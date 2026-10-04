// Unit tests for src/services/ComposeKubernetesPlanner.cpp.
//
// sanitizeDnsLabel feeds Kubernetes object names. A label that violates RFC
// 1123 does not fail fast — it fails at apply time, halfway through a
// deployment, with an error that points at the API server rather than at the
// project name the user typed.

#include "testing.h"

#include "../../../src/services/ComposeKubernetesPlanner.h"

using namespace stackpilot;

namespace {

/// RFC 1123 label: lowercase alphanumerics and '-', must start and end
/// alphanumeric, 1..63 characters.
bool isValidDnsLabel(const std::string& label) {
    if (label.empty() || label.size() > 63) return false;
    const auto alnum = [](char c) {
        return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
    };
    if (!alnum(label.front()) || !alnum(label.back())) return false;
    for (const char c : label) {
        if (!alnum(c) && c != '-') return false;
    }
    return true;
}

}  // namespace

TEST(SanitizeDnsLabel, PassesThroughAnAlreadyValidLabel) {
    EXPECT_EQ(ComposeKubernetesPlanner::sanitizeDnsLabel("web-api"), "web-api");
}

TEST(SanitizeDnsLabel, LowercasesUppercaseInput) {
    EXPECT_EQ(ComposeKubernetesPlanner::sanitizeDnsLabel("MyProject"), "myproject");
}

TEST(SanitizeDnsLabel, CollapsesRunsOfIllegalCharactersToOneDash) {
    EXPECT_EQ(ComposeKubernetesPlanner::sanitizeDnsLabel("my   ///  app"), "my-app");
}

TEST(SanitizeDnsLabel, StripsLeadingAndTrailingDashes) {
    EXPECT_EQ(ComposeKubernetesPlanner::sanitizeDnsLabel("__api__"), "api");
    EXPECT_EQ(ComposeKubernetesPlanner::sanitizeDnsLabel("---api---"), "api");
}

TEST(SanitizeDnsLabel, FallsBackWhenNothingUsableRemains) {
    // An all-symbol or non-ASCII project name must still produce a namespace.
    EXPECT_EQ(ComposeKubernetesPlanner::sanitizeDnsLabel("!!!"), "stackpilot-runtime");
    EXPECT_EQ(ComposeKubernetesPlanner::sanitizeDnsLabel(""), "stackpilot-runtime");
    EXPECT_TRUE(isValidDnsLabel(ComposeKubernetesPlanner::sanitizeDnsLabel("日本語")));
}

TEST(SanitizeDnsLabel, TruncationNeverLeavesATrailingDash) {
    // Truncating "abcdefgh-xyz" at 9 would end in '-', which Kubernetes rejects.
    const std::string label = ComposeKubernetesPlanner::sanitizeDnsLabel("abcdefgh xyz", 9);
    EXPECT_EQ(label, "abcdefgh");
    EXPECT_TRUE(isValidDnsLabel(label));
}

TEST(SanitizeDnsLabel, ClampsMaxLengthIntoTheLegalRange) {
    // maxLength is clamped to [8, 63]; a caller asking for 200 must not be able
    // to produce an over-long label.
    const std::string longName(200, 'a');
    EXPECT_EQ(ComposeKubernetesPlanner::sanitizeDnsLabel(longName, 200).size(),
              static_cast<size_t>(63));
    // ...and asking for 1 must not produce a shorter-than-legal name.
    EXPECT_EQ(ComposeKubernetesPlanner::sanitizeDnsLabel(longName, 1).size(),
              static_cast<size_t>(8));
}

TEST(SanitizeDnsLabel, DefaultMaxLengthIsRespected) {
    EXPECT_EQ(ComposeKubernetesPlanner::sanitizeDnsLabel(std::string(120, 'b')).size(),
              static_cast<size_t>(50));
}

TEST(SanitizeDnsLabel, OutputIsAlwaysAValidLabel) {
    const char* inputs[] = {
        "web-api", "MyProject", "  spaced  name  ", "1234", "-", "___",
        "UPPER_CASE_WITH_SYMBOLS!@#", "a", "tab\tand\nnewline", "a..b..c",
        "project/with/slashes", "trailing-dash-", "-leading-dash",
    };
    for (const char* input : inputs) {
        const std::string label = ComposeKubernetesPlanner::sanitizeDnsLabel(input);
        if (!isValidDnsLabel(label)) {
            STACKPILOT_FAIL(std::string("input ") + ::stackpilot::testing::show(input) +
                            " produced invalid label " +
                            ::stackpilot::testing::show(label));
        }
    }
}

TEST(JoinWarnings, EmptyListProducesEmptyString) {
    EXPECT_EQ(ComposeKubernetesPlanner::joinWarnings({}), "");
}

