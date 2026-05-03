// ============================================================
// LogWebSocketController.cpp — Real-time Build Log Streaming
// ============================================================

#include "LogWebSocketController.h"
#include <json/json.h>
#include <spdlog/spdlog.h>

namespace aids {

namespace {

constexpr const char* kGlobalDeploymentsChannel = "__deployments__";

std::string getSubscriptionKey(const drogon::HttpRequestPtr& req) {
    std::string stream = req->getParameter("stream");
    if (stream == "deployments") {
        return kGlobalDeploymentsChannel;
    }

    std::string deploymentId = req->getParameter("deploymentId");
    if (!deploymentId.empty()) {
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
    std::string subscriptionKey = getSubscriptionKey(req);
    if (subscriptionKey.empty()) {
        conn->forceClose();
        return;
    }

    spdlog::info("WebSocket client connected for stream: {}", subscriptionKey);
    
    std::lock_guard<std::mutex> lock(subscribersMutex_);
    subscribers_[subscriptionKey].insert(conn);
    conn->setContext(std::make_shared<std::string>(subscriptionKey));
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

    std::lock_guard<std::mutex> lock(subscribersMutex_);
    sendToChannelUnlocked(deploymentId, out);
}

void LogWebSocketController::broadcastStatus(const std::string& deploymentId, const std::string& status) {
    Json::Value msg;
    msg["type"] = "status";
    msg["deployment_id"] = deploymentId;
    msg["status"] = status;
    
    Json::FastWriter writer;
    std::string out = writer.write(msg);

    std::lock_guard<std::mutex> lock(subscribersMutex_);
    sendToChannelUnlocked(deploymentId, out);
}

void LogWebSocketController::broadcastDeploymentUpdate(const Json::Value& deployment) {
    Json::Value msg;
    msg["type"] = "deployment_update";
    msg["deployment"] = deployment;

    Json::FastWriter writer;
    std::string out = writer.write(msg);

    std::lock_guard<std::mutex> lock(subscribersMutex_);
    sendToChannelUnlocked(kGlobalDeploymentsChannel, out);
    if (deployment.isMember("id")) {
        sendToChannelUnlocked(deployment["id"].asString(), out);
    }
}

void LogWebSocketController::broadcastDeploymentDeleted(const std::string& deploymentId) {
    Json::Value msg;
    msg["type"] = "deployment_deleted";
    msg["deployment_id"] = deploymentId;

    Json::FastWriter writer;
    std::string out = writer.write(msg);

    std::lock_guard<std::mutex> lock(subscribersMutex_);
    sendToChannelUnlocked(kGlobalDeploymentsChannel, out);
    sendToChannelUnlocked(deploymentId, out);
}

void LogWebSocketController::sendToChannelUnlocked(const std::string& channelKey, const std::string& payload) {
    auto it = subscribers_.find(channelKey);
    if (it != subscribers_.end()) {
        for (const auto& conn : it->second) {
            conn->send(payload);
        }
    }
}

} // namespace aids
