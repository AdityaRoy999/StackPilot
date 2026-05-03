#include "AiController.h"

#include "../db/Database.h"
#include "../services/AiServiceClient.h"
#include "../utils/AiRedaction.h"
#include "../utils/AuditLogger.h"
#include "../utils/JwtHelper.h"

#include <json/json.h>
#include <pqxx/pqxx>
#include <spdlog/spdlog.h>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdlib>
#include <deque>
#include <mutex>
#include <sstream>
#include <string>
#include <unordered_map>

namespace aids {

namespace {

std::string envOrDefault(const char* key, const std::string& fallback) {
    const char* value = std::getenv(key);
    return value && *value ? value : fallback;
}

bool envBool(const char* key, bool fallback) {
    const char* value = std::getenv(key);
    if (!value || !*value) {
        return fallback;
    }
    std::string normalized(value);
    std::transform(normalized.begin(), normalized.end(), normalized.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
    });
    return normalized == "1" || normalized == "true" || normalized == "yes" || normalized == "on";
}

int envInt(const char* key, int fallback) {
    const char* value = std::getenv(key);
    if (!value || !*value) {
        return fallback;
    }
    try {
        return std::stoi(value);
    } catch (...) {
        return fallback;
    }
}

double envDouble(const char* key, double fallback) {
    const char* value = std::getenv(key);
    if (!value || !*value) {
        return fallback;
    }
    try {
        return std::stod(value);
    } catch (...) {
        return fallback;
    }
}

std::size_t maxContextBytes() {
    return static_cast<std::size_t>(std::max(8000, envInt("AIDS_AI_MAX_CONTEXT_BYTES", 32000)));
}

double clampConfidence(double value) {
    return std::max(0.0, std::min(1.0, value));
}

std::string compactJson(const Json::Value& value) {
    Json::StreamWriterBuilder builder;
    builder["indentation"] = "";
    return Json::writeString(builder, value);
}

Json::Value parseJson(const std::string& value) {
    Json::Value parsed;
    if (value.empty()) {
        return parsed;
    }
    Json::CharReaderBuilder builder;
    std::string errors;
    std::istringstream stream(value);
    if (!Json::parseFromStream(builder, stream, &parsed, &errors)) {
        return Json::Value(Json::objectValue);
    }
    return parsed;
}

Json::Value requestBody(const drogon::HttpRequestPtr& req) {
    auto json = req->getJsonObject();
    if (!json) {
        return Json::Value(Json::objectValue);
    }
    return *json;
}

void sendJson(std::function<void(const drogon::HttpResponsePtr&)>& callback,
              const Json::Value& payload,
              drogon::HttpStatusCode status = drogon::k200OK) {
    auto response = drogon::HttpResponse::newHttpJsonResponse(payload);
    response->setStatusCode(status);
    callback(response);
}

void sendError(std::function<void(const drogon::HttpResponsePtr&)>& callback,
               drogon::HttpStatusCode status,
               const std::string& message) {
    Json::Value payload;
    payload["error"] = message;
    sendJson(callback, payload, status);
}

bool validProvider(const std::string& provider) {
    return provider == "nvidia_nim" || provider == "openai_compatible";
}

bool rateLimitAllows(const std::string& userId, Json::Value& error) {
    static std::mutex mutex;
    static std::unordered_map<std::string, std::deque<std::chrono::steady_clock::time_point>> buckets;

    const int limit = std::max(1, envInt("AIDS_AI_RATE_LIMIT_PER_MINUTE", 12));
    const auto now = std::chrono::steady_clock::now();
    const auto window = std::chrono::seconds(60);

    std::lock_guard<std::mutex> lock(mutex);
    auto& bucket = buckets[userId];
    while (!bucket.empty() && now - bucket.front() > window) {
        bucket.pop_front();
    }
    if (static_cast<int>(bucket.size()) >= limit) {
        error["error"] = "AI rate limit exceeded";
        error["limit_per_minute"] = limit;
        return false;
    }
    bucket.push_back(now);
    return true;
}

Json::Value loadPreferences(pqxx::work& txn, const std::string& userId) {
    Json::Value prefs;
    prefs["enabled"] = envBool("AIDS_AI_ENABLED", true);
    prefs["provider"] = envOrDefault("AIDS_AI_PROVIDER", "nvidia_nim");
    prefs["model"] = envOrDefault("AIDS_AI_MODEL", "");
    prefs["openai_compatible_base_url"] = envOrDefault("OPENAI_COMPATIBLE_BASE_URL", "");
    prefs["confidence_threshold"] = clampConfidence(envDouble("AIDS_AI_CONFIDENCE_THRESHOLD", 0.72));
    prefs["history_retention_days"] = 90;

    const auto rows = txn.exec_params(
        "SELECT enabled, provider, model, openai_compatible_base_url, confidence_threshold, history_retention_days "
        "FROM ai_preferences WHERE user_id = $1",
        userId);
    if (!rows.empty()) {
        const auto& row = rows[0];
        prefs["enabled"] = row["enabled"].as<bool>();
        prefs["provider"] = row["provider"].as<std::string>();
        prefs["model"] = row["model"].is_null() ? "" : row["model"].as<std::string>();
        prefs["openai_compatible_base_url"] =
            row["openai_compatible_base_url"].is_null() ? "" : row["openai_compatible_base_url"].as<std::string>();
        prefs["confidence_threshold"] = clampConfidence(row["confidence_threshold"].as<double>());
        prefs["history_retention_days"] = row["history_retention_days"].as<int>();
    }
    return prefs;
}

Json::Value projectContext(pqxx::work& txn, const std::string& userId, const std::string& projectId) {
    const auto rows = txn.exec_params(
        "SELECT p.id, p.name, p.description, p.repo_url, p.status, p.source_type, p.source_path, "
        "p.execution_mode, p.remote_runtime_type, p.remote_k8s_exposure, p.runtime_scheme, p.local_https_enabled, "
        "p.created_at, p.updated_at, "
        "COALESCE((SELECT jsonb_agg(jsonb_build_object('key', key, 'has_value', true) ORDER BY key) "
        "FROM project_env_vars WHERE project_id = p.id), '[]'::jsonb)::text AS env_keys "
        "FROM projects p WHERE p.id = $1 AND p.user_id = $2",
        projectId,
        userId);
    if (rows.empty()) {
        return Json::Value();
    }
    const auto& row = rows[0];
    Json::Value project(Json::objectValue);
    for (const auto& name : {"id", "name", "description", "repo_url", "status", "source_type", "source_path",
                             "execution_mode", "remote_runtime_type", "remote_k8s_exposure", "runtime_scheme",
                             "created_at", "updated_at"}) {
        project[name] = row[name].is_null() ? "" : row[name].as<std::string>();
    }
    project["local_https_enabled"] = row["local_https_enabled"].is_null() ? false : row["local_https_enabled"].as<bool>();
    project["env_keys"] = parseJson(row["env_keys"].as<std::string>());
    return project;
}

Json::Value deploymentContext(pqxx::work& txn, const std::string& userId, const std::string& deploymentId) {
    const auto rows = txn.exec_params(
        "SELECT d.id, d.project_id, d.status, d.version, d.commit_hash, d.logs, d.image_name, "
        "d.runtime_provider, d.runtime_url, d.runtime_exposure, d.remote_container_name, "
        "d.k8s_namespace, d.k8s_deployment_name, d.k8s_service_name, d.k8s_ingress_name, "
        "d.desired_replicas, d.runtime_paused, d.artifact_available, d.artifact_digest, "
        "d.source_snapshot::text AS source_snapshot, d.env_snapshot::text AS env_snapshot, "
        "d.runtime_snapshot::text AS runtime_snapshot, d.remote_runtime_details::text AS remote_runtime_details, "
        "d.created_at, d.updated_at, p.name AS project_name "
        "FROM deployments d JOIN projects p ON p.id = d.project_id "
        "WHERE d.id = $1 AND p.user_id = $2",
        deploymentId,
        userId);
    if (rows.empty()) {
        return Json::Value();
    }
    const auto& row = rows[0];
    Json::Value deployment(Json::objectValue);
    for (const auto& name : {"id", "project_id", "status", "version", "commit_hash", "logs", "image_name",
                             "runtime_provider", "runtime_url", "runtime_exposure", "remote_container_name",
                             "k8s_namespace", "k8s_deployment_name", "k8s_service_name", "k8s_ingress_name",
                             "artifact_digest", "created_at", "updated_at", "project_name"}) {
        deployment[name] = row[name].is_null() ? "" : row[name].as<std::string>();
    }
    deployment["desired_replicas"] = row["desired_replicas"].is_null() ? 0 : row["desired_replicas"].as<int>();
    deployment["runtime_paused"] = row["runtime_paused"].is_null() ? false : row["runtime_paused"].as<bool>();
    deployment["artifact_available"] = row["artifact_available"].is_null() ? false : row["artifact_available"].as<bool>();
    deployment["source_snapshot"] = parseJson(row["source_snapshot"].is_null() ? "" : row["source_snapshot"].as<std::string>());
    deployment["env_snapshot"] = parseJson(row["env_snapshot"].is_null() ? "" : row["env_snapshot"].as<std::string>());
    deployment["runtime_snapshot"] = parseJson(row["runtime_snapshot"].is_null() ? "" : row["runtime_snapshot"].as<std::string>());
    deployment["remote_runtime_details"] =
        parseJson(row["remote_runtime_details"].is_null() ? "" : row["remote_runtime_details"].as<std::string>());
    return deployment;
}

std::string insertAiRun(pqxx::work& txn,
                        const std::string& userId,
                        const std::string& workflow,
                        const Json::Value& request,
                        const Json::Value& response,
                        const std::string& error) {
    const Json::Value tokenUsage = response.isMember("token_usage") ? response["token_usage"] : Json::Value(Json::objectValue);
    const bool responseFailed = response.isMember("status") && response["status"].asString() == "error";
    const std::string status = (!error.empty() || responseFailed) ? "failed" : "completed";
    const double confidence = response.isMember("confidence") ? clampConfidence(response["confidence"].asDouble()) : 0.0;
    const auto rows = txn.exec_params(
        "INSERT INTO ai_runs "
        "(user_id, workflow_type, provider, model, status, confidence, summary, warnings, request_redacted, "
        "response_payload, trace_id, latency_ms, prompt_tokens, completion_tokens, total_tokens, error) "
        "VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13, $14, $15, $16) "
        "RETURNING id",
        userId,
        workflow,
        response.isMember("provider") ? response["provider"].asString() : envOrDefault("AIDS_AI_PROVIDER", "nvidia_nim"),
        response.isMember("model") ? response["model"].asString() : "",
        status,
        confidence,
        response.isMember("summary") ? response["summary"].asString() : "",
        compactJson(response.isMember("warnings") ? response["warnings"] : Json::Value(Json::arrayValue)),
        compactJson(request),
        compactJson(response),
        response.isMember("trace_id") ? response["trace_id"].asString() : "",
        response.isMember("latency_ms") ? response["latency_ms"].asInt() : 0,
        tokenUsage.isMember("prompt_tokens") ? tokenUsage["prompt_tokens"].asInt() : 0,
        tokenUsage.isMember("completion_tokens") ? tokenUsage["completion_tokens"].asInt() : 0,
        tokenUsage.isMember("total_tokens") ? tokenUsage["total_tokens"].asInt() : 0,
        error);
    return rows[0][0].as<std::string>();
}

void linkAiRun(pqxx::work& txn,
               const std::string& runId,
               const std::string& projectId,
               const std::string& deploymentId,
               const std::string& jobId = "") {
    txn.exec_params(
        "INSERT INTO ai_run_links (run_id, project_id, deployment_id, job_id) "
        "VALUES ($1, NULLIF($2, '')::uuid, NULLIF($3, '')::uuid, $4)",
        runId,
        projectId,
        deploymentId,
        jobId);
}

void storeArtifacts(pqxx::work& txn, const std::string& runId, const Json::Value& response) {
    const Json::Value output = response.isMember("structured_output") ? response["structured_output"] : Json::Value(Json::objectValue);
    if (output.isMember("dockerfile") && output["dockerfile"].isString()) {
        Json::Value metadata(Json::objectValue);
        metadata["source"] = "ai";
        txn.exec_params(
            "INSERT INTO ai_artifacts (run_id, artifact_type, title, content, metadata) "
            "VALUES ($1, 'dockerfile', 'Generated Dockerfile', $2, $3::jsonb)",
            runId,
            output["dockerfile"].asString(),
            compactJson(metadata));
    }
    if (output.isMember("commands") || output.isMember("steps") || output.isMember("fix_steps")) {
        txn.exec_params(
            "INSERT INTO ai_artifacts (run_id, artifact_type, title, content, metadata) "
            "VALUES ($1, 'plan', 'AI plan', $2, '{}'::jsonb)",
            runId,
            compactJson(output));
    }
}

Json::Value runWorkflow(const std::string& path, const Json::Value& payload) {
    const auto result = AiServiceClient::instance().postWorkflow(path, payload);
    Json::Value body = result.body;
    if (!result.ok) {
        body["status"] = "error";
        body["error"] = result.error.empty() ? "AI service request failed" : result.error;
        body["http_status"] = static_cast<Json::Int64>(result.statusCode);
    }
    return body;
}

Json::Value buildPayload(const Json::Value& prefs,
                         const Json::Value& body,
                         const Json::Value& project,
                         const Json::Value& deployment = Json::Value()) {
    Json::Value payload(Json::objectValue);
    payload["provider"] = prefs["provider"];
    payload["model"] = body.isMember("model") ? body["model"].asString() : prefs["model"].asString();
    payload["confidence_threshold"] = prefs["confidence_threshold"];
    payload["ai_mode"] = body.isMember("ai_mode") ? body["ai_mode"].asString() : "explicit";
    payload["project"] = project;
    if (!deployment.isNull()) {
        payload["deployment"] = deployment;
        payload["logs"] = deployment.isMember("logs") ? deployment["logs"].asString() : "";
    }
    if (body.isMember("file_tree")) {
        payload["file_tree"] = body["file_tree"];
    }
    if (body.isMember("manifest_excerpts")) {
        payload["manifest_excerpts"] = body["manifest_excerpts"];
    }
    if (body.isMember("message")) {
        payload["message"] = body["message"];
    }
    if (body.isMember("model_mode")) {
        payload["model_mode"] = body["model_mode"];
    }
    if (body.isMember("command")) {
        payload["command"] = body["command"];
    }
    if (body.isMember("runtime")) {
        payload["runtime"] = body["runtime"];
    }
    return AiRedaction::redactJson(payload, maxContextBytes());
}

} // namespace

