// ============================================================
// AiStreamController.cpp — live agent replies over SSE
// ============================================================
// The browser opens one POST and holds it. Reasoning and content frames are
// forwarded as the model produces them, so the user watches the answer form
// instead of watching a spinner.
//
// Member of AiController, kept in its own translation unit: AiController.cpp
// is already large and this is a self-contained concern.

#include "AiController.h"

#include "../db/Database.h"
#include "../services/AiStreamProxy.h"
#include "../services/AiServiceClient.h"
#include "../utils/BlockingTaskRunner.h"
#include "../utils/JwtHelper.h"
#include "../utils/StringUtils.h"

#include <atomic>
#include <json/json.h>
#include <memory>
#include <pqxx/pqxx>
#include <spdlog/spdlog.h>
#include <sstream>
#include <algorithm>
#include <regex>

namespace stackpilot {
namespace {

/// Wraps the Drogon stream so the curl thread can push frames safely and the
/// stream is closed exactly once however the transfer ends.
struct SseWriter {
    drogon::ResponseStreamPtr stream;
    std::atomic<bool> closed{false};

    void send(const std::string& frame) {
        if (closed.load()) return;
        if (!stream || !stream->send(frame)) {
            // send() returning false means the client hung up. Stop writing;
            // continuing would pump an entire model response into a socket
            // nobody is reading.
            closed.store(true);
        }
    }

    void finish() {
        if (closed.exchange(true)) return;
        if (stream) stream->close();
    }
};

std::string sseFrame(const Json::Value& payload) {
    return "data: " + strings::compactJson(payload) + "\n\n";
}

std::string streamChatTitle(const std::string& message) {
    std::string title = strings::trim(message);
    title.erase(std::remove(title.begin(), title.end(), '\n'), title.end());
    title.erase(std::remove(title.begin(), title.end(), '\r'), title.end());
    if (title.size() > 72) {
        title = title.substr(0, 69) + "...";
    }
    return title.empty() ? "New AI chat" : title;
}

}  // namespace

void AiController::chatAgentStream(const drogon::HttpRequestPtr& req,
                                   std::function<void(const drogon::HttpResponsePtr&)>&& callback) {
    const Json::Value auth = JwtHelper::verifyRequestToken(req);
    if (auth.isNull() || !auth.isMember("user_id")) {
        Json::Value err;
        err["error"] = "Unauthorized";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp);
        return;
    }
    const std::string userId = auth["user_id"].asString();

