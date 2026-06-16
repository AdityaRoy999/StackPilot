// ============================================================
// JobQueueService.cpp - Redis-backed durable build queue
// ============================================================

#include "JobQueueService.h"

#include "../controllers/LogWebSocketController.h"
#include "../db/Database.h"
#include "../utils/TokenCrypto.h"
#include "ApplicationCatalog.h"
#include "BuildService.h"
#include "DeploymentCleanupService.h"
#include "KubernetesService.h"
#include "SshService.h"

#include <algorithm>
#include <chrono>
#include <cctype>
#include <cstdlib>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <pqxx/pqxx>
#include <sstream>
#include <spdlog/spdlog.h>
#include <stdexcept>
#include <unordered_map>
#ifndef _WIN32
#include <sys/wait.h>
#include <unistd.h>
#else
#include <process.h>
#endif

namespace stackpilot {
namespace {

std::mutex deploymentLogMutex;

std::string getEnvOrDefault(const char* name, const std::string& fallback) {
    const char* value = std::getenv(name);
    return (value && *value) ? value : fallback;
}

int getEnvIntOrDefault(const char* name, int fallback) {
    const char* value = std::getenv(name);
    if (!value || !*value) return fallback;
    try {
        return std::stoi(value);
    } catch (...) {
        return fallback;
    }
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
        const auto pos = toLower(value).find(marker);
        if (pos != std::string::npos) {
            value = value.substr(pos + marker.size());
        }
    }
    while (!value.empty() && value.front() == '/') value.erase(value.begin());
    const auto queryPos = value.find_first_of("?#");
    if (queryPos != std::string::npos) value = value.substr(0, queryPos);
    if (value.size() > 4 && value.substr(value.size() - 4) == ".git") value.resize(value.size() - 4);
    while (!value.empty() && value.back() == '/') value.pop_back();
    const auto slash = value.find('/');
    if (slash == std::string::npos || slash == 0 || slash == value.size() - 1) return "";
    if (value.find('/', slash + 1) != std::string::npos) {
        value = value.substr(0, value.find('/', slash + 1));
    }
    return value;
}

std::string normalizeRuntimeScheme(const std::string& value) {
    return toLower(trim(value)) == "https" ? "https" : "http";
}

std::string normalizeRemoteK8sExposure(const std::string& value) {
    const std::string cleaned = toLower(trim(value));
    if (cleaned == "ingress" || cleaned == "loadbalancer" || cleaned == "clusterip") {
        return cleaned;
    }
    return "nodeport";
}

std::string compactJson(const Json::Value& value) {
    Json::StreamWriterBuilder builder;
    builder["indentation"] = "";
    return Json::writeString(builder, value.isNull() ? Json::Value(Json::objectValue) : value);
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

bool shouldSkipDeploymentJob(const std::string& status) {
    return status == "superseded" || status == "canceled" || status == "cancelled" ||
           status == "failed_ci" || status == "retired";
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
    Json::Value snapshot(Json::objectValue);
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
                            const std::string& resourcePreset,
                            const std::string& healthPath,
                            const std::string& runtimeScheme) {
    const std::string scheme = normalizeRuntimeScheme(runtimeScheme);
    Json::Value snapshot(Json::objectValue);
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
        "compose",
        "/",
        runtimeScheme
    );
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
                                             int containerPort = 3000,
                                             const std::string& resourcePreset = "small",
                                             const std::string& healthPath = "/") {
    Json::Value snapshot = runtimeSnapshot(
        provider,
        buildResult.imageName,
        runtime.runtimeUrl,
        runtime.exposureMode,
        runtime.desiredReplicas,
        containerPort,
        resourcePreset,
        healthPath,
        runtime.runtimeScheme.empty() ? runtimeScheme : runtime.runtimeScheme
    );
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

std::string runCommandCapture(const std::string& command) {
    std::string output;
#ifdef _WIN32
    FILE* pipe = _popen(command.c_str(), "r");
#else
    FILE* pipe = popen(command.c_str(), "r");
#endif
    if (!pipe) {
        return output;
    }

    char buffer[512];
    while (fgets(buffer, sizeof(buffer), pipe)) {
        output += buffer;
    }
#ifdef _WIN32
    _pclose(pipe);
#else
    pclose(pipe);
#endif
    return output;
}

int runCommandCaptureExit(const std::string& command, std::string& output) {
    output.clear();
#ifdef _WIN32
    FILE* pipe = _popen(command.c_str(), "r");
#else
    FILE* pipe = popen(command.c_str(), "r");
#endif
    if (!pipe) {
        output = "Failed to start local command";
        return 1;
    }

    char buffer[4096];
    while (fgets(buffer, sizeof(buffer), pipe) != nullptr) {
        output += buffer;
    }
#ifdef _WIN32
    return _pclose(pipe);
#else
    const int status = pclose(pipe);
    if (WIFEXITED(status)) {
        return WEXITSTATUS(status);
    }
    if (WIFSIGNALED(status)) {
        return 128 + WTERMSIG(status);
    }
    return status;
#endif
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

std::string logTailFromLocalDockerOutput(const std::string& output) {
    const std::string marker = "__STACKPILOT_LOCAL_LOG_TAIL__";
    const auto pos = output.find(marker);
    if (pos == std::string::npos) {
        return "";
    }
    return trim(output.substr(pos + marker.size()));
}

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
                                      const std::vector<BuildEnvVar>& envVars) {
    std::string envArgs;
    for (const auto& envVar : envVars) {
        if (!isValidRuntimeEnvKey(envVar.key)) {
            continue;
        }
        std::string value = envVar.value;
        std::replace(value.begin(), value.end(), '\n', ' ');
        envArgs += " --env " + shellQuote(envVar.key + "=" + value);
    }

    const std::string container = shellQuote(containerName);
    const std::string image = shellQuote(imageName);
    const std::string requestedPort = std::to_string(std::clamp(containerPort, 0, 65535));
    return
        "set -e; "
        "command -v docker >/dev/null 2>&1 || { echo __STACKPILOT_DOCKER_MISSING__; exit 10; }; "
        "docker info >/dev/null 2>&1 || { echo __STACKPILOT_DOCKER_DAEMON_DOWN__; exit 11; }; "
        "docker image inspect " + image + " >/dev/null 2>&1 || { echo __STACKPILOT_IMAGE_MISSING__; exit 12; }; "
        "requested_port=" + requestedPort + "; "
        "if [ \"$requested_port\" -gt 0 ]; then "
        "container_port=\"$requested_port\"; "
        "else "
        "container_port=$(docker image inspect --format '{{range $p, $_ := .Config.ExposedPorts}}{{println $p}}{{end}}' " + image + " 2>/dev/null | sed -n 's#/tcp$##p' | head -n 1); "
        "[ -n \"$container_port\" ] || container_port=3000; "
        "fi; "
        "docker rm -f " + container + " >/dev/null 2>&1 || true; "
        "docker run -d --restart unless-stopped --name " + container + envArgs +
        " -p 127.0.0.1::$container_port " + image + " >/tmp/stackpilot-local-container-id; "
        "host_port=$(docker port " + container + " $container_port/tcp 2>/dev/null | awk -F: 'NF {print $NF; exit}'); "
        "[ -n \"$host_port\" ] || { echo __STACKPILOT_PORT_MISSING__; docker logs --tail 80 " + container + " || true; exit 13; }; "
        "status=$(docker inspect --format '{{.State.Status}}' " + container + "); "
        "running=$(docker inspect --format '{{.State.Running}}' " + container + "); "
        "echo __STACKPILOT_LOCAL_DOCKER_RUNNING__; "
        "echo container_name=" + containerName + "; "
        "echo container_port=$container_port; "
        "echo host_port=$host_port; "
        "echo runtime_url=http://localhost:$host_port; "
        "echo status=$status; "
        "echo running=$running; "
        "echo image=" + imageName + "; "
        "echo __STACKPILOT_LOCAL_LOG_TAIL__; "
        "docker logs --tail 80 " + container + " 2>&1 || true";
}

struct GitHubCheckProbe {
    bool queried = false;
    bool hasChecks = false;
    bool pending = false;
    bool passed = false;
    bool failed = false;
    std::string detail;
};

std::string jsonEscapeForCurlConfig(const std::string& value) {
    std::string out;
    for (char c : value) {
        if (c == '\\' || c == '"') {
            out.push_back('\\');
        }
        out.push_back(c);
    }
    return out;
}

GitHubCheckProbe queryGitHubCheckRuns(const std::string& repoUrl,
                                      const std::string& commitSha,
                                      const std::string& token) {
    GitHubCheckProbe probe;
    const std::string fullName = githubFullNameFromUrl(repoUrl);
    if (fullName.empty() || commitSha.empty()) {
        probe.detail = "Repository or commit could not be parsed for GitHub check lookup.";
        return probe;
    }

    const auto configPath = std::filesystem::temp_directory_path() /
        ("stackpilot-github-checks-" + std::to_string(std::rand()) + ".curl");
    {
        std::ofstream cfg(configPath, std::ios::trunc);
        if (!cfg.is_open()) {
            probe.detail = "Unable to create temporary GitHub check query config.";
            return probe;
        }
        cfg << "silent\n";
        cfg << "show-error\n";
        cfg << "fail\n";
        cfg << "location\n";
        cfg << "url = \"https://api.github.com/repos/" << jsonEscapeForCurlConfig(fullName)
            << "/commits/" << jsonEscapeForCurlConfig(commitSha) << "/check-runs?per_page=100\"\n";
        cfg << "header = \"Accept: application/vnd.github+json\"\n";
        cfg << "header = \"X-GitHub-Api-Version: 2022-11-28\"\n";
        cfg << "header = \"User-Agent: stackpilot-Platform\"\n";
        if (!token.empty()) {
            cfg << "header = \"Authorization: Bearer " << jsonEscapeForCurlConfig(token) << "\"\n";
        }
    }
    std::error_code permissionError;
    std::filesystem::permissions(
        configPath,
        std::filesystem::perms::owner_read | std::filesystem::perms::owner_write,
        std::filesystem::perm_options::replace,
        permissionError
    );

    const std::string output = runCommandCapture("curl --config " + shellQuote(configPath.string()) + " 2>/dev/null");
    std::filesystem::remove(configPath);
    if (output.empty()) {
        probe.detail = "GitHub check lookup returned no response.";
        return probe;
    }

    Json::Value payload;
    Json::CharReaderBuilder builder;
    builder["collectComments"] = false;
    std::string errors;
    std::istringstream stream(output);
    if (!Json::parseFromStream(builder, stream, &payload, &errors) || !payload.isObject()) {
        probe.detail = "GitHub check lookup returned an invalid payload.";
        return probe;
    }

    probe.queried = true;
    const int totalCount = payload.get("total_count", 0).asInt();
    const Json::Value runs = payload["check_runs"];
    if (totalCount <= 0 || !runs.isArray() || runs.empty()) {
        probe.hasChecks = false;
        probe.passed = true;
        probe.detail = "No GitHub check runs exist for this commit.";
        return probe;
    }

    probe.hasChecks = true;
    bool anyPending = false;
    bool anyFailed = false;
    for (const auto& run : runs) {
        const std::string status = toLower(run.get("status", "").asString());
        const std::string conclusion = toLower(run.get("conclusion", "").asString());
        if (status != "completed") {
            anyPending = true;
            continue;
        }
        if (!(conclusion == "success" || conclusion == "skipped" || conclusion == "neutral")) {
            anyFailed = true;
        }
    }
    probe.pending = anyPending;
    probe.failed = anyFailed;
    probe.passed = !anyPending && !anyFailed;
    probe.detail = probe.passed ? "GitHub check runs passed." :
        (probe.failed ? "One or more GitHub check runs failed." : "GitHub check runs are still pending.");
    return probe;
}

void appendDeploymentLog(const std::string& deploymentId, const std::string& line) {
    std::lock_guard<std::mutex> lock(deploymentLogMutex);
    try {
        auto conn = Database::getInstance().getConnection();
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
        spdlog::error("Failed to append queued build log for {}: {}", deploymentId, e.what());
    }
}

Json::Value extractPortAdjustments(const std::string& logs) {
    Json::Value adjustments(Json::arrayValue);
    const std::string marker = "__STACKPILOT_PORT_ADJUSTED__=";
    std::size_t offset = 0;
    while ((offset = logs.find(marker, offset)) != std::string::npos) {
        const std::size_t payloadStart = offset + marker.size();
        const std::size_t lineEnd = logs.find('\n', payloadStart);
        const std::string payload = trim(logs.substr(payloadStart, lineEnd == std::string::npos ? std::string::npos : lineEnd - payloadStart));
        const std::size_t firstColon = payload.find(':');
        const std::size_t secondColon = firstColon == std::string::npos ? std::string::npos : payload.find(':', firstColon + 1);
        if (firstColon != std::string::npos && secondColon != std::string::npos) {
            Json::Value item;
            item["key"] = payload.substr(0, firstColon);
            item["from"] = payload.substr(firstColon + 1, secondColon - firstColon - 1);
            item["to"] = payload.substr(secondColon + 1);
            adjustments.append(item);
        }
        offset = lineEnd == std::string::npos ? logs.size() : lineEnd + 1;
    }
    return adjustments;
}

Json::Value loadDeploymentSummary(const std::string& deploymentId) {
    auto conn = Database::getInstance().getConnection();
    pqxx::work txn(*conn);
    auto rows = txn.exec_params(
        "SELECT d.id, d.project_id, p.name AS project_name, p.repo_url, d.status, d.version, d.commit_hash, "
        "d.environment_id, e.name AS environment_name, d.branch, d.commit_sha, d.trigger_source, d.github_delivery_id, "
        "d.ci_required, d.ci_status, d.logs, d.image_name, "
        "d.k8s_namespace, d.k8s_deployment_name, d.k8s_service_name, d.k8s_ingress_name, "
        "d.desired_replicas, d.runtime_url, d.runtime_exposure, d.runtime_provider, d.remote_container_name, d.created_at "
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
    dep["port_adjustments"] = row["logs"].is_null() ? Json::Value(Json::arrayValue) : extractPortAdjustments(row["logs"].as<std::string>());
    dep["image_name"] = row["image_name"].is_null() ? "" : row["image_name"].as<std::string>();
    dep["k8s_namespace"] = row["k8s_namespace"].is_null() ? "" : row["k8s_namespace"].as<std::string>();
    dep["k8s_deployment_name"] = row["k8s_deployment_name"].is_null() ? "" : row["k8s_deployment_name"].as<std::string>();
    dep["k8s_service_name"] = row["k8s_service_name"].is_null() ? "" : row["k8s_service_name"].as<std::string>();
    dep["k8s_ingress_name"] = row["k8s_ingress_name"].is_null() ? "" : row["k8s_ingress_name"].as<std::string>();
    dep["desired_replicas"] = row["desired_replicas"].is_null() ? 1 : row["desired_replicas"].as<int>();
    dep["runtime_url"] = row["runtime_url"].is_null() ? "" : row["runtime_url"].as<std::string>();
    dep["runtime_exposure"] = row["runtime_exposure"].is_null() ? "" : row["runtime_exposure"].as<std::string>();
    dep["runtime_provider"] = row["runtime_provider"].is_null() ? "" : row["runtime_provider"].as<std::string>();
    dep["remote_container_name"] = row["remote_container_name"].is_null() ? "" : row["remote_container_name"].as<std::string>();
    dep["created_at"] = row["created_at"].as<std::string>();
    return dep;
}

void broadcastDeploymentSummary(const std::string& deploymentId) {
    Json::Value summary = loadDeploymentSummary(deploymentId);
    if (!summary.isNull()) {
        LogWebSocketController::broadcastDeploymentUpdate(summary);
    }
}

SshConnectionConfig rowToSshConfig(const pqxx::row& row,
                                   const std::string& prefix,
                                   const std::string& fallbackConnectionType = "ssh") {
    SshConnectionConfig config;
    config.connectionType = row[prefix + "connection_type"].is_null()
        ? fallbackConnectionType
        : row[prefix + "connection_type"].as<std::string>();
    config.host = row[prefix + "host"].is_null() ? "" : row[prefix + "host"].as<std::string>();
    config.port = row[prefix + "port"].is_null() ? 22 : row[prefix + "port"].as<int>();
    config.username = row[prefix + "username"].is_null() ? "" : row[prefix + "username"].as<std::string>();
    config.authType = row[prefix + "auth_type"].is_null() ? "" : row[prefix + "auth_type"].as<std::string>();
    config.password = row[prefix + "password_encrypted"].is_null()
        ? ""
        : TokenCrypto::decrypt(row[prefix + "password_encrypted"].as<std::string>());
    config.privateKey = row[prefix + "private_key_encrypted"].is_null()
        ? ""
        : TokenCrypto::decrypt(row[prefix + "private_key_encrypted"].as<std::string>());
    config.knownHostsEntry = row[prefix + "known_hosts_entry"].is_null()
        ? ""
        : row[prefix + "known_hosts_entry"].as<std::string>();
    return config;
}

} // namespace

JobQueueService& JobQueueService::getInstance() {
    static JobQueueService instance;
    return instance;
}

JobQueueService::JobQueueService()
    : workerId_(getEnvOrDefault("HOSTNAME", "stackpilot-backend") + "-" + std::to_string(::getpid())),
      redisHost_(getEnvOrDefault("REDIS_HOST", "redis")),
      redisPort_(getEnvIntOrDefault("REDIS_PORT", 6379)),
      redisPassword_(getEnvOrDefault("REDIS_PASSWORD", "")),
      queueName_(getEnvOrDefault("STACKPILOT_REDIS_QUEUE", "stackpilot:jobs:deployment")),
      workerCount_(std::max(1, getEnvIntOrDefault("STACKPILOT_JOB_WORKERS", 2))),
      maxAttempts_(std::clamp(getEnvIntOrDefault("STACKPILOT_JOB_MAX_ATTEMPTS", 3), 1, 10)) {}

JobQueueService::~JobQueueService() {
    stop();
}

void JobQueueService::start() {
    std::lock_guard<std::mutex> lock(lifecycleMutex_);
    if (running_) {
        return;
    }

    recoverInterruptedJobs();
    running_ = true;
    for (int i = 0; i < workerCount_; ++i) {
        workers_.emplace_back([this, i]() { workerLoop(i); });
    }
    spdlog::info("Started {} deployment job worker(s)", workerCount_);
}

void JobQueueService::stop() {
    {
        std::lock_guard<std::mutex> lock(lifecycleMutex_);
        if (!running_) {
            return;
        }
        running_ = false;
    }
    for (auto& worker : workers_) {
        if (worker.joinable()) {
            worker.join();
        }
    }
    workers_.clear();
}

Json::Value JobQueueService::enqueueDeploymentBuild(const std::string& deploymentId,
                                                    const std::string& userId,
                                                    const std::string& queuedLog) {
    auto conn = Database::getInstance().getConnection();
    pqxx::work txn(*conn);

    auto jobRows = txn.exec_params(
        "INSERT INTO deployment_jobs (deployment_id, user_id, type, status, max_attempts) "
        "VALUES ($1, $2, 'deployment_build', 'queued', $3) "
        "RETURNING id, status, attempts, max_attempts, created_at",
        deploymentId,
        userId,
        maxAttempts_
    );

    const std::string jobId = jobRows[0]["id"].as<std::string>();
    txn.exec_params(
        "UPDATE deployments "
        "SET status = 'queued', logs = $1 || E'\\n', job_id = $2, artifact_available = FALSE, updated_at = NOW() "
        "WHERE id = $3",
        queuedLog,
        jobId,
        deploymentId
    );
    txn.commit();

    pushRedisJob(jobId);
    LogWebSocketController::broadcastStatus(deploymentId, "queued");
    broadcastDeploymentSummary(deploymentId);
    LogWebSocketController::broadcastLog(deploymentId, queuedLog);

    Json::Value job;
    job["id"] = jobId;
    job["deployment_id"] = deploymentId;
    job["status"] = jobRows[0]["status"].as<std::string>();
    job["attempts"] = jobRows[0]["attempts"].as<int>();
    job["max_attempts"] = jobRows[0]["max_attempts"].as<int>();
    job["created_at"] = jobRows[0]["created_at"].as<std::string>();
    return job;
}

void JobQueueService::recoverInterruptedJobs() {
    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);
        txn.exec(
            "UPDATE deployment_jobs "
            "SET status = 'queued', locked_by = '', locked_at = NULL, next_run_at = NOW(), updated_at = NOW() "
            "WHERE status = 'running'"
        );
        txn.exec(
            "UPDATE deployments "
            "SET status = 'queued', "
            "logs = COALESCE(NULLIF(logs, ''), 'Deployment recovered from interrupted worker.') "
            "       || E'\\nDeployment re-queued after backend restart.\\n', "
            "updated_at = NOW() "
            "WHERE status = 'building' AND job_id IS NOT NULL"
        );
        txn.commit();
    } catch (const std::exception& e) {
        spdlog::warn("Deployment job recovery skipped: {}", e.what());
    }
}

