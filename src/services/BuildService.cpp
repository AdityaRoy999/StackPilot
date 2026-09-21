// ============================================================
// BuildService.cpp — Repository clone + Docker image build
// ============================================================

#include "BuildService.h"
#include "../utils/StringUtils.h"
#include "AiServiceClient.h"
#include "SshService.h"

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <json/json.h>
#include <fstream>
#include <sstream>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>
#include <unordered_set>
#include <signal.h>
#include <regex>

namespace stackpilot {

namespace {

using strings::trim;


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

std::string toLower(const std::string& input) {
    std::string out = input;
    std::transform(out.begin(), out.end(), out.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return out;
}

bool hasFile(const std::filesystem::path& dir, const std::string& name) {
    return std::filesystem::exists(dir / name);
}

std::filesystem::path findComposeFile(const std::filesystem::path& dir) {
    const std::vector<std::string> candidates = {
        "docker-compose.StackPilot.yml",
        "docker-compose.StackPilot.yaml",
        "docker-compose.prod.yml",
        "docker-compose.prod.yaml",
        "compose.prod.yml",
        "compose.prod.yaml",
        "docker-compose.yml",
        "docker-compose.yaml",
        "compose.yml",
        "compose.yaml"
    };
    for (const auto& candidate : candidates) {
        std::error_code ec;
        const auto path = dir / candidate;
        if (std::filesystem::exists(path, ec) && std::filesystem::is_regular_file(path, ec)) {
            return path;
        }
    }
    return {};
}

bool hasPythonScript(const std::filesystem::path& dir) {
    std::error_code ec;
    for (const auto& entry : std::filesystem::directory_iterator(dir, ec)) {
        if (ec) {
            return false;
        }
        if (entry.is_regular_file(ec) && entry.path().extension() == ".py") {
            return true;
        }
    }
    return false;
}

bool envFlag(const char* name, bool fallback) {
    const char* value = std::getenv(name);
    if (!value || !*value) {
        return fallback;
    }
    std::string normalized = toLower(value);
    return normalized == "1" || normalized == "true" || normalized == "yes" || normalized == "on";
}

bool looksLikeGitCommitSha(const std::string& value) {
    if (value.size() < 7 || value.size() > 64) {
        return false;
    }
    return std::all_of(value.begin(), value.end(), [](unsigned char c) {
        return std::isxdigit(c) != 0;
    });
}

bool shouldSkipContextPath(const std::filesystem::path& path) {
    static const std::unordered_set<std::string> skipped = {
        ".git", ".next", ".venv", "venv", "env", "__pycache__", "node_modules",
        "dist", "build", "target", ".pytest_cache", ".mypy_cache", ".ruff_cache"
    };
    for (const auto& part : path) {
        if (skipped.find(part.string()) != skipped.end()) {
            return true;
        }
    }
    return false;
}

bool shouldIncludeExcerpt(const std::filesystem::path& relativePath) {
    const std::string name = toLower(relativePath.filename().string());
    const std::string ext = toLower(relativePath.extension().string());
    static const std::unordered_set<std::string> manifestNames = {
        "package.json", "requirements.txt", "pyproject.toml", "pipfile", "poetry.lock",
        "uv.lock", "environment.yml", "go.mod", "cargo.toml", "pom.xml",
        "build.gradle", "build.gradle.kts", "readme.md", "index.html", "index.htm",
        "vite.config.js", "vite.config.ts", "next.config.js", "next.config.mjs",
        "angular.json", "app.json", "appsettings.json", "program.cs", "startup.cs",
        "cmakelists.txt", "makefile", "gemfile", "composer.json"
    };
    if (manifestNames.find(name) != manifestNames.end()) {
        return true;
    }
    static const std::unordered_set<std::string> codeExtensions = {
        ".py", ".js", ".ts", ".tsx", ".jsx", ".html", ".htm", ".css",
        ".cs", ".csproj", ".sln", ".java", ".kt", ".kts", ".go", ".rs",
        ".php", ".rb", ".c", ".cpp", ".h", ".hpp", ".sh"
    };
    return codeExtensions.find(ext) != codeExtensions.end();
}

bool hasCommonCodeExtension(const std::filesystem::path& path) {
    const std::string ext = toLower(path.extension().string());
    if (ext == ".env" || ext == ".lock" || ext == ".json" || ext == ".yml" || ext == ".yaml" ||
        ext == ".toml" || ext == ".ini" || ext == ".conf" || ext == ".config" || ext == ".md" ||
        ext == ".rst" || ext == ".txt") {
        return false;
    }
    return ext == ".py" || ext == ".js" || ext == ".ts" || ext == ".tsx";
}

bool isSafeTarEntryName(const std::string& rawName) {
    std::string name = rawName;
    while (!name.empty() && (name.back() == '\r' || name.back() == '\n')) {
        name.pop_back();
    }
    if (name.empty() || name.front() == '/' || name.find('\\') != std::string::npos ||
        name.find('\0') != std::string::npos) {
        return false;
    }
    while (name.rfind("./", 0) == 0) {
        name.erase(0, 2);
    }
    while (!name.empty() && name.back() == '/') {
        name.pop_back();
    }
    if (name.empty() || name == ".") {
        return true;
    }
    std::stringstream stream(name);
    std::string part;
    while (std::getline(stream, part, '/')) {
        if (part.empty() || part == "." || part == "..") {
            return false;
        }
    }
    return true;
}

bool isValidDockerfileText(const std::string& dockerfile) {
    const std::string lowered = toLower(dockerfile);
    return lowered.find("from ") != std::string::npos &&
           (lowered.find("copy ") != std::string::npos || lowered.find("add ") != std::string::npos || lowered.find("run ") != std::string::npos) &&
           (lowered.find("cmd ") != std::string::npos || lowered.find("entrypoint ") != std::string::npos);
}

std::string extractDockerfileFromText(const std::string& text) {
    if (text.empty()) return "";
    std::regex fenceRegex(R"(```(?:dockerfile|docker)?\s*\n(FROM\s+[\s\S]+?)\n```)", std::regex::icase);
    std::smatch m;
    if (std::regex_search(text, m, fenceRegex) && m.size() > 1) {
        return trim(m[1].str());
    }
    std::regex rawRegex(R"((FROM\s+[^\n]+[\s\S]+?(?:CMD|ENTRYPOINT)\s+[^\n]+))", std::regex::icase);
    if (std::regex_search(text, m, rawRegex) && m.size() > 1) {
        return trim(m[1].str());
    }
    return "";
}

bool isDockerInstruction(const std::string& line) {
    std::string trimmed = strings::trim(line);
    if (trimmed.empty() || trimmed[0] == '#') return true;
    size_t spacePos = trimmed.find_first_of(" \t");
    std::string firstWord = toLower(spacePos == std::string::npos ? trimmed : trimmed.substr(0, spacePos));
    static const std::unordered_set<std::string> instructions = {
        "from", "run", "cmd", "label", "expose", "env", "add", "copy",
        "entrypoint", "volume", "user", "workdir", "arg", "onbuild",
        "stopsignal", "healthcheck", "shell", "maintainer"
    };
    return instructions.find(firstWord) != instructions.end();
}

std::string sanitizeDockerfile(const std::string& raw) {
    std::string content = raw;
    std::regex nginxPrintfRegex(R"(RUN\s+printf\s+["']server\s*\{[\s\S]+?\}\s*["']\s*>\s*/etc/nginx/conf\.d/default\.conf)", std::regex::icase);
    content = std::regex_replace(content, nginxPrintfRegex,
        "RUN printf 'server {\\n    listen 3000;\\n    server_name localhost;\\n    root /usr/share/nginx/html;\\n    index index.html index.htm;\\n    location / {\\n        try_files $uri $uri/ /index.html;\\n    }\\n}\\n' > /etc/nginx/conf.d/default.conf");

    std::istringstream stream(content);
    std::string line;
    std::vector<std::string> lines;
    while (std::getline(stream, line)) {
        if (!line.empty() && line.back() == '\r') {
            line.pop_back();
        }
        lines.push_back(line);
    }

    for (int i = static_cast<int>(lines.size()) - 1; i >= 0; --i) {
        std::string trimmed = strings::trim(lines[i]);
        if (!trimmed.empty()) {
            while (!lines[i].empty() && (lines[i].back() == '\\' || lines[i].back() == ' ' || lines[i].back() == '\t')) {
                if (lines[i].back() == '\\') {
                    lines[i].pop_back();
                    break;
                }
                lines[i].pop_back();
            }
            break;
        }
    }

    std::vector<std::string> fixedLines;
    for (size_t i = 0; i < lines.size(); ++i) {
        std::string current = lines[i];
        std::string curTrimmed = strings::trim(current);
        size_t spacePos = curTrimmed.find_first_of(" \t");
        std::string firstWord = toLower(spacePos == std::string::npos ? curTrimmed : curTrimmed.substr(0, spacePos));

        if (firstWord == "cmd" || firstWord == "entrypoint") {
            while (!current.empty() && (current.back() == '\\' || current.back() == ' ' || current.back() == '\t')) {
                if (current.back() == '\\') {
                    current.pop_back();
                    break;
                }
                current.pop_back();
            }
            fixedLines.push_back(current);
            continue;
        }

        if (i + 1 < lines.size()) {
            size_t nextIdx = i + 1;
            while (nextIdx < lines.size() && strings::trim(lines[nextIdx]).empty()) {
                ++nextIdx;
            }
            if (nextIdx < lines.size()) {
                const std::string nextTrimmed = strings::trim(lines[nextIdx]);
                if (!isDockerInstruction(nextTrimmed) && nextTrimmed[0] != '#') {
                    if (!curTrimmed.empty() && curTrimmed.back() != '\\') {
                        current += " \\";
                    }
                }
            }
        }

        fixedLines.push_back(current);
    }

    std::ostringstream out;
    for (const auto& l : fixedLines) {
        out << l << "\n";
    }
    return out.str();
}

bool hasFileWithExtension(const std::filesystem::path& dir, const std::string& ext, int maxDepth = 3) {
    std::error_code ec;
    for (auto it = std::filesystem::recursive_directory_iterator(dir, ec);
         it != std::filesystem::recursive_directory_iterator();
         it.increment(ec)) {
        if (ec) break;
        if (it.depth() > maxDepth) {
            it.pop();
            continue;
        }
        if (it->is_regular_file(ec) && toLower(it->path().extension().string()) == toLower(ext)) {
            return true;
        }
    }
    return false;
}

std::string markerValue(const std::string& output, const std::string& marker) {
    std::istringstream stream(output);
    std::string line;
    const std::string prefix = marker + "=";
    while (std::getline(stream, line)) {
        if (line.rfind(prefix, 0) == 0) {
            return trim(line.substr(prefix.size()));
        }
    }
    return "";
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
      app_public_next=$(choose_port "$next_public" 13306 13307 15432 16379 27018 15672 14222 18080 18088 19000 19090 13000 3307 5433 6380 5673 4223 8082 8089 9002 9091 3001)
      if [ -n "$app_public_next" ] && [ "$app_public_next" != "$app_public_port" ]; then
        write_env_value APP_PUBLIC_PORT "$app_public_next"
        echo "__STACKPILOT_PORT_ADJUSTED__=APP_PUBLIC_PORT:${app_public_port}:${app_public_next}"
        echo "Application port conflict detected; retrying with APP_PUBLIC_PORT=$app_public_next"
        changed=1
      fi
    fi
  fi
  app_public_ui_port=$(read_env_value APP_PUBLIC_UI_PORT)
  if [ -n "$app_public_ui_port" ]; then
    next_ui=$(next_port_after "$app_public_ui_port" || true)
    if [ -n "$next_ui" ]; then
      app_ui_next=$(choose_port "$next_ui" 15673 18222 19001 19002 9002 8223 3002 8083 9092)
      if [ -n "$app_ui_next" ] && [ "$app_ui_next" != "$app_public_ui_port" ]; then
        write_env_value APP_PUBLIC_UI_PORT "$app_ui_next"
        echo "__STACKPILOT_PORT_ADJUSTED__=APP_PUBLIC_UI_PORT:${app_public_ui_port}:${app_ui_next}"
        echo "Application UI port conflict detected; retrying with APP_PUBLIC_UI_PORT=$app_ui_next"
        changed=1
      fi
    fi
  fi
  return "$changed"
}
sed -i -E 's/^([[:space:]]*)container_name:/\1# [stackpilot-isolated] container_name:/g' )sh" + composeFileArg + R"sh( 2>/dev/null || true
compose_up_exit=0
compose_up_output=$($compose_cmd -f )sh" + composeFileArg + " -p " + projectArg + R"sh( up -d --build --remove-orphans 2>&1) || compose_up_exit=$?
printf '%s\n' "$compose_up_output"
if [ "$compose_up_exit" -ne 0 ]; then
  if printf '%s\n' "$compose_up_output" | grep -Eqi 'Conflict\. The container name|is already in use by container'; then
    echo "Resolving container name conflicts and re-isolating stack..."
    conflicting_ids=$(printf '%s\n' "$compose_up_output" | grep -oE 'in use by container "[a-f0-9]+"' | awk -F'"' '{print $2}' || true)
    for cid in $conflicting_ids; do
      [ -n "$cid" ] && docker rm -f "$cid" 2>/dev/null || true
    done
    conflicting_names=$(printf '%s\n' "$compose_up_output" | grep -oE 'The container name "/[^"]+"' | awk -F'"' '{print $2}' | tr -d '/' || true)
    for cname in $conflicting_names; do
      [ -n "$cname" ] && docker rm -f "$cname" 2>/dev/null || true
    done
    sed -i -E 's/^([[:space:]]*)container_name:/\1# [stackpilot-isolated] container_name:/g' )sh" + composeFileArg + R"sh( 2>/dev/null || true
    $compose_cmd -f )sh" + composeFileArg + " -p " + projectArg + R"sh( up -d --build --remove-orphans
  elif printf '%s\n' "$compose_up_output" | grep -Eqi 'address already in use|ports are not available|only one usage of each socket address|bind:|port is already allocated'; then
    rewrite_conflicting_application_ports || true
    if grep -Eq 'STACKPILOT_HTTP_PORT|STACKPILOT_HTTPS_PORT' )sh" + composeFileArg + R"sh( 2>/dev/null; then
      old_http_port=$(read_env_value STACKPILOT_HTTP_PORT)
      old_https_port=$(read_env_value STACKPILOT_HTTPS_PORT)
      http_port=$(choose_port 8080 8081 8082 8090 8000 3000)
      https_port=$(choose_port 8443 9443 10443 4443)
      write_env_value STACKPILOT_HTTP_PORT "$http_port"
      write_env_value STACKPILOT_HTTPS_PORT "$https_port"
      echo "__STACKPILOT_PORT_ADJUSTED__=STACKPILOT_HTTP_PORT:${old_http_port:-80}:${http_port}"
      echo "__STACKPILOT_PORT_ADJUSTED__=STACKPILOT_HTTPS_PORT:${old_https_port:-443}:${https_port}"
      echo "Host port conflict detected; retrying Compose with STACKPILOT_HTTP_PORT=$http_port and STACKPILOT_HTTPS_PORT=$https_port"
    fi
    conflicting_ports=$(printf '%s\n' "$compose_up_output" | grep -oE 'Bind for [^:]+:([0-9]+) failed' | awk -F':' '{print $2}' | awk '{print $1}' || true)
    if [ -z "$conflicting_ports" ]; then
      conflicting_ports=$(printf '%s\n' "$compose_up_output" | grep -oE 'listen tcp4 [^:]+:([0-9]+): bind:' | awk -F':' '{print $2}' || true)
    fi
    for p in $conflicting_ports; do
      if [ -n "$p" ]; then
        np=$(choose_port $((p + 1)) 8082 8083 8084 8085 8088 8092 18080 18088 19000 13000 3002)
        sed -i -E "s/([\"']?)${p}:([0-9]+)([\"']?)/\1${np}:\2\3/g" )sh" + composeFileArg + R"sh( 2>/dev/null || true
        echo "Port conflict resolved: remapped host port $p -> $np in compose file"
      fi
    done
    $compose_cmd -f )sh" + composeFileArg + " -p " + projectArg + R"sh( up -d --build --remove-orphans
  else
    exit "$compose_up_exit"
  fi
fi
)sh";
}

bool writeGitAskPassFiles(const std::filesystem::path& deploymentDir,
                          const std::string& token,
                          std::filesystem::path& askPassPath,
                          std::filesystem::path& tokenPath) {
    if (token.empty()) {
        return false;
    }

    askPassPath = deploymentDir / ".git-askpass.sh";
    tokenPath = deploymentDir / ".git-token";

    {
        std::ofstream tokenOut(tokenPath, std::ios::trunc);
        if (!tokenOut.is_open()) {
            return false;
        }
        tokenOut << token;
    }

    {
        std::ofstream askPassOut(askPassPath, std::ios::trunc);
        if (!askPassOut.is_open()) {
            return false;
        }
        askPassOut
            << "#!/bin/sh\n"
            << "case \"$1\" in\n"
            << "  *Username*) printf '%s\\n' 'x-access-token' ;;\n"
            << "  *Password*) cat " << shellQuote(tokenPath.string()) << " ;;\n"
            << "  *) printf '\\n' ;;\n"
            << "esac\n";
    }

    chmod(tokenPath.string().c_str(), S_IRUSR | S_IWUSR);
    chmod(askPassPath.string().c_str(), S_IRUSR | S_IWUSR | S_IXUSR);
    return true;
}

