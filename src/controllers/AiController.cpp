#include "AiController.h"

#include "../db/Database.h"
#include "../services/AiServiceClient.h"
#include "../utils/AiRedaction.h"
#include "../utils/AuditLogger.h"
#include "../utils/JwtHelper.h"
#include "../utils/TokenCrypto.h"

#include <json/json.h>
#include <pqxx/pqxx>
#include <spdlog/spdlog.h>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <deque>
#include <iomanip>
#include <mutex>
#include <sstream>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace stackpilot {

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
    return static_cast<std::size_t>(std::max(8000, envInt("STACKPILOT_AI_MAX_CONTEXT_BYTES", 32000)));
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

std::string trimText(const std::string& value) {
    const auto begin = std::find_if_not(value.begin(), value.end(), [](unsigned char c) { return std::isspace(c); });
    const auto end = std::find_if_not(value.rbegin(), value.rend(), [](unsigned char c) { return std::isspace(c); }).base();
    if (begin >= end) {
        return "";
    }
    return std::string(begin, end);
}

std::string chatTitleFromMessage(const std::string& message) {
    std::string title = trimText(message);
    title.erase(std::remove(title.begin(), title.end(), '\n'), title.end());
    title.erase(std::remove(title.begin(), title.end(), '\r'), title.end());
    if (title.size() > 72) {
        title = title.substr(0, 69) + "...";
    }
    return title.empty() ? "New AI chat" : title;
}

std::string lowerText(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
    });
    return value;
}

std::string hostFromUrl(const std::string& url) {
    const auto schemeEnd = url.find("://");
    if (schemeEnd == std::string::npos) {
        return "";
    }
    auto hostStart = schemeEnd + 3;
    const auto at = url.find('@', hostStart);
    if (at != std::string::npos) {
        hostStart = at + 1;
    }
    const auto hostEnd = url.find_first_of(":/?#", hostStart);
    std::string host = url.substr(hostStart, hostEnd == std::string::npos ? std::string::npos : hostEnd - hostStart);
    if (host.size() >= 2 && host.front() == '[' && host.back() == ']') {
        host = host.substr(1, host.size() - 2);
    }
    return lowerText(host);
}

bool isBlockedProviderHost(const std::string& host) {
    if (host.empty()) {
        return true;
    }
    static const std::unordered_set<std::string> exact = {
        "localhost",
        "metadata.google.internal",
        "host.docker.internal",
        "kubernetes.default",
        "kubernetes.default.svc"
    };
    if (exact.count(host) > 0) {
        return true;
    }
    if (host == "::1" || host == "0.0.0.0" || host.rfind("127.", 0) == 0 ||
        host.rfind("10.", 0) == 0 || host.rfind("192.168.", 0) == 0 ||
        host.rfind("169.254.", 0) == 0 || host.rfind("172.16.", 0) == 0 ||
        host.rfind("172.17.", 0) == 0 || host.rfind("172.18.", 0) == 0 ||
        host.rfind("172.19.", 0) == 0 || host.rfind("172.2", 0) == 0 ||
        host.rfind("172.30.", 0) == 0 || host.rfind("172.31.", 0) == 0) {
        return true;
    }
    return false;
}

bool validOpenAiCompatibleBaseUrl(const std::string& url) {
    if (url.empty()) {
        return true;
    }
    const std::string normalized = lowerText(trimText(url));
    if (normalized.rfind("https://", 0) != 0) {
        return false;
    }
    return !isBlockedProviderHost(hostFromUrl(normalized));
}

std::string clipText(const std::string& value, std::size_t limit) {
    if (value.size() <= limit) {
        return value;
    }
    return value.substr(value.size() - limit);
}

Json::Value sessionMemory(const std::string& summary, const std::string& graphText) {
    Json::Value memory(Json::objectValue);
    memory["summary"] = summary;
    Json::Value graph = parseJson(graphText);
    memory["graph"] = graph.isObject() ? graph : Json::Value(Json::objectValue);
    return memory;
}