bool JobQueueService::pushRedisJob(const std::string& jobId) const {
    std::string command = "redis-cli -h " + shellQuote(redisHost_) +
        " -p " + std::to_string(redisPort_);
    if (!redisPassword_.empty()) {
        command += " -a " + shellQuote(redisPassword_) + " --no-auth-warning";
    }
    command += " RPUSH " + shellQuote(queueName_) + " " + shellQuote(jobId) + " >/dev/null 2>&1";
    return std::system(command.c_str()) == 0;
}

std::optional<std::string> JobQueueService::popRedisJob(int timeoutSeconds) const {
    std::string command = "timeout " + std::to_string(timeoutSeconds + 2) +
        " redis-cli -h " + shellQuote(redisHost_) + " -p " + std::to_string(redisPort_);
    if (!redisPassword_.empty()) {
        command += " -a " + shellQuote(redisPassword_) + " --no-auth-warning";
    }
    command += " --raw BLPOP " + shellQuote(queueName_) + " " + std::to_string(timeoutSeconds) + " 2>/dev/null";

    const std::string output = runCommandCapture(command);
    std::istringstream stream(output);
    std::string line;
    std::string last;
    while (std::getline(stream, line)) {
        line = trim(line);
        if (!line.empty()) {
            last = line;
        }
    }
    if (last.empty() || last == queueName_) {
        return std::nullopt;
    }
    return last;
}

