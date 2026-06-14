// ============================================================
// McpController.cpp — MCP Token Management Implementation
// ============================================================

#include "McpController.h"

#include "../db/Database.h"
#include "../utils/JwtHelper.h"
#include "../utils/AuditLogger.h"

#include <drogon/utils/Utilities.h>
#include <openssl/rand.h>
#include <openssl/evp.h>
#include <pqxx/pqxx>
#include <spdlog/spdlog.h>

#include <algorithm>
#include <cstdlib>
#include <iomanip>
#include <sstream>

namespace stackpilot {

namespace {

std::string getEnv(const char* key, const std::string& fallback = "") {
    const char* v = std::getenv(key);
    return (v && *v) ? v : fallback;
}

std::string getCorsOrigin() {
    return getEnv("CORS_ALLOWED_ORIGIN", "http://localhost:3000");
}

drogon::HttpResponsePtr corsOptions() {
    auto resp = drogon::HttpResponse::newHttpResponse();
    resp->setStatusCode(drogon::k204NoContent);
    resp->addHeader("Access-Control-Allow-Origin", getCorsOrigin());
    resp->addHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    resp->addHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-stackpilot-CSRF, X-stackpilot-MCP");
    resp->addHeader("Access-Control-Allow-Credentials", "true");
    resp->addHeader("Access-Control-Max-Age", "86400");
    return resp;
}

void setCors(const drogon::HttpResponsePtr& resp) {
    resp->addHeader("Access-Control-Allow-Origin", getCorsOrigin());
    resp->addHeader("Access-Control-Allow-Credentials", "true");
}

// Generate a secure random token: STACKPILOT_mcp_<40hex>
std::string generateMcpToken() {
    unsigned char bytes[20]; // 40 hex chars
    if (RAND_bytes(bytes, sizeof(bytes)) != 1) {
        throw std::runtime_error("Failed to generate secure random MCP token");
    }
    std::ostringstream out;
    out << "STACKPILOT_mcp_" << std::hex << std::setfill('0');
    for (int i = 0; i < 20; ++i) {
        out << std::setw(2) << static_cast<int>(bytes[i]);
    }
    return out.str();
}

// SHA-256 hash of a token for storage
std::string sha256Hex(const std::string& input) {
    unsigned char hash[EVP_MAX_MD_SIZE];
    unsigned int hashLen = 0;
    EVP_MD_CTX* ctx = EVP_MD_CTX_new();
    EVP_DigestInit_ex(ctx, EVP_sha256(), nullptr);
    EVP_DigestUpdate(ctx, input.data(), input.size());
    EVP_DigestFinal_ex(ctx, hash, &hashLen);
    EVP_MD_CTX_free(ctx);

    std::ostringstream out;
    out << std::hex << std::setfill('0');
    for (unsigned int i = 0; i < hashLen; ++i) {
        out << std::setw(2) << static_cast<int>(hash[i]);
    }
    return out.str();
}

} // namespace

// ─── OPTIONS handler ────────────────────────────────────────
void McpController::handleOptions(
    const drogon::HttpRequestPtr&,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback
) {
    callback(corsOptions());
}

// ─── Extract user from JWT cookie / Authorization header ────
std::string McpController::extractUserId(const drogon::HttpRequestPtr& req) {
    Json::Value payload = JwtHelper::verifyRequestToken(req);
    if (payload.isNull() || !payload.isMember("user_id")) {
        return "";
    }
    return payload["user_id"].asString();
}

// ─── Extract user from MCP Bearer token ─────────────────────
std::string McpController::extractMcpUserId(const drogon::HttpRequestPtr& req) {
    // First try normal JWT auth (browser)
    std::string userId = extractUserId(req);
    if (!userId.empty()) return userId;

    // Then try MCP Bearer token
    std::string authHeader = req->getHeader("Authorization");
    if (authHeader.size() < 8 || authHeader.substr(0, 7) != "Bearer ") {
        return "";
    }

    std::string token = authHeader.substr(7);
    if (token.rfind("STACKPILOT_mcp_", 0) != 0) {
        return "";  // Not an MCP token, might be a JWT
    }

    std::string tokenHash = sha256Hex(token);

    try {
        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);

        auto result = txn.exec_params(
            "SELECT user_id FROM mcp_tokens WHERE token_hash = $1 AND (expires_at IS NULL OR expires_at > NOW())",
            tokenHash
        );

        if (result.empty()) {
            return "";
        }

        // Update last_used_at
        txn.exec_params(
            "UPDATE mcp_tokens SET last_used_at = NOW() WHERE token_hash = $1",
            tokenHash
        );
        txn.commit();

        return result[0]["user_id"].as<std::string>();
    } catch (const std::exception& e) {
        spdlog::warn("MCP token lookup failed: {}", e.what());
        return "";
    }
}