Json::Value buildHistory(const pqxx::result& rows) {
    Json::Value history(Json::arrayValue);
    for (const auto& row : rows) {
        Json::Value message(Json::objectValue);
        message["role"] = row["role"].as<std::string>();
        message["content"] = row["content"].as<std::string>();
        history.append(message);
    }
    return history;
}

Json::Value updateMemoryGraph(Json::Value graph, const std::string& userMessage, const std::string& assistantMessage) {
    if (!graph.isObject()) {
        graph = Json::Value(Json::objectValue);
    }
    graph["last_user_request"] = clipText(userMessage, 1000);
    graph["last_assistant_response"] = clipText(assistantMessage, 1000);

    std::string lower = userMessage;
    std::transform(lower.begin(), lower.end(), lower.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
    });
    const bool looksLikePreference =
        lower.find("remember") != std::string::npos ||
        lower.find("prefer") != std::string::npos ||
        lower.find("always") != std::string::npos ||
        lower.find("my ") != std::string::npos;
    if (looksLikePreference) {
        Json::Value preferences = graph.isMember("preferences") && graph["preferences"].isArray()
                                      ? graph["preferences"]
                                      : Json::Value(Json::arrayValue);
        preferences.append(clipText(userMessage, 500));
        while (preferences.size() > 24) {
            Json::Value trimmed(Json::arrayValue);
            for (Json::ArrayIndex i = 1; i < preferences.size(); ++i) {
                trimmed.append(preferences[i]);
            }
            preferences = trimmed;
        }
        graph["preferences"] = preferences;
    }
    return graph;
}

