#include "BrowserTunnelController.h"

#include "../services/LocalDockerRuntime.h"
#include "../utils/BlockingTaskRunner.h"
#include "../utils/StringUtils.h"

#include <openssl/crypto.h>
#include <cstdlib>
#include <mutex>

namespace stackpilot {
namespace {
std::mutex tunnelStartMutex;
}

void BrowserTunnelController::ensure(const drogon::HttpRequestPtr& req,
                                     std::function<void(const drogon::HttpResponsePtr&)>&& callback) {
    BlockingTaskRunner::run([req, callback = std::move(callback)]() mutable {
        auto respond = [&](drogon::HttpStatusCode status, const std::string& message, bool running = false) {
            Json::Value body;
            body["running"] = running;
            if (!message.empty()) body["error"] = message;
            auto response = drogon::HttpResponse::newHttpJsonResponse(body);
            response->setStatusCode(status);
            response->addHeader("Cache-Control", "no-store");
            callback(response);
        };

        const char* raw = std::getenv("STACKPILOT_AI_SERVICE_TOKEN");
        const std::string expected = raw ? raw : "";
        const std::string presented = req->getHeader("x-stackpilot-service-token");
        if (expected.empty() || presented.size() != expected.size() ||
            CRYPTO_memcmp(presented.data(), expected.data(), expected.size()) != 0) {
            respond(drogon::k401Unauthorized, "Internal service authentication required");
            return;
        }

        std::lock_guard<std::mutex> guard(tunnelStartMutex);
        // Fixed commands keep this endpoint from becoming general Docker control.
        std::string output;
        int code = LocalDockerRuntime::run(
            "timeout 4s docker inspect --format '{{.State.Running}}' stackpilot-remote-browser-tunnel 2>/dev/null", output);
        if (code != 0) {
            respond(drogon::k503ServiceUnavailable,
                    "Remote browser tunnel is not installed. Start the remote-browser Compose profile once after configuring its SSH host and key.");
            return;
        }
        if (strings::trim(output) != "true") {
            output.clear();
            code = LocalDockerRuntime::run(
                "timeout 6s docker start stackpilot-remote-browser-tunnel 2>/dev/null", output);
            if (code != 0) {
                respond(drogon::k503ServiceUnavailable,
                        "Remote browser tunnel could not start. Check its SSH configuration and Docker logs.");
                return;
            }
        }
        respond(drogon::k200OK, "", true);
    });
}
}
