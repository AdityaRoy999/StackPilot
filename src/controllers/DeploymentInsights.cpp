// ============================================================
// DeploymentInsights.cpp — drift and cost handlers
// ============================================================
// Members of DeploymentController, deliberately in their own translation unit.
// The controller was just cut from 4,400 lines to 3,900 and adding two more
// features to it would undo that. C++ lets members be defined across files;
// there is no reason a controller has to be one.

#include "DeploymentController.h"

#include "../db/Database.h"
#include "../services/CostModel.h"
#include "../services/DriftDetector.h"
#include "../services/KubernetesService.h"
#include "../services/LocalDockerRuntime.h"
#include "../services/ComponentRuntimeVerification.h"
#include "../services/AiServiceClient.h"
#include "../services/ReleaseCheckpointService.h"
#include "../utils/BlockingTaskRunner.h"
#include "../utils/JwtHelper.h"
#include "../utils/StringUtils.h"

#include "LogWebSocketController.h"
#include "../services/DeploymentJournal.h"

#include <algorithm>
#include <json/json.h>
#include <pqxx/pqxx>
#include <regex>
#include <spdlog/spdlog.h>
#include <sstream>

namespace stackpilot {
namespace {

drogon::HttpResponsePtr errorResponse(drogon::HttpStatusCode status, const std::string& message) {
    Json::Value err;
    err["error"] = message;
    auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
    resp->setStatusCode(status);
    return resp;
}

}  // namespace

void DeploymentController::checkDrift(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& deploymentId
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        callback(errorResponse(drogon::k401Unauthorized, "Unauthorized"));
        return;
    }

