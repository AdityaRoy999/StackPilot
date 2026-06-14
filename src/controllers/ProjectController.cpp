// ============================================================
// ProjectController.cpp — Project CRUD Implementation
// ============================================================

#include "ProjectController.h"
#include "LogWebSocketController.h"
#include "../db/Database.h"
#include "../services/ApplicationCatalog.h"
#include "../services/BuildService.h"
#include "../services/DeploymentCleanupService.h"
#include "../services/JobQueueService.h"
#include "../services/KubernetesService.h"
#include "../services/SshService.h"
#include "../utils/AuditLogger.h"
#include "../utils/JwtHelper.h"
#include "../utils/TokenCrypto.h"
#include <spdlog/spdlog.h>
#include <drogon/HttpClient.h>
#include <drogon/utils/Utilities.h>
#include <pqxx/pqxx>
#include <json/json.h>

#include <memory>
#include <sstream>
#include <thread>
#include <unordered_set>
#include <vector>
#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <mutex>

namespace stackpilot {

namespace {

std::mutex projectDeploymentLogMutex;

bool isSupportedSourceType(const std::string& sourceType) {
    return sourceType == "github" || sourceType == "ssh" || sourceType == "local" ||
           sourceType == "artifact" || sourceType == "application";
}

bool isSupportedExecutionMode(const std::string& executionMode) {
    return executionMode == "local" || executionMode == "remote_host";
}

bool isValidEnvKey(const std::string& key) {
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

std::string githubFullNameFromUrl(std::string value) {
    value = trim(value);
    if (value.empty()) {
        return "";
    }
    if (value.rfind("git@github.com:", 0) == 0) {
        value = value.substr(std::string("git@github.com:").size());
    } else {
        const std::string marker = "github.com/";
        const auto pos = value.find(marker);
        if (pos != std::string::npos) {
            value = value.substr(pos + marker.size());
        }
    }
    while (!value.empty() && value.front() == '/') {
        value.erase(value.begin());
    }
    const auto queryPos = value.find_first_of("?#");
    if (queryPos != std::string::npos) {
        value = value.substr(0, queryPos);
    }
    if (value.size() > 4 && value.substr(value.size() - 4) == ".git") {
        value.resize(value.size() - 4);
    }
    while (!value.empty() && value.back() == '/') {
        value.pop_back();
    }
    const auto slash = value.find('/');
    if (slash == std::string::npos || slash == 0 || slash == value.size() - 1) {
        return "";
    }
    if (value.find('/', slash + 1) != std::string::npos) {
        value = value.substr(0, value.find('/', slash + 1));
    }
    for (char c : value) {
        const bool ok = std::isalnum(static_cast<unsigned char>(c)) ||
                        c == '-' || c == '_' || c == '.' || c == '/';
        if (!ok) {
            return "";
        }
    }
    return value;
}

std::string envOrEmpty(const char* name) {
    const char* value = std::getenv(name);
    return value && *value ? value : "";
}

bool looksPublicHttpsUrl(const std::string& url) {
    const std::string cleaned = toLower(trim(url));
    if (cleaned.rfind("https://", 0) != 0) {
        return false;
    }
    return cleaned.find("localhost") == std::string::npos &&
           cleaned.find("127.0.0.1") == std::string::npos &&
           cleaned.find("0.0.0.0") == std::string::npos &&
           cleaned.find("[::1]") == std::string::npos;
}

bool githubAppWebhookModeEnabled() {
    const std::string value = toLower(trim(envOrEmpty("GITHUB_APP_WEBHOOK_MODE")));
    return value == "1" || value == "true" || value == "yes" || value == "on";
}

std::string loadConnectedGitHubToken(const std::string& userId) {
    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);
        auto rows = txn.exec_params(
            "SELECT github_access_token FROM users WHERE id = $1",
            userId
        );
        txn.commit();
        if (!rows.empty() && !rows[0]["github_access_token"].is_null()) {
            return TokenCrypto::decrypt(rows[0]["github_access_token"].as<std::string>());
        }
    } catch (const std::exception& e) {
        spdlog::warn("Failed to load connected GitHub token for webhook registration: {}", e.what());
    }
    return "";
}

Json::Value maybeRegisterGitHubWebhook(const std::string& userId,
                                       const std::string& repoUrl,
                                       const std::string& explicitToken,
                                       const Json::Value& environments) {
    Json::Value warnings(Json::arrayValue);
    bool autoDeployRequested = false;
    for (const auto& env : environments) {
        if (env.isObject() && env.isMember("auto_deploy") && env["auto_deploy"].asBool()) {
            autoDeployRequested = true;
            break;
        }
    }
    if (!autoDeployRequested) {
        return warnings;
    }

    const std::string fullName = githubFullNameFromUrl(repoUrl);
    if (fullName.empty()) {
        warnings.append("GitHub webhook was not registered because the repository URL could not be parsed.");
        return warnings;
    }

    if (githubAppWebhookModeEnabled()) {
        warnings.append("GitHub App webhook mode is enabled. StackPilot will use the central GitHub App webhook instead of creating a repository webhook.");
        return warnings;
    }

    std::string backendPublicUrl = envOrEmpty("BACKEND_PUBLIC_URL");
    if (backendPublicUrl.empty()) {
        backendPublicUrl = "http://localhost:8090";
    }
    while (!backendPublicUrl.empty() && backendPublicUrl.back() == '/') {
        backendPublicUrl.pop_back();
    }
    const std::string webhookSecret = envOrEmpty("GITHUB_WEBHOOK_SECRET");
    if (webhookSecret.empty()) {
        warnings.append("Auto deploy needs GITHUB_WEBHOOK_SECRET before StackPilot can register a production GitHub webhook.");
        return warnings;
    }
    if (!looksPublicHttpsUrl(backendPublicUrl)) {
        warnings.append("Auto deploy webhook was not registered because BACKEND_PUBLIC_URL must be a public HTTPS URL reachable by GitHub.");
        return warnings;
    }

    const std::string token = explicitToken.empty() ? loadConnectedGitHubToken(userId) : explicitToken;
    if (token.empty()) {
        warnings.append("Auto deploy webhook was not registered because no GitHub token is available. Reconnect GitHub after the repo hook permission is added.");
        return warnings;
    }

    const std::string webhookUrl = backendPublicUrl + "/api/v1/github/webhooks";
    std::thread([fullName, token, webhookSecret, webhookUrl]() {
        try {
            auto client = drogon::HttpClient::newHttpClient("https://api.github.com");
            Json::Value payload;
            payload["name"] = "web";
            payload["active"] = true;
            payload["events"].append("push");
            payload["events"].append("check_run");
            payload["events"].append("check_suite");
            payload["config"]["url"] = webhookUrl;
            payload["config"]["content_type"] = "json";
            payload["config"]["secret"] = webhookSecret;
            payload["config"]["insecure_ssl"] = "0";

            auto hookReq = drogon::HttpRequest::newHttpJsonRequest(payload);
            hookReq->setMethod(drogon::Post);
            hookReq->setPath("/repos/" + fullName + "/hooks");
            hookReq->addHeader("Authorization", "Bearer " + token);
            hookReq->addHeader("Accept", "application/vnd.github+json");
            hookReq->addHeader("X-GitHub-Api-Version", "2022-11-28");
            hookReq->addHeader("User-Agent", "stackpilot-Platform");
            client->sendRequest(
                hookReq,
                [fullName](drogon::ReqResult result, const drogon::HttpResponsePtr& response) {
                    if (result != drogon::ReqResult::Ok || !response) {
                        spdlog::warn("GitHub webhook registration failed for {}: transport error", fullName);
                        return;
                    }
                    const auto status = response->getStatusCode();
                    if (status == drogon::k201Created || status == drogon::k200OK) {
                        spdlog::info("GitHub webhook registered for {}", fullName);
                    } else if (status == drogon::k422UnprocessableEntity) {
                        spdlog::info("GitHub webhook for {} already exists or GitHub rejected a duplicate", fullName);
                    } else {
                        spdlog::warn("GitHub webhook registration for {} returned HTTP {}", fullName, static_cast<int>(status));
                    }
                },
                10.0
            );
        } catch (const std::exception& e) {
            spdlog::warn("GitHub webhook registration failed for {}: {}", fullName, e.what());
        }
    }).detach();

    return warnings;
}

std::string normalizeRemoteK8sExposure(const std::string& value) {
    std::string cleaned = trim(value);
    std::transform(cleaned.begin(), cleaned.end(), cleaned.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
    });
    if (cleaned == "ingress" || cleaned == "loadbalancer" || cleaned == "clusterip") {
        return cleaned;
    }
    return "nodeport";
}

std::string normalizeRuntimeScheme(const std::string& value) {
    std::string cleaned = trim(value);
    std::transform(cleaned.begin(), cleaned.end(), cleaned.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
    });
    return cleaned == "https" ? "https" : "http";
}

void normalizeRuntimePreferences(const std::string& executionMode,
                                 std::string& runtimeType,
                                 std::string& k8sExposure,
                                 std::string& runtimeScheme,
                                 bool& localHttpsEnabled) {
    runtimeType = trim(runtimeType).empty() ? "docker" : trim(runtimeType);
    std::transform(runtimeType.begin(), runtimeType.end(), runtimeType.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
    });

    runtimeScheme = normalizeRuntimeScheme(runtimeScheme);
    k8sExposure = normalizeRemoteK8sExposure(k8sExposure);

    if (runtimeType != "kubernetes") {
        runtimeType = "docker";
        k8sExposure = "nodeport";
        if (executionMode != "remote_host") {
            runtimeScheme = "http";
        }
        localHttpsEnabled = false;
        return;
    }

    if (runtimeScheme == "https") {
        k8sExposure = "ingress";
    } else if (k8sExposure != "ingress") {
        runtimeScheme = "http";
    }

    if (k8sExposure != "ingress") {
        runtimeScheme = "http";
        localHttpsEnabled = false;
    } else {
        localHttpsEnabled = executionMode == "local" && runtimeScheme == "https";
    }

    if (executionMode == "remote_host") {
        localHttpsEnabled = false;
    }
}

struct ProjectEnvironmentConfig {
    std::string name;
    std::string branch;
    bool autoDeploy = true;
    bool requireCi = false;
    bool cleanupPreviousOnSuccess = false;
    std::vector<BuildEnvVar> envVars;
    std::string executionMode = "local";
    std::string remoteConnectionId;
    std::string remoteRuntimeType = "docker";
    std::string remoteK8sExposure = "nodeport";
    std::string runtimeScheme = "http";
};

std::vector<BuildEnvVar> parseEnvVarArray(const Json::Value& value) {
    std::vector<BuildEnvVar> envVars;
    if (!value.isArray()) {
        return envVars;
    }

    std::unordered_set<std::string> seenKeys;
    for (const auto& item : value) {
        if (!item.isObject()) {
            continue;
        }
        const std::string key = trim(item.get("key", "").asString());
        const std::string envValue = item.get("value", "").asString();
        if (!isValidEnvKey(key)) {
            continue;
        }
        if (seenKeys.insert(key).second) {
            envVars.push_back({key, envValue});
        }
    }

    std::sort(envVars.begin(), envVars.end(), [](const BuildEnvVar& left, const BuildEnvVar& right) {
        return left.key < right.key;
    });
    return envVars;
}

ProjectEnvironmentConfig makeProjectEnvironmentConfig(const std::string& name,
                                                       const std::string& branch,
                                                       bool autoDeploy,
                                                       bool requireCi,
                                                       bool cleanupPreviousOnSuccess,
                                                       const std::vector<BuildEnvVar>& envVars,
                                                       const std::string& executionMode,
                                                       const std::string& remoteConnectionId,
                                                       const std::string& remoteRuntimeType,
                                                       const std::string& remoteK8sExposure,
                                                       const std::string& runtimeScheme) {
    ProjectEnvironmentConfig env;
    env.name = toLower(trim(name));
    env.branch = trim(branch);
    env.autoDeploy = autoDeploy;
    env.requireCi = requireCi;
    env.cleanupPreviousOnSuccess = cleanupPreviousOnSuccess;
    env.envVars = envVars;
    env.executionMode = executionMode.empty() ? "local" : executionMode;
    env.remoteConnectionId = remoteConnectionId;
    env.remoteRuntimeType = remoteRuntimeType.empty() ? "docker" : remoteRuntimeType;
    env.remoteK8sExposure = remoteK8sExposure.empty() ? "nodeport" : remoteK8sExposure;
    env.runtimeScheme = runtimeScheme.empty() ? "http" : runtimeScheme;
    bool localHttpsEnabled = false;
    normalizeRuntimePreferences(env.executionMode, env.remoteRuntimeType, env.remoteK8sExposure, env.runtimeScheme, localHttpsEnabled);
    return env;
}

