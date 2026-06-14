// ============================================================
// ProjectEnvironmentController.cpp
// ============================================================

#include "ProjectEnvironmentController.h"
#include "../db/Database.h"
#include "../utils/AuditLogger.h"
#include "../utils/JwtHelper.h"
#include "../utils/TokenCrypto.h"

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <drogon/HttpClient.h>
#include <json/json.h>
#include <pqxx/pqxx>
#include <spdlog/spdlog.h>
#include <thread>
#include <vector>

namespace stackpilot {
namespace {

Json::Value environmentRowToJson(const pqxx::row& row) {
    Json::Value env(Json::objectValue);
    env["id"] = row["id"].as<std::string>();
    env["project_id"] = row["project_id"].as<std::string>();
    env["name"] = row["name"].as<std::string>();
    env["branch"] = row["branch"].as<std::string>();
    env["auto_deploy"] = row["auto_deploy"].as<bool>();
    env["require_ci"] = row["require_ci"].as<bool>();
    env["cleanup_previous_on_success"] = row["cleanup_previous_on_success"].as<bool>();
    env["execution_mode"] = row["execution_mode"].as<std::string>();
    env["remote_connection_id"] = row["remote_connection_id"].is_null() ? "" : row["remote_connection_id"].as<std::string>();
    env["remote_runtime_type"] = row["remote_runtime_type"].as<std::string>();
    env["remote_k8s_exposure"] = row["remote_k8s_exposure"].as<std::string>();
    env["runtime_scheme"] = row["runtime_scheme"].as<std::string>();
    env["current_deployment_id"] = row["current_deployment_id"].is_null() ? "" : row["current_deployment_id"].as<std::string>();
    env["current_deployment_status"] = row["current_deployment_status"].is_null() ? "" : row["current_deployment_status"].as<std::string>();
    env["current_deployment_version"] = row["current_deployment_version"].is_null() ? "" : row["current_deployment_version"].as<std::string>();
    env["current_commit_sha"] = row["current_commit_sha"].is_null() ? "" : row["current_commit_sha"].as<std::string>();
    env["current_runtime_url"] = row["current_runtime_url"].is_null() ? "" : row["current_runtime_url"].as<std::string>();
    env["updated_at"] = row["updated_at"].as<std::string>();
    return env;
}

bool projectBelongsToUser(pqxx::transaction_base& txn,
                          const std::string& projectId,
                          const std::string& userId) {
    auto rows = txn.exec_params("SELECT id FROM projects WHERE id = $1 AND user_id = $2", projectId, userId);
    return !rows.empty();
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

bool isSupportedExecutionMode(const std::string& value) {
    return value == "local" || value == "remote_host";
}

bool isSupportedRuntimeType(const std::string& value) {
    return value == "docker" || value == "kubernetes";
}

bool isSupportedK8sExposure(const std::string& value) {
    return value == "nodeport" || value == "ingress" || value == "loadbalancer" || value == "clusterip";
}

bool isSupportedRuntimeScheme(const std::string& value) {
    return value == "http" || value == "https";
}

bool remoteConnectionBelongsToUser(pqxx::transaction_base& txn,
                                   const std::string& remoteConnectionId,
                                   const std::string& userId) {
    if (remoteConnectionId.empty()) {
        return true;
    }
    auto rows = txn.exec_params(
        "SELECT id FROM ssh_connections WHERE id = $1 AND user_id = $2",
        remoteConnectionId,
        userId
    );
    return !rows.empty();
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

std::vector<std::pair<std::string, std::string>> parseEnvVars(const Json::Value& body) {
    std::vector<std::pair<std::string, std::string>> envVars;
    if (!body.isMember("env_vars") || !body["env_vars"].isArray()) {
        return envVars;
    }

    std::vector<std::string> seen;
    for (const auto& item : body["env_vars"]) {
        if (!item.isObject()) {
            continue;
        }
        const std::string key = trim(item.get("key", "").asString());
        if (!isValidEnvKey(key) || std::find(seen.begin(), seen.end(), key) != seen.end()) {
            continue;
        }
        seen.push_back(key);
        envVars.emplace_back(key, item.get("value", "").asString());
    }
    std::sort(envVars.begin(), envVars.end(), [](const auto& left, const auto& right) {
        return left.first < right.first;
    });
    return envVars;
}

Json::Value envVarsToJson(const std::vector<std::pair<std::string, std::string>>& envVars) {
    Json::Value values(Json::arrayValue);
    for (const auto& envVar : envVars) {
        Json::Value item(Json::objectValue);
        item["key"] = envVar.first;
        item["value"] = envVar.second;
        values.append(item);
    }
    return values;
}

std::vector<std::pair<std::string, std::string>> loadEnvironmentEnvVars(pqxx::transaction_base& txn,
                                                                        const std::string& environmentId) {
    std::vector<std::pair<std::string, std::string>> envVars;
    auto rows = txn.exec_params(
        "SELECT key, value_encrypted FROM project_environment_env_vars WHERE environment_id = $1 ORDER BY key ASC",
        environmentId
    );
    for (const auto& row : rows) {
        envVars.emplace_back(
            row["key"].as<std::string>(),
            TokenCrypto::decrypt(row["value_encrypted"].as<std::string>())
        );
    }
    return envVars;
}

void replaceEnvironmentEnvVars(pqxx::transaction_base& txn,
                               const std::string& environmentId,
                               const std::vector<std::pair<std::string, std::string>>& envVars) {
    txn.exec_params("DELETE FROM project_environment_env_vars WHERE environment_id = $1", environmentId);
    for (const auto& envVar : envVars) {
        txn.exec_params(
            "INSERT INTO project_environment_env_vars (environment_id, key, value_encrypted) "
            "VALUES ($1, $2, $3) "
            "ON CONFLICT (environment_id, key) DO UPDATE SET value_encrypted = EXCLUDED.value_encrypted, updated_at = NOW()",
            environmentId,
            envVar.first,
            TokenCrypto::encrypt(envVar.second)
        );
    }
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
    for (char c : value) {
        const bool ok = std::isalnum(static_cast<unsigned char>(c)) ||
                        c == '-' || c == '_' || c == '.' || c == '/';
        if (!ok) return "";
    }
    return value;
}

std::string envOrEmpty(const char* name) {
    const char* value = std::getenv(name);
    return value && *value ? value : "";
}

bool looksPublicHttpsUrl(const std::string& url) {
    const std::string cleaned = toLower(trim(url));
    return cleaned.rfind("https://", 0) == 0 &&
           cleaned.find("localhost") == std::string::npos &&
           cleaned.find("127.0.0.1") == std::string::npos &&
           cleaned.find("0.0.0.0") == std::string::npos &&
           cleaned.find("[::1]") == std::string::npos;
}

bool githubAppWebhookModeEnabled() {
    const std::string value = toLower(trim(envOrEmpty("GITHUB_APP_WEBHOOK_MODE")));
    return value == "1" || value == "true" || value == "yes" || value == "on";
}

Json::Value maybeRegisterWebhookForEnvironment(const std::string& repoUrl,
                                               const std::string& token,
                                               bool autoDeploy) {
    Json::Value warnings(Json::arrayValue);
    if (!autoDeploy) {
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
    if (backendPublicUrl.empty()) backendPublicUrl = "http://localhost:8090";
    while (!backendPublicUrl.empty() && backendPublicUrl.back() == '/') backendPublicUrl.pop_back();
    const std::string webhookSecret = envOrEmpty("GITHUB_WEBHOOK_SECRET");
    if (webhookSecret.empty()) {
        warnings.append("Auto deploy needs GITHUB_WEBHOOK_SECRET before StackPilot can register a production GitHub webhook.");
        return warnings;
    }
    if (!looksPublicHttpsUrl(backendPublicUrl)) {
        warnings.append("Auto deploy webhook was not registered because BACKEND_PUBLIC_URL must be a public HTTPS URL reachable by GitHub.");
        return warnings;
    }
    if (token.empty()) {
        warnings.append("Auto deploy webhook was not registered because no GitHub token is available.");
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
            client->sendRequest(hookReq, [fullName](drogon::ReqResult result, const drogon::HttpResponsePtr& response) {
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
            }, 10.0);
        } catch (const std::exception& e) {
            spdlog::warn("GitHub webhook registration failed for {}: {}", fullName, e.what());
        }
    }).detach();

    return warnings;
}

} // namespace

std::string ProjectEnvironmentController::extractUserId(const drogon::HttpRequestPtr& req) {
    auto payload = JwtHelper::verifyRequestToken(req);
    return payload.isNull() ? "" : payload["user_id"].asString();
}

void ProjectEnvironmentController::listEnvironments(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& projectId
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        Json::Value err; err["error"] = "Unauthorized";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp); return;
    }

    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);
        if (!projectBelongsToUser(txn, projectId, userId)) {
            txn.commit();
            Json::Value err; err["error"] = "Project not found";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp); return;
        }
        auto rows = txn.exec_params(
            "SELECT e.id, e.project_id, e.name, e.branch, e.auto_deploy, e.require_ci, e.cleanup_previous_on_success, "
            "e.execution_mode, e.remote_connection_id, e.remote_runtime_type, e.remote_k8s_exposure, e.runtime_scheme, "
            "e.current_deployment_id, d.status AS current_deployment_status, d.version AS current_deployment_version, "
            "d.commit_sha AS current_commit_sha, d.runtime_url AS current_runtime_url, e.updated_at "
            "FROM project_environments e "
            "LEFT JOIN deployments d ON e.current_deployment_id = d.id "
            "WHERE e.project_id = $1 ORDER BY e.name ASC",
            projectId
        );
        Json::Value payload(Json::objectValue);
        payload["environments"] = Json::Value(Json::arrayValue);
        for (const auto& row : rows) {
            Json::Value env = environmentRowToJson(row);
            env["env_vars"] = envVarsToJson(loadEnvironmentEnvVars(txn, env["id"].asString()));
            payload["environments"].append(env);
        }
        txn.commit();
        callback(drogon::HttpResponse::newHttpJsonResponse(payload));
    } catch (const std::exception& e) {
        spdlog::error("List environments error: {}", e.what());
        Json::Value err; err["error"] = "Internal server error";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void ProjectEnvironmentController::createEnvironment(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& projectId
) {
    const std::string userId = extractUserId(req);
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

    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);
        auto projectRows = txn.exec_params(
            "SELECT p.repo_url, p.github_pat, u.github_access_token "
            "FROM projects p JOIN users u ON p.user_id = u.id "
            "WHERE p.id = $1 AND p.user_id = $2",
            projectId,
            userId
        );
        if (projectRows.empty()) {
            txn.commit();
            Json::Value err; err["error"] = "Project not found";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp); return;
        }
        const std::string name = toLower(trim((*body).get("name", "environment").asString()));
        const std::string branch = trim((*body).get("branch", "").asString());
        const std::string executionMode = toLower(trim((*body).get("execution_mode", "local").asString()));
        const std::string remoteConnectionId = trim((*body).get("remote_connection_id", "").asString());
        const std::string remoteRuntimeType = toLower(trim((*body).get("remote_runtime_type", "docker").asString()));
        const std::string remoteK8sExposure = toLower(trim((*body).get("remote_k8s_exposure", "nodeport").asString()));
        const std::string runtimeScheme = toLower(trim((*body).get("runtime_scheme", "http").asString()));
        const auto envVars = parseEnvVars(*body);
        if (name.empty() || branch.empty() || !isSupportedExecutionMode(executionMode) ||
            !isSupportedRuntimeType(remoteRuntimeType) || !isSupportedK8sExposure(remoteK8sExposure) ||
            !isSupportedRuntimeScheme(runtimeScheme) || !remoteConnectionBelongsToUser(txn, remoteConnectionId, userId)) {
            txn.commit();
            Json::Value err; err["error"] = "Invalid environment settings";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp); return;
        }
        auto rows = txn.exec_params(
            "INSERT INTO project_environments "
            "(project_id, name, branch, auto_deploy, require_ci, cleanup_previous_on_success, execution_mode, remote_connection_id, remote_runtime_type, remote_k8s_exposure, runtime_scheme) "
            "VALUES ($1, $2, $3, $4, $5, $6, $7, NULLIF($8, '')::uuid, $9, $10, $11) "
            "RETURNING id, project_id, name, branch, auto_deploy, require_ci, cleanup_previous_on_success, execution_mode, remote_connection_id, remote_runtime_type, remote_k8s_exposure, runtime_scheme, current_deployment_id, NULL::text AS current_deployment_status, NULL::text AS current_deployment_version, NULL::text AS current_commit_sha, NULL::text AS current_runtime_url, updated_at",
            projectId,
            name,
            branch,
            (*body).get("auto_deploy", true).asBool(),
            (*body).get("require_ci", false).asBool(),
            (*body).get("cleanup_previous_on_success", false).asBool(),
            executionMode,
            remoteConnectionId,
            remoteRuntimeType,
            remoteK8sExposure,
            runtimeScheme
        );
        const std::string repoUrl = projectRows[0]["repo_url"].is_null() ? "" : projectRows[0]["repo_url"].as<std::string>();
        const std::string projectToken = projectRows[0]["github_pat"].is_null() ? "" : TokenCrypto::decrypt(projectRows[0]["github_pat"].as<std::string>());
        const std::string userToken = projectRows[0]["github_access_token"].is_null() ? "" : TokenCrypto::decrypt(projectRows[0]["github_access_token"].as<std::string>());
        const bool autoDeploy = rows[0]["auto_deploy"].as<bool>();
        const std::string createdEnvironmentId = rows[0]["id"].as<std::string>();
        replaceEnvironmentEnvVars(txn, createdEnvironmentId, envVars);
        txn.commit();
        Json::Value payload(Json::objectValue);
        payload["environment"] = environmentRowToJson(rows[0]);
        payload["environment"]["env_vars"] = envVarsToJson(envVars);
        payload["webhook_warnings"] = maybeRegisterWebhookForEnvironment(repoUrl, projectToken.empty() ? userToken : projectToken, autoDeploy);
        AuditLogger::recordFromRequest(req, userId, "project_environment.created", "project", projectId, payload["environment"]);
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k201Created);
        callback(resp);
    } catch (const std::exception& e) {
        spdlog::error("Create environment error: {}", e.what());
        Json::Value err; err["error"] = "Unable to create environment";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k400BadRequest);
        callback(resp);
    }
}

