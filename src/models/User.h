// ============================================================
// User.h — User Data Model
// ============================================================
// CONCEPT: A "model" represents a database row as a C++ object.
// This is the "M" in MVC (Model-View-Controller) architecture.
// ============================================================

#pragma once

#include <string>
#include <json/json.h>  // Drogon's built-in jsoncpp

namespace dokscp {

struct User {
    std::string id;
    std::string username;
    std::string email;
    std::string passwordHash;
    std::string createdAt;
    std::string updatedAt;

    // Convert to JSON for API responses (excludes passwordHash!)
    Json::Value toJson() const {
        Json::Value j;
        j["id"] = id;
        j["username"] = username;
        j["email"] = email;
        j["created_at"] = createdAt;
        j["updated_at"] = updatedAt;
        return j;
    }
};

} // namespace dokscp
