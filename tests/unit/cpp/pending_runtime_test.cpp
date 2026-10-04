#include "testing.h"
#include "../../../src/services/PendingRuntime.h"
using namespace stackpilot;

TEST(PendingRuntime, RetainsCandidateAndExecutionInsteadOfRebuilding) {
    BuildResult original;original.runtimeProvider="local_compose";original.composeProject=true;
    original.composeProjectName="candidate";original.composeWorkdir="/app/uploads/builds/frozen";
    original.composeFile="compose.safe.json";original.imageName="sha256:immutable";
    original.sourceDigest="source";original.artifactDigest="artifact";original.testEvidence["status"]="passed";
    original.deploymentPlan["component_contracts"]["job"]["job_execution_id"]="exact-execution";
    const auto restored=pending_runtime::restore(pending_runtime::snapshot(original));
    EXPECT_TRUE(restored.success);EXPECT_TRUE(restored.composeProject);
    EXPECT_EQ(restored.composeWorkdir,original.composeWorkdir);
    EXPECT_EQ(restored.artifactDigest,original.artifactDigest);
    EXPECT_EQ(restored.deploymentPlan["component_contracts"]["job"]["job_execution_id"].asString(),"exact-execution");
    EXPECT_EQ(restored.testEvidence["status"].asString(),"passed");
}

TEST(PendingRuntime, RejectsUnsupportedExecutorAndInvalidDescriptor) {
    for(const auto& provider:{"kubernetes","remote_docker",""}) {
        Json::Value data;data["version"]=1;data["runtime_provider"]=provider;
        data["deployment_plan"]=Json::Value(Json::objectValue);
        bool rejected=false;
        try{pending_runtime::restore(data);}catch(const std::exception&){rejected=true;}
        EXPECT_TRUE(rejected);
    }
    Json::Value data;data["runtime_provider"]="local_docker";data["deployment_plan"]=Json::Value(Json::objectValue);
    bool rejected=false;try{pending_runtime::restore(data);}catch(const std::exception&){rejected=true;}
    EXPECT_TRUE(rejected);
}