std::string AiController::extractUserId(const drogon::HttpRequestPtr& req) const {
    Json::Value payload = JwtHelper::verifyRequestToken(req);
    if (payload.isNull() || !payload.isMember("user_id")) {
        return "";
    }
    return payload["user_id"].asString();
}

void AiController::health(const drogon::HttpRequestPtr& req,
                          std::function<void(const drogon::HttpResponsePtr&)>&& callback) {
    if (extractUserId(req).empty()) {
        sendError(callback, drogon::k401Unauthorized, "Unauthorized");
        return;
    }

    Json::Value payload;
    const auto result = AiServiceClient::instance().health();
    payload["configured"] = envBool("AIDS_AI_ENABLED", true);
    payload["provider"] = envOrDefault("AIDS_AI_PROVIDER", "nvidia_nim");
    payload["model"] = envOrDefault("AIDS_AI_MODEL", envOrDefault("NVIDIA_NIM_MODEL", ""));
    payload["service_ok"] = result.ok;
    payload["service"] = result.body;
    if (!result.error.empty()) {
        payload["error"] = result.error;
    }
    sendJson(callback, payload, result.ok ? drogon::k200OK : drogon::k503ServiceUnavailable);
}

void AiController::getSettings(const drogon::HttpRequestPtr& req,
                               std::function<void(const drogon::HttpResponsePtr&)>&& callback) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        sendError(callback, drogon::k401Unauthorized, "Unauthorized");
        return;
    }

    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);
        Json::Value payload = loadPreferences(txn, userId);
        txn.commit();
        payload["has_nvidia_key"] = envOrDefault("NVIDIA_API_KEY", "").empty() && envOrDefault("NVIDIA_NIM_API_KEY", "").empty()
                                        ? false
                                        : true;
        payload["has_openai_compatible_key"] = !envOrDefault("OPENAI_COMPATIBLE_API_KEY", "").empty();
        sendJson(callback, payload);
    } catch (const std::exception& e) {
        spdlog::error("AI settings load failed: {}", e.what());
        sendError(callback, drogon::k500InternalServerError, "Failed to load AI settings");
    }
}

