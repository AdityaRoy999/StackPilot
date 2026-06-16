// ============================================================
// HealthController.cpp - lightweight readiness endpoints
// ============================================================

#include "HealthController.h"
#include "../db/Database.h"
#include "../services/SshService.h"
#include "../utils/JwtHelper.h"
#include "../utils/TokenCrypto.h"

#include <json/json.h>
#include <pqxx/pqxx>
#include <spdlog/spdlog.h>
#include <trantor/utils/Date.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <map>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

namespace stackpilot {

namespace {

std::string envOrDefault(const char* key, const std::string& fallback) {
    const char* value = std::getenv(key);
    return value && *value ? value : fallback;
}

std::string escapePrometheusLabel(const std::string& value) {
    std::string escaped;
    escaped.reserve(value.size());
    for (char c : value) {
        if (c == '\\' || c == '"') {
            escaped.push_back('\\');
        }
        if (c == '\n' || c == '\r') {
            escaped.push_back(' ');
            continue;
        }
        escaped.push_back(c);
    }
    return escaped;
}

void addMetricLine(std::ostringstream& out,
                   const std::string& name,
                   const std::map<std::string, std::string>& labels,
                   long long value) {
    out << name;
    if (!labels.empty()) {
        out << "{";
        bool first = true;
        for (const auto& [key, labelValue] : labels) {
            if (!first) {
                out << ",";
            }
            first = false;
            out << key << "=\"" << escapePrometheusLabel(labelValue) << "\"";
        }
        out << "}";
    }
    out << " " << value << "\n";
}

long long firstCount(pqxx::work& txn, const std::string& sql) {
    auto rows = txn.exec(sql);
    if (rows.empty() || rows[0][0].is_null()) {
        return 0;
    }
    return rows[0][0].as<long long>();
}

Json::Value groupedCounts(pqxx::work& txn, const std::string& sql) {
    Json::Value result(Json::objectValue);
    for (const auto& row : txn.exec(sql)) {
        const std::string key = row[0].is_null() ? "unknown" : row[0].as<std::string>();
        result[key] = Json::Value::Int64(row[1].as<long long>());
    }
    return result;
}

Json::Value groupedCountsForUser(pqxx::work& txn,
                                 const std::string& userId,
                                 const std::string& sql) {
    Json::Value result(Json::objectValue);
    for (const auto& row : txn.exec_params(sql, userId)) {
        const std::string key = row[0].is_null() ? "unknown" : row[0].as<std::string>();
        result[key] = Json::Value::Int64(row[1].as<long long>());
    }
    return result;
}

std::string trimCopy(const std::string& value) {
    const auto first = value.find_first_not_of(" \t\r\n");
    if (first == std::string::npos) return "";
    const auto last = value.find_last_not_of(" \t\r\n");
    return value.substr(first, last - first + 1);
}

std::vector<std::string> splitString(const std::string& value, const std::string& delimiter) {
    std::vector<std::string> parts;
    if (delimiter.empty()) {
        parts.push_back(value);
        return parts;
    }
    size_t start = 0;
    while (start <= value.size()) {
        const size_t pos = value.find(delimiter, start);
        if (pos == std::string::npos) {
            parts.push_back(value.substr(start));
            break;
        }
        parts.push_back(value.substr(start, pos - start));
        start = pos + delimiter.size();
    }
    return parts;
}

std::vector<std::string> splitLines(const std::string& value) {
    std::vector<std::string> lines;
    std::istringstream stream(value);
    std::string line;
    while (std::getline(stream, line)) {
        line = trimCopy(line);
        if (!line.empty()) {
            lines.push_back(line);
        }
    }
    return lines;
}

std::string runInventoryCommand(const std::string& command) {
    std::array<char, 4096> buffer{};
    std::string output;
    std::unique_ptr<FILE, decltype(&pclose)> pipe(popen(command.c_str(), "r"), pclose);
    if (!pipe) {
        return "";
    }
    while (fgets(buffer.data(), static_cast<int>(buffer.size()), pipe.get()) != nullptr) {
        output += buffer.data();
        if (output.size() > 4 * 1024 * 1024) {
            break;
        }
    }
    return output;
}

struct InfrastructureTarget {
    std::string targetType = "local";
    std::string connectionId;
    std::string label = "Local host";
    bool remote = false;
    SshConnectionConfig ssh;
};

std::string stripRemoteCommandMarkers(const std::string& output) {
    std::ostringstream cleaned;
    std::istringstream stream(output);
    std::string line;
    while (std::getline(stream, line)) {
        if (line.rfind("__STACKPILOT_CWD__=", 0) == 0 ||
            line.rfind("__STACKPILOT_EXIT_CODE__=", 0) == 0) {
            continue;
        }
        cleaned << line << "\n";
    }
    return cleaned.str();
}

SshConnectionConfig sshConfigFromRow(const pqxx::row& row) {
    SshConnectionConfig config;
    config.connectionType = row["connection_type"].is_null() ? "ssh" : row["connection_type"].as<std::string>();
    config.host = row["host"].as<std::string>();
    config.port = row["port"].as<int>();
    config.username = row["username"].as<std::string>();
    config.authType = row["auth_type"].as<std::string>();
    config.password = row["password_encrypted"].is_null()
        ? ""
        : TokenCrypto::decrypt(row["password_encrypted"].as<std::string>());
    config.privateKey = row["private_key_encrypted"].is_null()
        ? ""
        : TokenCrypto::decrypt(row["private_key_encrypted"].as<std::string>());
    config.knownHostsEntry = row["known_hosts_entry"].is_null() ? "" : row["known_hosts_entry"].as<std::string>();
    return config;
}

Json::Value targetToJson(const InfrastructureTarget& target) {
    Json::Value json;
    json["target_type"] = target.targetType;
    json["connection_id"] = target.connectionId;
    json["label"] = target.label;
    json["remote"] = target.remote;
    if (target.remote) {
        json["host"] = target.ssh.host;
        json["username"] = target.ssh.username;
        json["port"] = target.ssh.port;
        json["connection_type"] = target.ssh.connectionType;
    }
    return json;
}

InfrastructureTarget resolveInfrastructureTarget(const std::string& userId,
                                                 const std::string& requestedConnectionId,
                                                 drogon::HttpStatusCode& statusCode,
                                                 std::string& errorMessage) {
    InfrastructureTarget target;
    const std::string connectionId = trimCopy(requestedConnectionId);
    if (connectionId.empty() || connectionId == "local") {
        return target;
    }

    auto conn = Database::getInstance().getConnection();
    pqxx::work txn(*conn);
    const auto rows = txn.exec_params(
        "SELECT id, name, COALESCE(connection_type, 'ssh') AS connection_type, host, port, username, auth_type, "
        "password_encrypted, private_key_encrypted, known_hosts_entry "
        "FROM ssh_connections WHERE id = $1 AND user_id = $2",
        connectionId,
        userId
    );
    txn.commit();

    if (rows.empty()) {
        statusCode = drogon::k404NotFound;
        errorMessage = "Remote infrastructure target was not found for this account";
        return target;
    }

    target.targetType = "ssh";
    target.connectionId = rows[0]["id"].as<std::string>();
    target.label = rows[0]["name"].as<std::string>() + " (" + rows[0]["host"].as<std::string>() + ")";
    target.remote = true;
    target.ssh = sshConfigFromRow(rows[0]);
    return target;
}

std::string runCommandForTarget(const InfrastructureTarget& target,
                                const std::string& command,
                                int timeoutSeconds = 30) {
    if (!target.remote) {
        return runInventoryCommand(command);
    }

    SshService ssh;
    const auto result = ssh.runRemoteCommand(target.ssh, "/tmp", command, timeoutSeconds);
    std::string output = stripRemoteCommandMarkers(result.output);
    if (!result.success && !result.error.empty()) {
        if (!output.empty()) {
            output += "\n";
        }
        output += result.error;
    }
    return output;
}

bool parseJsonString(const std::string& raw, Json::Value& value) {
    if (trimCopy(raw).empty()) return false;
    Json::CharReaderBuilder reader;
    std::string errors;
    std::istringstream stream(raw);
    return Json::parseFromStream(reader, stream, &value, &errors);
}

std::string jsonStringValue(const Json::Value& value, const std::string& fallback = "") {
    return value.isString() ? value.asString() : fallback;
}

Json::Value numericMetricValue(const std::string& raw) {
    std::string cleaned = trimCopy(raw);
    cleaned.erase(std::remove(cleaned.begin(), cleaned.end(), '%'), cleaned.end());
    if (cleaned.empty() || cleaned == "<unknown>") {
        return Json::Value();
    }
    char* end = nullptr;
    const double value = std::strtod(cleaned.c_str(), &end);
    if (end == cleaned.c_str()) {
        return Json::Value();
    }
    return value;
}

bool nameLooksManagedByStackPilot(const std::string& name, const std::string& image = "") {
    return name.rfind("stackpilot-", 0) == 0 ||
           name.find("stackpilot-local-") != std::string::npos ||
           image.rfind("stackpilot/", 0) == 0 ||
           image.rfind("StackPilot/", 0) == 0 ||
           image.rfind("stackpilot-", 0) == 0;
}

std::string claimLookupKey(const std::string& providerType,
                           const std::string& resourceType,
                           const std::string& resourceKey) {
    return providerType + "|" + resourceType + "|" + resourceKey;
}

std::string dockerContainerResourceKey(const std::string& name, const std::string& id) {
    return "container:" + (!name.empty() ? name : id);
}

std::string dockerImageResourceKey(const std::string& repository, const std::string& tag, const std::string& id) {
    return "image:" + (!repository.empty() ? repository + ":" + tag : id);
}

std::string kubernetesResourceKey(const std::string& resourceType,
                                  const std::string& namespaceName,
                                  const std::string& name) {
    if (namespaceName.empty()) {
        return resourceType + ":" + name;
    }
    return resourceType + ":" + namespaceName + "/" + name;
}

Json::Value rowToInfrastructureResource(const pqxx::row& row) {
    Json::Value item;
    item["id"] = row["id"].as<std::string>();
    item["provider_type"] = row["provider_type"].as<std::string>();
    item["resource_type"] = row["resource_type"].as<std::string>();
    item["resource_key"] = row["resource_key"].as<std::string>();
    item["namespace"] = row["namespace"].is_null() ? "" : row["namespace"].as<std::string>();
    item["name"] = row["name"].as<std::string>();
    item["external_id"] = row["external_id"].is_null() ? "" : row["external_id"].as<std::string>();
    item["image"] = row["image"].is_null() ? "" : row["image"].as<std::string>();
    item["status"] = row["status"].is_null() ? "" : row["status"].as<std::string>();
    item["ownership_state"] = row["ownership_state"].as<std::string>();
    item["target_type"] = row["target_type"].is_null() ? "local" : row["target_type"].as<std::string>();
    item["target_connection_id"] = row["target_connection_id"].is_null() ? "" : row["target_connection_id"].as<std::string>();
    item["claimed_at"] = row["claimed_at"].is_null() ? "" : row["claimed_at"].as<std::string>();
    item["updated_at"] = row["updated_at"].is_null() ? "" : row["updated_at"].as<std::string>();

    Json::Value metadata(Json::objectValue);
    if (!row["metadata"].is_null()) {
        parseJsonString(row["metadata"].as<std::string>(), metadata);
    }
    item["metadata"] = metadata;
    return item;
}

std::map<std::string, Json::Value> loadClaimedInfrastructureResources(const std::string& userId,
                                                                       const InfrastructureTarget& target) {
    std::map<std::string, Json::Value> claims;
    auto conn = Database::getInstance().getConnection();
    pqxx::work txn(*conn);
    const auto rows = txn.exec_params(
        "SELECT id, provider_type, resource_type, resource_key, namespace, name, external_id, image, status, "
        "ownership_state, COALESCE(target_type, 'local') AS target_type, target_connection_id, metadata, claimed_at, updated_at "
        "FROM infrastructure_resources "
        "WHERE user_id = $1 AND ownership_state IN ('claimed', 'managed') "
        "AND COALESCE(target_type, 'local') = $2 "
        "AND (($3 = '' AND target_connection_id IS NULL) OR target_connection_id::text = $3)",
        userId,
        target.targetType,
        target.connectionId
    );
    for (const auto& row : rows) {
        Json::Value item = rowToInfrastructureResource(row);
        claims[claimLookupKey(item["provider_type"].asString(),
                              item["resource_type"].asString(),
                              item["resource_key"].asString())] = item;
    }
    txn.commit();
    return claims;
}

void applyClaimState(Json::Value& item,
                     const std::map<std::string, Json::Value>& claims,
                     const std::string& providerType,
                     const std::string& resourceType,
                     const std::string& resourceKey) {
    item["provider_type"] = providerType;
    item["resource_type"] = resourceType;
    item["resource_key"] = resourceKey;
    const auto it = claims.find(claimLookupKey(providerType, resourceType, resourceKey));
    if (it == claims.end()) {
        item["claimed_by_StackPilot"] = false;
        item["claim_id"] = "";
        item["ownership_state"] = item.get("managed_by_stackpilot", false).asBool() ? "managed" : "observed";
        return;
    }
    item["claimed_by_StackPilot"] = true;
    item["claim_id"] = it->second["id"].asString();
    item["ownership_state"] = it->second["ownership_state"].asString();
}

std::string jsonBodyString(const Json::Value& body, const std::string& key) {
    if (!body.isMember(key) || !body[key].isString()) return "";
    return trimCopy(body[key].asString());
}

std::string targetConnectionIdFromBody(const Json::Value& body) {
    std::string value = jsonBodyString(body, "target_connection_id");
    if (value.empty()) {
        value = jsonBodyString(body, "connection_id");
    }
    return value;
}

std::string targetConnectionIdFromRequest(const drogon::HttpRequestPtr& req) {
    if (!req) {
        return "";
    }
    return trimCopy(req->getParameter("connection_id"));
}

std::string shellQuote(const std::string& value) {
    std::string quoted = "'";
    for (char c : value) {
        if (c == '\'') {
            quoted += "'\\''";
        } else {
            quoted.push_back(c);
        }
    }
    quoted += "'";
    return quoted;
}

std::string kubernetesObjectName(const std::string& storedName, const std::string& namespaceName) {
    if (!namespaceName.empty()) {
        const std::string prefix = namespaceName + "/";
        if (storedName.rfind(prefix, 0) == 0) {
            return storedName.substr(prefix.size());
        }
    }
    const auto slash = storedName.find('/');
    if (slash != std::string::npos && slash + 1 < storedName.size()) {
        return storedName.substr(slash + 1);
    }
    return storedName;
}

Json::Value observedResourceFromActionBody(const Json::Value& body, const InfrastructureTarget& target) {
    const std::string providerType = jsonBodyString(body, "provider_type");
    const std::string resourceType = jsonBodyString(body, "resource_type");
    const std::string resourceKey = jsonBodyString(body, "resource_key");
    const std::string name = jsonBodyString(body, "name");

    if (providerType.empty() || resourceType.empty() || resourceKey.empty() || name.empty()) {
        return Json::Value();
    }

    Json::Value resource;
    resource["id"] = "";
    resource["claim_id"] = "";
    resource["provider_type"] = providerType;
    resource["resource_type"] = resourceType;
    resource["resource_key"] = resourceKey;
    resource["namespace"] = jsonBodyString(body, "namespace");
    resource["name"] = name;
    resource["external_id"] = jsonBodyString(body, "external_id");
    resource["image"] = jsonBodyString(body, "image");
    resource["status"] = jsonBodyString(body, "status");
    resource["ownership_state"] = "observed";
    resource["target_type"] = target.targetType;
    resource["target_connection_id"] = target.connectionId;
    resource["claimed_by_StackPilot"] = false;
    resource["managed_by_stackpilot"] = false;
    resource["metadata"] = body.isMember("metadata") && body["metadata"].isObject()
        ? body["metadata"]
        : Json::Value(Json::objectValue);
    return resource;
}

Json::Value claimedResourceForAction(const std::string& userId,
                                     const Json::Value& body,
                                     const std::string& actionName,
                                     drogon::HttpStatusCode& statusCode,
                                     std::string& errorMessage) {
    const std::string claimId = jsonBodyString(body, "claim_id");
    const std::string providerType = jsonBodyString(body, "provider_type");
    const std::string resourceType = jsonBodyString(body, "resource_type");
    const std::string resourceKey = jsonBodyString(body, "resource_key");
    drogon::HttpStatusCode targetStatus = drogon::k200OK;
    std::string targetError;
    const InfrastructureTarget target = resolveInfrastructureTarget(
        userId,
        targetConnectionIdFromBody(body),
        targetStatus,
        targetError
    );
    if (!targetError.empty()) {
        statusCode = targetStatus;
        errorMessage = targetError;
        return Json::Value();
    }

    auto conn = Database::getInstance().getConnection();
    pqxx::work txn(*conn);
    pqxx::result rows;
    if (!claimId.empty()) {
        rows = txn.exec_params(
            "SELECT id, provider_type, resource_type, resource_key, namespace, name, external_id, image, status, "
            "ownership_state, COALESCE(target_type, 'local') AS target_type, target_connection_id, metadata, claimed_at, updated_at "
            "FROM infrastructure_resources "
            "WHERE id = $1 AND user_id = $2 AND ownership_state IN ('claimed', 'managed')",
            claimId,
            userId
        );
    } else {
        rows = txn.exec_params(
            "SELECT id, provider_type, resource_type, resource_key, namespace, name, external_id, image, status, "
            "ownership_state, COALESCE(target_type, 'local') AS target_type, target_connection_id, metadata, claimed_at, updated_at "
            "FROM infrastructure_resources "
            "WHERE user_id = $1 AND provider_type = $2 AND resource_type = $3 AND resource_key = $4 "
            "AND COALESCE(target_type, 'local') = $5 "
            "AND (($6 = '' AND target_connection_id IS NULL) OR target_connection_id::text = $6) "
            "AND ownership_state IN ('claimed', 'managed')",
            userId,
            providerType,
            resourceType,
            resourceKey,
            target.targetType,
            target.connectionId
        );
    }

    if (rows.empty()) {
        const bool readOnlyAction = actionName == "inspect" || actionName == "read logs from";
        if (readOnlyAction) {
            Json::Value observed = observedResourceFromActionBody(body, target);
            if (!observed.isNull()) {
                txn.commit();
                return observed;
            }
        }

        statusCode = drogon::k403Forbidden;
        errorMessage = "Resource must be claimed before StackPilot can " + actionName + " it";
        return Json::Value();
    }

    Json::Value resource = rowToInfrastructureResource(rows[0]);
    txn.commit();
    return resource;
}

InfrastructureTarget targetForClaimedResource(const std::string& userId,
                                              const Json::Value& resource,
                                              drogon::HttpStatusCode& statusCode,
                                              std::string& errorMessage) {
    return resolveInfrastructureTarget(
        userId,
        resource.isMember("target_connection_id") ? resource["target_connection_id"].asString() : "",
        statusCode,
        errorMessage
    );
}

bool metricsRequestAuthorized(const drogon::HttpRequestPtr& req) {
    const char* expected = std::getenv("STACKPILOT_METRICS_BEARER_TOKEN");
    if (!expected || !*expected) {
        return true;
    }

    const std::string authHeader = req ? req->getHeader("Authorization") : "";
    return authHeader == ("Bearer " + std::string(expected));
}

} // namespace

void HealthController::health(
    const drogon::HttpRequestPtr&,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback
) {
    Json::Value payload;
    payload["status"] = Database::getInstance().isConnected() ? "ok" : "degraded";
    payload["service"] = "stackpilot-backend";
    payload["timestamp"] = trantor::Date::now().toFormattedString(false);

    auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
    resp->setStatusCode(Database::getInstance().isConnected()
        ? drogon::k200OK
        : drogon::k503ServiceUnavailable);
    callback(resp);
}

void HealthController::metrics(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback
) {
    if (!metricsRequestAuthorized(req)) {
        Json::Value payload;
        payload["error"] = "Unauthorized";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp);
        return;
    }

