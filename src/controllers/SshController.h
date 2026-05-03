// ============================================================
// SshController.h - Saved SSH/VPS connection management API
// ============================================================

#pragma once

#include <drogon/HttpController.h>

namespace aids {

class SshController : public drogon::HttpController<SshController> {
public:
    METHOD_LIST_BEGIN
    ADD_METHOD_TO(SshController::listConnections, "/api/v1/ssh/connections", drogon::Get);
    ADD_METHOD_TO(SshController::createConnection, "/api/v1/ssh/connections", drogon::Post);
    ADD_METHOD_TO(SshController::testConnection, "/api/v1/ssh/connections/{id}/test", drogon::Post);
    ADD_METHOD_TO(SshController::probeConnection, "/api/v1/ssh/connections/{id}/probe", drogon::Post);
    ADD_METHOD_TO(SshController::provisionDocker, "/api/v1/ssh/connections/{id}/provision/docker", drogon::Post);
    ADD_METHOD_TO(SshController::provisionKubernetes, "/api/v1/ssh/connections/{id}/provision/kubernetes", drogon::Post);
    ADD_METHOD_TO(SshController::browseConnection, "/api/v1/ssh/connections/{id}/browse", drogon::Post);
    ADD_METHOD_TO(SshController::executeCommand, "/api/v1/ssh/connections/{id}/command", drogon::Post);
    ADD_METHOD_TO(SshController::cloneRepository, "/api/v1/ssh/connections/{id}/git/clone", drogon::Post);
    ADD_METHOD_TO(SshController::deleteConnection, "/api/v1/ssh/connections/{id}", drogon::Delete);
    METHOD_LIST_END

    void listConnections(const drogon::HttpRequestPtr& req,
                         std::function<void(const drogon::HttpResponsePtr&)>&& callback);
    void createConnection(const drogon::HttpRequestPtr& req,
                          std::function<void(const drogon::HttpResponsePtr&)>&& callback);
    void testConnection(const drogon::HttpRequestPtr& req,
                        std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                        const std::string& id);
    void probeConnection(const drogon::HttpRequestPtr& req,
                         std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                         const std::string& id);
    void provisionDocker(const drogon::HttpRequestPtr& req,
                         std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                         const std::string& id);
    void provisionKubernetes(const drogon::HttpRequestPtr& req,
                             std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                             const std::string& id);
    void browseConnection(const drogon::HttpRequestPtr& req,
                          std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                          const std::string& id);
    void executeCommand(const drogon::HttpRequestPtr& req,
                        std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                        const std::string& id);
    void cloneRepository(const drogon::HttpRequestPtr& req,
                         std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                         const std::string& id);
    void deleteConnection(const drogon::HttpRequestPtr& req,
                          std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                          const std::string& id);

private:
    std::string extractUserId(const drogon::HttpRequestPtr& req) const;
};

} // namespace aids
