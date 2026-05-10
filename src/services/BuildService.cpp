// ============================================================
// BuildService.cpp — Repository clone + Docker image build
// ============================================================

#include "BuildService.h"
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
#include <unordered_set>

namespace dokscp {

namespace {

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

bool hasFile(const std::filesystem::path& dir, const std::string& name) {
    return std::filesystem::exists(dir / name);
}

std::filesystem::path findComposeFile(const std::filesystem::path& dir) {
    const std::vector<std::string> candidates = {
        "docker-compose.dokscp.yml",
        "docker-compose.dokscp.yaml",
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
    const std::string name = relativePath.filename().string();
    const std::string ext = relativePath.extension().string();
    static const std::unordered_set<std::string> manifestNames = {
        "package.json", "requirements.txt", "pyproject.toml", "Pipfile", "poetry.lock",
        "uv.lock", "environment.yml", "go.mod", "Cargo.toml", "pom.xml",
        "build.gradle", "build.gradle.kts", "README.md"
    };
    if (manifestNames.find(name) != manifestNames.end()) {
        return true;
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
           lowered.find("copy ") != std::string::npos &&
           (lowered.find("cmd ") != std::string::npos || lowered.find("entrypoint ") != std::string::npos);
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

    const std::string branchArg = branch.empty() ? "" : (" --branch " + shellQuote(branch));
    const std::string cloneCmd =
        credentialPrefix +
        "GIT_TERMINAL_PROMPT=0 " +
        "git -c credential.helper= clone --depth 1" + branchArg + " " +
        shellQuote(repoUrl) + " " + shellQuote(sourceDir.string());
    int cloneExit = runCommandCapture(cloneCmd, logFile, true, cloneTimeoutSeconds_, onLogLine);
    if (cloneExit != 0 && !githubPat.empty() && isGitHubHttps && looksLikeGitHubAuthFailure(readFileBounded(logFile))) {
        appendLogLine(
            logFile,
            "Authenticated GitHub clone was rejected. Retrying once without credentials in case the repository is public.",
            onLogLine
        );
        std::error_code cleanupEc;
        std::filesystem::remove_all(sourceDir, cleanupEc);
        const std::string publicCloneCmd =
            "GIT_TERMINAL_PROMPT=0 git -c credential.helper= clone --depth 1" + branchArg + " " +
            shellQuote(repoUrl) + " " + shellQuote(sourceDir.string());
        cloneExit = runCommandCapture(publicCloneCmd, logFile, true, cloneTimeoutSeconds_, onLogLine);
    }
    if (cloneExit != 0) {
        if (!askPassPath.empty()) {
            std::error_code cleanupEc;
            std::filesystem::remove(askPassPath, cleanupEc);
            std::filesystem::remove(tokenPath, cleanupEc);
        }
        result.error = "git clone failed";
        appendLogLine(logFile,
                      "git clone failed with exit code " + std::to_string(cloneExit),
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

    if (!checkoutCommit.empty()) {
        appendLogLine(logFile, "Checking out commit " + checkoutCommit, onLogLine);
        std::string checkoutCmd =
            "GIT_TERMINAL_PROMPT=0 git -C " + shellQuote(sourceDir.string()) +
            " checkout --detach " + shellQuote(checkoutCommit);
        int checkoutExit = runCommandCapture(checkoutCmd, logFile, true, cloneTimeoutSeconds_, onLogLine);
        if (checkoutExit != 0) {
            appendLogLine(logFile, "Commit was not present in the shallow clone. Fetching exact commit.", onLogLine);
            const std::string fetchPrefix =
                (!githubPat.empty() && isGitHubHttps && !askPassPath.empty())
                    ? ("GIT_ASKPASS=" + shellQuote(askPassPath.string()) + " GIT_TERMINAL_PROMPT=0 ")
                    : "GIT_TERMINAL_PROMPT=0 ";
            const std::string fetchCmd =
                fetchPrefix + "git -C " + shellQuote(sourceDir.string()) +
                " fetch --depth 1 origin " + shellQuote(checkoutCommit);
            const int fetchExit = runCommandCapture(fetchCmd, logFile, true, cloneTimeoutSeconds_, onLogLine);
            if (fetchExit == 0) {
                checkoutExit = runCommandCapture(checkoutCmd, logFile, true, cloneTimeoutSeconds_, onLogLine);
            }
        }
        if (checkoutExit != 0) {
            if (!askPassPath.empty()) {
                std::error_code cleanupEc;
                std::filesystem::remove(askPassPath, cleanupEc);
                std::filesystem::remove(tokenPath, cleanupEc);
            }
            result.error = "git checkout failed";
            appendLogLine(logFile, "Unable to checkout requested commit " + checkoutCommit, onLogLine);
            result.logs = readFileBounded(logFile);
            return result;
        }
    }
    if (!askPassPath.empty()) {
        std::error_code cleanupEc;
        std::filesystem::remove(askPassPath, cleanupEc);
        std::filesystem::remove(tokenPath, cleanupEc);
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
    const int extractExit = runCommandCapture(extractCommand, logFile, true, cloneTimeoutSeconds_, onLogLine);
    if (extractExit != 0) {
        result.error = extractExit == 124 ? "Source artifact extraction timed out" : "Source artifact extraction failed";
        appendLogLine(logFile, result.error, onLogLine);
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
    const std::string imageName = "dokscp/" + sanitizeName(deploymentId) + ":" + sanitizeTag(version);
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
    const std::string containerName = "dokscp-" + projectSlug + "-" + sanitizeName(deploymentId).substr(0, 8);

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

    const std::string remoteComposeProject = markerValue(remoteResult.output, "__DOKSCP_REMOTE_COMPOSE_PROJECT__");
    if (!remoteComposeProject.empty()) {
        result.composeProject = true;
        result.composeProjectName = remoteComposeProject;
        result.composeFile = markerValue(remoteResult.output, "__DOKSCP_REMOTE_COMPOSE_FILE__");
        result.composeServices = markerValue(remoteResult.output, "__DOKSCP_REMOTE_COMPOSE_SERVICES__");
        result.composeWorkdir = remotePath;
        result.imageName = "compose:" + remoteComposeProject;
        result.remoteContainerName = remoteComposeProject;
        result.runtimeProvider = "remote_compose";
        result.runtimeUrl = markerValue(remoteResult.output, "__DOKSCP_REMOTE_URL__");
    }

    if (!remoteResult.success) {
        if (remoteResult.output.find("__DOKSCP_COMPOSE_MISSING__") != std::string::npos) {
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
        if (line.rfind("__DOKSCP_REMOTE_PORT__=", 0) == 0) {
            publishedPort = line.substr(std::string("__DOKSCP_REMOTE_PORT__=").size());
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
    const std::string remoteBase = baseWorkspace + "/dokscp-builds/" + safeDeployment;
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
        " && echo __DOKSCP_ARTIFACT_EXTRACTED__";
    auto extractResult = sshService.runRemoteCommand(sshConfig, "/", extractCommand, 120);
    if (!extractResult.success || extractResult.output.find("__DOKSCP_ARTIFACT_EXTRACTED__") == std::string::npos) {
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
    const std::string remoteBase = baseWorkspace + "/dokscp-builds/" + safeDeployment;
    const std::string remoteSourcePath = remoteBase + "/source";

    if (onLogLine) {
        onLogLine("Starting remote repository build for deployment " + deploymentId);
        onLogLine("Repository: " + repoUrl);
        if (!branch.empty()) onLogLine("Branch: " + branch);
        if (!commitSha.empty()) onLogLine("Commit: " + commitSha);
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
        const std::string composeProject = "dokscp-" + composeProjectSuffix;
        appendLogLine(logFile, "Detected Docker Compose project: " + composeFile, onLogLine);
        appendLogLine(logFile, "Starting Compose build and runtime stack: " + composeProject, onLogLine);

        const std::string quotedComposeFile = shellQuote(composeFile);
        const std::string quotedProject = shellQuote(composeProject);
        const std::string composeCommand =
            "cd " + shellQuote(sourceDir.string()) + " && "
            "compose_cmd='docker compose'; "
            "if ! docker compose version >/dev/null 2>&1; then "
            "  if command -v docker-compose >/dev/null 2>&1; then compose_cmd='docker-compose'; "
            "  else echo __DOKSCP_COMPOSE_MISSING__; exit 20; fi; "
            "fi; "
            "$compose_cmd -f " + quotedComposeFile + " -p " + quotedProject + " config --services > .dokscp-compose-services; "
            "services=$(paste -sd, .dokscp-compose-services 2>/dev/null || true); "
            "echo __DOKSCP_COMPOSE_PROJECT__=" + composeProject + "; "
            "echo __DOKSCP_COMPOSE_FILE__=" + composeFile + "; "
            "echo __DOKSCP_COMPOSE_SERVICES__=$services; "
            "$compose_cmd -f " + quotedComposeFile + " -p " + quotedProject + " pull --ignore-pull-failures || true; "
            "$compose_cmd -f " + quotedComposeFile + " -p " + quotedProject + " up -d --build --remove-orphans; "
            "runtime=''; "
            "domain=$(sed -n 's/^DOKSCP_DOMAIN=//p' .env 2>/dev/null | tail -n1 | tr -d '\"' | tr -d \"'\" || true); "
            "if [ -n \"$domain\" ]; then runtime=\"https://$domain\"; fi; "
            "if [ -z \"$runtime\" ]; then "
            "  for svc in $(cat .dokscp-compose-services 2>/dev/null); do "
            "    for port in 80 443 3000 8080 8000 5000 5173; do "
            "      mapped=$($compose_cmd -f " + quotedComposeFile + " -p " + quotedProject + " port \"$svc\" \"$port\" 2>/dev/null | head -n1 | awk -F: 'NF {print $NF; exit}'); "
            "      if [ -n \"$mapped\" ]; then scheme='http'; [ \"$port\" = '443' ] && scheme='https'; runtime=\"$scheme://localhost:$mapped\"; break 2; fi; "
            "    done; "
            "  done; "
            "fi; "
            "echo __DOKSCP_COMPOSE_URL__=$runtime; "
            "$compose_cmd -f " + quotedComposeFile + " -p " + quotedProject + " ps";

        const int composeExit = runCommandCapture(
            composeCommand,
            logFile,
            true,
            std::max(buildTimeoutSeconds_, 120),
            onLogLine
        );

        result.logs = readFileBounded(logFile);
        result.composeProject = true;
        result.composeProjectName = composeProject;
        result.composeFile = composeFile;
        result.composeWorkdir = sourceDir.string();
        result.composeServices = markerValue(result.logs, "__DOKSCP_COMPOSE_SERVICES__");
        result.runtimeUrl = markerValue(result.logs, "__DOKSCP_COMPOSE_URL__");
        result.runtimeProvider = "local_compose";
        result.remoteContainerName = composeProject;
        result.imageName = "compose:" + composeProject;

        if (composeExit != 0) {
            result.error = result.logs.find("__DOKSCP_COMPOSE_MISSING__") != std::string::npos
                ? "Docker Compose is not available to the DOKSCP backend"
                : (composeExit == 124 ? "Docker Compose deploy timed out" : "Docker Compose deploy failed");
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

    const std::string imageName = "dokscp/" + sanitizeName(deploymentId) + ":" + sanitizeTag(version);
    const std::string buildCmd = "docker build --pull=false --memory \"" + dockerMemoryLimit_ +
                                 "\" -t \"" + imageName + "\" \"" + sourceDir.string() + "\"";

    {
        std::string buildMsg = "Building image: " + imageName;
        std::ofstream logOut(logFile, std::ios::app);
        logOut << "\n" << buildMsg << "\n";
        if (onLogLine) onLogLine(buildMsg);
    }

    const int buildExit = runCommandCapture(buildCmd, logFile, true, buildTimeoutSeconds_, onLogLine);

    result.imageName = imageName;
    result.logs = readFileBounded(logFile);

    if (buildExit != 0) {
        result.error = "docker build failed";
        appendLogLine(logFile,
                      "docker build failed with exit code " + std::to_string(buildExit),
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
        ("dokscp-tar-check-" + sanitizeName(archivePath.filename().string()) + "-" + std::to_string(std::rand()));
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
                                    LogCallback onLogLine) const {
    // We use popen to read the command output line by line
    // Redirect stderr to stdout so we catch everything
    std::string wrapped =
        "timeout " + std::to_string(timeoutSeconds) + "s sh -lc " +
        shellQuote(command + " 2>&1");
    
    FILE* pipe = popen(wrapped.c_str(), "r");
    if (!pipe) {
        return -1;
    }

    std::ofstream logFile(outputFile, append ? std::ios::app : std::ios::trunc);
    char buffer[4096];
    
    while (fgets(buffer, sizeof(buffer), pipe) != nullptr) {
        // Write to log file
        logFile << buffer << std::flush;
        
        // Notify callback for WebSocket broadcast
        if (onLogLine) {
            std::string line = buffer;
            // Remove trailing newline for the callback if present
            if (!line.empty() && line.back() == '\n') {
                line.pop_back();
            }
            if (!line.empty() && line.back() == '\r') {
                line.pop_back();
            }
            onLogLine(line);
        }
    }

    int rawExitCode = pclose(pipe);
    int exitCode = rawExitCode;
    if (WIFEXITED(rawExitCode)) {
        exitCode = WEXITSTATUS(rawExitCode);
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

    int fileCount = 0;
    int excerptCount = 0;
    std::error_code ec;
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
        if (fileCount < 220) {
            files.append(rel);
        }
        ++fileCount;

        if (excerptCount < 36 && shouldIncludeExcerpt(relative)) {
            excerpts[rel] = readFileBounded(entry.path(), 6000);
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
    if (!envFlag("DOKSCP_AI_DOCKERFILE_ENABLED", true)) {
        reason = "AI Dockerfile generation is disabled";
        return false;
    }

    Json::Value payload(Json::objectValue);
    payload["provider"] = std::getenv("DOKSCP_AI_PROVIDER") ? std::getenv("DOKSCP_AI_PROVIDER") : "nvidia_nim";
    payload["model_mode"] = "thinking";
    payload["workflow_type"] = "generate_dockerfile";
    payload["project"]["name"] = sourceDir.filename().string();
    payload["source"] = collectSourceContext(sourceDir);
    payload["message"] =
        "Read the actual project file tree and excerpts, choose the correct entrypoint, and generate a Dockerfile. "
        "If there are multiple Python files, infer the most likely runnable entrypoint from names, imports, and README/package context. "
        "Prefer a deterministic Dockerfile that runs the app or script without requiring manual edits. "
        "IMPORTANT: The platform will route traffic to port 3000. Your Dockerfile MUST EXPOSE port 3000 and ensure the app listens on port 3000. "
        "If using nginx, you MUST include a RUN command to change the default port, e.g., RUN sed -i 's/80/3000/g' /etc/nginx/conf.d/default.conf "
        "CRITICAL ARCHITECTURE RULE: NEVER copy files individually using multiple COPY commands (e.g., do not write 'COPY index.html ...'). "
        "You MUST copy the entire directory at once using 'COPY . /usr/share/nginx/html/' (for nginx) or 'COPY . /app/' (for Python/Node). "
        "This is strictly required to prevent Docker build crashes caused by spaces in individual filenames. "
        "CRITICAL SECURITY RULE: The platform runs all containers as a non-root user (UID 10001). "
        "If using nginx, you MUST grant non-root permissions by adding this exact command: "
        "RUN mkdir -p /var/cache/nginx/client_temp /var/cache/nginx/proxy_temp /var/cache/nginx/fastcgi_temp /var/cache/nginx/uwsgi_temp /var/cache/nginx/scgi_temp && chmod -R 777 /var/cache/nginx /var/run /var/log/nginx /etc/nginx";

    appendLogLine(logFile, "AI Dockerfile generation: scanning source tree and asking AI for a Dockerfile plan...", onLogLine);
    const auto aiResult = AiServiceClient::instance().postWorkflow("/generate/dockerfile", payload);
    if (!aiResult.ok) {
        reason = aiResult.error.empty() ? "AI Dockerfile generation failed" : aiResult.error;
        appendLogLine(logFile, "AI Dockerfile generation unavailable: " + reason, onLogLine);
        return false;
    }

    const Json::Value structured = aiResult.body.isMember("structured_output")
        ? aiResult.body["structured_output"]
        : Json::Value(Json::objectValue);
    const std::string dockerfile = structured.isMember("dockerfile") && structured["dockerfile"].isString()
        ? structured["dockerfile"].asString()
        : "";
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

bool BuildService::ensureDockerfile(const std::filesystem::path& sourceDir,
                                    const std::filesystem::path& logFile,
                                    std::string& reason,
                                    LogCallback onLogLine) const {
    const std::filesystem::path dockerfilePath = sourceDir / "Dockerfile";
    if (std::filesystem::exists(dockerfilePath)) {
        return true;
    }

    appendLogLine(logFile, "Using deterministic Dockerfile generator.", onLogLine);
    std::string generated;

    if (hasFile(sourceDir, "package.json")) {
        const bool nextApp = isNextJsApp(sourceDir);
        const bool hasBuildScript = hasPackageScript(sourceDir / "package.json", "build");

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
            "RUN if [ -f mvnw ]; then chmod +x mvnw && ./mvnw -DskipTests package; elif [ -f pom.xml ]; then apt-get update && apt-get install -y maven && mvn -DskipTests package; elif [ -f gradlew ]; then chmod +x gradlew && ./gradlew build -x test; else apt-get update && apt-get install -y gradle && gradle build -x test; fi\n"
            "FROM eclipse-temurin:21-jre\n"
            "WORKDIR /app\n"
            "COPY --from=build /src .\n"
            "ENV PORT=3000\n"
            "ENV SERVER_PORT=3000\n"
            "EXPOSE 3000\n"
            "CMD [\"/bin/sh\", \"-c\", \"jar=$(find . -path '*/target/*.jar' -o -path '*/build/libs/*.jar' | grep -v plain | head -n1); [ -n \\\"$jar\\\" ] || { echo 'No runnable jar found'; exit 1; }; exec java -jar \\\"$jar\\\"\"]\n";
    } else {
        appendLogLine(logFile, "Deterministic generator could not classify this source tree. Trying AI Dockerfile fallback.", onLogLine);
        if (tryGenerateDockerfileWithAi(sourceDir, logFile, reason, onLogLine)) {
            return true;
        }
        reason = reason.empty()
            ? "No Dockerfile found and project type could not be auto-detected"
            : "No deterministic Dockerfile generator matched this project, and AI fallback failed: " + reason;
        return false;
    }

    std::ofstream out(dockerfilePath, std::ios::trunc);
    if (!out.is_open()) {
        reason = "Failed to write generated Dockerfile";
        return false;
    }

    out << generated;
    return true;
}

} // namespace dokscp