void ProjectEnvironmentController::updateEnvironment(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& projectId,
    const std::string& environmentId
) {
    const std::string userId = extractUserId(req);
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

    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);
        auto projectRows = txn.exec_params(
            "SELECT p.repo_url, p.github_pat, u.github_access_token "
            "FROM projects p JOIN users u ON p.user_id = u.id "
            "WHERE p.id = $1 AND p.user_id = $2",
            projectId,
            userId
        );
        if (projectRows.empty()) {
            txn.commit();
            Json::Value err; err["error"] = "Project not found";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp); return;
        }
        const bool hasAutoDeploy = (*body).isMember("auto_deploy");
        const bool hasRequireCi = (*body).isMember("require_ci");
        const bool hasCleanupPrevious = (*body).isMember("cleanup_previous_on_success");
        const bool hasRemoteConnection = (*body).isMember("remote_connection_id");
        const bool hasEnvVars = (*body).isMember("env_vars");
        const auto envVars = parseEnvVars(*body);
        const std::string executionMode = toLower(trim((*body).get("execution_mode", "").asString()));
        const std::string remoteConnectionId = trim((*body).get("remote_connection_id", "").asString());
        const std::string remoteRuntimeType = toLower(trim((*body).get("remote_runtime_type", "").asString()));
        const std::string remoteK8sExposure = toLower(trim((*body).get("remote_k8s_exposure", "").asString()));
        const std::string runtimeScheme = toLower(trim((*body).get("runtime_scheme", "").asString()));
        if ((!executionMode.empty() && !isSupportedExecutionMode(executionMode)) ||
            (!remoteRuntimeType.empty() && !isSupportedRuntimeType(remoteRuntimeType)) ||
            (!remoteK8sExposure.empty() && !isSupportedK8sExposure(remoteK8sExposure)) ||
            (!runtimeScheme.empty() && !isSupportedRuntimeScheme(runtimeScheme)) ||
            !remoteConnectionBelongsToUser(txn, remoteConnectionId, userId)) {
            txn.commit();
            Json::Value err; err["error"] = "Invalid environment settings";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp); return;
        }
        auto rows = txn.exec_params(
            "UPDATE project_environments SET "
            "name = COALESCE(NULLIF($1, ''), name), "
            "branch = COALESCE(NULLIF($2, ''), branch), "
            "auto_deploy = CASE WHEN $3 THEN $4::boolean ELSE auto_deploy END, "
            "require_ci = CASE WHEN $5 THEN $6::boolean ELSE require_ci END, "
            "cleanup_previous_on_success = CASE WHEN $7 THEN $8::boolean ELSE cleanup_previous_on_success END, "
            "execution_mode = COALESCE(NULLIF($9, ''), execution_mode), "
            "remote_connection_id = CASE WHEN $10 THEN NULLIF($11, '')::uuid ELSE remote_connection_id END, "
            "remote_runtime_type = COALESCE(NULLIF($12, ''), remote_runtime_type), "
            "remote_k8s_exposure = COALESCE(NULLIF($13, ''), remote_k8s_exposure), "
            "runtime_scheme = COALESCE(NULLIF($14, ''), runtime_scheme), updated_at = NOW() "
            "WHERE id = $15 AND project_id = $16 "
            "RETURNING id, project_id, name, branch, auto_deploy, require_ci, cleanup_previous_on_success, execution_mode, remote_connection_id, remote_runtime_type, remote_k8s_exposure, runtime_scheme, current_deployment_id, NULL::text AS current_deployment_status, NULL::text AS current_deployment_version, NULL::text AS current_commit_sha, NULL::text AS current_runtime_url, updated_at",
            (*body).get("name", "").asString(),
            (*body).get("branch", "").asString(),
            hasAutoDeploy,
            (*body).get("auto_deploy", true).asBool(),
            hasRequireCi,
            (*body).get("require_ci", false).asBool(),
            hasCleanupPrevious,
            (*body).get("cleanup_previous_on_success", false).asBool(),
            executionMode,
            hasRemoteConnection,
            remoteConnectionId,
            remoteRuntimeType,
            remoteK8sExposure,
            runtimeScheme,
            environmentId,
            projectId
        );
        const std::string repoUrl = projectRows[0]["repo_url"].is_null() ? "" : projectRows[0]["repo_url"].as<std::string>();
        const std::string projectToken = projectRows[0]["github_pat"].is_null() ? "" : TokenCrypto::decrypt(projectRows[0]["github_pat"].as<std::string>());
        const std::string userToken = projectRows[0]["github_access_token"].is_null() ? "" : TokenCrypto::decrypt(projectRows[0]["github_access_token"].as<std::string>());
        if (!rows.empty() && hasEnvVars) {
            replaceEnvironmentEnvVars(txn, environmentId, envVars);
        }
        const auto finalEnvVars = rows.empty()
            ? std::vector<std::pair<std::string, std::string>>{}
            : loadEnvironmentEnvVars(txn, environmentId);
        auto refreshedRows = txn.exec_params(
            "SELECT e.id, e.project_id, e.name, e.branch, e.auto_deploy, e.require_ci, e.cleanup_previous_on_success, "
            "e.execution_mode, e.remote_connection_id, e.remote_runtime_type, e.remote_k8s_exposure, e.runtime_scheme, "
            "e.current_deployment_id, d.status AS current_deployment_status, d.version AS current_deployment_version, "
            "d.commit_sha AS current_commit_sha, d.runtime_url AS current_runtime_url, e.updated_at "
            "FROM project_environments e "
            "LEFT JOIN deployments d ON e.current_deployment_id = d.id "
            "WHERE e.id = $1 AND e.project_id = $2",
            environmentId,
            projectId
        );
        txn.commit();
        if (refreshedRows.empty()) {
            Json::Value err; err["error"] = "Environment not found";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp); return;
        }
        const bool autoDeploy = refreshedRows[0]["auto_deploy"].as<bool>();
        Json::Value payload(Json::objectValue);
        payload["environment"] = environmentRowToJson(refreshedRows[0]);
        payload["environment"]["env_vars"] = envVarsToJson(finalEnvVars);
        payload["webhook_warnings"] = maybeRegisterWebhookForEnvironment(repoUrl, projectToken.empty() ? userToken : projectToken, autoDeploy);
        AuditLogger::recordFromRequest(req, userId, "project_environment.updated", "project", projectId, payload["environment"]);
        callback(drogon::HttpResponse::newHttpJsonResponse(payload));
    } catch (const std::exception& e) {
        spdlog::error("Update environment error: {}", e.what());
        Json::Value err; err["error"] = "Unable to update environment";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k400BadRequest);
        callback(resp);
    }
}

