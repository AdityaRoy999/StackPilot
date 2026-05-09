// ============================================================
// Deployment.h — Deployment Data Model
// ============================================================

#pragma once

#include <string>
#include <json/json.h>

namespace dokscp {

struct Deployment {
    std::string id;
    std::string projectId;
    std::string status;
    std::string version;
    std::string commitHash;
    std::string logs;
    std::string imageName;
    std::string createdAt;
    std::string updatedAt;

    Json::Value toJson() const {
        Json::Value j;
        j["id"] = id;
        j["project_id"] = projectId;
        j["status"] = status;
        j["version"] = version;
        j["commit_hash"] = commitHash;
        j["logs"] = logs;
        j["image_name"] = imageName;
        j["created_at"] = createdAt;
        j["updated_at"] = updatedAt;
        return j;
    }
};

} // namespace dokscp
