// ============================================================
// DeploymentController.h — Deployment Management REST API
// ============================================================

#pragma once

#include <drogon/HttpController.h>

namespace aids {

class DeploymentController : public drogon::HttpController<DeploymentController> {
public:
    METHOD_LIST_BEGIN
    ADD_METHOD_TO(DeploymentController::createDeployment, "/api/v1/projects/{project_id}/deployments", drogon::Post);
    ADD_METHOD_TO(DeploymentController::listDeployments, "/api/v1/projects/{project_id}/deployments", drogon::Get);
    ADD_METHOD_TO(DeploymentController::listUserDeployments, "/api/v1/deployments", drogon::Get);
    ADD_METHOD_TO(DeploymentController::triggerBuild, "/api/v1/deployments/{deployment_id}/trigger", drogon::Post);
    ADD_METHOD_TO(DeploymentController::getDeploymentLogs, "/api/v1/deployments/{deployment_id}/logs", drogon::Get);
    ADD_METHOD_TO(DeploymentController::getDeploymentMetrics, "/api/v1/deployments/{deployment_id}/metrics", drogon::Get);
    ADD_METHOD_TO(DeploymentController::getRuntimeHealth, "/api/v1/deployments/{deployment_id}/runtime/health", drogon::Get);
    ADD_METHOD_TO(DeploymentController::deleteDeployment, "/api/v1/deployments/{deployment_id}", drogon::Delete);
    ADD_METHOD_TO(DeploymentController::deployToKubernetes, "/api/v1/deployments/{deployment_id}/kubernetes/deploy", drogon::Post);
    ADD_METHOD_TO(DeploymentController::scaleKubernetesDeployment, "/api/v1/deployments/{deployment_id}/kubernetes/scale", drogon::Post);
    ADD_METHOD_TO(DeploymentController::pauseRuntime, "/api/v1/deployments/{deployment_id}/runtime/pause", drogon::Post);
    ADD_METHOD_TO(DeploymentController::resumeRuntime, "/api/v1/deployments/{deployment_id}/runtime/resume", drogon::Post);
    ADD_METHOD_TO(DeploymentController::rollbackKubernetesDeployment, "/api/v1/deployments/{deployment_id}/kubernetes/rollback", drogon::Post);
    ADD_METHOD_TO(DeploymentController::getKubernetesEvents, "/api/v1/deployments/{deployment_id}/kubernetes/events", drogon::Get);
    ADD_METHOD_TO(DeploymentController::getKubernetesStatus, "/api/v1/deployments/{deployment_id}/kubernetes/status", drogon::Get);
    ADD_METHOD_TO(DeploymentController::removeKubernetesDeployment, "/api/v1/deployments/{deployment_id}/kubernetes", drogon::Delete);
    METHOD_LIST_END

    void createDeployment(const drogon::HttpRequestPtr& req,
                          std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                          const std::string& projectId);
    void listDeployments(const drogon::HttpRequestPtr& req,
                         std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                         const std::string& projectId);
    void listUserDeployments(const drogon::HttpRequestPtr& req,
                             std::function<void(const drogon::HttpResponsePtr&)>&& callback);
    void triggerBuild(const drogon::HttpRequestPtr& req,
                      std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                      const std::string& deploymentId);
    void getDeploymentLogs(const drogon::HttpRequestPtr& req,
                           std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                           const std::string& deploymentId);
    void getDeploymentMetrics(const drogon::HttpRequestPtr& req,
                              std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                              const std::string& deploymentId);
    void getRuntimeHealth(const drogon::HttpRequestPtr& req,
                          std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                          const std::string& deploymentId);
    void deleteDeployment(const drogon::HttpRequestPtr& req,
                          std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                          const std::string& deploymentId);
    void deployToKubernetes(const drogon::HttpRequestPtr& req,
                            std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                            const std::string& deploymentId);
    void scaleKubernetesDeployment(const drogon::HttpRequestPtr& req,
                                   std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                                   const std::string& deploymentId);
    void pauseRuntime(const drogon::HttpRequestPtr& req,
                      std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                      const std::string& deploymentId);
    void resumeRuntime(const drogon::HttpRequestPtr& req,
                       std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                       const std::string& deploymentId);
    void rollbackKubernetesDeployment(const drogon::HttpRequestPtr& req,
                                      std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                                      const std::string& deploymentId);
    void getKubernetesEvents(const drogon::HttpRequestPtr& req,
                             std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                             const std::string& deploymentId);
    void getKubernetesStatus(const drogon::HttpRequestPtr& req,
                             std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                             const std::string& deploymentId);
    void removeKubernetesDeployment(const drogon::HttpRequestPtr& req,
                                    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                                    const std::string& deploymentId);


private:
    std::string extractUserId(const drogon::HttpRequestPtr& req);
    void setRuntimePausedState(const drogon::HttpRequestPtr& req,
                               std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                               const std::string& deploymentId,
                               bool paused);
};

} // namespace aids