    std::ostringstream body;
    body << "# HELP STACKPILOT_database_connected Database connection health, 1 means connected.\n";
    body << "# TYPE STACKPILOT_database_connected gauge\n";
    addMetricLine(body, "STACKPILOT_database_connected", {}, Database::getInstance().isConnected() ? 1 : 0);

    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);

        body << "# HELP STACKPILOT_projects_total Projects grouped by status.\n";
        body << "# TYPE STACKPILOT_projects_total gauge\n";
        for (const auto& row : txn.exec("SELECT COALESCE(status, 'unknown'), COUNT(*) FROM projects GROUP BY 1")) {
            addMetricLine(body, "STACKPILOT_projects_total", {{"status", row[0].as<std::string>()}}, row[1].as<long long>());
        }

        body << "# HELP STACKPILOT_deployments_total Deployments grouped by status.\n";
        body << "# TYPE STACKPILOT_deployments_total gauge\n";
        for (const auto& row : txn.exec("SELECT COALESCE(status, 'unknown'), COUNT(*) FROM deployments GROUP BY 1")) {
            addMetricLine(body, "STACKPILOT_deployments_total", {{"status", row[0].as<std::string>()}}, row[1].as<long long>());
        }

        body << "# HELP STACKPILOT_deployments_by_runtime_total Deployments grouped by runtime provider.\n";
        body << "# TYPE STACKPILOT_deployments_by_runtime_total gauge\n";
        for (const auto& row : txn.exec(
                 "SELECT COALESCE(NULLIF(runtime_provider, ''), 'docker'), COUNT(*) "
                 "FROM deployments GROUP BY 1")) {
            addMetricLine(body, "STACKPILOT_deployments_by_runtime_total",
                          {{"runtime_provider", row[0].as<std::string>()}},
                          row[1].as<long long>());
        }

        body << "# HELP STACKPILOT_running_runtimes_total Deployments currently running.\n";
        body << "# TYPE STACKPILOT_running_runtimes_total gauge\n";
        addMetricLine(body, "STACKPILOT_running_runtimes_total", {},
                      firstCount(txn, "SELECT COUNT(*) FROM deployments WHERE status = 'running'"));

        body << "# HELP STACKPILOT_deployment_jobs_total Deployment jobs grouped by status.\n";
        body << "# TYPE STACKPILOT_deployment_jobs_total gauge\n";
        for (const auto& row : txn.exec("SELECT COALESCE(status, 'unknown'), COUNT(*) FROM deployment_jobs GROUP BY 1")) {
            addMetricLine(body, "STACKPILOT_deployment_jobs_total", {{"status", row[0].as<std::string>()}}, row[1].as<long long>());
        }

        body << "# HELP STACKPILOT_deployment_failures_last_24h Failed deployments created in the last 24 hours.\n";
        body << "# TYPE STACKPILOT_deployment_failures_last_24h gauge\n";
        addMetricLine(body, "STACKPILOT_deployment_failures_last_24h", {},
                      firstCount(txn,
                                 "SELECT COUNT(*) FROM deployments "
                                 "WHERE status = 'failed' AND created_at > NOW() - INTERVAL '24 hours'"));

        txn.commit();
    } catch (const std::exception& e) {
        body << "# HELP STACKPILOT_metrics_collection_error Metrics collection error, 1 means failed.\n";
        body << "# TYPE STACKPILOT_metrics_collection_error gauge\n";
        addMetricLine(body, "STACKPILOT_metrics_collection_error", {{"message", e.what()}}, 1);
    }

    auto resp = drogon::HttpResponse::newHttpResponse();
    resp->setStatusCode(drogon::k200OK);
    resp->addHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    resp->setBody(body.str());
    callback(resp);
}