std::string updateMemorySummary(const std::string& current,
                                const std::string& userMessage,
                                const std::string& assistantMessage) {
    std::ostringstream next;
    if (!current.empty()) {
        next << current << "\n";
    }
    next << "User: " << clipText(userMessage, 700) << "\n";
    next << "Assistant: " << clipText(assistantMessage, 700);
    return clipText(next.str(), 6000);
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

    const int limit = std::max(1, envInt("STACKPILOT_AI_RATE_LIMIT_PER_MINUTE", 12));
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
    prefs["enabled"] = envBool("STACKPILOT_AI_ENABLED", true);
    prefs["provider"] = envOrDefault("STACKPILOT_AI_PROVIDER", "nvidia_nim");
    prefs["model"] = envOrDefault("STACKPILOT_AI_MODEL", "");
    prefs["openai_compatible_base_url"] = envOrDefault("OPENAI_COMPATIBLE_BASE_URL", "");
    prefs["openai_compatible_api_key"] = envOrDefault("OPENAI_COMPATIBLE_API_KEY", "");
    prefs["confidence_threshold"] = clampConfidence(envDouble("STACKPILOT_AI_CONFIDENCE_THRESHOLD", 0.72));
    prefs["history_retention_days"] = 90;

    const auto rows = txn.exec_params(
        "SELECT enabled, provider, model, openai_compatible_base_url, openai_compatible_api_key, "
        "confidence_threshold, history_retention_days "
        "FROM ai_preferences WHERE user_id = $1",
        userId);
    if (!rows.empty()) {
        const auto& row = rows[0];
        prefs["enabled"] = row["enabled"].as<bool>();
        prefs["provider"] = row["provider"].as<std::string>();
        prefs["model"] = row["model"].is_null() ? "" : row["model"].as<std::string>();
        prefs["openai_compatible_base_url"] =
            row["openai_compatible_base_url"].is_null() ? "" : row["openai_compatible_base_url"].as<std::string>();
        prefs["openai_compatible_api_key"] =
            row["openai_compatible_api_key"].is_null() ? envOrDefault("OPENAI_COMPATIBLE_API_KEY", "")
                                                       : TokenCrypto::decrypt(row["openai_compatible_api_key"].as<std::string>());
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
        response.isMember("provider") ? response["provider"].asString() : envOrDefault("STACKPILOT_AI_PROVIDER", "nvidia_nim"),
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

Json::Value providerOverrides(const Json::Value& prefs) {
    Json::Value overrides(Json::objectValue);
    if (prefs.isMember("provider") && prefs["provider"].asString() == "openai_compatible") {
        if (prefs.isMember("openai_compatible_base_url") && !prefs["openai_compatible_base_url"].asString().empty()) {
            overrides["base_url"] = prefs["openai_compatible_base_url"].asString();
        }
        if (prefs.isMember("openai_compatible_api_key") && !prefs["openai_compatible_api_key"].asString().empty()) {
            overrides["api_key"] = prefs["openai_compatible_api_key"].asString();
        }
    }
    return overrides;
}

Json::Value runWorkflow(const std::string& path, const Json::Value& payload, const Json::Value& overrides);

int embeddingDimensions() {
    return 384;
}

std::string vectorLiteral(const Json::Value& embedding) {
    std::ostringstream out;
    out << "[";
    for (Json::ArrayIndex i = 0; i < embedding.size(); ++i) {
        if (i > 0) {
            out << ",";
        }
        out << std::setprecision(9) << embedding[i].asDouble();
    }
    out << "]";
    return out.str();
}

Json::Value embeddingForText(const Json::Value& prefs, const std::string& text) {
    Json::Value payload(Json::objectValue);
    payload["provider"] = prefs["provider"];
    payload["dimensions"] = embeddingDimensions();
    payload["texts"] = Json::Value(Json::arrayValue);
    payload["texts"].append(AiRedaction::redactText(text, maxContextBytes()));
    Json::Value result = runWorkflow("/embeddings", payload, providerOverrides(prefs));
    if (!result.isObject() || !result.isMember("embeddings") || !result["embeddings"].isArray() ||
        result["embeddings"].empty() || !result["embeddings"][0].isArray()) {
        return Json::Value(Json::arrayValue);
    }
    return result["embeddings"][0];
}

Json::Value retrieveSemanticMemories(pqxx::work& txn,
                                     const std::string& userId,
                                     const std::string& sessionId,
                                     const Json::Value& embedding) {
    Json::Value memories(Json::arrayValue);
    if (!embedding.isArray() || embedding.empty()) {
        return memories;
    }
    try {
        const auto rows = txn.exec_params(
            "SELECT content, metadata::text, session_id::text, memory_type, similarity FROM ("
            "  SELECT content, metadata, session_id, memory_type, (1 - (embedding <=> $2::vector)) AS similarity "
            "  FROM ai_memory_chunks "
            "  WHERE user_id = $1 AND ($3 = '' OR session_id = $3::uuid OR session_id IS NULL)"
            ") ranked "
            "WHERE similarity >= 0.22 "
            "ORDER BY similarity DESC LIMIT 8",
            userId,
            vectorLiteral(embedding),
            sessionId);
        for (const auto& row : rows) {
            Json::Value memory(Json::objectValue);
            memory["content"] = row["content"].as<std::string>();
            memory["metadata"] = parseJson(row["metadata"].as<std::string>());
            memory["session_id"] = row["session_id"].is_null() ? "" : row["session_id"].as<std::string>();
            memory["memory_type"] = row["memory_type"].as<std::string>();
            memory["similarity"] = row["similarity"].as<double>();
            memories.append(memory);
        }
    } catch (const std::exception& e) {
        spdlog::warn("AI semantic memory retrieval skipped: {}", e.what());
    }
    return memories;
}

void storeSemanticMemory(pqxx::work& txn,
                         const std::string& userId,
                         const std::string& sessionId,
                         const std::string& sourceMessageId,
                         const std::string& content,
                         const Json::Value& embedding,
                         const Json::Value& metadata) {
    if (!embedding.isArray() || embedding.empty() || content.empty()) {
        return;
    }
    try {
        txn.exec_params(
            "INSERT INTO ai_memory_chunks "
            "(user_id, session_id, source_message_id, memory_type, content, metadata, embedding) "
            "VALUES ($1, $2::uuid, NULLIF($3, '')::uuid, 'chat_turn', $4, $5::jsonb, $6::vector)",
            userId,
            sessionId,
            sourceMessageId,
            AiRedaction::redactText(clipText(content, 4000), maxContextBytes()),
            compactJson(metadata),
            vectorLiteral(embedding));
    } catch (const std::exception& e) {
        spdlog::warn("AI semantic memory store skipped: {}", e.what());
    }
}

Json::Value runWorkflow(const std::string& path,
                        const Json::Value& payload,
                        const Json::Value& overrides = Json::Value(Json::objectValue)) {
    Json::Value requestPayload = payload;
    if (overrides.isObject() && !overrides.empty()) {
        requestPayload["provider_overrides"] = overrides;
    }
    const auto result = AiServiceClient::instance().postWorkflow(path, requestPayload);
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
    if (body.isMember("history")) {
        payload["history"] = body["history"];
    }
    if (body.isMember("memory")) {
        payload["memory"] = body["memory"];
    }
    if (body.isMember("session_id")) {
        payload["session_id"] = body["session_id"];
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
    payload["configured"] = envBool("STACKPILOT_AI_ENABLED", true);
    payload["provider"] = envOrDefault("STACKPILOT_AI_PROVIDER", "nvidia_nim");
    payload["model"] = result.body.isObject() && result.body.isMember("model")
        ? result.body["model"].asString()
        : envOrDefault("STACKPILOT_AI_MODEL", envOrDefault("NVIDIA_NIM_FAST_MODEL", envOrDefault("NVIDIA_NIM_MODEL", "")));
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
        payload["has_openai_compatible_key"] =
            payload.isMember("openai_compatible_api_key") && !payload["openai_compatible_api_key"].asString().empty();
        payload.removeMember("openai_compatible_api_key");
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
    if (!validOpenAiCompatibleBaseUrl(baseUrl)) {
        sendError(callback,
                  drogon::k400BadRequest,
                  "OpenAI-compatible base URL must be HTTPS and cannot target localhost, private, or link-local hosts");
        return;
    }
    const bool clearCompatibleKey = body.isMember("clear_openai_compatible_api_key") &&
                                    body["clear_openai_compatible_api_key"].asBool();
    const std::string compatibleApiKey =
        body.isMember("openai_compatible_api_key") ? body["openai_compatible_api_key"].asString() : "";
    std::string encryptedCompatibleApiKey;
    try {
        encryptedCompatibleApiKey = compatibleApiKey.empty() ? "" : TokenCrypto::encrypt(compatibleApiKey);
    } catch (const std::exception& e) {
        spdlog::error("AI provider key encryption failed: {}", e.what());
        sendError(callback, drogon::k500InternalServerError, "AI provider key encryption is not configured");
        return;
    }
    const double threshold = body.isMember("confidence_threshold")
                                 ? clampConfidence(body["confidence_threshold"].asDouble())
                                 : clampConfidence(envDouble("STACKPILOT_AI_CONFIDENCE_THRESHOLD", 0.72));
    const int retentionDays = body.isMember("history_retention_days")
                                  ? std::max(1, std::min(3650, body["history_retention_days"].asInt()))
                                  : 90;

    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);
        txn.exec_params(
            "INSERT INTO ai_preferences "
            "(user_id, enabled, provider, model, openai_compatible_base_url, openai_compatible_api_key, "
            "confidence_threshold, history_retention_days) "
            "VALUES ($1, $2, $3, NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, ''), $7, $8) "
            "ON CONFLICT (user_id) DO UPDATE SET "
            "enabled = EXCLUDED.enabled, provider = EXCLUDED.provider, model = EXCLUDED.model, "
            "openai_compatible_base_url = EXCLUDED.openai_compatible_base_url, "
            "openai_compatible_api_key = CASE "
            "WHEN $9 THEN NULL "
            "WHEN NULLIF($6, '') IS NULL THEN ai_preferences.openai_compatible_api_key "
            "ELSE EXCLUDED.openai_compatible_api_key END, "
            "confidence_threshold = EXCLUDED.confidence_threshold, history_retention_days = EXCLUDED.history_retention_days, "
            "updated_at = NOW()",
            userId,
            enabled,
            provider,
            model,
            baseUrl,
            encryptedCompatibleApiKey,
            threshold,
            retentionDays,
            clearCompatibleKey);
        txn.commit();

        Json::Value audit;
        audit["provider"] = provider;
        audit["enabled"] = enabled;
        audit["openai_compatible_key_updated"] = !compatibleApiKey.empty();
        audit["openai_compatible_key_cleared"] = clearCompatibleKey;
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
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        sendError(callback, drogon::k401Unauthorized, "Unauthorized");
        return;
    }

    Json::Value payload(Json::objectValue);
    drogon::HttpStatusCode status = drogon::k200OK;
    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);
        Json::Value prefs = loadPreferences(txn, userId);
        txn.commit();

        Json::Value request(Json::objectValue);
        request["provider"] = prefs["provider"];
        request["model"] = prefs["model"];
        request["model_mode"] = "fast";
        Json::Value overrides = providerOverrides(prefs);
        if (overrides.isObject() && !overrides.empty()) {
            request["provider_overrides"] = overrides;
        }

        const auto result = AiServiceClient::instance().postWorkflow("/models", request);
        payload = result.body;
        if (!result.ok) {
            status = drogon::k503ServiceUnavailable;
            payload["status"] = "error";
            payload["error"] = result.error.empty() ? "AI model catalog request failed" : result.error;
        }
    } catch (const std::exception& e) {
        status = drogon::k503ServiceUnavailable;
        spdlog::error("AI model catalog request failed: {}", e.what());
        payload["status"] = "error";
        payload["error"] = "AI model catalog request failed";
    }
    sendJson(callback, payload, status);
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
        Json::Value prefs(Json::objectValue);
        Json::Value project(Json::objectValue);
        Json::Value deployment(Json::objectValue);
        Json::Value payload(Json::objectValue);
        std::string projectId = body.isMember("project_id") ? body["project_id"].asString() : "";
        const std::string deploymentId = body.isMember("deployment_id") ? body["deployment_id"].asString() : "";
        const std::string userMessage = AiRedaction::redactText(body["message"].asString(), maxContextBytes());
        std::string sessionId = body.isMember("session_id") ? body["session_id"].asString() : "";
        std::string sessionTitle;
        std::string memorySummary;
        std::string userMessageId;
        Json::Value memoryGraph(Json::objectValue);

        {
            pqxx::work txn(*conn);
            prefs = loadPreferences(txn, userId);
            if (!prefs["enabled"].asBool()) {
                sendError(callback, drogon::k403Forbidden, "AI is disabled");
                return;
            }

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

            if (!sessionId.empty()) {
                const auto sessions = txn.exec_params(
                    "SELECT id, title, memory_summary, memory_graph::text "
                    "FROM ai_sessions WHERE id = $1 AND user_id = $2 AND session_type = 'agent_chat'",
                    sessionId,
                    userId);
                if (sessions.empty()) {
                    sendError(callback, drogon::k404NotFound, "AI chat not found");
                    return;
                }
                sessionTitle = sessions[0]["title"].as<std::string>();
                memorySummary = sessions[0]["memory_summary"].as<std::string>();
                memoryGraph = parseJson(sessions[0]["memory_graph"].as<std::string>());
                if (!memoryGraph.isObject()) {
                    memoryGraph = Json::Value(Json::objectValue);
                }
            } else {
                sessionTitle = chatTitleFromMessage(userMessage);
                const auto rows = txn.exec_params(
                    "INSERT INTO ai_sessions (user_id, project_id, title, session_type) "
                    "VALUES ($1, NULLIF($2, '')::uuid, $3, 'agent_chat') RETURNING id",
                    userId,
                    projectId,
                    sessionTitle);
                sessionId = rows[0][0].as<std::string>();
            }

            const auto historyRows = txn.exec_params(
                "SELECT role, content FROM ("
                "SELECT role, content, created_at FROM ai_messages WHERE session_id = $1 "
                "ORDER BY created_at DESC LIMIT 24"
                ") recent ORDER BY created_at ASC",
                sessionId);
            body["history"] = buildHistory(historyRows);
            body["session_id"] = sessionId;

            const auto userMessageRows = txn.exec_params(
                "INSERT INTO ai_messages (session_id, role, content) VALUES ($1, 'user', $2) RETURNING id",
                sessionId,
                userMessage);
            userMessageId = userMessageRows[0][0].as<std::string>();
            txn.commit();
        }

        Json::Value queryEmbedding = embeddingForText(prefs, userMessage);
        {
            pqxx::work txn(*conn);
            Json::Value memory = sessionMemory(memorySummary, compactJson(memoryGraph));
            memory["semantic"] = retrieveSemanticMemories(txn, userId, sessionId, queryEmbedding);
            body["memory"] = memory;
            txn.commit();
        }

        payload = buildPayload(prefs, body, project, deployment);
        Json::Value result = runWorkflow("/chat/agent", payload, providerOverrides(prefs));
        std::string runId;
        const std::string assistantMessage = result.isMember("summary") ? result["summary"].asString() : compactJson(result);
        Json::Value turnEmbedding = embeddingForText(prefs, userMessage + "\n" + assistantMessage);

        {
            pqxx::work txn(*conn);
            runId = insertAiRun(txn, userId, "agent_chat", payload, result,
                                result.isMember("error") ? result["error"].asString() : "");
            linkAiRun(txn, runId, projectId, deploymentId);
            storeArtifacts(txn, runId, result);

            Json::Value messageMeta;
            messageMeta["run_id"] = runId;
            messageMeta["model"] = result.isMember("model") ? result["model"].asString() : payload["model"].asString();
            messageMeta["provider"] = result.isMember("provider") ? result["provider"].asString() : payload["provider"].asString();
            const auto assistantRows = txn.exec_params(
                "INSERT INTO ai_messages (session_id, role, content, metadata) VALUES ($1, 'assistant', $2, $3::jsonb) RETURNING id",
                sessionId,
                assistantMessage,
                compactJson(messageMeta));
            const std::string assistantMessageId = assistantRows[0][0].as<std::string>();

            Json::Value semanticMeta(Json::objectValue);
            semanticMeta["run_id"] = runId;
            semanticMeta["user_message_id"] = userMessageId;
            semanticMeta["assistant_message_id"] = assistantMessageId;
            semanticMeta["embedding_kind"] = "chat_turn";
            storeSemanticMemory(
                txn,
                userId,
                sessionId,
                assistantMessageId,
                "User: " + userMessage + "\nAssistant: " + assistantMessage,
                turnEmbedding,
                semanticMeta);

            memorySummary = updateMemorySummary(memorySummary, userMessage, assistantMessage);
            memoryGraph = updateMemoryGraph(memoryGraph, userMessage, assistantMessage);
            txn.exec_params(
                "UPDATE ai_sessions SET updated_at = NOW(), memory_summary = $2, memory_graph = $3::jsonb, last_model = $4 "
                "WHERE id = $1",
                sessionId,
                memorySummary,
                compactJson(memoryGraph),
                payload["model"].asString());
            txn.commit();
        }

        Json::Value audit;
        audit["run_id"] = runId;
        audit["command"] = body.isMember("command") ? body["command"].asString() : "";
        AuditLogger::recordFromRequest(req, userId, "ai.agent.chat", "ai", runId, audit);

        result["run_id"] = runId;
        result["session_id"] = sessionId;
        result["session_title"] = sessionTitle;
        sendJson(callback, result);
    } catch (const std::exception& e) {
        spdlog::error("AI agent chat failed: {}", e.what());
        sendError(callback, drogon::k500InternalServerError, "AI agent chat failed");
    }
}

