// ============================================================
// KubernetesService.cpp - Kubernetes deployment engine
// ============================================================

#include "KubernetesService.h"

#include "ComposeKubernetesPlanner.h"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <sys/wait.h>

namespace dokscp {

namespace {

std::string getEnvOrDefault(const char* name, const std::string& fallback) {
    const char* value = std::getenv(name);
    return (value && *value) ? value : fallback;
}

bool isTruthy(const std::string& value) {
    std::string lowered;
    lowered.reserve(value.size());
    for (char c : value) {
        lowered.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(c))));
    }
    return lowered == "1" || lowered == "true" || lowered == "yes" || lowered == "on";
}

std::string normalizeRuntimeScheme(const std::string& value) {
    size_t start = 0;
    while (start < value.size() && std::isspace(static_cast<unsigned char>(value[start]))) {
        ++start;
    }
    size_t end = value.size();
    while (end > start && std::isspace(static_cast<unsigned char>(value[end - 1]))) {
        --end;
    }
    std::string normalized = value.substr(start, end - start);
    std::transform(normalized.begin(), normalized.end(), normalized.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
    });
    return normalized == "https" ? "https" : "http";
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

int getEnvIntOrDefault(const char* name, int fallback) {
    const char* value = std::getenv(name);
    if (!value || !*value) {
        return fallback;
    }

    try {
        return std::stoi(value);
    } catch (...) {
        return fallback;
    }
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

struct ResourcePreset {
    std::string cpuRequest;
    std::string memoryRequest;
    std::string cpuLimit;
    std::string memoryLimit;
};

ResourcePreset resourcePresetFor(const std::string& requested,
                                 const std::string& defaultCpuRequest,
                                 const std::string& defaultMemoryRequest,
                                 const std::string& defaultCpuLimit,
                                 const std::string& defaultMemoryLimit) {
    const std::string normalized = trim(requested);
    if (normalized == "medium") {
        return {"250m", "256Mi", "1000m", "1Gi"};
    }
    if (normalized == "large") {
        return {"500m", "512Mi", "2000m", "2Gi"};
    }
    if (normalized == "small") {
        return {"100m", "128Mi", "500m", "512Mi"};
    }
    return {defaultCpuRequest, defaultMemoryRequest, defaultCpuLimit, defaultMemoryLimit};
}

std::string sanitizeProbePath(std::string value) {
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

bool isValidEnvKey(const std::string& value) {
    if (value.empty() || value.size() > 253) {
        return false;
    }
    const auto isFirst = [](char c) {
        return std::isalpha(static_cast<unsigned char>(c)) || c == '_';
    };
    const auto isRest = [](char c) {
        return std::isalnum(static_cast<unsigned char>(c)) || c == '_';
    };
    if (!isFirst(value.front())) {
        return false;
    }
    for (char c : value) {
        if (!isRest(c)) {
            return false;
        }
    }
    return true;
}

void writeYamlBlockScalar(std::ostream& out, const std::string& key, const std::string& value) {
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

std::string replaceAll(std::string value, const std::string& needle, const std::string& replacement) {
    if (needle.empty()) {
        return value;
    }
    size_t pos = 0;
    while ((pos = value.find(needle, pos)) != std::string::npos) {
        value.replace(pos, needle.size(), replacement);
        pos += replacement.size();
    }
    return value;
}

} // namespace

KubernetesService::KubernetesService()
    : kubeconfigPath_(getEnvOrDefault("KUBECONFIG_PATH", "")),
      defaultNamespace_(getEnvOrDefault("K8S_NAMESPACE", "dokscp-apps")),
      serviceType_(getEnvOrDefault("K8S_SERVICE_TYPE", "NodePort")),
      exposureMode_(getEnvOrDefault("K8S_EXPOSURE_MODE", "")),
      nodeHost_(getEnvOrDefault("K8S_NODE_HOST", "localhost")),
      baseDomain_(getEnvOrDefault("K8S_BASE_DOMAIN", "")),
      runtimeScheme_(getEnvOrDefault("K8S_RUNTIME_SCHEME", "http")),
      ingressClassName_(getEnvOrDefault("K8S_INGRESS_CLASS", "")),
      ingressTlsSecretName_(getEnvOrDefault("K8S_INGRESS_TLS_SECRET", "")),
      ingressAnnotationsJson_(getEnvOrDefault("K8S_INGRESS_ANNOTATIONS_JSON", "")),
      namespacePrefix_(getEnvOrDefault("K8S_NAMESPACE_PREFIX", "")),
      imagePullSecretName_(getEnvOrDefault("K8S_IMAGE_PULL_SECRET", "")),
      serviceAccountName_(getEnvOrDefault("K8S_SERVICE_ACCOUNT_NAME", "")),
      cpuRequest_(getEnvOrDefault("K8S_CPU_REQUEST", "100m")),
      memoryRequest_(getEnvOrDefault("K8S_MEMORY_REQUEST", "128Mi")),
      cpuLimit_(getEnvOrDefault("K8S_CPU_LIMIT", "500m")),
      memoryLimit_(getEnvOrDefault("K8S_MEMORY_LIMIT", "512Mi")),
      probePath_(getEnvOrDefault("K8S_PROBE_PATH", "/")),
      maxReplicas_(std::max(1, getEnvIntOrDefault("K8S_MAX_REPLICAS", 10))),
      rolloutTimeoutSeconds_(std::max(30, getEnvIntOrDefault("K8S_ROLLOUT_TIMEOUT_SECONDS", 180))),
      readinessInitialDelaySeconds_(std::max(1, getEnvIntOrDefault("K8S_READINESS_INITIAL_DELAY_SECONDS", 5))),
      livenessInitialDelaySeconds_(std::max(1, getEnvIntOrDefault("K8S_LIVENESS_INITIAL_DELAY_SECONDS", 15))),
      startupFailureThreshold_(std::max(3, getEnvIntOrDefault("K8S_STARTUP_FAILURE_THRESHOLD", 30))),
      enablePodDisruptionBudget_(isTruthy(getEnvOrDefault("K8S_ENABLE_PDB", "true"))),
      enableHorizontalPodAutoscaler_(isTruthy(getEnvOrDefault("K8S_ENABLE_HPA", "false"))),
      hpaMinReplicas_(std::max(1, getEnvIntOrDefault("K8S_HPA_MIN_REPLICAS", 1))),
      hpaMaxReplicas_(std::max(1, getEnvIntOrDefault("K8S_HPA_MAX_REPLICAS", 3))),
      hpaCpuUtilizationTarget_(std::max(1, getEnvIntOrDefault("K8S_HPA_CPU_UTILIZATION", 70))) {
    if (serviceType_ != "NodePort" && serviceType_ != "ClusterIP" && serviceType_ != "LoadBalancer") {
        serviceType_ = "NodePort";
    }

    if (runtimeScheme_ != "http" && runtimeScheme_ != "https") {
        runtimeScheme_ = "http";
    }

    std::transform(serviceType_.begin(), serviceType_.end(), serviceType_.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
    });
    if (serviceType_ == "nodeport") {
        serviceType_ = "NodePort";
    } else if (serviceType_ == "clusterip") {
        serviceType_ = "ClusterIP";
    } else if (serviceType_ == "loadbalancer") {
        serviceType_ = "LoadBalancer";
    } else {
        serviceType_ = "NodePort";
    }

    std::transform(exposureMode_.begin(), exposureMode_.end(), exposureMode_.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
    });
    if (exposureMode_.empty()) {
        exposureMode_ = baseDomain_.empty() ? "service" : "ingress";
    }
    if (exposureMode_ != "ingress" &&
        exposureMode_ != "nodeport" &&
        exposureMode_ != "loadbalancer" &&
        exposureMode_ != "clusterip" &&
        exposureMode_ != "service") {
        exposureMode_ = baseDomain_.empty() ? "service" : "ingress";
    }
    if (hpaMaxReplicas_ < hpaMinReplicas_) {
        hpaMaxReplicas_ = hpaMinReplicas_;
    }
}

