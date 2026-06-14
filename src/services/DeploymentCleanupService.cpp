// ============================================================
// DeploymentCleanupService.cpp
// ============================================================

#include "DeploymentCleanupService.h"

#include "../controllers/LogWebSocketController.h"
#include "../db/Database.h"
#include "../utils/TokenCrypto.h"
#include "KubernetesService.h"
#include "SshService.h"

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <json/json.h>
#include <pqxx/pqxx>
#include <sstream>
#include <spdlog/spdlog.h>
#ifndef _WIN32
#include <sys/wait.h>
#else
#include <process.h>
#endif

namespace stackpilot {
namespace {

std::string trim(const std::string& value) {
    size_t start = 0;
    while (start < value.size() && std::isspace(static_cast<unsigned char>(value[start]))) {
        ++start;
    }
    size_t end = value.size();
    while (end > start && std::isspace(static_cast<unsigned char>(value[end - 1]))) {
        --end;
    }
    return value.substr(start, end - start);
}

Json::Value parseJsonObject(const std::string& raw) {
    if (trim(raw).empty()) {
        return Json::Value(Json::objectValue);
    }
    Json::Value parsed;
    Json::CharReaderBuilder builder;
    std::string errors;
    std::istringstream stream(raw);
    if (!Json::parseFromStream(builder, stream, &parsed, &errors) || !parsed.isObject()) {
        return Json::Value(Json::objectValue);
    }
    return parsed;
}

std::string jsonString(const Json::Value& value, const std::string& key, const std::string& fallback = "") {
    return value.isObject() && value.isMember(key) && value[key].isString() ? value[key].asString() : fallback;
}

std::string shellQuote(const std::string& value) {
    std::string quoted = "'";
    for (char c : value) {
        if (c == '\'') {
            quoted += "'\\''";
        } else {
            quoted += c;
        }
    }
    quoted += "'";
    return quoted;
}

std::filesystem::path getBuildWorkspaceRoot() {
    const char* workspaceEnv = std::getenv("BUILD_WORKSPACE_DIR");
    if (workspaceEnv && *workspaceEnv) {
        return std::filesystem::path(workspaceEnv);
    }
    return std::filesystem::path("uploads/builds");
}

bool isValidDockerImageRefForCleanup(const std::string& value) {
    const std::string cleaned = trim(value);
    if (cleaned.empty() || cleaned.size() > 255) {
        return false;
    }
    for (char c : cleaned) {
        const bool ok = std::isalnum(static_cast<unsigned char>(c)) ||
                        c == '_' || c == '.' || c == '-' || c == '/' ||
                        c == ':' || c == '@';
        if (!ok) {
            return false;
        }
    }
    return true;
}

bool isValidComposeProjectName(const std::string& value) {
    const std::string cleaned = trim(value);
    if (cleaned.empty() || cleaned.size() > 80) {
        return false;
    }
    for (char c : cleaned) {
        if (!std::isalnum(static_cast<unsigned char>(c)) && c != '_' && c != '-' && c != '.') {
            return false;
        }
    }
    return true;
}

bool isSafeComposeFileName(const std::string& value) {
    const std::string cleaned = trim(value);
    if (cleaned.empty() || cleaned.size() > 120 ||
        cleaned.find('/') != std::string::npos ||
        cleaned.find('\\') != std::string::npos) {
        return false;
    }
    for (char c : cleaned) {
        if (!std::isalnum(static_cast<unsigned char>(c)) && c != '_' && c != '-' && c != '.') {
            return false;
        }
    }
    const auto endsWith = [&cleaned](const std::string& suffix) {
        return cleaned.size() >= suffix.size() &&
               cleaned.compare(cleaned.size() - suffix.size(), suffix.size(), suffix) == 0;
    };
    return endsWith(".yml") || endsWith(".yaml");
}

bool isSafeComposeWorkdir(const std::string& value) {
    const std::string cleaned = trim(value);
    return !cleaned.empty() &&
           cleaned.size() < 512 &&
           cleaned.front() == '/' &&
           cleaned.find('\n') == std::string::npos &&
           cleaned.find('\r') == std::string::npos;
}

int runCommand(const std::string& command, std::string& output) {
    output.clear();
#ifdef _WIN32
    FILE* pipe = _popen((command + " 2>&1").c_str(), "r");
#else
    FILE* pipe = popen((command + " 2>&1").c_str(), "r");
#endif
    if (!pipe) {
        output = "Failed to start command";
        return -1;
    }
    char buffer[4096];
    while (fgets(buffer, sizeof(buffer), pipe) != nullptr) {
        output += buffer;
    }
#ifndef _WIN32
    const int rawExit = pclose(pipe);
    if (WIFEXITED(rawExit)) {
        return WEXITSTATUS(rawExit);
    }
    return rawExit;
#else
    return _pclose(pipe);
#endif
}

SshOperationResult removeLocalDockerImage(const std::string& imageName) {
    SshOperationResult result;
    if (!isValidDockerImageRefForCleanup(imageName)) {
        result.error = "Docker image reference is empty or invalid";
        return result;
    }
    const std::string command =
        "timeout 60s sh -lc " +
        shellQuote("if command -v docker >/dev/null 2>&1; then docker image rm -f " +
                   shellQuote(imageName) + " || true; echo __STACKPILOT_LOCAL_IMAGE_CLEANUP_DONE__; "
                   "else echo __STACKPILOT_DOCKER_MISSING__; exit 11; fi");
    std::string output;
    const int exitCode = runCommand(command, output);
    result.exitCode = exitCode;
    result.output = output;
    if (exitCode != 0 || output.find("__STACKPILOT_LOCAL_IMAGE_CLEANUP_DONE__") == std::string::npos) {
        result.error = exitCode == 124 ? "Docker image cleanup timed out" : "Failed to remove Docker image";
        return result;
    }
    result.success = true;
    return result;
}

SshOperationResult removeLocalDockerContainer(const std::string& containerName) {
    SshOperationResult result;
    const std::string cleaned = trim(containerName);
    if (cleaned.empty()) {
        result.error = "Local Docker container name is missing";
        return result;
    }
    for (char c : cleaned) {
        const bool ok = std::isalnum(static_cast<unsigned char>(c)) ||
                        c == '_' || c == '.' || c == '-';
        if (!ok) {
            result.error = "Local Docker container name is invalid";
            return result;
        }
    }

    const std::string command =
        "timeout 60s sh -lc " +
        shellQuote("if command -v docker >/dev/null 2>&1; then docker rm -f " +
                   shellQuote(cleaned) + " >/dev/null 2>&1 || true; echo __STACKPILOT_LOCAL_CONTAINER_REMOVED__; "
                   "else echo __STACKPILOT_DOCKER_MISSING__; exit 11; fi");
    std::string output;
    const int exitCode = runCommand(command, output);
    result.exitCode = exitCode;
    result.output = output;
    if (exitCode != 0 || output.find("__STACKPILOT_LOCAL_CONTAINER_REMOVED__") == std::string::npos) {
        result.error = exitCode == 124 ? "Local Docker runtime cleanup timed out" : "Failed to remove local Docker runtime";
        return result;
    }
    result.success = true;
    return result;
}

void appendDeploymentLogBlock(const std::string& deploymentId, const std::string& block) {
    if (block.empty()) {
        return;
    }
    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);
        txn.exec_params(
            "UPDATE deployments SET logs = COALESCE(logs, '') || $1 || E'\\n', updated_at = NOW() WHERE id = $2",
            block,
            deploymentId
        );
        txn.commit();
    } catch (const std::exception& e) {
        spdlog::warn("Failed to append cleanup logs for {}: {}", deploymentId, e.what());
    }
}