std::optional<JobQueueService::DeploymentJobRecord> JobQueueService::claimJob(const std::string& preferredJobId) {
    if (preferredJobId.empty()) {
        return claimNextDbJob();
    }

    auto conn = Database::getInstance().getConnection();
    pqxx::work txn(*conn);
    auto rows = txn.exec_params(
        "UPDATE deployment_jobs "
        "SET status = 'running', attempts = attempts + 1, locked_by = $2, locked_at = NOW(), "
        "started_at = COALESCE(started_at, NOW()), updated_at = NOW() "
        "WHERE id = $1 AND status IN ('queued', 'retrying') AND next_run_at <= NOW() "
        "RETURNING id, deployment_id, user_id, attempts, max_attempts",
        preferredJobId,
        workerId_
    );
    txn.commit();

    if (rows.empty()) {
        return std::nullopt;
    }

    return DeploymentJobRecord{
        rows[0]["id"].as<std::string>(),
        rows[0]["deployment_id"].as<std::string>(),
        rows[0]["user_id"].as<std::string>(),
        rows[0]["attempts"].as<int>(),
        rows[0]["max_attempts"].as<int>()
    };
}

std::optional<JobQueueService::DeploymentJobRecord> JobQueueService::claimNextDbJob() {
    auto conn = Database::getInstance().getConnection();
    pqxx::work txn(*conn);
    auto rows = txn.exec(
        "WITH candidate AS ("
        "  SELECT id FROM deployment_jobs "
        "  WHERE status IN ('queued', 'retrying') AND next_run_at <= NOW() "
        "  ORDER BY priority ASC, created_at ASC "
        "  FOR UPDATE SKIP LOCKED LIMIT 1"
        ") "
        "UPDATE deployment_jobs j "
        "SET status = 'running', attempts = attempts + 1, locked_by = " + txn.quote(workerId_) + ", "
        "locked_at = NOW(), started_at = COALESCE(started_at, NOW()), updated_at = NOW() "
        "FROM candidate WHERE j.id = candidate.id "
        "RETURNING j.id, j.deployment_id, j.user_id, j.attempts, j.max_attempts"
    );
    txn.commit();

    if (rows.empty()) {
        return std::nullopt;
    }

    return DeploymentJobRecord{
        rows[0]["id"].as<std::string>(),
        rows[0]["deployment_id"].as<std::string>(),
        rows[0]["user_id"].as<std::string>(),
        rows[0]["attempts"].as<int>(),
        rows[0]["max_attempts"].as<int>()
    };
}