KubernetesRuntimeInfo KubernetesService::deploy(const KubernetesDeployOptions& options) const {
    KubernetesRuntimeInfo result;
    result.nameSpace = options.nameSpace.empty() ? defaultNamespace_ : options.nameSpace;
    result.exposureMode = normalizeExposureMode(options.exposureMode);
    result.runtimeScheme = normalizeRuntimeScheme(options.runtimeScheme.empty() ? runtimeScheme_ : options.runtimeScheme);
    result.desiredReplicas = std::max(1, options.replicas);
    if (enableHorizontalPodAutoscaler_) {
        result.desiredReplicas = std::max(result.desiredReplicas, hpaMinReplicas_);
    }
    if (result.desiredReplicas > maxReplicas_) {
        result.error = "Replica count exceeds configured platform maximum";
        return result;
    }
    if (enableHorizontalPodAutoscaler_ && result.desiredReplicas > hpaMaxReplicas_) {
        result.error = "Replica count exceeds configured autoscaling maximum";
        return result;
    }

    if (!isValidDnsLabel(result.nameSpace)) {
        result.error = "Namespace must be a lowercase DNS label";
        return result;
    }
    if (!namespacePrefix_.empty() && result.nameSpace.rfind(namespacePrefix_, 0) != 0) {
        result.error = "Namespace must use the configured platform prefix";
        return result;
    }

    if (options.containerPort < 1 || options.containerPort > 65535) {
        result.error = "Container port must be between 1 and 65535";
        return result;
    }

    const std::string baseName = sanitizeDnsLabel(options.projectName + "-" + options.deploymentId.substr(0, std::min<size_t>(8, options.deploymentId.size())));
    result.deploymentName = baseName;
    result.serviceName = sanitizeDnsLabel(baseName + "-svc");
    result.ingressName = sanitizeDnsLabel(baseName + "-ing");

    std::ostringstream logs;
    logs << "[runtime] Preparing Kubernetes deployment\n";
    logs << "[runtime] Namespace: " << result.nameSpace << "\n";
    logs << "[runtime] Deployment: " << result.deploymentName << "\n";
    logs << "[runtime] Service: " << result.serviceName << "\n";
    logs << "[runtime] Exposure mode: " << result.exposureMode << "\n";
    logs << "[runtime] Runtime scheme: " << result.runtimeScheme << "\n";
    logs << "[runtime] Image: " << options.imageName << "\n";
    logs << "[runtime] Initial replicas: " << result.desiredReplicas << "\n";

    if (result.runtimeScheme == "https" && !exposureUsesIngress(result.exposureMode)) {
        result.error = "HTTPS runtime URLs require Ingress exposure so TLS can terminate at the ingress controller";
        result.logs = logs.str();
        return result;
    }

    if (exposureUsesIngress(result.exposureMode)) {
        if (baseDomain_.empty()) {
            result.error = "Ingress mode requires K8S_BASE_DOMAIN to be configured";
            return result;
        }
        if (result.runtimeScheme == "https" && ingressTlsSecretName_.empty()) {
            const bool certManagerConfigured =
                ingressAnnotationsJson_.find("cert-manager.io/cluster-issuer") != std::string::npos ||
                ingressAnnotationsJson_.find("cert-manager.io/issuer") != std::string::npos;
            if (!certManagerConfigured) {
                logs << "[runtime] WARNING: HTTPS requested but no K8S_INGRESS_TLS_SECRET or cert-manager annotations found. Falling back to HTTP.\n";
                result.runtimeScheme = "http";
            }
        }
        if (!ingressClassName_.empty()) {
            std::string ingressClassOutput;
            if (!ingressClassExists(ingressClassOutput)) {
                result.error = "Configured ingress class is not available in the cluster";
                result.logs = logs.str() + ingressClassOutput;
                return result;
            }
        }
    }

    std::string commandOutput;
    const std::string ensureNamespaceCommand =
        kubectlPrefix() + " get namespace " + shellQuote(result.nameSpace) + " >/dev/null 2>&1 || " +
        kubectlPrefix() + " create namespace " + shellQuote(result.nameSpace);
    if (runCommand(ensureNamespaceCommand, commandOutput) != 0) {
        result.error = "Failed to ensure Kubernetes namespace";
        result.logs = logs.str() + commandOutput;
        return result;
    }

    const std::filesystem::path manifestPath =
        std::filesystem::temp_directory_path() / ("dokscp-k8s-" + options.deploymentId + ".yaml");
    const auto deployStamp = std::chrono::duration_cast<std::chrono::nanoseconds>(
        std::chrono::system_clock::now().time_since_epoch()
    ).count();
    const bool useIngress = exposureUsesIngress(result.exposureMode);
    const std::string effectiveServiceType = serviceTypeForExposure(result.exposureMode);
    const std::string ingressHost = useIngress
        ? sanitizeDnsLabel(result.deploymentName) + "." + baseDomain_
        : "";
    result.ingressHost = ingressHost;
    const ResourcePreset resources = resourcePresetFor(
        options.resourcePreset,
        cpuRequest_,
        memoryRequest_,
        cpuLimit_,
        memoryLimit_
    );
    const std::string healthPath = sanitizeProbePath(options.healthPath.empty() ? probePath_ : options.healthPath);
    const std::string secretName = sanitizeDnsLabel(result.deploymentName + "-env");
    std::vector<std::pair<std::string, std::string>> envVars;
    envVars.reserve(options.envVars.size());
    for (const auto& envVar : options.envVars) {
        if (isValidEnvKey(envVar.first)) {
            envVars.push_back(envVar);
        }
    }
    logs << "[runtime] Resource preset: " << (options.resourcePreset.empty() ? "platform-default" : options.resourcePreset) << "\n";
    logs << "[runtime] Health path: " << healthPath << "\n";
    logs << "[runtime] Environment variables: " << envVars.size() << " secret-backed\n";

    {
        std::ofstream manifest(manifestPath, std::ios::trunc);
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
                writeYamlBlockScalar(manifest, envVar.first, envVar.second);
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
            << "  progressDeadlineSeconds: " << rolloutTimeoutSeconds_ << "\n"
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
            << "      annotations:\n"
            << "        dokscp.io/deployed-at: \"" << deployStamp << "\"\n"
            << "    spec:\n"
            << (!serviceAccountName_.empty() ? "      serviceAccountName: " + serviceAccountName_ + "\n" : "")
            << "      securityContext:\n"
            << "        runAsNonRoot: true\n"
            << "        runAsUser: 10001\n"
            << "        runAsGroup: 10001\n"
            << "        fsGroup: 10001\n"
            << "        seccompProfile:\n"
            << "          type: RuntimeDefault\n"
            << "      terminationGracePeriodSeconds: 30\n"
            << (!imagePullSecretName_.empty()
                    ? "      imagePullSecrets:\n        - name: " + imagePullSecretName_ + "\n"
                    : "")
            << "      containers:\n"
            << "        - name: app\n"
            << "          image: " << options.imageName << "\n"
            << "          imagePullPolicy: IfNotPresent\n"
            << "          ports:\n"
            << "            - containerPort: " << std::max(1, options.containerPort) << "\n"
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
            << "              port: " << std::max(1, options.containerPort) << "\n"
            << "            initialDelaySeconds: " << readinessInitialDelaySeconds_ << "\n"
            << "            periodSeconds: 10\n"
            << "            timeoutSeconds: 3\n"
            << "            failureThreshold: 3\n"
            << "          livenessProbe:\n"
            << "            httpGet:\n"
            << "              path: " << healthPath << "\n"
            << "              port: " << std::max(1, options.containerPort) << "\n"
            << "            initialDelaySeconds: " << livenessInitialDelaySeconds_ << "\n"
            << "            periodSeconds: 20\n"
            << "            timeoutSeconds: 3\n"
            << "            failureThreshold: 3\n"
            << "          startupProbe:\n"
            << "            httpGet:\n"
            << "              path: " << healthPath << "\n"
            << "              port: " << std::max(1, options.containerPort) << "\n"
            << "            periodSeconds: 5\n"
            << "            timeoutSeconds: 3\n"
            << "            failureThreshold: " << startupFailureThreshold_ << "\n"
            << "---\n"
            << "apiVersion: v1\n"
            << "kind: Service\n"
            << "metadata:\n"
            << "  name: " << result.serviceName << "\n"
            << "  namespace: " << result.nameSpace << "\n"
            << "spec:\n"
            << "  selector:\n"
            << "    app: " << result.deploymentName << "\n"
            << "  type: " << effectiveServiceType << "\n"
            << "  ports:\n"
            << "    - protocol: TCP\n"
            << "      port: " << std::max(1, options.containerPort) << "\n"
            << "      targetPort: " << std::max(1, options.containerPort) << "\n";

        if (enablePodDisruptionBudget_ && result.desiredReplicas > 1) {
            manifest
                << "---\n"
                << "apiVersion: policy/v1\n"
                << "kind: PodDisruptionBudget\n"
                << "metadata:\n"
                << "  name: " << sanitizeDnsLabel(result.deploymentName + "-pdb") << "\n"
                << "  namespace: " << result.nameSpace << "\n"
                << "spec:\n"
                << "  minAvailable: 1\n"
                << "  selector:\n"
                << "    matchLabels:\n"
                << "      app: " << result.deploymentName << "\n";
        }

        if (enableHorizontalPodAutoscaler_) {
            manifest
                << "---\n"
                << "apiVersion: autoscaling/v2\n"
                << "kind: HorizontalPodAutoscaler\n"
                << "metadata:\n"
                << "  name: " << sanitizeDnsLabel(result.deploymentName + "-hpa") << "\n"
                << "  namespace: " << result.nameSpace << "\n"
                << "spec:\n"
                << "  scaleTargetRef:\n"
                << "    apiVersion: apps/v1\n"
                << "    kind: Deployment\n"
                << "    name: " << result.deploymentName << "\n"
                << "  minReplicas: " << hpaMinReplicas_ << "\n"
                << "  maxReplicas: " << hpaMaxReplicas_ << "\n"
                << "  metrics:\n"
                << "    - type: Resource\n"
                << "      resource:\n"
                << "        name: cpu\n"
                << "        target:\n"
                << "          type: Utilization\n"
                << "          averageUtilization: " << hpaCpuUtilizationTarget_ << "\n";
        }

        if (useIngress) {
            Json::Value annotationConfig;
            if (!ingressAnnotationsJson_.empty()) {
                Json::CharReaderBuilder builder;
                std::string errors;
                std::istringstream annotationStream(ingressAnnotationsJson_);
                Json::parseFromStream(builder, annotationStream, &annotationConfig, &errors);
            }
            manifest
                << "---\n"
                << "apiVersion: networking.k8s.io/v1\n"
                << "kind: Ingress\n"
                << "metadata:\n"
                << "  name: " << result.ingressName << "\n"
                << "  namespace: " << result.nameSpace << "\n";
            const bool useTls = result.runtimeScheme == "https";
            const std::string clusterIssuer = getEnvOrDefault("K8S_CERT_CLUSTER_ISSUER", "");
            if ((annotationConfig.isObject() && !annotationConfig.empty()) || !ingressClassName_.empty() ||
                (useTls && !clusterIssuer.empty())) {
                manifest << "  annotations:\n";
                if (!ingressClassName_.empty()) {
                    manifest << "    kubernetes.io/ingress.class: " << ingressClassName_ << "\n";
                }
                if (useTls && !clusterIssuer.empty()) {
                    manifest << "    cert-manager.io/cluster-issuer: \"" << clusterIssuer << "\"\n";
                }
                if (annotationConfig.isObject()) {
                    for (const auto& key : annotationConfig.getMemberNames()) {
                        manifest << "    " << key << ": \"" << annotationConfig[key].asString() << "\"\n";
                    }
                }
            }
            manifest
                << "spec:\n"
                << (!ingressClassName_.empty() ? "  ingressClassName: " + ingressClassName_ + "\n" : "")
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
                << "                  number: " << std::max(1, options.containerPort) << "\n";
            if (useTls || !ingressTlsSecretName_.empty()) {
                const std::string tlsSecretName = !ingressTlsSecretName_.empty()
                    ? ingressTlsSecretName_
                    : sanitizeDnsLabel(result.ingressName + "-tls");
                manifest
                    << "  tls:\n"
                    << "    - hosts:\n"
                    << "        - " << ingressHost << "\n"
                    << "      secretName: " << tlsSecretName << "\n";
            }
        }
    }

    commandOutput.clear();
    if (runCommand(kubectlPrefix() + " apply -f " + shellQuote(manifestPath.string()), commandOutput) != 0) {
        result.error = "Failed to apply Kubernetes manifests";
        result.logs = logs.str() + commandOutput;
        std::error_code ignore;
        std::filesystem::remove(manifestPath, ignore);
        return result;
    }
    logs << commandOutput;

    commandOutput.clear();
    if (runCommand(
            kubectlPrefix() + " rollout status deployment/" + shellQuote(result.deploymentName) +
                " -n " + shellQuote(result.nameSpace) +
                " --timeout=" + std::to_string(rolloutTimeoutSeconds_) + "s",
            commandOutput
        ) != 0) {
        result.error = "Kubernetes rollout failed";
        result.logs = logs.str() + commandOutput;
        std::error_code ignore;
        std::filesystem::remove(manifestPath, ignore);
        return result;
    }
    logs << commandOutput;

    std::error_code ignore;
    std::filesystem::remove(manifestPath, ignore);

    KubernetesRuntimeInfo inspected = inspect(result.nameSpace, result.deploymentName, result.serviceName, result.exposureMode, result.runtimeScheme);
    inspected.ingressHost = ingressHost;
    inspected.ingressName = result.ingressName;
    inspected.exposureMode = result.exposureMode;
    inspected.runtimeScheme = result.runtimeScheme;
    inspected.logs = logs.str() + inspected.logs;
    if (!inspected.success) {
        return inspected;
    }

    inspected.deployed = true;
    inspected.success = true;
    return inspected;
}

