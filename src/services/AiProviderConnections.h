#pragma once
#include <json/json.h>
#include <pqxx/pqxx>
#include "../utils/TokenCrypto.h"

namespace stackpilot::aiProviders {
inline Json::Value list(pqxx::work& txn, const std::string& userId) {
    Json::Value items(Json::arrayValue);
    for (const auto& row : txn.exec_params(
             "SELECT id, name, vendor, provider, base_url, active, NULLIF(api_key_encrypted, '') IS NOT NULL AS has_key "
             "FROM ai_provider_connections WHERE user_id=$1 ORDER BY created_at, id", userId)) {
        Json::Value item(Json::objectValue);
        for (const auto* field : {"id", "name", "vendor", "provider", "base_url"}) item[field] = row[field].as<std::string>();
        item["active"] = row["active"].as<bool>();
        item["has_key"] = row["has_key"].as<bool>();
        items.append(item);
    }
    return items;
}

// Resolve credentials on the server. Never accept encrypted or saved secrets from the browser.
inline bool apply(pqxx::work& txn, const std::string& userId, Json::Value& prefs) {
    const auto rows = txn.exec_params(
        "SELECT id, name, provider, base_url, api_key_encrypted FROM ai_provider_connections WHERE user_id=$1 AND active", userId);
    if (rows.empty()) return false;
    const auto& row = rows[0];
    const auto provider = row["provider"].as<std::string>();
    const auto key = row["api_key_encrypted"].is_null() ? "" : TokenCrypto::decrypt(row["api_key_encrypted"].as<std::string>());
    prefs["provider"] = provider;
    prefs["provider_connection_id"] = row["id"].as<std::string>();
    prefs["provider_connection_name"] = row["name"].as<std::string>();
    if (provider == "nvidia_nim") prefs["nvidia_api_key"] = key;
    else {
        prefs["openai_compatible_base_url"] = row["base_url"].as<std::string>();
        prefs["openai_compatible_api_key"] = key;
    }
    return true;
}
}
