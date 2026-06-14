#pragma once

#include <drogon/HttpRequest.h>
#include <json/value.h>

#include <string>

namespace stackpilot {

class AuditLogger {
public:
    static void record(const std::string& userId,
                       const std::string& action,
                       const std::string& targetType,
                       const std::string& targetId,
                       const std::string& ipAddress,
                       const std::string& userAgent,
                       const Json::Value& metadata = Json::Value(Json::objectValue));

    static void recordFromRequest(const drogon::HttpRequestPtr& req,
                                  const std::string& userId,
                                  const std::string& action,
                                  const std::string& targetType,
                                  const std::string& targetId,
                                  const Json::Value& metadata = Json::Value(Json::objectValue));

    static std::string clientIp(const drogon::HttpRequestPtr& req);
    static std::string userAgent(const drogon::HttpRequestPtr& req);
};

} // namespace stackpilot