KubernetesRuntimeInfo KubernetesService::deployComposeStack(const KubernetesDeployOptions& options,
                                                            const std::string& composeWorkdir,
                                                            const std::string& composeFile,
                                                            const std::string& composeProjectName,
                                                            const std::string& composeServicesCsv) const {
    KubernetesRuntimeInfo result;
    result.nameSpace = options.nameSpace.empty() ? defaultNamespace_ : options.nameSpace;
    result.exposureMode = normalizeExposureMode(options.exposureMode);
    result.runtimeScheme = normalizeRuntimeScheme(options.runtimeScheme.empty() ? runtimeScheme_ : options.runtimeScheme);
    result.desiredReplicas = std::max(1, options.replicas);
    if (result.desiredReplicas > maxReplicas_) {
        result.error = "Replica count exceeds configured platform maximum";
        return result;
    }
    if (!isValidDnsLabel(result.nameSpace)) {
        result.error = "Namespace must be a lowercase DNS label";
        return result;
    }
    if (!namespacePrefix_.empty() && result.nameSpace.rfind(namespacePrefix_, 0) != 0) {
        result.error = "Namespace must use the configured platform prefix";
        return result;
    }
    if (composeWorkdir.empty() || composeFile.empty() || composeProjectName.empty()) {
        result.error = "Compose Kubernetes deployment is missing build metadata";
        return result;
    }

    std::ostringstream logs;
    logs << "[compose-k8s] Preparing Docker Compose Kubernetes stack\n";
    logs << "[compose-k8s] Namespace: " << result.nameSpace << "\n";
    logs << "[compose-k8s] Compose project: " << composeProjectName << "\n";
    logs << "[compose-k8s] Compose file: " << composeFile << "\n";
    if (!composeServicesCsv.empty()) {
        logs << "[compose-k8s] Compose services: " << composeServicesCsv << "\n";
    }

    if (result.runtimeScheme == "https" && !exposureUsesIngress(result.exposureMode)) {
        result.error = "HTTPS runtime URLs require Ingress exposure so TLS can terminate at the ingress controller";
        result.logs = logs.str();
        return result;
    }

    if (exposureUsesIngress(result.exposureMode) && !ingressClassName_.empty()) {
        std::string ingressClassOutput;
        if (!ingressClassExists(ingressClassOutput)) {
            result.error = "Configured ingress class is not available in the cluster";
            result.logs = logs.str() + ingressClassOutput;
            return result;
        }
    }

    std::string output;
    const std::string configCommand =
        "timeout 120s sh -lc " + shellQuote(
            "cd " + shellQuote(composeWorkdir) + " && "
            "compose_cmd='docker compose'; "
            "if ! docker compose version >/dev/null 2>&1; then "
            "  if command -v docker-compose >/dev/null 2>&1; then compose_cmd='docker-compose'; "
            "  else echo __DOKSCP_COMPOSE_MISSING__; exit 20; fi; "
            "fi; "
            "$compose_cmd -f " + shellQuote(composeFile) +
            " -p " + shellQuote(composeProjectName) +
            " config --format json 2>/dev/null"
        );
    if (runCommand(configCommand, output) != 0) {
        result.error = output.find("__DOKSCP_COMPOSE_MISSING__") != std::string::npos
            ? "Docker Compose is not available to the DOKSCP backend"
            : "Failed to read Docker Compose config for Kubernetes conversion";
        result.logs = logs.str() + output;
        return result;
    }

    Json::Value composeConfig;
    Json::CharReaderBuilder builder;
    builder["collectComments"] = false;
    std::string parseErrors;
    std::istringstream composeStream(output);
    if (!Json::parseFromStream(builder, composeStream, &composeConfig, &parseErrors)) {
        result.error = "Docker Compose config output could not be parsed";
        result.logs = logs.str() + parseErrors + "\n" + output;
        return result;
    }

    ComposeKubernetesPlanOptions planOptions;
    planOptions.deploymentId = options.deploymentId;
    planOptions.projectName = options.projectName;
    planOptions.composeProjectName = composeProjectName;
    planOptions.nameSpace = result.nameSpace;
    planOptions.exposureMode = result.exposureMode;
    planOptions.runtimeScheme = result.runtimeScheme;
    planOptions.serviceType = serviceType_;
    planOptions.baseDomain = baseDomain_;
    planOptions.ingressClassName = ingressClassName_;
    planOptions.ingressTlsSecretName = ingressTlsSecretName_;
    planOptions.ingressAnnotationsJson = ingressAnnotationsJson_;
    planOptions.imagePullSecretName = imagePullSecretName_;
    planOptions.serviceAccountName = serviceAccountName_;
    planOptions.resourcePreset = options.resourcePreset;
    planOptions.cpuRequest = cpuRequest_;
    planOptions.memoryRequest = memoryRequest_;
    planOptions.cpuLimit = cpuLimit_;
    planOptions.memoryLimit = memoryLimit_;
    planOptions.healthPath = options.healthPath.empty() ? probePath_ : options.healthPath;
    planOptions.envVars = options.envVars;
    planOptions.replicas = result.desiredReplicas;
    planOptions.defaultContainerPort = options.containerPort;
    planOptions.maxReplicas = maxReplicas_;
    planOptions.enablePodDisruptionBudget = enablePodDisruptionBudget_;
    planOptions.enableHorizontalPodAutoscaler = enableHorizontalPodAutoscaler_;
    planOptions.hpaMinReplicas = hpaMinReplicas_;
    planOptions.hpaMaxReplicas = hpaMaxReplicas_;
    planOptions.hpaCpuUtilizationTarget = hpaCpuUtilizationTarget_;
    planOptions.useImagePlaceholders = true;

    const ComposeKubernetesPlan plan = ComposeKubernetesPlanner::build(composeConfig, planOptions);
    if (!plan.success) {
        result.error = plan.error.empty() ? "Docker Compose Kubernetes conversion failed" : plan.error;
        result.logs = logs.str() + ComposeKubernetesPlanner::joinWarnings(plan.warnings);
        return result;
    }
    logs << ComposeKubernetesPlanner::joinWarnings(plan.warnings);
    logs << "[compose-k8s] Primary service: " << plan.primaryServiceName << "\n";
    logs << "[compose-k8s] Exposure mode: " << plan.exposureMode << "\n";

    std::string manifestText = plan.manifest;
    for (const auto& service : plan.services) {
        output.clear();
        if (runCommand("docker image inspect " + shellQuote(service.imageName) + " >/dev/null", output) != 0) {
            result.error = "Compose-built image is missing before Kubernetes deploy: " + service.imageName;
            result.logs = logs.str() + output;
            return result;
        }

        bool imageLoaded = false;
        const std::vector<std::string> loadCommands = {
            "timeout 180s sh -lc " + shellQuote("kind load docker-image " + shellQuote(service.imageName) + " >/dev/null 2>&1"),
            "timeout 180s sh -lc " + shellQuote("minikube image load " + shellQuote(service.imageName) + " >/dev/null 2>&1"),
            "timeout 180s sh -lc " + shellQuote(
                "docker save " + shellQuote(service.imageName) +
                " | docker run --rm -i --privileged --pid=host justincormack/nsenter1 ctr -n k8s.io images import - >/dev/null 2>&1"
            )
        };
        for (const auto& loadCommand : loadCommands) {
            output.clear();
            if (runCommand(loadCommand, output) == 0) {
                imageLoaded = true;
                break;
            }
        }
        if (imageLoaded) {
            logs << "[compose-k8s] Loaded image into Kubernetes runtime: " << service.imageName << "\n";
        } else {
            logs << "[compose-k8s] WARNING: Could not proactively load image into the Kubernetes runtime; rollout may rely on a pullable image: " << service.imageName << "\n";
        }
        manifestText = replaceAll(manifestText, service.imagePlaceholder, service.imageName);
    }

    const std::string ensureNamespaceCommand =
        kubectlPrefix() + " get namespace " + shellQuote(plan.nameSpace) + " >/dev/null 2>&1 || " +
        kubectlPrefix() + " create namespace " + shellQuote(plan.nameSpace);
    output.clear();
    if (runCommand(ensureNamespaceCommand, output) != 0) {
        result.error = "Failed to ensure Kubernetes namespace";
        result.logs = logs.str() + output;
        return result;
    }
    logs << output;

    const std::string downCommand =
        "timeout 120s sh -lc " + shellQuote(
            "cd " + shellQuote(composeWorkdir) + " && "
            "compose_cmd='docker compose'; "
            "if ! docker compose version >/dev/null 2>&1; then compose_cmd='docker-compose'; fi; "
            "$compose_cmd -f " + shellQuote(composeFile) +
            " -p " + shellQuote(composeProjectName) +
            " down --remove-orphans || true"
        );
    output.clear();
    runCommand(downCommand, output);
    if (!output.empty()) {
        logs << output;
    }

    const std::filesystem::path manifestPath =
        std::filesystem::temp_directory_path() / ("dokscp-compose-k8s-" + options.deploymentId + ".yaml");
    {
        std::ofstream manifest(manifestPath, std::ios::trunc);
        manifest << manifestText;
    }

    output.clear();
    if (runCommand(kubectlPrefix() + " apply -f " + shellQuote(manifestPath.string()), output) != 0) {
        result.error = "Failed to apply Compose Kubernetes manifests";
        result.logs = logs.str() + output;
        std::error_code ignore;
        std::filesystem::remove(manifestPath, ignore);
        return result;
    }
    logs << output;

    for (const auto& service : plan.services) {
        output.clear();
        if (runCommand(
                kubectlPrefix() + " rollout status deployment/" + shellQuote(service.deploymentName) +
                    " -n " + shellQuote(plan.nameSpace) +
                    " --timeout=" + std::to_string(rolloutTimeoutSeconds_) + "s",
                output
            ) != 0) {
            result.error = "Compose Kubernetes rollout failed for service " + service.serviceName;
            result.logs = logs.str() + output;
            std::error_code ignore;
            std::filesystem::remove(manifestPath, ignore);
            return result;
        }
        logs << output;
    }

    std::error_code ignore;
    std::filesystem::remove(manifestPath, ignore);

    KubernetesRuntimeInfo inspected = inspect(plan.nameSpace, plan.primaryDeploymentName, plan.primaryServiceName, plan.exposureMode, plan.runtimeScheme);
    inspected.ingressHost = plan.ingressHost;
    inspected.ingressName = plan.ingressName;
    inspected.exposureMode = plan.exposureMode;
    inspected.runtimeScheme = plan.runtimeScheme;
    if (plan.exposureMode == "ingress" && !plan.ingressHost.empty()) {
        inspected.runtimeUrl = plan.runtimeScheme + "://" + plan.ingressHost;
    }
    inspected.logs = logs.str() + inspected.logs;
    if (!inspected.success) {
        return inspected;
    }

    inspected.deployed = true;
    inspected.success = true;
    return inspected;
}

