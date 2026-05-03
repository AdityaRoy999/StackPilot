// ============================================================
// HealthController.cpp - lightweight readiness endpoints
// ============================================================

#include "HealthController.h"
#include "../db/Database.h"
#include "../utils/JwtHelper.h"

#include <json/json.h>
#include <pqxx/pqxx>
#include <spdlog/spdlog.h>
#include <trantor/utils/Date.h>

#include <algorithm>
#include <cstdlib>
#include <map>
#include <sstream>
#include <string>

namespace aids {

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

bool metricsRequestAuthorized(const drogon::HttpRequestPtr& req) {
    const char* expected = std::getenv("AIDS_METRICS_BEARER_TOKEN");
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
    payload["service"] = "aids-backend";
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
    body << "# HELP aids_database_connected Database connection health, 1 means connected.\n";
    body << "# TYPE aids_database_connected gauge\n";
    addMetricLine(body, "aids_database_connected", {}, Database::getInstance().isConnected() ? 1 : 0);

    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);

        body << "# HELP aids_projects_total Projects grouped by status.\n";
        body << "# TYPE aids_projects_total gauge\n";
        for (const auto& row : txn.exec("SELECT COALESCE(status, 'unknown'), COUNT(*) FROM projects GROUP BY 1")) {
            addMetricLine(body, "aids_projects_total", {{"status", row[0].as<std::string>()}}, row[1].as<long long>());
        }

        body << "# HELP aids_deployments_total Deployments grouped by status.\n";
        body << "# TYPE aids_deployments_total gauge\n";
        for (const auto& row : txn.exec("SELECT COALESCE(status, 'unknown'), COUNT(*) FROM deployments GROUP BY 1")) {
            addMetricLine(body, "aids_deployments_total", {{"status", row[0].as<std::string>()}}, row[1].as<long long>());
        }

        body << "# HELP aids_deployments_by_runtime_total Deployments grouped by runtime provider.\n";
        body << "# TYPE aids_deployments_by_runtime_total gauge\n";
        for (const auto& row : txn.exec(
                 "SELECT COALESCE(NULLIF(runtime_provider, ''), 'docker'), COUNT(*) "
                 "FROM deployments GROUP BY 1")) {
            addMetricLine(body, "aids_deployments_by_runtime_total",
                          {{"runtime_provider", row[0].as<std::string>()}},
                          row[1].as<long long>());
        }

        body << "# HELP aids_running_runtimes_total Deployments currently running.\n";
        body << "# TYPE aids_running_runtimes_total gauge\n";
        addMetricLine(body, "aids_running_runtimes_total", {},
                      firstCount(txn, "SELECT COUNT(*) FROM deployments WHERE status = 'running'"));

        body << "# HELP aids_deployment_jobs_total Deployment jobs grouped by status.\n";
        body << "# TYPE aids_deployment_jobs_total gauge\n";
        for (const auto& row : txn.exec("SELECT COALESCE(status, 'unknown'), COUNT(*) FROM deployment_jobs GROUP BY 1")) {
            addMetricLine(body, "aids_deployment_jobs_total", {{"status", row[0].as<std::string>()}}, row[1].as<long long>());
        }

        body << "# HELP aids_deployment_failures_last_24h Failed deployments created in the last 24 hours.\n";
        body << "# TYPE aids_deployment_failures_last_24h gauge\n";
        addMetricLine(body, "aids_deployment_failures_last_24h", {},
                      firstCount(txn,
                                 "SELECT COUNT(*) FROM deployments "
                                 "WHERE status = 'failed' AND created_at > NOW() - INTERVAL '24 hours'"));

        txn.commit();
    } catch (const std::exception& e) {
        body << "# HELP aids_metrics_collection_error Metrics collection error, 1 means failed.\n";
        body << "# TYPE aids_metrics_collection_error gauge\n";
        addMetricLine(body, "aids_metrics_collection_error", {{"message", e.what()}}, 1);
    }

    auto resp = drogon::HttpResponse::newHttpResponse();
    resp->setStatusCode(drogon::k200OK);
    resp->addHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    resp->setBody(body.str());
    callback(resp);
}

void HealthController::observabilitySummary(
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
    payload["service"] = "aids-backend";
    payload["phase"] = "Observability System";
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
        spdlog::warn("Observability summary degraded: {}", e.what());
    }

    auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
    resp->setStatusCode(drogon::k200OK);
    callback(resp);
}

std::string HealthController::extractUserId(const drogon::HttpRequestPtr& req) {
    Json::Value payload = JwtHelper::verifyRequestToken(req);
    if (payload.isNull() || !payload.isMember("user_id")) {
        return "";
    }
    return payload["user_id"].asString();
}

} // namespace aids
