// ============================================================
// SshTerminalWebSocketController.h - Interactive SSH PTY bridge
// ============================================================

#pragma once

#include <drogon/WebSocketController.h>

#include <atomic>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

namespace dokscp {

class SshTerminalWebSocketController : public drogon::WebSocketController<SshTerminalWebSocketController> {
public:
    void handleNewMessage(const drogon::WebSocketConnectionPtr&,
                          std::string&&,
                          const drogon::WebSocketMessageType&) override;
    void handleNewConnection(const drogon::HttpRequestPtr&,
                             const drogon::WebSocketConnectionPtr&) override;
    void handleConnectionClosed(const drogon::WebSocketConnectionPtr&) override;

    WS_PATH_LIST_BEGIN
    WS_PATH_ADD("/ws/ssh-terminal");
    WS_PATH_LIST_END

private:
    struct TerminalSession {
        int masterFd = -1;
        int childPid = -1;
        std::string tempDir;
        std::atomic<bool> closed{false};
        std::mutex writeMutex;
        std::thread reader;
    };

    static void closeSession(const std::shared_ptr<TerminalSession>& session);
};

} // namespace dokscp