std::string extractHostFromUrl(const std::string& url) {
    const auto scheme = url.find("://");
    if (scheme == std::string::npos) {
        return "";
    }

    size_t hostStart = scheme + 3;
    size_t hostEnd = url.find('/', hostStart);
    std::string authority = url.substr(hostStart, hostEnd == std::string::npos ? std::string::npos : hostEnd - hostStart);
    const auto at = authority.rfind('@');
    if (at != std::string::npos) {
        authority = authority.substr(at + 1);
    }

    if (!authority.empty() && authority.front() == '[') {
        const auto closing = authority.find(']');
        return closing == std::string::npos ? authority : authority.substr(1, closing - 1);
    }

    const auto colon = authority.find(':');
    return authority.substr(0, colon);
}

bool isPrivateOrLocalHost(const std::string& host) {
    const std::string lowered = toLower(host);
    if (lowered.empty()) {
        return true;
    }

    const bool endsWithLocal =
        lowered.size() >= 6 && lowered.compare(lowered.size() - 6, 6, ".local") == 0;

    if (lowered == "localhost" || lowered == "::1" || lowered == "0.0.0.0" ||
        lowered == "host.docker.internal" || endsWithLocal) {
        return true;
    }

    if (lowered.rfind("127.", 0) == 0 ||
        lowered.rfind("10.", 0) == 0 ||
        lowered.rfind("192.168.", 0) == 0 ||
        lowered.rfind("169.254.", 0) == 0) {
        return true;
    }

    if (lowered.rfind("172.", 0) == 0) {
        std::stringstream stream(lowered.substr(4));
        std::string octet;
        if (std::getline(stream, octet, '.')) {
            try {
                const int second = std::stoi(octet);
                if (second >= 16 && second <= 31) {
                    return true;
                }
            } catch (...) {
                return true;
            }
        }
    }

    return false;
}

bool looksLikeGitHubAuthFailure(const std::string& logs) {
    const std::string lowered = toLower(logs);
    return lowered.find("invalid username or token") != std::string::npos ||
           lowered.find("authentication failed") != std::string::npos ||
           lowered.find("could not read username") != std::string::npos;
}

bool hasPackageScript(const std::filesystem::path& packageJsonPath, const std::string& scriptName) {
    std::ifstream in(packageJsonPath);
    if (!in.is_open()) {
        return false;
    }

    Json::CharReaderBuilder builder;
    builder["collectComments"] = false;
    Json::Value root;
    std::string errors;
    if (!Json::parseFromStream(builder, in, &root, &errors) || !root.isObject()) {
        return false;
    }

    const Json::Value& scripts = root["scripts"];
    return scripts.isObject() && scripts.isMember(scriptName) && scripts[scriptName].isString() &&
           !scripts[scriptName].asString().empty();
}

bool isNextJsApp(const std::filesystem::path& sourceDir) {
    if (hasFile(sourceDir, "next.config.js") || hasFile(sourceDir, "next.config.mjs") ||
        hasFile(sourceDir, "next.config.ts")) {
        return true;
    }

    const std::filesystem::path packageJsonPath = sourceDir / "package.json";
    std::ifstream in(packageJsonPath);
    if (!in.is_open()) {
        return false;
    }

    Json::CharReaderBuilder builder;
    builder["collectComments"] = false;
    Json::Value root;
    std::string errors;
    if (!Json::parseFromStream(builder, in, &root, &errors) || !root.isObject()) {
        return false;
    }

    const auto hasNextDependency = [](const Json::Value& deps) {
        return deps.isObject() && deps.isMember("next");
    };

    if (hasNextDependency(root["dependencies"]) || hasNextDependency(root["devDependencies"])) {
        return true;
    }

    const Json::Value& scripts = root["scripts"];
    return scripts.isObject() && scripts.isMember("start") && scripts["start"].isString() &&
           scripts["start"].asString().find("next") != std::string::npos;
}

