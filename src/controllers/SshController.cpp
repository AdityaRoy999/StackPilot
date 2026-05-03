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

namespace aids {

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
        ? "tailscale"
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
            if (equals == std::string::npos || line.rfind("__AIDS_", 0) == 0) {
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
        auto provisionResult = sshService.provisionDockerHost(config);

        Json::Value payload;
        payload["success"] = provisionResult.success;
        payload["details"] = provisionResult.output;
        payload["message"] = provisionResult.success ? "Docker host prepared" : "Docker host preparation failed";
        if (!provisionResult.error.empty()) {
            if (provisionResult.success) {
                payload["warning"] = provisionResult.error;
            } else {
                payload["error"] = provisionResult.error;
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
        auto provisionResult = sshService.provisionLightweightKubernetesHost(config);

        Json::Value payload;
        payload["success"] = provisionResult.success;
        payload["details"] = provisionResult.output;
        payload["message"] = provisionResult.success ? "Lightweight Kubernetes prepared" : "Kubernetes preparation failed";
        if (!provisionResult.error.empty()) {
            payload[provisionResult.success ? "warning" : "error"] = provisionResult.error;
            if (!provisionResult.success &&
                provisionResult.error.find("root or passwordless sudo") != std::string::npos) {
                payload["hint"] = "Tailscale SSH or passwordless login only authenticates the SSH session. Installing k3s still needs root or passwordless sudo on the remote Linux host.";
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

} // namespace aids
