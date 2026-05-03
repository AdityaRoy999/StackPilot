// ============================================================
// SshService.cpp - Encrypted SSH/VPS connectivity helpers
// ============================================================

#include "SshService.h"

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <sys/stat.h>
#include <sys/wait.h>

namespace aids {

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

bool hasShellUnsafeCharacters(const std::string& value) {
    static const std::string dangerous = "\"';&|<>`$";
    for (char c : value) {
        if (std::iscntrl(static_cast<unsigned char>(c)) || dangerous.find(c) != std::string::npos) {
            return true;
        }
    }
    return false;
}

bool isValidDockerName(const std::string& value) {
    if (value.empty() || value.size() > 128) {
        return false;
    }
    for (char c : value) {
        const bool ok = std::isalnum(static_cast<unsigned char>(c)) ||
                        c == '_' || c == '.' || c == '-';
        if (!ok) {
            return false;
        }
    }
    return true;
}

bool isValidDockerImageRef(const std::string& value) {
    const std::string cleaned = trim(value);
    if (cleaned.empty() || cleaned.size() > 255) {
        return false;
    }
    for (char c : cleaned) {
        const bool ok = std::isalnum(static_cast<unsigned char>(c)) ||
                        c == '_' || c == '.' || c == '-' || c == '/' ||
                        c == ':' || c == '@';
        if (!ok) {
            return false;
        }
    }
    return true;
}

int countRolloutHistoryRevisions(const std::string& output) {
    std::istringstream stream(output);
    std::string line;
    int count = 0;
    while (std::getline(stream, line)) {
        const std::string cleaned = trim(line);
        if (!cleaned.empty() && std::isdigit(static_cast<unsigned char>(cleaned.front()))) {
            ++count;
        }
    }
    return count;
}

bool isValidRemoteCommand(const std::string& value) {
    const std::string cleaned = trim(value);
    if (cleaned.empty() || cleaned.size() > 6000) {
        return false;
    }
    for (char c : cleaned) {
        if (std::iscntrl(static_cast<unsigned char>(c)) && c != '\n' && c != '\t') {
            return false;
        }
    }
    return true;
}

bool isValidCloneTargetDirectory(const std::string& value) {
    const std::string cleaned = trim(value);
    if (cleaned.empty()) {
        return true;
    }
    if (cleaned == "." || cleaned == ".." || cleaned.find('/') != std::string::npos) {
        return false;
    }
    return !hasShellUnsafeCharacters(cleaned);
}

bool isSupportedGitUrl(const std::string& value) {
    const std::string cleaned = trim(value);
    return cleaned.starts_with("https://") ||
           cleaned.starts_with("http://") ||
           cleaned.starts_with("git@");
}

void capOutput(std::string& output, size_t maxBytes = 120000) {
    if (output.size() <= maxBytes) {
        return;
    }
    output = output.substr(output.size() - maxBytes);
    output.insert(0, "[output truncated to last " + std::to_string(maxBytes) + " bytes]\n");
}

std::string toLower(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return value;
}

bool isTailscaleConnection(const SshConnectionConfig& config) {
    const std::string connectionType = toLower(trim(config.connectionType));
    const std::string authType = toLower(trim(config.authType));
    return connectionType == "tailscale" || connectionType == "headscale" ||
           authType == "tailscale" || authType == "headscale";
}

bool looksLikeTailscaleHost(const std::string& host) {
    const std::string cleaned = toLower(trim(host));
    if (cleaned.empty()) {
        return false;
    }

    if (cleaned.size() > 7 && cleaned.ends_with(".ts.net")) {
        return true;
    }

    std::stringstream stream(cleaned);
    std::string first;
    std::string second;
    if (std::getline(stream, first, '.') && std::getline(stream, second, '.')) {
        try {
            const int firstOctet = std::stoi(first);
            const int secondOctet = std::stoi(second);
            return firstOctet == 100 && secondOctet >= 64 && secondOctet <= 127;
        } catch (...) {
            return false;
        }
    }

    return cleaned.find(".") == std::string::npos;
}

bool isValidDnsLabelValue(const std::string& value) {
    const std::string cleaned = trim(value);
    if (cleaned.empty() || cleaned.size() > 63) {
        return false;
    }
    if (!std::isalnum(static_cast<unsigned char>(cleaned.front())) ||
        !std::isalnum(static_cast<unsigned char>(cleaned.back()))) {
        return false;
    }
    for (char c : cleaned) {
        const bool ok = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-';
        if (!ok) {
            return false;
        }
    }
    return true;
}

struct RuntimeResourcePreset {
    std::string cpuRequest;
    std::string memoryRequest;
    std::string cpuLimit;
    std::string memoryLimit;
};

RuntimeResourcePreset runtimeResourcePresetFor(const std::string& requested) {
    const std::string normalized = toLower(trim(requested));
    if (normalized == "medium") {
        return {"250m", "256Mi", "1000m", "1Gi"};
    }
    if (normalized == "large") {
        return {"500m", "512Mi", "2000m", "2Gi"};
    }
    return {"100m", "128Mi", "500m", "512Mi"};
}

std::string sanitizeProbePathValue(std::string value) {
    value = trim(value);
    if (value.empty()) {
        return "/";
    }
    if (value.front() != '/') {
        value.insert(value.begin(), '/');
    }
    if (value.size() > 128) {
        value.resize(128);
    }
    for (char& c : value) {
        if (std::iscntrl(static_cast<unsigned char>(c)) || c == '"' || c == '\'' || c == '\\') {
            c = '-';
        }
    }
    return value;
}

bool isValidEnvKeyValue(const std::string& value) {
    if (value.empty() || value.size() > 253) {
        return false;
    }
    if (!std::isalpha(static_cast<unsigned char>(value.front())) && value.front() != '_') {
        return false;
    }
    for (char c : value) {
        if (!std::isalnum(static_cast<unsigned char>(c)) && c != '_') {
            return false;
        }
    }
    return true;
}

void writeYamlBlockScalarValue(std::ostream& out, const std::string& key, const std::string& value) {
    out << "  " << key << ": |-\n";
    std::istringstream stream(value);
    std::string line;
    bool wroteLine = false;
    while (std::getline(stream, line)) {
        out << "    " << line << "\n";
        wroteLine = true;
    }
    if (!wroteLine) {
        out << "    \n";
    }
}

std::string sanitizeDnsLabelValue(const std::string& value) {
    std::string out;
    out.reserve(value.size());
    for (char c : value) {
        const char lowered = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        if ((lowered >= 'a' && lowered <= 'z') || (lowered >= '0' && lowered <= '9')) {
            out.push_back(lowered);
        } else if (!out.empty() && out.back() != '-') {
            out.push_back('-');
        }
    }
    while (!out.empty() && out.front() == '-') {
        out.erase(out.begin());
    }
    while (!out.empty() && out.back() == '-') {
        out.pop_back();
    }
    if (out.empty()) {
        out = "aids-runtime";
    }
    if (out.size() > 50) {
        out.resize(50);
        while (!out.empty() && out.back() == '-') {
            out.pop_back();
        }
    }
    return out;
}

std::string normalizeKubernetesExposure(const std::string& value) {
    const std::string normalized = toLower(trim(value));
    if (normalized == "ingress" || normalized == "loadbalancer" || normalized == "clusterip") {
        return normalized;
    }
    return "nodeport";
}

std::string normalizeRuntimeScheme(const std::string& value) {
    const std::string normalized = toLower(trim(value));
    return normalized == "https" ? "https" : "http";
}

std::string markerValue(const std::string& output, const std::string& key) {
    std::istringstream stream(output);
    std::string line;
    const std::string prefix = key + "=";
    while (std::getline(stream, line)) {
        if (line.rfind(prefix, 0) == 0) {
            return trim(line.substr(prefix.size()));
        }
    }
    return "";
}

int markerInt(const std::string& output, const std::string& key, int fallback = 0) {
    try {
        const std::string value = markerValue(output, key);
        return value.empty() ? fallback : std::stoi(value);
    } catch (...) {
        return fallback;
    }
}

} // namespace

SshService::SshService()
    : workspaceRoot_("uploads/ssh") {
    const char* env = std::getenv("SSH_SESSION_DIR");
    if (env && *env) {
        workspaceRoot_ = env;
    }
}

bool SshService::isValidConnectionConfig(const SshConnectionConfig& config, std::string& error) const {
    const std::string connectionType = toLower(trim(config.connectionType.empty() ? "ssh" : config.connectionType));
    if (connectionType != "ssh" && connectionType != "tailscale" && connectionType != "headscale") {
        error = "Connection type must be ssh, tailscale, or headscale";
        return false;
    }

    if (trim(config.host).empty() || hasShellUnsafeCharacters(config.host)) {
        error = "SSH host is required and contains unsupported characters";
        return false;
    }
    if (config.port < 1 || config.port > 65535) {
        error = "SSH port must be between 1 and 65535";
        return false;
    }
    if (trim(config.username).empty() || hasShellUnsafeCharacters(config.username)) {
        error = "SSH username is required and contains unsupported characters";
        return false;
    }

    if (connectionType == "tailscale" || connectionType == "headscale") {
        if (!looksLikeTailscaleHost(config.host)) {
            error = "Tailnet host must be a 100.64.0.0/10 address, MagicDNS name, or .ts.net name";
            return false;
        }
        return true;
    }

    const std::string authType = trim(config.authType);
    if (authType != "password" && authType != "key") {
        error = "SSH auth type must be password or key";
        return false;
    }

    if (authType == "password" && trim(config.password).empty()) {
        error = "SSH password is required";
        return false;
    }

    if (authType == "key" && trim(config.privateKey).empty()) {
        error = "SSH private key is required";
        return false;
    }

    if (trim(config.knownHostsEntry).empty()) {
        error = "SSH host fingerprint is missing";
        return false;
    }

    return true;
}

bool SshService::isValidRemotePath(const std::string& path) const {
    const std::string cleaned = trim(path);
    if (cleaned.empty() || cleaned.front() != '/') {
        return false;
    }
    return !hasShellUnsafeCharacters(cleaned);
}

SshOperationResult SshService::fetchKnownHostsEntry(const std::string& host, int port) const {
    SshOperationResult result;
    if (trim(host).empty() || port < 1 || port > 65535 || hasShellUnsafeCharacters(host)) {
        result.error = "Invalid SSH host or port";
        return result;
    }

    const std::string command =
        "ssh-keyscan -p " + std::to_string(port) + " -T 10 " + shellQuote(trim(host)) + " 2>/dev/null";

    std::string output;
    const int exitCode = runCommand(command, output);
    if (exitCode != 0 || trim(output).empty()) {
        result.error = "Unable to fetch SSH host fingerprint";
        result.output = output;
        return result;
    }

    result.success = true;
    result.output = output;
    return result;
}

