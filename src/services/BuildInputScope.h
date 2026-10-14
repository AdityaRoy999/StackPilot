#pragma once
#include <json/json.h>
#include <set>
#include <string>
#include <utility>
#include <vector>

namespace stackpilot {
inline std::vector<std::pair<std::string,std::string>> runtimeInputs(
    const std::vector<std::pair<std::string,std::string>>& inputs, const Json::Value& plan) {
    // Artifact delivery runs only a trusted download server. Signing/private
    // build inputs must not become environment variables in that runtime.
    if (plan.get("verification_scope", "").asString()=="artifact_delivery") return {};
    std::set<std::string> buildOnly;
    for (const auto& key : plan["build_secrets"]) buildOnly.insert(key.asString());
    std::vector<std::pair<std::string,std::string>> result;
    for (const auto& item : inputs) if (!buildOnly.count(item.first)) result.push_back(item);
    return result;
}
}
