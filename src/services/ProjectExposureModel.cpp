#include "ProjectExposure.h"
#include <regex>
#include <stdexcept>
namespace stackpilot::projectExposure {
namespace { constexpr const char* image = "cloudflare/cloudflared:2026.9.1"; constexpr const char* label = "io.stackpilot.public-deployment"; }
std::string tunnelName(const std::string& id) {
    if (!std::regex_match(id, std::regex("[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}"))) throw std::invalid_argument("Invalid deployment ID");
    return "stackpilot-tunnel-" + id;
}
Ports discoverPorts(const Json::Value& inspection, const Json::Value& snapshot, const std::string& currentUrl) {
    Ports result; const auto& bindings=inspection["NetworkSettings"]["Ports"];
    int preferred=snapshot.get("container_port",0).isInt()?snapshot.get("container_port",0).asInt():0;
    std::smatch match; int current=0;
    if(std::regex_match(currentUrl,match,std::regex("http://(localhost|127\\.0\\.0\\.1):([0-9]{1,5})/?"))) current=std::stoi(match[2].str());
    for(const auto& key:bindings.getMemberNames()) {
        if(!std::regex_match(key,match,std::regex("([0-9]{1,5})/tcp"))) continue;
        const int port=std::stoi(match[1].str()); if(port<1 || port>65535 || !bindings[key].isArray()) continue;
        for(const auto& binding:bindings[key]) {
            const auto value=binding.get("HostPort","").asString(); if(!std::regex_match(value,std::regex("[0-9]{1,5}"))) continue;
            const int host=std::stoi(value); if(host<1 || host>65535) continue;
            if(host==current) return {port,host};
            if(result.container==0 || port==preferred) result={port,host};
        }
    }
    if(result.container==0) throw std::invalid_argument("No published TCP port was found for this deployment");
    return result;
}

Json::Value tunnelSpec(const std::string& id, const std::string& target, int port, const std::string& token) {
    tunnelName(id); if(!std::regex_match(target,std::regex("[a-f0-9]{64}")) || port<1 || port>65535) throw std::invalid_argument("Invalid tunnel target");
    Json::Value spec; spec["Image"]=image;
    for(const auto* value:{"tunnel","--no-autoupdate","--no-prechecks","--protocol","http2","--metrics","127.0.0.1:20241"}) spec["Cmd"].append(value);
    if(token.empty()) { spec["Cmd"].append("--url"); spec["Cmd"].append("http://127.0.0.1:"+std::to_string(port)); }
    else { spec["Cmd"].append("run"); spec["Env"].append("TUNNEL_TOKEN="+token); }
    spec["Labels"][label]=id; spec["HostConfig"]["NetworkMode"]="container:"+target;
    spec["HostConfig"]["ReadonlyRootfs"]=true; spec["HostConfig"]["CapDrop"].append("ALL");
    spec["HostConfig"]["SecurityOpt"].append("no-new-privileges:true"); spec["HostConfig"]["Memory"]=Json::Int64(128*1024*1024);
    spec["HostConfig"]["PidsLimit"]=64; spec["HostConfig"]["RestartPolicy"]["Name"]="unless-stopped";
    spec["HostConfig"]["LogConfig"]["Type"]="json-file"; spec["HostConfig"]["LogConfig"]["Config"]["max-size"]="5m"; spec["HostConfig"]["LogConfig"]["Config"]["max-file"]="2";
    for(const auto* value:{"CMD","cloudflared","tunnel","--metrics","127.0.0.1:20241","ready"}) spec["Healthcheck"]["Test"].append(value);
    spec["Healthcheck"]["Interval"]=Json::Int64(30000000000LL); spec["Healthcheck"]["StartInterval"]=Json::Int64(1000000000);
    spec["Healthcheck"]["StartPeriod"]=Json::Int64(60000000000LL); spec["Healthcheck"]["Timeout"]=Json::Int64(2000000000); spec["Healthcheck"]["Retries"]=3;
    return spec;
}

Json::Value publicStatus(const Json::Value& snapshot, const std::string& url, const std::string& mode) {
    const auto& saved=snapshot["public_exposure"]; Json::Value result;
    for(const auto* key:{"request_id","state","requested_mode","public_url","error","requested_at","named_url"}) if(saved.isMember(key)) result[key]=saved[key];
    if(!result.isMember("state")) result["state"]="ready";
    result["runtime_url"]=url; result["runtime_exposure"]=mode;
    return result;
}

}
