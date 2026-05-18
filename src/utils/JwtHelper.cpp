// ============================================================
// JwtHelper.cpp — JWT Implementation using jsoncpp + OpenSSL
// ============================================================

#include "JwtHelper.h"
#include "../db/Database.h"
#include <spdlog/spdlog.h>
#include <pqxx/pqxx>
#include <chrono>
#include <openssl/hmac.h>
#include <openssl/evp.h>
#include <openssl/crypto.h>
#include <openssl/buffer.h>
#include <openssl/bio.h>
#include <cstring>
#include <cstdlib>
#include <algorithm>
#include <cctype>
#include <sstream>

namespace dokscp {

namespace {

std::string trim(const std::string& value) {
    size_t start = 0;
    while (start < value.size() && std::isspace(static_cast<unsigned char>(value[start]))) {
        ++start;
    }

    size_t end = value.size();
    while (end > start && std::isspace(static_cast<unsigned char>(value[end - 1]))) {
        --end;
    }

    return value.substr(start, end - start);
}

std::string extractCookieValue(const std::string& cookieHeader, const std::string& name) {
    std::stringstream stream(cookieHeader);
    std::string chunk;
    const std::string prefix = name + "=";

    while (std::getline(stream, chunk, ';')) {
        chunk = trim(chunk);
        if (chunk.rfind(prefix, 0) == 0) {
            return chunk.substr(prefix.size());
        }
    }

    return "";
}

} // namespace

std::string JwtHelper::getSecretKey() {
    const char* secret = std::getenv("JWT_SECRET");
    if (secret && std::strlen(secret) >= 32) {
        return secret;
    }
    throw std::runtime_error("JWT_SECRET must be set to at least 32 characters");
}

int JwtHelper::getExpirySeconds() {
    const char* expiry = std::getenv("JWT_EXPIRY_SECONDS");
    if (!expiry || !*expiry) {
        return 3600;
    }
    try {
        return std::max(300, std::stoi(expiry));
    } catch (...) {
        return 3600;
    }
}

std::string JwtHelper::base64UrlEncode(const std::string& input) {
    BIO* b64 = BIO_new(BIO_f_base64());
    BIO* bmem = BIO_new(BIO_s_mem());
    b64 = BIO_push(b64, bmem);
    BIO_set_flags(b64, BIO_FLAGS_BASE64_NO_NL);
    BIO_write(b64, input.data(), static_cast<int>(input.size()));
    BIO_flush(b64);

    BUF_MEM* bptr;
    BIO_get_mem_ptr(b64, &bptr);
    std::string result(bptr->data, bptr->length);
    BIO_free_all(b64);

    for (auto& c : result) {
        if (c == '+') c = '-';
        else if (c == '/') c = '_';
    }
    while (!result.empty() && result.back() == '=') result.pop_back();
    return result;
}

std::string JwtHelper::base64UrlDecode(const std::string& input) {
    std::string base64 = input;
    for (auto& c : base64) {
        if (c == '-') c = '+';
        else if (c == '_') c = '/';
    }
    while (base64.size() % 4 != 0) base64 += '=';

    BIO* b64 = BIO_new(BIO_f_base64());
    BIO* bmem = BIO_new_mem_buf(base64.data(), static_cast<int>(base64.size()));
    bmem = BIO_push(b64, bmem);
    BIO_set_flags(bmem, BIO_FLAGS_BASE64_NO_NL);

    std::string result(base64.size(), '\0');
    int len = BIO_read(bmem, result.data(), static_cast<int>(result.size()));
    BIO_free_all(bmem);
    if (len > 0) result.resize(len);
    else result.clear();
    return result;
}

std::string JwtHelper::hmacSha256(const std::string& key, const std::string& data) {
    unsigned char result[EVP_MAX_MD_SIZE];
    unsigned int len = 0;
    HMAC(EVP_sha256(), key.data(), static_cast<int>(key.size()),
         reinterpret_cast<const unsigned char*>(data.data()), data.size(),
         result, &len);
    return std::string(reinterpret_cast<char*>(result), len);
}

std::string JwtHelper::createToken(const std::string& userId, const std::string& email) {
    // Header
    Json::Value header;
    header["alg"] = "HS256";
    header["typ"] = "JWT";

    // Payload
    auto now = std::chrono::system_clock::now();
    auto exp = now + std::chrono::seconds(getExpirySeconds());
    auto iat = std::chrono::duration_cast<std::chrono::seconds>(now.time_since_epoch()).count();
    auto expTime = std::chrono::duration_cast<std::chrono::seconds>(exp.time_since_epoch()).count();

    Json::Value payload;
    payload["user_id"] = userId;
    payload["email"] = email;
    payload["iat"] = Json::Value::Int64(iat);
    payload["exp"] = Json::Value::Int64(expTime);

    // Serialize to compact JSON
    Json::StreamWriterBuilder writer;
    writer["indentation"] = "";
    std::string headerStr = Json::writeString(writer, header);
    std::string payloadStr = Json::writeString(writer, payload);

    std::string encodedHeader = base64UrlEncode(headerStr);
    std::string encodedPayload = base64UrlEncode(payloadStr);
    std::string sigInput = encodedHeader + "." + encodedPayload;
    const std::string secret = getSecretKey();
    std::string signature = base64UrlEncode(hmacSha256(secret, sigInput));

    return encodedHeader + "." + encodedPayload + "." + signature;
}

Json::Value JwtHelper::verifyToken(const std::string& token) {
    try {
        auto firstDot = token.find('.');
        auto lastDot = token.rfind('.');
        if (firstDot == std::string::npos || lastDot == std::string::npos || firstDot == lastDot) {
            spdlog::warn("Invalid JWT format");
            return Json::Value(Json::nullValue);
        }

        std::string encodedHeader = token.substr(0, firstDot);
        std::string encodedPayload = token.substr(firstDot + 1, lastDot - firstDot - 1);
        std::string providedSig = token.substr(lastDot + 1);

        // Verify signature
        std::string sigInput = encodedHeader + "." + encodedPayload;
        const std::string secret = getSecretKey();
        std::string expectedSig = base64UrlEncode(hmacSha256(secret, sigInput));
        if (providedSig.size() != expectedSig.size() ||
            CRYPTO_memcmp(providedSig.data(), expectedSig.data(), expectedSig.size()) != 0) {
            spdlog::warn("JWT signature verification failed");
            return Json::Value(Json::nullValue);
        }

        // Decode and parse payload
        std::string payloadStr = base64UrlDecode(encodedPayload);
        Json::CharReaderBuilder reader;
        Json::Value payload;
        std::string errs;
        std::istringstream stream(payloadStr);
        if (!Json::parseFromStream(reader, stream, &payload, &errs)) {
            spdlog::warn("JWT payload parse failed: {}", errs);
            return Json::Value(Json::nullValue);
        }

        if (isExpired(payload)) {
            spdlog::warn("JWT token expired");
            return Json::Value(Json::nullValue);
        }

        return payload;
    } catch (const std::exception& e) {
        spdlog::error("JWT verification error: {}", e.what());
        return Json::Value(Json::nullValue);
    }
}

std::string JwtHelper::extractTokenFromRequest(const drogon::HttpRequestPtr& req) {
    if (!req) {
        return "";
    }

    const std::string authHeader = req->getHeader("Authorization");
    if (authHeader.rfind("Bearer ", 0) == 0) {
        return authHeader.substr(7);
    }

    const std::string cookieValue = req->getCookie("token");
    if (cookieValue.empty()) {
        const std::string cookieHeader = req->getHeader("cookie");
        if (cookieHeader.empty()) {
            return "";
        }
        return extractCookieValue(cookieHeader, "token");
    }

    return cookieValue;
}

Json::Value JwtHelper::verifyRequestToken(const drogon::HttpRequestPtr& req) {
    const std::string token = extractTokenFromRequest(req);
    if (token.empty()) {
        return Json::Value(Json::nullValue);
    }

    // MCP tokens are scoped to MCP endpoints. Normal API auth must reject them.
    if (token.rfind("dokscp_mcp_", 0) == 0) {
        return Json::Value(Json::nullValue);
    }

    Json::Value payload = verifyToken(token);
    if (payload.isNull() || !payload.isMember("user_id") || !payload.isMember("iat")) {
        return Json::Value(Json::nullValue);
    }

    try {
        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);
        auto rows = txn.exec_params(
            "SELECT EXTRACT(EPOCH FROM token_invalid_before) AS token_invalid_before "
            "FROM users WHERE id = $1",
            payload["user_id"].asString()
        );
        txn.commit();

        if (rows.empty()) {
            return Json::Value(Json::nullValue);
        }

        const auto invalidBefore = rows[0]["token_invalid_before"].is_null()
            ? 0
            : static_cast<long long>(rows[0]["token_invalid_before"].as<double>());
        if (payload["iat"].asInt64() < invalidBefore) {
            spdlog::warn("JWT rejected because it predates token_invalid_before");
            return Json::Value(Json::nullValue);
        }
    } catch (const std::exception& e) {
        spdlog::error("JWT request verification DB error: {}", e.what());
        return Json::Value(Json::nullValue);
    }

