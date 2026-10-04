#pragma once
#include <json/json.h>
#include <string>

namespace stackpilot {
// These methods authenticate through the ownership query before reading or changing a runtime.
class DeploymentOperations {
public:
    static Json::Value metrics(const std::string& deploymentId, const std::string& userId);
    static Json::Value events(const std::string& deploymentId, const std::string& userId);
    static Json::Value scale(const std::string& deploymentId, const std::string& userId, int replicas);
};
}
