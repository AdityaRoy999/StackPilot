#include "RemoteTunnelService.h"
#include <curl/curl.h>
#include <algorithm>
#include <cstdlib>
#include <ctime>
#include <iomanip>
#include <memory>
#include <regex>
#include <sstream>
#include <stdexcept>

namespace stackpilot {
namespace {
constexpr const char* container = "/containers/stackpilot-remote-tunnel";
constexpr const char* metrics = "http://remote-tunnel:20241";

size_t receive(char* data, size_t size, size_t count, void* pointer) {
    auto& out = *static_cast<std::string*>(pointer);
    const auto length = size * count;
    if (out.size() + length > 256 * 1024) return 0;
    out.append(data, length);
    return length;
}

RemoteTunnelService::Response request(const std::string& method, const std::string& path,
                                     bool docker, long timeoutMs) {
    RemoteTunnelService::Response response;
    std::unique_ptr<CURL, decltype(&curl_easy_cleanup)> curl(curl_easy_init(), curl_easy_cleanup);
    if (!curl) return response;
    const std::string url = docker ? "http://localhost" + path : path;
    const bool publicProbe = !docker && path.rfind("https://", 0) == 0;
    curl_easy_setopt(curl.get(), CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl.get(), CURLOPT_CUSTOMREQUEST, method.c_str());
    curl_easy_setopt(curl.get(), CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(curl.get(), CURLOPT_CONNECTTIMEOUT_MS, std::min(publicProbe ? 3000L : 1000L, timeoutMs));
    curl_easy_setopt(curl.get(), CURLOPT_TIMEOUT_MS, timeoutMs);
    curl_easy_setopt(curl.get(), CURLOPT_WRITEFUNCTION, receive);
    curl_easy_setopt(curl.get(), CURLOPT_WRITEDATA, &response.body);
    if (docker) {
        curl_easy_setopt(curl.get(), CURLOPT_UNIX_SOCKET_PATH, "/var/run/docker.sock");
        curl_easy_setopt(curl.get(), CURLOPT_PROXY, "");
    }
    if (method == "POST") {
        curl_easy_setopt(curl.get(), CURLOPT_POSTFIELDS, "");
        curl_easy_setopt(curl.get(), CURLOPT_POSTFIELDSIZE, 0L);
    }
    const auto began = RemoteTunnelService::Clock::now();
    auto code = curl_easy_perform(curl.get());
    if (publicProbe && code == CURLE_COULDNT_RESOLVE_HOST) {
        // A newly allocated hostname can hit an upstream negative DNS cache.
        // Retry only failed resolution through Cloudflare's HTTPS resolver,
        // inside the original deadline, retaining certificate verification.
        const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(RemoteTunnelService::Clock::now() - began).count();
        if (elapsed < timeoutMs) {
            response.body.clear();
            curl_easy_setopt(curl.get(), CURLOPT_DOH_URL, "https://cloudflare-dns.com/dns-query");
            curl_easy_setopt(curl.get(), CURLOPT_TIMEOUT_MS, timeoutMs - static_cast<long>(elapsed));
            code = curl_easy_perform(curl.get());
        }
    }
    if (code == CURLE_OK)
        curl_easy_getinfo(curl.get(), CURLINFO_RESPONSE_CODE, &response.status);
    return response;
}

Json::Value parse(const std::string& body) {
    Json::Value value;
    Json::CharReaderBuilder builder;
    std::unique_ptr<Json::CharReader> reader(builder.newCharReader());
    std::string errors;
    reader->parse(body.data(), body.data() + body.size(), &value, &errors);
    return value;
}

Json::Value status(bool available, bool running, const std::string& state) {
    Json::Value value;
    value["available"] = available;
    value["running"] = running;
    value["ready"] = false;
    value["url"] = "";
    value["state"] = state;
    return value;
}

std::string logsSince(const std::string& started) {
    // The CLI translates RFC3339 to Unix time; the Engine /logs API does not.
    // Preserve nanoseconds so a fast restart cannot match the previous process.
    static const std::regex timestamp("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?Z");
    if (!std::regex_match(started, timestamp)) return "";
    std::tm utc{};
    std::istringstream input(started.substr(0, 19));
    input >> std::get_time(&utc, "%Y-%m-%dT%H:%M:%S");
    if (input.fail()) return "";
#ifdef _WIN32
    const auto seconds = _mkgmtime(&utc);
#else
    const auto seconds = timegm(&utc);
#endif
    if (seconds < 0) return "";
    return std::to_string(seconds) + started.substr(19, started.size() - 20);
}
}

RemoteTunnelService& RemoteTunnelService::instance() {
    static RemoteTunnelService service;
    return service;
}

RemoteTunnelService::RemoteTunnelService(Request handler, Now now)
    : request_(handler ? std::move(handler) : request), now_(std::move(now)) {}

void RemoteTunnelService::resetGeneration(const std::string& generation) {
    generation_ = generation;
    hostname_.clear();
    publicReady_ = false;
    disconnectedAt_ = {};
    expires_ = {};
}

bool RemoteTunnelService::change(const std::string& action) {
    const auto response = request_("POST", std::string(container) + "/" + action,
                                   true, action == "start" ? 3000 : 5000);
    return response.status == 204 || response.status == 304;
}

Json::Value RemoteTunnelService::access(const std::string& action) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!action.empty() && action != "start" && action != "stop" && action != "restart")
        throw std::invalid_argument("Choose start, stop or restart");
    if (!action.empty()) {
        const auto result = request_("GET", std::string(container) + "/json", true, 1500);
        if (result.status == 404) return status(false, false, "unavailable");
        if (result.status != 200) throw std::runtime_error("Docker is not responding");
        const bool running = parse(result.body)["State"].get("Running", false).asBool();
        // Starting an existing healthy tunnel must preserve its public address.
        if (action != "start" || !running) {
            const auto operation = action == "restart" ? "restart?t=1" : action == "stop" ? "stop?t=1" : "start";
            if (!change(operation)) throw std::runtime_error("Could not change remote access");
            resetGeneration("");
            recoveryAttempts_ = 0;
            recoverAfter_ = {};
        }
        expires_ = {};
    } else if (!cached_.isNull() && now_() < expires_) {
        return cached_;
    }
    const char* configured = std::getenv("STACKPILOT_REMOTE_PUBLIC_URL");
    try { cached_ = observe(); }
    catch (...) {
        if (!action.empty() || !configured || !*configured) throw;
        cached_ = status(false, false, "custom");
    }
    // An independently configured HTTPS gateway does not depend on the
    // managed quick tunnel being installed or running on this Docker host.
    if (configured && *configured) {
        cached_["url"] = configured;
        cached_["ready"] = true;
        cached_["state"] = "custom";
    }
    expires_ = now_() + std::chrono::milliseconds(cached_["ready"].asBool() ? 1000 : 250);
    return cached_;
}

