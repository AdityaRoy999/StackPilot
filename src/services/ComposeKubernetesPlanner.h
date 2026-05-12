// ============================================================
// ComposeKubernetesPlanner.h - Docker Compose to Kubernetes plan
// ============================================================

#pragma once

#include <json/json.h>

#include <string>
#include <utility>
#include <vector>

namespace dokscp {

struct ComposeKubernetesPlanService {
    std::string serviceName;
    std::string deploymentName;
    std::string kubernetesServiceName;
    std::string imageName;
    std::string imagePlaceholder;
    bool localBuildImage = false;
    bool publicService = false;
    bool hasPublishedPort = false;
    int containerPort = 0;
};

struct ComposeKubernetesPlanOptions {
    std::string deploymentId;
    std::string projectName;
    std::string composeProjectName;
    std::string nameSpace;
    std::string exposureMode;
    std::string runtimeScheme = "http";
    std::string serviceType = "NodePort";
    std::string baseDomain;
    std::string hostForNip;
    std::string ingressClassName;
    std::string ingressTlsSecretName;
    std::string ingressAnnotationsJson;
    std::string imagePullSecretName;
    std::string serviceAccountName;
    std::string resourcePreset = "small";
    std::string cpuRequest = "100m";
    std::string memoryRequest = "128Mi";
    std::string cpuLimit = "500m";
    std::string memoryLimit = "512Mi";
    std::string healthPath = "/";
    std::vector<std::pair<std::string, std::string>> envVars;
    int replicas = 1;
    int defaultContainerPort = 3000;
    int maxReplicas = 10;
    bool enablePodDisruptionBudget = true;
    bool enableHorizontalPodAutoscaler = false;
    int hpaMinReplicas = 1;
    int hpaMaxReplicas = 3;
    int hpaCpuUtilizationTarget = 70;
    bool allowIngressWithoutBaseDomain = false;
    bool isolateNamespace = true;
    bool useImagePlaceholders = false;
};

struct ComposeKubernetesPlan {
    bool success = false;
    std::string error;
    std::string manifest;
    std::string stackName;
    std::string nameSpace;
    std::string exposureMode;
    std::string runtimeScheme;
    std::string primaryDeploymentName;
    std::string primaryServiceName;
    std::string ingressName;
    std::string ingressHost;
    std::string servicesCsv;
    int desiredReplicas = 0;
    std::vector<ComposeKubernetesPlanService> services;
    std::vector<std::string> warnings;
};

class ComposeKubernetesPlanner {
public:
    static ComposeKubernetesPlan build(const Json::Value& composeConfig,
                                       const ComposeKubernetesPlanOptions& options);
    static std::string sanitizeDnsLabel(const std::string& value, size_t maxLength = 50);
    static std::string joinWarnings(const std::vector<std::string>& warnings);
};

} // namespace dokscp