KubernetesRuntimeInfo KubernetesService::scale(const std::string& nameSpace,
                                               const std::string& deploymentName,
                                               const std::string& serviceName,
                                               const std::string& exposureMode,
                                               int replicas,
                                               const std::string& runtimeScheme) const {
    KubernetesRuntimeInfo result;
    result.nameSpace = nameSpace.empty() ? defaultNamespace_ : nameSpace;
    result.deploymentName = deploymentName;
    result.serviceName = serviceName;
    result.ingressName = sanitizeDnsLabel(deploymentName + "-ing");
    result.exposureMode = normalizeExposureMode(exposureMode);
    result.desiredReplicas = std::max(0, replicas);
    if (result.desiredReplicas > maxReplicas_) {
        result.error = "Replica count exceeds configured platform maximum";
        return result;
    }

    std::ostringstream logs;
    logs << "[runtime] Scaling deployment " << deploymentName << " to " << result.desiredReplicas << " replicas\n";

    std::string output;
    if (runCommand(
            kubectlPrefix() + " scale deployment " + shellQuote(deploymentName) +
                " -n " + shellQuote(result.nameSpace) +
                " --replicas=" + std::to_string(result.desiredReplicas),
            output
        ) != 0) {
        result.error = "Failed to scale Kubernetes deployment";
        result.logs = logs.str() + output;
        return result;
    }
    logs << output;

    if (result.desiredReplicas > 0) {
        output.clear();
        if (runCommand(
                kubectlPrefix() + " rollout status deployment/" + shellQuote(deploymentName) +
                    " -n " + shellQuote(result.nameSpace) +
                    " --timeout=" + std::to_string(rolloutTimeoutSeconds_) + "s",
                output
            ) != 0) {
            result.error = "Scaled deployment did not become ready";
            result.logs = logs.str() + output;
            return result;
        }
        logs << output;
    }

    KubernetesRuntimeInfo inspected = inspect(result.nameSpace, deploymentName, serviceName, result.exposureMode, runtimeScheme);
    inspected.logs = logs.str() + inspected.logs;
    return inspected;
}