void AiController::listSessions(const drogon::HttpRequestPtr& req,
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
            "SELECT s.id, s.title, s.session_type, s.project_id, s.memory_summary, s.last_model, "
            "s.created_at, s.updated_at, "
            "(SELECT COUNT(*) FROM ai_messages m WHERE m.session_id = s.id) AS message_count, "
            "COALESCE((SELECT m.content FROM ai_messages m WHERE m.session_id = s.id ORDER BY m.created_at DESC LIMIT 1), '') AS preview "
            "FROM ai_sessions s WHERE s.user_id = $1 AND s.session_type IN ('agent_chat', 'project_chat') "
            "ORDER BY s.updated_at DESC LIMIT 100",
            userId);
        Json::Value sessions(Json::arrayValue);
        for (const auto& row : rows) {
            Json::Value session(Json::objectValue);
            for (const auto& name : {"id", "title", "session_type", "created_at", "updated_at", "memory_summary", "last_model", "preview"}) {
                session[name] = row[name].is_null() ? "" : row[name].as<std::string>();
            }
            session["project_id"] = row["project_id"].is_null() ? "" : row["project_id"].as<std::string>();
            session["message_count"] = row["message_count"].as<int>();
            sessions.append(session);
        }
        txn.commit();

        Json::Value payload;
        payload["sessions"] = sessions;
        sendJson(callback, payload);
    } catch (const std::exception& e) {
        spdlog::error("AI sessions list failed: {}", e.what());
        sendError(callback, drogon::k500InternalServerError, "Failed to list AI chats");
    }
}

