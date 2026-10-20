#pragma once
#include <json/json.h>
#include <string>

namespace stackpilot::projectExposure {
struct Ports { int container = 0; int host = 0; };
std::string tunnelName(const std::string& deploymentId);
Ports discoverPorts(const Json::Value& inspection, const Json::Value& snapshot, const std::string& currentUrl);
Json::Value tunnelSpec(const std::string& deploymentId, const std::string& targetId,
                      int port, const std::string& token);
Json::Value publicStatus(const Json::Value& snapshot, const std::string& url, const std::string& mode);
Json::Value change(const std::string& deploymentId, const std::string& userId, const Json::Value& input);
Json::Value status(const std::string& deploymentId, const std::string& userId);
void release(const std::string& deploymentId, const std::string& userId);
void resumePending();
void stop();
}
