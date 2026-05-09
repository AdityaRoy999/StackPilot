// ============================================================
// KubernetesService.h - Kubernetes deployment engine
// ============================================================

#pragma once

#include <json/json.h>

#include <string>
#include <vector>

namespace dokscp {

struct KubernetesDeployOptions {
    std::string deploymentId;
    std::string projectName;
    std::string imageName;
    std::string nameSpace;
    std::string exposureMode;
    std::string runtimeScheme = "http";
    std::string resourcePreset = "small";
    std::string healthPath = "/";
    std::vector<std::pair<std::string, std::string>> envVars;
    int replicas = 1;
    int containerPort = 3000;
};

struct KubernetesRuntimeInfo {
    bool success = false;
    bool deployed = false;
    std::string status;
    std::string nameSpace;
    std::string deploymentName;
    std::string serviceName;
    std::string ingressName;
    std::string runtimeUrl;
    std::string runtimeScheme;
    std::string logs;
    std::string error;
    std::string ingressHost;
    std::string exposureMode;
    int desiredReplicas = 0;
    int readyReplicas = 0;
};

class KubernetesService {
public:
    KubernetesService();

    KubernetesRuntimeInfo deploy(const KubernetesDeployOptions& options) const;
    KubernetesRuntimeInfo scale(const std::string& nameSpace,
                                const std::string& deploymentName,
                                const std::string& serviceName,
                                const std::string& exposureMode,
                                int replicas,
                                const std::string& runtimeScheme = "") const;
    KubernetesRuntimeInfo rollback(const std::string& nameSpace,
                                   const std::string& deploymentName,
                                   const std::string& serviceName,
                                   const std::string& exposureMode,
                                   const std::string& runtimeScheme = "") const;
    KubernetesRuntimeInfo inspect(const std::string& nameSpace,
                                  const std::string& deploymentName,
                                  const std::string& serviceName,
                                  const std::string& exposureMode,
                                  const std::string& runtimeScheme = "") const;
    KubernetesRuntimeInfo remove(const std::string& nameSpace,
                                 const std::string& deploymentName,
                                 const std::string& serviceName,
                                 const std::string& exposureMode) const;
    std::string collectEvents(const std::string& nameSpace,
                              const std::string& deploymentName,
                              const std::string& ingressName,
                              const std::string& exposureMode) const;

private:
    std::string kubeconfigPath_;
    std::string defaultNamespace_;
    std::string serviceType_;
    std::string exposureMode_;
    std::string nodeHost_;
    std::string baseDomain_;
    std::string runtimeScheme_;
    std::string ingressClassName_;
    std::string ingressTlsSecretName_;
    std::string ingressAnnotationsJson_;
    std::string namespacePrefix_;
    std::string imagePullSecretName_;
    std::string serviceAccountName_;
    std::string cpuRequest_;
    std::string memoryRequest_;
    std::string cpuLimit_;
    std::string memoryLimit_;
    std::string probePath_;
    int maxReplicas_;
    int rolloutTimeoutSeconds_;
    int readinessInitialDelaySeconds_;
    int livenessInitialDelaySeconds_;
    int startupFailureThreshold_;
    bool enablePodDisruptionBudget_ = true;
    bool enableHorizontalPodAutoscaler_ = false;
    int hpaMinReplicas_ = 1;
    int hpaMaxReplicas_ = 3;
    int hpaCpuUtilizationTarget_ = 70;

    std::string kubectlPrefix() const;
    std::string shellQuote(const std::string& value) const;
    std::string sanitizeDnsLabel(const std::string& value) const;
    bool isValidDnsLabel(const std::string& value) const;
    std::string buildRuntimeUrl(const Json::Value& serviceJson,
                                const Json::Value& ingressJson,
                                const std::string& nameSpace,
                                const std::string& serviceName,
                                const std::string& ingressHost,
                                const std::string& exposureMode,
                                const std::string& runtimeScheme) const;
    std::string collectRuntimeDiagnostics(const std::string& nameSpace,
                                          const std::string& deploymentName,
                                          bool includeContainerLogs,
                                          const std::string& ingressName,
                                          const std::string& exposureMode) const;
    std::string deriveRuntimeStatus(const Json::Value& deploymentJson,
                                    int desiredReplicas,
                                    int readyReplicas) const;
    bool ingressModeEnabled() const;
    bool ingressClassExists(std::string& output) const;
    std::string normalizeExposureMode(const std::string& requestedExposureMode) const;
    bool exposureUsesIngress(const std::string& exposureMode) const;
    std::string serviceTypeForExposure(const std::string& exposureMode) const;

    int runCommand(const std::string& command, std::string& output) const;
    bool runJsonCommand(const std::string& command, Json::Value& output, std::string& rawOutput) const;
};

} // namespace dokscp