void JobQueueService::workerLoop(int workerIndex) {
    spdlog::info("Deployment job worker {} online", workerIndex);
    while (running_) {
        try {
            std::optional<std::string> redisJobId = popRedisJob(5);
            auto job = redisJobId ? claimJob(*redisJobId) : claimNextDbJob();
            if (!job) {
                continue;
            }
            executeDeploymentBuildJob(*job);
        } catch (const std::exception& e) {
            spdlog::error("Deployment job worker {} loop error: {}", workerIndex, e.what());
            std::this_thread::sleep_for(std::chrono::seconds(2));
        }
    }
}

void JobQueueService::completeJob(const DeploymentJobRecord& job) {
    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);
        txn.exec_params(
            "UPDATE deployment_jobs "
            "SET status = 'completed', completed_at = NOW(), locked_by = '', locked_at = NULL, updated_at = NOW() "
            "WHERE id = $1",
            job.id
        );
        txn.commit();
    } catch (const std::exception& e) {
        spdlog::warn("Failed to mark deployment job {} completed: {}", job.id, e.what());
    }
}

void JobQueueService::failJob(const DeploymentJobRecord& job, const std::string& error, bool retryable) {
    const bool shouldRetry = retryable && job.attempts < job.maxAttempts;
    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);
        if (shouldRetry) {
            const int delaySeconds = std::min(300, 10 * job.attempts * job.attempts);
            txn.exec_params(
                "UPDATE deployment_jobs "
                "SET status = 'retrying', last_error = $2, locked_by = '', locked_at = NULL, "
                "next_run_at = NOW() + ($3::text || ' seconds')::interval, updated_at = NOW() "
                "WHERE id = $1",
                job.id,
                error,
                delaySeconds
            );
            txn.exec_params(
                "UPDATE deployments "
                "SET status = 'queued', logs = COALESCE(logs, '') || $2 || E'\\n', updated_at = NOW() "
                "WHERE id = $1",
                job.deploymentId,
                "Worker error, retrying in " + std::to_string(delaySeconds) + " seconds: " + error
            );
            txn.commit();
            pushRedisJob(job.id);
            LogWebSocketController::broadcastStatus(job.deploymentId, "queued");
            broadcastDeploymentSummary(job.deploymentId);
            return;
        }

        txn.exec_params(
            "UPDATE deployment_jobs "
            "SET status = 'failed', last_error = $2, completed_at = NOW(), locked_by = '', locked_at = NULL, updated_at = NOW() "
            "WHERE id = $1",
            job.id,
            error
        );
        txn.commit();
    } catch (const std::exception& e) {
        spdlog::warn("Failed to mark deployment job {} failed: {}", job.id, e.what());
    }
}

