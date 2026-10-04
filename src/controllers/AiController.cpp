#include "AiController.h"
#include "../services/AiProviderConnections.h"
#include "../services/AiConversationMemory.h"
#include "../utils/BlockingTaskRunner.h"
#include "../utils/StringUtils.h"

#include "../db/Database.h"
#include "../services/AiServiceClient.h"
#include "../services/BuildService.h"
#include "../services/JobQueueService.h"
#include "../services/DeploymentOperations.h"
#include "../utils/AiRedaction.h"
#include "../utils/AuditLogger.h"
#include "../utils/JwtHelper.h"
#include "../utils/TokenCrypto.h"

#include <filesystem>
#include <fstream>
#include <json/json.h>
#include <pqxx/pqxx>
#include <spdlog/spdlog.h>
#include <openssl/bio.h>
#include <openssl/buffer.h>
#include <openssl/crypto.h>
#include <openssl/evp.h>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <deque>
#include <iomanip>
#include <mutex>
#include <regex>
#include <sstream>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace stackpilot {

namespace {

std::string normalizeDeploymentId(pqxx::work& txn, const std::string& inputId, const std::string& userId) {
    std::string clean = strings::trim(inputId);
    while (clean.size() >= 3 && clean.substr(clean.size() - 3) == "...") {
        clean = clean.substr(0, clean.size() - 3);
    }
    clean = strings::trim(clean);
    if (clean.empty()) return "";
    if (clean.size() == 36 && clean.find('-') != std::string::npos) {
        return clean; // Already a full UUID
    }
    if (clean.size() >= 8) {
        try {
            auto rows = txn.exec_params(
                "SELECT d.id::text FROM deployments d JOIN projects p ON d.project_id = p.id "
                "WHERE d.id::text LIKE $1 || '%' AND (p.user_id = $2 OR has_project_access(p.id, $2)) "
                "ORDER BY d.created_at DESC LIMIT 1",
                clean, userId);
            if (!rows.empty() && !rows[0][0].is_null()) {
                return rows[0][0].as<std::string>();
            }
        } catch (...) {}
    }
    return clean;
}

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

using aiMemory::clipText;
using aiMemory::sessionMemory;
using aiMemory::updateMemoryGraph;
using aiMemory::updateMemorySummary;
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

Json::Value loadPreferences(pqxx::work& txn, const std::string& userId, bool resolveConnection = true) {
    Json::Value prefs;
    prefs["enabled"] = envBool("STACKPILOT_AI_ENABLED", true);
    prefs["provider"] = envOrDefault("STACKPILOT_AI_PROVIDER", "nvidia_nim");
    prefs["model"] = envOrDefault("STACKPILOT_AI_MODEL", "");
    prefs["openai_compatible_base_url"] = envOrDefault("OPENAI_COMPATIBLE_BASE_URL", "");
    prefs["openai_compatible_api_key"] = envOrDefault("OPENAI_COMPATIBLE_API_KEY", "");
    prefs["nvidia_api_key"] = envOrDefault("NVIDIA_API_KEY", envOrDefault("NVIDIA_NIM_API_KEY", ""));
    prefs["confidence_threshold"] = clampConfidence(envDouble("STACKPILOT_AI_CONFIDENCE_THRESHOLD", 0.72));
    prefs["history_retention_days"] = 90;
    prefs["agent_access_mode"] = "ask";  // fail closed until the user opts in

    const auto rows = txn.exec_params(
        "SELECT enabled, provider, model, openai_compatible_base_url, openai_compatible_api_key, "
        "confidence_threshold, history_retention_days, agent_access_mode, nvidia_api_key "
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
        if (!row["nvidia_api_key"].is_null() && !row["nvidia_api_key"].as<std::string>().empty()) {
            prefs["nvidia_api_key"] = TokenCrypto::decrypt(row["nvidia_api_key"].as<std::string>());
        }
        prefs["confidence_threshold"] = clampConfidence(row["confidence_threshold"].as<double>());
        prefs["history_retention_days"] = row["history_retention_days"].as<int>();
        if (!row["agent_access_mode"].is_null()) {
            prefs["agent_access_mode"] = row["agent_access_mode"].as<std::string>();
        }
    }
    if (resolveConnection) aiProviders::apply(txn, userId, prefs);
    prefs["provider_connections"] = aiProviders::list(txn, userId);
    return prefs;
}

Json::Value projectContext(pqxx::work& txn, const std::string& userId, const std::string& projectId) {
    const auto rows = txn.exec_params(
        "SELECT p.id, p.name, p.description, p.repo_url, p.status, p.source_type, p.source_path, "
        "p.execution_mode, p.remote_runtime_type, p.remote_k8s_exposure, p.runtime_scheme, p.local_https_enabled, "
        "p.created_at, p.updated_at, "
        "COALESCE((SELECT jsonb_agg(jsonb_build_object('key', key, 'has_value', true) ORDER BY key) "
        "FROM project_env_vars WHERE project_id = p.id), '[]'::jsonb)::text AS env_keys "
        "FROM projects p WHERE p.id = $1 AND has_project_access(p.id, $2)",
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
        "SELECT d.id, d.project_id, d.status, d.version, d.commit_hash, d.logs, d.branch, d.image_name, "
        "d.runtime_provider, d.runtime_url, d.runtime_exposure, d.remote_container_name, "
        "d.k8s_namespace, d.k8s_deployment_name, d.k8s_service_name, d.k8s_ingress_name, "
        "d.desired_replicas, d.runtime_paused, d.artifact_available, d.artifact_digest, "
        "d.source_snapshot::text AS source_snapshot, d.env_snapshot::text AS env_snapshot, "
        "d.runtime_snapshot::text AS runtime_snapshot, d.remote_runtime_details::text AS remote_runtime_details, "
        "d.created_at, d.updated_at, p.name AS project_name "
        "FROM deployments d JOIN projects p ON p.id = d.project_id "
        "WHERE d.id = $1 AND has_project_access(p.id, $2)",
        deploymentId,
        userId);
    if (rows.empty()) {
        return Json::Value();
    }
    const auto& row = rows[0];
    Json::Value deployment(Json::objectValue);
    for (const auto& name : {"id", "project_id", "status", "version", "commit_hash", "logs", "branch", "image_name",
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
    } else if (prefs.isMember("provider") && prefs["provider"].asString() == "nvidia_nim") {
        if (prefs.isMember("nvidia_api_key") && !prefs["nvidia_api_key"].asString().empty()) {
            overrides["api_key"] = prefs["nvidia_api_key"].asString();
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
            // The inner query must ORDER BY the distance operator and LIMIT for
            // pgvector to use idx_ai_memory_chunks_embedding_hnsw. Previously the
            // ordering lived in the outer query, so every chat turn sequentially
            // scanned the user's entire memory table. The similarity floor is
            // applied outside, over the small candidate set.
            "SELECT content, metadata::text, session_id::text, memory_type, similarity FROM ("
            "  SELECT content, metadata, session_id, memory_type, (1 - (embedding <=> $2::vector)) AS similarity "
            "  FROM ai_memory_chunks "
            "  WHERE user_id = $1 AND ($3 = '' OR session_id = $3::uuid OR session_id IS NULL) "
            "  ORDER BY embedding <=> $2::vector "
            "  LIMIT 40"
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
    if (body.isMember("sandbox_mode")) payload["sandbox_mode"] = body["sandbox_mode"];
    if (body.isMember("custom_url")) payload["custom_url"] = body["custom_url"];
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
    if (body.isMember("images")) {
        payload["images"] = body["images"];
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
        payload["has_nvidia_key"] = (payload.isMember("nvidia_api_key") && !payload["nvidia_api_key"].asString().empty()) ||
                                    !envOrDefault("NVIDIA_API_KEY", "").empty() ||
                                    !envOrDefault("NVIDIA_NIM_API_KEY", "").empty();
        payload["has_openai_compatible_key"] =
            payload.isMember("openai_compatible_api_key") && !payload["openai_compatible_api_key"].asString().empty();
        payload.removeMember("openai_compatible_api_key");
        payload.removeMember("nvidia_api_key");
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

    Json::Value body = requestBody(req);
    if (body.isMember("provider_connection")) {
        try {
            const auto input = body["provider_connection"];
            if (!input.isObject()) throw std::invalid_argument("Invalid provider connection");
            auto conn = Database::getInstance().getConnection();
            pqxx::work txn(*conn);
            // Serialize changes for this user, including simultaneous activation requests.
            txn.exec_params("SELECT id FROM users WHERE id=$1 FOR UPDATE", userId);
            std::string id = input.get("id", "").asString();
            if (!id.empty()) {
                const auto found = txn.exec_params("SELECT id FROM ai_provider_connections WHERE id::text=$1 AND user_id=$2", id, userId);
                if (found.empty()) { sendError(callback, drogon::k404NotFound, "Provider connection unavailable"); return; }
            }
            if (input.get("remove", false).asBool()) {
                if (id.empty()) throw std::invalid_argument("Connection id is required");
                txn.exec_params("DELETE FROM ai_provider_connections WHERE id::text=$1 AND user_id=$2", id, userId);
            } else if (input.isMember("name")) {
                const auto name = trimText(input.get("name", "").asString());
                const auto engine = input.get("provider", "openai_compatible").asString();
                const auto url = trimText(input.get("base_url", "").asString());
                const auto vendor = input.get("vendor", "custom").asString();
                if (name.empty() || name.size()>120 || !validProvider(engine) || vendor.size()>80 || url.size()>2048 ||
                    (engine=="openai_compatible" && (url.empty() || !validOpenAiCompatibleBaseUrl(url))))
                    throw std::invalid_argument("Provide a name and a public HTTPS compatible API endpoint");
                const auto rawKey = input.get("api_key", "").asString();
                if (rawKey.size()>8192) throw std::invalid_argument("API key is too long");
                const auto encrypted = rawKey.empty() ? "" : TokenCrypto::encrypt(rawKey);
                if (id.empty()) {
                    const auto count = txn.exec_params("SELECT COUNT(*) FROM ai_provider_connections WHERE user_id=$1", userId);
                    if (count[0][0].as<int>()>=50) throw std::invalid_argument("At most 50 provider connections are supported");
                    auto rows=txn.exec_params("INSERT INTO ai_provider_connections(user_id,name,vendor,provider,base_url,api_key_encrypted) VALUES($1,$2,$3,$4,$5,NULLIF($6,'')) RETURNING id", userId,name,vendor,engine,url,encrypted);
                    id=rows[0][0].as<std::string>();
                } else {
                    txn.exec_params("UPDATE ai_provider_connections SET name=$3,vendor=$4,provider=$5,base_url=$6,api_key_encrypted=CASE WHEN $8 THEN NULL WHEN $7='' THEN api_key_encrypted ELSE $7 END,updated_at=NOW() WHERE id::text=$1 AND user_id=$2",id,userId,name,vendor,engine,url,encrypted,input.get("clear_key",false).asBool());
                }
            }
            if (input.isMember("active")) {
                const bool active=input["active"].asBool();
                if (active) txn.exec_params("UPDATE ai_provider_connections SET active=false WHERE user_id=$1 AND active", userId);
                if (!id.empty()) txn.exec_params("UPDATE ai_provider_connections SET active=$3,updated_at=NOW() WHERE id::text=$1 AND user_id=$2",id,userId,active);
            }
            auto connections = aiProviders::list(txn, userId);
            txn.commit();
            Json::Value response; response["success"]=true; response["provider_connections"]=connections;
            sendJson(callback,response);
        } catch (const std::invalid_argument& e) {
            sendError(callback,drogon::k400BadRequest,e.what());
        } catch (const std::exception& e) {
            spdlog::error("Provider connection save failed: {}",e.what());
            sendError(callback,drogon::k500InternalServerError,"Could not save provider connection");
        }
        return;
    }
    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);
        // A temporary active profile must not replace the user's fallback
        // provider when unrelated settings (such as the model) are saved.
        const auto current = loadPreferences(txn,userId,false);
        for (const auto* field : {"enabled","provider","model","openai_compatible_base_url","confidence_threshold","history_retention_days","agent_access_mode"})
            if (!body.isMember(field)) body[field]=current[field];
        txn.commit();
    } catch (const std::exception& e) {
        spdlog::error("AI settings unavailable: {}",e.what());
        sendError(callback,drogon::k503ServiceUnavailable,"Could not load current AI settings"); return;
    }
    const std::string provider = body.isMember("provider") ? body["provider"].asString() : "nvidia_nim";
    if (!validProvider(provider)) {
        sendError(callback, drogon::k400BadRequest, "Unsupported AI provider");
        return;
    }

    const bool enabled = body.isMember("enabled") ? body["enabled"].asBool() : true;
    const std::string model = body.isMember("model") ? body["model"].asString() : "";
    const std::string baseUrl = body.isMember("openai_compatible_base_url") ? body["openai_compatible_base_url"].asString() : "";
    if (provider == "openai_compatible" && !validOpenAiCompatibleBaseUrl(baseUrl)) {
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

    std::string rawNvidiaKey = body.isMember("nvidia_api_key") ? body["nvidia_api_key"].asString() : "";
    if (rawNvidiaKey.empty() && provider == "nvidia_nim" && body.isMember("api_key")) {
        rawNvidiaKey = body["api_key"].asString();
    }
    const bool clearNvidiaKey = body.isMember("clear_nvidia_api_key") && body["clear_nvidia_api_key"].asBool();
    std::string encryptedNvidiaKey;
    if (!rawNvidiaKey.empty()) {
        try {
            encryptedNvidiaKey = TokenCrypto::encrypt(rawNvidiaKey);
        } catch (const std::exception& e) {
            spdlog::error("NVIDIA API key encryption failed: {}", e.what());
            sendError(callback, drogon::k500InternalServerError, "AI provider key encryption is not configured");
            return;
        }
    }

    const double threshold = body.isMember("confidence_threshold")
                                 ? clampConfidence(body["confidence_threshold"].asDouble())
                                 : clampConfidence(envDouble("STACKPILOT_AI_CONFIDENCE_THRESHOLD", 0.72));
    const int retentionDays = body.isMember("history_retention_days")
                                  ? std::max(1, std::min(3650, body["history_retention_days"].asInt()))
                                  : 90;
    std::string agentAccessMode = body.isMember("agent_access_mode")
                                      ? body["agent_access_mode"].asString()
                                      : "ask";
    if (agentAccessMode != "ask" && agentAccessMode != "auto_review" && agentAccessMode != "full_access") {
        agentAccessMode = "ask";
    }

    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);
        txn.exec_params(
            "INSERT INTO ai_preferences "
            "(user_id, enabled, provider, model, openai_compatible_base_url, openai_compatible_api_key, "
            "confidence_threshold, history_retention_days, agent_access_mode, nvidia_api_key) "
            "VALUES ($1, $2, $3, NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, ''), $7, $8, $9, NULLIF($11, '')) "
            "ON CONFLICT (user_id) DO UPDATE SET "
            "enabled = EXCLUDED.enabled, provider = EXCLUDED.provider, model = EXCLUDED.model, "
            "openai_compatible_base_url = EXCLUDED.openai_compatible_base_url, "
            "openai_compatible_api_key = CASE "
            "WHEN $10 THEN NULL "
            "WHEN NULLIF($6, '') IS NULL THEN ai_preferences.openai_compatible_api_key "
            "ELSE EXCLUDED.openai_compatible_api_key END, "
            "nvidia_api_key = CASE "
            "WHEN $12 THEN NULL "
            "WHEN NULLIF($11, '') IS NULL THEN ai_preferences.nvidia_api_key "
            "ELSE EXCLUDED.nvidia_api_key END, "
            "confidence_threshold = EXCLUDED.confidence_threshold, history_retention_days = EXCLUDED.history_retention_days, "
            "agent_access_mode = EXCLUDED.agent_access_mode, "
            "updated_at = NOW()",
            userId,
            enabled,
            provider,
            model,
            baseUrl,
            encryptedCompatibleApiKey,
            threshold,
            retentionDays,
            agentAccessMode,
            clearCompatibleKey,
            encryptedNvidiaKey,
            clearNvidiaKey);
        txn.commit();

        Json::Value audit;
        audit["provider"] = provider;
        audit["enabled"] = enabled;
        audit["openai_compatible_key_updated"] = !compatibleApiKey.empty();
        audit["openai_compatible_key_cleared"] = clearCompatibleKey;
        audit["nvidia_key_updated"] = !rawNvidiaKey.empty();
        audit["nvidia_key_cleared"] = clearNvidiaKey;
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
    // Runs off the event loop: this handler performs a synchronous call to
    // the AI service that can block for up to 120s, which would otherwise
    // occupy one of the few Drogon event-loop threads for its duration.
    BlockingTaskRunner::run([this, req, callback = std::move(callback)]() mutable {
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

        auto body = req->getJsonObject();
        std::string reqProvider = "";
        std::string reqApiKey = "";
        std::string reqBaseUrl = "";
        std::string reqModel = "";
        if (body) {
            if (body->isMember("provider")) reqProvider = (*body)["provider"].asString();
            if (body->isMember("api_key")) reqApiKey = (*body)["api_key"].asString();
            if (body->isMember("base_url")) reqBaseUrl = (*body)["base_url"].asString();
            if (body->isMember("model")) reqModel = (*body)["model"].asString();
        }
        if (reqProvider.empty()) reqProvider = req->getParameter("provider");
        if (reqApiKey.empty()) reqApiKey = req->getParameter("api_key");
        if (reqBaseUrl.empty()) reqBaseUrl = req->getParameter("base_url");
        if (reqModel.empty()) reqModel = req->getParameter("model");

        Json::Value request(Json::objectValue);
        request["provider"] = !reqProvider.empty() ? reqProvider : prefs["provider"];
        request["model"] = !reqModel.empty() ? reqModel : prefs["model"];
        request["model_mode"] = "fast";
        Json::Value overrides = providerOverrides(prefs);
        if (!reqApiKey.empty()) {
            overrides["api_key"] = reqApiKey;
        }
        if (!reqBaseUrl.empty()) {
            overrides["base_url"] = reqBaseUrl;
        }
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
    });
}

void AiController::testConnection(const drogon::HttpRequestPtr& req,
                                 std::function<void(const drogon::HttpResponsePtr&)>&& callback) {
    BlockingTaskRunner::run([this, req, callback = std::move(callback)]() mutable {
        const std::string userId = extractUserId(req);
        if (userId.empty()) {
            sendError(callback, drogon::k401Unauthorized, "Unauthorized");
            return;
        }
        const auto body = req->getJsonObject();
        if (!body || !(*body)["model"].isString() || (*body)["model"].asString().empty() ||
            (*body)["model"].asString().size() > 200) {
            sendError(callback, drogon::k400BadRequest, "Enter a model identifier to test.");
            return;
        }
        try {
            auto conn = Database::getInstance().getConnection();
            pqxx::work txn(*conn);
            const auto prefs = loadPreferences(txn, userId);
            txn.commit();
            Json::Value request(Json::objectValue);
            request["provider"] = prefs["provider"];
            request["model"] = (*body)["model"];
            request["provider_overrides"] = providerOverrides(prefs);
            // Only saved, owned credentials are accepted; no browser-supplied key or endpoint.
            const auto result = AiServiceClient::instance().postWorkflow("/providers/test", request);
            if (!result.ok) {
                sendError(callback, drogon::k503ServiceUnavailable, "AI service unavailable. Start the AI service profile and retry.");
                return;
            }
            sendJson(callback, result.body);
        } catch (const std::exception&) {
            sendError(callback, drogon::k503ServiceUnavailable, "Could not test the AI connection. Check service health and retry.");
        }
    });
}

void AiController::chatAgent(const drogon::HttpRequestPtr& req,
                             std::function<void(const drogon::HttpResponsePtr&)>&& callback) {
    // Runs off the event loop: this handler performs a synchronous call to
    // the AI service that can block for up to 120s, which would otherwise
    // occupy one of the few Drogon event-loop threads for its duration.
    BlockingTaskRunner::run([this, req, callback = std::move(callback)]() mutable {
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
        std::string deploymentId = body.isMember("deployment_id") ? body["deployment_id"].asString() : "";
        std::string workflowType = body.isMember("workflow_type") ? body["workflow_type"].asString() : "agent_chat";
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

            // Backend Session Context Resolution:
            // When body contains session_id:
            // If deployment_id is empty or project_id is empty, query ai_sessions in PostgreSQL:
            // SELECT deployment_id, project_id, session_type FROM ai_sessions WHERE id = $1
            // If found, populate deployment_id and project_id and workflow_type!
            if (!sessionId.empty()) {
                const auto sessions = txn.exec_params(
                    "SELECT id, title, project_id, deployment_id, session_type, memory_summary, memory_graph::text "
                    "FROM ai_sessions WHERE id = $1 AND (user_id = $2 OR has_project_access(project_id, $2))",
                    sessionId,
                    userId);
                if (sessions.empty()) {
                    sendError(callback, drogon::k404NotFound, "AI chat not found");
                    return;
                }
                const auto& sRow = sessions[0];
                if (deploymentId.empty() && !sRow["deployment_id"].is_null()) {
                    deploymentId = sRow["deployment_id"].as<std::string>();
                }
                if (projectId.empty() && !sRow["project_id"].is_null()) {
                    projectId = sRow["project_id"].as<std::string>();
                }
                if (!sRow["session_type"].is_null() && !sRow["session_type"].as<std::string>().empty()) {
                    workflowType = sRow["session_type"].as<std::string>();
                }
                sessionTitle = sRow["title"].is_null() ? "" : sRow["title"].as<std::string>();
                memorySummary = sRow["memory_summary"].is_null() ? "" : sRow["memory_summary"].as<std::string>();
                memoryGraph = parseJson(sRow["memory_graph"].is_null() ? "" : sRow["memory_graph"].as<std::string>());
                if (!memoryGraph.isObject()) {
                    memoryGraph = Json::Value(Json::objectValue);
                }
            } else {
                sessionTitle = chatTitleFromMessage(userMessage);
                const auto rows = txn.exec_params(
                    "INSERT INTO ai_sessions (user_id, project_id, title, session_type, deployment_id) "
                    "VALUES ($1, NULLIF($2, '')::uuid, $3, $4, NULLIF($5, '')::uuid) RETURNING id",
                    userId,
                    projectId,
                    sessionTitle,
                    workflowType.empty() ? "agent_chat" : workflowType,
                    deploymentId);
                sessionId = rows[0][0].as<std::string>();
            }

            // Query deployments table:
            // SELECT d.id, d.status, d.logs, d.branch, p.id AS project_id, p.name AS project_name FROM deployments d JOIN projects p ON d.project_id = p.id WHERE d.id = $1
            // Populate deployment JSON object (id, status, logs, branch) and project JSON object (id, name) so the AI service always receives complete deployment context!
            if (!deploymentId.empty()) {
                const auto dRows = txn.exec_params(
                    "SELECT d.id, d.status, d.logs, d.branch, p.id AS project_id, p.name AS project_name "
                    "FROM deployments d JOIN projects p ON d.project_id = p.id "
                    "WHERE d.id = $1 AND (p.user_id = $2 OR has_project_access(p.id, $2))",
                    deploymentId, userId);
                if (dRows.empty()) {
                    sendError(callback, drogon::k404NotFound, "Deployment not found");
                    return;
                }
                deployment = deploymentContext(txn, userId, deploymentId);
                if (deployment.isNull()) {
                    deployment = Json::Value(Json::objectValue);
                }
                deployment["id"] = dRows[0]["id"].as<std::string>();
                deployment["status"] = dRows[0]["status"].is_null() ? "" : dRows[0]["status"].as<std::string>();
                deployment["logs"] = dRows[0]["logs"].is_null() ? "" : dRows[0]["logs"].as<std::string>();
                deployment["branch"] = dRows[0]["branch"].is_null() ? "" : dRows[0]["branch"].as<std::string>();
                if (projectId.empty() && !dRows[0]["project_id"].is_null()) {
                    projectId = dRows[0]["project_id"].as<std::string>();
                }
                if (!project.isObject()) {
                    project = Json::Value(Json::objectValue);
                }
                project["id"] = dRows[0]["project_id"].as<std::string>();
                project["name"] = dRows[0]["project_name"].is_null() ? "" : dRows[0]["project_name"].as<std::string>();
            }

            if (!projectId.empty()) {
                Json::Value fullProject = projectContext(txn, userId, projectId);
                if (!fullProject.isNull()) {
                    for (const auto& key : fullProject.getMemberNames()) {
                        project[key] = fullProject[key];
                    }
                } else if (project.isNull() || !project.isMember("id")) {
                    sendError(callback, drogon::k404NotFound, "Project not found");
                    return;
                }
            }

            const auto historyRows = txn.exec_params(
                "SELECT role, content FROM ("
                "SELECT role, content, created_at FROM ai_messages WHERE session_id = $1 "
                "ORDER BY created_at DESC LIMIT 24"
                ") recent ORDER BY created_at ASC",
                sessionId);
            body["history"] = buildHistory(historyRows);
            body["session_id"] = sessionId;
            body["project_id"] = projectId;
            body["deployment_id"] = deploymentId;
            body["workflow_type"] = workflowType;

            const auto renamed = txn.exec_params(
                "UPDATE ai_sessions SET title = $2, "
                "project_id = COALESCE(project_id, (SELECT p.id FROM projects p WHERE p.id = NULLIF($3, '')::uuid AND has_project_access(p.id, $5))), "
                "deployment_id = COALESCE(deployment_id, (SELECT d.id FROM deployments d JOIN projects p ON p.id = d.project_id WHERE d.id = NULLIF($4, '')::uuid AND has_project_access(p.id, $5))) "
                "WHERE id = $1 AND title = 'New AI chat' "
                "AND NOT EXISTS (SELECT 1 FROM ai_messages WHERE session_id = $1 AND role = 'user') RETURNING title",
                sessionId, chatTitleFromMessage(userMessage), projectId, deploymentId, userId);
            if (!renamed.empty()) sessionTitle = renamed[0]["title"].as<std::string>();
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
        payload["user_id"] = userId;
        payload["workflow_type"] = workflowType;
        payload["project_id"] = projectId;
        payload["deployment_id"] = deploymentId;
        payload["deployment"] = deployment;
        payload["project"] = project;

        Json::Value result = runWorkflow("/chat/agent", payload, providerOverrides(prefs));
        std::string runId;
        const std::string assistantMessage = result.isMember("summary") ? result["summary"].asString() : compactJson(result);
        Json::Value turnEmbedding = embeddingForText(prefs, userMessage + "\n" + assistantMessage);

        {
            pqxx::work txn(*conn);
            runId = insertAiRun(txn, userId, workflowType, payload, result,
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
    });
}

void AiController::createSession(const drogon::HttpRequestPtr& req,
                                 std::function<void(const drogon::HttpResponsePtr&)>&& callback) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        sendError(callback, drogon::k401Unauthorized, "Unauthorized");
        return;
    }
    // A viewer needs a persisted, owned chat before it can request a browser
    // capability. Creating an empty chat must not start a model or a build.
    BlockingTaskRunner::run([userId, callback = std::move(callback)]() mutable {
        try {
            auto conn = Database::getInstance().getConnection();
            pqxx::work txn(*conn);
            const auto rows = txn.exec_params(
                "INSERT INTO ai_sessions (user_id, title, session_type) "
                "VALUES ($1, 'New AI chat', 'agent_chat') RETURNING id, created_at, updated_at",
                userId);
            Json::Value session(Json::objectValue);
            session["id"] = rows[0]["id"].as<std::string>();
            session["title"] = "New AI chat";
            session["session_type"] = "agent_chat";
            session["status"] = "active";
            session["message_count"] = 0;
            session["created_at"] = rows[0]["created_at"].as<std::string>();
            session["updated_at"] = rows[0]["updated_at"].as<std::string>();
            txn.commit();
            Json::Value payload;
            payload["session"] = session;
            sendJson(callback, payload, drogon::k201Created);
        } catch (const std::exception& e) {
            spdlog::error("AI chat creation failed: {}", e.what());
            sendError(callback, drogon::k500InternalServerError, "Could not create AI chat");
        }
    });
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
            "COALESCE(s.status, 'active') AS status, "
            "s.deployment_id, "
            "COALESCE((SELECT m.metadata->>'provider' FROM ai_messages m WHERE m.session_id=s.id AND m.role='assistant' ORDER BY m.created_at DESC LIMIT 1),'') AS last_provider, "
            "COALESCE((SELECT m.metadata->>'provider_connection_name' FROM ai_messages m WHERE m.session_id=s.id AND m.role='assistant' ORDER BY m.created_at DESC LIMIT 1),'') AS provider_connection_name, "
            "s.created_at, s.updated_at, "
            "(SELECT COUNT(*) FROM ai_messages m WHERE m.session_id = s.id) AS message_count, "
            "COALESCE((SELECT SUBSTRING(m.content FROM 1 FOR 2000) FROM ai_messages m WHERE m.session_id = s.id ORDER BY m.created_at DESC LIMIT 1), '') AS preview "
            "FROM ai_sessions s WHERE s.user_id = $1 AND s.session_type IN ('agent_chat', 'project_chat', 'sre_incident') "
            "ORDER BY s.updated_at DESC LIMIT 100",
            userId);

        auto sanitizePreview = [](std::string text) -> std::string {
            if (text.empty()) return "";
            try {
                static const std::regex dataUriRegex(R"(data:image\/[a-zA-Z0-9.+_-]+;base64,[A-Za-z0-9+/=]+)");
                text = std::regex_replace(text, dataUriRegex, "[image snapshot]");
            } catch (...) {}
            for (char& c : text) {
                if (c == '\r' || c == '\n' || c == '\t') c = ' ';
            }
            try {
                static const std::regex spaceRegex(R"(\s+)");
                text = std::regex_replace(text, spaceRegex, " ");
            } catch (...) {}
            size_t first = text.find_first_not_of(' ');
            if (first == std::string::npos) return "";
            text = text.substr(first);
            if (text.size() > 250) {
                text = text.substr(0, 247) + "...";
            }
            return text;
        };

        Json::Value sessions(Json::arrayValue);
        for (const auto& row : rows) {
            Json::Value session(Json::objectValue);
            for (const auto& name : {"id", "title", "session_type", "created_at", "updated_at", "memory_summary", "last_model", "status", "last_provider", "provider_connection_name"}) {
                session[name] = row[name].is_null() ? "" : row[name].as<std::string>();
            }
            std::string rawPreview = row["preview"].is_null() ? "" : row["preview"].as<std::string>();
            session["preview"] = sanitizePreview(rawPreview);
            session["project_id"] = row["project_id"].is_null() ? "" : row["project_id"].as<std::string>();
            session["deployment_id"] = row["deployment_id"].is_null() ? "" : row["deployment_id"].as<std::string>();
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
            "SELECT id, title, session_type, project_id, memory_summary, memory_graph::text, last_model, "
            "COALESCE(status, 'active') AS status, deployment_id, created_at, updated_at "
            "FROM ai_sessions WHERE id = $1 AND user_id = $2",
            sessionId,
            userId);
        if (sessions.empty()) {
            sendError(callback, drogon::k404NotFound, "AI chat not found");
            return;
        }

        const auto& row = sessions[0];
        Json::Value session(Json::objectValue);
        for (const auto& name : {"id", "title", "session_type", "created_at", "updated_at", "memory_summary", "last_model", "status"}) {
            session[name] = row[name].is_null() ? "" : row[name].as<std::string>();
        }
        session["project_id"] = row["project_id"].is_null() ? "" : row["project_id"].as<std::string>();
        session["deployment_id"] = row["deployment_id"].is_null() ? "" : row["deployment_id"].as<std::string>();
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

void AiController::branchSession(const drogon::HttpRequestPtr& req,
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
            "SELECT id, title, session_type, project_id, memory_summary, memory_graph::text, last_model "
            "FROM ai_sessions WHERE id = $1 AND user_id = $2",
            sessionId,
            userId);
        if (sessions.empty()) {
            sendError(callback, drogon::k404NotFound, "AI chat not found");
            return;
        }

        const auto& orig = sessions[0];
        std::string origTitle = orig["title"].is_null() ? "Chat" : orig["title"].as<std::string>();
        std::string newTitle = "[Branch] " + origTitle;
        if (newTitle.size() > 72) newTitle = newTitle.substr(0, 69) + "...";
        std::string sessionType = orig["session_type"].is_null() ? "agent_chat" : orig["session_type"].as<std::string>();
        std::string projectId = orig["project_id"].is_null() ? "" : orig["project_id"].as<std::string>();
        std::string lastModel = orig["last_model"].is_null() ? "" : orig["last_model"].as<std::string>();

        const auto newSessionRows = txn.exec_params(
            "INSERT INTO ai_sessions (user_id, project_id, title, session_type, last_model) "
            "VALUES ($1, NULLIF($2, '')::uuid, $3, $4, $5) RETURNING id",
            userId,
            projectId,
            newTitle,
            sessionType,
            lastModel);
        const std::string newSessionId = newSessionRows[0]["id"].as<std::string>();

        const auto body = req->getJsonObject();
        int maxIndex = -1;
        if (body && body->isMember("message_index")) {
            maxIndex = (*body)["message_index"].asInt();
        }

        const auto messagesRows = txn.exec_params(
            "SELECT role, content, metadata::text FROM ai_messages "
            "WHERE session_id = $1 ORDER BY created_at ASC",
            sessionId);

        int count = 0;
        for (const auto& msg : messagesRows) {
            if (maxIndex >= 0 && count > maxIndex) {
                break;
            }
            std::string role = msg["role"].as<std::string>();
            std::string content = msg["content"].as<std::string>();
            std::string metaStr = msg["metadata"].is_null() ? "{}" : msg["metadata"].as<std::string>();
            txn.exec_params(
                "INSERT INTO ai_messages (session_id, role, content, metadata) VALUES ($1, $2, $3, $4::jsonb)",
                newSessionId,
                role,
                content,
                metaStr);
            count++;
        }
        txn.commit();

        Json::Value payload;
        payload["success"] = true;
        Json::Value sessionObj;
        sessionObj["id"] = newSessionId;
        sessionObj["title"] = newTitle;
        sessionObj["session_type"] = sessionType;
        sessionObj["copied_messages"] = count;
        payload["session"] = sessionObj;
        sendJson(callback, payload);
    } catch (const std::exception& e) {
        spdlog::error("AI session branch failed: {}", e.what());
        sendError(callback, drogon::k500InternalServerError, "Failed to branch AI chat");
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
    // Runs off the event loop: this handler performs a synchronous call to
    // the AI service that can block for up to 120s, which would otherwise
    // occupy one of the few Drogon event-loop threads for its duration.
    BlockingTaskRunner::run([this, req, callback = std::move(callback), projectId]() mutable {
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
    });
}

void AiController::generateDockerfile(const drogon::HttpRequestPtr& req,
                                      std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                                      const std::string& projectId) {
    // Runs off the event loop: this handler performs a synchronous call to
    // the AI service that can block for up to 120s, which would otherwise
    // occupy one of the few Drogon event-loop threads for its duration.
    BlockingTaskRunner::run([this, req, callback = std::move(callback), projectId]() mutable {
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
    });
}

void AiController::chatProject(const drogon::HttpRequestPtr& req,
                               std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                               const std::string& projectId) {
    // Runs off the event loop: this handler performs a synchronous call to
    // the AI service that can block for up to 120s, which would otherwise
    // occupy one of the few Drogon event-loop threads for its duration.
    BlockingTaskRunner::run([this, req, callback = std::move(callback), projectId]() mutable {
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
    });
}

void AiController::analyzeBuildFailure(const drogon::HttpRequestPtr& req,
                                       std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                                       const std::string& deploymentId) {
    // Runs off the event loop: this handler performs a synchronous call to
    // the AI service that can block for up to 120s, which would otherwise
    // occupy one of the few Drogon event-loop threads for its duration.
    BlockingTaskRunner::run([this, req, callback = std::move(callback), deploymentId]() mutable {
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
    });
}

void AiController::repairDeployment(const drogon::HttpRequestPtr& req,
                                    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                                    const std::string& deploymentId) {
    BlockingTaskRunner::run([this, req, callback = std::move(callback), deploymentId]() mutable {
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
        const std::string projectId = deployment["project_id"].asString();
        Json::Value project = projectContext(txn, userId, projectId);

        // Find the source workspace directory
        std::filesystem::path sourceDir = std::filesystem::path("uploads/builds") / deploymentId / "source";
        if (!std::filesystem::exists(sourceDir)) {
            sourceDir = std::filesystem::path("uploads/builds") / deploymentId;
        }

        Json::Value sourceInfo(Json::objectValue);
        Json::Value filesArray(Json::arrayValue);
        Json::Value fileContents(Json::objectValue);
        size_t excerptBytes = 0;

        if (std::filesystem::exists(sourceDir)) {
            const auto end = std::filesystem::recursive_directory_iterator();
            for (auto it = std::filesystem::recursive_directory_iterator(sourceDir, std::filesystem::directory_options::skip_permission_denied);
                 it != end && filesArray.size() < 2000; ++it) {
                const auto& entry = *it;
                const auto filename = entry.path().filename().string();
                if (entry.is_directory() && (filename == ".git" || filename == "node_modules" || filename == ".next" || filename == ".venv" || filename == ".cache")) {
                    it.disable_recursion_pending();
                    continue;
                }
                if (entry.is_regular_file() && !entry.is_symlink()) {
                    auto relPath = std::filesystem::relative(entry.path(), sourceDir).string();
                    std::replace(relPath.begin(), relPath.end(), '\\', '/');
                    if (relPath.find(".git") == std::string::npos && relPath.find("node_modules") == std::string::npos && relPath.find(".next") == std::string::npos) {
                        filesArray.append(relPath);
                        // Read key configuration and build files for AI inspection
                        if (relPath.find("docker-compose") != std::string::npos ||
                            relPath.find("Dockerfile") != std::string::npos ||
                            relPath.find("package.json") != std::string::npos ||
                            relPath.find("nginx") != std::string::npos ||
                            filename == ".env.example" || filename == ".env.sample" ||
                            relPath.find("requirements.txt") != std::string::npos ||
                            relPath.find("build.gradle") != std::string::npos ||
                            relPath.find("pom.xml") != std::string::npos ||
                            relPath.find("conveyor.conf") != std::string::npos ||
                            relPath.find("Cargo.toml") != std::string::npos ||
                            relPath.find("go.mod") != std::string::npos) {
                            if (entry.file_size() > 64000 || excerptBytes >= 256000) continue;
                            std::ifstream f(entry.path());
                            if (f.is_open()) {
                                std::string content((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
                                if (content.size() <= 64000 && excerptBytes + content.size() <= 256000) {
                                    fileContents[relPath] = content;
                                    excerptBytes += content.size();
                                }
                            }
                        }
                    }
                }
            }
        }
        sourceInfo["file_tree"] = filesArray;
        sourceInfo["manifest_excerpts"] = fileContents;

        Json::Value reqBody = requestBody(req);
        reqBody["source"] = sourceInfo;
        reqBody["file_tree"] = filesArray;
        reqBody["manifest_excerpts"] = fileContents;

        Json::Value payload = buildPayload(prefs, reqBody, project, deployment);
        payload["source"] = sourceInfo;
        payload["workflow_type"] = "repair_project";

        payload["user_id"] = userId;
        payload["project_id"] = projectId;
        payload["deployment_id"] = deploymentId;
        // Release the inspection transaction while tools execute through the
        // authenticated backend path. This handler must never replay edits or
        // queue a second deployment after the agent already rebuilt the first.
        txn.commit();
        Json::Value result = runWorkflow("/repair/project", payload, providerOverrides(prefs));
        auto saveConn = Database::getInstance().getConnection();
        pqxx::work saveTxn(*saveConn);
        Json::Value appliedChanges(Json::arrayValue);
        const auto& output = result["structured_output"];
        if (output["file_changes"].isArray()) {
            for (const auto& change : output["file_changes"]) {
                Json::Value applied(Json::objectValue);
                applied["path"] = change["path"];
                applied["action"] = change["action"];
                applied["description"] = change["description"];
                appliedChanges.append(applied);
            }
        }
        const std::string jobId = output["verification"]["job_id"].isString() ? output["verification"]["job_id"].asString() : "";
        bool verified = false;
        if (!jobId.empty()) {
            auto evidence = saveTxn.exec_params(
                "SELECT 1 FROM deployments d JOIN deployment_jobs j ON j.id = d.job_id "
                "WHERE d.id = $1 AND j.id::text = $2 AND j.status = 'completed' "
                "AND d.status IN ('running', 'ready') AND j.metadata->'runtime_verification'->>'verified' = 'true'",
                deploymentId, jobId);
            verified = !evidence.empty() && output["verification"].get("verified", false).asBool();
        }
        result["verified"] = verified;
        if (!verified && result.get("status", "").asString() == "success") result["status"] = "unverified";
        result["repaired_deployment_id"] = deploymentId;
        result["applied_changes"] = appliedChanges;
        const std::string runId = insertAiRun(saveTxn, userId, "project_repair", payload, result,
                                              result.isMember("error") ? result["error"].asString() : "");
        linkAiRun(saveTxn, runId, projectId, deploymentId, jobId);
        storeArtifacts(saveTxn, runId, result);
        saveTxn.commit();
        result["run_id"] = runId;
        Json::Value audit;
        audit["run_id"] = runId;
        audit["deployment_id"] = deploymentId;
        audit["job_id"] = jobId;
        audit["verified"] = verified;
        AuditLogger::recordFromRequest(req, userId, verified ? "ai.project.repaired" : "ai.project.repair_attempted", "deployment", deploymentId, audit);
        sendJson(callback, result);
    } catch (const std::exception& e) {
        spdlog::error("AI project repair failed: {}", e.what());
        sendError(callback, drogon::k500InternalServerError, "AI project repair failed");
    }
    });
}

void AiController::repairProject(const drogon::HttpRequestPtr& req,
                                 std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                                 const std::string& projectId) {
    BlockingTaskRunner::run([this, req, callback = std::move(callback), projectId]() mutable {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        sendError(callback, drogon::k401Unauthorized, "Unauthorized");
        return;
    }

    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);
        auto rows = txn.exec_params(
            "SELECT id FROM deployments WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1",
            projectId
        );
        txn.commit();

        if (rows.empty()) {
            sendError(callback, drogon::k404NotFound, "No deployments found for project");
            return;
        }

        std::string latestDeploymentId = rows[0][0].as<std::string>();
        repairDeployment(req, std::move(callback), latestDeploymentId);
    } catch (const std::exception& e) {
        spdlog::error("repairProject error: {}", e.what());
        sendError(callback, drogon::k500InternalServerError, "Failed to locate latest deployment");
    }
    });
}

