// ============================================================
// GitHubWebhookController.h - branch/environment auto deploy
// ============================================================

#pragma once

#include <drogon/HttpController.h>

namespace stackpilot {

class GitHubWebhookController : public drogon::HttpController<GitHubWebhookController> {
public:
    METHOD_LIST_BEGIN
    ADD_METHOD_TO(GitHubWebhookController::handleWebhook, "/api/v1/github/webhooks", drogon::Post);
    METHOD_LIST_END

    void handleWebhook(const drogon::HttpRequestPtr& req,
                       std::function<void(const drogon::HttpResponsePtr&)>&& callback);
};

} // namespace stackpilot