void HealthController::loggingMonitoringSummary(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        Json::Value payload;
        payload["error"] = "Unauthorized";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp);
        return;
    }

    Json::Value payload;
    payload["service"] = "stackpilot-backend";
    payload["timestamp"] = trantor::Date::now().toFormattedString(false);
    payload["database_connected"] = Database::getInstance().isConnected();
    payload["stack"]["prometheus_url"] = envOrDefault("PROMETHEUS_PUBLIC_URL", "http://localhost:9090");
    payload["stack"]["grafana_url"] = envOrDefault("GRAFANA_PUBLIC_URL", "http://localhost:3001");
    payload["stack"]["loki_url"] = envOrDefault("LOKI_PUBLIC_URL", "http://localhost:3001/explore");
    payload["stack"]["metrics_endpoint"] = "/metrics";
    payload["status"] = "ok";
    payload["projects"]["active"] = Json::Value::Int64(0);
    payload["deployments"]["total"] = Json::Value::Int64(0);
    payload["deployments"]["running"] = Json::Value::Int64(0);
    payload["deployments"]["failed_current"] = Json::Value::Int64(0);
    payload["deployments"]["failed_last_24h"] = Json::Value::Int64(0);
    payload["deployments"]["by_status"] = Json::Value(Json::objectValue);
    payload["deployments"]["by_runtime"] = Json::Value(Json::objectValue);
    payload["jobs"]["by_status"] = Json::Value(Json::objectValue);
    payload["recent_failures"] = Json::Value(Json::arrayValue);

    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);

        payload["projects"]["active"] = Json::Value::Int64(
            txn.exec_params("SELECT COUNT(*) FROM projects WHERE user_id = $1 AND status = 'active'", userId)[0][0].as<long long>());
        payload["deployments"]["total"] = Json::Value::Int64(
            txn.exec_params(
                "SELECT COUNT(*) FROM deployments d JOIN projects p ON p.id = d.project_id WHERE p.user_id = $1",
                userId)[0][0].as<long long>());
        payload["deployments"]["running"] = Json::Value::Int64(
            txn.exec_params(
                "SELECT COUNT(*) FROM deployments d JOIN projects p ON p.id = d.project_id "
                "WHERE p.user_id = $1 AND d.status = 'running'",
                userId)[0][0].as<long long>());
        payload["deployments"]["failed_current"] = Json::Value::Int64(
            txn.exec_params(
                "SELECT COUNT(*) FROM deployments d JOIN projects p ON p.id = d.project_id "
                "WHERE p.user_id = $1 AND d.status = 'failed'",
                userId)[0][0].as<long long>());
        payload["deployments"]["failed_last_24h"] = Json::Value::Int64(
            txn.exec_params(
                "SELECT COUNT(*) FROM deployments d JOIN projects p ON p.id = d.project_id "
                "WHERE p.user_id = $1 AND d.status = 'failed' AND d.created_at > NOW() - INTERVAL '24 hours'",
                userId)[0][0].as<long long>());

        payload["deployments"]["by_status"] = groupedCountsForUser(
            txn,
            userId,
            "SELECT COALESCE(d.status, 'unknown'), COUNT(*) "
            "FROM deployments d JOIN projects p ON p.id = d.project_id "
            "WHERE p.user_id = $1 GROUP BY 1 ORDER BY 1");
        payload["deployments"]["by_runtime"] = groupedCountsForUser(
            txn,
            userId,
            "SELECT COALESCE(NULLIF(d.runtime_provider, ''), 'docker'), COUNT(*) "
            "FROM deployments d JOIN projects p ON p.id = d.project_id "
            "WHERE p.user_id = $1 GROUP BY 1 ORDER BY 1");
        payload["jobs"]["by_status"] = groupedCountsForUser(
            txn,
            userId,
            "SELECT COALESCE(j.status, 'unknown'), COUNT(*) "
            "FROM deployment_jobs j WHERE j.user_id = $1 GROUP BY 1 ORDER BY 1");

        Json::Value failures(Json::arrayValue);
        auto failureRows = txn.exec_params(
            "SELECT d.id, p.name, d.version, d.status, COALESCE(d.logs, '') AS logs, d.created_at "
            "FROM deployments d JOIN projects p ON p.id = d.project_id "
            "WHERE p.user_id = $1 AND d.status = 'failed' "
            "ORDER BY d.created_at DESC LIMIT 5",
            userId
        );
        for (const auto& row : failureRows) {
            Json::Value item;
            item["deployment_id"] = row["id"].as<std::string>();
            item["project_name"] = row["name"].as<std::string>();
            item["version"] = row["version"].is_null() ? "" : row["version"].as<std::string>();
            item["status"] = row["status"].as<std::string>();
            item["created_at"] = row["created_at"].as<std::string>();

            std::string logs = row["logs"].as<std::string>();
            if (logs.size() > 900) {
                logs = logs.substr(logs.size() - 900);
            }
            item["log_excerpt"] = logs;
            failures.append(item);
        }
        payload["recent_failures"] = failures;

        txn.commit();
    } catch (const std::exception& e) {
        payload["status"] = "degraded";
        payload["summary_warning"] = e.what();
        payload["database_connected"] = Database::getInstance().isConnected();
        spdlog::warn("Logging and monitoring summary degraded: {}", e.what());
    }

    auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
    resp->setStatusCode(drogon::k200OK);
    callback(resp);
}

