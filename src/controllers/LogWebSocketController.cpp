// ============================================================
// LogWebSocketController.cpp — Real-time Build Log Streaming
// ============================================================

#include "LogWebSocketController.h"
#include "../db/Database.h"
#include "../utils/JwtHelper.h"
#include "../services/RemoteAccess.h"
#include <json/json.h>
#include <pqxx/pqxx>
#include <spdlog/spdlog.h>
#include <vector>

namespace stackpilot {

namespace {

constexpr const char* kGlobalDeploymentsChannelPrefix = "__deployments__:";

// Per-user global channel. Previously a single shared "__deployments__" channel
// fanned every tenant's deployment updates out to every connected socket.
std::string globalChannelFor(const std::string& userId) {
    return std::string(kGlobalDeploymentsChannelPrefix) + userId;
}

bool userOwnsDeployment(const std::string& deploymentId, const std::string& userId) {
    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);
        auto rows = txn.exec_params(
            "SELECT 1 FROM deployments d "
            "JOIN projects p ON d.project_id = p.id "
            "WHERE d.id = $1 AND has_project_access(p.id, $2)",
            deploymentId,
            userId
        );
        txn.commit();
        return !rows.empty();
    } catch (const std::exception& e) {
        // A malformed (non-UUID) deploymentId lands here too — deny by default.
        spdlog::warn("WebSocket deployment ownership check failed: {}", e.what());
        return false;
    }
}

// Returns the channel this request is allowed to subscribe to, or "" to reject.
std::string resolveAuthorizedChannel(const drogon::HttpRequestPtr& req, const std::string& userId) {
    if (req->getParameter("stream") == "deployments") {
        return globalChannelFor(userId);
    }

    const std::string deploymentId = req->getParameter("deploymentId");
    if (!deploymentId.empty() && userOwnsDeployment(deploymentId, userId)) {
        return deploymentId;
    }

    return "";
}

} // namespace

std::map<std::string, std::set<drogon::WebSocketConnectionPtr>> LogWebSocketController::subscribers_;
std::mutex LogWebSocketController::subscribersMutex_;

void LogWebSocketController::handleNewConnection(
    const drogon::HttpRequestPtr& req,
    const drogon::WebSocketConnectionPtr& conn
) {
    // WebSocket upgrades bypass the CORS/CSRF filter, so this is the only
    // place the connection can be authenticated.
    const auto payload = JwtHelper::verifyRequestToken(req);
    if (payload.isNull()) {
        spdlog::warn("Rejected unauthenticated /ws/logs connection");
        conn->forceClose();
        return;
    }

    const std::string userId = payload["user_id"].asString();
    if (userId.empty()) {
        conn->forceClose();
        return;
    }

    const std::string subscriptionKey = resolveAuthorizedChannel(req, userId);
    if (subscriptionKey.empty()) {
        spdlog::warn("Rejected /ws/logs subscription for user {}", userId);
        conn->forceClose();
        return;
    }

    spdlog::info("WebSocket client connected for stream: {}", subscriptionKey);
    
    std::lock_guard<std::mutex> lock(subscribersMutex_);
    subscribers_[subscriptionKey].insert(conn);
    conn->setContext(std::make_shared<std::string>(subscriptionKey));
    if(payload.isMember("remote_device_id"))remote::watchConnection(req,conn);
}

void LogWebSocketController::handleNewMessage(
    const drogon::WebSocketConnectionPtr& conn,
    std::string&& message,
    const drogon::WebSocketMessageType& type
) {
    // We don't expect messages from clients for now
}

void LogWebSocketController::handleConnectionClosed(const drogon::WebSocketConnectionPtr& conn) {
    auto context = conn->getContext<std::string>();
    if (context) {
        std::lock_guard<std::mutex> lock(subscribersMutex_);
        subscribers_[*context].erase(conn);
        if (subscribers_[*context].empty()) {
            subscribers_.erase(*context);
        }
        spdlog::info("WebSocket client disconnected for stream: {}", *context);
    }
}

void LogWebSocketController::broadcastLog(const std::string& deploymentId, const std::string& line) {
    Json::Value msg;
    msg["type"] = "log";
    msg["line"] = line;
    
    Json::FastWriter writer;
    std::string out = writer.write(msg);

    std::vector<drogon::WebSocketConnectionPtr> targets;
    {
        std::lock_guard<std::mutex> lock(subscribersMutex_);
        auto it = subscribers_.find(deploymentId);
        if (it != subscribers_.end()) {
            targets.assign(it->second.begin(), it->second.end());
        }
    }

    for (const auto& conn : targets) {
        conn->send(out);
    }
}

void LogWebSocketController::broadcastStatus(const std::string& deploymentId, const std::string& status) {
    Json::Value msg;
    msg["type"] = "status";
    msg["deployment_id"] = deploymentId;
    msg["status"] = status;
    
    Json::FastWriter writer;
    std::string out = writer.write(msg);

    sendToChannelUnlocked(deploymentId, out);
}

void LogWebSocketController::broadcastDeploymentUpdate(const Json::Value& deployment, const std::string& ownerUserId) {
    Json::Value msg;
    msg["type"] = "deployment_update";
    msg["deployment"] = deployment;

    Json::FastWriter writer;
    std::string out = writer.write(msg);

    if (!ownerUserId.empty()) {
        sendToChannelUnlocked(globalChannelFor(ownerUserId), out);
    }
    if (deployment.isMember("id")) {
        sendToChannelUnlocked(deployment["id"].asString(), out);
    }
}

void LogWebSocketController::broadcastDeploymentDeleted(const std::string& deploymentId, const std::string& ownerUserId) {
    Json::Value msg;
    msg["type"] = "deployment_deleted";
    msg["deployment_id"] = deploymentId;

    Json::FastWriter writer;
    std::string out = writer.write(msg);

    if (!ownerUserId.empty()) {
        sendToChannelUnlocked(globalChannelFor(ownerUserId), out);
    }
    sendToChannelUnlocked(deploymentId, out);
}

void LogWebSocketController::sendToChannelUnlocked(const std::string& channelKey, const std::string& payload) {
    std::vector<drogon::WebSocketConnectionPtr> targets;
    {
        std::lock_guard<std::mutex> lock(subscribersMutex_);
        auto it = subscribers_.find(channelKey);
        if (it != subscribers_.end()) {
            targets.assign(it->second.begin(), it->second.end());
        }
    }
    for (const auto& conn : targets) {
        conn->send(payload);
    }
}

} // namespace stackpilot
