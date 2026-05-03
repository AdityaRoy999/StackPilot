// ============================================================
// JobQueueService.cpp - Redis-backed durable build queue
// ============================================================

#include "JobQueueService.h"

#include "../controllers/LogWebSocketController.h"
#include "../db/Database.h"
#include "../utils/TokenCrypto.h"
#include "BuildService.h"
#include "KubernetesService.h"
#include "SshService.h"

#include <algorithm>
#include <chrono>
#include <cctype>
#include <cstdlib>
#include <cstdio>
#include <mutex>
#include <pqxx/pqxx>
#include <sstream>
#include <spdlog/spdlog.h>
#include <stdexcept>
#ifndef _WIN32
#include <unistd.h>
#else
#include <process.h>
#endif

namespace aids {
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

Json::Value loadDeploymentSummary(const std::string& deploymentId) {
    auto conn = Database::getInstance().getConnection();
    pqxx::work txn(*conn);
    auto rows = txn.exec_params(
        "SELECT d.id, d.project_id, p.name AS project_name, d.status, d.version, d.commit_hash, d.image_name, "
        "d.k8s_namespace, d.k8s_deployment_name, d.k8s_service_name, d.k8s_ingress_name, "
        "d.desired_replicas, d.runtime_url, d.runtime_exposure, d.runtime_provider, d.remote_container_name, d.created_at "
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
    : workerId_(getEnvOrDefault("HOSTNAME", "aids-backend") + "-" + std::to_string(::getpid())),
      redisHost_(getEnvOrDefault("REDIS_HOST", "redis")),
      redisPort_(getEnvIntOrDefault("REDIS_PORT", 6379)),
      redisPassword_(getEnvOrDefault("REDIS_PASSWORD", "")),
      queueName_(getEnvOrDefault("AIDS_REDIS_QUEUE", "aids:jobs:deployment")),
      workerCount_(std::max(1, getEnvIntOrDefault("AIDS_JOB_WORKERS", 2))),
      maxAttempts_(std::clamp(getEnvIntOrDefault("AIDS_JOB_MAX_ATTEMPTS", 3), 1, 10)) {}

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
            job.deploymentId,
            job.userId
        );

        if (deploymentRows.empty()) {
            txn.commit();
            failJob(job, "Deployment no longer exists", false);
            return;
        }

        const auto& row = deploymentRows[0];
        const std::string version = row["version"].as<std::string>();
        const std::string projectName = row["project_name"].as<std::string>();
        const std::string sourceType = row["source_type"].is_null() ? "github" : row["source_type"].as<std::string>();
        const std::string executionMode = row["execution_mode"].is_null() ? "local" : row["execution_mode"].as<std::string>();
        const std::string remoteRuntimeType = row["remote_runtime_type"].is_null() ? "docker" : row["remote_runtime_type"].as<std::string>();
        const std::string remoteK8sExposure = row["remote_k8s_exposure"].is_null() ? "nodeport" : row["remote_k8s_exposure"].as<std::string>();
        const std::string runtimeScheme = normalizeRuntimeScheme(row["runtime_scheme"].is_null() ? "http" : row["runtime_scheme"].as<std::string>());
        const bool localHttpsEnabled = row["local_https_enabled"].is_null() ? false : row["local_https_enabled"].as<bool>();
        const std::string repoUrl = row["repo_url"].is_null() ? "" : row["repo_url"].as<std::string>();
        const std::string sourcePath = row["source_path"].is_null() ? "" : row["source_path"].as<std::string>();
        const std::string projectToken = row["github_pat"].is_null() ? "" : TokenCrypto::decrypt(row["github_pat"].as<std::string>());
        const std::string linkedGitHubToken = row["github_access_token"].is_null() ? "" : TokenCrypto::decrypt(row["github_access_token"].as<std::string>());
        const std::string githubPat = !projectToken.empty() ? projectToken : linkedGitHubToken;

        std::vector<BuildEnvVar> envVars;
        auto envRows = txn.exec_params(
            "SELECT key, value_encrypted FROM project_env_vars "
            "WHERE project_id = (SELECT project_id FROM deployments WHERE id = $1) "
            "ORDER BY key ASC",
            job.deploymentId
        );
        for (const auto& envRow : envRows) {
            envVars.push_back({
                envRow["key"].as<std::string>(),
                TokenCrypto::decrypt(envRow["value_encrypted"].as<std::string>())
            });
        }

        if (sourceType == "github" && repoUrl.empty()) {
            txn.commit();
            throw std::runtime_error("Project repository URL is required before triggering a build");
        }
        if ((sourceType == "ssh" || sourceType == "local") && sourcePath.empty()) {
            txn.commit();
            throw std::runtime_error("Project source path is required before triggering a build");
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

        txn.exec_params(
            "UPDATE deployments "
            "SET status = 'building', logs = '', source_snapshot = $2::jsonb, env_snapshot = $3::jsonb, "
            "artifact_available = FALSE, updated_at = NOW() "
            "WHERE id = $1",
            job.deploymentId,
            compactJson(deploymentSourceSnapshot(
                sourceType, repoUrl, sourcePath, executionMode, remoteRuntimeType, remoteK8sExposure,
                runtimeScheme, localHttpsEnabled, version, projectName
            )),
            compactJson(envKeySnapshot(envVars))
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
                if (!buildResult.remoteContainerName.empty()) {
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

                KubernetesDeployOptions options;
                options.deploymentId = job.deploymentId;
                options.projectName = projectName;
                options.imageName = buildResult.imageName;
                options.nameSpace = getEnvOrDefault("K8S_NAMESPACE", "aids-apps");
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
        } else {
            buildResult = buildService.buildFromRepository(
                job.deploymentId,
                repoUrl,
                version,
                githubPat,
                envVars,
                logSink
            );
        }

        if (buildResult.success && executionMode != "remote_host" && remoteRuntimeType == "kubernetes") {
            KubernetesDeployOptions options;
            options.deploymentId = job.deploymentId;
            options.projectName = projectName;
            options.imageName = buildResult.imageName;
            options.nameSpace = getEnvOrDefault("K8S_NAMESPACE", "aids-apps");
            options.runtimeScheme = runtimeScheme;
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
            localK8sRuntime = kubernetesService.deploy(options);
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
                    compactJson(runtimeSnapshot(
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
            } else {
                updateTxn.exec_params(
                    "UPDATE deployments "
                    "SET status = 'built', logs = $1, image_name = $2, runtime_snapshot = $3::jsonb, "
                    "artifact_available = TRUE, updated_at = NOW() "
                    "WHERE id = $4",
                    buildResult.logs,
                    buildResult.imageName,
                    compactJson(runtimeSnapshot("local_docker", buildResult.imageName, "", "docker", 0, 3000, "small", "/", localHttpsEnabled ? "https" : "http")),
                    job.deploymentId
                );
                LogWebSocketController::broadcastStatus(job.deploymentId, "built");
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
                failureLogs,
                job.deploymentId
            );
            LogWebSocketController::broadcastStatus(job.deploymentId, "failed");
        }
        updateTxn.commit();
        broadcastDeploymentSummary(job.deploymentId);

        if (buildResult.success) {
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

} // namespace aids