KubernetesRuntimeInfo KubernetesService::rollback(const std::string& nameSpace,
                                                  const std::string& deploymentName,
                                                  const std::string& serviceName,
                                                  const std::string& exposureMode,
                                                  const std::string& runtimeScheme) const {
    KubernetesRuntimeInfo result;
    result.nameSpace = nameSpace.empty() ? defaultNamespace_ : nameSpace;
    result.deploymentName = deploymentName;
    result.serviceName = serviceName;
    result.ingressName = sanitizeDnsLabel(deploymentName + "-ing");
    result.exposureMode = normalizeExposureMode(exposureMode);

    std::ostringstream logs;
    logs << "[kubernetes] Rolling back deployment " << deploymentName << "\n";

    std::string output;
    if (runCommand(
            kubectlPrefix() + " rollout history deployment/" + shellQuote(deploymentName) +
                " -n " + shellQuote(result.nameSpace),
            output
        ) != 0) {
        result.error = "Unable to read Kubernetes rollout history";
        result.logs = logs.str() + output;
        return result;
    }
    logs << output;
    if (countRolloutHistoryRevisions(output) < 2) {
        result.error = "No previous Kubernetes revision is available. Rollback works after at least two successful Kubernetes deployments.";
        result.logs = logs.str();
        return result;
    }

    output.clear();
    if (runCommand(
            kubectlPrefix() + " rollout undo deployment/" + shellQuote(deploymentName) +
                " -n " + shellQuote(result.nameSpace),
            output
        ) != 0) {
        if (output.find("no rollout history") != std::string::npos ||
            output.find("no previous revision") != std::string::npos) {
            result.error = "No previous Kubernetes revision is available. Rollback works after at least two successful Kubernetes deployments.";
        } else {
            result.error = "Failed to rollback Kubernetes deployment";
        }
        result.logs = logs.str() + output;
        return result;
    }
    logs << output;

    output.clear();
    if (runCommand(
            kubectlPrefix() + " rollout status deployment/" + shellQuote(deploymentName) +
                " -n " + shellQuote(result.nameSpace) +
                " --timeout=" + std::to_string(rolloutTimeoutSeconds_) + "s",
            output
        ) != 0) {
        result.error = "Rolled back deployment did not become ready";
        result.logs = logs.str() + output;
        return result;
    }
    logs << output;

    KubernetesRuntimeInfo inspected = inspect(result.nameSpace, deploymentName, serviceName, result.exposureMode, runtimeScheme);
    inspected.logs = logs.str() + inspected.logs;
    return inspected;
}