    return payload;
}

Json::Value JwtHelper::verifyMcpToken(const std::string& token) {
    // SHA-256 hash the token to look it up
    unsigned char hash[EVP_MAX_MD_SIZE];
    unsigned int hashLen = 0;
    EVP_MD_CTX* ctx = EVP_MD_CTX_new();
    EVP_DigestInit_ex(ctx, EVP_sha256(), nullptr);
    EVP_DigestUpdate(ctx, token.data(), token.size());
    EVP_DigestFinal_ex(ctx, hash, &hashLen);
    EVP_MD_CTX_free(ctx);

    std::ostringstream hexStream;
    hexStream << std::hex << std::setfill('0');
    for (unsigned int i = 0; i < hashLen; ++i) {
        hexStream << std::setw(2) << static_cast<int>(hash[i]);
    }
    std::string tokenHash = hexStream.str();

    try {
        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);

        auto result = txn.exec_params(
            "SELECT user_id FROM mcp_tokens WHERE token_hash = $1 AND (expires_at IS NULL OR expires_at > NOW())",
            tokenHash
        );

        if (result.empty()) {
            spdlog::warn("MCP token not found or expired");
            return Json::Value(Json::nullValue);
        }

        // Update last_used_at
        txn.exec_params("UPDATE mcp_tokens SET last_used_at = NOW() WHERE token_hash = $1", tokenHash);
        txn.commit();

        // Build a synthetic JWT-like payload
        Json::Value payload;
        payload["user_id"] = result[0]["user_id"].as<std::string>();
        payload["mcp"] = true;
        auto now = std::chrono::duration_cast<std::chrono::seconds>(
            std::chrono::system_clock::now().time_since_epoch()).count();
        payload["iat"] = Json::Value::Int64(now);
        payload["exp"] = Json::Value::Int64(now + 86400);
        return payload;
    } catch (const std::exception& e) {
        spdlog::error("MCP token verification DB error: {}", e.what());
        return Json::Value(Json::nullValue);
    }
}

bool JwtHelper::isExpired(const Json::Value& payload) {
    if (!payload.isMember("exp")) return true;
    auto now = std::chrono::duration_cast<std::chrono::seconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    return now > payload["exp"].asInt64();
}

} // namespace dokscp
