#pragma once

#include <json/value.h>

#include <string>

namespace aids {

struct AiServiceResult {
    bool ok = false;
    long statusCode = 0;
    Json::Value body;
    std::string error;
};

class AiServiceClient {
public:
    static AiServiceClient& instance();

    AiServiceResult health() const;
    AiServiceResult get(const std::string& path) const;
    AiServiceResult postWorkflow(const std::string& path, const Json::Value& payload) const;

private:
    std::string serviceUrl() const;
    long timeoutSeconds() const;
};

} // namespace aids