SshService::SessionFiles SshService::prepareSessionFiles(const SshConnectionConfig& config) const {
    namespace fs = std::filesystem;

    fs::create_directories(workspaceRoot_);
    const fs::path sessionDir = fs::path(workspaceRoot_) / ("session-" + std::to_string(std::time(nullptr)) + "-" + std::to_string(std::rand()));
    fs::create_directories(sessionDir);

    SessionFiles files;
    files.knownHostsPath = (sessionDir / "known_hosts").string();
    {
        std::ofstream knownHostsOut(files.knownHostsPath, std::ios::trunc);
        knownHostsOut << config.knownHostsEntry;
        if (!config.knownHostsEntry.empty() && config.knownHostsEntry.back() != '\n') {
            knownHostsOut << "\n";
        }
    }

    if (trim(config.authType) == "key") {
        files.privateKeyPath = (sessionDir / "id_key").string();
        std::ofstream keyOut(files.privateKeyPath, std::ios::trunc);
        keyOut << config.privateKey;
        keyOut.close();
        chmod(files.privateKeyPath.c_str(), S_IRUSR | S_IWUSR);
    }

    std::ostringstream sshPrefix;
    sshPrefix
        << "ssh -p " << config.port
        << " -o BatchMode=no"
        << " -o StrictHostKeyChecking=" << (isTailscaleConnection(config) ? "accept-new" : "yes")
        << " -o UserKnownHostsFile=" << shellQuote(files.knownHostsPath)
        << " -o ConnectTimeout=15";

    const std::string authType = trim(config.authType);
    if (authType == "password" && !isTailscaleConnection(config)) {
        sshPrefix
            << " -o PreferredAuthentications=password,keyboard-interactive"
            << " -o PasswordAuthentication=yes"
            << " -o KbdInteractiveAuthentication=yes"
            << " -o ChallengeResponseAuthentication=yes"
            << " -o PubkeyAuthentication=no"
            << " -o NumberOfPasswordPrompts=1";
    } else if (authType == "key") {
        sshPrefix
            << " -o PreferredAuthentications=publickey"
            << " -o PasswordAuthentication=no";
    }

    if (!files.privateKeyPath.empty()) {
        sshPrefix << " -i " << shellQuote(files.privateKeyPath);
    }

    sshPrefix << " " << shellQuote(config.username + "@" + config.host);
    files.sshPrefix = sshPrefix.str();

    if (authType == "password" && !isTailscaleConnection(config)) {
        files.sshpassPrefix = "SSHPASS=" + shellQuote(config.password) + " sshpass -e ";
    }

    return files;
}

void SshService::cleanupSessionFiles(const SessionFiles& files) const {
    namespace fs = std::filesystem;
    std::error_code ec;
    if (!files.privateKeyPath.empty()) {
        fs::remove(files.privateKeyPath, ec);
    }
    if (!files.knownHostsPath.empty()) {
        const fs::path parent = fs::path(files.knownHostsPath).parent_path();
        fs::remove(files.knownHostsPath, ec);
        fs::remove_all(parent, ec);
    }
}

SshOperationResult SshService::testConnection(const SshConnectionConfig& config) const {
    SshOperationResult result;
    std::string error;
    if (!isValidConnectionConfig(config, error)) {
        result.error = error;
        return result;
    }

    const SessionFiles files = prepareSessionFiles(config);
    const std::string command =
        "timeout 35s sh -lc " +
        shellQuote(files.sshpassPrefix + files.sshPrefix + " " + shellQuote("printf __AIDS_SSH_OK__"));

    std::string output;
    const int exitCode = runCommand(command, output);
    cleanupSessionFiles(files);

    if (exitCode != 0 || output.find("__AIDS_SSH_OK__") == std::string::npos) {
        if (isTailscaleConnection(config) && output.find("login.tailscale.com") != std::string::npos) {
            result.error = "Tailscale SSH requires browser approval. Visit the Tailscale URL shown in details, then retry.";
        } else if (output.find("Permission denied") != std::string::npos) {
            result.error = "SSH password was rejected by the remote host";
        } else if (output.find("REMOTE HOST IDENTIFICATION HAS CHANGED") != std::string::npos ||
                   output.find("Host key verification failed") != std::string::npos) {
            result.error = "SSH host fingerprint verification failed. Delete and recreate this connection to trust the current host key.";
        } else if (output.find("Connection timed out") != std::string::npos ||
                   output.find("No route to host") != std::string::npos ||
                   output.find("Connection refused") != std::string::npos) {
            result.error = "SSH server is not reachable from the AIDS backend container";
        } else if (output.find("Too many authentication failures") != std::string::npos) {
            result.error = "SSH authentication failed before password login was accepted";
        } else {
            result.error = "SSH connection test failed";
        }
        result.output = output;
        return result;
    }

    result.success = true;
    result.output = output;
    return result;
}

SshOperationResult SshService::listDirectory(const SshConnectionConfig& config,
                                            const std::string& remotePath,
                                            std::vector<SshDirectoryEntry>& entries) const {
    SshOperationResult result;
    std::string error;
    if (!isValidConnectionConfig(config, error)) {
        result.error = error;
        return result;
    }
    if (!isValidRemotePath(remotePath)) {
        result.error = "Remote path must be an absolute Linux path";
        return result;
    }

    const SessionFiles files = prepareSessionFiles(config);
    const std::string remoteCommand =
        "set -e; target=" + shellQuote(remotePath) +
        "; [ -d \"$target\" ] || { echo __AIDS_INVALID_PATH__; exit 9; }; " \
        "for path in \"$target\"/* \"$target\"/.[!.]* \"$target\"/..?*; do "
        "[ -e \"$path\" ] || continue; "
        "name=${path##*/}; "
        "[ \"$name\" = '.' ] || [ \"$name\" = '..' ] && continue; "
        "if [ -d \"$path\" ]; then kind=d; else kind=f; fi; "
        "printf '%s\\t%s\\n' \"$name\" \"$kind\"; "
        "done | sort";
    const std::string command =
        files.sshpassPrefix + files.sshPrefix + " " + shellQuote(remoteCommand);

    std::string output;
    const int exitCode = runCommand(command, output);
    cleanupSessionFiles(files);

    if (exitCode != 0) {
        result.error = output.find("__AIDS_INVALID_PATH__") != std::string::npos
            ? "Remote path does not exist or is not a directory"
            : "Failed to list remote directory";
        result.output = output;
        return result;
    }

    std::istringstream stream(output);
    std::string line;
    while (std::getline(stream, line)) {
        const auto tab = line.find('\t');
        if (tab == std::string::npos) {
            continue;
        }

        SshDirectoryEntry entry;
        entry.name = line.substr(0, tab);
        entry.directory = tab + 1 < line.size() && line[tab + 1] == 'd';
        if (!entry.name.empty()) {
            entries.push_back(entry);
        }
    }

    result.success = true;
    result.output = output;
    return result;
}

SshOperationResult SshService::syncDirectory(const SshConnectionConfig& config,
                                            const std::string& remotePath,
                                            const std::string& localDestination,
                                            int timeoutSeconds,
                                            SshLogCallback onLogLine) const {
    SshOperationResult result;
    std::string error;
    if (!isValidConnectionConfig(config, error)) {
        result.error = error;
        return result;
    }
    if (!isValidRemotePath(remotePath)) {
        result.error = "Remote path must be an absolute Linux path";
        return result;
    }

    namespace fs = std::filesystem;
    fs::create_directories(localDestination);
    const SessionFiles files = prepareSessionFiles(config);
    const std::string remoteCommand =
        "set -e; target=" + shellQuote(remotePath) +
        "; [ -d \"$target\" ] || { echo __AIDS_INVALID_PATH__; exit 9; }; " \
        "cd \"$target\" && tar --exclude=.git --exclude=node_modules --exclude=.next --exclude=dist --exclude=build -cf - .";

    const std::string command =
        "timeout " + std::to_string(std::max(30, timeoutSeconds)) + "s sh -lc " +
        shellQuote(files.sshpassPrefix + files.sshPrefix + " " + shellQuote(remoteCommand) +
                   " | tar -xf - -C " + shellQuote(localDestination) + " 2>&1");

    std::string output;
    const int exitCode = runCommand(command, output);
    cleanupSessionFiles(files);

    if (!output.empty() && onLogLine) {
        std::istringstream stream(output);
        std::string line;
        while (std::getline(stream, line)) {
            if (!trim(line).empty()) {
                onLogLine(line);
            }
        }
    }

    if (exitCode != 0) {
        result.error = output.find("__AIDS_INVALID_PATH__") != std::string::npos
            ? "Remote path does not exist or is not a directory"
            : (exitCode == 124 ? "SSH sync timed out" : "Failed to sync source from SSH");
        result.output = output;
        return result;
    }

    result.success = true;
    result.output = output;
    return result;
}

SshOperationResult SshService::probeHost(const SshConnectionConfig& config) const {
    SshOperationResult result;
    std::string error;
    if (!isValidConnectionConfig(config, error)) {
        result.error = error;
        return result;
    }

    const SessionFiles files = prepareSessionFiles(config);
    const std::string remoteCommand =
        "set +e; "
        "echo __AIDS_PROBE_START__; "
        "printf 'os='; uname -srm 2>/dev/null || true; "
        "printf 'user='; id -un 2>/dev/null || true; "
        "printf 'uid='; id -u 2>/dev/null || true; "
        "printf 'docker_cli='; command -v docker >/dev/null 2>&1 && echo yes || echo no; "
        "printf 'docker_daemon='; docker info >/dev/null 2>&1 && echo yes || echo no; "
        "printf 'docker_compose='; (docker compose version >/dev/null 2>&1 || command -v docker-compose >/dev/null 2>&1) && echo yes || echo no; "
        "printf 'kubectl='; command -v kubectl >/dev/null 2>&1 && echo yes || echo no; "
        "printf 'kubernetes_ready='; kubectl version --client >/dev/null 2>&1 && kubectl get nodes >/dev/null 2>&1 && echo yes || echo no; "
        "printf 'sudo_passwordless='; sudo -n true >/dev/null 2>&1 && echo yes || echo no; "
        "printf 'disk='; df -Pk / 2>/dev/null | awk 'NR==2 {print $4 \"KB_free\"}' || true; "
        "printf 'memory='; awk '/MemAvailable/ {print $2 \"KB_available\"}' /proc/meminfo 2>/dev/null || true; "
        "echo __AIDS_PROBE_END__";
    const std::string command =
        "timeout 35s sh -lc " +
        shellQuote(files.sshpassPrefix + files.sshPrefix + " " + shellQuote(remoteCommand));

    std::string output;
    const int exitCode = runCommand(command, output);
    cleanupSessionFiles(files);

    if (exitCode != 0 || output.find("__AIDS_PROBE_START__") == std::string::npos) {
        result.error = isTailscaleConnection(config) && output.find("login.tailscale.com") != std::string::npos
            ? "Tailscale SSH requires browser approval. Approve the session, then retry the probe."
            : "Failed to probe remote host capabilities";
        result.output = output;
        return result;
    }

    result.success = true;
    result.output = output;
    return result;
}