KubernetesRuntimeInfo KubernetesService::inspect(const std::string& nameSpace,
                                                 const std::string& deploymentName,
                                                 const std::string& serviceName,
                                                 const std::string& exposureMode,
                                                 const std::string& runtimeScheme) const {
    KubernetesRuntimeInfo result;
    result.nameSpace = nameSpace.empty() ? defaultNamespace_ : nameSpace;
    result.deploymentName = deploymentName;
    result.serviceName = serviceName;
    result.ingressName = sanitizeDnsLabel(deploymentName + "-ing");
    result.exposureMode = normalizeExposureMode(exposureMode);
    result.runtimeScheme = normalizeRuntimeScheme(runtimeScheme.empty() ? runtimeScheme_ : runtimeScheme);

    Json::Value deploymentJson;
    std::string deploymentOutput;
    if (!runJsonCommand(
            kubectlPrefix() + " get deployment " + shellQuote(deploymentName) +
                " -n " + shellQuote(result.nameSpace) + " -o json",
            deploymentJson,
            deploymentOutput
        )) {
        result.error = "Deployment is not present in Kubernetes";
        result.logs = deploymentOutput;
        return result;
    }

    Json::Value serviceJson;
    std::string serviceOutput;
    if (!runJsonCommand(
            kubectlPrefix() + " get service " + shellQuote(serviceName) +
                " -n " + shellQuote(result.nameSpace) + " -o json",
            serviceJson,
            serviceOutput
        )) {
        result.error = "Service is not present in Kubernetes";
        result.logs = deploymentOutput + serviceOutput;
        return result;
    }

    Json::Value ingressJson;
    std::string ingressOutput;
    if (exposureUsesIngress(result.exposureMode)) {
        runJsonCommand(
            kubectlPrefix() + " get ingress " + shellQuote(result.ingressName) +
                " -n " + shellQuote(result.nameSpace) + " -o json",
            ingressJson,
            ingressOutput
        );
        if (ingressJson.isObject()) {
            if (ingressJson["spec"].isMember("rules") &&
                ingressJson["spec"]["rules"].isArray() &&
                !ingressJson["spec"]["rules"].empty() &&
                ingressJson["spec"]["rules"][0].isMember("host")) {
                result.ingressHost = ingressJson["spec"]["rules"][0]["host"].asString();
            }
        }
    }

    result.deployed = true;
    result.success = true;
    result.desiredReplicas = deploymentJson["spec"].isMember("replicas") ? deploymentJson["spec"]["replicas"].asInt() : 0;
    result.readyReplicas = deploymentJson["status"].isMember("readyReplicas") ? deploymentJson["status"]["readyReplicas"].asInt() : 0;
    result.status = deriveRuntimeStatus(deploymentJson, result.desiredReplicas, result.readyReplicas);
    result.runtimeUrl = buildRuntimeUrl(serviceJson, ingressJson, result.nameSpace, result.serviceName, result.ingressHost, result.exposureMode, result.runtimeScheme);
    result.logs = deploymentOutput + serviceOutput + collectRuntimeDiagnostics(
        result.nameSpace,
        deploymentName,
        result.status != "running",
        result.ingressName,
        result.exposureMode
    );
    if (!ingressOutput.empty()) {
        result.logs += ingressOutput;
    }
    return result;
}

KubernetesRuntimeInfo KubernetesService::remove(const std::string& nameSpace,
                                                const std::string& deploymentName,
                                                const std::string& serviceName,
                                                const std::string& exposureMode) const {
    KubernetesRuntimeInfo result;
    result.success = true;
    result.nameSpace = nameSpace.empty() ? defaultNamespace_ : nameSpace;
    result.deploymentName = deploymentName;
    result.serviceName = serviceName;
    result.exposureMode = normalizeExposureMode(exposureMode);

    std::ostringstream logs;
    logs << "[runtime] Removing Kubernetes runtime resources\n";

    std::string output;
    if (exposureUsesIngress(result.exposureMode)) {
        runCommand(
            kubectlPrefix() + " delete ingress " + shellQuote(sanitizeDnsLabel(deploymentName + "-ing")) +
                " -n " + shellQuote(result.nameSpace) + " --ignore-not-found",
            output
        );
        logs << output;
        output.clear();
    }

    runCommand(
        kubectlPrefix() + " delete hpa " + shellQuote(sanitizeDnsLabel(deploymentName + "-hpa")) +
            " -n " + shellQuote(result.nameSpace) + " --ignore-not-found",
        output
    );
    logs << output;
    output.clear();

    runCommand(
        kubectlPrefix() + " delete pdb " + shellQuote(sanitizeDnsLabel(deploymentName + "-pdb")) +
            " -n " + shellQuote(result.nameSpace) + " --ignore-not-found",
        output
    );
    logs << output;
    output.clear();

    runCommand(
        kubectlPrefix() + " delete secret " + shellQuote(sanitizeDnsLabel(deploymentName + "-env")) +
            " -n " + shellQuote(result.nameSpace) + " --ignore-not-found",
        output
    );
    logs << output;
    output.clear();

    int serviceExit = runCommand(
        kubectlPrefix() + " delete service " + shellQuote(serviceName) +
            " -n " + shellQuote(result.nameSpace) + " --ignore-not-found",
        output
    );
    logs << output;

    output.clear();
    int deploymentExit = runCommand(
        kubectlPrefix() + " delete deployment " + shellQuote(deploymentName) +
            " -n " + shellQuote(result.nameSpace) + " --ignore-not-found --cascade=foreground",
        output
    );
    logs << output;

    // Aggressive Pod-level cleanup by label to ensure 'ghost' pods are entirely killed.
    output.clear();
    runCommand(
        kubectlPrefix() + " delete pods -l app=" + shellQuote(deploymentName) +
            " -n " + shellQuote(result.nameSpace) + " --ignore-not-found --grace-period=0 --force",
        output
    );
    logs << output;

    if (serviceExit != 0 || deploymentExit != 0) {
        result.success = false;
        result.error = "Failed to remove one or more Kubernetes resources";
    }

    result.logs = logs.str();
    return result;
}