SshConnectionConfig rowToRemoteRuntimeConfig(const pqxx::row& row) {
    SshConnectionConfig config;
    config.connectionType = row["remote_connection_type"].is_null() ? "ssh" : row["remote_connection_type"].as<std::string>();
    config.host = row["remote_host"].is_null() ? "" : row["remote_host"].as<std::string>();
    config.port = row["remote_port"].is_null() ? 22 : row["remote_port"].as<int>();
    config.username = row["remote_username"].is_null() ? "" : row["remote_username"].as<std::string>();
    config.authType = row["remote_auth_type"].is_null() ? "" : row["remote_auth_type"].as<std::string>();
    config.password = row["remote_password_encrypted"].is_null()
        ? ""
        : TokenCrypto::decrypt(row["remote_password_encrypted"].as<std::string>());
    config.privateKey = row["remote_private_key_encrypted"].is_null()
        ? ""
        : TokenCrypto::decrypt(row["remote_private_key_encrypted"].as<std::string>());
    config.knownHostsEntry = row["remote_known_hosts_entry"].is_null() ? "" : row["remote_known_hosts_entry"].as<std::string>();
    return config;
}

std::string sanitizeRemoteWorkspaceSegment(const std::string& raw) {
    std::string cleaned;
    for (char c : raw) {
        const bool ok = std::isalnum(static_cast<unsigned char>(c)) || c == '_' || c == '.' || c == '-';
        cleaned.push_back(ok ? c : '-');
        if (cleaned.size() >= 128) {
            break;
        }
    }
    return cleaned.empty() ? "deployment" : cleaned;
}

