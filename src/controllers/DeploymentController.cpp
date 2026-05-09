// ============================================================
// DeploymentController.cpp — Deployment API Implementation
// ============================================================

#include "DeploymentController.h"
#include "LogWebSocketController.h"
#include "../db/Database.h"
#include "../services/BuildService.h"
#include "../services/DeploymentCleanupService.h"
#include "../services/JobQueueService.h"
#include "../services/KubernetesService.h"
#include "../services/SshService.h"
#include "../utils/AuditLogger.h"
#include "../utils/JwtHelper.h"
#include "../utils/TokenCrypto.h"
#include <json/json.h>
#include <spdlog/spdlog.h>
#include <pqxx/pqxx>
#include <thread>
#include <mutex>
#include <sstream>
#include <filesystem>
#include <cstdlib>
#include <cstdio>
#include <algorithm>
#include <cctype>
#include <chrono>
#include <unordered_map>
#include <vector>
#ifndef _WIN32
#include <sys/wait.h>
#endif

namespace dokscp {

namespace {

std::mutex deploymentLogMutex;
std::mutex runtimeOperationRateLimitMutex;

struct RuntimeRateLimitState {
    int attempts = 0;
    std::chrono::steady_clock::time_point windowStart = std::chrono::steady_clock::now();
    std::chrono::steady_clock::time_point blockedUntil = std::chrono::steady_clock::time_point::min();
};

struct RuntimeRateLimitPolicy {
    int maxAttempts;
    int windowSeconds;
    int blockSeconds;
};

std::unordered_map<std::string, RuntimeRateLimitState> runtimeRateLimitStates;
const RuntimeRateLimitPolicy kRuntimeMutationRateLimit{12, 300, 300};

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

std::string toLower(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
    });
    return value;
}

bool looksLikeGitCommitSha(const std::string& value) {
    if (value.size() < 7 || value.size() > 64) {
        return false;
    }
    return std::all_of(value.begin(), value.end(), [](unsigned char c) {
        return std::isxdigit(c) != 0;
    });
}

std::string normalizeRuntimeScheme(const std::string& value) {
    const std::string cleaned = toLower(trim(value));
    return cleaned == "https" ? "https" : "http";
}

std::string compactJson(const Json::Value& value) {
    Json::StreamWriterBuilder builder;
    builder["indentation"] = "";
    return Json::writeString(builder, value.isNull() ? Json::Value(Json::objectValue) : value);
}

Json::Value deploymentSourceSnapshot(const std::string& sourceType,
                                     const std::string& repoUrl,
                                     const std::string& sourcePath,
                                     const std::string& executionMode,
                                     const std::string& remoteRuntimeType,
                                     const std::string& remoteK8sExposure,
                                     const std::string& runtimeScheme,
                                     bool localHttpsEnabled,
                                     const std::string& version,
                                     const std::string& projectName) {
    Json::Value snapshot;
    snapshot["source_type"] = sourceType;
    snapshot["repo_url"] = repoUrl;
    snapshot["source_path"] = sourcePath;
    snapshot["execution_mode"] = executionMode;
    snapshot["remote_runtime_type"] = remoteRuntimeType;
    snapshot["remote_k8s_exposure"] = remoteK8sExposure;
    snapshot["runtime_scheme"] = normalizeRuntimeScheme(runtimeScheme);
    snapshot["local_https_enabled"] = localHttpsEnabled;
    snapshot["version"] = version;
    snapshot["project_name"] = projectName;
    return snapshot;
}

Json::Value envKeySnapshot(const std::vector<BuildEnvVar>& envVars) {
    Json::Value snapshot(Json::arrayValue);
    for (const auto& envVar : envVars) {
        Json::Value item;
        item["key"] = envVar.key;
        item["has_value"] = !envVar.value.empty();
        snapshot.append(item);
    }
    return snapshot;
}