TEST(JoinWarnings, PrefixesAndNewlineTerminatesEachLine) {
    const std::string joined = ComposeKubernetesPlanner::joinWarnings({"first", "second"});
    EXPECT_EQ(joined, "[compose-k8s] WARNING: first\n[compose-k8s] WARNING: second\n");
}

// ─── build() ────────────────────────────────────────────────────

namespace {

Json::Value composeWithOneService() {
    Json::Value compose(Json::objectValue);
    Json::Value services(Json::objectValue);
    Json::Value web(Json::objectValue);
    web["image"] = "nginx:1.25";
    Json::Value ports(Json::arrayValue);
    ports.append("8080:80");
    web["ports"] = ports;
    services["web"] = web;
    compose["services"] = services;
    return compose;
}

ComposeKubernetesPlanOptions baseOptions() {
    ComposeKubernetesPlanOptions options;
    options.deploymentId = "dep-1";
    options.projectName = "My Project";
    options.composeProjectName = "my-project";
    options.nameSpace = "my-project";
    options.exposureMode = "nodeport";
    return options;
}

}  // namespace

TEST(PlannerBuild, RejectsAComposeFileWithNoServices) {
    Json::Value compose(Json::objectValue);
    compose["services"] = Json::Value(Json::objectValue);
    const auto plan = ComposeKubernetesPlanner::build(compose, baseOptions());
    EXPECT_FALSE(plan.success);
    EXPECT_FALSE(plan.error.empty());
}

TEST(PlannerBuild, RejectsMalformedInput) {
    const auto plan = ComposeKubernetesPlanner::build(Json::Value(Json::nullValue), baseOptions());
    EXPECT_FALSE(plan.success);
}

TEST(PlannerBuild, PlansASingleServiceStack) {
    const auto plan = ComposeKubernetesPlanner::build(composeWithOneService(), baseOptions());
    EXPECT_TRUE(plan.success);
    EXPECT_EQ(plan.services.size(), static_cast<size_t>(1));
    EXPECT_EQ(plan.services[0].serviceName, std::string("web"));
    EXPECT_EQ(plan.services[0].containerPort, 80);
    EXPECT_FALSE(plan.manifest.empty());
}

TEST(PlannerBuild, RefusesToSilentlyDiscardComposeSemantics) {
    for(const std::string key:{"depends_on","healthcheck","network_mode"}) {
        auto model=composeWithOneService();model["services"]["web"][key]=Json::Value(Json::objectValue);
        auto plan=ComposeKubernetesPlanner::build(model,baseOptions());
        EXPECT_FALSE(plan.success);EXPECT_CONTAINS(plan.error,key);
    }
    auto model=composeWithOneService();Json::Value mount;mount["type"]="bind";mount["source"]="/host";mount["target"]="/app";
    model["services"]["web"]["volumes"].append(mount);
    EXPECT_FALSE(ComposeKubernetesPlanner::build(model,baseOptions()).success);
}

TEST(PlannerBuild, EveryGeneratedNameIsAValidDnsLabel) {
    Json::Value compose(Json::objectValue);
    Json::Value services(Json::objectValue);
    for (const char* name : {"Web_API", "worker.queue", "DB"}) {
        Json::Value svc(Json::objectValue);
        svc["image"] = "busybox:latest";
        services[name] = svc;
    }
    // At least one service must publish a port, otherwise build() correctly
    // refuses the stack (there would be no preview URL to hand back).
    Json::Value ports(Json::arrayValue);
    ports.append("8080:80");
    services["Web_API"]["ports"] = ports;
    compose["services"] = services;

    auto options = baseOptions();
    options.projectName = "Ünüsual Näme!!";
    const auto plan = ComposeKubernetesPlanner::build(compose, options);
    EXPECT_TRUE(plan.success);
    EXPECT_TRUE(isValidDnsLabel(plan.nameSpace));
    for (const auto& service : plan.services) {
        EXPECT_TRUE(isValidDnsLabel(service.deploymentName));
        EXPECT_TRUE(isValidDnsLabel(service.kubernetesServiceName));
    }
}

TEST(PlannerBuild, ManifestNeverEmbedsRawEnvValuesAsUnquotedYaml) {
    // An env value like "yes" or "8080" parsed as a YAML bool/int would reach
    // the container as a different type than the user typed.
    auto options = baseOptions();
    options.envVars = {{"FEATURE_FLAG", "yes"}, {"PORT", "8080"}};
    const auto plan = ComposeKubernetesPlanner::build(composeWithOneService(), options);
    EXPECT_TRUE(plan.success);
    EXPECT_NOT_CONTAINS(plan.manifest, "value: yes\n");
    EXPECT_NOT_CONTAINS(plan.manifest, "value: 8080\n");
}

