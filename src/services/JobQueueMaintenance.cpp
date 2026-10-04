// ============================================================
// JobQueueMaintenance.cpp — periodic housekeeping
// ============================================================
// Cost sampling and preview expiry, on a slow timer alongside the build
// workers. Both are the kind of work that is invisible when it runs and
// expensive when it doesn't: a preview nobody tore down is a bill, and cost
// samples that stop accruing produce a report that quietly reads zero.
//
// Separate translation unit from JobQueueService.cpp, which is already 1,789
// lines.

#include "JobQueueService.h"

#include "CostModel.h"
#include "DeploymentCleanupService.h"
#include "PreviewEnvironments.h"
#include "LocalDockerRuntime.h"
#include "../db/Database.h"
#include "../utils/StringUtils.h"

#include <chrono>
#include <pqxx/pqxx>
#include <spdlog/spdlog.h>
#include <thread>
#include <utility>
#include <vector>

namespace stackpilot {
namespace {

/// How often a sample is taken. Each sample accounts for exactly this window,
/// so a missed tick under-reports rather than inventing usage for a gap.
constexpr int kSampleWindowSeconds = 60;

int envInt(const char* name, int fallback) {
    const std::string raw = strings::getEnvOrDefault(name, "");
    if (raw.empty()) return fallback;
    try {
        const int parsed = std::stoi(raw);
        return parsed > 0 ? parsed : fallback;
    } catch (...) {
        return fallback;
    }
}

void reconcileCandidates() {
    auto connection=Database::getInstance().getConnection();pqxx::work txn(*connection);
    auto rows=txn.exec("SELECT c.job_id::text,c.attempt,c.provider,c.resource_key,c.snapshot::text FROM deployment_runtime_candidates c JOIN deployment_jobs j ON j.id=c.job_id "
        "WHERE c.status IN ('planned','promoted','cleanup_failed') AND c.created_at<NOW()-INTERVAL '3 minutes' AND (j.attempts<>c.attempt OR (j.status<>'running' AND NOT(j.status IN ('queued','retrying') AND j.metadata ? 'awaiting_runtime'))) "
        "AND NOT EXISTS(SELECT 1 FROM environment_runtime_routes r JOIN deployments d ON d.id=r.deployment_id WHERE d.remote_container_name=c.resource_key) "
        "AND NOT EXISTS(SELECT 1 FROM deployments d WHERE d.remote_container_name=c.resource_key AND d.status IN ('running','ready','deploying','paused')) "
        "ORDER BY c.created_at FOR UPDATE OF c SKIP LOCKED LIMIT 4");
    for(const auto& row:rows){
        const auto provider=row["provider"].as<std::string>();const auto resource=row["resource_key"].as<std::string>();bool cleaned=false;
        if(provider=="local_docker")cleaned=LocalDockerRuntime::removeContainer(resource,"",false).success;
        if(provider=="local_compose"){
            const auto snapshot=strings::parseJsonObject(row["snapshot"].as<std::string>());
            const auto directory=snapshot.get("compose_workdir","").asString();const auto file=snapshot.get("compose_file","").asString();
            if(!directory.empty()&&file=="compose.safe.json"){
                std::string output;cleaned=LocalDockerRuntime::run("timeout 30s docker compose -p "+strings::shellQuote(resource)+" -f "+strings::shellQuote(directory+"/"+file)+" down --remove-orphans",output)==0;
            }
        }
        txn.exec_params("UPDATE deployment_runtime_candidates SET status=$4,updated_at=NOW() WHERE job_id=$1 AND attempt=$2 AND resource_key=$3",row["job_id"].as<std::string>(),row["attempt"].as<int>(),resource,cleaned?"cleaned":"cleanup_failed");
    }
    txn.commit();
}

/// Records one cost sample for every deployment currently running.
void sampleRunningDeployments(pqxx::transaction_base& txn) {
    const ResourceRate rate = CostModel::rateCard();

    // runtime_paused deployments are excluded: a paused container releases its
    // reservation, so charging for it would overstate the bill and, worse,
    // make pausing look pointless.
    const auto rows = txn.exec(
        "SELECT d.id, d.project_id, p.organization_id, "
        "COALESCE(d.desired_replicas, 1) AS replicas, "
        "COALESCE(d.runtime_provider, '') AS runtime_provider, "
        "COALESCE(d.runtime_snapshot->>'resource_preset', 'small') AS preset, "
        "d.runtime_snapshot::text AS runtime_snapshot "
        "FROM deployments d JOIN projects p ON p.id = d.project_id "
        "WHERE d.status = 'running' AND COALESCE(d.runtime_paused, FALSE) = FALSE"
    );

    for (const auto& row : rows) {
        const std::string runtimeProvider = strings::toLower(strings::trim(
            row["runtime_provider"].is_null() ? "" : row["runtime_provider"].as<std::string>()
        ));
        const int replicas = row["replicas"].as<int>();

        ResourceShape shape{0, 0};
        long long accrued = 0;

        if (runtimeProvider == "local_docker" || runtimeProvider == "docker") {
            // Free local development
            shape = {0, 0};
            accrued = 0;
        } else {
            // Kubernetes (or fallback to presets)
            const Json::Value snapshot = strings::parseJsonObject(
                row["runtime_snapshot"].is_null() ? "" : row["runtime_snapshot"].as<std::string>()
            );

            auto extractStringOrNumber = [](const Json::Value& val) -> std::string {
                if (val.isString()) return val.asString();
                if (val.isInt() || val.isUInt()) return std::to_string(val.asInt64());
                if (val.isDouble()) return std::to_string(val.asDouble());
                return "";
            };

            std::string cpuReq;
            std::string memReq;

            if (snapshot.isMember("cpu_request")) {
                cpuReq = extractStringOrNumber(snapshot["cpu_request"]);
            } else if (snapshot.isMember("cpu")) {
                cpuReq = extractStringOrNumber(snapshot["cpu"]);
            }

            if (snapshot.isMember("memory_request")) {
                memReq = extractStringOrNumber(snapshot["memory_request"]);
            } else if (snapshot.isMember("memory")) {
                memReq = extractStringOrNumber(snapshot["memory"]);
            }

            const int customCpu = CostModel::parseCpuMillicores(cpuReq);
            const int customMem = CostModel::parseMemoryMb(memReq);

            if (customCpu > 0 || customMem > 0) {
                const ResourceShape presetShape = CostModel::shapeForPreset(row["preset"].as<std::string>());
                shape.cpuMillicores = customCpu > 0 ? customCpu : presetShape.cpuMillicores;
                shape.memoryMb = customMem > 0 ? customMem : presetShape.memoryMb;
            } else {
                shape = CostModel::shapeForPreset(row["preset"].as<std::string>());
            }

            accrued = CostModel::accrueMillicents(shape, replicas, kSampleWindowSeconds, rate);
        }

        txn.exec_params(
            "INSERT INTO deployment_cost_samples "
            "(deployment_id, project_id, organization_id, window_seconds, replicas, "
            " cpu_millicores, memory_mb, accrued_millicents) "
            "VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
            row["id"].as<std::string>(),
            row["project_id"].as<std::string>(),
            row["organization_id"].as<std::string>(),
            kSampleWindowSeconds,
            replicas,
            shape.cpuMillicores * replicas,
            shape.memoryMb * replicas,
            accrued
        );
    }
}

/// Deletes samples and drift checks past their retention window.
///
/// Without this both tables grow forever: one cost sample per running
/// deployment per minute is ~525,000 rows per deployment per year. Nothing
/// fails when that happens — the cost query just gets slower every week, which
/// is the kind of problem that gets diagnosed as "the dashboard is slow" a year
/// after the cause.
void pruneOldTelemetry(pqxx::transaction_base& txn, int retentionDays) {
    const std::string window = std::to_string(retentionDays) + " days";
    txn.exec_params(
        "DELETE FROM deployment_cost_samples WHERE sampled_at < NOW() - $1::interval", window);
    // Always keep the newest check per deployment regardless of age, so a
    // deployment nobody has touched in months still reports its last known
    // state rather than showing "never checked".
    txn.exec_params(
        "DELETE FROM deployment_drift_checks d "
        "WHERE d.checked_at < NOW() - $1::interval "
        "AND d.id <> (SELECT id FROM deployment_drift_checks n "
        "             WHERE n.deployment_id = d.deployment_id "
        "             ORDER BY n.checked_at DESC LIMIT 1)",
        window);
}

/// Flags previews past their TTL. Actual teardown is performed by
/// tearDownExpiredPreviews below; this only decides that a preview's time is up.
int expirePreviews(pqxx::transaction_base& txn) {
    const auto result = txn.exec(
        "UPDATE deployments SET status = 'pending_teardown', "
        "logs = COALESCE(logs, '') || 'Preview environment expired and was queued for teardown.' || E'\\n', "
        "updated_at = NOW() "
        "WHERE is_preview AND preview_expires_at IS NOT NULL AND preview_expires_at < NOW() "
        "AND status NOT IN ('destroyed', 'failed', 'superseded', 'pending_teardown')"
    );
    return static_cast<int>(result.affected_rows());
}

/// Actually destroys previews marked `pending_teardown`.
///
/// This is the half that was missing: the webhook and the TTL sweep both wrote
/// `pending_teardown` and nothing ever read it, so previews were marked for
/// destruction and then quietly kept running. Nothing errors in that state —
/// the row says the right thing while the container bills forever, which is
/// exactly the failure mode preview environments are notorious for.
///
/// Runs outside the maintenance transaction because cleanup shells out to
/// Docker and kubectl and can take tens of seconds per deployment.
int tearDownExpiredPreviews() {
    std::vector<std::pair<std::string, std::string>> pending;  // deploymentId, ownerUserId
    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);
        // Cleanup is access-gated, so it needs a user who can see the project.
        // The project owner always can, which keeps automated teardown inside
        // the same authorization model rather than bypassing it.
        const auto rows = txn.exec(
            "SELECT d.id, p.user_id FROM deployments d JOIN projects p ON p.id = d.project_id "
            "WHERE d.is_preview AND d.status = 'pending_teardown' LIMIT 20"
        );
        for (const auto& row : rows) {
            pending.emplace_back(row["id"].as<std::string>(), row["user_id"].as<std::string>());
        }
        txn.commit();
    } catch (const std::exception& e) {
        spdlog::warn("Could not list previews awaiting teardown: {}", e.what());
        return 0;
    }

