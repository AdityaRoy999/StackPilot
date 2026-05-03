#pragma once

#include <drogon/HttpController.h>

namespace aids {

class AiController : public drogon::HttpController<AiController> {
public:
    METHOD_LIST_BEGIN
    ADD_METHOD_TO(AiController::health, "/api/v1/ai/health", drogon::Get);
    ADD_METHOD_TO(AiController::getSettings, "/api/v1/ai/settings", drogon::Get);
    ADD_METHOD_TO(AiController::updateSettings, "/api/v1/ai/settings", drogon::Put);
    ADD_METHOD_TO(AiController::listModels, "/api/v1/ai/models", drogon::Get);
    ADD_METHOD_TO(AiController::chatAgent, "/api/v1/ai/chat", drogon::Post);
    ADD_METHOD_TO(AiController::listRuns, "/api/v1/ai/runs", drogon::Get);
    ADD_METHOD_TO(AiController::listProjectRuns, "/api/v1/projects/{1}/ai/runs", drogon::Get);
    ADD_METHOD_TO(AiController::analyzeProject, "/api/v1/projects/{1}/ai/analyze", drogon::Post);
    ADD_METHOD_TO(AiController::generateDockerfile, "/api/v1/projects/{1}/ai/dockerfile", drogon::Post);
    ADD_METHOD_TO(AiController::chatProject, "/api/v1/projects/{1}/ai/chat", drogon::Post);
    ADD_METHOD_TO(AiController::analyzeBuildFailure, "/api/v1/deployments/{1}/ai/analyze-build-failure", drogon::Post);
    ADD_METHOD_TO(AiController::analyzeRuntimeFailure, "/api/v1/deployments/{1}/ai/analyze-runtime", drogon::Post);
    METHOD_LIST_END

    void health(const drogon::HttpRequestPtr& req,
                std::function<void(const drogon::HttpResponsePtr&)>&& callback);
    void getSettings(const drogon::HttpRequestPtr& req,
                     std::function<void(const drogon::HttpResponsePtr&)>&& callback);
    void updateSettings(const drogon::HttpRequestPtr& req,
                        std::function<void(const drogon::HttpResponsePtr&)>&& callback);
    void listModels(const drogon::HttpRequestPtr& req,
                    std::function<void(const drogon::HttpResponsePtr&)>&& callback);
    void chatAgent(const drogon::HttpRequestPtr& req,
                   std::function<void(const drogon::HttpResponsePtr&)>&& callback);
    void listRuns(const drogon::HttpRequestPtr& req,
                  std::function<void(const drogon::HttpResponsePtr&)>&& callback);
    void listProjectRuns(const drogon::HttpRequestPtr& req,
                         std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                         const std::string& projectId);
    void analyzeProject(const drogon::HttpRequestPtr& req,
                        std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                        const std::string& projectId);
    void generateDockerfile(const drogon::HttpRequestPtr& req,
                            std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                            const std::string& projectId);
    void chatProject(const drogon::HttpRequestPtr& req,
                     std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                     const std::string& projectId);
    void analyzeBuildFailure(const drogon::HttpRequestPtr& req,
                             std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                             const std::string& deploymentId);
    void analyzeRuntimeFailure(const drogon::HttpRequestPtr& req,
                               std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                               const std::string& deploymentId);

private:
    std::string extractUserId(const drogon::HttpRequestPtr& req) const;
};

} // namespace aids
