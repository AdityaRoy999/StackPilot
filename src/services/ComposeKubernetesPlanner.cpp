// ============================================================
// ComposeKubernetesPlanner.cpp - Docker Compose to Kubernetes plan
// ============================================================

#include "ComposeKubernetesPlanner.h"

#include <algorithm>
#include <cctype>
#include <map>
#include <set>
#include <sstream>

namespace stackpilot {

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

std::string toLower(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
    });
    return value;
}

bool isValidEnvKey(const std::string& value) {
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

std::string scalarToString(const Json::Value& value) {
    if (value.isString()) {
        return value.asString();
    }
    if (value.isBool()) {
        return value.asBool() ? "true" : "false";
    }
    if (value.isInt()) {
        return std::to_string(value.asInt());
    }
    if (value.isUInt()) {
        return std::to_string(value.asUInt());
    }
    if (value.isDouble()) {
        std::ostringstream out;
        out << value.asDouble();
        return out.str();
    }
    if (value.isNull()) {
        return "";
    }
    return value.toStyledString();
}

int parsePortValue(const Json::Value& value) {
    try {
        if (value.isInt()) {
            return value.asInt();
        }
        if (value.isUInt()) {
            return static_cast<int>(value.asUInt());
        }
        if (value.isString()) {
            std::string text = trim(value.asString());
            if (text.empty()) {
                return 0;
            }
            const size_t slash = text.find('/');
            if (slash != std::string::npos) {
                text = text.substr(0, slash);
            }
            const size_t colon = text.rfind(':');
            if (colon != std::string::npos) {
                text = text.substr(colon + 1);
            }
            return std::stoi(text);
        }
    } catch (...) {
    }
    return 0;
}

struct ServiceDetails {
    ComposeKubernetesPlanService service;
    std::map<std::string, std::string> env;
    std::vector<std::pair<std::string, std::string>> volumeMounts;
    std::vector<std::pair<std::string, std::string>> pvcNames;
    std::vector<std::string> entrypoint;
    std::vector<std::string> command;
    std::string workingDir;
};

std::vector<std::string> jsonCommandList(const Json::Value& value) {
    std::vector<std::string> result;
    if (value.isString()) {
        const std::string text = trim(value.asString());
        if (!text.empty()) {
            result.push_back("/bin/sh");
            result.push_back("-lc");
            result.push_back(text);
        }
        return result;
    }
    if (value.isArray()) {
        for (const auto& item : value) {
            if (item.isString()) {
                const std::string text = trim(item.asString());
                if (!text.empty()) {
                    result.push_back(text);
                }
            }
        }
    }
    return result;
}

std::string yamlQuote(const std::string& value);

void writeYamlStringList(std::ostream& out,
                         const std::string& key,
                         const std::vector<std::string>& values,
                         int indentSpaces) {
    if (values.empty()) {
        return;
    }
    const std::string indent(static_cast<size_t>(indentSpaces), ' ');
    out << indent << key << ":\n";
    for (const auto& value : values) {
        out << indent << "  - " << yamlQuote(value) << "\n";
    }
}

int inferredCommonPort(const std::string& serviceName, const std::string& imageName) {
    const std::string text = toLower(serviceName + " " + imageName);
    const std::vector<std::pair<std::string, int>> known = {
        {"postgres", 5432},
        {"postgis", 5432},
        {"mysql", 3306},
        {"mariadb", 3306},
        {"redis", 6379},
        {"valkey", 6379},
        {"mongo", 27017},
        {"rabbitmq", 5672},
        {"nats", 4222},
        {"kafka", 9092},
        {"zookeeper", 2181},
        {"elasticsearch", 9200},
        {"opensearch", 9200},
        {"meilisearch", 7700},
        {"typesense", 8108},
        {"grafana", 3000},
        {"prometheus", 9090},
        {"loki", 3100},
        {"jaeger", 16686},
        {"nginx", 80},
        {"httpd", 80},
        {"apache", 80},
        {"caddy", 80}
    };
    for (const auto& entry : known) {
        if (text.find(entry.first) != std::string::npos) {
            return entry.second;
        }
    }
    return 0;
}

int firstContainerPort(const Json::Value& service,
                       const std::string& serviceName,
                       const std::string& imageName) {
    const Json::Value& ports = service["ports"];
    if (ports.isArray()) {
        for (const auto& port : ports) {
            int target = 0;
            if (port.isObject()) {
                target = parsePortValue(port["target"]);
            } else {
                target = parsePortValue(port);
            }
            if (target > 0 && target <= 65535) {
                return target;
            }
        }
    }
    const Json::Value& expose = service["expose"];
    if (expose.isArray()) {
        for (const auto& exposed : expose) {
            const int target = parsePortValue(exposed);
            if (target > 0 && target <= 65535) {
                return target;
            }
        }
    }
    const int inferred = inferredCommonPort(serviceName, imageName);
    if (inferred > 0) {
        return inferred;
    }
    return 0;
}

bool hasPublishedPort(const Json::Value& service) {
    const Json::Value& ports = service["ports"];
    if (!ports.isArray()) {
        return false;
    }
    for (const auto& port : ports) {
        if (!port.isObject()) {
            return true;
        }
        if (port.isMember("published") && !trim(scalarToString(port["published"])).empty()) {
            return true;
        }
        if (port.isMember("mode") && toLower(trim(port["mode"].asString())) == "ingress") {
            return true;
        }
    }
    return false;
}

std::string normalizeRuntimeScheme(const std::string& value) {
    return toLower(trim(value)) == "https" ? "https" : "http";
}

std::string normalizeServiceType(std::string value) {
    value = toLower(trim(value));
    if (value == "clusterip") {
        return "ClusterIP";
    }
    if (value == "loadbalancer") {
        return "LoadBalancer";
    }
    return "NodePort";
}

std::string normalizeExposure(const ComposeKubernetesPlanOptions& options) {
    std::string normalized = toLower(trim(options.exposureMode));
    if (normalized.empty() || normalized == "service") {
        const std::string serviceType = normalizeServiceType(options.serviceType);
        if (!options.baseDomain.empty()) {
            return "ingress";
        }
        if (serviceType == "LoadBalancer") {
            return "loadbalancer";
        }
        if (serviceType == "ClusterIP") {
            return "clusterip";
        }
        return "nodeport";
    }
    if (normalized != "ingress" && normalized != "nodeport" &&
        normalized != "loadbalancer" && normalized != "clusterip") {
        normalized = options.baseDomain.empty() ? "nodeport" : "ingress";
    }
    if (normalized == "ingress" && options.baseDomain.empty() && !options.allowIngressWithoutBaseDomain) {
        normalized = "nodeport";
    }
    return normalized;
}

std::string serviceTypeForExposure(const std::string& exposureMode, const std::string& configuredServiceType) {
    if (exposureMode == "ingress" || exposureMode == "clusterip") {
        return "ClusterIP";
    }
    if (exposureMode == "loadbalancer") {
        return "LoadBalancer";
    }
    const std::string normalized = normalizeServiceType(configuredServiceType);
    return normalized == "ClusterIP" ? "NodePort" : normalized;
}

struct ResourcePreset {
    std::string cpuRequest;
    std::string memoryRequest;
    std::string cpuLimit;
    std::string memoryLimit;
};

ResourcePreset resourcesFor(const ComposeKubernetesPlanOptions& options) {
    const std::string preset = toLower(trim(options.resourcePreset));
    if (preset == "medium") {
        return {"250m", "256Mi", "1000m", "1Gi"};
    }
    if (preset == "large") {
        return {"500m", "512Mi", "2000m", "2Gi"};
    }
    if (preset == "small") {
        return {"100m", "128Mi", "500m", "512Mi"};
    }
    return {options.cpuRequest, options.memoryRequest, options.cpuLimit, options.memoryLimit};
}

std::string yamlQuote(const std::string& value) {
    std::string out = "\"";
    for (char c : value) {
        if (c == '\\' || c == '"') {
            out.push_back('\\');
            out.push_back(c);
        } else if (c == '\n') {
            out += "\\n";
        } else if (c == '\r') {
            out += "\\r";
        } else {
            out.push_back(c);
        }
    }
    out.push_back('"');
    return out;
}

void writeBlockScalar(std::ostream& out, const std::string& key, const std::string& value) {
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

void appendWarning(std::vector<std::string>& warnings, const std::string& warning) {
    if (std::find(warnings.begin(), warnings.end(), warning) == warnings.end()) {
        warnings.push_back(warning);
    }
}

std::string safeHealthPath(std::string value) {
    value = trim(value);
    if (value.empty()) {
        value = "/";
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

std::string serviceImageName(const std::string& stackName,
                             const std::string& serviceName,
                             const Json::Value& service) {
    if (service.isMember("image") && service["image"].isString() &&
        !trim(service["image"].asString()).empty()) {
        return trim(service["image"].asString());
    }
    return stackName + "-" + toLower(trim(serviceName));
}

void mergeEnvironment(std::map<std::string, std::string>& env,
                      const Json::Value& environment,
                      std::vector<std::string>& warnings,
                      const std::string& serviceName) {
    if (environment.isObject()) {
        for (const auto& key : environment.getMemberNames()) {
            if (isValidEnvKey(key)) {
                env[key] = scalarToString(environment[key]);
            } else {
                appendWarning(warnings, "Skipped unsupported environment key '" + key + "' on service '" + serviceName + "'");
            }
        }
        return;
    }
    if (environment.isArray()) {
        for (const auto& item : environment) {
            if (!item.isString()) {
                continue;
            }
            const std::string value = item.asString();
            const size_t equal = value.find('=');
            const std::string key = equal == std::string::npos ? value : value.substr(0, equal);
            if (isValidEnvKey(key)) {
                env[key] = equal == std::string::npos ? "" : value.substr(equal + 1);
            } else {
                appendWarning(warnings, "Skipped unsupported environment key '" + key + "' on service '" + serviceName + "'");
            }
        }
    }
}

} // namespace

std::string ComposeKubernetesPlanner::sanitizeDnsLabel(const std::string& value, size_t maxLength) {
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
        out = "stackpilot-runtime";
    }
    maxLength = std::clamp<size_t>(maxLength, 8, 63);
    if (out.size() > maxLength) {
        out.resize(maxLength);
        while (!out.empty() && out.back() == '-') {
            out.pop_back();
        }
    }
    return out;
}

std::string ComposeKubernetesPlanner::joinWarnings(const std::vector<std::string>& warnings) {
    std::ostringstream out;
    for (const auto& warning : warnings) {
        out << "[compose-k8s] WARNING: " << warning << "\n";
    }
    return out.str();
}

ComposeKubernetesPlan ComposeKubernetesPlanner::build(const Json::Value& composeConfig,
                                                       const ComposeKubernetesPlanOptions& options) {
    ComposeKubernetesPlan plan;
    const std::string baseNamespace = options.nameSpace.empty() ? "stackpilot-apps" : sanitizeDnsLabel(options.nameSpace, 63);
    const std::string composeImageProjectName = !trim(options.composeProjectName).empty()
        ? trim(options.composeProjectName)
        : "";
    plan.stackName = sanitizeDnsLabel(
        !composeImageProjectName.empty()
            ? composeImageProjectName
            : options.projectName + "-" + options.deploymentId.substr(0, std::min<size_t>(8, options.deploymentId.size())),
        45
    );
    plan.nameSpace = options.isolateNamespace
        ? sanitizeDnsLabel(baseNamespace + "-" + plan.stackName, 63)
        : baseNamespace;
    plan.exposureMode = normalizeExposure(options);
    plan.runtimeScheme = normalizeRuntimeScheme(options.runtimeScheme);
    plan.desiredReplicas = std::clamp(options.replicas, 1, std::max(1, options.maxReplicas));
    plan.ingressName = sanitizeDnsLabel(plan.stackName + "-ing", 63);

    if (plan.runtimeScheme == "https" && plan.exposureMode != "ingress") {
        plan.error = "HTTPS runtime URLs require Ingress exposure for Docker Compose Kubernetes stacks";
        return plan;
    }
    if (plan.exposureMode == "ingress" && options.baseDomain.empty() && options.hostForNip.empty()) {
        plan.error = "Ingress exposure requires a base domain or a node IP for nip.io";
        return plan;
    }
    if (!composeConfig.isObject() || !composeConfig["services"].isObject()) {
        plan.error = "Docker Compose config did not contain services";
        return plan;
    }

    const Json::Value& services = composeConfig["services"];
    const std::vector<std::string> serviceNames = services.getMemberNames();
    if (serviceNames.empty()) {
        plan.error = "Docker Compose config did not contain any runnable services";
        return plan;
    }

    std::vector<ServiceDetails> details;
    details.reserve(serviceNames.size());
    int placeholderIndex = 0;
    for (const auto& serviceName : serviceNames) {
        const Json::Value& service = services[serviceName];
        ServiceDetails detail;
        detail.service.serviceName = serviceName;
        detail.service.deploymentName = sanitizeDnsLabel(plan.stackName + "-" + serviceName, 58);
        detail.service.kubernetesServiceName = sanitizeDnsLabel(
            options.isolateNamespace ? serviceName : detail.service.deploymentName + "-svc",
            63
        );
        detail.service.imageName = serviceImageName(!composeImageProjectName.empty() ? composeImageProjectName : plan.stackName,
                                                    serviceName,
                                                    service);
        detail.service.imagePlaceholder = "__STACKPILOT_COMPOSE_IMAGE_" + std::to_string(placeholderIndex++) + "__";
        detail.service.localBuildImage = service.isMember("build");
        detail.service.containerPort = firstContainerPort(service, serviceName, detail.service.imageName);
        detail.service.hasPublishedPort = hasPublishedPort(service);
        detail.entrypoint = jsonCommandList(service["entrypoint"]);
        detail.command = jsonCommandList(service["command"]);
        if (service["working_dir"].isString()) {
            detail.workingDir = trim(service["working_dir"].asString());
        }

        for (const auto& envVar : options.envVars) {
            if (isValidEnvKey(envVar.first)) {
                detail.env[envVar.first] = envVar.second;
            }
        }
        mergeEnvironment(detail.env, service["environment"], plan.warnings, serviceName);

        if (service.isMember("depends_on")) {
            appendWarning(plan.warnings, "Compose depends_on is advisory in Kubernetes; readiness is handled by service discovery");
        }
        if (service.isMember("network_mode")) {
            appendWarning(plan.warnings, "Compose network_mode was ignored because Kubernetes uses cluster networking");
        }
        if (service.isMember("privileged") && service["privileged"].asBool()) {
            appendWarning(plan.warnings, "Privileged mode was not enabled automatically for service '" + serviceName + "'");
        }
        if (service.isMember("healthcheck")) {
            appendWarning(plan.warnings, "Compose healthcheck for service '" + serviceName + "' was replaced with a Kubernetes TCP readiness check");
        }
        if (detail.service.containerPort == inferredCommonPort(serviceName, detail.service.imageName) &&
            detail.service.containerPort > 0 && !service.isMember("ports") && !service.isMember("expose")) {
            appendWarning(plan.warnings, "Inferred TCP port " + std::to_string(detail.service.containerPort) +
                " for service '" + serviceName + "' from its image/name; declare ports or expose for exact Kubernetes service wiring");
        }

        const Json::Value& volumes = service["volumes"];
        if (volumes.isArray()) {
            int volumeIndex = 0;
            for (const auto& volume : volumes) {
                if (!volume.isObject()) {
                    appendWarning(plan.warnings, "Skipped string-style volume on service '" + serviceName + "'");
                    continue;
                }
                const std::string type = toLower(trim(volume.get("type", "").asString()));
                const std::string target = trim(volume.get("target", "").asString());
                const std::string source = trim(volume.get("source", "").asString());
                if (target.empty()) {
                    continue;
                }
                if (type == "volume") {
                    const std::string suffix = sanitizeDnsLabel(source.empty() ? std::to_string(volumeIndex) : source, 24);
                    const std::string pvcName = sanitizeDnsLabel(detail.service.deploymentName + "-" + suffix, 63);
                    const std::string mountName = sanitizeDnsLabel("vol-" + suffix, 32);
                    detail.pvcNames.emplace_back(mountName, pvcName);
                    detail.volumeMounts.emplace_back(mountName, target);
                } else if (type == "bind") {
                    appendWarning(plan.warnings, "Skipped host bind mount '" + source + "' on service '" + serviceName + "'; use named volumes or Kubernetes storage for portable deployments");
                } else {
                    appendWarning(plan.warnings, "Skipped unsupported volume type on service '" + serviceName + "'");
                }
                ++volumeIndex;
            }
        }

        details.push_back(std::move(detail));
    }

    int primaryIndex = -1;
    for (size_t i = 0; i < details.size(); ++i) {
        if (details[i].service.hasPublishedPort && details[i].service.containerPort > 0) {
            primaryIndex = static_cast<int>(i);
            break;
        }
    }
    if (primaryIndex < 0) {
        static const std::vector<std::string> preferred = {"frontend", "web", "app", "api", "backend", "server"};
        for (const auto& candidate : preferred) {
            for (size_t i = 0; i < details.size(); ++i) {
                if (toLower(details[i].service.serviceName) == candidate && details[i].service.containerPort > 0) {
                    primaryIndex = static_cast<int>(i);
                    break;
                }
            }
            if (primaryIndex >= 0) {
                break;
            }
        }
    }
    if (primaryIndex < 0) {
        for (size_t i = 0; i < details.size(); ++i) {
            if (details[i].service.containerPort > 0) {
                primaryIndex = static_cast<int>(i);
                break;
            }
        }
    }
    if (primaryIndex < 0 && details.size() == 1) {
        primaryIndex = 0;
        details[0].service.containerPort = std::clamp(options.defaultContainerPort, 1, 65535);
        appendWarning(plan.warnings, "No Compose ports were declared; using the platform default port for the only service");
    }
    if (primaryIndex < 0) {
        plan.error = "No service in the Compose project exposes a TCP port, so StackPilot cannot create a preview URL";
        return plan;
    }
    details[primaryIndex].service.publicService = true;
    plan.primaryDeploymentName = details[primaryIndex].service.deploymentName;
    plan.primaryServiceName = details[primaryIndex].service.kubernetesServiceName;
    if (plan.exposureMode == "ingress") {
        if (!options.baseDomain.empty()) {
            plan.ingressHost = plan.stackName + "." + options.baseDomain;
        } else {
            std::string host = options.hostForNip;
            std::replace(host.begin(), host.end(), '.', '-');
            plan.ingressHost = plan.stackName + "." + plan.nameSpace + "." + host + ".nip.io";
        }
    }

    std::ostringstream csv;
    for (size_t i = 0; i < details.size(); ++i) {
        if (i > 0) {
            csv << ",";
        }
        csv << details[i].service.serviceName;
        plan.services.push_back(details[i].service);
    }
    plan.servicesCsv = csv.str();

    const ResourcePreset resources = resourcesFor(options);
    const std::string primaryServiceType = serviceTypeForExposure(plan.exposureMode, options.serviceType);
    const std::string healthPath = safeHealthPath(options.healthPath);
    const bool useIngress = plan.exposureMode == "ingress";

    Json::Value annotations;
    if (!trim(options.ingressAnnotationsJson).empty()) {
        Json::CharReaderBuilder builder;
        std::string errors;
        std::istringstream stream(options.ingressAnnotationsJson);
        Json::parseFromStream(builder, stream, &annotations, &errors);
    }

    std::ostringstream manifest;
    for (const auto& detail : details) {
        const auto& svc = detail.service;
        if (!detail.env.empty()) {
            const std::string secretName = sanitizeDnsLabel(svc.deploymentName + "-env", 63);
            manifest
                << "apiVersion: v1\n"
                << "kind: Secret\n"
                << "metadata:\n"
                << "  name: " << secretName << "\n"
                << "  namespace: " << plan.nameSpace << "\n"
                << "  labels:\n"
                << "    app.kubernetes.io/managed-by: StackPilot\n"
                << "    StackPilot.io/deployment-id: " << yamlQuote(options.deploymentId) << "\n"
                << "    StackPilot.io/compose-project: " << yamlQuote(plan.stackName) << "\n"
                << "    StackPilot.io/compose-service: " << yamlQuote(svc.serviceName) << "\n"
                << "type: Opaque\n"
                << "stringData:\n";
            for (const auto& env : detail.env) {
                writeBlockScalar(manifest, env.first, env.second);
            }
            manifest << "---\n";
        }

        for (const auto& pvc : detail.pvcNames) {
            manifest
                << "apiVersion: v1\n"
                << "kind: PersistentVolumeClaim\n"
                << "metadata:\n"
                << "  name: " << pvc.second << "\n"
                << "  namespace: " << plan.nameSpace << "\n"
                << "  labels:\n"
                << "    app.kubernetes.io/managed-by: StackPilot\n"
                << "    StackPilot.io/deployment-id: " << yamlQuote(options.deploymentId) << "\n"
                << "    StackPilot.io/compose-project: " << yamlQuote(plan.stackName) << "\n"
                << "    StackPilot.io/compose-service: " << yamlQuote(svc.serviceName) << "\n"
                << "spec:\n"
                << "  accessModes:\n"
                << "    - ReadWriteOnce\n"
                << "  resources:\n"
                << "    requests:\n"
                << "      storage: 1Gi\n"
                << "---\n";
        }

        manifest
            << "apiVersion: apps/v1\n"
            << "kind: Deployment\n"
            << "metadata:\n"
            << "  name: " << svc.deploymentName << "\n"
            << "  namespace: " << plan.nameSpace << "\n"
            << "  labels:\n"
            << "    app.kubernetes.io/managed-by: StackPilot\n"
            << "    StackPilot.io/deployment-id: " << yamlQuote(options.deploymentId) << "\n"
            << "    StackPilot.io/compose-project: " << yamlQuote(plan.stackName) << "\n"
            << "    StackPilot.io/compose-service: " << yamlQuote(svc.serviceName) << "\n"
            << "spec:\n"
            << "  revisionHistoryLimit: 5\n"
            << "  progressDeadlineSeconds: 180\n"
            << "  replicas: " << plan.desiredReplicas << "\n"
            << "  strategy:\n"
            << "    type: RollingUpdate\n"
            << "    rollingUpdate:\n"
            << "      maxUnavailable: 0\n"
            << "      maxSurge: 1\n"
            << "  selector:\n"
            << "    matchLabels:\n"
            << "      app: " << svc.deploymentName << "\n"
            << "  template:\n"
            << "    metadata:\n"
            << "      labels:\n"
            << "        app: " << svc.deploymentName << "\n"
            << "        app.kubernetes.io/managed-by: StackPilot\n"
            << "        StackPilot.io/deployment-id: " << yamlQuote(options.deploymentId) << "\n"
            << "        StackPilot.io/compose-project: " << yamlQuote(plan.stackName) << "\n"
            << "        StackPilot.io/compose-service: " << yamlQuote(svc.serviceName) << "\n"
            << "    spec:\n"
            << (!options.serviceAccountName.empty() ? "      serviceAccountName: " + options.serviceAccountName + "\n" : "")
            << "      terminationGracePeriodSeconds: 30\n"
            << (!options.imagePullSecretName.empty()
                    ? "      imagePullSecrets:\n        - name: " + options.imagePullSecretName + "\n"
                    : "")
            << "      containers:\n"
            << "        - name: " << sanitizeDnsLabel(svc.serviceName, 40) << "\n"
            << "          image: " << (options.useImagePlaceholders ? svc.imagePlaceholder : svc.imageName) << "\n"
            << "          imagePullPolicy: " << (svc.localBuildImage ? "Never" : "IfNotPresent") << "\n";
        writeYamlStringList(manifest, "command", detail.entrypoint, 10);
        writeYamlStringList(manifest, "args", detail.command, 10);
        if (!detail.workingDir.empty()) {
            manifest << "          workingDir: " << yamlQuote(detail.workingDir) << "\n";
        }
        if (svc.containerPort > 0) {
            manifest
                << "          ports:\n"
                << "            - containerPort: " << svc.containerPort << "\n";
        }
        if (!detail.env.empty()) {
            manifest
                << "          envFrom:\n"
                << "            - secretRef:\n"
                << "                name: " << sanitizeDnsLabel(svc.deploymentName + "-env", 63) << "\n";
        }
        if (!detail.volumeMounts.empty()) {
            manifest << "          volumeMounts:\n";
            for (const auto& mount : detail.volumeMounts) {
                manifest
                    << "            - name: " << mount.first << "\n"
                    << "              mountPath: " << yamlQuote(mount.second) << "\n";
            }
        }
        manifest
            << "          resources:\n"
            << "            requests:\n"
            << "              cpu: " << resources.cpuRequest << "\n"
            << "              memory: " << resources.memoryRequest << "\n"
            << "            limits:\n"
            << "              cpu: " << resources.cpuLimit << "\n"
            << "              memory: " << resources.memoryLimit << "\n";
        if (svc.containerPort > 0) {
            manifest
                << "          readinessProbe:\n"
                << "            tcpSocket:\n"
                << "              port: " << svc.containerPort << "\n"
                << "            initialDelaySeconds: 5\n"
                << "            periodSeconds: 10\n"
                << "            timeoutSeconds: 3\n"
                << "            failureThreshold: 6\n"
                << "          livenessProbe:\n"
                << "            tcpSocket:\n"
                << "              port: " << svc.containerPort << "\n"
                << "            initialDelaySeconds: 15\n"
                << "            periodSeconds: 20\n"
                << "            timeoutSeconds: 3\n"
                << "            failureThreshold: 6\n"
                << "          startupProbe:\n"
                << "            tcpSocket:\n"
                << "              port: " << svc.containerPort << "\n"
                << "            periodSeconds: 5\n"
                << "            timeoutSeconds: 3\n"
                << "            failureThreshold: 36\n";
        }
        if (!detail.pvcNames.empty()) {
            manifest << "      volumes:\n";
            for (const auto& pvc : detail.pvcNames) {
                manifest
                    << "        - name: " << pvc.first << "\n"
                    << "          persistentVolumeClaim:\n"
                    << "            claimName: " << pvc.second << "\n";
            }
        }
        manifest << "---\n";

        if (svc.containerPort > 0) {
            const std::string serviceType = svc.publicService ? primaryServiceType : "ClusterIP";
            manifest
                << "apiVersion: v1\n"
                << "kind: Service\n"
                << "metadata:\n"
                << "  name: " << svc.kubernetesServiceName << "\n"
                << "  namespace: " << plan.nameSpace << "\n"
                << "  labels:\n"
                << "    app.kubernetes.io/managed-by: StackPilot\n"
                << "    StackPilot.io/deployment-id: " << yamlQuote(options.deploymentId) << "\n"
                << "    StackPilot.io/compose-project: " << yamlQuote(plan.stackName) << "\n"
                << "    StackPilot.io/compose-service: " << yamlQuote(svc.serviceName) << "\n"
                << "spec:\n"
                << "  selector:\n"
                << "    app: " << svc.deploymentName << "\n"
                << "  type: " << serviceType << "\n"
                << "  ports:\n"
                << "    - protocol: TCP\n"
                << "      port: " << svc.containerPort << "\n"
                << "      targetPort: " << svc.containerPort << "\n"
                << "---\n";
        }

        if (options.enablePodDisruptionBudget && plan.desiredReplicas > 1) {
            manifest
                << "apiVersion: policy/v1\n"
                << "kind: PodDisruptionBudget\n"
                << "metadata:\n"
                << "  name: " << sanitizeDnsLabel(svc.deploymentName + "-pdb", 63) << "\n"
                << "  namespace: " << plan.nameSpace << "\n"
                << "  labels:\n"
                << "    app.kubernetes.io/managed-by: StackPilot\n"
                << "    StackPilot.io/deployment-id: " << yamlQuote(options.deploymentId) << "\n"
                << "    StackPilot.io/compose-project: " << yamlQuote(plan.stackName) << "\n"
                << "spec:\n"
                << "  minAvailable: 1\n"
                << "  selector:\n"
                << "    matchLabels:\n"
                << "      app: " << svc.deploymentName << "\n"
                << "---\n";
        }
    }

    if (useIngress) {
        manifest
            << "apiVersion: networking.k8s.io/v1\n"
            << "kind: Ingress\n"
            << "metadata:\n"
            << "  name: " << plan.ingressName << "\n"
            << "  namespace: " << plan.nameSpace << "\n"
            << "  labels:\n"
            << "    app.kubernetes.io/managed-by: StackPilot\n"
            << "    StackPilot.io/deployment-id: " << yamlQuote(options.deploymentId) << "\n"
            << "    StackPilot.io/compose-project: " << yamlQuote(plan.stackName) << "\n";
        const bool hasAnnotations = !options.ingressClassName.empty() ||
                                    (annotations.isObject() && !annotations.empty()) ||
                                    (plan.runtimeScheme == "https" && !options.ingressTlsSecretName.empty());
        if (hasAnnotations) {
            manifest << "  annotations:\n";
            if (!options.ingressClassName.empty()) {
                manifest << "    kubernetes.io/ingress.class: " << yamlQuote(options.ingressClassName) << "\n";
            }
            if (annotations.isObject()) {
                for (const auto& key : annotations.getMemberNames()) {
                    manifest << "    " << key << ": " << yamlQuote(annotations[key].asString()) << "\n";
                }
            }
        }
        manifest
            << "spec:\n"
            << (!options.ingressClassName.empty() ? "  ingressClassName: " + options.ingressClassName + "\n" : "")
            << "  rules:\n"
            << "    - host: " << plan.ingressHost << "\n"
            << "      http:\n"
            << "        paths:\n"
            << "          - path: /\n"
            << "            pathType: Prefix\n"
            << "            backend:\n"
            << "              service:\n"
            << "                name: " << plan.primaryServiceName << "\n"
            << "                port:\n"
            << "                  number: " << details[primaryIndex].service.containerPort << "\n";
        if (plan.runtimeScheme == "https" || !options.ingressTlsSecretName.empty()) {
            manifest
                << "  tls:\n"
                << "    - hosts:\n"
                << "        - " << plan.ingressHost << "\n"
                << "      secretName: " << (!options.ingressTlsSecretName.empty()
                                               ? options.ingressTlsSecretName
                                               : sanitizeDnsLabel(plan.ingressName + "-tls", 63)) << "\n";
        }
        manifest << "---\n";
    }

    if (options.enableHorizontalPodAutoscaler && details[primaryIndex].service.containerPort > 0) {
        const std::string target = details[primaryIndex].service.deploymentName;
        manifest
            << "apiVersion: autoscaling/v2\n"
            << "kind: HorizontalPodAutoscaler\n"
            << "metadata:\n"
            << "  name: " << sanitizeDnsLabel(target + "-hpa", 63) << "\n"
            << "  namespace: " << plan.nameSpace << "\n"
            << "  labels:\n"
            << "    app.kubernetes.io/managed-by: StackPilot\n"
            << "    StackPilot.io/deployment-id: " << yamlQuote(options.deploymentId) << "\n"
            << "    StackPilot.io/compose-project: " << yamlQuote(plan.stackName) << "\n"
            << "spec:\n"
            << "  scaleTargetRef:\n"
            << "    apiVersion: apps/v1\n"
            << "    kind: Deployment\n"
            << "    name: " << target << "\n"
            << "  minReplicas: " << std::max(1, options.hpaMinReplicas) << "\n"
            << "  maxReplicas: " << std::max(options.hpaMinReplicas, options.hpaMaxReplicas) << "\n"
            << "  metrics:\n"
            << "    - type: Resource\n"
            << "      resource:\n"
            << "        name: cpu\n"
            << "        target:\n"
            << "          type: Utilization\n"
            << "          averageUtilization: " << std::max(1, options.hpaCpuUtilizationTarget) << "\n";
    }

    plan.manifest = manifest.str();
    plan.success = true;
    return plan;
}

} // namespace stackpilot