SshOperationResult SshService::provisionDockerHost(const SshConnectionConfig& config) const {
    SshOperationResult result;
    std::string error;
    if (!isValidConnectionConfig(config, error)) {
        result.error = error;
        return result;
    }

    const SessionFiles files = prepareSessionFiles(config);
    const std::string remoteCommand =
        "set -e; "
        "echo __AIDS_PROVISION_DOCKER_START__; "
        "if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then "
        "  echo docker_status=ready; echo __AIDS_PROVISION_DOCKER_DONE__; exit 0; "
        "fi; "
        "if [ \"$(id -u)\" -ne 0 ] && ! sudo -n true >/dev/null 2>&1; then "
        "  echo __AIDS_SUDO_REQUIRED__; exit 20; "
        "fi; "
        "SUDO=''; [ \"$(id -u)\" -eq 0 ] || SUDO='sudo -n'; "
        "if command -v apt-get >/dev/null 2>&1; then "
        "  echo package_manager=apt; "
        "  $SUDO apt-get update -y; "
        "  DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y docker.io docker-compose-plugin; "
        "elif command -v dnf >/dev/null 2>&1; then "
        "  echo package_manager=dnf; "
        "  $SUDO dnf install -y docker docker-compose-plugin; "
        "elif command -v yum >/dev/null 2>&1; then "
        "  echo package_manager=yum; "
        "  $SUDO yum install -y docker docker-compose-plugin; "
        "elif command -v pacman >/dev/null 2>&1; then "
        "  echo package_manager=pacman; "
        "  $SUDO pacman -Sy --noconfirm docker docker-compose; "
        "else "
        "  echo __AIDS_UNSUPPORTED_PACKAGE_MANAGER__; exit 21; "
        "fi; "
        "($SUDO systemctl enable --now docker >/dev/null 2>&1 || $SUDO service docker start >/dev/null 2>&1 || true); "
        "$SUDO usermod -aG docker \"$(id -un)\" >/dev/null 2>&1 || true; "
        "if docker info >/dev/null 2>&1; then "
        "  echo docker_status=ready; "
        "elif $SUDO docker info >/dev/null 2>&1; then "
        "  echo __AIDS_DOCKER_RELOGIN_REQUIRED__; "
        "else "
        "  echo __AIDS_DOCKER_DAEMON_DOWN__; exit 22; "
        "fi; "
        "docker --version 2>/dev/null || true; "
        "echo __AIDS_PROVISION_DOCKER_DONE__";

    const std::string command =
        "timeout 600s sh -lc " +
        shellQuote(files.sshpassPrefix + files.sshPrefix + " " + shellQuote(remoteCommand));

    std::string output;
    const int exitCode = runCommand(command, output);
    cleanupSessionFiles(files);

    result.exitCode = exitCode;
    result.output = output;
    if (exitCode != 0 || output.find("__AIDS_PROVISION_DOCKER_DONE__") == std::string::npos) {
        if (output.find("__AIDS_SUDO_REQUIRED__") != std::string::npos) {
            result.error = "Docker provisioning requires root or passwordless sudo on the remote host";
        } else if (output.find("__AIDS_UNSUPPORTED_PACKAGE_MANAGER__") != std::string::npos) {
            result.error = "Unsupported Linux package manager. Install Docker manually, then probe again.";
        } else if (output.find("__AIDS_DOCKER_DAEMON_DOWN__") != std::string::npos) {
            result.error = "Docker was installed, but the daemon is not reachable";
        } else if (exitCode == 124) {
            result.error = "Docker provisioning timed out";
        } else {
            result.error = "Docker provisioning failed";
        }
        return result;
    }

    result.success = true;
    if (output.find("__AIDS_DOCKER_RELOGIN_REQUIRED__") != std::string::npos) {
        result.error = "Docker is installed, but this user may need to reconnect before docker commands work without sudo";
    }
    return result;
}

SshOperationResult SshService::provisionLightweightKubernetesHost(const SshConnectionConfig& config) const {
    SshOperationResult result;
    std::string error;
    if (!isValidConnectionConfig(config, error)) {
        result.error = error;
        return result;
    }

    const SessionFiles files = prepareSessionFiles(config);
    const std::string remoteCommand =
        "set -e; "
        "echo __AIDS_PROVISION_K8S_START__; "
        "if (command -v kubectl >/dev/null 2>&1 && kubectl get nodes >/dev/null 2>&1) || "
        "   (command -v k3s >/dev/null 2>&1 && (k3s kubectl get nodes >/dev/null 2>&1 || sudo -n k3s kubectl get nodes >/dev/null 2>&1)); then "
        "  echo kubernetes_status=ready; echo __AIDS_PROVISION_K8S_DONE__; exit 0; "
        "fi; "
        "if [ \"$(id -u)\" -ne 0 ] && ! sudo -n true >/dev/null 2>&1; then "
        "  echo __AIDS_SUDO_REQUIRED__; exit 20; "
        "fi; "
        "command -v curl >/dev/null 2>&1 || { echo __AIDS_CURL_MISSING__; exit 21; }; "
        "SUDO=''; [ \"$(id -u)\" -eq 0 ] || SUDO='sudo -n'; "
        "curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC='--secrets-encryption --write-kubeconfig-mode=644' $SUDO sh - || { echo __AIDS_K3S_INSTALL_FAILED__; exit 22; }; "
        "sleep 4; "
        "if command -v kubectl >/dev/null 2>&1; then K='kubectl'; "
        "elif [ \"$(id -u)\" -eq 0 ]; then K='k3s kubectl'; "
        "else K='sudo -n k3s kubectl'; fi; "
        "$K get nodes || { echo __AIDS_K8S_VERIFY_FAILED__; exit 23; }; "
        "$K get ingressclass >/dev/null 2>&1 || true; "
        "echo kubernetes_status=ready; "
        "echo __AIDS_PROVISION_K8S_DONE__";

    const std::string command =
        "timeout 900s sh -lc " +
        shellQuote(files.sshpassPrefix + files.sshPrefix + " " + shellQuote(remoteCommand));

    std::string output;
    const int exitCode = runCommand(command, output);
    cleanupSessionFiles(files);

    result.exitCode = exitCode;
    result.output = output;
    if (exitCode != 0 || output.find("__AIDS_PROVISION_K8S_DONE__") == std::string::npos) {
        if (output.find("__AIDS_SUDO_REQUIRED__") != std::string::npos) {
            result.error = "Lightweight Kubernetes setup requires root or passwordless sudo on the remote host";
        } else if (output.find("__AIDS_CURL_MISSING__") != std::string::npos) {
            result.error = "curl is required to install lightweight Kubernetes";
        } else if (output.find("__AIDS_K3S_INSTALL_FAILED__") != std::string::npos) {
            result.error = "k3s installation failed on the remote host";
        } else if (output.find("__AIDS_K8S_VERIFY_FAILED__") != std::string::npos) {
            result.error = "k3s installed, but the Kubernetes node did not become ready";
        } else if (exitCode == 124) {
            result.error = "Lightweight Kubernetes provisioning timed out";
        } else {
            result.error = "Lightweight Kubernetes provisioning failed";
        }
        return result;
    }

    result.success = true;
    return result;
}

SshOperationResult SshService::runRemoteCommand(const SshConnectionConfig& config,
                                                const std::string& workingDirectory,
                                                const std::string& command,
                                                int timeoutSeconds) const {
    SshOperationResult result;
    std::string error;
    if (!isValidConnectionConfig(config, error)) {
        result.error = error;
        return result;
    }
    if (!isValidRemotePath(workingDirectory)) {
        result.error = "Working directory must be an absolute Linux path";
        return result;
    }
    if (!isValidRemoteCommand(command)) {
        result.error = "Command is empty, too long, or contains unsupported control characters";
        return result;
    }

    const int boundedTimeout = std::clamp(timeoutSeconds, 5, 300);
    const SessionFiles files = prepareSessionFiles(config);
    const std::string remoteCommand =
        "set +e; "
        "target=" + shellQuote(workingDirectory) + "; "
        "[ -d \"$target\" ] || { echo __AIDS_INVALID_CWD__; exit 9; }; "
        "cd \"$target\"; "
        "export TERM=dumb CI=1; "
        "echo __AIDS_CWD__=$(pwd); "
        "(" + command + "); "
        "code=$?; echo __AIDS_EXIT_CODE__=$code; exit $code";

    const std::string wrappedCommand =
        "timeout " + std::to_string(boundedTimeout) + "s sh -lc " +
        shellQuote(files.sshpassPrefix + files.sshPrefix + " " + shellQuote(remoteCommand));

    std::string output;
    const int exitCode = runCommand(wrappedCommand, output);
    cleanupSessionFiles(files);
    capOutput(output);

    result.exitCode = exitCode;
    result.output = output;
    if (output.find("__AIDS_INVALID_CWD__") != std::string::npos) {
        result.error = "Working directory does not exist on the remote host";
        return result;
    }
    if (exitCode == 124) {
        result.error = "Remote command timed out";
        return result;
    }

    result.success = exitCode == 0;
    if (!result.success) {
        result.error = "Remote command exited with code " + std::to_string(exitCode);
    }
    return result;
}

SshOperationResult SshService::cloneGitRepository(const SshConnectionConfig& config,
                                                  const std::string& workingDirectory,
                                                  const std::string& repositoryUrl,
                                                  const std::string& targetDirectory,
                                                  int timeoutSeconds,
                                                  const std::string& gitToken) const {
    SshOperationResult result;
    std::string error;
    if (!isValidConnectionConfig(config, error)) {
        result.error = error;
        return result;
    }
    if (!isValidRemotePath(workingDirectory)) {
        result.error = "Clone destination must be an absolute Linux path";
        return result;
    }
    if (!isSupportedGitUrl(repositoryUrl) || repositoryUrl.size() > 500 || hasShellUnsafeCharacters(repositoryUrl)) {
        result.error = "Repository URL must be a supported git URL without shell control characters";
        return result;
    }
    if (!isValidCloneTargetDirectory(targetDirectory)) {
        result.error = "Target folder must be a simple folder name";
        return result;
    }

    const int boundedTimeout = std::clamp(timeoutSeconds, 30, 300);
    const SessionFiles files = prepareSessionFiles(config);
    const std::string targetArg = trim(targetDirectory).empty()
        ? ""
        : " " + shellQuote(trim(targetDirectory));
    std::string credentialSetup;
    if (!gitToken.empty() && trim(repositoryUrl).starts_with("https://github.com/")) {
        credentialSetup =
            "token_file=$(mktemp \"$target/.git-token.XXXXXX\"); "
            "askpass_file=$(mktemp \"$target/.git-askpass.XXXXXX\"); "
            "chmod 600 \"$token_file\"; "
            "printf '%s' " + shellQuote(gitToken) + " > \"$token_file\"; "
            "cat > \"$askpass_file\" <<'__AIDS_ASKPASS_EOF__'\n"
            "#!/bin/sh\n"
            "case \"$1\" in\n"
            "  *Username*) printf '%s\\n' 'x-access-token' ;;\n"
            "  *Password*) cat \"$AIDS_GIT_TOKEN_FILE\" ;;\n"
            "  *) printf '\\n' ;;\n"
            "esac\n"
            "__AIDS_ASKPASS_EOF__\n"
            "chmod 700 \"$askpass_file\"; "
            "export AIDS_GIT_TOKEN_FILE=\"$token_file\" GIT_ASKPASS=\"$askpass_file\" GIT_TERMINAL_PROMPT=0; "
            "trap 'rm -f \"$token_file\" \"$askpass_file\"' EXIT; ";
    }
    const std::string remoteCommand =
        "set -e; "
        "target=" + shellQuote(workingDirectory) + "; "
        "[ -d \"$target\" ] || { echo __AIDS_INVALID_CWD__; exit 9; }; "
        "command -v git >/dev/null 2>&1 || { echo __AIDS_GIT_MISSING__; exit 10; }; "
        "cd \"$target\"; "
        + credentialSetup +
        "git clone --progress " + shellQuote(trim(repositoryUrl)) + targetArg + "; "
        "echo __AIDS_CLONE_PATH__=$(pwd)/" + (trim(targetDirectory).empty() ? "" : shellQuote(trim(targetDirectory)));

    const std::string wrappedCommand =
        "timeout " + std::to_string(boundedTimeout) + "s sh -lc " +
        shellQuote(files.sshpassPrefix + files.sshPrefix + " " + shellQuote(remoteCommand));

    std::string output;
    const int exitCode = runCommand(wrappedCommand, output);
    cleanupSessionFiles(files);
    capOutput(output);

    result.exitCode = exitCode;
    result.output = output;
    if (exitCode != 0) {
        if (output.find("__AIDS_INVALID_CWD__") != std::string::npos) {
            result.error = "Clone destination does not exist on the remote host";
        } else if (output.find("__AIDS_GIT_MISSING__") != std::string::npos) {
            result.error = "Git is not installed on the remote host";
        } else if (exitCode == 124) {
            result.error = "Git clone timed out";
        } else {
            result.error = "Git clone failed";
        }
        return result;
    }

    result.success = true;
    return result;
}

