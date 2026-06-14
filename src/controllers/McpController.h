// ============================================================
// McpController.h — MCP Token Management REST API
// ============================================================
// Manages API tokens used by external AI tools via the MCP server.
//
// Endpoints:
//   POST   /api/v1/mcp/tokens         → Create a new MCP token
//   GET    /api/v1/mcp/tokens         → List user's MCP tokens
//   DELETE /api/v1/mcp/tokens/{id}    → Revoke a token
//   GET    /api/v1/mcp/verify         → Verify a Bearer token (used by MCP server)
// ============================================================

#pragma once

#include <drogon/HttpController.h>

namespace stackpilot {

class McpController : public drogon::HttpController<McpController> {
public:
    METHOD_LIST_BEGIN
    ADD_METHOD_TO(McpController::createToken, "/api/v1/mcp/tokens", drogon::Post);
    ADD_METHOD_TO(McpController::listTokens, "/api/v1/mcp/tokens", drogon::Get);
    ADD_METHOD_TO(McpController::revokeToken, "/api/v1/mcp/tokens/{id}", drogon::Delete);
    ADD_METHOD_TO(McpController::verifyToken, "/api/v1/mcp/verify", drogon::Get);

    ADD_METHOD_TO(McpController::handleOptions, "/api/v1/mcp/tokens", drogon::Options);
    ADD_METHOD_TO(McpController::handleOptions, "/api/v1/mcp/tokens/{id}", drogon::Options);
    ADD_METHOD_TO(McpController::handleOptions, "/api/v1/mcp/verify", drogon::Options);
    METHOD_LIST_END

    void createToken(const drogon::HttpRequestPtr& req,
                     std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void listTokens(const drogon::HttpRequestPtr& req,
                    std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void revokeToken(const drogon::HttpRequestPtr& req,
                     std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                     const std::string& tokenId);

    void verifyToken(const drogon::HttpRequestPtr& req,
                     std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void handleOptions(const drogon::HttpRequestPtr& req,
                       std::function<void(const drogon::HttpResponsePtr&)>&& callback);

private:
    std::string extractUserId(const drogon::HttpRequestPtr& req);
    std::string extractMcpUserId(const drogon::HttpRequestPtr& req);
};

} // namespace stackpilot