void AiController::analyzeRuntimeFailure(const drogon::HttpRequestPtr& req,
                                         std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                                         const std::string& deploymentId) {
    // Runs off the event loop: this handler performs a synchronous call to
    // the AI service that can block for up to 120s, which would otherwise
    // occupy one of the few Drogon event-loop threads for its duration.
    BlockingTaskRunner::run([this, req, callback = std::move(callback), deploymentId]() mutable {
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
    });
}

namespace {

std::string shellQuoteHelper(const std::string& value) {
    std::string out = "'";
    for (char c : value) {
        if (c == '\'') out += "'\\''";
        else out += c;
    }
    out += "'";
    return out;
}

bool isPowerShellAvailable() {
    static const bool available = []() {
        return (std::filesystem::exists("/usr/bin/pwsh") ||
                std::filesystem::exists("/usr/local/bin/pwsh") ||
                std::filesystem::exists("/opt/microsoft/powershell/7/pwsh") ||
                std::system("which pwsh >/dev/null 2>&1") == 0);
    }();
    return available;
}

std::string encodeUtf16LeBase64(const std::string& input) {
    std::string utf16;
    utf16.reserve(input.size() * 2);
    for (char c : input) {
        utf16.push_back(c);
        utf16.push_back('\0');
    }
    BIO* b64 = BIO_new(BIO_f_base64());
    BIO* bmem = BIO_new(BIO_s_mem());
    b64 = BIO_push(b64, bmem);
    BIO_set_flags(b64, BIO_FLAGS_BASE64_NO_NL);
    BIO_write(b64, utf16.data(), static_cast<int>(utf16.size()));
    (void)BIO_flush(b64);
    BUF_MEM* bptr = nullptr;
    BIO_get_mem_ptr(b64, &bptr);
    std::string encoded;
    if (bptr && bptr->data) {
        encoded.assign(bptr->data, bptr->length);
    }
    BIO_free_all(b64);
    return encoded;
}

std::string cleanPowerShellOutput(const std::string& raw) {
    if (raw.find("#< CLIXML") == std::string::npos) {
        return raw;
    }
    std::string cleaned;
    std::regex errorTagRegex("<S(?:[^>]*)>(.*?)</S>");
    auto words_begin = std::sregex_iterator(raw.begin(), raw.end(), errorTagRegex);
    auto words_end = std::sregex_iterator();
    for (std::sregex_iterator i = words_begin; i != words_end; ++i) {
        std::smatch match = *i;
        std::string tagContent = match[1].str();
        tagContent = std::regex_replace(tagContent, std::regex("_x001B_\\[[0-9;]*m"), "");
        tagContent = std::regex_replace(tagContent, std::regex("_x001B_"), "");
        tagContent = std::regex_replace(tagContent, std::regex("_x000D_"), "\r");
        tagContent = std::regex_replace(tagContent, std::regex("_x000A_"), "\n");
        cleaned += tagContent;
    }
    if (cleaned.empty()) {
        cleaned = std::regex_replace(raw, std::regex("<[^>]*>"), "");
        cleaned = std::regex_replace(cleaned, std::regex("#< CLIXML"), "");
    }
    return trimText(cleaned);
}

int runCommandCaptureExitHelper(const std::string& command, std::string& output) {
    output.clear();
#ifdef _WIN32
    FILE* pipe = _popen(command.c_str(), "r");
#else
    FILE* pipe = popen(command.c_str(), "r");
#endif
    if (!pipe) {
        output = "Failed to start command";
        return 1;
    }

    char buffer[4096];
    while (fgets(buffer, sizeof(buffer), pipe) != nullptr) {
        output += buffer;
        if (output.size() > 65536) {
            output += "\n... [output truncated at 64KB]";
            break;
        }
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

std::filesystem::path resolveSourceWorkspace(pqxx::work& txn, const std::string& userId,
                                            std::string depId, const std::string& projId,
                                            std::string& err) {
    namespace fs = std::filesystem;
    err.clear();

    depId = normalizeDeploymentId(txn, depId, userId);

    if (!depId.empty()) {
        auto ownerCheck = txn.exec_params(
            "SELECT 1 FROM deployments d JOIN projects p ON d.project_id = p.id "
            "WHERE d.id = $1 AND (p.user_id = $2 OR has_project_access(p.id, $2))", depId, userId);
        if (ownerCheck.empty()) {
            err = "Deployment not found or access denied";
            return {};
        }
        fs::path sourceRoot = fs::weakly_canonical(BuildService::getInstance().sourceWorkspace(depId));
        if (!fs::exists(sourceRoot)) {
            err = "Deployment workspace source not found. Source may not be built yet.";
            return {};
        }
        return sourceRoot;
    }

    if (!projId.empty()) {
        auto projRows = txn.exec_params(
            "SELECT p.id, p.repo_url, p.source_path FROM projects p "
            "WHERE p.id = $1 AND (p.user_id = $2 OR has_project_access(p.id, $2))", projId, userId);
        if (projRows.empty()) {
            err = "Project not found or access denied";
            return {};
        }

        // 1. Check latest deployment source
        auto depRows = txn.exec_params(
            "SELECT id FROM deployments WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1", projId);
        if (!depRows.empty()) {
            std::string latestDepId = depRows[0]["id"].as<std::string>();
            fs::path depSource = fs::weakly_canonical(BuildService::getInstance().sourceWorkspace(latestDepId));
            if (fs::exists(depSource)) {
                return depSource;
            }
        }

        // 2. Check project source path
        std::string sourcePath = projRows[0]["source_path"].is_null() ? "" : projRows[0]["source_path"].as<std::string>();
        if (!sourcePath.empty()) {
            fs::path pSource = fs::weakly_canonical(fs::path(sourcePath));
            if (fs::exists(pSource)) {
                return pSource;
            }
        }

        // 3. Check uploads/projects/<projId>/source
        fs::path projSource = fs::weakly_canonical(fs::path("uploads/projects") / projId / "source");
        if (fs::exists(projSource)) {
            return projSource;
        }

        // 4. If repo_url exists, clone shallowly to inspect
        std::string repoUrl = projRows[0]["repo_url"].is_null() ? "" : projRows[0]["repo_url"].as<std::string>();
        if (!repoUrl.empty() && (repoUrl.rfind("http://", 0) == 0 || repoUrl.rfind("https://", 0) == 0)) {
            std::error_code ec;
            fs::create_directories(projSource.parent_path(), ec);
            std::string cloneCmd = "GIT_TERMINAL_PROMPT=0 git clone --depth 1 " + shellQuoteHelper(repoUrl) + " " + shellQuoteHelper(projSource.string()) + " 2>&1";
            std::string cloneOut;
            int exitCode = runCommandCaptureExitHelper(cloneCmd, cloneOut);
            if (exitCode == 0 && fs::exists(projSource)) {
                return projSource;
            }
        }

        err = "Workspace source directory not found for this project. Try building or deploying the project first.";
        return {};
    }

    err = "Neither deployment_id nor project_id was provided";
    return {};
}

void guardWorkspaceMutation(pqxx::work& txn, const std::string& depId, std::string& err) {
    if (!err.empty() || depId.empty()) return;
    auto rows = txn.exec_params(
        "SELECT j.status FROM deployments d LEFT JOIN deployment_jobs j ON j.id = d.job_id "
        "WHERE d.id = $1 FOR UPDATE OF d", depId);
    if (!rows.empty() && !rows[0][0].is_null()) {
        const auto state = rows[0][0].as<std::string>();
        if (state == "queued" || state == "running" || state == "retrying")
            err = "Source edits are blocked while this deployment's build is active. Wait for its job to finish before applying the next fix.";
    }
}

} // namespace


void AiController::executeToolCall(const drogon::HttpRequestPtr& req,
                                   std::function<void(const drogon::HttpResponsePtr&)>&& callback) {
    // Accept requests from internal AI service token OR authenticated user session
    const char* serviceToken = std::getenv("STACKPILOT_AI_SERVICE_TOKEN");
    std::string expectedToken = (serviceToken && *serviceToken) ? serviceToken : "";
    std::string reqToken = req->getHeader("x-stackpilot-service-token");
    if (reqToken.empty()) {
        reqToken = req->getHeader("X-StackPilot-Service-Token");
    }

    std::string userId;
    bool isService = false;
    if (!expectedToken.empty() && !reqToken.empty() && reqToken.size() == expectedToken.size()) {
        isService = (CRYPTO_memcmp(reqToken.data(), expectedToken.data(), expectedToken.size()) == 0);
    }
    if (!isService) {
        userId = extractUserId(req);
        if (userId.empty()) {
            sendError(callback, drogon::k401Unauthorized, "Unauthorized");
            return;
        }
    }

    auto body = req->getJsonObject();
    if (!body || !body->isMember("tool_name") || !body->isMember("arguments")) {
        sendError(callback, drogon::k400BadRequest, "Missing required fields");
        return;
    }

    std::string toolName = (*body)["tool_name"].asString();
    if (toolName.rfind("_internal_", 0) == 0 && !isService) {
        sendError(callback, drogon::k403Forbidden, "Internal agent operations require service authentication");
        return;
    }
    if (userId.empty()) {
        if (body->isMember("user_id") && !(*body)["user_id"].asString().empty()) {
            userId = (*body)["user_id"].asString();
        } else {
            sendError(callback, drogon::k400BadRequest, "Missing user_id");
            return;
        }
    }
    Json::Value args = (*body)["arguments"];
    
    // Check if arguments is a string that needs to be parsed (sometimes happens with LLMs)
    if (args.isString()) {
        std::string argStr = args.asString();
        if (!argStr.empty()) {
            try {
                Json::Value parsed = parseJson(argStr);
                if (!parsed.isNull() && parsed.isObject()) {
                    args = parsed;
                }
            } catch (...) {
                // Ignore parse errors, keep original args
            }
        }
    }

    BlockingTaskRunner::run([toolName, userId, args, callback{std::move(callback)}]() mutable {
        try {
            auto conn = Database::getInstance().getConnection();
            pqxx::work txn(*conn);
            bool txnCommitted = false;
            Json::Value result(Json::objectValue);

            if (toolName == "agent_run_status" || toolName == "agent_cancel_run" || toolName == "agent_event_artifact") {
                const auto permission=toolName=="agent_cancel_run"?"admin":"viewer";
                auto runs=txn.exec_params("SELECT r.* FROM agent_runs r JOIN projects p ON p.id::text=r.project_id WHERE r.user_id=$1 AND (p.user_id=$1::uuid OR has_project_access(p.id,$1::uuid,$4)) AND (($2<>'' AND r.id=$2) OR ($2='' AND r.session_id=$3)) ORDER BY r.created_at DESC LIMIT 1",userId,args.get("run_id", "").asString(),args.get("session_id", "").asString(),permission);
                if(runs.empty())throw std::runtime_error("Agent run not found or access denied");
                const auto runId=runs[0]["id"].as<std::string>();
                result["run_id"]=runId;result["state"]=runs[0]["state"].as<std::string>();
                if(toolName=="agent_cancel_run") {
                    txn.exec_params("UPDATE agent_runs SET state='canceled',lead_until=0 WHERE id=$1",runId);
                    txn.exec_params("UPDATE agent_tasks SET state='canceled',lease_until=0 WHERE run_id=$1 AND state IN ('queued','running','blocked','submitted')",runId);
                    result["state"]="canceled";
                } else if(toolName=="agent_event_artifact") {
                    const auto artifactId=args.get("artifact_id", "").asString();
                    if(!std::regex_match(artifactId,std::regex("[a-fA-F0-9-]{36}")))throw std::runtime_error("Invalid event artifact identity");
                    auto file=std::filesystem::path(envOrDefault("STACKPILOT_AGENT_WORKSPACE_ROOT", "/app/agent-workspaces"))/runId/"artifacts"/(artifactId+".json");
                    if(!std::filesystem::is_regular_file(file) || std::filesystem::file_size(file)>4*1024*1024+128)throw std::runtime_error("Event artifact missing or too large");
                    std::ifstream input(file);input>>result;
                } else {
                    result["original_revision"]=runs[0]["original_revision"].as<std::string>();result["effective_revision"]=runs[0]["effective_revision"].as<std::string>();
                    Json::Value tasks(Json::arrayValue),events(Json::arrayValue),requirements(Json::arrayValue);
                    for(const auto& row:txn.exec_params("SELECT id,parent_id,role,goal,state,attempt,result FROM agent_tasks WHERE run_id=$1 ORDER BY created_at",runId)) {
                        Json::Value item;item["id"]=row["id"].as<std::string>();item["parent_id"]=row["parent_id"].as<std::string>();item["role"]=row["role"].as<std::string>();item["goal"]=row["goal"].as<std::string>();item["state"]=row["state"].as<std::string>();item["attempt"]=row["attempt"].as<int>();item["result"]=parseJson(row["result"].as<std::string>());tasks.append(item);
                    }
                    for(const auto& row:txn.exec_params("SELECT event FROM agent_events WHERE run_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 200",runId,std::max<Json::Int64>(0,args.get("after_sequence",0).asInt64())))events.append(parseJson(row[0].as<std::string>()));
                    for(const auto& row:txn.exec_params("SELECT id,task_id,kind,description FROM agent_requirements WHERE run_id=$1 AND state='open'",runId)) {
                        Json::Value item;for(const auto& key:{"id","task_id","kind","description"})item[key]=row[key].as<std::string>();requirements.append(item);
                    }
                    result["tasks"]=tasks;result["events"]=events;result["requirements"]=requirements;
                }
            } else if (toolName == "_internal_agent_authorize" || toolName == "_internal_agent_capabilities") {
                auto access=txn.exec_params("SELECT r.id FROM agent_runs r JOIN projects p ON p.id::text=r.project_id WHERE r.id=$1 AND r.user_id=$2 AND (p.user_id=$2::uuid OR has_project_access(p.id,$2::uuid,'admin')) AND r.state='working' AND r.deadline>EXTRACT(EPOCH FROM NOW())",args.get("run_id", "").asString(),userId);
                if(access.empty()) throw std::runtime_error("Agent run administration access or deadline revoked");
                result["authorized"]=true;
                if(toolName=="_internal_agent_capabilities") {
                    namespace fs=std::filesystem;
                    auto directory=fs::path("uploads/agent-capabilities");fs::create_directories(directory);
                    const auto stem=args.get("run_id", "").asString()+"-"+std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
                    // Run identity is already joined to the authenticated owner.
                    if(!std::regex_match(args.get("run_id", "").asString(),std::regex("[a-fA-F0-9-]{36}")))throw std::runtime_error("Invalid agent run identity");
                    const auto requestFile=directory/(stem+".request.json"),resultFile=directory/(stem+".result.json");
                    {std::ofstream output(requestFile);output<<Json::writeString(Json::StreamWriterBuilder(),args);}
                    txn.commit();txnCommitted=true;
                    std::string logs;
                    const auto root=envOrDefault("STACKPILOT_DEPLOYMENT_RUNTIME_ROOT", "/app/deployment-runtime");
                    const auto code=runCommandCaptureExitHelper("python3 "+shellQuoteHelper(root+"/sandbox_capabilities.py")+" "+shellQuoteHelper(requestFile.string())+" "+shellQuoteHelper(resultFile.string())+" 2>&1",logs);
                    if(code || !fs::is_regular_file(resultFile)) {result["status"]="unavailable";result["error"]="Sandbox registry unavailable: "+AiRedaction::redactText(logs,2000);}
                    else {std::ifstream input(resultFile);input>>result;}
                    std::error_code ignored;fs::remove(requestFile,ignored);fs::remove(resultFile,ignored);
                }
            } else if (toolName == "_internal_agent_workspace") {
                namespace fs = std::filesystem;
                std::string depId = normalizeDeploymentId(txn, args.get("deployment_id", "").asString(), userId);
                std::string projectId = args.get("project_id", "").asString();
                if (!depId.empty()) {
                    auto rows = txn.exec_params("SELECT project_id::text FROM deployments WHERE id=$1", depId);
                    if (rows.empty()) throw std::runtime_error("Deployment not found");
                    auto actualProject = rows[0][0].as<std::string>();
                    if (!projectId.empty() && projectId != actualProject) throw std::runtime_error("Cross-project deployment denied");
                    projectId = actualProject;
                }
                auto access = txn.exec_params("SELECT id FROM projects WHERE id=$1 AND (user_id=$2 OR has_project_access(id,$2,'admin'))", projectId, userId);
                if (access.empty()) throw std::runtime_error("Project administration access required for agent execution");
                if (depId.empty()) {
                    auto rows = txn.exec_params("SELECT id::text FROM deployments WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1", projectId);
                    if (!rows.empty()) depId = rows[0][0].as<std::string>();
                }
                std::string error;
                fs::path source = resolveSourceWorkspace(txn, userId, depId, projectId, error);
                if (!error.empty()) throw std::runtime_error(error);
                if (!depId.empty()) {
                    auto repaired = txn.exec_params("SELECT j.metadata->>'agent_run_id' AS run_id,j.metadata->>'agent_source_revision' AS revision FROM deployments d JOIN deployment_jobs j ON j.id=d.job_id WHERE d.id=$1", depId);
                    if (!repaired.empty() && !repaired[0]["run_id"].is_null() && !repaired[0]["revision"].is_null()) {
                        auto runId = repaired[0]["run_id"].as<std::string>();
                        auto revision = repaired[0]["revision"].as<std::string>();
                        if (!std::regex_match(runId,std::regex("[a-fA-F0-9-]{36}")) || !std::regex_match(revision,std::regex("[a-f0-9]{40,64}"))) throw std::runtime_error("Invalid repaired source identity");
                        auto root = fs::path(envOrDefault("STACKPILOT_AGENT_WORKSPACE_ROOT", "/app/agent-workspaces"));
                        auto sealed = root/runId/"releases"/revision;
                        if (fs::is_directory(sealed)) source = fs::weakly_canonical(sealed);
                    }
                }
                result["source_root"] = source.string();
                result["project_id"] = projectId;
                result["deployment_id"] = depId;
            } else if(toolName=="_internal_agent_instance_cleanup") {
                const auto runId=args.get("run_id","").asString();
                if(!std::regex_match(runId,std::regex("[a-fA-F0-9-]{36}")))throw std::runtime_error("Invalid agent run identity");
                if(args.isMember("expired_only") && !args["expired_only"].isBool())throw std::runtime_error("Instance cleanup mode must be boolean");
                const bool expiredOnly=args.get("expired_only",false).asBool();
                const auto access=txn.exec_params("SELECT r.id FROM agent_runs r JOIN projects p ON p.id::text=r.project_id WHERE r.id=$1 AND r.user_id=$2 AND (r.state<>'working' OR $3) AND (p.user_id=$2::uuid OR has_project_access(p.id,$2::uuid,'admin'))",runId,userId,expiredOnly);
                if(access.empty())throw std::runtime_error("Instance cleanup requires an authorized terminal run or expiry-only reconciliation");
                namespace fs=std::filesystem;
                const auto directory=fs::path("uploads/agent-processes");fs::create_directories(directory);
                const auto stem=runId+"-instance-cleanup-"+std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
                const auto request=directory/(stem+".request.json"),response=directory/(stem+".result.json");
                Json::Value specification;specification["operation"]="cleanup";specification["run_id"]=runId;specification["user_id"]=userId;specification["expired_only"]=expiredOnly;
                if(expiredOnly) {
                    Json::Value retired(Json::arrayValue);
                    for(const auto& task:txn.exec_params("SELECT id,attempt FROM agent_tasks WHERE run_id=$1 AND state IN ('completed','canceled','failed','submitted') LIMIT 128",runId)) {
                        Json::Value item;item["task_id"]=task["id"].as<std::string>();item["attempt"]=task["attempt"].as<int>();retired.append(item);
                    }
                    specification["retired_leases"]=retired;
                }
                {std::ofstream file(request);file<<Json::writeString(Json::StreamWriterBuilder(),specification);}
                txn.commit();txnCommitted=true;
                std::string logs;
                const auto helper=envOrDefault("STACKPILOT_DEPLOYMENT_RUNTIME_ROOT","/app/deployment-runtime")+"/agent_instance.py";
                const auto code=runCommandCaptureExitHelper("python3 "+shellQuoteHelper(helper)+" cleanup "+shellQuoteHelper(request.string())+" "+shellQuoteHelper(response.string())+" 2>&1",logs);
                if(code!=0 || !fs::is_regular_file(response))result["error"]="Instance cleanup unavailable: "+AiRedaction::redactText(logs,2000);
                else {std::ifstream file(response);file>>result;}
                std::error_code ignored;fs::remove(request,ignored);fs::remove(response,ignored);
            } else if(toolName=="_internal_agent_image_cleanup") {
                const auto runId=args.get("run_id","").asString();
                if(!std::regex_match(runId,std::regex("[a-fA-F0-9-]{36}")))throw std::runtime_error("Invalid agent run identity");
                const auto access=txn.exec_params("SELECT r.id FROM agent_runs r JOIN projects p ON p.id::text=r.project_id WHERE r.id=$1 AND r.user_id=$2 AND r.state<>'working' AND (p.user_id=$2::uuid OR has_project_access(p.id,$2::uuid,'admin'))",runId,userId);
                if(access.empty())throw std::runtime_error("SDK cleanup requires an authorized terminal run");
                namespace fs=std::filesystem;
                const auto directory=fs::path("uploads/agent-processes");fs::create_directories(directory);
                const auto stem=runId+"-cleanup-"+std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
                const auto request=directory/(stem+".request.json"),response=directory/(stem+".result.json");
                Json::Value specification;specification["run_id"]=runId;
                {std::ofstream file(request);file<<Json::writeString(Json::StreamWriterBuilder(),specification);}
                txn.commit();txnCommitted=true;
                std::string logs;
                const auto helper=envOrDefault("STACKPILOT_DEPLOYMENT_RUNTIME_ROOT","/app/deployment-runtime")+"/agent_image.py";
                const auto code=runCommandCaptureExitHelper("python3 "+shellQuoteHelper(helper)+" cleanup "+shellQuoteHelper(request.string())+" "+shellQuoteHelper(response.string())+" 2>&1",logs);
                if(code!=0 || !fs::is_regular_file(response))result["error"]="SDK cleanup unavailable: "+AiRedaction::redactText(logs,2000);
                else {std::ifstream file(response);file>>result;}
                std::error_code ignored;fs::remove(request,ignored);fs::remove(response,ignored);
            } else if (toolName == "_internal_agent_process" || toolName == "_internal_agent_image" || toolName == "_internal_agent_instance" || toolName == "_internal_agent_lease") {
                const std::string runId=args.get("run_id", "").asString(), taskId=args.get("task_id", "").asString();
                if (!std::regex_match(runId,std::regex("[a-fA-F0-9-]{36}")) || !std::regex_match(taskId,std::regex("[a-fA-F0-9-]{36}"))) throw std::runtime_error("Invalid agent identity");
                auto lease=txn.exec_params("SELECT t.spec FROM agent_tasks t JOIN agent_runs r ON r.id=t.run_id JOIN projects p ON p.id::text=r.project_id WHERE t.id=$1 AND r.id=$2 AND r.user_id=$3 AND (p.user_id=$3::uuid OR has_project_access(p.id,$3::uuid,'admin')) AND t.state='running' AND r.state='working' AND t.lease_owner=$4 AND t.attempt=$5 AND t.lease_until>EXTRACT(EPOCH FROM NOW()) AND r.deadline>EXTRACT(EPOCH FROM NOW())",taskId,runId,userId,args.get("lease_owner", "").asString(),args.get("attempt",0).asInt());
                if(lease.empty()) throw std::runtime_error("Agent execution lease or administration access revoked");
                result["authorized"]=true;
                if(toolName=="_internal_agent_process" || toolName=="_internal_agent_image" || toolName=="_internal_agent_instance") {
                    if(!envBool("STACKPILOT_AGENT_LOCAL_WORKERS",false)) throw std::runtime_error("Local Docker task workers are disabled; register an isolated worker capability");
                    namespace fs=std::filesystem;
                    auto root=fs::path(envOrDefault("STACKPILOT_AGENT_WORKSPACE_ROOT", "/app/agent-workspaces"));
                    auto source=root/runId/"tasks"/taskId;
                    if(!fs::is_directory(source)) throw std::runtime_error("Assigned task source missing");
                    Json::Value spec=args;
                    const bool instanceCommand=toolName=="_internal_agent_process" && args.isMember("sandbox_id");
                    const auto taskSpecification=parseJson(lease[0][0].as<std::string>());
                    if((toolName=="_internal_agent_instance" || instanceCommand) && taskSpecification.get("execution_kind","").asString()=="acceptance")throw std::runtime_error("Independent acceptance requires a fresh disposable worker");
                    if(toolName=="_internal_agent_instance") {
                        const auto operation=args.get("operation","").asString();
                        if(operation!="provision" && operation!="inspect" && operation!="release")throw std::runtime_error("Invalid task instance operation");
                        if(operation=="provision" && !envBool("STACKPILOT_AGENT_DOCKER_PROVISIONING",true))throw std::runtime_error("Docker instance provisioning is disabled");
                    } else if(instanceCommand)spec["operation"]="execute";
                    spec["write_scope"]=taskSpecification["write_scope"];
                    spec["user_id"]=userId;
                    auto temporaryRoot=fs::path("uploads/agent-processes");fs::create_directories(temporaryRoot);
                    auto stem=taskId+"-"+std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
                    auto requestFile=temporaryRoot/(stem+".request.json"), resultFile=temporaryRoot/(stem+".result.json");
                    {std::ofstream file(requestFile);file<<Json::writeString(Json::StreamWriterBuilder(),spec);}
                    txn.commit();txnCommitted=true;
                    std::string logs;
                    auto runtimeRoot=envOrDefault("STACKPILOT_DEPLOYMENT_RUNTIME_ROOT", "/app/deployment-runtime");
                    const auto helper=(toolName=="_internal_agent_instance" || instanceCommand)?"/agent_instance.py":toolName=="_internal_agent_image"?"/agent_image.py":"/agent_process.py";
                    auto code=runCommandCaptureExitHelper("python3 "+shellQuoteHelper(runtimeRoot+helper)+" "+shellQuoteHelper(source.string())+" "+shellQuoteHelper(requestFile.string())+" "+shellQuoteHelper(resultFile.string())+" 2>&1",logs);
                    if(code!=0 || !fs::is_regular_file(resultFile)) result["error"]="Worker adapter failed: "+AiRedaction::redactText(logs,2000);
                    else {std::ifstream file(resultFile);file>>result;if(result.isMember("output"))result["output"]=AiRedaction::redactText(result["output"].asString(),65536);}
                    std::error_code ignored;fs::remove(requestFile,ignored);fs::remove(resultFile,ignored);
                }
            } else if (toolName == "_internal_repair_settings") {
                const auto preferences=loadPreferences(txn,userId);
                result["enabled"]=preferences["enabled"];
                result["provider"]=preferences["provider"];
                result["model"]=preferences["model"];
                result["provider_overrides"]=providerOverrides(preferences);
            } else if (toolName == "get_deployment_status") {
                std::string depId = args.isMember("deployment_id") ? args["deployment_id"].asString() : "";
                depId = normalizeDeploymentId(txn, depId, userId);
                const auto rows = txn.exec_params(
                    "SELECT d.id, d.status, d.runtime_url, p.name as project_name, d.created_at, d.job_id, j.status AS job_status, "
                    "COALESCE(j.metadata->'runtime_verification'->>'verified', 'false') AS runtime_verified, "
                    "COALESCE(j.metadata->'runtime_verification'->>'scope', 'unverified') AS verification_scope, "
                    "h.healthy AS observed_healthy, h.observed_at, (h.observed_at>NOW()-INTERVAL '3 minutes') AS observation_fresh "
                    "FROM deployments d JOIN projects p ON d.project_id = p.id "
                    "LEFT JOIN deployment_jobs j ON j.id = d.job_id "
                    "LEFT JOIN deployment_health_observations h ON h.deployment_id=d.id "
                    "WHERE d.id = $1 AND (p.user_id = $2 OR has_project_access(p.id, $2))",
                    depId, userId);
                if (rows.empty()) {
                    result["error"] = "Deployment not found or access denied";
                } else {
                    result["status"] = rows[0]["status"].as<std::string>();
                    result["runtime_url"] = rows[0]["runtime_url"].is_null() ? "" : rows[0]["runtime_url"].as<std::string>();
                    result["project_name"] = rows[0]["project_name"].as<std::string>();
                    result["created_at"] = rows[0]["created_at"].as<std::string>();
                    result["job_id"] = rows[0]["job_id"].is_null() ? "" : rows[0]["job_id"].as<std::string>();
                    result["job_status"] = rows[0]["job_status"].is_null() ? "" : rows[0]["job_status"].as<std::string>();
                    result["verified"] = (result["status"].asString() == "running" || result["status"].asString() == "ready") &&
                        result["job_status"].asString() == "completed" && rows[0]["runtime_verified"].as<std::string>() == "true";
                    result["verification_scope"] = rows[0]["verification_scope"].as<std::string>();
                    result["release_verified"] = result["verified"];
                    if(!rows[0]["observed_healthy"].is_null()) {
                        result["healthy"] = rows[0]["observed_healthy"].as<bool>();
                        result["health_observed_at"] = rows[0]["observed_at"].as<std::string>();
                        result["health_observation_fresh"] = rows[0]["observation_fresh"].as<bool>();
                        if(result["health_observation_fresh"].asBool() && !result["healthy"].asBool())result["verified"]=false;
                    }
                }
            } else if (toolName == "list_deployments") {
                const auto rows = txn.exec_params(
                    "SELECT d.id, d.status, d.runtime_url, p.name as project_name "
                    "FROM deployments d JOIN projects p ON d.project_id = p.id "
                    "WHERE (p.user_id = $1 OR has_project_access(p.id, $1)) ORDER BY d.created_at DESC LIMIT 10",
                    userId);
                Json::Value deps(Json::arrayValue);
                for (const auto& row : rows) {
                    Json::Value dep(Json::objectValue);
                    dep["id"] = row["id"].as<std::string>();
                    dep["status"] = row["status"].as<std::string>();
                    dep["url"] = row["runtime_url"].is_null() ? "" : row["runtime_url"].as<std::string>();
                    dep["runtime_url"] = dep["url"];
                    dep["project_name"] = row["project_name"].as<std::string>();
                    deps.append(dep);
                }
                result["deployments"] = deps;
            } else if (toolName == "list_projects") {
                const auto rows = txn.exec_params(
                    "SELECT id, name FROM projects WHERE user_id = $1 LIMIT 10",
                    userId);
                Json::Value projs(Json::arrayValue);
                for (const auto& row : rows) {
                    Json::Value p(Json::objectValue);
                    p["id"] = row["id"].as<std::string>();
                    p["name"] = row["name"].as<std::string>();
                    projs.append(p);
                }
                result["projects"] = projs;
            } else if (toolName == "get_session_context") {
                std::string sessId = args.isMember("session_id") ? args["session_id"].asString() : "";
                if (!sessId.empty()) {
                    const auto rows = txn.exec_params(
                        "SELECT id, project_id, deployment_id, session_type, status FROM ai_sessions WHERE id = $1",
                        sessId);
                    if (!rows.empty()) {
                        result["session_id"] = rows[0]["id"].as<std::string>();
                        result["project_id"] = rows[0]["project_id"].is_null() ? "" : rows[0]["project_id"].as<std::string>();
                        result["deployment_id"] = rows[0]["deployment_id"].is_null() ? "" : rows[0]["deployment_id"].as<std::string>();
                        result["session_type"] = rows[0]["session_type"].as<std::string>();
                        result["status"] = rows[0]["status"].as<std::string>();
                        std::string depId = result["deployment_id"].asString();
                        std::string projId = result["project_id"].asString();
                        if (depId.empty() && !projId.empty()) {
                            const auto dLatest = txn.exec_params(
                                "SELECT id, status, logs FROM deployments WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1",
                                projId);
                            if (!dLatest.empty()) {
                                depId = dLatest[0]["id"].as<std::string>();
                                result["deployment_id"] = depId;
                                result["deployment_status"] = dLatest[0]["status"].as<std::string>();
                                result["logs"] = dLatest[0]["logs"].is_null() ? "" : dLatest[0]["logs"].as<std::string>();
                            }
                        } else if (!depId.empty()) {
                            const auto dRows = txn.exec_params("SELECT status, logs FROM deployments WHERE id = $1", depId);
                            if (!dRows.empty()) {
                                result["deployment_status"] = dRows[0]["status"].as<std::string>();
                                result["logs"] = dRows[0]["logs"].is_null() ? "" : dRows[0]["logs"].as<std::string>();
                            }
                        }
                    } else {
                        result["error"] = "Session not found";
                    }
                } else {
                    result["error"] = "Missing session_id";
                }
            } else if (toolName == "workspace_list_files") {
                std::string depId = args.isMember("deployment_id") ? args["deployment_id"].asString() : "";
                depId = normalizeDeploymentId(txn, depId, userId);
                std::string projId = args.isMember("project_id") ? args["project_id"].asString() : "";
                std::string subPath = args.isMember("path") ? args["path"].asString() : "";

                std::string err;
                namespace fs = std::filesystem;
                fs::path sourceRoot = resolveSourceWorkspace(txn, userId, depId, projId, err);
                if (!err.empty()) {
                    result["error"] = err;
                } else {
                    fs::path targetDir = subPath.empty() ? sourceRoot : fs::weakly_canonical(sourceRoot / subPath);
                    const fs::path relative = targetDir.lexically_relative(sourceRoot);
                    if (relative.empty() || relative.is_absolute() || *relative.begin() == "..") {
                        result["error"] = "Path traversal denied";
                    } else if (!fs::exists(targetDir)) {
                        result["error"] = "Directory not found: " + subPath;
                    } else {
                        Json::Value files(Json::arrayValue);
                        for (const auto& entry : fs::directory_iterator(targetDir)) {
                            Json::Value f;
                            f["name"] = entry.path().filename().string();
                            f["type"] = entry.is_directory() ? "directory" : "file";
                            if (entry.is_regular_file()) {
                                f["size"] = static_cast<Json::Int64>(entry.file_size());
                            }
                            files.append(f);
                        }
                        result["files"] = files;
                        result["path"] = subPath.empty() ? "/" : subPath;
                    }
                }
            } else if (toolName == "workspace_read_file") {
                std::string depId = args.isMember("deployment_id") ? args["deployment_id"].asString() : "";
                depId = normalizeDeploymentId(txn, depId, userId);
                std::string projId = args.isMember("project_id") ? args["project_id"].asString() : "";
                std::string filePath = args["file_path"].asString();

                std::string err;
                namespace fs = std::filesystem;
                fs::path sourceRoot = resolveSourceWorkspace(txn, userId, depId, projId, err);
                if (!err.empty()) {
                    result["error"] = err;
                } else {
                    fs::path target = fs::weakly_canonical(sourceRoot / filePath);
                    const fs::path relative = target.lexically_relative(sourceRoot);
                    if (relative.empty() || relative.is_absolute() || *relative.begin() == "..") {
                        result["error"] = "Path traversal denied";
                    } else if (!fs::exists(target) || !fs::is_regular_file(target)) {
                        result["error"] = "File not found: " + filePath;
                    } else {
                        auto fileSize = fs::file_size(target);
                        if (fileSize > 102400) {
                            result["error"] = "File too large to read (limit 100KB). Size: " + std::to_string(fileSize);
                        } else {
                            std::ifstream in(target, std::ios::binary);
                            std::string content((std::istreambuf_iterator<char>(in)),
                                                 std::istreambuf_iterator<char>());
                            result["content"] = content;
                            result["file_path"] = filePath;
                            result["size"] = static_cast<Json::Int64>(fileSize);
                        }
                    }
                }
            } else if (toolName == "workspace_write_file") {
                std::string depId = args.isMember("deployment_id") ? args["deployment_id"].asString() : "";
                depId = normalizeDeploymentId(txn, depId, userId);
                std::string projId = args.isMember("project_id") ? args["project_id"].asString() : "";
                std::string filePath = args["file_path"].asString();
                std::string content = args["content"].asString();

                std::string err;
                namespace fs = std::filesystem;
                fs::path sourceRoot = resolveSourceWorkspace(txn, userId, depId, projId, err);
                guardWorkspaceMutation(txn, depId, err);
                if (!err.empty()) {
                    result["error"] = err;
                } else {
                    fs::path target = fs::weakly_canonical(sourceRoot / filePath);
                    const fs::path relative = target.lexically_relative(sourceRoot);
                    if (relative.empty() || relative.is_absolute() || *relative.begin() == "..") {
                        result["error"] = "Path traversal denied";
                    } else {
                        std::error_code ec;
                        fs::create_directories(target.parent_path(), ec);
                        std::ofstream out(target, std::ios::binary | std::ios::trunc);
                        if (!out.is_open()) {
                            result["error"] = "Failed to open file for writing: " + filePath;
                        } else {
                            out << content;
                            out.close();
                            result["status"] = "written";
                            result["file_path"] = filePath;
                            result["bytes_written"] = static_cast<Json::Int64>(content.size());
                        }
                    }
                }
            } else if (toolName == "workspace_edit_file") {
                std::string depId = args.isMember("deployment_id") ? args["deployment_id"].asString() : "";
                depId = normalizeDeploymentId(txn, depId, userId);
                std::string projId = args.isMember("project_id") ? args["project_id"].asString() : "";
                std::string filePath = args["file_path"].asString();
                std::string target = args["target"].asString();
                std::string replacement = args["replacement"].asString();

                std::string err;
                namespace fs = std::filesystem;
                fs::path sourceRoot = resolveSourceWorkspace(txn, userId, depId, projId, err);
                guardWorkspaceMutation(txn, depId, err);
                if (!err.empty()) {
                    result["error"] = err;
                } else {
                    fs::path targetFile = fs::weakly_canonical(sourceRoot / filePath);
                    const fs::path relative = targetFile.lexically_relative(sourceRoot);
                    if (relative.empty() || relative.is_absolute() || *relative.begin() == "..") {
                        result["error"] = "Path traversal denied";
                    } else if (!fs::exists(targetFile) || !fs::is_regular_file(targetFile)) {
                        result["error"] = "File not found: " + filePath;
                    } else {
                        std::ifstream in(targetFile, std::ios::binary);
                        std::string content((std::istreambuf_iterator<char>(in)),
                                             std::istreambuf_iterator<char>());
                        in.close();

                        auto pos = content.find(target);
                        if (pos == std::string::npos) {
                            result["error"] = "Target text not found in file";
                        } else {
                            content.replace(pos, target.size(), replacement);
                            std::ofstream out(targetFile, std::ios::binary | std::ios::trunc);
                            out << content;
                            out.close();
                            result["status"] = "edited";
                            result["file_path"] = filePath;
                            result["message"] = "Successfully replaced target text";
                        }
                    }
                }
            } else if (toolName == "terminal_run_command") {
                std::string cmd = args["command"].asString();
                std::string depId = args.isMember("deployment_id") ? args["deployment_id"].asString() : "";
                depId = normalizeDeploymentId(txn, depId, userId);
                std::string projId = args.isMember("project_id") ? args["project_id"].asString() : "";

                std::string lowerCmd = cmd;
                std::transform(lowerCmd.begin(), lowerCmd.end(), lowerCmd.begin(), ::tolower);
                if (lowerCmd.find("apt-get") != std::string::npos ||
                    lowerCmd.find("apt ") != std::string::npos ||
                    lowerCmd.find("sudo ") != std::string::npos ||
                    lowerCmd.find("yum ") != std::string::npos ||
                    lowerCmd.find("pacman ") != std::string::npos ||
                    lowerCmd.find("apk add") != std::string::npos) {
                    result["status"] = "error";
                    result["exit_code"] = 126;
                    result["error"] = "System package manager commands ('apt-get', 'sudo', 'apk', 'yum') cannot be executed in the workspace terminal because the backend runs as an unprivileged process.";
                    result["output"] = result["error"].asString() + "\nHint: To install packages or compilers, define them in a Dockerfile using 'workspace_write_file' or 'workspace_edit_file', then trigger a containerized build using 'workspace_trigger_rebuild'.";
                    result["stderr"] = result["output"];
                    result["hint"] = "Configure your dependencies in a Dockerfile and invoke workspace_trigger_rebuild.";
                } else if (lowerCmd.find("rm -rf /") != std::string::npos ||
                    lowerCmd.find("mkfs") != std::string::npos ||
                    lowerCmd.find("reboot") != std::string::npos ||
                    lowerCmd.find("shutdown") != std::string::npos) {
                    result["error"] = "Command blocked by security policy";
                } else {
                    std::string err;
                    namespace fs = std::filesystem;
                    fs::path sourceRoot = resolveSourceWorkspace(txn, userId, depId, projId, err);
                    if (!err.empty()) {
                        result["error"] = err;
                    } else {
                        std::string fullCmd;
                        std::string shellName = "bash";
                        if (isPowerShellAvailable()) {
                            shellName = "powershell";
                            std::string psScript = "Set-Location -LiteralPath '" + sourceRoot.string() + "'; " + cmd;
                            std::string b64 = encodeUtf16LeBase64(psScript);
                            fullCmd = "pwsh -NoProfile -NonInteractive -EncodedCommand " + b64 + " 2>&1";
                        } else {
                            fullCmd = "cd " + shellQuoteHelper(sourceRoot.string()) + " && " + cmd + " 2>&1";
                        }

                        std::string output;
                        int exitCode = runCommandCaptureExitHelper(fullCmd, output);
                        if (shellName == "powershell") {
                            output = cleanPowerShellOutput(output);
                        }
                        if (output.size() > 65536) {
                            output = output.substr(0, 65536) + "\n... [output truncated at 64KB]";
                        }
                        result["status"] = "ok";
                        result["shell"] = shellName;
                        result["command"] = cmd;
                        result["exit_code"] = exitCode;
                        result["stdout"] = (exitCode == 0 ? output : "");
                        result["stderr"] = (exitCode != 0 ? output : "");
                        result["output"] = output;
                        result["cwd"] = sourceRoot.string();
                        result["working_directory"] = sourceRoot.string();
                    }
                }
            } else if (toolName == "workspace_trigger_rebuild") {
                std::string depId;
                if(args.isMember("agent_run_id")) {
                    const auto runId=args["agent_run_id"].asString();
                    auto owned=txn.exec_params("SELECT r.project_id,r.deployment_id FROM agent_runs r JOIN projects p ON p.id::text=r.project_id WHERE r.id=$1 AND r.user_id=$2 AND r.state='working' AND r.deadline>EXTRACT(EPOCH FROM NOW()) AND (p.user_id=$2::uuid OR has_project_access(p.id,$2::uuid,'admin')) FOR UPDATE OF r",runId,userId);
                    if(owned.empty())throw std::runtime_error("Agent release administration access revoked");
                    depId=owned[0]["deployment_id"].as<std::string>();
                    if(depId.empty()) {
                        auto created=txn.exec_params("INSERT INTO deployments(project_id,version,commit_hash,trigger_source,environment_id) VALUES($1::uuid,'agent-v1',$2,'ai_repair',(SELECT id FROM project_environments WHERE project_id=$1::uuid ORDER BY CASE WHEN lower(name)='production' THEN 0 ELSE 1 END,name LIMIT 1)) RETURNING id::text",owned[0]["project_id"].as<std::string>(),args.get("agent_source_revision", "").asString());
                        depId=created[0][0].as<std::string>();
                        txn.exec_params("UPDATE agent_runs SET deployment_id=$1 WHERE id=$2",depId,runId);
                    }
                    if(!args.get("deployment_id", "").asString().empty() && args["deployment_id"].asString()!=depId)throw std::runtime_error("Cross-deployment agent release denied");
                } else depId = normalizeDeploymentId(txn, args["deployment_id"].asString(), userId);
                args["deployment_id"] = depId;

                auto depRows = txn.exec_params(
                    "SELECT d.id FROM deployments d JOIN projects p ON d.project_id = p.id "
                    "WHERE d.id = $1 AND (p.user_id = $2 OR has_project_access(p.id, $2, 'admin'))", depId, userId);
                if (depRows.empty()) {
                    result["error"] = "Deployment not found or access denied";
                } else {
                    namespace fs = std::filesystem;
                    fs::path sourceDir = BuildService::getInstance().sourceWorkspace(depId);
                    if (!fs::exists(sourceDir) && !args.isMember("agent_run_id")) {
                        result["error"] = "No source workspace found. The deployment must be built at least once before triggering a rebuild.";
                    } else {
                        txn.commit();
                        txnCommitted = true;

                        std::string sessionId = args.isMember("session_id") ? args["session_id"].asString() : "";
                        Json::Value meta(Json::objectValue);
                        meta["ai_repair"] = true;
                        if (!sessionId.empty()) {
                            meta["ai_session_id"] = sessionId;
                        }
                        if(args.isMember("agent_run_id")) {
                            const auto runId=args["agent_run_id"].asString(), revision=args.get("agent_source_revision", "").asString();
                            if(!std::regex_match(runId,std::regex("[a-fA-F0-9-]{36}")) || !std::regex_match(revision,std::regex("[a-f0-9]{40,64}"))) throw std::runtime_error("Invalid agent source identity");
                            auto runConn=Database::getInstance().getConnection();pqxx::work runTxn(*runConn);
                            auto accepted=runTxn.exec_params("SELECT id,settings FROM agent_runs WHERE id=$1 AND user_id=$2 AND deployment_id=$3 AND state='working' AND effective_revision=$4 AND deadline>EXTRACT(EPOCH FROM NOW())",runId,userId,depId,revision);
                            if(accepted.empty()) throw std::runtime_error("Accepted agent source does not belong to this deployment");
                            auto pending=runTxn.exec_params("SELECT id FROM agent_tasks WHERE run_id=$1 AND state IN ('queued','running','blocked','submitted') LIMIT 1",runId);
                            if(!pending.empty()) throw std::runtime_error("Unfinished team tasks cannot be published");
                            auto sealed=fs::path(envOrDefault("STACKPILOT_AGENT_WORKSPACE_ROOT", "/app/agent-workspaces"))/runId/"releases"/revision;
                            if(!fs::is_regular_file(sealed/".stackpilot-source.json")) throw std::runtime_error("Sealed agent source is unavailable");
                            Json::Value contract;{std::ifstream input(sealed/"stackpilot.json");if(input)input>>contract;}
                            bool testsRequired=contract.get("tests_required",false).asBool() || !contract["tests"].empty();
                            if(contract["components"].isArray())for(const auto& component:contract["components"])testsRequired=testsRequired || component.get("tests_required",false).asBool() || !component["tests"].empty();
                            auto completion=runTxn.exec_params("SELECT contract,contract_digest FROM agent_completion_plans WHERE run_id=$1",runId);
                            const bool completionRequired=parseJson(accepted[0]["settings"].as<std::string>()).get("completion_required",false).asBool() || !completion.empty();
                            if(completionRequired && completion.empty())throw std::runtime_error("Repository completion contract is missing; define and verify the finished features before release");
                            testsRequired=testsRequired || completionRequired;
                            if(testsRequired) {
                                auto proof=runTxn.exec_params("SELECT evidence FROM agent_verifications WHERE run_id=$1 AND revision=$2 AND status='passed'",runId,revision);
                                if(proof.empty())throw std::runtime_error("Independent repository acceptance has not passed for this source revision");
                                meta["agent_acceptance"]=parseJson(proof[0][0].as<std::string>());
                                if(completionRequired) {
                                    const auto plan=parseJson(completion[0]["contract"].as<std::string>());
                                    const auto& evidence=meta["agent_acceptance"];
                                    if(evidence.get("completion_digest", "").asString()!=completion[0]["contract_digest"].as<std::string>() ||
                                       !evidence.get("verified",false).asBool() || evidence.get("revision", "").asString()!=revision ||
                                       !evidence["features"].isArray() || evidence["features"].size()!=plan["features"].size())
                                        throw std::runtime_error("Completion verification does not match the frozen contract and source");
                                    for(const auto& feature:plan["features"]) {
                                        bool passed=false;
                                        for(const auto& observed:evidence["features"])if(observed["id"]==feature["id"] && observed["status"].asString()=="passed")passed=true;
                                        if(!passed)throw std::runtime_error("Unfinished feature: "+feature["id"].asString());
                                    }
                                    meta["completion_contract_digest"]=completion[0]["contract_digest"].as<std::string>();
                                }
                            }
                            meta["agent_run_id"]=runId;meta["agent_source_revision"]=revision;
                            meta["agent_source_path"]=sealed.string();
                        }
                        Json::StreamWriterBuilder writer;
                        writer["indentation"] = "";
                        std::string metaStr = Json::writeString(writer, meta);

                        Json::Value job = JobQueueService::getInstance().enqueueDeploymentBuild(
                            depId, userId,
                            "AI rebuild queued from modified source workspace.",
                            metaStr
                        );
                        result["status"] = "rebuild_queued";
                        result["deployment_id"] = depId;
                        result["job_id"] = job["id"].asString();
                        result["message"] = "Rebuild from modified source queued successfully. The build will use your edited files without re-cloning.";
                    }
                }
            } else if (toolName == "wait_for_deployment") {
                std::string depId = normalizeDeploymentId(txn, args["deployment_id"].asString(), userId);
                txn.commit();
                txnCommitted = true;

                int timeoutSec = 180;
                if (args.isMember("timeout_seconds")) {
                    if (args["timeout_seconds"].isInt()) {
                        timeoutSec = std::clamp(args["timeout_seconds"].asInt(), 10, 600);
                    } else if (args["timeout_seconds"].isString()) {
                        try { timeoutSec = std::clamp(std::stoi(args["timeout_seconds"].asString()), 10, 600); } catch (...) {}
                    }
                }
                
                auto startTime = std::chrono::steady_clock::now();
                std::string currentStatus = "unknown";
                std::string runtimeUrl = "";
                std::string logs = "";
                bool terminal = false;
                std::string expectedJobId = args.get("job_id", "").asString();
                std::string observedJobId;
                std::string jobStatus;
                bool runtimeVerified = false;
                std::string verificationScope="unverified";

                while (true) {
                    {
                        auto pollConn = Database::getInstance().getConnection();
                        pqxx::work pollTxn(*pollConn);
                        auto depRows = pollTxn.exec_params(
                            "SELECT d.status, d.runtime_url, d.logs, d.job_id, j.status AS job_status, "
                            "COALESCE(j.metadata->'runtime_verification'->>'verified', 'false') AS runtime_verified, COALESCE(j.metadata->'runtime_verification'->>'scope','unverified') AS verification_scope "
                            "FROM deployments d JOIN projects p ON d.project_id = p.id "
                            "LEFT JOIN deployment_jobs j ON j.id = d.job_id "
                            "WHERE d.id = $1 AND (p.user_id = $2 OR has_project_access(p.id, $2))",
                            depId, userId);
                        if (!depRows.empty()) {
                            currentStatus = depRows[0]["status"].as<std::string>();
                            runtimeUrl = depRows[0]["runtime_url"].is_null() ? "" : depRows[0]["runtime_url"].as<std::string>();
                            logs = depRows[0]["logs"].is_null() ? "" : depRows[0]["logs"].as<std::string>();
                            observedJobId = depRows[0]["job_id"].is_null() ? "" : depRows[0]["job_id"].as<std::string>();
                            jobStatus = depRows[0]["job_status"].is_null() ? "" : depRows[0]["job_status"].as<std::string>();
                            runtimeVerified = depRows[0]["runtime_verified"].as<std::string>() == "true";
                            verificationScope=depRows[0]["verification_scope"].as<std::string>();
                            if (expectedJobId.empty()) expectedJobId = observedJobId;
                            if (expectedJobId != observedJobId) {
                                currentStatus = "superseded";
                                terminal = true;
                            } else if (((currentStatus == "running" || currentStatus == "ready") && jobStatus == "completed") ||
                                currentStatus == "failed" || currentStatus == "error" ||
                                currentStatus == "crash_loop_backoff" || currentStatus == "built" || currentStatus == "canceled") {
                                terminal = true;
                            }
                        } else {
                            currentStatus = "not_found";
                            terminal = true;
                        }
                        pollTxn.commit();
                    }

                    if (terminal) break;

                    auto elapsed = std::chrono::duration_cast<std::chrono::seconds>(
                        std::chrono::steady_clock::now() - startTime).count();
                    if (elapsed >= timeoutSec) break;

                    std::this_thread::sleep_for(std::chrono::milliseconds(2000));
                }

                auto totalElapsed = std::chrono::duration_cast<std::chrono::seconds>(
                    std::chrono::steady_clock::now() - startTime).count();

                result["deployment_id"] = depId;
                result["status"] = currentStatus;
                result["runtime_url"] = runtimeUrl;
                result["elapsed_seconds"] = static_cast<int>(totalElapsed);
                result["job_id"] = observedJobId;
                result["job_status"] = jobStatus;
                result["verification_scope"]=verificationScope;
                result["verified"] = terminal && expectedJobId == observedJobId && jobStatus == "completed" && runtimeVerified &&
                    (currentStatus == "running" || currentStatus == "ready");

                if (currentStatus == "running" || currentStatus == "ready") {
                    result["message"] = result["verified"].asBool()
                        ? "This exact build completed and passed its workload contract. Undeclared business and device workflows remain unverified."
                        : "Container status is running, but this build has not passed runtime browser verification. Do not report the repair as verified.";
                } else if (currentStatus == "failed" || currentStatus == "error" || currentStatus == "crash_loop_backoff") {
                    result["message"] = "Deployment failed. Inspect the logs in recent_logs to apply further fixes.";
                    if (logs.size() > 4096) {
                        result["recent_logs"] = logs.substr(logs.size() - 4096);
                    } else {
                        result["recent_logs"] = logs;
                    }
                } else {
                    result["message"] = "Deployment still in progress (" + currentStatus + ") after " + std::to_string(totalElapsed) + " seconds.";
                }
            } else if (toolName == "get_deployment_logs") {
                std::string depId = args.isMember("deployment_id") ? args["deployment_id"].asString() : "";
                depId = normalizeDeploymentId(txn, depId, userId);
                auto depRows = txn.exec_params(
                    "SELECT d.id, d.status, d.logs FROM deployments d JOIN projects p ON d.project_id = p.id "
                    "WHERE d.id = $1 AND (p.user_id = $2 OR has_project_access(p.id, $2))", depId, userId);
                if (depRows.empty()) {
                    result["error"] = "Deployment not found or access denied";
                } else {
                    std::string logs = depRows[0]["logs"].is_null() ? "" : depRows[0]["logs"].as<std::string>();
                    result["status"] = "ok";
                    result["deployment_id"] = depId;
                    result["deployment_status"] = depRows[0]["status"].as<std::string>();
                    if (logs.size() > 65536) {
                        result["logs"] = "... [logs truncated, showing last 64KB]\n" + logs.substr(logs.size() - 65536);
                    } else {
                        result["logs"] = logs;
                    }
                }
            } else if (toolName == "get_deployment_metrics" || toolName == "scale_deployment") {
                const std::string id = normalizeDeploymentId(txn, args.get("deployment_id", "").asString(), userId);
                txn.commit(); txnCommitted = true;
                result = toolName == "get_deployment_metrics"
                    ? DeploymentOperations::metrics(id, userId)
                    : DeploymentOperations::scale(id, userId, args.get("replicas", 1).asInt());
            } else if (toolName == "trigger_build") {
                std::string depId = args.isMember("deployment_id") ? args["deployment_id"].asString() : "";
                depId = normalizeDeploymentId(txn, depId, userId);
                auto depRows = txn.exec_params(
                    "SELECT d.id, d.project_id FROM deployments d JOIN projects p ON d.project_id = p.id "
                    "WHERE d.id = $1 AND (p.user_id = $2 OR has_project_access(p.id, $2))", depId, userId);
                if (depRows.empty()) {
                    result["error"] = "Deployment not found or access denied";
                } else {
                    txn.commit();
                    txnCommitted = true;

                    Json::Value job = JobQueueService::getInstance().enqueueDeploymentBuild(
                        depId, userId,
                        "Deployment build queued by AI assistant.",
                        "{\"triggered_by\":\"ai\"}"
                    );
                    result["status"] = "build_queued";
                    result["deployment_id"] = depId;
                    result["job_id"] = job["id"].asString();
                    result["message"] = "Deployment build queued successfully.";
                }
            } else if (toolName == "get_kubernetes_events") {
                const std::string id = normalizeDeploymentId(txn, args.get("deployment_id", "").asString(), userId);
                txn.commit(); txnCommitted = true;
                result = DeploymentOperations::events(id, userId);
            } else if (toolName == "repair_deployment") {
                const std::string depId=normalizeDeploymentId(txn,args.get("deployment_id","").asString(),userId);
                const auto preferences=loadPreferences(txn,userId);
                const auto allowed=txn.exec_params("SELECT d.id FROM deployments d JOIN projects p ON p.id=d.project_id WHERE d.id=$1 AND has_project_access(p.id,$2,'admin') AND d.status NOT IN ('canceled','cancelled','retired','superseded')",depId,userId);
                if(allowed.empty())result["error"]="Deployment not found, inactive or administration access denied";
                else if(!preferences.get("enabled",false).asBool())result["error"]="Enable AI repair in settings before scheduling a recovery incident";
                else {
                    txn.exec_params("INSERT INTO deployment_incidents(deployment_id,user_id,source_job_id,kind,last_error) SELECT d.id,$2,'manual:'||gen_random_uuid()::text,'build',$3 FROM deployments d WHERE d.id=$1 ON CONFLICT DO NOTHING",depId,userId,args.get("problem_description","User requested deployment diagnosis and repair").asString());
                    auto incidents=txn.exec_params("SELECT id,status FROM deployment_incidents WHERE deployment_id=$1 ORDER BY created_at DESC LIMIT 1",depId);
                    result["status"]=incidents[0]["status"].as<std::string>();
                    result["incident_id"]=incidents[0]["id"].as<std::string>();result["deployment_id"]=depId;
                    result["verified"]=false;result["message"]="Durable diagnosis and repair incident scheduled; completion requires verified rebuild evidence.";
                }
            } else {
                result["error"] = "Unknown tool: " + toolName;
            }
            
            if (!txnCommitted) {
                txn.commit();
            }
            
            auto resp = drogon::HttpResponse::newHttpJsonResponse(result);
            resp->setStatusCode(drogon::k200OK);
            callback(resp);
        } catch (const std::exception& e) {
            Json::Value err;
            err["error"] = std::string("Tool execution failed: ") + e.what();
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k200OK);
            callback(resp);
        }
    });
}

} // namespace stackpilot