    int destroyed = 0;
    for (const auto& [deploymentId, ownerUserId] : pending) {
        try {
            DeploymentCleanupService cleanup;
            DeploymentCleanupOptions options;
            options.deleteImage = true;
            options.deleteRemoteWorkspace = true;
            // The row is kept: a destroyed preview is still the record of what
            // that pull request cost, and deleting it would take its cost
            // samples with it via the foreign key.
            options.deleteDatabaseRow = false;

            const DeploymentCleanupResult result =
                cleanup.cleanupDeployment(ownerUserId, deploymentId, options);

            auto conn = Database::getInstance().getConnection();
            pqxx::work txn(*conn);
            if (result.success) {
                txn.exec_params(
                    "UPDATE deployments SET status = 'destroyed', runtime_url = '', updated_at = NOW(), "
                    "logs = COALESCE(logs, '') || 'Preview environment torn down.' || E'\\n' "
                    "WHERE id = $1", deploymentId);
                ++destroyed;
            } else {
                // Leave it pending so the next tick retries. A preview that
                // cannot be destroyed must keep asking rather than be marked
                // done and forgotten.
                txn.exec_params(
                    "UPDATE deployments SET updated_at = NOW(), "
                    "logs = COALESCE(logs, '') || $2 || E'\\n' WHERE id = $1",
                    deploymentId,
                    "Preview teardown attempt failed, will retry: " + result.error);
            }
            txn.commit();
        } catch (const std::exception& e) {
            spdlog::warn("Preview teardown failed for {}: {}", deploymentId, e.what());
        }
    }
    return destroyed;
}

}  // namespace

