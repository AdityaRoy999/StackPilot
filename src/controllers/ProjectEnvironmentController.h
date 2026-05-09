// ============================================================
// ProjectEnvironmentController.h - branch mapped environments
// ============================================================

#pragma once

#include <drogon/HttpController.h>

namespace dokscp {

class ProjectEnvironmentController : public drogon::HttpController<ProjectEnvironmentController> {
public:
    METHOD_LIST_BEGIN
    ADD_METHOD_TO(ProjectEnvironmentController::listEnvironments, "/api/v1/projects/{project_id}/environments", drogon::Get);
    ADD_METHOD_TO(ProjectEnvironmentController::createEnvironment, "/api/v1/projects/{project_id}/environments", drogon::Post);
    ADD_METHOD_TO(ProjectEnvironmentController::updateEnvironment, "/api/v1/projects/{project_id}/environments/{environment_id}", drogon::Put);
    ADD_METHOD_TO(ProjectEnvironmentController::deleteEnvironment, "/api/v1/projects/{project_id}/environments/{environment_id}", drogon::Delete);
    METHOD_LIST_END

    void listEnvironments(const drogon::HttpRequestPtr& req,
                          std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                          const std::string& projectId);
    void createEnvironment(const drogon::HttpRequestPtr& req,
                           std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                           const std::string& projectId);
    void updateEnvironment(const drogon::HttpRequestPtr& req,
                           std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                           const std::string& projectId,
                           const std::string& environmentId);
    void deleteEnvironment(const drogon::HttpRequestPtr& req,
                           std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                           const std::string& projectId,
                           const std::string& environmentId);

private:
    std::string extractUserId(const drogon::HttpRequestPtr& req);
};

} // namespace dokscp
