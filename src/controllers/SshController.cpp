// ============================================================
// SshController.cpp - Saved SSH/VPS connection management API
// ============================================================

#include "SshController.h"
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
    return output;
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
            "SELECT id, name, COALESCE(connection_type, 'ssh') AS connection_type, host, port, username, auth_type, last_tested_at, created_at, updated_at "
            "FROM ssh_connections WHERE user_id = $1 ORDER BY created_at DESC",
            userId
        );
        txn.commit();

        Json::Value connections(Json::arrayValue);
        for (const auto& row : rows) {
            connections.append(toConnectionJson(row));
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
        auto provisionResult = sshService.provisionLightweightKubernetesHost(config, sudoPassword);

        Json::Value payload;
        payload["success"] = provisionResult.success;
        payload["details"] = provisionResult.output;
        payload["message"] = provisionResult.success ? "Lightweight Kubernetes prepared" : "Kubernetes preparation failed";
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

        const std::string clusterName = safeClusterName(requestedClusterName, connectionName);
        const std::string encryptedToken = TokenCrypto::encrypt(nodeToken);
        pqxx::work writeTxn(*conn);
        auto clusterRows = writeTxn.exec_params(
            "INSERT INTO kubernetes_clusters (user_id, name, provider, control_plane_connection_id, server_url, join_token_encrypted, status, last_status) "
            "VALUES ($1, $2, 'k3s', $3, $4, $5, 'ready', $6) "
            "ON CONFLICT (user_id, name) DO UPDATE SET "
            "control_plane_connection_id = EXCLUDED.control_plane_connection_id, "
            "server_url = EXCLUDED.server_url, join_token_encrypted = EXCLUDED.join_token_encrypted, "
            "status = 'ready', last_status = EXCLUDED.last_status, updated_at = NOW() "
            "RETURNING id, name, provider, server_url, status, created_at, updated_at",
            userId,
            clusterName,
            id,
            serverUrl,
            encryptedToken,
            redactedDetails
        );
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

        const std::string clusterId = clusterRows[0]["id"].as<std::string>();
        const std::string clusterName = clusterRows[0]["name"].as<std::string>();
        const std::string serverUrl = clusterRows[0]["server_url"].as<std::string>();
        const std::string nodeToken = TokenCrypto::decrypt(clusterRows[0]["join_token_encrypted"].as<std::string>());
        const SshConnectionConfig workerConfig = rowToConfig(workerRows[0]);
        readTxn.commit();

        SshService sshService;
        auto joinResult = sshService.joinK3sWorker(workerConfig, serverUrl, nodeToken, sudoPassword);
        const std::string redactedDetails = redactClusterToken(joinResult.output);

        pqxx::work writeTxn(*conn);
        writeTxn.exec_params(
            "INSERT INTO kubernetes_cluster_nodes (cluster_id, connection_id, role, status, last_status, joined_at) "
            "VALUES ($1, $2, 'agent', $3, $4, CASE WHEN $3 = 'ready' THEN NOW() ELSE NULL END) "
            "ON CONFLICT (cluster_id, connection_id) DO UPDATE SET "
            "role = 'agent', status = EXCLUDED.status, last_status = EXCLUDED.last_status, "
            "joined_at = CASE WHEN EXCLUDED.status = 'ready' THEN NOW() ELSE kubernetes_cluster_nodes.joined_at END, updated_at = NOW()",
            clusterId,
            workerConnectionId,
            joinResult.success ? "ready" : "failed",
            redactedDetails
        );
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
            "SELECT id FROM projects WHERE user_id = $1 AND ssh_connection_id = $2 LIMIT 1",
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