void JobQueueService::executeDeploymentBuildJob(const DeploymentJobRecord& job) {
    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);
        auto deploymentRows = txn.exec_params(
            "SELECT d.id, d.version, d.status, d.environment_id, d.source_artifact_id, d.branch, d.commit_sha, "
            "d.trigger_source, d.ci_required, d.ci_status, d.created_at AS deployment_created_at, "
            "EXTRACT(EPOCH FROM (NOW() - d.created_at))::int AS deployment_age_seconds, "
            "e.cleanup_previous_on_success, e.current_deployment_id AS previous_current_deployment_id, "
            "sa.storage_path AS artifact_storage_path, "
            "p.name AS project_name, p.repo_url, p.github_pat, p.source_type, p.ssh_connection_id, p.source_path, "
            "p.application_template_id, p.application_config::text AS application_config, "
            "COALESCE(e.execution_mode, p.execution_mode) AS execution_mode, "
            "COALESCE(e.remote_runtime_type, p.remote_runtime_type) AS remote_runtime_type, "
            "COALESCE(e.remote_k8s_exposure, p.remote_k8s_exposure) AS remote_k8s_exposure, "
            "COALESCE(e.remote_connection_id, p.remote_connection_id) AS remote_connection_id, "
            "COALESCE(e.runtime_scheme, p.runtime_scheme) AS runtime_scheme, p.local_https_enabled, "
            "u.github_access_token, COALESCE(s.connection_type, 'ssh') AS connection_type, s.host, s.port, s.username, s.auth_type, "
            "s.password_encrypted, s.private_key_encrypted, s.known_hosts_entry, "
            "COALESCE(rs.connection_type, 'ssh') AS remote_connection_type, rs.host AS remote_host, rs.port AS remote_port, rs.username AS remote_username, "
            "rs.auth_type AS remote_auth_type, rs.password_encrypted AS remote_password_encrypted, rs.private_key_encrypted AS remote_private_key_encrypted, "
            "rs.known_hosts_entry AS remote_known_hosts_entry "
            "FROM deployments d "
            "JOIN projects p ON d.project_id = p.id "
            "JOIN users u ON p.user_id = u.id "
            "LEFT JOIN project_environments e ON d.environment_id = e.id AND e.project_id = p.id "
            "LEFT JOIN source_artifacts sa ON d.source_artifact_id = sa.id AND sa.user_id = p.user_id "
            "LEFT JOIN ssh_connections s ON p.ssh_connection_id = s.id "
            "LEFT JOIN ssh_connections rs ON COALESCE(e.remote_connection_id, p.remote_connection_id) = rs.id "
            "WHERE d.id = $1 AND p.user_id = $2",
            job.deploymentId,
            job.userId
        );

        if (deploymentRows.empty()) {
            txn.commit();
            failJob(job, "Deployment no longer exists", false);
            return;
        }

        const auto& row = deploymentRows[0];
        const std::string deploymentStatus = row["status"].as<std::string>();
        const std::string environmentId = row["environment_id"].is_null() ? "" : row["environment_id"].as<std::string>();
        const bool ciRequired = row["ci_required"].is_null() ? false : row["ci_required"].as<bool>();
        const std::string ciStatus = row["ci_status"].is_null() ? "not_required" : row["ci_status"].as<std::string>();
        const std::string triggerSource = row["trigger_source"].is_null() ? "manual" : row["trigger_source"].as<std::string>();
        const int deploymentAgeSeconds = row["deployment_age_seconds"].is_null() ? 0 : row["deployment_age_seconds"].as<int>();
        const bool cleanupPreviousOnSuccess =
            row["cleanup_previous_on_success"].is_null() ? false : row["cleanup_previous_on_success"].as<bool>();
        const std::string previousCurrentDeploymentId =
            row["previous_current_deployment_id"].is_null() ? "" : row["previous_current_deployment_id"].as<std::string>();
        const std::string repoUrlForCi = row["repo_url"].is_null() ? "" : row["repo_url"].as<std::string>();
        const std::string commitShaForCi = row["commit_sha"].is_null() ? "" : row["commit_sha"].as<std::string>();
        const std::string sourceTypeForCi = row["source_type"].is_null() ? "github" : row["source_type"].as<std::string>();
        const std::string projectTokenForCi = row["github_pat"].is_null() ? "" : TokenCrypto::decrypt(row["github_pat"].as<std::string>());
        const std::string linkedGitHubTokenForCi = row["github_access_token"].is_null() ? "" : TokenCrypto::decrypt(row["github_access_token"].as<std::string>());
        const std::string githubTokenForCi = !projectTokenForCi.empty() ? projectTokenForCi : linkedGitHubTokenForCi;
        if (shouldSkipDeploymentJob(deploymentStatus)) {
            txn.commit();
            appendDeploymentLog(job.deploymentId, "Deployment job skipped because this deployment is " + deploymentStatus + ".");
            completeJob(job);
            broadcastDeploymentSummary(job.deploymentId);
            return;
        }
        if (ciRequired && ciStatus == "pending" &&
            (triggerSource != "github_push" || sourceTypeForCi != "github" || repoUrlForCi.empty() || commitShaForCi.empty())) {
            txn.exec_params(
                "UPDATE deployments "
                "SET ci_status = 'not_required', "
                "ci_details = ci_details || '{\"ci_bypassed_for_non_github_push\":true}'::jsonb, "
                "logs = COALESCE(logs, '') || E'CI gate skipped because this deployment was not triggered by a GitHub push with a commit SHA.\\n', "
                "updated_at = NOW() "
                "WHERE id = $1",
                job.deploymentId
            );
        }
        if (ciRequired && ciStatus == "pending" &&
            triggerSource == "github_push" && sourceTypeForCi == "github" && !repoUrlForCi.empty() && !commitShaForCi.empty()) {
            const int graceSeconds = std::max(15, getEnvIntOrDefault("STACKPILOT_CI_NO_CHECKS_GRACE_SECONDS", 90));
            if (triggerSource == "github_push" && deploymentAgeSeconds >= graceSeconds) {
                const auto probe = queryGitHubCheckRuns(repoUrlForCi, commitShaForCi, githubTokenForCi);
                if (!probe.queried) {
                    txn.exec_params(
                        "UPDATE deployments "
                        "SET status = 'blocked', logs = COALESCE(logs, '') || $2 || E' Build remains blocked because CI is required.\\n', updated_at = NOW() "
                        "WHERE id = $1",
                        job.deploymentId,
                        probe.detail.empty() ? "GitHub check lookup did not complete." : probe.detail
                    );
                    txn.exec_params(
                        "UPDATE deployment_jobs "
                        "SET status = 'retrying', last_error = 'Unable to verify GitHub checks', locked_by = '', locked_at = NULL, "
                        "next_run_at = NOW() + interval '60 seconds', updated_at = NOW() "
                        "WHERE id = $1",
                        job.id
                    );
                    txn.commit();
                    LogWebSocketController::broadcastStatus(job.deploymentId, "blocked");
                    broadcastDeploymentSummary(job.deploymentId);
                    return;
                }
                if (probe.hasChecks) {
                    if (probe.failed) {
                        txn.exec_params(
                            "UPDATE deployments "
                            "SET ci_status = 'failed', status = 'failed_ci', "
                            "ci_details = ci_details || '{\"checks_api\":\"failed\"}'::jsonb, "
                            "logs = COALESCE(logs, '') || $2 || E'\\n', updated_at = NOW() "
                            "WHERE id = $1",
                            job.deploymentId,
                            probe.detail
                        );
                        txn.commit();
                        failJob(job, "GitHub checks failed", false);
                        LogWebSocketController::broadcastStatus(job.deploymentId, "failed_ci");
                        broadcastDeploymentSummary(job.deploymentId);
                        return;
                    }
                    if (probe.pending) {
                        txn.exec_params(
                            "UPDATE deployments "
                            "SET status = 'blocked', logs = COALESCE(logs, '') || $2 || E'\\n', updated_at = NOW() "
                            "WHERE id = $1",
                            job.deploymentId,
                            probe.detail
                        );
                        txn.exec_params(
                            "UPDATE deployment_jobs "
                            "SET status = 'retrying', last_error = 'Waiting for GitHub checks', locked_by = '', locked_at = NULL, "
                            "next_run_at = NOW() + interval '30 seconds', updated_at = NOW() "
                            "WHERE id = $1",
                            job.id
                        );
                        txn.commit();
                        LogWebSocketController::broadcastStatus(job.deploymentId, "blocked");
                        broadcastDeploymentSummary(job.deploymentId);
                        return;
                    }
                    txn.exec_params(
                        "UPDATE deployments "
                        "SET ci_status = 'passed', status = 'pending', "
                        "ci_details = ci_details || '{\"checks_api\":\"passed\"}'::jsonb, "
                        "logs = COALESCE(logs, '') || E'GitHub checks passed from the Checks API. Deployment continuing.\\n', "
                        "updated_at = NOW() "
                        "WHERE id = $1",
                        job.deploymentId
                    );
                } else {
                    txn.exec_params(
                        "UPDATE deployments "
                        "SET ci_status = 'not_required', ci_details = ci_details || '{\"no_checks_found\":true}'::jsonb, "
                        "logs = COALESCE(logs, '') || E'No GitHub check runs were found for this commit. Continuing because this repository may not define CI workflows.\\n', "
                        "updated_at = NOW() "
                        "WHERE id = $1",
                        job.deploymentId
                    );
                }
            } else {
                const int retryDelay = std::min(30, std::max(5, graceSeconds - deploymentAgeSeconds));
                txn.exec_params(
                    "UPDATE deployments "
                    "SET status = 'blocked', logs = COALESCE(logs, '') || E'GitHub checks are still pending. Build remains blocked until CI passes or no checks are found.\\n', updated_at = NOW() "
                    "WHERE id = $1",
                    job.deploymentId
                );
                txn.exec_params(
                    "UPDATE deployment_jobs "
                    "SET status = 'retrying', last_error = 'Waiting for GitHub checks', locked_by = '', locked_at = NULL, "
                    "next_run_at = NOW() + ($2::text || ' seconds')::interval, updated_at = NOW() "
                    "WHERE id = $1",
                    job.id,
                    retryDelay
                );
                txn.commit();
                LogWebSocketController::broadcastStatus(job.deploymentId, "blocked");
                broadcastDeploymentSummary(job.deploymentId);
                return;
            }
        }
        if (!environmentId.empty()) {
            auto newerRows = txn.exec_params(
                "SELECT id FROM deployments "
                "WHERE environment_id = $1 AND id <> $2 "
                "AND created_at > (SELECT created_at FROM deployments WHERE id = $2) "
                "AND status NOT IN ('failed', 'failed_ci', 'superseded', 'canceled', 'cancelled', 'retired') "
                "ORDER BY created_at DESC LIMIT 1",
                environmentId,
                job.deploymentId
            );
            if (!newerRows.empty()) {
                txn.exec_params(
                    "UPDATE deployments "
                    "SET status = 'superseded', logs = COALESCE(logs, '') || E'Skipped build because a newer commit is already the deployment candidate for this environment.\\n', updated_at = NOW() "
                    "WHERE id = $1",
                    job.deploymentId
                );
                txn.commit();
                completeJob(job);
                LogWebSocketController::broadcastStatus(job.deploymentId, "superseded");
                broadcastDeploymentSummary(job.deploymentId);
                return;
            }
        }

        const std::string version = row["version"].as<std::string>();
        const std::string projectName = row["project_name"].as<std::string>();
        const std::string sourceType = row["source_type"].is_null() ? "github" : row["source_type"].as<std::string>();
        const std::string executionMode = row["execution_mode"].is_null() ? "local" : row["execution_mode"].as<std::string>();
        const std::string remoteRuntimeType = row["remote_runtime_type"].is_null() ? "docker" : row["remote_runtime_type"].as<std::string>();
        const std::string remoteK8sExposure = row["remote_k8s_exposure"].is_null() ? "nodeport" : row["remote_k8s_exposure"].as<std::string>();
        const std::string remoteConnectionId = row["remote_connection_id"].is_null() ? "" : row["remote_connection_id"].as<std::string>();
        const std::string runtimeScheme = normalizeRuntimeScheme(row["runtime_scheme"].is_null() ? "http" : row["runtime_scheme"].as<std::string>());
        const bool localHttpsEnabled = false;
        const std::string repoUrl = row["repo_url"].is_null() ? "" : row["repo_url"].as<std::string>();
        const std::string branch = row["branch"].is_null() ? "" : row["branch"].as<std::string>();
        const std::string commitSha = row["commit_sha"].is_null() ? "" : row["commit_sha"].as<std::string>();
        const std::string sourcePath = row["source_path"].is_null() ? "" : row["source_path"].as<std::string>();
        const std::string applicationTemplateId =
            row["application_template_id"].is_null() ? "" : row["application_template_id"].as<std::string>();
        const Json::Value applicationConfig =
            parseJsonObject(row["application_config"].is_null() ? "" : row["application_config"].as<std::string>());
        const std::string sourceArtifactId = row["source_artifact_id"].is_null() ? "" : row["source_artifact_id"].as<std::string>();
        const std::string artifactStoragePath = row["artifact_storage_path"].is_null() ? "" : row["artifact_storage_path"].as<std::string>();
        const std::string projectToken = row["github_pat"].is_null() ? "" : TokenCrypto::decrypt(row["github_pat"].as<std::string>());
        const std::string linkedGitHubToken = row["github_access_token"].is_null() ? "" : TokenCrypto::decrypt(row["github_access_token"].as<std::string>());
        const std::string githubPat = !projectToken.empty() ? projectToken : linkedGitHubToken;

        std::unordered_map<std::string, std::string> mergedEnvVars;
        auto envRows = txn.exec_params(
            "SELECT key, value_encrypted FROM project_env_vars "
            "WHERE project_id = (SELECT project_id FROM deployments WHERE id = $1) "
            "ORDER BY key ASC",
            job.deploymentId
        );
        for (const auto& envRow : envRows) {
            mergedEnvVars[envRow["key"].as<std::string>()] =
                TokenCrypto::decrypt(envRow["value_encrypted"].as<std::string>());
        }
        if (!environmentId.empty()) {
            auto environmentEnvRows = txn.exec_params(
                "SELECT key, value_encrypted FROM project_environment_env_vars "
                "WHERE environment_id = $1 ORDER BY key ASC",
                environmentId
            );
            for (const auto& envRow : environmentEnvRows) {
                mergedEnvVars[envRow["key"].as<std::string>()] =
                    TokenCrypto::decrypt(envRow["value_encrypted"].as<std::string>());
            }
        }
        std::vector<BuildEnvVar> envVars;
        envVars.reserve(mergedEnvVars.size());
        for (const auto& item : mergedEnvVars) {
            envVars.push_back({item.first, item.second});
        }
        std::sort(envVars.begin(), envVars.end(), [](const BuildEnvVar& left, const BuildEnvVar& right) {
            return left.key < right.key;
        });

        if (sourceType == "github" && repoUrl.empty()) {
            txn.commit();
            throw std::runtime_error("Project repository URL is required before triggering a build");
        }
        if ((sourceType == "ssh" || sourceType == "local") && sourcePath.empty()) {
            txn.commit();
            throw std::runtime_error("Project source path is required before triggering a build");
        }
        if (sourceType == "artifact" && (sourceArtifactId.empty() || artifactStoragePath.empty())) {
            txn.commit();
            throw std::runtime_error("Deployment source artifact is missing or no longer available");
        }
        if (sourceType == "application" && !ApplicationCatalog::isSupportedTemplate(applicationTemplateId)) {
            txn.commit();
            throw std::runtime_error("Deployment application template is missing or no longer supported");
        }

        SshConnectionConfig sshConfig;
        if (sourceType == "ssh") {
            if (row["host"].is_null() || row["username"].is_null() || row["auth_type"].is_null()) {
                txn.commit();
                throw std::runtime_error("Project SSH connection is missing or no longer available");
            }
            sshConfig = rowToSshConfig(row, "", "ssh");
        }

        SshConnectionConfig remoteExecutionConfig;
        if (executionMode == "remote_host") {
            if (sourceType == "local") {
                txn.commit();
                throw std::runtime_error("Remote host execution does not support local source projects");
            }
            if (row["remote_host"].is_null() || row["remote_username"].is_null() || row["remote_auth_type"].is_null()) {
                txn.commit();
                throw std::runtime_error("Remote execution connection is missing or no longer available");
            }
            remoteExecutionConfig = rowToSshConfig(row, "remote_", "ssh");
        }

        txn.exec_params("DELETE FROM deployment_env_vars WHERE deployment_id = $1", job.deploymentId);
        for (const auto& envVar : envVars) {
            txn.exec_params(
                "INSERT INTO deployment_env_vars (deployment_id, key, value_encrypted) "
                "VALUES ($1, $2, $3) "
                "ON CONFLICT (deployment_id, key) DO UPDATE SET value_encrypted = EXCLUDED.value_encrypted",
                job.deploymentId,
                envVar.key,
                TokenCrypto::encrypt(envVar.value)
            );
        }

        Json::Value sourceSnapshot = deploymentSourceSnapshot(
            sourceType, repoUrl, sourcePath, executionMode, remoteRuntimeType, remoteK8sExposure,
            runtimeScheme, localHttpsEnabled, version, projectName
        );
        if (!sourceArtifactId.empty()) {
            sourceSnapshot["source_artifact_id"] = sourceArtifactId;
        }
        if (sourceType == "application") {
            sourceSnapshot["application_template_id"] = applicationTemplateId;
            sourceSnapshot["application_config"] = applicationConfig;
        }
        if (!remoteConnectionId.empty()) {
            sourceSnapshot["remote_connection_id"] = remoteConnectionId;
        }
        txn.exec_params(
            "UPDATE deployments "
            "SET status = 'building', logs = '', source_snapshot = $2::jsonb, env_snapshot = $3::jsonb, "
            "remote_connection_id = NULLIF($4, '')::uuid, artifact_available = FALSE, updated_at = NOW() "
            "WHERE id = $1",
            job.deploymentId,
            compactJson(sourceSnapshot),
            compactJson(envKeySnapshot(envVars)),
            remoteConnectionId
        );
        txn.commit();

        LogWebSocketController::broadcastStatus(job.deploymentId, "building");
        broadcastDeploymentSummary(job.deploymentId);

        BuildService buildService;
        const auto logSink = [deploymentId = job.deploymentId](const std::string& line) {
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
                    job.deploymentId,
                    remoteExecutionConfig,
                    repoUrl,
                    sourcePath,
                    version,
                    githubPat,
                    branch,
                    commitSha,
                    projectName,
                    3000,
                    envVars,
                    logSink
                );
            } else if (sourceType == "artifact") {
                buildResult = buildService.buildArtifactAndRunOnRemoteDocker(
                    job.deploymentId,
                    remoteExecutionConfig,
                    artifactStoragePath,
                    sourcePath.empty() ? "/tmp" : sourcePath,
                    version,
                    projectName,
                    3000,
                    envVars,
                    logSink
                );
            } else if (sourceType == "application") {
                auto generatedSource = ApplicationCatalog::materializeSource(
                    job.deploymentId,
                    projectName,
                    applicationTemplateId,
                    applicationConfig,
                    std::filesystem::temp_directory_path()
                );
                logSink("Generated application template source: " + applicationTemplateId);
                buildResult = buildService.buildGeneratedSourceAndRunOnRemoteDocker(
                    job.deploymentId,
                    remoteExecutionConfig,
                    generatedSource.string(),
                    sourcePath.empty() ? "/tmp" : sourcePath,
                    version,
                    projectName,
                    3000,
                    envVars,
                    logSink
                );
            } else {
                buildResult = buildService.buildAndRunOnRemoteDocker(
                    job.deploymentId,
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
                    options.deploymentId = job.deploymentId;
                    options.projectName = projectName;
                    options.nameSpace = getEnvOrDefault("K8S_NAMESPACE", "stackpilot-apps");
                    options.runtimeScheme = runtimeScheme;
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
                    const auto cleanup = sshService.removeDockerContainer(
                        remoteExecutionConfig,
                        buildResult.remoteContainerName,
                        buildResult.imageName,
                        false
                    );
                    if (!cleanup.output.empty()) {
                        buildResult.logs += "\n" + cleanup.output;
                    }
                    logSink("Temporary remote Docker container removed before Kubernetes deployment");
                }

                if (!buildResult.composeProject) {
                    KubernetesDeployOptions options;
                    options.deploymentId = job.deploymentId;
                    options.projectName = projectName;
                    options.imageName = buildResult.imageName;
                    options.nameSpace = getEnvOrDefault("K8S_NAMESPACE", "stackpilot-apps");
                    options.runtimeScheme = runtimeScheme;
                    options.exposureMode = options.runtimeScheme == "https" ? "ingress" : normalizeRemoteK8sExposure(remoteK8sExposure);
                    options.replicas = 1;
                    options.containerPort = 3000;
                    options.resourcePreset = "small";
                    options.healthPath = "/";
                    for (const auto& envVar : envVars) {
                        options.envVars.emplace_back(envVar.key, envVar.value);
                    }

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
                    buildResult.error = remoteK8sRuntime.error.empty()
                        ? "Remote Kubernetes deployment failed"
                        : remoteK8sRuntime.error;
                }
            }
        } else if (sourceType == "ssh") {
            buildResult = buildService.buildFromSshSource(
                job.deploymentId,
                sshConfig,
                sourcePath,
                version,
                envVars,
                logSink
            );
        } else if (sourceType == "local") {
            buildResult = buildService.buildFromLocalSource(
                job.deploymentId,
                sourcePath,
                version,
                envVars,
                logSink
            );
        } else if (sourceType == "artifact") {
            buildResult = buildService.buildFromArtifact(
                job.deploymentId,
                artifactStoragePath,
                version,
                envVars,
                logSink
            );
        } else if (sourceType == "application") {
            auto generatedSource = ApplicationCatalog::materializeSource(
                job.deploymentId,
                projectName,
                applicationTemplateId,
                applicationConfig,
                std::filesystem::temp_directory_path()
            );
            logSink("Generated application template source: " + applicationTemplateId);
            buildResult = buildService.buildFromGeneratedSource(
                job.deploymentId,
                generatedSource.string(),
                version,
                envVars,
                logSink
            );
        } else {
            buildResult = buildService.buildFromRepository(
                job.deploymentId,
                repoUrl,
                version,
                githubPat,
                branch,
                commitSha,
                envVars,
                logSink
            );
        }

        if (buildResult.success && executionMode != "remote_host" && remoteRuntimeType == "docker" && !buildResult.composeProject) {
            const std::string containerName =
                "stackpilot-local-" + sanitizeDockerContainerName(projectName) + "-" +
                sanitizeDockerContainerName(job.deploymentId).substr(0, 12);
            logSink("Deploying image to local Docker...");
            std::string dockerOutput;
            const int dockerExit = runCommandCaptureExit(
                "timeout 120s sh -lc " + shellQuote(makeLocalDockerRunCommand(containerName, buildResult.imageName, 3000, envVars)),
                dockerOutput
            );
            buildResult.logs += "\n" + dockerOutput;
            if (dockerExit != 0 || dockerOutput.find("__STACKPILOT_LOCAL_DOCKER_RUNNING__") == std::string::npos) {
                buildResult.success = false;
                if (dockerOutput.find("__STACKPILOT_DOCKER_MISSING__") != std::string::npos) {
                    buildResult.error = "Docker is not installed in the StackPilot backend environment";
                } else if (dockerOutput.find("__STACKPILOT_DOCKER_DAEMON_DOWN__") != std::string::npos) {
                    buildResult.error = "Docker daemon is not reachable from the StackPilot backend";
                } else if (dockerOutput.find("__STACKPILOT_IMAGE_MISSING__") != std::string::npos) {
                    buildResult.error = "Built image is missing from local Docker";
                } else if (dockerExit == 124) {
                    buildResult.error = "Local Docker deploy timed out";
                } else {
                    buildResult.error = "Failed to start local Docker runtime";
                }
                logSink(buildResult.error);
            } else {
                buildResult.runtimeProvider = "local_docker";
                buildResult.runtimeUrl = valueFromKeyValueOutput(dockerOutput, "runtime_url");
                buildResult.remoteContainerName = containerName;
                logSink("Runtime URL: " + buildResult.runtimeUrl);
            }
        }

        if (buildResult.success && executionMode != "remote_host" && remoteRuntimeType == "kubernetes") {
            KubernetesDeployOptions options;
            options.deploymentId = job.deploymentId;
            options.projectName = projectName;
            options.imageName = buildResult.imageName;
            options.nameSpace = getEnvOrDefault("K8S_NAMESPACE", "stackpilot-apps");
            options.runtimeScheme = "http";
            options.exposureMode = "nodeport";
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
                buildResult.error = localK8sRuntime.error.empty()
                    ? "Local Kubernetes deployment failed"
                    : localK8sRuntime.error;
            }
        }

        auto connUpdate = Database::getInstance().getConnection();
        pqxx::work updateTxn(*connUpdate);
        std::string deploymentToRetire;
        bool cleanupPreviousDeployment = false;
        if (buildResult.success) {
            if (buildResult.runtimeProvider == "remote_kubernetes" && hasRemoteK8sRuntime) {
                updateTxn.exec_params(
                    "UPDATE deployments "
                    "SET status = $1, logs = $2, image_name = $3, runtime_url = $4, runtime_exposure = $5, "
                    "runtime_provider = 'remote_kubernetes', remote_container_name = '', "
                    "k8s_namespace = $6, k8s_deployment_name = $7, k8s_service_name = $8, k8s_ingress_name = $9, "
                    "desired_replicas = $10, runtime_snapshot = $11::jsonb, artifact_available = TRUE, updated_at = NOW() "
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
                        ? composeKubernetesRuntimeSnapshot(buildResult, remoteK8sRuntime, "remote_kubernetes", runtimeScheme, 3000, "small", "/")
                        : runtimeSnapshot(
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
                    job.deploymentId
                );
                LogWebSocketController::broadcastStatus(job.deploymentId, remoteK8sRuntime.status.empty() ? "running" : remoteK8sRuntime.status);
            } else if (buildResult.runtimeProvider == "kubernetes" && hasLocalK8sRuntime) {
                updateTxn.exec_params(
                    "UPDATE deployments "
                    "SET status = $1, logs = $2, image_name = $3, runtime_url = $4, runtime_exposure = $5, "
                    "runtime_provider = 'kubernetes', "
                    "k8s_namespace = $6, k8s_deployment_name = $7, k8s_service_name = $8, k8s_ingress_name = $9, "
                    "desired_replicas = $10, runtime_snapshot = $11::jsonb, runtime_paused = FALSE, "
                    "artifact_available = TRUE, updated_at = NOW() "
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
                        ? composeKubernetesRuntimeSnapshot(buildResult, localK8sRuntime, "kubernetes", runtimeScheme, 3000, "small", "/")
                        : runtimeSnapshot(
                            "kubernetes",
                            buildResult.imageName,
                            localK8sRuntime.runtimeUrl,
                            localK8sRuntime.exposureMode,
                            localK8sRuntime.desiredReplicas,
                            3000,
                            "small",
                            "/",
                            localK8sRuntime.runtimeScheme.empty() ? runtimeScheme : localK8sRuntime.runtimeScheme
                        )),
                    job.deploymentId
                );
                LogWebSocketController::broadcastStatus(job.deploymentId, localK8sRuntime.status.empty() ? "running" : localK8sRuntime.status);
            } else if (buildResult.runtimeProvider == "remote_compose") {
                updateTxn.exec_params(
                    "UPDATE deployments "
                    "SET status = 'running', logs = $1, image_name = $2, runtime_url = $3, runtime_exposure = 'remote_compose', "
                    "runtime_provider = 'remote_compose', remote_container_name = $4, runtime_snapshot = $5::jsonb, "
                    "artifact_available = TRUE, runtime_paused = FALSE, updated_at = NOW() "
                    "WHERE id = $6",
                    buildResult.logs,
                    buildResult.imageName,
                    buildResult.runtimeUrl,
                    buildResult.composeProjectName.empty() ? buildResult.remoteContainerName : buildResult.composeProjectName,
                    compactJson(composeRuntimeSnapshot(buildResult, "remote_compose", "http")),
                    job.deploymentId
                );
                LogWebSocketController::broadcastStatus(job.deploymentId, "running");
            } else if (buildResult.runtimeProvider == "remote_docker") {
                updateTxn.exec_params(
                    "UPDATE deployments "
                    "SET status = 'running', logs = $1, image_name = $2, runtime_url = $3, runtime_exposure = 'remote_docker', "
                    "runtime_provider = 'remote_docker', remote_container_name = $4, runtime_snapshot = $5::jsonb, "
                    "artifact_available = TRUE, updated_at = NOW() "
                    "WHERE id = $6",
                    buildResult.logs,
                    buildResult.imageName,
                    buildResult.runtimeUrl,
                    buildResult.remoteContainerName,
                    compactJson(runtimeSnapshot("remote_docker", buildResult.imageName, buildResult.runtimeUrl, "remote_docker", 1, 3000, "small", "/", "http")),
                    job.deploymentId
                );
                LogWebSocketController::broadcastStatus(job.deploymentId, "running");
            } else if (buildResult.runtimeProvider == "local_compose") {
                updateTxn.exec_params(
                    "UPDATE deployments "
                    "SET status = 'running', logs = $1, image_name = $2, runtime_url = $3, runtime_exposure = 'local_compose', "
                    "runtime_provider = 'local_compose', remote_container_name = $4, desired_replicas = 1, runtime_paused = FALSE, "
                    "runtime_snapshot = $5::jsonb, artifact_available = TRUE, updated_at = NOW() "
                    "WHERE id = $6",
                    buildResult.logs,
                    buildResult.imageName,
                    buildResult.runtimeUrl,
                    buildResult.composeProjectName.empty() ? buildResult.remoteContainerName : buildResult.composeProjectName,
                    compactJson(composeRuntimeSnapshot(buildResult, "local_compose", "http")),
                    job.deploymentId
                );
                LogWebSocketController::broadcastStatus(job.deploymentId, "running");
            } else if (buildResult.runtimeProvider == "local_docker") {
                int containerPort = 3000;
                updateTxn.exec_params(
                    "UPDATE deployments "
                    "SET status = 'running', logs = $1, image_name = $2, runtime_url = $3, runtime_exposure = 'local_docker', "
                    "runtime_provider = 'local_docker', remote_container_name = $4, desired_replicas = 1, runtime_paused = FALSE, "
                    "runtime_snapshot = $5::jsonb, artifact_available = TRUE, updated_at = NOW() "
                    "WHERE id = $6",
                    buildResult.logs,
                    buildResult.imageName,
                    buildResult.runtimeUrl,
                    buildResult.remoteContainerName,
                    compactJson(runtimeSnapshot("local_docker", buildResult.imageName, buildResult.runtimeUrl, "local_docker", 1, containerPort, "small", "/", "http")),
                    job.deploymentId
                );
                LogWebSocketController::broadcastStatus(job.deploymentId, "running");
            } else {
                updateTxn.exec_params(
                    "UPDATE deployments "
                    "SET status = 'built', logs = $1, image_name = $2, runtime_snapshot = $3::jsonb, "
                    "artifact_available = TRUE, updated_at = NOW() "
                    "WHERE id = $4",
                    buildResult.logs,
                    buildResult.imageName,
                    compactJson(runtimeSnapshot("local_docker", buildResult.imageName, "", "docker", 0, 3000, "small", "/", "http")),
                    job.deploymentId
                );
                LogWebSocketController::broadcastStatus(job.deploymentId, "built");
            }
            if (!environmentId.empty()) {
                auto newerRows = updateTxn.exec_params(
                    "SELECT id FROM deployments "
                    "WHERE environment_id = $1 AND id <> $2 "
                    "AND created_at > (SELECT created_at FROM deployments WHERE id = $2) "
                    "AND status NOT IN ('failed', 'failed_ci', 'superseded', 'canceled', 'cancelled', 'retired') "
                    "ORDER BY created_at DESC LIMIT 1",
                    environmentId,
                    job.deploymentId
                );
                if (!newerRows.empty()) {
                    updateTxn.exec_params(
                        "UPDATE deployments "
                        "SET status = 'superseded', logs = COALESCE(logs, '') || E'Build succeeded, but a newer commit arrived before promotion. Cleaning up this superseded runtime.\\n', "
                        "ci_status = CASE WHEN ci_required = TRUE THEN 'passed' ELSE ci_status END, updated_at = NOW() "
                        "WHERE id = $1",
                        job.deploymentId
                    );
                    updateTxn.commit();

                    DeploymentCleanupOptions cleanupOptions;
                    cleanupOptions.deleteDatabaseRow = false;
                    cleanupOptions.deleteImage = true;
                    cleanupOptions.deleteRemoteWorkspace = true;
                    DeploymentCleanupService cleanupService;
                    const auto cleanup = cleanupService.cleanupDeployment(job.userId, job.deploymentId, cleanupOptions);
                    if (!cleanup.success) {
                        appendDeploymentLog(job.deploymentId, "Superseded runtime cleanup failed: " + cleanup.error);
                    }
                    completeJob(job);
                    LogWebSocketController::broadcastStatus(job.deploymentId, "superseded");
                    broadcastDeploymentSummary(job.deploymentId);
                    return;
                }

                auto envRows = updateTxn.exec_params(
                    "SELECT current_deployment_id, cleanup_previous_on_success "
                    "FROM project_environments WHERE id = $1 FOR UPDATE",
                    environmentId
                );
                if (!envRows.empty()) {
                    deploymentToRetire = envRows[0]["current_deployment_id"].is_null()
                        ? previousCurrentDeploymentId
                        : envRows[0]["current_deployment_id"].as<std::string>();
                    cleanupPreviousDeployment = envRows[0]["cleanup_previous_on_success"].is_null()
                        ? cleanupPreviousOnSuccess
                        : envRows[0]["cleanup_previous_on_success"].as<bool>();
                }
                updateTxn.exec_params(
                    "UPDATE project_environments e "
                    "SET current_deployment_id = d.id, updated_at = NOW() "
                    "FROM deployments d "
                    "WHERE d.id = $1 AND d.environment_id = e.id AND d.project_id = e.project_id",
                    job.deploymentId
                );
            }
            updateTxn.exec_params(
                "UPDATE deployments "
                "SET ci_status = CASE WHEN ci_required = TRUE AND ci_status = 'pending' THEN 'passed' ELSE ci_status END "
                "WHERE id = $1",
                job.deploymentId
            );
        } else {
            std::string failureLogs = buildResult.logs.empty() ? buildResult.error : buildResult.logs;
            if (!buildResult.error.empty() && failureLogs.find(buildResult.error) == std::string::npos) {
                failureLogs += "\nFailure reason: " + buildResult.error + "\n";
            }
            updateTxn.exec_params(
                "UPDATE deployments "
                "SET status = 'failed', logs = $1, artifact_available = FALSE, updated_at = NOW() "
                "WHERE id = $2",
                failureLogs,
                job.deploymentId
            );
            LogWebSocketController::broadcastStatus(job.deploymentId, "failed");
        }
        updateTxn.commit();
        broadcastDeploymentSummary(job.deploymentId);

        if (buildResult.success) {
            if (cleanupPreviousDeployment && !deploymentToRetire.empty() && deploymentToRetire != job.deploymentId) {
                DeploymentCleanupOptions cleanupOptions;
                cleanupOptions.deleteDatabaseRow = false;
                cleanupOptions.deleteImage = true;
                cleanupOptions.deleteRemoteWorkspace = true;
                DeploymentCleanupService cleanupService;
                const auto cleanup = cleanupService.cleanupDeployment(job.userId, deploymentToRetire, cleanupOptions);
                try {
                    auto cleanupConn = Database::getInstance().getConnection();
                    pqxx::work cleanupTxn(*cleanupConn);
                    if (cleanup.success) {
                        cleanupTxn.exec_params(
                            "UPDATE deployments "
                            "SET status = 'retired', logs = COALESCE(logs, '') || E'Environment superseded by a newer successful commit; runtime and image were cleaned up.\\n', updated_at = NOW() "
                            "WHERE id = $1",
                            deploymentToRetire
                        );
                    } else {
                        cleanupTxn.exec_params(
                            "UPDATE deployments "
                            "SET logs = COALESCE(logs, '') || $2 || E'\\n', updated_at = NOW() "
                            "WHERE id = $1",
                            deploymentToRetire,
                            "Cleanup after successful replacement failed: " + cleanup.error
                        );
                    }
                    cleanupTxn.commit();
                    broadcastDeploymentSummary(deploymentToRetire);
                } catch (const std::exception& cleanupDbError) {
                    spdlog::warn("Failed to persist replacement cleanup result for {}: {}", deploymentToRetire, cleanupDbError.what());
                }
            }
            completeJob(job);
        } else {
            failJob(job, buildResult.error.empty() ? "Deployment build failed" : buildResult.error, false);
        }
    } catch (const std::exception& e) {
        spdlog::error("Deployment job {} failed for {}: {}", job.id, job.deploymentId, e.what());
        try {
            auto conn = Database::getInstance().getConnection();
            pqxx::work txn(*conn);
            txn.exec_params(
                "UPDATE deployments SET status = 'failed', logs = $1, artifact_available = FALSE, updated_at = NOW() WHERE id = $2",
                std::string("Background worker error: ") + e.what(),
                job.deploymentId
            );
            txn.commit();
            LogWebSocketController::broadcastStatus(job.deploymentId, "failed");
            broadcastDeploymentSummary(job.deploymentId);
        } catch (const std::exception& dbError) {
            spdlog::error("Failed to persist worker failure for {}: {}", job.deploymentId, dbError.what());
        }
        failJob(job, e.what(), true);
    }
}

} // namespace stackpilot