// ─── POST /api/v1/mcp/tokens ────────────────────────────────
void McpController::createToken(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback
) {
    spdlog::info("POST /api/v1/mcp/tokens");

    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        Json::Value err; err["error"] = "Unauthorized";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k401Unauthorized);
        setCors(resp);
        callback(resp);
        return;
    }

    try {
        auto body = req->getJsonObject();
        std::string name = "MCP Token";
        Json::Value permissions(Json::arrayValue);
        permissions.append("read");

        if (body) {
            if (body->isMember("name") && (*body)["name"].isString()) {
                name = (*body)["name"].asString();
                if (name.empty()) name = "MCP Token";
                if (name.size() > 128) name = name.substr(0, 128);
            }
            if (body->isMember("permissions") && (*body)["permissions"].isArray()) {
                permissions = (*body)["permissions"];
            }
        }

        // Generate token
        std::string rawToken = generateMcpToken();
        std::string tokenHash = sha256Hex(rawToken);
        std::string tokenPrefix = rawToken.substr(0, 12); // "STACKPILOT_mcp_xxx"

        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);

        // Limit tokens per user
        auto countResult = txn.exec_params(
            "SELECT COUNT(*) FROM mcp_tokens WHERE user_id = $1", userId
        );
        if (!countResult.empty() && countResult[0][0].as<int>() >= 10) {
            Json::Value err;
            err["error"] = "Maximum of 10 MCP tokens per account. Revoke an existing one first.";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            setCors(resp);
            callback(resp);
            return;
        }

        // Write permissions as JSON string
        Json::StreamWriterBuilder writer;
        writer["indentation"] = "";
        std::string permissionsJson = Json::writeString(writer, permissions);

        auto result = txn.exec_params(
            "INSERT INTO mcp_tokens (user_id, name, token_hash, token_prefix, permissions) "
            "VALUES ($1, $2, $3, $4, $5::jsonb) "
            "RETURNING id, name, token_prefix, permissions, created_at",
            userId, name, tokenHash, tokenPrefix, permissionsJson
        );
        txn.commit();

        Json::Value respBody;
        respBody["message"] = "MCP token created successfully";
        respBody["token"] = rawToken;  // Only returned once!
        respBody["token_id"] = result[0]["id"].as<std::string>();
        respBody["name"] = result[0]["name"].as<std::string>();
        respBody["prefix"] = result[0]["token_prefix"].as<std::string>();
        respBody["created_at"] = result[0]["created_at"].as<std::string>();

        Json::Value metadata;
        metadata["token_name"] = name;
        AuditLogger::recordFromRequest(req, userId, "mcp.token.create", "mcp_token", result[0]["id"].as<std::string>(), metadata);

        auto resp = drogon::HttpResponse::newHttpJsonResponse(respBody);
        resp->setStatusCode(drogon::k201Created);
        setCors(resp);
        callback(resp);
        spdlog::info("MCP token created: {} for user {}", name, userId);
    } catch (const std::exception& e) {
        spdlog::error("MCP token creation error: {}", e.what());
        Json::Value err; err["error"] = "Internal server error";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k500InternalServerError);
        setCors(resp);
        callback(resp);
    }
}