Json::Value RemoteTunnelService::observe() {
    const auto inspected = request_("GET", std::string(container) + "/json", true, 1500);
    if (inspected.status == 404) { resetGeneration(""); return status(false, false, "unavailable"); }
    if (inspected.status != 200) throw std::runtime_error("Docker is not responding");
    const auto info = parse(inspected.body);
    const auto& state = info["State"];
    const auto generation = info.get("Id", "").asString() + "/" + state.get("StartedAt", "").asString();
    if (generation != generation_) resetGeneration(generation);
    const bool running = state.get("Running", false).asBool();
    auto result = status(true, running, running ? "starting" : "off");
    if (!running) { resetGeneration(generation); return result; }

    // These private endpoints report the current process, survive log rotation,
    // and do not expose a port to the host or the public tunnel.
    const auto ready = request_("GET", std::string(metrics) + "/ready", false, 650);
    if (hostname_.empty()) {
        const auto quick = request_("GET", std::string(metrics) + "/quicktunnel", false, 650);
        const auto hostname = parse(quick.body).get("hostname", "").asString();
        static const std::regex allowed("[a-z0-9]+(-[a-z0-9]+)*\\.trycloudflare\\.com");
        if (quick.status == 200 && std::regex_match(hostname, allowed)) hostname_ = hostname;
    }
    const char* configured = std::getenv("STACKPILOT_REMOTE_PUBLIC_URL");
    const std::string url = configured && *configured ? configured : hostname_.empty() ? "" : "https://" + hostname_;
    const bool connected = ready.status == 200 && parse(ready.body).get("readyConnections", 0).asInt() > 0;
    if (connected) {
        // On first registration also confirm DNS and the phone gateway work.
        // Never follow redirects or send credentials on this public probe.
        if (configured && *configured) publicReady_ = true;
        if (!publicReady_ && !hostname_.empty()) {
            const auto probe = request_("GET", "https://" + hostname_ + "/remote", false, 5000);
            publicReady_ = probe.status == 200 && (probe.body.find("stackpilot-remote-entry") != std::string::npos ||
                                                   probe.body.find("StackPilot on your phone") != std::string::npos);
        }
        result["url"] = url;
        result["ready"] = publicReady_;
        result["state"] = publicReady_ ? "ready" : "starting";
        if (publicReady_) {
            disconnectedAt_ = {};
            recoveryAttempts_ = 0;
            return result;
        }
    } else {
        publicReady_ = false;
    }

    if (disconnectedAt_ == Clock::time_point{}) disconnectedAt_ = now_();
    // A quick-tunnel registration can expire after sleep/network loss. The
    // old process otherwise backs off forever against an invalid tunnel ID.
    // Read only recent logs for this process to recognize that failure.
    const auto since = logsSince(state.get("StartedAt", "").asString());
    const auto logs = connected || since.empty() ? Response{} : request_("GET", std::string(container) +
        "/logs?stdout=1&stderr=1&tail=40&since=" + since, true, 1000);
    const bool expired = logs.status == 200 && logs.body.find("Unauthorized: Tunnel not found") != std::string::npos;
    // DNS/edge propagation after allocation gets longer than a disconnected
    // connector. Rotating a connected tunnel too early starts that work over.
    const bool stalled = now_() - disconnectedAt_ >= std::chrono::seconds(connected ? 45 : 25);
    if ((expired || stalled) && now_() >= recoverAfter_) {
        const auto delay = std::min(120u, 10u << std::min(recoveryAttempts_, 4u));
        recoverAfter_ = now_() + std::chrono::seconds(delay);
        ++recoveryAttempts_;
        if (change("restart?t=1")) {
            resetGeneration("");
            result["url"] = "";
            result["state"] = "reconnecting";
        } else {
            result["state"] = "failed";
            result["error"] = "Could not reconnect the tunnel. Check Docker and your internet connection.";
        }
    } else if (stalled || expired) {
        result["state"] = "reconnecting";
    }
    return result;
}
}