SshOperationResult SshService::buildAndRunDockerProject(const SshConnectionConfig& config,
                                                        const std::string& remotePath,
                                                        const std::string& imageName,
                                                        const std::string& containerName,
                                                        int containerPort,
                                                        int timeoutSeconds,
                                                        const SshEnvVars& envVars,
                                                        SshLogCallback onLogLine) const {
    SshOperationResult result;
    std::string error;
    if (!isValidConnectionConfig(config, error)) {
        result.error = error;
        return result;
    }
    if (!isValidRemotePath(remotePath)) {
        result.error = "Remote path must be an absolute Linux path";
        return result;
    }
    if (containerPort < 1 || containerPort > 65535) {
        result.error = "Container port must be between 1 and 65535";
        return result;
    }

    std::ostringstream envContent;
    for (const auto& envVar : envVars) {
        envContent << envVar.first << "=" << envVar.second << "\n";
    }

    const SessionFiles files = prepareSessionFiles(config);
    const std::string envFile = ".env.aids." + containerName;
    const std::string remoteCommand =
        "set -e; "
        "target=" + shellQuote(remotePath) + "; "
        "[ -d \"$target\" ] || { echo __AIDS_INVALID_PATH__; exit 9; }; "
        "cd \"$target\"; "
        "command -v docker >/dev/null 2>&1 || { echo __AIDS_DOCKER_MISSING__; exit 10; }; "
        "docker info >/dev/null 2>&1 || { echo __AIDS_DOCKER_DAEMON_DOWN__; exit 11; }; "
        "dockerfile_arg='-f Dockerfile'; "
        "if [ ! -f Dockerfile ]; then "
        "  mkdir -p .aids; "
        "  dockerfile_arg='-f .aids/Dockerfile'; "
        "  if [ -f package.json ]; then "
        "    cat > .aids/Dockerfile <<'__AIDS_DOCKERFILE_EOF__'\n"
        "FROM node:20-alpine\n"
        "WORKDIR /app\n"
        "COPY package*.json ./\n"
        "RUN npm ci || npm install\n"
        "COPY . .\n"
        "RUN if [ -f next.config.js ] || [ -f next.config.mjs ] || [ -f next.config.ts ] || node -e \"const fs=require('fs');const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));if(!(pkg.scripts&&pkg.scripts.build)) process.exit(1)\"; then npm run build; fi\n"
        "EXPOSE 3000\n"
        "CMD [\"sh\", \"-c\", \"node -e \\\"const p=require('./package.json');process.exit(p.scripts&&p.scripts.start?0:1)\\\" && npm start || node server.js || node index.js || node app.js\"]\n"
        "__AIDS_DOCKERFILE_EOF__\n"
        "  elif [ -f requirements.txt ]; then "
        "    cat > .aids/Dockerfile <<'__AIDS_DOCKERFILE_EOF__'\n"
        "FROM python:3.12-slim\n"
        "WORKDIR /app\n"
        "COPY requirements.txt ./\n"
        "RUN pip install --no-cache-dir -r requirements.txt\n"
        "COPY . .\n"
        "EXPOSE 8000\n"
        "CMD [\"sh\", \"-c\", \"if python - <<'PY'\\nimport importlib.util,sys\\nsys.exit(0 if importlib.util.find_spec('streamlit') else 1)\\nPY\\nthen f=$(ls app.py main.py *.py 2>/dev/null | head -n1); exec streamlit run ${f:-app.py} --server.address=0.0.0.0 --server.port=8000; elif python - <<'PY'\\nimport importlib.util,sys\\nsys.exit(0 if importlib.util.find_spec('uvicorn') else 1)\\nPY\\nthen exec uvicorn app:app --host 0.0.0.0 --port 8000; else exec python $( [ -f app.py ] && echo app.py || echo main.py ); fi\"]\n"
        "__AIDS_DOCKERFILE_EOF__\n"
        "  elif [ -f pyproject.toml ]; then "
        "    cat > .aids/Dockerfile <<'__AIDS_DOCKERFILE_EOF__'\n"
        "FROM python:3.12-slim\n"
        "WORKDIR /app\n"
        "COPY . .\n"
        "RUN pip install --no-cache-dir .\n"
        "EXPOSE 8000\n"
        "CMD [\"sh\", \"-c\", \"if python - <<'PY'\\nimport importlib.util,sys\\nsys.exit(0 if importlib.util.find_spec('streamlit') else 1)\\nPY\\nthen f=$(ls app.py main.py *.py 2>/dev/null | head -n1); exec streamlit run ${f:-app.py} --server.address=0.0.0.0 --server.port=8000; elif python - <<'PY'\\nimport importlib.util,sys\\nsys.exit(0 if importlib.util.find_spec('uvicorn') else 1)\\nPY\\nthen exec uvicorn app:app --host 0.0.0.0 --port 8000; else exec python $( [ -f app.py ] && echo app.py || echo main.py ); fi\"]\n"
        "__AIDS_DOCKERFILE_EOF__\n"
        "  elif [ -f main.py ] || [ -f app.py ]; then "
        "    entry='app.py'; [ -f app.py ] || entry='main.py'; "
        "    cat > .aids/Dockerfile <<__AIDS_DOCKERFILE_EOF__\n"
        "FROM python:3.12-slim\n"
        "WORKDIR /app\n"
        "COPY . .\n"
        "EXPOSE 8000\n"
        "CMD [\"python\", \"$entry\"]\n"
        "__AIDS_DOCKERFILE_EOF__\n"
        "  elif [ -f go.mod ]; then "
        "    cat > .aids/Dockerfile <<'__AIDS_DOCKERFILE_EOF__'\n"
        "FROM golang:1.24-alpine AS build\n"
        "WORKDIR /src\n"
        "COPY go.mod go.sum* ./\n"
        "RUN go mod download\n"
        "COPY . .\n"
        "RUN CGO_ENABLED=0 GOOS=linux go build -o /app/server .\n"
        "FROM alpine:3.20\n"
        "WORKDIR /app\n"
        "COPY --from=build /app/server ./server\n"
        "EXPOSE 8080\n"
        "CMD [\"./server\"]\n"
        "__AIDS_DOCKERFILE_EOF__\n"
        "  elif [ -f CMakeLists.txt ]; then "
        "    cat > .aids/Dockerfile <<'__AIDS_DOCKERFILE_EOF__'\n"
        "FROM ubuntu:24.04\n"
        "RUN apt-get update && apt-get install -y build-essential cmake libssl-dev zlib1g-dev uuid-dev && rm -rf /var/lib/apt/lists/*\n"
        "WORKDIR /app\n"
        "COPY . .\n"
        "RUN cmake -S . -B build && cmake --build build --config Release\n"
        "CMD [\"/bin/sh\", \"-c\", \"exe=$(find build -maxdepth 4 -type f -executable | head -n1); [ -n \\\"$exe\\\" ] || { echo 'No executable found after CMake build'; exit 1; }; exec \\\"$exe\\\"\"]\n"
        "__AIDS_DOCKERFILE_EOF__\n"
        "  elif [ -f Cargo.toml ]; then "
        "    cat > .aids/Dockerfile <<'__AIDS_DOCKERFILE_EOF__'\n"
        "FROM rust:1-bookworm AS build\n"
        "WORKDIR /src\n"
        "COPY . .\n"
        "RUN cargo build --release\n"
        "FROM debian:bookworm-slim\n"
        "WORKDIR /app\n"
        "COPY --from=build /src/target/release /app/bin\n"
        "EXPOSE 8080\n"
        "CMD [\"/bin/sh\", \"-c\", \"exe=$(find /app/bin -maxdepth 1 -type f -executable | head -n1); [ -n \\\"$exe\\\" ] || { echo 'No Rust release binary found'; exit 1; }; exec \\\"$exe\\\"\"]\n"
        "__AIDS_DOCKERFILE_EOF__\n"
        "  elif [ -f pom.xml ] || [ -f build.gradle ] || [ -f build.gradle.kts ] || [ -f gradlew ]; then "
        "    cat > .aids/Dockerfile <<'__AIDS_DOCKERFILE_EOF__'\n"
        "FROM eclipse-temurin:21-jdk AS build\n"
        "WORKDIR /src\n"
        "COPY . .\n"
        "RUN if [ -f mvnw ]; then chmod +x mvnw && ./mvnw -DskipTests package; elif [ -f pom.xml ]; then apt-get update && apt-get install -y maven && mvn -DskipTests package; elif [ -f gradlew ]; then chmod +x gradlew && ./gradlew build -x test; else apt-get update && apt-get install -y gradle && gradle build -x test; fi\n"
        "FROM eclipse-temurin:21-jre\n"
        "WORKDIR /app\n"
        "COPY --from=build /src .\n"
        "EXPOSE 8080\n"
        "CMD [\"/bin/sh\", \"-c\", \"jar=$(find . -path '*/target/*.jar' -o -path '*/build/libs/*.jar' | grep -v plain | head -n1); [ -n \\\"$jar\\\" ] || { echo 'No runnable jar found'; exit 1; }; exec java -jar \\\"$jar\\\"\"]\n"
        "__AIDS_DOCKERFILE_EOF__\n"
        "  else echo __AIDS_DOCKERFILE_MISSING__; exit 12; fi; "
        "  echo 'Generated remote Dockerfile at .aids/Dockerfile'; "
        "fi; "
        "cat > " + shellQuote(envFile) + " <<'__AIDS_ENV_EOF__'\n" +
        envContent.str() +
        "__AIDS_ENV_EOF__\n"
        "cp " + shellQuote(envFile) + " .env 2>/dev/null || true; "
        "cp " + shellQuote(envFile) + " .env.local 2>/dev/null || true; "
        "cp " + shellQuote(envFile) + " .env.production.local 2>/dev/null || true; "
        "echo 'Building remote Docker image " + imageName + "'; "
        "docker build --pull=false $dockerfile_arg -t " + shellQuote(imageName) + " .; "
        "docker rm -f " + shellQuote(containerName) + " >/dev/null 2>&1 || true; "
        "echo 'Starting remote container " + containerName + "'; "
        "docker run -d --restart unless-stopped --name " + shellQuote(containerName) +
        " --cap-drop ALL --security-opt no-new-privileges --memory 1g --cpus 1 "
        " --env-file " + shellQuote(envFile) +
        " -p " + std::to_string(containerPort) +
        " " + shellQuote(imageName) + "; "
        "published=$(docker port " + shellQuote(containerName) + " " + std::to_string(containerPort) + "/tcp 2>/dev/null | head -n1 | awk -F: '{print $NF}'); "
        "echo __AIDS_REMOTE_IMAGE__=" + imageName + "; "
        "echo __AIDS_REMOTE_CONTAINER__=" + containerName + "; "
        "echo __AIDS_REMOTE_PORT__=$published";

    const std::string command =
        "timeout " + std::to_string(std::max(60, timeoutSeconds)) + "s sh -lc " +
        shellQuote(files.sshpassPrefix + files.sshPrefix + " " + shellQuote(remoteCommand));

    std::string output;
    const int exitCode = runCommand(command, output);
    cleanupSessionFiles(files);

    if (!output.empty() && onLogLine) {
        std::istringstream stream(output);
        std::string line;
        while (std::getline(stream, line)) {
            if (!trim(line).empty() && line.find("__AIDS_ENV_EOF__") == std::string::npos) {
                onLogLine(line);
            }
        }
    }

    if (exitCode != 0) {
        if (output.find("__AIDS_INVALID_PATH__") != std::string::npos) {
            result.error = "Remote path does not exist or is not a directory";
        } else if (output.find("__AIDS_DOCKER_MISSING__") != std::string::npos) {
            result.error = "Docker is not installed on the remote host";
        } else if (output.find("__AIDS_DOCKER_DAEMON_DOWN__") != std::string::npos) {
            result.error = "Docker is installed but the remote Docker daemon is not running or accessible";
        } else if (output.find("__AIDS_DOCKERFILE_MISSING__") != std::string::npos) {
            result.error = "No Dockerfile found and the remote project type could not be auto-detected";
        } else if (exitCode == 124) {
            result.error = "Remote Docker build timed out";
        } else {
            result.error = "Remote Docker build or run failed";
        }
        result.output = output;
        return result;
    }

    result.success = true;
    result.output = output;
    return result;
}

