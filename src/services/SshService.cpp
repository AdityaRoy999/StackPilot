// ============================================================
// SshService.cpp - Encrypted SSH/VPS connectivity helpers
// ============================================================

#include "SshService.h"

#include "ComposeKubernetesPlanner.h"

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

std::string extractJsonObjectFromCommandOutput(const std::string& output) {
    const size_t start = output.find('{');
    if (start == std::string::npos) {
        return "";
    }

    const size_t exitMarker = output.find("__DOKSCP_EXIT_CODE__", start);
    const size_t searchEnd = exitMarker == std::string::npos ? output.size() : exitMarker;
    const size_t end = output.rfind('}', searchEnd);
    if (end == std::string::npos || end < start) {
        return "";
    }

    return output.substr(start, end - start + 1);
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

bool isValidClusterTextValue(const std::string& value, size_t maxLength = 255) {
    const std::string cleaned = trim(value);
    if (cleaned.size() > maxLength) {
        return false;
    }
    for (char c : cleaned) {
        if (std::iscntrl(static_cast<unsigned char>(c))) {
            return false;
        }
    }
    return true;
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

bool looksLikeGitHubCloneAuthFailure(const std::string& output) {
    const std::string lowered = toLower(output);
    return lowered.find("invalid username or token") != std::string::npos ||
           lowered.find("password authentication is not supported") != std::string::npos ||
           lowered.find("authentication failed") != std::string::npos ||
           lowered.find("repository not found") != std::string::npos ||
           lowered.find("could not read username") != std::string::npos;
}

std::string composePortFallbackShell(const std::string& composeFileArg,
                                     const std::string& projectArg) {
    return R"sh(
port_in_use() {
  port="$1"
  if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq '(^|:|])'"$port"'$'; then return 0; fi
  if command -v netstat >/dev/null 2>&1 && netstat -ltn 2>/dev/null | awk '{print $4}' | grep -Eq '(^|:|])'"$port"'$'; then return 0; fi
  if docker ps --format '{{.Ports}}' 2>/dev/null | grep -Eq '(^|, )([^ ]+:)?'"$port"'->'; then return 0; fi
  return 1
}
choose_port() {
  preferred="$1"
  shift
  for port in "$preferred" "$@"; do
    case "$port" in ''|*[!0-9]*) continue ;; esac
    if ! port_in_use "$port"; then echo "$port"; return 0; fi
  done
  port="$preferred"
  while [ "$port" -le 65535 ]; do
    if ! port_in_use "$port"; then echo "$port"; return 0; fi
    port=$((port + 1))
  done
  return 1
}
write_env_value() {
  key="$1"
  value="$2"
  touch .env
  if grep -q "^${key}=" .env 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${value}|" .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}
read_env_value() {
  key="$1"
  sed -n "s/^${key}=//p" .env 2>/dev/null | tail -n1 | tr -d '"' | tr -d "'" || true
}
next_port_after() {
  port="$1"
  case "$port" in ''|*[!0-9]*) return 1 ;; esac
  if [ "$port" -lt 65535 ]; then echo $((port + 1)); else return 1; fi
}
rewrite_conflicting_application_ports() {
  changed=0
  app_public_port=$(read_env_value APP_PUBLIC_PORT)
  if [ -n "$app_public_port" ]; then
    next_public=$(next_port_after "$app_public_port" || true)
    if [ -n "$next_public" ]; then
      app_public_next=$(choose_port "$next_public" 3307 5433 6380 27018 5673 4223 8082 8089 9002 9091 3001)
      if [ -n "$app_public_next" ] && [ "$app_public_next" != "$app_public_port" ]; then
        write_env_value APP_PUBLIC_PORT "$app_public_next"
        echo "Application port conflict detected; retrying with APP_PUBLIC_PORT=$app_public_next"
        changed=1
      fi
    fi
  fi
  app_public_ui_port=$(read_env_value APP_PUBLIC_UI_PORT)
  if [ -n "$app_public_ui_port" ]; then
    next_ui=$(next_port_after "$app_public_ui_port" || true)
    if [ -n "$next_ui" ]; then
      app_ui_next=$(choose_port "$next_ui" 15673 9002 8223 3002 8083 9092)
      if [ -n "$app_ui_next" ] && [ "$app_ui_next" != "$app_public_ui_port" ]; then
        write_env_value APP_PUBLIC_UI_PORT "$app_ui_next"
        echo "Application UI port conflict detected; retrying with APP_PUBLIC_UI_PORT=$app_ui_next"
        changed=1
      fi
    fi
  fi
  return "$changed"
}
compose_up_exit=0
compose_up_output=$($compose_cmd -f )sh" + composeFileArg + " -p " + projectArg + R"sh( up -d --build --remove-orphans 2>&1) || compose_up_exit=$?
printf '%s\n' "$compose_up_output"
if [ "$compose_up_exit" -ne 0 ]; then
  if printf '%s\n' "$compose_up_output" | grep -Eqi 'address already in use|ports are not available|only one usage of each socket address|bind:'; then
    rewrite_conflicting_application_ports || true
    http_port=$(choose_port 8080 8081 8082 8090 8000 3000)
    https_port=$(choose_port 8443 9443 10443 4443)
    write_env_value DOKSCP_HTTP_PORT "$http_port"
    write_env_value DOKSCP_HTTPS_PORT "$https_port"
    echo "Host port conflict detected; retrying Compose with DOKSCP_HTTP_PORT=$http_port and DOKSCP_HTTPS_PORT=$https_port"
    $compose_cmd -f )sh" + composeFileArg + " -p " + projectArg + R"sh( up -d --build --remove-orphans
  else
    exit "$compose_up_exit"
  fi
fi
)sh";
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

std::string encodeEnvFileValue(const std::string& value) {
    bool needsQuotes = value.empty();
    for (char c : value) {
        if (std::isspace(static_cast<unsigned char>(c)) || c == '#' || c == '"' || c == '\'' ||
            c == '\\' || c == '\n' || c == '\r' || c == '=') {
            needsQuotes = true;
            break;
        }
    }
    if (!needsQuotes) {
        return value;
    }

    std::string escaped;
    escaped.reserve(value.size() + 8);
    for (char c : value) {
        switch (c) {
            case '\\': escaped += "\\\\"; break;
            case '"': escaped += "\\\""; break;
            case '\n': escaped += "\\n"; break;
            case '\r': escaped += "\\r"; break;
            case '\t': escaped += "\\t"; break;
            default: escaped.push_back(c); break;
        }
    }
    return "\"" + escaped + "\"";
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
        out = "dokscp-runtime";
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
        shellQuote(files.sshpassPrefix + files.sshPrefix + " " + shellQuote("printf __DOKSCP_SSH_OK__"));

    std::string output;
    const int exitCode = runCommand(command, output);
    cleanupSessionFiles(files);

    if (exitCode != 0 || output.find("__DOKSCP_SSH_OK__") == std::string::npos) {
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
            result.error = "SSH server is not reachable from the DOKSCP backend container";
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
        "; [ -d \"$target\" ] || { echo __DOKSCP_INVALID_PATH__; exit 9; }; " \
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
        result.error = output.find("__DOKSCP_INVALID_PATH__") != std::string::npos
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
        "; [ -d \"$target\" ] || { echo __DOKSCP_INVALID_PATH__; exit 9; }; " \
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
        result.error = output.find("__DOKSCP_INVALID_PATH__") != std::string::npos
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
        "echo __DOKSCP_PROBE_START__; "
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
        "echo __DOKSCP_PROBE_END__";
    const std::string command =
        "timeout 35s sh -lc " +
        shellQuote(files.sshpassPrefix + files.sshPrefix + " " + shellQuote(remoteCommand));

    std::string output;
    const int exitCode = runCommand(command, output);
    cleanupSessionFiles(files);

    if (exitCode != 0 || output.find("__DOKSCP_PROBE_START__") == std::string::npos) {
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

SshOperationResult SshService::provisionDockerHost(const SshConnectionConfig& config, const std::string& sudoPassword) const {
    SshOperationResult result;
    std::string error;
    if (!isValidConnectionConfig(config, error)) {
        result.error = error;
        return result;
    }

    const SessionFiles files = prepareSessionFiles(config);
    const bool hasSudoPass = !sudoPassword.empty();
    const std::string sudoCmd = hasSudoPass
        ? "echo " + shellQuote(sudoPassword) + " | sudo -S"
        : "sudo -n";
    const std::string sudoCheck = hasSudoPass
        ? "echo " + shellQuote(sudoPassword) + " | sudo -S true >/dev/null 2>&1"
        : "sudo -n true >/dev/null 2>&1";
    const std::string remoteCommand =
        "set -e; "
        "echo __DOKSCP_PROVISION_DOCKER_START__; "
        "if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then "
        "  echo docker_status=ready; echo __DOKSCP_PROVISION_DOCKER_DONE__; exit 0; "
        "fi; "
        "if [ \"$(id -u)\" -ne 0 ] && ! " + sudoCheck + "; then "
        "  echo __DOKSCP_SUDO_REQUIRED__; exit 20; "
        "fi; "
        "SUDO=''; [ \"$(id -u)\" -eq 0 ] || SUDO='" + sudoCmd + "'; "
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
        "  echo __DOKSCP_UNSUPPORTED_PACKAGE_MANAGER__; exit 21; "
        "fi; "
        "($SUDO systemctl enable --now docker >/dev/null 2>&1 || $SUDO service docker start >/dev/null 2>&1 || true); "
        "$SUDO usermod -aG docker \"$(id -un)\" >/dev/null 2>&1 || true; "
        "if docker info >/dev/null 2>&1; then "
        "  echo docker_status=ready; "
        "elif $SUDO docker info >/dev/null 2>&1; then "
        "  echo __DOKSCP_DOCKER_RELOGIN_REQUIRED__; "
        "else "
        "  echo __DOKSCP_DOCKER_DAEMON_DOWN__; exit 22; "
        "fi; "
        "docker --version 2>/dev/null || true; "
        "echo __DOKSCP_PROVISION_DOCKER_DONE__";

    const std::string command =
        "timeout 600s sh -lc " +
        shellQuote(files.sshpassPrefix + files.sshPrefix + " " + shellQuote(remoteCommand));

    std::string output;
    const int exitCode = runCommand(command, output);
    cleanupSessionFiles(files);

    result.exitCode = exitCode;
    result.output = output;
    if (exitCode != 0 || output.find("__DOKSCP_PROVISION_DOCKER_DONE__") == std::string::npos) {
        if (output.find("__DOKSCP_SUDO_REQUIRED__") != std::string::npos) {
            result.error = "Docker provisioning requires root or passwordless sudo on the remote host";
        } else if (output.find("__DOKSCP_UNSUPPORTED_PACKAGE_MANAGER__") != std::string::npos) {
            result.error = "Unsupported Linux package manager. Install Docker manually, then probe again.";
        } else if (output.find("__DOKSCP_DOCKER_DAEMON_DOWN__") != std::string::npos) {
            result.error = "Docker was installed, but the daemon is not reachable";
        } else if (exitCode == 124) {
            result.error = "Docker provisioning timed out";
        } else {
            result.error = "Docker provisioning failed";
        }
        return result;
    }

    result.success = true;
    if (output.find("__DOKSCP_DOCKER_RELOGIN_REQUIRED__") != std::string::npos) {
        result.error = "Docker is installed, but this user may need to reconnect before docker commands work without sudo";
    }
    return result;
}

SshOperationResult SshService::provisionLightweightKubernetesHost(const SshConnectionConfig& config, const std::string& sudoPassword) const {
    SshOperationResult result;
    std::string error;
    if (!isValidConnectionConfig(config, error)) {
        result.error = error;
        return result;
    }

    const SessionFiles files = prepareSessionFiles(config);
    const bool hasSudoPass = !sudoPassword.empty();
    const std::string sudoCmd = hasSudoPass
        ? "echo " + shellQuote(sudoPassword) + " | sudo -S"
        : "sudo -n";
    const std::string sudoCheck = hasSudoPass
        ? "echo " + shellQuote(sudoPassword) + " | sudo -S true >/dev/null 2>&1"
        : "sudo -n true >/dev/null 2>&1";
    const std::string remoteCommand =
        "set -e; "
        "echo __DOKSCP_PROVISION_K8S_START__; "
        "if (command -v kubectl >/dev/null 2>&1 && kubectl get nodes >/dev/null 2>&1) || "
        "   (command -v k3s >/dev/null 2>&1 && (k3s kubectl get nodes >/dev/null 2>&1 || " + sudoCmd + " k3s kubectl get nodes >/dev/null 2>&1)); then "
        "  echo kubernetes_status=ready; echo __DOKSCP_PROVISION_K8S_DONE__; exit 0; "
        "fi; "
        "if [ \"$(id -u)\" -ne 0 ] && ! " + sudoCheck + "; then "
        "  echo __DOKSCP_SUDO_REQUIRED__; exit 20; "
        "fi; "
        "command -v curl >/dev/null 2>&1 || { echo __DOKSCP_CURL_MISSING__; exit 21; }; "
        "SUDO=''; [ \"$(id -u)\" -eq 0 ] || SUDO='" + sudoCmd + "'; "
        "curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC='--secrets-encryption --write-kubeconfig-mode=644' $SUDO sh - || { echo __DOKSCP_K3S_INSTALL_FAILED__; exit 22; }; "
        "sleep 4; "
        "if command -v kubectl >/dev/null 2>&1; then K='kubectl'; "
        "elif [ \"$(id -u)\" -eq 0 ]; then K='k3s kubectl'; "
        "else K='" + sudoCmd + " k3s kubectl'; fi; "
        "$K get nodes || { echo __DOKSCP_K8S_VERIFY_FAILED__; exit 23; }; "
        "$K get ingressclass >/dev/null 2>&1 || true; "
        "echo kubernetes_status=ready; "
        "echo __DOKSCP_PROVISION_K8S_DONE__";

    const std::string command =
        "timeout 900s sh -lc " +
        shellQuote(files.sshpassPrefix + files.sshPrefix + " " + shellQuote(remoteCommand));

    std::string output;
    const int exitCode = runCommand(command, output);
    cleanupSessionFiles(files);

    result.exitCode = exitCode;
    result.output = output;
    if (exitCode != 0 || output.find("__DOKSCP_PROVISION_K8S_DONE__") == std::string::npos) {
        if (output.find("__DOKSCP_SUDO_REQUIRED__") != std::string::npos) {
            result.error = "Lightweight Kubernetes setup requires root or passwordless sudo on the remote host";
        } else if (output.find("__DOKSCP_CURL_MISSING__") != std::string::npos) {
            result.error = "curl is required to install lightweight Kubernetes";
        } else if (output.find("__DOKSCP_K3S_INSTALL_FAILED__") != std::string::npos) {
            result.error = "k3s installation failed on the remote host";
        } else if (output.find("__DOKSCP_K8S_VERIFY_FAILED__") != std::string::npos) {
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

SshOperationResult SshService::initializeK3sControlPlane(const SshConnectionConfig& config,
                                                         const std::string& sudoPassword,
                                                         const std::string& advertiseAddress,
                                                         const std::string& tlsSan) const {
    SshOperationResult result;
    std::string error;
    if (!isValidConnectionConfig(config, error)) {
        result.error = error;
        return result;
    }
    if (!isValidClusterTextValue(advertiseAddress) || !isValidClusterTextValue(tlsSan)) {
        result.error = "Cluster address values contain unsupported control characters";
        return result;
    }

    const std::string apiHost = trim(advertiseAddress).empty() ? trim(config.host) : trim(advertiseAddress);
    if (apiHost.empty()) {
        result.error = "A control-plane host or advertise address is required";
        return result;
    }

    std::string installExec = "server --secrets-encryption --write-kubeconfig-mode=644";
    if (!trim(advertiseAddress).empty()) {
        installExec += " --node-ip " + trim(advertiseAddress);
        installExec += " --advertise-address " + trim(advertiseAddress);
    }
    if (!trim(tlsSan).empty()) {
        installExec += " --tls-san " + trim(tlsSan);
    }
    if (!trim(config.host).empty() && trim(config.host) != trim(tlsSan)) {
        installExec += " --tls-san " + trim(config.host);
    }

    const SessionFiles files = prepareSessionFiles(config);
    const bool hasSudoPass = !sudoPassword.empty();
    const std::string sudoCheck = hasSudoPass
        ? "echo " + shellQuote(sudoPassword) + " | sudo -S true >/dev/null 2>&1"
        : "sudo -n true >/dev/null 2>&1";
    const std::string installAsRoot =
        "env INSTALL_K3S_EXEC=" + shellQuote(installExec) + " sh \"$tmp\"";
    const std::string installWithSudo = hasSudoPass
        ? "echo " + shellQuote(sudoPassword) + " | sudo -S env INSTALL_K3S_EXEC=" + shellQuote(installExec) + " sh \"$tmp\""
        : "sudo -n env INSTALL_K3S_EXEC=" + shellQuote(installExec) + " sh \"$tmp\"";
    const std::string tokenCommand = hasSudoPass
        ? "echo " + shellQuote(sudoPassword) + " | sudo -S cat /var/lib/rancher/k3s/server/node-token"
        : "sudo -n cat /var/lib/rancher/k3s/server/node-token";
    const std::string privilegedKubectl = hasSudoPass
        ? "echo " + shellQuote(sudoPassword) + " | sudo -S k3s kubectl"
        : "sudo -n k3s kubectl";
    const std::string getNodesCommand =
        "if command -v kubectl >/dev/null 2>&1; then kubectl get nodes -o wide; "
        "elif [ \"$(id -u)\" -eq 0 ]; then k3s kubectl get nodes -o wide; "
        "else " + privilegedKubectl + " get nodes -o wide; fi";

    const std::string remoteCommand =
        "set -e; "
        "echo __DOKSCP_K3S_CLUSTER_INIT_START__; "
        "if [ \"$(id -u)\" -ne 0 ] && ! " + sudoCheck + "; then echo __DOKSCP_SUDO_REQUIRED__; exit 20; fi; "
        "command -v curl >/dev/null 2>&1 || { echo __DOKSCP_CURL_MISSING__; exit 21; }; "
        "if command -v k3s >/dev/null 2>&1; then echo dokscp_k3s_existing=yes; "
        "else tmp=$(mktemp); curl -sfL https://get.k3s.io -o \"$tmp\" || { rm -f \"$tmp\"; echo __DOKSCP_K3S_DOWNLOAD_FAILED__; exit 22; }; chmod +x \"$tmp\"; "
        "if [ \"$(id -u)\" -eq 0 ]; then " + installAsRoot + "; else " + installWithSudo + "; fi || { rm -f \"$tmp\"; echo __DOKSCP_K3S_INSTALL_FAILED__; exit 23; }; rm -f \"$tmp\"; fi; "
        "sleep 5; "
        "(" + getNodesCommand + ") || { echo __DOKSCP_K3S_VERIFY_FAILED__; exit 24; }; "
        "echo dokscp_cluster_server_url=" + shellQuote("https://" + apiHost + ":6443") + "; "
        "printf 'dokscp_cluster_token='; if [ \"$(id -u)\" -eq 0 ]; then cat /var/lib/rancher/k3s/server/node-token; else " + tokenCommand + "; fi; "
        "echo __DOKSCP_K3S_CLUSTER_NODES_BEGIN__; " + getNodesCommand + "; echo __DOKSCP_K3S_CLUSTER_NODES_END__; "
        "echo __DOKSCP_K3S_CLUSTER_INIT_DONE__";

    const std::string command =
        "timeout 900s sh -lc " +
        shellQuote(files.sshpassPrefix + files.sshPrefix + " " + shellQuote(remoteCommand));

    std::string output;
    const int exitCode = runCommand(command, output);
    cleanupSessionFiles(files);
    capOutput(output, 240000);

    result.exitCode = exitCode;
    result.output = output;
    if (exitCode != 0 || output.find("__DOKSCP_K3S_CLUSTER_INIT_DONE__") == std::string::npos) {
        if (output.find("__DOKSCP_SUDO_REQUIRED__") != std::string::npos) {
            result.error = "Control-plane bootstrap requires root or passwordless sudo on the remote host";
        } else if (output.find("__DOKSCP_CURL_MISSING__") != std::string::npos) {
            result.error = "curl is required to install k3s on the control plane";
        } else if (output.find("__DOKSCP_K3S_DOWNLOAD_FAILED__") != std::string::npos) {
            result.error = "Unable to download the k3s installer on the control plane";
        } else if (output.find("__DOKSCP_K3S_INSTALL_FAILED__") != std::string::npos) {
            result.error = "k3s server installation failed on the control plane";
        } else if (output.find("__DOKSCP_K3S_VERIFY_FAILED__") != std::string::npos) {
            result.error = "k3s server installed, but the control-plane node did not become ready";
        } else if (exitCode == 124) {
            result.error = "Control-plane bootstrap timed out";
        } else {
            result.error = "Control-plane bootstrap failed";
        }
        return result;
    }

    result.success = true;
    return result;
}

SshOperationResult SshService::joinK3sWorker(const SshConnectionConfig& config,
                                             const std::string& serverUrl,
                                             const std::string& nodeToken,
                                             const std::string& sudoPassword) const {
    SshOperationResult result;
    std::string error;
    if (!isValidConnectionConfig(config, error)) {
        result.error = error;
        return result;
    }
    const std::string cleanedServerUrl = trim(serverUrl);
    const std::string cleanedToken = trim(nodeToken);
    if (!cleanedServerUrl.starts_with("https://") || cleanedToken.empty() ||
        !isValidClusterTextValue(cleanedServerUrl, 512) || !isValidClusterTextValue(cleanedToken, 4096)) {
        result.error = "A valid k3s server URL and node token are required";
        return result;
    }

    const SessionFiles files = prepareSessionFiles(config);
    const bool hasSudoPass = !sudoPassword.empty();
    const std::string sudoCheck = hasSudoPass
        ? "echo " + shellQuote(sudoPassword) + " | sudo -S true >/dev/null 2>&1"
        : "sudo -n true >/dev/null 2>&1";
    const std::string installAsRoot =
        "env K3S_URL=" + shellQuote(cleanedServerUrl) + " K3S_TOKEN=" + shellQuote(cleanedToken) + " sh \"$tmp\"";
    const std::string installWithSudo = hasSudoPass
        ? "echo " + shellQuote(sudoPassword) + " | sudo -S env K3S_URL=" + shellQuote(cleanedServerUrl) + " K3S_TOKEN=" + shellQuote(cleanedToken) + " sh \"$tmp\""
        : "sudo -n env K3S_URL=" + shellQuote(cleanedServerUrl) + " K3S_TOKEN=" + shellQuote(cleanedToken) + " sh \"$tmp\"";

    const std::string remoteCommand =
        "set -e; "
        "echo __DOKSCP_K3S_WORKER_JOIN_START__; "
        "if [ \"$(id -u)\" -ne 0 ] && ! " + sudoCheck + "; then echo __DOKSCP_SUDO_REQUIRED__; exit 20; fi; "
        "command -v curl >/dev/null 2>&1 || { echo __DOKSCP_CURL_MISSING__; exit 21; }; "
        "if systemctl is-active --quiet k3s-agent 2>/dev/null || systemctl is-active --quiet k3s 2>/dev/null; then echo dokscp_k3s_existing=yes; "
        "else tmp=$(mktemp); curl -sfL https://get.k3s.io -o \"$tmp\" || { rm -f \"$tmp\"; echo __DOKSCP_K3S_DOWNLOAD_FAILED__; exit 22; }; chmod +x \"$tmp\"; "
        "if [ \"$(id -u)\" -eq 0 ]; then " + installAsRoot + "; else " + installWithSudo + "; fi || { rm -f \"$tmp\"; echo __DOKSCP_K3S_AGENT_INSTALL_FAILED__; exit 23; }; rm -f \"$tmp\"; fi; "
        "sleep 5; "
        "if systemctl is-active --quiet k3s-agent 2>/dev/null || systemctl is-active --quiet k3s 2>/dev/null; then "
        "echo dokscp_worker_status=ready; echo __DOKSCP_K3S_WORKER_JOIN_DONE__; "
        "else echo __DOKSCP_K3S_AGENT_VERIFY_FAILED__; exit 24; fi";

    const std::string command =
        "timeout 900s sh -lc " +
        shellQuote(files.sshpassPrefix + files.sshPrefix + " " + shellQuote(remoteCommand));

    std::string output;
    const int exitCode = runCommand(command, output);
    cleanupSessionFiles(files);
    capOutput(output, 160000);

    result.exitCode = exitCode;
    result.output = output;
    if (exitCode != 0 || output.find("__DOKSCP_K3S_WORKER_JOIN_DONE__") == std::string::npos) {
        if (output.find("__DOKSCP_SUDO_REQUIRED__") != std::string::npos) {
            result.error = "Worker join requires root or passwordless sudo on the remote host";
        } else if (output.find("__DOKSCP_CURL_MISSING__") != std::string::npos) {
            result.error = "curl is required to install k3s on the worker";
        } else if (output.find("__DOKSCP_K3S_DOWNLOAD_FAILED__") != std::string::npos) {
            result.error = "Unable to download the k3s installer on the worker";
        } else if (output.find("__DOKSCP_K3S_AGENT_INSTALL_FAILED__") != std::string::npos) {
            result.error = "k3s agent installation failed on the worker";
        } else if (output.find("__DOKSCP_K3S_AGENT_VERIFY_FAILED__") != std::string::npos) {
            result.error = "k3s agent installed, but the worker service did not become ready";
        } else if (exitCode == 124) {
            result.error = "Worker join timed out";
        } else {
            result.error = "Worker join failed";
        }
        return result;
    }

    result.success = true;
    return result;
}

SshOperationResult SshService::inspectK3sCluster(const SshConnectionConfig& config) const {
    SshOperationResult result;
    std::string error;
    if (!isValidConnectionConfig(config, error)) {
        result.error = error;
        return result;
    }

    const SessionFiles files = prepareSessionFiles(config);
    const std::string remoteCommand =
        "set -e; "
        "echo __DOKSCP_K3S_CLUSTER_STATUS_START__; "
        "if command -v kubectl >/dev/null 2>&1; then K='kubectl'; "
        "elif command -v k3s >/dev/null 2>&1 && [ \"$(id -u)\" -eq 0 ]; then K='k3s kubectl'; "
        "elif command -v k3s >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then K='sudo -n k3s kubectl'; "
        "else echo __DOKSCP_KUBECTL_MISSING__; exit 20; fi; "
        "echo __DOKSCP_K3S_CLUSTER_NODES_BEGIN__; $K get nodes -o wide; echo __DOKSCP_K3S_CLUSTER_NODES_END__; "
        "echo __DOKSCP_K3S_CLUSTER_PODS_BEGIN__; $K get pods -A -o wide; echo __DOKSCP_K3S_CLUSTER_PODS_END__; "
        "echo __DOKSCP_K3S_CLUSTER_INFO_BEGIN__; $K cluster-info || true; echo __DOKSCP_K3S_CLUSTER_INFO_END__; "
        "echo __DOKSCP_K3S_CLUSTER_STATUS_DONE__";

    const std::string command =
        "timeout 90s sh -lc " +
        shellQuote(files.sshpassPrefix + files.sshPrefix + " " + shellQuote(remoteCommand));

    std::string output;
    const int exitCode = runCommand(command, output);
    cleanupSessionFiles(files);
    capOutput(output, 240000);

    result.exitCode = exitCode;
    result.output = output;
    if (exitCode != 0 || output.find("__DOKSCP_K3S_CLUSTER_STATUS_DONE__") == std::string::npos) {
        result.error = output.find("__DOKSCP_KUBECTL_MISSING__") != std::string::npos
            ? "kubectl or k3s is not available on the control-plane host"
            : "Failed to inspect the Kubernetes cluster";
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
        "[ -d \"$target\" ] || { echo __DOKSCP_INVALID_CWD__; exit 9; }; "
        "cd \"$target\"; "
        "export TERM=dumb CI=1; "
        "echo __DOKSCP_CWD__=$(pwd); "
        "(" + command + "); "
        "code=$?; echo __DOKSCP_EXIT_CODE__=$code; exit $code";

    const std::string wrappedCommand =
        "timeout " + std::to_string(boundedTimeout) + "s sh -lc " +
        shellQuote(files.sshpassPrefix + files.sshPrefix + " " + shellQuote(remoteCommand));

    std::string output;
    const int exitCode = runCommand(wrappedCommand, output);
    cleanupSessionFiles(files);
    capOutput(output);

    result.exitCode = exitCode;
    result.output = output;
    if (output.find("__DOKSCP_INVALID_CWD__") != std::string::npos) {
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

SshOperationResult SshService::uploadFile(const SshConnectionConfig& config,
                                          const std::string& localPath,
                                          const std::string& remotePath,
                                          int timeoutSeconds,
                                          SshLogCallback onLogLine) const {
    SshOperationResult result;
    std::string error;
    if (!isValidConnectionConfig(config, error)) {
        result.error = error;
        return result;
    }
    if (!isValidRemotePath(remotePath)) {
        result.error = "Remote upload path must be an absolute Linux path";
        return result;
    }
    if (localPath.empty()) {
        result.error = "Local upload path is required";
        return result;
    }

    std::string remoteDir = remotePath;
    const auto slash = remoteDir.find_last_of('/');
    remoteDir = slash == std::string::npos || slash == 0 ? "/" : remoteDir.substr(0, slash);

    const SessionFiles files = prepareSessionFiles(config);
    const std::string remoteCommand =
        "set -e; mkdir -p " + shellQuote(remoteDir) +
        "; cat > " + shellQuote(remotePath) +
        "; chmod 600 " + shellQuote(remotePath) +
        "; echo __DOKSCP_UPLOAD_DONE__";
    const std::string command =
        "timeout " + std::to_string(std::max(30, timeoutSeconds)) + "s sh -lc " +
        shellQuote("cat " + shellQuote(localPath) + " | " +
                   files.sshpassPrefix + files.sshPrefix + " " + shellQuote(remoteCommand));

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

    result.exitCode = exitCode;
    result.output = output;
    if (exitCode != 0 || output.find("__DOKSCP_UPLOAD_DONE__") == std::string::npos) {
        result.error = exitCode == 124 ? "Remote file upload timed out" : "Failed to upload file to remote host";
        return result;
    }

    result.success = true;
    return result;
}

SshOperationResult SshService::cloneGitRepository(const SshConnectionConfig& config,
                                                  const std::string& workingDirectory,
                                                  const std::string& repositoryUrl,
                                                  const std::string& targetDirectory,
                                                  int timeoutSeconds,
                                                  const std::string& gitToken,
                                                  const std::string& branch,
                                                  const std::string& commitSha) const {
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
    const std::string branchArg = trim(branch).empty()
        ? ""
        : " --branch " + shellQuote(trim(branch));
    const std::string targetPath = trim(targetDirectory).empty() ? "." : trim(targetDirectory);
    std::string credentialSetup;
    if (!gitToken.empty() && trim(repositoryUrl).starts_with("https://github.com/")) {
        credentialSetup =
            "token_file=$(mktemp \"$target/.git-token.XXXXXX\"); "
            "askpass_file=$(mktemp \"$target/.git-askpass.XXXXXX\"); "
            "chmod 600 \"$token_file\"; "
            "printf '%s' " + shellQuote(gitToken) + " > \"$token_file\"; "
            "cat > \"$askpass_file\" <<'__DOKSCP_ASKPASS_EOF__'\n"
            "#!/bin/sh\n"
            "case \"$1\" in\n"
            "  *Username*) printf '%s\\n' 'x-access-token' ;;\n"
            "  *Password*) cat \"$DOKSCP_GIT_TOKEN_FILE\" ;;\n"
            "  *) printf '\\n' ;;\n"
            "esac\n"
            "__DOKSCP_ASKPASS_EOF__\n"
            "chmod 700 \"$askpass_file\"; "
            "export DOKSCP_GIT_TOKEN_FILE=\"$token_file\" GIT_ASKPASS=\"$askpass_file\" GIT_TERMINAL_PROMPT=0; "
            "trap 'rm -f \"$token_file\" \"$askpass_file\"' EXIT; ";
    }
    const std::string remoteCommand =
        "set -e; "
        "target=" + shellQuote(workingDirectory) + "; "
        "[ -d \"$target\" ] || { echo __DOKSCP_INVALID_CWD__; exit 9; }; "
        "command -v git >/dev/null 2>&1 || { echo __DOKSCP_GIT_MISSING__; exit 10; }; "
        "cd \"$target\"; "
        + credentialSetup +
        "git clone --progress --depth 1" + branchArg + " " + shellQuote(trim(repositoryUrl)) + targetArg + "; "
        + (trim(commitSha).empty()
            ? ""
            : "cd " + shellQuote(targetPath) + "; "
              "git checkout --detach " + shellQuote(trim(commitSha)) + " || "
              "(git fetch --depth 1 origin " + shellQuote(trim(commitSha)) + " && git checkout --detach " + shellQuote(trim(commitSha)) + "); "
              "cd \"$target\"; ") +
        "echo __DOKSCP_CLONE_PATH__=$(pwd)/" + (trim(targetDirectory).empty() ? "" : shellQuote(trim(targetDirectory)));

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
        if (output.find("__DOKSCP_INVALID_CWD__") != std::string::npos) {
            result.error = "Clone destination does not exist on the remote host";
        } else if (output.find("__DOKSCP_GIT_MISSING__") != std::string::npos) {
            result.error = "Git is not installed on the remote host";
        } else if (exitCode == 124) {
            result.error = "Git clone timed out";
        } else if (trim(repositoryUrl).starts_with("https://github.com/") &&
                   looksLikeGitHubCloneAuthFailure(output)) {
            result.error = gitToken.empty()
                ? "GitHub clone failed because no usable token was available for the remote HTTPS clone. Reconnect GitHub, install the GitHub App on this repository, or add a project token with repo access."
                : "GitHub rejected the remote clone credentials. Check that the repository URL is correct and that the connected GitHub token or GitHub App installation can access this repository.";
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
        if (isValidEnvKeyValue(envVar.first)) {
            envContent << envVar.first << "=" << encodeEnvFileValue(envVar.second) << "\n";
        }
    }

    const SessionFiles files = prepareSessionFiles(config);
    const std::string envFile = ".env.dokscp." + containerName;
    const std::string remoteCommand =
        "set -e; "
        "target=" + shellQuote(remotePath) + "; "
        "[ -d \"$target\" ] || { echo __DOKSCP_INVALID_PATH__; exit 9; }; "
        "cd \"$target\"; "
        "command -v docker >/dev/null 2>&1 || { echo __DOKSCP_DOCKER_MISSING__; exit 10; }; "
        "docker info >/dev/null 2>&1 || { echo __DOKSCP_DOCKER_DAEMON_DOWN__; exit 11; }; "
        "compose_file=''; "
        "for f in docker-compose.dokscp.yml docker-compose.dokscp.yaml docker-compose.prod.yml docker-compose.prod.yaml compose.prod.yml compose.prod.yaml docker-compose.yml docker-compose.yaml compose.yml compose.yaml; do [ -f \"$f\" ] && { compose_file=\"$f\"; break; }; done; "
        "if [ -n \"$compose_file\" ]; then "
        "  compose_cmd='docker compose'; "
        "  if ! docker compose version >/dev/null 2>&1; then if command -v docker-compose >/dev/null 2>&1; then compose_cmd='docker-compose'; else echo __DOKSCP_COMPOSE_MISSING__; exit 20; fi; fi; "
        "  cat > " + shellQuote(envFile) + " <<'__DOKSCP_ENV_EOF__'\n" +
        envContent.str() +
        "__DOKSCP_ENV_EOF__\n"
        "  cp " + shellQuote(envFile) + " .env 2>/dev/null || true; "
        "  cp " + shellQuote(envFile) + " .env.local 2>/dev/null || true; "
        "  cp " + shellQuote(envFile) + " .env.production.local 2>/dev/null || true; "
        "  compose_parallel_limit=$(sed -n 's/^DOKSCP_COMPOSE_PARALLEL_LIMIT=//p' .env 2>/dev/null | tail -n1 | tr -d '\"' | tr -d \"'\" || true); "
        "  [ -n \"$compose_parallel_limit\" ] || compose_parallel_limit=1; "
        "  export COMPOSE_PARALLEL_LIMIT=\"$compose_parallel_limit\"; "
        "  echo 'Detected Docker Compose project: '\"$compose_file\"; "
        "  $compose_cmd -f \"$compose_file\" -p " + shellQuote(containerName) + " config --services > .dokscp-compose-services; "
        "  services=$(paste -sd, .dokscp-compose-services 2>/dev/null || true); "
        "  echo __DOKSCP_REMOTE_COMPOSE_PROJECT__=" + containerName + "; "
        "  echo __DOKSCP_REMOTE_COMPOSE_FILE__=$compose_file; "
        "  echo __DOKSCP_REMOTE_COMPOSE_SERVICES__=$services; "
        "  $compose_cmd -f \"$compose_file\" -p " + shellQuote(containerName) + " pull --ignore-pull-failures || true; "
        + composePortFallbackShell("\"$compose_file\"", shellQuote(containerName)) +
        "  runtime=''; domain=$(sed -n 's/^DOKSCP_DOMAIN=//p' .env 2>/dev/null | tail -n1 | tr -d '\"' | tr -d \"'\" || true); "
        "  require_https=$(sed -n 's/^DOKSCP_REQUIRE_HTTPS=//p' .env 2>/dev/null | tail -n1 | tr '[:upper:]' '[:lower:]' | tr -d '\"' | tr -d \"'\" || true); "
        "  http_port=$(sed -n 's/^DOKSCP_HTTP_PORT=//p' .env 2>/dev/null | tail -n1 | tr -d '\"' | tr -d \"'\" || true); "
        "  https_port=$(sed -n 's/^DOKSCP_HTTPS_PORT=//p' .env 2>/dev/null | tail -n1 | tr -d '\"' | tr -d \"'\" || true); "
        "  if [ -n \"$domain\" ]; then "
        "    if [ \"$require_https\" = 'true' ]; then "
        "      if [ -n \"$https_port\" ] && [ \"$https_port\" != '443' ]; then runtime=\"https://$domain:$https_port\"; else runtime=\"https://$domain\"; fi; "
        "    else "
        "      if [ -n \"$http_port\" ] && [ \"$http_port\" != '80' ]; then runtime=\"http://$domain:$http_port\"; else runtime=\"http://$domain\"; fi; "
        "    fi; "
        "  fi; "
        "  if [ -z \"$runtime\" ]; then "
        "    for svc in $(cat .dokscp-compose-services 2>/dev/null); do "
        "      for port in 80 443 3000 8080 8000 5000 5173 15672 9001 8222 9090 3100 5432 3306 6379 27017 5672 9000 4222; do "
        "        mapped=$($compose_cmd -f \"$compose_file\" -p " + shellQuote(containerName) + " port \"$svc\" \"$port\" 2>/dev/null | head -n1 | awk -F: 'NF {print $NF; exit}'); "
        "        if [ -n \"$mapped\" ]; then scheme='http'; [ \"$port\" = '443' ] && scheme='https'; case \"$port\" in 5432|3306|6379|27017|5672|4222) scheme='tcp';; esac; runtime=\"$scheme://" + config.host + ":$mapped\"; break 2; fi; "
        "      done; "
        "    done; "
        "  fi; "
        "  echo __DOKSCP_REMOTE_URL__=$runtime; "
        "  $compose_cmd -f \"$compose_file\" -p " + shellQuote(containerName) + " ps; "
        "  exit 0; "
        "fi; "
        "dockerfile_arg='-f Dockerfile'; "
        "if [ ! -f Dockerfile ]; then "
        "  mkdir -p .dokscp; "
        "  dockerfile_arg='-f .dokscp/Dockerfile'; "
        "  if [ -f package.json ]; then "
        "    cat > .dokscp/Dockerfile <<'__DOKSCP_DOCKERFILE_EOF__'\n"
        "FROM node:20-alpine\n"
        "WORKDIR /app\n"
        "COPY package*.json ./\n"
        "RUN npm ci || npm install\n"
        "COPY . .\n"
        "RUN if [ -f next.config.js ] || [ -f next.config.mjs ] || [ -f next.config.ts ] || node -e \"const fs=require('fs');const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));if(!(pkg.scripts&&pkg.scripts.build)) process.exit(1)\"; then npm run build; fi\n"
        "EXPOSE 3000\n"
        "CMD [\"sh\", \"-c\", \"node -e \\\"const p=require('./package.json');process.exit(p.scripts&&p.scripts.start?0:1)\\\" && npm start || node server.js || node index.js || node app.js\"]\n"
        "__DOKSCP_DOCKERFILE_EOF__\n"
        "  elif [ -f requirements.txt ]; then "
        "    cat > .dokscp/Dockerfile <<'__DOKSCP_DOCKERFILE_EOF__'\n"
        "FROM python:3.12-slim\n"
        "WORKDIR /app\n"
        "COPY requirements.txt ./\n"
        "RUN pip install --no-cache-dir -r requirements.txt\n"
        "COPY . .\n"
        "EXPOSE 3000\n"
        "CMD [\"sh\", \"-c\", \"if python - <<'PY'\\nimport importlib.util,sys\\nsys.exit(0 if importlib.util.find_spec('streamlit') else 1)\\nPY\\nthen f=$(ls app.py main.py *.py 2>/dev/null | head -n1); exec streamlit run ${f:-app.py} --server.address=0.0.0.0 --server.port=3000; elif python - <<'PY'\\nimport importlib.util,sys\\nsys.exit(0 if importlib.util.find_spec('uvicorn') else 1)\\nPY\\nthen m=$(if [ -f app.py ]; then echo app; elif [ -f main.py ]; then echo main; else ls *.py 2>/dev/null | head -n1 | sed 's/\\\\.py$//'; fi); exec uvicorn ${m}:app --host 0.0.0.0 --port 3000; else exec python $( [ -f app.py ] && echo app.py || echo main.py ); fi\"]\n"
        "__DOKSCP_DOCKERFILE_EOF__\n"
        "  elif [ -f pyproject.toml ]; then "
        "    cat > .dokscp/Dockerfile <<'__DOKSCP_DOCKERFILE_EOF__'\n"
        "FROM python:3.12-slim\n"
        "WORKDIR /app\n"
        "COPY . .\n"
        "RUN pip install --no-cache-dir .\n"
        "EXPOSE 3000\n"
        "CMD [\"sh\", \"-c\", \"if python - <<'PY'\\nimport importlib.util,sys\\nsys.exit(0 if importlib.util.find_spec('streamlit') else 1)\\nPY\\nthen f=$(ls app.py main.py *.py 2>/dev/null | head -n1); exec streamlit run ${f:-app.py} --server.address=0.0.0.0 --server.port=3000; elif python - <<'PY'\\nimport importlib.util,sys\\nsys.exit(0 if importlib.util.find_spec('uvicorn') else 1)\\nPY\\nthen m=$(if [ -f app.py ]; then echo app; elif [ -f main.py ]; then echo main; else ls *.py 2>/dev/null | head -n1 | sed 's/\\\\.py$//'; fi); exec uvicorn ${m}:app --host 0.0.0.0 --port 3000; else exec python $( [ -f app.py ] && echo app.py || echo main.py ); fi\"]\n"
        "__DOKSCP_DOCKERFILE_EOF__\n"
        "  elif [ -f main.py ] || [ -f app.py ]; then "
        "    entry='app.py'; [ -f app.py ] || entry='main.py'; "
        "    cat > .dokscp/Dockerfile <<__DOKSCP_DOCKERFILE_EOF__\n"
        "FROM python:3.12-slim\n"
        "WORKDIR /app\n"
        "COPY . .\n"
        "EXPOSE 3000\n"
        "CMD [\"python\", \"$entry\"]\n"
        "__DOKSCP_DOCKERFILE_EOF__\n"
        "  elif [ -f go.mod ]; then "
        "    cat > .dokscp/Dockerfile <<'__DOKSCP_DOCKERFILE_EOF__'\n"
        "FROM golang:1.24-alpine AS build\n"
        "WORKDIR /src\n"
        "COPY go.mod go.sum* ./\n"
        "RUN go mod download\n"
        "COPY . .\n"
        "RUN CGO_ENABLED=0 GOOS=linux go build -o /app/server .\n"
        "FROM alpine:3.20\n"
        "WORKDIR /app\n"
        "COPY --from=build /app/server ./server\n"
        "ENV PORT=3000\n"
        "EXPOSE 3000\n"
        "CMD [\"./server\"]\n"
        "__DOKSCP_DOCKERFILE_EOF__\n"
        "  elif [ -f CMakeLists.txt ]; then "
        "    cat > .dokscp/Dockerfile <<'__DOKSCP_DOCKERFILE_EOF__'\n"
        "FROM ubuntu:24.04\n"
        "RUN apt-get update && apt-get install -y build-essential cmake libssl-dev zlib1g-dev uuid-dev && rm -rf /var/lib/apt/lists/*\n"
        "WORKDIR /app\n"
        "COPY . .\n"
        "RUN cmake -S . -B build && cmake --build build --config Release\n"
        "ENV PORT=3000\n"
        "EXPOSE 3000\n"
        "CMD [\"/bin/sh\", \"-c\", \"exe=$(find build -maxdepth 4 -type f -executable | head -n1); [ -n \\\"$exe\\\" ] || { echo 'No executable found after CMake build'; exit 1; }; exec \\\"$exe\\\"\"]\n"
        "__DOKSCP_DOCKERFILE_EOF__\n"
        "  elif [ -f Cargo.toml ]; then "
        "    cat > .dokscp/Dockerfile <<'__DOKSCP_DOCKERFILE_EOF__'\n"
        "FROM rust:1-bookworm AS build\n"
        "WORKDIR /src\n"
        "COPY . .\n"
        "RUN cargo build --release\n"
        "FROM debian:bookworm-slim\n"
        "WORKDIR /app\n"
        "COPY --from=build /src/target/release /app/bin\n"
        "ENV PORT=3000\n"
        "EXPOSE 3000\n"
        "CMD [\"/bin/sh\", \"-c\", \"exe=$(find /app/bin -maxdepth 1 -type f -executable | head -n1); [ -n \\\"$exe\\\" ] || { echo 'No Rust release binary found'; exit 1; }; exec \\\"$exe\\\"\"]\n"
        "__DOKSCP_DOCKERFILE_EOF__\n"
        "  elif [ -f pom.xml ] || [ -f build.gradle ] || [ -f build.gradle.kts ] || [ -f gradlew ]; then "
        "    cat > .dokscp/Dockerfile <<'__DOKSCP_DOCKERFILE_EOF__'\n"
        "FROM eclipse-temurin:21-jdk AS build\n"
        "WORKDIR /src\n"
        "COPY . .\n"
        "RUN if [ -f mvnw ]; then chmod +x mvnw && ./mvnw -DskipTests package; elif [ -f pom.xml ]; then apt-get update && apt-get install -y maven && mvn -DskipTests package; elif [ -f gradlew ]; then chmod +x gradlew && ./gradlew build -x test; else apt-get update && apt-get install -y gradle && gradle build -x test; fi\n"
        "FROM eclipse-temurin:21-jre\n"
        "WORKDIR /app\n"
        "COPY --from=build /src .\n"
        "ENV PORT=3000\n"
        "ENV SERVER_PORT=3000\n"
        "EXPOSE 3000\n"
        "CMD [\"/bin/sh\", \"-c\", \"jar=$(find . -path '*/target/*.jar' -o -path '*/build/libs/*.jar' | grep -v plain | head -n1); [ -n \\\"$jar\\\" ] || { echo 'No runnable jar found'; exit 1; }; exec java -jar \\\"$jar\\\"\"]\n"
        "__DOKSCP_DOCKERFILE_EOF__\n"
        "  else echo __DOKSCP_DOCKERFILE_MISSING__; exit 12; fi; "
        "  echo 'Generated remote Dockerfile at .dokscp/Dockerfile'; "
        "fi; "
        "cat > " + shellQuote(envFile) + " <<'__DOKSCP_ENV_EOF__'\n" +
        envContent.str() +
        "__DOKSCP_ENV_EOF__\n"
        "cp " + shellQuote(envFile) + " .env 2>/dev/null || true; "
        "cp " + shellQuote(envFile) + " .env.local 2>/dev/null || true; "
        "cp " + shellQuote(envFile) + " .env.production.local 2>/dev/null || true; "
        "build_parallel=$(sed -n 's/^DOKSCP_BACKEND_BUILD_PARALLELISM=//p' .env 2>/dev/null | tail -n1 | tr -d '\"' | tr -d \"'\" || true); "
        "[ -n \"$build_parallel\" ] || build_parallel=1; "
        "echo 'Building remote Docker image " + imageName + "'; "
        "docker build --pull=false --build-arg DOKSCP_BACKEND_BUILD_PARALLELISM=\"$build_parallel\" $dockerfile_arg -t " + shellQuote(imageName) + " .; "
        "docker rm -f " + shellQuote(containerName) + " >/dev/null 2>&1 || true; "
        "echo 'Starting remote container " + containerName + "'; "
        "docker run -d --restart unless-stopped --name " + shellQuote(containerName) +
        " --cap-drop ALL --security-opt no-new-privileges --memory 1g --cpus 1 "
        " --env-file " + shellQuote(envFile) +
        " -p " + std::to_string(containerPort) +
        " " + shellQuote(imageName) + "; "
        "published=$(docker port " + shellQuote(containerName) + " " + std::to_string(containerPort) + "/tcp 2>/dev/null | head -n1 | awk -F: '{print $NF}'); "
        "echo __DOKSCP_REMOTE_IMAGE__=" + imageName + "; "
        "echo __DOKSCP_REMOTE_CONTAINER__=" + containerName + "; "
        "echo __DOKSCP_REMOTE_PORT__=$published";

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
            if (!trim(line).empty() && line.find("__DOKSCP_ENV_EOF__") == std::string::npos) {
                onLogLine(line);
            }
        }
    }

    if (exitCode != 0) {
        if (output.find("__DOKSCP_INVALID_PATH__") != std::string::npos) {
            result.error = "Remote path does not exist or is not a directory";
        } else if (output.find("__DOKSCP_DOCKER_MISSING__") != std::string::npos) {
            result.error = "Docker is not installed on the remote host";
        } else if (output.find("__DOKSCP_DOCKER_DAEMON_DOWN__") != std::string::npos) {
            result.error = "Docker is installed but the remote Docker daemon is not running or accessible";
        } else if (output.find("__DOKSCP_DOCKERFILE_MISSING__") != std::string::npos) {
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
        "command -v docker >/dev/null 2>&1 || { echo __DOKSCP_DOCKER_MISSING__; exit 10; }; "
        "docker info >/dev/null 2>&1 || { echo __DOKSCP_DOCKER_DAEMON_DOWN__; exit 11; }; "
        "docker inspect " + shellQuote(containerName) + " >/dev/null 2>&1 || { echo __DOKSCP_CONTAINER_MISSING__; exit 12; }; "
        "docker inspect --format 'status={{.State.Status}}\nrunning={{.State.Running}}\npaused={{.State.Paused}}\nexit_code={{.State.ExitCode}}\nimage={{.Config.Image}}\nstarted_at={{.State.StartedAt}}\nfinished_at={{.State.FinishedAt}}\nrestart_count={{.RestartCount}}' " + shellQuote(containerName) + "; "
        "printf 'published_ports='; docker port " + shellQuote(containerName) + " 2>/dev/null | tr '\\n' ',' || true; echo; "
        "echo __DOKSCP_REMOTE_LOG_TAIL__; "
        "docker logs --tail 80 " + shellQuote(containerName) + " 2>&1 || true";

    const std::string command =
        "timeout 35s sh -lc " +
        shellQuote(files.sshpassPrefix + files.sshPrefix + " " + shellQuote(remoteCommand));

    std::string output;
    const int exitCode = runCommand(command, output);
    cleanupSessionFiles(files);

    if (exitCode != 0) {
        if (output.find("__DOKSCP_DOCKER_MISSING__") != std::string::npos) {
            result.error = "Docker is not installed on the remote host";
        } else if (output.find("__DOKSCP_DOCKER_DAEMON_DOWN__") != std::string::npos) {
            result.error = "Docker daemon is not reachable on the remote host";
        } else if (output.find("__DOKSCP_CONTAINER_MISSING__") != std::string::npos) {
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
                  "    echo __DOKSCP_REMOTE_IMAGE_REMOVED__; "
                  "  else "
                  "    echo __DOKSCP_REMOTE_IMAGE_REMOVE_FAILED__; "
                  "  fi; "
                  "else "
                  "  echo __DOKSCP_REMOTE_IMAGE_ALREADY_ABSENT__; "
                  "fi; ")
            : "";
    const std::string remoteCommand =
        "set -e; "
        "command -v docker >/dev/null 2>&1 || { echo __DOKSCP_DOCKER_MISSING__; exit 10; }; "
        "docker info >/dev/null 2>&1 || { echo __DOKSCP_DOCKER_DAEMON_DOWN__; exit 11; }; "
        "docker rm -f " + shellQuote(containerName) + " >/dev/null 2>&1 || true; "
        "echo __DOKSCP_REMOTE_CONTAINER_REMOVED__; " +
        imageCleanup;

    const std::string command =
        "timeout 35s sh -lc " +
        shellQuote(files.sshpassPrefix + files.sshPrefix + " " + shellQuote(remoteCommand));

    std::string output;
    const int exitCode = runCommand(command, output);
    cleanupSessionFiles(files);

    const bool imageRemoveFailed = output.find("__DOKSCP_REMOTE_IMAGE_REMOVE_FAILED__") != std::string::npos;
    if (exitCode != 0 || output.find("__DOKSCP_REMOTE_CONTAINER_REMOVED__") == std::string::npos || imageRemoveFailed) {
        if (output.find("__DOKSCP_DOCKER_MISSING__") != std::string::npos) {
            result.error = "Docker is not installed on the remote host";
        } else if (output.find("__DOKSCP_DOCKER_DAEMON_DOWN__") != std::string::npos) {
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
        "command -v docker >/dev/null 2>&1 || { echo __DOKSCP_DOCKER_MISSING__; exit 10; }; "
        "docker info >/dev/null 2>&1 || { echo __DOKSCP_DOCKER_DAEMON_DOWN__; exit 11; }; "
        "removed=0; failed=0; "
        "for img in " + shellQuote(imageName) + " " + shellQuote(registryImage) + "; do "
        "  [ -n \"$img\" ] || continue; "
        "  if docker image inspect \"$img\" >/dev/null 2>&1; then "
        "    if docker image rm \"$img\" >/dev/null 2>&1; then "
        "      echo __DOKSCP_REMOTE_IMAGE_REMOVED__=$img; removed=1; "
        "    else "
        "      echo __DOKSCP_REMOTE_IMAGE_REMOVE_FAILED__=$img; failed=1; "
        "    fi; "
        "  else "
        "    echo __DOKSCP_REMOTE_IMAGE_ALREADY_ABSENT__=$img; "
        "  fi; "
        "done; "
        "[ \"$failed\" -eq 0 ] || exit 12; "
        "echo __DOKSCP_REMOTE_IMAGE_CLEANUP_DONE__";

    const std::string command =
        "timeout 45s sh -lc " +
        shellQuote(files.sshpassPrefix + files.sshPrefix + " " + shellQuote(remoteCommand));

    std::string output;
    const int exitCode = runCommand(command, output);
    cleanupSessionFiles(files);

    result.exitCode = exitCode;
    result.output = output;
    if (exitCode != 0 || output.find("__DOKSCP_REMOTE_IMAGE_CLEANUP_DONE__") == std::string::npos) {
        if (output.find("__DOKSCP_DOCKER_MISSING__") != std::string::npos) {
            result.error = "Docker is not installed on the remote host";
        } else if (output.find("__DOKSCP_DOCKER_DAEMON_DOWN__") != std::string::npos) {
            result.error = "Docker daemon is not reachable on the remote host";
        } else if (output.find("__DOKSCP_REMOTE_IMAGE_REMOVE_FAILED__") != std::string::npos) {
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

    result.nameSpace = options.nameSpace.empty() ? "dokscp-apps" : toLower(trim(options.nameSpace));
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
        << "          image: __DOKSCP_K8S_IMAGE__\n"
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
            << "    kubernetes.io/ingress.class: \"__DOKSCP_REMOTE_INGRESS_CLASS__\"\n";
        if (result.runtimeScheme == "https") {
            manifest << "    cert-manager.io/cluster-issuer: \"__DOKSCP_REMOTE_CLUSTER_ISSUER__\"\n";
        }
        manifest
            << "spec:\n"
            << "  ingressClassName: __DOKSCP_REMOTE_INGRESS_CLASS__\n"
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
    const std::string manifestPath = "/tmp/dokscp-k8s-" + sanitizeDnsLabelValue(options.deploymentId) + ".yaml";
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
        "else echo __DOKSCP_KUBECTL_MISSING__; exit 30; fi; "
        "$K get nodes >/dev/null 2>&1 || { echo __DOKSCP_K8S_NOT_READY__; exit 31; }; "
        "k8s_image=" + shellQuote(options.imageName) + "; "
        "if ! command -v docker >/dev/null 2>&1 || ! docker image inspect " + shellQuote(options.imageName) + " >/dev/null 2>&1; then "
        "  echo __DOKSCP_K8S_SOURCE_IMAGE_MISSING__; exit 32; "
        "fi; "
        "image_loaded=no; "
        "if command -v kind >/dev/null 2>&1 && kind load docker-image " + shellQuote(options.imageName) + " >/dev/null 2>&1; then image_loaded=yes; fi; "
        "if [ \"$image_loaded\" = no ] && command -v minikube >/dev/null 2>&1 && minikube image load " + shellQuote(options.imageName) + " >/dev/null 2>&1; then image_loaded=yes; fi; "
        "if [ \"$image_loaded\" = no ] && command -v k3s >/dev/null 2>&1; then "
        "  if [ \"$(id -u)\" -eq 0 ] && docker save " + shellQuote(options.imageName) + " | k3s ctr -n k8s.io images import - >/dev/null 2>&1; then image_loaded=yes; "
        "  elif sudo -n true >/dev/null 2>&1 && docker save " + shellQuote(options.imageName) + " | sudo -n k3s ctr -n k8s.io images import - >/dev/null 2>&1; then image_loaded=yes; fi; "
        "fi; "
        "if [ \"$image_loaded\" = no ]; then "
        "  echo '[remote-k8s] Local image import unavailable; using local registry fallback'; "
        "  docker ps --format '{{.Names}}' | grep -qx dokscp-local-registry || { docker rm -f dokscp-local-registry >/dev/null 2>&1 || true; docker run -d --restart unless-stopped --name dokscp-local-registry -p 127.0.0.1:5000:5000 registry:2 >/dev/null; }; "
        "  for i in $(seq 1 20); do (command -v curl >/dev/null 2>&1 && curl -fsS http://127.0.0.1:5000/v2/ >/dev/null 2>&1) && break || true; sleep 1; done; "
        "  docker tag " + shellQuote(options.imageName) + " " + shellQuote(registryImageName) + "; "
        "  docker push " + shellQuote(registryImageName) + " >/dev/null || { echo __DOKSCP_K8S_REGISTRY_PUSH_FAILED__; exit 33; }; "
        "  k8s_image=" + shellQuote(registryImageName) + "; "
        "fi; "
        "echo __DOKSCP_K8S_IMAGE_USED__=$k8s_image; "
        "requested_ingress_class=" + shellQuote(useIngress ? (ingressClass.empty() ? "auto" : ingressClass) : "") + "; "
        "requested_cluster_issuer=" + shellQuote(useIngress && result.runtimeScheme == "https" ? (clusterIssuer.empty() ? "letsencrypt-prod" : clusterIssuer) : "") + "; "
        "acme_email=" + shellQuote(acmeEmail) + "; "
        "cert_manager_version=" + shellQuote(certManagerVersion) + "; "
        "ingress_class=''; cluster_issuer=''; "
        "if [ " + shellQuote(useIngress ? "yes" : "no") + " = 'yes' ]; then "
        "  case \"$requested_ingress_class\" in ''|auto) requested_ingress_class='';; *[!A-Za-z0-9.-]*) echo __DOKSCP_INGRESS_CLASS_INVALID__; exit 34;; esac; "
        "  if [ -n \"$requested_ingress_class\" ] && $K get ingressclass \"$requested_ingress_class\" >/dev/null 2>&1; then ingress_class=\"$requested_ingress_class\"; fi; "
        "  if [ -z \"$ingress_class\" ]; then ingress_class=$($K get ingressclass -o jsonpath='{.items[?(@.metadata.annotations.ingressclass\\.kubernetes\\.io/is-default-class==\"true\")].metadata.name}' 2>/dev/null | awk '{print $1}'); fi; "
        "  if [ -z \"$ingress_class\" ]; then ingress_class=$($K get ingressclass -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true); fi; "
        "  [ -n \"$ingress_class\" ] || { echo __DOKSCP_INGRESS_CLASS_MISSING__; exit 35; }; "
        "  echo __DOKSCP_K8S_INGRESS_CLASS__=$ingress_class; "
        "fi; "
        "if [ " + shellQuote(useIngress && result.runtimeScheme == "https" ? "yes" : "no") + " = 'yes' ]; then "
        "  case \"$requested_cluster_issuer\" in ''|auto) requested_cluster_issuer='letsencrypt-prod';; *[!A-Za-z0-9.-]*) echo __DOKSCP_CLUSTER_ISSUER_INVALID__; exit 36;; esac; "
        "  cluster_issuer=\"$requested_cluster_issuer\"; "
        "  if ! $K get clusterissuer \"$cluster_issuer\" >/dev/null 2>&1; then "
        "    [ -n \"$acme_email\" ] && [ \"$acme_email\" != 'admin@example.com' ] || { echo __DOKSCP_ACME_EMAIL_MISSING__; exit 37; }; "
        "    if ! $K get crd certificates.cert-manager.io >/dev/null 2>&1; then "
        "      echo '[remote-k8s] Installing cert-manager for HTTPS certificates'; "
        "      $K apply -f https://github.com/cert-manager/cert-manager/releases/download/${cert_manager_version}/cert-manager.yaml >/dev/null || { echo __DOKSCP_CERT_MANAGER_INSTALL_FAILED__; exit 38; }; "
        "      $K -n cert-manager wait --for=condition=Available deploy/cert-manager --timeout=180s >/dev/null || { echo __DOKSCP_CERT_MANAGER_NOT_READY__; exit 39; }; "
        "      $K -n cert-manager wait --for=condition=Available deploy/cert-manager-webhook --timeout=180s >/dev/null || { echo __DOKSCP_CERT_MANAGER_NOT_READY__; exit 39; }; "
        "      $K -n cert-manager wait --for=condition=Available deploy/cert-manager-cainjector --timeout=180s >/dev/null || { echo __DOKSCP_CERT_MANAGER_NOT_READY__; exit 39; }; "
        "    fi; "
        "    cat <<__DOKSCP_CLUSTER_ISSUER__ | $K apply -f - >/dev/null\n"
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
        "__DOKSCP_CLUSTER_ISSUER__\n"
        "    $K get clusterissuer \"$cluster_issuer\" >/dev/null 2>&1 || { echo __DOKSCP_CLUSTER_ISSUER_FAILED__; exit 40; }; "
        "  fi; "
        "  echo __DOKSCP_K8S_CLUSTER_ISSUER__=$cluster_issuer; "
        "fi; "
        "$K get namespace " + shellQuote(result.nameSpace) + " >/dev/null 2>&1 || $K create namespace " + shellQuote(result.nameSpace) + "; "
        "cat > " + shellQuote(manifestPath) + " <<'__DOKSCP_K8S_MANIFEST__'\n" +
        manifest.str() +
        "__DOKSCP_K8S_MANIFEST__\n"
        "sed -i \"s|__DOKSCP_K8S_IMAGE__|${k8s_image}|g\" " + shellQuote(manifestPath) + "; "
        "sed -i \"s|__DOKSCP_REMOTE_INGRESS_CLASS__|${ingress_class}|g\" " + shellQuote(manifestPath) + "; "
        "sed -i \"s|__DOKSCP_REMOTE_CLUSTER_ISSUER__|${cluster_issuer}|g\" " + shellQuote(manifestPath) + "; "
        "$K apply -f " + shellQuote(manifestPath) + "; "
        "if ! $K rollout status deployment/" + shellQuote(result.deploymentName) + " -n " + shellQuote(result.nameSpace) + " --timeout=180s; then "
        "  echo __DOKSCP_K8S_ROLLOUT_FAILED__; "
        "  $K get pods -n " + shellQuote(result.nameSpace) + " -l app=" + shellQuote(result.deploymentName) + " -o wide || true; "
        "  $K describe pods -n " + shellQuote(result.nameSpace) + " -l app=" + shellQuote(result.deploymentName) + " || true; "
        "  exit 40; "
        "fi; "
        "ready=$($K get deployment " + shellQuote(result.deploymentName) + " -n " + shellQuote(result.nameSpace) + " -o jsonpath='{.status.readyReplicas}' 2>/dev/null || true); "
        "desired=$($K get deployment " + shellQuote(result.deploymentName) + " -n " + shellQuote(result.nameSpace) + " -o jsonpath='{.spec.replicas}' 2>/dev/null || true); "
        "nodeport=$($K get service " + shellQuote(result.serviceName) + " -n " + shellQuote(result.nameSpace) + " -o jsonpath='{.spec.ports[0].nodePort}' 2>/dev/null || true); "
        "rm -f " + shellQuote(manifestPath) + "; "
        "echo __DOKSCP_K8S_NAMESPACE__=" + result.nameSpace + "; "
        "echo __DOKSCP_K8S_DEPLOYMENT__=" + result.deploymentName + "; "
        "echo __DOKSCP_K8S_SERVICE__=" + result.serviceName + "; "
        "echo __DOKSCP_K8S_INGRESS__=" + (useIngress ? result.ingressName : "") + "; "
        "echo __DOKSCP_K8S_EXPOSURE__=" + result.exposureMode + "; "
        "echo __DOKSCP_K8S_READY__=${ready:-0}; "
        "echo __DOKSCP_K8S_DESIRED__=${desired:-0}; "
        "if [ -n \"$nodeport\" ]; then echo __DOKSCP_K8S_URL__=http://" + config.host + ":$nodeport; "
        "elif [ " + shellQuote(useIngress ? "yes" : "no") + " = 'yes' ]; then echo __DOKSCP_K8S_URL__=" + result.runtimeScheme + "://" + ingressHost + "; fi; "
        "echo __DOKSCP_K8S_DONE__";

    const std::string command =
        "timeout 260s sh -lc " +
        shellQuote(files.sshpassPrefix + files.sshPrefix + " " + shellQuote(remoteCommand));

    std::string output;
    const int exitCode = runCommand(command, output);
    cleanupSessionFiles(files);
    result.logs = output;

    if (exitCode != 0 || output.find("__DOKSCP_K8S_DONE__") == std::string::npos) {
        if (output.find("__DOKSCP_KUBECTL_MISSING__") != std::string::npos) {
            result.error = "kubectl or k3s is not installed on the remote host";
        } else if (output.find("__DOKSCP_K8S_NOT_READY__") != std::string::npos) {
            result.error = "Remote Kubernetes cluster is not reachable";
        } else if (output.find("__DOKSCP_K8S_SOURCE_IMAGE_MISSING__") != std::string::npos) {
            result.error = "Remote Docker image is missing before Kubernetes deploy";
        } else if (output.find("__DOKSCP_K8S_REGISTRY_PUSH_FAILED__") != std::string::npos) {
            result.error = "Remote Kubernetes image handoff failed: unable to push to local registry";
        } else if (output.find("__DOKSCP_INGRESS_CLASS_INVALID__") != std::string::npos) {
            result.error = "Remote Kubernetes ingress class contains unsupported characters";
        } else if (output.find("__DOKSCP_INGRESS_CLASS_MISSING__") != std::string::npos) {
            result.error = "Remote Kubernetes ingress exposure requires an installed IngressClass";
        } else if (output.find("__DOKSCP_CLUSTER_ISSUER_INVALID__") != std::string::npos) {
            result.error = "Remote Kubernetes certificate issuer contains unsupported characters";
        } else if (output.find("__DOKSCP_ACME_EMAIL_MISSING__") != std::string::npos) {
            result.error = "HTTPS requires ACME_EMAIL to create Let's Encrypt certificates";
        } else if (output.find("__DOKSCP_CERT_MANAGER_INSTALL_FAILED__") != std::string::npos) {
            result.error = "Failed to install cert-manager for HTTPS certificates";
        } else if (output.find("__DOKSCP_CERT_MANAGER_NOT_READY__") != std::string::npos) {
            result.error = "cert-manager did not become ready on the remote Kubernetes host";
        } else if (output.find("__DOKSCP_CLUSTER_ISSUER_FAILED__") != std::string::npos) {
            result.error = "Failed to create the remote Kubernetes ClusterIssuer";
        } else if (output.find("__DOKSCP_K8S_ROLLOUT_FAILED__") != std::string::npos) {
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
    result.readyReplicas = markerInt(output, "__DOKSCP_K8S_READY__", 0);
    result.desiredReplicas = markerInt(output, "__DOKSCP_K8S_DESIRED__", result.desiredReplicas);
    result.runtimeUrl = markerValue(output, "__DOKSCP_K8S_URL__");
    result.status = result.desiredReplicas > 0 && result.readyReplicas >= result.desiredReplicas ? "running" : "deploying";
    return result;
}

KubernetesRuntimeInfo SshService::deployComposeKubernetesRuntime(const SshConnectionConfig& config,
                                                                 const KubernetesDeployOptions& options,
                                                                 const std::string& remoteComposeWorkdir,
                                                                 const std::string& composeFile,
                                                                 const std::string& composeProjectName,
                                                                 const std::string& composeServicesCsv) const {
    KubernetesRuntimeInfo result;
    std::string error;
    if (!isValidConnectionConfig(config, error)) {
        result.error = error;
        return result;
    }
    if (!isValidRemotePath(remoteComposeWorkdir) || composeFile.empty() || composeProjectName.empty()) {
        result.error = "Remote Compose Kubernetes deployment is missing safe build metadata";
        return result;
    }

    result.nameSpace = options.nameSpace.empty() ? "dokscp-apps" : toLower(trim(options.nameSpace));
    result.exposureMode = normalizeKubernetesExposure(options.exposureMode);
    result.runtimeScheme = normalizeRuntimeScheme(options.runtimeScheme);
    result.desiredReplicas = std::clamp(options.replicas, 1, 10);
    if (!isValidDnsLabelValue(result.nameSpace)) {
        result.error = "Namespace must be a lowercase DNS label";
        return result;
    }

    const SshOperationResult configResult = runRemoteCommand(
        config,
        remoteComposeWorkdir,
        "compose_cmd='docker compose'; "
        "if ! docker compose version >/dev/null 2>&1; then "
        "  if command -v docker-compose >/dev/null 2>&1; then compose_cmd='docker-compose'; "
        "  else echo __DOKSCP_COMPOSE_MISSING__; exit 20; fi; "
        "fi; "
        "$compose_cmd -f " + shellQuote(composeFile) +
        " -p " + shellQuote(composeProjectName) +
        " config --format json 2>/dev/null",
        120
    );
    if (!configResult.success) {
        result.logs = configResult.output;
        result.error = configResult.output.find("__DOKSCP_COMPOSE_MISSING__") != std::string::npos
            ? "Docker Compose is not available on the remote host"
            : (configResult.error.empty() ? "Failed to read remote Docker Compose config" : configResult.error);
        return result;
    }

    Json::Value composeConfig;
    Json::CharReaderBuilder builder;
    builder["collectComments"] = false;
    std::string parseErrors;
    const std::string composeJson = extractJsonObjectFromCommandOutput(configResult.output);
    std::istringstream composeStream(composeJson.empty() ? configResult.output : composeJson);
    if (!Json::parseFromStream(builder, composeStream, &composeConfig, &parseErrors)) {
        result.logs = configResult.output + "\n" + parseErrors;
        result.error = "Remote Docker Compose config output could not be parsed";
        return result;
    }

    const char* baseDomainEnv = std::getenv("REMOTE_K8S_BASE_DOMAIN");
    const char* ingressClassEnv = std::getenv("REMOTE_K8S_INGRESS_CLASS");
    const char* issuerEnv = std::getenv("REMOTE_K8S_CERT_CLUSTER_ISSUER");
    const std::string baseDomain = baseDomainEnv && *baseDomainEnv ? baseDomainEnv : "";
    const std::string ingressClass = ingressClassEnv && *ingressClassEnv ? ingressClassEnv : "";
    const std::string clusterIssuer = issuerEnv && *issuerEnv ? issuerEnv : "";

    ComposeKubernetesPlanOptions planOptions;
    planOptions.deploymentId = options.deploymentId;
    planOptions.projectName = options.projectName;
    planOptions.composeProjectName = composeProjectName;
    planOptions.nameSpace = result.nameSpace;
    planOptions.exposureMode = result.exposureMode;
    planOptions.runtimeScheme = result.runtimeScheme;
    planOptions.serviceType = result.exposureMode == "loadbalancer" ? "LoadBalancer" : "NodePort";
    planOptions.baseDomain = baseDomain;
    planOptions.hostForNip = config.host;
    planOptions.ingressClassName = ingressClass;
    if (result.runtimeScheme == "https") {
        const std::string issuer = clusterIssuer.empty() ? "letsencrypt-prod" : clusterIssuer;
        planOptions.ingressAnnotationsJson = "{\"cert-manager.io/cluster-issuer\":\"" + issuer + "\"}";
    }
    planOptions.resourcePreset = options.resourcePreset;
    planOptions.envVars = options.envVars;
    planOptions.replicas = result.desiredReplicas;
    planOptions.defaultContainerPort = options.containerPort;
    planOptions.allowIngressWithoutBaseDomain = true;
    planOptions.useImagePlaceholders = true;

    const ComposeKubernetesPlan plan = ComposeKubernetesPlanner::build(composeConfig, planOptions);
    if (!plan.success) {
        result.error = plan.error.empty() ? "Remote Compose Kubernetes conversion failed" : plan.error;
        result.logs = ComposeKubernetesPlanner::joinWarnings(plan.warnings);
        return result;
    }

    result.nameSpace = plan.nameSpace;
    result.deploymentName = plan.primaryDeploymentName;
    result.serviceName = plan.primaryServiceName;
    result.ingressName = plan.ingressName;
    result.ingressHost = plan.ingressHost;
    result.exposureMode = plan.exposureMode;
    result.runtimeScheme = plan.runtimeScheme;
    result.desiredReplicas = plan.desiredReplicas;

    const std::filesystem::path localManifestPath =
        std::filesystem::temp_directory_path() / ("dokscp-remote-compose-k8s-" + sanitizeDnsLabelValue(options.deploymentId) + ".yaml");
    const std::filesystem::path localScriptPath =
        std::filesystem::temp_directory_path() / ("dokscp-remote-compose-k8s-" + sanitizeDnsLabelValue(options.deploymentId) + ".sh");
    {
        std::ofstream manifest(localManifestPath, std::ios::trunc);
        manifest << plan.manifest;
    }

    const std::string remoteBase = "/tmp/dokscp-compose-k8s-" + sanitizeDnsLabelValue(options.deploymentId);
    const std::string remoteManifestPath = remoteBase + ".yaml";
    const std::string remoteScriptPath = remoteBase + ".sh";

    {
        std::ofstream script(localScriptPath, std::ios::trunc);
        script
            << "#!/bin/sh\n"
            << "set -eu\n"
            << "echo '[remote-compose-k8s] Preparing multi-service Kubernetes stack'\n"
            << "if command -v kubectl >/dev/null 2>&1; then K='kubectl';\n"
            << "elif command -v k3s >/dev/null 2>&1 && [ \"$(id -u)\" -eq 0 ]; then K='k3s kubectl';\n"
            << "elif command -v k3s >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then K='sudo -n k3s kubectl';\n"
            << "else echo __DOKSCP_KUBECTL_MISSING__; exit 30; fi\n"
            << "$K get nodes >/dev/null 2>&1 || { echo __DOKSCP_K8S_NOT_READY__; exit 31; }\n"
            << "find_build_node() {\n"
            << "  ips=\"$(hostname -I 2>/dev/null || true)\"\n"
            << "  nodes=\"$($K get nodes -o jsonpath='{range .items[*]}{.metadata.name}{\"|\"}{range .status.addresses[*]}{.address}{\",\"}{end}{\"\\n\"}{end}' 2>/dev/null || true)\"\n"
            << "  for ip in $ips; do\n"
            << "    match=$(printf '%s\\n' \"$nodes\" | awk -F'|' -v ip=\"$ip\" 'index(\",\" $2, \",\" ip \",\") { print $1; exit }')\n"
            << "    [ -n \"$match\" ] && { printf '%s' \"$match\"; return 0; }\n"
            << "  done\n"
            << "  host=\"$(hostname 2>/dev/null || true)\"\n"
            << "  if [ -n \"$host\" ] && $K get node \"$host\" >/dev/null 2>&1; then printf '%s' \"$host\"; return 0; fi\n"
            << "  $K get nodes -o jsonpath='{.items[0].metadata.name}'\n"
            << "}\n"
            << "build_node=\"$(find_build_node)\"\n"
            << "[ -n \"$build_node\" ] || { echo __DOKSCP_K8S_BUILD_NODE_NOT_FOUND__; exit 35; }\n"
            << "$K label node \"$build_node\" dokscp.io/local-build-node=true --overwrite >/dev/null 2>&1 || true\n"
            << "echo __DOKSCP_K8S_BUILD_NODE__=$build_node\n"
            << "$K get namespace " << shellQuote(plan.nameSpace) << " >/dev/null 2>&1 || $K create namespace " << shellQuote(plan.nameSpace) << "\n"
            << "cd " << shellQuote(remoteComposeWorkdir) << "\n"
            << "compose_cmd='docker compose'\n"
            << "if ! docker compose version >/dev/null 2>&1; then compose_cmd='docker-compose'; fi\n"
            << "$compose_cmd -f " << shellQuote(composeFile) << " -p " << shellQuote(composeProjectName) << " down --remove-orphans || true\n"
            << "ensure_registry() {\n"
            << "  docker ps --format '{{.Names}}' | grep -qx dokscp-local-registry || { docker rm -f dokscp-local-registry >/dev/null 2>&1 || true; docker run -d --restart unless-stopped --name dokscp-local-registry -p 127.0.0.1:5000:5000 registry:2 >/dev/null; }\n"
            << "  for i in $(seq 1 20); do (command -v curl >/dev/null 2>&1 && curl -fsS http://127.0.0.1:5000/v2/ >/dev/null 2>&1) && return 0 || true; sleep 1; done\n"
            << "  return 1\n"
            << "}\n"
            << "prepare_image() {\n"
            << "  placeholder=\"$1\"; image=\"$2\"; local_build=\"$3\"; replacement=\"$image\"; image_loaded=no\n"
            << "  if ! command -v docker >/dev/null 2>&1 || ! docker image inspect \"$image\" >/dev/null 2>&1; then echo __DOKSCP_K8S_SOURCE_IMAGE_MISSING__=$image; exit 32; fi\n"
            << "  if command -v kind >/dev/null 2>&1 && kind load docker-image \"$image\" >/dev/null 2>&1; then image_loaded=yes; fi\n"
            << "  if [ \"$image_loaded\" = no ] && command -v minikube >/dev/null 2>&1 && minikube image load \"$image\" >/dev/null 2>&1; then image_loaded=yes; fi\n"
            << "  if [ \"$image_loaded\" = no ] && command -v k3s >/dev/null 2>&1; then\n"
            << "    if [ \"$(id -u)\" -eq 0 ] && docker save \"$image\" | k3s ctr -n k8s.io images import - >/dev/null 2>&1; then image_loaded=yes;\n"
            << "    elif sudo -n true >/dev/null 2>&1 && docker save \"$image\" | sudo -n k3s ctr -n k8s.io images import - >/dev/null 2>&1; then image_loaded=yes; fi\n"
            << "  fi\n"
            << "  if [ \"$local_build\" = yes ] && [ \"$image_loaded\" = no ]; then\n"
            << "    echo __DOKSCP_K8S_IMAGE_IMPORT_FAILED__=$image\n"
            << "    exit 34\n"
            << "  fi\n"
            << "  safe=$(printf '%s' \"$replacement\" | sed 's/[&|]/\\\\&/g')\n"
            << "  sed -i \"s|$placeholder|$safe|g\" " << shellQuote(remoteManifestPath) << "\n"
            << "  echo __DOKSCP_K8S_IMAGE_USED__=$replacement\n"
            << "}\n";
        for (const auto& service : plan.services) {
            script
                << "prepare_image " << shellQuote(service.imagePlaceholder)
                << " " << shellQuote(service.imageName)
                << " " << (service.localBuildImage ? "yes" : "no") << "\n";
        }
        if (result.runtimeScheme == "https") {
            const char* acmeEmailEnv = std::getenv("ACME_EMAIL");
            const std::string acmeEmail = acmeEmailEnv && *acmeEmailEnv ? acmeEmailEnv : "";
            script
                << "if ! $K get crd certificates.cert-manager.io >/dev/null 2>&1; then\n"
                << "  [ -n " << shellQuote(acmeEmail) << " ] || { echo __DOKSCP_ACME_EMAIL_MISSING__; exit 37; }\n"
                << "  echo '[remote-compose-k8s] cert-manager is not installed; install it before HTTPS Compose deployments'\n"
                << "  echo __DOKSCP_CERT_MANAGER_NOT_READY__; exit 39\n"
                << "fi\n";
        }
        script
            << "dump_rollout_debug() {\n"
            << "  deployment=\"$1\"; service=\"$2\"\n"
            << "  echo __DOKSCP_K8S_ROLLOUT_DEBUG__=$service\n"
            << "  $K get deployment \"$deployment\" -n " << shellQuote(plan.nameSpace) << " -o wide || true\n"
            << "  $K get pods -n " << shellQuote(plan.nameSpace) << " -l app=\"$deployment\" -o wide || true\n"
            << "  $K describe deployment \"$deployment\" -n " << shellQuote(plan.nameSpace) << " || true\n"
            << "  for pod in $($K get pods -n " << shellQuote(plan.nameSpace) << " -l app=\"$deployment\" -o jsonpath='{.items[*].metadata.name}' 2>/dev/null); do\n"
            << "    echo __DOKSCP_K8S_POD_DESCRIBE__=$pod\n"
            << "    $K describe pod \"$pod\" -n " << shellQuote(plan.nameSpace) << " || true\n"
            << "    echo __DOKSCP_K8S_POD_LOGS__=$pod\n"
            << "    $K logs \"$pod\" -n " << shellQuote(plan.nameSpace) << " --all-containers --tail=120 || true\n"
            << "  done\n"
            << "}\n"
            << "$K apply -f " << shellQuote(remoteManifestPath) << "\n";
        for (const auto& service : plan.services) {
            if (!service.localBuildImage) {
                continue;
            }
            script
                << "$K patch deployment/" << shellQuote(service.deploymentName)
                << " -n " << shellQuote(plan.nameSpace)
                << " --type merge -p '{\"spec\":{\"template\":{\"spec\":{\"nodeSelector\":{\"dokscp.io/local-build-node\":\"true\"}}}}}' >/dev/null\n";
        }
        for (const auto& service : plan.services) {
            script
                << "$K rollout restart deployment/" << shellQuote(service.deploymentName)
                << " -n " << shellQuote(plan.nameSpace) << " || true\n";
        }
        for (const auto& service : plan.services) {
            script
                << "$K rollout status deployment/" << shellQuote(service.deploymentName)
                << " -n " << shellQuote(plan.nameSpace) << " --timeout=180s || { dump_rollout_debug "
                << shellQuote(service.deploymentName) << " " << shellQuote(service.serviceName)
                << "; echo __DOKSCP_K8S_ROLLOUT_FAILED__=" << service.serviceName << "; exit 40; }\n";
        }
        script
            << "ready=$($K get deployment " << shellQuote(plan.primaryDeploymentName) << " -n " << shellQuote(plan.nameSpace) << " -o jsonpath='{.status.readyReplicas}' 2>/dev/null || true)\n"
            << "desired=$($K get deployment " << shellQuote(plan.primaryDeploymentName) << " -n " << shellQuote(plan.nameSpace) << " -o jsonpath='{.spec.replicas}' 2>/dev/null || true)\n"
            << "nodeport=$($K get service " << shellQuote(plan.primaryServiceName) << " -n " << shellQuote(plan.nameSpace) << " -o jsonpath='{.spec.ports[0].nodePort}' 2>/dev/null || true)\n"
            << "lbhost=$($K get service " << shellQuote(plan.primaryServiceName) << " -n " << shellQuote(plan.nameSpace) << " -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || true)\n"
            << "lbip=$($K get service " << shellQuote(plan.primaryServiceName) << " -n " << shellQuote(plan.nameSpace) << " -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)\n"
            << "echo __DOKSCP_K8S_NAMESPACE__=" << plan.nameSpace << "\n"
            << "echo __DOKSCP_K8S_DEPLOYMENT__=" << plan.primaryDeploymentName << "\n"
            << "echo __DOKSCP_K8S_SERVICE__=" << plan.primaryServiceName << "\n"
            << "echo __DOKSCP_K8S_INGRESS__=" << (plan.exposureMode == "ingress" ? plan.ingressName : "") << "\n"
            << "echo __DOKSCP_K8S_EXPOSURE__=" << plan.exposureMode << "\n"
            << "echo __DOKSCP_K8S_READY__=${ready:-0}\n"
            << "echo __DOKSCP_K8S_DESIRED__=${desired:-0}\n";
        if (plan.exposureMode == "ingress") {
            script << "echo __DOKSCP_K8S_URL__=" << plan.runtimeScheme << "://" << plan.ingressHost << "\n";
        } else {
            script
                << "if [ -n \"$nodeport\" ]; then echo __DOKSCP_K8S_URL__=http://" << config.host << ":$nodeport;\n"
                << "elif [ -n \"$lbhost\" ]; then echo __DOKSCP_K8S_URL__=" << plan.runtimeScheme << "://$lbhost;\n"
                << "elif [ -n \"$lbip\" ]; then echo __DOKSCP_K8S_URL__=" << plan.runtimeScheme << "://$lbip;\n"
                << "else echo __DOKSCP_K8S_URL__=http://" << plan.primaryServiceName << "." << plan.nameSpace << ".svc.cluster.local; fi\n";
        }
        script
            << "rm -f " << shellQuote(remoteManifestPath) << " " << shellQuote(remoteScriptPath) << "\n"
            << "echo __DOKSCP_K8S_DONE__\n";
    }

    auto cleanupLocalFiles = [&]() {
        std::error_code ignore;
        std::filesystem::remove(localManifestPath, ignore);
        std::filesystem::remove(localScriptPath, ignore);
    };

    SshOperationResult uploadManifest = uploadFile(config, localManifestPath.string(), remoteManifestPath, 120);
    if (!uploadManifest.success) {
        cleanupLocalFiles();
        result.logs = uploadManifest.output;
        result.error = uploadManifest.error.empty() ? "Failed to upload Compose Kubernetes manifest" : uploadManifest.error;
        return result;
    }
    SshOperationResult uploadScript = uploadFile(config, localScriptPath.string(), remoteScriptPath, 120);
    if (!uploadScript.success) {
        cleanupLocalFiles();
        result.logs = uploadManifest.output + uploadScript.output;
        result.error = uploadScript.error.empty() ? "Failed to upload Compose Kubernetes deploy script" : uploadScript.error;
        return result;
    }

    const SshOperationResult commandResult = runRemoteCommand(
        config,
        "/tmp",
        "chmod 700 " + shellQuote(remoteScriptPath) + " && sh " + shellQuote(remoteScriptPath),
        300
    );
    cleanupLocalFiles();

    result.logs = uploadManifest.output + uploadScript.output +
        ComposeKubernetesPlanner::joinWarnings(plan.warnings) + commandResult.output;
    if (!commandResult.success || commandResult.output.find("__DOKSCP_K8S_DONE__") == std::string::npos) {
        if (commandResult.output.find("__DOKSCP_KUBECTL_MISSING__") != std::string::npos) {
            result.error = "kubectl or k3s is not installed on the remote host";
        } else if (commandResult.output.find("__DOKSCP_K8S_NOT_READY__") != std::string::npos) {
            result.error = "Remote Kubernetes cluster is not reachable";
        } else if (commandResult.output.find("__DOKSCP_K8S_SOURCE_IMAGE_MISSING__") != std::string::npos) {
            result.error = "One or more Compose-built images are missing before Kubernetes deploy";
        } else if (commandResult.output.find("__DOKSCP_K8S_REGISTRY_PUSH_FAILED__") != std::string::npos) {
            result.error = "Remote Kubernetes image handoff failed: unable to push to local registry";
        } else if (commandResult.output.find("__DOKSCP_ACME_EMAIL_MISSING__") != std::string::npos) {
            result.error = "HTTPS requires ACME_EMAIL to create Let's Encrypt certificates";
        } else if (commandResult.output.find("__DOKSCP_CERT_MANAGER_NOT_READY__") != std::string::npos) {
            result.error = "cert-manager must be installed before HTTPS Compose Kubernetes deployment";
        } else if (commandResult.output.find("__DOKSCP_K8S_ROLLOUT_FAILED__") != std::string::npos) {
            result.error = "Remote Compose Kubernetes rollout failed";
        } else {
            result.error = commandResult.error.empty() ? "Remote Compose Kubernetes deployment failed" : commandResult.error;
        }
        return result;
    }

    result.success = true;
    result.deployed = true;
    result.readyReplicas = markerInt(commandResult.output, "__DOKSCP_K8S_READY__", 0);
    result.desiredReplicas = markerInt(commandResult.output, "__DOKSCP_K8S_DESIRED__", result.desiredReplicas);
    result.runtimeUrl = markerValue(commandResult.output, "__DOKSCP_K8S_URL__");
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
        "else echo __DOKSCP_KUBECTL_MISSING__; exit 30; fi; "
        "$K get deployment " + shellQuote(deploymentName) + " -n " + shellQuote(nameSpace) + " >/dev/null 2>&1 || { echo __DOKSCP_K8S_DEPLOYMENT_MISSING__; exit 32; }; "
        "$K get service " + shellQuote(serviceName) + " -n " + shellQuote(nameSpace) + " >/dev/null 2>&1 || { echo __DOKSCP_K8S_SERVICE_MISSING__; exit 33; }; "
        "ready=$($K get deployment " + shellQuote(deploymentName) + " -n " + shellQuote(nameSpace) + " -o jsonpath='{.status.readyReplicas}' 2>/dev/null || true); "
        "desired=$($K get deployment " + shellQuote(deploymentName) + " -n " + shellQuote(nameSpace) + " -o jsonpath='{.spec.replicas}' 2>/dev/null || true); "
        "nodeport=$($K get service " + shellQuote(serviceName) + " -n " + shellQuote(nameSpace) + " -o jsonpath='{.spec.ports[0].nodePort}' 2>/dev/null || true); "
        "ingress_host=''; if [ " + shellQuote(useIngress ? "yes" : "no") + " = 'yes' ]; then ingress_host=$($K get ingress " + shellQuote(result.ingressName) + " -n " + shellQuote(nameSpace) + " -o jsonpath='{.spec.rules[0].host}' 2>/dev/null || true); fi; "
        "echo __DOKSCP_K8S_READY__=${ready:-0}; echo __DOKSCP_K8S_DESIRED__=${desired:-0}; "
        "if [ -n \"$nodeport\" ]; then echo __DOKSCP_K8S_URL__=http://" + config.host + ":$nodeport; "
        "elif [ -n \"$ingress_host\" ]; then echo __DOKSCP_K8S_URL__=" + result.runtimeScheme + "://$ingress_host; fi; "
        "echo __DOKSCP_K8S_LOGS__; $K get pods -n " + shellQuote(nameSpace) + " -l app=" + shellQuote(deploymentName) + " -o wide; "
        + (useIngress ? "$K describe ingress " + shellQuote(result.ingressName) + " -n " + shellQuote(nameSpace) + " 2>&1 || true; " : "") +
        "echo __DOKSCP_K8S_DONE__";

    const std::string command =
        "timeout 60s sh -lc " +
        shellQuote(files.sshpassPrefix + files.sshPrefix + " " + shellQuote(remoteCommand));

    std::string output;
    const int exitCode = runCommand(command, output);
    cleanupSessionFiles(files);
    result.logs = output;
    if (exitCode != 0 || output.find("__DOKSCP_K8S_DONE__") == std::string::npos) {
        result.error = output.find("__DOKSCP_K8S_DEPLOYMENT_MISSING__") != std::string::npos
            ? "Remote Kubernetes deployment is not present"
            : "Failed to inspect remote Kubernetes runtime";
        return result;
    }

    result.success = true;
    result.deployed = true;
    result.readyReplicas = markerInt(output, "__DOKSCP_K8S_READY__", 0);
    result.desiredReplicas = markerInt(output, "__DOKSCP_K8S_DESIRED__", 0);
    result.runtimeUrl = markerValue(output, "__DOKSCP_K8S_URL__");
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
        "else echo __DOKSCP_KUBECTL_MISSING__; exit 30; fi; ";

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
        failed.error = historyResult.output.find("__DOKSCP_KUBECTL_MISSING__") != std::string::npos
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
        "$K delete deployment " + shellQuote(deploymentName) + " -n " + shellQuote(nameSpace) + " --ignore-not-found --cascade=foreground; "
        "$K delete pods -l app=" + shellQuote(deploymentName) + " -n " + shellQuote(nameSpace) + " --ignore-not-found --grace-period=0 --force; "
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

KubernetesRuntimeInfo SshService::removeComposeKubernetesRuntime(const SshConnectionConfig& config,
                                                                 const std::string& nameSpace,
                                                                 const std::string& stackName,
                                                                 const std::string& exposureMode) const {
    KubernetesRuntimeInfo result;
    result.success = true;
    result.nameSpace = nameSpace;
    result.deploymentName = stackName;
    result.exposureMode = normalizeKubernetesExposure(exposureMode);
    std::string error;
    if (!isValidConnectionConfig(config, error)) {
        result.success = false;
        result.error = error;
        return result;
    }
    if (!isValidDnsLabelValue(nameSpace) || !isValidDnsLabelValue(stackName)) {
        result.success = false;
        result.error = "Invalid remote Compose Kubernetes cleanup metadata";
        return result;
    }

    const std::string selector = "dokscp.io/compose-project=" + stackName;
    const SshOperationResult commandResult = runRemoteCommand(
        config,
        "/tmp",
        "if command -v kubectl >/dev/null 2>&1; then K='kubectl'; "
        "elif command -v k3s >/dev/null 2>&1 && [ \"$(id -u)\" -eq 0 ]; then K='k3s kubectl'; "
        "else K='sudo -n k3s kubectl'; fi; "
        "$K delete ingress,service,hpa,pdb,secret,pvc,deployment -l " + shellQuote(selector) +
            " -n " + shellQuote(nameSpace) + " --ignore-not-found --cascade=foreground; "
        "$K delete pods -l " + shellQuote(selector) +
            " -n " + shellQuote(nameSpace) + " --ignore-not-found --grace-period=0 --force; "
        "case " + shellQuote(nameSpace) + " in *" + shellQuote(stackName) + "*) "
            "$K delete namespace " + shellQuote(nameSpace) + " --ignore-not-found || true;; esac",
        120
    );
    result.logs = commandResult.output;
    if (!commandResult.success) {
        result.success = false;
        result.error = commandResult.error.empty() ? "Failed to remove remote Compose Kubernetes runtime" : commandResult.error;
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

} // namespace dokscp