TEST(PlannerBuild, LoneServiceWithNoPortsFallsBackToTheDefaultPort) {
    // Deliberate ergonomic: a single-service Compose file that declares no
    // ports still deploys, on the platform default port, with a warning. The
    // warning is the contract — silently picking a port with no trace would
    // leave the user guessing why the preview URL is wrong.
    Json::Value compose(Json::objectValue);
    Json::Value services(Json::objectValue);
    Json::Value worker(Json::objectValue);
    worker["image"] = "busybox:latest";
    services["worker"] = worker;
    compose["services"] = services;

    auto options = baseOptions();
    options.defaultContainerPort = 3000;
    const auto plan = ComposeKubernetesPlanner::build(compose, options);
    EXPECT_TRUE(plan.success);
    EXPECT_EQ(plan.services[0].containerPort, 3000);
    EXPECT_CONTAINS(ComposeKubernetesPlanner::joinWarnings(plan.warnings), "default port");
}

TEST(PlannerBuild, MultipleServicesWithNoPortsAreRefused) {
    // The fallback above applies only when there is exactly one service. With
    // two, there is no defensible guess about which one is the front door.
    Json::Value compose(Json::objectValue);
    Json::Value services(Json::objectValue);
    for (const char* name : {"worker", "cron"}) {
        Json::Value svc(Json::objectValue);
        svc["image"] = "busybox:latest";
        services[name] = svc;
    }
    compose["services"] = services;

    const auto plan = ComposeKubernetesPlanner::build(compose, baseOptions());
    EXPECT_FALSE(plan.success);
    EXPECT_CONTAINS(plan.error, "port");
}

TEST(PlannerBuild, PrefersAConventionallyNamedServiceAsThePrimary) {
    // With no published ports anywhere, the "frontend/web/app/api/..." name
    // list decides the front door before falling back to first-wins.
    Json::Value compose(Json::objectValue);
    Json::Value services(Json::objectValue);
    for (const char* name : {"cache", "frontend"}) {
        Json::Value svc(Json::objectValue);
        svc["image"] = "busybox:latest";
        Json::Value expose(Json::arrayValue);
        expose.append("8080");
        svc["expose"] = expose;
        services[name] = svc;
    }
    compose["services"] = services;

    const auto plan = ComposeKubernetesPlanner::build(compose, baseOptions());
    EXPECT_TRUE(plan.success);
    EXPECT_CONTAINS(plan.primaryServiceName, "frontend");
}

TEST(PlannerBuild, IngressWithoutABaseDomainDowngradesToNodePort) {
    // normalizeExposure() rewrites an unsatisfiable ingress request into
    // nodeport rather than failing. A deployment that is reachable on a node
    // port beats one that refuses to start because DNS was not configured.
    auto options = baseOptions();
    options.exposureMode = "ingress";
    options.baseDomain = "";
    options.hostForNip = "";
    const auto plan = ComposeKubernetesPlanner::build(composeWithOneService(), options);
    EXPECT_TRUE(plan.success);
    EXPECT_EQ(plan.exposureMode, "nodeport");
}

TEST(PlannerBuild, IngressIsRefusedOnlyWhenExplicitlyForcedWithNoHost) {
    // allowIngressWithoutBaseDomain opts out of that downgrade, and then the
    // missing host is a hard error instead.
    auto options = baseOptions();
    options.exposureMode = "ingress";
    options.baseDomain = "";
    options.hostForNip = "";
    options.allowIngressWithoutBaseDomain = true;
    const auto plan = ComposeKubernetesPlanner::build(composeWithOneService(), options);
    EXPECT_FALSE(plan.success);
    EXPECT_CONTAINS(plan.error, "base domain");
}

TEST(PlannerBuild, ABaseDomainProducesAnIngressHost) {
    auto options = baseOptions();
    options.exposureMode = "ingress";
    options.baseDomain = "apps.example.com";
    const auto plan = ComposeKubernetesPlanner::build(composeWithOneService(), options);
    EXPECT_TRUE(plan.success);
    EXPECT_EQ(plan.exposureMode, "ingress");
    EXPECT_CONTAINS(plan.ingressHost, "apps.example.com");
}

TEST(PlannerBuild, HttpsRequiresIngress) {
    // NodePort cannot terminate TLS, so asking for an https runtime URL on a
    // NodePort stack must fail at plan time rather than produce a dead link.
    auto options = baseOptions();
    options.runtimeScheme = "https";
    options.exposureMode = "nodeport";
    const auto plan = ComposeKubernetesPlanner::build(composeWithOneService(), options);
    EXPECT_FALSE(plan.success);
    EXPECT_CONTAINS(plan.error, "Ingress");
}