void AiController::updateSettings(const drogon::HttpRequestPtr& req,
                                  std::function<void(const drogon::HttpResponsePtr&)>&& callback) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        sendError(callback, drogon::k401Unauthorized, "Unauthorized");
        return;
    }

    const Json::Value body = requestBody(req);
    const std::string provider = body.isMember("provider") ? body["provider"].asString() : "nvidia_nim";
    if (!validProvider(provider)) {
        sendError(callback, drogon::k400BadRequest, "Unsupported AI provider");
        return;
    }

    const bool enabled = body.isMember("enabled") ? body["enabled"].asBool() : true;
    const std::string model = body.isMember("model") ? body["model"].asString() : "";
    const std::string baseUrl = body.isMember("openai_compatible_base_url") ? body["openai_compatible_base_url"].asString() : "";
    const double threshold = body.isMember("confidence_threshold")
                                 ? clampConfidence(body["confidence_threshold"].asDouble())
                                 : clampConfidence(envDouble("AIDS_AI_CONFIDENCE_THRESHOLD", 0.72));
    const int retentionDays = body.isMember("history_retention_days")
                                  ? std::max(1, std::min(3650, body["history_retention_days"].asInt()))
                                  : 90;

    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);
        txn.exec_params(
            "INSERT INTO ai_preferences "
            "(user_id, enabled, provider, model, openai_compatible_base_url, confidence_threshold, history_retention_days) "
            "VALUES ($1, $2, $3, NULLIF($4, ''), NULLIF($5, ''), $6, $7) "
            "ON CONFLICT (user_id) DO UPDATE SET "
            "enabled = EXCLUDED.enabled, provider = EXCLUDED.provider, model = EXCLUDED.model, "
            "openai_compatible_base_url = EXCLUDED.openai_compatible_base_url, "
            "confidence_threshold = EXCLUDED.confidence_threshold, history_retention_days = EXCLUDED.history_retention_days, "
            "updated_at = NOW()",
            userId,
            enabled,
            provider,
            model,
            baseUrl,
            threshold,
            retentionDays);
        txn.commit();

        Json::Value audit;
        audit["provider"] = provider;
        audit["enabled"] = enabled;
        AuditLogger::recordFromRequest(req, userId, "ai.preferences.updated", "ai_preferences", userId, audit);

        Json::Value payload;
        payload["success"] = true;
        sendJson(callback, payload);
    } catch (const std::exception& e) {
        spdlog::error("AI settings update failed: {}", e.what());
        sendError(callback, drogon::k500InternalServerError, "Failed to update AI settings");
    }
}