SshOperationResult SshService::inspectDockerContainer(const SshConnectionConfig& config,
                                                      const std::string& containerName) const {
    SshOperationResult result;
    std::string error;
    if (!isValidConnectionConfig(config, error)) {
        result.error = error;
        return result;
    }
    if (!isValidDockerName(containerName)) {
        result.error = "Invalid remote container name";
        return result;
    }

    const SessionFiles files = prepareSessionFiles(config);
    const std::string remoteCommand =
        "set -e; "
        "command -v docker >/dev/null 2>&1 || { echo __AIDS_DOCKER_MISSING__; exit 10; }; "
        "docker info >/dev/null 2>&1 || { echo __AIDS_DOCKER_DAEMON_DOWN__; exit 11; }; "
        "docker inspect " + shellQuote(containerName) + " >/dev/null 2>&1 || { echo __AIDS_CONTAINER_MISSING__; exit 12; }; "
        "docker inspect --format 'status={{.State.Status}}\nrunning={{.State.Running}}\npaused={{.State.Paused}}\nexit_code={{.State.ExitCode}}\nimage={{.Config.Image}}\nstarted_at={{.State.StartedAt}}\nfinished_at={{.State.FinishedAt}}\nrestart_count={{.RestartCount}}' " + shellQuote(containerName) + "; "
        "printf 'published_ports='; docker port " + shellQuote(containerName) + " 2>/dev/null | tr '\\n' ',' || true; echo; "
        "echo __AIDS_REMOTE_LOG_TAIL__; "
        "docker logs --tail 80 " + shellQuote(containerName) + " 2>&1 || true";

    const std::string command =
        "timeout 35s sh -lc " +
        shellQuote(files.sshpassPrefix + files.sshPrefix + " " + shellQuote(remoteCommand));

    std::string output;
    const int exitCode = runCommand(command, output);
    cleanupSessionFiles(files);

    if (exitCode != 0) {
        if (output.find("__AIDS_DOCKER_MISSING__") != std::string::npos) {
            result.error = "Docker is not installed on the remote host";
        } else if (output.find("__AIDS_DOCKER_DAEMON_DOWN__") != std::string::npos) {
            result.error = "Docker daemon is not reachable on the remote host";
        } else if (output.find("__AIDS_CONTAINER_MISSING__") != std::string::npos) {
            result.error = "Remote Docker container is not present";
        } else if (exitCode == 124) {
            result.error = "Remote Docker inspect timed out";
        } else {
            result.error = "Failed to inspect remote Docker container";
        }
        result.output = output;
        return result;
    }

    result.success = true;
    result.output = output;
    return result;
}

SshOperationResult SshService::removeDockerContainer(const SshConnectionConfig& config,
                                                     const std::string& containerName,
                                                     const std::string& imageName,
                                                     bool removeImage) const {
    SshOperationResult result;
    std::string error;
    if (!isValidConnectionConfig(config, error)) {
        result.error = error;
        return result;
    }
    if (!isValidDockerName(containerName)) {
        result.error = "Invalid remote container name";
        return result;
    }
    if (removeImage && !isValidDockerImageRef(imageName)) {
        result.error = "Invalid or missing remote Docker image reference";
        return result;
    }

    const SessionFiles files = prepareSessionFiles(config);
    const std::string imageCleanup =
        removeImage
            ? std::string(
                  "if docker image inspect " + shellQuote(imageName) + " >/dev/null 2>&1; then "
                  "  if docker image rm " + shellQuote(imageName) + " >/dev/null 2>&1; then "
                  "    echo __AIDS_REMOTE_IMAGE_REMOVED__; "
                  "  else "
                  "    echo __AIDS_REMOTE_IMAGE_REMOVE_FAILED__; "
                  "  fi; "
                  "else "
                  "  echo __AIDS_REMOTE_IMAGE_ALREADY_ABSENT__; "
                  "fi; ")
            : "";
    const std::string remoteCommand =
        "set -e; "
        "command -v docker >/dev/null 2>&1 || { echo __AIDS_DOCKER_MISSING__; exit 10; }; "
        "docker info >/dev/null 2>&1 || { echo __AIDS_DOCKER_DAEMON_DOWN__; exit 11; }; "
        "docker rm -f " + shellQuote(containerName) + " >/dev/null 2>&1 || true; "
        "echo __AIDS_REMOTE_CONTAINER_REMOVED__; " +
        imageCleanup;

    const std::string command =
        "timeout 35s sh -lc " +
        shellQuote(files.sshpassPrefix + files.sshPrefix + " " + shellQuote(remoteCommand));

    std::string output;
    const int exitCode = runCommand(command, output);
    cleanupSessionFiles(files);

    const bool imageRemoveFailed = output.find("__AIDS_REMOTE_IMAGE_REMOVE_FAILED__") != std::string::npos;
    if (exitCode != 0 || output.find("__AIDS_REMOTE_CONTAINER_REMOVED__") == std::string::npos || imageRemoveFailed) {
        if (output.find("__AIDS_DOCKER_MISSING__") != std::string::npos) {
            result.error = "Docker is not installed on the remote host";
        } else if (output.find("__AIDS_DOCKER_DAEMON_DOWN__") != std::string::npos) {
            result.error = "Docker daemon is not reachable on the remote host";
        } else if (imageRemoveFailed) {
            result.error = "Remote Docker container was removed, but the image could not be deleted because it may still be in use";
        } else if (exitCode == 124) {
            result.error = "Remote Docker remove timed out";
        } else {
            result.error = "Failed to remove remote Docker container";
        }
        result.output = output;
        return result;
    }

    result.success = true;
    result.output = output;
    return result;
}

SshOperationResult SshService::removeDockerImage(const SshConnectionConfig& config,
                                                 const std::string& imageName) const {
    SshOperationResult result;
    std::string error;
    if (!isValidConnectionConfig(config, error)) {
        result.error = error;
        return result;
    }
    if (!isValidDockerImageRef(imageName)) {
        result.error = "Invalid or missing remote Docker image reference";
        return result;
    }

    const SessionFiles files = prepareSessionFiles(config);
    std::string registryImage = "localhost:5000/" + imageName;
    const std::string dockerIoPrefix = "localhost:5000/docker.io/";
    if (registryImage.rfind(dockerIoPrefix, 0) == 0) {
        registryImage = "localhost:5000/" + registryImage.substr(dockerIoPrefix.size());
    }

    const std::string remoteCommand =
        "set -e; "
        "command -v docker >/dev/null 2>&1 || { echo __AIDS_DOCKER_MISSING__; exit 10; }; "
        "docker info >/dev/null 2>&1 || { echo __AIDS_DOCKER_DAEMON_DOWN__; exit 11; }; "
        "removed=0; failed=0; "
        "for img in " + shellQuote(imageName) + " " + shellQuote(registryImage) + "; do "
        "  [ -n \"$img\" ] || continue; "
        "  if docker image inspect \"$img\" >/dev/null 2>&1; then "
        "    if docker image rm \"$img\" >/dev/null 2>&1; then "
        "      echo __AIDS_REMOTE_IMAGE_REMOVED__=$img; removed=1; "
        "    else "
        "      echo __AIDS_REMOTE_IMAGE_REMOVE_FAILED__=$img; failed=1; "
        "    fi; "
        "  else "
        "    echo __AIDS_REMOTE_IMAGE_ALREADY_ABSENT__=$img; "
        "  fi; "
        "done; "
        "[ \"$failed\" -eq 0 ] || exit 12; "
        "echo __AIDS_REMOTE_IMAGE_CLEANUP_DONE__";

    const std::string command =
        "timeout 45s sh -lc " +
        shellQuote(files.sshpassPrefix + files.sshPrefix + " " + shellQuote(remoteCommand));

    std::string output;
    const int exitCode = runCommand(command, output);
    cleanupSessionFiles(files);

    result.exitCode = exitCode;
    result.output = output;
    if (exitCode != 0 || output.find("__AIDS_REMOTE_IMAGE_CLEANUP_DONE__") == std::string::npos) {
        if (output.find("__AIDS_DOCKER_MISSING__") != std::string::npos) {
            result.error = "Docker is not installed on the remote host";
        } else if (output.find("__AIDS_DOCKER_DAEMON_DOWN__") != std::string::npos) {
            result.error = "Docker daemon is not reachable on the remote host";
        } else if (output.find("__AIDS_REMOTE_IMAGE_REMOVE_FAILED__") != std::string::npos) {
            result.error = "Remote Docker image could not be deleted because it may still be in use";
        } else if (exitCode == 124) {
            result.error = "Remote Docker image cleanup timed out";
        } else {
            result.error = "Failed to remove remote Docker image";
        }
        return result;
    }

    result.success = true;
    return result;
}

