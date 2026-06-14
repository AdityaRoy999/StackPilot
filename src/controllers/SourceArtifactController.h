// ============================================================
// SourceArtifactController.h - MCP local source artifact uploads
// ============================================================

#pragma once

#include <drogon/HttpController.h>

namespace stackpilot {

class SourceArtifactController : public drogon::HttpController<SourceArtifactController> {
public:
    METHOD_LIST_BEGIN
    ADD_METHOD_TO(SourceArtifactController::createArtifact, "/api/v1/source-artifacts", drogon::Post);
    ADD_METHOD_TO(SourceArtifactController::getArtifact, "/api/v1/source-artifacts/{id}", drogon::Get);
    METHOD_LIST_END

    void createArtifact(const drogon::HttpRequestPtr& req,
                        std::function<void(const drogon::HttpResponsePtr&)>&& callback);
    void getArtifact(const drogon::HttpRequestPtr& req,
                     std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                     const std::string& id);

private:
    std::string extractUserId(const drogon::HttpRequestPtr& req);
};

} // namespace stackpilot