void AiController::listModels(const drogon::HttpRequestPtr& req,
                              std::function<void(const drogon::HttpResponsePtr&)>&& callback) {
    if (extractUserId(req).empty()) {
        sendError(callback, drogon::k401Unauthorized, "Unauthorized");
        return;
    }

    Json::Value payload;
    const auto result = AiServiceClient::instance().get("/models");
    payload = result.body;
    if (!result.ok) {
        payload["status"] = "error";
        payload["error"] = result.error.empty() ? "AI model catalog request failed" : result.error;
    }
    sendJson(callback, payload, result.ok ? drogon::k200OK : drogon::k503ServiceUnavailable);
}

void AiController::chatAgent(const drogon::HttpRequestPtr& req,
                             std::function<void(const drogon::HttpResponsePtr&)>&& callback) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        sendError(callback, drogon::k401Unauthorized, "Unauthorized");
        return;
    }

    Json::Value body = requestBody(req);
    if (!body.isMember("message") || body["message"].asString().empty()) {
        sendError(callback, drogon::k400BadRequest, "message is required");
        return;
    }

    Json::Value limited;
    if (!rateLimitAllows(userId, limited)) {
        sendJson(callback, limited, drogon::k429TooManyRequests);
        return;
    }

    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);
        Json::Value prefs = loadPreferences(txn, userId);
        if (!prefs["enabled"].asBool()) {
            sendError(callback, drogon::k403Forbidden, "AI is disabled");
            return;
        }

        Json::Value project(Json::objectValue);
        Json::Value deployment(Json::objectValue);
        std::string projectId = body.isMember("project_id") ? body["project_id"].asString() : "";
        const std::string deploymentId = body.isMember("deployment_id") ? body["deployment_id"].asString() : "";

        if (!deploymentId.empty()) {
            deployment = deploymentContext(txn, userId, deploymentId);
            if (deployment.isNull()) {
                sendError(callback, drogon::k404NotFound, "Deployment not found");
                return;
            }
            projectId = deployment["project_id"].asString();
        }

        if (!projectId.empty()) {
            project = projectContext(txn, userId, projectId);
            if (project.isNull()) {
                sendError(callback, drogon::k404NotFound, "Project not found");
                return;
            }
        }

        Json::Value payload = buildPayload(prefs, body, project, deployment);
        Json::Value result = runWorkflow("/chat/agent", payload);
        const std::string runId = insertAiRun(txn, userId, "agent_chat", payload, result,
                                              result.isMember("error") ? result["error"].asString() : "");
        linkAiRun(txn, runId, projectId, deploymentId);
        storeArtifacts(txn, runId, result);
        txn.commit();

        Json::Value audit;
        audit["run_id"] = runId;
        audit["command"] = body.isMember("command") ? body["command"].asString() : "";
        AuditLogger::recordFromRequest(req, userId, "ai.agent.chat", "ai", runId, audit);

        result["run_id"] = runId;
        sendJson(callback, result);
    } catch (const std::exception& e) {
        spdlog::error("AI agent chat failed: {}", e.what());
        sendError(callback, drogon::k500InternalServerError, "AI agent chat failed");
    }
}