    // Inspecting a runtime shells out to kubectl or docker; that must not run
    // on a Drogon event-loop thread.
    BlockingTaskRunner::run([deploymentId, userId, callback = std::move(callback)]() mutable {
        try {
            auto conn = Database::getInstance().getConnection();
            pqxx::work txn(*conn);
            auto rows = txn.exec_params(
                "SELECT d.id, d.desired_replicas, d.image_name, d.k8s_namespace, d.k8s_deployment_name, "
                "d.k8s_service_name, d.runtime_exposure, d.runtime_url, d.runtime_provider, "
                "d.remote_container_name, d.status "
                "FROM deployments d JOIN projects p ON p.id = d.project_id "
                "WHERE d.id = $1 AND has_project_access(p.id, $2)",
                deploymentId, userId
            );
            if (rows.empty()) {
                txn.commit();
                callback(errorResponse(drogon::k404NotFound, "Deployment not found"));
                return;
            }

            const auto& row = rows[0];
            const auto text = [&row](const char* key) -> std::string {
                return row[key].is_null() ? std::string() : row[key].as<std::string>();
            };

            Json::Value desired(Json::objectValue);
            desired["replicas"] = row["desired_replicas"].is_null() ? 1 : row["desired_replicas"].as<int>();
            desired["image"] = text("image_name");
            desired["namespace"] = text("k8s_namespace");
            desired["deployment_name"] = text("k8s_deployment_name");
            desired["service_name"] = text("k8s_service_name");
            desired["exposure"] = text("runtime_exposure");
            desired["runtime_url"] = text("runtime_url");

            const std::string provider = text("runtime_provider");
            const std::string nameSpace = text("k8s_namespace");
            const std::string deploymentName = text("k8s_deployment_name");

            // Left null when the runtime cannot be read. DriftDetector reports
            // that as `unreachable` rather than as a clean check.
            Json::Value observed;

            if (provider == "kubernetes" && !nameSpace.empty() && !deploymentName.empty()) {
                KubernetesService kubernetes;
                const KubernetesRuntimeInfo live = kubernetes.inspect(
                    nameSpace, deploymentName, text("k8s_service_name"), text("runtime_exposure"));
                if (live.success) {
                    observed = Json::Value(Json::objectValue);
                    observed["replicas"] = live.readyReplicas;
                    observed["namespace"] = live.nameSpace;
                    observed["deployment_name"] = live.deploymentName;
                    observed["service_name"] = live.serviceName;
                    observed["exposure"] = live.exposureMode;
                    observed["runtime_url"] = live.runtimeUrl;
                    // Replica counts always diverge mid-rollout. Saying so
                    // downgrades the finding instead of paging someone about
                    // a deploy that is working exactly as intended.
                    observed["rolling_out"] =
                        live.readyReplicas != live.desiredReplicas && live.status == "progressing";
                }
            } else if (provider == "local_docker") {
                const std::string container = text("remote_container_name");
                if (!container.empty()) {
                    std::string output;
                    const std::string format =
                        std::string("--format 'running={{.State.Running}}") + "\n" + "image={{.Config.Image}}'";
                    const int exitCode = LocalDockerRuntime::run(
                        "docker inspect " + format + " " + strings::shellQuote(container) + " 2>/dev/null",
                        output);
                    if (exitCode == 0 && !output.empty()) {
                        observed = Json::Value(Json::objectValue);
                        observed["replicas"] =
                            LocalDockerRuntime::markerValue(output, "running") == "true" ? 1 : 0;
                        observed["image"] = LocalDockerRuntime::markerValue(output, "image");
                    }
                }
            }

            const DriftReport report = DriftDetector::compare(desired, observed);

            // Record every check, including clean ones. Without that, a
            // detector that silently stopped running looks the same as a
            // cluster that never drifts.
            txn.exec_params(
                "INSERT INTO deployment_drift_checks (deployment_id, status, findings, summary) "
                "VALUES ($1, $2, $3::jsonb, $4)",
                deploymentId, report.status, strings::compactJson(report.findings), report.summary
            );
            txn.commit();

            Json::Value body;
            body["deployment_id"] = deploymentId;
            body["status"] = report.status;
            body["drifted"] = report.drifted();
            body["summary"] = report.summary;
            body["findings"] = report.findings;
            body["desired"] = desired;
            body["observed"] = observed.isNull() ? Json::Value(Json::objectValue) : observed;
            callback(drogon::HttpResponse::newHttpJsonResponse(body));
        } catch (const std::exception& e) {
            spdlog::error("checkDrift failed for {}: {}", deploymentId, e.what());
            callback(errorResponse(drogon::k500InternalServerError, "Failed to check drift"));
        }
    });
}