// ─── GET /api/v1/mcp/tokens ────────────────────────────────
void McpController::listTokens(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        Json::Value err; err["error"] = "Unauthorized";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k401Unauthorized);
        setCors(resp);
        callback(resp);
        return;
    }

    try {
        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);

        auto result = txn.exec_params(
            "SELECT id, name, token_prefix, permissions, last_used_at, expires_at, created_at "
            "FROM mcp_tokens WHERE user_id = $1 ORDER BY created_at DESC",
            userId
        );
        txn.commit();

        Json::Value tokens(Json::arrayValue);
        for (const auto& row : result) {
            Json::Value token;
            token["id"] = row["id"].as<std::string>();
            token["name"] = row["name"].as<std::string>();
            token["prefix"] = row["token_prefix"].as<std::string>();
            token["last_used_at"] = row["last_used_at"].is_null() ? "" : row["last_used_at"].as<std::string>();
            token["expires_at"] = row["expires_at"].is_null() ? "" : row["expires_at"].as<std::string>();
            token["created_at"] = row["created_at"].as<std::string>();

            // Parse permissions JSON
            if (!row["permissions"].is_null()) {
                Json::CharReaderBuilder reader;
                std::string errors;
                std::istringstream stream(row["permissions"].as<std::string>());
                Json::Value perms;
                if (Json::parseFromStream(reader, stream, &perms, &errors)) {
                    token["permissions"] = perms;
                }
            }
            tokens.append(token);
        }

        Json::Value respBody;
        respBody["tokens"] = tokens;
        respBody["count"] = static_cast<int>(tokens.size());

        auto resp = drogon::HttpResponse::newHttpJsonResponse(respBody);
        setCors(resp);
        callback(resp);
    } catch (const std::exception& e) {
        spdlog::error("MCP token list error: {}", e.what());
        Json::Value err; err["error"] = "Internal server error";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k500InternalServerError);
        setCors(resp);
        callback(resp);
    }
}

// ─── DELETE /api/v1/mcp/tokens/{id} ────────────────────────
void McpController::revokeToken(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& tokenId
) {
    spdlog::info("DELETE /api/v1/mcp/tokens/{}", tokenId);

    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        Json::Value err; err["error"] = "Unauthorized";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k401Unauthorized);
        setCors(resp);
        callback(resp);
        return;
    }

    try {
        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);

        auto result = txn.exec_params(
            "DELETE FROM mcp_tokens WHERE id = $1 AND user_id = $2 RETURNING id, name",
            tokenId, userId
        );
        txn.commit();

        if (result.empty()) {
            Json::Value err; err["error"] = "Token not found or access denied";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k404NotFound);
            setCors(resp);
            callback(resp);
            return;
        }

        Json::Value metadata;
        metadata["token_name"] = result[0]["name"].as<std::string>();
        AuditLogger::recordFromRequest(req, userId, "mcp.token.revoke", "mcp_token", tokenId, metadata);

        Json::Value respBody;
        respBody["message"] = "MCP token revoked successfully";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(respBody);
        setCors(resp);
        callback(resp);
        spdlog::info("MCP token revoked: {}", tokenId);
    } catch (const std::exception& e) {
        spdlog::error("MCP token revoke error: {}", e.what());
        Json::Value err; err["error"] = "Internal server error";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k500InternalServerError);
        setCors(resp);
        callback(resp);
    }
}

// ─── GET /api/v1/mcp/verify ────────────────────────────────
// Used internally by the MCP server to verify a token and get user context
void McpController::verifyToken(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback
) {
    const std::string userId = extractMcpUserId(req);
    if (userId.empty()) {
        Json::Value err; err["error"] = "Invalid or expired MCP token";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k401Unauthorized);
        setCors(resp);
        callback(resp);
        return;
    }

    Json::Value respBody;
    respBody["valid"] = true;
    respBody["user_id"] = userId;
    auto resp = drogon::HttpResponse::newHttpJsonResponse(respBody);
    setCors(resp);
    callback(resp);
}

} // namespace stackpilot