KubernetesRuntimeInfo SshService::deployKubernetesRuntime(const SshConnectionConfig& config,
                                                          const KubernetesDeployOptions& options) const {
    KubernetesRuntimeInfo result;
    std::string error;
    if (!isValidConnectionConfig(config, error)) {
        result.error = error;
        return result;
    }
    if (!isValidDockerImageRef(options.imageName)) {
        result.error = "Invalid image reference for remote Kubernetes deployment";
        return result;
    }

    result.nameSpace = options.nameSpace.empty() ? "aids-apps" : toLower(trim(options.nameSpace));
    result.exposureMode = normalizeKubernetesExposure(options.exposureMode);
    result.runtimeScheme = normalizeRuntimeScheme(options.runtimeScheme);
    result.desiredReplicas = std::clamp(options.replicas, 1, 10);
    const int containerPort = std::clamp(options.containerPort, 1, 65535);
    if (!isValidDnsLabelValue(result.nameSpace)) {
        result.error = "Namespace must be a lowercase DNS label";
        return result;
    }

    const std::string baseName = sanitizeDnsLabelValue(options.projectName + "-" + options.deploymentId.substr(0, std::min<size_t>(8, options.deploymentId.size())));
    result.deploymentName = baseName;
    result.serviceName = sanitizeDnsLabelValue(baseName + "-svc");
    result.ingressName = sanitizeDnsLabelValue(baseName + "-ing");
    const RuntimeResourcePreset resources = runtimeResourcePresetFor(options.resourcePreset);
    const std::string healthPath = sanitizeProbePathValue(options.healthPath);
    const std::string secretName = sanitizeDnsLabelValue(result.deploymentName + "-env");
    std::vector<std::pair<std::string, std::string>> envVars;
    envVars.reserve(options.envVars.size());
    for (const auto& envVar : options.envVars) {
        if (isValidEnvKeyValue(envVar.first)) {
            envVars.push_back(envVar);
        }
    }

    const bool useIngress = result.exposureMode == "ingress";
    if (result.runtimeScheme == "https" && !useIngress) {
        result.error = "HTTPS runtime URLs require Ingress exposure on the remote Kubernetes host";
        return result;
    }
    const std::string serviceType = useIngress || result.exposureMode == "clusterip"
        ? "ClusterIP"
        : (result.exposureMode == "loadbalancer" ? "LoadBalancer" : "NodePort");
    const char* baseDomainEnv = std::getenv("REMOTE_K8S_BASE_DOMAIN");
    const std::string baseDomain = baseDomainEnv && *baseDomainEnv ? baseDomainEnv : "";
    const char* issuerEnv = std::getenv("REMOTE_K8S_CERT_CLUSTER_ISSUER");
    const char* ingressClassEnv = std::getenv("REMOTE_K8S_INGRESS_CLASS");
    const char* acmeEmailEnv = std::getenv("ACME_EMAIL");
    const char* certManagerVersionEnv = std::getenv("REMOTE_K8S_CERT_MANAGER_VERSION");
    const std::string clusterIssuer = issuerEnv && *issuerEnv ? issuerEnv : "";
    const std::string ingressClass = ingressClassEnv && *ingressClassEnv ? ingressClassEnv : "";
    const std::string acmeEmail = acmeEmailEnv && *acmeEmailEnv ? acmeEmailEnv : "";
    const std::string certManagerVersion = certManagerVersionEnv && *certManagerVersionEnv
        ? certManagerVersionEnv
        : "v1.15.3";
    std::string ingressHost;
    if (useIngress) {
        std::string hostForDns = config.host;
        std::replace(hostForDns.begin(), hostForDns.end(), '.', '-');
        ingressHost = !baseDomain.empty()
            ? result.deploymentName + "." + baseDomain
            : result.deploymentName + "." + result.nameSpace + "." + hostForDns + ".nip.io";
    }
    result.ingressHost = ingressHost;

    std::ostringstream manifest;
    if (!envVars.empty()) {
        manifest
            << "apiVersion: v1\n"
            << "kind: Secret\n"
            << "metadata:\n"
            << "  name: " << secretName << "\n"
            << "  namespace: " << result.nameSpace << "\n"
            << "type: Opaque\n"
            << "stringData:\n";
        for (const auto& envVar : envVars) {
            writeYamlBlockScalarValue(manifest, envVar.first, envVar.second);
        }
        manifest << "---\n";
    }
    manifest
        << "apiVersion: apps/v1\n"
        << "kind: Deployment\n"
        << "metadata:\n"
        << "  name: " << result.deploymentName << "\n"
        << "  namespace: " << result.nameSpace << "\n"
        << "spec:\n"
        << "  revisionHistoryLimit: 5\n"
        << "  progressDeadlineSeconds: 180\n"
        << "  replicas: " << result.desiredReplicas << "\n"
        << "  strategy:\n"
        << "    type: RollingUpdate\n"
        << "    rollingUpdate:\n"
        << "      maxUnavailable: 0\n"
        << "      maxSurge: 1\n"
        << "  selector:\n"
        << "    matchLabels:\n"
        << "      app: " << result.deploymentName << "\n"
        << "  template:\n"
        << "    metadata:\n"
        << "      labels:\n"
        << "        app: " << result.deploymentName << "\n"
        << "    spec:\n"
        << "      securityContext:\n"
        << "        runAsNonRoot: true\n"
        << "        runAsUser: 10001\n"
        << "        runAsGroup: 10001\n"
        << "        fsGroup: 10001\n"
        << "        seccompProfile:\n"
        << "          type: RuntimeDefault\n"
        << "      terminationGracePeriodSeconds: 30\n"
        << "      containers:\n"
        << "        - name: app\n"
        << "          image: __AIDS_K8S_IMAGE__\n"
        << "          imagePullPolicy: IfNotPresent\n"
        << "          ports:\n"
        << "            - containerPort: " << containerPort << "\n"
        << (!envVars.empty()
                ? "          envFrom:\n            - secretRef:\n                name: " + secretName + "\n"
                : "")
        << "          securityContext:\n"
        << "            allowPrivilegeEscalation: false\n"
        << "            runAsNonRoot: true\n"
        << "            capabilities:\n"
        << "              drop:\n"
        << "                - ALL\n"
        << "          resources:\n"
        << "            requests:\n"
        << "              cpu: " << resources.cpuRequest << "\n"
        << "              memory: " << resources.memoryRequest << "\n"
        << "            limits:\n"
        << "              cpu: " << resources.cpuLimit << "\n"
        << "              memory: " << resources.memoryLimit << "\n"
        << "          readinessProbe:\n"
        << "            httpGet:\n"
        << "              path: " << healthPath << "\n"
        << "              port: " << containerPort << "\n"
        << "            initialDelaySeconds: 5\n"
        << "            periodSeconds: 10\n"
        << "            timeoutSeconds: 3\n"
        << "            failureThreshold: 3\n"
        << "          livenessProbe:\n"
        << "            httpGet:\n"
        << "              path: " << healthPath << "\n"
        << "              port: " << containerPort << "\n"
        << "            initialDelaySeconds: 15\n"
        << "            periodSeconds: 20\n"
        << "            timeoutSeconds: 3\n"
        << "            failureThreshold: 3\n"
        << "          startupProbe:\n"
        << "            httpGet:\n"
        << "              path: " << healthPath << "\n"
        << "              port: " << containerPort << "\n"
        << "            periodSeconds: 5\n"
        << "            timeoutSeconds: 3\n"
        << "            failureThreshold: 30\n"
        << "---\n"
        << "apiVersion: v1\n"
        << "kind: Service\n"
        << "metadata:\n"
        << "  name: " << result.serviceName << "\n"
        << "  namespace: " << result.nameSpace << "\n"
        << "spec:\n"
        << "  selector:\n"
        << "    app: " << result.deploymentName << "\n"
        << "  type: " << serviceType << "\n"
        << "  ports:\n"
        << "    - protocol: TCP\n"
        << "      port: " << containerPort << "\n"
        << "      targetPort: " << containerPort << "\n";

    if (useIngress) {
        manifest
            << "---\n"
            << "apiVersion: networking.k8s.io/v1\n"
            << "kind: Ingress\n"
            << "metadata:\n"
            << "  name: " << result.ingressName << "\n"
            << "  namespace: " << result.nameSpace << "\n"
            << "  annotations:\n"
            << "    kubernetes.io/ingress.class: \"__AIDS_REMOTE_INGRESS_CLASS__\"\n";
        if (result.runtimeScheme == "https") {
            manifest << "    cert-manager.io/cluster-issuer: \"__AIDS_REMOTE_CLUSTER_ISSUER__\"\n";
        }
        manifest
            << "spec:\n"
            << "  ingressClassName: __AIDS_REMOTE_INGRESS_CLASS__\n"
            << "  rules:\n"
            << "    - host: " << ingressHost << "\n"
            << "      http:\n"
            << "        paths:\n"
            << "          - path: /\n"
            << "            pathType: Prefix\n"
            << "            backend:\n"
            << "              service:\n"
            << "                name: " << result.serviceName << "\n"
            << "                port:\n"
            << "                  number: " << containerPort << "\n";
        if (result.runtimeScheme == "https") {
            manifest
                << "  tls:\n"
                << "    - hosts:\n"
                << "        - " << ingressHost << "\n"
                << "      secretName: " << result.ingressName << "-tls\n";
        }
        result.logs += "requested_ingress_class=" + ingressClass + "\n";
        result.logs += "requested_cluster_issuer=" + clusterIssuer + "\n";
    }

    const SessionFiles files = prepareSessionFiles(config);
    const std::string manifestPath = "/tmp/aids-k8s-" + sanitizeDnsLabelValue(options.deploymentId) + ".yaml";
    std::string registryImageName = "localhost:5000/" + options.imageName;
    if (registryImageName.rfind("localhost:5000/docker.io/", 0) == 0) {
        registryImageName = "localhost:5000/" + registryImageName.substr(std::string("localhost:5000/docker.io/").size());
    }

    const std::string remoteCommand =
        "set -e; "
        "echo '[remote-k8s] Preparing remote Kubernetes deployment'; "
        "if command -v kubectl >/dev/null 2>&1; then K='kubectl'; "
        "elif command -v k3s >/dev/null 2>&1 && [ \"$(id -u)\" -eq 0 ]; then K='k3s kubectl'; "
        "elif command -v k3s >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then K='sudo -n k3s kubectl'; "
        "else echo __AIDS_KUBECTL_MISSING__; exit 30; fi; "
        "$K get nodes >/dev/null 2>&1 || { echo __AIDS_K8S_NOT_READY__; exit 31; }; "
        "k8s_image=" + shellQuote(options.imageName) + "; "
        "if ! command -v docker >/dev/null 2>&1 || ! docker image inspect " + shellQuote(options.imageName) + " >/dev/null 2>&1; then "
        "  echo __AIDS_K8S_SOURCE_IMAGE_MISSING__; exit 32; "
        "fi; "
        "image_loaded=no; "
        "if command -v kind >/dev/null 2>&1 && kind load docker-image " + shellQuote(options.imageName) + " >/dev/null 2>&1; then image_loaded=yes; fi; "
        "if [ \"$image_loaded\" = no ] && command -v minikube >/dev/null 2>&1 && minikube image load " + shellQuote(options.imageName) + " >/dev/null 2>&1; then image_loaded=yes; fi; "
        "if [ \"$image_loaded\" = no ] && command -v k3s >/dev/null 2>&1; then "
        "  if [ \"$(id -u)\" -eq 0 ] && docker save " + shellQuote(options.imageName) + " | k3s ctr images import - >/dev/null 2>&1; then image_loaded=yes; "
        "  elif sudo -n true >/dev/null 2>&1 && docker save " + shellQuote(options.imageName) + " | sudo -n k3s ctr images import - >/dev/null 2>&1; then image_loaded=yes; fi; "
        "fi; "
        "if [ \"$image_loaded\" = no ]; then "
        "  echo '[remote-k8s] Local image import unavailable; using local registry fallback'; "
        "  docker ps --format '{{.Names}}' | grep -qx aids-local-registry || { docker rm -f aids-local-registry >/dev/null 2>&1 || true; docker run -d --restart unless-stopped --name aids-local-registry -p 127.0.0.1:5000:5000 registry:2 >/dev/null; }; "
        "  for i in $(seq 1 20); do (command -v curl >/dev/null 2>&1 && curl -fsS http://127.0.0.1:5000/v2/ >/dev/null 2>&1) && break || true; sleep 1; done; "
        "  docker tag " + shellQuote(options.imageName) + " " + shellQuote(registryImageName) + "; "
        "  docker push " + shellQuote(registryImageName) + " >/dev/null || { echo __AIDS_K8S_REGISTRY_PUSH_FAILED__; exit 33; }; "
        "  k8s_image=" + shellQuote(registryImageName) + "; "
        "fi; "
        "echo __AIDS_K8S_IMAGE_USED__=$k8s_image; "
        "requested_ingress_class=" + shellQuote(useIngress ? (ingressClass.empty() ? "auto" : ingressClass) : "") + "; "
        "requested_cluster_issuer=" + shellQuote(useIngress && result.runtimeScheme == "https" ? (clusterIssuer.empty() ? "letsencrypt-prod" : clusterIssuer) : "") + "; "
        "acme_email=" + shellQuote(acmeEmail) + "; "
        "cert_manager_version=" + shellQuote(certManagerVersion) + "; "
        "ingress_class=''; cluster_issuer=''; "
        "if [ " + shellQuote(useIngress ? "yes" : "no") + " = 'yes' ]; then "
        "  case \"$requested_ingress_class\" in ''|auto) requested_ingress_class='';; *[!A-Za-z0-9.-]*) echo __AIDS_INGRESS_CLASS_INVALID__; exit 34;; esac; "
        "  if [ -n \"$requested_ingress_class\" ] && $K get ingressclass \"$requested_ingress_class\" >/dev/null 2>&1; then ingress_class=\"$requested_ingress_class\"; fi; "
        "  if [ -z \"$ingress_class\" ]; then ingress_class=$($K get ingressclass -o jsonpath='{.items[?(@.metadata.annotations.ingressclass\\.kubernetes\\.io/is-default-class==\"true\")].metadata.name}' 2>/dev/null | awk '{print $1}'); fi; "
        "  if [ -z \"$ingress_class\" ]; then ingress_class=$($K get ingressclass -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true); fi; "
        "  [ -n \"$ingress_class\" ] || { echo __AIDS_INGRESS_CLASS_MISSING__; exit 35; }; "
        "  echo __AIDS_K8S_INGRESS_CLASS__=$ingress_class; "
        "fi; "
        "if [ " + shellQuote(useIngress && result.runtimeScheme == "https" ? "yes" : "no") + " = 'yes' ]; then "
        "  case \"$requested_cluster_issuer\" in ''|auto) requested_cluster_issuer='letsencrypt-prod';; *[!A-Za-z0-9.-]*) echo __AIDS_CLUSTER_ISSUER_INVALID__; exit 36;; esac; "
        "  cluster_issuer=\"$requested_cluster_issuer\"; "
        "  if ! $K get clusterissuer \"$cluster_issuer\" >/dev/null 2>&1; then "
        "    [ -n \"$acme_email\" ] && [ \"$acme_email\" != 'admin@example.com' ] || { echo __AIDS_ACME_EMAIL_MISSING__; exit 37; }; "
        "    if ! $K get crd certificates.cert-manager.io >/dev/null 2>&1; then "
        "      echo '[remote-k8s] Installing cert-manager for HTTPS certificates'; "
        "      $K apply -f https://github.com/cert-manager/cert-manager/releases/download/${cert_manager_version}/cert-manager.yaml >/dev/null || { echo __AIDS_CERT_MANAGER_INSTALL_FAILED__; exit 38; }; "
        "      $K -n cert-manager wait --for=condition=Available deploy/cert-manager --timeout=180s >/dev/null || { echo __AIDS_CERT_MANAGER_NOT_READY__; exit 39; }; "
        "      $K -n cert-manager wait --for=condition=Available deploy/cert-manager-webhook --timeout=180s >/dev/null || { echo __AIDS_CERT_MANAGER_NOT_READY__; exit 39; }; "
        "      $K -n cert-manager wait --for=condition=Available deploy/cert-manager-cainjector --timeout=180s >/dev/null || { echo __AIDS_CERT_MANAGER_NOT_READY__; exit 39; }; "
        "    fi; "
        "    cat <<__AIDS_CLUSTER_ISSUER__ | $K apply -f - >/dev/null\n"
        "apiVersion: cert-manager.io/v1\n"
        "kind: ClusterIssuer\n"
        "metadata:\n"
        "  name: $cluster_issuer\n"
        "spec:\n"
        "  acme:\n"
        "    email: $acme_email\n"
        "    server: https://acme-v02.api.letsencrypt.org/directory\n"
        "    privateKeySecretRef:\n"
        "      name: ${cluster_issuer}-account-key\n"
        "    solvers:\n"
        "      - http01:\n"
        "          ingress:\n"
        "            class: $ingress_class\n"
        "__AIDS_CLUSTER_ISSUER__\n"
        "    $K get clusterissuer \"$cluster_issuer\" >/dev/null 2>&1 || { echo __AIDS_CLUSTER_ISSUER_FAILED__; exit 40; }; "
        "  fi; "
        "  echo __AIDS_K8S_CLUSTER_ISSUER__=$cluster_issuer; "
        "fi; "
        "$K get namespace " + shellQuote(result.nameSpace) + " >/dev/null 2>&1 || $K create namespace " + shellQuote(result.nameSpace) + "; "
        "cat > " + shellQuote(manifestPath) + " <<'__AIDS_K8S_MANIFEST__'\n" +
        manifest.str() +
        "__AIDS_K8S_MANIFEST__\n"
        "sed -i \"s|__AIDS_K8S_IMAGE__|${k8s_image}|g\" " + shellQuote(manifestPath) + "; "
        "sed -i \"s|__AIDS_REMOTE_INGRESS_CLASS__|${ingress_class}|g\" " + shellQuote(manifestPath) + "; "
        "sed -i \"s|__AIDS_REMOTE_CLUSTER_ISSUER__|${cluster_issuer}|g\" " + shellQuote(manifestPath) + "; "
        "$K apply -f " + shellQuote(manifestPath) + "; "
        "if ! $K rollout status deployment/" + shellQuote(result.deploymentName) + " -n " + shellQuote(result.nameSpace) + " --timeout=180s; then "
        "  echo __AIDS_K8S_ROLLOUT_FAILED__; "
        "  $K get pods -n " + shellQuote(result.nameSpace) + " -l app=" + shellQuote(result.deploymentName) + " -o wide || true; "
        "  $K describe pods -n " + shellQuote(result.nameSpace) + " -l app=" + shellQuote(result.deploymentName) + " || true; "
        "  exit 40; "
        "fi; "
        "ready=$($K get deployment " + shellQuote(result.deploymentName) + " -n " + shellQuote(result.nameSpace) + " -o jsonpath='{.status.readyReplicas}' 2>/dev/null || true); "
        "desired=$($K get deployment " + shellQuote(result.deploymentName) + " -n " + shellQuote(result.nameSpace) + " -o jsonpath='{.spec.replicas}' 2>/dev/null || true); "
        "nodeport=$($K get service " + shellQuote(result.serviceName) + " -n " + shellQuote(result.nameSpace) + " -o jsonpath='{.spec.ports[0].nodePort}' 2>/dev/null || true); "
        "rm -f " + shellQuote(manifestPath) + "; "
        "echo __AIDS_K8S_NAMESPACE__=" + result.nameSpace + "; "
        "echo __AIDS_K8S_DEPLOYMENT__=" + result.deploymentName + "; "
        "echo __AIDS_K8S_SERVICE__=" + result.serviceName + "; "
        "echo __AIDS_K8S_INGRESS__=" + (useIngress ? result.ingressName : "") + "; "
        "echo __AIDS_K8S_EXPOSURE__=" + result.exposureMode + "; "
        "echo __AIDS_K8S_READY__=${ready:-0}; "
        "echo __AIDS_K8S_DESIRED__=${desired:-0}; "
        "if [ -n \"$nodeport\" ]; then echo __AIDS_K8S_URL__=http://" + config.host + ":$nodeport; "
        "elif [ " + shellQuote(useIngress ? "yes" : "no") + " = 'yes' ]; then echo __AIDS_K8S_URL__=" + result.runtimeScheme + "://" + ingressHost + "; fi; "
        "echo __AIDS_K8S_DONE__";

    const std::string command =
        "timeout 260s sh -lc " +
        shellQuote(files.sshpassPrefix + files.sshPrefix + " " + shellQuote(remoteCommand));

    std::string output;
    const int exitCode = runCommand(command, output);
    cleanupSessionFiles(files);
    result.logs = output;

    if (exitCode != 0 || output.find("__AIDS_K8S_DONE__") == std::string::npos) {
        if (output.find("__AIDS_KUBECTL_MISSING__") != std::string::npos) {
            result.error = "kubectl or k3s is not installed on the remote host";
        } else if (output.find("__AIDS_K8S_NOT_READY__") != std::string::npos) {
            result.error = "Remote Kubernetes cluster is not reachable";
        } else if (output.find("__AIDS_K8S_SOURCE_IMAGE_MISSING__") != std::string::npos) {
            result.error = "Remote Docker image is missing before Kubernetes deploy";
        } else if (output.find("__AIDS_K8S_REGISTRY_PUSH_FAILED__") != std::string::npos) {
            result.error = "Remote Kubernetes image handoff failed: unable to push to local registry";
        } else if (output.find("__AIDS_INGRESS_CLASS_INVALID__") != std::string::npos) {
            result.error = "Remote Kubernetes ingress class contains unsupported characters";
        } else if (output.find("__AIDS_INGRESS_CLASS_MISSING__") != std::string::npos) {
            result.error = "Remote Kubernetes ingress exposure requires an installed IngressClass";
        } else if (output.find("__AIDS_CLUSTER_ISSUER_INVALID__") != std::string::npos) {
            result.error = "Remote Kubernetes certificate issuer contains unsupported characters";
        } else if (output.find("__AIDS_ACME_EMAIL_MISSING__") != std::string::npos) {
            result.error = "HTTPS requires ACME_EMAIL to create Let's Encrypt certificates";
        } else if (output.find("__AIDS_CERT_MANAGER_INSTALL_FAILED__") != std::string::npos) {
            result.error = "Failed to install cert-manager for HTTPS certificates";
        } else if (output.find("__AIDS_CERT_MANAGER_NOT_READY__") != std::string::npos) {
            result.error = "cert-manager did not become ready on the remote Kubernetes host";
        } else if (output.find("__AIDS_CLUSTER_ISSUER_FAILED__") != std::string::npos) {
            result.error = "Failed to create the remote Kubernetes ClusterIssuer";
        } else if (output.find("__AIDS_K8S_ROLLOUT_FAILED__") != std::string::npos) {
            result.error = "Remote Kubernetes deployment rollout failed";
        } else if (exitCode == 124) {
            result.error = "Remote Kubernetes deployment timed out";
        } else {
            result.error = "Remote Kubernetes deployment failed";
        }
        return result;
    }

    result.success = true;
    result.deployed = true;
    result.readyReplicas = markerInt(output, "__AIDS_K8S_READY__", 0);
    result.desiredReplicas = markerInt(output, "__AIDS_K8S_DESIRED__", result.desiredReplicas);
    result.runtimeUrl = markerValue(output, "__AIDS_K8S_URL__");
    result.status = result.desiredReplicas > 0 && result.readyReplicas >= result.desiredReplicas ? "running" : "deploying";
    return result;
}

