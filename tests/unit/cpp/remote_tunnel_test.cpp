#include "testing.h"
#include "../../../src/services/RemoteTunnelService.h"
#include <future>

using stackpilot::RemoteTunnelService;
namespace {
struct Tunnel {
    RemoteTunnelService::Clock::time_point time = RemoteTunnelService::Clock::time_point{} + std::chrono::seconds(1);
    bool running = true, connected = true, expired = false;
    long inspectStatus = 200, publicStatus = 200;
    int generation = 1, requests = 0, starts = 0, restarts = 0, stops = 0, logs = 0, probes = 0;
    std::string hostname = "first-test.trycloudflare.com";
    RemoteTunnelService service{[this](const std::string& method, const std::string& path, bool docker, long timeout) {
        ++requests;
        EXPECT_TRUE(timeout > 0 && timeout <= 5000);
        if (docker && method == "POST") {
            if (path.find("/restart") != std::string::npos) { ++restarts; ++generation; running = true; connected = false; expired = false; }
            else if (path.find("/stop") != std::string::npos) { ++stops; running = false; }
            else { ++starts; ++generation; running = true; connected = false; }
            return RemoteTunnelService::Response{204, ""};
        }
        if (path.find("/json") != std::string::npos) {
            Json::Value info;
            info["Id"] = "container";
            info["State"]["StartedAt"] = "2026-10-15T00:00:0" + std::to_string(generation) + ".123456789Z";
            info["State"]["Running"] = running;
            return RemoteTunnelService::Response{inspectStatus, info.toStyledString()};
        }
        if (path.ends_with("/ready")) return RemoteTunnelService::Response{connected ? 200 : 503, connected ? "{\"readyConnections\":1}" : "{\"readyConnections\":0}"};
        if (path.ends_with("/quicktunnel")) return RemoteTunnelService::Response{200, "{\"hostname\":\"" + hostname + "\"}"};
        if (path.find("/logs?") != std::string::npos) {
            ++logs;
            EXPECT_CONTAINS(path, "since=" + std::to_string(1792022400 + generation) + ".123456789");
            return RemoteTunnelService::Response{200, expired ? "Unauthorized: Tunnel not found" : ""};
        }
        EXPECT_TRUE(path.starts_with("https://"));
        ++probes;
        return RemoteTunnelService::Response{publicStatus, "<main data-stackpilot-remote-entry></main>"};
    }, [this] { return time; }};
    void after(int milliseconds) { time += std::chrono::milliseconds(milliseconds); }
};
}

TEST(RemoteTunnel, ReadsCurrentHostnameWithoutDependingOnLogs) {
    Tunnel t;
    const auto result = t.service.access();
    EXPECT_TRUE(result["ready"].asBool());
    EXPECT_EQ(result["url"].asString(), std::string("https://first-test.trycloudflare.com"));
    EXPECT_EQ(t.logs, 0);
    const auto requests = t.requests;
    t.service.access();
    EXPECT_EQ(t.requests, requests);
    t.after(1001); t.service.access();
    EXPECT_EQ(t.probes, 1); // No public round trip on each ready-status poll.
}

TEST(RemoteTunnel, DoesNotPublishReadinessBeforeDnsAndGatewayRespond) {
    Tunnel t; t.publicStatus = 0;
    EXPECT_FALSE(t.service.access()["ready"].asBool());
    t.after(501); t.publicStatus = 200;
    EXPECT_TRUE(t.service.access()["ready"].asBool());
    EXPECT_EQ(t.restarts, 0);
}

TEST(RemoteTunnel, StartReusesHealthyConnectionAndStopStaysOff) {
    Tunnel t;
    EXPECT_TRUE(t.service.access("start")["ready"].asBool());
    EXPECT_EQ(t.starts, 0); EXPECT_EQ(t.restarts, 0);
    EXPECT_FALSE(t.service.access("stop")["running"].asBool());
    t.after(60000);
    EXPECT_EQ(t.service.access()["url"].asString(), std::string(""));
    EXPECT_EQ(t.starts, 0); EXPECT_EQ(t.restarts, 0); EXPECT_EQ(t.stops, 1);
}

TEST(RemoteTunnel, RestartAndContainerReplacementDiscardOldHostname) {
    Tunnel t; t.service.access();
    EXPECT_FALSE(t.service.access("restart")["ready"].asBool());
    t.hostname = "replacement-test.trycloudflare.com"; ++t.generation;
    t.connected = true; t.after(501);
    EXPECT_EQ(t.service.access()["url"].asString(), std::string("https://replacement-test.trycloudflare.com"));
    EXPECT_EQ(t.restarts, 1);
}

TEST(RemoteTunnel, ExpiredRegistrationRecoversOnceWithBackoff) {
    Tunnel t; t.connected = false; t.expired = true;
    const auto result = t.service.access();
    EXPECT_EQ(result["state"].asString(), std::string("reconnecting"));
    EXPECT_EQ(result["url"].asString(), std::string(""));
    EXPECT_EQ(t.restarts, 1);
    t.expired = true; t.after(501); t.service.access();
    EXPECT_EQ(t.restarts, 1);
    t.after(10000); t.service.access();
    EXPECT_EQ(t.restarts, 2);
}

TEST(RemoteTunnel, NetworkLossGetsRecoveryGracePeriod) {
    Tunnel t; t.connected = false;
    t.service.access(); t.after(24000); t.service.access();
    EXPECT_EQ(t.restarts, 0);
    t.after(1500); t.service.access();
    EXPECT_EQ(t.restarts, 1);
}

TEST(RemoteTunnel, UnreachablePublicGatewayDoesNotStayStartingForever) {
    Tunnel t; t.publicStatus = 0;
    t.service.access(); t.after(26000); t.service.access();
    EXPECT_EQ(t.restarts, 0); // Do not restart just before negative DNS caches expire.
    t.after(20000);
    const auto result = t.service.access();
    EXPECT_EQ(t.restarts, 1);
    EXPECT_EQ(result["url"].asString(), std::string(""));
    EXPECT_FALSE(result["ready"].asBool());
}

TEST(RemoteTunnel, ConcurrentStartRequestsDoNotRotateOneAnother) {
    Tunnel t; t.running = false;
    auto first = std::async(std::launch::async, [&] { return t.service.access("start"); });
    auto second = std::async(std::launch::async, [&] { return t.service.access("start"); });
    EXPECT_TRUE(first.get()["running"].asBool());
    EXPECT_TRUE(second.get()["running"].asBool());
    EXPECT_EQ(t.starts, 1);
}

TEST(RemoteTunnel, RejectsUnsafeHostnamesAndReportsMissingInstallation) {
    Tunnel t; t.hostname = "127.0.0.1/secret";
    EXPECT_FALSE(t.service.access()["ready"].asBool());
    EXPECT_EQ(t.probes, 0);
    t.after(1001); t.inspectStatus = 404;
    EXPECT_FALSE(t.service.access()["available"].asBool());
}

TEST(RemoteTunnel, DockerFailureIsNotSilentlyReportedAsDisabled) {
    Tunnel t; t.inspectStatus = 0;
    bool failed = false;
    try { t.service.access(); } catch (const std::runtime_error&) { failed = true; }
    EXPECT_TRUE(failed);
}
