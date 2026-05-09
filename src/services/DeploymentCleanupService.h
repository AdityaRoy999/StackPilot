// ============================================================
// DeploymentCleanupService.h - shared runtime and artifact cleanup
// ============================================================

#pragma once

#include <json/json.h>
#include <string>

namespace dokscp {

struct DeploymentCleanupOptions {
    bool deleteDatabaseRow = false;
    bool deleteImage = false;
    bool deleteRemoteWorkspace = false;
};

struct DeploymentCleanupResult {
    bool success = false;
    std::string error;
    std::string logs;
    bool runtimeCleanupAttempted = false;
    bool imageCleanupAttempted = false;
    bool imageDeleted = false;
    bool remoteWorkspaceDeleted = false;
    std::string imageName;
    std::string runtimeProvider;
    Json::Value toJson() const;
};

class DeploymentCleanupService {
public:
    DeploymentCleanupResult cleanupDeployment(const std::string& userId,
                                              const std::string& deploymentId,
                                              const DeploymentCleanupOptions& options) const;
};

} // namespace dokscp

