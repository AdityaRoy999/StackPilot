// ============================================================
// AuthController.h — Authentication REST API
// ============================================================
// CONCEPT: Controllers in MVC
// A controller HANDLES incoming HTTP requests.
// It's the "C" in MVC (Model-View-Controller).
//
// Flow: Client → HTTP Request → Controller → Service → Database
//                                    ↓
//                              HTTP Response ← Controller
//
// This controller handles:
//   POST /api/v1/auth/register  → Create new user
//   POST /api/v1/auth/login     → Login and get JWT token
//   GET  /api/v1/auth/me        → Get current user (requires JWT)
// ============================================================

#pragma once

#include <drogon/HttpController.h>

namespace dokscp {

class AuthController : public drogon::HttpController<AuthController> {
public:
    // ─── Route Registration ─────────────────────────────────
    // CONCEPT: These macros tell Drogon "when someone hits
    // POST /api/v1/auth/register, call the registerUser method"
    // This is called "routing" — mapping URLs to handler functions
    METHOD_LIST_BEGIN
    ADD_METHOD_TO(AuthController::registerUser, "/api/v1/auth/register", drogon::Post);
    ADD_METHOD_TO(AuthController::loginUser, "/api/v1/auth/login", drogon::Post);
    ADD_METHOD_TO(AuthController::googleAuth, "/api/v1/auth/google", drogon::Post);
    ADD_METHOD_TO(AuthController::startGitHubAuth, "/api/v1/auth/github/start", drogon::Post);
    ADD_METHOD_TO(AuthController::githubCallback, "/api/v1/auth/github/callback", drogon::Get);
    ADD_METHOD_TO(AuthController::requestPasswordResetOtp, "/api/v1/auth/forgot-password/request", drogon::Post);
    ADD_METHOD_TO(AuthController::resetPasswordWithOtp, "/api/v1/auth/forgot-password/verify", drogon::Post);
    ADD_METHOD_TO(AuthController::logoutUser, "/api/v1/auth/logout", drogon::Post);
    ADD_METHOD_TO(AuthController::disconnectGitHub, "/api/v1/auth/github", drogon::Delete);
    ADD_METHOD_TO(AuthController::getMe, "/api/v1/auth/me", drogon::Get);
    ADD_METHOD_TO(AuthController::getLoginHistory, "/api/v1/auth/login-history", drogon::Get);
    ADD_METHOD_TO(AuthController::getAuditLogs, "/api/v1/auth/audit-logs", drogon::Get);
    ADD_METHOD_TO(AuthController::updateMe, "/api/v1/auth/me", drogon::Put);
    
    // Explicit OPTIONS handlers for preflight requests
    ADD_METHOD_TO(AuthController::handleOptions, "/api/v1/auth/register", drogon::Options);
    ADD_METHOD_TO(AuthController::handleOptions, "/api/v1/auth/login", drogon::Options);
    ADD_METHOD_TO(AuthController::handleOptions, "/api/v1/auth/google", drogon::Options);
    ADD_METHOD_TO(AuthController::handleOptions, "/api/v1/auth/github/start", drogon::Options);
    ADD_METHOD_TO(AuthController::handleOptions, "/api/v1/auth/forgot-password/request", drogon::Options);
    ADD_METHOD_TO(AuthController::handleOptions, "/api/v1/auth/forgot-password/verify", drogon::Options);
    ADD_METHOD_TO(AuthController::handleOptions, "/api/v1/auth/logout", drogon::Options);
    ADD_METHOD_TO(AuthController::handleOptions, "/api/v1/auth/github", drogon::Options);
    ADD_METHOD_TO(AuthController::handleOptions, "/api/v1/auth/me", drogon::Options);
    ADD_METHOD_TO(AuthController::handleOptions, "/api/v1/auth/login-history", drogon::Options);
    ADD_METHOD_TO(AuthController::handleOptions, "/api/v1/auth/audit-logs", drogon::Options);
    METHOD_LIST_END

    // ─── Handler Methods ────────────────────────────────────
    // CONCEPT: Each method receives:
    //   - req: The incoming HTTP request (contains headers, body, etc.)
    //   - callback: A function YOU call to send the response back
    //
    // The callback pattern is how async frameworks work:
    // Instead of "return response", you call callback(response)
    // This allows the server to handle other requests while
    // waiting for database queries to complete.

    void registerUser(const drogon::HttpRequestPtr& req,
                      std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void loginUser(const drogon::HttpRequestPtr& req,
                   std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void googleAuth(const drogon::HttpRequestPtr& req,
                    std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void startGitHubAuth(const drogon::HttpRequestPtr& req,
                         std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void githubCallback(const drogon::HttpRequestPtr& req,
                        std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void requestPasswordResetOtp(const drogon::HttpRequestPtr& req,
                                 std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void resetPasswordWithOtp(const drogon::HttpRequestPtr& req,
                              std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void logoutUser(const drogon::HttpRequestPtr& req,
                    std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void disconnectGitHub(const drogon::HttpRequestPtr& req,
                          std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void getMe(const drogon::HttpRequestPtr& req,
               std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void getLoginHistory(const drogon::HttpRequestPtr& req,
                         std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void getAuditLogs(const drogon::HttpRequestPtr& req,
                      std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void updateMe(const drogon::HttpRequestPtr& req,
                  std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void handleOptions(const drogon::HttpRequestPtr& req,
                       std::function<void(const drogon::HttpResponsePtr&)>&& callback);
};

} // namespace dokscp
