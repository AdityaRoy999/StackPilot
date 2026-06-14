// ============================================================
// ProjectController.h — Project Management REST API
// ============================================================
// CONCEPT: CRUD Operations
// CRUD = Create, Read, Update, Delete
// These are the 4 fundamental operations for any data entity.
//
// Endpoints:
//   POST   /api/v1/projects         → Create project
//   GET    /api/v1/projects         → List user's projects
//   GET    /api/v1/projects/{id}    → Get specific project
//   PUT    /api/v1/projects/{id}    → Update project
//   DELETE /api/v1/projects/{id}    → Delete project
// ============================================================

#pragma once

#include <drogon/HttpController.h>

namespace stackpilot {

class ProjectController : public drogon::HttpController<ProjectController> {
public:
    METHOD_LIST_BEGIN
    ADD_METHOD_TO(ProjectController::createProject, "/api/v1/projects", drogon::Post);
    ADD_METHOD_TO(ProjectController::listProjects, "/api/v1/projects", drogon::Get);
    ADD_METHOD_TO(ProjectController::getProject, "/api/v1/projects/{id}", drogon::Get);
    ADD_METHOD_TO(ProjectController::updateProject, "/api/v1/projects/{id}", drogon::Put);
    ADD_METHOD_TO(ProjectController::deleteProject, "/api/v1/projects/{id}", drogon::Delete);
    ADD_METHOD_TO(ProjectController::listGitHubRepos, "/api/v1/github/repos", drogon::Get);
    ADD_METHOD_TO(ProjectController::listGitHubRepos, "/api/v1/github/repos", drogon::Post);
    ADD_METHOD_TO(ProjectController::listGitHubBranches, "/api/v1/github/branches", drogon::Post);
    ADD_METHOD_TO(ProjectController::browseLocalSources, "/api/v1/local/sources/browse", drogon::Post);
    METHOD_LIST_END

    void createProject(const drogon::HttpRequestPtr& req,
                       std::function<void(const drogon::HttpResponsePtr&)>&& callback);
    void listProjects(const drogon::HttpRequestPtr& req,
                      std::function<void(const drogon::HttpResponsePtr&)>&& callback);
    void getProject(const drogon::HttpRequestPtr& req,
                    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                    const std::string& id);
    void updateProject(const drogon::HttpRequestPtr& req,
                       std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                       const std::string& id);
    void deleteProject(const drogon::HttpRequestPtr& req,
                       std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                       const std::string& id);
    void listGitHubRepos(const drogon::HttpRequestPtr& req,
                         std::function<void(const drogon::HttpResponsePtr&)>&& callback);
    void listGitHubBranches(const drogon::HttpRequestPtr& req,
                            std::function<void(const drogon::HttpResponsePtr&)>&& callback);
    void browseLocalSources(const drogon::HttpRequestPtr& req,
                            std::function<void(const drogon::HttpResponsePtr&)>&& callback);

private:
    // Helper: extract user_id from JWT in Authorization header
    std::string extractUserId(const drogon::HttpRequestPtr& req);
};

} // namespace stackpilot