void AiController::listRuns(const drogon::HttpRequestPtr& req,
                            std::function<void(const drogon::HttpResponsePtr&)>&& callback) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        sendError(callback, drogon::k401Unauthorized, "Unauthorized");
        return;
    }

    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);
        const auto rows = txn.exec_params(
            "SELECT r.id, r.workflow_type, r.provider, r.model, r.status, r.confidence, r.summary, r.trace_id, "
            "r.latency_ms, r.created_at, l.project_id, l.deployment_id "
            "FROM ai_runs r LEFT JOIN ai_run_links l ON l.run_id = r.id "
            "WHERE r.user_id = $1 ORDER BY r.created_at DESC LIMIT 50",
            userId);
        Json::Value runs(Json::arrayValue);
        for (const auto& row : rows) {
            Json::Value run(Json::objectValue);
            for (const auto& name : {"id", "workflow_type", "provider", "model", "status", "summary", "trace_id",
                                     "created_at", "project_id", "deployment_id"}) {
                run[name] = row[name].is_null() ? "" : row[name].as<std::string>();
            }
            run["confidence"] = row["confidence"].as<double>();
            run["latency_ms"] = row["latency_ms"].as<int>();
            runs.append(run);
        }
        txn.commit();
        Json::Value payload;
        payload["runs"] = runs;
        sendJson(callback, payload);
    } catch (const std::exception& e) {
        spdlog::error("AI runs list failed: {}", e.what());
        sendError(callback, drogon::k500InternalServerError, "Failed to list AI runs");
    }
}