void DeploymentController::getCostReport(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        callback(errorResponse(drogon::k401Unauthorized, "Unauthorized"));
        return;
    }

    int days = 30;
    const std::string requested = req->getParameter("days");
    if (!requested.empty()) {
        try {
            days = std::clamp(std::stoi(requested), 1, 365);
        } catch (...) {
            days = 30;
        }
    }

    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);

        // has_project_access does the scoping, so this reports across the whole
        // organization for a member and only their own work for a solo user,
        // without the handler knowing which case it is in.
        auto rows = txn.exec_params(
            "SELECT p.id AS project_id, p.name AS project_name, "
            "COALESCE(SUM(c.accrued_millicents), 0)::bigint AS total_millicents, "
            "COALESCE(SUM(CASE WHEN d.is_preview THEN c.accrued_millicents ELSE 0 END), 0)::bigint "
            "  AS preview_millicents, "
            "COUNT(DISTINCT c.deployment_id)::int AS deployments "
            "FROM projects p "
            "LEFT JOIN deployment_cost_samples c "
            "  ON c.project_id = p.id AND c.sampled_at > NOW() - ($2 || ' days')::interval "
            "LEFT JOIN deployments d ON d.id = c.deployment_id "
            "WHERE has_project_access(p.id, $1) "
            "GROUP BY p.id, p.name ORDER BY total_millicents DESC",
            userId, std::to_string(days)
        );
        txn.commit();

        Json::Value projects(Json::arrayValue);
        long long total = 0;
        long long previewTotal = 0;
        for (const auto& row : rows) {
            const long long amount = row["total_millicents"].as<long long>();
            const long long preview = row["preview_millicents"].as<long long>();
            total += amount;
            previewTotal += preview;

            Json::Value entry(Json::objectValue);
            entry["project_id"] = row["project_id"].as<std::string>();
            entry["project_name"] = row["project_name"].as<std::string>();
            entry["millicents"] = Json::Int64(amount);
            entry["formatted"] = CostModel::formatMillicents(amount);
            entry["preview_millicents"] = Json::Int64(preview);
            entry["preview_formatted"] = CostModel::formatMillicents(preview);
            entry["deployments"] = row["deployments"].as<int>();
            projects.append(entry);
        }

        Json::Value body;
        body["window_days"] = days;
        body["total_millicents"] = Json::Int64(total);
        body["total_formatted"] = CostModel::formatMillicents(total);
        // Preview spend is broken out because it is the line people are
        // surprised by: an environment nobody remembers opening.
        body["preview_millicents"] = Json::Int64(previewTotal);
        body["preview_formatted"] = CostModel::formatMillicents(previewTotal);
        body["projects"] = projects;
        body["note"] = "Attribution is derived from requested resources, not observed usage. "
                       "A reservation costs the cluster whether or not it is used.";
        callback(drogon::HttpResponse::newHttpJsonResponse(body));
    } catch (const std::exception& e) {
        spdlog::error("getCostReport failed: {}", e.what());
        callback(errorResponse(drogon::k500InternalServerError, "Failed to build cost report"));
    }
}