std::vector<ProjectEnvironmentConfig> defaultProjectEnvironmentConfigs(const std::string& executionMode,
                                                                       const std::string& remoteConnectionId,
                                                                       const std::string& remoteRuntimeType,
                                                                       const std::string& remoteK8sExposure,
                                                                       const std::string& runtimeScheme) {
    return {
        makeProjectEnvironmentConfig(
            "development", "dev", true, false, true, {},
            executionMode, remoteConnectionId, remoteRuntimeType, remoteK8sExposure, runtimeScheme
        ),
        makeProjectEnvironmentConfig(
            "production", "main", false, true, false, {},
            executionMode, remoteConnectionId, remoteRuntimeType, remoteK8sExposure, runtimeScheme
        )
    };
}

std::vector<ProjectEnvironmentConfig> parseProjectEnvironmentConfigs(const Json::Value& body,
                                                                     const std::string& executionMode,
                                                                     const std::string& remoteConnectionId,
                                                                     const std::string& remoteRuntimeType,
                                                                     const std::string& remoteK8sExposure,
                                                                     const std::string& runtimeScheme,
                                                                     std::string& error) {
    if (!body.isMember("environments") || !body["environments"].isArray() || body["environments"].size() == 0u) {
        return defaultProjectEnvironmentConfigs(
            executionMode, remoteConnectionId, remoteRuntimeType, remoteK8sExposure, runtimeScheme
        );
    }

    std::vector<ProjectEnvironmentConfig> configs;
    std::unordered_set<std::string> seenNames;
    int index = 0;
    for (const auto& item : body["environments"]) {
        ++index;
        if (!item.isObject()) {
            error = "Environment entries must be objects";
            return {};
        }

        ProjectEnvironmentConfig env = makeProjectEnvironmentConfig(
            item.get("name", index == 1 ? "development" : "environment").asString(),
            item.get("branch", "").asString(),
            item.get("auto_deploy", true).asBool(),
            item.get("require_ci", false).asBool(),
            item.get("cleanup_previous_on_success", false).asBool(),
            parseEnvVarArray(item["env_vars"]),
            item.get("execution_mode", executionMode.empty() ? "local" : executionMode).asString(),
            item.get("remote_connection_id", remoteConnectionId).asString(),
            item.get("remote_runtime_type", remoteRuntimeType.empty() ? "docker" : remoteRuntimeType).asString(),
            normalizeRemoteK8sExposure(item.get("remote_k8s_exposure", remoteK8sExposure.empty() ? "nodeport" : remoteK8sExposure).asString()),
            normalizeRuntimeScheme(item.get("runtime_scheme", runtimeScheme.empty() ? "http" : runtimeScheme).asString())
        );

        if (env.name.empty()) {
            error = "Each environment needs a name";
            return {};
        }
        if (env.branch.empty()) {
            error = "Each environment needs a Git branch";
            return {};
        }
        if (!isSupportedExecutionMode(env.executionMode)) {
            error = "Environment execution mode must be local or remote_host";
            return {};
        }
        if (env.remoteRuntimeType != "docker" && env.remoteRuntimeType != "kubernetes") {
            error = "Environment runtime must be docker or kubernetes";
            return {};
        }
        if (!seenNames.insert(env.name).second) {
            error = "Environment names must be unique";
            return {};
        }
        configs.push_back(env);
    }

    if (configs.empty()) {
        return defaultProjectEnvironmentConfigs(
            executionMode, remoteConnectionId, remoteRuntimeType, remoteK8sExposure, runtimeScheme
        );
    }
    return configs;
}

void replaceProjectEnvironmentEnvVars(pqxx::transaction_base& txn,
                                      const std::string& environmentId,
                                      const std::vector<BuildEnvVar>& envVars) {
    txn.exec_params("DELETE FROM project_environment_env_vars WHERE environment_id = $1", environmentId);
    for (const auto& envVar : envVars) {
        txn.exec_params(
            "INSERT INTO project_environment_env_vars (environment_id, key, value_encrypted) "
            "VALUES ($1, $2, $3) "
            "ON CONFLICT (environment_id, key) DO UPDATE SET value_encrypted = EXCLUDED.value_encrypted, updated_at = NOW()",
            environmentId,
            envVar.key,
            TokenCrypto::encrypt(envVar.value)
        );
    }
}

Json::Value envVarArrayToJson(const std::vector<BuildEnvVar>& envVars) {
    Json::Value values(Json::arrayValue);
    for (const auto& envVar : envVars) {
        Json::Value item(Json::objectValue);
        item["key"] = envVar.key;
        item["value"] = envVar.value;
        values.append(item);
    }
    return values;
}

Json::Value insertProjectEnvironments(pqxx::transaction_base& txn,
                                      const std::string& projectId,
                                      const std::vector<ProjectEnvironmentConfig>& configs) {
    Json::Value environments(Json::arrayValue);
    for (const auto& env : configs) {
        auto rows = txn.exec_params(
            "INSERT INTO project_environments "
            "(project_id, name, branch, auto_deploy, require_ci, cleanup_previous_on_success, execution_mode, remote_connection_id, remote_runtime_type, remote_k8s_exposure, runtime_scheme) "
            "VALUES ($1, $2, $3, $4, $5, $6, $7, NULLIF($8, '')::uuid, $9, $10, $11) "
            "ON CONFLICT (project_id, name) DO UPDATE SET "
            "branch = EXCLUDED.branch, auto_deploy = EXCLUDED.auto_deploy, require_ci = EXCLUDED.require_ci, "
            "cleanup_previous_on_success = EXCLUDED.cleanup_previous_on_success, execution_mode = EXCLUDED.execution_mode, "
            "remote_connection_id = EXCLUDED.remote_connection_id, remote_runtime_type = EXCLUDED.remote_runtime_type, "
            "remote_k8s_exposure = EXCLUDED.remote_k8s_exposure, runtime_scheme = EXCLUDED.runtime_scheme, updated_at = NOW() "
            "RETURNING id, name, branch, auto_deploy, require_ci, cleanup_previous_on_success, execution_mode, remote_connection_id, remote_runtime_type, remote_k8s_exposure, runtime_scheme",
            projectId,
            env.name,
            env.branch,
            env.autoDeploy,
            env.requireCi,
            env.cleanupPreviousOnSuccess,
            env.executionMode,
            env.remoteConnectionId,
            env.remoteRuntimeType,
            env.remoteK8sExposure,
            env.runtimeScheme
        );
        if (!rows.empty()) {
            const std::string environmentId = rows[0]["id"].as<std::string>();
            replaceProjectEnvironmentEnvVars(txn, environmentId, env.envVars);
            Json::Value item(Json::objectValue);
            item["id"] = environmentId;
            item["name"] = rows[0]["name"].as<std::string>();
            item["branch"] = rows[0]["branch"].as<std::string>();
            item["auto_deploy"] = rows[0]["auto_deploy"].as<bool>();
            item["require_ci"] = rows[0]["require_ci"].as<bool>();
            item["cleanup_previous_on_success"] = rows[0]["cleanup_previous_on_success"].as<bool>();
            item["env_vars"] = envVarArrayToJson(env.envVars);
            item["execution_mode"] = rows[0]["execution_mode"].as<std::string>();
            item["remote_connection_id"] = rows[0]["remote_connection_id"].is_null() ? "" : rows[0]["remote_connection_id"].as<std::string>();
            item["remote_runtime_type"] = rows[0]["remote_runtime_type"].as<std::string>();
            item["remote_k8s_exposure"] = rows[0]["remote_k8s_exposure"].as<std::string>();
            item["runtime_scheme"] = rows[0]["runtime_scheme"].as<std::string>();
            environments.append(item);
        }
    }
    return environments;
}

std::string compactJson(const Json::Value& value) {
    Json::StreamWriterBuilder builder;
    builder["indentation"] = "";
    return Json::writeString(builder, value);
}

Json::Value runtimeSnapshot(const std::string& provider,
                            const std::string& imageName,
                            const std::string& runtimeUrl,
                            const std::string& exposureMode,
                            int replicas,
                            int containerPort,
                            const std::string& runtimeScheme) {
    const std::string scheme = normalizeRuntimeScheme(runtimeScheme);
    Json::Value snapshot(Json::objectValue);
    snapshot["provider"] = provider;
    snapshot["image_name"] = imageName;
    snapshot["runtime_url"] = runtimeUrl;
    snapshot["exposure_mode"] = exposureMode;
    snapshot["replicas"] = std::max(0, replicas);
    snapshot["container_port"] = std::clamp(containerPort, 1, 65535);
    snapshot["resource_preset"] = "small";
    snapshot["health_path"] = "/";
    snapshot["runtime_scheme"] = scheme;
    snapshot["tls_enabled"] = scheme == "https";
    return snapshot;
}

Json::Value composeRuntimeSnapshot(const BuildResult& buildResult,
                                   const std::string& provider,
                                   const std::string& runtimeScheme = "http") {
    Json::Value snapshot = runtimeSnapshot(
        provider,
        buildResult.imageName,
        buildResult.runtimeUrl,
        provider,
        1,
        0,
        runtimeScheme
    );
    snapshot["resource_preset"] = "compose";
    snapshot["multi_service"] = true;
    snapshot["compose_project"] = buildResult.composeProjectName;
    snapshot["compose_file"] = buildResult.composeFile;
    snapshot["compose_workdir"] = buildResult.composeWorkdir;
    snapshot["compose_services"] = buildResult.composeServices;
    return snapshot;
}