void AiController::getSession(const drogon::HttpRequestPtr& req,
                              std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                              const std::string& sessionId) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        sendError(callback, drogon::k401Unauthorized, "Unauthorized");
        return;
    }

    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);
        const auto sessions = txn.exec_params(
            "SELECT id, title, session_type, project_id, memory_summary, memory_graph::text, last_model, created_at, updated_at "
            "FROM ai_sessions WHERE id = $1 AND user_id = $2",
            sessionId,
            userId);
        if (sessions.empty()) {
            sendError(callback, drogon::k404NotFound, "AI chat not found");
            return;
        }

        const auto& row = sessions[0];
        Json::Value session(Json::objectValue);
        for (const auto& name : {"id", "title", "session_type", "created_at", "updated_at", "memory_summary", "last_model"}) {
            session[name] = row[name].is_null() ? "" : row[name].as<std::string>();
        }
        session["project_id"] = row["project_id"].is_null() ? "" : row["project_id"].as<std::string>();
        session["memory_graph"] = parseJson(row["memory_graph"].as<std::string>());

        const auto messagesRows = txn.exec_params(
            "SELECT id, role, content, metadata::text, created_at FROM ai_messages "
            "WHERE session_id = $1 ORDER BY created_at ASC LIMIT 500",
            sessionId);
        Json::Value messages(Json::arrayValue);
        for (const auto& messageRow : messagesRows) {
            Json::Value message(Json::objectValue);
            for (const auto& name : {"id", "role", "content", "created_at"}) {
                message[name] = messageRow[name].is_null() ? "" : messageRow[name].as<std::string>();
            }
            message["metadata"] = parseJson(messageRow["metadata"].as<std::string>());
            messages.append(message);
        }
        txn.commit();

        Json::Value payload;
        payload["session"] = session;
        payload["messages"] = messages;
        sendJson(callback, payload);
    } catch (const std::exception& e) {
        spdlog::error("AI session load failed: {}", e.what());
        sendError(callback, drogon::k500InternalServerError, "Failed to load AI chat");
    }
}