void AiController::listProjectRuns(const drogon::HttpRequestPtr& req,
                                   std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                                   const std::string& projectId) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        sendError(callback, drogon::k401Unauthorized, "Unauthorized");
        return;
    }

    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);
        if (projectContext(txn, userId, projectId).isNull()) {
            sendError(callback, drogon::k404NotFound, "Project not found");
            return;
        }
        const auto rows = txn.exec_params(
            "SELECT r.id, r.workflow_type, r.provider, r.model, r.status, r.confidence, r.summary, r.trace_id, "
            "r.latency_ms, r.created_at, l.deployment_id "
            "FROM ai_runs r JOIN ai_run_links l ON l.run_id = r.id "
            "WHERE r.user_id = $1 AND l.project_id = $2 ORDER BY r.created_at DESC LIMIT 50",
            userId,
            projectId);
        Json::Value runs(Json::arrayValue);
        for (const auto& row : rows) {
            Json::Value run(Json::objectValue);
            for (const auto& name : {"id", "workflow_type", "provider", "model", "status", "summary", "trace_id",
                                     "created_at", "deployment_id"}) {
                run[name] = row[name].is_null() ? "" : row[name].as<std::string>();
            }
            run["confidence"] = row["confidence"].as<double>();
            run["latency_ms"] = row["latency_ms"].as<int>();
            runs.append(run);
        }
        txn.commit();
        Json::Value payload;
        payload["runs"] = runs;
        sendJson(callback, payload);
    } catch (const std::exception& e) {
        spdlog::error("AI project runs list failed: {}", e.what());
        sendError(callback, drogon::k500InternalServerError, "Failed to list project AI runs");
    }
}

void AiController::analyzeProject(const drogon::HttpRequestPtr& req,
                                  std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                                  const std::string& projectId) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        sendError(callback, drogon::k401Unauthorized, "Unauthorized");
        return;
    }
    Json::Value limited;
    if (!rateLimitAllows(userId, limited)) {
        sendJson(callback, limited, drogon::k429TooManyRequests);
        return;
    }

    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);
        Json::Value prefs = loadPreferences(txn, userId);
        if (!prefs["enabled"].asBool()) {
            sendError(callback, drogon::k403Forbidden, "AI is disabled");
            return;
        }
        Json::Value project = projectContext(txn, userId, projectId);
        if (project.isNull()) {
            sendError(callback, drogon::k404NotFound, "Project not found");
            return;
        }
        Json::Value payload = buildPayload(prefs, requestBody(req), project);
        Json::Value result = runWorkflow("/analyze/project", payload);
        const std::string runId = insertAiRun(txn, userId, "project_analysis", payload, result,
                                              result.isMember("error") ? result["error"].asString() : "");
        linkAiRun(txn, runId, projectId, "");
        storeArtifacts(txn, runId, result);
        txn.commit();

        Json::Value audit;
        audit["run_id"] = runId;
        audit["trace_id"] = result.isMember("trace_id") ? result["trace_id"].asString() : "";
        AuditLogger::recordFromRequest(req, userId, "ai.project.analyzed", "project", projectId, audit);

        result["run_id"] = runId;
        sendJson(callback, result);
    } catch (const std::exception& e) {
        spdlog::error("AI project analysis failed: {}", e.what());
        sendError(callback, drogon::k500InternalServerError, "AI project analysis failed");
    }
}

