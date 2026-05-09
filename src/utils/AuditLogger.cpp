#include "AuditLogger.h"

#include "../db/Database.h"

#include <json/json.h>
#include <pqxx/pqxx>
#include <spdlog/spdlog.h>

#include <algorithm>
#include <cctype>

namespace dokscp {
namespace {

std::string trim(const std::string& value) {
    size_t start = 0;
    while (start < value.size() && std::isspace(static_cast<unsigned char>(value[start]))) {
        ++start;
    }
    size_t end = value.size();
    while (end > start && std::isspace(static_cast<unsigned char>(value[end - 1]))) {
        --end;
    }
    return value.substr(start, end - start);
}

std::string limit(const std::string& value, size_t maxLength) {
    return value.size() <= maxLength ? value : value.substr(0, maxLength);
}

std::string lower(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
    });
    return value;
}

std::string jsonToString(const Json::Value& value) {
    Json::StreamWriterBuilder builder;
    builder["indentation"] = "";
    return Json::writeString(builder, value.isNull() ? Json::Value(Json::objectValue) : value);
}

} // namespace

std::string AuditLogger::clientIp(const drogon::HttpRequestPtr& req) {
    if (!req) {
        return "unknown";
    }

    const std::string forwarded = trim(req->getHeader("X-Forwarded-For"));
    if (!forwarded.empty()) {
        const auto comma = forwarded.find(',');
        return lower(trim(forwarded.substr(0, comma)));
    }

    return lower(req->peerAddr().toIp());
}

std::string AuditLogger::userAgent(const drogon::HttpRequestPtr& req) {
    if (!req) {
        return "";
    }
    return limit(trim(req->getHeader("User-Agent")), 500);
}

void AuditLogger::record(const std::string& userId,
                         const std::string& action,
                         const std::string& targetType,
                         const std::string& targetId,
                         const std::string& ipAddress,
                         const std::string& userAgent,
                         const Json::Value& metadata) {
    if (userId.empty() || action.empty()) {
        return;
    }

    try {
        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);
        txn.exec_params(
            "INSERT INTO audit_logs (user_id, action, target_type, target_id, ip_address, user_agent, metadata) "
            "VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)",
            userId,
            limit(action, 90),
            limit(targetType, 60),
            limit(targetId, 220),
            limit(ipAddress, 128),
            limit(userAgent, 500),
            jsonToString(metadata)
        );
        txn.commit();
    } catch (const std::exception& e) {
        spdlog::warn("Audit log skipped for {} on {}: {}", action, targetId, e.what());
    }
}

void AuditLogger::recordFromRequest(const drogon::HttpRequestPtr& req,
                                    const std::string& userId,
                                    const std::string& action,
                                    const std::string& targetType,
                                    const std::string& targetId,
                                    const Json::Value& metadata) {
    record(userId, action, targetType, targetId, clientIp(req), userAgent(req), metadata);
}

} // namespace dokscp