void ProjectEnvironmentController::deleteEnvironment(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& projectId,
    const std::string& environmentId
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        Json::Value err; err["error"] = "Unauthorized";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp); return;
    }

    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);
        if (!projectBelongsToUser(txn, projectId, userId)) {
            txn.commit();
            Json::Value err; err["error"] = "Project not found";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp); return;
        }

        auto countRows = txn.exec_params(
            "SELECT COUNT(*)::int AS count FROM project_environments WHERE project_id = $1",
            projectId
        );
        if (!countRows.empty() && countRows[0]["count"].as<int>() <= 1) {
            txn.commit();
            Json::Value err; err["error"] = "A project must keep at least one environment";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k409Conflict);
            callback(resp); return;
        }

        auto deleted = txn.exec_params(
            "DELETE FROM project_environments WHERE id = $1 AND project_id = $2 RETURNING id, name",
            environmentId,
            projectId
        );
        if (deleted.empty()) {
            txn.commit();
            Json::Value err; err["error"] = "Environment not found";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp); return;
        }
        txn.commit();

        Json::Value payload(Json::objectValue);
        payload["message"] = "Environment deleted";
        payload["environment_id"] = environmentId;
        AuditLogger::recordFromRequest(req, userId, "project_environment.deleted", "project", projectId, payload);
        callback(drogon::HttpResponse::newHttpJsonResponse(payload));
    } catch (const std::exception& e) {
        spdlog::error("Delete environment error: {}", e.what());
        Json::Value err; err["error"] = "Unable to delete environment";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k400BadRequest);
        callback(resp);
    }
}

} // namespace stackpilot
