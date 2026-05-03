// ============================================================
// BuildService.h — Repository clone + Docker image build
// ============================================================

#pragma once

#include <filesystem>
#include <json/value.h>
#include <string>
#include <functional>
#include <vector>

namespace aids {

struct SshConnectionConfig;
struct BuildEnvVar {
    std::string key;
    std::string value;
};

struct BuildResult {
    bool success = false;
    std::string logs;
    std::string imageName;
    std::string runtimeUrl;
    std::string runtimeProvider;
    std::string remoteContainerName;
    std::string error;
};

typedef std::function<void(const std::string&)> LogCallback;

class BuildService {
public:
    BuildService();

    BuildResult buildFromRepository(const std::string& deploymentId,
                                    const std::string& repoUrl,
                                    const std::string& version,
                                    const std::string& githubPat = "",
                                    const std::vector<BuildEnvVar>& envVars = {},
                                    LogCallback onLogLine = nullptr) const;
    BuildResult buildFromSshSource(const std::string& deploymentId,
                                   const SshConnectionConfig& sshConfig,
                                   const std::string& remotePath,
                                   const std::string& version,
                                   const std::vector<BuildEnvVar>& envVars = {},
                                   LogCallback onLogLine = nullptr) const;
    BuildResult buildFromLocalSource(const std::string& deploymentId,
                                     const std::string& localPath,
                                     const std::string& version,
                                     const std::vector<BuildEnvVar>& envVars = {},
                                     LogCallback onLogLine = nullptr) const;
    BuildResult buildAndRunOnRemoteDocker(const std::string& deploymentId,
                                          const SshConnectionConfig& sshConfig,
                                          const std::string& remotePath,
                                          const std::string& projectName,
                                          const std::string& version,
                                          int containerPort,
                                          const std::vector<BuildEnvVar>& envVars = {},
                                          LogCallback onLogLine = nullptr) const;
    BuildResult buildRepositoryAndRunOnRemoteDocker(const std::string& deploymentId,
                                                    const SshConnectionConfig& sshConfig,
                                                    const std::string& repoUrl,
                                                    const std::string& remoteWorkspacePath,
                                                    const std::string& version,
                                                    const std::string& githubPat,
                                                    const std::string& projectName,
                                                    int containerPort,
                                                    const std::vector<BuildEnvVar>& envVars = {},
                                                    LogCallback onLogLine = nullptr) const;

private:
    std::filesystem::path workspaceRoot_;
    int maxLogBytes_;
    int cloneTimeoutSeconds_;
    int buildTimeoutSeconds_;
    std::string dockerMemoryLimit_;

    bool isSupportedRepoUrl(const std::string& repoUrl) const;
    std::string sanitizeName(const std::string& raw) const;
    std::string sanitizeTag(const std::string& raw) const;
    std::string readFileBounded(const std::filesystem::path& filePath, int maxBytes = 0) const;
    bool isAllowedLocalSourcePath(const std::filesystem::path& localPath, std::string& reason) const;
    bool copyLocalSourceTree(const std::filesystem::path& source,
                             const std::filesystem::path& destination,
                             std::string& reason) const;

    int runCommandCapture(const std::string& command,
                          const std::filesystem::path& outputFile,
                          bool append,
                          int timeoutSeconds,
                          LogCallback onLogLine = nullptr) const;

    Json::Value collectSourceContext(const std::filesystem::path& sourceDir) const;
    bool tryGenerateDockerfileWithAi(const std::filesystem::path& sourceDir,
                                     const std::filesystem::path& logFile,
                                     std::string& reason,
                                     LogCallback onLogLine) const;
    bool ensureDockerfile(const std::filesystem::path& sourceDir,
                          const std::filesystem::path& logFile,
                          std::string& reason,
                          LogCallback onLogLine) const;
    BuildResult buildFromPreparedSource(const std::string& deploymentId,
                                        const std::filesystem::path& sourceDir,
                                        const std::filesystem::path& logFile,
                                        const std::string& version,
                                        const std::vector<BuildEnvVar>& envVars,
                                        LogCallback onLogLine) const;
};

} // namespace aids
