#pragma once
#include "BuildService.h"
#include <stdexcept>

namespace stackpilot::pending_runtime {
inline Json::Value snapshot(const BuildResult& build) {
    Json::Value result(Json::objectValue);
    result["version"]=1;
    result["logs"]=build.logs;result["image_name"]=build.imageName;
    result["runtime_url"]=build.runtimeUrl;result["runtime_provider"]=build.runtimeProvider;
    result["container"]=build.remoteContainerName;result["compose_project"]=build.composeProject;
    result["compose_project_name"]=build.composeProjectName;result["compose_file"]=build.composeFile;
    result["compose_workdir"]=build.composeWorkdir;result["compose_services"]=build.composeServices;
    result["deployment_plan"]=build.deploymentPlan;result["test_evidence"]=build.testEvidence;
    result["artifact_digest"]=build.artifactDigest;result["source_digest"]=build.sourceDigest;
    result["source_archive"]=build.sourceArchive;result["archetype"]=build.archetype;
    result["archetype_details"]=build.archetypeDetails;
    return result;
}
inline BuildResult restore(const Json::Value& value) {
    if(value.get("version",0).asInt()!=1 || !value["deployment_plan"].isObject() ||
       (value["runtime_provider"].asString()!="local_docker" && value["runtime_provider"].asString()!="local_compose"))
        throw std::runtime_error("Pending runtime descriptor is invalid or unsupported");
    BuildResult build;build.success=true;
    build.logs=value["logs"].asString();build.imageName=value["image_name"].asString();
    build.runtimeUrl=value["runtime_url"].asString();build.runtimeProvider=value["runtime_provider"].asString();
    build.remoteContainerName=value["container"].asString();build.composeProject=value["compose_project"].asBool();
    build.composeProjectName=value["compose_project_name"].asString();build.composeFile=value["compose_file"].asString();
    build.composeWorkdir=value["compose_workdir"].asString();build.composeServices=value["compose_services"].asString();
    build.deploymentPlan=value["deployment_plan"];build.testEvidence=value["test_evidence"];
    build.artifactDigest=value["artifact_digest"].asString();build.sourceDigest=value["source_digest"].asString();
    build.sourceArchive=value["source_archive"].asString();build.archetype=value["archetype"].asString();
    build.archetypeDetails=value["archetype_details"].asString();
    return build;
}
} // namespace stackpilot::pending_runtime