std::string encodeEnvValue(const std::string& value) {
    bool needsQuotes = value.empty();
    for (char c : value) {
        if (std::isspace(static_cast<unsigned char>(c)) || c == '#' || c == '$' || c == '"' || c == '\'' ||
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

bool isValidEnvKey(const std::string& key) {
    if (key.empty()) {
        return false;
    }

    if (!(std::isalpha(static_cast<unsigned char>(key.front())) || key.front() == '_')) {
        return false;
    }

    for (char c : key) {
        if (!(std::isalnum(static_cast<unsigned char>(c)) || c == '_')) {
            return false;
        }
    }

    return true;
}

void ensureDockerignoreIncludesGeneratedEnv(const std::filesystem::path& sourceDir) {
    const std::filesystem::path dockerignorePath = sourceDir / ".dockerignore";
    std::string existing;
    if (std::filesystem::exists(dockerignorePath)) {
        std::ifstream in(dockerignorePath);
        existing.assign(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
    }

    const std::vector<std::string> requiredLines = {
        "!.env",
        "!.env.local",
        "!.env.production.local"
    };

    std::ofstream out(dockerignorePath, std::ios::app);
    for (const auto& line : requiredLines) {
        if (existing.find(line) == std::string::npos) {
            if (!existing.empty() && existing.back() != '\n') {
                out << "\n";
                existing.push_back('\n');
            }
            out << line << "\n";
            existing += line + "\n";
        }
    }
}

void injectBuildEnvironmentFiles(const std::filesystem::path& sourceDir,
                                 const std::vector<BuildEnvVar>& envVars,
                                 LogCallback onLogLine) {
    if (envVars.empty()) {
        return;
    }

    std::ostringstream content;
    for (const auto& envVar : envVars) {
        if (!isValidEnvKey(envVar.key)) {
            continue;
        }
        content << envVar.key << "=" << encodeEnvValue(envVar.value) << "\n";
    }

    const std::string envContent = content.str();
    if (envContent.empty()) {
        return;
    }

    const std::vector<std::filesystem::path> envFiles = {
        sourceDir / ".env",
        sourceDir / ".env.local",
        sourceDir / ".env.production.local"
    };

    for (const auto& path : envFiles) {
        std::ofstream out(path, std::ios::trunc);
        out << envContent;
    }

    ensureDockerignoreIncludesGeneratedEnv(sourceDir);

    if (onLogLine) {
        onLogLine("Injected project environment variables into build context");
    }
}

void appendLogLine(const std::filesystem::path& logFile,
                   const std::string& line,
                   LogCallback onLogLine) {
    std::ofstream logOut(logFile, std::ios::app);
    logOut << line << "\n";
    if (onLogLine) onLogLine(line);
}

std::vector<std::filesystem::path> configuredLocalSourceRoots() {
    std::vector<std::filesystem::path> roots;
    const char* env = std::getenv("LOCAL_SOURCE_ROOTS");
    const std::string raw = (env && *env) ? env : "/app/local-projects";

    std::stringstream stream(raw);
    std::string item;
    while (std::getline(stream, item, ';')) {
        if (item.empty()) {
            continue;
        }
        roots.emplace_back(item);
    }

    if (roots.empty()) {
        roots.emplace_back("/app/local-projects");
    }
    return roots;
}

bool isExcludedLocalSourceName(const std::string& name) {
    static const std::vector<std::string> excluded = {
        ".git",
        ".next",
        "node_modules",
        "dist",
        "build",
        ".turbo",
        ".cache"
    };
    return std::find(excluded.begin(), excluded.end(), name) != excluded.end();
}

} // namespace

std::mutex BuildService::buildPidsMutex_;
std::unordered_map<std::string, pid_t> BuildService::activeBuildPids_;
std::unordered_set<std::string> BuildService::canceledBuilds_;

BuildService& BuildService::getInstance() {
    static BuildService instance;
    return instance;
}

bool BuildService::cancelBuild(const std::string& deploymentId) {
    if (deploymentId.empty()) {
        return false;
    }
    std::lock_guard<std::mutex> lock(buildPidsMutex_);
    canceledBuilds_.insert(deploymentId);
    auto it = activeBuildPids_.find(deploymentId);
    if (it != activeBuildPids_.end()) {
        pid_t pid = it->second;
        if (pid > 0) {
            kill(-pid, SIGTERM);
            kill(pid, SIGTERM);
            kill(-pid, SIGKILL);
            kill(pid, SIGKILL);
        }
        return true;
    }
    return true;
}

bool BuildService::isBuildCanceled(const std::string& deploymentId) const {
    if (deploymentId.empty()) {
        return false;
    }
    std::lock_guard<std::mutex> lock(buildPidsMutex_);
    return canceledBuilds_.find(deploymentId) != canceledBuilds_.end();
}

BuildService::BuildService()
    : workspaceRoot_("uploads/builds"),
      maxLogBytes_(200000),
      cloneTimeoutSeconds_(120),
      buildTimeoutSeconds_(900),
      dockerMemoryLimit_("1g") {
    const char* workspaceEnv = std::getenv("BUILD_WORKSPACE_DIR");
    if (workspaceEnv && *workspaceEnv) {
        workspaceRoot_ = std::filesystem::path(workspaceEnv);
    }

    const char* maxLogEnv = std::getenv("BUILD_MAX_LOG_BYTES");
    if (maxLogEnv && *maxLogEnv) {
        try {
            maxLogBytes_ = std::max(1024, std::stoi(maxLogEnv));
        } catch (...) {
            maxLogBytes_ = 200000;
        }
    }

    const char* cloneTimeoutEnv = std::getenv("BUILD_CLONE_TIMEOUT_SECONDS");
    if (cloneTimeoutEnv && *cloneTimeoutEnv) {
        try {
            cloneTimeoutSeconds_ = std::max(30, std::stoi(cloneTimeoutEnv));
        } catch (...) {
            cloneTimeoutSeconds_ = 120;
        }
    }

    const char* buildTimeoutEnv = std::getenv("BUILD_COMMAND_TIMEOUT_SECONDS");
    if (buildTimeoutEnv && *buildTimeoutEnv) {
        try {
            buildTimeoutSeconds_ = std::max(60, std::stoi(buildTimeoutEnv));
        } catch (...) {
            buildTimeoutSeconds_ = 900;
        }
    }

    const char* memoryEnv = std::getenv("BUILD_DOCKER_MEMORY");
    if (memoryEnv && *memoryEnv) {
        dockerMemoryLimit_ = memoryEnv;
    }
}

BuildResult BuildService::buildFromRepository(const std::string& deploymentId,
                                              const std::string& repoUrl,
                                              const std::string& version,
                                              const std::string& githubPat,
                                              const std::string& branch,
                                              const std::string& commitSha,
                                              const std::vector<BuildEnvVar>& envVars,
                                              LogCallback onLogLine) const {
    BuildResult result;

    if (!isSupportedRepoUrl(repoUrl)) {
        result.error = "Only public HTTP/HTTPS repository URLs are supported for builds";
        result.logs = result.error;
        if (onLogLine) onLogLine(result.error);
        return result;
    }

    const std::filesystem::path deploymentDir = workspaceRoot_ / deploymentId;
    const std::filesystem::path sourceDir = deploymentDir / "source";
    const std::filesystem::path logFile = deploymentDir / "build.log";

    std::error_code ec;
    if (std::filesystem::exists(deploymentDir, ec)) {
        std::filesystem::remove_all(deploymentDir, ec);
    }
    std::filesystem::create_directories(deploymentDir, ec);

    const std::string checkoutCommit = looksLikeGitCommitSha(commitSha) ? commitSha : "";
    {
        std::string line1 = "Starting build for deployment " + deploymentId;
        std::string line2 = "Repository: " + repoUrl;
        std::ofstream logOut(logFile, std::ios::trunc);
        logOut << line1 << "\n" << line2 << "\n\n";
        if (!branch.empty()) {
            logOut << "Branch: " << branch << "\n";
        }
        if (!checkoutCommit.empty()) {
            logOut << "Commit: " << checkoutCommit << "\n";
        }
        if (onLogLine) {
            onLogLine(line1);
            onLogLine(line2);
            if (!branch.empty()) onLogLine("Branch: " + branch);
            if (!checkoutCommit.empty()) onLogLine("Commit: " + checkoutCommit);
            onLogLine(""); // Empty line for spacing
        }
    }

    const bool isGitHubHttps = repoUrl.find("https://github.com/") == 0;
    if (isGitHubHttps) {
        appendLogLine(
            logFile,
            githubPat.empty()
                ? "GitHub credentials: no project PAT or connected GitHub token available for this clone."
                : "GitHub credentials: token available for this clone.",
            onLogLine
        );
    }

    std::filesystem::path askPassPath;
    std::filesystem::path tokenPath;
    std::string credentialPrefix;
    if (!commitSha.empty() && checkoutCommit.empty()) {
        appendLogLine(
            logFile,
            "Ignoring non-SHA commit selector '" + commitSha + "'. Building the selected branch or default branch instead.",
            onLogLine
        );
    }
    if (!githubPat.empty() && isGitHubHttps) {
        if (!writeGitAskPassFiles(deploymentDir, githubPat, askPassPath, tokenPath)) {
            result.error = "Unable to prepare secure GitHub credentials for clone";
            result.logs = result.error;
            appendLogLine(logFile, result.error, onLogLine);
            return result;
        }
        credentialPrefix =
            "GIT_ASKPASS=" + shellQuote(askPassPath.string()) +
            " GIT_TERMINAL_PROMPT=0 ";
    }

    {
        std::lock_guard<std::mutex> lock(buildPidsMutex_);
        canceledBuilds_.erase(deploymentId);
    }

    const std::string branchArg = branch.empty() ? "" : (" --branch " + shellQuote(branch));
    const std::string gitCloneFlags =
        "git -c credential.helper= -c http.version=HTTP/1.1 -c http.postBuffer=524288000 -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=60 -c core.compression=0 clone --depth 1 --progress";
    const std::string cloneCmd =
        credentialPrefix +
        "GIT_TERMINAL_PROMPT=0 " +
        gitCloneFlags + branchArg + " " +
        shellQuote(repoUrl) + " " + shellQuote(sourceDir.string());
    int cloneExit = runCommandCapture(cloneCmd, logFile, true, cloneTimeoutSeconds_, onLogLine, deploymentId);
    if (cloneExit != 0 && !githubPat.empty() && isGitHubHttps && looksLikeGitHubAuthFailure(readFileBounded(logFile)) && !isBuildCanceled(deploymentId)) {
        appendLogLine(
            logFile,
            "Authenticated GitHub clone was rejected. Retrying once without credentials in case the repository is public.",
            onLogLine
        );
        std::error_code cleanupEc;
        std::filesystem::remove_all(sourceDir, cleanupEc);
        const std::string publicCloneCmd =
            "GIT_TERMINAL_PROMPT=0 " + gitCloneFlags + branchArg + " " +
            shellQuote(repoUrl) + " " + shellQuote(sourceDir.string());
        cloneExit = runCommandCapture(publicCloneCmd, logFile, true, cloneTimeoutSeconds_, onLogLine, deploymentId);
    }
    if (cloneExit != 0) {
        if (!askPassPath.empty()) {
            std::error_code cleanupEc;
            std::filesystem::remove(askPassPath, cleanupEc);
            std::filesystem::remove(tokenPath, cleanupEc);
        }
        result.error = isBuildCanceled(deploymentId) ? "Deployment was canceled by user" : "git clone failed";
        appendLogLine(logFile,
                      isBuildCanceled(deploymentId) ? "Build was canceled by user" : ("git clone failed with exit code " + std::to_string(cloneExit)),
                      onLogLine);
        if (cloneExit == 124) {
            appendLogLine(logFile,
                          "git clone timed out after " + std::to_string(cloneTimeoutSeconds_) + " seconds",
                          onLogLine);
        }
        if (isGitHubHttps && looksLikeGitHubAuthFailure(readFileBounded(logFile))) {
            appendLogLine(
                logFile,
                githubPat.empty()
                    ? "GitHub rejected the clone and no token was available. Connect GitHub again or add a project PAT with repo access."
                    : "GitHub rejected the configured token. Reconnect GitHub with repo access or replace the project PAT; org repositories may also require organization approval.",
                onLogLine
            );
        }
        result.logs = readFileBounded(logFile);
        return result;
    }

    if (isBuildCanceled(deploymentId)) {
        if (!askPassPath.empty()) {
            std::error_code cleanupEc;
            std::filesystem::remove(askPassPath, cleanupEc);
            std::filesystem::remove(tokenPath, cleanupEc);
        }
        result.error = "Deployment was canceled by user";
        appendLogLine(logFile, result.error, onLogLine);
        result.logs = readFileBounded(logFile);
        return result;
    }

    if (!checkoutCommit.empty()) {
        appendLogLine(logFile, "Checking out commit " + checkoutCommit, onLogLine);
        std::string checkoutCmd =
            "GIT_TERMINAL_PROMPT=0 git -C " + shellQuote(sourceDir.string()) +
            " checkout --detach " + shellQuote(checkoutCommit);
        int checkoutExit = runCommandCapture(checkoutCmd, logFile, true, cloneTimeoutSeconds_, onLogLine, deploymentId);
        if (checkoutExit != 0 && !isBuildCanceled(deploymentId)) {
            appendLogLine(logFile, "Commit was not present in the shallow clone. Fetching from origin.", onLogLine);
            const std::string fetchPrefix =
                (!githubPat.empty() && isGitHubHttps && !askPassPath.empty())
                    ? ("GIT_ASKPASS=" + shellQuote(askPassPath.string()) + " GIT_TERMINAL_PROMPT=0 ")
                    : "GIT_TERMINAL_PROMPT=0 ";

            std::string fetchCmd;
            if (checkoutCommit.length() < 40) {
                // Short commit SHA (< 40 chars): Git wire protocol rejects `git fetch origin <shortSha>`.
                // Fetch the branch or remote HEAD with depth 50 to resolve the short commit locally.
                if (!branch.empty()) {
                    fetchCmd = fetchPrefix + "git -C " + shellQuote(sourceDir.string()) +
                               " fetch --depth 50 origin " + shellQuote(branch);
                } else {
                    fetchCmd = fetchPrefix + "git -C " + shellQuote(sourceDir.string()) +
                               " fetch --depth 50 origin";
                }
            } else {
                fetchCmd = fetchPrefix + "git -C " + shellQuote(sourceDir.string()) +
                           " fetch --depth 1 origin " + shellQuote(checkoutCommit);
            }

            const int fetchExit = runCommandCapture(fetchCmd, logFile, true, cloneTimeoutSeconds_, onLogLine, deploymentId);
            if (fetchExit == 0) {
                checkoutExit = runCommandCapture(checkoutCmd, logFile, true, cloneTimeoutSeconds_, onLogLine, deploymentId);
            } else if (checkoutCommit.length() >= 40 && !branch.empty() && !isBuildCanceled(deploymentId)) {
                // Fallback: if fetching exact SHA was disallowed by remote, fetch branch with depth 50
                const std::string fallbackFetchCmd = fetchPrefix + "git -C " + shellQuote(sourceDir.string()) +
                                                     " fetch --depth 50 origin " + shellQuote(branch);
                const int fallbackFetchExit = runCommandCapture(fallbackFetchCmd, logFile, true, cloneTimeoutSeconds_, onLogLine, deploymentId);
                if (fallbackFetchExit == 0) {
                    checkoutExit = runCommandCapture(checkoutCmd, logFile, true, cloneTimeoutSeconds_, onLogLine, deploymentId);
                }
            }
        }
        if (checkoutExit != 0) {
            if (!askPassPath.empty()) {
                std::error_code cleanupEc;
                std::filesystem::remove(askPassPath, cleanupEc);
                std::filesystem::remove(tokenPath, cleanupEc);
            }
            result.error = isBuildCanceled(deploymentId) ? "Deployment was canceled by user" : "git checkout failed";
            appendLogLine(logFile, isBuildCanceled(deploymentId) ? "Build was canceled by user" : ("Unable to checkout requested commit " + checkoutCommit), onLogLine);
            result.logs = readFileBounded(logFile);
            return result;
        }
    }
    if (isBuildCanceled(deploymentId)) {
        if (!askPassPath.empty()) {
            std::error_code cleanupEc;
            std::filesystem::remove(askPassPath, cleanupEc);
            std::filesystem::remove(tokenPath, cleanupEc);
        }
        result.error = "Deployment was canceled by user";
        appendLogLine(logFile, result.error, onLogLine);
        result.logs = readFileBounded(logFile);
        return result;
    }

    if (std::filesystem::exists(sourceDir / ".gitmodules")) {
        appendLogLine(logFile, "Initializing and updating git submodules...", onLogLine);
        const std::string submoduleCmd =
            credentialPrefix + "GIT_TERMINAL_PROMPT=0 git -C " + shellQuote(sourceDir.string()) + " submodule update --init --recursive --depth 1";
        int subExit = runCommandCapture(submoduleCmd, logFile, true, cloneTimeoutSeconds_, onLogLine, deploymentId);
        if (subExit != 0 && !isBuildCanceled(deploymentId)) {
            appendLogLine(logFile, "Warning: Failed to update some git submodules (exit code " + std::to_string(subExit) + "). Proceeding with build...", onLogLine);
        }
    }

    if (!askPassPath.empty()) {
        std::error_code cleanupEc;
        std::filesystem::remove(askPassPath, cleanupEc);
        std::filesystem::remove(tokenPath, cleanupEc);
    }

    if (isBuildCanceled(deploymentId)) {
        result.error = "Deployment was canceled by user";
        appendLogLine(logFile, result.error, onLogLine);
        result.logs = readFileBounded(logFile);
        return result;
    }

    return buildFromPreparedSource(deploymentId, sourceDir, logFile, version, envVars, onLogLine);
}

BuildResult BuildService::buildFromSshSource(const std::string& deploymentId,
                                             const SshConnectionConfig& sshConfig,
                                             const std::string& remotePath,
                                             const std::string& version,
                                             const std::vector<BuildEnvVar>& envVars,
                                             LogCallback onLogLine) const {
    BuildResult result;

    const std::filesystem::path deploymentDir = workspaceRoot_ / deploymentId;
    const std::filesystem::path sourceDir = deploymentDir / "source";
    const std::filesystem::path logFile = deploymentDir / "build.log";

    std::error_code ec;
    if (std::filesystem::exists(deploymentDir, ec)) {
        std::filesystem::remove_all(deploymentDir, ec);
    }
    std::filesystem::create_directories(deploymentDir, ec);

    {
        std::string line1 = "Starting build for deployment " + deploymentId;
        std::string line2 = "SSH source: " + sshConfig.username + "@" + sshConfig.host + ":" + remotePath;
        std::ofstream logOut(logFile, std::ios::trunc);
        logOut << line1 << "\n" << line2 << "\n\n";
        if (onLogLine) {
            onLogLine(line1);
            onLogLine(line2);
            onLogLine("");
        }
    }

    SshService sshService;
    SshOperationResult syncResult = sshService.syncDirectory(
        sshConfig,
        remotePath,
        sourceDir.string(),
        cloneTimeoutSeconds_,
        onLogLine
    );

    if (!syncResult.success) {
        result.error = syncResult.error.empty() ? "Failed to sync source from SSH" : syncResult.error;
        appendLogLine(logFile, result.error, onLogLine);
        if (!syncResult.output.empty()) {
            std::ofstream logOut(logFile, std::ios::app);
            logOut << syncResult.output;
        }
        result.logs = readFileBounded(logFile);
        return result;
    }

    return buildFromPreparedSource(deploymentId, sourceDir, logFile, version, envVars, onLogLine);
}

BuildResult BuildService::buildFromLocalSource(const std::string& deploymentId,
                                               const std::string& localPath,
                                               const std::string& version,
                                               const std::vector<BuildEnvVar>& envVars,
                                               LogCallback onLogLine) const {
    BuildResult result;

    std::string validationReason;
    if (!isAllowedLocalSourcePath(localPath, validationReason)) {
        result.error = validationReason;
        result.logs = validationReason;
        if (onLogLine) onLogLine(validationReason);
        return result;
    }

    const std::filesystem::path deploymentDir = workspaceRoot_ / deploymentId;
    const std::filesystem::path sourceDir = deploymentDir / "source";
    const std::filesystem::path logFile = deploymentDir / "build.log";

    std::error_code ec;
    if (std::filesystem::exists(deploymentDir, ec)) {
        std::filesystem::remove_all(deploymentDir, ec);
    }
    std::filesystem::create_directories(deploymentDir, ec);

    {
        std::string line1 = "Starting build for deployment " + deploymentId;
        std::string line2 = "Local source: " + localPath;
        std::ofstream logOut(logFile, std::ios::trunc);
        logOut << line1 << "\n" << line2 << "\n\n";
        if (onLogLine) {
            onLogLine(line1);
            onLogLine(line2);
            onLogLine("");
        }
    }

    std::string copyReason;
    if (!copyLocalSourceTree(localPath, sourceDir, copyReason)) {
        result.error = copyReason;
        appendLogLine(logFile, copyReason, onLogLine);
        result.logs = readFileBounded(logFile);
        return result;
    }

    return buildFromPreparedSource(deploymentId, sourceDir, logFile, version, envVars, onLogLine);
}

BuildResult BuildService::buildFromArtifact(const std::string& deploymentId,
                                            const std::string& artifactPath,
                                            const std::string& version,
                                            const std::vector<BuildEnvVar>& envVars,
                                            LogCallback onLogLine) const {
    BuildResult result;
    namespace fs = std::filesystem;

    {
        std::lock_guard<std::mutex> lock(buildPidsMutex_);
        canceledBuilds_.erase(deploymentId);
    }

    std::error_code ec;
    const fs::path archive = fs::weakly_canonical(artifactPath, ec);
    if (ec || !fs::exists(archive, ec) || !fs::is_regular_file(archive, ec)) {
        result.error = "Source artifact is missing or unreadable";
        result.logs = result.error;
        if (onLogLine) onLogLine(result.error);
        return result;
    }

    const fs::path deploymentDir = workspaceRoot_ / deploymentId;
    const fs::path sourceDir = deploymentDir / "source";
    const fs::path logFile = deploymentDir / "build.log";
    if (fs::exists(deploymentDir, ec)) {
        fs::remove_all(deploymentDir, ec);
    }
    fs::create_directories(sourceDir, ec);
    if (ec) {
        result.error = "Unable to create artifact build workspace";
        result.logs = result.error;
        if (onLogLine) onLogLine(result.error);
        return result;
    }

    {
        std::ofstream logOut(logFile, std::ios::trunc);
        logOut << "Starting build for deployment " << deploymentId << "\n"
               << "Source artifact: " << archive.string() << "\n\n";
    }
    if (onLogLine) {
        onLogLine("Starting build for deployment " + deploymentId);
        onLogLine("Source artifact: " + archive.string());
    }

    std::string archiveValidationError;
    if (!validateTarArchive(archive, archiveValidationError)) {
        result.error = archiveValidationError;
        result.logs += "\n" + archiveValidationError + "\n";
        if (onLogLine) onLogLine(archiveValidationError);
        return result;
    }

    const std::string extractCommand =
        "tar --no-same-owner --no-same-permissions --delay-directory-restore -xf " +
        shellQuote(archive.string()) + " -C " + shellQuote(sourceDir.string());
    const int extractExit = runCommandCapture(extractCommand, logFile, true, cloneTimeoutSeconds_, onLogLine, deploymentId);
    if (extractExit != 0) {
        result.error = isBuildCanceled(deploymentId)
            ? "Deployment was canceled by user"
            : (extractExit == 124 ? "Source artifact extraction timed out" : "Source artifact extraction failed");
        appendLogLine(logFile, result.error, onLogLine);
        result.logs = readFileBounded(logFile);
        return result;
    }

    if (isBuildCanceled(deploymentId)) {
        result.error = "Deployment was canceled by user";
        appendLogLine(logFile, result.error, onLogLine);
        result.logs = readFileBounded(logFile);
        return result;
    }

    return buildFromPreparedSource(deploymentId, sourceDir, logFile, version, envVars, onLogLine);
}

BuildResult BuildService::buildFromGeneratedSource(const std::string& deploymentId,
                                                   const std::string& generatedSourcePath,
                                                   const std::string& version,
                                                   const std::vector<BuildEnvVar>& envVars,
                                                   LogCallback onLogLine) const {
    BuildResult result;
    namespace fs = std::filesystem;

    std::error_code ec;
    const fs::path generatedSource = fs::weakly_canonical(generatedSourcePath, ec);
    if (ec || !fs::exists(generatedSource, ec) || !fs::is_directory(generatedSource, ec)) {
        result.error = "Generated application source is missing or unreadable";
        result.logs = result.error;
        if (onLogLine) onLogLine(result.error);
        return result;
    }

    const fs::path deploymentDir = workspaceRoot_ / deploymentId;
    const fs::path sourceDir = deploymentDir / "source";
    const fs::path logFile = deploymentDir / "build.log";

    if (fs::exists(deploymentDir, ec)) {
        fs::remove_all(deploymentDir, ec);
    }
    fs::create_directories(deploymentDir, ec);
    if (ec) {
        result.error = "Unable to prepare generated application build workspace";
        result.logs = result.error;
        if (onLogLine) onLogLine(result.error);
        return result;
    }

    {
        std::ofstream logOut(logFile, std::ios::trunc);
        logOut << "Starting generated application build for deployment " << deploymentId << "\n"
               << "Generated source: " << generatedSource.string() << "\n\n";
        if (onLogLine) {
            onLogLine("Starting generated application build for deployment " + deploymentId);
            onLogLine("Generated source: " + generatedSource.string());
            onLogLine("");
        }
    }

    std::string copyReason;
    if (!copyLocalSourceTree(generatedSource, sourceDir, copyReason)) {
        result.error = copyReason;
        appendLogLine(logFile, copyReason, onLogLine);
        result.logs = readFileBounded(logFile);
        return result;
    }

    return buildFromPreparedSource(deploymentId, sourceDir, logFile, version, envVars, onLogLine);
}

BuildResult BuildService::buildAndRunOnRemoteDocker(const std::string& deploymentId,
                                                    const SshConnectionConfig& sshConfig,
                                                    const std::string& remotePath,
                                                    const std::string& projectName,
                                                    const std::string& version,
                                                    int containerPort,
                                                    const std::vector<BuildEnvVar>& envVars,
                                                    LogCallback onLogLine) const {
    BuildResult result;
    const std::string imageName = "stackpilot/" + sanitizeName(deploymentId) + ":" + sanitizeTag(version);
    std::string projectSlug = sanitizeName(projectName);
    if (projectSlug.size() > 32) {
        projectSlug.resize(32);
        while (!projectSlug.empty() && projectSlug.back() == '-') {
            projectSlug.pop_back();
        }
    }
    if (projectSlug.empty()) {
        projectSlug = "project";
    }
    const std::string containerName = "stackpilot-" + projectSlug + "-" + sanitizeName(deploymentId).substr(0, 8);
    result.remoteContainerName = containerName;

    std::vector<std::pair<std::string, std::string>> sshEnvVars;
    for (const auto& envVar : envVars) {
        if (isValidEnvKey(envVar.key)) {
            sshEnvVars.emplace_back(envVar.key, envVar.value);
        }
    }

    if (onLogLine) {
        onLogLine("Starting remote Docker build for deployment " + deploymentId);
        onLogLine("Remote source: " + sshConfig.username + "@" + sshConfig.host + ":" + remotePath);
    }

    SshService sshService;
    SshOperationResult remoteResult = sshService.buildAndRunDockerProject(
        sshConfig,
        remotePath,
        imageName,
        containerName,
        containerPort,
        buildTimeoutSeconds_,
        sshEnvVars,
        onLogLine
    );

    result.logs = remoteResult.output;
    result.imageName = imageName;
    result.remoteContainerName = containerName;
    result.runtimeProvider = "remote_docker";

    const std::string remoteComposeProject = markerValue(remoteResult.output, "__STACKPILOT_REMOTE_COMPOSE_PROJECT__");
    if (!remoteComposeProject.empty()) {
        result.composeProject = true;
        result.composeProjectName = remoteComposeProject;
        result.composeFile = markerValue(remoteResult.output, "__STACKPILOT_REMOTE_COMPOSE_FILE__");
        result.composeServices = markerValue(remoteResult.output, "__STACKPILOT_REMOTE_COMPOSE_SERVICES__");
        result.composeWorkdir = remotePath;
        result.imageName = "compose:" + remoteComposeProject;
        result.remoteContainerName = remoteComposeProject;
        result.runtimeProvider = "remote_compose";
        result.runtimeUrl = markerValue(remoteResult.output, "__STACKPILOT_REMOTE_URL__");
    }

    if (!remoteResult.success) {
        if (remoteResult.output.find("__STACKPILOT_COMPOSE_MISSING__") != std::string::npos) {
            result.error = "Docker Compose is not installed on the remote host";
        } else {
            result.error = remoteResult.error.empty() ? "Remote Docker execution failed" : remoteResult.error;
        }
        return result;
    }

    if (result.composeProject) {
        result.success = true;
        return result;
    }

    std::string publishedPort;
    std::istringstream stream(remoteResult.output);
    std::string line;
    while (std::getline(stream, line)) {
        if (line.rfind("__STACKPILOT_REMOTE_PORT__=", 0) == 0) {
            publishedPort = line.substr(std::string("__STACKPILOT_REMOTE_PORT__=").size());
        }
    }

    if (!publishedPort.empty()) {
        result.runtimeUrl = "http://" + sshConfig.host + ":" + publishedPort;
    }

    result.success = true;
    return result;
}

BuildResult BuildService::buildArtifactAndRunOnRemoteDocker(const std::string& deploymentId,
                                                            const SshConnectionConfig& sshConfig,
                                                            const std::string& artifactPath,
                                                            const std::string& remoteWorkspacePath,
                                                            const std::string& version,
                                                            const std::string& projectName,
                                                            int containerPort,
                                                            const std::vector<BuildEnvVar>& envVars,
                                                            LogCallback onLogLine) const {
    BuildResult result;
    std::string projectSlug = sanitizeName(projectName);
    if (projectSlug.size() > 32) {
        projectSlug.resize(32);
        while (!projectSlug.empty() && projectSlug.back() == '-') {
            projectSlug.pop_back();
        }
    }
    if (projectSlug.empty()) {
        projectSlug = "project";
    }
    const std::string containerName = "stackpilot-" + projectSlug + "-" + sanitizeName(deploymentId).substr(0, 8);
    result.remoteContainerName = containerName;

    namespace fs = std::filesystem;

    std::error_code ec;
    const fs::path archive = fs::weakly_canonical(artifactPath, ec);
    if (ec || !fs::exists(archive, ec) || !fs::is_regular_file(archive, ec)) {
        result.error = "Source artifact is missing or unreadable";
        if (onLogLine) onLogLine(result.error);
        return result;
    }

    const std::string safeDeployment = sanitizeName(deploymentId);
    const std::string baseWorkspace = remoteWorkspacePath.empty() ? "/tmp" : remoteWorkspacePath;
    const std::string remoteBase = baseWorkspace + "/stackpilot-builds/" + safeDeployment;
    const std::string remoteArchive = remoteBase + "/source.tar";
    const std::string remoteSourcePath = remoteBase + "/source";

    if (onLogLine) {
        onLogLine("Starting remote artifact build for deployment " + deploymentId);
        onLogLine("Remote host: " + sshConfig.username + "@" + sshConfig.host);
        onLogLine("Preparing remote build workspace: " + remoteBase);
    }

    std::string archiveValidationError;
    if (!validateTarArchive(archive, archiveValidationError)) {
        result.error = archiveValidationError;
        result.logs += "\n" + archiveValidationError + "\n";
        if (onLogLine) onLogLine(archiveValidationError);
        return result;
    }

    SshService sshService;
    const std::string prepareCommand =
        "rm -rf " + shellQuote(remoteBase) + " && mkdir -p " + shellQuote(remoteBase);
    auto prepareResult = sshService.runRemoteCommand(sshConfig, "/", prepareCommand, 60);
    if (!prepareResult.success) {
        result.error = prepareResult.error.empty() ? "Unable to prepare remote build workspace" : prepareResult.error;
        result.logs = prepareResult.output;
        if (onLogLine) onLogLine(result.error);
        return result;
    }

    if (onLogLine) onLogLine("Uploading source artifact to remote host...");
    auto uploadResult = sshService.uploadFile(
        sshConfig,
        archive.string(),
        remoteArchive,
        std::max(120, cloneTimeoutSeconds_),
        onLogLine
    );
    if (!uploadResult.success) {
        result.error = uploadResult.error.empty() ? "Unable to upload source artifact" : uploadResult.error;
        result.logs = uploadResult.output;
        if (onLogLine) onLogLine(result.error);
        return result;
    }

    if (onLogLine) onLogLine("Extracting source artifact on remote host...");
    const std::string extractCommand =
        "set -e; mkdir -p " + shellQuote(remoteSourcePath) +
        " && tar --no-same-owner --no-same-permissions --delay-directory-restore -xf " +
        shellQuote(remoteArchive) + " -C " + shellQuote(remoteSourcePath) +
        " && echo __STACKPILOT_ARTIFACT_EXTRACTED__";
    auto extractResult = sshService.runRemoteCommand(sshConfig, "/", extractCommand, 120);
    if (!extractResult.success || extractResult.output.find("__STACKPILOT_ARTIFACT_EXTRACTED__") == std::string::npos) {
        result.error = extractResult.error.empty() ? "Unable to extract source artifact on remote host" : extractResult.error;
        result.logs = extractResult.output;
        if (onLogLine) onLogLine(result.error);
        return result;
    }

    return buildAndRunOnRemoteDocker(
        deploymentId,
        sshConfig,
        remoteSourcePath,
        projectName,
        version,
        containerPort,
        envVars,
        onLogLine
    );
}

BuildResult BuildService::buildGeneratedSourceAndRunOnRemoteDocker(const std::string& deploymentId,
                                                                   const SshConnectionConfig& sshConfig,
                                                                   const std::string& generatedSourcePath,
                                                                   const std::string& remoteWorkspacePath,
                                                                   const std::string& version,
                                                                   const std::string& projectName,
                                                                   int containerPort,
                                                                   const std::vector<BuildEnvVar>& envVars,
                                                                   LogCallback onLogLine) const {
    BuildResult result;
    namespace fs = std::filesystem;

    std::error_code ec;
    const fs::path generatedSource = fs::weakly_canonical(generatedSourcePath, ec);
    if (ec || !fs::exists(generatedSource, ec) || !fs::is_directory(generatedSource, ec)) {
        result.error = "Generated application source is missing or unreadable";
        result.logs = result.error;
        if (onLogLine) onLogLine(result.error);
        return result;
    }

    const fs::path deploymentDir = workspaceRoot_ / deploymentId;
    fs::create_directories(deploymentDir, ec);
    if (ec) {
        result.error = "Unable to prepare generated application artifact workspace";
        result.logs = result.error;
        if (onLogLine) onLogLine(result.error);
        return result;
    }

    const fs::path archive = deploymentDir / "generated-application-source.tar";
    const fs::path logFile = deploymentDir / "build.log";
    {
        std::ofstream logOut(logFile, std::ios::app);
        logOut << "Packaging generated application source for remote Docker\n";
    }
    if (onLogLine) onLogLine("Packaging generated application source for remote Docker");

    const std::string tarCommand =
        "tar --format=ustar --no-xattrs --no-acls -cf " + shellQuote(archive.string()) +
        " -C " + shellQuote(generatedSource.string()) + " .";
    const int tarExit = runCommandCapture(tarCommand, logFile, true, std::max(60, cloneTimeoutSeconds_), onLogLine, deploymentId);
    if (tarExit != 0) {
        result.error = isBuildCanceled(deploymentId)
            ? "Deployment was canceled by user"
            : (tarExit == 124 ? "Generated application packaging timed out" : "Generated application packaging failed");
        appendLogLine(logFile, result.error, onLogLine);
        result.logs = readFileBounded(logFile);
        return result;
    }

    return buildArtifactAndRunOnRemoteDocker(
        deploymentId,
        sshConfig,
        archive.string(),
        remoteWorkspacePath,
        version,
        projectName,
        containerPort,
        envVars,
        onLogLine
    );
}

BuildResult BuildService::buildRepositoryAndRunOnRemoteDocker(const std::string& deploymentId,
                                                              const SshConnectionConfig& sshConfig,
                                                              const std::string& repoUrl,
                                                              const std::string& remoteWorkspacePath,
                                                              const std::string& version,
                                                              const std::string& githubPat,
                                                              const std::string& branch,
                                                              const std::string& commitSha,
                                                              const std::string& projectName,
                                                              int containerPort,
                                                              const std::vector<BuildEnvVar>& envVars,
                                                              LogCallback onLogLine) const {
    BuildResult result;
    if (!isSupportedRepoUrl(repoUrl)) {
        result.error = "Unsupported or unsafe repository URL";
        if (onLogLine) {
            onLogLine(result.error);
        }
        return result;
    }

    const std::string safeDeployment = sanitizeName(deploymentId);
    const std::string baseWorkspace = remoteWorkspacePath.empty() ? "/tmp" : remoteWorkspacePath;
    const std::string remoteBase = baseWorkspace + "/stackpilot-builds/" + safeDeployment;
    const std::string remoteSourcePath = remoteBase + "/source";

    if (onLogLine) {
        onLogLine("Starting remote repository build for deployment " + deploymentId);
        onLogLine("Repository: " + repoUrl);
        if (!branch.empty()) onLogLine("Branch: " + branch);
        if (!commitSha.empty()) onLogLine("Commit: " + commitSha);
        if (repoUrl.rfind("https://github.com/", 0) == 0) {
            onLogLine(githubPat.empty()
                ? "GitHub credentials: no project PAT or connected GitHub token available for this remote clone."
                : "GitHub credentials: token available for this remote clone.");
        }
        onLogLine("Remote host: " + sshConfig.username + "@" + sshConfig.host);
        onLogLine("Preparing remote build workspace: " + remoteBase);
    }

    SshService sshService;
    const std::string prepareCommand =
        "rm -rf " + shellQuote(remoteBase) + " && mkdir -p " + shellQuote(remoteBase);
    auto prepareResult = sshService.runRemoteCommand(sshConfig, "/", prepareCommand, 60);
    if (!prepareResult.success) {
        result.error = prepareResult.error.empty() ? "Unable to prepare remote build workspace" : prepareResult.error;
        result.logs = prepareResult.output;
        if (onLogLine) {
            onLogLine(result.error);
        }
        return result;
    }

    if (onLogLine) {
        onLogLine("Cloning repository on remote host...");
    }
    auto cloneResult = sshService.cloneGitRepository(
        sshConfig,
        remoteBase,
        repoUrl,
        "source",
        cloneTimeoutSeconds_,
        githubPat,
        branch,
        commitSha
    );
    if (!cloneResult.output.empty() && onLogLine) {
        std::istringstream stream(cloneResult.output);
        std::string line;
        while (std::getline(stream, line)) {
            if (!line.empty()) {
                onLogLine(line);
            }
        }
    }
    if (!cloneResult.success) {
        result.error = cloneResult.error.empty() ? "Remote git clone failed" : cloneResult.error;
        result.logs = cloneResult.output;
        if (onLogLine) {
            onLogLine(result.error);
        }
        return result;
    }

    return buildAndRunOnRemoteDocker(
        deploymentId,
        sshConfig,
        remoteSourcePath,
        projectName,
        version,
        containerPort,
        envVars,
        onLogLine
    );
}

BuildResult BuildService::buildFromPreparedSource(const std::string& deploymentId,
                                                  const std::filesystem::path& sourceDir,
                                                  const std::filesystem::path& logFile,
                                                  const std::string& version,
                                                  const std::vector<BuildEnvVar>& envVars,
                                                  LogCallback onLogLine) const {
    BuildResult result;

    const RepositoryArchetype archetype = classifyRepositoryArchetype(sourceDir);
    result.archetype = archetype.type;
    result.archetypeDetails = archetype.details;
    result.detectedSubServices = archetype.subServices;
    result.mobileMetadata = archetype.mobileMetadata;

    if (isBuildCanceled(deploymentId)) {
        result.error = "Deployment was canceled by user";
        appendLogLine(logFile, result.error, onLogLine);
        result.logs = readFileBounded(logFile);
        return result;
    }

    injectBuildEnvironmentFiles(sourceDir, envVars, onLogLine);
    if (!envVars.empty()) {
        appendLogLine(logFile, "Injected project environment variables into build context", nullptr);
    }

    const std::filesystem::path composePath = findComposeFile(sourceDir);
    if (!composePath.empty()) {
        const std::string composeFile = composePath.filename().string();
        std::string composeProjectSuffix = sanitizeName(deploymentId);
        if (composeProjectSuffix.size() > 24) {
            composeProjectSuffix.resize(24);
        }
        while (!composeProjectSuffix.empty() && composeProjectSuffix.back() == '-') {
            composeProjectSuffix.pop_back();
        }
        if (composeProjectSuffix.empty()) {
            composeProjectSuffix = "deployment";
        }
        const std::string composeProject = "stackpilot-" + composeProjectSuffix;
        appendLogLine(logFile, "Detected Docker Compose project: " + composeFile, onLogLine);
        appendLogLine(logFile, "Starting Compose build and runtime stack: " + composeProject, onLogLine);

        const std::string quotedComposeFile = shellQuote(composeFile);
        const std::string quotedProject = shellQuote(composeProject);
        const std::string composeCommand =
            "cd " + shellQuote(sourceDir.string()) + " && "
            "compose_cmd='docker compose'; "
            "if ! docker compose version >/dev/null 2>&1; then "
            "  if command -v docker-compose >/dev/null 2>&1; then compose_cmd='docker-compose'; "
            "  else echo __STACKPILOT_COMPOSE_MISSING__; exit 20; fi; "
            "fi; "
            "compose_parallel_limit=$(sed -n 's/^STACKPILOT_COMPOSE_PARALLEL_LIMIT=//p' .env 2>/dev/null | tail -n1 | tr -d '\"' | tr -d \"'\" || true); "
            "[ -n \"$compose_parallel_limit\" ] || compose_parallel_limit=1; "
            "export COMPOSE_PARALLEL_LIMIT=\"$compose_parallel_limit\"; "
            "$compose_cmd -f " + quotedComposeFile + " -p " + quotedProject + " config --services > .stackpilot-compose-services; "
            "services=$(paste -sd, .stackpilot-compose-services 2>/dev/null || true); "
            "echo __STACKPILOT_COMPOSE_PROJECT__=" + composeProject + "; "
            "echo __STACKPILOT_COMPOSE_FILE__=" + composeFile + "; "
            "echo __STACKPILOT_COMPOSE_SERVICES__=$services; "
            "$compose_cmd -f " + quotedComposeFile + " -p " + quotedProject + " pull --ignore-pull-failures || true; "
            + composePortFallbackShell(quotedComposeFile, quotedProject) +
            "runtime=''; "
            "preferred_public_port=$(sed -n 's/^APP_PUBLIC_UI_PORT=//p' .env 2>/dev/null | tail -n1 | tr -d '\"' | tr -d \"'\" || true); "
            "domain=$(sed -n 's/^STACKPILOT_DOMAIN=//p' .env 2>/dev/null | tail -n1 | tr -d '\"' | tr -d \"'\" || true); "
            "require_https=$(sed -n 's/^STACKPILOT_REQUIRE_HTTPS=//p' .env 2>/dev/null | tail -n1 | tr '[:upper:]' '[:lower:]' | tr -d '\"' | tr -d \"'\" || true); "
            "http_port=$(sed -n 's/^STACKPILOT_HTTP_PORT=//p' .env 2>/dev/null | tail -n1 | tr -d '\"' | tr -d \"'\" || true); "
            "https_port=$(sed -n 's/^STACKPILOT_HTTPS_PORT=//p' .env 2>/dev/null | tail -n1 | tr -d '\"' | tr -d \"'\" || true); "
            "if [ -n \"$domain\" ]; then "
            "  if [ \"$require_https\" = 'true' ]; then "
            "    if [ -n \"$https_port\" ] && [ \"$https_port\" != '443' ]; then runtime=\"https://$domain:$https_port\"; else runtime=\"https://$domain\"; fi; "
            "  else "
            "    if [ -n \"$http_port\" ] && [ \"$http_port\" != '80' ]; then runtime=\"http://$domain:$http_port\"; else runtime=\"http://$domain\"; fi; "
            "  fi; "
            "fi; "
            "if [ -z \"$runtime\" ] && [ -n \"$preferred_public_port\" ]; then runtime=\"http://localhost:$preferred_public_port\"; fi; "
            "if [ -z \"$runtime\" ]; then "
            "  for svc in $(cat .stackpilot-compose-services 2>/dev/null); do "
            "    for port in 9001 15672 8222 3000 8080 8000 5000 5173 9090 3100 80 443 5432 3306 6379 27017 5672 9000 4222; do "
            "      mapped=$($compose_cmd -f " + quotedComposeFile + " -p " + quotedProject + " port \"$svc\" \"$port\" 2>/dev/null | head -n1 | awk -F: 'NF {print $NF; exit}'); "
            "      if [ -n \"$mapped\" ]; then scheme='http'; [ \"$port\" = '443' ] && scheme='https'; case \"$port\" in 5432|3306|6379|27017|5672|4222) scheme='tcp';; esac; runtime=\"$scheme://localhost:$mapped\"; break 2; fi; "
            "    done; "
            "  done; "
            "fi; "
            "echo __STACKPILOT_COMPOSE_URL__=$runtime; "
            "$compose_cmd -f " + quotedComposeFile + " -p " + quotedProject + " ps";

        const int composeExit = runCommandCapture(
            composeCommand,
            logFile,
            true,
            std::max(buildTimeoutSeconds_, 120),
            onLogLine,
            deploymentId
        );

        result.logs = readFileBounded(logFile);
        result.composeProject = true;
        result.composeProjectName = composeProject;
        result.composeFile = composeFile;
        result.composeWorkdir = sourceDir.string();
        result.composeServices = markerValue(result.logs, "__STACKPILOT_COMPOSE_SERVICES__");
        result.runtimeUrl = markerValue(result.logs, "__STACKPILOT_COMPOSE_URL__");
        result.runtimeProvider = "local_compose";
        result.remoteContainerName = composeProject;
        result.imageName = "compose:" + composeProject;

        if (composeExit != 0) {
            result.error = isBuildCanceled(deploymentId)
                ? "Deployment was canceled by user"
                : (result.logs.find("__STACKPILOT_COMPOSE_MISSING__") != std::string::npos
                    ? "Docker Compose is not available to the StackPilot backend"
                    : (composeExit == 124 ? "Docker Compose deploy timed out" : "Docker Compose deploy failed"));
            appendLogLine(logFile, result.error, onLogLine);
            result.logs = readFileBounded(logFile);
            result.success = false;
            return result;
        }

        result.success = true;
        return result;
    }

    std::string dockerfileReason;
    if (!ensureDockerfile(sourceDir, logFile, dockerfileReason, onLogLine)) {
        std::ofstream logOut(logFile, std::ios::app);
        logOut << "\n" << dockerfileReason << "\n";
        if (onLogLine) onLogLine(dockerfileReason);

        result.error = dockerfileReason;
        result.logs = readFileBounded(logFile);
        return result;
    }

    const std::string imageName = "stackpilot/" + sanitizeName(deploymentId) + ":" + sanitizeTag(version);
    const std::string buildParallel = [] {
        const char* value = std::getenv("STACKPILOT_BACKEND_BUILD_PARALLELISM");
        return (value && *value) ? std::string(value) : std::string("1");
    }();
    const std::string buildCmd = "docker build --pull=false --memory \"" + dockerMemoryLimit_ +
                                 "\" --build-arg STACKPILOT_BACKEND_BUILD_PARALLELISM=" +
                                 shellQuote(buildParallel) + " -t \"" + imageName +
                                 "\" \"" + sourceDir.string() + "\"";

    {
        std::string buildMsg = "Building image: " + imageName;
        std::ofstream logOut(logFile, std::ios::app);
        logOut << "\n" << buildMsg << "\n";
        if (onLogLine) onLogLine(buildMsg);
    }

    const int buildExit = runCommandCapture(buildCmd, logFile, true, buildTimeoutSeconds_, onLogLine, deploymentId);

    result.imageName = imageName;
    result.logs = readFileBounded(logFile);

    if (buildExit != 0) {
        result.error = isBuildCanceled(deploymentId) ? "Deployment was canceled by user" : "docker build failed";
        appendLogLine(logFile,
                      isBuildCanceled(deploymentId) ? "Build was canceled by user" : ("docker build failed with exit code " + std::to_string(buildExit)),
                      onLogLine);
        if (buildExit == 124) {
            appendLogLine(logFile,
                          "docker build timed out after " + std::to_string(buildTimeoutSeconds_) + " seconds",
                          onLogLine);
        }
        result.logs = readFileBounded(logFile);
        return result;
    }

    result.success = true;
    return result;
}

bool BuildService::isSupportedRepoUrl(const std::string& repoUrl) const {
    if (repoUrl.rfind("http://", 0) != 0 && repoUrl.rfind("https://", 0) != 0) {
        return false;
    }

    const std::string dangerous = "\"';&|<>`";
    for (char c : repoUrl) {
        if (std::isspace(static_cast<unsigned char>(c)) || dangerous.find(c) != std::string::npos) {
            return false;
        }
    }

    const std::string host = extractHostFromUrl(repoUrl);
    if (isPrivateOrLocalHost(host)) {
        return false;
    }

    return true;
}

std::string BuildService::sanitizeName(const std::string& raw) const {
    std::string normalized = toLower(raw);
    std::string out;
    out.reserve(normalized.size());

    char last = '\0';
    for (char c : normalized) {
        const bool allowed = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-';
        const char mapped = allowed ? c : '-';
        if (mapped == '-' && last == '-') {
            continue;
        }
        out.push_back(mapped);
        last = mapped;
    }

    while (!out.empty() && out.front() == '-') out.erase(out.begin());
    while (!out.empty() && out.back() == '-') out.pop_back();

    if (out.empty()) {
        return "deployment";
    }
    return out;
}

std::string BuildService::sanitizeTag(const std::string& raw) const {
    std::string source = raw.empty() ? "latest" : toLower(raw);
    std::string out;
    out.reserve(source.size());

    for (char c : source) {
        const bool allowed = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-';
        out.push_back(allowed ? c : '-');
    }

    while (!out.empty() && (out.front() == '.' || out.front() == '-')) out.erase(out.begin());
    while (!out.empty() && (out.back() == '.' || out.back() == '-')) out.pop_back();

    if (out.empty()) {
        return "latest";
    }
    if (out.size() > 64) {
        out.resize(64);
    }
    return out;
}

std::string BuildService::readFileBounded(const std::filesystem::path& filePath, int maxBytes) const {
    std::ifstream in(filePath, std::ios::binary);
    if (!in.is_open()) {
        return "";
    }

    in.seekg(0, std::ios::end);
    const std::streamoff size = in.tellg();
    std::streamoff start = 0;
    bool truncated = false;

    const int limit = maxBytes > 0 ? maxBytes : maxLogBytes_;
    if (size > static_cast<std::streamoff>(limit)) {
        start = size - static_cast<std::streamoff>(limit);
        truncated = true;
    }

    in.seekg(start, std::ios::beg);
    std::string data((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());

    if (truncated) {
        return "[logs truncated to last bytes]\n" + data;
    }
    return data;
}

bool BuildService::isAllowedLocalSourcePath(const std::filesystem::path& localPath, std::string& reason) const {
    namespace fs = std::filesystem;
    if (localPath.empty() || !localPath.is_absolute()) {
        reason = "Local source path must be an absolute path mounted into the backend container";
        return false;
    }

    std::error_code ec;
    const fs::path canonicalSource = fs::weakly_canonical(localPath, ec);
    if (ec || !fs::exists(canonicalSource, ec) || !fs::is_directory(canonicalSource, ec)) {
        reason = "Local source path does not exist or is not a directory";
        return false;
    }

    for (const auto& root : configuredLocalSourceRoots()) {
        std::error_code rootEc;
        const fs::path canonicalRoot = fs::weakly_canonical(root, rootEc);
        if (rootEc || !fs::exists(canonicalRoot, rootEc) || !fs::is_directory(canonicalRoot, rootEc)) {
            continue;
        }

        auto sourceIt = canonicalSource.begin();
        auto rootIt = canonicalRoot.begin();
        bool matchesRoot = true;
        for (; rootIt != canonicalRoot.end(); ++rootIt, ++sourceIt) {
            if (sourceIt == canonicalSource.end() || *sourceIt != *rootIt) {
                matchesRoot = false;
                break;
            }
        }

        if (matchesRoot) {
            return true;
        }
    }

    reason = "Local source path is outside the configured allowed roots";
    return false;
}

bool BuildService::copyLocalSourceTree(const std::filesystem::path& source,
                                       const std::filesystem::path& destination,
                                       std::string& reason) const {
    namespace fs = std::filesystem;
    std::error_code ec;
    const fs::path canonicalSource = fs::weakly_canonical(source, ec);
    if (ec) {
        reason = "Unable to resolve local source path";
        return false;
    }

    fs::create_directories(destination, ec);
    if (ec) {
        reason = "Unable to create local build workspace";
        return false;
    }

    fs::recursive_directory_iterator it(
        canonicalSource,
        fs::directory_options::skip_permission_denied,
        ec
    );
    fs::recursive_directory_iterator end;
    while (!ec && it != end) {
        const fs::path current = it->path();
        const std::string name = current.filename().string();
        if (isExcludedLocalSourceName(name)) {
            if (it->is_directory(ec)) {
                it.disable_recursion_pending();
            }
            ++it;
            continue;
        }

        if (it->is_symlink(ec)) {
            ++it;
            continue;
        }

        const fs::path relative = fs::relative(current, canonicalSource, ec);
        if (ec) {
            reason = "Unable to resolve a local source file";
            return false;
        }

        const fs::path target = destination / relative;
        if (it->is_directory(ec)) {
            fs::create_directories(target, ec);
        } else if (it->is_regular_file(ec)) {
            fs::create_directories(target.parent_path(), ec);
            fs::copy_file(current, target, fs::copy_options::overwrite_existing, ec);
        }

        if (ec) {
            reason = "Unable to copy local source into build workspace";
            return false;
        }
        ++it;
    }

    if (ec) {
        reason = "Unable to read local source folder";
        return false;
    }

    return true;
}

bool BuildService::validateTarArchive(const std::filesystem::path& archivePath,
                                      std::string& reason) const {
    if (!std::filesystem::exists(archivePath)) {
        reason = "Source artifact archive does not exist";
        return false;
    }

    const auto tempBase = std::filesystem::temp_directory_path() /
        ("stackpilot-tar-check-" + sanitizeName(archivePath.filename().string()) + "-" + std::to_string(std::rand()));
    const auto namesFile = tempBase.string() + ".names";
    const auto verboseFile = tempBase.string() + ".verbose";

    const std::string listCommand =
        "tar -tf " + shellQuote(archivePath.string()) + " > " + shellQuote(namesFile) + " 2>&1";
    if (std::system(listCommand.c_str()) != 0) {
        reason = "Source artifact is not a readable tar archive";
        std::filesystem::remove(namesFile);
        return false;
    }

    {
        std::ifstream names(namesFile);
        std::string entry;
        bool sawEntry = false;
        while (std::getline(names, entry)) {
            sawEntry = true;
            if (!isSafeTarEntryName(entry)) {
                reason = "Source artifact contains an unsafe path: " + entry;
                std::filesystem::remove(namesFile);
                return false;
            }
        }
        if (!sawEntry) {
            reason = "Source artifact archive is empty";
            std::filesystem::remove(namesFile);
            return false;
        }
    }
    std::filesystem::remove(namesFile);

    const std::string verboseCommand =
        "tar -tvf " + shellQuote(archivePath.string()) + " > " + shellQuote(verboseFile) + " 2>&1";
    if (std::system(verboseCommand.c_str()) != 0) {
        reason = "Source artifact metadata could not be inspected";
        std::filesystem::remove(verboseFile);
        return false;
    }
    {
        std::ifstream verbose(verboseFile);
        std::string line;
        while (std::getline(verbose, line)) {
            if (line.empty()) {
                continue;
            }
            const char type = line.front();
            if (type != '-' && type != 'd') {
                reason = "Source artifact contains unsupported tar entry types such as symlinks, hardlinks, or devices";
                std::filesystem::remove(verboseFile);
                return false;
            }
        }
    }
    std::filesystem::remove(verboseFile);
    return true;
}

int BuildService::runCommandCapture(const std::string& command,
                                    const std::filesystem::path& outputFile,
                                    bool append,
                                    int timeoutSeconds,
                                    LogCallback onLogLine,
                                    const std::string& deploymentId) const {
    if (!deploymentId.empty()) {
        std::lock_guard<std::mutex> lock(buildPidsMutex_);
        if (canceledBuilds_.find(deploymentId) != canceledBuilds_.end()) {
            appendLogLine(outputFile, "Build was canceled by user", onLogLine);
            return 130;
        }
    }

    int pipefd[2];
    if (pipe(pipefd) != 0) {
        return -1;
    }

    std::string wrapped =
        "timeout " + std::to_string(timeoutSeconds) + "s sh -lc " +
        shellQuote(command + " 2>&1");

    pid_t pid = fork();
    if (pid < 0) {
        close(pipefd[0]);
        close(pipefd[1]);
        return -1;
    }

    if (pid == 0) {
        // Child process: setpgid so this process and all its children form a distinct group
        setpgid(0, 0);

        close(pipefd[0]);
        dup2(pipefd[1], STDOUT_FILENO);
        dup2(pipefd[1], STDERR_FILENO);
        close(pipefd[1]);

        execl("/bin/sh", "sh", "-c", wrapped.c_str(), (char*)NULL);
        _exit(127);
    }

    // Parent process: also setpgid to avoid race before child executes
    setpgid(pid, pid);
    close(pipefd[1]);

    if (!deploymentId.empty()) {
        std::lock_guard<std::mutex> lock(buildPidsMutex_);
        if (canceledBuilds_.find(deploymentId) != canceledBuilds_.end()) {
            kill(-pid, SIGTERM);
            kill(pid, SIGTERM);
            kill(-pid, SIGKILL);
            kill(pid, SIGKILL);
        } else {
            activeBuildPids_[deploymentId] = pid;
        }
    }

    std::ofstream logFile(outputFile, append ? std::ios::app : std::ios::trunc);
    char buffer[4096];
    std::string accumulator;
    char lastDelimiter = '\0';

    auto flushLine = [&logFile, &onLogLine](std::string& line) {
        logFile << line << '\n' << std::flush;
        if (onLogLine) {
            onLogLine(line);
        }
        line.clear();
    };

    while (true) {
        ssize_t bytesRead = read(pipefd[0], buffer, sizeof(buffer));
        if (bytesRead < 0) {
            if (errno == EINTR) {
                continue;
            }
            break;
        }
        if (bytesRead == 0) {
            break;
        }

        for (ssize_t i = 0; i < bytesRead; ++i) {
            char c = buffer[i];
            if (c == '\r') {
                flushLine(accumulator);
                lastDelimiter = '\r';
            } else if (c == '\n') {
                if (lastDelimiter == '\r') {
                    // Part of CRLF sequence where CR already flushed the line; do not duplicate
                    lastDelimiter = '\n';
                } else {
                    flushLine(accumulator);
                    lastDelimiter = '\n';
                }
            } else {
                accumulator.push_back(c);
                lastDelimiter = c;
            }
        }

        // If an accumulator has content after a chunk, flush it so clients receive real-time updates
        if (!accumulator.empty()) {
            flushLine(accumulator);
        }
    }

    // Flush any remaining content in accumulator
    if (!accumulator.empty()) {
        flushLine(accumulator);
    }

    close(pipefd[0]);

    int status = 0;
    while (waitpid(pid, &status, 0) < 0) {
        if (errno == EINTR) {
            continue;
        }
        break;
    }

    if (!deploymentId.empty()) {
        std::lock_guard<std::mutex> lock(buildPidsMutex_);
        activeBuildPids_.erase(deploymentId);
    }

    int exitCode = -1;
    if (WIFEXITED(status)) {
        exitCode = WEXITSTATUS(status);
    } else if (WIFSIGNALED(status)) {
        exitCode = 128 + WTERMSIG(status);
    }

    if (exitCode != 0) {
        const std::string exitLine = "Command exited with status " + std::to_string(exitCode);
        logFile << exitLine << "\n" << std::flush;
        if (onLogLine) onLogLine(exitLine);
    }

    return exitCode;
}

Json::Value BuildService::collectSourceContext(const std::filesystem::path& sourceDir) const {
    Json::Value context(Json::objectValue);
    Json::Value files(Json::arrayValue);
    Json::Value excerpts(Json::objectValue);
    Json::Value topLevelDirs(Json::arrayValue);

    std::error_code ec;
    for (const auto& entry : std::filesystem::directory_iterator(sourceDir, ec)) {
        if (ec) {
            break;
        }
        if (entry.is_directory(ec)) {
            const std::string name = entry.path().filename().string();
            if (name != ".git" && name != "node_modules" && name != ".next" &&
                name != "dist" && name != "build" && name != "bin" && name != "obj") {
                topLevelDirs.append(name);
            }
        }
    }
    context["top_level_directories"] = topLevelDirs;

    int fileCount = 0;
    int excerptCount = 0;
    for (const auto& entry : std::filesystem::recursive_directory_iterator(sourceDir, ec)) {
        if (ec) {
            break;
        }
        const std::filesystem::path relative = std::filesystem::relative(entry.path(), sourceDir, ec);
        if (ec || relative.empty() || shouldSkipContextPath(relative)) {
            continue;
        }
        if (!entry.is_regular_file(ec)) {
            continue;
        }

        const std::string rel = relative.generic_string();
        if (fileCount < 500) {
            files.append(rel);
        }
        ++fileCount;

        if (excerptCount < 60 && shouldIncludeExcerpt(relative)) {
            excerpts[rel] = readFileBounded(entry.path(), 8000);
            ++excerptCount;
        }
    }

    context["file_count"] = fileCount;
    context["files"] = files;
    context["excerpts"] = excerpts;
    context["has_existing_dockerfile"] = std::filesystem::exists(sourceDir / "Dockerfile");
    return context;
}

bool BuildService::tryGenerateDockerfileWithAi(const std::filesystem::path& sourceDir,
                                               const std::filesystem::path& logFile,
                                               std::string& reason,
                                               LogCallback onLogLine) const {
    if (!envFlag("STACKPILOT_AI_DOCKERFILE_ENABLED", true)) {
        reason = "AI Dockerfile generation is disabled via STACKPILOT_AI_DOCKERFILE_ENABLED";
        return false;
    }

    Json::Value payload(Json::objectValue);
    payload["provider"] = std::getenv("STACKPILOT_AI_PROVIDER") ? std::getenv("STACKPILOT_AI_PROVIDER") : "nvidia_nim";
    payload["model_mode"] = "thinking";
    payload["workflow_type"] = "generate_dockerfile";
    payload["project"]["name"] = sourceDir.filename().string();
    payload["source"] = collectSourceContext(sourceDir);
    payload["message"] =
        "Inspect the provided project file tree, directory structure, and file excerpts to generate an optimal, production-ready Dockerfile. "
        "CRITICAL REQUIREMENTS: "
        "1. Traffic routes to port 3000. Your Dockerfile MUST expose port 3000 and ensure the service listens on port 3000. "
        "2. For static HTML/CSS/JS sites, use nginx:alpine, configure nginx to listen on port 3000, copy the files to /usr/share/nginx/html, and chmod permissions so non-root user can run. "
        "3. For monorepos containing both frontend and backend (e.g. .NET backend + React frontend), prioritize building and running the primary runnable backend service or build both stages into one container. "
        "4. DO NOT use heredocs ('cat << EOF'). Use standard POSIX commands. "
        "5. Output the complete buildable Dockerfile text.";

    appendLogLine(logFile, "AI Dockerfile generation: analyzing repository files with AI agent...", onLogLine);
    const auto aiResult = AiServiceClient::instance().postWorkflow("/generate/dockerfile", payload);
    if (!aiResult.ok) {
        reason = aiResult.error.empty() ? "AI Dockerfile generation failed" : aiResult.error;
        appendLogLine(logFile, "AI Dockerfile generation unavailable: " + reason, onLogLine);
        return false;
    }

    std::string dockerfile;
    const Json::Value structured = aiResult.body.isMember("structured_output")
        ? aiResult.body["structured_output"]
        : Json::Value(Json::objectValue);
    if (structured.isMember("dockerfile") && structured["dockerfile"].isString()) {
        dockerfile = structured["dockerfile"].asString();
    }
    if (!isValidDockerfileText(dockerfile)) {
        if (aiResult.body.isMember("summary") && aiResult.body["summary"].isString()) {
            dockerfile = extractDockerfileFromText(aiResult.body["summary"].asString());
        }
    }
    if (!isValidDockerfileText(dockerfile)) {
        if (aiResult.body.isMember("content") && aiResult.body["content"].isString()) {
            dockerfile = extractDockerfileFromText(aiResult.body["content"].asString());
        }
    }
    if (!isValidDockerfileText(dockerfile)) {
        if (aiResult.body.isMember("raw") && aiResult.body["raw"].isString()) {
            dockerfile = extractDockerfileFromText(aiResult.body["raw"].asString());
        }
    }

    dockerfile = sanitizeDockerfile(dockerfile);

    if (!isValidDockerfileText(dockerfile)) {
        reason = "AI did not return a valid Dockerfile";
        appendLogLine(logFile, reason + "; falling back to deterministic generator.", onLogLine);
        return false;
    }

    const std::filesystem::path dockerfilePath = sourceDir / "Dockerfile";
    std::ofstream out(dockerfilePath, std::ios::trunc);
    if (!out.is_open()) {
        reason = "Failed to write AI-generated Dockerfile";
        return false;
    }
    out << dockerfile;
    if (!dockerfile.empty() && dockerfile.back() != '\n') {
        out << "\n";
    }

    appendLogLine(logFile, "AI generated Dockerfile from source tree analysis.", onLogLine);
    if (structured.isMember("start_command") && structured["start_command"].isString()) {
        appendLogLine(logFile, "AI selected start command: " + structured["start_command"].asString(), onLogLine);
    }
    return true;
}

RepositoryArchetype BuildService::classifyRepositoryArchetype(const std::filesystem::path& sourceDir) const {
    RepositoryArchetype arch;
    arch.type = "standard_web";
    arch.displayName = "Web Application";
    arch.isDeployable = true;

    std::error_code ec;

    // 1. Scan for monorepo sub-services
    static const std::vector<std::string> subSearchDirs = {
        "backend", "server", "api", "web", "frontend", "client", "service", "app"
    };
    for (const auto& candidate : subSearchDirs) {
        const auto p = sourceDir / candidate;
        if (std::filesystem::exists(p, ec) && std::filesystem::is_directory(p, ec)) {
            if (hasFile(p, "package.json") || hasFile(p, "requirements.txt") ||
                hasFile(p, "go.mod") || hasFile(p, "Cargo.toml") || hasFile(p, "Dockerfile") ||
                hasFile(p, "pom.xml") || hasFile(p, "build.gradle") || hasFile(p, "mvnw") ||
                findComposeFile(p) != std::filesystem::path()) {
                arch.subServices.push_back(candidate);
            }
        }
    }
    for (const auto& monoFolder : {"apps", "packages", "services"}) {
        const auto p = sourceDir / monoFolder;
        if (std::filesystem::exists(p, ec) && std::filesystem::is_directory(p, ec)) {
            for (const auto& entry : std::filesystem::directory_iterator(p, ec)) {
                if (entry.is_directory(ec)) {
                    if (hasFile(entry.path(), "package.json") || hasFile(entry.path(), "requirements.txt") ||
                        hasFile(entry.path(), "go.mod") || hasFile(entry.path(), "Cargo.toml") || hasFile(entry.path(), "Dockerfile") ||
                        hasFile(entry.path(), "pom.xml") || hasFile(entry.path(), "build.gradle")) {
                        arch.subServices.push_back(std::string(monoFolder) + "/" + entry.path().filename().string());
                    }
                }
            }
        }
    }

    // 2. Check for Windows Desktop Executables (.exe / .msi)
    bool hasWinExe = false;
    for (const auto& entry : std::filesystem::directory_iterator(sourceDir, ec)) {
        if (ec) break;
        const std::string ext = entry.path().extension().string();
        if (ext == ".exe" || ext == ".msi") {
            hasWinExe = true;
            break;
        }
    }
    if (hasWinExe && !hasFile(sourceDir, "Dockerfile") && !hasFile(sourceDir, "package.json")) {
        arch.type = "windows_desktop_exe";
        arch.displayName = "Windows Desktop Executable (.exe / Win32)";
        arch.isDeployable = true;
        arch.requiresDiversion = true;
        arch.suggestedStrategy = "wine_novnc_web_stream";
        arch.details = "Detected a Windows executable or desktop application. StackPilot generates a containerized Wine virtual desktop with an interactive HTML5 web stream on port 3000.";
        return arch;
    }

    // 2.5 Check for .NET / C# Web Application (.sln / .csproj)
    bool hasDotNet = hasFileWithExtension(sourceDir, ".sln") || hasFileWithExtension(sourceDir, ".csproj") ||
                     hasFile(sourceDir, "Backend_MVC_DotNet8");
    if (hasDotNet && !hasFile(sourceDir, "Dockerfile")) {
        arch.type = "dotnet_web";
        arch.displayName = ".NET 8 / ASP.NET Web Application";
        arch.isDeployable = true;
        arch.suggestedStrategy = "dotnet_sdk_aspnet_container";
        arch.details = "Detected a .NET 8 / C# application. StackPilot packages the service using Microsoft .NET 8 SDK and ASP.NET Core runtime on port 3000.";
        return arch;
    }

    // 3. Check for iOS Native (Xcode / Swift UIKit)
    bool hasXcodeProj = false;
    for (const auto& entry : std::filesystem::directory_iterator(sourceDir, ec)) {
        if (ec) break;
        const std::string name = entry.path().filename().string();
        if (name.rfind(".xcodeproj") != std::string::npos || name.rfind(".xcworkspace") != std::string::npos) {
            hasXcodeProj = true;
            break;
        }
    }
    if (!hasXcodeProj) {
        const auto iosDir = sourceDir / "ios";
        if (std::filesystem::exists(iosDir, ec) && std::filesystem::is_directory(iosDir, ec)) {
            for (const auto& entry : std::filesystem::directory_iterator(iosDir, ec)) {
                if (ec) break;
                const std::string name = entry.path().filename().string();
                if (name.rfind(".xcodeproj") != std::string::npos || name.rfind(".xcworkspace") != std::string::npos) {
                    hasXcodeProj = true;
                    break;
                }
            }
        }
    }

    // 4. Check for Native Android Application (Gradle / Manifest)
    bool isAndroidApp = hasFile(sourceDir, "AndroidManifest.xml") ||
                        hasFile(sourceDir / "app" / "src" / "main", "AndroidManifest.xml") ||
                        hasFile(sourceDir / "src" / "main", "AndroidManifest.xml") ||
                        hasFile(sourceDir / "androidApp" / "src" / "main", "AndroidManifest.xml") ||
                        hasFile(sourceDir / "androidApp", "build.gradle.kts") ||
                        hasFile(sourceDir / "androidApp", "build.gradle") ||
                        hasFile(sourceDir, "build_and_sign_apk.sh");
    std::string androidBundleId;
    std::string androidSdkVersion;

    if (!hasFile(sourceDir, "Dockerfile")) {
        std::string bgContent;
        if (hasFile(sourceDir, "build.gradle")) {
            std::ifstream in(sourceDir / "build.gradle");
            bgContent.assign((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
        } else if (hasFile(sourceDir, "build.gradle.kts")) {
            std::ifstream in(sourceDir / "build.gradle.kts");
            bgContent.assign((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
        } else if (hasFile(sourceDir / "app", "build.gradle")) {
            std::ifstream in(sourceDir / "app" / "build.gradle");
            bgContent.assign((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
        } else if (hasFile(sourceDir / "androidApp", "build.gradle.kts")) {
            std::ifstream in(sourceDir / "androidApp" / "build.gradle.kts");
            bgContent.assign((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
        } else if (hasFile(sourceDir / "androidApp", "build.gradle")) {
            std::ifstream in(sourceDir / "androidApp" / "build.gradle");
            bgContent.assign((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
        }

        if (bgContent.find("com.android.application") != std::string::npos ||
            bgContent.find("com.android.library") != std::string::npos ||
            bgContent.find("apply plugin: 'android'") != std::string::npos ||
            bgContent.find("apply plugin: \"android\"") != std::string::npos ||
            bgContent.find("plugins.android") != std::string::npos ||
            bgContent.find("libs.plugins.android") != std::string::npos ||
            bgContent.find("android {") != std::string::npos) {
            isAndroidApp = true;
        }

        if (isAndroidApp) {
            // Extract namespace / applicationId
            std::regex nsRegex(R"((?:namespace|applicationId)\s*=?\s*["']([^"']+)["'])");
            std::smatch m;
            if (std::regex_search(bgContent, m, nsRegex) && m.size() > 1) {
                androidBundleId = m[1].str();
            }

            // Extract targetSdk / compileSdk
            std::regex sdkRegex(R"((?:compileSdk|compileSdkVersion|targetSdk|targetSdkVersion)\s*=?\s*([0-9]+))");
            if (std::regex_search(bgContent, m, sdkRegex) && m.size() > 1) {
                androidSdkVersion = "API " + m[1].str();
            }
        }
    }

    // 4.5 Check for Compose Multiplatform / Desktop Application (JVM / Compose Desktop)
    bool isComposeDesktop = hasFile(sourceDir, "desktopApp") ||
                            hasFile(sourceDir / "desktopApp", "build.gradle.kts") ||
                            hasFile(sourceDir / "desktopApp", "build.gradle") ||
                            hasFile(sourceDir, "conveyor.conf");
    if (!isComposeDesktop && (hasFile(sourceDir, "build.gradle.kts") || hasFile(sourceDir, "build.gradle"))) {
        std::string bgKts;
        if (hasFile(sourceDir, "build.gradle.kts")) {
            std::ifstream in(sourceDir / "build.gradle.kts");
            bgKts.assign((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
        } else if (hasFile(sourceDir, "build.gradle")) {
            std::ifstream in(sourceDir / "build.gradle");
            bgKts.assign((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
        }
        if (bgKts.find("compose.multiplatform") != std::string::npos ||
            bgKts.find("compose.desktop") != std::string::npos ||
            bgKts.find("org.jetbrains.compose") != std::string::npos ||
            bgKts.find("desktopApp") != std::string::npos ||
            bgKts.find("javafx") != std::string::npos ||
            bgKts.find("openjfx") != std::string::npos) {
            isComposeDesktop = true;
        }
    }

    if (isComposeDesktop && !hasFile(sourceDir, "Dockerfile")) {
        arch.type = "desktop_compose_gui";
        arch.displayName = "Compose Multiplatform / Desktop Application";
        arch.isDeployable = true;
        arch.requiresDiversion = true;
        arch.suggestedStrategy = "desktop_novnc_web_stream";
        arch.details = "Detected a Compose Multiplatform / Desktop application. StackPilot compiles the desktop target and streams the UI over an interactive HTML5 virtual desktop on port 3000.";
        return arch;
    }

    if (isAndroidApp && !hasFile(sourceDir, "package.json") && !hasFile(sourceDir, "requirements.txt") && !hasFile(sourceDir, "Dockerfile")) {
        arch.type = "native_android";
        arch.displayName = "Native Android Application (Gradle)";
        arch.isDeployable = true;
        arch.requiresDiversion = true;
        arch.suggestedStrategy = "android_apk_download_server";
        arch.details = "Detected a native Android application. StackPilot compiles the debug APK via Gradle and hosts an interactive download portal with a mobile install QR code on port 3000.";
        arch.mobileMetadata.framework = "Native Android";
        arch.mobileMetadata.bundleId = androidBundleId.empty() ? "com.android.app" : androidBundleId;
        arch.mobileMetadata.appName = androidBundleId.empty() ? "Android App" : androidBundleId;
        arch.mobileMetadata.sdkVersion = androidSdkVersion.empty() ? "API 34 (Android 14)" : androidSdkVersion;
        arch.mobileMetadata.previewStrategy = "android_apk_download_server";
        return arch;
    }

    // 5. Check for Java Web / Spring Boot / Maven / Gradle
    if (hasFile(sourceDir, "pom.xml") || hasFile(sourceDir, "build.gradle") ||
        hasFile(sourceDir, "build.gradle.kts") || hasFile(sourceDir, "mvnw") || hasFile(sourceDir, "gradlew")) {
        bool isJavaWeb = false;
        std::string buildContent;
        if (hasFile(sourceDir, "pom.xml")) {
            std::ifstream in(sourceDir / "pom.xml");
            buildContent.assign((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
        } else if (hasFile(sourceDir, "build.gradle")) {
            std::ifstream in(sourceDir / "build.gradle");
            buildContent.assign((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
        } else if (hasFile(sourceDir, "build.gradle.kts")) {
            std::ifstream in(sourceDir / "build.gradle.kts");
            buildContent.assign((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
        }

        if (buildContent.find("spring-boot") != std::string::npos ||
            buildContent.find("quarkus") != std::string::npos ||
            buildContent.find("micronaut") != std::string::npos ||
            buildContent.find("ktor") != std::string::npos ||
            buildContent.find("spark-core") != std::string::npos ||
            buildContent.find("dropwizard") != std::string::npos ||
            buildContent.find("<packaging>war</packaging>") != std::string::npos ||
            buildContent.find("servlet") != std::string::npos) {
            isJavaWeb = true;
        }

        bool hasApplicationEntry = (buildContent.find("mainClass") != std::string::npos ||
                                    buildContent.find("application") != std::string::npos ||
                                    buildContent.find("fun main") != std::string::npos ||
                                    buildContent.find("public static void main") != std::string::npos ||
                                    hasFile(sourceDir, "gradlew") ||
                                    hasFile(sourceDir, "mvnw"));

        if (isJavaWeb || hasApplicationEntry) {
            arch.type = "java_web";
            arch.displayName = isJavaWeb ? "Java Web Application (Spring Boot / Maven / Gradle)" : "Java / Kotlin Application (Gradle / Maven)";
            arch.isDeployable = true;
            arch.suggestedStrategy = "java_temurin_container";
            arch.details = "Detected a Java/Kotlin application (Spring Boot / Maven / Gradle). StackPilot packages the service using Eclipse Temurin Java 21 LTS runtime on port 3000.";
            return arch;
        } else if (!hasFile(sourceDir, "Dockerfile")) {
            arch.type = "library";
            arch.displayName = "Java Library / SDK";
            arch.isDeployable = false;
            arch.details = "Detected a Java library or package without a runnable entrypoint. Pure libraries cannot be run as long-running web services. Add a Dockerfile or runnable entrypoint to deploy.";
            return arch;
        }
    }

    // 6. Check for React Native / Expo
    if (hasFile(sourceDir, "package.json")) {
        std::ifstream in(sourceDir / "package.json");
        Json::CharReaderBuilder builder;
        Json::Value pkg;
        std::string errs;
        if (Json::parseFromStream(builder, in, &pkg, &errs) && pkg.isObject()) {
            auto hasDep = [](const Json::Value& deps, const std::string& name) {
                return deps.isObject() && deps.isMember(name);
            };
            const bool isExpo = hasDep(pkg["dependencies"], "expo") || hasDep(pkg["devDependencies"], "expo") || hasFile(sourceDir, "app.json");
            const bool isReactNative = hasDep(pkg["dependencies"], "react-native") || hasDep(pkg["devDependencies"], "react-native");

            if (isExpo || isReactNative) {
                arch.type = "expo_react_native";
                arch.displayName = isExpo ? "React Native (Expo Mobile)" : "React Native Mobile";
                arch.requiresDiversion = true;
                arch.suggestedStrategy = "expo_web_preview";
                arch.details = "Detected a React Native / Expo mobile application. StackPilot is diverting the build to an Expo Web PWA container (port 3000) with interactive mobile phone simulation.";
                arch.mobileMetadata.framework = isExpo ? "Expo" : "React Native";
                arch.mobileMetadata.previewStrategy = "expo_web_preview";

                if (hasFile(sourceDir, "app.json")) {
                    std::ifstream appIn(sourceDir / "app.json");
                    Json::CharReaderBuilder b;
                    Json::Value appJson;
                    std::string aErrs;
                    if (Json::parseFromStream(b, appIn, &appJson, &aErrs) && appJson.isObject() && appJson.isMember("expo")) {
                        const auto& expo = appJson["expo"];
                        arch.mobileMetadata.appName = expo.isMember("name") ? expo["name"].asString() : "";
                        arch.mobileMetadata.bundleId = expo.isMember("slug") ? expo["slug"].asString() : "";
                        arch.mobileMetadata.sdkVersion = expo.isMember("sdkVersion") ? ("SDK " + expo["sdkVersion"].asString()) : "";
                    }
                }
                return arch;
            }

            // Check if pure library
            const Json::Value& scripts = pkg["scripts"];
            bool hasRunnableScript = false;
            if (scripts.isObject()) {
                for (const auto& key : scripts.getMemberNames()) {
                    if (key == "start" || key == "dev" || key == "serve" || key == "server" || key == "preview") {
                        hasRunnableScript = true;
                        break;
                    }
                }
            }
            bool hasWebDep = hasDep(pkg["dependencies"], "express") || hasDep(pkg["dependencies"], "next") ||
                             hasDep(pkg["dependencies"], "nuxt") || hasDep(pkg["dependencies"], "react-scripts") ||
                             hasDep(pkg["dependencies"], "vite") || hasDep(pkg["dependencies"], "koa") ||
                             hasDep(pkg["dependencies"], "fastify") || hasDep(pkg["dependencies"], "nest") ||
                             hasDep(pkg["dependencies"], "@nestjs/core") || hasDep(pkg["dependencies"], "hono") ||
                             hasDep(pkg["dependencies"], "remix") || hasDep(pkg["dependencies"], "astro");

            if (!hasRunnableScript && !hasWebDep && pkg.isMember("main") && !hasFile(sourceDir, "server.js") && !hasFile(sourceDir, "app.js")) {
                arch.type = "library";
                arch.displayName = "JavaScript/TypeScript Library";
                arch.isDeployable = false;
                arch.details = "This repository appears to be a pure JavaScript/TypeScript library or package without a runnable HTTP server. To deploy on StackPilot, add a web server entrypoint (e.g. Express, Fastify, Next.js) or a demonstration dashboard.";
                return arch;
            }
        }
    }

    // 7. Check Flutter
    if (hasFile(sourceDir, "pubspec.yaml")) {
        std::ifstream in(sourceDir / "pubspec.yaml");
        std::string line;
        bool isFlutter = false;
        while (std::getline(in, line)) {
            if (line.find("flutter:") != std::string::npos || line.find("sdk: flutter") != std::string::npos) {
                isFlutter = true;
                break;
            }
        }
        if (isFlutter) {
            arch.type = "flutter_mobile";
            arch.displayName = "Flutter Mobile Application";
            arch.requiresDiversion = true;
            arch.suggestedStrategy = "flutter_web_preview";
            arch.details = "Detected a Flutter mobile application. StackPilot is diverting the build to a Flutter Web preview container on port 3000.";
            arch.mobileMetadata.framework = "Flutter";
            arch.mobileMetadata.previewStrategy = "flutter_web_preview";
            return arch;
        }
    }

    // 8. If pure iOS Xcode project without web or monorepo root server:
    if (hasXcodeProj && !hasFile(sourceDir, "package.json") && !hasFile(sourceDir, "requirements.txt") && !hasFile(sourceDir, "Dockerfile")) {
        arch.type = "native_ios";
        arch.displayName = "Native iOS (Xcode)";
        arch.isDeployable = false;
        arch.details = "Native iOS applications (.xcodeproj / .xcworkspace) require macOS and the iOS simulator SDK and cannot be deployed directly as Linux web containers. If this repository contains a companion backend API, configure the deployment root directory to point to the server subfolder.";
        arch.mobileMetadata.framework = "Native iOS";
        return arch;
    }


    // 10. Pure Python library check
    if ((hasFile(sourceDir, "setup.py") || hasFile(sourceDir, "pyproject.toml")) &&
        !hasFile(sourceDir, "requirements.txt") && !hasFile(sourceDir, "app.py") &&
        !hasFile(sourceDir, "main.py") && !hasFile(sourceDir, "server.py") && !hasFile(sourceDir, "wsgi.py") && !hasFile(sourceDir, "asgi.py") && !hasFile(sourceDir, "manage.py")) {
        bool hasWebFramework = false;
        for (const auto& entry : std::filesystem::directory_iterator(sourceDir, ec)) {
            if (ec) break;
            if (entry.is_regular_file(ec) && entry.path().extension() == ".py") {
                std::ifstream pyIn(entry.path());
                std::string pyLine;
                while (std::getline(pyIn, pyLine)) {
                    if (pyLine.find("flask") != std::string::npos || pyLine.find("fastapi") != std::string::npos ||
                        pyLine.find("django") != std::string::npos || pyLine.find("streamlit") != std::string::npos ||
                        pyLine.find("uvicorn") != std::string::npos) {
                        hasWebFramework = true;
                        break;
                    }
                }
                if (hasWebFramework) break;
            }
        }
        if (!hasWebFramework) {
            arch.type = "library";
            arch.displayName = "Python Library / SDK";
            arch.isDeployable = false;
            arch.details = "This repository appears to be a pure Python library or SDK without a runnable web application entrypoint (e.g. FastAPI, Flask, Streamlit). To deploy on StackPilot, add a web server entrypoint script.";
            return arch;
        }
    }

    if (!arch.subServices.empty()) {
        arch.type = "monorepo";
        arch.displayName = "Monorepo / Multi-Service";
    }

    return arch;
}

bool BuildService::ensureDockerfile(const std::filesystem::path& sourceDir,
                                    const std::filesystem::path& logFile,
                                    std::string& reason,
                                    LogCallback onLogLine) const {
    const std::filesystem::path dockerfilePath = sourceDir / "Dockerfile";
    if (std::filesystem::exists(dockerfilePath)) {
        return true;
    }

    // 1. Run Deterministic Archetype Pre-Flight Classification FIRST
    const RepositoryArchetype archetype = classifyRepositoryArchetype(sourceDir);
    if (!archetype.isDeployable) {
        appendLogLine(logFile, "============================================================", onLogLine);
        appendLogLine(logFile, "❌ [Archetype Pre-Flight Check] " + archetype.displayName + " detected.", onLogLine);
        appendLogLine(logFile, archetype.details, onLogLine);
        if (!archetype.subServices.empty()) {
            std::string subMsg = "Detected runnable sub-services in repository:";
            for (const auto& svc : archetype.subServices) {
                subMsg += " " + svc;
            }
            appendLogLine(logFile, subMsg, onLogLine);
        }
        appendLogLine(logFile, "============================================================", onLogLine);
        reason = archetype.details;
        return false;
    }

    std::string generated;

    if (archetype.type == "windows_desktop_exe") {
        appendLogLine(logFile, "🖥️ [Archetype Engine] " + archetype.displayName + " detected.", onLogLine);
        appendLogLine(logFile, "⚡ [Wine Streaming] Auto-generating Wine 64/32 virtual desktop with noVNC HTML5 canvas on port 3000...", onLogLine);
        generated =
            "FROM ubuntu:22.04\n"
            "ENV DEBIAN_FRONTEND=noninteractive DISPLAY=:99 WINEPREFIX=/wine WINEARCH=win64 WINEDEBUG=-all\n"
            "RUN dpkg --add-architecture i386 && apt-get update && apt-get install -y --no-install-recommends \\\n"
            "    ca-certificates curl xvfb openbox x11vnc novnc websockify supervisor wine64 wine32 fonts-wine net-tools \\\n"
            "    && rm -rf /var/lib/apt/lists/*\n"
            "RUN mkdir -p /wine && wineboot --init || true\n"
            "WORKDIR /app\n"
            "COPY . /app\n"
            "RUN mkdir -p /etc/supervisor/conf.d\n"
            "RUN printf '[supervisord]\\nnodaemon=true\\n\\n[program:xvfb]\\ncommand=Xvfb :99 -screen 0 1280x720x24 -ac +extension GLX +render -noreset\\npriority=100\\nautorestart=true\\n\\n[program:openbox]\\ncommand=openbox-session\\nenvironment=DISPLAY=\":99\"\\npriority=200\\nautorestart=true\\n\\n[program:x11vnc]\\ncommand=x11vnc -display :99 -forever -shared -nopw -rfbport 5900 -listen 127.0.0.1\\npriority=300\\nautorestart=true\\n\\n[program:websockify]\\ncommand=websockify --web /usr/share/novnc 3000 localhost:5900\\npriority=400\\nautorestart=true\\n\\n[program:app]\\ncommand=/bin/bash -c \"sleep 2; exe=$(find /app -maxdepth 3 -type f -name \\'*.exe\\' | head -n1); if [ -n \\\"$exe\\\" ]; then exec wine explorer /desktop=App,1280x720 \\\"$exe\\\"; else exec sleep infinity; fi\"\\nenvironment=DISPLAY=\":99\",WINEPREFIX=\"/wine\",WINEDEBUG=\"-all\"\\npriority=500\\nautorestart=false\\n' > /etc/supervisor/conf.d/supervisord.conf\n"
            "EXPOSE 3000\n"
            "CMD [\"/usr/bin/supervisord\", \"-c\", \"/etc/supervisor/conf.d/supervisord.conf\"]\n";
    } else if (archetype.type == "native_android") {
        appendLogLine(logFile, "📱 [Archetype Engine] " + archetype.displayName + " detected.", onLogLine);
        appendLogLine(logFile, "⚡ [Android Portal] Auto-generating APK build & mobile install QR portal on port 3000...", onLogLine);
        generated =
            "FROM python:3.12-alpine\n"
            "WORKDIR /app\n"
            "COPY . /app\n"
            "RUN pip install --no-cache-dir qrcode pillow || true\n"
            "RUN printf 'import http.server, socketserver, os, glob\\nPORT = 3000\\nclass H(http.server.SimpleHTTPRequestHandler):\\n    def do_GET(self):\\n        apks = glob.glob(\"/app/**/*.apk\", recursive=True)\\n        apk = apks[0] if apks else \"\"\\n        apk_name = os.path.basename(apk) if apk else \"app-debug.apk\"\\n        if self.path == \"/\" or self.path == \"/index.html\":\\n            self.send_response(200)\\n            self.send_header(\"Content-type\", \"text/html; charset=utf-8\")\\n            self.end_headers()\\n            host = self.headers.get(\"Host\", f\"localhost:{PORT}\")\\n            dl_url = f\"http://{host}/{apk_name}\"\\n            qr_api = f\"https://api.qrserver.com/v1/create-qr-code/?size=220x220&data={dl_url}&bgcolor=18181b&color=38bdf8&margin=1\"\\n            html = f\"\"\"<!DOCTYPE html><html><head><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Android APK Install</title><style>body{{font-family:system-ui,sans-serif;background:#09090b;color:#f4f4f5;text-align:center;padding:40px 16px;margin:0;}} .card{{background:#18181b;max-width:440px;margin:0 auto;padding:32px;border-radius:20px;border:1px solid #27272a;box-shadow:0 20px 40px rgba(0,0,0,0.6);}} h1{{font-size:22px;margin:0 0 8px;}} p{{color:#a1a1aa;font-size:13px;line-height:1.5;}} .btn{{display:inline-block;background:#38bdf8;color:#09090b;padding:12px 28px;font-weight:700;border-radius:10px;text-decoration:none;margin-top:20px;transition:0.2s;}} .qr{{background:#18181b;padding:12px;border-radius:16px;display:inline-block;margin:16px 0;border:1px solid #38bdf840;}}</style></head><body><div class=\"card\"><h1>Android Application Ready</h1><p>Scan the QR code with your physical Android phone camera to download and install this application instantly over WiFi.</p><div class=\"qr\"><img src=\"{qr_api}\" width=\"220\" height=\"220\" alt=\"QR Code\" /></div><br><a href=\"/{apk_name}\" class=\"btn\" download>Download APK ({apk_name})</a></div></body></html>\"\"\"\\n            self.wfile.write(html.encode(\"utf-8\"))\\n        else:\\n            super().do_GET()\\nwith socketserver.TCPServer((\"\", PORT), H) as s:\\n    print(f\"Android Portal serving on {PORT}\")\\n    s.serve_forever()\\n' > /app/portal.py\n"
            "EXPOSE 3000\n"
            "CMD [\"python\", \"/app/portal.py\"]\n";
    } else if (archetype.type == "desktop_compose_gui") {
        appendLogLine(logFile, "🖥️ [Archetype Engine] " + archetype.displayName + " detected.", onLogLine);
        appendLogLine(logFile, "⚡ [Desktop Stream] Auto-generating Eclipse Temurin 21 + Xvfb HTML5 web desktop on port 3000...", onLogLine);
        generated =
            "FROM eclipse-temurin:21-jdk AS builder\n"
            "WORKDIR /app\n"
            "COPY . .\n"
            "RUN if [ -f gradlew ]; then chmod +x gradlew && (./gradlew desktopApp:jar || ./gradlew jar || ./gradlew build -x test || ./gradlew assemble || true); fi\n\n"
            "FROM ubuntu:22.04\n"
            "ENV DEBIAN_FRONTEND=noninteractive DISPLAY=:99\n"
            "RUN apt-get update && apt-get install -y --no-install-recommends \\\n"
            "    ca-certificates curl xvfb openbox x11vnc novnc websockify supervisor openjdk-21-jre fonts-dejavu-core net-tools \\\n"
            "    && rm -rf /var/lib/apt/lists/*\n"
            "WORKDIR /app\n"
            "COPY --from=builder /app /app\n"
            "RUN mkdir -p /etc/supervisor/conf.d\n"
            "RUN printf '[supervisord]\\nnodaemon=true\\n\\n[program:xvfb]\\ncommand=Xvfb :99 -screen 0 1280x720x24 -ac +extension GLX +render -noreset\\npriority=100\\nautorestart=true\\n\\n[program:openbox]\\ncommand=openbox-session\\nenvironment=DISPLAY=\":99\"\\npriority=200\\nautorestart=true\\n\\n[program:x11vnc]\\ncommand=x11vnc -display :99 -forever -shared -nopw -rfbport 5900 -listen 127.0.0.1\\npriority=300\\nautorestart=true\\n\\n[program:websockify]\\ncommand=websockify --web /usr/share/novnc 3000 localhost:5900\\npriority=400\\nautorestart=true\\n\\n[program:app]\\ncommand=/bin/bash -c \"sleep 3; jar=$(find /app -name \\'*.jar\\' | grep -v \\'plain\\' | head -n1); if [ -n \\\"$jar\\\" ]; then exec java -jar \\\"$jar\\\"; else exec sleep infinity; fi\"\\nenvironment=DISPLAY=\":99\"\\npriority=500\\nautorestart=false\\n' > /etc/supervisor/conf.d/supervisord.conf\n"
            "EXPOSE 3000\n"
            "CMD [\"/usr/bin/supervisord\", \"-c\", \"/etc/supervisor/conf.d/supervisord.conf\"]\n";
    } else if (archetype.type == "expo_react_native") {
        appendLogLine(logFile, "📱 [Archetype Pre-Flight Check] " + archetype.displayName + " detected.", onLogLine);
        appendLogLine(logFile, "⚡ [Smart Diversion] Auto-generating Expo Web PWA container preview on port 3000...", onLogLine);
        generated =
            "FROM node:20-alpine AS builder\n"
            "WORKDIR /app\n"
            "COPY package*.json ./\n"
            "RUN npm install --legacy-peer-deps || npm install\n"
            "COPY . .\n"
            "RUN npx expo export --platform web || npx expo export:web || npm run build || true\n\n"
            "FROM nginx:alpine\n"
            "COPY --from=builder /app/dist /usr/share/nginx/html\n"
            "RUN if [ ! -d /usr/share/nginx/html ] || [ -z \"$(ls -A /usr/share/nginx/html 2>/dev/null)\" ]; then \\\n"
            "      cp -r /app/web-build/* /usr/share/nginx/html/ 2>/dev/null || true; \\\n"
            "    fi\n"
            "RUN printf 'server {\\n    listen 3000;\\n    server_name localhost;\\n    root /usr/share/nginx/html;\\n    index index.html;\\n    location / {\\n        try_files $uri $uri/ /index.html;\\n    }\\n}\\n' > /etc/nginx/conf.d/default.conf\n"
            "RUN mkdir -p /var/cache/nginx/client_temp /var/cache/nginx/proxy_temp /var/cache/nginx/fastcgi_temp /var/cache/nginx/uwsgi_temp /var/cache/nginx/scgi_temp && chmod -R 777 /var/cache/nginx /var/run /var/log/nginx /etc/nginx\n"
            "EXPOSE 3000\n"
            "CMD [\"nginx\", \"-g\", \"daemon off;\"]\n";
    } else if (archetype.type == "flutter_mobile") {
        appendLogLine(logFile, "📱 [Archetype Pre-Flight Check] " + archetype.displayName + " detected.", onLogLine);
        appendLogLine(logFile, "⚡ [Smart Diversion] Auto-generating Flutter Web preview container on port 3000...", onLogLine);
        generated =
            "FROM ghcr.io/cirruslabs/flutter:stable AS build\n"
            "WORKDIR /app\n"
            "COPY . .\n"
            "RUN flutter config --enable-web && flutter pub get && flutter build web --release\n\n"
            "FROM nginx:alpine\n"
            "COPY --from=build /app/build/web /usr/share/nginx/html\n"
            "RUN printf 'server {\\n    listen 3000;\\n    server_name localhost;\\n    root /usr/share/nginx/html;\\n    index index.html;\\n    location / {\\n        try_files $uri $uri/ /index.html;\\n    }\\n}\\n' > /etc/nginx/conf.d/default.conf\n"
            "RUN mkdir -p /var/cache/nginx/client_temp /var/cache/nginx/proxy_temp /var/cache/nginx/fastcgi_temp /var/cache/nginx/uwsgi_temp /var/cache/nginx/scgi_temp && chmod -R 777 /var/cache/nginx /var/run /var/log/nginx /etc/nginx\n"
            "EXPOSE 3000\n"
            "CMD [\"nginx\", \"-g\", \"daemon off;\"]\n";
    } else if (hasFile(sourceDir, "index.html") || hasFileWithExtension(sourceDir, ".html")) {
        appendLogLine(logFile, "🌐 [Archetype Engine] Static HTML/CSS/JS site detected. Generating Nginx container on port 3000...", onLogLine);
        generated =
            "FROM nginx:alpine\n"
            "WORKDIR /usr/share/nginx/html\n"
            "COPY . /usr/share/nginx/html/\n"
            "RUN printf 'server {\\n    listen 3000;\\n    server_name localhost;\\n    root /usr/share/nginx/html;\\n    index index.html index.htm;\\n    location / {\\n        try_files $uri $uri/ /index.html =404;\\n    }\\n}\\n' > /etc/nginx/conf.d/default.conf\n"
            "RUN mkdir -p /var/cache/nginx/client_temp /var/cache/nginx/proxy_temp /var/cache/nginx/fastcgi_temp /var/cache/nginx/uwsgi_temp /var/cache/nginx/scgi_temp && chmod -R 777 /var/cache/nginx /var/run /var/log/nginx /etc/nginx\n"
            "EXPOSE 3000\n"
            "CMD [\"nginx\", \"-g\", \"daemon off;\"]\n";
    } else if (hasFileWithExtension(sourceDir, ".sln") || hasFileWithExtension(sourceDir, ".csproj") ||
               hasFile(sourceDir, "Backend_MVC_DotNet8")) {
        appendLogLine(logFile, "🔷 [Archetype Engine] .NET 8 / C# application detected. Generating multi-stage SDK & ASP.NET container on port 3000...", onLogLine);
        generated =
            "FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build\n"
            "WORKDIR /src\n"
            "COPY . .\n"
            "RUN proj=$(find . -name '*.csproj' ! -iname '*test*' | head -n1); \\\n"
            "    if [ -z \"$proj\" ]; then proj=$(find . -name '*.csproj' | head -n1); fi; \\\n"
            "    if [ -z \"$proj\" ]; then echo \"No .csproj found\"; exit 1; fi; \\\n"
            "    dotnet restore \"$proj\" && dotnet publish \"$proj\" -c Release -o /app/publish /p:UseAppHost=false\n\n"
            "FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS final\n"
            "WORKDIR /app\n"
            "COPY --from=build /app/publish .\n"
            "ENV ASPNETCORE_URLS=http://+:3000\n"
            "ENV PORT=3000\n"
            "EXPOSE 3000\n"
            "CMD [\"sh\", \"-c\", \"cfg=$(find /app -maxdepth 1 -name '*.runtimeconfig.json' ! -iname '*test*' | head -n1); if test -n \\\"$cfg\\\"; then dll=\\\"\\${cfg%.runtimeconfig.json}.dll\\\"; else dll=$(find /app -maxdepth 1 -name '*.dll' ! -name 'Microsoft.*' ! -name 'System.*' ! -name 'Azure.*' ! -iname '*test*' | head -n1); fi; exec dotnet \\\"$dll\\\"\"]\n";
    } else if (hasFile(sourceDir, "package.json")) {
        const std::filesystem::path packageJsonPath = sourceDir / "package.json";
        Json::Value packageJson;
        bool parsedPackage = false;
        {
            std::ifstream in(packageJsonPath);
            if (in.is_open()) {
                Json::CharReaderBuilder builder;
                builder["collectComments"] = false;
                std::string errors;
                parsedPackage = Json::parseFromStream(builder, in, &packageJson, &errors) && packageJson.isObject();
            }
        }

        const bool hasNextConfig = hasFile(sourceDir, "next.config.js") ||
                                   hasFile(sourceDir, "next.config.mjs") ||
                                   hasFile(sourceDir, "next.config.ts") ||
                                   hasFile(sourceDir, "next.config.cjs");
        const bool hasNuxtConfig = hasFile(sourceDir, "nuxt.config.js") ||
                                   hasFile(sourceDir, "nuxt.config.mjs") ||
                                   hasFile(sourceDir, "nuxt.config.ts") ||
                                   hasFile(sourceDir, "nuxt.config.cjs");
        const bool nextApp = hasNextConfig || isNextJsApp(sourceDir);
        const bool nuxtApp = hasNuxtConfig;

        bool hasBuildScript = false;
        bool hasStartScript = false;
        bool hasVite = false;

        if (parsedPackage) {
            const Json::Value& scripts = packageJson["scripts"];
            if (scripts.isObject()) {
                hasBuildScript = scripts.isMember("build") && scripts["build"].isString() && !scripts["build"].asString().empty();
                hasStartScript = scripts.isMember("start") && scripts["start"].isString() && !scripts["start"].asString().empty();
            }
            auto hasDep = [](const Json::Value& deps, const std::string& name) {
                return deps.isObject() && deps.isMember(name);
            };
            hasVite = hasDep(packageJson["dependencies"], "vite") ||
                      hasDep(packageJson["devDependencies"], "vite");
        } else {
            hasBuildScript = hasPackageScript(packageJsonPath, "build");
            hasStartScript = hasPackageScript(packageJsonPath, "start");
        }

        const bool isStaticSpa = (!nextApp && !nuxtApp) && ((hasBuildScript && !hasStartScript) || hasVite);

        if (isStaticSpa) {
            appendLogLine(logFile, "Detected Static SPA (Vite/React/Vue/Svelte/Astro). Generating Nginx multi-stage Dockerfile.", onLogLine);
            generated =
                "FROM node:20-alpine AS builder\n"
                "WORKDIR /app\n"
                "COPY package*.json ./\n"
                "RUN npm ci || npm install\n"
                "COPY . .\n"
                "RUN npm run build\n\n"
                "FROM nginx:alpine\n"
                "COPY --from=builder /app/dist /usr/share/nginx/html\n"
                "RUN if [ ! -d /usr/share/nginx/html ] || [ -z \"$(ls -A /usr/share/nginx/html 2>/dev/null)\" ]; then \\\n"
                "      cp -r /app/build/* /usr/share/nginx/html/ 2>/dev/null || true; \\\n"
                "    fi\n"
                "RUN printf 'server {\\n    listen 3000;\\n    server_name localhost;\\n    root /usr/share/nginx/html;\\n    index index.html;\\n    location / {\\n        try_files $uri $uri/ /index.html;\\n    }\\n}\\n' > /etc/nginx/conf.d/default.conf\n"
                "RUN mkdir -p /var/cache/nginx/client_temp /var/cache/nginx/proxy_temp /var/cache/nginx/fastcgi_temp /var/cache/nginx/uwsgi_temp /var/cache/nginx/scgi_temp && chmod -R 777 /var/cache/nginx /var/run /var/log/nginx /etc/nginx\n"
                "EXPOSE 3000\n"
                "CMD [\"nginx\", \"-g\", \"daemon off;\"]\n";
        } else {
            generated =
                "FROM node:20-alpine\n"
                "WORKDIR /app\n"
                "COPY package*.json ./\n"
                "RUN npm ci || npm install\n"
                "COPY . .\n";

            if (nextApp || hasBuildScript) {
                generated +=
                    "RUN if [ -f next.config.js ] || [ -f next.config.mjs ] || [ -f next.config.ts ] || "
                    "node -e \"const fs=require('fs');const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));if(!(pkg.scripts&&pkg.scripts.build)) process.exit(1)\"; then npm run build; fi\n";
            }

            generated +=
                "EXPOSE 3000\n"
                "CMD [\"sh\", \"-c\", \"node -e \\\"const p=require('./package.json');process.exit(p.scripts&&p.scripts.start?0:1)\\\" && npm start || node server.js || node index.js || node app.js\"]\n";
        }
    } else if (hasFile(sourceDir, "requirements.txt") || hasFile(sourceDir, "pyproject.toml") ||
               hasFile(sourceDir, "app.py") || hasFile(sourceDir, "main.py") || hasPythonScript(sourceDir)) {
        if (hasFile(sourceDir, "requirements.txt")) {
            generated =
                "FROM python:3.12-slim\n"
                "WORKDIR /app\n"
                "COPY requirements.txt ./\n"
                "RUN pip install --no-cache-dir -r requirements.txt\n"
                "COPY . .\n"
                "EXPOSE 3000\n"
                "CMD [\"sh\", \"-c\", \"if python - <<'PY'\\nimport importlib.util,sys\\nsys.exit(0 if importlib.util.find_spec('streamlit') else 1)\\nPY\\nthen f=$(if [ -f app.py ]; then echo app.py; elif [ -f main.py ]; then echo main.py; else ls *.py 2>/dev/null | head -n1; fi); [ -n \\\"$f\\\" ] || { echo 'No Python entrypoint found'; exit 1; }; exec streamlit run \\\"$f\\\" --server.address=0.0.0.0 --server.port=3000; elif python - <<'PY'\\nimport importlib.util,sys\\nsys.exit(0 if importlib.util.find_spec('uvicorn') else 1)\\nPY\\nthen m=$(if [ -f app.py ]; then echo app; elif [ -f main.py ]; then echo main; else ls *.py 2>/dev/null | head -n1 | sed 's/\\\\.py$//'; fi); [ -n \\\"$m\\\" ] || { echo 'No Python module found'; exit 1; }; exec uvicorn \\\"${m}:app\\\" --host 0.0.0.0 --port=3000; else f=$(if [ -f app.py ]; then echo app.py; elif [ -f main.py ]; then echo main.py; else ls *.py 2>/dev/null | head -n1; fi); [ -n \\\"$f\\\" ] || { echo 'No Python entrypoint found'; exit 1; }; exec python \\\"$f\\\"; fi\"]\n";
        } else {
            generated =
                "FROM python:3.12-slim\n"
                "WORKDIR /app\n"
                "COPY . .\n"
                "RUN if [ -f pyproject.toml ]; then pip install --no-cache-dir .; fi\n"
                "EXPOSE 3000\n"
                "CMD [\"sh\", \"-c\", \"if python - <<'PY'\\nimport importlib.util,sys\\nsys.exit(0 if importlib.util.find_spec('streamlit') else 1)\\nPY\\nthen f=$(if [ -f app.py ]; then echo app.py; elif [ -f main.py ]; then echo main.py; else ls *.py 2>/dev/null | head -n1; fi); [ -n \\\"$f\\\" ] || { echo 'No Python entrypoint found'; exit 1; }; exec streamlit run \\\"$f\\\" --server.address=0.0.0.0 --server.port=3000; elif python - <<'PY'\\nimport importlib.util,sys\\nsys.exit(0 if importlib.util.find_spec('uvicorn') else 1)\\nPY\\nthen m=$(if [ -f app.py ]; then echo app; elif [ -f main.py ]; then echo main; else ls *.py 2>/dev/null | head -n1 | sed 's/\\\\.py$//'; fi); [ -n \\\"$m\\\" ] || { echo 'No Python module found'; exit 1; }; exec uvicorn \\\"${m}:app\\\" --host 0.0.0.0 --port=3000; else f=$(if [ -f app.py ]; then echo app.py; elif [ -f main.py ]; then echo main.py; else ls *.py 2>/dev/null | head -n1; fi); [ -n \\\"$f\\\" ] || { echo 'No Python entrypoint found'; exit 1; }; exec python \\\"$f\\\"; fi\"]\n";
        }
    } else if (hasFile(sourceDir, "go.mod")) {
        generated =
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
            "CMD [\"./server\"]\n";
    } else if (hasFile(sourceDir, "CMakeLists.txt")) {
        generated =
            "FROM ubuntu:24.04\n"
            "RUN apt-get update && apt-get install -y build-essential cmake libssl-dev zlib1g-dev uuid-dev && rm -rf /var/lib/apt/lists/*\n"
            "WORKDIR /app\n"
            "COPY . .\n"
            "RUN cmake -S . -B build && cmake --build build --config Release\n"
            "ENV PORT=3000\n"
            "EXPOSE 3000\n"
            "CMD [\"/bin/sh\", \"-c\", \"exe=$(find build -maxdepth 4 -type f -executable | head -n1); [ -n \\\"$exe\\\" ] || { echo 'No executable found after CMake build'; exit 1; }; exec \\\"$exe\\\"\"]\n";
    } else if (hasFile(sourceDir, "Cargo.toml")) {
        generated =
            "FROM rust:1-bookworm AS build\n"
            "WORKDIR /src\n"
            "COPY . .\n"
            "RUN cargo build --release\n"
            "FROM debian:bookworm-slim\n"
            "WORKDIR /app\n"
            "COPY --from=build /src/target/release /app/bin\n"
            "ENV PORT=3000\n"
            "EXPOSE 3000\n"
            "CMD [\"/bin/sh\", \"-c\", \"exe=$(find /app/bin -maxdepth 1 -type f -executable | head -n1); [ -n \\\"$exe\\\" ] || { echo 'No Rust release binary found'; exit 1; }; exec \\\"$exe\\\"\"]\n";
    } else if (hasFile(sourceDir, "pom.xml") || hasFile(sourceDir, "build.gradle") ||
               hasFile(sourceDir, "build.gradle.kts") || hasFile(sourceDir, "gradlew")) {
        generated =
            "FROM eclipse-temurin:21-jdk AS build\n"
            "WORKDIR /src\n"
            "COPY . .\n"
            "RUN if [ -f mvnw ]; then chmod +x mvnw && ./mvnw -DskipTests package; elif [ -f pom.xml ]; then apt-get update && apt-get install -y maven && mvn -DskipTests package; elif [ -f gradlew ]; then chmod +x gradlew && (./gradlew build -x test || ./gradlew desktopApp:jar || ./gradlew jar || ./gradlew assemble || true); else apt-get update && apt-get install -y gradle && gradle build -x test; fi\n"
            "FROM eclipse-temurin:21-jre\n"
            "WORKDIR /app\n"
            "COPY --from=build /src .\n"
            "ENV PORT=3000\n"
            "ENV SERVER_PORT=3000\n"
            "EXPOSE 3000\n"
            "CMD [\"/bin/sh\", \"-c\", \"jar=$(find . -path '*/target/*.jar' -o -path '*/build/libs/*.jar' -o -name '*.jar' | grep -v plain | head -n1); [ -n \\\"$jar\\\" ] || { echo 'No runnable jar found'; exit 1; }; exec java -jar \\\"$jar\\\"\"]\n";
    } else {
        appendLogLine(logFile, "🤖 [AI Agent Auto-Detect] Project type could not be deterministically resolved. Passing project tree to AI agent...", onLogLine);
        std::string aiReason;
        if (tryGenerateDockerfileWithAi(sourceDir, logFile, aiReason, onLogLine)) {
            appendLogLine(logFile, "✅ [AI Agent Auto-Detect] Dockerfile developed and verified by AI. Continuing deployment build...", onLogLine);
            return true;
        }

        reason = "No Dockerfile found, deterministic engine could not detect project type, and AI generation failed (" + aiReason + ")";
        return false;
    }

    std::ofstream out(dockerfilePath, std::ios::trunc);
    if (!out.is_open()) {
        reason = "Failed to write generated Dockerfile";
        return false;
    }

    out << generated;
    appendLogLine(logFile, "⚡ [Deterministic Engine] Dockerfile generated successfully for " + archetype.displayName + ".", onLogLine);
    return true;
}

} // namespace stackpilot
