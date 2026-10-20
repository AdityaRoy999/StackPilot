#pragma once

#include <json/json.h>
#include <chrono>
#include <functional>
#include <mutex>
#include <string>

namespace stackpilot {

// The phone tunnel is shared by accounts on this host. Serialize lifecycle
// changes and briefly cache observations so concurrent polls do not fork CLIs
// or restart an already healthy connector.
class RemoteTunnelService {
public:
    struct Response { long status = 0; std::string body; };
    using Request = std::function<Response(const std::string&, const std::string&, bool, long)>;
    using Clock = std::chrono::steady_clock;
    using Now = std::function<Clock::time_point()>;

    static RemoteTunnelService& instance();
    explicit RemoteTunnelService(Request request = {}, Now now = Clock::now);
    Json::Value access(const std::string& action = "");

private:
    Json::Value observe();
    void resetGeneration(const std::string& generation);
    bool change(const std::string& action);

    Request request_;
    Now now_;
    std::mutex mutex_;
    Json::Value cached_;
    Clock::time_point expires_{}, disconnectedAt_{}, recoverAfter_{};
    std::string generation_, hostname_;
    bool publicReady_ = false;
    unsigned recoveryAttempts_ = 0;
};
}
