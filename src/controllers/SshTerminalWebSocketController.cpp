// ============================================================
// SshTerminalWebSocketController.cpp - Interactive SSH PTY bridge
// ============================================================

#include "SshTerminalWebSocketController.h"
#include "../db/Database.h"
#include "../utils/JwtHelper.h"
#include "../utils/TokenCrypto.h"

#include <fcntl.h>
#include <json/json.h>
#include <pqxx/pqxx>
#include <pty.h>
#include <signal.h>
#include <spdlog/spdlog.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <vector>

namespace stackpilot {

namespace {

struct SshTerminalConfig {
    std::string connectionType = "ssh";
    std::string host;
    int port = 22;
    std::string username;
    std::string authType;
    std::string password;
    std::string privateKey;
    std::string knownHostsEntry;
};

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

std::string toLower(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return value;
}

bool hasUnsafeShellCharacters(const std::string& value) {
    static const std::string dangerous = "\"';&|<>`$";
    for (char c : value) {
        if (std::iscntrl(static_cast<unsigned char>(c)) || dangerous.find(c) != std::string::npos) {
            return true;
        }
    }
    return false;
}

bool isValidRemotePath(const std::string& path) {
    const std::string cleaned = trim(path);
    return !cleaned.empty() && cleaned.front() == '/' && !hasUnsafeShellCharacters(cleaned);
}

bool isTailscaleConnection(const SshTerminalConfig& config) {
    return toLower(trim(config.connectionType)) == "tailscale" ||
           toLower(trim(config.authType)) == "tailscale";
}

std::string shellQuote(const std::string& value) {
    std::string out = "'";
    for (char c : value) {
        if (c == '\'') {
            out += "'\\''";
        } else {
            out.push_back(c);
        }
    }
    out.push_back('\'');
    return out;
}

void sendJson(const drogon::WebSocketConnectionPtr& conn,
              const std::string& type,
              const std::string& message) {
    Json::Value payload;
    payload["type"] = type;
    payload["message"] = message;
    Json::StreamWriterBuilder writer;
    writer["indentation"] = "";
    conn->send(Json::writeString(writer, payload));
}

SshTerminalConfig rowToConfig(const pqxx::row& row) {
    SshTerminalConfig config;
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
    config.knownHostsEntry = row["known_hosts_entry"].is_null()
        ? ""
        : row["known_hosts_entry"].as<std::string>();
    return config;
}

bool loadOwnedConfig(const std::string& connectionId,
                     const std::string& userId,
                     SshTerminalConfig& config) {
    auto& db = Database::getInstance();
    auto conn = db.getConnection();
    pqxx::work txn(*conn);
    auto rows = txn.exec_params(
        "SELECT COALESCE(connection_type, 'ssh') AS connection_type, host, port, username, auth_type, password_encrypted, private_key_encrypted, known_hosts_entry "
        "FROM ssh_connections WHERE id = $1 AND user_id = $2",
        connectionId,
        userId
    );
    txn.commit();
    if (rows.empty()) {
        return false;
    }
    config = rowToConfig(rows[0]);
    return true;
}

std::string makeSessionDir() {
    const char* rootEnv = std::getenv("SSH_SESSION_DIR");
    const std::filesystem::path root = rootEnv && *rootEnv ? rootEnv : "uploads/ssh";
    std::filesystem::create_directories(root);
    const auto dir = root / ("pty-" + std::to_string(::getpid()) + "-" + std::to_string(std::time(nullptr)) + "-" + std::to_string(std::rand()));
    std::filesystem::create_directories(dir);
    return dir.string();
}

std::vector<std::string> buildSshArgs(const SshTerminalConfig& config,
                                      const std::string& knownHostsPath,
                                      const std::string& privateKeyPath,
                                      const std::string& cwd) {
    std::vector<std::string> args;
    if (trim(config.authType) == "password" && !isTailscaleConnection(config)) {
        args.push_back("sshpass");
        args.push_back("-e");
    }

    args.push_back("ssh");
    args.push_back("-tt");
    args.push_back("-p");
    args.push_back(std::to_string(config.port));
    args.push_back("-o");
    args.push_back("BatchMode=no");
    args.push_back("-o");
    args.push_back(std::string("StrictHostKeyChecking=") + (isTailscaleConnection(config) ? "accept-new" : "yes"));
    args.push_back("-o");
    args.push_back("UserKnownHostsFile=" + knownHostsPath);
    args.push_back("-o");
    args.push_back("ConnectTimeout=15");
    args.push_back("-o");
    args.push_back("ServerAliveInterval=30");
    args.push_back("-o");
    args.push_back("ServerAliveCountMax=2");
    if (!privateKeyPath.empty()) {
        args.push_back("-i");
        args.push_back(privateKeyPath);
    }
    args.push_back(config.username + "@" + config.host);
    args.push_back("cd " + shellQuote(cwd) + " 2>/dev/null || cd ~; "
                   "export TERM=xterm-256color; "
                   "if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi");
    return args;
}

void execSsh(const std::vector<std::string>& args, const std::string& password) {
    if (!password.empty()) {
        setenv("SSHPASS", password.c_str(), 1);
    }

    std::vector<char*> argv;
    argv.reserve(args.size() + 1);
    for (const auto& arg : args) {
        argv.push_back(const_cast<char*>(arg.c_str()));
    }
    argv.push_back(nullptr);
    execvp(argv[0], argv.data());
    _exit(127);
}

} // namespace

void SshTerminalWebSocketController::handleNewConnection(
    const drogon::HttpRequestPtr& req,
    const drogon::WebSocketConnectionPtr& conn
) {
    const auto payload = JwtHelper::verifyRequestToken(req);
    if (payload.isNull()) {
        sendJson(conn, "error", "Unauthorized terminal session");
        conn->forceClose();
        return;
    }

    const std::string userId = payload["user_id"].asString();
    const std::string connectionId = req->getParameter("connectionId");
    const std::string cwd = req->getParameter("cwd").empty() ? "/home" : req->getParameter("cwd");
    if (connectionId.empty() || !isValidRemotePath(cwd)) {
        sendJson(conn, "error", "Invalid SSH terminal request");
        conn->forceClose();
        return;
    }

    try {
        SshTerminalConfig config;
        if (!loadOwnedConfig(connectionId, userId, config)) {
            sendJson(conn, "error", "SSH connection not found");
            conn->forceClose();
            return;
        }

        const std::string connectionType = toLower(trim(config.connectionType.empty() ? "ssh" : config.connectionType));
        if (connectionType != "ssh" && connectionType != "tailscale" && connectionType != "headscale") {
            sendJson(conn, "error", "Unsupported SSH connection type");
            conn->forceClose();
            return;
        }
        if (trim(config.host).empty() || trim(config.username).empty() ||
            hasUnsafeShellCharacters(config.host) || hasUnsafeShellCharacters(config.username) ||
            config.port < 1 || config.port > 65535) {
            sendJson(conn, "error", "Saved SSH connection is invalid");
            conn->forceClose();
            return;
        }

        auto session = std::make_shared<TerminalSession>();
        session->tempDir = makeSessionDir();
        const std::string knownHostsPath = (std::filesystem::path(session->tempDir) / "known_hosts").string();
        {
            std::ofstream out(knownHostsPath, std::ios::trunc);
            out << config.knownHostsEntry;
            if (!config.knownHostsEntry.empty() && config.knownHostsEntry.back() != '\n') {
                out << "\n";
            }
        }

        std::string privateKeyPath;
        if (trim(config.authType) == "key") {
            privateKeyPath = (std::filesystem::path(session->tempDir) / "id_key").string();
            std::ofstream keyOut(privateKeyPath, std::ios::trunc);
            keyOut << config.privateKey;
            keyOut.close();
            chmod(privateKeyPath.c_str(), S_IRUSR | S_IWUSR);
        }

        struct winsize ws {};
        ws.ws_col = 120;
        ws.ws_row = 32;
        const std::vector<std::string> args = buildSshArgs(config, knownHostsPath, privateKeyPath, cwd);
        const pid_t child = forkpty(&session->masterFd, nullptr, nullptr, &ws);
        if (child < 0) {
            sendJson(conn, "error", "Unable to create SSH terminal");
            conn->forceClose();
            closeSession(session);
            return;
        }
        if (child == 0) {
            execSsh(args, trim(config.authType) == "password" && !isTailscaleConnection(config) ? config.password : "");
        }

        session->childPid = child;
        conn->setContext(session);
        sendJson(conn, "ready", "SSH terminal connected");

        session->reader = std::thread([conn, session]() {
            char buffer[4096];
            while (!session->closed.load()) {
                const ssize_t readBytes = ::read(session->masterFd, buffer, sizeof(buffer));
                if (readBytes > 0) {
                    conn->send(std::string(buffer, static_cast<size_t>(readBytes)));
                    continue;
                }
                break;
            }
            if (!session->closed.exchange(true)) {
                sendJson(conn, "closed", "SSH terminal closed");
                conn->shutdown();
            }
        });

        spdlog::info("SSH terminal opened for connection {}", connectionId);
    } catch (const std::exception& e) {
        spdlog::error("SSH terminal open error: {}", e.what());
        sendJson(conn, "error", "Unable to open SSH terminal");
        conn->forceClose();
    }
}

void SshTerminalWebSocketController::handleNewMessage(
    const drogon::WebSocketConnectionPtr& conn,
    std::string&& message,
    const drogon::WebSocketMessageType& type
) {
    if (type != drogon::WebSocketMessageType::Text &&
        type != drogon::WebSocketMessageType::Binary) {
        return;
    }

    auto session = conn->getContext<TerminalSession>();
    if (!session || session->closed.load() || session->masterFd < 0) {
        return;
    }

    if (type == drogon::WebSocketMessageType::Text && message.rfind("{", 0) == 0) {
        Json::CharReaderBuilder reader;
        Json::Value payload;
        std::string errs;
        std::istringstream stream(message);
        if (Json::parseFromStream(reader, stream, &payload, &errs) &&
            payload.isMember("type") && payload["type"].asString() == "resize") {
            struct winsize ws {};
            ws.ws_col = static_cast<unsigned short>(std::clamp(payload.get("cols", 120).asInt(), 40, 240));
            ws.ws_row = static_cast<unsigned short>(std::clamp(payload.get("rows", 32).asInt(), 10, 80));
            ioctl(session->masterFd, TIOCSWINSZ, &ws);
            if (session->childPid > 0) {
                kill(session->childPid, SIGWINCH);
            }
            return;
        }
    }

    std::lock_guard<std::mutex> lock(session->writeMutex);
    const char* data = message.data();
    size_t remaining = message.size();
    while (remaining > 0) {
        const ssize_t written = ::write(session->masterFd, data, remaining);
        if (written <= 0) {
            break;
        }
        data += written;
        remaining -= static_cast<size_t>(written);
    }
}

void SshTerminalWebSocketController::handleConnectionClosed(const drogon::WebSocketConnectionPtr& conn) {
    auto session = conn->getContext<TerminalSession>();
    closeSession(session);
}

void SshTerminalWebSocketController::closeSession(const std::shared_ptr<TerminalSession>& session) {
    if (!session || session->closed.exchange(true)) {
        return;
    }

    if (session->childPid > 0) {
        kill(session->childPid, SIGHUP);
        kill(session->childPid, SIGTERM);
        int status = 0;
        waitpid(session->childPid, &status, WNOHANG);
    }
    if (session->masterFd >= 0) {
        ::close(session->masterFd);
        session->masterFd = -1;
    }
    if (session->reader.joinable()) {
        session->reader.detach();
    }
    if (!session->tempDir.empty()) {
        std::error_code ec;
        std::filesystem::remove_all(session->tempDir, ec);
    }
}

} // namespace stackpilot