void HealthController::infrastructureInventory(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        Json::Value payload;
        payload["error"] = "Unauthorized";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp);
        return;
    }

    Json::Value payload;
    payload["status"] = "ok";
    payload["timestamp"] = trantor::Date::now().toFormattedString(false);
    payload["scope"] = "host_runtime_inventory";
    payload["mode"] = "read_only";
    payload["docker"]["available"] = false;
    payload["docker"]["containers"] = Json::Value(Json::arrayValue);
    payload["docker"]["images"] = Json::Value(Json::arrayValue);
    payload["docker"]["stats"] = Json::Value(Json::arrayValue);
    payload["kubernetes"]["available"] = false;
    payload["kubernetes"]["namespaces"] = Json::Value(Json::arrayValue);
    payload["kubernetes"]["nodes"] = Json::Value(Json::arrayValue);
    payload["kubernetes"]["pods"] = Json::Value(Json::arrayValue);
    payload["kubernetes"]["deployments"] = Json::Value(Json::arrayValue);
    payload["kubernetes"]["services"] = Json::Value(Json::arrayValue);
    payload["kubernetes"]["events"] = Json::Value(Json::arrayValue);
    payload["kubernetes"]["node_metrics"] = Json::Value(Json::arrayValue);
    payload["kubernetes"]["pod_metrics"] = Json::Value(Json::arrayValue);
    payload["warnings"] = Json::Value(Json::arrayValue);

    drogon::HttpStatusCode targetStatus = drogon::k200OK;
    std::string targetError;
    const InfrastructureTarget target = resolveInfrastructureTarget(
        userId,
        targetConnectionIdFromRequest(req),
        targetStatus,
        targetError
    );
    if (!targetError.empty()) {
        Json::Value err;
        err["error"] = targetError;
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(targetStatus);
        callback(resp);
        return;
    }
    payload["target"] = targetToJson(target);
    payload["scope"] = target.remote ? "remote_runtime_inventory" : "host_runtime_inventory";

    std::map<std::string, Json::Value> claimedResources;
    try {
        claimedResources = loadClaimedInfrastructureResources(userId, target);
    } catch (const std::exception& e) {
        payload["warnings"].append(std::string("Claim registry unavailable: ") + e.what());
    }

    try {
        const std::string dockerPs = runCommandForTarget(
            target,
            "timeout 8s sh -lc \"command -v docker >/dev/null 2>&1 && "
            "docker ps -a --format '{{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}' 2>/dev/null\"",
            12
        );
        for (const auto& line : splitLines(dockerPs)) {
            const auto parts = splitString(line, "\t");
            if (parts.size() < 4) continue;
            Json::Value item;
            item["id"] = parts[0];
            item["name"] = parts.size() > 1 ? parts[1] : "";
            item["image"] = parts.size() > 2 ? parts[2] : "";
            item["status"] = parts.size() > 3 ? parts[3] : "";
            item["ports"] = parts.size() > 4 ? parts[4] : "";
            item["managed_by_stackpilot"] = nameLooksManagedByStackPilot(item["name"].asString(), item["image"].asString());
            applyClaimState(item,
                            claimedResources,
                            "docker",
                            "container",
                            dockerContainerResourceKey(item["name"].asString(), item["id"].asString()));
            payload["docker"]["containers"].append(item);
        }

        const std::string dockerImages = runCommandForTarget(
            target,
            "timeout 8s sh -lc \"command -v docker >/dev/null 2>&1 && "
            "docker images --format '{{.Repository}}\\t{{.Tag}}\\t{{.ID}}\\t{{.Size}}' 2>/dev/null\"",
            12
        );
        for (const auto& line : splitLines(dockerImages)) {
            const auto parts = splitString(line, "\t");
            if (parts.size() < 4) continue;
            Json::Value item;
            item["repository"] = parts[0];
            item["tag"] = parts[1];
            item["id"] = parts[2];
            item["size"] = parts[3];
            item["managed_by_stackpilot"] = nameLooksManagedByStackPilot(parts[0], parts[0]);
            applyClaimState(item,
                            claimedResources,
                            "docker",
                            "image",
                            dockerImageResourceKey(item["repository"].asString(),
                                                   item["tag"].asString(),
                                                   item["id"].asString()));
            payload["docker"]["images"].append(item);
        }
        const std::string dockerStats = runCommandForTarget(
            target,
            "timeout 8s sh -lc \"command -v docker >/dev/null 2>&1 && "
            "docker stats --no-stream --format '{{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}\\t{{.MemPerc}}\\t{{.PIDs}}' 2>/dev/null\"",
            12
        );
        for (const auto& line : splitLines(dockerStats)) {
            const auto parts = splitString(line, "\t");
            if (parts.size() < 4) continue;
            Json::Value item;
            item["name"] = parts[0];
            item["cpu"] = parts[1];
            item["cpu_percent"] = numericMetricValue(parts[1]);
            item["memory"] = parts[2];
            item["memory_percent"] = numericMetricValue(parts[3]);
            item["pids"] = parts.size() > 4 ? parts[4] : "";
            payload["docker"]["stats"].append(item);
        }
        payload["docker"]["available"] =
            payload["docker"]["containers"].size() > 0 || payload["docker"]["images"].size() > 0;
        payload["docker"]["container_count"] = static_cast<Json::UInt64>(payload["docker"]["containers"].size());
        payload["docker"]["image_count"] = static_cast<Json::UInt64>(payload["docker"]["images"].size());
    } catch (const std::exception& e) {
        payload["warnings"].append(std::string("Docker inventory failed: ") + e.what());
    }

    try {
        Json::Value namespacesJson;
        const std::string namespacesRaw = runCommandForTarget(
            target,
            "timeout 8s sh -lc \"command -v kubectl >/dev/null 2>&1 && kubectl get namespaces -o json 2>/dev/null\"",
            12
        );
        if (parseJsonString(namespacesRaw, namespacesJson) && namespacesJson.isMember("items")) {
            for (const auto& ns : namespacesJson["items"]) {
                Json::Value item;
                item["name"] = jsonStringValue(ns["metadata"]["name"]);
                item["status"] = jsonStringValue(ns["status"]["phase"], "Unknown");
                item["created_at"] = jsonStringValue(ns["metadata"]["creationTimestamp"]);
                item["managed_by_stackpilot"] = item["name"].asString().rfind("stackpilot-", 0) == 0;
                applyClaimState(item,
                                claimedResources,
                                "kubernetes",
                                "namespace",
                                kubernetesResourceKey("namespace", "", item["name"].asString()));
                payload["kubernetes"]["namespaces"].append(item);
            }
        }

        Json::Value nodesJson;
        const std::string nodesRaw = runCommandForTarget(
            target,
            "timeout 8s sh -lc \"command -v kubectl >/dev/null 2>&1 && kubectl get nodes -o json 2>/dev/null\"",
            12
        );
        if (parseJsonString(nodesRaw, nodesJson) && nodesJson.isMember("items")) {
            for (const auto& node : nodesJson["items"]) {
                Json::Value item;
                item["name"] = jsonStringValue(node["metadata"]["name"]);
                item["version"] = jsonStringValue(node["status"]["nodeInfo"]["kubeletVersion"]);
                item["os_image"] = jsonStringValue(node["status"]["nodeInfo"]["osImage"]);
                item["container_runtime"] = jsonStringValue(node["status"]["nodeInfo"]["containerRuntimeVersion"]);
                item["architecture"] = jsonStringValue(node["status"]["nodeInfo"]["architecture"]);
                item["kernel_version"] = jsonStringValue(node["status"]["nodeInfo"]["kernelVersion"]);
                item["capacity"] = node["status"].isMember("capacity") ? node["status"]["capacity"] : Json::Value(Json::objectValue);
                item["allocatable"] = node["status"].isMember("allocatable") ? node["status"]["allocatable"] : Json::Value(Json::objectValue);
                item["conditions"] = Json::Value(Json::arrayValue);
                item["ready"] = false;
                for (const auto& condition : node["status"]["conditions"]) {
                    Json::Value conditionItem;
                    conditionItem["type"] = jsonStringValue(condition["type"]);
                    conditionItem["status"] = jsonStringValue(condition["status"]);
                    conditionItem["reason"] = jsonStringValue(condition["reason"]);
                    conditionItem["message"] = jsonStringValue(condition["message"]);
                    item["conditions"].append(conditionItem);
                    if (jsonStringValue(condition["type"]) == "Ready") {
                        item["ready"] = jsonStringValue(condition["status"]) == "True";
                    }
                }
                item["managed_by_stackpilot"] = false;
                applyClaimState(item,
                                claimedResources,
                                "kubernetes",
                                "node",
                                kubernetesResourceKey("node", "", item["name"].asString()));
                payload["kubernetes"]["nodes"].append(item);
            }
        }

        Json::Value podsJson;
        const std::string podsRaw = runCommandForTarget(
            target,
            "timeout 8s sh -lc \"command -v kubectl >/dev/null 2>&1 && kubectl get pods -A -o json 2>/dev/null\"",
            12
        );
        if (parseJsonString(podsRaw, podsJson) && podsJson.isMember("items")) {
            for (const auto& pod : podsJson["items"]) {
                Json::Value item;
                item["namespace"] = jsonStringValue(pod["metadata"]["namespace"]);
                item["name"] = jsonStringValue(pod["metadata"]["name"]);
                item["node"] = jsonStringValue(pod["spec"]["nodeName"]);
                item["phase"] = jsonStringValue(pod["status"]["phase"], "Unknown");
                item["pod_ip"] = jsonStringValue(pod["status"]["podIP"]);
                item["created_at"] = jsonStringValue(pod["metadata"]["creationTimestamp"]);
                item["restart_count"] = 0;
                item["containers_ready"] = 0;
                item["container_count"] = static_cast<Json::UInt64>(pod["spec"]["containers"].size());
                for (const auto& containerStatus : pod["status"]["containerStatuses"]) {
                    item["restart_count"] = item["restart_count"].asInt() + containerStatus.get("restartCount", 0).asInt();
                    if (containerStatus.get("ready", false).asBool()) {
                        item["containers_ready"] = item["containers_ready"].asInt() + 1;
                    }
                }
                item["managed_by_stackpilot"] = item["namespace"].asString().rfind("stackpilot-", 0) == 0 ||
                                            item["name"].asString().find("StackPilot") != std::string::npos;
                applyClaimState(item,
                                claimedResources,
                                "kubernetes",
                                "pod",
                                kubernetesResourceKey("pod",
                                                      item["namespace"].asString(),
                                                      item["name"].asString()));
                payload["kubernetes"]["pods"].append(item);
            }
        }

        Json::Value deploymentsJson;
        const std::string deploymentsRaw = runCommandForTarget(
            target,
            "timeout 8s sh -lc \"command -v kubectl >/dev/null 2>&1 && kubectl get deployments -A -o json 2>/dev/null\"",
            12
        );
        if (parseJsonString(deploymentsRaw, deploymentsJson) && deploymentsJson.isMember("items")) {
            for (const auto& dep : deploymentsJson["items"]) {
                Json::Value item;
                item["namespace"] = jsonStringValue(dep["metadata"]["namespace"]);
                item["name"] = jsonStringValue(dep["metadata"]["name"]);
                item["replicas"] = dep["status"].get("replicas", dep["spec"].get("replicas", 0));
                item["desired_replicas"] = dep["spec"].get("replicas", 0);
                item["ready_replicas"] = dep["status"].get("readyReplicas", 0);
                item["available_replicas"] = dep["status"].get("availableReplicas", 0);
                item["updated_replicas"] = dep["status"].get("updatedReplicas", 0);
                item["generation"] = dep["metadata"].get("generation", 0);
                item["observed_generation"] = dep["status"].get("observedGeneration", 0);
                item["created_at"] = jsonStringValue(dep["metadata"]["creationTimestamp"]);
                item["conditions"] = Json::Value(Json::arrayValue);
                for (const auto& condition : dep["status"]["conditions"]) {
                    Json::Value conditionItem;
                    conditionItem["type"] = jsonStringValue(condition["type"]);
                    conditionItem["status"] = jsonStringValue(condition["status"]);
                    conditionItem["reason"] = jsonStringValue(condition["reason"]);
                    conditionItem["message"] = jsonStringValue(condition["message"]);
                    item["conditions"].append(conditionItem);
                }
                item["managed_by_stackpilot"] = item["namespace"].asString().rfind("stackpilot-", 0) == 0 ||
                                            item["name"].asString().find("StackPilot") != std::string::npos;
                applyClaimState(item,
                                claimedResources,
                                "kubernetes",
                                "deployment",
                                kubernetesResourceKey("deployment",
                                                      item["namespace"].asString(),
                                                      item["name"].asString()));
                payload["kubernetes"]["deployments"].append(item);
            }
        }

        Json::Value servicesJson;
        const std::string servicesRaw = runCommandForTarget(
            target,
            "timeout 8s sh -lc \"command -v kubectl >/dev/null 2>&1 && kubectl get services -A -o json 2>/dev/null\"",
            12
        );
        if (parseJsonString(servicesRaw, servicesJson) && servicesJson.isMember("items")) {
            for (const auto& svc : servicesJson["items"]) {
                Json::Value item;
                item["namespace"] = jsonStringValue(svc["metadata"]["namespace"]);
                item["name"] = jsonStringValue(svc["metadata"]["name"]);
                item["type"] = jsonStringValue(svc["spec"]["type"]);
                item["cluster_ip"] = jsonStringValue(svc["spec"]["clusterIP"]);
                item["created_at"] = jsonStringValue(svc["metadata"]["creationTimestamp"]);
                item["ports"] = Json::Value(Json::arrayValue);
                for (const auto& port : svc["spec"]["ports"]) {
                    Json::Value portItem;
                    portItem["name"] = jsonStringValue(port["name"]);
                    portItem["protocol"] = jsonStringValue(port["protocol"]);
                    portItem["port"] = port.get("port", 0);
                    portItem["target_port"] = port["targetPort"].isString()
                        ? port["targetPort"]
                        : port.get("targetPort", 0);
                    portItem["node_port"] = port.get("nodePort", 0);
                    item["ports"].append(portItem);
                }
                item["managed_by_stackpilot"] = item["namespace"].asString().rfind("stackpilot-", 0) == 0 ||
                                            item["name"].asString().find("StackPilot") != std::string::npos;
                applyClaimState(item,
                                claimedResources,
                                "kubernetes",
                                "service",
                                kubernetesResourceKey("service",
                                                      item["namespace"].asString(),
                                                      item["name"].asString()));
                payload["kubernetes"]["services"].append(item);
            }
        }

        Json::Value eventsJson;
        const std::string eventsRaw = runCommandForTarget(
            target,
            "timeout 8s sh -lc \"command -v kubectl >/dev/null 2>&1 && kubectl get events -A -o json 2>/dev/null\"",
            12
        );
        if (parseJsonString(eventsRaw, eventsJson) && eventsJson.isMember("items")) {
            for (const auto& event : eventsJson["items"]) {
                Json::Value item;
                item["namespace"] = jsonStringValue(event["metadata"]["namespace"]);
                item["name"] = jsonStringValue(event["metadata"]["name"]);
                item["type"] = jsonStringValue(event["type"], "Normal");
                item["reason"] = jsonStringValue(event["reason"]);
                item["message"] = jsonStringValue(event["message"]);
                item["count"] = event.get("count", 1);
                item["involved_kind"] = jsonStringValue(event["involvedObject"]["kind"]);
                item["involved_name"] = jsonStringValue(event["involvedObject"]["name"]);
                item["first_timestamp"] = jsonStringValue(event["firstTimestamp"]);
                item["last_timestamp"] = jsonStringValue(event["lastTimestamp"]);
                payload["kubernetes"]["events"].append(item);
            }
        }

        const std::string nodeMetricsRaw = runCommandForTarget(
            target,
            "timeout 8s sh -lc \"command -v kubectl >/dev/null 2>&1 && kubectl top nodes --no-headers 2>/dev/null\"",
            12
        );
        for (const auto& line : splitLines(nodeMetricsRaw)) {
            std::istringstream row(line);
            std::string name;
            std::string cpu;
            std::string cpuPercent;
            std::string memory;
            std::string memoryPercent;
            row >> name >> cpu >> cpuPercent >> memory >> memoryPercent;
            if (name.empty()) continue;
            Json::Value item;
            item["name"] = name;
            item["cpu"] = cpu;
            item["cpu_percent"] = numericMetricValue(cpuPercent);
            item["memory"] = memory;
            item["memory_percent"] = numericMetricValue(memoryPercent);
            payload["kubernetes"]["node_metrics"].append(item);
        }

        const std::string podMetricsRaw = runCommandForTarget(
            target,
            "timeout 8s sh -lc \"command -v kubectl >/dev/null 2>&1 && kubectl top pods -A --no-headers 2>/dev/null\"",
            12
        );
        for (const auto& line : splitLines(podMetricsRaw)) {
            std::istringstream row(line);
            std::string namespaceName;
            std::string name;
            std::string cpu;
            std::string memory;
            row >> namespaceName >> name >> cpu >> memory;
            if (namespaceName.empty() || name.empty()) continue;
            Json::Value item;
            item["namespace"] = namespaceName;
            item["name"] = name;
            item["cpu"] = cpu;
            item["memory"] = memory;
            payload["kubernetes"]["pod_metrics"].append(item);
        }

        payload["kubernetes"]["available"] =
            payload["kubernetes"]["nodes"].size() > 0 ||
            payload["kubernetes"]["pods"].size() > 0 ||
            payload["kubernetes"]["deployments"].size() > 0;
        payload["kubernetes"]["namespace_count"] = static_cast<Json::UInt64>(payload["kubernetes"]["namespaces"].size());
        payload["kubernetes"]["node_count"] = static_cast<Json::UInt64>(payload["kubernetes"]["nodes"].size());
        payload["kubernetes"]["pod_count"] = static_cast<Json::UInt64>(payload["kubernetes"]["pods"].size());
        payload["kubernetes"]["deployment_count"] = static_cast<Json::UInt64>(payload["kubernetes"]["deployments"].size());
        payload["kubernetes"]["service_count"] = static_cast<Json::UInt64>(payload["kubernetes"]["services"].size());
        payload["kubernetes"]["event_count"] = static_cast<Json::UInt64>(payload["kubernetes"]["events"].size());
    } catch (const std::exception& e) {
        payload["warnings"].append(std::string("Kubernetes inventory failed: ") + e.what());
    }

    auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
    resp->setStatusCode(drogon::k200OK);
    callback(resp);
}