void JobQueueService::maintenanceLoop() {
    const int intervalSeconds = envInt("STACKPILOT_MAINTENANCE_INTERVAL_SECONDS", kSampleWindowSeconds);
    const int retentionDays = envInt("STACKPILOT_TELEMETRY_RETENTION_DAYS", 90);
    spdlog::info("Deployment maintenance worker online (every {}s)", intervalSeconds);

    while (running_) {
        // Sleep in short slices so shutdown does not wait out a full interval.
        for (int elapsed = 0; elapsed < intervalSeconds && running_; ++elapsed) {
            std::this_thread::sleep_for(std::chrono::seconds(1));
        }
        if (!running_) break;

        try {
            recoverInterruptedJobs();
            reconcileCandidates();
            auto conn = Database::getInstance().getConnection();
            pqxx::work txn(*conn);
            sampleRunningDeployments(txn);
            const int expired = expirePreviews(txn);
            pruneOldTelemetry(txn, retentionDays);
            txn.commit();
            if (expired > 0) {
                spdlog::info("Expired {} preview environment(s)", expired);
            }

            // Outside the transaction above: this shells out per deployment.
            const int destroyed = tearDownExpiredPreviews();
            if (destroyed > 0) {
                spdlog::info("Tore down {} preview environment(s)", destroyed);
            }
        } catch (const std::exception& e) {
            // Never fatal. Losing a sample under-reports cost slightly; killing
            // the worker would stop reporting entirely, which is far worse and
            // much harder to notice.
            spdlog::warn("Maintenance tick failed: {}", e.what());
        }
    }
}

}  // namespace stackpilot
