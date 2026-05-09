// ============================================================
// LogWebSocketController.h — Real-time Build Log Streaming
// ============================================================

#pragma once

#include <drogon/WebSocketController.h>
#include <json/json.h>
#include <map>
#include <set>
#include <mutex>

namespace dokscp {

class LogWebSocketController : public drogon::WebSocketController<LogWebSocketController> {
public:
    virtual void handleNewMessage(const drogon::WebSocketConnectionPtr&,
                                 std::string&&,
                                 const drogon::WebSocketMessageType&) override;
    virtual void handleNewConnection(const drogon::HttpRequestPtr&,
                                    const drogon::WebSocketConnectionPtr&) override;
    virtual void handleConnectionClosed(const drogon::WebSocketConnectionPtr&) override;

    WS_PATH_LIST_BEGIN
    WS_PATH_ADD("/ws/logs");
    WS_PATH_LIST_END

    // Static helper to broadcast logs to all listeners of a deployment
    static void broadcastLog(const std::string& deploymentId, const std::string& line);
    static void broadcastStatus(const std::string& deploymentId, const std::string& status);
    static void broadcastDeploymentUpdate(const Json::Value& deployment);
    static void broadcastDeploymentDeleted(const std::string& deploymentId);

private:
    static void sendToChannelUnlocked(const std::string& channelKey, const std::string& payload);

    static std::map<std::string, std::set<drogon::WebSocketConnectionPtr>> subscribers_;
    static std::mutex subscribersMutex_;
};

} // namespace dokscp