Json::Value composeKubernetesRuntimeSnapshot(const BuildResult& buildResult,
                                             const KubernetesRuntimeInfo& runtime,
                                             const std::string& provider,
                                             const std::string& runtimeScheme,
                                             int containerPort = 3000) {
    Json::Value snapshot = runtimeSnapshot(
        provider,
        buildResult.imageName,
        runtime.runtimeUrl,
        runtime.exposureMode,
        runtime.desiredReplicas,
        containerPort,
        runtime.runtimeScheme.empty() ? runtimeScheme : runtime.runtimeScheme
    );
    snapshot["resource_preset"] = "small";
    snapshot["health_path"] = "/";
    snapshot["multi_service"] = true;
    snapshot["compose_kubernetes"] = true;
    snapshot["compose_project"] = buildResult.composeProjectName;
    snapshot["compose_file"] = buildResult.composeFile;
    snapshot["compose_workdir"] = buildResult.composeWorkdir;
    snapshot["compose_services"] = buildResult.composeServices;
    snapshot["compose_primary_deployment"] = runtime.deploymentName;
    snapshot["compose_primary_service"] = runtime.serviceName;
    snapshot["ingress_name"] = runtime.ingressName;
    snapshot["ingress_host"] = runtime.ingressHost;
    return snapshot;
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

std::vector<std::filesystem::path> configuredLocalSourceRoots() {
    std::vector<std::filesystem::path> roots;
    const char* env = std::getenv("LOCAL_SOURCE_ROOTS");
    const std::string raw = (env && *env) ? env : "/app/local-projects";
    std::stringstream stream(raw);
    std::string item;
    while (std::getline(stream, item, ';')) {
        item = trim(item);
        if (!item.empty()) {
            roots.emplace_back(item);
        }
    }
    if (roots.empty()) {
        roots.emplace_back("/app/local-projects");
    }
    return roots;
}

bool pathStartsWith(const std::filesystem::path& candidate, const std::filesystem::path& root) {
    auto candidateIt = candidate.begin();
    auto rootIt = root.begin();
    for (; rootIt != root.end(); ++rootIt, ++candidateIt) {
        if (candidateIt == candidate.end() || *candidateIt != *rootIt) {
            return false;
        }
    }
    return true;
}

bool resolveAllowedLocalPath(const std::string& rawPath,
                             std::filesystem::path& resolvedPath,
                             std::string& error) {
    namespace fs = std::filesystem;
    const std::string cleaned = trim(rawPath);
    if (cleaned.empty()) {
        error = "Local path is required";
        return false;
    }

    const fs::path requested(cleaned);
    if (!requested.is_absolute()) {
        error = "Local source path must be an absolute path inside a configured local source root";
        return false;
    }

    std::error_code ec;
    const fs::path canonicalRequested = fs::weakly_canonical(requested, ec);
    if (ec || !fs::exists(canonicalRequested, ec) || !fs::is_directory(canonicalRequested, ec)) {
        error = "Local source path does not exist or is not a directory";
        return false;
    }

    for (const auto& root : configuredLocalSourceRoots()) {
        std::error_code rootEc;
        const fs::path canonicalRoot = fs::weakly_canonical(root, rootEc);
        if (rootEc || !fs::exists(canonicalRoot, rootEc) || !fs::is_directory(canonicalRoot, rootEc)) {
            continue;
        }

        if (pathStartsWith(canonicalRequested, canonicalRoot)) {
            resolvedPath = canonicalRequested;
            return true;
        }
    }

    error = "Local source path is outside the configured allowed roots";
    return false;
}

std::vector<BuildEnvVar> parseEnvVars(const Json::Value& body) {
    std::vector<BuildEnvVar> envVars;
    if (!body.isMember("env_vars") || !body["env_vars"].isArray()) {
        return envVars;
    }

    std::unordered_set<std::string> seenKeys;
    for (const auto& item : body["env_vars"]) {
        if (!item.isObject()) {
            continue;
        }

        const std::string key = trim(item.isMember("key") ? item["key"].asString() : "");
        const std::string value = item.isMember("value") ? item["value"].asString() : "";
        if (!isValidEnvKey(key)) {
            continue;
        }

        if (seenKeys.insert(key).second) {
            envVars.push_back({key, value});
        }
    }

    std::sort(envVars.begin(), envVars.end(), [](const BuildEnvVar& left, const BuildEnvVar& right) {
        return left.key < right.key;
    });

    return envVars;
}

Json::Value envVarsToJson(const std::vector<BuildEnvVar>& envVars) {
    Json::Value values(Json::arrayValue);
    for (const auto& envVar : envVars) {
        Json::Value item;
        item["key"] = envVar.key;
        item["value"] = envVar.value;
        values.append(item);
    }
    return values;
}

std::string envVarsSignature(const std::vector<BuildEnvVar>& envVars) {
    std::ostringstream stream;
    for (const auto& envVar : envVars) {
        stream << envVar.key << "=" << envVar.value << "\n";
    }
    return stream.str();
}

std::vector<BuildEnvVar> loadProjectEnvVars(pqxx::transaction_base& txn, const std::string& projectId) {
    std::vector<BuildEnvVar> envVars;
    auto rows = txn.exec_params(
        "SELECT key, value_encrypted FROM project_env_vars WHERE project_id = $1 ORDER BY key ASC",
        projectId
    );
    for (const auto& row : rows) {
        envVars.push_back({
            row["key"].as<std::string>(),
            TokenCrypto::decrypt(row["value_encrypted"].as<std::string>())
        });
    }
    return envVars;
}

void replaceProjectEnvVars(pqxx::transaction_base& txn,
                           const std::string& projectId,
                           const std::vector<BuildEnvVar>& envVars) {
    txn.exec_params("DELETE FROM project_env_vars WHERE project_id = $1", projectId);
    for (const auto& envVar : envVars) {
        txn.exec_params(
            "INSERT INTO project_env_vars (project_id, key, value_encrypted) VALUES ($1, $2, $3)",
            projectId,
            envVar.key,
            TokenCrypto::encrypt(envVar.value)
        );
    }
}

void appendDeploymentLog(const std::string& deploymentId, const std::string& line) {
    std::lock_guard<std::mutex> lock(projectDeploymentLogMutex);

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
        spdlog::error("Failed to append deployment log for {}: {}", deploymentId, e.what());
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
        "SELECT d.id, d.project_id, p.name AS project_name, d.status, d.version, d.commit_hash, d.image_name, "
        "d.k8s_namespace, d.k8s_deployment_name, d.k8s_service_name, d.k8s_ingress_name, "
        "d.desired_replicas, d.runtime_url, d.runtime_exposure, d.created_at "
        "FROM deployments d "
        "JOIN projects p ON d.project_id = p.id "
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
    dep["status"] = row["status"].as<std::string>();
    dep["version"] = row["version"].as<std::string>();
    dep["commit_hash"] = row["commit_hash"].as<std::string>();
    dep["image_name"] = row["image_name"].is_null() ? "" : row["image_name"].as<std::string>();
    dep["k8s_namespace"] = row["k8s_namespace"].is_null() ? "" : row["k8s_namespace"].as<std::string>();
    dep["k8s_deployment_name"] = row["k8s_deployment_name"].is_null() ? "" : row["k8s_deployment_name"].as<std::string>();
    dep["k8s_service_name"] = row["k8s_service_name"].is_null() ? "" : row["k8s_service_name"].as<std::string>();
    dep["k8s_ingress_name"] = row["k8s_ingress_name"].is_null() ? "" : row["k8s_ingress_name"].as<std::string>();
    dep["desired_replicas"] = row["desired_replicas"].is_null() ? 1 : row["desired_replicas"].as<int>();
    dep["runtime_url"] = row["runtime_url"].is_null() ? "" : row["runtime_url"].as<std::string>();
    dep["runtime_exposure"] = row["runtime_exposure"].is_null() ? "" : row["runtime_exposure"].as<std::string>();
    dep["created_at"] = row["created_at"].as<std::string>();
    return dep;
}

void broadcastDeploymentSummary(const std::string& deploymentId) {
    Json::Value summary = loadDeploymentSummary(deploymentId);
    if (!summary.isNull()) {
        LogWebSocketController::broadcastDeploymentUpdate(summary);
    }
}

void startBackgroundBuild(const std::string& deploymentId,
                          const std::string& sourceType,
                          const std::string& repoUrl,
                          const std::string& version,
                          const std::string& githubPat,
                          const std::string& sourcePath,
                          const SshConnectionConfig& sshConfig,
                          const std::string& executionMode,
                          const SshConnectionConfig& remoteExecutionConfig,
                          const std::string& remoteRuntimeType,
                          const std::string& remoteK8sExposure,
                          const std::string& runtimeScheme,
                          const std::string& projectName,
                          const std::vector<BuildEnvVar>& envVars) {
    std::thread buildThread([deploymentId, sourceType, repoUrl, version, githubPat, sourcePath, sshConfig, executionMode, remoteExecutionConfig, remoteRuntimeType, remoteK8sExposure, runtimeScheme, projectName, envVars]() {
        try {
            BuildService buildService;
            const auto logSink = [deploymentId](const std::string& line) {
                appendDeploymentLog(deploymentId, line);
                LogWebSocketController::broadcastLog(deploymentId, line);
            };

            BuildResult buildResult;
            KubernetesRuntimeInfo remoteK8sRuntime;
            KubernetesRuntimeInfo localK8sRuntime;
            bool hasRemoteK8sRuntime = false;
            bool hasLocalK8sRuntime = false;
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
                    if (buildResult.composeProject) {
                        KubernetesDeployOptions options;
                        options.deploymentId = deploymentId;
                        options.projectName = projectName;
                        options.nameSpace = "stackpilot-apps";
                        options.runtimeScheme = normalizeRuntimeScheme(runtimeScheme);
                        options.exposureMode = options.runtimeScheme == "https" ? "ingress" : normalizeRemoteK8sExposure(remoteK8sExposure);
                        options.replicas = 1;
                        options.containerPort = 3000;
                        options.resourcePreset = "small";
                        options.healthPath = "/";
                        for (const auto& envVar : envVars) {
                            options.envVars.emplace_back(envVar.key, envVar.value);
                        }
                        logSink("Deploying Docker Compose stack to remote Kubernetes...");
                        remoteK8sRuntime = sshService.deployComposeKubernetesRuntime(
                            remoteExecutionConfig,
                            options,
                            buildResult.composeWorkdir,
                            buildResult.composeFile,
                            buildResult.composeProjectName,
                            buildResult.composeServices
                        );
                    } else if (!buildResult.remoteContainerName.empty()) {
                        const auto cleanup = sshService.removeDockerContainer(remoteExecutionConfig, buildResult.remoteContainerName, buildResult.imageName, false);
                        buildResult.logs += "\n" + cleanup.output;
                        logSink("Temporary remote Docker container removed before Kubernetes deployment");
                    }

                    if (!buildResult.composeProject) {
                        KubernetesDeployOptions options;
                        options.deploymentId = deploymentId;
                        options.projectName = projectName;
                        options.imageName = buildResult.imageName;
                        options.nameSpace = "stackpilot-apps";
                        options.runtimeScheme = normalizeRuntimeScheme(runtimeScheme);
                        options.exposureMode = options.runtimeScheme == "https" ? "ingress" : normalizeRemoteK8sExposure(remoteK8sExposure);
                        options.replicas = 1;
                        options.containerPort = 3000;
                        logSink("Deploying image to remote Kubernetes...");
                        remoteK8sRuntime = sshService.deployKubernetesRuntime(remoteExecutionConfig, options);
                    }
                    hasRemoteK8sRuntime = true;
                    buildResult.logs += "\n" + remoteK8sRuntime.logs;
                    buildResult.runtimeProvider = "remote_kubernetes";
                    buildResult.runtimeUrl = remoteK8sRuntime.runtimeUrl;
                    buildResult.remoteContainerName.clear();
                    if (!remoteK8sRuntime.success) {
                        buildResult.success = false;
                        buildResult.error = remoteK8sRuntime.error.empty() ? "Remote Kubernetes deployment failed" : remoteK8sRuntime.error;
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

            if (buildResult.success && executionMode != "remote_host" && remoteRuntimeType == "kubernetes") {
                KubernetesDeployOptions options;
                options.deploymentId = deploymentId;
                options.projectName = projectName;
                options.imageName = buildResult.imageName;
                options.nameSpace = "stackpilot-apps";
                options.runtimeScheme = normalizeRuntimeScheme(runtimeScheme);
                options.exposureMode = options.runtimeScheme == "https" ? "ingress" : normalizeRemoteK8sExposure(remoteK8sExposure);
                options.replicas = 1;
                options.containerPort = 3000;
                options.resourcePreset = "small";
                options.healthPath = "/";
                for (const auto& envVar : envVars) {
                    options.envVars.emplace_back(envVar.key, envVar.value);
                }

                logSink("Deploying image to local Kubernetes...");
                KubernetesService kubernetesService;
                if (buildResult.composeProject) {
                    logSink("Converting Docker Compose stack to local Kubernetes resources...");
                    localK8sRuntime = kubernetesService.deployComposeStack(
                        options,
                        buildResult.composeWorkdir,
                        buildResult.composeFile,
                        buildResult.composeProjectName,
                        buildResult.composeServices
                    );
                } else {
                    localK8sRuntime = kubernetesService.deploy(options);
                }
                hasLocalK8sRuntime = true;
                buildResult.logs += "\n" + localK8sRuntime.logs;
                buildResult.runtimeProvider = "kubernetes";
                buildResult.runtimeUrl = localK8sRuntime.runtimeUrl;
                if (!localK8sRuntime.success) {
                    buildResult.success = false;
                    buildResult.error = localK8sRuntime.error.empty() ? "Local Kubernetes deployment failed" : localK8sRuntime.error;
                }
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
                        "desired_replicas = $10, runtime_snapshot = $11::jsonb, updated_at = NOW() "
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
                        compactJson(buildResult.composeProject
                            ? composeKubernetesRuntimeSnapshot(buildResult, remoteK8sRuntime, "remote_kubernetes", runtimeScheme, 3000)
                            : runtimeSnapshot(
                                "remote_kubernetes",
                                buildResult.imageName,
                                remoteK8sRuntime.runtimeUrl,
                                remoteK8sRuntime.exposureMode,
                                remoteK8sRuntime.desiredReplicas,
                                3000,
                                remoteK8sRuntime.runtimeScheme.empty() ? runtimeScheme : remoteK8sRuntime.runtimeScheme
                            )),
                        deploymentId
                    );
                    LogWebSocketController::broadcastStatus(deploymentId, remoteK8sRuntime.status.empty() ? "running" : remoteK8sRuntime.status);
                } else if (buildResult.runtimeProvider == "kubernetes" && hasLocalK8sRuntime) {
                    updateTxn.exec_params(
                        "UPDATE deployments "
                        "SET status = $1, logs = $2, image_name = $3, runtime_url = $4, runtime_exposure = $5, "
                        "runtime_provider = 'kubernetes', "
                        "k8s_namespace = $6, k8s_deployment_name = $7, k8s_service_name = $8, k8s_ingress_name = $9, "
                        "desired_replicas = $10, runtime_snapshot = $11::jsonb, runtime_paused = FALSE, updated_at = NOW() "
                        "WHERE id = $12",
                        localK8sRuntime.status.empty() ? "running" : localK8sRuntime.status,
                        buildResult.logs,
                        buildResult.imageName,
                        localK8sRuntime.runtimeUrl,
                        localK8sRuntime.exposureMode,
                        localK8sRuntime.nameSpace,
                        localK8sRuntime.deploymentName,
                        localK8sRuntime.serviceName,
                        localK8sRuntime.ingressName,
                        localK8sRuntime.desiredReplicas,
                        compactJson(buildResult.composeProject
                            ? composeKubernetesRuntimeSnapshot(buildResult, localK8sRuntime, "kubernetes", runtimeScheme, 3000)
                            : runtimeSnapshot(
                                "kubernetes",
                                buildResult.imageName,
                                localK8sRuntime.runtimeUrl,
                                localK8sRuntime.exposureMode,
                                localK8sRuntime.desiredReplicas,
                                3000,
                                localK8sRuntime.runtimeScheme.empty() ? runtimeScheme : localK8sRuntime.runtimeScheme
                            )),
                        deploymentId
                    );
                    LogWebSocketController::broadcastStatus(deploymentId, localK8sRuntime.status.empty() ? "running" : localK8sRuntime.status);
                } else if (buildResult.runtimeProvider == "remote_compose") {
                    updateTxn.exec_params(
                        "UPDATE deployments "
                        "SET status = 'running', logs = $1, image_name = $2, runtime_url = $3, runtime_exposure = 'remote_compose', "
                        "runtime_provider = 'remote_compose', remote_container_name = $4, runtime_snapshot = $5::jsonb, runtime_paused = FALSE, updated_at = NOW() "
                        "WHERE id = $6",
                        buildResult.logs,
                        buildResult.imageName,
                        buildResult.runtimeUrl,
                        buildResult.composeProjectName.empty() ? buildResult.remoteContainerName : buildResult.composeProjectName,
                        compactJson(composeRuntimeSnapshot(buildResult, "remote_compose", "http")),
                        deploymentId
                    );
                    LogWebSocketController::broadcastStatus(deploymentId, "running");
                } else if (buildResult.runtimeProvider == "remote_docker") {
                    updateTxn.exec_params(
                        "UPDATE deployments "
                        "SET status = 'running', logs = $1, image_name = $2, runtime_url = $3, runtime_exposure = 'remote_docker', "
                        "runtime_provider = 'remote_docker', remote_container_name = $4, runtime_snapshot = $5::jsonb, updated_at = NOW() "
                        "WHERE id = $6",
                        buildResult.logs,
                        buildResult.imageName,
                        buildResult.runtimeUrl,
                        buildResult.remoteContainerName,
                        compactJson(runtimeSnapshot("remote_docker", buildResult.imageName, buildResult.runtimeUrl, "remote_docker", 1, 3000, "http")),
                        deploymentId
                    );
                    LogWebSocketController::broadcastStatus(deploymentId, "running");
                } else if (buildResult.runtimeProvider == "local_compose") {
                    updateTxn.exec_params(
                        "UPDATE deployments "
                        "SET status = 'running', logs = $1, image_name = $2, runtime_url = $3, runtime_exposure = 'local_compose', "
                        "runtime_provider = 'local_compose', remote_container_name = $4, desired_replicas = 1, runtime_paused = FALSE, runtime_snapshot = $5::jsonb, updated_at = NOW() "
                        "WHERE id = $6",
                        buildResult.logs,
                        buildResult.imageName,
                        buildResult.runtimeUrl,
                        buildResult.composeProjectName.empty() ? buildResult.remoteContainerName : buildResult.composeProjectName,
                        compactJson(composeRuntimeSnapshot(buildResult, "local_compose", normalizeRuntimeScheme(runtimeScheme))),
                        deploymentId
                    );
                    LogWebSocketController::broadcastStatus(deploymentId, "running");
                } else {
                    updateTxn.exec_params(
                        "UPDATE deployments "
                        "SET status = 'built', logs = $1, image_name = $2, runtime_snapshot = $3::jsonb, updated_at = NOW() "
                        "WHERE id = $4",
                        buildResult.logs,
                        buildResult.imageName,
                        compactJson(runtimeSnapshot("local_docker", buildResult.imageName, "", "docker", 0, 3000, normalizeRuntimeScheme(runtimeScheme))),
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
                    "UPDATE deployments SET status = 'failed', logs = $1, updated_at = NOW() WHERE id = $2",
                    failureLogs,
                    deploymentId
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
                spdlog::error("Failed to persist env auto-build failure for {}: {}", deploymentId, dbError.what());
            }
        }
    });

    buildThread.detach();
}

Json::Value projectRowToJson(const pqxx::row& row) {
    Json::Value pj;
    pj["id"] = row["id"].as<std::string>();
    try {
        pj["user_id"] = row["user_id"].as<std::string>();
    } catch (...) {}
    pj["name"] = row["name"].as<std::string>();
    pj["description"] = row["description"].as<std::string>();
    pj["repo_url"] = row["repo_url"].is_null() ? "" : row["repo_url"].as<std::string>();
    pj["github_pat_configured"] = TokenCrypto::isConfigured(row["github_pat"].as<std::string>());
    pj["source_type"] = row["source_type"].is_null() ? "github" : row["source_type"].as<std::string>();
    pj["ssh_connection_id"] = row["ssh_connection_id"].is_null() ? "" : row["ssh_connection_id"].as<std::string>();
    pj["source_path"] = row["source_path"].is_null() ? "" : row["source_path"].as<std::string>();
    try {
        pj["application_template_id"] =
            row["application_template_id"].is_null() ? "" : row["application_template_id"].as<std::string>();
        if (!row["application_config"].is_null()) {
            Json::Value parsed;
            Json::CharReaderBuilder builder;
            std::string errors;
            std::istringstream stream(row["application_config"].as<std::string>());
            if (Json::parseFromStream(builder, stream, &parsed, &errors) && parsed.isObject()) {
                pj["application_config"] = parsed;
            } else {
                pj["application_config"] = Json::Value(Json::objectValue);
            }
        } else {
            pj["application_config"] = Json::Value(Json::objectValue);
        }
    } catch (...) {
        pj["application_template_id"] = "";
        pj["application_config"] = Json::Value(Json::objectValue);
    }
    try {
        pj["execution_mode"] = row["execution_mode"].is_null() ? "local" : row["execution_mode"].as<std::string>();
    } catch (...) {
        pj["execution_mode"] = "local";
    }
    try {
        pj["remote_connection_id"] = row["remote_connection_id"].is_null() ? "" : row["remote_connection_id"].as<std::string>();
    } catch (...) {
        pj["remote_connection_id"] = "";
    }
    try {
        pj["remote_runtime_type"] = row["remote_runtime_type"].is_null() ? "docker" : row["remote_runtime_type"].as<std::string>();
    } catch (...) {
        pj["remote_runtime_type"] = "docker";
    }
    try {
        pj["remote_k8s_exposure"] = row["remote_k8s_exposure"].is_null() ? "nodeport" : row["remote_k8s_exposure"].as<std::string>();
    } catch (...) {
        pj["remote_k8s_exposure"] = "nodeport";
    }
    try {
        pj["runtime_scheme"] = row["runtime_scheme"].is_null() ? "http" : row["runtime_scheme"].as<std::string>();
    } catch (...) {
        pj["runtime_scheme"] = "http";
    }
    try {
        pj["local_https_enabled"] = row["local_https_enabled"].is_null() ? false : row["local_https_enabled"].as<bool>();
    } catch (...) {
        pj["local_https_enabled"] = false;
    }
    try {
        pj["env_var_count"] = row["env_var_count"].is_null() ? 0 : row["env_var_count"].as<int>();
    } catch (...) {}
    pj["status"] = row["status"].as<std::string>();
    try {
        pj["created_at"] = row["created_at"].as<std::string>();
    } catch (...) {}
    try {
        pj["updated_at"] = row["updated_at"].as<std::string>();
    } catch (...) {}
    return pj;
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

} // namespace

std::string ProjectController::extractUserId(const drogon::HttpRequestPtr& req) {
    auto payload = JwtHelper::verifyRequestToken(req);
    if (payload.isNull()) return "";
    return payload["user_id"].asString();
}

void ProjectController::createProject(
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
        auto body = req->getJsonObject();
        if (!body) {
            Json::Value err; err["error"] = "Invalid JSON body";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp); return;
        }

        std::string name = (*body)["name"].asString();
        std::string description = (*body).isMember("description") ? (*body)["description"].asString() : "";
        std::string repoUrl = (*body).isMember("repo_url") ? (*body)["repo_url"].asString() : "";
        std::string githubPat = (*body).isMember("github_pat") ? (*body)["github_pat"].asString() : "";
        std::string sourceType = (*body).isMember("source_type") ? (*body)["source_type"].asString() : "github";
        std::string sshConnectionId = (*body).isMember("ssh_connection_id") ? (*body)["ssh_connection_id"].asString() : "";
        std::string sourcePath = (*body).isMember("source_path") ? (*body)["source_path"].asString() : "";
        std::string executionMode = (*body).isMember("execution_mode") ? (*body)["execution_mode"].asString() : "local";
        std::string remoteConnectionId = (*body).isMember("remote_connection_id") ? (*body)["remote_connection_id"].asString() : "";
        std::string remoteRuntimeType = (*body).isMember("remote_runtime_type") ? (*body)["remote_runtime_type"].asString() : "docker";
        std::string remoteK8sExposure = normalizeRemoteK8sExposure(
            (*body).isMember("remote_k8s_exposure") ? (*body)["remote_k8s_exposure"].asString() : "nodeport"
        );
        std::string runtimeScheme = normalizeRuntimeScheme(
            (*body).isMember("runtime_scheme") ? (*body)["runtime_scheme"].asString() : "http"
        );
        bool localHttpsEnabled = (*body).isMember("local_https_enabled") && (*body)["local_https_enabled"].asBool();
        if (localHttpsEnabled) {
            runtimeScheme = "https";
        }
        std::string applicationTemplateId =
            (*body).isMember("application_template_id") ? trim((*body)["application_template_id"].asString()) : "";
        Json::Value applicationConfig = (*body).isMember("application_config") && (*body)["application_config"].isObject()
            ? (*body)["application_config"]
            : Json::Value(Json::objectValue);
        std::vector<BuildEnvVar> envVars = parseEnvVars(*body);

        if (name.empty()) {
            Json::Value err; err["error"] = "Project name is required";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp); return;
        }
        if (!isSupportedSourceType(sourceType)) {
            Json::Value err; err["error"] = "Unsupported project source type";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp); return;
        }
        if (!isSupportedExecutionMode(executionMode)) {
            Json::Value err; err["error"] = "Unsupported execution mode";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp); return;
        }
        if (remoteRuntimeType.empty()) {
            remoteRuntimeType = "docker";
        }
        if (remoteRuntimeType != "docker" && remoteRuntimeType != "kubernetes") {
            Json::Value err; err["error"] = "Remote runtime type must be docker or kubernetes";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp); return;
        }
        normalizeRuntimePreferences(executionMode, remoteRuntimeType, remoteK8sExposure, runtimeScheme, localHttpsEnabled);
        if (sourceType == "github" && repoUrl.empty()) {
            Json::Value err; err["error"] = "Repository URL is required for GitHub projects";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp); return;
        }
        if (sourceType == "ssh" && (sshConnectionId.empty() || sourcePath.empty())) {
            Json::Value err; err["error"] = "SSH source projects require a saved SSH connection and remote path";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp); return;
        }
        if (sourceType == "local" && sourcePath.empty()) {
            Json::Value err; err["error"] = "Local source projects require a local source path";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp); return;
        }
        if (sourceType == "application" && !ApplicationCatalog::isSupportedTemplate(applicationTemplateId)) {
            Json::Value err; err["error"] = "Choose a supported application template";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp); return;
        }
        // Remote host execution for local source is allowed if the path is accessible to the backend.

        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);

        if (sourceType == "ssh") {
            SshService sshService;
            if (!sshService.isValidRemotePath(sourcePath)) {
                Json::Value err; err["error"] = "Remote SSH path must be an absolute Linux path";
                auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
                resp->setStatusCode(drogon::k400BadRequest);
                callback(resp); return;
            }
            auto sshRows = txn.exec_params(
                "SELECT id FROM ssh_connections WHERE id = $1 AND user_id = $2",
                sshConnectionId,
                userId
            );
            if (sshRows.empty()) {
                Json::Value err; err["error"] = "SSH connection not found";
                auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
                resp->setStatusCode(drogon::k404NotFound);
                callback(resp); return;
            }
            repoUrl.clear();
            githubPat.clear();
            if (executionMode == "remote_host" && remoteConnectionId.empty()) {
                remoteConnectionId = sshConnectionId;
            }
        } else if (sourceType == "local") {
            std::filesystem::path resolvedLocalPath;
            std::string localPathError;
            if (!resolveAllowedLocalPath(sourcePath, resolvedLocalPath, localPathError)) {
                Json::Value err; err["error"] = localPathError;
                auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
                resp->setStatusCode(drogon::k400BadRequest);
                callback(resp); return;
            }
            sourcePath = resolvedLocalPath.string();
            repoUrl.clear();
            githubPat.clear();
            sshConnectionId.clear();
        } else if (sourceType == "artifact") {
            repoUrl.clear();
            githubPat.clear();
            sshConnectionId.clear();
            if (executionMode == "remote_host" && sourcePath.empty()) {
                sourcePath = "/tmp";
            }
            if (executionMode == "remote_host" && !sourcePath.empty()) {
                SshService sshService;
                if (!sshService.isValidRemotePath(sourcePath)) {
                    Json::Value err; err["error"] = "Remote artifact workspace path must be an absolute Linux path";
                    auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
                    resp->setStatusCode(drogon::k400BadRequest);
                    callback(resp); return;
                }
            }
        } else if (sourceType == "application") {
            repoUrl.clear();
            githubPat.clear();
            sshConnectionId.clear();
            const auto missingApplicationFields =
                ApplicationCatalog::missingRequiredFields(applicationTemplateId, (*body)["application_config"]);
            if (!missingApplicationFields.empty()) {
                Json::Value err;
                err["error"] = "Missing required application configuration";
                err["missing_fields"] = Json::Value(Json::arrayValue);
                for (const auto& field : missingApplicationFields) {
                    err["missing_fields"].append(field);
                }
                auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
                resp->setStatusCode(drogon::k400BadRequest);
                callback(resp); return;
            }
            applicationConfig = ApplicationCatalog::sanitizedConfig(applicationTemplateId, applicationConfig);
            auto applicationEnvVars = ApplicationCatalog::envVarsForConfig(applicationTemplateId, (*body)["application_config"]);
            std::unordered_map<std::string, std::string> merged;
            for (const auto& envVar : envVars) {
                merged[envVar.key] = envVar.value;
            }
            for (const auto& envVar : applicationEnvVars) {
                merged[envVar.key] = envVar.value;
            }
            envVars.clear();
            for (const auto& item : merged) {
                envVars.push_back({item.first, item.second});
            }
            std::sort(envVars.begin(), envVars.end(), [](const BuildEnvVar& left, const BuildEnvVar& right) {
                return left.key < right.key;
            });
            if (executionMode == "remote_host" && sourcePath.empty()) {
                sourcePath = "/tmp";
            }
            if (executionMode == "remote_host" && !sourcePath.empty()) {
                SshService sshService;
                if (!sshService.isValidRemotePath(sourcePath)) {
                    Json::Value err; err["error"] = "Remote application workspace path must be an absolute Linux path";
                    auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
                    resp->setStatusCode(drogon::k400BadRequest);
                    callback(resp); return;
                }
            }
        } else if (sourceType == "github") {
            sshConnectionId.clear();
            if (executionMode == "remote_host" && sourcePath.empty()) {
                sourcePath = "/tmp";
            }
            if (!sourcePath.empty()) {
                SshService sshService;
                if (!sshService.isValidRemotePath(sourcePath)) {
                    Json::Value err; err["error"] = "Remote GitHub workspace path must be an absolute Linux path";
                    auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
                    resp->setStatusCode(drogon::k400BadRequest);
                    callback(resp); return;
                }
            }
        }

        if (executionMode == "remote_host") {
            if (remoteConnectionId.empty() && sourceType == "ssh") {
                remoteConnectionId = sshConnectionId;
            }
            if (remoteConnectionId.empty()) {
                Json::Value err; err["error"] = "Remote execution requires a saved SSH/VPS connection";
                auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
                resp->setStatusCode(drogon::k400BadRequest);
                callback(resp); return;
            }
            auto remoteRows = txn.exec_params(
                "SELECT id FROM ssh_connections WHERE id = $1 AND user_id = $2",
                remoteConnectionId,
                userId
            );
            if (remoteRows.empty()) {
                Json::Value err; err["error"] = "Remote execution connection not found";
                auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
                resp->setStatusCode(drogon::k404NotFound);
                callback(resp); return;
            }
        } else {
            remoteConnectionId.clear();
            normalizeRuntimePreferences(executionMode, remoteRuntimeType, remoteK8sExposure, runtimeScheme, localHttpsEnabled);
        }

        std::string environmentConfigError;
        const auto environmentConfigs = parseProjectEnvironmentConfigs(
            *body,
            executionMode,
            remoteConnectionId,
            remoteRuntimeType,
            remoteK8sExposure,
            runtimeScheme,
            environmentConfigError
        );
        if (!environmentConfigError.empty()) {
            Json::Value err; err["error"] = environmentConfigError;
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp); return;
        }
        for (const auto& envConfig : environmentConfigs) {
            if (sourceType == "local" && envConfig.executionMode == "remote_host") {
                Json::Value err;
                err["error"] = "Local source projects cannot use remote-host branch environments directly. Use the MCP artifact deploy path for local-to-remote deployments.";
                auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
                resp->setStatusCode(drogon::k400BadRequest);
                callback(resp); return;
            }
            if (envConfig.executionMode == "remote_host" && envConfig.remoteConnectionId.empty()) {
                Json::Value err; err["error"] = "Remote-host environments require a saved SSH/VPS connection";
                auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
                resp->setStatusCode(drogon::k400BadRequest);
                callback(resp); return;
            }
            if (!envConfig.remoteConnectionId.empty()) {
                auto envRemoteRows = txn.exec_params(
                    "SELECT id FROM ssh_connections WHERE id = $1 AND user_id = $2",
                    envConfig.remoteConnectionId,
                    userId
                );
                if (envRemoteRows.empty()) {
                    Json::Value err; err["error"] = "Environment remote execution connection not found";
                    auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
                    resp->setStatusCode(drogon::k404NotFound);
                    callback(resp); return;
                }
            }
        }

        const std::string encryptedGithubPat = TokenCrypto::encrypt(githubPat);

        auto result = txn.exec_params(
            "INSERT INTO projects (user_id, name, description, repo_url, github_pat, source_type, ssh_connection_id, source_path, execution_mode, remote_connection_id, remote_runtime_type, remote_k8s_exposure, runtime_scheme, local_https_enabled, application_template_id, application_config) "
            "VALUES ($1, $2, $3, $4, $5, $6, NULLIF($7, '')::uuid, $8, $9, NULLIF($10, '')::uuid, $11, $12, $13, $14, $15, $16::jsonb) "
            "RETURNING id, user_id, name, description, repo_url, github_pat, source_type, ssh_connection_id, source_path, application_template_id, application_config::text AS application_config, execution_mode, remote_connection_id, remote_runtime_type, remote_k8s_exposure, runtime_scheme, local_https_enabled, status, created_at",
            userId, name, description, repoUrl, encryptedGithubPat, sourceType, sshConnectionId, sourcePath, executionMode, remoteConnectionId, remoteRuntimeType, remoteK8sExposure, runtimeScheme, localHttpsEnabled, applicationTemplateId, compactJson(applicationConfig)
        );
        const std::string projectId = result[0]["id"].as<std::string>();
        replaceProjectEnvVars(txn, projectId, envVars);
        Json::Value createdEnvironments = insertProjectEnvironments(txn, projectId, environmentConfigs);
        txn.commit();

        Json::Value auditMeta;
        auditMeta["name"] = name;
        auditMeta["source_type"] = sourceType;
        auditMeta["execution_mode"] = executionMode;
        auditMeta["remote_runtime_type"] = remoteRuntimeType;
        auditMeta["runtime_scheme"] = runtimeScheme;
        auditMeta["local_https_enabled"] = localHttpsEnabled;
        auditMeta["env_var_count"] = static_cast<int>(envVars.size());
        auditMeta["environment_count"] = static_cast<int>(createdEnvironments.size());
        AuditLogger::recordFromRequest(req, userId, "project.created", "project", projectId, auditMeta);

        Json::Value pj = projectRowToJson(result[0]);
        pj["env_var_count"] = static_cast<int>(envVars.size());
        pj["env_vars"] = envVarsToJson(envVars);
        pj["environments"] = createdEnvironments;
        Json::Value webhookWarnings(Json::arrayValue);
        if (sourceType == "github") {
            webhookWarnings = maybeRegisterGitHubWebhook(userId, repoUrl, githubPat, createdEnvironments);
        }

        Json::Value resp_body;
        resp_body["message"] = "Project created";
        resp_body["project"] = pj;
        if (!webhookWarnings.empty()) {
            resp_body["warnings"] = webhookWarnings;
        }
        auto resp = drogon::HttpResponse::newHttpJsonResponse(resp_body);
        resp->setStatusCode(drogon::k201Created);
        callback(resp);

    } catch (const std::exception& e) {
        spdlog::error("Create project error: {}", e.what());
        Json::Value err; err["error"] = "Internal server error";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void ProjectController::listProjects(
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
            "SELECT p.id, p.user_id, p.name, p.description, p.repo_url, p.github_pat, p.source_type, p.ssh_connection_id, p.source_path, "
            "p.application_template_id, p.application_config::text AS application_config, "
            "p.execution_mode, p.remote_connection_id, p.remote_runtime_type, p.remote_k8s_exposure, p.runtime_scheme, p.local_https_enabled, p.status, p.created_at, "
            "(SELECT COUNT(*)::int FROM project_env_vars pe WHERE pe.project_id = p.id) AS env_var_count "
            "FROM projects p WHERE p.user_id = $1 ORDER BY p.created_at DESC", userId
        );
        txn.commit();

        Json::Value projects(Json::arrayValue);
        for (const auto& row : result) {
            projects.append(projectRowToJson(row));
        }

        Json::Value resp_body;
        resp_body["projects"] = projects;
        resp_body["count"] = static_cast<int>(projects.size());
        callback(drogon::HttpResponse::newHttpJsonResponse(resp_body));

    } catch (const std::exception& e) {
        spdlog::error("List projects error: {}", e.what());
        Json::Value err; err["error"] = "Internal server error";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void ProjectController::getProject(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& id
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
            "SELECT p.id, p.user_id, p.name, p.description, p.repo_url, p.github_pat, p.source_type, p.ssh_connection_id, p.source_path, "
            "p.application_template_id, p.application_config::text AS application_config, "
            "p.execution_mode, p.remote_connection_id, p.remote_runtime_type, p.remote_k8s_exposure, p.runtime_scheme, p.local_https_enabled, p.status, p.created_at, p.updated_at, "
            "(SELECT COUNT(*)::int FROM project_env_vars pe WHERE pe.project_id = p.id) AS env_var_count "
            "FROM projects p WHERE p.id = $1 AND p.user_id = $2", id, userId
        );

        if (result.empty()) {
            Json::Value err; err["error"] = "Project not found";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp); return;
        }

        const auto envVars = loadProjectEnvVars(txn, id);
        txn.commit();

        Json::Value projectJson = projectRowToJson(result[0]);
        projectJson["env_vars"] = envVarsToJson(envVars);
        Json::Value resp_body; resp_body["project"] = projectJson;
        callback(drogon::HttpResponse::newHttpJsonResponse(resp_body));

    } catch (const std::exception& e) {
        spdlog::error("Get project error: {}", e.what());
        Json::Value err; err["error"] = "Internal server error";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void ProjectController::updateProject(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& id
) {
    std::string userId = extractUserId(req);
    if (userId.empty()) {
        Json::Value err; err["error"] = "Unauthorized";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp); return;
    }

    try {
        auto body = req->getJsonObject();
        if (!body) {
            Json::Value err; err["error"] = "Invalid JSON body";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp); return;
        }

        std::string name = (*body).isMember("name") ? (*body)["name"].asString() : "";
        std::string description = (*body).isMember("description") ? (*body)["description"].asString() : "";
        std::string repoUrl = (*body).isMember("repo_url") ? (*body)["repo_url"].asString() : "";
        std::string githubPat = (*body).isMember("github_pat") ? (*body)["github_pat"].asString() : "";
        std::string sourceType = (*body).isMember("source_type") ? (*body)["source_type"].asString() : "";
        std::string sshConnectionId = (*body).isMember("ssh_connection_id") ? (*body)["ssh_connection_id"].asString() : "";
        std::string sourcePath = (*body).isMember("source_path") ? (*body)["source_path"].asString() : "";
        std::string executionMode = (*body).isMember("execution_mode") ? (*body)["execution_mode"].asString() : "";
        std::string remoteConnectionId = (*body).isMember("remote_connection_id") ? (*body)["remote_connection_id"].asString() : "";
        std::string remoteRuntimeType = (*body).isMember("remote_runtime_type") ? (*body)["remote_runtime_type"].asString() : "";
        std::string remoteK8sExposure = (*body).isMember("remote_k8s_exposure")
            ? normalizeRemoteK8sExposure((*body)["remote_k8s_exposure"].asString())
            : "";
        std::string runtimeScheme = (*body).isMember("runtime_scheme")
            ? normalizeRuntimeScheme((*body)["runtime_scheme"].asString())
            : "";
        bool hasLocalHttpsEnabled = (*body).isMember("local_https_enabled");
        bool localHttpsEnabled = hasLocalHttpsEnabled && (*body)["local_https_enabled"].asBool();
        const std::vector<BuildEnvVar> incomingEnvVars = parseEnvVars(*body);
        const std::string encryptedGithubPat = githubPat.empty() ? "" : TokenCrypto::encrypt(githubPat);

        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);

        std::string resolvedSourceType;
        std::string existingSourceType;
        std::string existingRepoUrl;
        std::string existingSourcePath;
        std::string existingSshConnectionId;
        std::string existingExecutionMode;
        std::string existingRemoteConnectionId;
        std::string existingRemoteRuntimeType;
        std::string existingRemoteK8sExposure;
        std::string existingRuntimeScheme;
        bool existingLocalHttpsEnabled = false;
        std::vector<BuildEnvVar> existingEnvVars;
        std::string linkedGitHubToken;
        std::string latestVersion;
        std::string latestCommitHash;
        SshConnectionConfig sshConfig;
        SshConnectionConfig remoteExecutionConfig;
        bool hasLatestDeployment = false;
        if (!sourceType.empty()) {
            if (!isSupportedSourceType(sourceType)) {
                Json::Value err; err["error"] = "Unsupported project source type";
                auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
                resp->setStatusCode(drogon::k400BadRequest);
                callback(resp); return;
            }
            resolvedSourceType = sourceType;
        }
        if (!executionMode.empty() && !isSupportedExecutionMode(executionMode)) {
            Json::Value err; err["error"] = "Unsupported execution mode";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp); return;
        }
        if (!remoteRuntimeType.empty() && remoteRuntimeType != "docker" && remoteRuntimeType != "kubernetes") {
            Json::Value err; err["error"] = "Remote runtime type must be docker or kubernetes";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp); return;
        }
        if (!remoteRuntimeType.empty() && remoteRuntimeType != "kubernetes") {
            remoteK8sExposure = "nodeport";
        }

        auto currentRows = txn.exec_params(
            "SELECT p.source_type, p.ssh_connection_id, p.source_path, p.repo_url, "
            "p.execution_mode, p.remote_connection_id, p.remote_runtime_type, p.remote_k8s_exposure, p.runtime_scheme, p.local_https_enabled, u.github_access_token "
            "FROM projects p "
            "JOIN users u ON p.user_id = u.id "
            "WHERE p.id = $1 AND p.user_id = $2",
            id,
            userId
        );
        if (currentRows.empty()) {
            Json::Value err; err["error"] = "Project not found";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp); return;
        }
        if (resolvedSourceType.empty()) {
            resolvedSourceType = currentRows[0]["source_type"].is_null() ? "github" : currentRows[0]["source_type"].as<std::string>();
        }
        existingSourceType = currentRows[0]["source_type"].is_null() ? "github" : currentRows[0]["source_type"].as<std::string>();
        existingSshConnectionId = currentRows[0]["ssh_connection_id"].is_null() ? "" : currentRows[0]["ssh_connection_id"].as<std::string>();
        existingSourcePath = currentRows[0]["source_path"].is_null() ? "" : currentRows[0]["source_path"].as<std::string>();
        existingRepoUrl = currentRows[0]["repo_url"].is_null() ? "" : currentRows[0]["repo_url"].as<std::string>();
        existingExecutionMode = currentRows[0]["execution_mode"].is_null() ? "local" : currentRows[0]["execution_mode"].as<std::string>();
        existingRemoteConnectionId = currentRows[0]["remote_connection_id"].is_null() ? "" : currentRows[0]["remote_connection_id"].as<std::string>();
        existingRemoteRuntimeType = currentRows[0]["remote_runtime_type"].is_null() ? "docker" : currentRows[0]["remote_runtime_type"].as<std::string>();
        existingRemoteK8sExposure = currentRows[0]["remote_k8s_exposure"].is_null() ? "nodeport" : currentRows[0]["remote_k8s_exposure"].as<std::string>();
        existingRuntimeScheme = currentRows[0]["runtime_scheme"].is_null() ? "http" : currentRows[0]["runtime_scheme"].as<std::string>();
        existingLocalHttpsEnabled = currentRows[0]["local_https_enabled"].is_null() ? false : currentRows[0]["local_https_enabled"].as<bool>();
        linkedGitHubToken = currentRows[0]["github_access_token"].is_null()
            ? ""
            : TokenCrypto::decrypt(currentRows[0]["github_access_token"].as<std::string>());
        existingEnvVars = loadProjectEnvVars(txn, id);

        if (resolvedSourceType == "ssh") {
            SshService sshService;
            if (sshConnectionId.empty()) {
                sshConnectionId = existingSshConnectionId;
            }
            if (sourcePath.empty()) {
                sourcePath = existingSourcePath;
            }

            if (sshConnectionId.empty() || sourcePath.empty()) {
                Json::Value err; err["error"] = "SSH source projects require a saved SSH connection and remote path";
                auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
                resp->setStatusCode(drogon::k400BadRequest);
                callback(resp); return;
            }
            if (!sshService.isValidRemotePath(sourcePath)) {
                Json::Value err; err["error"] = "Remote SSH path must be an absolute Linux path";
                auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
                resp->setStatusCode(drogon::k400BadRequest);
                callback(resp); return;
            }

            auto sshRows = txn.exec_params(
                "SELECT id, COALESCE(connection_type, 'ssh') AS connection_type, host, port, username, auth_type, password_encrypted, private_key_encrypted, known_hosts_entry "
                "FROM ssh_connections WHERE id = $1 AND user_id = $2",
                sshConnectionId,
                userId
            );
            if (sshRows.empty()) {
                Json::Value err; err["error"] = "SSH connection not found";
                auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
                resp->setStatusCode(drogon::k404NotFound);
                callback(resp); return;
            }
            sshConfig.connectionType = sshRows[0]["connection_type"].as<std::string>();
            sshConfig.host = sshRows[0]["host"].as<std::string>();
            sshConfig.port = sshRows[0]["port"].is_null() ? 22 : sshRows[0]["port"].as<int>();
            sshConfig.username = sshRows[0]["username"].as<std::string>();
            sshConfig.authType = sshRows[0]["auth_type"].as<std::string>();
            sshConfig.password = sshRows[0]["password_encrypted"].is_null()
                ? ""
                : TokenCrypto::decrypt(sshRows[0]["password_encrypted"].as<std::string>());
            sshConfig.privateKey = sshRows[0]["private_key_encrypted"].is_null()
                ? ""
                : TokenCrypto::decrypt(sshRows[0]["private_key_encrypted"].as<std::string>());
            sshConfig.knownHostsEntry = sshRows[0]["known_hosts_entry"].as<std::string>();
            repoUrl.clear();
            githubPat.clear();
        } else if (resolvedSourceType == "local") {
            if (sourcePath.empty()) {
                sourcePath = existingSourcePath;
            }
            std::filesystem::path resolvedLocalPath;
            std::string localPathError;
            if (!resolveAllowedLocalPath(sourcePath, resolvedLocalPath, localPathError)) {
                Json::Value err; err["error"] = localPathError;
                auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
                resp->setStatusCode(drogon::k400BadRequest);
                callback(resp); return;
            }
            sourcePath = resolvedLocalPath.string();
            sshConnectionId.clear();
            repoUrl.clear();
            githubPat.clear();
        } else if (resolvedSourceType == "artifact") {
            sshConnectionId.clear();
            repoUrl.clear();
            githubPat.clear();
            if (sourcePath.empty()) {
                sourcePath = existingSourcePath;
            }
            if (executionMode == "remote_host" && sourcePath.empty()) {
                sourcePath = "/tmp";
            }
            if (executionMode == "remote_host" && !sourcePath.empty()) {
                SshService sshService;
                if (!sshService.isValidRemotePath(sourcePath)) {
                    Json::Value err; err["error"] = "Remote artifact workspace path must be an absolute Linux path";
                    auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
                    resp->setStatusCode(drogon::k400BadRequest);
                    callback(resp); return;
                }
            }
        } else {
            sshConnectionId.clear();
            if (sourcePath.empty()) {
                sourcePath = existingSourcePath;
            }
            if (executionMode == "remote_host" && sourcePath.empty()) {
                sourcePath = "/tmp";
            }
            if (!sourcePath.empty()) {
                SshService sshService;
                if (!sshService.isValidRemotePath(sourcePath)) {
                    Json::Value err; err["error"] = "Remote GitHub workspace path must be an absolute Linux path";
                    auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
                    resp->setStatusCode(drogon::k400BadRequest);
                    callback(resp); return;
                }
            }
            if (repoUrl.empty()) {
                repoUrl = existingRepoUrl;
            }
        }

        if (executionMode.empty()) {
            executionMode = existingExecutionMode.empty() ? "local" : existingExecutionMode;
        }
        if (remoteRuntimeType.empty()) {
            remoteRuntimeType = existingRemoteRuntimeType.empty() ? "docker" : existingRemoteRuntimeType;
        }
        if (remoteK8sExposure.empty()) {
            remoteK8sExposure = existingRemoteK8sExposure.empty() ? "nodeport" : existingRemoteK8sExposure;
        }
        if (runtimeScheme.empty()) {
            runtimeScheme = existingRuntimeScheme.empty() ? "http" : existingRuntimeScheme;
        }
        if (!hasLocalHttpsEnabled) {
            localHttpsEnabled = existingLocalHttpsEnabled;
        }
        normalizeRuntimePreferences(executionMode, remoteRuntimeType, remoteK8sExposure, runtimeScheme, localHttpsEnabled);
        if (executionMode == "remote_host") {
            if (remoteConnectionId.empty()) {
                if (resolvedSourceType == "ssh") {
                    remoteConnectionId = existingRemoteConnectionId.empty() ? sshConnectionId : existingRemoteConnectionId;
                } else {
                    remoteConnectionId = existingRemoteConnectionId;
                }
            }
            if (remoteConnectionId.empty()) {
                Json::Value err; err["error"] = "Remote execution requires a saved SSH/VPS connection";
                auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
                resp->setStatusCode(drogon::k400BadRequest);
                callback(resp); return;
            }
            if (resolvedSourceType == "ssh" && remoteConnectionId != sshConnectionId) {
                Json::Value err; err["error"] = "Remote execution currently uses the same SSH/VPS connection as the project source";
                auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
                resp->setStatusCode(drogon::k400BadRequest);
                callback(resp); return;
            }
            auto remoteRows = txn.exec_params(
                "SELECT id, COALESCE(connection_type, 'ssh') AS connection_type, host, port, username, auth_type, password_encrypted, private_key_encrypted, known_hosts_entry "
                "FROM ssh_connections WHERE id = $1 AND user_id = $2",
                remoteConnectionId,
                userId
            );
            if (remoteRows.empty()) {
                Json::Value err; err["error"] = "Remote execution connection not found";
                auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
                resp->setStatusCode(drogon::k404NotFound);
                callback(resp); return;
            }
            remoteExecutionConfig.connectionType = remoteRows[0]["connection_type"].as<std::string>();
            remoteExecutionConfig.host = remoteRows[0]["host"].as<std::string>();
            remoteExecutionConfig.port = remoteRows[0]["port"].is_null() ? 22 : remoteRows[0]["port"].as<int>();
            remoteExecutionConfig.username = remoteRows[0]["username"].as<std::string>();
            remoteExecutionConfig.authType = remoteRows[0]["auth_type"].as<std::string>();
            remoteExecutionConfig.password = remoteRows[0]["password_encrypted"].is_null()
                ? ""
                : TokenCrypto::decrypt(remoteRows[0]["password_encrypted"].as<std::string>());
            remoteExecutionConfig.privateKey = remoteRows[0]["private_key_encrypted"].is_null()
                ? ""
                : TokenCrypto::decrypt(remoteRows[0]["private_key_encrypted"].as<std::string>());
            remoteExecutionConfig.knownHostsEntry = remoteRows[0]["known_hosts_entry"].as<std::string>();
        } else {
            remoteConnectionId.clear();
            normalizeRuntimePreferences(executionMode, remoteRuntimeType, remoteK8sExposure, runtimeScheme, localHttpsEnabled);
        }

        const std::vector<BuildEnvVar> finalEnvVars =
            (*body).isMember("env_vars") ? incomingEnvVars : existingEnvVars;
        const bool envChanged = envVarsSignature(finalEnvVars) != envVarsSignature(existingEnvVars);

        auto latestDeploymentRows = txn.exec_params(
            "SELECT id, version, commit_hash FROM deployments WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1",
            id
        );
        if (!latestDeploymentRows.empty()) {
            hasLatestDeployment = true;
            latestVersion = latestDeploymentRows[0]["version"].as<std::string>();
            latestCommitHash = latestDeploymentRows[0]["commit_hash"].is_null()
                ? ""
                : latestDeploymentRows[0]["commit_hash"].as<std::string>();
        }

        if (hasLatestDeployment) {
            const bool sourceIdentityChanged =
                resolvedSourceType != existingSourceType ||
                sourcePath != existingSourcePath ||
                repoUrl != existingRepoUrl ||
                sshConnectionId != existingSshConnectionId ||
                executionMode != existingExecutionMode ||
                remoteConnectionId != existingRemoteConnectionId;
            if (sourceIdentityChanged) {
                Json::Value err;
                err["error"] = "Project source and remote workspace cannot be changed after deployments exist. Create a new project for a different path or server.";
                auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
                resp->setStatusCode(drogon::k409Conflict);
                callback(resp);
                return;
            }
        }

        auto result = txn.exec_params(
            "UPDATE projects SET "
            "name = COALESCE(NULLIF($1, ''), name), "
            "description = COALESCE(NULLIF($2, ''), description), "
            "repo_url = CASE "
            "    WHEN NULLIF($5, '') IN ('ssh', 'local', 'artifact') THEN '' "
            "    ELSE COALESCE(NULLIF($3, ''), repo_url) "
            "END, "
            "github_pat = CASE "
            "    WHEN NULLIF($5, '') IN ('ssh', 'local', 'artifact') THEN github_pat "
            "    ELSE COALESCE(NULLIF($4, ''), github_pat) "
            "END, "
            "source_type = COALESCE(NULLIF($5, ''), source_type), "
            "ssh_connection_id = CASE "
            "    WHEN NULLIF($5, '') = 'ssh' THEN NULLIF($6, '')::uuid "
            "    WHEN NULLIF($5, '') IN ('github', 'local', 'artifact') THEN NULL "
            "    ELSE ssh_connection_id "
            "END, "
            "source_path = CASE "
            "    WHEN NULLIF($5, '') IN ('ssh', 'local', 'artifact') THEN $7 "
            "    WHEN NULLIF($5, '') = 'github' THEN $7 "
            "    ELSE COALESCE(NULLIF($7, ''), source_path) "
            "END, "
            "execution_mode = $10, "
            "remote_connection_id = NULLIF($11, '')::uuid, "
            "remote_runtime_type = $12, "
            "remote_k8s_exposure = $13, "
            "runtime_scheme = $14, "
            "local_https_enabled = $15, "
            "updated_at = NOW() "
            "WHERE id = $8 AND user_id = $9 "
            "RETURNING id, name, description, repo_url, github_pat, source_type, ssh_connection_id, source_path, execution_mode, remote_connection_id, remote_runtime_type, remote_k8s_exposure, runtime_scheme, local_https_enabled, status, updated_at",
            name, description, repoUrl, encryptedGithubPat, resolvedSourceType, sshConnectionId, sourcePath, id, userId,
            executionMode, remoteConnectionId, remoteRuntimeType, remoteK8sExposure, runtimeScheme, localHttpsEnabled
        );

        replaceProjectEnvVars(txn, id, finalEnvVars);

        std::string autoBuildDeploymentId;
        if (envChanged && hasLatestDeployment) {
            auto autoBuildRows = txn.exec_params(
                "INSERT INTO deployments (project_id, version, commit_hash, status, logs) "
                "VALUES ($1, $2, $3, 'queued', 'Environmental variables changed. Deployment queued for background worker.\n') "
                "RETURNING id",
                id,
                latestVersion.empty() ? "v1.0.0" : latestVersion,
                latestCommitHash
            );
            autoBuildDeploymentId = autoBuildRows[0]["id"].as<std::string>();
        }
        txn.commit();

        if (result.empty()) {
            Json::Value err; err["error"] = "Project not found";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp); return;
        }

        Json::Value resp_body;
        Json::Value projectJson = projectRowToJson(result[0]);
        projectJson["env_var_count"] = static_cast<int>(finalEnvVars.size());
        projectJson["env_vars"] = envVarsToJson(finalEnvVars);
        resp_body["message"] = envChanged && hasLatestDeployment
            ? "Project updated. Environmental variables changed, auto building project..."
            : "Project updated";
        resp_body["project"] = projectJson;
        resp_body["auto_build_triggered"] = envChanged && hasLatestDeployment;
        if (!autoBuildDeploymentId.empty()) {
            resp_body["auto_build_deployment_id"] = autoBuildDeploymentId;
        }

        if (!autoBuildDeploymentId.empty()) {
            Json::Value job = JobQueueService::getInstance().enqueueDeploymentBuild(
                autoBuildDeploymentId,
                userId,
                "Environmental variables changed. Deployment queued for background worker."
            );
            resp_body["auto_build_job"] = job;
        }
        Json::Value auditMeta;
        auditMeta["name"] = projectJson["name"].asString();
        auditMeta["source_type"] = projectJson["source_type"].asString();
        auditMeta["execution_mode"] = projectJson["execution_mode"].asString();
        auditMeta["remote_runtime_type"] = projectJson["remote_runtime_type"].asString();
        auditMeta["runtime_scheme"] = projectJson["runtime_scheme"].asString();
        auditMeta["local_https_enabled"] = projectJson["local_https_enabled"].asBool();
        auditMeta["env_changed"] = envChanged;
        auditMeta["auto_build_triggered"] = envChanged && hasLatestDeployment;
        if (!autoBuildDeploymentId.empty()) {
            auditMeta["auto_build_deployment_id"] = autoBuildDeploymentId;
        }
        AuditLogger::recordFromRequest(req, userId, "project.updated", "project", id, auditMeta);
        callback(drogon::HttpResponse::newHttpJsonResponse(resp_body));

    } catch (const std::exception& e) {
        spdlog::error("Update project error: {}", e.what());
        Json::Value err; err["error"] = "Internal server error";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void ProjectController::deleteProject(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& id
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

        std::vector<std::string> deploymentIds;
        {
            pqxx::work txn(*conn);
            auto projectRows = txn.exec_params(
                "SELECT id FROM projects WHERE id = $1 AND user_id = $2",
                id,
                userId
            );
            if (projectRows.empty()) {
                txn.commit();
                Json::Value err; err["error"] = "Project not found";
                auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
                resp->setStatusCode(drogon::k404NotFound);
                callback(resp); return;
            }

            auto activeJobs = txn.exec_params(
                "SELECT COUNT(*) FROM deployments d "
                "JOIN deployment_jobs j ON j.deployment_id = d.id "
                "WHERE d.project_id = $1 AND j.status = 'running'",
                id
            );
            const int runningJobs = activeJobs.empty() ? 0 : activeJobs[0][0].as<int>();
            if (runningJobs > 0) {
                txn.commit();
                Json::Value err;
                err["error"] = "Project has running deployment jobs. Wait for them to finish before deleting so runtime cleanup can be authoritative.";
                err["running_jobs"] = runningJobs;
                auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
                resp->setStatusCode(drogon::k409Conflict);
                callback(resp); return;
            }

            txn.exec_params(
                "UPDATE deployment_jobs j "
                "SET status = 'canceled', completed_at = NOW(), locked_by = '', locked_at = NULL, updated_at = NOW() "
                "FROM deployments d "
                "WHERE j.deployment_id = d.id AND d.project_id = $1 AND j.status IN ('queued', 'retrying')",
                id
            );

            auto rows = txn.exec_params(
                "SELECT id FROM deployments WHERE project_id = $1 ORDER BY created_at DESC",
                id
            );
            for (const auto& row : rows) {
                deploymentIds.push_back(row["id"].as<std::string>());
            }
            txn.commit();
        }

        DeploymentCleanupService cleanupService;
        Json::Value cleanupResults(Json::arrayValue);
        for (const auto& deploymentId : deploymentIds) {
            DeploymentCleanupOptions options;
            options.deleteDatabaseRow = false;
            options.deleteImage = true;
            options.deleteRemoteWorkspace = true;
            const DeploymentCleanupResult cleanup = cleanupService.cleanupDeployment(userId, deploymentId, options);
            cleanupResults.append(cleanup.toJson());
            if (!cleanup.success) {
                Json::Value err;
                err["error"] = cleanup.error.empty() ? "Failed to clean deployment before deleting project" : cleanup.error;
                err["deployment_id"] = deploymentId;
                err["cleanup_results"] = cleanupResults;
                auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
                resp->setStatusCode(drogon::k500InternalServerError);
                callback(resp);
                return;
            }
        }

        pqxx::work txn(*conn);
        auto result = txn.exec_params(
            "DELETE FROM projects WHERE id = $1 AND user_id = $2 RETURNING id",
            id, userId
        );
        txn.commit();

        if (result.empty()) {
            Json::Value err; err["error"] = "Project not found";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp); return;
        }

        Json::Value resp_body;
        resp_body["message"] = "Project deleted successfully";
        resp_body["cleaned_deployments"] = cleanupResults;
        Json::Value auditMeta(Json::objectValue);
        auditMeta["cleaned_deployment_count"] = static_cast<int>(deploymentIds.size());
        AuditLogger::recordFromRequest(req, userId, "project.deleted", "project", id, auditMeta);
        callback(drogon::HttpResponse::newHttpJsonResponse(resp_body));

    } catch (const std::exception& e) {
        spdlog::error("Delete project error: {}", e.what());
        Json::Value err; err["error"] = "Internal server error";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void ProjectController::browseLocalSources(
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

    auto body = req->getJsonObject();
    const std::string requestedPath = (body && (*body).isMember("path")) ? (*body)["path"].asString() : "";

    try {
        namespace fs = std::filesystem;

        Json::Value payload;
        Json::Value roots(Json::arrayValue);
        for (const auto& root : configuredLocalSourceRoots()) {
            std::error_code ec;
            const fs::path canonicalRoot = fs::weakly_canonical(root, ec);
            if (!ec && fs::exists(canonicalRoot, ec) && fs::is_directory(canonicalRoot, ec)) {
                Json::Value item;
                item["path"] = canonicalRoot.string();
                item["name"] = canonicalRoot.filename().empty() ? canonicalRoot.string() : canonicalRoot.filename().string();
                roots.append(item);
            }
        }
        payload["roots"] = roots;

        if (trim(requestedPath).empty()) {
            payload["path"] = "";
            payload["entries"] = Json::arrayValue;
            callback(drogon::HttpResponse::newHttpJsonResponse(payload));
            return;
        }

        fs::path resolvedPath;
        std::string pathError;
        if (!resolveAllowedLocalPath(requestedPath, resolvedPath, pathError)) {
            Json::Value err; err["error"] = pathError;
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp); return;
        }

        Json::Value entries(Json::arrayValue);
        std::error_code ec;
        std::vector<fs::directory_entry> directoryEntries;
        for (const auto& entry : fs::directory_iterator(resolvedPath, fs::directory_options::skip_permission_denied, ec)) {
            if (ec) {
                break;
            }
            if (entry.is_symlink(ec) || !entry.is_directory(ec)) {
                continue;
            }
            directoryEntries.push_back(entry);
        }
        std::sort(directoryEntries.begin(), directoryEntries.end(), [](const fs::directory_entry& left, const fs::directory_entry& right) {
            return left.path().filename().string() < right.path().filename().string();
        });

        for (const auto& entry : directoryEntries) {
            Json::Value item;
            item["name"] = entry.path().filename().string();
            item["directory"] = true;
            item["path"] = entry.path().string();
            entries.append(item);
        }

        payload["path"] = resolvedPath.string();
        payload["entries"] = entries;
        callback(drogon::HttpResponse::newHttpJsonResponse(payload));
    } catch (const std::exception& e) {
        spdlog::error("Browse local sources error: {}", e.what());
        Json::Value err; err["error"] = "Internal server error";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void ProjectController::listGitHubRepos(
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

    std::string pat;
    auto body = req->getJsonObject();
    if (body && (*body).isMember("pat")) {
        pat = (*body)["pat"].asString();
    }

    if (pat.empty()) {
        try {
            auto& db = Database::getInstance();
            auto conn = db.getConnection();
            pqxx::work txn(*conn);
            auto userRows = txn.exec_params(
                "SELECT github_access_token FROM users WHERE id = $1",
                userId
            );
            txn.commit();

            if (!userRows.empty() && !userRows[0]["github_access_token"].is_null()) {
                pat = TokenCrypto::decrypt(userRows[0]["github_access_token"].as<std::string>());
            }
        } catch (const std::exception& e) {
            spdlog::warn("Unable to load connected GitHub token for repo listing: {}", e.what());
        }
    }

    if (pat.empty()) {
        Json::Value err; err["error"] = "Connect GitHub or provide a Personal Access Token (PAT) to load repositories";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k400BadRequest);
        callback(resp); return;
    }

    auto client = drogon::HttpClient::newHttpClient("https://api.github.com");
    auto repos = std::make_shared<Json::Value>(Json::arrayValue);
    auto seenRepoNames = std::make_shared<std::unordered_set<std::string>>();
    auto orgs = std::make_shared<std::vector<std::string>>();
    auto userRepoPage = std::make_shared<int>(1);
    auto orgPage = std::make_shared<int>(1);
    auto orgRepoPage = std::make_shared<int>(1);
    auto orgIndex = std::make_shared<size_t>(0);
    auto completed = std::make_shared<bool>(false);
    auto warnings = std::make_shared<Json::Value>(Json::arrayValue);
    auto oauthScopes = std::make_shared<std::string>();

    auto sendError = [callback, completed](const std::string& message, const Json::Value& details = Json::Value()) {
        if (*completed) {
            return;
        }
        *completed = true;
        Json::Value err;
        err["error"] = message;
        if (!details.isNull()) {
            err["details"] = details;
        }
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k400BadRequest);
        callback(resp);
    };

    auto sendFinal = [callback, repos, orgs, warnings, oauthScopes, completed]() {
        if (*completed) {
            return;
        }
        *completed = true;
        Json::Value body(Json::objectValue);
        body["repositories"] = *repos;
        body["count"] = static_cast<Json::UInt64>(repos->size());
        body["organizations_count"] = static_cast<Json::UInt64>(orgs->size());
        if (!oauthScopes->empty()) {
            body["oauth_scopes"] = *oauthScopes;
        }
        if (warnings->size() > 0u) {
            body["warnings"] = *warnings;
        }
        auto finalResp = drogon::HttpResponse::newHttpResponse();
        Json::StreamWriterBuilder writer;
        writer["indentation"] = "";
        finalResp->setBody(Json::writeString(writer, body));
        finalResp->setStatusCode(drogon::k200OK);
        finalResp->setContentTypeCode(drogon::CT_APPLICATION_JSON);
        callback(finalResp);
    };

    auto makeGitHubRequest = [pat](const std::string& requestPath) {
        auto gitReq = drogon::HttpRequest::newHttpRequest();
        gitReq->setPath(requestPath);
        gitReq->setMethod(drogon::Get);
        gitReq->addHeader("Authorization", "Bearer " + pat);
        gitReq->addHeader("User-Agent", "stackpilot-Platform");
        gitReq->addHeader("Accept", "application/vnd.github+json");
        gitReq->addHeader("X-GitHub-Api-Version", "2022-11-28");
        return gitReq;
    };

    auto parsePayload = [](const drogon::HttpResponsePtr& response, Json::Value& payload) {
        Json::CharReaderBuilder builder;
        builder["collectComments"] = false;
        std::string errors;
        std::istringstream bodyStream(std::string(response->getBody()));
        return Json::parseFromStream(builder, bodyStream, &payload, &errors);
    };

    auto addRepos = [repos, seenRepoNames](const Json::Value& payload) {
        for (const auto& repo : payload) {
            const std::string fullName = repo.isMember("full_name") ? repo["full_name"].asString() : "";
            if (fullName.empty()) {
                continue;
            }

            if (seenRepoNames->insert(fullName).second) {
                repos->append(repo);
            }
        }
    };

    auto fetchOrgRepos = std::make_shared<std::function<void()>>();
    auto fetchOrgs = std::make_shared<std::function<void()>>();
    auto fetchUserRepos = std::make_shared<std::function<void()>>();

    *fetchOrgRepos = [client, makeGitHubRequest, parsePayload, addRepos, orgs, orgIndex, orgRepoPage, warnings, sendFinal, fetchOrgRepos]() {
        if (*orgIndex >= orgs->size()) {
            sendFinal();
            return;
        }

        const std::string org = (*orgs)[*orgIndex];
        std::ostringstream path;
        path << "/orgs/" << drogon::utils::urlEncode(org)
             << "/repos?type=all&sort=updated&per_page=100&page=" << *orgRepoPage;

        client->sendRequest(makeGitHubRequest(path.str()), [parsePayload, addRepos, orgs, orgIndex, orgRepoPage, warnings, sendFinal, fetchOrgRepos, org](drogon::ReqResult result, const drogon::HttpResponsePtr& response) {
            if (result != drogon::ReqResult::Ok) {
                const std::string warning = "Failed to connect to GitHub while listing repositories for organization " + org;
                warnings->append(warning);
                spdlog::warn("{}", warning);
                ++(*orgIndex);
                *orgRepoPage = 1;
                (*fetchOrgRepos)();
                return;
            }

            Json::Value payload;
            parsePayload(response, payload);

            if (response->getStatusCode() != drogon::k200OK || !payload.isArray()) {
                std::string detail;
                if (payload.isObject() && payload.isMember("message")) {
                    detail = payload["message"].asString();
                }
                std::ostringstream warning;
                warning << "GitHub skipped repositories for organization " << org
                        << " with status " << static_cast<int>(response->getStatusCode());
                if (!detail.empty()) {
                    warning << ": " << detail;
                }
                warnings->append(warning.str());
                spdlog::warn("{}", warning.str());
                ++(*orgIndex);
                *orgRepoPage = 1;
                (*fetchOrgRepos)();
                return;
            }

            addRepos(payload);
            if (payload.size() == 100u) {
                ++(*orgRepoPage);
                (*fetchOrgRepos)();
                return;
            }

            ++(*orgIndex);
            *orgRepoPage = 1;
            (*fetchOrgRepos)();
        });
    };

    *fetchOrgs = [client, makeGitHubRequest, parsePayload, orgs, orgPage, warnings, oauthScopes, sendFinal, fetchOrgs, fetchOrgRepos]() {
        std::ostringstream path;
        path << "/user/orgs?per_page=100&page=" << *orgPage;

        client->sendRequest(makeGitHubRequest(path.str()), [parsePayload, orgs, orgPage, warnings, oauthScopes, sendFinal, fetchOrgs, fetchOrgRepos](drogon::ReqResult result, const drogon::HttpResponsePtr& response) {
            if (result != drogon::ReqResult::Ok) {
                warnings->append("Failed to connect to GitHub while listing organizations");
                spdlog::warn("Failed to connect to GitHub while listing organizations");
                sendFinal();
                return;
            }

            Json::Value payload;
            parsePayload(response, payload);
            if (oauthScopes->empty()) {
                *oauthScopes = response->getHeader("X-OAuth-Scopes");
            }

            if (response->getStatusCode() != drogon::k200OK || !payload.isArray()) {
                std::string detail;
                if (payload.isObject() && payload.isMember("message")) {
                    detail = payload["message"].asString();
                }
                std::ostringstream warning;
                warning << "GitHub organization listing unavailable with status "
                        << static_cast<int>(response->getStatusCode());
                if (!detail.empty()) {
                    warning << ": " << detail;
                }
                if (!oauthScopes->empty() && oauthScopes->find("read:org") == std::string::npos) {
                    warning << ". Reconnect GitHub to grant read:org.";
                }
                warnings->append(warning.str());
                spdlog::warn("{}", warning.str());
                sendFinal();
                return;
            }

            for (const auto& org : payload) {
                const std::string login = org.isMember("login") ? org["login"].asString() : "";
                if (!login.empty()) {
                    orgs->push_back(login);
                }
            }

            if (payload.size() == 100u) {
                ++(*orgPage);
                (*fetchOrgs)();
                return;
            }

            (*fetchOrgRepos)();
        });
    };

    *fetchUserRepos = [client, makeGitHubRequest, parsePayload, addRepos, userRepoPage, oauthScopes, sendError, fetchUserRepos, fetchOrgs]() {
        std::ostringstream path;
        path << "/user/repos?visibility=all&affiliation=owner,collaborator,organization_member"
             << "&sort=updated&per_page=100&page=" << *userRepoPage;

        client->sendRequest(makeGitHubRequest(path.str()), [parsePayload, addRepos, userRepoPage, oauthScopes, sendError, fetchUserRepos, fetchOrgs](drogon::ReqResult result, const drogon::HttpResponsePtr& response) {
            if (result != drogon::ReqResult::Ok) {
                sendError("Failed to connect to GitHub");
                return;
            }

            Json::Value payload;
            parsePayload(response, payload);
            if (oauthScopes->empty()) {
                *oauthScopes = response->getHeader("X-OAuth-Scopes");
            }

            if (response->getStatusCode() != drogon::k200OK) {
                sendError("GitHub rejected the token or it is missing repository permissions", payload);
                return;
            }

            if (!payload.isArray()) {
                sendError("GitHub returned an unexpected repository payload");
                return;
            }

            addRepos(payload);
            if (payload.size() == 100u) {
                ++(*userRepoPage);
                (*fetchUserRepos)();
                return;
            }

            (*fetchOrgs)();
        });
    };

    (*fetchUserRepos)();
}