KubernetesRuntimeInfo SshService::inspectKubernetesRuntime(const SshConnectionConfig& config,
                                                           const std::string& nameSpace,
                                                           const std::string& deploymentName,
                                                           const std::string& serviceName,
                                                           const std::string& exposureMode,
                                                           const std::string& runtimeScheme) const {
    KubernetesRuntimeInfo result;
    result.nameSpace = nameSpace;
    result.deploymentName = deploymentName;
    result.serviceName = serviceName;
    result.ingressName = sanitizeDnsLabelValue(deploymentName + "-ing");
    result.exposureMode = normalizeKubernetesExposure(exposureMode);
    result.runtimeScheme = normalizeRuntimeScheme(runtimeScheme);
    std::string error;
    if (!isValidConnectionConfig(config, error)) {
        result.error = error;
        return result;
    }
    if (!isValidDnsLabelValue(nameSpace) || !isValidDnsLabelValue(deploymentName) || !isValidDnsLabelValue(serviceName)) {
        result.error = "Invalid Kubernetes runtime metadata";
        return result;
    }

    const SessionFiles files = prepareSessionFiles(config);
    const bool useIngress = result.exposureMode == "ingress";
    const std::string remoteCommand =
        "set -e; "
        "if command -v kubectl >/dev/null 2>&1; then K='kubectl'; "
        "elif command -v k3s >/dev/null 2>&1 && [ \"$(id -u)\" -eq 0 ]; then K='k3s kubectl'; "
        "elif command -v k3s >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then K='sudo -n k3s kubectl'; "
        "else echo __AIDS_KUBECTL_MISSING__; exit 30; fi; "
        "$K get deployment " + shellQuote(deploymentName) + " -n " + shellQuote(nameSpace) + " >/dev/null 2>&1 || { echo __AIDS_K8S_DEPLOYMENT_MISSING__; exit 32; }; "
        "$K get service " + shellQuote(serviceName) + " -n " + shellQuote(nameSpace) + " >/dev/null 2>&1 || { echo __AIDS_K8S_SERVICE_MISSING__; exit 33; }; "
        "ready=$($K get deployment " + shellQuote(deploymentName) + " -n " + shellQuote(nameSpace) + " -o jsonpath='{.status.readyReplicas}' 2>/dev/null || true); "
        "desired=$($K get deployment " + shellQuote(deploymentName) + " -n " + shellQuote(nameSpace) + " -o jsonpath='{.spec.replicas}' 2>/dev/null || true); "
        "nodeport=$($K get service " + shellQuote(serviceName) + " -n " + shellQuote(nameSpace) + " -o jsonpath='{.spec.ports[0].nodePort}' 2>/dev/null || true); "
        "ingress_host=''; if [ " + shellQuote(useIngress ? "yes" : "no") + " = 'yes' ]; then ingress_host=$($K get ingress " + shellQuote(result.ingressName) + " -n " + shellQuote(nameSpace) + " -o jsonpath='{.spec.rules[0].host}' 2>/dev/null || true); fi; "
        "echo __AIDS_K8S_READY__=${ready:-0}; echo __AIDS_K8S_DESIRED__=${desired:-0}; "
        "if [ -n \"$nodeport\" ]; then echo __AIDS_K8S_URL__=http://" + config.host + ":$nodeport; "
        "elif [ -n \"$ingress_host\" ]; then echo __AIDS_K8S_URL__=" + result.runtimeScheme + "://$ingress_host; fi; "
        "echo __AIDS_K8S_LOGS__; $K get pods -n " + shellQuote(nameSpace) + " -l app=" + shellQuote(deploymentName) + " -o wide; "
        + (useIngress ? "$K describe ingress " + shellQuote(result.ingressName) + " -n " + shellQuote(nameSpace) + " 2>&1 || true; " : "") +
        "echo __AIDS_K8S_DONE__";

    const std::string command =
        "timeout 60s sh -lc " +
        shellQuote(files.sshpassPrefix + files.sshPrefix + " " + shellQuote(remoteCommand));

    std::string output;
    const int exitCode = runCommand(command, output);
    cleanupSessionFiles(files);
    result.logs = output;
    if (exitCode != 0 || output.find("__AIDS_K8S_DONE__") == std::string::npos) {
        result.error = output.find("__AIDS_K8S_DEPLOYMENT_MISSING__") != std::string::npos
            ? "Remote Kubernetes deployment is not present"
            : "Failed to inspect remote Kubernetes runtime";
        return result;
    }

    result.success = true;
    result.deployed = true;
    result.readyReplicas = markerInt(output, "__AIDS_K8S_READY__", 0);
    result.desiredReplicas = markerInt(output, "__AIDS_K8S_DESIRED__", 0);
    result.runtimeUrl = markerValue(output, "__AIDS_K8S_URL__");
    result.status = result.desiredReplicas > 0 && result.readyReplicas >= result.desiredReplicas ? "running" : "deploying";
    return result;
}

