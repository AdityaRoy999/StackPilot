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
#include "../services/AiProviderConnections.h"
#include "../services/AiConversationMemory.h"
#include "../services/RemoteAccess.h"
#include "../utils/TokenCrypto.h"

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
    std::atomic<bool> finished{false};
    bool detached=false;
    std::string remoteId;
    std::string remoteState="interrupted";
    bool pendingApproval=false;
    bool pendingQuestion=false;
    bool progressFailed=false;

    void send(const std::string& frame) {
        if (finished.load()) return;
        if (!remoteId.empty()) {
            try {
                remote::appendEvent(remoteId,frame);
                if(frame.rfind("data: ",0)==0){Json::Value event;Json::Reader reader;if(reader.parse(frame.substr(6),event)){
                    const auto type=event.get("type","").asString();
                    if(type=="permission_request"||type=="approval_required"||type=="permission_required"||event.get("requires_approval",false).asBool()||(event["result"].isObject()&&event["result"].get("approval_required",false).asBool()))pendingApproval=true;
                    if(type=="agent_question")pendingQuestion=true;
                    if(type=="error")remoteState="error";
                    if(type=="done")remoteState=event.get("stopped",false).asBool()?"cancelled":event.get("status","ok").asString()=="error"?"error":pendingApproval?"awaiting_approval":pendingQuestion?"awaiting_input":"completed";
                }}
            } catch (...) {progressFailed=true;remoteState="error";spdlog::error("Remote progress could not be persisted");}
            if(detached)return;
        }
        if(closed.load())return;
        if (!stream || !stream->send(frame)) {
            // send() returning false means the client hung up. Stop writing;
            // continuing would pump an entire model response into a socket
            // nobody is reading.
            closed.store(true);
        }
    }

    void finish() {
        if(finished.exchange(true))return;
        if(!remoteId.empty()){try{remote::finishRun(remoteId,progressFailed?"error":remoteState);}catch(...){remote::deactivateRun(remoteId);spdlog::error("Remote run completion could not be saved");}}
        if(!closed.exchange(true) && stream)stream->close();
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
    const bool background=body->get("background",false).asBool();
    std::string remoteId=background?body->get("request_id","").asString():drogon::utils::getUuid();
    if(background && (!std::regex_match(remoteId,std::regex("[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")) || userMessage.size()>32000)){
        Json::Value error;error["error"]="A valid request_id and a message below 32KB are required";auto response=drogon::HttpResponse::newHttpJsonResponse(error);response->setStatusCode(drogon::k400BadRequest);callback(response);return;
    }
    const auto requestHash=remote::hash(strings::compactJson(*body));
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
    if (body->isMember("approval_token")) payload["approval_token"] = (*body)["approval_token"];
    if (body->isMember("remote_terminal")) payload["remote_terminal"] = (*body)["remote_terminal"];
    if (body->isMember("images")) payload["images"] = (*body)["images"];
    if (body->isMember("custom_url")) payload["custom_url"] = (*body)["custom_url"];
    if (body->isMember("sandbox_mode")) payload["sandbox_mode"] = (*body)["sandbox_mode"];

    // Persist session and user message in database
    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);
        if(background){
            txn.exec("SELECT pg_advisory_xact_lock(hashtext('stackpilot_remote_admission'))");
            const auto existing=txn.exec_params("SELECT id,user_id,session_id,request_hash,state FROM remote_runs WHERE id=$1",remoteId);
            if(!existing.empty()){
                Json::Value result;const bool conflict=existing[0]["user_id"].as<std::string>()!=userId || existing[0]["request_hash"].as<std::string>()!=requestHash;
                if(conflict){result["error"]="This request ID already belongs to another command";}
                else{result["run_id"]=remoteId;result["session_id"]=existing[0]["session_id"].as<std::string>();result["state"]=existing[0]["state"].as<std::string>();}
                auto response=drogon::HttpResponse::newHttpJsonResponse(result);if(conflict)response->setStatusCode(drogon::k409Conflict);response->addHeader("Cache-Control","no-store");txn.commit();callback(response);return;
            }
            const auto working=txn.exec("SELECT id FROM remote_runs WHERE state='working'");
            int active=0;for(const auto& row:working){const auto id=row[0].as<std::string>();if(remote::activeRun(id))++active;else txn.exec_params("UPDATE remote_runs SET state='interrupted' WHERE id=$1",id);}
            if(active>=2)throw std::runtime_error("Two background requests are already running. Wait for one to finish.");
            if(!sessionId.empty() && txn.exec_params("SELECT id FROM ai_sessions WHERE id=$1 AND user_id=$2",sessionId,userId).empty())throw std::runtime_error("The selected chat is not owned by this account");
        }

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
                    "FROM ai_messages m, jsonb_array_elements(CASE WHEN jsonb_typeof(m.metadata->'tool_calls')='array' THEN m.metadata->'tool_calls' ELSE '[]'::jsonb END) tc "
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
                "SELECT id, title, project_id, deployment_id, session_type, memory_summary, memory_graph::text FROM ai_sessions WHERE id = $1 AND (user_id = $2 OR has_project_access(project_id, $2))",
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

        // A chat opened for Live App starts empty. Give it the first prompt's
        // title without renaming a conversation that already has messages.
        txn.exec_params(
            "UPDATE ai_sessions SET title = $2, "
            "project_id = COALESCE(project_id, (SELECT p.id FROM projects p WHERE p.id = NULLIF($3, '')::uuid AND has_project_access(p.id, $5))), "
            "deployment_id = COALESCE(deployment_id, (SELECT d.id FROM deployments d JOIN projects p ON p.id = d.project_id WHERE d.id = NULLIF($4, '')::uuid AND has_project_access(p.id, $5))) "
            "WHERE id = $1 AND title = 'New AI chat' "
            "AND NOT EXISTS (SELECT 1 FROM ai_messages WHERE session_id = $1 AND role = 'user')",
            sessionId, streamChatTitle(userMessage), projectId, deploymentId, userId);
        if(!background)txn.exec_params("UPDATE remote_runs SET state='superseded',updated_at=NOW() WHERE session_id=$1 AND state='working'",sessionId);
        Json::Value remoteContext(Json::objectValue);
        for(const auto* field:{"project_id","deployment_id","custom_url","sandbox_mode","model_mode","model","command","workflow_type"})if(payload.isMember(field))remoteContext[field]=payload[field];
        txn.exec_params("INSERT INTO remote_runs(id,user_id,device_id,session_id,request_hash,context) VALUES($1,$2,NULLIF($3,'')::uuid,$4,$5,$6::jsonb)",remoteId,userId,auth.get("remote_device_id","").asString(),sessionId,requestHash,strings::compactJson(remoteContext));
        const bool continuation=body->get("continuation",false).asBool() &&
            (!body->get("approval_token", "").asString().empty() || userMessage.rfind("[System] User answered",0)==0);
        if(continuation) {
            const auto prior=txn.exec_params("SELECT id FROM ai_messages WHERE session_id=$1 AND role='assistant' ORDER BY created_at DESC LIMIT 1",sessionId);
            if(!prior.empty())payload["continuation_message_id"]=prior[0][0].as<std::string>();
        }
        txn.exec_params(
            "INSERT INTO ai_messages (session_id, role, content, metadata) VALUES ($1, 'user', $2, $3::jsonb)",
            sessionId, userMessage, continuation ? "{\"continuation\":true}" : "{}");

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
        const auto memories = txn.exec_params("SELECT memory_summary,memory_graph::text FROM ai_sessions WHERE id=$1",sessionId);
        if (!memories.empty()) payload["memory"] = aiMemory::sessionMemory(memories[0][0].is_null()?"":memories[0][0].as<std::string>(), memories[0][1].is_null()?"{}":memories[0][1].as<std::string>());
        // The current request is sent separately by the model adapter.
        if (!history.empty() && history[history.size()-1]["role"]=="user" && history[history.size()-1]["content"].asString()==userMessage) history.resize(history.size()-1);
        payload["history"] = history;
        payload["session_id"] = sessionId;
        remote::activateRun(remoteId);
        txn.commit();
    } catch (const std::exception& e) {
        spdlog::warn("AI stream session persistence error: {}", e.what());
        remote::deactivateRun(remoteId);
        if(background){Json::Value result;result["error"]="Background request could not start. The chat may be busy or unavailable.";auto response=drogon::HttpResponse::newHttpJsonResponse(result);response->setStatusCode(drogon::k409Conflict);callback(response);return;}
        remoteId.clear();
    }

    auto produce = [payload, userId, sessionId, remoteId, background](drogon::ResponseStreamPtr stream) {
            auto writer = std::make_shared<SseWriter>();
            writer->stream = std::move(stream);
            writer->remoteId = remoteId;
            writer->detached = background;

            BlockingTaskRunner::run([payload, userId, sessionId, writer]() {
                Json::Value requestPayload = payload;
                try {
                    auto conn = Database::getInstance().getConnection();
                    pqxx::work txn(*conn);
                    const auto rows = txn.exec_params(
                        "SELECT provider, openai_compatible_base_url, openai_compatible_api_key, nvidia_api_key,model "
                        "FROM ai_preferences WHERE user_id = $1",
                        userId);
                    Json::Value prefs(Json::objectValue);
                    prefs["provider"]=requestPayload.get("provider", "nvidia_nim");
                    if (!rows.empty()) {
                        const auto& row=rows[0];
                        if (!requestPayload.isMember("provider")) prefs["provider"]=row["provider"].is_null()?"nvidia_nim":row["provider"].as<std::string>();
                        prefs["openai_compatible_base_url"]=row["openai_compatible_base_url"].is_null()?"":row["openai_compatible_base_url"].as<std::string>();
                        const auto modelField="model";
                        if(!requestPayload.isMember("model") && !row[modelField].is_null() && !row[modelField].as<std::string>().empty())requestPayload["model"]=row[modelField].as<std::string>();
                        for (const auto* field : {"nvidia_api_key","openai_compatible_api_key"}) prefs[field]=row[field].is_null()?"":TokenCrypto::decrypt(row[field].as<std::string>());
                    }
                    aiProviders::apply(txn,userId,prefs);
                    requestPayload["provider"]=prefs["provider"];
                    requestPayload["provider_connection_name"]=prefs.get("provider_connection_name", "");
                    Json::Value overrides(Json::objectValue);
                    const bool compatible=prefs["provider"].asString()=="openai_compatible";
                    const auto key=prefs.get(compatible?"openai_compatible_api_key":"nvidia_api_key", "").asString();
                    if (!key.empty()) overrides["api_key"]=key;
                    if (compatible && !prefs.get("openai_compatible_base_url", "").asString().empty()) overrides["base_url"]=prefs["openai_compatible_base_url"];
                    if (!overrides.empty()) requestPayload["provider_overrides"]=overrides;
                    txn.commit();
                } catch (const std::exception& e) {
                    spdlog::error("AI stream credentials unavailable: {}", e.what());
                    Json::Value failure; failure["type"]="error"; failure["error"]="Provider credentials unavailable; check provider settings";
                    writer->send(sseFrame(failure)); writer->finish(); return;
                }

                auto assembledContent = std::make_shared<std::string>();
                auto assembledReasoning = std::make_shared<std::string>();
                auto assembledToolCalls = std::make_shared<Json::Value>(Json::arrayValue);
                auto assembledPermissions = std::make_shared<Json::Value>(Json::arrayValue);
                auto assembledTeamEvents = std::make_shared<Json::Value>(Json::arrayValue);
                auto teamRunId = std::make_shared<std::string>();
                auto doneModel = std::make_shared<std::string>();
                auto doneUsage = std::make_shared<Json::Value>(Json::objectValue);
                auto sawDone = std::make_shared<bool>(false);
                auto streamError = std::make_shared<std::string>();

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
                    [writer, assembledContent, assembledReasoning, assembledToolCalls, assembledPermissions, assembledTeamEvents, teamRunId, doneModel, doneUsage, sawDone, streamError](const std::string& frame) {
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
                                    if(type=="agent_run" && event.isMember("run_id"))*teamRunId=event["run_id"].asString();
                                    if(!event.get("agent_id", "").asString().empty() && event["agent_id"].asString()!="lead") {
                                        if(assembledTeamEvents->size()<2000) {
                                            if(event["result"].isObject()) {event["result"].removeMember("frame");event["result"].removeMember("som_frame");}
                                            assembledTeamEvents->append(event);
                                        }
                                        return;
                                    }
                                    if(type=="done" && event.isMember("team_tasks"))assembledTeamEvents->append(event);
                                    if (type == "content" && event.isMember("delta")) {
                                        *assembledContent += event["delta"].asString();
                                    } else if (type == "reasoning" && event.isMember("delta")) {
                                        *assembledReasoning += event["delta"].asString();
                                    } else if (type == "permission_request") {
                                        Json::Value permission(Json::objectValue);
                                        auto permissionId=event.get("id", "").asString();
                                        const auto token=event.get("token", "").asString();
                                        if(permissionId.empty() && !token.empty())permissionId="permission-"+token.substr(token.size()>32?token.size()-32:0);
                                        permission["id"]=permissionId;
                                        permission["toolName"]=event["tool_name"];
                                        permission["title"]=event["tool_name"];
                                        permission["description"]=event["description"];
                                        permission["arguments"]=event["arguments"];
                                        permission["status"]="pending";
                                        if(event.isMember("browser_step"))permission["browserStep"]=event["browser_step"];
                                        if(event["arguments"].isMember("command"))permission["command"]=event["arguments"]["command"];
                                        assembledPermissions->append(permission);
                                    } else if (type == "tool_call") {
                                        Json::Value tc(Json::objectValue);
                                        tc["name"] = event.isMember("name") ? event["name"].asString() : "";
                                        tc["arguments"] = event.isMember("arguments") ? event["arguments"] : Json::Value(Json::objectValue);
                                        if (event.isMember("id")) tc["id"] = event["id"].asString();
                                        assembledToolCalls->append(tc);
                                    } else if (type == "tool_step") {
                                        Json::Value step(Json::objectValue);
                                        step["id"] = event["id"];
                                        step["parent_id"] = event["parent_id"];
                                        step["name"] = event["name"];
                                        step["arguments"] = event["arguments"];
                                        step["result"] = event["result"];
                                        assembledToolCalls->append(step);
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
                                    } else if (type == "error") {
                                        *streamError = event.get("error", "Agent stream failed").asString();
                                    } else if (type == "done") {
                                        *sawDone = true;
                                        if (event.get("status", "ok").asString()=="error") *streamError=event.get("error", "Agent request failed").asString();
                                        if (event.isMember("content")) *assembledContent = event["content"].asString();
                                        if (event.isMember("reasoning")) *assembledReasoning = event["reasoning"].asString();
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
                    [writer, userId, sessionId, requestPayload, assembledContent, assembledReasoning, assembledToolCalls, assembledPermissions, assembledTeamEvents, teamRunId, doneModel, doneUsage, sawDone, streamError](bool ok, const std::string& error) {
                        const bool completed = ok && *sawDone && streamError->empty();
                        const std::string completionError = !ok ? error : !streamError->empty() ? *streamError : "Stream closed before completion";
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
                                if(!writer->remoteId.empty())meta["remote_run_id"]=writer->remoteId;
                                meta["provider"]=requestPayload.get("provider", "");
                                meta["provider_connection_name"]=requestPayload.get("provider_connection_name", "");
                                if (!assembledReasoning->empty()) meta["reasoning"] = *assembledReasoning;
                                if (!assembledToolCalls->empty()) meta["tool_calls"] = *assembledToolCalls;
                                if (!assembledPermissions->empty()) meta["permissions"] = *assembledPermissions;
                                if (!assembledTeamEvents->empty()) meta["agent_events"] = *assembledTeamEvents;
                                if (!teamRunId->empty()) meta["agent_run_id"] = *teamRunId;
                                if (!doneModel->empty()) meta["model"] = *doneModel;
                                if (!doneUsage->empty()) meta["token_usage"] = *doneUsage;
                                if (!completed) meta["interrupted_reason"] = completionError;

                                std::string finalContent = *assembledContent;
                                if (finalContent.empty()) {
                                    finalContent = !completed
                                        ? "Partial agent activity before the stream closed: " + completionError
                                        : !assembledPermissions->empty() ? "Waiting for your approval of this step."
                                        : "Agent activity finished. Review the recorded tool results for its outcome.";
                                } else if (!completed) {
                                    finalContent += "\n\n*(Stream ended: " + completionError + ")*";
                                }

                                const auto continuationId=requestPayload.get("continuation_message_id", "").asString();
                                const auto previous=continuationId.empty() ? pqxx::result{} : txn.exec_params("SELECT content,metadata FROM ai_messages WHERE id=$1 AND session_id=$2 AND role='assistant' FOR UPDATE",continuationId,sessionId);
                                if(!previous.empty()) {
                                    Json::Value oldMeta;Json::Reader reader;
                                    if(!previous[0]["metadata"].is_null())reader.parse(previous[0]["metadata"].as<std::string>(),oldMeta);
                                    const auto oldContent=previous[0]["content"].as<std::string>();
                                    if(!oldContent.empty() && oldContent.rfind("Waiting for",0)!=0 && oldContent.rfind("Completed workspace actions",0)!=0)finalContent=oldContent+"\n\n"+finalContent;
                                    if(oldMeta["reasoning"].isString())meta["reasoning"]=oldMeta["reasoning"].asString()+"\n"+meta.get("reasoning", "").asString();
                                    for(const auto* key:{"tool_calls","agent_events","permissions"}) {
                                        auto combined=oldMeta[key].isArray()?oldMeta[key]:Json::Value(Json::arrayValue);
                                        if(std::string(key)=="permissions" && requestPayload.isMember("approval_token"))for(auto& item:combined)if(item["status"].asString()=="pending")item["status"]="approved";
                                        if(meta[key].isArray())for(const auto& item:meta[key])combined.append(item);
                                        if(!combined.empty())meta[key]=combined;
                                        else meta.removeMember(key);
                                    }
                                    txn.exec_params("UPDATE ai_messages SET content=$3,metadata=$4::jsonb WHERE id=$1 AND session_id=$2",continuationId,sessionId,finalContent,strings::compactJson(meta));
                                } else txn.exec_params(
                                    "INSERT INTO ai_messages (session_id, role, content, metadata) VALUES ($1, 'assistant', $2, $3::jsonb)",
                                    sessionId,
                                    finalContent,
                                    strings::compactJson(meta));
                                const auto saved=txn.exec_params("SELECT memory_summary,memory_graph::text FROM ai_sessions WHERE id=$1 FOR UPDATE",sessionId);
                                if (!saved.empty()) {
                                    auto graph=aiMemory::sessionMemory("",saved[0][1].is_null()?"{}":saved[0][1].as<std::string>())["graph"];
                                    auto summary=saved[0][0].is_null()?"":saved[0][0].as<std::string>();
                                    // Partial or failed turns remain in history, but are not presented as durable successful outcomes.
                                    if (completed && !assembledContent->empty()) {
                                        graph=aiMemory::updateMemoryGraph(graph,requestPayload.get("message", "").asString(),*assembledContent);
                                        summary=aiMemory::updateMemorySummary(summary,requestPayload.get("message", "").asString(),*assembledContent);
                                    }
                                    txn.exec_params("UPDATE ai_sessions SET updated_at=NOW(),last_model=$2,memory_summary=$3,memory_graph=$4::jsonb WHERE id=$1",sessionId,doneModel->empty()?requestPayload.get("model", "").asString():*doneModel,summary,strings::compactJson(graph));
                                }
                                txn.commit();
                            } catch (const std::exception& e) {
                                spdlog::error("Failed to save streamed assistant message: {}", e.what());
                            }
                        }
                        writer->finish();
                    });
            });
        };

    if(background){
        produce(nullptr);
        Json::Value result;result["run_id"]=remoteId;result["session_id"]=sessionId;result["state"]="working";
        auto response=drogon::HttpResponse::newHttpJsonResponse(result);response->setStatusCode(drogon::k202Accepted);response->addHeader("Cache-Control","no-store");callback(response);return;
    }
    auto response = drogon::HttpResponse::newAsyncStreamResponse(produce);

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

    const auto uid=auth["user_id"].asString();
    BlockingTaskRunner::run([sessionId,uid,callback]() {
        try {
            auto connection=Database::getInstance().getConnection();pqxx::work txn(*connection);
            auto allowed=txn.exec_params("SELECT id FROM ai_sessions WHERE id::text=$1 AND (user_id=$2::uuid OR has_project_access(project_id,$2,'admin'))",sessionId,uid);txn.commit();
            if(allowed.empty()){Json::Value error;error["error"]="Session unavailable";auto response=drogon::HttpResponse::newHttpJsonResponse(error);response->setStatusCode(drogon::k404NotFound);callback(response);return;}
        } catch(...) {Json::Value error;error["error"]="Session authorization unavailable";auto response=drogon::HttpResponse::newHttpJsonResponse(error);response->setStatusCode(drogon::k503ServiceUnavailable);callback(response);return;}

        Json::Value stopPayload(Json::objectValue);
        stopPayload["session_id"] = sessionId;

        const auto result = AiServiceClient::instance().postWorkflow("/chat/agent/stop", stopPayload);
        if(result.ok){try{auto conn=Database::getInstance().getConnection();pqxx::work tx(*conn);tx.exec_params("UPDATE remote_runs SET state='cancelled',updated_at=NOW() WHERE session_id::text=$1 AND user_id=$2 AND state IN ('awaiting_approval','awaiting_input')",sessionId,uid);tx.commit();}catch(...){}}

        Json::Value out(Json::objectValue);
        out["status"] = result.ok ? "ok" : "error";
        out["message"] = result.ok ? "Stream and browser testing stopped" : result.error;
        auto resp = drogon::HttpResponse::newHttpJsonResponse(out);
        callback(resp);
    });
}

}  // namespace stackpilot