void ProjectController::listGitHubBranches(
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

    auto body = req->getJsonObject();
    if (!body) {
        Json::Value err; err["error"] = "Invalid JSON body";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k400BadRequest);
        callback(resp); return;
    }

    std::string pat = body->isMember("pat") ? (*body)["pat"].asString() : "";
    const std::string repoInput = body->isMember("repo_url")
        ? (*body)["repo_url"].asString()
        : (body->isMember("full_name") ? (*body)["full_name"].asString() : "");
    const std::string fullName = githubFullNameFromUrl(repoInput);
    if (fullName.empty()) {
        Json::Value err; err["error"] = "A GitHub repository URL or owner/name is required";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k400BadRequest);
        callback(resp); return;
    }

    if (pat.empty()) {
        try {
            auto conn = Database::getInstance().getConnection();
            pqxx::work txn(*conn);
            auto userRows = txn.exec_params(
                "SELECT github_access_token FROM users WHERE id = $1",
                userId
            );
            txn.commit();
            if (!userRows.empty() && !userRows[0]["github_access_token"].is_null()) {
                pat = TokenCrypto::decrypt(userRows[0]["github_access_token"].as<std::string>());
            }
        } catch (const std::exception& e) {
            spdlog::warn("Unable to load connected GitHub token for branch listing: {}", e.what());
        }
    }

    auto client = drogon::HttpClient::newHttpClient("https://api.github.com");
    auto branches = std::make_shared<Json::Value>(Json::arrayValue);
    auto completed = std::make_shared<bool>(false);
    auto page = std::make_shared<int>(1);
    auto fetchPage = std::make_shared<std::function<void()>>();

    auto makeBranchRequest = [fullName, pat](int currentPage) {
        auto gitReq = drogon::HttpRequest::newHttpRequest();
        gitReq->setMethod(drogon::Get);
        gitReq->setPath(
            "/repos/" + fullName + "/branches?per_page=100&page=" + std::to_string(currentPage)
        );
        if (!pat.empty()) {
            gitReq->addHeader("Authorization", "Bearer " + pat);
        }
        gitReq->addHeader("User-Agent", "stackpilot-Platform");
        gitReq->addHeader("Accept", "application/vnd.github+json");
        gitReq->addHeader("X-GitHub-Api-Version", "2022-11-28");
        return gitReq;
    };

    auto sendError = [callback, completed, fullName](drogon::HttpStatusCode status,
                                                     const std::string& message,
                                                     const Json::Value& payload = Json::Value()) {
        if (*completed) {
            return;
        }
        *completed = true;
        Json::Value err;
        err["error"] = message;
        if (payload.isObject() && payload.isMember("message")) {
            err["details"] = payload["message"].asString();
        }
        if (payload.isObject() && payload.isMember("documentation_url")) {
            err["documentation_url"] = payload["documentation_url"].asString();
        }
        err["repository"] = fullName;
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(status);
        callback(resp);
    };

    auto sendFinal = [callback, completed, fullName, branches]() {
        if (*completed) {
            return;
        }
        *completed = true;
        Json::Value body(Json::objectValue);
        body["repository"] = fullName;
        body["branches"] = *branches;
        body["count"] = static_cast<Json::UInt64>(branches->size());
        callback(drogon::HttpResponse::newHttpJsonResponse(body));
    };

    *fetchPage = [client, makeBranchRequest, branches, page, fetchPage, sendError, sendFinal]() {
        client->sendRequest(
            makeBranchRequest(*page),
            [branches, page, fetchPage, sendError, sendFinal](
                drogon::ReqResult result,
                const drogon::HttpResponsePtr& response
            ) {
                if (result != drogon::ReqResult::Ok || !response) {
                    sendError(drogon::k502BadGateway, "Failed to connect to GitHub while listing branches");
                    return;
                }

                Json::Value payload;
                Json::CharReaderBuilder builder;
                builder["collectComments"] = false;
                std::string errors;
                std::istringstream bodyStream(std::string(response->getBody()));
                Json::parseFromStream(builder, bodyStream, &payload, &errors);

                if (response->getStatusCode() != drogon::k200OK || !payload.isArray()) {
                    sendError(
                        response->getStatusCode() == drogon::k404NotFound ? drogon::k404NotFound : drogon::k400BadRequest,
                        "GitHub rejected branch listing",
                        payload
                    );
                    return;
                }

                for (const auto& branch : payload) {
                    const std::string name = branch.isMember("name") ? branch["name"].asString() : "";
                    if (name.empty()) {
                        continue;
                    }
                    Json::Value item(Json::objectValue);
                    item["name"] = name;
                    item["protected"] = branch.isMember("protected") && branch["protected"].asBool();
                    if (branch.isMember("commit") && branch["commit"].isObject()) {
                        item["commit_sha"] = branch["commit"].get("sha", "").asString();
                    }
                    branches->append(item);
                }

                if (payload.size() == 100u) {
                    ++(*page);
                    (*fetchPage)();
                    return;
                }

                sendFinal();
            }
        );
    };

    (*fetchPage)();
}

} // namespace stackpilot
