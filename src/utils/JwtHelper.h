// ============================================================
// JwtHelper.h — JWT Token Management
// ============================================================

#pragma once

#include <drogon/HttpRequest.h>
#include <string>
#include <json/json.h>

namespace stackpilot {

class JwtHelper {
public:
    static std::string createToken(const std::string& userId,
                                   const std::string& email);
    static Json::Value verifyToken(const std::string& token);
    static std::string extractTokenFromRequest(const drogon::HttpRequestPtr& req);
    static Json::Value verifyRequestToken(const drogon::HttpRequestPtr& req);
    static Json::Value verifyMcpToken(const std::string& token);
    static bool isExpired(const Json::Value& payload);

private:
    static std::string getSecretKey();
    static int getExpirySeconds();

    static std::string base64UrlEncode(const std::string& input);
    static std::string base64UrlDecode(const std::string& input);
    static std::string hmacSha256(const std::string& key, const std::string& data);
};

} // namespace stackpilot
