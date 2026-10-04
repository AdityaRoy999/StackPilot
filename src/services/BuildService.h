// ============================================================
// BuildService.h — Repository clone + Docker image build
// ============================================================

#pragma once

#include <filesystem>
#include <json/value.h>
#include <string>
#include <functional>
#include <vector>
#include <mutex>
#include <unordered_map>
#include <unordered_set>
#include <sys/types.h>

namespace stackpilot {

struct SshConnectionConfig;
struct BuildEnvVar {
    std::string key;
    std::string value;
    bool secret = false;
};

struct MobileMetadata {
    std::string framework;
    std::string appName;
    std::string bundleId;
    std::string sdkVersion;
    std::string previewStrategy;
    std::string qrTargetUrl;
};

struct RepositoryArchetype {
    std::string type = "standard_web";       // "standard_web", "expo_react_native", "flutter_mobile", "native_ios", "native_android", "windows_desktop_exe", "desktop_compose_gui", "java_web", "library", "monorepo"
    std::string displayName = "Web Application";
    std::string suggestedStrategy = "standard"; // "expo_web_preview", "flutter_web_preview", "wine_novnc_web_stream", "desktop_novnc_web_stream", "android_apk_download_server", "monorepo_subservice", "unsupported_native"
    std::vector<std::string> subServices;
    std::string details;
    MobileMetadata mobileMetadata;
    bool requiresDiversion = false;
    bool isDeployable = true;
};

struct BuildResult {
    bool success = false;
    std::string logs;
    std::string imageName;
    std::string runtimeUrl;
    std::string runtimeProvider;
    std::string remoteContainerName;
    std::string error;
    bool composeProject = false;
    std::string composeProjectName;
    std::string composeFile;
    std::string composeWorkdir;
    std::string composeServices;
    std::string archetype;
    std::string archetypeDetails;
    std::vector<std::string> detectedSubServices;
    MobileMetadata mobileMetadata;
    Json::Value deploymentPlan;
    Json::Value testEvidence;
    std::string artifactDigest;
    std::string sourceDigest;
    std::string sourceArchive;
};

typedef std::function<void(const std::string&)> LogCallback;

class BuildService {
public:
    using CandidateObserver=std::function<void(const std::string&,const std::string&,const Json::Value&)>;
    void setCandidateObserver(CandidateObserver observer){candidateObserver_=std::move(observer);}
    static BuildService& getInstance();
    BuildService();

    bool cancelBuild(const std::string& deploymentId);
    bool isBuildCanceled(const std::string& deploymentId) const;

    RepositoryArchetype classifyRepositoryArchetype(const std::filesystem::path& sourceDir) const;

    BuildResult buildFromRepository(const std::string& deploymentId,
                                    const std::string& repoUrl,
                                    const std::string& version,
                                    const std::string& githubPat = "",
                                    const std::string& branch = "",
                                    const std::string& commitSha = "",
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
    BuildResult buildFromArtifact(const std::string& deploymentId,
                                  const std::string& artifactPath,
                                  const std::string& version,
                                  const std::vector<BuildEnvVar>& envVars = {},
                                  LogCallback onLogLine = nullptr) const;
    BuildResult buildFromGeneratedSource(const std::string& deploymentId,
                                         const std::string& generatedSourcePath,
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
                                                    const std::string& branch,
                                                    const std::string& commitSha,
                                                    const std::string& projectName,
                                                    int containerPort,
                                                    const std::vector<BuildEnvVar>& envVars = {},
                                                    LogCallback onLogLine = nullptr) const;
    BuildResult buildArtifactAndRunOnRemoteDocker(const std::string& deploymentId,
                                                  const SshConnectionConfig& sshConfig,
                                                  const std::string& artifactPath,
                                                  const std::string& remoteWorkspacePath,
                                                  const std::string& version,
                                                  const std::string& projectName,
                                                  int containerPort,
                                                  const std::vector<BuildEnvVar>& envVars = {},
                                                  LogCallback onLogLine = nullptr) const;
    BuildResult buildGeneratedSourceAndRunOnRemoteDocker(const std::string& deploymentId,
                                                         const SshConnectionConfig& sshConfig,
                                                         const std::string& generatedSourcePath,
                                                         const std::string& remoteWorkspacePath,
                                                         const std::string& version,
                                                         const std::string& projectName,
                                                         int containerPort,
                                                         const std::vector<BuildEnvVar>& envVars = {},
                                                         LogCallback onLogLine = nullptr) const;

    BuildResult buildFromPreparedSource(const std::string& deploymentId,
                                        const std::filesystem::path& sourceDir,
                                        const std::filesystem::path& logFile,
                                        const std::string& version,
                                        const std::vector<BuildEnvVar>& envVars = {},
                                        LogCallback onLogLine = nullptr) const;

    bool ensureDockerfile(const std::filesystem::path& sourceDir,
                          const std::filesystem::path& logFile,
                          std::string& reason,
                          LogCallback onLogLine = nullptr) const;

    std::filesystem::path sourceWorkspace(const std::string& deploymentId) const {
        return workspaceRoot_ / deploymentId / "source";
    }

private:
    CandidateObserver candidateObserver_;
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
    bool validateTarArchive(const std::filesystem::path& archivePath,
                            std::string& reason) const;

    int runCommandCapture(const std::string& command,
                          const std::filesystem::path& outputFile,
                          bool append,
                          int timeoutSeconds,
                          LogCallback onLogLine = nullptr,
                          const std::string& deploymentId = "") const;

    Json::Value collectSourceContext(const std::filesystem::path& sourceDir) const;
    bool tryGenerateDockerfileWithAi(const std::filesystem::path& sourceDir,
                                     const std::filesystem::path& logFile,
                                     std::string& reason,
                                     LogCallback onLogLine) const;

    static std::mutex buildPidsMutex_;
    static std::unordered_map<std::string, pid_t> activeBuildPids_;
    static std::unordered_set<std::string> canceledBuilds_;
};

} // namespace stackpilot