void AiController::generateDockerfile(const drogon::HttpRequestPtr& req,
                                      std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                                      const std::string& projectId) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        sendError(callback, drogon::k401Unauthorized, "Unauthorized");
        return;
    }
    Json::Value limited;
    if (!rateLimitAllows(userId, limited)) {
        sendJson(callback, limited, drogon::k429TooManyRequests);
        return;
    }

    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);
        Json::Value prefs = loadPreferences(txn, userId);
        if (!prefs["enabled"].asBool()) {
            sendError(callback, drogon::k403Forbidden, "AI is disabled");
            return;
        }
        Json::Value project = projectContext(txn, userId, projectId);
        if (project.isNull()) {
            sendError(callback, drogon::k404NotFound, "Project not found");
            return;
        }
        Json::Value payload = buildPayload(prefs, requestBody(req), project);
        Json::Value result = runWorkflow("/generate/dockerfile", payload);
        const std::string runId = insertAiRun(txn, userId, "dockerfile_generation", payload, result,
                                              result.isMember("error") ? result["error"].asString() : "");
        linkAiRun(txn, runId, projectId, "");
        storeArtifacts(txn, runId, result);
        txn.commit();

        Json::Value audit;
        audit["run_id"] = runId;
        AuditLogger::recordFromRequest(req, userId, "ai.dockerfile.generated", "project", projectId, audit);

        result["run_id"] = runId;
        sendJson(callback, result);
    } catch (const std::exception& e) {
        spdlog::error("AI Dockerfile generation failed: {}", e.what());
        sendError(callback, drogon::k500InternalServerError, "AI Dockerfile generation failed");
    }
}

void AiController::chatProject(const drogon::HttpRequestPtr& req,
                               std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                               const std::string& projectId) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        sendError(callback, drogon::k401Unauthorized, "Unauthorized");
        return;
    }
    Json::Value body = requestBody(req);
    if (!body.isMember("message") || body["message"].asString().empty()) {
        sendError(callback, drogon::k400BadRequest, "message is required");
        return;
    }
    Json::Value limited;
    if (!rateLimitAllows(userId, limited)) {
        sendJson(callback, limited, drogon::k429TooManyRequests);
        return;
    }

    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);
        Json::Value prefs = loadPreferences(txn, userId);
        if (!prefs["enabled"].asBool()) {
            sendError(callback, drogon::k403Forbidden, "AI is disabled");
            return;
        }
        Json::Value project = projectContext(txn, userId, projectId);
        if (project.isNull()) {
            sendError(callback, drogon::k404NotFound, "Project not found");
            return;
        }

        std::string sessionId = body.isMember("session_id") ? body["session_id"].asString() : "";
        if (!sessionId.empty()) {
            const auto sessions = txn.exec_params(
                "SELECT id FROM ai_sessions WHERE id = $1 AND user_id = $2 AND project_id = $3",
                sessionId,
                userId,
                projectId);
            if (sessions.empty()) {
                sendError(callback, drogon::k404NotFound, "AI session not found");
                return;
            }
        } else {
            const auto rows = txn.exec_params(
                "INSERT INTO ai_sessions (user_id, project_id, title, session_type) "
                "VALUES ($1, $2, 'Project AI Chat', 'project_chat') RETURNING id",
                userId,
                projectId);
            sessionId = rows[0][0].as<std::string>();
        }

        const std::string userMessage = AiRedaction::redactText(body["message"].asString(), maxContextBytes());
        txn.exec_params("INSERT INTO ai_messages (session_id, role, content) VALUES ($1, 'user', $2)",
                        sessionId,
                        userMessage);

        Json::Value payload = buildPayload(prefs, body, project);
        payload["session_id"] = sessionId;
        Json::Value result = runWorkflow("/chat/project", payload);
        const std::string runId = insertAiRun(txn, userId, "project_chat", payload, result,
                                              result.isMember("error") ? result["error"].asString() : "");
        linkAiRun(txn, runId, projectId, "");
        storeArtifacts(txn, runId, result);

        const std::string assistantMessage = result.isMember("summary") ? result["summary"].asString() : compactJson(result);
        Json::Value messageMeta;
        messageMeta["run_id"] = runId;
        txn.exec_params("INSERT INTO ai_messages (session_id, role, content, metadata) VALUES ($1, 'assistant', $2, $3::jsonb)",
                        sessionId,
                        assistantMessage,
                        compactJson(messageMeta));
        txn.exec_params("UPDATE ai_sessions SET updated_at = NOW() WHERE id = $1", sessionId);
        txn.commit();

        Json::Value audit;
        audit["run_id"] = runId;
        audit["session_id"] = sessionId;
        AuditLogger::recordFromRequest(req, userId, "ai.project.chat", "project", projectId, audit);

        result["run_id"] = runId;
        result["session_id"] = sessionId;
        sendJson(callback, result);
    } catch (const std::exception& e) {
        spdlog::error("AI project chat failed: {}", e.what());
        sendError(callback, drogon::k500InternalServerError, "AI project chat failed");
    }
}