KubernetesRuntimeInfo SshService::scaleKubernetesRuntime(const SshConnectionConfig& config,
                                                         const std::string& nameSpace,
                                                         const std::string& deploymentName,
                                                         const std::string& serviceName,
                                                         const std::string& exposureMode,
                                                         int replicas,
                                                         const std::string& runtimeScheme) const {
    KubernetesRuntimeInfo result;
    result.nameSpace = nameSpace;
    result.deploymentName = deploymentName;
    result.serviceName = serviceName;
    result.exposureMode = normalizeKubernetesExposure(exposureMode);
    result.desiredReplicas = std::clamp(replicas, 0, 10);
    const std::string rolloutStatus =
        result.desiredReplicas == 0
            ? ""
            : " && $K rollout status deployment/" + shellQuote(deploymentName) +
                  " -n " + shellQuote(nameSpace) + " --timeout=180s";
    const SshOperationResult commandResult = runRemoteCommand(
        config,
        "/tmp",
        "if command -v kubectl >/dev/null 2>&1; then K='kubectl'; elif command -v k3s >/dev/null 2>&1 && [ \"$(id -u)\" -eq 0 ]; then K='k3s kubectl'; else K='sudo -n k3s kubectl'; fi; "
        "$K scale deployment " + shellQuote(deploymentName) + " -n " + shellQuote(nameSpace) + " --replicas=" + std::to_string(result.desiredReplicas) + rolloutStatus,
        240
    );
    result.logs = commandResult.output;
    if (!commandResult.success) {
        result.error = commandResult.error.empty() ? "Failed to scale remote Kubernetes runtime" : commandResult.error;
        return result;
    }
    KubernetesRuntimeInfo inspected = inspectKubernetesRuntime(config, nameSpace, deploymentName, serviceName, exposureMode, runtimeScheme);
    inspected.logs = commandResult.output + inspected.logs;
    return inspected;
}

KubernetesRuntimeInfo SshService::rollbackKubernetesRuntime(const SshConnectionConfig& config,
                                                            const std::string& nameSpace,
                                                            const std::string& deploymentName,
                                                            const std::string& serviceName,
                                                            const std::string& exposureMode,
                                                            const std::string& runtimeScheme) const {
    const std::string kubectlSelector =
        "if command -v kubectl >/dev/null 2>&1; then K='kubectl'; "
        "elif command -v k3s >/dev/null 2>&1 && [ \"$(id -u)\" -eq 0 ]; then K='k3s kubectl'; "
        "elif command -v k3s >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then K='sudo -n k3s kubectl'; "
        "else echo __AIDS_KUBECTL_MISSING__; exit 30; fi; ";

    const SshOperationResult historyResult = runRemoteCommand(
        config,
        "/tmp",
        kubectlSelector +
        "$K rollout history deployment/" + shellQuote(deploymentName) + " -n " + shellQuote(nameSpace),
        60
    );
    if (!historyResult.success) {
        KubernetesRuntimeInfo failed;
        failed.nameSpace = nameSpace;
        failed.deploymentName = deploymentName;
        failed.serviceName = serviceName;
        failed.exposureMode = normalizeKubernetesExposure(exposureMode);
        failed.logs = historyResult.output;
        failed.error = historyResult.output.find("__AIDS_KUBECTL_MISSING__") != std::string::npos
            ? "kubectl or k3s is not installed on the remote host"
            : (historyResult.error.empty() ? "Unable to read remote Kubernetes rollout history" : historyResult.error);
        return failed;
    }
    if (countRolloutHistoryRevisions(historyResult.output) < 2) {
        KubernetesRuntimeInfo failed;
        failed.nameSpace = nameSpace;
        failed.deploymentName = deploymentName;
        failed.serviceName = serviceName;
        failed.exposureMode = normalizeKubernetesExposure(exposureMode);
        failed.logs = historyResult.output;
        failed.error = "No previous Kubernetes revision is available. Rollback works after at least two successful Kubernetes deployments.";
        return failed;
    }

    const SshOperationResult commandResult = runRemoteCommand(
        config,
        "/tmp",
        kubectlSelector +
        "$K rollout undo deployment/" + shellQuote(deploymentName) + " -n " + shellQuote(nameSpace) + " && "
        "$K rollout status deployment/" + shellQuote(deploymentName) + " -n " + shellQuote(nameSpace) + " --timeout=180s",
        240
    );
    if (!commandResult.success) {
        KubernetesRuntimeInfo failed;
        failed.nameSpace = nameSpace;
        failed.deploymentName = deploymentName;
        failed.serviceName = serviceName;
        failed.exposureMode = normalizeKubernetesExposure(exposureMode);
        failed.logs = commandResult.output;
        if (commandResult.output.find("no rollout history") != std::string::npos ||
            commandResult.output.find("no previous revision") != std::string::npos) {
            failed.error = "No previous Kubernetes revision is available. Rollback works after at least two successful Kubernetes deployments.";
        } else {
            failed.error = commandResult.error.empty() ? "Failed to rollback remote Kubernetes runtime" : commandResult.error;
        }
        return failed;
    }
    KubernetesRuntimeInfo inspected = inspectKubernetesRuntime(config, nameSpace, deploymentName, serviceName, exposureMode, runtimeScheme);
    inspected.logs = historyResult.output + commandResult.output + inspected.logs;
    return inspected;
}

KubernetesRuntimeInfo SshService::removeKubernetesRuntime(const SshConnectionConfig& config,
                                                          const std::string& nameSpace,
                                                          const std::string& deploymentName,
                                                          const std::string& serviceName,
                                                          const std::string& exposureMode) const {
    KubernetesRuntimeInfo result;
    result.success = true;
    result.nameSpace = nameSpace;
    result.deploymentName = deploymentName;
    result.serviceName = serviceName;
    result.exposureMode = normalizeKubernetesExposure(exposureMode);
    const std::string ingressName = sanitizeDnsLabelValue(deploymentName + "-ing");
    const SshOperationResult commandResult = runRemoteCommand(
        config,
        "/tmp",
        "if command -v kubectl >/dev/null 2>&1; then K='kubectl'; elif command -v k3s >/dev/null 2>&1 && [ \"$(id -u)\" -eq 0 ]; then K='k3s kubectl'; else K='sudo -n k3s kubectl'; fi; "
        "$K delete ingress " + shellQuote(ingressName) + " -n " + shellQuote(nameSpace) + " --ignore-not-found; "
        "$K delete service " + shellQuote(serviceName) + " -n " + shellQuote(nameSpace) + " --ignore-not-found; "
        "$K delete deployment " + shellQuote(deploymentName) + " -n " + shellQuote(nameSpace) + " --ignore-not-found; "
        "$K delete hpa " + shellQuote(sanitizeDnsLabelValue(deploymentName + "-hpa")) + " -n " + shellQuote(nameSpace) + " --ignore-not-found; "
        "$K delete pdb " + shellQuote(sanitizeDnsLabelValue(deploymentName + "-pdb")) + " -n " + shellQuote(nameSpace) + " --ignore-not-found; "
        "$K delete secret " + shellQuote(sanitizeDnsLabelValue(deploymentName + "-env")) + " -n " + shellQuote(nameSpace) + " --ignore-not-found",
        90
    );
    result.logs = commandResult.output;
    if (!commandResult.success) {
        result.success = false;
        result.error = commandResult.error.empty() ? "Failed to remove remote Kubernetes runtime" : commandResult.error;
    }
    return result;
}

std::string SshService::shellQuote(const std::string& value) const {
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

int SshService::runCommand(const std::string& command, std::string& output) const {
    output.clear();
    FILE* pipe = popen((command + " 2>&1").c_str(), "r");
    if (!pipe) {
        output = "Failed to start SSH command\n";
        return -1;
    }

    char buffer[4096];
    while (fgets(buffer, sizeof(buffer), pipe) != nullptr) {
        output += buffer;
    }

    const int rawExit = pclose(pipe);
    if (WIFEXITED(rawExit)) {
        return WEXITSTATUS(rawExit);
    }
    return rawExit;
}

} // namespace aids