void AiController::deleteSession(const drogon::HttpRequestPtr& req,
                                 std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                                 const std::string& sessionId) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        sendError(callback, drogon::k401Unauthorized, "Unauthorized");
        return;
    }

    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);
        const auto rows = txn.exec_params(
            "DELETE FROM ai_sessions WHERE id = $1 AND user_id = $2 RETURNING id",
            sessionId,
            userId);
        if (rows.empty()) {
            sendError(callback, drogon::k404NotFound, "AI chat not found");
            return;
        }
        txn.commit();
        Json::Value payload;
        payload["success"] = true;
        sendJson(callback, payload);
    } catch (const std::exception& e) {
        spdlog::error("AI session delete failed: {}", e.what());
        sendError(callback, drogon::k500InternalServerError, "Failed to delete AI chat");
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
        Json::Value result = runWorkflow("/analyze/project", payload, providerOverrides(prefs));
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
        Json::Value result = runWorkflow("/generate/dockerfile", payload, providerOverrides(prefs));
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
        Json::Value result = runWorkflow("/chat/project", payload, providerOverrides(prefs));
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
        Json::Value result = runWorkflow("/analyze/build-failure", payload, providerOverrides(prefs));
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
        Json::Value result = runWorkflow("/analyze/runtime-failure", payload, providerOverrides(prefs));
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

} // namespace stackpilot
