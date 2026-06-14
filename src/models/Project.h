// ============================================================
// Project.h — Project Data Model
// ============================================================

#pragma once

#include <string>
#include <json/json.h>

namespace stackpilot {

struct Project {
    std::string id;
    std::string userId;
    std::string name;
    std::string description;
    std::string repoUrl;
    std::string status;
    std::string createdAt;
    std::string updatedAt;

    Json::Value toJson() const {
        Json::Value j;
        j["id"] = id;
        j["user_id"] = userId;
        j["name"] = name;
        j["description"] = description;
        j["repo_url"] = repoUrl;
        j["status"] = status;
        j["created_at"] = createdAt;
        j["updated_at"] = updatedAt;
        return j;
    }
};

} // namespace stackpilot
