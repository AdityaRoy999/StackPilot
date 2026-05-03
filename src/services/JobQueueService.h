// ============================================================
// JobQueueService.h - Durable background deployment jobs
// ============================================================

#pragma once

#include <atomic>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>

#include <json/json.h>

namespace aids {

class JobQueueService {
public:
    static JobQueueService& getInstance();

    void start();
    void stop();

    Json::Value enqueueDeploymentBuild(const std::string& deploymentId,
                                       const std::string& userId,
                                       const std::string& queuedLog = "Deployment queued for background worker.");

private:
    struct DeploymentJobRecord {
        std::string id;
        std::string deploymentId;
        std::string userId;
        int attempts = 0;
        int maxAttempts = 3;
    };

    JobQueueService();
    ~JobQueueService();
    JobQueueService(const JobQueueService&) = delete;
    JobQueueService& operator=(const JobQueueService&) = delete;

    void recoverInterruptedJobs();
    void workerLoop(int workerIndex);
    std::optional<std::string> popRedisJob(int timeoutSeconds) const;
    bool pushRedisJob(const std::string& jobId) const;
    std::optional<DeploymentJobRecord> claimJob(const std::string& preferredJobId);
    std::optional<DeploymentJobRecord> claimNextDbJob();
    void executeDeploymentBuildJob(const DeploymentJobRecord& job);
    void completeJob(const DeploymentJobRecord& job);
    void failJob(const DeploymentJobRecord& job, const std::string& error, bool retryable);

    std::atomic<bool> running_{false};
    std::mutex lifecycleMutex_;
    std::vector<std::thread> workers_;
    std::string workerId_;
    std::string redisHost_;
    int redisPort_ = 6379;
    std::string redisPassword_;
    std::string queueName_;
    int workerCount_ = 2;
    int maxAttempts_ = 3;
};

} // namespace aids