void HealthController::listInfrastructureClaims(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        Json::Value payload;
        payload["error"] = "Unauthorized";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp);
        return;
    }

    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);
        const auto rows = txn.exec_params(
            "SELECT id, provider_type, resource_type, resource_key, namespace, name, external_id, image, status, "
            "ownership_state, COALESCE(target_type, 'local') AS target_type, target_connection_id, metadata, claimed_at, updated_at "
            "FROM infrastructure_resources "
            "WHERE user_id = $1 AND ownership_state IN ('claimed', 'managed') "
            "ORDER BY updated_at DESC",
            userId
        );

        Json::Value payload;
        payload["resources"] = Json::Value(Json::arrayValue);
        for (const auto& row : rows) {
            payload["resources"].append(rowToInfrastructureResource(row));
        }
        payload["count"] = static_cast<Json::UInt64>(payload["resources"].size());
        txn.commit();

        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k200OK);
        callback(resp);
    } catch (const std::exception& e) {
        Json::Value payload;
        payload["error"] = "Failed to list infrastructure claims";
        payload["details"] = e.what();
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void HealthController::claimInfrastructureResource(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        Json::Value payload;
        payload["error"] = "Unauthorized";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp);
        return;
    }

    const auto body = req->getJsonObject();
    if (!body) {
        Json::Value payload;
        payload["error"] = "Invalid JSON body";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k400BadRequest);
        callback(resp);
        return;
    }

    const std::string providerType = jsonBodyString(*body, "provider_type");
    const std::string resourceType = jsonBodyString(*body, "resource_type");
    const std::string resourceKey = jsonBodyString(*body, "resource_key");
    const std::string name = jsonBodyString(*body, "name");
    const std::string namespaceName = jsonBodyString(*body, "namespace");
    const std::string externalId = jsonBodyString(*body, "external_id");
    const std::string image = jsonBodyString(*body, "image");
    const std::string status = jsonBodyString(*body, "status");
    drogon::HttpStatusCode targetStatus = drogon::k200OK;
    std::string targetError;
    const InfrastructureTarget target = resolveInfrastructureTarget(
        userId,
        targetConnectionIdFromBody(*body),
        targetStatus,
        targetError
    );
    if (!targetError.empty()) {
        Json::Value payload;
        payload["error"] = targetError;
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(targetStatus);
        callback(resp);
        return;
    }

    const bool providerOk = providerType == "docker" || providerType == "kubernetes";
    const bool typeOk = resourceType == "container" || resourceType == "image" ||
                        resourceType == "namespace" ||
                        resourceType == "node" || resourceType == "pod" ||
                        resourceType == "deployment" || resourceType == "service";
    if (!providerOk || !typeOk || resourceKey.empty() || name.empty()) {
        Json::Value payload;
        payload["error"] = "provider_type, resource_type, resource_key, and name are required";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k400BadRequest);
        callback(resp);
        return;
    }

    Json::Value metadata(Json::objectValue);
    if (body->isMember("metadata") && (*body)["metadata"].isObject()) {
        metadata = (*body)["metadata"];
    }
    Json::StreamWriterBuilder writer;
    writer["indentation"] = "";
    const std::string metadataJson = Json::writeString(writer, metadata);

    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);
        const auto existingRows = txn.exec_params(
            "SELECT id FROM infrastructure_resources "
            "WHERE user_id = $1 AND provider_type = $2 AND resource_type = $3 AND resource_key = $4 "
            "AND COALESCE(target_type, 'local') = $5 "
            "AND (($6 = '' AND target_connection_id IS NULL) OR target_connection_id::text = $6)",
            userId,
            providerType,
            resourceType,
            resourceKey,
            target.targetType,
            target.connectionId
        );

        pqxx::result rows;
        if (existingRows.empty()) {
            rows = txn.exec_params(
                "INSERT INTO infrastructure_resources "
                "(user_id, target_type, target_connection_id, provider_type, resource_type, resource_key, namespace, name, external_id, image, status, "
                "ownership_state, metadata, claimed_at, released_at, updated_at) "
                "VALUES ($1, $2, NULLIF($3, '')::uuid, $4, $5, $6, NULLIF($7, ''), $8, NULLIF($9, ''), NULLIF($10, ''), NULLIF($11, ''), "
                "'claimed', $12::jsonb, NOW(), NULL, NOW()) "
                "RETURNING id, provider_type, resource_type, resource_key, namespace, name, external_id, image, status, "
                "ownership_state, COALESCE(target_type, 'local') AS target_type, target_connection_id, metadata, claimed_at, updated_at",
                userId,
                target.targetType,
                target.connectionId,
                providerType,
                resourceType,
                resourceKey,
                namespaceName,
                name,
                externalId,
                image,
                status,
                metadataJson
            );
        } else {
            rows = txn.exec_params(
                "UPDATE infrastructure_resources "
                "SET namespace = NULLIF($1, ''), "
                "name = $2, "
                "external_id = NULLIF($3, ''), "
                "image = NULLIF($4, ''), "
                "status = NULLIF($5, ''), "
                "ownership_state = 'claimed', "
                "metadata = $6::jsonb, "
                "released_at = NULL, "
                "updated_at = NOW() "
                "WHERE id = $7 AND user_id = $8 "
                "RETURNING id, provider_type, resource_type, resource_key, namespace, name, external_id, image, status, "
                "ownership_state, COALESCE(target_type, 'local') AS target_type, target_connection_id, metadata, claimed_at, updated_at",
            namespaceName,
            name,
            externalId,
            image,
            status,
                metadataJson,
                existingRows[0]["id"].as<std::string>(),
                userId
            );
        }

        Json::Value payload;
        payload["resource"] = rowToInfrastructureResource(rows[0]);
        payload["message"] = "Resource claimed. Future destructive actions can now require this claim.";
        txn.commit();

        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k201Created);
        callback(resp);
    } catch (const std::exception& e) {
        Json::Value payload;
        payload["error"] = "Failed to claim infrastructure resource";
        payload["details"] = e.what();
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void HealthController::releaseInfrastructureResource(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& id
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        Json::Value payload;
        payload["error"] = "Unauthorized";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp);
        return;
    }

    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);
        const auto rows = txn.exec_params(
            "UPDATE infrastructure_resources "
            "SET ownership_state = 'released', released_at = NOW(), updated_at = NOW() "
            "WHERE id = $1 AND user_id = $2 AND ownership_state IN ('claimed', 'managed') "
            "RETURNING id",
            id,
            userId
        );
        txn.commit();

        Json::Value payload;
        payload["released"] = !rows.empty();
        if (rows.empty()) {
            payload["message"] = "No active claim found for this resource.";
        }
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(rows.empty() ? drogon::k404NotFound : drogon::k200OK);
        callback(resp);
    } catch (const std::exception& e) {
        Json::Value payload;
        payload["error"] = "Failed to release infrastructure resource";
        payload["details"] = e.what();
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void HealthController::inspectInfrastructureResource(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        Json::Value payload;
        payload["error"] = "Unauthorized";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp);
        return;
    }

    const auto body = req->getJsonObject();
    if (!body) {
        Json::Value payload;
        payload["error"] = "Invalid JSON body";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k400BadRequest);
        callback(resp);
        return;
    }

    try {
        drogon::HttpStatusCode actionStatus = drogon::k200OK;
        std::string actionError;
        const Json::Value resource = claimedResourceForAction(userId, *body, "inspect", actionStatus, actionError);
        if (resource.isNull()) {
            Json::Value payload;
            payload["error"] = actionError;
            auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
            resp->setStatusCode(actionStatus);
            callback(resp);
            return;
        }
        const InfrastructureTarget target = targetForClaimedResource(userId, resource, actionStatus, actionError);
        if (!actionError.empty()) {
            Json::Value payload;
            payload["error"] = actionError;
            auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
            resp->setStatusCode(actionStatus);
            callback(resp);
            return;
        }
        const std::string resolvedProvider = resource["provider_type"].asString();
        const std::string resolvedType = resource["resource_type"].asString();
        const std::string namespaceName = resource["namespace"].asString();
        const std::string name = resolvedProvider == "kubernetes"
            ? kubernetesObjectName(resource["name"].asString(), namespaceName)
            : resource["name"].asString();
        const std::string externalId = resource["external_id"].asString();
        const std::string image = resource["image"].asString();

        std::string command;
        if (resolvedProvider == "docker") {
            if (resolvedType == "container") {
                const std::string target = !externalId.empty() ? externalId : name;
                command = "timeout 8s sh -lc \"docker inspect " + shellQuote(target) + " 2>/dev/null\"";
            } else if (resolvedType == "image") {
                const std::string target = !image.empty() ? image : name;
                command = "timeout 8s sh -lc \"docker image inspect " + shellQuote(target) + " 2>/dev/null\"";
            }
        } else if (resolvedProvider == "kubernetes") {
            std::string kubectlType = resolvedType;
            if (resolvedType == "deployment") kubectlType = "deployment";
            if (resolvedType == "service") kubectlType = "service";
            if (resolvedType == "pod") kubectlType = "pod";
            if (resolvedType == "node") {
                command = "timeout 8s sh -lc \"kubectl get node " + shellQuote(name) + " -o json 2>/dev/null\"";
            } else if (!namespaceName.empty()) {
                command = "timeout 8s sh -lc \"kubectl get " + kubectlType + " -n " +
                          shellQuote(namespaceName) + " " + shellQuote(name) + " -o json 2>/dev/null\"";
            }
        }

        if (command.empty()) {
            Json::Value payload;
            payload["error"] = "Inspect is not supported for this resource type";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp);
            return;
        }

        const std::string raw = runCommandForTarget(target, command, 15);
        Json::Value parsed;
        Json::Value payload;
        payload["resource"] = resource;
        payload["mode"] = "read_only_inspect";
        payload["raw"] = raw;
        if (parseJsonString(raw, parsed)) {
            payload["inspect"] = parsed;
        } else {
            payload["inspect"] = Json::Value(Json::objectValue);
            payload["warning"] = "Inspect command returned no JSON. The resource may no longer exist or the runtime is unavailable.";
        }

        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k200OK);
        callback(resp);
    } catch (const std::exception& e) {
        Json::Value payload;
        payload["error"] = "Failed to inspect infrastructure resource";
        payload["details"] = e.what();
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void HealthController::logsInfrastructureResource(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        Json::Value payload;
        payload["error"] = "Unauthorized";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp);
        return;
    }

    const auto body = req->getJsonObject();
    if (!body) {
        Json::Value payload;
        payload["error"] = "Invalid JSON body";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k400BadRequest);
        callback(resp);
        return;
    }

    try {
        drogon::HttpStatusCode actionStatus = drogon::k200OK;
        std::string actionError;
        const Json::Value resource = claimedResourceForAction(userId, *body, "read logs from", actionStatus, actionError);
        if (resource.isNull()) {
            Json::Value payload;
            payload["error"] = actionError;
            auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
            resp->setStatusCode(actionStatus);
            callback(resp);
            return;
        }
        const InfrastructureTarget target = targetForClaimedResource(userId, resource, actionStatus, actionError);
        if (!actionError.empty()) {
            Json::Value payload;
            payload["error"] = actionError;
            auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
            resp->setStatusCode(actionStatus);
            callback(resp);
            return;
        }

        const int tailLines = body->isMember("tail_lines") && (*body)["tail_lines"].isInt()
            ? std::clamp((*body)["tail_lines"].asInt(), 20, 1000)
            : 200;
        const std::string resolvedProvider = resource["provider_type"].asString();
        const std::string resolvedType = resource["resource_type"].asString();
        const std::string namespaceName = resource["namespace"].asString();
        const std::string name = resolvedProvider == "kubernetes"
            ? kubernetesObjectName(resource["name"].asString(), namespaceName)
            : resource["name"].asString();
        const std::string externalId = resource["external_id"].asString();

        std::string command;
        if (resolvedProvider == "docker" && resolvedType == "container") {
            const std::string target = !externalId.empty() ? externalId : name;
            command = "timeout 10s sh -lc \"docker logs --tail " + std::to_string(tailLines) + " " +
                      shellQuote(target) + " 2>&1\"";
        } else if (resolvedProvider == "kubernetes" && resolvedType == "pod" && !namespaceName.empty()) {
            command = "timeout 10s sh -lc \"kubectl logs -n " + shellQuote(namespaceName) + " " +
                      shellQuote(name) + " --tail=" + std::to_string(tailLines) + " --all-containers=true 2>&1\"";
        } else if (resolvedProvider == "kubernetes" && resolvedType == "deployment" && !namespaceName.empty()) {
            command = "timeout 10s sh -lc \"kubectl logs -n " + shellQuote(namespaceName) + " deployment/" +
                      shellQuote(name) + " --tail=" + std::to_string(tailLines) + " --all-containers=true 2>&1\"";
        }

        if (command.empty()) {
            Json::Value payload;
            payload["error"] = "Logs are supported for Docker containers and Kubernetes pods/deployments";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp);
            return;
        }

        Json::Value payload;
        payload["resource"] = resource;
        payload["mode"] = "claimed_resource_logs";
        payload["tail_lines"] = tailLines;
        payload["logs"] = runCommandForTarget(target, command, 15);
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k200OK);
        callback(resp);
    } catch (const std::exception& e) {
        Json::Value payload;
        payload["error"] = "Failed to read infrastructure resource logs";
        payload["details"] = e.what();
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void HealthController::restartInfrastructureResource(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        Json::Value payload;
        payload["error"] = "Unauthorized";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp);
        return;
    }

    const auto body = req->getJsonObject();
    if (!body) {
        Json::Value payload;
        payload["error"] = "Invalid JSON body";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k400BadRequest);
        callback(resp);
        return;
    }

    if (!body->isMember("confirm") || !(*body)["confirm"].asBool()) {
        Json::Value payload;
        payload["error"] = "Restart requires confirm=true";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k400BadRequest);
        callback(resp);
        return;
    }

    try {
        drogon::HttpStatusCode actionStatus = drogon::k200OK;
        std::string actionError;
        const Json::Value resource = claimedResourceForAction(userId, *body, "restart", actionStatus, actionError);
        if (resource.isNull()) {
            Json::Value payload;
            payload["error"] = actionError;
            auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
            resp->setStatusCode(actionStatus);
            callback(resp);
            return;
        }
        const InfrastructureTarget target = targetForClaimedResource(userId, resource, actionStatus, actionError);
        if (!actionError.empty()) {
            Json::Value payload;
            payload["error"] = actionError;
            auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
            resp->setStatusCode(actionStatus);
            callback(resp);
            return;
        }

        const std::string resolvedProvider = resource["provider_type"].asString();
        const std::string resolvedType = resource["resource_type"].asString();
        const std::string namespaceName = resource["namespace"].asString();
        const std::string name = resolvedProvider == "kubernetes"
            ? kubernetesObjectName(resource["name"].asString(), namespaceName)
            : resource["name"].asString();
        const std::string externalId = resource["external_id"].asString();

        std::string command;
        std::string action;
        if (resolvedProvider == "docker" && resolvedType == "container") {
            const std::string target = !externalId.empty() ? externalId : name;
            command = "timeout 20s sh -lc \"docker restart " + shellQuote(target) + " 2>&1\"";
            action = "docker_restart";
        } else if (resolvedProvider == "kubernetes" && resolvedType == "deployment" && !namespaceName.empty()) {
            command = "timeout 20s sh -lc \"kubectl rollout restart deployment/" + shellQuote(name) +
                      " -n " + shellQuote(namespaceName) + " 2>&1\"";
            action = "kubernetes_rollout_restart";
        }

        if (command.empty()) {
            Json::Value payload;
            payload["error"] = "Restart is supported for Docker containers and Kubernetes deployments";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp);
            return;
        }

        Json::Value payload;
        payload["resource"] = resource;
        payload["action"] = action;
        payload["output"] = runCommandForTarget(target, command, 25);
        payload["status"] = "requested";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k200OK);
        callback(resp);
    } catch (const std::exception& e) {
        Json::Value payload;
        payload["error"] = "Failed to restart infrastructure resource";
        payload["details"] = e.what();
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void HealthController::dockerStateInfrastructureResource(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        Json::Value payload;
        payload["error"] = "Unauthorized";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp);
        return;
    }

    const auto body = req->getJsonObject();
    if (!body) {
        Json::Value payload;
        payload["error"] = "Invalid JSON body";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k400BadRequest);
        callback(resp);
        return;
    }

    if (!body->isMember("confirm") || !(*body)["confirm"].asBool()) {
        Json::Value payload;
        payload["error"] = "Docker state changes require confirm=true";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k400BadRequest);
        callback(resp);
        return;
    }

    const std::string requestedAction = jsonBodyString(*body, "action");
    if (requestedAction != "start" && requestedAction != "stop") {
        Json::Value payload;
        payload["error"] = "Docker action must be start or stop";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k400BadRequest);
        callback(resp);
        return;
    }

    try {
        drogon::HttpStatusCode actionStatus = drogon::k200OK;
        std::string actionError;
        const Json::Value resource = claimedResourceForAction(userId, *body, requestedAction, actionStatus, actionError);
        if (resource.isNull()) {
            Json::Value payload;
            payload["error"] = actionError;
            auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
            resp->setStatusCode(actionStatus);
            callback(resp);
            return;
        }
        const InfrastructureTarget target = targetForClaimedResource(userId, resource, actionStatus, actionError);
        if (!actionError.empty()) {
            Json::Value payload;
            payload["error"] = actionError;
            auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
            resp->setStatusCode(actionStatus);
            callback(resp);
            return;
        }

        if (resource["provider_type"].asString() != "docker" || resource["resource_type"].asString() != "container") {
            Json::Value payload;
            payload["error"] = "Docker start/stop is supported only for claimed Docker containers";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp);
            return;
        }

        const std::string name = resource["name"].asString();
        const std::string externalId = resource["external_id"].asString();
        const std::string runtimeTarget = !externalId.empty() ? externalId : name;
        const std::string command = "timeout 20s sh -lc \"docker " + requestedAction + " " + shellQuote(runtimeTarget) + " 2>&1\"";

        Json::Value payload;
        payload["resource"] = resource;
        payload["action"] = "docker_" + requestedAction;
        payload["output"] = runCommandForTarget(target, command, 25);
        payload["status"] = "requested";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k200OK);
        callback(resp);
    } catch (const std::exception& e) {
        Json::Value payload;
        payload["error"] = "Failed to change Docker resource state";
        payload["details"] = e.what();
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void HealthController::scaleInfrastructureResource(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        Json::Value payload;
        payload["error"] = "Unauthorized";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp);
        return;
    }

    const auto body = req->getJsonObject();
    if (!body) {
        Json::Value payload;
        payload["error"] = "Invalid JSON body";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k400BadRequest);
        callback(resp);
        return;
    }

    if (!body->isMember("confirm") || !(*body)["confirm"].asBool()) {
        Json::Value payload;
        payload["error"] = "Scale requires confirm=true";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k400BadRequest);
        callback(resp);
        return;
    }

    if (!body->isMember("replicas") || !(*body)["replicas"].isInt()) {
        Json::Value payload;
        payload["error"] = "replicas must be an integer";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k400BadRequest);
        callback(resp);
        return;
    }

    const int replicas = std::clamp((*body)["replicas"].asInt(), 0, 50);

    try {
        drogon::HttpStatusCode actionStatus = drogon::k200OK;
        std::string actionError;
        const Json::Value resource = claimedResourceForAction(userId, *body, "scale", actionStatus, actionError);
        if (resource.isNull()) {
            Json::Value payload;
            payload["error"] = actionError;
            auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
            resp->setStatusCode(actionStatus);
            callback(resp);
            return;
        }
        const InfrastructureTarget target = targetForClaimedResource(userId, resource, actionStatus, actionError);
        if (!actionError.empty()) {
            Json::Value payload;
            payload["error"] = actionError;
            auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
            resp->setStatusCode(actionStatus);
            callback(resp);
            return;
        }

        if (resource["provider_type"].asString() != "kubernetes" || resource["resource_type"].asString() != "deployment") {
            Json::Value payload;
            payload["error"] = "Scale is supported only for claimed Kubernetes deployments";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp);
            return;
        }

        const std::string namespaceName = resource["namespace"].asString();
        const std::string name = kubernetesObjectName(resource["name"].asString(), namespaceName);
        if (namespaceName.empty() || name.empty()) {
            Json::Value payload;
            payload["error"] = "Kubernetes deployment namespace and name are required";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp);
            return;
        }

        const std::string command = "timeout 25s sh -lc \"kubectl scale deployment " + shellQuote(name) +
                                    " -n " + shellQuote(namespaceName) +
                                    " --replicas=" + std::to_string(replicas) + " 2>&1\"";

        Json::Value payload;
        payload["resource"] = resource;
        payload["action"] = "kubernetes_scale";
        payload["replicas"] = replicas;
        payload["output"] = runCommandForTarget(target, command, 30);
        payload["status"] = "requested";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k200OK);
        callback(resp);
    } catch (const std::exception& e) {
        Json::Value payload;
        payload["error"] = "Failed to scale infrastructure resource";
        payload["details"] = e.what();
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void HealthController::kubernetesControlInfrastructureResource(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        Json::Value payload;
        payload["error"] = "Unauthorized";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp);
        return;
    }

    const auto body = req->getJsonObject();
    if (!body) {
        Json::Value payload;
        payload["error"] = "Invalid JSON body";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k400BadRequest);
        callback(resp);
        return;
    }

    const std::string requestedAction = jsonBodyString(*body, "action");
    const bool dryRun = body->isMember("dry_run") && (*body)["dry_run"].isBool() && (*body)["dry_run"].asBool();
    const bool confirmedAction = requestedAction == "undo_rollout" ||
                                 requestedAction == "delete_pod" ||
                                 requestedAction == "pause_rollout" ||
                                 requestedAction == "resume_rollout" ||
                                 requestedAction == "set_image" ||
                                 requestedAction == "cordon_node" ||
                                 requestedAction == "uncordon_node" ||
                                 requestedAction == "drain_node";
    if (confirmedAction && !dryRun && (!body->isMember("confirm") || !(*body)["confirm"].asBool())) {
        Json::Value payload;
        payload["error"] = "This Kubernetes control action requires confirm=true";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k400BadRequest);
        callback(resp);
        return;
    }

    try {
        drogon::HttpStatusCode actionStatus = drogon::k200OK;
        std::string actionError;
        const Json::Value resource = claimedResourceForAction(userId, *body, "control", actionStatus, actionError);
        if (resource.isNull()) {
            Json::Value payload;
            payload["error"] = actionError;
            auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
            resp->setStatusCode(actionStatus);
            callback(resp);
            return;
        }
        const InfrastructureTarget target = targetForClaimedResource(userId, resource, actionStatus, actionError);
        if (!actionError.empty()) {
            Json::Value payload;
            payload["error"] = actionError;
            auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
            resp->setStatusCode(actionStatus);
            callback(resp);
            return;
        }

        if (resource["provider_type"].asString() != "kubernetes") {
            Json::Value payload;
            payload["error"] = "Kubernetes controls require a claimed Kubernetes resource";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp);
            return;
        }

        const std::string resourceType = resource["resource_type"].asString();
        const std::string namespaceName = resource["namespace"].asString();
        const std::string name = kubernetesObjectName(resource["name"].asString(), namespaceName);
        const bool isNodeResource = resourceType == "node";
        if (name.empty() || (!isNodeResource && namespaceName.empty())) {
            Json::Value payload;
            payload["error"] = "Kubernetes control requires a named resource";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp);
            return;
        }

        std::string command;
        std::string previewOutput;
        std::string responseStatus = "completed";
        if (resourceType == "deployment" && requestedAction == "rollout_status") {
            command = "timeout 25s sh -lc \"kubectl rollout status deployment/" + shellQuote(name) +
                      " -n " + shellQuote(namespaceName) + " 2>&1\"";
        } else if (resourceType == "deployment" && requestedAction == "rollout_history") {
            command = "timeout 20s sh -lc \"kubectl rollout history deployment/" + shellQuote(name) +
                      " -n " + shellQuote(namespaceName) + " 2>&1\"";
        } else if (resourceType == "deployment" && requestedAction == "undo_rollout") {
            if (dryRun) {
                previewOutput = "Dry run only. StackPilot would run: kubectl rollout undo deployment/" + name +
                                " -n " + namespaceName;
                responseStatus = "dry_run";
            } else {
                command = "timeout 30s sh -lc \"kubectl rollout undo deployment/" + shellQuote(name) +
                          " -n " + shellQuote(namespaceName) + " 2>&1\"";
                responseStatus = "requested";
            }
        } else if (resourceType == "deployment" && requestedAction == "pause_rollout") {
            if (dryRun) {
                previewOutput = "Dry run only. StackPilot would run: kubectl rollout pause deployment/" + name +
                                " -n " + namespaceName;
                responseStatus = "dry_run";
            } else {
                command = "timeout 20s sh -lc \"kubectl rollout pause deployment/" + shellQuote(name) +
                          " -n " + shellQuote(namespaceName) + " 2>&1\"";
                responseStatus = "requested";
            }
        } else if (resourceType == "deployment" && requestedAction == "resume_rollout") {
            if (dryRun) {
                previewOutput = "Dry run only. StackPilot would run: kubectl rollout resume deployment/" + name +
                                " -n " + namespaceName;
                responseStatus = "dry_run";
            } else {
                command = "timeout 20s sh -lc \"kubectl rollout resume deployment/" + shellQuote(name) +
                          " -n " + shellQuote(namespaceName) + " 2>&1\"";
                responseStatus = "requested";
            }
        } else if (resourceType == "deployment" && requestedAction == "set_image") {
            const std::string newImage = jsonBodyString(*body, "new_image");
            if (newImage.empty()) {
                Json::Value payload;
                payload["error"] = "new_image is required for set_image";
                auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
                resp->setStatusCode(drogon::k400BadRequest);
                callback(resp);
                return;
            }
            command = "timeout 30s sh -lc \"kubectl set image deployment/" + shellQuote(name) +
                      " " + shellQuote("*=" + newImage) +
                      " -n " + shellQuote(namespaceName) +
                      (dryRun ? " --dry-run=server -o yaml" : "") +
                      " 2>&1\"";
            responseStatus = dryRun ? "dry_run" : "requested";
        } else if (resourceType == "pod" && requestedAction == "delete_pod") {
            if (dryRun) {
                const std::string currentYaml = runCommandForTarget(
                    target,
                    "timeout 20s sh -lc \"kubectl get pod " + shellQuote(name) +
                    " -n " + shellQuote(namespaceName) + " -o yaml 2>&1\"",
                    25
                );
                previewOutput = "Dry run only. StackPilot would run: kubectl delete pod " + name +
                                " -n " + namespaceName + " --wait=false\n\nCurrent object:\n" + currentYaml;
                responseStatus = "dry_run";
            } else {
                command = "timeout 20s sh -lc \"kubectl delete pod " + shellQuote(name) +
                          " -n " + shellQuote(namespaceName) + " --wait=false 2>&1\"";
                responseStatus = "requested";
            }
        } else if (resourceType == "node" && requestedAction == "node_describe") {
            command = "timeout 25s sh -lc \"kubectl describe node " + shellQuote(name) + " 2>&1\"";
        } else if (resourceType == "node" && requestedAction == "cordon_node") {
            if (dryRun) {
                previewOutput = "Dry run only. StackPilot would run: kubectl cordon " + name;
                responseStatus = "dry_run";
            } else {
                command = "timeout 20s sh -lc \"kubectl cordon " + shellQuote(name) + " 2>&1\"";
                responseStatus = "requested";
            }
        } else if (resourceType == "node" && requestedAction == "uncordon_node") {
            if (dryRun) {
                previewOutput = "Dry run only. StackPilot would run: kubectl uncordon " + name;
                responseStatus = "dry_run";
            } else {
                command = "timeout 20s sh -lc \"kubectl uncordon " + shellQuote(name) + " 2>&1\"";
                responseStatus = "requested";
            }
        } else if (resourceType == "node" && requestedAction == "drain_node") {
            if (dryRun) {
                previewOutput = "Dry run only. StackPilot would run: kubectl drain " + name +
                                " --ignore-daemonsets --delete-emptydir-data --force --timeout=60s";
                responseStatus = "dry_run";
            } else {
                command = "timeout 75s sh -lc \"kubectl drain " + shellQuote(name) +
                          " --ignore-daemonsets --delete-emptydir-data --force --timeout=60s 2>&1\"";
                responseStatus = "requested";
            }
        }

        if (command.empty() && previewOutput.empty()) {
            Json::Value payload;
            payload["error"] = "Unsupported Kubernetes control action for this resource";
            payload["supported_actions"].append("deployment: rollout_status");
            payload["supported_actions"].append("deployment: rollout_history");
            payload["supported_actions"].append("deployment: undo_rollout");
            payload["supported_actions"].append("deployment: pause_rollout");
            payload["supported_actions"].append("deployment: resume_rollout");
            payload["supported_actions"].append("deployment: set_image");
            payload["supported_actions"].append("pod: delete_pod");
            payload["supported_actions"].append("node: node_describe");
            payload["supported_actions"].append("node: cordon_node");
            payload["supported_actions"].append("node: uncordon_node");
            payload["supported_actions"].append("node: drain_node");
            auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp);
            return;
        }

        Json::Value payload;
        payload["resource"] = resource;
        payload["action"] = requestedAction;
        payload["dry_run"] = dryRun;
        payload["output"] = !previewOutput.empty() ? previewOutput : runCommandForTarget(target, command, 90);
        payload["status"] = responseStatus;
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k200OK);
        callback(resp);
    } catch (const std::exception& e) {
        Json::Value payload;
        payload["error"] = "Failed to run Kubernetes control action";
        payload["details"] = e.what();
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void HealthController::kubernetesResourceYaml(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        Json::Value payload;
        payload["error"] = "Unauthorized";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp);
        return;
    }

    const auto body = req->getJsonObject();
    if (!body) {
        Json::Value payload;
        payload["error"] = "Invalid JSON body";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k400BadRequest);
        callback(resp);
        return;
    }

    const std::string resourceType = jsonBodyString(*body, "resource_type");
    const std::string namespaceName = jsonBodyString(*body, "namespace");
    const std::string name = kubernetesObjectName(jsonBodyString(*body, "name"), namespaceName);
    drogon::HttpStatusCode targetStatus = drogon::k200OK;
    std::string targetError;
    const InfrastructureTarget target = resolveInfrastructureTarget(
        userId,
        targetConnectionIdFromBody(*body),
        targetStatus,
        targetError
    );
    if (!targetError.empty()) {
        Json::Value payload;
        payload["error"] = targetError;
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(targetStatus);
        callback(resp);
        return;
    }

    if (name.empty()) {
        Json::Value payload;
        payload["error"] = "Kubernetes resource name is required";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k400BadRequest);
        callback(resp);
        return;
    }

    const bool isNamespaced = resourceType == "pod" || resourceType == "deployment" || resourceType == "service";
    if (isNamespaced && namespaceName.empty()) {
        Json::Value payload;
        payload["error"] = "Namespace is required for this Kubernetes resource";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k400BadRequest);
        callback(resp);
        return;
    }

    std::string command;
    if (resourceType == "namespace") {
        command = "timeout 10s sh -lc \"kubectl get namespace " + shellQuote(name) + " -o yaml 2>/dev/null\"";
    } else if (resourceType == "node") {
        command = "timeout 10s sh -lc \"kubectl get node " + shellQuote(name) + " -o yaml 2>/dev/null\"";
    } else if (resourceType == "pod" || resourceType == "deployment" || resourceType == "service") {
        command = "timeout 10s sh -lc \"kubectl get " + resourceType + " -n " + shellQuote(namespaceName) +
                  " " + shellQuote(name) + " -o yaml 2>/dev/null\"";
    } else {
        Json::Value payload;
        payload["error"] = "YAML is supported for namespaces, nodes, pods, deployments, and services";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k400BadRequest);
        callback(resp);
        return;
    }

    try {
        const std::string yaml = runCommandForTarget(target, command, 15);
        if (trimCopy(yaml).empty()) {
            Json::Value payload;
            payload["error"] = "Resource YAML not found or kubectl unavailable";
            payload["resource_type"] = resourceType;
            payload["namespace"] = namespaceName;
            payload["name"] = name;
            auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp);
            return;
        }

        Json::Value payload;
        payload["mode"] = "read_only_yaml";
        payload["resource_type"] = resourceType;
        payload["namespace"] = namespaceName;
        payload["name"] = name;
        payload["target"] = targetToJson(target);
        payload["yaml"] = yaml;
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k200OK);
        callback(resp);
    } catch (const std::exception& e) {
        Json::Value payload;
        payload["error"] = "Failed to read Kubernetes resource YAML";
        payload["details"] = e.what();
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void HealthController::applyKubernetesResourceYaml(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        Json::Value payload;
        payload["error"] = "Unauthorized";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp);
        return;
    }

    const auto body = req->getJsonObject();
    if (!body) {
        Json::Value payload;
        payload["error"] = "Invalid JSON body";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k400BadRequest);
        callback(resp);
        return;
    }

    const std::string yaml = body->isMember("yaml") && (*body)["yaml"].isString()
        ? (*body)["yaml"].asString()
        : "";
    const bool dryRun = body->isMember("dry_run") && (*body)["dry_run"].isBool() && (*body)["dry_run"].asBool();
    const bool restart = body->isMember("restart") && (*body)["restart"].isBool() && (*body)["restart"].asBool();
    if (trimCopy(yaml).empty()) {
        Json::Value payload;
        payload["error"] = "yaml is required";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k400BadRequest);
        callback(resp);
        return;
    }
    if (yaml.size() > 512 * 1024) {
        Json::Value payload;
        payload["error"] = "YAML payload is too large";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k413RequestEntityTooLarge);
        callback(resp);
        return;
    }
    if (!dryRun && (!body->isMember("confirm") || !(*body)["confirm"].isBool() || !(*body)["confirm"].asBool())) {
        Json::Value payload;
        payload["error"] = "Applying YAML requires confirm=true";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k400BadRequest);
        callback(resp);
        return;
    }

    try {
        drogon::HttpStatusCode actionStatus = drogon::k200OK;
        std::string actionError;
        const Json::Value resource = claimedResourceForAction(userId, *body, "apply YAML to", actionStatus, actionError);
        if (resource.isNull()) {
            Json::Value payload;
            payload["error"] = actionError;
            auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
            resp->setStatusCode(actionStatus);
            callback(resp);
            return;
        }
        if (resource["provider_type"].asString() != "kubernetes") {
            Json::Value payload;
            payload["error"] = "YAML apply requires a claimed Kubernetes resource";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp);
            return;
        }
        const InfrastructureTarget target = targetForClaimedResource(userId, resource, actionStatus, actionError);
        if (!actionError.empty()) {
            Json::Value payload;
            payload["error"] = actionError;
            auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
            resp->setStatusCode(actionStatus);
            callback(resp);
            return;
        }

        const std::string resourceType = resource["resource_type"].asString();
        if (resourceType != "namespace" && resourceType != "node" && resourceType != "pod" &&
            resourceType != "deployment" && resourceType != "service") {
            Json::Value payload;
            payload["error"] = "YAML apply is supported for namespaces, nodes, pods, deployments, and services";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp);
            return;
        }

        const auto now = std::chrono::system_clock::now().time_since_epoch().count();
        const std::filesystem::path yamlPath =
            std::filesystem::temp_directory_path() /
            ("stackpilot-apply-" + std::to_string(now) + "-" + std::to_string(std::hash<std::string>{}(userId + yaml)) + ".yaml");
        {
            std::ofstream out(yamlPath, std::ios::binary);
            if (!out) {
                throw std::runtime_error("Failed to create temporary YAML file");
            }
            out << yaml;
        }

        std::string yamlPathForKubectl = yamlPath.string();
        std::string remoteYamlPath;
        if (target.remote) {
            remoteYamlPath = "/tmp/" + yamlPath.filename().string();
            SshService ssh;
            const auto upload = ssh.uploadFile(target.ssh, yamlPath.string(), remoteYamlPath, 35);
            if (!upload.success) {
                std::error_code ignored;
                std::filesystem::remove(yamlPath, ignored);
                throw std::runtime_error(upload.error.empty() ? "Failed to upload YAML to remote target" : upload.error);
            }
            yamlPathForKubectl = remoteYamlPath;
        }

        const std::string applyCommand = "timeout 35s sh -lc \"kubectl apply " +
            std::string(dryRun ? "--dry-run=server -o yaml " : "") +
            "-f " + shellQuote(yamlPathForKubectl) + " 2>&1\"";
        const std::string applyOutput = runCommandForTarget(target, applyCommand, 45);

        std::string restartOutput;
        if (!dryRun && restart && resourceType == "deployment") {
            const std::string namespaceName = resource["namespace"].asString();
            const std::string name = kubernetesObjectName(resource["name"].asString(), namespaceName);
            if (!namespaceName.empty() && !name.empty()) {
                const std::string restartCommand =
                    "timeout 30s sh -lc \"kubectl rollout restart deployment/" + shellQuote(name) +
                    " -n " + shellQuote(namespaceName) + " 2>&1\"";
                restartOutput = runCommandForTarget(target, restartCommand, 40);
            }
        }
        std::error_code ignored;
        if (!remoteYamlPath.empty()) {
            runCommandForTarget(target, "timeout 8s sh -lc \"rm -f " + shellQuote(remoteYamlPath) + "\"", 10);
        }
        std::filesystem::remove(yamlPath, ignored);

        Json::Value payload;
        payload["resource"] = resource;
        payload["action"] = "apply_yaml";
        payload["dry_run"] = dryRun;
        payload["restart_requested"] = restart && resourceType == "deployment";
        payload["output"] = applyOutput;
        payload["restart_output"] = restartOutput;
        payload["status"] = dryRun ? "dry_run" : "requested";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k200OK);
        callback(resp);
    } catch (const std::exception& e) {
        Json::Value payload;
        payload["error"] = "Failed to apply Kubernetes YAML";
        payload["details"] = e.what();
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

std::string HealthController::extractUserId(const drogon::HttpRequestPtr& req) {
    Json::Value payload = JwtHelper::verifyRequestToken(req);
    if (payload.isNull() || !payload.isMember("user_id")) {
        return "";
    }
    return payload["user_id"].asString();
}

} // namespace stackpilot