KubernetesRuntimeInfo KubernetesService::removeComposeStack(const std::string& nameSpace,
                                                            const std::string& stackName,
                                                            const std::string& exposureMode) const {
    KubernetesRuntimeInfo result;
    result.success = true;
    result.nameSpace = nameSpace.empty() ? defaultNamespace_ : nameSpace;
    result.deploymentName = stackName;
    result.exposureMode = normalizeExposureMode(exposureMode);

    if (!isValidDnsLabel(result.nameSpace) || !isValidDnsLabel(stackName)) {
        result.success = false;
        result.error = "Invalid Compose Kubernetes cleanup metadata";
        return result;
    }

    const std::string selector = "dokscp.io/compose-project=" + stackName;
    std::ostringstream logs;
    logs << "[compose-k8s] Removing Kubernetes stack " << stackName << "\n";

    std::string output;
    const int resourceExit = runCommand(
        kubectlPrefix() + " delete ingress,service,hpa,pdb,secret,pvc,deployment " +
            "-l " + shellQuote(selector) +
            " -n " + shellQuote(result.nameSpace) +
            " --ignore-not-found --cascade=foreground",
        output
    );
    logs << output;

    output.clear();
    runCommand(
        kubectlPrefix() + " delete pods " +
            "-l " + shellQuote(selector) +
            " -n " + shellQuote(result.nameSpace) +
            " --ignore-not-found --grace-period=0 --force",
        output
    );
    logs << output;

    if (resourceExit == 0 && result.nameSpace != defaultNamespace_ &&
        result.nameSpace.find(stackName) != std::string::npos) {
        output.clear();
        runCommand(
            kubectlPrefix() + " delete namespace " + shellQuote(result.nameSpace) + " --ignore-not-found",
            output
        );
        logs << output;
    }

    if (resourceExit != 0) {
        result.success = false;
        result.error = "Failed to remove one or more Compose Kubernetes resources";
    }
    result.logs = logs.str();
    return result;
}

std::string KubernetesService::collectEvents(const std::string& nameSpace,
                                             const std::string& deploymentName,
                                             const std::string& ingressName,
                                             const std::string& exposureMode) const {
    const std::string effectiveNamespace = nameSpace.empty() ? defaultNamespace_ : nameSpace;
    std::ostringstream diagnostics;
    std::string output;

    diagnostics << "[kubernetes] Runtime events for " << deploymentName << "\n\n";
    diagnostics << "[pods]\n";
    runCommand(
        kubectlPrefix() + " get pods -n " + shellQuote(effectiveNamespace) +
            " -l app=" + shellQuote(deploymentName) + " -o wide",
        output
    );
    diagnostics << output << "\n";

    output.clear();
    diagnostics << "[deployment]\n";
    runCommand(
        kubectlPrefix() + " describe deployment " + shellQuote(deploymentName) +
            " -n " + shellQuote(effectiveNamespace),
        output
    );
    diagnostics << output << "\n";

    if (exposureUsesIngress(exposureMode) && !ingressName.empty()) {
        output.clear();
        diagnostics << "[ingress]\n";
        runCommand(
            kubectlPrefix() + " describe ingress " + shellQuote(ingressName) +
                " -n " + shellQuote(effectiveNamespace),
            output
        );
        diagnostics << output << "\n";
    }

    output.clear();
    diagnostics << "[recent events]\n";
    runCommand(
        kubectlPrefix() + " get events -n " + shellQuote(effectiveNamespace) +
            " --sort-by=.lastTimestamp",
        output
    );
    diagnostics << output;
    return diagnostics.str();
}

std::string KubernetesService::kubectlPrefix() const {
    if (!kubeconfigPath_.empty()) {
        return "kubectl --kubeconfig " + shellQuote(kubeconfigPath_);
    }
    return "kubectl";
}

