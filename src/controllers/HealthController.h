// ============================================================
// HealthController.h - lightweight readiness endpoints
// ============================================================

#pragma once

#include <drogon/HttpController.h>

namespace stackpilot {

class HealthController : public drogon::HttpController<HealthController> {
public:
    METHOD_LIST_BEGIN
    ADD_METHOD_TO(HealthController::health, "/healthz", drogon::Get);
    ADD_METHOD_TO(HealthController::health, "/api/v1/health", drogon::Get);
    ADD_METHOD_TO(HealthController::metrics, "/metrics", drogon::Get);
    ADD_METHOD_TO(HealthController::loggingMonitoringSummary, "/api/v1/observability/summary", drogon::Get);
    ADD_METHOD_TO(HealthController::loggingMonitoringSummary, "/api/v1/logging-monitoring/summary", drogon::Get);
    ADD_METHOD_TO(HealthController::infrastructureInventory, "/api/v1/infrastructure/inventory", drogon::Get);
    ADD_METHOD_TO(HealthController::listInfrastructureClaims, "/api/v1/infrastructure/claims", drogon::Get);
    ADD_METHOD_TO(HealthController::claimInfrastructureResource, "/api/v1/infrastructure/claims", drogon::Post);
    ADD_METHOD_TO(HealthController::releaseInfrastructureResource, "/api/v1/infrastructure/claims/{id}", drogon::Delete);
    ADD_METHOD_TO(HealthController::inspectInfrastructureResource, "/api/v1/infrastructure/actions/inspect", drogon::Post);
    ADD_METHOD_TO(HealthController::logsInfrastructureResource, "/api/v1/infrastructure/actions/logs", drogon::Post);
    ADD_METHOD_TO(HealthController::restartInfrastructureResource, "/api/v1/infrastructure/actions/restart", drogon::Post);
    ADD_METHOD_TO(HealthController::dockerStateInfrastructureResource, "/api/v1/infrastructure/actions/docker-state", drogon::Post);
    ADD_METHOD_TO(HealthController::scaleInfrastructureResource, "/api/v1/infrastructure/actions/scale", drogon::Post);
    ADD_METHOD_TO(HealthController::kubernetesControlInfrastructureResource, "/api/v1/infrastructure/actions/kubernetes-control", drogon::Post);
    ADD_METHOD_TO(HealthController::kubernetesResourceYaml, "/api/v1/infrastructure/kubernetes/yaml", drogon::Post);
    ADD_METHOD_TO(HealthController::applyKubernetesResourceYaml, "/api/v1/infrastructure/kubernetes/apply-yaml", drogon::Post);
    METHOD_LIST_END

    void health(const drogon::HttpRequestPtr& req,
                std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void metrics(const drogon::HttpRequestPtr& req,
                 std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void loggingMonitoringSummary(const drogon::HttpRequestPtr& req,
                                  std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void infrastructureInventory(const drogon::HttpRequestPtr& req,
                                 std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void listInfrastructureClaims(const drogon::HttpRequestPtr& req,
                                  std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void claimInfrastructureResource(const drogon::HttpRequestPtr& req,
                                     std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void releaseInfrastructureResource(const drogon::HttpRequestPtr& req,
                                       std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                                       const std::string& id);

    void inspectInfrastructureResource(const drogon::HttpRequestPtr& req,
                                       std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void logsInfrastructureResource(const drogon::HttpRequestPtr& req,
                                    std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void restartInfrastructureResource(const drogon::HttpRequestPtr& req,
                                       std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void dockerStateInfrastructureResource(const drogon::HttpRequestPtr& req,
                                           std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void scaleInfrastructureResource(const drogon::HttpRequestPtr& req,
                                     std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void kubernetesControlInfrastructureResource(const drogon::HttpRequestPtr& req,
                                                 std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void kubernetesResourceYaml(const drogon::HttpRequestPtr& req,
                                std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void applyKubernetesResourceYaml(const drogon::HttpRequestPtr& req,
                                     std::function<void(const drogon::HttpResponsePtr&)>&& callback);

private:
    std::string extractUserId(const drogon::HttpRequestPtr& req);
};

} // namespace stackpilot