void AiController::analyzeBuildFailure(const drogon::HttpRequestPtr& req,
                                       std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                                       const std::string& deploymentId) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        sendError(callback, drogon::k401Unauthorized, "Unauthorized");
        return;
    }
    Json::Value limited;
    if (!rateLimitAllows(userId, limited)) {
        sendJson(callback, limited, drogon::k429TooManyRequests);
        return;
    }

    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);
        Json::Value prefs = loadPreferences(txn, userId);
        if (!prefs["enabled"].asBool()) {
            sendError(callback, drogon::k403Forbidden, "AI is disabled");
            return;
        }
        Json::Value deployment = deploymentContext(txn, userId, deploymentId);
        if (deployment.isNull()) {
            sendError(callback, drogon::k404NotFound, "Deployment not found");
            return;
        }
        Json::Value project = projectContext(txn, userId, deployment["project_id"].asString());
        Json::Value payload = buildPayload(prefs, requestBody(req), project, deployment);
        Json::Value result = runWorkflow("/analyze/build-failure", payload);
        const std::string runId = insertAiRun(txn, userId, "build_failure_analysis", payload, result,
                                              result.isMember("error") ? result["error"].asString() : "");
        linkAiRun(txn, runId, deployment["project_id"].asString(), deploymentId);
        storeArtifacts(txn, runId, result);
        txn.commit();

        Json::Value audit;
        audit["run_id"] = runId;
        AuditLogger::recordFromRequest(req, userId, "ai.build_failure.analyzed", "deployment", deploymentId, audit);

        result["run_id"] = runId;
        sendJson(callback, result);
    } catch (const std::exception& e) {
        spdlog::error("AI build failure analysis failed: {}", e.what());
        sendError(callback, drogon::k500InternalServerError, "AI build failure analysis failed");
    }
}

void AiController::analyzeRuntimeFailure(const drogon::HttpRequestPtr& req,
                                         std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                                         const std::string& deploymentId) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        sendError(callback, drogon::k401Unauthorized, "Unauthorized");
        return;
    }
    Json::Value limited;
    if (!rateLimitAllows(userId, limited)) {
        sendJson(callback, limited, drogon::k429TooManyRequests);
        return;
    }

    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);
        Json::Value prefs = loadPreferences(txn, userId);
        if (!prefs["enabled"].asBool()) {
            sendError(callback, drogon::k403Forbidden, "AI is disabled");
            return;
        }
        Json::Value deployment = deploymentContext(txn, userId, deploymentId);
        if (deployment.isNull()) {
            sendError(callback, drogon::k404NotFound, "Deployment not found");
            return;
        }
        Json::Value project = projectContext(txn, userId, deployment["project_id"].asString());
        Json::Value payload = buildPayload(prefs, requestBody(req), project, deployment);
        Json::Value result = runWorkflow("/analyze/runtime-failure", payload);
        const std::string runId = insertAiRun(txn, userId, "runtime_troubleshooting", payload, result,
                                              result.isMember("error") ? result["error"].asString() : "");
        linkAiRun(txn, runId, deployment["project_id"].asString(), deploymentId);
        storeArtifacts(txn, runId, result);
        txn.commit();

        Json::Value audit;
        audit["run_id"] = runId;
        AuditLogger::recordFromRequest(req, userId, "ai.runtime_failure.analyzed", "deployment", deploymentId, audit);

        result["run_id"] = runId;
        sendJson(callback, result);
    } catch (const std::exception& e) {
        spdlog::error("AI runtime failure analysis failed: {}", e.what());
        sendError(callback, drogon::k500InternalServerError, "AI runtime failure analysis failed");
    }
}

} // namespace aids