std::string KubernetesService::shellQuote(const std::string& value) const {
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

std::string KubernetesService::sanitizeDnsLabel(const std::string& value) const {
    std::string out;
    out.reserve(value.size());

    for (char c : value) {
        const char lowered = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        if ((lowered >= 'a' && lowered <= 'z') || (lowered >= '0' && lowered <= '9')) {
            out.push_back(lowered);
        } else if (out.empty() || out.back() == '-') {
            continue;
        } else {
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

std::string KubernetesService::buildRuntimeUrl(const Json::Value& serviceJson,
                                               const Json::Value& ingressJson,
                                               const std::string& nameSpace,
                                               const std::string& serviceName,
                                               const std::string& ingressHost,
                                               const std::string& exposureMode,
                                               const std::string& runtimeScheme) const {
    const std::string normalizedExposureMode = normalizeExposureMode(exposureMode);
    const std::string scheme = normalizeRuntimeScheme(runtimeScheme.empty() ? runtimeScheme_ : runtimeScheme);
    if (exposureUsesIngress(normalizedExposureMode)) {
        if (!ingressHost.empty()) {
            return scheme + "://" + ingressHost;
        }
        if (ingressJson.isObject() && ingressJson["status"].isMember("loadBalancer")) {
            const Json::Value& ingress = ingressJson["status"]["loadBalancer"]["ingress"];
            if (ingress.isArray() && !ingress.empty()) {
                if (ingress[0].isMember("hostname") && ingress[0]["hostname"].isString()) {
                    return scheme + "://" + ingress[0]["hostname"].asString();
                }
                if (ingress[0].isMember("ip") && ingress[0]["ip"].isString()) {
                    return scheme + "://" + ingress[0]["ip"].asString();
                }
            }
        }
        return "";
    }

    const Json::Value& ports = serviceJson["spec"]["ports"];
    if (ports.isArray() && !ports.empty()) {
        const Json::Value& port = ports[0];
        if (normalizedExposureMode == "nodeport" && port.isMember("nodePort")) {
            return "http://" + nodeHost_ + ":" + std::to_string(port["nodePort"].asInt());
        }
        if (normalizedExposureMode == "loadbalancer" &&
            serviceJson["status"].isMember("loadBalancer") &&
            serviceJson["status"]["loadBalancer"].isMember("ingress") &&
            serviceJson["status"]["loadBalancer"]["ingress"].isArray() &&
            !serviceJson["status"]["loadBalancer"]["ingress"].empty()) {
            const Json::Value& ingress = serviceJson["status"]["loadBalancer"]["ingress"][0];
            if (ingress.isMember("hostname") && ingress["hostname"].isString()) {
                return scheme + "://" + ingress["hostname"].asString();
            }
            if (ingress.isMember("ip") && ingress["ip"].isString()) {
                return scheme + "://" + ingress["ip"].asString();
            }
        }
        if (port.isMember("port")) {
            return "http://" + serviceName + "." + nameSpace + ".svc.cluster.local:" + std::to_string(port["port"].asInt());
        }
    }

    return "";
}

std::string KubernetesService::collectRuntimeDiagnostics(const std::string& nameSpace,
                                                         const std::string& deploymentName,
                                                         bool includeContainerLogs,
                                                         const std::string& ingressName,
                                                         const std::string& exposureMode) const {
    std::ostringstream diagnostics;
    std::string output;

    diagnostics << "\n[runtime] Pod snapshot\n";
    runCommand(
        kubectlPrefix() + " get pods -n " + shellQuote(nameSpace) +
            " -l app=" + shellQuote(deploymentName) + " -o wide",
        output
    );
    diagnostics << output;

    if (exposureUsesIngress(exposureMode) && !ingressName.empty()) {
        output.clear();
        diagnostics << "\n[runtime] Ingress describe\n";
        runCommand(
            kubectlPrefix() + " describe ingress " + shellQuote(ingressName) +
                " -n " + shellQuote(nameSpace),
            output
        );
        diagnostics << output;
    }

    if (includeContainerLogs) {
        output.clear();
        diagnostics << "\n[runtime] Deployment describe\n";
        runCommand(
            kubectlPrefix() + " describe deployment " + shellQuote(deploymentName) +
                " -n " + shellQuote(nameSpace),
            output
        );
        diagnostics << output;

        output.clear();
        diagnostics << "\n[runtime] Recent events\n";
        runCommand(
            kubectlPrefix() + " get events -n " + shellQuote(nameSpace) +
                " --sort-by=.lastTimestamp",
            output
        );
        diagnostics << output;

        output.clear();
        diagnostics << "\n[runtime] Recent container logs\n";
        runCommand(
            kubectlPrefix() + " logs deployment/" + shellQuote(deploymentName) +
                " -n " + shellQuote(nameSpace) +
                " --all-containers=true --tail=100",
            output
        );
        diagnostics << output;
    }

    return diagnostics.str();
}

std::string KubernetesService::deriveRuntimeStatus(const Json::Value& deploymentJson,
                                                   int desiredReplicas,
                                                   int readyReplicas) const {
    const Json::Value& conditions = deploymentJson["status"]["conditions"];
    if (conditions.isArray()) {
        for (const auto& condition : conditions) {
            const std::string type = condition.isMember("type") ? condition["type"].asString() : "";
            const std::string status = condition.isMember("status") ? condition["status"].asString() : "";
            const std::string reason = condition.isMember("reason") ? condition["reason"].asString() : "";

            if ((type == "Progressing" && status == "False") ||
                reason == "ProgressDeadlineExceeded" ||
                reason == "ReplicaFailure" ||
                reason == "FailedCreate") {
                return "failed";
            }
        }
    }

    if (desiredReplicas > 0 && readyReplicas >= desiredReplicas) {
        return "running";
    }

    return "deploying";
}

int KubernetesService::runCommand(const std::string& command, std::string& output) const {
    output.clear();
    FILE* pipe = popen((command + " 2>&1").c_str(), "r");
    if (!pipe) {
        output = "Failed to start shell command\n";
        return -1;
    }

    char buffer[4096];
    while (fgets(buffer, sizeof(buffer), pipe) != nullptr) {
        output += buffer;
    }

    int rawExit = pclose(pipe);
    if (WIFEXITED(rawExit)) {
        return WEXITSTATUS(rawExit);
    }
    return rawExit;
}

bool KubernetesService::runJsonCommand(const std::string& command, Json::Value& output, std::string& rawOutput) const {
    if (runCommand(command, rawOutput) != 0) {
        return false;
    }

    Json::CharReaderBuilder builder;
    builder["collectComments"] = false;
    std::string errors;
    std::istringstream stream(rawOutput);
    return Json::parseFromStream(builder, stream, &output, &errors);
}

bool KubernetesService::isValidDnsLabel(const std::string& value) const {
    if (value.empty() || value.size() > 63) {
        return false;
    }

    if (!std::isalnum(static_cast<unsigned char>(value.front())) ||
        !std::isalnum(static_cast<unsigned char>(value.back()))) {
        return false;
    }

    for (char c : value) {
        const bool isLowerAlpha = c >= 'a' && c <= 'z';
        const bool isDigit = c >= '0' && c <= '9';
        if (!isLowerAlpha && !isDigit && c != '-') {
            return false;
        }
    }

    return sanitizeDnsLabel(value) == value;
}

bool KubernetesService::ingressModeEnabled() const {
    return exposureMode_ == "ingress";
}

bool KubernetesService::ingressClassExists(std::string& output) const {
    if (ingressClassName_.empty()) {
        return runCommand(
                   kubectlPrefix() + " get ingressclass -o name",
                   output
               ) == 0 && !trim(output).empty();
    }

    return runCommand(
               kubectlPrefix() + " get ingressclass " + shellQuote(ingressClassName_) + " -o name",
               output
           ) == 0;
}

std::string KubernetesService::normalizeExposureMode(const std::string& requestedExposureMode) const {
    std::string normalized = trim(requestedExposureMode);
    std::transform(normalized.begin(), normalized.end(), normalized.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
    });

    if (normalized.empty()) {
        normalized = exposureMode_;
    }

    if (normalized == "service") {
        normalized = serviceType_ == "LoadBalancer" ? "loadbalancer"
                    : serviceType_ == "ClusterIP" ? "clusterip"
                    : "nodeport";
    }

    if (normalized != "ingress" &&
        normalized != "nodeport" &&
        normalized != "loadbalancer" &&
        normalized != "clusterip") {
        normalized = baseDomain_.empty() ? "nodeport" : "ingress";
    }

    if (normalized == "ingress" && baseDomain_.empty()) {
        normalized = "nodeport";
    }

    return normalized;
}

bool KubernetesService::exposureUsesIngress(const std::string& exposureMode) const {
    return normalizeExposureMode(exposureMode) == "ingress";
}

std::string KubernetesService::serviceTypeForExposure(const std::string& exposureMode) const {
    const std::string normalized = normalizeExposureMode(exposureMode);
    if (normalized == "ingress" || normalized == "clusterip") {
        return "ClusterIP";
    }
    if (normalized == "loadbalancer") {
        return "LoadBalancer";
    }
    return "NodePort";
}

} // namespace dokscp