std::string joinRemotePath(std::string base, const std::string& child) {
    base = trim(base);
    if (base.empty()) {
        base = "/tmp";
    }
    while (base.size() > 1 && base.back() == '/') {
        base.pop_back();
    }
    return base + "/" + child;
}

} // namespace

Json::Value DeploymentCleanupResult::toJson() const {
    Json::Value body(Json::objectValue);
    body["success"] = success;
    body["error"] = error;
    body["runtime_cleanup_attempted"] = runtimeCleanupAttempted;
    body["docker_image_cleanup_attempted"] = imageCleanupAttempted;
    body["docker_image_deleted"] = imageDeleted;
    body["remote_workspace_deleted"] = remoteWorkspaceDeleted;
    body["runtime_provider"] = runtimeProvider;
    body["image_name"] = imageName;
    return body;
}

DeploymentCleanupResult DeploymentCleanupService::cleanupDeployment(
    const std::string& userId,
    const std::string& deploymentId,
    const DeploymentCleanupOptions& options
) const {
    DeploymentCleanupResult result;
    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);
        auto rows = txn.exec_params(
            "SELECT d.id, d.k8s_namespace, d.k8s_deployment_name, d.k8s_service_name, d.runtime_exposure, "
            "d.runtime_provider, d.remote_container_name, d.image_name, d.runtime_snapshot::text AS runtime_snapshot, "
            "d.source_snapshot, "
            "p.source_type AS project_source_type, p.source_path AS project_source_path, p.execution_mode AS project_execution_mode, "
            "COALESCE(rs.connection_type, 'ssh') AS remote_connection_type, rs.host AS remote_host, rs.port AS remote_port, "
            "rs.username AS remote_username, rs.auth_type AS remote_auth_type, rs.password_encrypted AS remote_password_encrypted, "
            "rs.private_key_encrypted AS remote_private_key_encrypted, rs.known_hosts_entry AS remote_known_hosts_entry "
            "FROM deployments d "
            "JOIN projects p ON d.project_id = p.id "
            "LEFT JOIN project_environments e ON d.environment_id = e.id AND e.project_id = p.id "
            "LEFT JOIN ssh_connections rs ON COALESCE(d.remote_connection_id, e.remote_connection_id, p.remote_connection_id) = rs.id "
            "WHERE d.id = $1 AND p.user_id = $2",
            deploymentId,
            userId
        );

        if (rows.empty()) {
            txn.commit();
            result.error = "Deployment not found";
            return result;
        }

        const auto& row = rows[0];
        const Json::Value runtimeSnapshotJson = parseJsonObject(row["runtime_snapshot"].is_null() ? "" : row["runtime_snapshot"].as<std::string>());
        const Json::Value sourceSnapshot = parseJsonObject(row["source_snapshot"].is_null() ? "" : row["source_snapshot"].as<std::string>());
        const std::string nameSpace = row["k8s_namespace"].is_null() ? "" : row["k8s_namespace"].as<std::string>();
        const std::string deploymentName = row["k8s_deployment_name"].is_null() ? "" : row["k8s_deployment_name"].as<std::string>();
        const std::string serviceName = row["k8s_service_name"].is_null() ? "" : row["k8s_service_name"].as<std::string>();
        const std::string exposureMode = jsonString(runtimeSnapshotJson, "exposure_mode", row["runtime_exposure"].is_null() ? "" : row["runtime_exposure"].as<std::string>());
        const std::string runtimeProvider = jsonString(runtimeSnapshotJson, "provider", row["runtime_provider"].is_null() ? "" : row["runtime_provider"].as<std::string>());
        const std::string remoteContainerName = row["remote_container_name"].is_null() ? "" : row["remote_container_name"].as<std::string>();
        const std::string imageName = jsonString(runtimeSnapshotJson, "image_name", row["image_name"].is_null() ? "" : row["image_name"].as<std::string>());
        const std::string sourceType = jsonString(sourceSnapshot, "source_type", row["project_source_type"].is_null() ? "" : row["project_source_type"].as<std::string>());
        const std::string sourcePath = jsonString(sourceSnapshot, "source_path", row["project_source_path"].is_null() ? "" : row["project_source_path"].as<std::string>());
        const std::string executionMode = jsonString(sourceSnapshot, "execution_mode", row["project_execution_mode"].is_null() ? "" : row["project_execution_mode"].as<std::string>());
        const bool hasRemoteHost = !row["remote_host"].is_null();
        txn.commit();

        result.runtimeProvider = runtimeProvider;
        result.imageName = imageName;
        bool composeImageHandled = false;

        const std::string composeProject = jsonString(runtimeSnapshotJson, "compose_project", remoteContainerName);
        const std::string composeFile = jsonString(runtimeSnapshotJson, "compose_file");
        const std::string composeWorkdir = jsonString(runtimeSnapshotJson, "compose_workdir");

        if ((runtimeProvider == "remote_compose" || exposureMode == "remote_compose") && hasRemoteHost) {
            result.runtimeCleanupAttempted = true;
            if (!isValidComposeProjectName(composeProject) ||
                !isSafeComposeFileName(composeFile) ||
                !isSafeComposeWorkdir(composeWorkdir)) {
                result.error = "Compose runtime snapshot is missing safe cleanup metadata";
                return result;
            }
            SshService sshService;
            const std::string command =
                "compose_cmd='docker compose'; "
                "if ! docker compose version >/dev/null 2>&1; then compose_cmd='docker-compose'; fi; "
                "cd " + shellQuote(composeWorkdir) + " && "
                "$compose_cmd -f " + shellQuote(composeFile) +
                " -p " + shellQuote(composeProject) +
                std::string(" down --remove-orphans") + (options.deleteImage ? " --rmi local" : "") + "; "
                "echo __STACKPILOT_COMPOSE_REMOVED__";
            const auto removal = sshService.runRemoteCommand(rowToRemoteRuntimeConfig(row), "/", command, 180);
            result.logs += removal.output;
            appendDeploymentLogBlock(deploymentId, removal.output);
            if (!removal.success || removal.output.find("__STACKPILOT_COMPOSE_REMOVED__") == std::string::npos) {
                result.error = removal.error.empty() ? "Failed to remove remote Compose runtime before deleting deployment" : removal.error;
                return result;
            }
            if (options.deleteImage) {
                result.imageCleanupAttempted = true;
                result.imageDeleted = true;
                composeImageHandled = true;
            }
        } else if (runtimeProvider == "local_compose" || exposureMode == "local_compose") {
            result.runtimeCleanupAttempted = true;
            if (!isValidComposeProjectName(composeProject) ||
                !isSafeComposeFileName(composeFile) ||
                !isSafeComposeWorkdir(composeWorkdir)) {
                result.error = "Compose runtime snapshot is missing safe cleanup metadata";
                return result;
            }
            const std::string command =
                "timeout 180s sh -lc " + shellQuote(
                    "compose_cmd='docker compose'; "
                    "if ! docker compose version >/dev/null 2>&1; then compose_cmd='docker-compose'; fi; "
                    "cd " + shellQuote(composeWorkdir) + " && "
                    "$compose_cmd -f " + shellQuote(composeFile) +
                    " -p " + shellQuote(composeProject) +
                    std::string(" down --remove-orphans") + (options.deleteImage ? " --rmi local" : "") + "; "
                    "echo __STACKPILOT_COMPOSE_REMOVED__"
                );
            std::string output;
            const int exitCode = runCommand(command, output);
            result.logs += output;
            appendDeploymentLogBlock(deploymentId, output);
            if (exitCode != 0 || output.find("__STACKPILOT_COMPOSE_REMOVED__") == std::string::npos) {
                result.error = "Failed to remove local Compose runtime before deleting deployment";
                return result;
            }
            if (options.deleteImage) {
                result.imageCleanupAttempted = true;
                result.imageDeleted = true;
                composeImageHandled = true;
            }
        }

        const bool composeKubernetesRuntime =
            runtimeSnapshotJson.get("compose_kubernetes", false).asBool() ||
            (runtimeSnapshotJson.get("multi_service", false).asBool() &&
             (runtimeProvider == "kubernetes" || runtimeProvider == "remote_kubernetes") &&
             !composeProject.empty());

        if (composeKubernetesRuntime && runtimeProvider == "remote_kubernetes" && !composeProject.empty() && hasRemoteHost) {
            result.runtimeCleanupAttempted = true;
            SshService sshService;
            const KubernetesRuntimeInfo removal = sshService.removeComposeKubernetesRuntime(
                rowToRemoteRuntimeConfig(row),
                nameSpace,
                composeProject,
                exposureMode
            );
            result.logs += removal.logs;
            appendDeploymentLogBlock(deploymentId, removal.logs);
            if (!removal.success) {
                result.error = removal.error.empty() ? "Failed to remove remote Compose Kubernetes runtime before deleting deployment" : removal.error;
                return result;
            }
            if (options.deleteImage && isValidComposeProjectName(composeProject) &&
                isSafeComposeFileName(composeFile) && isSafeComposeWorkdir(composeWorkdir)) {
                result.imageCleanupAttempted = true;
                const std::string command =
                    "compose_cmd='docker compose'; "
                    "if ! docker compose version >/dev/null 2>&1; then compose_cmd='docker-compose'; fi; "
                    "cd " + shellQuote(composeWorkdir) + " && "
                    "$compose_cmd -f " + shellQuote(composeFile) +
                    " -p " + shellQuote(composeProject) +
                    " down --remove-orphans --rmi local || true; "
                    "echo __STACKPILOT_COMPOSE_IMAGES_REMOVED__";
                const auto imageRemoval = sshService.runRemoteCommand(rowToRemoteRuntimeConfig(row), "/", command, 180);
                result.logs += imageRemoval.output;
                appendDeploymentLogBlock(deploymentId, imageRemoval.output);
                if (!imageRemoval.success || imageRemoval.output.find("__STACKPILOT_COMPOSE_IMAGES_REMOVED__") == std::string::npos) {
                    result.error = imageRemoval.error.empty() ? "Failed to clean remote Compose images" : imageRemoval.error;
                    return result;
                }
                result.imageDeleted = true;
                composeImageHandled = true;
            }
        } else if (composeKubernetesRuntime && runtimeProvider == "kubernetes" && !composeProject.empty()) {
            result.runtimeCleanupAttempted = true;
            KubernetesService service;
            const KubernetesRuntimeInfo removal = service.removeComposeStack(nameSpace, composeProject, exposureMode);
            result.logs += removal.logs;
            appendDeploymentLogBlock(deploymentId, removal.logs);
            if (!removal.success) {
                result.error = removal.error.empty() ? "Failed to remove Compose Kubernetes runtime before deleting deployment" : removal.error;
                return result;
            }
            if (options.deleteImage && isValidComposeProjectName(composeProject) &&
                isSafeComposeFileName(composeFile) && isSafeComposeWorkdir(composeWorkdir)) {
                result.imageCleanupAttempted = true;
                const std::string command =
                    "timeout 180s sh -lc " + shellQuote(
                        "compose_cmd='docker compose'; "
                        "if ! docker compose version >/dev/null 2>&1; then compose_cmd='docker-compose'; fi; "
                        "cd " + shellQuote(composeWorkdir) + " && "
                        "$compose_cmd -f " + shellQuote(composeFile) +
                        " -p " + shellQuote(composeProject) +
                        " down --remove-orphans --rmi local || true; "
                        "echo __STACKPILOT_COMPOSE_IMAGES_REMOVED__"
                    );
                std::string output;
                const int exitCode = runCommand(command, output);
                result.logs += output;
                appendDeploymentLogBlock(deploymentId, output);
                if (exitCode != 0 || output.find("__STACKPILOT_COMPOSE_IMAGES_REMOVED__") == std::string::npos) {
                    result.error = "Failed to clean local Compose images";
                    return result;
                }
                result.imageDeleted = true;
                composeImageHandled = true;
            }
        } else if ((runtimeProvider == "remote_docker" || exposureMode == "remote_docker") && !remoteContainerName.empty() && hasRemoteHost) {
            result.runtimeCleanupAttempted = true;
            SshService sshService;
            const auto removal = sshService.removeDockerContainer(rowToRemoteRuntimeConfig(row), remoteContainerName, imageName, false);
            result.logs += removal.output;
            appendDeploymentLogBlock(deploymentId, removal.output);
            if (!removal.success) {
                result.error = removal.error.empty() ? "Failed to remove remote runtime before deleting deployment" : removal.error;
                return result;
            }
        } else if ((runtimeProvider == "local_docker" || exposureMode == "local_docker") && !remoteContainerName.empty()) {
            result.runtimeCleanupAttempted = true;
            const auto removal = removeLocalDockerContainer(remoteContainerName);
            result.logs += removal.output;
            appendDeploymentLogBlock(deploymentId, removal.output);
            if (!removal.success) {
                result.error = removal.error.empty() ? "Failed to remove local Docker runtime before deleting deployment" : removal.error;
                return result;
            }
        } else if (runtimeProvider == "remote_kubernetes" && !deploymentName.empty() && !serviceName.empty() && hasRemoteHost) {
            result.runtimeCleanupAttempted = true;
            SshService sshService;
            const KubernetesRuntimeInfo removal = sshService.removeKubernetesRuntime(rowToRemoteRuntimeConfig(row), nameSpace, deploymentName, serviceName, exposureMode);
            result.logs += removal.logs;
            appendDeploymentLogBlock(deploymentId, removal.logs);
            if (!removal.success) {
                result.error = removal.error.empty() ? "Failed to remove remote Kubernetes runtime before deleting deployment" : removal.error;
                return result;
            }
        } else if (!deploymentName.empty() && !serviceName.empty()) {
            result.runtimeCleanupAttempted = true;
            KubernetesService service;
            const KubernetesRuntimeInfo removal = service.remove(nameSpace, deploymentName, serviceName, exposureMode);
            result.logs += removal.logs;
            appendDeploymentLogBlock(deploymentId, removal.logs);
            if (!removal.success) {
                result.error = removal.error.empty() ? "Failed to remove runtime before deleting deployment" : removal.error;
                return result;
            }
        }

        if (options.deleteImage && !imageName.empty() && !composeImageHandled && imageName.rfind("compose:", 0) != 0) {
            result.imageCleanupAttempted = true;
            SshOperationResult imageRemoval;
            if (hasRemoteHost && (runtimeProvider == "remote_docker" || runtimeProvider == "remote_kubernetes" || executionMode == "remote_host")) {
                SshService sshService;
                imageRemoval = sshService.removeDockerImage(rowToRemoteRuntimeConfig(row), imageName);
            } else {
                imageRemoval = removeLocalDockerImage(imageName);
            }
            result.logs += imageRemoval.output;
            appendDeploymentLogBlock(deploymentId, imageRemoval.output);
            if (!imageRemoval.success) {
                result.error = imageRemoval.error.empty() ? "Failed to remove Docker image" : imageRemoval.error;
                return result;
            }
            result.imageDeleted = true;
        }

        if (options.deleteRemoteWorkspace && hasRemoteHost && executionMode == "remote_host" &&
            (sourceType == "github" || sourceType == "artifact")) {
            const std::string remoteWorkspace = joinRemotePath(
                joinRemotePath(sourcePath.empty() ? "/tmp" : sourcePath, "stackpilot-builds"),
                sanitizeRemoteWorkspaceSegment(deploymentId)
            );
            SshService sshService;
            const auto cleanup = sshService.runRemoteCommand(
                rowToRemoteRuntimeConfig(row),
                "/",
                "rm -rf -- " + shellQuote(remoteWorkspace) + " && echo __STACKPILOT_REMOTE_WORKSPACE_REMOVED__",
                60
            );
            result.logs += cleanup.output;
            appendDeploymentLogBlock(deploymentId, cleanup.output);
            if (!cleanup.success) {
                result.error = cleanup.error.empty() ? "Failed to clean remote build workspace" : cleanup.error;
                return result;
            }
            result.remoteWorkspaceDeleted = true;
        }

        std::error_code ec;
        std::filesystem::remove_all(getBuildWorkspaceRoot() / deploymentId, ec);
        if (ec) {
            spdlog::warn("Failed to clean deployment workspace {}: {}", deploymentId, ec.message());
        }

        if (options.deleteDatabaseRow) {
            auto deleteConn = Database::getInstance().getConnection();
            pqxx::work deleteTxn(*deleteConn);
            auto deleted = deleteTxn.exec_params(
                "DELETE FROM deployments USING projects "
                "WHERE deployments.project_id = projects.id "
                "AND deployments.id = $1 "
                "AND projects.user_id = $2 "
                "RETURNING deployments.id",
                deploymentId,
                userId
            );
            deleteTxn.commit();
            if (deleted.empty()) {
                result.error = "Deployment not found";
                return result;
            }
            LogWebSocketController::broadcastDeploymentDeleted(deploymentId);
        }

        result.success = true;
        return result;
    } catch (const std::exception& e) {
        result.error = e.what();
        return result;
    }
}

} // namespace stackpilot