    const auto body = req->getJsonObject();
    if (!body || !body->isMember("message") || strings::trim((*body)["message"].asString()).empty()) {
        Json::Value err;
        err["error"] = "message is required";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k400BadRequest);
        callback(resp);
        return;
    }

    const std::string userMessage = (*body)["message"].asString();
    std::string sessionId = body->isMember("session_id") ? (*body)["session_id"].asString() : "";
    std::string projectId = body->isMember("project_id") ? (*body)["project_id"].asString() : "";
    std::string deploymentId = body->isMember("deployment_id") ? (*body)["deployment_id"].asString() : "";
    std::string command = body->isMember("command") ? (*body)["command"].asString() : "";

    std::string workflowType = body->isMember("workflow_type") ? (*body)["workflow_type"].asString() : "agent_chat";

    // Extract UUID from message if deploymentId or projectId not explicitly given
    std::string extractedUuid;
    {
        static const std::regex uuidRegex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}");
        std::smatch match;
        if (std::regex_search(userMessage, match, uuidRegex)) {
            extractedUuid = match.str();
        }
    }

    // Build the upstream payload before the stream opens
    Json::Value payload(Json::objectValue);
    payload["message"] = userMessage;
    payload["workflow_type"] = workflowType;
    payload["user_id"] = userId;
    payload["model_mode"] = body->isMember("model_mode") ? (*body)["model_mode"].asString() : "fast";
    if (!command.empty()) payload["command"] = command;
    if (body->isMember("model")) payload["model"] = (*body)["model"];
    if (body->isMember("provider")) payload["provider"] = (*body)["provider"];
    if (body->isMember("project")) payload["project"] = (*body)["project"];
    if (body->isMember("logs")) payload["logs"] = (*body)["logs"];
    if (body->isMember("runtime")) payload["runtime"] = (*body)["runtime"];
    if (body->isMember("agent_access_mode")) payload["agent_access_mode"] = (*body)["agent_access_mode"];
    if (body->isMember("remote_terminal")) payload["remote_terminal"] = (*body)["remote_terminal"];
    if (body->isMember("images")) payload["images"] = (*body)["images"];
    if (body->isMember("custom_url")) payload["custom_url"] = (*body)["custom_url"];

    // Persist session and user message in database
    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);

        // Session Context Resolution:
        // When body contains session_id:
        // If deployment_id is empty or project_id is empty, query ai_sessions in PostgreSQL:
        // SELECT deployment_id, project_id, session_type FROM ai_sessions WHERE id = $1
        // If found, populate deployment_id and project_id and workflow_type!
        if (!sessionId.empty()) {
            try {
                auto sessRows = txn.exec_params(
                    "SELECT deployment_id, project_id, session_type FROM ai_sessions WHERE id = $1 AND (user_id = $2 OR has_project_access(project_id, $2))",
                    sessionId, userId);
                if (!sessRows.empty()) {
                    if (deploymentId.empty() && !sessRows[0]["deployment_id"].is_null()) {
                        deploymentId = sessRows[0]["deployment_id"].as<std::string>();
                    }
                    if (projectId.empty() && !sessRows[0]["project_id"].is_null()) {
                        projectId = sessRows[0]["project_id"].as<std::string>();
                    }
                    if (!sessRows[0]["session_type"].is_null() && !sessRows[0]["session_type"].as<std::string>().empty()) {
                        workflowType = sessRows[0]["session_type"].as<std::string>();
                        payload["workflow_type"] = workflowType;
                    }
                }
            } catch (...) {}
        }

        // If deploymentId is empty but an extracted UUID matched a deployment, resolve it
        if (deploymentId.empty() && !extractedUuid.empty()) {
            auto dCheck = txn.exec_params(
                "SELECT d.id, d.project_id FROM deployments d JOIN projects p ON d.project_id = p.id "
                "WHERE d.id = $1 AND (p.user_id = $2 OR has_project_access(p.id, $2))",
                extractedUuid, userId);
            if (!dCheck.empty()) {
                deploymentId = extractedUuid;
                if (projectId.empty()) {
                    projectId = dCheck[0]["project_id"].as<std::string>();
                }
            }
        }

        // If projectId is provided but deploymentId is empty, find the latest running deployment for this specific project
        if (deploymentId.empty() && !projectId.empty()) {
            try {
                auto dCheck = txn.exec_params(
                    "SELECT id FROM deployments WHERE project_id = $1 AND status = 'running' ORDER BY created_at DESC LIMIT 1",
                    projectId);
                if (!dCheck.empty()) {
                    deploymentId = dCheck[0]["id"].as<std::string>();
                } else {
                    auto dAny = txn.exec_params(
                        "SELECT id FROM deployments WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1",
                        projectId);
                    if (!dAny.empty()) {
                        deploymentId = dAny[0]["id"].as<std::string>();
                    }
                }
            } catch (...) {}
        }

        // Only inherit deployment from prior tool calls in session if BOTH deploymentId and projectId are empty
        if (deploymentId.empty() && projectId.empty() && !sessionId.empty()) {
            try {
                auto depInSession = txn.exec_params(
                    "SELECT (tc->'arguments'->>'deployment_id') as dep_id "
                    "FROM ai_messages m, jsonb_array_elements(COALESCE(m.metadata->'tool_calls', '[]'::jsonb)) tc "
                    "WHERE m.session_id = $1 AND tc->'arguments'->>'deployment_id' IS NOT NULL "
                    "ORDER BY m.created_at DESC LIMIT 1",
                    sessionId);
                if (!depInSession.empty() && !depInSession[0]["dep_id"].is_null()) {
                    deploymentId = depInSession[0]["dep_id"].as<std::string>();
                }
            } catch (...) {}
        }

        // If projectId is empty but an extracted UUID matched a project, resolve it
        if (projectId.empty() && !extractedUuid.empty()) {
            auto pCheck = txn.exec_params(
                "SELECT id FROM projects WHERE id = $1 AND (user_id = $2 OR has_project_access(id, $2))",
                extractedUuid, userId);
            if (!pCheck.empty()) {
                projectId = extractedUuid;
            }
        }

        // Populate deployment context if deployment_id is set
        // SELECT d.id, d.status, d.logs, d.branch, p.id AS project_id, p.name AS project_name FROM deployments d JOIN projects p ON d.project_id = p.id WHERE d.id = $1
        // Populate deployment JSON object (id, status, logs, branch) and project JSON object (id, name)
        if (!deploymentId.empty()) {
            const auto dRows = txn.exec_params(
                "SELECT d.id, d.status, d.logs, d.branch, d.image_name, d.runtime_url, p.id AS project_id, p.name AS project_name "
                "FROM deployments d JOIN projects p ON d.project_id = p.id "
                "WHERE d.id = $1 AND (p.user_id = $2 OR has_project_access(p.id, $2))",
                deploymentId, userId);
            if (!dRows.empty()) {
                Json::Value dep = payload.isMember("deployment") && payload["deployment"].isObject()
                    ? payload["deployment"]
                    : Json::Value(Json::objectValue);
                dep["id"] = dRows[0]["id"].as<std::string>();
                dep["status"] = dRows[0]["status"].is_null() ? "" : dRows[0]["status"].as<std::string>();
                dep["logs"] = dRows[0]["logs"].is_null() ? "" : dRows[0]["logs"].as<std::string>();
                dep["branch"] = dRows[0]["branch"].is_null() ? "" : dRows[0]["branch"].as<std::string>();
                if (!dRows[0]["image_name"].is_null()) dep["image_name"] = dRows[0]["image_name"].as<std::string>();
                if (!dRows[0]["runtime_url"].is_null()) dep["runtime_url"] = dRows[0]["runtime_url"].as<std::string>();
                payload["deployment"] = dep;

                if (!payload.isMember("logs") && !dRows[0]["logs"].is_null()) {
                    payload["logs"] = dRows[0]["logs"].as<std::string>();
                }
                if (projectId.empty()) {
                    projectId = dRows[0]["project_id"].as<std::string>();
                }
                if (!payload.isMember("project") || !payload["project"].isObject()) {
                    Json::Value proj(Json::objectValue);
                    proj["id"] = dRows[0]["project_id"].as<std::string>();
                    proj["name"] = dRows[0]["project_name"].is_null() ? "" : dRows[0]["project_name"].as<std::string>();
                    payload["project"] = proj;
                } else {
                    payload["project"]["id"] = dRows[0]["project_id"].as<std::string>();
                    if (!payload["project"].isMember("name") || payload["project"]["name"].asString().empty()) {
                        payload["project"]["name"] = dRows[0]["project_name"].is_null() ? "" : dRows[0]["project_name"].as<std::string>();
                    }
                }
            }
        }

        payload["workflow_type"] = workflowType;
        payload["project_id"] = projectId;
        payload["deployment_id"] = deploymentId;

        // Populate project context if project_id is set
        if (!projectId.empty()) {
            const auto pRows = txn.exec_params(
                "SELECT id, name, description, repo_url, status, source_type, source_path "
                "FROM projects WHERE id = $1 AND (user_id = $2 OR has_project_access(id, $2))",
                projectId, userId);
            if (!pRows.empty()) {
                Json::Value proj = payload.isMember("project") && payload["project"].isObject()
                    ? payload["project"]
                    : Json::Value(Json::objectValue);
                proj["id"] = pRows[0]["id"].as<std::string>();
                proj["name"] = pRows[0]["name"].as<std::string>();
                proj["description"] = pRows[0]["description"].is_null() ? "" : pRows[0]["description"].as<std::string>();
                proj["repo_url"] = pRows[0]["repo_url"].is_null() ? "" : pRows[0]["repo_url"].as<std::string>();
                proj["status"] = pRows[0]["status"].is_null() ? "" : pRows[0]["status"].as<std::string>();
                proj["source_type"] = pRows[0]["source_type"].is_null() ? "" : pRows[0]["source_type"].as<std::string>();
                proj["source_path"] = pRows[0]["source_path"].is_null() ? "" : pRows[0]["source_path"].as<std::string>();
                payload["project"] = proj;
            }
        }

        if (!sessionId.empty()) {
            const auto sessions = txn.exec_params(
                "SELECT id, title, project_id, deployment_id, session_type FROM ai_sessions WHERE id = $1 AND (user_id = $2 OR has_project_access(project_id, $2))",
                sessionId,
                userId);
            if (sessions.empty()) {
                sessionId.clear();
            } else {
                if (projectId.empty() && !sessions[0]["project_id"].is_null()) {
                    projectId = sessions[0]["project_id"].as<std::string>();
                    payload["project_id"] = projectId;
                }
                if (deploymentId.empty() && !sessions[0]["deployment_id"].is_null()) {
                    deploymentId = sessions[0]["deployment_id"].as<std::string>();
                    payload["deployment_id"] = deploymentId;
                }
                if (!sessions[0]["session_type"].is_null() && !sessions[0]["session_type"].as<std::string>().empty()) {
                    workflowType = sessions[0]["session_type"].as<std::string>();
                    payload["workflow_type"] = workflowType;
                }
            }
        }

        if (!deploymentId.empty() && !payload.isMember("deployment")) {
            const auto dRows = txn.exec_params(
                "SELECT id, status, logs FROM deployments WHERE id = $1", deploymentId);
            if (!dRows.empty()) {
                Json::Value dep(Json::objectValue);
                dep["id"] = dRows[0]["id"].as<std::string>();
                dep["status"] = dRows[0]["status"].as<std::string>();
                dep["logs"] = dRows[0]["logs"].is_null() ? "" : dRows[0]["logs"].as<std::string>();
                payload["deployment"] = dep;
                if (!payload.isMember("logs") || payload["logs"].asString().empty()) {
                    payload["logs"] = dep["logs"];
                }
            }
        }
        if (sessionId.empty()) {
            const std::string title = streamChatTitle(userMessage);
            const auto rows = txn.exec_params(
                "INSERT INTO ai_sessions (user_id, project_id, title, session_type, deployment_id) "
                "VALUES ($1, NULLIF($2, '')::uuid, $3, $4, NULLIF($5, '')::uuid) RETURNING id",
                userId,
                projectId,
                title,
                workflowType.empty() ? "agent_chat" : workflowType,
                deploymentId);
            sessionId = rows[0][0].as<std::string>();
        }

        txn.exec_params(
            "INSERT INTO ai_messages (session_id, role, content) VALUES ($1, 'user', $2)",
            sessionId,
            userMessage);

        const auto historyRows = txn.exec_params(
            "SELECT role, content, metadata FROM ("
            "SELECT role, content, metadata, created_at FROM ai_messages WHERE session_id = $1 "
            "ORDER BY created_at DESC LIMIT 24"
            ") recent ORDER BY created_at ASC",
            sessionId);
        Json::Value history(Json::arrayValue);
        for (const auto& row : historyRows) {
            Json::Value item(Json::objectValue);
            item["role"] = row["role"].as<std::string>();
            item["content"] = row["content"].is_null() ? "" : row["content"].as<std::string>();
            if (!row["metadata"].is_null()) {
                try {
                    Json::Value meta;
                    Json::Reader reader;
                    if (reader.parse(row["metadata"].as<std::string>(), meta)) {
                        if (meta.isMember("tool_calls")) {
                            item["tool_calls"] = meta["tool_calls"];
                        }
                    }
                } catch (...) {}
            }
            history.append(item);
        }
        payload["history"] = history;
        payload["session_id"] = sessionId;
        txn.commit();
    } catch (const std::exception& e) {
        spdlog::warn("AI stream session persistence error: {}", e.what());
    }

    auto response = drogon::HttpResponse::newAsyncStreamResponse(
        [payload, userId, sessionId](drogon::ResponseStreamPtr stream) {
            auto writer = std::make_shared<SseWriter>();
            writer->stream = std::move(stream);

            BlockingTaskRunner::run([payload, userId, sessionId, writer]() {
                Json::Value requestPayload = payload;
                try {
                    auto conn = Database::getInstance().getConnection();
                    pqxx::work txn(*conn);
                    const auto rows = txn.exec_params(
                        "SELECT provider, openai_compatible_base_url, openai_compatible_api_key, nvidia_api_key "
                        "FROM ai_preferences WHERE user_id = $1",
                        userId);
                    if (!rows.empty()) {
                        Json::Value overrides(Json::objectValue);
                        std::string prefProvider = rows[0]["provider"].is_null() ? "" : rows[0]["provider"].c_str();
                        if (prefProvider == "openai_compatible") {
                            if (!rows[0]["openai_compatible_base_url"].is_null()) overrides["base_url"] = rows[0]["openai_compatible_base_url"].c_str();
                            if (!rows[0]["openai_compatible_api_key"].is_null()) overrides["api_key"] = rows[0]["openai_compatible_api_key"].c_str();
                        } else if (prefProvider == "nvidia_nim") {
                            if (!rows[0]["nvidia_api_key"].is_null()) overrides["api_key"] = rows[0]["nvidia_api_key"].c_str();
                        }
                        if (!overrides.empty()) requestPayload["provider_overrides"] = overrides;
                    }
                } catch (...) {}

                auto assembledContent = std::make_shared<std::string>();
                auto assembledReasoning = std::make_shared<std::string>();
                auto assembledToolCalls = std::make_shared<Json::Value>(Json::arrayValue);
                auto doneModel = std::make_shared<std::string>();
                auto doneUsage = std::make_shared<Json::Value>(Json::objectValue);

                // Emit initial start event with session_id so client can track active session immediately
                if (!sessionId.empty()) {
                    Json::Value startFrame(Json::objectValue);
                    startFrame["type"] = "start";
                    startFrame["session_id"] = sessionId;
                    if (requestPayload.isMember("model")) startFrame["model"] = requestPayload["model"];
                    if (requestPayload.isMember("provider")) startFrame["provider"] = requestPayload["provider"];
                    writer->send(sseFrame(startFrame));
                }

                AiStreamProxy::stream(
                    "/chat/agent/stream",
                    requestPayload,
                    [writer, assembledContent, assembledReasoning, assembledToolCalls, doneModel, doneUsage](const std::string& frame) {
                        writer->send(frame);
                        // Parse frame to record final response for persistence
                        try {
                            const std::string prefix = "data: ";
                            if (frame.rfind(prefix, 0) == 0) {
                                std::string jsonStr = frame.substr(prefix.size());
                                while (!jsonStr.empty() && (jsonStr.back() == '\n' || jsonStr.back() == '\r')) {
                                    jsonStr.pop_back();
                                }
                                Json::CharReaderBuilder reader;
                                Json::Value event;
                                std::string errs;
                                std::istringstream s(jsonStr);
                                if (Json::parseFromStream(reader, s, &event, &errs) && event.isObject()) {
                                    const std::string type = event.isMember("type") ? event["type"].asString() : "";
                                    if (type == "content" && event.isMember("delta")) {
                                        *assembledContent += event["delta"].asString();
                                    } else if (type == "reasoning" && event.isMember("delta")) {
                                        *assembledReasoning += event["delta"].asString();
                                    } else if (type == "tool_call") {
                                        Json::Value tc(Json::objectValue);
                                        tc["name"] = event.isMember("name") ? event["name"].asString() : "";
                                        tc["arguments"] = event.isMember("arguments") ? event["arguments"] : Json::Value(Json::objectValue);
                                        if (event.isMember("id")) tc["id"] = event["id"].asString();
                                        assembledToolCalls->append(tc);
                                    } else if (type == "tool_result") {
                                        const std::string tcName = event.isMember("name") ? event["name"].asString() : "";
                                        const std::string tcId = event.isMember("id") ? event["id"].asString() : "";
                                        for (int i = static_cast<int>(assembledToolCalls->size()) - 1; i >= 0; --i) {
                                            if ((!tcId.empty() && (*assembledToolCalls)[i].isMember("id") && (*assembledToolCalls)[i]["id"].asString() == tcId) ||
                                                ((*assembledToolCalls)[i]["name"].asString() == tcName && !(*assembledToolCalls)[i].isMember("result"))) {
                                                (*assembledToolCalls)[i]["result"] = event["result"];
                                                break;
                                            }
                                        }
                                    } else if (type == "done") {
                                        if (event.isMember("content") && !event["content"].asString().empty()) {
                                            *assembledContent = event["content"].asString();
                                        }
                                        if (event.isMember("reasoning") && !event["reasoning"].asString().empty()) {
                                            *assembledReasoning = event["reasoning"].asString();
                                        }
                                        if (event.isMember("model")) {
                                            *doneModel = event["model"].asString();
                                        }
                                        if (event.isMember("token_usage")) {
                                            *doneUsage = event["token_usage"];
                                        }
                                    }
                                }
                            }
                        } catch (...) {}
                    },
                    [writer, userId, sessionId, assembledContent, assembledReasoning, assembledToolCalls, doneModel, doneUsage](bool ok, const std::string& error) {
                        if (!ok) {
                            Json::Value failure(Json::objectValue);
                            failure["type"] = "error";
                            failure["error"] = error;
                            writer->send(sseFrame(failure));
                        }

                        // Persist assistant message in database with full reasoning and tool calls
                        // even if the stream terminated prematurely (e.g. timeout, disconnect),
                        // so user actions and diagnostics are not lost.
                        if (!sessionId.empty() && (!assembledContent->empty() || !assembledReasoning->empty() || !assembledToolCalls->empty())) {
                            try {
                                auto conn = Database::getInstance().getConnection();
                                pqxx::work txn(*conn);
                                Json::Value meta(Json::objectValue);
                                if (!assembledReasoning->empty()) meta["reasoning"] = *assembledReasoning;
                                if (!assembledToolCalls->empty()) meta["tool_calls"] = *assembledToolCalls;
                                if (!doneModel->empty()) meta["model"] = *doneModel;
                                if (!doneUsage->empty()) meta["token_usage"] = *doneUsage;
                                if (!ok) meta["interrupted_reason"] = error;

                                std::string finalContent = *assembledContent;
                                if (finalContent.empty()) {
                                    finalContent = !ok
                                        ? "Completed workspace actions and diagnostic inspection before stream closed: " + error
                                        : "Completed workspace actions and diagnostic inspection. See the tool activity above for details.";
                                } else if (!ok) {
                                    finalContent += "\n\n*(Stream ended: " + error + ")*";
                                }

                                txn.exec_params(
                                    "INSERT INTO ai_messages (session_id, role, content, metadata) VALUES ($1, 'assistant', $2, $3::jsonb)",
                                    sessionId,
                                    finalContent,
                                    strings::compactJson(meta));
                                txn.exec_params(
                                    "UPDATE ai_sessions SET updated_at = NOW(), last_model = $2 WHERE id = $1",
                                    sessionId,
                                    *doneModel);
                                txn.commit();
                            } catch (const std::exception& e) {
                                spdlog::error("Failed to save streamed assistant message: {}", e.what());
                            }
                        }
                        writer->finish();
                    });
            });
        });

    response->setContentTypeCodeAndCustomString(drogon::CT_CUSTOM, "text/event-stream");
    response->addHeader("Cache-Control", "no-cache");
    response->addHeader("Connection", "keep-alive");
    response->addHeader("X-Accel-Buffering", "no");
    callback(response);
}

void AiController::stopAgentStream(const drogon::HttpRequestPtr& req,
                                   std::function<void(const drogon::HttpResponsePtr&)>&& callback) {
    const Json::Value auth = JwtHelper::verifyRequestToken(req);
    if (auth.isNull() || !auth.isMember("user_id")) {
        Json::Value err;
        err["error"] = "Unauthorized";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp);
        return;
    }

    std::string sessionId = "default";
    const auto body = req->getJsonObject();
    if (body && body->isMember("session_id")) {
        sessionId = (*body)["session_id"].asString();
    }

    BlockingTaskRunner::run([sessionId, callback]() {
        Json::Value stopPayload(Json::objectValue);
        stopPayload["session_id"] = sessionId;

        const auto result = AiServiceClient::instance().postWorkflow("/chat/agent/stop", stopPayload);

        Json::Value out(Json::objectValue);
        out["status"] = result.ok ? "ok" : "error";
        out["message"] = result.ok ? "Stream and browser testing stopped" : result.error;
        auto resp = drogon::HttpResponse::newHttpJsonResponse(out);
        callback(resp);
    });
}

}  // namespace stackpilot
