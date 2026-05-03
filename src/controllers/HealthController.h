// ============================================================
// HealthController.h - lightweight readiness endpoints
// ============================================================

#pragma once

#include <drogon/HttpController.h>

namespace aids {

class HealthController : public drogon::HttpController<HealthController> {
public:
    METHOD_LIST_BEGIN
    ADD_METHOD_TO(HealthController::health, "/healthz", drogon::Get);
    ADD_METHOD_TO(HealthController::health, "/api/v1/health", drogon::Get);
    ADD_METHOD_TO(HealthController::metrics, "/metrics", drogon::Get);
    ADD_METHOD_TO(HealthController::observabilitySummary, "/api/v1/observability/summary", drogon::Get);
    METHOD_LIST_END

    void health(const drogon::HttpRequestPtr& req,
                std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void metrics(const drogon::HttpRequestPtr& req,
                 std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void observabilitySummary(const drogon::HttpRequestPtr& req,
                              std::function<void(const drogon::HttpResponsePtr&)>&& callback);

private:
    std::string extractUserId(const drogon::HttpRequestPtr& req);
};

} // namespace aids