Json::Value runtimeSnapshot(const std::string& provider,
                            const std::string& imageName,
                            const std::string& runtimeUrl,
                            const std::string& exposureMode,
                            int replicas,
                            int containerPort,
                            const std::string& resourcePreset = "small",
                            const std::string& healthPath = "/",
                            const std::string& runtimeScheme = "http") {
    const std::string scheme = normalizeRuntimeScheme(runtimeScheme);
    Json::Value snapshot;
    snapshot["provider"] = provider;
    snapshot["image_name"] = imageName;
    snapshot["runtime_url"] = runtimeUrl;
    snapshot["exposure_mode"] = exposureMode;
    snapshot["replicas"] = replicas;
    snapshot["container_port"] = containerPort;
    snapshot["resource_preset"] = resourcePreset.empty() ? "small" : resourcePreset;
    snapshot["health_path"] = healthPath.empty() ? "/" : healthPath;
    snapshot["runtime_scheme"] = scheme;
    snapshot["tls_enabled"] = scheme == "https";
    return snapshot;
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

void hydrateDeploymentRuntimeFields(Json::Value& dep, const pqxx::row& row) {
    const Json::Value snapshot = parseJsonObject(
        row["runtime_snapshot"].is_null() ? "" : row["runtime_snapshot"].as<std::string>()
    );
    const std::string imageName = jsonString(
        snapshot,
        "image_name",
        row["image_name"].is_null() ? "" : row["image_name"].as<std::string>()
    );
    const std::string runtimeProvider = jsonString(
        snapshot,
        "provider",
        row["runtime_provider"].is_null() ? "" : row["runtime_provider"].as<std::string>()
    );
    const std::string runtimeExposure = jsonString(
        snapshot,
        "exposure_mode",
        row["runtime_exposure"].is_null() ? "" : row["runtime_exposure"].as<std::string>()
    );
    const std::string remoteContainerName =
        row["remote_container_name"].is_null() ? "" : row["remote_container_name"].as<std::string>();
    const std::string k8sDeploymentName =
        row["k8s_deployment_name"].is_null() ? "" : row["k8s_deployment_name"].as<std::string>();

    dep["image_name"] = imageName;
    dep["k8s_namespace"] = row["k8s_namespace"].is_null() ? "" : row["k8s_namespace"].as<std::string>();
    dep["k8s_deployment_name"] = k8sDeploymentName;
    dep["k8s_service_name"] = row["k8s_service_name"].is_null() ? "" : row["k8s_service_name"].as<std::string>();
    dep["k8s_ingress_name"] = row["k8s_ingress_name"].is_null() ? "" : row["k8s_ingress_name"].as<std::string>();
    dep["desired_replicas"] = row["desired_replicas"].is_null() ? 1 : row["desired_replicas"].as<int>();
    dep["runtime_url"] = jsonString(
        snapshot,
        "runtime_url",
        row["runtime_url"].is_null() ? "" : row["runtime_url"].as<std::string>()
    );
    dep["runtime_exposure"] = runtimeExposure;
    dep["runtime_provider"] = runtimeProvider;
    dep["remote_container_name"] = remoteContainerName;
    dep["runtime_paused"] = row["runtime_paused"].is_null() ? false : row["runtime_paused"].as<bool>();
    dep["can_delete_image"] = !imageName.empty();
}

int jsonInt(const Json::Value& value, const std::string& key, int fallback) {
    if (!value.isObject() || !value.isMember(key)) {
        return fallback;
    }
    if (value[key].isInt()) {
        return value[key].asInt();
    }
    if (value[key].isString()) {
        try {
            return std::stoi(value[key].asString());
        } catch (...) {
            return fallback;
        }
    }
    return fallback;
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

std::string valueFromKeyValueOutput(const std::string& output, const std::string& key) {
    std::istringstream stream(output);
    std::string line;
    const std::string prefix = key + "=";
    while (std::getline(stream, line)) {
        if (line.rfind(prefix, 0) == 0) {
            return trim(line.substr(prefix.size()));
        }
    }
    return "";
}

std::string remoteLogTailFromInspectOutput(const std::string& output) {
    const std::string marker = "__DOKSCP_REMOTE_LOG_TAIL__";
    const auto pos = output.find(marker);
    if (pos == std::string::npos) {
        return "";
    }
    return trim(output.substr(pos + marker.size()));
}

std::string getClientAddress(const drogon::HttpRequestPtr& req) {
    if (!req) {
        return "unknown";
    }

    const std::string forwarded = trim(req->getHeader("X-Forwarded-For"));
    if (!forwarded.empty()) {
        const auto comma = forwarded.find(',');
        return toLower(trim(forwarded.substr(0, comma)));
    }

    return toLower(req->peerAddr().toIp());
}

std::string makeRuntimeRateLimitKey(const std::string& scope,
                                    const drogon::HttpRequestPtr& req,
                                    const std::string& userId,
                                    const std::string& deploymentId) {
    return scope + ":" + getClientAddress(req) + ":" + userId + ":" + deploymentId;
}

int getRuntimeRetryAfterSeconds(const std::string& key) {
    std::lock_guard<std::mutex> lock(runtimeOperationRateLimitMutex);
    const auto it = runtimeRateLimitStates.find(key);
    if (it == runtimeRateLimitStates.end()) {
        return 0;
    }

    const auto now = std::chrono::steady_clock::now();
    if (now >= it->second.blockedUntil) {
        return 0;
    }

    return static_cast<int>(std::chrono::duration_cast<std::chrono::seconds>(it->second.blockedUntil - now).count());
}

bool isRuntimeRateLimited(const std::string& key, int& retryAfterSeconds) {
    retryAfterSeconds = getRuntimeRetryAfterSeconds(key);
    return retryAfterSeconds > 0;
}

void recordRuntimeRateLimitFailure(const std::string& key, const RuntimeRateLimitPolicy& policy) {
    std::lock_guard<std::mutex> lock(runtimeOperationRateLimitMutex);
    auto& state = runtimeRateLimitStates[key];
    const auto now = std::chrono::steady_clock::now();

    if (now >= state.blockedUntil && now - state.windowStart > std::chrono::seconds(policy.windowSeconds)) {
        state.attempts = 0;
        state.windowStart = now;
    }

    if (state.blockedUntil > now) {
        return;
    }

    if (state.attempts == 0) {
        state.windowStart = now;
    }

    ++state.attempts;
    if (state.attempts >= policy.maxAttempts) {
        state.blockedUntil = now + std::chrono::seconds(policy.blockSeconds);
        state.attempts = 0;
        state.windowStart = now;
    }
}

void clearRuntimeRateLimitState(const std::string& key) {
    std::lock_guard<std::mutex> lock(runtimeOperationRateLimitMutex);
    runtimeRateLimitStates.erase(key);
}

drogon::HttpResponsePtr makeRuntimeRateLimitedResponse(int retryAfterSeconds) {
    Json::Value err;
    err["error"] = "Too many runtime operations. Please wait and try again.";
    auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
    resp->setStatusCode(drogon::k429TooManyRequests);
    resp->addHeader("Retry-After", std::to_string(std::max(1, retryAfterSeconds)));
    return resp;
}

void appendDeploymentLog(const std::string& deploymentId, const std::string& line) {
    std::lock_guard<std::mutex> lock(deploymentLogMutex);

    try {
        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);
        txn.exec_params(
            "UPDATE deployments "
            "SET logs = COALESCE(logs, '') || $1 || E'\\n', updated_at = NOW() "
            "WHERE id = $2",
            line,
            deploymentId
        );
        txn.commit();
    } catch (const std::exception& e) {
        spdlog::error("Failed to append build log for {}: {}", deploymentId, e.what());
    }
}

void appendDeploymentLogBlock(const std::string& deploymentId, const std::string& block) {
    std::istringstream stream(block);
    std::string line;
    while (std::getline(stream, line)) {
        if (!line.empty()) {
            appendDeploymentLog(deploymentId, line);
        }
    }
}

Json::Value loadDeploymentSummary(const std::string& deploymentId) {
    auto& db = Database::getInstance();
    auto conn = db.getConnection();
    pqxx::work txn(*conn);
    auto rows = txn.exec_params(
        "SELECT d.id, d.project_id, p.name AS project_name, p.repo_url, d.status, d.version, d.commit_hash, "
        "d.environment_id, e.name AS environment_name, d.branch, d.commit_sha, d.trigger_source, d.github_delivery_id, "
        "d.ci_required, d.ci_status, d.image_name, "
        "d.k8s_namespace, d.k8s_deployment_name, d.k8s_service_name, d.k8s_ingress_name, "
        "d.desired_replicas, d.runtime_url, d.runtime_exposure, d.runtime_provider, d.remote_container_name, "
        "d.runtime_paused, d.runtime_snapshot::text AS runtime_snapshot, d.created_at "
        "FROM deployments d "
        "JOIN projects p ON d.project_id = p.id "
        "LEFT JOIN project_environments e ON d.environment_id = e.id "
        "WHERE d.id = $1",
        deploymentId
    );
    txn.commit();

    if (rows.empty()) {
        return Json::Value();
    }

    const auto& row = rows[0];
    Json::Value dep;
    dep["id"] = row["id"].as<std::string>();
    dep["project_id"] = row["project_id"].as<std::string>();
    dep["project_name"] = row["project_name"].as<std::string>();
    dep["repo_url"] = row["repo_url"].is_null() ? "" : row["repo_url"].as<std::string>();
    dep["status"] = row["status"].as<std::string>();
    dep["version"] = row["version"].as<std::string>();
    dep["commit_hash"] = row["commit_hash"].as<std::string>();
    dep["environment_id"] = row["environment_id"].is_null() ? "" : row["environment_id"].as<std::string>();
    dep["environment_name"] = row["environment_name"].is_null() ? "" : row["environment_name"].as<std::string>();
    dep["branch"] = row["branch"].is_null() ? "" : row["branch"].as<std::string>();
    dep["commit_sha"] = row["commit_sha"].is_null() ? "" : row["commit_sha"].as<std::string>();
    dep["trigger_source"] = row["trigger_source"].is_null() ? "manual" : row["trigger_source"].as<std::string>();
    dep["github_delivery_id"] = row["github_delivery_id"].is_null() ? "" : row["github_delivery_id"].as<std::string>();
    dep["ci_required"] = row["ci_required"].is_null() ? false : row["ci_required"].as<bool>();
    dep["ci_status"] = row["ci_status"].is_null() ? "not_required" : row["ci_status"].as<std::string>();
    hydrateDeploymentRuntimeFields(dep, row);
    dep["created_at"] = row["created_at"].as<std::string>();
    return dep;
}

void broadcastDeploymentSummary(const std::string& deploymentId) {
    Json::Value summary = loadDeploymentSummary(deploymentId);
    if (!summary.isNull()) {
        LogWebSocketController::broadcastDeploymentUpdate(summary);
    }
}

std::filesystem::path getBuildWorkspaceRoot() {
    const char* workspaceEnv = std::getenv("BUILD_WORKSPACE_DIR");
    if (workspaceEnv && *workspaceEnv) {
        return std::filesystem::path(workspaceEnv);
    }
    return std::filesystem::path("uploads/builds");
}

std::vector<std::string> splitString(const std::string& value, char delimiter) {
    std::vector<std::string> parts;
    std::stringstream stream(value);
    std::string item;
    while (std::getline(stream, item, delimiter)) {
        parts.push_back(item);
    }
    return parts;
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

std::string makeDockerPauseCommand(const std::string& containerName, bool paused) {
    const std::string container = shellQuote(containerName);
    return "set -e; "
           "command -v docker >/dev/null 2>&1 || { echo __DOKSCP_DOCKER_MISSING__; exit 10; }; "
           "docker info >/dev/null 2>&1 || { echo __DOKSCP_DOCKER_DAEMON_DOWN__; exit 11; }; "
           "docker inspect " + container + " >/dev/null 2>&1 || { echo __DOKSCP_CONTAINER_MISSING__; exit 12; }; "
           "docker " + std::string(paused ? "pause " : "unpause ") + container + " >/dev/null; "
           "docker inspect --format 'status={{.State.Status}}\nrunning={{.State.Running}}\npaused={{.State.Paused}}\nimage={{.Config.Image}}\nstarted_at={{.State.StartedAt}}\nfinished_at={{.State.FinishedAt}}\nrestart_count={{.RestartCount}}' " + container;
}

int runLocalCommand(const std::string& command, std::string& output);

std::string sanitizeDockerContainerName(const std::string& raw) {
    std::string cleaned;
    cleaned.reserve(std::min<size_t>(raw.size(), 96));
    for (char c : raw) {
        const bool ok = std::isalnum(static_cast<unsigned char>(c)) || c == '_' || c == '.' || c == '-';
        cleaned.push_back(ok ? static_cast<char>(std::tolower(static_cast<unsigned char>(c))) : '-');
        if (cleaned.size() >= 96) {
            break;
        }
    }
    while (!cleaned.empty() && cleaned.front() == '-') {
        cleaned.erase(cleaned.begin());
    }
    while (!cleaned.empty() && cleaned.back() == '-') {
        cleaned.pop_back();
    }
    return cleaned.empty() ? "deployment" : cleaned;
}

bool isValidRuntimeEnvKey(const std::string& key) {
    if (key.empty()) {
        return false;
    }
    if (!(std::isalpha(static_cast<unsigned char>(key.front())) || key.front() == '_')) {
        return false;
    }
    for (char c : key) {
        if (!(std::isalnum(static_cast<unsigned char>(c)) || c == '_')) {
            return false;
        }
    }
    return true;
}

std::string makeLocalDockerRunCommand(const std::string& containerName,
                                      const std::string& imageName,
                                      int containerPort,
                                      const std::vector<std::pair<std::string, std::string>>& envVars) {
    std::string envArgs;
    for (const auto& envVar : envVars) {
        if (!isValidRuntimeEnvKey(envVar.first)) {
            continue;
        }
        std::string value = envVar.second;
        std::replace(value.begin(), value.end(), '\n', ' ');
        envArgs += " --env " + shellQuote(envVar.first + "=" + value);
    }

    const std::string container = shellQuote(containerName);
    const std::string image = shellQuote(imageName);
    const std::string requestedPort = std::to_string(std::clamp(containerPort, 0, 65535));
    return
        "set -e; "
        "command -v docker >/dev/null 2>&1 || { echo __DOKSCP_DOCKER_MISSING__; exit 10; }; "
        "docker info >/dev/null 2>&1 || { echo __DOKSCP_DOCKER_DAEMON_DOWN__; exit 11; }; "
        "docker image inspect " + image + " >/dev/null 2>&1 || { echo __DOKSCP_IMAGE_MISSING__; exit 12; }; "
        "requested_port=" + requestedPort + "; "
        "if [ \"$requested_port\" -gt 0 ]; then "
        "container_port=\"$requested_port\"; "
        "else "
        "container_port=$(docker image inspect --format '{{range $p, $_ := .Config.ExposedPorts}}{{println $p}}{{end}}' " + image + " 2>/dev/null | sed -n 's#/tcp$##p' | head -n 1); "
        "[ -n \"$container_port\" ] || container_port=3000; "
        "fi; "
        "docker rm -f " + container + " >/dev/null 2>&1 || true; "
        "docker run -d --restart unless-stopped --name " + container + envArgs +
        " -p 127.0.0.1::$container_port " + image + " >/tmp/dokscp-local-container-id; "
        "host_port=$(docker port " + container + " $container_port/tcp 2>/dev/null | awk -F: 'NF {print $NF; exit}'); "
        "[ -n \"$host_port\" ] || { echo __DOKSCP_PORT_MISSING__; docker logs --tail 80 " + container + " || true; exit 13; }; "
        "status=$(docker inspect --format '{{.State.Status}}' " + container + "); "
        "running=$(docker inspect --format '{{.State.Running}}' " + container + "); "
        "echo __DOKSCP_LOCAL_DOCKER_RUNNING__; "
        "echo container_name=" + containerName + "; "
        "echo container_port=$container_port; "
        "echo host_port=$host_port; "
        "echo runtime_url=http://localhost:$host_port; "
        "echo status=$status; "
        "echo running=$running; "
        "echo image=" + imageName + "; "
        "echo __DOKSCP_LOCAL_LOG_TAIL__; "
        "docker logs --tail 80 " + container + " 2>&1 || true";
}

SshOperationResult removeLocalDockerContainer(const std::string& containerName,
                                             const std::string& imageName,
                                             bool removeImage) {
    SshOperationResult result;
    if (trim(containerName).empty()) {
        result.error = "Local Docker container name is missing";
        return result;
    }
    const std::string command =
        "timeout 60s sh -lc " + shellQuote(
            std::string("set -e; ")
            + "command -v docker >/dev/null 2>&1 || { echo __DOKSCP_DOCKER_MISSING__; exit 10; }; "
            + "docker info >/dev/null 2>&1 || { echo __DOKSCP_DOCKER_DAEMON_DOWN__; exit 11; }; "
            + "docker rm -f " + shellQuote(containerName) + " >/dev/null 2>&1 || true; "
            + "echo __DOKSCP_LOCAL_CONTAINER_REMOVED__; "
            + (removeImage && !imageName.empty()
                ? "docker image rm -f " + shellQuote(imageName) + " >/dev/null 2>&1 || true; echo __DOKSCP_LOCAL_IMAGE_REMOVE_ATTEMPTED__;"
                : "")
        );
    std::string output;
    const int exitCode = runLocalCommand(command, output);
    result.exitCode = exitCode;
    result.output = output;
    if (exitCode != 0 || output.find("__DOKSCP_LOCAL_CONTAINER_REMOVED__") == std::string::npos) {
        result.error = exitCode == 124 ? "Local Docker runtime removal timed out" : "Failed to remove local Docker runtime";
        return result;
    }
    result.success = true;
    return result;
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

std::string sanitizeRemoteWorkspaceSegment(const std::string& raw) {
    std::string cleaned;
    cleaned.reserve(std::min<size_t>(raw.size(), 128));
    for (char c : raw) {
        const bool ok = std::isalnum(static_cast<unsigned char>(c)) ||
                        c == '_' || c == '.' || c == '-';
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

std::vector<std::pair<std::string, std::string>> loadProjectEnvVarPairs(pqxx::transaction_base& txn,
                                                                         const std::string& projectId) {
    std::vector<std::pair<std::string, std::string>> envVars;
    auto rows = txn.exec_params(
        "SELECT key, value_encrypted FROM project_env_vars WHERE project_id = $1 ORDER BY key ASC",
        projectId
    );
    envVars.reserve(rows.size());
    for (const auto& row : rows) {
        envVars.emplace_back(
            row["key"].as<std::string>(),
            TokenCrypto::decrypt(row["value_encrypted"].as<std::string>())
        );
    }
    return envVars;
}

std::vector<std::pair<std::string, std::string>> loadDeploymentEnvVarPairs(pqxx::transaction_base& txn,
                                                                           const std::string& deploymentId) {
    std::vector<std::pair<std::string, std::string>> envVars;
    auto rows = txn.exec_params(
        "SELECT key, value_encrypted FROM deployment_env_vars WHERE deployment_id = $1 ORDER BY key ASC",
        deploymentId
    );
    envVars.reserve(rows.size());
    for (const auto& row : rows) {
        envVars.emplace_back(
            row["key"].as<std::string>(),
            TokenCrypto::decrypt(row["value_encrypted"].as<std::string>())
        );
    }
    return envVars;
}

std::string sanitizeHealthPath(std::string value) {
    value = trim(value);
    if (value.empty()) {
        return "/";
    }
    if (value.front() != '/') {
        value.insert(value.begin(), '/');
    }
    if (value.size() > 128) {
        value.resize(128);
    }
    for (char& c : value) {
        if (std::iscntrl(static_cast<unsigned char>(c)) || c == '"' || c == '\'' || c == '\\') {
            c = '-';
        }
    }
    return value;
}

std::string normalizeResourcePreset(std::string value) {
    value = toLower(trim(value));
    if (value == "medium" || value == "large") {
        return value;
    }
    return "small";
}

int runLocalCommand(const std::string& command, std::string& output) {
    output.clear();
    FILE* pipe = popen(command.c_str(), "r");
    if (!pipe) {
        output = "Failed to start local command";
        return 1;
    }

    char buffer[4096];
    while (fgets(buffer, sizeof(buffer), pipe) != nullptr) {
        output += buffer;
    }

    const int status = pclose(pipe);
#ifdef _WIN32
    return status;
#else
    if (WIFEXITED(status)) {
        return WEXITSTATUS(status);
    }
    return status;
#endif
}

SshOperationResult removeLocalDockerImage(const std::string& imageName) {
    SshOperationResult result;
    if (!isValidDockerImageRefForCleanup(imageName)) {
        result.error = "Invalid or missing Docker image reference";
        return result;
    }

    std::string registryImage = "localhost:5000/" + imageName;
    const std::string dockerIoPrefix = "localhost:5000/docker.io/";
    if (registryImage.rfind(dockerIoPrefix, 0) == 0) {
        registryImage = "localhost:5000/" + registryImage.substr(dockerIoPrefix.size());
    }

    const std::string command =
        "timeout 45s sh -lc " + shellQuote(
            "set -e; "
            "command -v docker >/dev/null 2>&1 || { echo __DOKSCP_DOCKER_MISSING__; exit 10; }; "
            "docker info >/dev/null 2>&1 || { echo __DOKSCP_DOCKER_DAEMON_DOWN__; exit 11; }; "
            "failed=0; "
            "for img in " + shellQuote(imageName) + " " + shellQuote(registryImage) + "; do "
            "  [ -n \"$img\" ] || continue; "
            "  if docker image inspect \"$img\" >/dev/null 2>&1; then "
            "    if docker image rm \"$img\" >/dev/null 2>&1; then "
            "      echo __DOKSCP_LOCAL_IMAGE_REMOVED__=$img; "
            "    else "
            "      echo __DOKSCP_LOCAL_IMAGE_REMOVE_FAILED__=$img; failed=1; "
            "    fi; "
            "  else "
            "    echo __DOKSCP_LOCAL_IMAGE_ALREADY_ABSENT__=$img; "
            "  fi; "
            "done; "
            "[ \"$failed\" -eq 0 ] || exit 12; "
            "echo __DOKSCP_LOCAL_IMAGE_CLEANUP_DONE__"
        );

    std::string output;
    const int exitCode = runLocalCommand(command, output);
    result.exitCode = exitCode;
    result.output = output;
    if (exitCode != 0 || output.find("__DOKSCP_LOCAL_IMAGE_CLEANUP_DONE__") == std::string::npos) {
        if (output.find("__DOKSCP_DOCKER_MISSING__") != std::string::npos) {
            result.error = "Docker is not installed on this host";
        } else if (output.find("__DOKSCP_DOCKER_DAEMON_DOWN__") != std::string::npos) {
            result.error = "Docker daemon is not reachable on this host";
        } else if (output.find("__DOKSCP_LOCAL_IMAGE_REMOVE_FAILED__") != std::string::npos) {
            result.error = "Docker image could not be deleted because it may still be in use";
        } else if (exitCode == 124) {
            result.error = "Docker image cleanup timed out";
        } else {
            result.error = "Failed to remove Docker image";
        }
        return result;
    }
    result.success = true;
    return result;
}

double parseMetricNumber(const std::string& raw) {
    const std::string value = trim(raw);
    if (value.empty()) {
        return 0.0;
    }

    try {
        size_t parsed = 0;
        return std::stod(value, &parsed);
    } catch (...) {
        return 0.0;
    }
}

double parsePercentValue(const std::string& raw) {
    std::string value = trim(raw);
    value.erase(std::remove(value.begin(), value.end(), '%'), value.end());
    return parseMetricNumber(value);
}

long long parseByteQuantity(const std::string& raw) {
    std::string value = trim(raw);
    value.erase(std::remove(value.begin(), value.end(), ' '), value.end());
    if (value.empty() || value == "-") {
        return 0;
    }

    size_t index = 0;
    while (index < value.size() &&
           (std::isdigit(static_cast<unsigned char>(value[index])) || value[index] == '.')) {
        ++index;
    }

    const double amount = parseMetricNumber(value.substr(0, index));
    std::string unit = toLower(value.substr(index));
    double multiplier = 1.0;
    if (unit == "b" || unit.empty()) multiplier = 1.0;
    else if (unit == "kb") multiplier = 1000.0;
    else if (unit == "kib") multiplier = 1024.0;
    else if (unit == "mb") multiplier = 1000.0 * 1000.0;
    else if (unit == "mib") multiplier = 1024.0 * 1024.0;
    else if (unit == "gb") multiplier = 1000.0 * 1000.0 * 1000.0;
    else if (unit == "gib") multiplier = 1024.0 * 1024.0 * 1024.0;
    else if (unit == "tb") multiplier = 1000.0 * 1000.0 * 1000.0 * 1000.0;
    else if (unit == "tib") multiplier = 1024.0 * 1024.0 * 1024.0 * 1024.0;
    return static_cast<long long>(amount * multiplier);
}

std::pair<long long, long long> parseBytePair(const std::string& raw) {
    const auto parts = splitString(raw, '/');
    if (parts.size() < 2) {
        const long long value = parseByteQuantity(raw);
        return {value, 0};
    }
    return {parseByteQuantity(parts[0]), parseByteQuantity(parts[1])};
}

long long parseCpuMillicores(const std::string& raw) {
    std::string value = trim(raw);
    if (value.empty()) {
        return 0;
    }

    if (value.back() == 'm') {
        value.pop_back();
        return static_cast<long long>(parseMetricNumber(value));
    }

    return static_cast<long long>(parseMetricNumber(value) * 1000.0);
}

std::string makeHostMetricsCommandSegment() {
    return
        "printf 'cpu_name='; "
        "awk -F': ' '/model name/ {print $2; exit}' /proc/cpuinfo 2>/dev/null | tr -d '\\n'; echo; "
        "printf 'host_memory_total='; "
        "awk '/MemTotal/ {printf \"%s\", $2 * 1024}' /proc/meminfo 2>/dev/null; echo; "
        "printf 'temp='; "
        "if [ -r /sys/class/thermal/thermal_zone0/temp ]; then "
        "awk '{printf \"%.1f\", $1/1000}' /sys/class/thermal/thermal_zone0/temp; "
        "elif command -v sensors >/dev/null 2>&1; then "
        "sensors 2>/dev/null | awk '/Package id 0|Tctl|CPU/ {for(i=1;i<=NF;i++) if($i ~ /^\\+/) {gsub(/[+C]/,\"\",$i); print $i; exit}}' | tr -d '\\n'; "
        "fi; echo; "
        "printf 'gpu_name='; "
        "if command -v nvidia-smi >/dev/null 2>&1; then "
        "nvidia-smi --query-gpu=name --format=csv,noheader | head -n1 | tr -d '\\n'; "
        "elif command -v lspci >/dev/null 2>&1; then "
        "lspci | awk '/VGA|3D|Display/ {sub(/^[^:]+: /, \"\"); print; exit}' | tr -d '\\n'; "
        "fi; echo; "
        "printf 'gpu='; "
        "if command -v nvidia-smi >/dev/null 2>&1; then "
        "nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits | head -n1; "
        "else "
        "for gpu_busy in /sys/class/drm/card*/device/gpu_busy_percent; do "
        "if [ -r \"$gpu_busy\" ]; then busy=$(cat \"$gpu_busy\" 2>/dev/null | head -n1); printf '%s,,,' \"$busy\"; break; fi; "
        "done; "
        "fi; echo";
}

std::string makeDockerMetricsCommand(const std::string& containerName) {
    const std::string container = shellQuote(containerName);
    return
        "docker stats --no-stream --format 'stats={{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.NetIO}}|{{.BlockIO}}|{{.PIDs}}' " + container + " 2>&1; "
        "docker inspect --format 'inspect=status={{.State.Status}}|restart_count={{.RestartCount}}|image={{.Config.Image}}' " + container + " 2>&1; " +
        makeHostMetricsCommandSegment();
}

Json::Value parseDockerMetrics(const std::string& output,
                               const std::string& provider,
                               const std::string& deploymentId) {
    Json::Value payload;
    payload["deployment_id"] = deploymentId;
    payload["provider"] = provider;
    payload["timestamp"] = trantor::Date::now().toFormattedString(false);
    payload["available"] = false;
    payload["message"] = "Docker metrics are not available for this runtime.";

    Json::Value summary;
    Json::Value host;
    Json::Value series(Json::arrayValue);
    summary["available"] = false;
    host["cpu_temperature_celsius"] = Json::Value();
    host["gpu_usage_percent"] = Json::Value();
    host["gpu_memory_percent"] = Json::Value();
    host["gpu_temperature_celsius"] = Json::Value();
    host["cpu_name"] = "";
    host["gpu_name"] = "";
    host["host_memory_total_bytes"] = Json::Value();
    host["sensor_scope"] = "container";

    std::istringstream stream(output);
    std::string line;
    while (std::getline(stream, line)) {
        line = trim(line);
        if (line.rfind("stats=", 0) == 0 || line.rfind("dockerstats=", 0) == 0) {
            const size_t prefixLength = line.rfind("stats=", 0) == 0 ? 6 : 12;
            const auto parts = splitString(line.substr(prefixLength), '|');
            if (parts.size() >= 7) {
                const auto memory = parseBytePair(parts[2]);
                const auto network = parseBytePair(parts[4]);
                const auto block = parseBytePair(parts[5]);

                Json::Value item;
                item["name"] = trim(parts[0]);
                item["cpu_percent"] = parsePercentValue(parts[1]);
                item["memory_bytes"] = Json::Int64(memory.first);
                item["memory_limit_bytes"] = Json::Int64(memory.second);
                item["memory_percent"] = parsePercentValue(parts[3]);
                item["network_rx_bytes"] = Json::Int64(network.first);
                item["network_tx_bytes"] = Json::Int64(network.second);
                item["block_read_bytes"] = Json::Int64(block.first);
                item["block_write_bytes"] = Json::Int64(block.second);
                item["pids"] = static_cast<int>(parseMetricNumber(parts[6]));
                series.append(item);

                summary = item;
                summary["available"] = true;
                payload["available"] = true;
                payload["message"] = "Live Docker metrics";
            }
        } else if (line.rfind("inspect=", 0) == 0) {
            const auto fields = splitString(line.substr(8), '|');
            for (const auto& field : fields) {
                const auto pos = field.find('=');
                if (pos == std::string::npos) {
                    continue;
                }
                const std::string key = trim(field.substr(0, pos));
                const std::string value = trim(field.substr(pos + 1));
                if (key == "status") summary["container_status"] = value;
                if (key == "restart_count") summary["restart_count"] = value;
                if (key == "image") summary["image"] = value;
            }
        } else if (line.rfind("cpu_name=", 0) == 0) {
            host["cpu_name"] = trim(line.substr(9));
        } else if (line.rfind("host_memory_total=", 0) == 0) {
            const std::string value = trim(line.substr(18));
            if (!value.empty()) {
                host["host_memory_total_bytes"] = Json::Int64(static_cast<long long>(parseMetricNumber(value)));
            }
        } else if (line.rfind("temp=", 0) == 0) {
            const std::string value = trim(line.substr(5));
            if (!value.empty()) {
                host["cpu_temperature_celsius"] = parseMetricNumber(value);
            }
        } else if (line.rfind("gpu_name=", 0) == 0) {
            host["gpu_name"] = trim(line.substr(9));
        } else if (line.rfind("gpu=", 0) == 0) {
            const std::string value = trim(line.substr(4));
            if (!value.empty()) {
                const auto parts = splitString(value, ',');
                if (parts.size() >= 4) {
                    const double usage = parseMetricNumber(parts[0]);
                    const double used = parseMetricNumber(parts[1]);
                    const double total = parseMetricNumber(parts[2]);
                    host["gpu_usage_percent"] = usage;
                    if (total > 0) {
                        host["gpu_memory_percent"] = (used / total) * 100.0;
                    }
                    if (!trim(parts[3]).empty()) {
                        host["gpu_temperature_celsius"] = parseMetricNumber(parts[3]);
                    }
                }
            }
        }
    }

    payload["summary"] = summary;
    payload["host"] = host;
    payload["series"] = series;
    if (!payload["available"].asBool()) {
        payload["raw_error"] = output;
    }
    return payload;
}

std::string makeKubernetesMetricsCommand(const std::string& nameSpace, const std::string& deploymentName) {
    const std::string ns = shellQuote(nameSpace);
    const std::string dep = shellQuote(deploymentName);
    const std::string dockerNamePrefix = shellQuote("k8s_app_" + deploymentName + "-");
    const std::string dockerNamespaceMarker = shellQuote("_" + nameSpace + "_");
    return
        "kubectl get deployment " + dep + " -n " + ns + " -o jsonpath='deploy=ready={.status.readyReplicas}|replicas={.status.replicas}|unavailable={.status.unavailableReplicas}' 2>&1; echo; "
        "kubectl top pods -n " + ns + " -l app=" + dep + " --no-headers 2>&1; "
        "if command -v docker >/dev/null 2>&1; then "
        "names=$(docker ps --format '{{.Names}}' | awk -v prefix=" + dockerNamePrefix + " -v ns=" + dockerNamespaceMarker + " 'index($0,prefix)==1 && index($0,ns)>0 {print}'); "
        "if [ -n \"$names\" ]; then docker stats --no-stream --format 'dockerstats={{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.NetIO}}|{{.BlockIO}}|{{.PIDs}}' $names 2>&1; fi; "
        "fi; "
        + makeHostMetricsCommandSegment();
}

Json::Value parseKubernetesMetrics(const std::string& output,
                                   const std::string& deploymentId,
                                   const std::string& deploymentName) {
    Json::Value payload;
    payload["deployment_id"] = deploymentId;
    payload["provider"] = "kubernetes";
    payload["timestamp"] = trantor::Date::now().toFormattedString(false);
    payload["available"] = false;
    payload["message"] = "Kubernetes metrics are not available. Install or enable metrics-server to expose pod usage.";

    Json::Value summary;
    Json::Value host;
    Json::Value series(Json::arrayValue);
    summary["available"] = false;
    summary["deployment"] = deploymentName;
    host["cpu_temperature_celsius"] = Json::Value();
    host["gpu_usage_percent"] = Json::Value();
    host["gpu_memory_percent"] = Json::Value();
    host["gpu_temperature_celsius"] = Json::Value();
    host["cpu_name"] = "";
    host["gpu_name"] = "";
    host["host_memory_total_bytes"] = Json::Value();
    host["sensor_scope"] = "container";

    double totalCpuPercent = 0.0;
    long long totalCpuMillicores = 0;
    long long totalMemoryBytes = 0;
    long long totalMemoryLimitBytes = 0;
    int podCount = 0;

    std::istringstream stream(output);
    std::string line;
    while (std::getline(stream, line)) {
        line = trim(line);
        if (line.empty()) {
            continue;
        }

        if (line.rfind("deploy=", 0) == 0) {
            const auto fields = splitString(line.substr(7), '|');
            for (const auto& field : fields) {
                const auto pos = field.find('=');
                if (pos == std::string::npos) continue;
                const std::string key = trim(field.substr(0, pos));
                const std::string value = trim(field.substr(pos + 1));
                if (key == "ready") summary["ready_pods"] = value.empty() ? 0 : static_cast<int>(parseMetricNumber(value));
                if (key == "replicas") summary["pod_count"] = value.empty() ? 0 : static_cast<int>(parseMetricNumber(value));
                if (key == "unavailable") summary["unavailable_pods"] = value.empty() ? 0 : static_cast<int>(parseMetricNumber(value));
            }
            continue;
        }

        if (line.rfind("dockerstats=", 0) == 0) {
            const auto parts = splitString(line.substr(12), '|');
            if (parts.size() >= 7) {
                const auto memory = parseBytePair(parts[2]);
                const auto network = parseBytePair(parts[4]);
                const auto block = parseBytePair(parts[5]);

                Json::Value item;
                item["name"] = trim(parts[0]);
                item["cpu_percent"] = parsePercentValue(parts[1]);
                item["memory_bytes"] = Json::Int64(memory.first);
                item["memory_limit_bytes"] = Json::Int64(memory.second);
                item["memory_percent"] = parsePercentValue(parts[3]);
                item["network_rx_bytes"] = Json::Int64(network.first);
                item["network_tx_bytes"] = Json::Int64(network.second);
                item["block_read_bytes"] = Json::Int64(block.first);
                item["block_write_bytes"] = Json::Int64(block.second);
                item["pids"] = static_cast<int>(parseMetricNumber(parts[6]));
                item["container_status"] = "running";
                series.append(item);

                totalCpuMillicores += static_cast<long long>(parsePercentValue(parts[1]) * 10.0);
                totalCpuPercent += parsePercentValue(parts[1]);
                totalMemoryBytes += memory.first;
                totalMemoryLimitBytes += memory.second;
                ++podCount;
                continue;
            }
        }

        if (line.rfind("cpu_name=", 0) == 0) {
            host["cpu_name"] = trim(line.substr(9));
            continue;
        }

        if (line.rfind("host_memory_total=", 0) == 0) {
            const std::string value = trim(line.substr(18));
            if (!value.empty()) {
                host["host_memory_total_bytes"] = Json::Int64(static_cast<long long>(parseMetricNumber(value)));
            }
            continue;
        }

        if (line.rfind("temp=", 0) == 0) {
            const std::string value = trim(line.substr(5));
            if (!value.empty()) {
                host["cpu_temperature_celsius"] = parseMetricNumber(value);
            }
            continue;
        }

        if (line.rfind("gpu_name=", 0) == 0) {
            host["gpu_name"] = trim(line.substr(9));
            continue;
        }

        if (line.rfind("gpu=", 0) == 0) {
            const std::string value = trim(line.substr(4));
            if (!value.empty()) {
                const auto parts = splitString(value, ',');
                if (!parts.empty() && !trim(parts[0]).empty()) {
                    host["gpu_usage_percent"] = parseMetricNumber(parts[0]);
                }
                if (parts.size() >= 3) {
                    const double used = parseMetricNumber(parts[1]);
                    const double total = parseMetricNumber(parts[2]);
                    if (total > 0) {
                        host["gpu_memory_percent"] = (used / total) * 100.0;
                    }
                }
                if (parts.size() >= 4 && !trim(parts[3]).empty()) {
                    host["gpu_temperature_celsius"] = parseMetricNumber(parts[3]);
                }
            }
            continue;
        }

        if (line.rfind("error:", 0) == 0 || line.find("Metrics API not available") != std::string::npos ||
            line.find("not found") != std::string::npos || line.find("unknown command") != std::string::npos) {
            payload["raw_error"] = line;
            continue;
        }

        std::istringstream podLine(line);
        std::string podName;
        std::string cpu;
        std::string memory;
        podLine >> podName >> cpu >> memory;
        if (podName.empty() || cpu.empty() || memory.empty()) {
            continue;
        }

        const long long cpuMillicores = parseCpuMillicores(cpu);
        const long long memoryBytes = parseByteQuantity(memory);
        Json::Value item;
        item["name"] = podName;
        item["cpu_millicores"] = Json::Int64(cpuMillicores);
        item["cpu_percent"] = cpuMillicores / 10.0;
        item["memory_bytes"] = Json::Int64(memoryBytes);
        item["memory_percent"] = Json::Value();
        series.append(item);

        totalCpuMillicores += cpuMillicores;
        totalCpuPercent += cpuMillicores / 10.0;
        totalMemoryBytes += memoryBytes;
        ++podCount;
    }

    if (podCount > 0) {
        payload["available"] = true;
        payload["message"] = "Live Kubernetes pod metrics";
        summary["available"] = true;
        summary["cpu_millicores"] = Json::Int64(totalCpuMillicores);
        summary["cpu_percent"] = totalCpuPercent;
        summary["memory_bytes"] = Json::Int64(totalMemoryBytes);
        summary["memory_limit_bytes"] = Json::Int64(totalMemoryLimitBytes);
        if (totalMemoryLimitBytes > 0) {
            summary["memory_percent"] = (static_cast<double>(totalMemoryBytes) / static_cast<double>(totalMemoryLimitBytes)) * 100.0;
        } else {
            summary["memory_percent"] = Json::Value();
        }
        if (!summary.isMember("pod_count")) {
            summary["pod_count"] = podCount;
        }
        if (!summary.isMember("ready_pods")) {
            summary["ready_pods"] = podCount;
        }
    }

    payload["summary"] = summary;
    payload["host"] = host;
    payload["series"] = series;
    return payload;
}

} // namespace

std::string DeploymentController::extractUserId(const drogon::HttpRequestPtr& req) {
    auto payload = JwtHelper::verifyRequestToken(req);
    if (payload.isNull()) return "";
    return payload["user_id"].asString();
}

void DeploymentController::createDeployment(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& projectId
) {
    std::string userId = extractUserId(req);
    if (userId.empty()) {
        Json::Value err; err["error"] = "Unauthorized";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp); return;
    }

    try {
        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);

        // Verify project ownership
        auto check = txn.exec_params("SELECT id, source_type, repo_url FROM projects WHERE id = $1 AND user_id = $2", projectId, userId);
        if (check.empty()) {
            Json::Value err; err["error"] = "Project not found";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp); return;
        }
        const std::string projectSourceType = check[0]["source_type"].is_null() ? "github" : check[0]["source_type"].as<std::string>();
        const std::string projectRepoUrl = check[0]["repo_url"].is_null() ? "" : trim(check[0]["repo_url"].as<std::string>());

        auto body = req->getJsonObject();
        if (!body) {
            Json::Value err; err["error"] = "Invalid JSON body";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp); return;
        }

        std::string version = trim((*body).isMember("version") ? (*body)["version"].asString() : "v1.0.0");
        std::string commitHash = trim((*body).isMember("commit_hash") ? (*body)["commit_hash"].asString() : "");
        std::string commitSha = trim((*body).isMember("commit_sha") ? (*body)["commit_sha"].asString() : "");
        std::string branch = trim((*body).isMember("branch") ? (*body)["branch"].asString() : "");
        std::string triggerSource = trim((*body).isMember("trigger_source") ? (*body)["trigger_source"].asString() : "manual");
        std::string githubDeliveryId = trim((*body).isMember("github_delivery_id") ? (*body)["github_delivery_id"].asString() : "");
        std::string environmentId = trim((*body).isMember("environment_id") ? (*body)["environment_id"].asString() : "");
        std::string sourceArtifactId = trim((*body).isMember("source_artifact_id") ? (*body)["source_artifact_id"].asString() : "");
        bool ciRequired = (*body).isMember("ci_required") && (*body)["ci_required"].asBool();

        if (commitSha.empty() && looksLikeGitCommitSha(commitHash)) {
            commitSha = commitHash;
        }
        if (!commitSha.empty() && !looksLikeGitCommitSha(commitSha)) {
            Json::Value err; err["error"] = "Commit SHA must be a 7-64 character hexadecimal Git SHA";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp); return;
        }

        std::string environmentName;
        if (environmentId.empty()) {
            auto defaultEnvRows = txn.exec_params(
                "SELECT id, name, branch, require_ci FROM project_environments "
                "WHERE project_id = $1 "
                "ORDER BY "
                "CASE "
                "WHEN lower(name) = 'production' THEN 0 "
                "WHEN lower(branch) IN ('main', 'master') THEN 1 "
                "WHEN lower(name) = 'development' THEN 2 "
                "ELSE 3 END, "
                "name ASC LIMIT 1",
                projectId
            );
            if (!defaultEnvRows.empty()) {
                environmentId = defaultEnvRows[0]["id"].as<std::string>();
                environmentName = defaultEnvRows[0]["name"].as<std::string>();
                if (branch.empty()) {
                    branch = defaultEnvRows[0]["branch"].as<std::string>();
                }
                ciRequired = ciRequired || (triggerSource == "github_push" && projectSourceType == "github" &&
                                            !projectRepoUrl.empty() && !commitSha.empty() &&
                                            defaultEnvRows[0]["require_ci"].as<bool>());
            }
        }

        if (!environmentId.empty() && environmentName.empty()) {
            auto envRows = txn.exec_params(
                "SELECT name, branch, require_ci FROM project_environments WHERE id = $1 AND project_id = $2",
                environmentId,
                projectId
            );
            if (envRows.empty()) {
                Json::Value err; err["error"] = "Project environment not found";
                auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
                resp->setStatusCode(drogon::k404NotFound);
                callback(resp); return;
            }
            environmentName = envRows[0]["name"].as<std::string>();
            if (branch.empty()) {
                branch = envRows[0]["branch"].as<std::string>();
            }
            ciRequired = ciRequired || (triggerSource == "github_push" && projectSourceType == "github" &&
                                        !projectRepoUrl.empty() && !commitSha.empty() &&
                                        envRows[0]["require_ci"].as<bool>());
        }

        if (commitHash.empty()) {
            commitHash = !commitSha.empty() ? commitSha : (!branch.empty() ? "branch:" + branch : "manual");
        }

        if (!sourceArtifactId.empty()) {
            auto artifactRows = txn.exec_params(
                "SELECT id FROM source_artifacts WHERE id = $1 AND user_id = $2",
                sourceArtifactId,
                userId
            );
            if (artifactRows.empty()) {
                Json::Value err; err["error"] = "Source artifact not found";
                auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
                resp->setStatusCode(drogon::k404NotFound);
                callback(resp); return;
            }
        }

        auto result = txn.exec_params(
            "INSERT INTO deployments "
            "(project_id, version, commit_hash, environment_id, source_artifact_id, branch, commit_sha, trigger_source, github_delivery_id, ci_required, ci_status) "
            "VALUES ($1, $2, $3, NULLIF($4, '')::uuid, NULLIF($5, '')::uuid, $6, $7, $8, $9, $10, $11) "
            "RETURNING id, status, version, commit_hash, branch, commit_sha, trigger_source, ci_required, ci_status, logs, created_at",
            projectId,
            version,
            commitHash,
            environmentId,
            sourceArtifactId,
            branch,
            commitSha,
            triggerSource,
            githubDeliveryId,
            ciRequired,
            ciRequired ? "pending" : "not_required"
        );
        txn.commit();

        Json::Value dep;
        dep["id"] = result[0]["id"].as<std::string>();
        dep["project_id"] = projectId;
        dep["status"] = result[0]["status"].as<std::string>();
        dep["version"] = result[0]["version"].as<std::string>();
        dep["commit_hash"] = result[0]["commit_hash"].as<std::string>();
        dep["environment_id"] = environmentId;
        dep["environment_name"] = environmentName;
        dep["branch"] = result[0]["branch"].as<std::string>();
        dep["commit_sha"] = result[0]["commit_sha"].as<std::string>();
        dep["trigger_source"] = result[0]["trigger_source"].as<std::string>();
        dep["ci_required"] = result[0]["ci_required"].as<bool>();
        dep["ci_status"] = result[0]["ci_status"].as<std::string>();
        dep["logs"] = result[0]["logs"].as<std::string>();
        dep["created_at"] = result[0]["created_at"].as<std::string>();

        Json::Value resp_body;
        resp_body["message"] = "Deployment initiated";
        resp_body["deployment"] = dep;
        Json::Value auditMeta;
        auditMeta["project_id"] = projectId;
        auditMeta["version"] = version;
        auditMeta["trigger_source"] = triggerSource;
        auditMeta["branch"] = branch;
        auditMeta["ci_required"] = ciRequired;
        AuditLogger::recordFromRequest(req, userId, "deployment.created", "deployment", dep["id"].asString(), auditMeta);
        auto resp = drogon::HttpResponse::newHttpJsonResponse(resp_body);
        resp->setStatusCode(drogon::k201Created);
        callback(resp);
        broadcastDeploymentSummary(dep["id"].asString());

    } catch (const std::exception& e) {
        spdlog::error("Create deployment error: {}", e.what());
        Json::Value err; err["error"] = "Internal server error";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void DeploymentController::listDeployments(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& projectId
) {
    std::string userId = extractUserId(req);
    if (userId.empty()) {
        Json::Value err; err["error"] = "Unauthorized";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp); return;
    }

    try {
        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);

        auto check = txn.exec_params("SELECT id FROM projects WHERE id = $1 AND user_id = $2", projectId, userId);
        if (check.empty()) {
            Json::Value err; err["error"] = "Project not found";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp); return;
        }

        auto result = txn.exec_params(
            "SELECT d.id, d.status, d.version, d.commit_hash, d.environment_id, e.name AS environment_name, "
            "d.branch, d.commit_sha, d.trigger_source, d.github_delivery_id, d.ci_required, d.ci_status, d.image_name, "
            "d.k8s_namespace, d.k8s_deployment_name, d.k8s_service_name, d.k8s_ingress_name, d.desired_replicas, "
            "d.runtime_url, d.runtime_exposure, d.runtime_provider, d.remote_container_name, d.runtime_paused, "
            "d.runtime_snapshot::text AS runtime_snapshot, d.created_at "
            "FROM deployments d "
            "LEFT JOIN project_environments e ON d.environment_id = e.id "
            "WHERE d.project_id = $1 ORDER BY d.created_at DESC",
            projectId
        );
        txn.commit();

        Json::Value deps(Json::arrayValue);
        for (const auto& row : result) {
            Json::Value dep;
            dep["id"] = row["id"].as<std::string>();
            dep["status"] = row["status"].as<std::string>();
            dep["version"] = row["version"].as<std::string>();
            dep["commit_hash"] = row["commit_hash"].as<std::string>();
            dep["environment_id"] = row["environment_id"].is_null() ? "" : row["environment_id"].as<std::string>();
            dep["environment_name"] = row["environment_name"].is_null() ? "" : row["environment_name"].as<std::string>();
            dep["branch"] = row["branch"].is_null() ? "" : row["branch"].as<std::string>();
            dep["commit_sha"] = row["commit_sha"].is_null() ? "" : row["commit_sha"].as<std::string>();
            dep["trigger_source"] = row["trigger_source"].is_null() ? "manual" : row["trigger_source"].as<std::string>();
            dep["github_delivery_id"] = row["github_delivery_id"].is_null() ? "" : row["github_delivery_id"].as<std::string>();
            dep["ci_required"] = row["ci_required"].is_null() ? false : row["ci_required"].as<bool>();
            dep["ci_status"] = row["ci_status"].is_null() ? "not_required" : row["ci_status"].as<std::string>();
            hydrateDeploymentRuntimeFields(dep, row);
            dep["created_at"] = row["created_at"].as<std::string>();
            deps.append(dep);
        }

        Json::Value resp_body;
        resp_body["deployments"] = deps;
        resp_body["count"] = static_cast<int>(deps.size());
        callback(drogon::HttpResponse::newHttpJsonResponse(resp_body));

    } catch (const std::exception& e) {
        spdlog::error("List deployments error: {}", e.what());
        Json::Value err; err["error"] = "Internal server error";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void DeploymentController::listUserDeployments(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback
) {
    std::string userId = extractUserId(req);
    if (userId.empty()) {
        Json::Value err; err["error"] = "Unauthorized";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp); return;
    }

    try {
        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);

        auto result = txn.exec_params(
            "SELECT d.id, d.project_id, p.name AS project_name, p.repo_url, d.status, d.version, d.commit_hash, "
            "d.environment_id, e.name AS environment_name, d.branch, d.commit_sha, d.trigger_source, "
            "d.github_delivery_id, d.ci_required, d.ci_status, d.image_name, "
            "d.k8s_namespace, d.k8s_deployment_name, d.k8s_service_name, d.k8s_ingress_name, "
            "d.desired_replicas, d.runtime_url, d.runtime_exposure, d.runtime_provider, d.remote_container_name, "
            "d.runtime_paused, d.runtime_snapshot::text AS runtime_snapshot, d.created_at "
            "FROM deployments d "
            "JOIN projects p ON d.project_id = p.id "
            "LEFT JOIN project_environments e ON d.environment_id = e.id "
            "WHERE p.user_id = $1 "
            "ORDER BY d.created_at DESC",
            userId
        );
        txn.commit();

        Json::Value deps(Json::arrayValue);
        for (const auto& row : result) {
            Json::Value dep;
            dep["id"] = row["id"].as<std::string>();
            dep["project_id"] = row["project_id"].as<std::string>();
            dep["project_name"] = row["project_name"].as<std::string>();
            dep["repo_url"] = row["repo_url"].is_null() ? "" : row["repo_url"].as<std::string>();
            dep["status"] = row["status"].as<std::string>();
            dep["version"] = row["version"].as<std::string>();
            dep["commit_hash"] = row["commit_hash"].as<std::string>();
            dep["environment_id"] = row["environment_id"].is_null() ? "" : row["environment_id"].as<std::string>();
            dep["environment_name"] = row["environment_name"].is_null() ? "" : row["environment_name"].as<std::string>();
            dep["branch"] = row["branch"].is_null() ? "" : row["branch"].as<std::string>();
            dep["commit_sha"] = row["commit_sha"].is_null() ? "" : row["commit_sha"].as<std::string>();
            dep["trigger_source"] = row["trigger_source"].is_null() ? "manual" : row["trigger_source"].as<std::string>();
            dep["github_delivery_id"] = row["github_delivery_id"].is_null() ? "" : row["github_delivery_id"].as<std::string>();
            dep["ci_required"] = row["ci_required"].is_null() ? false : row["ci_required"].as<bool>();
            dep["ci_status"] = row["ci_status"].is_null() ? "not_required" : row["ci_status"].as<std::string>();
            hydrateDeploymentRuntimeFields(dep, row);
            dep["created_at"] = row["created_at"].as<std::string>();
            deps.append(dep);
        }

        Json::Value resp_body;
        resp_body["deployments"] = deps;
        resp_body["count"] = static_cast<int>(deps.size());
        callback(drogon::HttpResponse::newHttpJsonResponse(resp_body));

    } catch (const std::exception& e) {
        spdlog::error("List user deployments error: {}", e.what());
        Json::Value err; err["error"] = "Internal server error";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void DeploymentController::triggerBuild(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& deploymentId
) {
    std::string userId = extractUserId(req);
    if (userId.empty()) {
        Json::Value err; err["error"] = "Unauthorized";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp); return;
    }

    try {
        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);
        auto rows = txn.exec_params(
            "SELECT d.id, d.status, p.name AS project_name, p.repo_url, p.source_type, p.source_path, "
            "COALESCE(e.execution_mode, p.execution_mode) AS execution_mode, "
            "COALESCE(e.remote_runtime_type, p.remote_runtime_type) AS remote_runtime_type, "
            "COALESCE(e.remote_connection_id, p.remote_connection_id) AS remote_connection_id, "
            "p.ssh_connection_id "
            "FROM deployments d "
            "JOIN projects p ON d.project_id = p.id "
            "LEFT JOIN project_environments e ON d.environment_id = e.id AND e.project_id = p.id "
            "WHERE d.id = $1 AND p.user_id = $2",
            deploymentId,
            userId
        );

        if (rows.empty()) {
            Json::Value err; err["error"] = "Deployment not found";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp); return;
        }

        const std::string currentStatus = rows[0]["status"].as<std::string>();
        if (currentStatus == "queued" || currentStatus == "building") {
            Json::Value err; err["error"] = "Build is already queued or running for this deployment";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k409Conflict);
            callback(resp); return;
        }

        const std::string sourceType =
            rows[0]["source_type"].is_null() ? "github" : rows[0]["source_type"].as<std::string>();
        const std::string repoUrl = rows[0]["repo_url"].is_null() ? "" : rows[0]["repo_url"].as<std::string>();
        const std::string sourcePath =
            rows[0]["source_path"].is_null() ? "" : rows[0]["source_path"].as<std::string>();
        const std::string executionMode =
            rows[0]["execution_mode"].is_null() ? "local" : rows[0]["execution_mode"].as<std::string>();
        const std::string remoteRuntimeType =
            rows[0]["remote_runtime_type"].is_null() ? "docker" : rows[0]["remote_runtime_type"].as<std::string>();

        if (sourceType == "github" && repoUrl.empty()) {
            Json::Value err; err["error"] = "Project repository URL is required before triggering a build";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp); return;
        }
        if ((sourceType == "ssh" || sourceType == "local") && sourcePath.empty()) {
            Json::Value err; err["error"] = "Project source path is required before triggering a build";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp); return;
        }
        if (sourceType == "ssh" && rows[0]["ssh_connection_id"].is_null()) {
            Json::Value err; err["error"] = "Project SSH connection is missing or no longer available";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp); return;
        }
        if (executionMode == "remote_host" && rows[0]["remote_connection_id"].is_null()) {
            Json::Value err; err["error"] = "Remote execution connection is missing or no longer available";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp); return;
        }
        if (executionMode == "remote_host" && remoteRuntimeType != "docker" && remoteRuntimeType != "kubernetes") {
            Json::Value err; err["error"] = "Remote host runtime must be Docker or Kubernetes";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp); return;
        }
        txn.commit();

        Json::Value job = JobQueueService::getInstance().enqueueDeploymentBuild(
            deploymentId,
            userId,
            "Deployment queued for background worker."
        );

        Json::Value auditMeta;
        auditMeta["project_name"] = rows[0]["project_name"].as<std::string>();
        auditMeta["source_type"] = sourceType;
        auditMeta["execution_mode"] = executionMode;
        auditMeta["remote_runtime_type"] = remoteRuntimeType;
        auditMeta["job_id"] = job["id"].asString();
        AuditLogger::recordFromRequest(req, userId, "deployment.build_queued", "deployment", deploymentId, auditMeta);

        Json::Value payload;
        payload["message"] = "Build queued";
        payload["deployment_id"] = deploymentId;
        payload["status"] = "queued";
        payload["job"] = job;
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k202Accepted);
        callback(resp);
        return;
    } catch (const std::exception& e) {
        spdlog::error("Queue deployment build error for {}: {}", deploymentId, e.what());
        Json::Value err; err["error"] = "Internal server error";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
        return;
    }

    try {
        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);

        auto deploymentRows = txn.exec_params(
            "SELECT d.id, d.version, d.status, p.name AS project_name, p.repo_url, p.github_pat, p.source_type, p.ssh_connection_id, p.source_path, "
            "p.execution_mode, p.remote_runtime_type, p.remote_k8s_exposure, p.remote_connection_id, p.runtime_scheme, p.local_https_enabled, "
            "u.github_access_token, COALESCE(s.connection_type, 'ssh') AS connection_type, s.host, s.port, s.username, s.auth_type, "
            "s.password_encrypted, s.private_key_encrypted, s.known_hosts_entry, "
            "COALESCE(rs.connection_type, 'ssh') AS remote_connection_type, rs.host AS remote_host, rs.port AS remote_port, rs.username AS remote_username, "
            "rs.auth_type AS remote_auth_type, rs.password_encrypted AS remote_password_encrypted, rs.private_key_encrypted AS remote_private_key_encrypted, "
            "rs.known_hosts_entry AS remote_known_hosts_entry "
            "FROM deployments d "
            "JOIN projects p ON d.project_id = p.id "
            "JOIN users u ON p.user_id = u.id "
            "LEFT JOIN ssh_connections s ON p.ssh_connection_id = s.id "
            "LEFT JOIN ssh_connections rs ON p.remote_connection_id = rs.id "
            "WHERE d.id = $1 AND p.user_id = $2",
            deploymentId, userId
        );

        if (deploymentRows.empty()) {
            Json::Value err; err["error"] = "Deployment not found";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp); return;
        }

        const std::string version = deploymentRows[0]["version"].as<std::string>();
        const std::string currentStatus = deploymentRows[0]["status"].as<std::string>();
        const std::string projectName = deploymentRows[0]["project_name"].as<std::string>();
        const std::string sourceType =
            deploymentRows[0]["source_type"].is_null() ? "github" : deploymentRows[0]["source_type"].as<std::string>();
        const std::string executionMode =
            deploymentRows[0]["execution_mode"].is_null() ? "local" : deploymentRows[0]["execution_mode"].as<std::string>();
        const std::string remoteRuntimeType =
            deploymentRows[0]["remote_runtime_type"].is_null() ? "docker" : deploymentRows[0]["remote_runtime_type"].as<std::string>();
        const std::string remoteK8sExposure =
            deploymentRows[0]["remote_k8s_exposure"].is_null() ? "nodeport" : deploymentRows[0]["remote_k8s_exposure"].as<std::string>();
        const std::string runtimeScheme = normalizeRuntimeScheme(
            deploymentRows[0]["runtime_scheme"].is_null() ? "http" : deploymentRows[0]["runtime_scheme"].as<std::string>()
        );
        const bool localHttpsEnabled =
            deploymentRows[0]["local_https_enabled"].is_null() ? false : deploymentRows[0]["local_https_enabled"].as<bool>();
        const std::string repoUrl = deploymentRows[0]["repo_url"].as<std::string>();
        const std::string sourcePath =
            deploymentRows[0]["source_path"].is_null() ? "" : deploymentRows[0]["source_path"].as<std::string>();
        const std::string projectToken = TokenCrypto::decrypt(deploymentRows[0]["github_pat"].as<std::string>());
        const std::string linkedGitHubToken =
            deploymentRows[0]["github_access_token"].is_null()
                ? ""
                : TokenCrypto::decrypt(deploymentRows[0]["github_access_token"].as<std::string>());
        const std::string githubPat = !projectToken.empty() ? projectToken : linkedGitHubToken;
        std::vector<BuildEnvVar> envVars;
        SshConnectionConfig sshConfig;
        SshConnectionConfig remoteExecutionConfig;
        if (sourceType == "ssh") {
            if (deploymentRows[0]["host"].is_null() || deploymentRows[0]["username"].is_null() ||
                deploymentRows[0]["auth_type"].is_null()) {
                Json::Value err; err["error"] = "Project SSH connection is missing or no longer available";
                auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
                resp->setStatusCode(drogon::k400BadRequest);
                callback(resp); return;
            }
            sshConfig.connectionType = deploymentRows[0]["connection_type"].as<std::string>();
            sshConfig.host = deploymentRows[0]["host"].as<std::string>();
            sshConfig.port = deploymentRows[0]["port"].is_null() ? 22 : deploymentRows[0]["port"].as<int>();
            sshConfig.username = deploymentRows[0]["username"].as<std::string>();
            sshConfig.authType = deploymentRows[0]["auth_type"].as<std::string>();
            sshConfig.password = deploymentRows[0]["password_encrypted"].is_null()
                ? ""
                : TokenCrypto::decrypt(deploymentRows[0]["password_encrypted"].as<std::string>());
            sshConfig.privateKey = deploymentRows[0]["private_key_encrypted"].is_null()
                ? ""
                : TokenCrypto::decrypt(deploymentRows[0]["private_key_encrypted"].as<std::string>());
            sshConfig.knownHostsEntry = deploymentRows[0]["known_hosts_entry"].as<std::string>();
        }
        if (executionMode == "remote_host") {
            if (sourceType == "local") {
                Json::Value err; err["error"] = "Remote host execution does not support local source projects";
                auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
                resp->setStatusCode(drogon::k400BadRequest);
                callback(resp); return;
            }
            if (remoteRuntimeType != "docker" && remoteRuntimeType != "kubernetes") {
                Json::Value err; err["error"] = "Remote host runtime must be Docker or Kubernetes";
                auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
                resp->setStatusCode(drogon::k400BadRequest);
                callback(resp); return;
            }
            if (deploymentRows[0]["remote_host"].is_null() || deploymentRows[0]["remote_username"].is_null() ||
                deploymentRows[0]["remote_auth_type"].is_null()) {
                Json::Value err; err["error"] = "Remote execution connection is missing or no longer available";
                auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
                resp->setStatusCode(drogon::k400BadRequest);
                callback(resp); return;
            }
            remoteExecutionConfig.connectionType = deploymentRows[0]["remote_connection_type"].as<std::string>();
            remoteExecutionConfig.host = deploymentRows[0]["remote_host"].as<std::string>();
            remoteExecutionConfig.port = deploymentRows[0]["remote_port"].is_null() ? 22 : deploymentRows[0]["remote_port"].as<int>();
            remoteExecutionConfig.username = deploymentRows[0]["remote_username"].as<std::string>();
            remoteExecutionConfig.authType = deploymentRows[0]["remote_auth_type"].as<std::string>();
            remoteExecutionConfig.password = deploymentRows[0]["remote_password_encrypted"].is_null()
                ? ""
                : TokenCrypto::decrypt(deploymentRows[0]["remote_password_encrypted"].as<std::string>());
            remoteExecutionConfig.privateKey = deploymentRows[0]["remote_private_key_encrypted"].is_null()
                ? ""
                : TokenCrypto::decrypt(deploymentRows[0]["remote_private_key_encrypted"].as<std::string>());
            remoteExecutionConfig.knownHostsEntry = deploymentRows[0]["remote_known_hosts_entry"].as<std::string>();
        }

        auto envRows = txn.exec_params(
            "SELECT key, value_encrypted FROM project_env_vars "
            "WHERE project_id = (SELECT project_id FROM deployments WHERE id = $1) "
            "ORDER BY key ASC",
            deploymentId
        );
        for (const auto& envRow : envRows) {
            envVars.push_back({
                envRow["key"].as<std::string>(),
                TokenCrypto::decrypt(envRow["value_encrypted"].as<std::string>())
            });
        }

        if (currentStatus == "building") {
            Json::Value err; err["error"] = "Build is already in progress for this deployment";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k409Conflict);
            callback(resp); return;
        }

        if (sourceType == "github" && repoUrl.empty()) {
            Json::Value err; err["error"] = "Project repository URL is required before triggering a build";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp); return;
        }

        if (sourceType == "ssh" && sourcePath.empty()) {
            Json::Value err; err["error"] = "Remote SSH path is required before triggering a build";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp); return;
        }
        if (sourceType == "local" && sourcePath.empty()) {
            Json::Value err; err["error"] = "Local source path is required before triggering a build";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp); return;
        }

        txn.exec_params("DELETE FROM deployment_env_vars WHERE deployment_id = $1", deploymentId);
        for (const auto& envVar : envVars) {
            txn.exec_params(
                "INSERT INTO deployment_env_vars (deployment_id, key, value_encrypted) "
                "VALUES ($1, $2, $3) "
                "ON CONFLICT (deployment_id, key) DO UPDATE SET value_encrypted = EXCLUDED.value_encrypted",
                deploymentId,
                envVar.key,
                TokenCrypto::encrypt(envVar.value)
            );
        }

        const Json::Value sourceSnapshot = deploymentSourceSnapshot(
            sourceType, repoUrl, sourcePath, executionMode, remoteRuntimeType, remoteK8sExposure,
            runtimeScheme, localHttpsEnabled, version, projectName
        );
        const Json::Value envSnapshot = envKeySnapshot(envVars);
        txn.exec_params(
            "UPDATE deployments "
            "SET status = 'building', logs = '', source_snapshot = $2::jsonb, env_snapshot = $3::jsonb, "
            "artifact_available = FALSE, updated_at = NOW() "
            "WHERE id = $1",
            deploymentId,
            compactJson(sourceSnapshot),
            compactJson(envSnapshot)
        );
        txn.commit();

        Json::Value auditMeta;
        auditMeta["project_name"] = projectName;
        auditMeta["source_type"] = sourceType;
        auditMeta["execution_mode"] = executionMode;
        auditMeta["remote_runtime_type"] = remoteRuntimeType;
        auditMeta["env_var_count"] = static_cast<int>(envVars.size());
        AuditLogger::recordFromRequest(req, userId, "deployment.build_triggered", "deployment", deploymentId, auditMeta);

        // Broadcast status update
        LogWebSocketController::broadcastStatus(deploymentId, "building");
        broadcastDeploymentSummary(deploymentId);

        // Run build in a background thread to avoid blocking the HTTP thread
        std::thread buildThread([deploymentId, repoUrl, version, githubPat, sourceType, sourcePath, sshConfig, executionMode, remoteExecutionConfig, remoteRuntimeType, remoteK8sExposure, runtimeScheme, localHttpsEnabled, projectName, envVars]() {
            try {
                BuildService buildService;
                const auto logSink = [deploymentId](const std::string& line) {
                    appendDeploymentLog(deploymentId, line);
                    LogWebSocketController::broadcastLog(deploymentId, line);
                };
                BuildResult buildResult;
                KubernetesRuntimeInfo remoteK8sRuntime;
                bool hasRemoteK8sRuntime = false;
                if (executionMode == "remote_host") {
                    if (sourceType == "github") {
                        buildResult = buildService.buildRepositoryAndRunOnRemoteDocker(
                            deploymentId,
                            remoteExecutionConfig,
                            repoUrl,
                            sourcePath,
                            version,
                            githubPat,
                            "",
                            "",
                            projectName,
                            3000,
                            envVars,
                            logSink
                        );
                    } else {
                        buildResult = buildService.buildAndRunOnRemoteDocker(
                            deploymentId,
                            remoteExecutionConfig,
                            sourcePath,
                            projectName,
                            version,
                            3000,
                            envVars,
                            logSink
                        );
                    }
                    if (buildResult.success && remoteRuntimeType == "kubernetes") {
                        SshService sshService;
                        if (!buildResult.remoteContainerName.empty()) {
                            const auto cleanup = sshService.removeDockerContainer(
                                remoteExecutionConfig,
                                buildResult.remoteContainerName,
                                buildResult.imageName,
                                false
                            );
                            if (!cleanup.output.empty()) {
                                buildResult.logs += "\n" + cleanup.output;
                                logSink("Temporary remote Docker container removed before Kubernetes deployment");
                            }
                        }

                        KubernetesDeployOptions options;
                        options.deploymentId = deploymentId;
                        options.projectName = projectName;
                        options.imageName = buildResult.imageName;
                        options.nameSpace = "dokscp-apps";
                        options.runtimeScheme = runtimeScheme;
                        options.exposureMode = options.runtimeScheme == "https" ? "ingress" : remoteK8sExposure;
                        options.replicas = 1;
                        options.containerPort = 3000;
                        options.resourcePreset = "small";
                        options.healthPath = "/";
                        for (const auto& envVar : envVars) {
                            options.envVars.emplace_back(envVar.key, envVar.value);
                        }

                        logSink("Deploying image to remote Kubernetes...");
                        remoteK8sRuntime = sshService.deployKubernetesRuntime(remoteExecutionConfig, options);
                        hasRemoteK8sRuntime = true;
                        buildResult.logs += "\n" + remoteK8sRuntime.logs;
                        buildResult.runtimeProvider = "remote_kubernetes";
                        buildResult.runtimeUrl = remoteK8sRuntime.runtimeUrl;
                        buildResult.remoteContainerName.clear();
                        if (!remoteK8sRuntime.success) {
                            buildResult.success = false;
                            buildResult.error = remoteK8sRuntime.error.empty()
                                ? "Remote Kubernetes deployment failed"
                                : remoteK8sRuntime.error;
                        }
                    }
                } else if (sourceType == "ssh") {
                    buildResult = buildService.buildFromSshSource(
                        deploymentId,
                        sshConfig,
                        sourcePath,
                        version,
                        envVars,
                        logSink
                    );
                } else if (sourceType == "local") {
                    buildResult = buildService.buildFromLocalSource(
                        deploymentId,
                        sourcePath,
                        version,
                        envVars,
                        logSink
                    );
                } else {
                    buildResult = buildService.buildFromRepository(
                        deploymentId,
                        repoUrl,
                        version,
                        githubPat,
                        "",
                        "",
                        envVars,
                        logSink
                    );
                }

                auto& db = Database::getInstance();
                auto connUpdate = db.getConnection();
                pqxx::work updateTxn(*connUpdate);
                if (buildResult.success) {
                    if (buildResult.runtimeProvider == "remote_kubernetes" && hasRemoteK8sRuntime) {
                        updateTxn.exec_params(
                            "UPDATE deployments "
                            "SET status = $1, logs = $2, image_name = $3, runtime_url = $4, runtime_exposure = $5, "
                            "runtime_provider = 'remote_kubernetes', remote_container_name = '', "
                            "k8s_namespace = $6, k8s_deployment_name = $7, k8s_service_name = $8, k8s_ingress_name = $9, "
                            "desired_replicas = $10, runtime_snapshot = $11::jsonb, runtime_paused = FALSE, artifact_available = TRUE, updated_at = NOW() "
                            "WHERE id = $12",
                            remoteK8sRuntime.status.empty() ? "running" : remoteK8sRuntime.status,
                            buildResult.logs,
                            buildResult.imageName,
                            remoteK8sRuntime.runtimeUrl,
                            remoteK8sRuntime.exposureMode,
                            remoteK8sRuntime.nameSpace,
                            remoteK8sRuntime.deploymentName,
                            remoteK8sRuntime.serviceName,
                            remoteK8sRuntime.ingressName,
                            remoteK8sRuntime.desiredReplicas,
                            compactJson(runtimeSnapshot(
                                "remote_kubernetes",
                                buildResult.imageName,
                                remoteK8sRuntime.runtimeUrl,
                                remoteK8sRuntime.exposureMode,
                                remoteK8sRuntime.desiredReplicas,
                                3000,
                                "small",
                                "/",
                                remoteK8sRuntime.runtimeScheme.empty() ? runtimeScheme : remoteK8sRuntime.runtimeScheme
                            )),
                            deploymentId
                        );
                        LogWebSocketController::broadcastStatus(deploymentId, remoteK8sRuntime.status.empty() ? "running" : remoteK8sRuntime.status);
                    } else if (buildResult.runtimeProvider == "remote_docker") {
                        updateTxn.exec_params(
                            "UPDATE deployments "
                            "SET status = 'running', logs = $1, image_name = $2, runtime_url = $3, runtime_exposure = 'remote_docker', "
                            "runtime_provider = 'remote_docker', remote_container_name = $4, runtime_snapshot = $5::jsonb, runtime_paused = FALSE, "
                            "artifact_available = TRUE, updated_at = NOW() "
                            "WHERE id = $6",
                            buildResult.logs,
                            buildResult.imageName,
                            buildResult.runtimeUrl,
                            buildResult.remoteContainerName,
                            compactJson(runtimeSnapshot("remote_docker", buildResult.imageName, buildResult.runtimeUrl, "remote_docker", 1, 3000, "small", "/", "http")),
                            deploymentId
                        );
                        LogWebSocketController::broadcastStatus(deploymentId, "running");
                    } else {
                        updateTxn.exec_params(
                            "UPDATE deployments "
                            "SET status = 'built', logs = $1, image_name = $2, runtime_snapshot = $3::jsonb, runtime_paused = FALSE, "
                            "artifact_available = TRUE, updated_at = NOW() "
                            "WHERE id = $4",
                            buildResult.logs,
                            buildResult.imageName,
                            compactJson(runtimeSnapshot("local_docker", buildResult.imageName, "", "docker", 0, 3000, "small", "/", localHttpsEnabled ? "https" : "http")),
                            deploymentId
                        );
                        LogWebSocketController::broadcastStatus(deploymentId, "built");
                    }
                } else {
                    std::string failureLogs = buildResult.logs.empty() ? buildResult.error : buildResult.logs;
                    if (!buildResult.error.empty() && failureLogs.find(buildResult.error) == std::string::npos) {
                        failureLogs += "\nFailure reason: " + buildResult.error + "\n";
                    }
                    updateTxn.exec_params(
                        "UPDATE deployments "
                        "SET status = 'failed', logs = $1, artifact_available = FALSE, updated_at = NOW() "
                        "WHERE id = $2",
                        failureLogs, deploymentId
                    );
                    LogWebSocketController::broadcastStatus(deploymentId, "failed");
                }
                updateTxn.commit();
                broadcastDeploymentSummary(deploymentId);
            } catch (const std::exception& e) {
                spdlog::error("Background build error for {}: {}", deploymentId, e.what());
                try {
                    auto& db = Database::getInstance();
                    auto connUpdate = db.getConnection();
                    pqxx::work updateTxn(*connUpdate);
                    updateTxn.exec_params(
                        "UPDATE deployments SET status = 'failed', logs = $1, updated_at = NOW() WHERE id = $2",
                        std::string("Background build error: ") + e.what(),
                        deploymentId
                    );
                    updateTxn.commit();
                    LogWebSocketController::broadcastStatus(deploymentId, "failed");
                    broadcastDeploymentSummary(deploymentId);
                } catch (const std::exception& dbError) {
                    spdlog::error("Failed to persist build failure for {}: {}", deploymentId, dbError.what());
                }
            }
        });
        buildThread.detach(); // Detach to let it run independently

        Json::Value payload;
        payload["message"] = "Build triggered successfully in background";
        payload["deployment_id"] = deploymentId;
        payload["status"] = "building";
        
        callback(drogon::HttpResponse::newHttpJsonResponse(payload));

    } catch (const std::exception& e) {
        spdlog::error("Trigger build error: {}", e.what());
        Json::Value err; err["error"] = "Internal server error";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void DeploymentController::getDeploymentLogs(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& deploymentId
) {
    std::string userId = extractUserId(req);
    if (userId.empty()) {
        Json::Value err; err["error"] = "Unauthorized";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp); return;
    }

    try {
        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);

        auto result = txn.exec_params(
            "SELECT d.id, d.status, d.version, d.commit_hash, d.branch, d.commit_sha, p.repo_url, "
            "d.logs, d.image_name, d.k8s_namespace, d.k8s_deployment_name, "
            "d.k8s_service_name, d.k8s_ingress_name, d.desired_replicas, d.runtime_url, d.runtime_exposure, d.updated_at "
            "FROM deployments d "
            "JOIN projects p ON d.project_id = p.id "
            "WHERE d.id = $1 AND p.user_id = $2",
            deploymentId, userId
        );
        txn.commit();

        if (result.empty()) {
            Json::Value err; err["error"] = "Deployment not found";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp); return;
        }

        Json::Value deployment;
        deployment["id"] = result[0]["id"].as<std::string>();
        deployment["status"] = result[0]["status"].as<std::string>();
        deployment["version"] = result[0]["version"].as<std::string>();
        deployment["commit_hash"] = result[0]["commit_hash"].as<std::string>();
        deployment["branch"] = result[0]["branch"].is_null() ? "" : result[0]["branch"].as<std::string>();
        deployment["commit_sha"] = result[0]["commit_sha"].is_null() ? "" : result[0]["commit_sha"].as<std::string>();
        deployment["repo_url"] = result[0]["repo_url"].is_null() ? "" : result[0]["repo_url"].as<std::string>();
        deployment["logs"] = result[0]["logs"].as<std::string>();
        deployment["image_name"] = result[0]["image_name"].as<std::string>();
        deployment["k8s_namespace"] = result[0]["k8s_namespace"].is_null() ? "" : result[0]["k8s_namespace"].as<std::string>();
        deployment["k8s_deployment_name"] = result[0]["k8s_deployment_name"].is_null() ? "" : result[0]["k8s_deployment_name"].as<std::string>();
        deployment["k8s_service_name"] = result[0]["k8s_service_name"].is_null() ? "" : result[0]["k8s_service_name"].as<std::string>();
        deployment["k8s_ingress_name"] = result[0]["k8s_ingress_name"].is_null() ? "" : result[0]["k8s_ingress_name"].as<std::string>();
        deployment["desired_replicas"] = result[0]["desired_replicas"].is_null() ? 1 : result[0]["desired_replicas"].as<int>();
        deployment["runtime_url"] = result[0]["runtime_url"].is_null() ? "" : result[0]["runtime_url"].as<std::string>();
        deployment["runtime_exposure"] = result[0]["runtime_exposure"].is_null() ? "" : result[0]["runtime_exposure"].as<std::string>();
        deployment["updated_at"] = result[0]["updated_at"].as<std::string>();

        Json::Value body;
        body["deployment"] = deployment;
        callback(drogon::HttpResponse::newHttpJsonResponse(body));
    } catch (const std::exception& e) {
        spdlog::error("Get deployment logs error: {}", e.what());
        Json::Value err; err["error"] = "Internal server error";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void DeploymentController::deleteDeployment(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& deploymentId
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        Json::Value err; err["error"] = "Unauthorized";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp); return;
    }

    try {
        bool deleteRemoteImage = false;
        if (auto body = req->getJsonObject()) {
            if ((*body).isMember("delete_image")) {
                deleteRemoteImage = (*body)["delete_image"].isBool() && (*body)["delete_image"].asBool();
            }
        }

        DeploymentCleanupOptions options;
        options.deleteDatabaseRow = true;
        options.deleteImage = deleteRemoteImage;
        options.deleteRemoteWorkspace = deleteRemoteImage;
        DeploymentCleanupService cleanupService;
        const DeploymentCleanupResult cleanup = cleanupService.cleanupDeployment(userId, deploymentId, options);
        if (!cleanup.success) {
            Json::Value err;
            err["error"] = cleanup.error.empty() ? "Failed to delete deployment" : cleanup.error;
            err["cleanup"] = cleanup.toJson();
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(cleanup.error == "Deployment not found" ? drogon::k404NotFound : drogon::k500InternalServerError);
            callback(resp);
            return;
        }

        Json::Value body = cleanup.toJson();
        body["message"] = "Deployment deleted";
        body["deployment_id"] = deploymentId;
        Json::Value auditMeta;
        auditMeta["delete_remote_image"] = deleteRemoteImage;
        auditMeta["cleanup"] = cleanup.toJson();
        AuditLogger::recordFromRequest(req, userId, "deployment.deleted", "deployment", deploymentId, auditMeta);
        callback(drogon::HttpResponse::newHttpJsonResponse(body));
    } catch (const std::exception& e) {
        spdlog::error("Delete deployment error: {}", e.what());
        Json::Value err; err["error"] = "Internal server error";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void DeploymentController::deployToLocalDocker(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& deploymentId
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        Json::Value err; err["error"] = "Unauthorized";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp); return;
    }

    const std::string rateLimitKey = makeRuntimeRateLimitKey("local-docker-deploy", req, userId, deploymentId);
    int retryAfterSeconds = 0;
    if (isRuntimeRateLimited(rateLimitKey, retryAfterSeconds)) {
        callback(makeRuntimeRateLimitedResponse(retryAfterSeconds));
        return;
    }

    try {
        auto body = req->getJsonObject();
        const int requestedContainerPort =
            (body && body->isMember("container_port")) ? std::clamp((*body)["container_port"].asInt(), 1, 65535) : 0;

        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);
        auto rows = txn.exec_params(
            "SELECT d.id, d.project_id, d.image_name, d.status, d.remote_container_name, d.runtime_snapshot::text AS runtime_snapshot, "
            "p.name AS project_name "
            "FROM deployments d "
            "JOIN projects p ON d.project_id = p.id "
            "WHERE d.id = $1 AND p.user_id = $2",
            deploymentId,
            userId
        );

        if (rows.empty()) {
            recordRuntimeRateLimitFailure(rateLimitKey, kRuntimeMutationRateLimit);
            Json::Value err; err["error"] = "Deployment not found";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp); return;
        }

        const auto& row = rows[0];
        const Json::Value existingRuntimeSnapshot = parseJsonObject(
            row["runtime_snapshot"].is_null() ? "" : row["runtime_snapshot"].as<std::string>()
        );
        const std::string imageName = jsonString(
            existingRuntimeSnapshot,
            "image_name",
            row["image_name"].is_null() ? "" : row["image_name"].as<std::string>()
        );
        if (imageName.empty()) {
            recordRuntimeRateLimitFailure(rateLimitKey, kRuntimeMutationRateLimit);
            Json::Value err; err["error"] = "Build the image before deploying to local Docker";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp); return;
        }

        const auto deploymentEnvVars = loadDeploymentEnvVarPairs(txn, deploymentId);
        const std::string projectName = row["project_name"].is_null() ? "deployment" : row["project_name"].as<std::string>();
        const std::string containerName = "dokscp-local-" + sanitizeDockerContainerName(projectName) + "-" + sanitizeDockerContainerName(deploymentId).substr(0, 12);
        txn.exec_params(
            "UPDATE deployments SET status = 'deploying', updated_at = NOW() WHERE id = $1",
            deploymentId
        );
        txn.commit();

        LogWebSocketController::broadcastStatus(deploymentId, "deploying");
        broadcastDeploymentSummary(deploymentId);

        std::string output;
        const int exitCode = runLocalCommand(
            "timeout 120s sh -lc " + shellQuote(makeLocalDockerRunCommand(containerName, imageName, requestedContainerPort, deploymentEnvVars)),
            output
        );
        appendDeploymentLogBlock(deploymentId, output);

        const std::string runtimeUrl = valueFromKeyValueOutput(output, "runtime_url");
        int containerPort = requestedContainerPort > 0 ? requestedContainerPort : 3000;
        const std::string actualContainerPort = valueFromKeyValueOutput(output, "container_port");
        if (!actualContainerPort.empty()) {
            try {
                containerPort = std::clamp(std::stoi(actualContainerPort), 1, 65535);
            } catch (...) {
                containerPort = requestedContainerPort > 0 ? requestedContainerPort : 3000;
            }
        }
        const std::string status = valueFromKeyValueOutput(output, "status");
        const bool running = valueFromKeyValueOutput(output, "running") == "true";
        if (exitCode != 0 || output.find("__DOKSCP_LOCAL_DOCKER_RUNNING__") == std::string::npos || runtimeUrl.empty()) {
            recordRuntimeRateLimitFailure(rateLimitKey, kRuntimeMutationRateLimit);
            auto connUpdate = db.getConnection();
            pqxx::work updateTxn(*connUpdate);
            updateTxn.exec_params(
                "UPDATE deployments SET status = 'failed', updated_at = NOW() WHERE id = $1",
                deploymentId
            );
            updateTxn.commit();
            LogWebSocketController::broadcastStatus(deploymentId, "failed");
            broadcastDeploymentSummary(deploymentId);

            Json::Value err;
            if (output.find("__DOKSCP_DOCKER_MISSING__") != std::string::npos) {
                err["error"] = "Docker CLI is not available to the DOKSCP backend";
            } else if (output.find("__DOKSCP_DOCKER_DAEMON_DOWN__") != std::string::npos) {
                err["error"] = "Docker daemon is not reachable from the DOKSCP backend";
            } else if (output.find("__DOKSCP_IMAGE_MISSING__") != std::string::npos) {
                err["error"] = "Built image is missing from local Docker";
            } else {
                err["error"] = exitCode == 124 ? "Local Docker deploy timed out" : "Failed to start local Docker runtime";
            }
            err["runtime"]["logs"] = output;
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k500InternalServerError);
            callback(resp);
            return;
        }

        const std::string persistedStatus = running ? "running" : (status.empty() ? "built" : status);
        auto connUpdate = db.getConnection();
        pqxx::work updateTxn(*connUpdate);
        updateTxn.exec_params(
            "UPDATE deployments "
            "SET status = $1, runtime_url = $2, runtime_exposure = 'local_docker', runtime_provider = 'local_docker', "
            "remote_container_name = $3, desired_replicas = 1, runtime_snapshot = $4::jsonb, runtime_paused = FALSE, updated_at = NOW() "
            "WHERE id = $5",
            persistedStatus,
            runtimeUrl,
            containerName,
            compactJson(runtimeSnapshot("local_docker", imageName, runtimeUrl, "local_docker", 1, containerPort, "small", "/", "http")),
            deploymentId
        );
        updateTxn.commit();

        clearRuntimeRateLimitState(rateLimitKey);
        LogWebSocketController::broadcastStatus(deploymentId, persistedStatus);
        broadcastDeploymentSummary(deploymentId);

        Json::Value payload;
        payload["message"] = "Deployment is running in local Docker";
        payload["runtime"]["provider"] = "local_docker";
        payload["runtime"]["status"] = persistedStatus;
        payload["runtime"]["runtime_url"] = runtimeUrl;
        payload["runtime"]["container_name"] = containerName;
        payload["runtime"]["image"] = imageName;
        payload["runtime"]["container_port"] = containerPort;
        payload["runtime"]["published_ports"] = valueFromKeyValueOutput(output, "host_port");
        payload["runtime"]["logs"] = remoteLogTailFromInspectOutput(output);
        Json::Value auditMeta;
        auditMeta["provider"] = "local_docker";
        auditMeta["container_name"] = containerName;
        auditMeta["image_name"] = imageName;
        auditMeta["runtime_url"] = runtimeUrl;
        AuditLogger::recordFromRequest(req, userId, "runtime.local_docker.deployed", "deployment", deploymentId, auditMeta);
        callback(drogon::HttpResponse::newHttpJsonResponse(payload));
    } catch (const std::exception& e) {
        recordRuntimeRateLimitFailure(rateLimitKey, kRuntimeMutationRateLimit);
        spdlog::error("Deploy to local Docker error: {}", e.what());
        Json::Value err; err["error"] = "Internal server error";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void DeploymentController::deployToKubernetes(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& deploymentId
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        Json::Value err; err["error"] = "Unauthorized";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp); return;
    }

    const std::string rateLimitKey = makeRuntimeRateLimitKey("deploy", req, userId, deploymentId);
    int retryAfterSeconds = 0;
    if (isRuntimeRateLimited(rateLimitKey, retryAfterSeconds)) {
        callback(makeRuntimeRateLimitedResponse(retryAfterSeconds));
        return;
    }

    try {
        auto body = req->getJsonObject();
        const std::string requestedNamespace =
            (body && body->isMember("namespace")) ? (*body)["namespace"].asString() : "";
        const std::string requestedExposureMode =
            (body && body->isMember("exposure_mode")) ? (*body)["exposure_mode"].asString() : "";
        const std::string requestedRuntimeScheme =
            (body && body->isMember("runtime_scheme")) ? normalizeRuntimeScheme((*body)["runtime_scheme"].asString()) : "";
        const int replicas =
            (body && body->isMember("replicas")) ? std::max(1, (*body)["replicas"].asInt()) : 1;
        const int containerPort =
            (body && body->isMember("container_port")) ? std::max(1, (*body)["container_port"].asInt()) : 3000;
        const std::string resourcePreset = normalizeResourcePreset(
            (body && body->isMember("resource_preset")) ? (*body)["resource_preset"].asString() : "small"
        );
        const std::string healthPath = sanitizeHealthPath(
            (body && body->isMember("health_path")) ? (*body)["health_path"].asString() : "/"
        );

        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);
        auto rows = txn.exec_params(
            "SELECT d.id, d.project_id, d.image_name, d.status, d.runtime_exposure, d.runtime_snapshot::text AS runtime_snapshot, "
            "p.name AS project_name, p.runtime_scheme, p.local_https_enabled "
            "FROM deployments d "
            "JOIN projects p ON d.project_id = p.id "
            "WHERE d.id = $1 AND p.user_id = $2",
            deploymentId, userId
        );

        if (rows.empty()) {
            recordRuntimeRateLimitFailure(rateLimitKey, kRuntimeMutationRateLimit);
            Json::Value err; err["error"] = "Deployment not found";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp); return;
        }

        const auto& row = rows[0];
        const Json::Value existingRuntimeSnapshot = parseJsonObject(
            row["runtime_snapshot"].is_null() ? "" : row["runtime_snapshot"].as<std::string>()
        );
        const std::string savedScheme = normalizeRuntimeScheme(jsonString(
            existingRuntimeSnapshot,
            "runtime_scheme",
            row["runtime_scheme"].is_null() ? "http" : row["runtime_scheme"].as<std::string>()
        ));
        const auto deploymentEnvVars = loadDeploymentEnvVarPairs(txn, deploymentId);
        const std::string imageName = row["image_name"].is_null() ? "" : row["image_name"].as<std::string>();
        if (imageName.empty()) {
            recordRuntimeRateLimitFailure(rateLimitKey, kRuntimeMutationRateLimit);
            Json::Value err; err["error"] = "Build the image before deploying to Kubernetes";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp); return;
        }

        txn.exec_params(
            "UPDATE deployments SET status = 'deploying', updated_at = NOW() WHERE id = $1",
            deploymentId
        );
        txn.commit();
        LogWebSocketController::broadcastStatus(deploymentId, "deploying");
        broadcastDeploymentSummary(deploymentId);

        KubernetesService service;
        KubernetesDeployOptions options;
        options.deploymentId = deploymentId;
        options.projectName = row["project_name"].as<std::string>();
        options.imageName = imageName;
        options.nameSpace = requestedNamespace;
        options.exposureMode = !requestedExposureMode.empty()
            ? requestedExposureMode
            : (row["runtime_exposure"].is_null() ? "" : row["runtime_exposure"].as<std::string>());
        options.runtimeScheme = requestedRuntimeScheme.empty() ? savedScheme : requestedRuntimeScheme;
        if (options.runtimeScheme == "https") {
            options.exposureMode = "ingress";
        }
        options.replicas = replicas;
        options.containerPort = containerPort;
        options.resourcePreset = resourcePreset;
        options.healthPath = healthPath;
        options.envVars = deploymentEnvVars;

        KubernetesRuntimeInfo runtime = service.deploy(options);
        appendDeploymentLogBlock(deploymentId, runtime.logs);

        auto connUpdate = db.getConnection();
        pqxx::work updateTxn(*connUpdate);
        if (runtime.success) {
            updateTxn.exec_params(
                "UPDATE deployments "
                "SET status = $1, k8s_namespace = $2, k8s_deployment_name = $3, "
                "k8s_service_name = $4, k8s_ingress_name = $5, desired_replicas = $6, runtime_url = $7, "
                "runtime_exposure = $8, runtime_provider = 'kubernetes', runtime_snapshot = $9::jsonb, runtime_paused = FALSE, updated_at = NOW() "
                "WHERE id = $10",
                runtime.status.empty() ? "running" : runtime.status,
                runtime.nameSpace,
                runtime.deploymentName,
                runtime.serviceName,
                runtime.ingressName,
                runtime.desiredReplicas,
                runtime.runtimeUrl,
                runtime.exposureMode,
                compactJson(runtimeSnapshot(
                    "kubernetes",
                    imageName,
                    runtime.runtimeUrl,
                    runtime.exposureMode,
                    runtime.desiredReplicas,
                    containerPort,
                    resourcePreset,
                    healthPath,
                    runtime.runtimeScheme.empty() ? options.runtimeScheme : runtime.runtimeScheme
                )),
                deploymentId
            );
            updateTxn.commit();
            clearRuntimeRateLimitState(rateLimitKey);
            LogWebSocketController::broadcastStatus(deploymentId, runtime.status.empty() ? "running" : runtime.status);
            broadcastDeploymentSummary(deploymentId);
        } else {
            recordRuntimeRateLimitFailure(rateLimitKey, kRuntimeMutationRateLimit);
            updateTxn.exec_params(
                "UPDATE deployments SET status = 'failed', updated_at = NOW() WHERE id = $1",
                deploymentId
            );
            updateTxn.commit();
            LogWebSocketController::broadcastStatus(deploymentId, "failed");
            broadcastDeploymentSummary(deploymentId);
        }

        Json::Value payload;
        if (!runtime.success) {
            payload["error"] = runtime.error.empty() ? "Failed to deploy to Kubernetes" : runtime.error;
            payload["runtime"]["logs"] = runtime.logs;
            auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
            resp->setStatusCode(drogon::k500InternalServerError);
            callback(resp);
            return;
        }

        payload["message"] = "Deployment pushed to Kubernetes";
        payload["runtime"]["status"] = runtime.status;
        payload["runtime"]["namespace"] = runtime.nameSpace;
        payload["runtime"]["deployment_name"] = runtime.deploymentName;
        payload["runtime"]["service_name"] = runtime.serviceName;
        payload["runtime"]["ingress_name"] = runtime.ingressName;
        payload["runtime"]["ingress_host"] = runtime.ingressHost;
        payload["runtime"]["exposure_mode"] = runtime.exposureMode;
        payload["runtime"]["runtime_url"] = runtime.runtimeUrl;
        payload["runtime"]["runtime_scheme"] = runtime.runtimeScheme.empty() ? options.runtimeScheme : runtime.runtimeScheme;
        payload["runtime"]["desired_replicas"] = runtime.desiredReplicas;
        payload["runtime"]["ready_replicas"] = runtime.readyReplicas;
        Json::Value auditMeta;
        auditMeta["namespace"] = runtime.nameSpace;
        auditMeta["exposure_mode"] = runtime.exposureMode;
        auditMeta["desired_replicas"] = runtime.desiredReplicas;
        auditMeta["resource_preset"] = resourcePreset;
        auditMeta["runtime_scheme"] = payload["runtime"]["runtime_scheme"].asString();
        AuditLogger::recordFromRequest(req, userId, "runtime.kubernetes.deployed", "deployment", deploymentId, auditMeta);
        callback(drogon::HttpResponse::newHttpJsonResponse(payload));
    } catch (const std::exception& e) {
        recordRuntimeRateLimitFailure(rateLimitKey, kRuntimeMutationRateLimit);
        spdlog::error("Deploy to Kubernetes error: {}", e.what());
        Json::Value err; err["error"] = "Internal server error";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void DeploymentController::scaleKubernetesDeployment(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& deploymentId
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        Json::Value err; err["error"] = "Unauthorized";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp); return;
    }

    const std::string rateLimitKey = makeRuntimeRateLimitKey("scale", req, userId, deploymentId);
    int retryAfterSeconds = 0;
    if (isRuntimeRateLimited(rateLimitKey, retryAfterSeconds)) {
        callback(makeRuntimeRateLimitedResponse(retryAfterSeconds));
        return;
    }

    try {
        auto body = req->getJsonObject();
        const int replicas =
            (body && body->isMember("replicas")) ? std::max(1, (*body)["replicas"].asInt()) : 1;

        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);
        auto rows = txn.exec_params(
            "SELECT d.k8s_namespace, d.k8s_deployment_name, d.k8s_service_name, d.runtime_exposure, "
            "d.runtime_provider, d.remote_container_name, d.runtime_snapshot::text AS runtime_snapshot, d.runtime_url, "
            "COALESCE(rs.connection_type, 'ssh') AS remote_connection_type, rs.host AS remote_host, rs.port AS remote_port, "
            "rs.username AS remote_username, rs.auth_type AS remote_auth_type, rs.password_encrypted AS remote_password_encrypted, "
            "rs.private_key_encrypted AS remote_private_key_encrypted, rs.known_hosts_entry AS remote_known_hosts_entry "
            "FROM deployments d "
            "JOIN projects p ON d.project_id = p.id "
            "LEFT JOIN project_environments e ON d.environment_id = e.id AND e.project_id = p.id "
            "LEFT JOIN ssh_connections rs ON COALESCE(d.remote_connection_id, e.remote_connection_id, p.remote_connection_id) = rs.id "
            "WHERE d.id = $1 AND p.user_id = $2",
            deploymentId, userId
        );

        if (rows.empty()) {
            recordRuntimeRateLimitFailure(rateLimitKey, kRuntimeMutationRateLimit);
            Json::Value err; err["error"] = "Deployment not found";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp); return;
        }

        const auto& row = rows[0];
        const std::string nameSpace = row["k8s_namespace"].is_null() ? "" : row["k8s_namespace"].as<std::string>();
        const std::string deploymentName = row["k8s_deployment_name"].is_null() ? "" : row["k8s_deployment_name"].as<std::string>();
        const std::string serviceName = row["k8s_service_name"].is_null() ? "" : row["k8s_service_name"].as<std::string>();
        const std::string exposureMode = row["runtime_exposure"].is_null() ? "" : row["runtime_exposure"].as<std::string>();
        const std::string runtimeProvider = row["runtime_provider"].is_null() ? "" : row["runtime_provider"].as<std::string>();
        const std::string runtimeUrl = row["runtime_url"].is_null() ? "" : row["runtime_url"].as<std::string>();
        const Json::Value runtimeSnapshotJson = parseJsonObject(
            row["runtime_snapshot"].is_null() ? "" : row["runtime_snapshot"].as<std::string>()
        );
        const std::string runtimeScheme = normalizeRuntimeScheme(jsonString(
            runtimeSnapshotJson,
            "runtime_scheme",
            runtimeUrl.rfind("https://", 0) == 0 ? "https" : "http"
        ));

        if (deploymentName.empty() || serviceName.empty()) {
            recordRuntimeRateLimitFailure(rateLimitKey, kRuntimeMutationRateLimit);
            Json::Value err; err["error"] = "This build has not been deployed to Kubernetes yet";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp); return;
        }

        SshConnectionConfig remoteConfig;
        const bool isRemoteKubernetes = runtimeProvider == "remote_kubernetes";
        if (isRemoteKubernetes) {
            if (row["remote_host"].is_null()) {
                txn.commit();
                recordRuntimeRateLimitFailure(rateLimitKey, kRuntimeMutationRateLimit);
                Json::Value err; err["error"] = "Remote Kubernetes connection metadata is missing";
                auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
                resp->setStatusCode(drogon::k400BadRequest);
                callback(resp); return;
            }
            remoteConfig = rowToRemoteRuntimeConfig(row);
        }
        txn.commit();

        KubernetesRuntimeInfo runtime;
        if (isRemoteKubernetes) {
            SshService sshService;
            runtime = sshService.scaleKubernetesRuntime(remoteConfig, nameSpace, deploymentName, serviceName, exposureMode, replicas, runtimeScheme);
            runtime.runtimeScheme = runtime.runtimeScheme.empty() ? runtimeScheme : runtime.runtimeScheme;
        } else {
            KubernetesService service;
            runtime = service.scale(nameSpace, deploymentName, serviceName, exposureMode, replicas, runtimeScheme);
            runtime.runtimeScheme = runtime.runtimeScheme.empty() ? runtimeScheme : runtime.runtimeScheme;
        }
        appendDeploymentLogBlock(deploymentId, runtime.logs);

        auto connUpdate = db.getConnection();
        pqxx::work updateTxn(*connUpdate);
        if (runtime.success) {
            updateTxn.exec_params(
                "UPDATE deployments SET status = $1, desired_replicas = $2, runtime_url = $3, runtime_exposure = $4, runtime_paused = FALSE, updated_at = NOW() WHERE id = $5",
                runtime.status.empty() ? "running" : runtime.status,
                runtime.desiredReplicas,
                runtime.runtimeUrl,
                runtime.exposureMode,
                deploymentId
            );
            updateTxn.commit();
            clearRuntimeRateLimitState(rateLimitKey);
            LogWebSocketController::broadcastStatus(deploymentId, runtime.status.empty() ? "running" : runtime.status);
            broadcastDeploymentSummary(deploymentId);
        } else {
            recordRuntimeRateLimitFailure(rateLimitKey, kRuntimeMutationRateLimit);
            updateTxn.exec_params("UPDATE deployments SET updated_at = NOW() WHERE id = $1", deploymentId);
            updateTxn.commit();
            broadcastDeploymentSummary(deploymentId);
        }

        Json::Value payload;
        if (!runtime.success) {
            payload["error"] = runtime.error.empty() ? "Failed to scale Kubernetes deployment" : runtime.error;
            payload["runtime"]["logs"] = runtime.logs;
            auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
            resp->setStatusCode(drogon::k500InternalServerError);
            callback(resp);
            return;
        }

        payload["message"] = "Runtime scaled successfully";
        payload["runtime"]["status"] = runtime.status;
        payload["runtime"]["exposure_mode"] = runtime.exposureMode;
        payload["runtime"]["ingress_name"] = runtime.ingressName;
        payload["runtime"]["ingress_host"] = runtime.ingressHost;
        payload["runtime"]["runtime_url"] = runtime.runtimeUrl;
        payload["runtime"]["runtime_scheme"] = runtime.runtimeScheme.empty() ? runtimeScheme : runtime.runtimeScheme;
        payload["runtime"]["desired_replicas"] = runtime.desiredReplicas;
        payload["runtime"]["ready_replicas"] = runtime.readyReplicas;
        Json::Value auditMeta;
        auditMeta["desired_replicas"] = runtime.desiredReplicas;
        auditMeta["ready_replicas"] = runtime.readyReplicas;
        auditMeta["exposure_mode"] = runtime.exposureMode;
        AuditLogger::recordFromRequest(req, userId, "runtime.kubernetes.scaled", "deployment", deploymentId, auditMeta);
        callback(drogon::HttpResponse::newHttpJsonResponse(payload));
    } catch (const std::exception& e) {
        recordRuntimeRateLimitFailure(rateLimitKey, kRuntimeMutationRateLimit);
        spdlog::error("Scale Kubernetes error: {}", e.what());
        Json::Value err; err["error"] = "Internal server error";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void DeploymentController::pauseRuntime(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& deploymentId
) {
    setRuntimePausedState(req, std::move(callback), deploymentId, true);
}

void DeploymentController::resumeRuntime(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& deploymentId
) {
    setRuntimePausedState(req, std::move(callback), deploymentId, false);
}

void DeploymentController::setRuntimePausedState(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& deploymentId,
    bool paused
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        Json::Value err;
        err["error"] = "Unauthorized";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp);
        return;
    }

    const std::string rateLimitKey = makeRuntimeRateLimitKey(paused ? "pause" : "resume", req, userId, deploymentId);
    int retryAfterSeconds = 0;
    if (isRuntimeRateLimited(rateLimitKey, retryAfterSeconds)) {
        callback(makeRuntimeRateLimitedResponse(retryAfterSeconds));
        return;
    }

    try {
        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);
        auto rows = txn.exec_params(
            "SELECT d.id, d.status, d.runtime_paused, d.runtime_provider, d.runtime_exposure, d.runtime_url, "
            "d.image_name, d.remote_container_name, d.desired_replicas, d.k8s_namespace, d.k8s_deployment_name, "
            "d.k8s_service_name, d.k8s_ingress_name, d.runtime_snapshot::text AS runtime_snapshot, p.name AS project_name, "
            "COALESCE(rs.connection_type, 'ssh') AS remote_connection_type, rs.host AS remote_host, rs.port AS remote_port, "
            "rs.username AS remote_username, rs.auth_type AS remote_auth_type, rs.password_encrypted AS remote_password_encrypted, "
            "rs.private_key_encrypted AS remote_private_key_encrypted, rs.known_hosts_entry AS remote_known_hosts_entry "
            "FROM deployments d "
            "JOIN projects p ON d.project_id = p.id "
            "LEFT JOIN project_environments e ON d.environment_id = e.id AND e.project_id = p.id "
            "LEFT JOIN ssh_connections rs ON COALESCE(d.remote_connection_id, e.remote_connection_id, p.remote_connection_id) = rs.id "
            "WHERE d.id = $1 AND p.user_id = $2",
            deploymentId, userId
        );

        if (rows.empty()) {
            recordRuntimeRateLimitFailure(rateLimitKey, kRuntimeMutationRateLimit);
            Json::Value err;
            err["error"] = "Deployment not found";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp);
            return;
        }

        const auto& row = rows[0];
        const std::string runtimeProvider = row["runtime_provider"].is_null() ? "" : row["runtime_provider"].as<std::string>();
        const std::string runtimeExposure = row["runtime_exposure"].is_null() ? "" : row["runtime_exposure"].as<std::string>();
        const std::string runtimeUrl = row["runtime_url"].is_null() ? "" : row["runtime_url"].as<std::string>();
        const std::string projectName = row["project_name"].is_null() ? "deployment" : row["project_name"].as<std::string>();
        const std::string imageName = row["image_name"].is_null() ? "" : row["image_name"].as<std::string>();
        const std::string remoteContainerName = row["remote_container_name"].is_null() ? "" : row["remote_container_name"].as<std::string>();
        const std::string nameSpace = row["k8s_namespace"].is_null() ? "" : row["k8s_namespace"].as<std::string>();
        const std::string deploymentName = row["k8s_deployment_name"].is_null() ? "" : row["k8s_deployment_name"].as<std::string>();
        const std::string serviceName = row["k8s_service_name"].is_null() ? "" : row["k8s_service_name"].as<std::string>();
        const std::string ingressName = row["k8s_ingress_name"].is_null() ? "" : row["k8s_ingress_name"].as<std::string>();
        const int desiredReplicas = row["desired_replicas"].is_null() ? 1 : std::max(1, row["desired_replicas"].as<int>());
        const bool alreadyPaused = row["runtime_paused"].is_null() ? false : row["runtime_paused"].as<bool>();
        const Json::Value runtimeSnapshotJson = parseJsonObject(
            row["runtime_snapshot"].is_null() ? "" : row["runtime_snapshot"].as<std::string>()
        );
        const std::string runtimeScheme = normalizeRuntimeScheme(jsonString(
            runtimeSnapshotJson,
            "runtime_scheme",
            runtimeUrl.rfind("https://", 0) == 0 ? "https" : "http"
        ));

        const bool isRemoteDocker = runtimeProvider == "remote_docker" || runtimeExposure == "remote_docker";
        const bool isRemoteKubernetes = runtimeProvider == "remote_kubernetes";
        const bool isKubernetes = !deploymentName.empty() && !serviceName.empty();
        const bool isLocalDocker = runtimeProvider == "local_docker" || runtimeExposure == "local_docker";

        if (paused && alreadyPaused) {
            txn.commit();
            Json::Value payload;
            payload["message"] = "Runtime is already paused";
            payload["runtime"]["status"] = "paused";
            payload["runtime"]["paused"] = true;
            callback(drogon::HttpResponse::newHttpJsonResponse(payload));
            return;
        }

        if (!paused && !alreadyPaused) {
            txn.commit();
            Json::Value payload;
            payload["message"] = "Runtime is already running";
            payload["runtime"]["status"] = "running";
            payload["runtime"]["paused"] = false;
            callback(drogon::HttpResponse::newHttpJsonResponse(payload));
            return;
        }

        SshConnectionConfig remoteConfig;
        if ((isRemoteDocker || isRemoteKubernetes) && row["remote_host"].is_null()) {
            txn.commit();
            recordRuntimeRateLimitFailure(rateLimitKey, kRuntimeMutationRateLimit);
            Json::Value err;
            err["error"] = "Remote runtime connection metadata is missing";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp);
            return;
        }
        if (isRemoteDocker || isRemoteKubernetes) {
            remoteConfig = rowToRemoteRuntimeConfig(row);
        }
        txn.commit();

        Json::Value payload;
        payload["runtime"]["paused"] = paused;

        if (isRemoteDocker) {
            if (remoteContainerName.empty()) {
                recordRuntimeRateLimitFailure(rateLimitKey, kRuntimeMutationRateLimit);
                Json::Value err;
                err["error"] = "Remote Docker container is not attached to this deployment";
                auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
                resp->setStatusCode(drogon::k400BadRequest);
                callback(resp);
                return;
            }

            SshService sshService;
            const auto op = sshService.runRemoteCommand(
                remoteConfig,
                "/tmp",
                makeDockerPauseCommand(remoteContainerName, paused),
                20
            );
            appendDeploymentLogBlock(deploymentId, op.output);
            if (!op.error.empty()) {
                appendDeploymentLogBlock(deploymentId, op.error);
            }

            if (!op.success) {
                recordRuntimeRateLimitFailure(rateLimitKey, kRuntimeMutationRateLimit);
                payload["error"] = op.error.empty() ? std::string(paused ? "Failed to pause runtime" : "Failed to resume runtime") : op.error;
                payload["runtime"]["logs"] = op.output;
                auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
                resp->setStatusCode(drogon::k500InternalServerError);
                callback(resp);
                return;
            }

            const std::string status = valueFromKeyValueOutput(op.output, "status");
            const bool running = valueFromKeyValueOutput(op.output, "running") == "true";
            const bool dockerPaused = valueFromKeyValueOutput(op.output, "paused") == "true";
            const std::string persistedStatus = dockerPaused ? "paused" : (running ? "running" : (status.empty() ? "built" : status));

            auto connUpdate = db.getConnection();
            pqxx::work updateTxn(*connUpdate);
            updateTxn.exec_params(
                "UPDATE deployments SET status = $1, runtime_paused = $2, updated_at = NOW() WHERE id = $3",
                persistedStatus,
                dockerPaused,
                deploymentId
            );
            updateTxn.commit();

            clearRuntimeRateLimitState(rateLimitKey);
            LogWebSocketController::broadcastStatus(deploymentId, persistedStatus);
            broadcastDeploymentSummary(deploymentId);

            payload["message"] = paused ? "Runtime paused successfully" : "Runtime resumed successfully";
            payload["runtime"]["provider"] = "remote_docker";
            payload["runtime"]["status"] = persistedStatus;
            payload["runtime"]["ready_replicas"] = dockerPaused ? 0 : (running ? 1 : 0);
            payload["runtime"]["runtime_url"] = runtimeUrl;
            payload["runtime"]["container_name"] = remoteContainerName;
            payload["runtime"]["image"] = valueFromKeyValueOutput(op.output, "image");
            payload["runtime"]["started_at"] = valueFromKeyValueOutput(op.output, "started_at");
            payload["runtime"]["finished_at"] = valueFromKeyValueOutput(op.output, "finished_at");
            payload["runtime"]["restart_count"] = valueFromKeyValueOutput(op.output, "restart_count");
            Json::Value auditMeta;
            auditMeta["provider"] = "remote_docker";
            auditMeta["container_name"] = remoteContainerName;
            auditMeta["image_name"] = imageName;
            auditMeta["paused"] = dockerPaused;
            AuditLogger::recordFromRequest(
                req,
                userId,
                paused ? "runtime.paused" : "runtime.resumed",
                "deployment",
                deploymentId,
                auditMeta
            );
            callback(drogon::HttpResponse::newHttpJsonResponse(payload));
            return;
        }

        if (isRemoteKubernetes || isKubernetes) {
            KubernetesRuntimeInfo runtime;
            const int desiredTarget = desiredReplicas;
            if (isRemoteKubernetes) {
                SshService sshService;
                runtime = sshService.scaleKubernetesRuntime(
                    remoteConfig,
                    nameSpace,
                    deploymentName,
                    serviceName,
                    runtimeExposure,
                    paused ? 0 : desiredTarget,
                    runtimeScheme
                );
            } else {
                KubernetesService service;
                runtime = service.scale(
                    nameSpace,
                    deploymentName,
                    serviceName,
                    runtimeExposure,
                    paused ? 0 : desiredTarget,
                    runtimeScheme
                );
            }

            appendDeploymentLogBlock(deploymentId, runtime.logs);
            if (!runtime.success) {
                recordRuntimeRateLimitFailure(rateLimitKey, kRuntimeMutationRateLimit);
                payload["error"] = runtime.error.empty() ? std::string(paused ? "Failed to pause runtime" : "Failed to resume runtime") : runtime.error;
                payload["runtime"]["logs"] = runtime.logs;
                auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
                resp->setStatusCode(drogon::k500InternalServerError);
                callback(resp);
                return;
            }

            const std::string persistedStatus = paused ? "paused" : (runtime.status.empty() ? "running" : runtime.status);
            auto connUpdate = db.getConnection();
            pqxx::work updateTxn(*connUpdate);
            updateTxn.exec_params(
                "UPDATE deployments SET status = $1, desired_replicas = $2, runtime_url = $3, "
                "k8s_ingress_name = $4, runtime_exposure = $5, runtime_paused = $6, updated_at = NOW() WHERE id = $7",
                persistedStatus,
                desiredTarget,
                runtime.runtimeUrl.empty() ? runtimeUrl : runtime.runtimeUrl,
                runtime.ingressName,
                runtime.exposureMode.empty() ? runtimeExposure : runtime.exposureMode,
                paused,
                deploymentId
            );
            updateTxn.commit();

            clearRuntimeRateLimitState(rateLimitKey);
            LogWebSocketController::broadcastStatus(deploymentId, persistedStatus);
            broadcastDeploymentSummary(deploymentId);

            payload["message"] = paused ? "Runtime paused successfully" : "Runtime resumed successfully";
            payload["runtime"]["provider"] = isRemoteKubernetes ? "remote_kubernetes" : "kubernetes";
            payload["runtime"]["status"] = persistedStatus;
            payload["runtime"]["paused"] = paused;
            payload["runtime"]["namespace"] = runtime.nameSpace.empty() ? nameSpace : runtime.nameSpace;
            payload["runtime"]["deployment_name"] = runtime.deploymentName.empty() ? deploymentName : runtime.deploymentName;
            payload["runtime"]["service_name"] = runtime.serviceName.empty() ? serviceName : runtime.serviceName;
            payload["runtime"]["ingress_name"] = runtime.ingressName.empty() ? ingressName : runtime.ingressName;
            payload["runtime"]["ingress_host"] = runtime.ingressHost;
            payload["runtime"]["exposure_mode"] = runtime.exposureMode.empty() ? runtimeExposure : runtime.exposureMode;
            payload["runtime"]["desired_replicas"] = desiredTarget;
            payload["runtime"]["ready_replicas"] = paused ? 0 : runtime.readyReplicas;
            payload["runtime"]["runtime_url"] = runtime.runtimeUrl.empty() ? runtimeUrl : runtime.runtimeUrl;
            payload["runtime"]["runtime_scheme"] = runtime.runtimeScheme.empty() ? runtimeScheme : runtime.runtimeScheme;
            Json::Value auditMeta;
            auditMeta["provider"] = isRemoteKubernetes ? "remote_kubernetes" : "kubernetes";
            auditMeta["namespace"] = nameSpace;
            auditMeta["deployment_name"] = deploymentName;
            auditMeta["paused"] = paused;
            auditMeta["desired_replicas"] = desiredTarget;
            AuditLogger::recordFromRequest(
                req,
                userId,
                paused ? "runtime.paused" : "runtime.resumed",
                "deployment",
                deploymentId,
                auditMeta
            );
            callback(drogon::HttpResponse::newHttpJsonResponse(payload));
            return;
        }

        if (isLocalDocker) {
            recordRuntimeRateLimitFailure(rateLimitKey, kRuntimeMutationRateLimit);
            Json::Value err;
            err["error"] = "Pause and resume are currently supported for remote Docker and Kubernetes runtimes.";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp);
            return;
        }

        recordRuntimeRateLimitFailure(rateLimitKey, kRuntimeMutationRateLimit);
        Json::Value err;
        err["error"] = "This deployment does not have a controllable live runtime yet.";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k400BadRequest);
        callback(resp);
    } catch (const std::exception& e) {
        recordRuntimeRateLimitFailure(rateLimitKey, kRuntimeMutationRateLimit);
        spdlog::error("{} runtime error: {}", paused ? "Pause" : "Resume", e.what());
        Json::Value err;
        err["error"] = "Internal server error";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void DeploymentController::getDeploymentMetrics(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& deploymentId
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        Json::Value err; err["error"] = "Unauthorized";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp); return;
    }

    try {
        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);
        auto rows = txn.exec_params(
            "SELECT d.id, d.status, d.image_name, d.k8s_namespace, d.k8s_deployment_name, "
            "d.runtime_exposure, d.runtime_provider, d.remote_container_name, d.runtime_paused, "
            "COALESCE(rs.connection_type, 'ssh') AS remote_connection_type, rs.host AS remote_host, rs.port AS remote_port, "
            "rs.username AS remote_username, rs.auth_type AS remote_auth_type, rs.password_encrypted AS remote_password_encrypted, "
            "rs.private_key_encrypted AS remote_private_key_encrypted, rs.known_hosts_entry AS remote_known_hosts_entry "
            "FROM deployments d "
            "JOIN projects p ON d.project_id = p.id "
            "LEFT JOIN project_environments e ON d.environment_id = e.id AND e.project_id = p.id "
            "LEFT JOIN ssh_connections rs ON COALESCE(d.remote_connection_id, e.remote_connection_id, p.remote_connection_id) = rs.id "
            "WHERE d.id = $1 AND p.user_id = $2",
            deploymentId, userId
        );

        if (rows.empty()) {
            Json::Value err; err["error"] = "Deployment not found";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp); return;
        }

        const auto& row = rows[0];
        const std::string runtimeProvider = row["runtime_provider"].is_null() ? "" : row["runtime_provider"].as<std::string>();
        const std::string runtimeExposure = row["runtime_exposure"].is_null() ? "" : row["runtime_exposure"].as<std::string>();
        const std::string remoteContainerName = row["remote_container_name"].is_null() ? "" : row["remote_container_name"].as<std::string>();
        const std::string nameSpace = row["k8s_namespace"].is_null() ? "" : row["k8s_namespace"].as<std::string>();
        const std::string deploymentName = row["k8s_deployment_name"].is_null() ? "" : row["k8s_deployment_name"].as<std::string>();
        const bool runtimePaused = row["runtime_paused"].is_null() ? false : row["runtime_paused"].as<bool>();

        const bool isRemoteDocker = runtimeProvider == "remote_docker" || runtimeExposure == "remote_docker";
        const bool isLocalDocker = runtimeProvider == "local_docker" || runtimeExposure == "local_docker";
        const bool isRemoteKubernetes = runtimeProvider == "remote_kubernetes";
        const bool isKubernetes = !deploymentName.empty() && !nameSpace.empty();

        if (runtimePaused) {
            txn.commit();
            Json::Value payload;
            payload["deployment_id"] = deploymentId;
            payload["provider"] =
                isRemoteDocker ? "remote_docker" :
                isRemoteKubernetes ? "remote_kubernetes" :
                isLocalDocker ? "local_docker" :
                isKubernetes ? "kubernetes" : "runtime";
            payload["available"] = false;
            payload["paused"] = true;
            payload["timestamp"] = trantor::Date::now().toFormattedString(false);
            payload["message"] = "Runtime is paused.";
            callback(drogon::HttpResponse::newHttpJsonResponse(payload));
            return;
        }

        if (isRemoteDocker) {
            if (remoteContainerName.empty() || row["remote_host"].is_null()) {
                Json::Value payload;
                payload["deployment_id"] = deploymentId;
                payload["provider"] = "remote_docker";
                payload["available"] = false;
                payload["message"] = "Remote container is not deployed yet.";
                payload["timestamp"] = trantor::Date::now().toFormattedString(false);
                callback(drogon::HttpResponse::newHttpJsonResponse(payload));
                return;
            }

            const SshConnectionConfig remoteConfig = rowToRemoteRuntimeConfig(row);
            txn.commit();

            SshService sshService;
            const auto result = sshService.runRemoteCommand(
                remoteConfig,
                "/tmp",
                makeDockerMetricsCommand(remoteContainerName),
                12
            );
            Json::Value payload = parseDockerMetrics(result.output + "\n" + result.error, "remote_docker", deploymentId);
            if (!result.success && !payload["available"].asBool()) {
                payload["message"] = result.error.empty() ? "Unable to collect remote Docker metrics." : result.error;
            }
            callback(drogon::HttpResponse::newHttpJsonResponse(payload));
            return;
        }

        if (isRemoteKubernetes) {
            if (row["remote_host"].is_null()) {
                Json::Value payload;
                payload["deployment_id"] = deploymentId;
                payload["provider"] = "remote_kubernetes";
                payload["available"] = false;
                payload["message"] = "Remote Kubernetes connection metadata is missing.";
                payload["timestamp"] = trantor::Date::now().toFormattedString(false);
                callback(drogon::HttpResponse::newHttpJsonResponse(payload));
                return;
            }

            const SshConnectionConfig remoteConfig = rowToRemoteRuntimeConfig(row);
            txn.commit();

            const std::string command =
                "if command -v kubectl >/dev/null 2>&1; then K='kubectl'; "
                "elif command -v k3s >/dev/null 2>&1 && [ \"$(id -u)\" -eq 0 ]; then K='k3s kubectl'; "
                "else K='sudo -n k3s kubectl'; fi; kubectl(){ $K \"$@\"; }; " +
                makeKubernetesMetricsCommand(nameSpace, deploymentName);
            SshService sshService;
            const auto result = sshService.runRemoteCommand(remoteConfig, "/tmp", command, 12);
            Json::Value payload = parseKubernetesMetrics(result.output + "\n" + result.error, deploymentId, deploymentName);
            payload["provider"] = "remote_kubernetes";
            if (!result.success && !payload["available"].asBool()) {
                payload["message"] = result.error.empty() ? "Unable to collect remote Kubernetes metrics." : result.error;
            }
            callback(drogon::HttpResponse::newHttpJsonResponse(payload));
            return;
        }

        txn.commit();

        if (isLocalDocker && !remoteContainerName.empty()) {
            std::string output;
            const int exitCode = runLocalCommand("timeout 12s sh -lc " + shellQuote(makeDockerMetricsCommand(remoteContainerName)), output);
            Json::Value payload = parseDockerMetrics(output, "local_docker", deploymentId);
            if (exitCode != 0 && !payload["available"].asBool()) {
                payload["message"] = "Unable to collect local Docker metrics.";
            }
            callback(drogon::HttpResponse::newHttpJsonResponse(payload));
            return;
        }

        if (isKubernetes) {
            std::string output;
            const int exitCode = runLocalCommand("timeout 12s sh -lc " + shellQuote(makeKubernetesMetricsCommand(nameSpace, deploymentName)), output);
            Json::Value payload = parseKubernetesMetrics(output, deploymentId, deploymentName);
            if (exitCode != 0 && !payload["available"].asBool()) {
                payload["message"] = "Unable to collect Kubernetes metrics. Check kubectl access and metrics-server.";
            }
            callback(drogon::HttpResponse::newHttpJsonResponse(payload));
            return;
        }

        Json::Value payload;
        payload["deployment_id"] = deploymentId;
        payload["provider"] = "none";
        payload["available"] = false;
        payload["timestamp"] = trantor::Date::now().toFormattedString(false);
        payload["message"] = "No live runtime is attached to this deployment yet.";
        callback(drogon::HttpResponse::newHttpJsonResponse(payload));
    } catch (const std::exception& e) {
        spdlog::error("Get deployment metrics error: {}", e.what());
        Json::Value err; err["error"] = "Internal server error";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void DeploymentController::getRuntimeHealth(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& deploymentId
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        Json::Value err; err["error"] = "Unauthorized";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp); return;
    }

    try {
        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);
        auto rows = txn.exec_params(
            "SELECT d.runtime_url, d.runtime_provider, d.runtime_exposure, d.status, d.runtime_paused, "
            "d.remote_container_name, "
            "COALESCE(rs.connection_type, 'ssh') AS remote_connection_type, rs.host AS remote_host, rs.port AS remote_port, "
            "rs.username AS remote_username, rs.auth_type AS remote_auth_type, rs.password_encrypted AS remote_password_encrypted, "
            "rs.private_key_encrypted AS remote_private_key_encrypted, rs.known_hosts_entry AS remote_known_hosts_entry "
            "FROM deployments d "
            "JOIN projects p ON d.project_id = p.id "
            "LEFT JOIN project_environments e ON d.environment_id = e.id AND e.project_id = p.id "
            "LEFT JOIN ssh_connections rs ON COALESCE(d.remote_connection_id, e.remote_connection_id, p.remote_connection_id) = rs.id "
            "WHERE d.id = $1 AND p.user_id = $2",
            deploymentId, userId
        );
        if (rows.empty()) {
            Json::Value err; err["error"] = "Deployment not found";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp); return;
        }

        const auto& row = rows[0];
        const std::string runtimeUrl = row["runtime_url"].is_null() ? "" : row["runtime_url"].as<std::string>();
        const std::string provider = row["runtime_provider"].is_null() ? "" : row["runtime_provider"].as<std::string>();
        const std::string exposure = row["runtime_exposure"].is_null() ? "" : row["runtime_exposure"].as<std::string>();
        const std::string containerName = row["remote_container_name"].is_null() ? "" : row["remote_container_name"].as<std::string>();
        const bool runtimePaused = row["runtime_paused"].is_null() ? false : row["runtime_paused"].as<bool>();
        const std::string status = row["status"].is_null() ? "" : row["status"].as<std::string>();
        if (runtimePaused || status == "paused") {
            txn.commit();
            Json::Value payload;
            payload["deployment_id"] = deploymentId;
            payload["runtime_url"] = runtimeUrl;
            payload["provider"] = provider.empty() ? "runtime" : provider;
            payload["available"] = true;
            payload["healthy"] = false;
            payload["paused"] = true;
            payload["message"] = "Runtime is paused.";
            payload["checked_at"] = trantor::Date::now().toFormattedString(false);
            callback(drogon::HttpResponse::newHttpJsonResponse(payload));
            return;
        }
        if ((provider == "local_docker" || exposure == "local_docker") && !containerName.empty()) {
            txn.commit();
            std::string output;
            const std::string inspectCommand =
                "docker inspect --format 'running={{.State.Running}}\npaused={{.State.Paused}}\nstatus={{.State.Status}}' " +
                shellQuote(containerName) + " 2>&1";
            const int exitCode = runLocalCommand("timeout 8s sh -lc " + shellQuote(inspectCommand), output);
            const bool running = valueFromKeyValueOutput(output, "running") == "true";
            const bool paused = valueFromKeyValueOutput(output, "paused") == "true";
            Json::Value payload;
            payload["deployment_id"] = deploymentId;
            payload["runtime_url"] = runtimeUrl;
            payload["provider"] = "local_docker";
            payload["available"] = exitCode == 0;
            payload["healthy"] = exitCode == 0 && running && !paused;
            payload["paused"] = paused;
            payload["status"] = valueFromKeyValueOutput(output, "status");
            payload["message"] = payload["healthy"].asBool()
                ? "Local Docker container is running."
                : "Local Docker container is not running.";
            payload["checked_at"] = trantor::Date::now().toFormattedString(false);
            callback(drogon::HttpResponse::newHttpJsonResponse(payload));
            return;
        }
        if (runtimeUrl.empty() || (runtimeUrl.rfind("http://", 0) != 0 && runtimeUrl.rfind("https://", 0) != 0)) {
            txn.commit();
            Json::Value payload;
            payload["deployment_id"] = deploymentId;
            payload["available"] = false;
            payload["healthy"] = false;
            payload["runtime_url"] = runtimeUrl;
            payload["message"] = "No reachable runtime URL is attached yet.";
            payload["checked_at"] = trantor::Date::now().toFormattedString(false);
            callback(drogon::HttpResponse::newHttpJsonResponse(payload));
            return;
        }

        const bool remote = provider == "remote_docker" || provider == "remote_kubernetes";
        SshConnectionConfig remoteConfig;
        if (remote) {
            if (row["remote_host"].is_null()) {
                txn.commit();
                Json::Value payload;
                payload["deployment_id"] = deploymentId;
                payload["available"] = false;
                payload["healthy"] = false;
                payload["runtime_url"] = runtimeUrl;
                payload["message"] = "Remote connection metadata is missing.";
                payload["checked_at"] = trantor::Date::now().toFormattedString(false);
                callback(drogon::HttpResponse::newHttpJsonResponse(payload));
                return;
            }
            remoteConfig = rowToRemoteRuntimeConfig(row);
        }
        txn.commit();

        const std::string probeCommand =
            "if command -v curl >/dev/null 2>&1; then "
            "curl -k -L --connect-timeout 3 --max-time 8 -o /dev/null -s -w 'status=%{http_code}\\ntime_total=%{time_total}\\n' " +
            shellQuote(runtimeUrl) + "; else echo status=000; echo time_total=0; echo error=curl-missing; exit 20; fi";

        std::string output;
        int exitCode = 0;
        if (remote) {
            SshService sshService;
            const auto probe = sshService.runRemoteCommand(remoteConfig, "/tmp", probeCommand, 12);
            output = probe.output + (probe.error.empty() ? "" : "\n" + probe.error);
            exitCode = probe.success ? 0 : probe.exitCode;
        } else {
            exitCode = runLocalCommand("timeout 12s sh -lc " + shellQuote(probeCommand), output);
        }

        const std::string statusRaw = valueFromKeyValueOutput(output, "status");
        const int statusCode = statusRaw.empty() ? 0 : std::atoi(statusRaw.c_str());
        const double seconds = parseMetricNumber(valueFromKeyValueOutput(output, "time_total"));
        Json::Value payload;
        payload["deployment_id"] = deploymentId;
        payload["runtime_url"] = runtimeUrl;
        payload["provider"] = provider.empty() ? "runtime" : provider;
        payload["available"] = exitCode == 0 || statusCode > 0;
        payload["healthy"] = statusCode >= 200 && statusCode < 400;
        payload["status_code"] = statusCode;
        payload["response_time_ms"] = static_cast<int>(seconds * 1000.0);
        payload["checked_at"] = trantor::Date::now().toFormattedString(false);
        if (!payload["healthy"].asBool()) {
            payload["message"] = statusCode == 0 ? "Runtime did not respond to the HTTP probe." : "Runtime responded with a non-success status code.";
            payload["raw"] = output;
        }
        callback(drogon::HttpResponse::newHttpJsonResponse(payload));
    } catch (const std::exception& e) {
        spdlog::error("Get runtime health error: {}", e.what());
        Json::Value err; err["error"] = "Internal server error";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void DeploymentController::getKubernetesStatus(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& deploymentId
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        Json::Value err; err["error"] = "Unauthorized";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp); return;
    }

    try {
        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);
        auto rows = txn.exec_params(
            "SELECT d.k8s_namespace, d.k8s_deployment_name, d.k8s_service_name, d.k8s_ingress_name, "
            "d.runtime_url, d.desired_replicas, d.runtime_exposure, d.runtime_provider, d.remote_container_name, d.runtime_snapshot::text AS runtime_snapshot, "
            "d.status, d.runtime_paused, "
            "COALESCE(rs.connection_type, 'ssh') AS remote_connection_type, rs.host AS remote_host, rs.port AS remote_port, "
            "rs.username AS remote_username, rs.auth_type AS remote_auth_type, rs.password_encrypted AS remote_password_encrypted, "
            "rs.private_key_encrypted AS remote_private_key_encrypted, rs.known_hosts_entry AS remote_known_hosts_entry "
            "FROM deployments d "
            "JOIN projects p ON d.project_id = p.id "
            "LEFT JOIN project_environments e ON d.environment_id = e.id AND e.project_id = p.id "
            "LEFT JOIN ssh_connections rs ON COALESCE(d.remote_connection_id, e.remote_connection_id, p.remote_connection_id) = rs.id "
            "WHERE d.id = $1 AND p.user_id = $2",
            deploymentId, userId
        );

        if (rows.empty()) {
            Json::Value err; err["error"] = "Deployment not found";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp); return;
        }

        const auto& row = rows[0];
        const std::string nameSpace = row["k8s_namespace"].is_null() ? "" : row["k8s_namespace"].as<std::string>();
        const std::string deploymentName = row["k8s_deployment_name"].is_null() ? "" : row["k8s_deployment_name"].as<std::string>();
        const std::string serviceName = row["k8s_service_name"].is_null() ? "" : row["k8s_service_name"].as<std::string>();
        const std::string ingressName = row["k8s_ingress_name"].is_null() ? "" : row["k8s_ingress_name"].as<std::string>();
        const std::string runtimeUrl = row["runtime_url"].is_null() ? "" : row["runtime_url"].as<std::string>();
        const int desiredReplicas = row["desired_replicas"].is_null() ? 1 : row["desired_replicas"].as<int>();
        const std::string runtimeExposure = row["runtime_exposure"].is_null() ? "" : row["runtime_exposure"].as<std::string>();
        const std::string runtimeProvider = row["runtime_provider"].is_null() ? "" : row["runtime_provider"].as<std::string>();
        const std::string deploymentStatus = row["status"].is_null() ? "" : row["status"].as<std::string>();
        const bool runtimePaused = row["runtime_paused"].is_null() ? false : row["runtime_paused"].as<bool>();
        const Json::Value runtimeSnapshotJson = parseJsonObject(
            row["runtime_snapshot"].is_null() ? "" : row["runtime_snapshot"].as<std::string>()
        );
        const std::string runtimeScheme = normalizeRuntimeScheme(jsonString(
            runtimeSnapshotJson,
            "runtime_scheme",
            runtimeUrl.rfind("https://", 0) == 0 ? "https" : "http"
        ));
        const std::string remoteContainerName =
            row["remote_container_name"].is_null() ? "" : row["remote_container_name"].as<std::string>();
        const bool isLocalDocker = runtimeProvider == "local_docker" || runtimeExposure == "local_docker";

        if (runtimeProvider == "remote_docker" || runtimeExposure == "remote_docker") {
            Json::Value payload;
            payload["runtime"]["provider"] = "remote_docker";
            payload["runtime"]["exposure_mode"] = "remote_docker";
            payload["runtime"]["desired_replicas"] = 1;
            payload["runtime"]["runtime_url"] = runtimeUrl;
            payload["runtime"]["runtime_scheme"] = "http";
            payload["runtime"]["container_name"] = remoteContainerName;

            if (remoteContainerName.empty() || row["remote_host"].is_null()) {
                payload["runtime"]["deployed"] = false;
                payload["runtime"]["status"] = "not_deployed";
                txn.commit();
                callback(drogon::HttpResponse::newHttpJsonResponse(payload));
                return;
            }

            const SshConnectionConfig remoteConfig = rowToRemoteRuntimeConfig(row);
            txn.commit();

            SshService sshService;
            const auto inspect = sshService.inspectDockerContainer(remoteConfig, remoteContainerName);
            if (!inspect.success) {
                payload["runtime"]["deployed"] = false;
                payload["runtime"]["status"] = "not_ready";
                payload["runtime"]["error"] = inspect.error;
                payload["runtime"]["logs"] = inspect.output;
                auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
                resp->setStatusCode(drogon::k200OK);
                callback(resp);
                return;
            }

            const std::string status = valueFromKeyValueOutput(inspect.output, "status");
            const bool running = valueFromKeyValueOutput(inspect.output, "running") == "true";
            const bool paused = runtimePaused || valueFromKeyValueOutput(inspect.output, "paused") == "true";
            payload["runtime"]["deployed"] = true;
            payload["runtime"]["paused"] = paused;
            payload["runtime"]["status"] = paused ? "paused" : (running ? "running" : (status.empty() ? "stopped" : status));
            payload["runtime"]["ready_replicas"] = paused ? 0 : (running ? 1 : 0);
            payload["runtime"]["image"] = valueFromKeyValueOutput(inspect.output, "image");
            payload["runtime"]["started_at"] = valueFromKeyValueOutput(inspect.output, "started_at");
            payload["runtime"]["finished_at"] = valueFromKeyValueOutput(inspect.output, "finished_at");
            payload["runtime"]["restart_count"] = valueFromKeyValueOutput(inspect.output, "restart_count");
            payload["runtime"]["published_ports"] = valueFromKeyValueOutput(inspect.output, "published_ports");
            payload["runtime"]["logs"] = remoteLogTailFromInspectOutput(inspect.output);

            auto connUpdate = db.getConnection();
            pqxx::work updateTxn(*connUpdate);
            updateTxn.exec_params(
                "UPDATE deployments SET status = $1, runtime_provider = 'remote_docker', runtime_exposure = 'remote_docker', "
                "runtime_url = $2, desired_replicas = 1, runtime_paused = $3, updated_at = NOW() WHERE id = $4",
                paused ? "paused" : (running ? "running" : "built"),
                runtimeUrl,
                paused,
                deploymentId
            );
            updateTxn.commit();
            broadcastDeploymentSummary(deploymentId);

            callback(drogon::HttpResponse::newHttpJsonResponse(payload));
            return;
        }

        if (isLocalDocker) {
            Json::Value payload;
            payload["runtime"]["provider"] = "local_docker";
            payload["runtime"]["exposure_mode"] = "local_docker";
            payload["runtime"]["desired_replicas"] = 1;
            payload["runtime"]["runtime_url"] = runtimeUrl;
            payload["runtime"]["runtime_scheme"] = "http";
            payload["runtime"]["container_name"] = remoteContainerName;

            if (remoteContainerName.empty()) {
                payload["runtime"]["deployed"] = false;
                payload["runtime"]["status"] = "not_deployed";
                txn.commit();
                callback(drogon::HttpResponse::newHttpJsonResponse(payload));
                return;
            }

            txn.commit();
            std::string output;
            const std::string inspectCommand =
                "set -e; "
                "command -v docker >/dev/null 2>&1 || { echo __DOKSCP_DOCKER_MISSING__; exit 10; }; "
                "docker inspect --format 'status={{.State.Status}}\nrunning={{.State.Running}}\npaused={{.State.Paused}}\nimage={{.Config.Image}}\nstarted_at={{.State.StartedAt}}\nfinished_at={{.State.FinishedAt}}\nrestart_count={{.RestartCount}}' " +
                shellQuote(remoteContainerName) + "; "
                "echo published_ports=$(docker port " + shellQuote(remoteContainerName) + " 2>/dev/null | tr '\\n' ',' | sed 's/,$//'); "
                "echo __DOKSCP_REMOTE_LOG_TAIL__; "
                "docker logs --tail 80 " + shellQuote(remoteContainerName) + " 2>&1 || true";
            const int exitCode = runLocalCommand("timeout 12s sh -lc " + shellQuote(inspectCommand), output);
            if (exitCode != 0) {
                payload["runtime"]["deployed"] = false;
                payload["runtime"]["status"] = "not_ready";
                payload["runtime"]["error"] = output.empty() ? "Local Docker container is not reachable" : output;
                auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
                resp->setStatusCode(drogon::k200OK);
                callback(resp);
                return;
            }

            const std::string status = valueFromKeyValueOutput(output, "status");
            const bool running = valueFromKeyValueOutput(output, "running") == "true";
            const bool paused = runtimePaused || valueFromKeyValueOutput(output, "paused") == "true";
            payload["runtime"]["deployed"] = true;
            payload["runtime"]["paused"] = paused;
            payload["runtime"]["status"] = paused ? "paused" : (running ? "running" : (status.empty() ? "stopped" : status));
            payload["runtime"]["ready_replicas"] = paused ? 0 : (running ? 1 : 0);
            payload["runtime"]["image"] = valueFromKeyValueOutput(output, "image");
            payload["runtime"]["started_at"] = valueFromKeyValueOutput(output, "started_at");
            payload["runtime"]["finished_at"] = valueFromKeyValueOutput(output, "finished_at");
            payload["runtime"]["restart_count"] = valueFromKeyValueOutput(output, "restart_count");
            payload["runtime"]["published_ports"] = valueFromKeyValueOutput(output, "published_ports");
            payload["runtime"]["logs"] = remoteLogTailFromInspectOutput(output);

            auto connUpdate = db.getConnection();
            pqxx::work updateTxn(*connUpdate);
            updateTxn.exec_params(
                "UPDATE deployments SET status = $1, runtime_provider = 'local_docker', runtime_exposure = 'local_docker', "
                "runtime_url = $2, desired_replicas = 1, runtime_paused = $3, updated_at = NOW() WHERE id = $4",
                paused ? "paused" : (running ? "running" : "built"),
                runtimeUrl,
                paused,
                deploymentId
            );
            updateTxn.commit();
            broadcastDeploymentSummary(deploymentId);

            callback(drogon::HttpResponse::newHttpJsonResponse(payload));
            return;
        }

        if (runtimeProvider == "remote_kubernetes") {
            Json::Value payload;
            payload["runtime"]["provider"] = "remote_kubernetes";
            payload["runtime"]["exposure_mode"] = runtimeExposure;
            payload["runtime"]["desired_replicas"] = desiredReplicas;
            payload["runtime"]["runtime_url"] = runtimeUrl;
            payload["runtime"]["runtime_scheme"] = runtimeScheme;

            if (deploymentName.empty() || serviceName.empty() || row["remote_host"].is_null()) {
                payload["runtime"]["deployed"] = false;
                payload["runtime"]["status"] = "not_deployed";
                txn.commit();
                callback(drogon::HttpResponse::newHttpJsonResponse(payload));
                return;
            }

            const SshConnectionConfig remoteConfig = rowToRemoteRuntimeConfig(row);
            txn.commit();

            SshService sshService;
            KubernetesRuntimeInfo runtime = sshService.inspectKubernetesRuntime(remoteConfig, nameSpace, deploymentName, serviceName, runtimeExposure, runtimeScheme);
            if (!runtime.success) {
                payload["runtime"]["deployed"] = false;
                payload["runtime"]["status"] = "not_ready";
                payload["runtime"]["error"] = runtime.error;
                payload["runtime"]["logs"] = runtime.logs;
                auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
                resp->setStatusCode(drogon::k200OK);
                callback(resp);
                return;
            }

            auto connUpdate = db.getConnection();
            pqxx::work updateTxn(*connUpdate);
            updateTxn.exec_params(
                "UPDATE deployments SET status = $1, desired_replicas = $2, runtime_url = $3, "
                "k8s_ingress_name = $4, runtime_exposure = $5, runtime_paused = $6, updated_at = NOW() WHERE id = $7",
                runtimePaused ? "paused" : (runtime.status.empty() ? "running" : runtime.status),
                desiredReplicas,
                runtime.runtimeUrl.empty() ? runtimeUrl : runtime.runtimeUrl,
                runtime.ingressName,
                runtime.exposureMode,
                runtimePaused,
                deploymentId
            );
            updateTxn.commit();
            broadcastDeploymentSummary(deploymentId);

            payload["runtime"]["deployed"] = true;
            payload["runtime"]["paused"] = runtimePaused;
            payload["runtime"]["status"] = runtimePaused ? "paused" : runtime.status;
            payload["runtime"]["namespace"] = runtime.nameSpace;
            payload["runtime"]["deployment_name"] = runtime.deploymentName;
            payload["runtime"]["service_name"] = runtime.serviceName;
            payload["runtime"]["ingress_name"] = runtime.ingressName;
            payload["runtime"]["ingress_host"] = runtime.ingressHost;
            payload["runtime"]["exposure_mode"] = runtime.exposureMode;
            payload["runtime"]["desired_replicas"] = desiredReplicas;
            payload["runtime"]["ready_replicas"] = runtimePaused ? 0 : runtime.readyReplicas;
            payload["runtime"]["runtime_url"] = runtime.runtimeUrl.empty() ? runtimeUrl : runtime.runtimeUrl;
            payload["runtime"]["runtime_scheme"] = runtime.runtimeScheme.empty() ? runtimeScheme : runtime.runtimeScheme;
            payload["runtime"]["logs"] = runtime.logs;
            callback(drogon::HttpResponse::newHttpJsonResponse(payload));
            return;
        }
        txn.commit();

        Json::Value payload;
        if (deploymentName.empty() || serviceName.empty()) {
            payload["runtime"]["deployed"] = false;
            payload["runtime"]["status"] = "not_deployed";
            payload["runtime"]["ingress_name"] = ingressName;
            payload["runtime"]["exposure_mode"] = runtimeExposure;
            payload["runtime"]["desired_replicas"] = desiredReplicas;
            payload["runtime"]["runtime_url"] = runtimeUrl;
            payload["runtime"]["runtime_scheme"] = runtimeScheme;
            callback(drogon::HttpResponse::newHttpJsonResponse(payload));
            return;
        }

        KubernetesService service;
        KubernetesRuntimeInfo runtime = service.inspect(nameSpace, deploymentName, serviceName, runtimeExposure, runtimeScheme);
        if (!runtime.success) {
            payload["runtime"]["deployed"] = false;
            payload["runtime"]["status"] = "not_ready";
            payload["runtime"]["error"] = runtime.error;
            payload["runtime"]["logs"] = runtime.logs;
            auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
            resp->setStatusCode(drogon::k200OK);
            callback(resp);
            return;
        }

        auto connUpdate = db.getConnection();
        pqxx::work updateTxn(*connUpdate);
        updateTxn.exec_params(
            "UPDATE deployments SET status = $1, desired_replicas = $2, runtime_url = $3, "
            "k8s_ingress_name = $4, runtime_exposure = $5, runtime_paused = $6, updated_at = NOW() WHERE id = $7",
            runtimePaused ? "paused" : (runtime.status.empty() ? "running" : runtime.status),
            desiredReplicas,
            runtime.runtimeUrl,
            runtime.ingressName,
            runtime.exposureMode,
            runtimePaused,
            deploymentId
        );
        updateTxn.commit();
        broadcastDeploymentSummary(deploymentId);

        payload["runtime"]["deployed"] = true;
        payload["runtime"]["paused"] = runtimePaused;
        payload["runtime"]["status"] = runtimePaused ? "paused" : runtime.status;
        payload["runtime"]["namespace"] = runtime.nameSpace;
        payload["runtime"]["deployment_name"] = runtime.deploymentName;
        payload["runtime"]["service_name"] = runtime.serviceName;
        payload["runtime"]["ingress_name"] = runtime.ingressName;
        payload["runtime"]["ingress_host"] = runtime.ingressHost;
        payload["runtime"]["exposure_mode"] = runtime.exposureMode;
        payload["runtime"]["desired_replicas"] = desiredReplicas;
        payload["runtime"]["ready_replicas"] = runtimePaused ? 0 : runtime.readyReplicas;
        payload["runtime"]["runtime_url"] = runtime.runtimeUrl;
        payload["runtime"]["runtime_scheme"] = runtime.runtimeScheme.empty() ? runtimeScheme : runtime.runtimeScheme;
        payload["runtime"]["logs"] = runtime.logs;
        callback(drogon::HttpResponse::newHttpJsonResponse(payload));
    } catch (const std::exception& e) {
        spdlog::error("Get Kubernetes status error: {}", e.what());
        Json::Value err; err["error"] = "Internal server error";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void DeploymentController::getKubernetesEvents(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& deploymentId
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        Json::Value err; err["error"] = "Unauthorized";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp); return;
    }

    try {
        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);
        auto rows = txn.exec_params(
            "SELECT d.k8s_namespace, d.k8s_deployment_name, d.k8s_service_name, d.k8s_ingress_name, "
            "d.runtime_provider, d.runtime_exposure, "
            "COALESCE(rs.connection_type, 'ssh') AS remote_connection_type, rs.host AS remote_host, rs.port AS remote_port, "
            "rs.username AS remote_username, rs.auth_type AS remote_auth_type, rs.password_encrypted AS remote_password_encrypted, "
            "rs.private_key_encrypted AS remote_private_key_encrypted, rs.known_hosts_entry AS remote_known_hosts_entry "
            "FROM deployments d "
            "JOIN projects p ON d.project_id = p.id "
            "LEFT JOIN project_environments e ON d.environment_id = e.id AND e.project_id = p.id "
            "LEFT JOIN ssh_connections rs ON COALESCE(d.remote_connection_id, e.remote_connection_id, p.remote_connection_id) = rs.id "
            "WHERE d.id = $1 AND p.user_id = $2",
            deploymentId, userId
        );
        if (rows.empty()) {
            Json::Value err; err["error"] = "Deployment not found";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp); return;
        }

        const auto& row = rows[0];
        const std::string nameSpace = row["k8s_namespace"].is_null() ? "" : row["k8s_namespace"].as<std::string>();
        const std::string deploymentName = row["k8s_deployment_name"].is_null() ? "" : row["k8s_deployment_name"].as<std::string>();
        const std::string ingressName = row["k8s_ingress_name"].is_null() ? "" : row["k8s_ingress_name"].as<std::string>();
        const std::string runtimeProvider = row["runtime_provider"].is_null() ? "" : row["runtime_provider"].as<std::string>();
        const std::string exposureMode = row["runtime_exposure"].is_null() ? "" : row["runtime_exposure"].as<std::string>();

        if (nameSpace.empty() || deploymentName.empty()) {
            txn.commit();
            Json::Value payload;
            payload["deployment_id"] = deploymentId;
            payload["available"] = false;
            payload["events"] = "";
            payload["message"] = "This deployment does not have a Kubernetes runtime yet.";
            callback(drogon::HttpResponse::newHttpJsonResponse(payload));
            return;
        }

        std::string events;
        if (runtimeProvider == "remote_kubernetes") {
            if (row["remote_host"].is_null()) {
                txn.commit();
                Json::Value payload;
                payload["deployment_id"] = deploymentId;
                payload["available"] = false;
                payload["events"] = "";
                payload["message"] = "Remote Kubernetes connection metadata is missing.";
                callback(drogon::HttpResponse::newHttpJsonResponse(payload));
                return;
            }
            const SshConnectionConfig remoteConfig = rowToRemoteRuntimeConfig(row);
            txn.commit();
            const std::string command =
                "if command -v kubectl >/dev/null 2>&1; then K='kubectl'; "
                "elif command -v k3s >/dev/null 2>&1 && [ \"$(id -u)\" -eq 0 ]; then K='k3s kubectl'; "
                "else K='sudo -n k3s kubectl'; fi; "
                "echo '[pods]'; $K get pods -n " + shellQuote(nameSpace) + " -l app=" + shellQuote(deploymentName) + " -o wide; "
                "echo; echo '[deployment]'; $K describe deployment " + shellQuote(deploymentName) + " -n " + shellQuote(nameSpace) + "; "
                "echo; echo '[recent events]'; $K get events -n " + shellQuote(nameSpace) + " --sort-by=.lastTimestamp";
            SshService sshService;
            const auto remoteEvents = sshService.runRemoteCommand(remoteConfig, "/tmp", command, 20);
            events = remoteEvents.output + (remoteEvents.error.empty() ? "" : "\n" + remoteEvents.error);
        } else {
            txn.commit();
            KubernetesService service;
            events = service.collectEvents(nameSpace, deploymentName, ingressName, exposureMode);
        }

        Json::Value payload;
        payload["deployment_id"] = deploymentId;
        payload["available"] = !events.empty();
        payload["events"] = events;
        payload["checked_at"] = trantor::Date::now().toFormattedString(false);
        callback(drogon::HttpResponse::newHttpJsonResponse(payload));
    } catch (const std::exception& e) {
        spdlog::error("Get Kubernetes events error: {}", e.what());
        Json::Value err; err["error"] = "Internal server error";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void DeploymentController::rollbackKubernetesDeployment(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& deploymentId
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        Json::Value err; err["error"] = "Unauthorized";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp); return;
    }

    const std::string rateLimitKey = makeRuntimeRateLimitKey("rollback", req, userId, deploymentId);
    int retryAfterSeconds = 0;
    if (isRuntimeRateLimited(rateLimitKey, retryAfterSeconds)) {
        callback(makeRuntimeRateLimitedResponse(retryAfterSeconds));
        return;
    }

    try {
        bool deleteRemoteImage = false;
        if (auto body = req->getJsonObject()) {
            if ((*body).isMember("delete_image")) {
                deleteRemoteImage = (*body)["delete_image"].isBool() && (*body)["delete_image"].asBool();
            }
        }

        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);
        auto rows = txn.exec_params(
            "SELECT d.k8s_namespace, d.k8s_deployment_name, d.k8s_service_name, d.runtime_exposure, "
            "d.runtime_provider, d.remote_container_name, d.image_name, d.desired_replicas, "
            "d.runtime_snapshot::text AS runtime_snapshot, d.artifact_available, p.name AS project_name, "
            "COALESCE(rs.connection_type, 'ssh') AS remote_connection_type, rs.host AS remote_host, rs.port AS remote_port, "
            "rs.username AS remote_username, rs.auth_type AS remote_auth_type, rs.password_encrypted AS remote_password_encrypted, "
            "rs.private_key_encrypted AS remote_private_key_encrypted, rs.known_hosts_entry AS remote_known_hosts_entry "
            "FROM deployments d "
            "JOIN projects p ON d.project_id = p.id "
            "LEFT JOIN project_environments e ON d.environment_id = e.id AND e.project_id = p.id "
            "LEFT JOIN ssh_connections rs ON COALESCE(d.remote_connection_id, e.remote_connection_id, p.remote_connection_id) = rs.id "
            "WHERE d.id = $1 AND p.user_id = $2",
            deploymentId, userId
        );

        if (rows.empty()) {
            recordRuntimeRateLimitFailure(rateLimitKey, kRuntimeMutationRateLimit);
            Json::Value err; err["error"] = "Deployment not found";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp); return;
        }

        const auto& row = rows[0];
        const Json::Value snapshot = parseJsonObject(row["runtime_snapshot"].is_null() ? "" : row["runtime_snapshot"].as<std::string>());
        const std::string nameSpace = row["k8s_namespace"].is_null() ? "" : row["k8s_namespace"].as<std::string>();
        const std::string deploymentName = row["k8s_deployment_name"].is_null() ? "" : row["k8s_deployment_name"].as<std::string>();
        const std::string serviceName = row["k8s_service_name"].is_null() ? "" : row["k8s_service_name"].as<std::string>();
        const std::string exposureMode = jsonString(
            snapshot,
            "exposure_mode",
            row["runtime_exposure"].is_null() ? "" : row["runtime_exposure"].as<std::string>()
        );
        const std::string runtimeScheme = normalizeRuntimeScheme(jsonString(snapshot, "runtime_scheme", "http"));
        const std::string runtimeProvider = row["runtime_provider"].is_null() ? "" : row["runtime_provider"].as<std::string>();
        const std::string imageName = jsonString(
            snapshot,
            "image_name",
            row["image_name"].is_null() ? "" : row["image_name"].as<std::string>()
        );
        const bool artifactAvailable = row["artifact_available"].is_null() ? true : row["artifact_available"].as<bool>();
        if (deploymentName.empty() || serviceName.empty()) {
            recordRuntimeRateLimitFailure(rateLimitKey, kRuntimeMutationRateLimit);
            Json::Value err; err["error"] = "This build has not been deployed to Kubernetes yet";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp); return;
        }
        if (imageName.empty() || !artifactAvailable) {
            recordRuntimeRateLimitFailure(rateLimitKey, kRuntimeMutationRateLimit);
            Json::Value err; err["error"] = "Rollback artifact is not available for this deployment";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp); return;
        }

        SshConnectionConfig remoteConfig;
        const bool isRemoteKubernetes = runtimeProvider == "remote_kubernetes";
        if (isRemoteKubernetes) {
            if (row["remote_host"].is_null()) {
                txn.commit();
                recordRuntimeRateLimitFailure(rateLimitKey, kRuntimeMutationRateLimit);
                Json::Value err; err["error"] = "Remote Kubernetes connection metadata is missing";
                auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
                resp->setStatusCode(drogon::k400BadRequest);
                callback(resp); return;
            }
            remoteConfig = rowToRemoteRuntimeConfig(row);
        }
        const auto deploymentEnvVars = loadDeploymentEnvVarPairs(txn, deploymentId);
        txn.exec_params(
            "UPDATE deployments SET status = 'deploying', updated_at = NOW() WHERE id = $1",
            deploymentId
        );
        txn.commit();
        LogWebSocketController::broadcastStatus(deploymentId, "deploying");
        broadcastDeploymentSummary(deploymentId);

        KubernetesDeployOptions options;
        options.deploymentId = deploymentId;
        options.projectName = row["project_name"].as<std::string>();
        options.imageName = imageName;
        options.nameSpace = nameSpace;
        options.exposureMode = exposureMode;
        options.runtimeScheme = runtimeScheme;
        if (options.runtimeScheme == "https") {
            options.exposureMode = "ingress";
        }
        options.replicas = jsonInt(
            snapshot,
            "replicas",
            row["desired_replicas"].is_null() ? 1 : std::max(1, row["desired_replicas"].as<int>())
        );
        options.containerPort = std::clamp(jsonInt(snapshot, "container_port", 3000), 1, 65535);
        options.resourcePreset = normalizeResourcePreset(jsonString(snapshot, "resource_preset", "small"));
        options.healthPath = sanitizeHealthPath(jsonString(snapshot, "health_path", "/"));
        options.envVars = deploymentEnvVars;

        KubernetesRuntimeInfo runtime;
        if (isRemoteKubernetes) {
            SshService sshService;
            runtime = sshService.deployKubernetesRuntime(remoteConfig, options);
        } else {
            KubernetesService service;
            runtime = service.deploy(options);
        }
        appendDeploymentLogBlock(deploymentId, runtime.logs);

        auto connUpdate = db.getConnection();
        pqxx::work updateTxn(*connUpdate);
        if (runtime.success) {
            updateTxn.exec_params(
                "UPDATE deployments SET status = $1, desired_replicas = $2, runtime_url = $3, "
                "k8s_namespace = $4, k8s_deployment_name = $5, k8s_service_name = $6, "
                "k8s_ingress_name = $7, runtime_exposure = $8, runtime_snapshot = $9::jsonb, updated_at = NOW() "
                "WHERE id = $10",
                runtime.status.empty() ? "running" : runtime.status,
                runtime.desiredReplicas,
                runtime.runtimeUrl,
                runtime.nameSpace,
                runtime.deploymentName,
                runtime.serviceName,
                runtime.ingressName,
                runtime.exposureMode,
                compactJson(runtimeSnapshot(
                    runtimeProvider.empty() ? "kubernetes" : runtimeProvider,
                    imageName,
                    runtime.runtimeUrl,
                    runtime.exposureMode,
                    runtime.desiredReplicas,
                    options.containerPort,
                    options.resourcePreset,
                    options.healthPath,
                    runtime.runtimeScheme.empty() ? options.runtimeScheme : runtime.runtimeScheme
                )),
                deploymentId
            );
            updateTxn.commit();
            clearRuntimeRateLimitState(rateLimitKey);
            LogWebSocketController::broadcastStatus(deploymentId, runtime.status.empty() ? "running" : runtime.status);
            broadcastDeploymentSummary(deploymentId);
        } else {
            recordRuntimeRateLimitFailure(rateLimitKey, kRuntimeMutationRateLimit);
            updateTxn.exec_params("UPDATE deployments SET updated_at = NOW() WHERE id = $1", deploymentId);
            updateTxn.commit();
            broadcastDeploymentSummary(deploymentId);
        }

        Json::Value payload;
        if (!runtime.success) {
            payload["error"] = runtime.error.empty() ? "Failed to rollback Kubernetes deployment" : runtime.error;
            payload["runtime"]["logs"] = runtime.logs;
            auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
            resp->setStatusCode(drogon::k500InternalServerError);
            callback(resp);
            return;
        }

        payload["message"] = "Runtime restored from deployment snapshot";
        payload["runtime"]["status"] = runtime.status;
        payload["runtime"]["runtime_url"] = runtime.runtimeUrl;
        payload["runtime"]["runtime_scheme"] = runtime.runtimeScheme.empty() ? options.runtimeScheme : runtime.runtimeScheme;
        payload["runtime"]["desired_replicas"] = runtime.desiredReplicas;
        payload["runtime"]["ready_replicas"] = runtime.readyReplicas;
        payload["runtime"]["exposure_mode"] = runtime.exposureMode;
        payload["runtime"]["ingress_name"] = runtime.ingressName;
        payload["runtime"]["ingress_host"] = runtime.ingressHost;
        Json::Value auditMeta;
        auditMeta["desired_replicas"] = runtime.desiredReplicas;
        auditMeta["ready_replicas"] = runtime.readyReplicas;
        auditMeta["exposure_mode"] = runtime.exposureMode;
        auditMeta["snapshot_based"] = true;
        auditMeta["env_var_count"] = static_cast<int>(deploymentEnvVars.size());
        AuditLogger::recordFromRequest(req, userId, "runtime.kubernetes.rollback", "deployment", deploymentId, auditMeta);
        callback(drogon::HttpResponse::newHttpJsonResponse(payload));
    } catch (const std::exception& e) {
        recordRuntimeRateLimitFailure(rateLimitKey, kRuntimeMutationRateLimit);
        spdlog::error("Rollback Kubernetes deployment error: {}", e.what());
        Json::Value err; err["error"] = "Internal server error";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void DeploymentController::removeKubernetesDeployment(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& deploymentId
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        Json::Value err; err["error"] = "Unauthorized";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp); return;
    }

    const std::string rateLimitKey = makeRuntimeRateLimitKey("remove", req, userId, deploymentId);
    int retryAfterSeconds = 0;
    if (isRuntimeRateLimited(rateLimitKey, retryAfterSeconds)) {
        callback(makeRuntimeRateLimitedResponse(retryAfterSeconds));
        return;
    }

    try {
        bool deleteRemoteImage = false;
        if (auto body = req->getJsonObject()) {
            if ((*body).isMember("delete_image")) {
                deleteRemoteImage = (*body)["delete_image"].isBool() && (*body)["delete_image"].asBool();
            }
        }

        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);
        auto rows = txn.exec_params(
            "SELECT d.k8s_namespace, d.k8s_deployment_name, d.k8s_service_name, d.runtime_exposure, "
            "d.runtime_provider, d.remote_container_name, d.image_name, d.runtime_snapshot::text AS runtime_snapshot, "
            "COALESCE(rs.connection_type, 'ssh') AS remote_connection_type, rs.host AS remote_host, rs.port AS remote_port, "
            "rs.username AS remote_username, rs.auth_type AS remote_auth_type, rs.password_encrypted AS remote_password_encrypted, "
            "rs.private_key_encrypted AS remote_private_key_encrypted, rs.known_hosts_entry AS remote_known_hosts_entry "
            "FROM deployments d "
            "JOIN projects p ON d.project_id = p.id "
            "LEFT JOIN project_environments e ON d.environment_id = e.id AND e.project_id = p.id "
            "LEFT JOIN ssh_connections rs ON COALESCE(d.remote_connection_id, e.remote_connection_id, p.remote_connection_id) = rs.id "
            "WHERE d.id = $1 AND p.user_id = $2",
            deploymentId, userId
        );

        if (rows.empty()) {
            recordRuntimeRateLimitFailure(rateLimitKey, kRuntimeMutationRateLimit);
            Json::Value err; err["error"] = "Deployment not found";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp); return;
        }

        const auto& row = rows[0];
        const Json::Value runtimeSnapshotJson = parseJsonObject(
            row["runtime_snapshot"].is_null() ? "" : row["runtime_snapshot"].as<std::string>()
        );
        const std::string nameSpace = row["k8s_namespace"].is_null() ? "" : row["k8s_namespace"].as<std::string>();
        const std::string deploymentName = row["k8s_deployment_name"].is_null() ? "" : row["k8s_deployment_name"].as<std::string>();
        const std::string serviceName = row["k8s_service_name"].is_null() ? "" : row["k8s_service_name"].as<std::string>();
        const std::string exposureMode = jsonString(
            runtimeSnapshotJson,
            "exposure_mode",
            row["runtime_exposure"].is_null() ? "" : row["runtime_exposure"].as<std::string>()
        );
        const std::string runtimeProvider = jsonString(
            runtimeSnapshotJson,
            "provider",
            row["runtime_provider"].is_null() ? "" : row["runtime_provider"].as<std::string>()
        );
        const std::string remoteContainerName =
            row["remote_container_name"].is_null() ? "" : row["remote_container_name"].as<std::string>();
        const std::string imageName = jsonString(
            runtimeSnapshotJson,
            "image_name",
            row["image_name"].is_null() ? "" : row["image_name"].as<std::string>()
        );

        if (runtimeProvider == "remote_docker" || exposureMode == "remote_docker") {
            if (remoteContainerName.empty() || row["remote_host"].is_null()) {
                txn.commit();
                recordRuntimeRateLimitFailure(rateLimitKey, kRuntimeMutationRateLimit);
                Json::Value err; err["error"] = "Remote Docker runtime metadata is missing";
                auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
                resp->setStatusCode(drogon::k400BadRequest);
                callback(resp); return;
            }

            const SshConnectionConfig remoteConfig = rowToRemoteRuntimeConfig(row);
            txn.commit();

            SshService sshService;
            const auto removal = sshService.removeDockerContainer(remoteConfig, remoteContainerName, imageName, deleteRemoteImage);
            appendDeploymentLogBlock(deploymentId, removal.output);

            auto connUpdate = db.getConnection();
            pqxx::work updateTxn(*connUpdate);
            if (removal.success) {
                updateTxn.exec_params(
                    "UPDATE deployments SET status = 'built', runtime_url = '', desired_replicas = 1, "
                    "runtime_exposure = '', runtime_provider = '', remote_container_name = '', updated_at = NOW() "
                    "WHERE id = $1",
                    deploymentId
                );
                updateTxn.commit();
                clearRuntimeRateLimitState(rateLimitKey);
                LogWebSocketController::broadcastStatus(deploymentId, "built");
                broadcastDeploymentSummary(deploymentId);

                Json::Value payload;
                const bool imageDeleted = deleteRemoteImage && removal.output.find("__DOKSCP_REMOTE_IMAGE_REMOVED__") != std::string::npos;
                payload["message"] = imageDeleted
                    ? "Remote Docker runtime and image removed"
                    : (deleteRemoteImage ? "Remote Docker runtime removed; image was kept" : "Remote Docker runtime removed");
                payload["image_deleted"] = imageDeleted;
                if (deleteRemoteImage && !imageDeleted) {
                    payload["warning"] = "The container was removed, but Docker did not remove the image. It may be shared or already absent.";
                }
                payload["runtime"]["status"] = "built";
                Json::Value auditMeta;
                auditMeta["runtime_provider"] = "remote_docker";
                auditMeta["delete_remote_image"] = deleteRemoteImage;
                auditMeta["image_deleted"] = imageDeleted;
                AuditLogger::recordFromRequest(req, userId, "runtime.removed", "deployment", deploymentId, auditMeta);
                callback(drogon::HttpResponse::newHttpJsonResponse(payload));
                return;
            }

            updateTxn.exec_params("UPDATE deployments SET updated_at = NOW() WHERE id = $1", deploymentId);
            updateTxn.commit();
            recordRuntimeRateLimitFailure(rateLimitKey, kRuntimeMutationRateLimit);
            broadcastDeploymentSummary(deploymentId);

            Json::Value err;
            err["error"] = removal.error.empty() ? "Failed to remove remote Docker runtime" : removal.error;
            err["runtime"]["logs"] = removal.output;
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k500InternalServerError);
            callback(resp);
            return;
        }

        if (runtimeProvider == "local_docker" || exposureMode == "local_docker") {
            if (remoteContainerName.empty()) {
                txn.commit();
                recordRuntimeRateLimitFailure(rateLimitKey, kRuntimeMutationRateLimit);
                Json::Value err; err["error"] = "Local Docker runtime metadata is missing";
                auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
                resp->setStatusCode(drogon::k400BadRequest);
                callback(resp); return;
            }

            txn.commit();
            const auto removal = removeLocalDockerContainer(remoteContainerName, imageName, deleteRemoteImage);
            appendDeploymentLogBlock(deploymentId, removal.output);

            auto connUpdate = db.getConnection();
            pqxx::work updateTxn(*connUpdate);
            if (removal.success) {
                updateTxn.exec_params(
                    "UPDATE deployments SET status = 'built', runtime_url = '', desired_replicas = 1, "
                    "runtime_exposure = '', runtime_provider = '', remote_container_name = '', runtime_paused = FALSE, updated_at = NOW() "
                    "WHERE id = $1",
                    deploymentId
                );
                updateTxn.commit();
                clearRuntimeRateLimitState(rateLimitKey);
                LogWebSocketController::broadcastStatus(deploymentId, "built");
                broadcastDeploymentSummary(deploymentId);

                Json::Value payload;
                payload["message"] = deleteRemoteImage ? "Local Docker runtime removed; image cleanup attempted" : "Local Docker runtime removed";
                payload["image_deleted"] = deleteRemoteImage && removal.output.find("__DOKSCP_LOCAL_IMAGE_REMOVE_ATTEMPTED__") != std::string::npos;
                payload["runtime"]["status"] = "built";
                Json::Value auditMeta;
                auditMeta["runtime_provider"] = "local_docker";
                auditMeta["container_name"] = remoteContainerName;
                auditMeta["delete_image"] = deleteRemoteImage;
                AuditLogger::recordFromRequest(req, userId, "runtime.removed", "deployment", deploymentId, auditMeta);
                callback(drogon::HttpResponse::newHttpJsonResponse(payload));
                return;
            }

            updateTxn.exec_params("UPDATE deployments SET updated_at = NOW() WHERE id = $1", deploymentId);
            updateTxn.commit();
            recordRuntimeRateLimitFailure(rateLimitKey, kRuntimeMutationRateLimit);
            broadcastDeploymentSummary(deploymentId);

            Json::Value err;
            err["error"] = removal.error.empty() ? "Failed to remove local Docker runtime" : removal.error;
            err["runtime"]["logs"] = removal.output;
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k500InternalServerError);
            callback(resp);
            return;
        }

        if (runtimeProvider == "remote_kubernetes") {
            if (deploymentName.empty() || serviceName.empty() || row["remote_host"].is_null()) {
                txn.commit();
                recordRuntimeRateLimitFailure(rateLimitKey, kRuntimeMutationRateLimit);
                Json::Value err; err["error"] = "Remote Kubernetes runtime metadata is missing";
                auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
                resp->setStatusCode(drogon::k400BadRequest);
                callback(resp); return;
            }

            const SshConnectionConfig remoteConfig = rowToRemoteRuntimeConfig(row);
            txn.commit();

            SshService sshService;
            KubernetesRuntimeInfo removal = sshService.removeKubernetesRuntime(remoteConfig, nameSpace, deploymentName, serviceName, exposureMode);
            appendDeploymentLogBlock(deploymentId, removal.logs);

            auto connUpdate = db.getConnection();
            pqxx::work updateTxn(*connUpdate);
            updateTxn.exec_params(
                "UPDATE deployments "
                "SET status = 'built', runtime_url = '', desired_replicas = 1, "
                "k8s_namespace = '', k8s_deployment_name = '', k8s_service_name = '', k8s_ingress_name = '', "
                "runtime_exposure = '', runtime_provider = '', updated_at = NOW() "
                "WHERE id = $1",
                deploymentId
            );
            updateTxn.commit();
            if (removal.success) {
                clearRuntimeRateLimitState(rateLimitKey);
            } else {
                recordRuntimeRateLimitFailure(rateLimitKey, kRuntimeMutationRateLimit);
            }
            LogWebSocketController::broadcastStatus(deploymentId, "built");
            broadcastDeploymentSummary(deploymentId);

            if (!removal.success) {
                Json::Value err;
                err["error"] = removal.error.empty() ? "Failed to remove remote Kubernetes runtime" : removal.error;
                err["runtime"]["logs"] = removal.logs;
                auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
                resp->setStatusCode(drogon::k500InternalServerError);
                callback(resp);
                return;
            }

            Json::Value payload;
            payload["message"] = "Remote Kubernetes runtime removed";
            payload["runtime"]["status"] = "built";
            Json::Value auditMeta;
            auditMeta["runtime_provider"] = "remote_kubernetes";
            auditMeta["exposure_mode"] = exposureMode;
            AuditLogger::recordFromRequest(req, userId, "runtime.removed", "deployment", deploymentId, auditMeta);
            callback(drogon::HttpResponse::newHttpJsonResponse(payload));
            return;
        }
        txn.commit();

        if (deploymentName.empty() || serviceName.empty()) {
            recordRuntimeRateLimitFailure(rateLimitKey, kRuntimeMutationRateLimit);
            Json::Value err; err["error"] = "This build is not currently deployed to Kubernetes";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp); return;
        }

        KubernetesService service;
        KubernetesRuntimeInfo removal = service.remove(nameSpace, deploymentName, serviceName, exposureMode);
        appendDeploymentLogBlock(deploymentId, removal.logs);

        auto connUpdate = db.getConnection();
        pqxx::work updateTxn(*connUpdate);
        updateTxn.exec_params(
            "UPDATE deployments "
            "SET status = 'built', runtime_url = '', desired_replicas = 1, "
            "k8s_namespace = '', k8s_deployment_name = '', k8s_service_name = '', k8s_ingress_name = '', "
            "runtime_exposure = '', updated_at = NOW() "
            "WHERE id = $1",
            deploymentId
        );
        updateTxn.commit();
        if (removal.success) {
            clearRuntimeRateLimitState(rateLimitKey);
        } else {
            recordRuntimeRateLimitFailure(rateLimitKey, kRuntimeMutationRateLimit);
        }
        LogWebSocketController::broadcastStatus(deploymentId, "built");
        broadcastDeploymentSummary(deploymentId);

        if (!removal.success) {
            Json::Value err;
            err["error"] = removal.error.empty() ? "Failed to remove Kubernetes runtime" : removal.error;
            err["runtime"]["logs"] = removal.logs;
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k500InternalServerError);
            callback(resp);
            return;
        }

        Json::Value payload;
        payload["message"] = "Kubernetes runtime removed";
        payload["runtime"]["status"] = "built";
        Json::Value auditMeta;
        auditMeta["runtime_provider"] = "kubernetes";
        auditMeta["exposure_mode"] = exposureMode;
        AuditLogger::recordFromRequest(req, userId, "runtime.removed", "deployment", deploymentId, auditMeta);
        callback(drogon::HttpResponse::newHttpJsonResponse(payload));
    } catch (const std::exception& e) {
        recordRuntimeRateLimitFailure(rateLimitKey, kRuntimeMutationRateLimit);
        spdlog::error("Remove Kubernetes deployment error: {}", e.what());
        Json::Value err; err["error"] = "Internal server error";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

} // namespace dokscp
