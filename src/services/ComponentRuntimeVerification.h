#pragma once

#include "AiServiceClient.h"
#include "LocalDockerRuntime.h"
#include <json/json.h>
#include <stdexcept>

namespace stackpilot {

inline bool sameComponentIdentities(const Json::Value& identities,const Json::Value& observed) {
    if(!identities.isObject() || identities.empty() || !observed.isObject() || identities.size()!=observed.size())return false;
    for(const auto& name:identities.getMemberNames()) {
        if(!observed.isMember(name))return false;
        for(const auto& field:{"container_id","image_id","started_at","restart_count","url"})
            if(!identities[name].isMember(field) || identities[name][field]!=observed[name][field])return false;
    }
    return true;
}

inline Json::Value verifySavedComponentRuntime(const Json::Value& snapshot,const std::string& publicUrl,const std::string& deploymentId) {
    Json::Value failed;failed["verified"]=false;failed["status"]="unverified";failed["scope"]="component_contracts";
    try {
        const auto plan=LocalDockerRuntime::freshComponentContract(snapshot);
        const auto primary=plan["repository_plan"]["primary_component"].asString();
        const auto url=plan["component_runtime"]["components"][primary].get("url","").asString();
        Json::Value request;request["url"]=url;request["deployment_id"]=deploymentId;request["contract"]=plan;
        const auto checked=AiServiceClient::instance().postWorkflow("/runtime/verify",request);
        if(!checked.ok){failed["reason"]="Component verification service is unavailable";return failed;}
        if(!checked.body.get("verified",false).asBool())return checked.body;
        const auto current=LocalDockerRuntime::freshComponentContract(snapshot,false);
        if(!sameComponentIdentities(checked.body["identities"],current["component_runtime"]["components"]))
            throw std::runtime_error("Component runtime changed during verification");
        Json::Value proof=checked.body;
        if(!publicUrl.empty() && publicUrl!=url && plan.get("protocol","http").asString()=="http") {
            Json::Value transport=plan;for(const auto& key:{"repository_plan","component_contracts","component_runtime"})transport.removeMember(key);
            transport["verification_scope"]="http_contract";transport["workload"]="api";
            request["url"]=publicUrl;request["contract"]=transport;
            const auto routed=AiServiceClient::instance().postWorkflow("/runtime/verify",request);
            proof["routed_verification"]=routed.body;
            if(!routed.ok || !routed.body.get("verified",false).asBool())throw std::runtime_error("Published component route is unreachable");
        }
        return proof;
    } catch(const std::exception& error) {failed["reason"]=error.what();return failed;}
}

} // namespace stackpilot
