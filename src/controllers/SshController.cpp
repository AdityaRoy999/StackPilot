// ============================================================
// SshController.cpp - Saved SSH/VPS connection management API
// ============================================================

#include "SshController.h"
#include <cctype>
#include <algorithm>
#include "../utils/StringUtils.h"
#include "../db/Database.h"
#include "../services/SshService.h"
#include "../utils/JwtHelper.h"
#include "../utils/TokenCrypto.h"

#include <pqxx/pqxx>
#include <spdlog/spdlog.h>
#include <sstream>

namespace stackpilot {

namespace {

Json::Value toConnectionJson(const pqxx::row& row) {
    Json::Value connection;
    connection["id"] = row["id"].as<std::string>();
    connection["name"] = row["name"].as<std::string>();
    connection["connection_type"] = row["connection_type"].is_null() ? "ssh" : row["connection_type"].as<std::string>();
    connection["host"] = row["host"].as<std::string>();
    connection["port"] = row["port"].as<int>();
    connection["username"] = row["username"].as<std::string>();
    connection["auth_type"] = row["auth_type"].as<std::string>();
    connection["last_tested_at"] = row["last_tested_at"].is_null() ? "" : row["last_tested_at"].as<std::string>();
    connection["created_at"] = row["created_at"].as<std::string>();
    connection["updated_at"] = row["updated_at"].as<std::string>();
    return connection;
}

Json::Value makeErrorPayload(const std::string& message) {
    Json::Value err;
    err["error"] = message;
    return err;
}

std::string trimCopy(const std::string& value) {
    const auto first = value.find_first_not_of(" \t\r\n");
    if (first == std::string::npos) return "";
    const auto last = value.find_last_not_of(" \t\r\n");
    return value.substr(first, last - first + 1);
}

std::string jsonString(const Json::Value& body, const std::string& key, const std::string& fallback = "") {
    if (!body.isMember(key) || !body[key].isString()) {
        return fallback;
    }
    return trimCopy(body[key].asString());
}

std::string outputValue(const std::string& output, const std::string& key) {
    std::istringstream stream(output);
    std::string line;
    const std::string prefix = key + "=";
    while (std::getline(stream, line)) {
        line = trimCopy(line);
        if (line.rfind(prefix, 0) == 0) {
            return line.substr(prefix.size());
        }
    }
    return "";
}

/// Pulls the kubeconfig out from between its markers.
std::string extractBlock(const std::string& output,
                         const std::string& beginMarker,
                         const std::string& endMarker) {
    const size_t begin = output.find(beginMarker);
    if (begin == std::string::npos) return "";
    const size_t start = output.find('\n', begin);
    if (start == std::string::npos) return "";
    const size_t end = output.find(endMarker, start);
    if (end == std::string::npos) return "";
    return strings::trim(output.substr(start + 1, end - start - 1));
}

std::string redactClusterToken(std::string output) {
    const std::string key = "STACKPILOT_cluster_token=";
    size_t pos = 0;
    while ((pos = output.find(key, pos)) != std::string::npos) {
        const size_t valueStart = pos + key.size();
        size_t valueEnd = output.find('\n', valueStart);
        if (valueEnd == std::string::npos) {
            valueEnd = output.size();
        }
        output.replace(valueStart, valueEnd - valueStart, "[redacted]");
        pos = valueStart + 10;
    }

    // The kubeconfig block is a full cluster-admin credential. It is stored
    // encrypted, and must not survive in last_status or the response body that
    // the browser renders.
    const std::string begin = "__STACKPILOT_K3S_KUBECONFIG_BEGIN__";
    const std::string end = "__STACKPILOT_K3S_KUBECONFIG_END__";
    const size_t from = output.find(begin);
    const size_t to = output.find(end);
    if (from != std::string::npos && to != std::string::npos && to > from) {
        output.replace(from, to + end.size() - from, "[kubeconfig captured and stored encrypted]");
    }
    return output;
}

std::string toLowerAscii(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return value;
}

std::string safeClusterName(const std::string& requested, const std::string& fallback) {
    std::string value = trimCopy(requested.empty() ? fallback : requested);
    if (value.empty()) {
        value = "default-cluster";
    }
    if (value.size() > 120) {
        value = value.substr(0, 120);
    }
    return value;
}

SshConnectionConfig rowToConfig(const pqxx::row& row) {
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
    config.knownHostsEntry = row["known_hosts_entry"].as<std::string>();
    return config;
}

} // namespace

std::string SshController::extractUserId(const drogon::HttpRequestPtr& req) const {
    auto payload = JwtHelper::verifyRequestToken(req);
    if (payload.isNull()) {
        return "";
    }
    return payload["user_id"].asString();
}

void SshController::listConnections(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Unauthorized"));
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp);
        return;
    }

    try {
        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);
        auto rows = txn.exec_params(
            "SELECT id, name, COALESCE(connection_type, 'ssh') AS connection_type, host, port, username, auth_type, last_tested_at, created_at, updated_at, host_capabilities::text, last_probed_at, last_probe_error "
            "FROM ssh_connections WHERE user_id = $1 ORDER BY created_at DESC",
            userId
        );
        txn.commit();

        Json::Value connections(Json::arrayValue);
        for (const auto& row : rows) {
            auto connection = toConnectionJson(row);
            connection["host_capabilities"] = strings::parseJsonObject(row["host_capabilities"].as<std::string>());
            connection["last_probed_at"] = row["last_probed_at"].is_null()?"":row["last_probed_at"].as<std::string>();
            connection["last_probe_error"] = row["last_probe_error"].as<std::string>();
            connections.append(connection);
        }

        Json::Value payload;
        payload["connections"] = connections;
        payload["count"] = static_cast<int>(connections.size());
        callback(drogon::HttpResponse::newHttpJsonResponse(payload));
    } catch (const std::exception& e) {
        spdlog::error("List SSH connections error: {}", e.what());
        auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Internal server error"));
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void SshController::listKubernetesClusters(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Unauthorized"));
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp);
        return;
    }

    try {
        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);
        auto clusterRows = txn.exec_params(
            "SELECT kc.id, kc.name, kc.provider, kc.control_plane_connection_id, kc.server_url, kc.status, "
            "kc.last_status, kc.created_at, kc.updated_at, sc.name AS control_plane_name, sc.host AS control_plane_host "
            "FROM kubernetes_clusters kc "
            "LEFT JOIN ssh_connections sc ON kc.control_plane_connection_id = sc.id "
            "WHERE kc.user_id = $1 "
            "ORDER BY kc.updated_at DESC",
            userId
        );

        Json::Value clusters(Json::arrayValue);
        for (const auto& row : clusterRows) {
            const std::string clusterId = row["id"].as<std::string>();
            Json::Value cluster;
            cluster["id"] = clusterId;
            cluster["name"] = row["name"].as<std::string>();
            cluster["provider"] = row["provider"].as<std::string>();
            cluster["control_plane_connection_id"] = row["control_plane_connection_id"].is_null()
                ? ""
                : row["control_plane_connection_id"].as<std::string>();
            cluster["control_plane_name"] = row["control_plane_name"].is_null()
                ? ""
                : row["control_plane_name"].as<std::string>();
            cluster["control_plane_host"] = row["control_plane_host"].is_null()
                ? ""
                : row["control_plane_host"].as<std::string>();
            cluster["server_url"] = row["server_url"].as<std::string>();
            cluster["status"] = row["status"].as<std::string>();
            cluster["last_status"] = row["last_status"].as<std::string>();
            cluster["created_at"] = row["created_at"].as<std::string>();
            cluster["updated_at"] = row["updated_at"].as<std::string>();

            auto nodeRows = txn.exec_params(
                "SELECT n.id, n.connection_id, n.role, n.status, n.last_status, n.joined_at, n.created_at, n.updated_at, "
                "sc.name AS connection_name, sc.host, sc.username "
                "FROM kubernetes_cluster_nodes n "
                "LEFT JOIN ssh_connections sc ON n.connection_id = sc.id "
                "WHERE n.cluster_id = $1 "
                "ORDER BY CASE WHEN n.role = 'server' THEN 0 ELSE 1 END, n.created_at ASC",
                clusterId
            );

            Json::Value nodes(Json::arrayValue);
            for (const auto& nodeRow : nodeRows) {
                Json::Value node;
                node["id"] = nodeRow["id"].as<std::string>();
                node["connection_id"] = nodeRow["connection_id"].as<std::string>();
                node["connection_name"] = nodeRow["connection_name"].is_null()
                    ? ""
                    : nodeRow["connection_name"].as<std::string>();
                node["host"] = nodeRow["host"].is_null() ? "" : nodeRow["host"].as<std::string>();
                node["username"] = nodeRow["username"].is_null() ? "" : nodeRow["username"].as<std::string>();
                node["role"] = nodeRow["role"].as<std::string>();
                node["status"] = nodeRow["status"].as<std::string>();
                node["last_status"] = nodeRow["last_status"].as<std::string>();
                node["joined_at"] = nodeRow["joined_at"].is_null() ? "" : nodeRow["joined_at"].as<std::string>();
                node["created_at"] = nodeRow["created_at"].as<std::string>();
                node["updated_at"] = nodeRow["updated_at"].as<std::string>();
                nodes.append(node);
            }
            cluster["nodes"] = nodes;
            clusters.append(cluster);
        }
        txn.commit();

        Json::Value payload;
        payload["clusters"] = clusters;
        payload["count"] = static_cast<int>(clusters.size());
        callback(drogon::HttpResponse::newHttpJsonResponse(payload));
    } catch (const std::exception& e) {
        spdlog::error("List Kubernetes clusters error: {}", e.what());
        auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Internal server error"));
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void SshController::createConnection(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Unauthorized"));
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp);
        return;
    }

    auto body = req->getJsonObject();
    if (!body) {
        auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Invalid JSON body"));
        resp->setStatusCode(drogon::k400BadRequest);
        callback(resp);
        return;
    }

    const std::string name = (*body).isMember("name") ? (*body)["name"].asString() : "";
    const std::string host = (*body).isMember("host") ? (*body)["host"].asString() : "";
    const int port = (*body).isMember("port") ? (*body)["port"].asInt() : 22;
    const std::string username = (*body).isMember("username") ? (*body)["username"].asString() : "";
    const std::string connectionType = (*body).isMember("connection_type") ? (*body)["connection_type"].asString() : "ssh";
    const bool meshSsh = connectionType == "tailscale" || connectionType == "headscale";
    const std::string authType = meshSsh
        ? connectionType
        : ((*body).isMember("auth_type") ? (*body)["auth_type"].asString() : "");
    const std::string password = (*body).isMember("password") ? (*body)["password"].asString() : "";
    const std::string privateKey = (*body).isMember("private_key") ? (*body)["private_key"].asString() : "";

    if (name.empty()) {
        auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Connection name is required"));
        resp->setStatusCode(drogon::k400BadRequest);
        callback(resp);
        return;
    }

    try {
        SshService sshService;
        SshOperationResult fingerprintResult;
        if (!meshSsh) {
            fingerprintResult = sshService.fetchKnownHostsEntry(host, port);
        }
        if (!meshSsh && !fingerprintResult.success) {
            auto resp = drogon::HttpResponse::newHttpJsonResponse(
                makeErrorPayload(fingerprintResult.error.empty() ? "Unable to fetch SSH host fingerprint" : fingerprintResult.error)
            );
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp);
            return;
        }

        SshConnectionConfig config;
        config.connectionType = connectionType;
        config.host = host;
        config.port = port;
        config.username = username;
        config.authType = authType;
        config.password = password;
        config.privateKey = privateKey;
        config.knownHostsEntry = fingerprintResult.output;

        std::string validationError;
        if (!sshService.isValidConnectionConfig(config, validationError)) {
            auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload(validationError));
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp);
            return;
        }

        auto testResult = sshService.testConnection(config);
        if (!testResult.success) {
            Json::Value payload = makeErrorPayload(testResult.error.empty() ? "SSH connection test failed" : testResult.error);
            if (!testResult.output.empty()) {
                payload["details"] = testResult.output;
            }
            auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp);
            return;
        }

        const std::string encryptedPassword = meshSsh || password.empty() ? "" : TokenCrypto::encrypt(password);
        const std::string encryptedPrivateKey = meshSsh || privateKey.empty() ? "" : TokenCrypto::encrypt(privateKey);

        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);
        auto rows = txn.exec_params(
            "INSERT INTO ssh_connections (user_id, name, connection_type, host, port, username, auth_type, password_encrypted, private_key_encrypted, known_hosts_entry) "
            "VALUES ($1, $2, $3, $4, $5, $6, $7, NULLIF($8, ''), NULLIF($9, ''), $10) "
            "RETURNING id, name, connection_type, host, port, username, auth_type, last_tested_at, created_at, updated_at",
            userId,
            name,
            connectionType,
            host,
            port,
            username,
            authType,
            encryptedPassword,
            encryptedPrivateKey,
            fingerprintResult.output
        );
        txn.commit();

        Json::Value payload;
        payload["message"] = "SSH connection saved";
        payload["connection"] = toConnectionJson(rows[0]);
        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(drogon::k201Created);
        callback(resp);
    } catch (const pqxx::unique_violation&) {
        auto resp = drogon::HttpResponse::newHttpJsonResponse(
            makeErrorPayload("You already have an SSH connection saved with this name")
        );
        resp->setStatusCode(drogon::k409Conflict);
        callback(resp);
    } catch (const std::exception& e) {
        spdlog::error("Create SSH connection error: {}", e.what());
        auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Internal server error"));
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void SshController::testConnection(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& id
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Unauthorized"));
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp);
        return;
    }

    try {
        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);
        auto rows = txn.exec_params(
            "SELECT id, name, COALESCE(connection_type, 'ssh') AS connection_type, host, port, username, auth_type, password_encrypted, private_key_encrypted, known_hosts_entry, last_tested_at, created_at, updated_at "
            "FROM ssh_connections WHERE id = $1 AND user_id = $2",
            id,
            userId
        );

        if (rows.empty()) {
            auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("SSH connection not found"));
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp);
            return;
        }

        const SshConnectionConfig config = rowToConfig(rows[0]);
        SshService sshService;
        auto testResult = sshService.testConnection(config);
        if (!testResult.success) {
            txn.commit();
            Json::Value payload;
            payload["error"] = testResult.error.empty() ? "SSH connection test failed" : testResult.error;
            payload["details"] = testResult.output;
            auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp);
            return;
        }

        auto updated = txn.exec_params(
            "UPDATE ssh_connections SET last_tested_at = NOW(), updated_at = NOW() WHERE id = $1 "
            "RETURNING id, name, COALESCE(connection_type, 'ssh') AS connection_type, host, port, username, auth_type, last_tested_at, created_at, updated_at",
            id
        );
        txn.commit();

        Json::Value payload;
        payload["message"] = "SSH connection is working";
        payload["connection"] = toConnectionJson(updated[0]);
        callback(drogon::HttpResponse::newHttpJsonResponse(payload));
    } catch (const std::exception& e) {
        spdlog::error("Test SSH connection error: {}", e.what());
        auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Internal server error"));
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void SshController::browseConnection(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& id
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Unauthorized"));
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp);
        return;
    }

    auto body = req->getJsonObject();
    const std::string remotePath = (body && body->isMember("path")) ? (*body)["path"].asString() : "";

    try {
        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);
        auto rows = txn.exec_params(
            "SELECT COALESCE(connection_type, 'ssh') AS connection_type, host, port, username, auth_type, password_encrypted, private_key_encrypted, known_hosts_entry "
            "FROM ssh_connections WHERE id = $1 AND user_id = $2",
            id,
            userId
        );

        if (rows.empty()) {
            auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("SSH connection not found"));
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp);
            return;
        }
        txn.commit();

        const SshConnectionConfig config = rowToConfig(rows[0]);
        SshService sshService;
        if (!sshService.isValidRemotePath(remotePath)) {
            auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Remote path must be an absolute Linux path"));
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp);
            return;
        }

        std::vector<SshDirectoryEntry> entries;
        auto browseResult = sshService.listDirectory(config, remotePath, entries);
        if (!browseResult.success) {
            Json::Value payload;
            payload["error"] = browseResult.error.empty() ? "Failed to browse remote directory" : browseResult.error;
            payload["details"] = browseResult.output;
            auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp);
            return;
        }

        Json::Value payload;
        payload["path"] = remotePath;
        Json::Value items(Json::arrayValue);
        for (const auto& entry : entries) {
            Json::Value item;
            item["name"] = entry.name;
            item["directory"] = entry.directory;
            item["path"] = remotePath == "/" ? "/" + entry.name : remotePath + "/" + entry.name;
            items.append(item);
        }
        payload["entries"] = items;
        callback(drogon::HttpResponse::newHttpJsonResponse(payload));
    } catch (const std::exception& e) {
        spdlog::error("Browse SSH connection error: {}", e.what());
        auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Internal server error"));
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void SshController::probeConnection(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& id
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Unauthorized"));
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp);
        return;
    }

    try {
        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);
        auto rows = txn.exec_params(
            "SELECT COALESCE(connection_type, 'ssh') AS connection_type, host, port, username, auth_type, password_encrypted, private_key_encrypted, known_hosts_entry "
            "FROM ssh_connections WHERE id = $1 AND user_id = $2",
            id,
            userId
        );

        if (rows.empty()) {
            auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("SSH connection not found"));
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp);
            return;
        }
        txn.commit();

        const SshConnectionConfig config = rowToConfig(rows[0]);
        SshService sshService;
        auto probeResult = sshService.probeHost(config);
        if (!probeResult.success) {
            pqxx::work observation(*conn);
            observation.exec_params("UPDATE ssh_connections SET last_probed_at=NOW(),last_probe_error=$3 WHERE id=$1 AND user_id=$2",id,userId,probeResult.error.empty()?"Host probe failed":probeResult.error);
            observation.commit();
            Json::Value payload;
            payload["error"] = probeResult.error.empty() ? "Failed to probe remote host" : probeResult.error;
            payload["details"] = probeResult.output;
            auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp);
            return;
        }

        Json::Value capabilities;
        std::istringstream stream(probeResult.output);
        std::string line;
        while (std::getline(stream, line)) {
            const auto equals = line.find('=');
            if (equals == std::string::npos || line.rfind("__STACKPILOT_", 0) == 0) {
                continue;
            }
            capabilities[line.substr(0, equals)] = line.substr(equals + 1);
        }

        pqxx::work observation(*conn);
        observation.exec_params("UPDATE ssh_connections SET host_capabilities=$3::jsonb,last_probed_at=NOW(),last_probe_error='' WHERE id=$1 AND user_id=$2",id,userId,strings::compactJson(capabilities));
        observation.commit();
        Json::Value payload;
        payload["message"] = "Remote host probed";
        payload["capabilities"] = capabilities;
        payload["details"] = probeResult.output;
        callback(drogon::HttpResponse::newHttpJsonResponse(payload));
    } catch (const std::exception& e) {
        spdlog::error("Probe SSH connection error: {}", e.what());
        auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Internal server error"));
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void SshController::provisionDocker(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& id
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Unauthorized"));
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp);
        return;
    }

    auto body = req->getJsonObject();
    const std::string sudoPassword = (body && body->isMember("sudo_password")) ? (*body)["sudo_password"].asString() : "";

    try {
        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);
        auto rows = txn.exec_params(
            "SELECT COALESCE(connection_type, 'ssh') AS connection_type, host, port, username, auth_type, password_encrypted, private_key_encrypted, known_hosts_entry "
            "FROM ssh_connections WHERE id = $1 AND user_id = $2",
            id,
            userId
        );

        if (rows.empty()) {
            auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("SSH connection not found"));
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp);
            return;
        }
        txn.commit();

        const SshConnectionConfig config = rowToConfig(rows[0]);
        SshService sshService;
        auto provisionResult = sshService.provisionDockerHost(config, sudoPassword);

        Json::Value payload;
        payload["success"] = provisionResult.success;
        payload["details"] = provisionResult.output;
        payload["message"] = provisionResult.success ? "Docker host prepared" : "Docker host preparation failed";
        if (!provisionResult.error.empty()) {
            if (provisionResult.success) {
                payload["warning"] = provisionResult.error;
            } else {
                payload["error"] = provisionResult.error;
                if (provisionResult.error.find("root or passwordless sudo") != std::string::npos) {
                    payload["needs_sudo_password"] = true;
                }
            }
        }

        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        if (!provisionResult.success) {
            resp->setStatusCode(drogon::k400BadRequest);
        }
        callback(resp);
    } catch (const std::exception& e) {
        spdlog::error("Provision Docker SSH connection error: {}", e.what());
        auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Internal server error"));
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void SshController::provisionKubernetes(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& id
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Unauthorized"));
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp);
        return;
    }

    auto body = req->getJsonObject();
    const std::string sudoPassword = (body && body->isMember("sudo_password")) ? (*body)["sudo_password"].asString() : "";

    try {
        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);
        auto rows = txn.exec_params(
            "SELECT name, COALESCE(connection_type, 'ssh') AS connection_type, host, port, username, auth_type, password_encrypted, private_key_encrypted, known_hosts_entry "
            "FROM ssh_connections WHERE id = $1 AND user_id = $2",
            id,
            userId
        );

        if (rows.empty()) {
            auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("SSH connection not found"));
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp);
            return;
        }
        const auto membership = txn.exec_params(
            "SELECT c.name FROM kubernetes_cluster_nodes n JOIN kubernetes_clusters c ON c.id=n.cluster_id WHERE n.connection_id=$1 AND c.user_id=$2 AND n.status<>'removed' AND n.removed_at IS NULL AND c.control_plane_connection_id IS DISTINCT FROM $1::uuid LIMIT 1",id,userId);
        if (!membership.empty()) {
            auto response=drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("This server is already a node of another cluster. Remove it from that cluster before preparing a standalone control plane."));
            response->setStatusCode(drogon::k409Conflict); callback(response); return;
        }
        txn.commit();

        const SshConnectionConfig config = rowToConfig(rows[0]);
        SshService sshService;
        auto provisionResult = sshService.provisionLightweightKubernetesHost(config, sudoPassword);

        const std::string redactedDetails = redactClusterToken(provisionResult.output);
        Json::Value payload;
        payload["success"] = provisionResult.success;
        payload["details"] = redactedDetails;
        payload["message"] = provisionResult.success ? "Lightweight Kubernetes prepared" : "Kubernetes preparation failed";

        if (provisionResult.success) {
            const std::string serverUrl = outputValue(provisionResult.output, "STACKPILOT_cluster_server_url");
            const std::string nodeToken = outputValue(provisionResult.output, "STACKPILOT_cluster_token");
            const std::string kubeconfig = extractBlock(provisionResult.output,
                                                        "__STACKPILOT_K3S_KUBECONFIG_BEGIN__",
                                                        "__STACKPILOT_K3S_KUBECONFIG_END__");
            if (!serverUrl.empty() && !nodeToken.empty() && !kubeconfig.empty()) {
                try {
                    const std::string connectionName = rows[0]["name"].as<std::string>();
                    pqxx::work lookup(*conn);
                    const auto existing = lookup.exec_params("SELECT name FROM kubernetes_clusters WHERE user_id=$1 AND control_plane_connection_id=$2 ORDER BY updated_at DESC LIMIT 1",userId,id);
                    const std::string clusterName = existing.empty()?safeClusterName("", connectionName + "-cluster"):existing[0][0].as<std::string>();
                    lookup.commit();
                    const std::string encryptedToken = TokenCrypto::encrypt(nodeToken);
                    const std::string encryptedKubeconfig = kubeconfig.empty() ? std::string() : TokenCrypto::encrypt(kubeconfig);

                    pqxx::work writeTxn(*conn);
                    auto clusterRows = writeTxn.exec_params(
                        "INSERT INTO kubernetes_clusters (user_id, name, provider, control_plane_connection_id, server_url, join_token_encrypted, status, last_status, kubeconfig_encrypted) "
                        "VALUES ($1, $2, 'k3s', $3, $4, $5, 'ready', $6, NULLIF($7, '')) "
                        "ON CONFLICT (user_id, name) DO UPDATE SET "
                        "control_plane_connection_id = EXCLUDED.control_plane_connection_id, "
                        "server_url = EXCLUDED.server_url, join_token_encrypted = EXCLUDED.join_token_encrypted, "
                        "status = 'ready', last_status = EXCLUDED.last_status, updated_at = NOW(), "
                        "kubeconfig_encrypted = COALESCE(NULLIF(EXCLUDED.kubeconfig_encrypted, ''), kubernetes_clusters.kubeconfig_encrypted) "
                        "WHERE kubernetes_clusters.control_plane_connection_id = EXCLUDED.control_plane_connection_id "
                        "RETURNING id, name, provider, server_url, status",
                        userId,
                        clusterName,
                        id,
                        serverUrl,
                        encryptedToken,
                        redactedDetails,
                        encryptedKubeconfig
                    );
                    if (clusterRows.empty()) throw std::runtime_error("Cluster name belongs to a different control plane");
                    const std::string clusterId = clusterRows[0]["id"].as<std::string>();
                    writeTxn.exec_params(
                        "INSERT INTO kubernetes_cluster_nodes (cluster_id, connection_id, role, status, last_status, joined_at) "
                        "VALUES ($1, $2, 'server', 'ready', $3, NOW()) "
                        "ON CONFLICT (cluster_id, connection_id) DO UPDATE SET "
                        "role = 'server', status = 'ready', last_status = EXCLUDED.last_status, joined_at = NOW(), updated_at = NOW()",
                        clusterId,
                        id,
                        redactedDetails
                    );
                    writeTxn.commit();

                    payload["cluster"]["id"] = clusterId;
                    payload["cluster"]["name"] = clusterRows[0]["name"].as<std::string>();
                    payload["cluster"]["provider"] = clusterRows[0]["provider"].as<std::string>();
                    payload["cluster"]["server_url"] = clusterRows[0]["server_url"].as<std::string>();
                    payload["cluster"]["status"] = clusterRows[0]["status"].as<std::string>();
                    payload["message"] = "Lightweight Kubernetes prepared and registered as cluster: " + clusterName;
                } catch (const std::exception& clusterEx) {
                    spdlog::warn("Could not register provisioned cluster into kubernetes_clusters: {}", clusterEx.what());
                    provisionResult.success = false;
                    payload["success"] = false;
                    payload["message"] = "Host prepared; cluster registration failed";
                    payload["error"] = "Kubernetes is installed, but StackPilot could not register its deployment target. Retry Prepare Kubernetes to register it.";
                }
            } else {
                provisionResult.success = false;
                payload["success"] = false;
                payload["message"] = "Host prepared; deployment credentials unavailable";
                payload["error"] = "Kubernetes was prepared, but its server URL, join token, or kubeconfig could not be read. Check sudo access and retry preparation.";
            }
        }

        if (!provisionResult.error.empty()) {
            payload[provisionResult.success ? "warning" : "error"] = provisionResult.error;
            if (!provisionResult.success &&
                provisionResult.error.find("root or passwordless sudo") != std::string::npos) {
                payload["needs_sudo_password"] = true;
                payload["hint"] = "This server requires a password for sudo. Enter the server password to proceed.";
            } else if (!provisionResult.success &&
                       provisionResult.error.find("curl") != std::string::npos) {
                payload["hint"] = "Install curl on the remote host, then run Prepare Kubernetes again.";
            } else if (!provisionResult.success &&
                       provisionResult.error.find("k3s installation failed") != std::string::npos) {
                payload["hint"] = "Check the remote host output. k3s usually fails here because of missing sudo rights, no network access, unsupported OS packages, or low disk space.";
            } else if (!provisionResult.success &&
                       provisionResult.error.find("node did not become ready") != std::string::npos) {
                payload["hint"] = "k3s was installed, but the node did not report ready. Run the Terminal action and check 'sudo systemctl status k3s' and 'sudo k3s kubectl get nodes'.";
            }
        }
        if (!provisionResult.success) {
            spdlog::warn("Provision Kubernetes failed for SSH connection {}: {}", id, provisionResult.error);
        }

        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        if (!provisionResult.success) {
            resp->setStatusCode(drogon::k400BadRequest);
        }
        callback(resp);
    } catch (const std::exception& e) {
        spdlog::error("Provision Kubernetes SSH connection error: {}", e.what());
        auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Internal server error"));
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void SshController::initializeKubernetesCluster(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& id
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Unauthorized"));
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp);
        return;
    }

    auto body = req->getJsonObject();
    const std::string sudoPassword = body ? jsonString(*body, "sudo_password") : "";
    const std::string requestedClusterName = body ? jsonString(*body, "cluster_name") : "";
    const std::string advertiseAddress = body ? jsonString(*body, "advertise_address") : "";
    const std::string tlsSan = body ? jsonString(*body, "tls_san") : "";

    try {
        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work readTxn(*conn);
        auto rows = readTxn.exec_params(
            "SELECT id, name, COALESCE(connection_type, 'ssh') AS connection_type, host, port, username, auth_type, password_encrypted, private_key_encrypted, known_hosts_entry "
            "FROM ssh_connections WHERE id = $1 AND user_id = $2",
            id,
            userId
        );

        if (rows.empty()) {
            auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("SSH connection not found"));
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp);
            return;
        }
        const std::string connectionName = rows[0]["name"].as<std::string>();
        const SshConnectionConfig config = rowToConfig(rows[0]);
        const auto membership = readTxn.exec_params(
            "SELECT c.name FROM kubernetes_cluster_nodes n JOIN kubernetes_clusters c ON c.id=n.cluster_id WHERE n.connection_id=$1 AND c.user_id=$2 AND n.status<>'removed' AND n.removed_at IS NULL AND c.control_plane_connection_id IS DISTINCT FROM $1::uuid LIMIT 1",id,userId);
        if (!membership.empty()) {
            auto response=drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("This server is already a node of another cluster. Remove it from that cluster before preparing a standalone control plane."));
            response->setStatusCode(drogon::k409Conflict); callback(response); return;
        }
        const auto previousCluster=readTxn.exec_params("SELECT name FROM kubernetes_clusters WHERE user_id=$1 AND control_plane_connection_id=$2 ORDER BY updated_at DESC LIMIT 1",userId,id);
        const std::string clusterName=previousCluster.empty()?safeClusterName(requestedClusterName,connectionName):previousCluster[0][0].as<std::string>();
        const auto collision=readTxn.exec_params("SELECT id FROM kubernetes_clusters WHERE user_id=$1 AND name=$2 AND control_plane_connection_id IS DISTINCT FROM $3::uuid",userId,clusterName,id);
        if (!collision.empty()) {
            auto response=drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Cluster name is already assigned to another control plane. Choose a different cluster name."));
            response->setStatusCode(drogon::k409Conflict); callback(response); return;
        }
        readTxn.commit();

        SshService sshService;
        auto initResult = sshService.initializeK3sControlPlane(config, sudoPassword, advertiseAddress, tlsSan);
        const std::string redactedDetails = redactClusterToken(initResult.output);

        Json::Value payload;
        payload["success"] = initResult.success;
        payload["details"] = redactedDetails;
        payload["message"] = initResult.success ? "Kubernetes control plane initialized" : "Kubernetes control-plane bootstrap failed";

        if (!initResult.success) {
            payload["error"] = initResult.error.empty() ? "Control-plane bootstrap failed" : initResult.error;
            if (payload["error"].asString().find("root or passwordless sudo") != std::string::npos) {
                payload["needs_sudo_password"] = true;
                payload["hint"] = "This server requires sudo. Enter the server password or configure passwordless sudo for provisioning.";
            }
            auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp);
            return;
        }

        const std::string serverUrl = outputValue(initResult.output, "STACKPILOT_cluster_server_url");
        const std::string nodeToken = outputValue(initResult.output, "STACKPILOT_cluster_token");
        if (serverUrl.empty() || nodeToken.empty()) {
            payload["success"] = false;
            payload["error"] = "Control plane initialized, but StackPilot could not read the server URL or join token";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
            resp->setStatusCode(drogon::k500InternalServerError);
            callback(resp);
            return;
        }

        const std::string encryptedToken = TokenCrypto::encrypt(nodeToken);
        // This is what makes a built cluster usable as a deploy target. Without
        // it the platform provisions a cluster it can never talk to again.
        const std::string kubeconfig = extractBlock(initResult.output,
                                                    "__STACKPILOT_K3S_KUBECONFIG_BEGIN__",
                                                    "__STACKPILOT_K3S_KUBECONFIG_END__");
        if (kubeconfig.empty()) {
            payload["success"]=false; payload["error"]="Control plane initialized, but no deployment kubeconfig was captured. Check sudo access and retry initialization.";
            auto response=drogon::HttpResponse::newHttpJsonResponse(payload); response->setStatusCode(drogon::k500InternalServerError); callback(response); return;
        }
        const std::string encryptedKubeconfig =
            kubeconfig.empty() ? std::string() : TokenCrypto::encrypt(kubeconfig);
        pqxx::work writeTxn(*conn);
        auto clusterRows = writeTxn.exec_params(
            "INSERT INTO kubernetes_clusters (user_id, name, provider, control_plane_connection_id, server_url, join_token_encrypted, status, last_status, kubeconfig_encrypted) "
            "VALUES ($1, $2, 'k3s', $3, $4, $5, 'ready', $6, NULLIF($7, '')) "
            "ON CONFLICT (user_id, name) DO UPDATE SET "
            "control_plane_connection_id = EXCLUDED.control_plane_connection_id, "
            "server_url = EXCLUDED.server_url, join_token_encrypted = EXCLUDED.join_token_encrypted, "
            "status = 'ready', last_status = EXCLUDED.last_status, updated_at = NOW(), "
            // Keep the existing kubeconfig if this run could not read one,
            // rather than blanking a working target.
            "kubeconfig_encrypted = COALESCE(NULLIF(EXCLUDED.kubeconfig_encrypted, ''), kubernetes_clusters.kubeconfig_encrypted) "
            "WHERE kubernetes_clusters.control_plane_connection_id=EXCLUDED.control_plane_connection_id "
            "RETURNING id, name, provider, server_url, status, created_at, updated_at",
            userId,
            clusterName,
            id,
            serverUrl,
            encryptedToken,
            redactedDetails,
            encryptedKubeconfig
        );
        if (clusterRows.empty()) throw std::runtime_error("Cluster name belongs to another control plane");
        const std::string clusterId = clusterRows[0]["id"].as<std::string>();
        writeTxn.exec_params(
            "INSERT INTO kubernetes_cluster_nodes (cluster_id, connection_id, role, status, last_status, joined_at) "
            "VALUES ($1, $2, 'server', 'ready', $3, NOW()) "
            "ON CONFLICT (cluster_id, connection_id) DO UPDATE SET "
            "role = 'server', status = 'ready', last_status = EXCLUDED.last_status, joined_at = NOW(), updated_at = NOW()",
            clusterId,
            id,
            redactedDetails
        );
        writeTxn.commit();

        payload["cluster"]["id"] = clusterId;
        payload["cluster"]["name"] = clusterRows[0]["name"].as<std::string>();
        payload["cluster"]["provider"] = clusterRows[0]["provider"].as<std::string>();
        payload["cluster"]["server_url"] = clusterRows[0]["server_url"].as<std::string>();
        payload["cluster"]["status"] = clusterRows[0]["status"].as<std::string>();
        payload["join_token_stored"] = true;
        callback(drogon::HttpResponse::newHttpJsonResponse(payload));
    } catch (const std::exception& e) {
        spdlog::error("Initialize Kubernetes cluster error: {}", e.what());
        auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Internal server error"));
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void SshController::joinKubernetesCluster(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& id
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Unauthorized"));
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp);
        return;
    }

    auto body = req->getJsonObject();
    if (!body) {
        auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Invalid JSON body"));
        resp->setStatusCode(drogon::k400BadRequest);
        callback(resp);
        return;
    }
    const std::string workerConnectionId = jsonString(*body, "worker_connection_id");
    const std::string sudoPassword = jsonString(*body, "sudo_password");
    if (workerConnectionId.empty()) {
        auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("worker_connection_id is required"));
        resp->setStatusCode(drogon::k400BadRequest);
        callback(resp);
        return;
    }
    if (workerConnectionId == id) {
        auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Choose a different saved connection for the worker node"));
        resp->setStatusCode(drogon::k400BadRequest);
        callback(resp);
        return;
    }

    try {
        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work readTxn(*conn);
        auto clusterRows = readTxn.exec_params(
            "SELECT id, name, server_url, join_token_encrypted "
            "FROM kubernetes_clusters "
            "WHERE user_id = $1 AND control_plane_connection_id = $2 "
            "ORDER BY updated_at DESC LIMIT 1",
            userId,
            id
        );
        if (clusterRows.empty()) {
            auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Initialize this control plane before joining workers"));
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp);
            return;
        }
        auto workerRows = readTxn.exec_params(
            "SELECT id, name, COALESCE(connection_type, 'ssh') AS connection_type, host, port, username, auth_type, password_encrypted, private_key_encrypted, known_hosts_entry "
            "FROM ssh_connections WHERE id = $1 AND user_id = $2",
            workerConnectionId,
            userId
        );
        if (workerRows.empty()) {
            auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Worker SSH connection not found"));
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp);
            return;
        }

        auto cpConnectionRows = readTxn.exec_params(
            "SELECT host FROM ssh_connections WHERE id = $1 AND user_id = $2",
            id,
            userId
        );
        if (!cpConnectionRows.empty()) {
            const std::string cpHost = cpConnectionRows[0]["host"].as<std::string>();
            if (!cpHost.empty() && cpHost == workerRows[0]["host"].as<std::string>()) {
                auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload(
                    "Worker host (" + workerRows[0]["host"].as<std::string>() +
                    ") is identical to the control plane host. You cannot join a control-plane server to itself as a worker."));
                resp->setStatusCode(drogon::k400BadRequest);
                callback(resp);
                return;
            }
        }

        const bool replaceExisting = body->isMember("replace_existing") && (*body)["replace_existing"].asBool();
        auto existingClusterAsCp = readTxn.exec_params(
            "SELECT name FROM kubernetes_clusters WHERE user_id = $1 AND control_plane_connection_id = $2",
            userId,
            workerConnectionId
        );
        if (!existingClusterAsCp.empty() && !replaceExisting) {
            auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload(
                "This server is already registered as the control plane for cluster '" +
                existingClusterAsCp[0]["name"].as<std::string>() + "'. "
                "Joining it as a worker will replace its standalone cluster. "
                "Confirm 'replace_existing' to proceed."));
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp);
            return;
        }

        const auto otherWorkerMembership=readTxn.exec_params("SELECT c.name FROM kubernetes_cluster_nodes n JOIN kubernetes_clusters c ON c.id=n.cluster_id WHERE c.user_id=$1 AND n.connection_id=$2 AND n.cluster_id<>$3 AND n.role='agent' AND n.status<>'removed' AND n.removed_at IS NULL LIMIT 1",userId,workerConnectionId,clusterRows[0]["id"].as<std::string>());
        if (!otherWorkerMembership.empty()) {
            auto response=drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Worker is managed by another cluster. Remove it from that cluster before joining this one.")); response->setStatusCode(drogon::k409Conflict); callback(response); return;
        }
        const std::string clusterId = clusterRows[0]["id"].as<std::string>();
        const std::string clusterName = clusterRows[0]["name"].as<std::string>();
        const std::string serverUrl = clusterRows[0]["server_url"].as<std::string>();
        const std::string nodeToken = TokenCrypto::decrypt(clusterRows[0]["join_token_encrypted"].as<std::string>());
        const SshConnectionConfig workerConfig = rowToConfig(workerRows[0]);
        readTxn.commit();

        // "server" adds another control plane so the cluster survives losing
        // the first node; anything else joins as a worker, which stays the
        // default so existing callers are unaffected.
        const std::string requestedRole = toLowerAscii(jsonString(*body, "role", "agent"));
        const bool joinAsServer = requestedRole == "server" || requestedRole == "control-plane";

        SshService sshService;
        auto joinResult = joinAsServer
            ? sshService.joinK3sServer(workerConfig, serverUrl, nodeToken, sudoPassword)
            : sshService.joinK3sWorker(workerConfig, serverUrl, nodeToken, sudoPassword,
                                       // The UI asks before setting this: converting a
                                       // standalone node destroys whatever it was running.
                                       body->isMember("replace_existing") &&
                                           (*body)["replace_existing"].asBool());
        const std::string redactedDetails = redactClusterToken(joinResult.output);

        pqxx::work writeTxn(*conn);
        writeTxn.exec_params(
            "INSERT INTO kubernetes_cluster_nodes (cluster_id, connection_id, role, status, last_status, joined_at) "
            // Explicit casts: $3 is used both as the status column and inside
            // the CASE comparison, and once $5 was added Postgres could no
            // longer deduce a single type for it -- "inconsistent types
            // deduced for parameter $3", which surfaced as a 500 on every
            // worker join.
            "VALUES ($1, $2, $5::varchar, $3::varchar, $4, "
            "        CASE WHEN $3::varchar = 'ready' THEN NOW() ELSE NULL END) "
            "ON CONFLICT (cluster_id, connection_id) DO UPDATE SET "
            "role = EXCLUDED.role, status = EXCLUDED.status, last_status = EXCLUDED.last_status, removed_at = CASE WHEN EXCLUDED.status = 'ready' THEN NULL ELSE kubernetes_cluster_nodes.removed_at END, "
            "joined_at = CASE WHEN EXCLUDED.status = 'ready' THEN NOW() ELSE kubernetes_cluster_nodes.joined_at END, updated_at = NOW()",
            clusterId,
            workerConnectionId,
            joinResult.success ? "ready" : "failed",
            redactedDetails,
            joinAsServer ? "server" : "agent"
        );
        if (joinAsServer && joinResult.success) {
            writeTxn.exec_params(
                "UPDATE kubernetes_clusters SET ha_enabled = TRUE WHERE id = $1", clusterId);
        }
        writeTxn.exec_params(
            "UPDATE kubernetes_clusters SET status = $1, updated_at = NOW() WHERE id = $2",
            joinResult.success ? "ready" : "degraded",
            clusterId
        );
        writeTxn.commit();

        Json::Value payload;
        payload["success"] = joinResult.success;
        payload["message"] = joinResult.success ? "Worker joined Kubernetes cluster" : "Worker join failed";
        payload["cluster"]["id"] = clusterId;
        payload["cluster"]["name"] = clusterName;
        payload["cluster"]["server_url"] = serverUrl;
        payload["worker_connection_id"] = workerConnectionId;
        payload["details"] = redactedDetails;
        if (!joinResult.success) {
            payload["error"] = joinResult.error.empty() ? "Worker join failed" : joinResult.error;
            if (payload["error"].asString().find("root or passwordless sudo") != std::string::npos) {
                payload["needs_sudo_password"] = true;
                payload["hint"] = "The worker requires sudo. Enter the worker server password or configure passwordless sudo.";
            } else if (payload["error"].asString().find("port 6443") != std::string::npos) {
                payload["hint"] = "Port 6443 was unreachable from this worker. Verify that the control-plane host has port 6443 open in its AWS Security Group or cloud firewall, and that k3s server is actively running on it.";
            } else if (payload["error"].asString().find("own control plane") != std::string::npos) {
                payload["hint"] = "This server already has standalone Kubernetes installed. Click 'Replace and join' to uninstall it and join this cluster.";
            }
            auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp);
            return;
        }
        callback(drogon::HttpResponse::newHttpJsonResponse(payload));
    } catch (const std::exception& e) {
        spdlog::error("Join Kubernetes cluster error: {}", e.what());
        auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Internal server error"));
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void SshController::removeKubernetesNode(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& id,
    const std::string& nodeName
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Unauthorized"));
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp);
        return;
    }

    const auto body = req->getJsonObject();
    const std::string sudoPassword = body ? jsonString(*body, "sudo_password") : "";

    try {
        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work readTxn(*conn);

        // The removal runs from the control plane, so `id` is the control
        // plane's saved connection and the node is identified by its
        // Kubernetes name.
        auto rows = readTxn.exec_params(
            "SELECT c.id AS cluster_id, s.id AS connection_id, s.name, "
            "COALESCE(s.connection_type, 'ssh') AS connection_type, s.host, s.port, s.username, s.auth_type, "
            "s.password_encrypted, s.private_key_encrypted, s.known_hosts_entry "
            "FROM kubernetes_clusters c "
            "JOIN ssh_connections s ON s.id = c.control_plane_connection_id "
            "WHERE c.user_id = $1 AND c.control_plane_connection_id = $2 "
            "ORDER BY c.updated_at DESC LIMIT 1",
            userId,
            id
        );
        if (rows.empty()) {
            readTxn.commit();
            auto resp = drogon::HttpResponse::newHttpJsonResponse(
                makeErrorPayload("No cluster is managed from this connection"));
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp);
            return;
        }

        const std::string clusterId = rows[0]["cluster_id"].as<std::string>();
        const SshConnectionConfig controlPlane = rowToConfig(rows[0]);
        readTxn.commit();

        SshService sshService;
        const auto removal = sshService.removeK3sNode(controlPlane, nodeName, sudoPassword);

        pqxx::work writeTxn(*conn);
        if (removal.success) {
            // Marked removed rather than deleted: the cluster keeps a record of
            // what was once part of it, which matters when working out why a
            // workload moved.
            writeTxn.exec_params(
                "UPDATE kubernetes_cluster_nodes SET status = 'removed', removed_at = NOW(), "
                "last_status = $3, updated_at = NOW() "
                "WHERE cluster_id = $1 AND (connection_id::text = $2 OR connection_id IN ("
                "  SELECT id FROM ssh_connections WHERE user_id = $4 AND (name = $2 OR host = $2 OR id::text = $2)"
                "))",
                clusterId, nodeName, redactClusterToken(removal.output), userId);
        }
        writeTxn.commit();

        Json::Value payload;
        payload["success"] = removal.success;
        payload["message"] = removal.success
            ? "Node drained and removed from the cluster"
            : "Node removal failed";
        payload["cluster_id"] = clusterId;
        payload["node"] = nodeName;
        payload["details"] = redactClusterToken(removal.output);
        if (!removal.success) {
            payload["error"] = removal.error;
        }

        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(removal.success ? drogon::k200OK : drogon::k400BadRequest);
        callback(resp);
    } catch (const std::exception& e) {
        spdlog::error("Remove Kubernetes node error: {}", e.what());
        auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Internal server error"));
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void SshController::inspectKubernetesCluster(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& id
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Unauthorized"));
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp);
        return;
    }

    try {
        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work readTxn(*conn);
        auto clusterRows = readTxn.exec_params(
            "SELECT id, name, provider, server_url, status "
            "FROM kubernetes_clusters "
            "WHERE user_id = $1 AND control_plane_connection_id = $2 "
            "ORDER BY updated_at DESC LIMIT 1",
            userId,
            id
        );
        if (clusterRows.empty()) {
            auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("No cluster is registered for this control-plane connection"));
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp);
            return;
        }
        auto connectionRows = readTxn.exec_params(
            "SELECT id, name, COALESCE(connection_type, 'ssh') AS connection_type, host, port, username, auth_type, password_encrypted, private_key_encrypted, known_hosts_entry "
            "FROM ssh_connections WHERE id = $1 AND user_id = $2",
            id,
            userId
        );
        if (connectionRows.empty()) {
            auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Control-plane SSH connection not found"));
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp);
            return;
        }
        const std::string clusterId = clusterRows[0]["id"].as<std::string>();
        const SshConnectionConfig config = rowToConfig(connectionRows[0]);
        readTxn.commit();

        SshService sshService;
        auto statusResult = sshService.inspectK3sCluster(config);
        const std::string redactedDetails = redactClusterToken(statusResult.output);
        pqxx::work writeTxn(*conn);
        writeTxn.exec_params(
            "UPDATE kubernetes_clusters SET status = $1, last_status = $2, updated_at = NOW() WHERE id = $3",
            statusResult.success ? "ready" : "degraded",
            redactedDetails,
            clusterId
        );
        writeTxn.commit();

        Json::Value payload;
        payload["success"] = statusResult.success;
        payload["cluster"]["id"] = clusterId;
        payload["cluster"]["name"] = clusterRows[0]["name"].as<std::string>();
        payload["cluster"]["provider"] = clusterRows[0]["provider"].as<std::string>();
        payload["cluster"]["server_url"] = clusterRows[0]["server_url"].as<std::string>();
        payload["cluster"]["status"] = statusResult.success ? "ready" : "degraded";
        payload["details"] = redactedDetails;
        payload["message"] = statusResult.success ? "Cluster status loaded" : "Cluster status degraded";
        if (!statusResult.success) {
            payload["error"] = statusResult.error.empty() ? "Failed to inspect cluster" : statusResult.error;
            auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp);
            return;
        }
        callback(drogon::HttpResponse::newHttpJsonResponse(payload));
    } catch (const std::exception& e) {
        spdlog::error("Inspect Kubernetes cluster error: {}", e.what());
        auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Internal server error"));
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void SshController::deleteKubernetesCluster(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& id
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Unauthorized"));
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp);
        return;
    }

    const auto body = req->getJsonObject();
    const bool wipeServers = body && body->isMember("wipe_servers") && (*body)["wipe_servers"].asBool();
    const std::string sudoPassword = body ? jsonString(*body, "sudo_password") : "";

    try {
        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work readTxn(*conn);

        auto clusterRows = readTxn.exec_params(
            "SELECT id, name, control_plane_connection_id FROM kubernetes_clusters WHERE id = $1 AND user_id = $2",
            id, userId
        );
        if (clusterRows.empty()) {
            readTxn.commit();
            auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Cluster not found"));
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp);
            return;
        }

        const std::string clusterName = clusterRows[0]["name"].as<std::string>();
        const std::string cpConnId = clusterRows[0]["control_plane_connection_id"].is_null() ? "" : clusterRows[0]["control_plane_connection_id"].as<std::string>();

        std::vector<std::string> serverConnIds;
        if (!cpConnId.empty()) {
            serverConnIds.push_back(cpConnId);
        }

        auto nodeRows = readTxn.exec_params(
            "SELECT connection_id FROM kubernetes_cluster_nodes WHERE cluster_id = $1",
            id
        );
        for (const auto& r : nodeRows) {
            if (!r["connection_id"].is_null()) {
                const std::string nid = r["connection_id"].as<std::string>();
                if (std::find(serverConnIds.begin(), serverConnIds.end(), nid) == serverConnIds.end()) {
                    serverConnIds.push_back(nid);
                }
            }
        }
        readTxn.commit();

        std::string wipeDetails;
        if (wipeServers && !serverConnIds.empty()) {
            SshService sshService;
            for (const auto& connId : serverConnIds) {
                pqxx::work fetchTxn(*conn);
                auto connRows = fetchTxn.exec_params(
                    "SELECT COALESCE(connection_type, 'ssh') AS connection_type, host, port, username, auth_type, password_encrypted, private_key_encrypted, known_hosts_entry "
                    "FROM ssh_connections WHERE id = $1 AND user_id = $2",
                    connId, userId
                );
                fetchTxn.commit();
                if (!connRows.empty()) {
                    auto config = rowToConfig(connRows[0]);
                    auto wipeRes = sshService.wipeK3sInstallation(config, sudoPassword);
                    wipeDetails += config.host + ": " + (wipeRes.success ? "wiped ok\n" : wipeRes.error + "\n");
                }
            }
        }

        pqxx::work deleteTxn(*conn);
        deleteTxn.exec_params("DELETE FROM kubernetes_cluster_nodes WHERE cluster_id = $1", id);
        deleteTxn.exec_params("DELETE FROM kubernetes_clusters WHERE id = $1 AND user_id = $2", id, userId);
        deleteTxn.commit();

        Json::Value payload;
        payload["success"] = true;
        payload["message"] = wipeServers ? ("Cluster '" + clusterName + "' deleted and associated nodes wiped.") : ("Cluster '" + clusterName + "' deregistered from StackPilot.");
        payload["cluster_id"] = id;
        payload["wipe_details"] = wipeDetails;

        callback(drogon::HttpResponse::newHttpJsonResponse(payload));
    } catch (const std::exception& e) {
        spdlog::error("Delete cluster error: {}", e.what());
        auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Internal server error"));
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void SshController::wipeConnection(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& id
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Unauthorized"));
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp);
        return;
    }

    const auto body = req->getJsonObject();
    const std::string sudoPassword = body ? jsonString(*body, "sudo_password") : "";

    try {
        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work readTxn(*conn);

        auto rows = readTxn.exec_params(
            "SELECT COALESCE(connection_type, 'ssh') AS connection_type, host, port, username, auth_type, password_encrypted, private_key_encrypted, known_hosts_entry "
            "FROM ssh_connections WHERE id = $1 AND user_id = $2",
            id, userId
        );
        if (rows.empty()) {
            readTxn.commit();
            auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("SSH connection not found"));
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp);
            return;
        }
        const SshConnectionConfig config = rowToConfig(rows[0]);
        readTxn.commit();

        SshService sshService;
        auto wipeRes = sshService.wipeK3sInstallation(config, sudoPassword);

        pqxx::work writeTxn(*conn);
        writeTxn.exec_params("DELETE FROM kubernetes_cluster_nodes WHERE connection_id = $1", id);
        writeTxn.exec_params("UPDATE kubernetes_clusters SET status = 'degraded', last_status = 'Control plane node wiped' WHERE control_plane_connection_id = $1", id);
        writeTxn.commit();

        Json::Value payload;
        payload["success"] = wipeRes.success;
        payload["message"] = wipeRes.success ? "Server wiped and K3s uninstalled cleanly" : "Failed to wipe server";
        payload["details"] = wipeRes.output;
        if (!wipeRes.success) {
            payload["error"] = wipeRes.error;
        }

        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        resp->setStatusCode(wipeRes.success ? drogon::k200OK : drogon::k400BadRequest);
        callback(resp);
    } catch (const std::exception& e) {
        spdlog::error("Wipe connection error: {}", e.what());
        auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Internal server error"));
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void SshController::executeCommand(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& id
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Unauthorized"));
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp);
        return;
    }

    auto body = req->getJsonObject();
    if (!body) {
        auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Invalid JSON body"));
        resp->setStatusCode(drogon::k400BadRequest);
        callback(resp);
        return;
    }

    const std::string cwd = body->isMember("cwd") ? (*body)["cwd"].asString() : "";
    const std::string command = body->isMember("command") ? (*body)["command"].asString() : "";
    const int timeoutSeconds = body->isMember("timeout_seconds") ? (*body)["timeout_seconds"].asInt() : 20;

    try {
        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);
        auto rows = txn.exec_params(
            "SELECT COALESCE(connection_type, 'ssh') AS connection_type, host, port, username, auth_type, password_encrypted, private_key_encrypted, known_hosts_entry "
            "FROM ssh_connections WHERE id = $1 AND user_id = $2",
            id,
            userId
        );

        if (rows.empty()) {
            auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("SSH connection not found"));
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp);
            return;
        }
        txn.commit();

        const SshConnectionConfig config = rowToConfig(rows[0]);
        SshService sshService;
        auto commandResult = sshService.runRemoteCommand(config, cwd, command, timeoutSeconds);

        Json::Value payload;
        payload["success"] = commandResult.success;
        payload["cwd"] = cwd;
        payload["command"] = command;
        payload["exit_code"] = commandResult.exitCode;
        payload["output"] = commandResult.output;
        if (!commandResult.error.empty()) {
            payload["error"] = commandResult.error;
        }

        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        if (!commandResult.success &&
            commandResult.error.find("Remote command exited with code") != 0) {
            resp->setStatusCode(drogon::k400BadRequest);
        }
        callback(resp);
    } catch (const std::exception& e) {
        spdlog::error("Execute SSH command error: {}", e.what());
        auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Internal server error"));
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void SshController::cloneRepository(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& id
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Unauthorized"));
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp);
        return;
    }

    auto body = req->getJsonObject();
    if (!body) {
        auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Invalid JSON body"));
        resp->setStatusCode(drogon::k400BadRequest);
        callback(resp);
        return;
    }

    const std::string cwd = body->isMember("cwd") ? (*body)["cwd"].asString() : "";
    const std::string repoUrl = body->isMember("repo_url") ? (*body)["repo_url"].asString() : "";
    const std::string targetDirectory = body->isMember("target_directory") ? (*body)["target_directory"].asString() : "";
    const int timeoutSeconds = body->isMember("timeout_seconds") ? (*body)["timeout_seconds"].asInt() : 180;

    try {
        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);
        auto rows = txn.exec_params(
            "SELECT COALESCE(connection_type, 'ssh') AS connection_type, host, port, username, auth_type, password_encrypted, private_key_encrypted, known_hosts_entry "
            "FROM ssh_connections WHERE id = $1 AND user_id = $2",
            id,
            userId
        );

        if (rows.empty()) {
            auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("SSH connection not found"));
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp);
            return;
        }
        txn.commit();

        const SshConnectionConfig config = rowToConfig(rows[0]);
        SshService sshService;
        auto cloneResult = sshService.cloneGitRepository(config, cwd, repoUrl, targetDirectory, timeoutSeconds);

        Json::Value payload;
        payload["success"] = cloneResult.success;
        payload["cwd"] = cwd;
        payload["repo_url"] = repoUrl;
        payload["target_directory"] = targetDirectory;
        payload["exit_code"] = cloneResult.exitCode;
        payload["output"] = cloneResult.output;
        if (!cloneResult.error.empty()) {
            payload["error"] = cloneResult.error;
        }

        auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
        if (!cloneResult.success) {
            resp->setStatusCode(drogon::k400BadRequest);
        }
        callback(resp);
    } catch (const std::exception& e) {
        spdlog::error("Clone SSH repository error: {}", e.what());
        auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Internal server error"));
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void SshController::deleteConnection(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& id
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Unauthorized"));
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp);
        return;
    }

    try {
        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);

        auto projectUse = txn.exec_params(
            "SELECT id FROM projects WHERE has_project_access(id, $1) AND ssh_connection_id = $2 LIMIT 1",
            userId,
            id
        );
        if (!projectUse.empty()) {
            auto resp = drogon::HttpResponse::newHttpJsonResponse(
                makeErrorPayload("This SSH connection is still attached to a project")
            );
            resp->setStatusCode(drogon::k409Conflict);
            callback(resp);
            return;
        }

        auto result = txn.exec_params(
            "DELETE FROM ssh_connections WHERE id = $1 AND user_id = $2 RETURNING id",
            id,
            userId
        );
        txn.commit();

        if (result.empty()) {
            auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("SSH connection not found"));
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp);
            return;
        }

        Json::Value payload;
        payload["message"] = "SSH connection deleted";
        callback(drogon::HttpResponse::newHttpJsonResponse(payload));
    } catch (const std::exception& e) {
        spdlog::error("Delete SSH connection error: {}", e.what());
        auto resp = drogon::HttpResponse::newHttpJsonResponse(makeErrorPayload("Internal server error"));
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

} // namespace stackpilot