void DeploymentController::getRootCauseAnalysis(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& deploymentId
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        callback(errorResponse(drogon::k401Unauthorized, "Unauthorized"));
        return;
    }

    BlockingTaskRunner::run([deploymentId, userId, callback = std::move(callback)]() mutable {
        try {
            auto conn = Database::getInstance().getConnection();
            pqxx::work txn(*conn);
            auto rows = txn.exec_params(
                "SELECT d.id, d.project_id, d.status, COALESCE(d.logs, '') AS logs, "
                "COALESCE(d.runtime_snapshot::text, '{}') AS runtime_snapshot, "
                "COALESCE(d.image_name, '') AS image_name, p.name AS project_name "
                "FROM deployments d JOIN projects p ON p.id = d.project_id "
                "WHERE d.id = $1 AND has_project_access(p.id, $2)",
                deploymentId, userId
            );
            if (rows.empty()) {
                txn.commit();
                callback(errorResponse(drogon::k404NotFound, "Deployment not found"));
                return;
            }
            txn.commit();

            const auto& row = rows[0];
            const std::string status = row["status"].as<std::string>();
            const std::string logs = row["logs"].as<std::string>();
            const std::string snapshotStr = row["runtime_snapshot"].as<std::string>();

            Json::Value snapshot;
            Json::CharReaderBuilder readerBuilder;
            std::string errs;
            std::istringstream sStream(snapshotStr);
            Json::parseFromStream(readerBuilder, sStream, &snapshot, &errs);

            std::string archetype = snapshot.isMember("archetype") ? snapshot["archetype"].asString() : "";
            std::string archetypeDetails = snapshot.isMember("archetype_details") ? snapshot["archetype_details"].asString() : "";
            Json::Value detectedSubservices = snapshot.isMember("detected_subservices") ? snapshot["detected_subservices"] : Json::Value(Json::arrayValue);

            Json::Value rca(Json::objectValue);
            rca["deployment_id"] = deploymentId;
            rca["status"] = status;
            rca["archetype"] = archetype;
            rca["detected_subservices"] = detectedSubservices;

            Json::Value analysis(Json::objectValue);

            // 1. Check Archetype first
            if (archetype == "native_ios") {
                analysis["category"] = "UNSUPPORTED_ARCHETYPE";
                analysis["confidence"] = 99;
                analysis["title"] = "Native iOS Xcode Project Detected";
                analysis["summary"] = archetypeDetails.empty()
                    ? "StackPilot Linux build nodes cannot build native macOS/iOS Xcode projects (.xcodeproj / .xcworkspace)."
                    : archetypeDetails;
                analysis["culprit_file"] = "Xcode Project";
                analysis["can_auto_repair"] = false;
                analysis["repair_action"] = "divert_subservice";
                Json::Value steps(Json::arrayValue);
                steps.append("Deploy the backend API sub-directory if this is a mobile client/server repository.");
                steps.append("Build the iOS native IPA using GitHub Actions macOS runner or Xcode Cloud.");
                analysis["remediation_steps"] = steps;
            } else if (archetype == "native_android") {
                analysis["category"] = "MOBILE_DIVERSION";
                analysis["confidence"] = 96;
                analysis["title"] = "Native Android Gradle Application";
                analysis["summary"] = archetypeDetails.empty()
                    ? "Native Android application detected. StackPilot builds the debug APK and serves an install portal with a mobile QR code."
                    : archetypeDetails;
                analysis["culprit_file"] = "build.gradle / AndroidManifest.xml";
                analysis["can_auto_repair"] = true;
                analysis["repair_action"] = "android_apk_download_server";
                Json::Value steps(Json::arrayValue);
                steps.append("Compile debug APK using Gradle wrapper.");
                steps.append("Host APK on port 3000 with dynamic scan-to-install QR code for physical phone testing.");
                analysis["remediation_steps"] = steps;
            } else if (archetype == "windows_desktop_exe") {
                analysis["category"] = "DESKTOP_GUI_STREAM";
                analysis["confidence"] = 98;
                analysis["title"] = "Windows Desktop Application (.exe / Win32)";
                analysis["summary"] = archetypeDetails.empty()
                    ? "Windows executable detected. StackPilot generates a containerized Wine virtual desktop with an interactive HTML5 web stream."
                    : archetypeDetails;
                analysis["culprit_file"] = ".exe / .sln";
                analysis["can_auto_repair"] = true;
                analysis["repair_action"] = "wine_novnc_web_stream";
                Json::Value steps(Json::arrayValue);
                steps.append("Package application into Wine 64/32 virtual framebuffer container with Openbox.");
                steps.append("Stream graphical desktop over WebSockets and noVNC on port 3000.");
                analysis["remediation_steps"] = steps;
            } else if (archetype == "java_web") {
                analysis["category"] = "JAVA_APPLICATION";
                analysis["confidence"] = 96;
                analysis["title"] = "Java Web Application (Spring Boot / Maven / Gradle)";
                analysis["summary"] = archetypeDetails.empty()
                    ? "Java application detected. Deploying with Eclipse Temurin Java 21 runtime on port 3000."
                    : archetypeDetails;
                analysis["culprit_file"] = "pom.xml / build.gradle";
                analysis["can_auto_repair"] = true;
                analysis["repair_action"] = "build_spring_boot";
                Json::Value steps(Json::arrayValue);
                steps.append("Compile fat JAR with Maven or Gradle wrapper.");
                steps.append("Run with -Dserver.port=3000 in minimal Temurin JRE container.");
                analysis["remediation_steps"] = steps;
            } else if (archetype == "library") {
                analysis["category"] = "UNSUPPORTED_ARCHETYPE";
                analysis["confidence"] = 95;
                analysis["title"] = "Non-Runnable Library / SDK Detected";
                analysis["summary"] = archetypeDetails.empty()
                    ? "This repository is a library or SDK without a runnable web application entrypoint (e.g. Express, FastAPI)."
                    : archetypeDetails;
                analysis["culprit_file"] = "package.json / setup.py";
                analysis["can_auto_repair"] = false;
                analysis["repair_action"] = "add_web_entrypoint";
                Json::Value steps(Json::arrayValue);
                steps.append("Add a web server entrypoint script (e.g. index.js with express, or app.py with fastapi).");
                steps.append("Specify a 'start' script in package.json that starts an HTTP server.");
                analysis["remediation_steps"] = steps;
            } else if (archetype == "expo_react_native") {
                analysis["category"] = "MOBILE_DIVERSION";
                analysis["confidence"] = 95;
                analysis["title"] = "Expo / React Native Mobile App";
                analysis["summary"] = "Expo application detected. Can be previewed directly on the web using StackPilot's Smart Mobile Simulator.";
                analysis["culprit_file"] = "app.json";
                analysis["can_auto_repair"] = true;
                analysis["repair_action"] = "expo_web_preview";
                Json::Value steps(Json::arrayValue);
                steps.append("Run web preview container via 'npx expo export --platform web'.");
                steps.append("Preview in the StackPilot Mobile Device Frame or scan QR code on physical device.");
                analysis["remediation_steps"] = steps;
            } else if (archetype == "flutter_mobile") {
                analysis["category"] = "MOBILE_DIVERSION";
                analysis["confidence"] = 95;
                analysis["title"] = "Flutter Mobile App";
                analysis["summary"] = "Flutter application detected. Can be compiled to web preview container.";
                analysis["culprit_file"] = "pubspec.yaml";
                analysis["can_auto_repair"] = true;
                analysis["repair_action"] = "flutter_web_preview";
                Json::Value steps(Json::arrayValue);
                steps.append("Build Flutter Web preview container.");
                steps.append("Preview in the StackPilot Mobile Device Frame.");
                analysis["remediation_steps"] = steps;
            } else {
                // 2. Scan log patterns for Root Cause
                std::smatch match;
                if (std::regex_search(logs, match, std::regex(R"(Cannot find module ['"]([^'"]+)['"])"))) {
                    std::string pkg = match[1].str();
                    analysis["category"] = "MISSING_DEPENDENCY";
                    analysis["confidence"] = 96;
                    analysis["title"] = "Missing NPM Dependency: " + pkg;
                    analysis["summary"] = "The application build failed because module '" + pkg + "' was imported but is missing from package.json.";
                    analysis["culprit_file"] = "package.json";
                    analysis["culprit_item"] = pkg;
                    analysis["can_auto_repair"] = true;
                    analysis["repair_action"] = "auto_patch";
                    Json::Value steps(Json::arrayValue);
                    steps.append("Add \"" + pkg + "\" to dependencies in package.json.");
                    steps.append("Run 'npm install' or trigger autonomous AI SRE repair.");
                    analysis["remediation_steps"] = steps;
                } else if (std::regex_search(logs, match, std::regex(R"(ModuleNotFoundError: No module named ['"]([^'"]+)['"])"))) {
                    std::string pkg = match[1].str();
                    analysis["category"] = "MISSING_DEPENDENCY";
                    analysis["confidence"] = 96;
                    analysis["title"] = "Missing Python Package: " + pkg;
                    analysis["summary"] = "The Python application failed to start because module '" + pkg + "' is not installed in the environment.";
                    analysis["culprit_file"] = "requirements.txt";
                    analysis["culprit_item"] = pkg;
                    analysis["can_auto_repair"] = true;
                    analysis["repair_action"] = "auto_patch";
                    Json::Value steps(Json::arrayValue);
                    steps.append("Add \"" + pkg + "\" to requirements.txt.");
                    steps.append("Rebuild container with the missing requirement.");
                    analysis["remediation_steps"] = steps;
                } else if (logs.find("npm ERR! ERESOLVE") != std::string::npos || logs.find("Could not resolve dependency") != std::string::npos) {
                    analysis["category"] = "LOCKFILE_CONFLICT";
                    analysis["confidence"] = 94;
                    analysis["title"] = "NPM Peer Dependency Conflict";
                    analysis["summary"] = "npm failed with ERESOLVE peer dependency resolution conflict.";
                    analysis["culprit_file"] = "package.json";
                    analysis["can_auto_repair"] = true;
                    analysis["repair_action"] = "auto_patch";
                    Json::Value steps(Json::arrayValue);
                    steps.append("Use 'npm install --legacy-peer-deps' in the Dockerfile build step.");
                    steps.append("Or update package versions to satisfy mutual peer dependencies.");
                    analysis["remediation_steps"] = steps;
                } else if (logs.find("address already in use") != std::string::npos || logs.find("EADDRINUSE") != std::string::npos || logs.find("port is already allocated") != std::string::npos) {
                    analysis["category"] = "PORT_BIND_CONFLICT";
                    analysis["confidence"] = 96;
                    analysis["title"] = "Port Binding Conflict";
                    analysis["summary"] = "The target listening port is already bound by another container or process.";
                    analysis["culprit_file"] = "PORT / Dockerfile";
                    analysis["can_auto_repair"] = true;
                    analysis["repair_action"] = "reallocate_port";
                    Json::Value steps(Json::arrayValue);
                    steps.append("Change container port in Deployment configuration or release the conflicting host port.");
                    analysis["remediation_steps"] = steps;
                } else if (logs.find("exit code 137") != std::string::npos || logs.find("OOMKilled") != std::string::npos || logs.find("Out of memory: Kill process") != std::string::npos) {
                    analysis["category"] = "OOM_KILL";
                    analysis["confidence"] = 95;
                    analysis["title"] = "Out of Memory (OOM Killer Invoked)";
                    analysis["summary"] = "The process exceeded container memory limits and was killed with SIGKILL (Exit code 137).";
                    analysis["culprit_file"] = "Resource Preset / Memory Limit";
                    analysis["can_auto_repair"] = true;
                    analysis["repair_action"] = "increase_memory";
                    Json::Value steps(Json::arrayValue);
                    steps.append("Increase deployment resource preset (e.g. from 'small' 512MB to 'medium' 2GB).");
                    steps.append("Optimize application memory usage and node options (e.g. --max-old-space-size).");
                    analysis["remediation_steps"] = steps;
                } else if (logs.find("docker build timed out") != std::string::npos || logs.find("exit code 124") != std::string::npos) {
                    analysis["category"] = "BUILD_TIMEOUT";
                    analysis["confidence"] = 95;
                    analysis["title"] = "Build Timed Out";
                    analysis["summary"] = "The container build step exceeded the maximum allowable execution timeout.";
                    analysis["culprit_file"] = "Dockerfile";
                    analysis["can_auto_repair"] = false;
                    analysis["repair_action"] = "optimize_build";
                    Json::Value steps(Json::arrayValue);
                    steps.append("Separate dependency caching (COPY package*.json before COPY .).");
                    steps.append("Increase STACKPILOT_BACKEND_BUILD_TIMEOUT if compiling large assets.");
                    analysis["remediation_steps"] = steps;
                } else if (logs.find("dockerfile parse error") != std::string::npos || logs.find("unknown instruction") != std::string::npos) {
                    analysis["category"] = "DOCKERFILE_SYNTAX_ERROR";
                    analysis["confidence"] = 92;
                    analysis["title"] = "Dockerfile Syntax Error";
                    analysis["summary"] = "Docker daemon failed parsing instructions in Dockerfile.";
                    analysis["culprit_file"] = "Dockerfile";
                    analysis["can_auto_repair"] = true;
                    analysis["repair_action"] = "auto_patch";
                    Json::Value steps(Json::arrayValue);
                    steps.append("Validate Dockerfile syntax and instruction arguments.");
                    analysis["remediation_steps"] = steps;
                } else if (logs.find("Connection refused") != std::string::npos || logs.find("ECONNREFUSED") != std::string::npos) {
                    analysis["category"] = "DATABASE_CONNECTION_REFUSED";
                    analysis["confidence"] = 90;
                    analysis["title"] = "Database Connection Refused";
                    analysis["summary"] = "The application failed connecting to an external service or database.";
                    analysis["culprit_file"] = "Environment Variables (.env)";
                    analysis["can_auto_repair"] = false;
                    analysis["repair_action"] = "check_env";
                    Json::Value steps(Json::arrayValue);
                    steps.append("Verify DATABASE_URL, DB_HOST, and DB_PORT in environment variables.");
                    steps.append("Ensure the database server is running and accessible over the network.");
                    analysis["remediation_steps"] = steps;
                } else if (status == "failed") {
                    analysis["category"] = "GENERAL_BUILD_FAILURE";
                    analysis["confidence"] = 75;
                    analysis["title"] = "Build or Compilation Error";
                    analysis["summary"] = "The deployment build command exited with a non-zero status.";
                    analysis["culprit_file"] = "Build Log";
                    analysis["can_auto_repair"] = true;
                    analysis["repair_action"] = "ai_repair";
                    Json::Value steps(Json::arrayValue);
                    steps.append("Check the latest build logs for stack traces.");
                    steps.append("Click 'Fix with AI' to trigger autonomous code & config repair.");
                    analysis["remediation_steps"] = steps;
                } else {
                    analysis["category"] = "HEALTHY_OR_RUNNING";
                    analysis["confidence"] = 100;
                    analysis["title"] = "Deployment Healthy";
                    analysis["summary"] = "No critical build or runtime failure patterns detected.";
                    analysis["culprit_file"] = "";
                    analysis["can_auto_repair"] = false;
                    analysis["repair_action"] = "none";
                    Json::Value steps(Json::arrayValue);
                    steps.append("Deployment is running as expected.");
                    analysis["remediation_steps"] = steps;
                }
            }

            rca["rca"] = analysis;
            callback(drogon::HttpResponse::newHttpJsonResponse(rca));
        } catch (const std::exception& e) {
            spdlog::error("getRootCauseAnalysis failed for {}: {}", deploymentId, e.what());
            callback(errorResponse(drogon::k500InternalServerError, "Failed to analyze root cause"));
        }
    });
}

void DeploymentController::rollbackDeployment(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& deploymentId
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        callback(errorResponse(drogon::k401Unauthorized, "Unauthorized"));
        return;
    }

    BlockingTaskRunner::run([deploymentId, userId, req, callback = std::move(callback), this]() mutable {
        try {
            auto conn = Database::getInstance().getConnection();
            pqxx::work txn(*conn);

            // 1. Fetch current deployment info
            auto currentRows = txn.exec_params(
                "SELECT d.id, d.project_id, d.environment_id, d.runtime_provider, d.runtime_exposure, "
                "COALESCE(d.runtime_snapshot::text, '{}') AS runtime_snapshot "
                "FROM deployments d JOIN projects p ON p.id = d.project_id "
                "WHERE d.id = $1 AND has_project_access(p.id, $2, 'admin')",
                deploymentId, userId
            );
            if (currentRows.empty()) {
                txn.commit();
                callback(errorResponse(drogon::k404NotFound, "Deployment not found or insufficient admin permissions"));
                return;
            }

            const auto& curRow = currentRows[0];
            const std::string projectId = curRow["project_id"].as<std::string>();
            const std::string envId = curRow["environment_id"].is_null() ? "" : curRow["environment_id"].as<std::string>();
            const std::string provider = curRow["runtime_provider"].is_null() ? "" : curRow["runtime_provider"].as<std::string>();

            // If it's Kubernetes, delegate directly to the k8s rollback engine
            if (provider == "kubernetes" || provider == "remote_kubernetes") {
                txn.commit();
                rollbackKubernetesDeployment(req, std::move(callback), deploymentId);
                return;
            }

            // 2. Find previous healthy deployment in the same project & environment
            if(provider=="local_docker"){
                const auto restored=ReleaseCheckpointService::rollbackLocal(deploymentId,userId);
                if(restored.get("success",false).asBool()){
                    txn.commit();const auto owner=restored["restored_deployment_id"].asString();
                    LogWebSocketController::broadcastStatus(owner,"running");DeploymentJournal::broadcastSummary(owner);
                    callback(drogon::HttpResponse::newHttpJsonResponse(restored));return;
                }
            }
            auto prevRows = txn.exec_params(
                "SELECT d.id, d.image_name, d.runtime_url, d.remote_container_name, "
                "d.runtime_snapshot::text AS runtime_snapshot, d.status "
                "FROM deployments d "
                "WHERE d.project_id = $1 "
                "AND ($2 = '' OR d.environment_id = NULLIF($2, '')::uuid) "
                "AND d.id <> $3 "
                "AND d.status = 'running' AND d.runtime_provider = $4 "
                "AND d.artifact_available = TRUE "
                "ORDER BY d.created_at DESC LIMIT 1",
                projectId, envId, deploymentId, provider
            );

            if (prevRows.empty()) {
                txn.commit();
                callback(errorResponse(drogon::k400BadRequest, "No previous healthy deployment checkpoint found to roll back to"));
                return;
            }

            const auto& prev = prevRows[0];
            const std::string prevId = prev["id"].as<std::string>();
            const std::string prevImage = prev["image_name"].is_null() ? "" : prev["image_name"].as<std::string>();
            const std::string prevUrl = prev["runtime_url"].is_null() ? "" : prev["runtime_url"].as<std::string>();
            const std::string prevContainer = prev["remote_container_name"].is_null() ? "" : prev["remote_container_name"].as<std::string>();
            const std::string prevSnapshot = prev["runtime_snapshot"].is_null() ? "{}" : prev["runtime_snapshot"].as<std::string>();

            // This path reuses an existing runtime; it does not start the old
            // image. Never promote a built-only or stale checkpoint as healthy.
            Json::Value probe; probe["url"] = prevUrl;
            Json::Value saved;
            {Json::CharReaderBuilder reader;std::string errors;std::istringstream input(prevSnapshot);
             if(Json::parseFromStream(reader,input,&saved,&errors))probe["contract"]=saved["deployment_plan"];}
            AiServiceResult verification;
            if(saved["deployment_plan"]["repository_plan"].isObject() && saved.isMember("compose_project")) {
                verification.body=verifySavedComponentRuntime(saved,prevUrl,prevId);verification.ok=true;
            } else verification=AiServiceClient::instance().postWorkflow("/runtime/verify", probe);
            if (!verification.ok || !verification.body.get("verified", false).asBool()) {
                txn.commit();
                callback(errorResponse(drogon::k502BadGateway, "Previous runtime is not browser-verified; rollback was not performed"));
                return;
            }

            // A runtime has exactly one deployment owner. Restore the existing owner.
            if (!envId.empty()) {
                txn.exec_params("UPDATE project_environments SET current_deployment_id=$1,updated_at=NOW() WHERE id=$2", prevId, envId);
            }
            txn.commit();

            LogWebSocketController::broadcastStatus(prevId, "running");
            DeploymentJournal::broadcastSummary(prevId);

            Json::Value res;
            res["success"] = true;
            res["message"] = "Reused the browser-verified running runtime from deployment " + prevId;
            res["verification"] = verification.body;
            res["restored_deployment_id"] = prevId;
            res["restored_image"] = prevImage;
            res["runtime_url"] = prevUrl;
            callback(drogon::HttpResponse::newHttpJsonResponse(res));
        } catch (const std::exception& e) {
            spdlog::error("rollbackDeployment failed for {}: {}", deploymentId, e.what());
            callback(errorResponse(drogon::k500InternalServerError, "Failed to perform rollback"));
        }
    });
}

}  // namespace stackpilot
