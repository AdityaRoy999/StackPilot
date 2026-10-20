#include "ProjectExposure.h"
#include "../db/Database.h"
#include "../utils/BlockingTaskRunner.h"
#include "../utils/StringUtils.h"
#include "../utils/TokenCrypto.h"
#include <drogon/drogon.h>
#include <curl/curl.h>
#include <openssl/sha.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <ctime>
#include <iomanip>
#include <memory>
#include <mutex>
#include <regex>
#include <set>
#include <sstream>
#include <stdexcept>
#include <unordered_map>

namespace stackpilot::projectExposure {
namespace {
constexpr const char* image = "cloudflare/cloudflared:2026.9.1";
constexpr const char* label = "io.stackpilot.public-deployment";
struct Http { long code = 0; std::string body; };
struct Control {
    std::atomic<bool> stopped{false}, pulling{false};
    std::mutex mutex;
    std::set<std::string> active;
    std::unordered_map<std::string, std::weak_ptr<std::mutex>> locks;
    std::string pullError;
};
std::shared_ptr<Control> control() { static auto value = std::make_shared<Control>(); return value; }
std::shared_ptr<std::mutex> lockFor(const std::shared_ptr<Control>& c, const std::string& id) {
    std::lock_guard<std::mutex> guard(c->mutex);
    auto value = c->locks[id].lock();
    if (!value) { value = std::make_shared<std::mutex>(); c->locks[id] = value; }
    return value;
}
Json::Value parse(const std::string& body) {
    Json::Value out; Json::CharReaderBuilder builder; std::string errors;
    std::istringstream stream(body); Json::parseFromStream(builder, stream, &out, &errors); return out;
}
std::string json(const Json::Value& value) { Json::StreamWriterBuilder writer; writer["indentation"]=""; return Json::writeString(writer,value); }
size_t receive(char* bytes, size_t size, size_t count, void* context) {
    auto& body = *static_cast<std::string*>(context); const auto length = size * count;
    if (body.size() + length > 1024 * 1024) return 0;
    body.append(bytes, length); return length;
}
Http request(const std::string& method, const std::string& path, const Json::Value& body = Json::nullValue, long timeout = 3000) {
    Http out; std::unique_ptr<CURL, decltype(&curl_easy_cleanup)> curl(curl_easy_init(), curl_easy_cleanup);
    if (!curl) return out;
    const bool publicProbe = method == "HEAD";
    const auto url = publicProbe ? path : "http://localhost" + path;
    const auto payload = body.isNull() ? "" : json(body);
    curl_easy_setopt(curl.get(), CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl.get(), CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(curl.get(), CURLOPT_CONNECTTIMEOUT_MS, std::min(3000L, timeout));
    curl_easy_setopt(curl.get(), CURLOPT_TIMEOUT_MS, timeout);
    curl_easy_setopt(curl.get(), CURLOPT_WRITEFUNCTION, receive);
    curl_easy_setopt(curl.get(), CURLOPT_WRITEDATA, &out.body);
    if (!publicProbe) { curl_easy_setopt(curl.get(), CURLOPT_UNIX_SOCKET_PATH, "/var/run/docker.sock"); curl_easy_setopt(curl.get(), CURLOPT_PROXY, ""); }
    if (publicProbe) curl_easy_setopt(curl.get(), CURLOPT_NOBODY, 1L);
    else curl_easy_setopt(curl.get(), CURLOPT_CUSTOMREQUEST, method.c_str());
    struct curl_slist* headers = nullptr;
    if (method == "POST") {
        headers = curl_slist_append(headers, "Content-Type: application/json");
        curl_easy_setopt(curl.get(), CURLOPT_HTTPHEADER, headers);
        curl_easy_setopt(curl.get(), CURLOPT_POSTFIELDS, payload.c_str());
        curl_easy_setopt(curl.get(), CURLOPT_POSTFIELDSIZE, static_cast<long>(payload.size()));
    }
    auto code = curl_easy_perform(curl.get());
    if (publicProbe && code == CURLE_COULDNT_RESOLVE_HOST) {
        curl_easy_setopt(curl.get(), CURLOPT_DOH_URL, "https://cloudflare-dns.com/dns-query");
        code = curl_easy_perform(curl.get());
    }
    if (code == CURLE_OK) curl_easy_getinfo(curl.get(), CURLINFO_RESPONSE_CODE, &out.code);
    curl_slist_free_all(headers); return out;
}
bool pending(const std::string& state) { return state == "queued" || state == "preparing" || state == "connecting"; }
std::string fingerprint(const Json::Value& spec) {
    const auto input = json(spec); unsigned char digest[SHA256_DIGEST_LENGTH];
    SHA256(reinterpret_cast<const unsigned char*>(input.data()), input.size(), digest);
    std::ostringstream out; for (const auto byte : digest) out << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(byte); return out.str();
}
std::string logsSince(const std::string& started) {
    if(started.size()<20) return "0";
    std::tm utc{}; std::istringstream input(started.substr(0,19)); input>>std::get_time(&utc,"%Y-%m-%dT%H:%M:%S");
    if(input.fail()) return "0";
#ifdef _WIN32
    const auto seconds=_mkgmtime(&utc);
#else
    const auto seconds=timegm(&utc);
#endif
    return std::to_string(seconds)+started.substr(19,started.size()-20);
}
struct Deployment { std::string url, mode, provider, container, user, name; Json::Value snapshot; };
Deployment load(const std::string& id, const std::string& user, bool member = true) {
    tunnelName(id);
    auto connection = Database::getInstance().getConnection(); pqxx::work tx(*connection);
    const auto rows = tx.exec_params("SELECT d.runtime_url,d.runtime_exposure,d.runtime_provider,d.remote_container_name,d.runtime_snapshot::text,p.name "
        "FROM deployments d JOIN projects p ON p.id=d.project_id WHERE d.id=$1 AND has_project_access(p.id,$2,$3)", id,user,member?"member":"viewer");
    if (rows.empty()) throw std::out_of_range("Deployment not found");
    Deployment d; d.url=rows[0][0].is_null()?"":rows[0][0].as<std::string>(); d.mode=rows[0][1].is_null()?"":rows[0][1].as<std::string>();
    d.provider=rows[0][2].is_null()?"":rows[0][2].as<std::string>(); d.container=rows[0][3].is_null()?"":rows[0][3].as<std::string>();
    d.snapshot=parse(rows[0][4].is_null()?"{}":rows[0][4].as<std::string>()); d.name=rows[0][5].as<std::string>(); d.user=user; return d;
}
bool save(const std::string& id, const std::string& target, const Json::Value& state,
          const std::string& expected = "", const std::string& url = "", const std::string& mode = "", int port = 0) {
    auto connection = Database::getInstance().getConnection(); pqxx::work tx(*connection);
    const auto rows = tx.exec_params("UPDATE deployments SET runtime_snapshot=jsonb_set(COALESCE(runtime_snapshot,'{}'::jsonb),'{public_exposure}',$2::jsonb,true), "
        "updated_at=NOW() WHERE id=$1 AND remote_container_name=$3 AND ($4='' OR runtime_snapshot->'public_exposure'->>'request_id'=$4) RETURNING id",id,json(state),target,expected);
    if (rows.empty()) return false;
    if (port > 0) tx.exec_params("UPDATE deployments SET runtime_snapshot=jsonb_set(runtime_snapshot,'{container_port}',to_jsonb($2::integer),true) WHERE id=$1",id,port);
    if (!url.empty()) tx.exec_params("UPDATE deployments SET runtime_url=$2::text,runtime_exposure=$3::text, "
        "runtime_snapshot=jsonb_set(jsonb_set(runtime_snapshot,'{runtime_url}',to_jsonb($2::text),true),'{exposure_mode}',to_jsonb($3::text),true) WHERE id=$1",id,url,mode);
    tx.commit(); return true;
}
void removeOwned(const std::string& id) {
    const auto name = tunnelName(id);
    const auto found = request("GET", "/containers/" + name + "/json");
    if (found.code == 404) return;
    if (found.code != 200 || parse(found.body)["Config"]["Labels"].get(label,"").asString() != id)
        throw std::runtime_error("Could not safely identify the deployment tunnel");
    if (request("DELETE", "/containers/" + name + "?force=1").code != 204) throw std::runtime_error("Could not disable the public tunnel");
}
bool imageReady(const std::shared_ptr<Control>& c) {
    const auto inspected = request("GET", std::string("/images/") + image + "/json");
    if (inspected.code == 200) return true;
    if (inspected.code != 404) throw std::runtime_error("Docker is not responding");
    { std::lock_guard<std::mutex> guard(c->mutex); if (!c->pullError.empty()) throw std::runtime_error(c->pullError); }
    if (!c->pulling.exchange(true)) BlockingTaskRunner::run([c] {
        const auto pulled = request("POST", "/images/create?fromImage=cloudflare%2Fcloudflared&tag=2026.9.1", Json::nullValue, 90000);
        const auto inspected = request("GET", std::string("/images/") + image + "/json");
        if (pulled.code != 200 || inspected.code != 200) { std::lock_guard<std::mutex> guard(c->mutex); c->pullError="Could not download the tunnel image. Check Docker's internet access, then retry."; }
        c->pulling=false;
    });
    return false;
}
void schedule(const std::shared_ptr<Control>& c, const std::string& id, const std::string& revision, bool first = true);
bool step(const std::shared_ptr<Control>& c, const std::string& id, const std::string& revision) {
    auto deploymentLock = lockFor(c,id); std::lock_guard<std::mutex> guard(*deploymentLock);
    Json::Value state; Deployment d;
    try {
        // The requested identity is private metadata, never returned in status.
        {
            auto connection=Database::getInstance().getConnection(); pqxx::work tx(*connection);
            const auto rows=tx.exec_params("SELECT runtime_snapshot->'public_exposure' FROM deployments WHERE id=$1",id);
            if(rows.empty()) return false; state=parse(rows[0][0].as<std::string>());
        }
        if (state.get("request_id","").asString()!=revision || !pending(state.get("state","").asString())) return false;
        d=load(id,state.get("requested_by","").asString());
        if (std::time(nullptr)-state.get("requested_at",Json::Int64(0)).asInt64()>180) throw std::runtime_error("The public link is not ready yet. Check your network, then retry the connection.");
        auto input=parse(TokenCrypto::decrypt(state.get("configuration_encrypted","").asString()));
        const auto target=request("GET","/containers/"+d.container+"/json");
        const auto inspection=parse(target.body);
        if (target.code!=200 || !inspection["State"].get("Running",false).asBool()) throw std::runtime_error("The deployment container is not running");
        if (inspection.get("Id","").asString()!=input.get("target_id","").asString()) throw std::runtime_error("The runtime changed while connecting. Retry for the current deployment.");
        if (!imageReady(c)) { state["state"]="preparing"; save(id,d.container,state,revision); return true; }
        const auto spec=tunnelSpec(id,input["target_id"].asString(),input["port"].asInt(),input.get("token","").asString());
        const auto desired=fingerprint(spec); const auto name=tunnelName(id);
        auto tunnel=request("GET","/containers/"+name+"/json"); auto info=parse(tunnel.body);
        if (tunnel.code==200 && info["Config"]["Labels"].get("io.stackpilot.configuration","").asString()!=desired) { removeOwned(id); tunnel.code=404; }
        if (tunnel.code==404) {
            auto createSpec=spec; createSpec["Labels"]["io.stackpilot.configuration"]=desired;
            const auto created=request("POST","/containers/create?name="+name,createSpec,5000);
            if (created.code!=201) throw std::runtime_error("Docker could not create the public tunnel");
            tunnel=request("GET","/containers/"+name+"/json"); info=parse(tunnel.body);
        }
        if (tunnel.code!=200) throw std::runtime_error("Could not inspect the public tunnel");
        if (!info["State"].get("Running",false).asBool()) {
            const auto started=request("POST","/containers/"+name+"/start");
            if(started.code!=204 && started.code!=304) throw std::runtime_error("Docker could not start the public tunnel");
            state["state"]="connecting"; save(id,d.container,state,revision); return true;
        }
        const auto generation=info["State"].get("StartedAt","").asString();
        if (state.get("generation","").asString()!=generation) { state["generation"]=generation; state["public_url"]=""; }
        const auto hostname=input.get("public_url","").asString();
        if (!hostname.empty()) state["public_url"]=hostname;
        else if (state.get("public_url","").asString().empty()) {
            // Read startup output once and persist the address before logs rotate.
            const auto logs=request("GET","/containers/"+name+"/logs?stdout=1&stderr=1&tail=500&since="+logsSince(generation));
            static const std::regex quick("https://[a-z0-9]+(-[a-z0-9]+)*\\.trycloudflare\\.com");
            auto begin=std::sregex_iterator(logs.body.begin(),logs.body.end(),quick);
            for(auto it=begin;it!=std::sregex_iterator();++it) state["public_url"]=it->str();
        }
        state["state"]="connecting";
        const bool connected=info["State"]["Health"].get("Status","").asString()=="healthy";
        const auto publicUrl=state.get("public_url","").asString();
        bool accessible=connected && !publicUrl.empty();
        if (accessible && hostname.empty()) { const auto response=request("HEAD",publicUrl,Json::nullValue,5000); accessible=response.code>=200 && response.code<500; }
        if (accessible) {
            state["state"]="ready"; state["error"]="";
            save(id,d.container,state,revision,publicUrl,"cloudflare_tunnel"); return false;
        }
        save(id,d.container,state,revision); return true;
    } catch (const std::out_of_range&) { return false; }
    catch (const std::exception& error) {
        if (!state.isObject() || state.get("request_id","").asString()!=revision) return false;
        state["state"]="failed"; state["error"]=error.what();
        try { save(id,d.container,state,revision); } catch (...) {}
        return false;
    }
}
void schedule(const std::shared_ptr<Control>& c, const std::string& id, const std::string& revision, bool first) {
    if(c->stopped) return;
    const auto key=id+"/"+revision;
    if(first) { std::lock_guard<std::mutex> guard(c->mutex); if(!c->active.insert(key).second) return; }
    drogon::app().getLoop()->runAfter(first?0.0:0.5,[c,id,revision,key] {
        BlockingTaskRunner::run([c,id,revision,key] {
            if(!c->stopped && step(c,id,revision)) schedule(c,id,revision,false);
            else { std::lock_guard<std::mutex> guard(c->mutex); c->active.erase(key); }
        });
    });
}
}

Json::Value change(const std::string& id, const std::string& user, const Json::Value& input) {
    const auto c=control(); auto deploymentLock=lockFor(c,id); std::lock_guard<std::mutex> guard(*deploymentLock);
    auto d=load(id,user);
    if(d.provider!="local_docker" || d.container.empty()) throw std::invalid_argument("Public tunnel exposure requires a local Docker deployment");
    if(input.isMember("exposure_mode") && !input["exposure_mode"].isString()) throw std::invalid_argument("Invalid exposure mode");
    const auto mode=input.get("exposure_mode","direct").asString();
    if(mode!="direct" && mode!="portless" && mode!="cloudflare_tunnel") throw std::invalid_argument("Invalid exposure mode");
    const auto inspected=request("GET","/containers/"+d.container+"/json"); const auto target=parse(inspected.body);
    if(inspected.code!=200 || !target["State"].get("Running",false).asBool()) throw std::invalid_argument("The deployment container is not running");
    const auto ports=discoverPorts(target,d.snapshot,d.url);
    Json::Value state; state["request_id"]=drogon::utils::getUuid(); state["requested_at"]=Json::Int64(std::time(nullptr)); state["requested_mode"]=mode; state["requested_by"]=user;
    if(mode!="cloudflare_tunnel") {
        state["state"]="ready"; if(!save(id,d.container,state,"","","",ports.container)) throw std::runtime_error("The runtime changed. Refresh and retry.");
        try { removeOwned(id); }
        catch(const std::exception& error) { state["state"]="failed"; state["error"]=error.what(); save(id,d.container,state); throw; }
        auto url="http://localhost:"+std::to_string(ports.host);
        if(mode=="portless") {
            auto slug=std::regex_replace(strings::toLower(d.name),std::regex("[^a-z0-9_.-]"),"-");
            if(slug.empty()) slug="app";
            url="http://"+slug+".localhost:"+std::to_string(ports.host);
        }
        save(id,d.container,state,state["request_id"].asString(),url,mode=="direct"?"local_docker":"portless_local");
        d.snapshot["public_exposure"]=state; return publicStatus(d.snapshot,url,mode=="direct"?"local_docker":"portless_local");
    }
    if((input.isMember("tunnel_token") && !input["tunnel_token"].isString()) || (input.isMember("public_url") && !input["public_url"].isString())) throw std::invalid_argument("Invalid named tunnel details");
    auto token=strings::trim(input.get("tunnel_token","").asString()); auto publicUrl=strings::trim(input.get("public_url","").asString());
    if(!publicUrl.empty() && publicUrl.back()=='/') publicUrl.pop_back();
    if(!publicUrl.empty() && token.empty()) {
        const auto& previous=d.snapshot["public_exposure"];
        if(previous.get("named_url","").asString()==publicUrl) token=parse(TokenCrypto::decrypt(previous.get("configuration_encrypted","").asString())).get("token","").asString();
    }
    if(token.size()>8192) throw std::invalid_argument("Invalid tunnel token");
    if(!token.empty() && !std::regex_match(publicUrl,std::regex("https://[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?\\.[a-zA-Z]{2,63}"))) throw std::invalid_argument("Enter the public HTTPS hostname configured for this named tunnel");
    if(token.empty() && !publicUrl.empty()) throw std::invalid_argument("A token is required for a named tunnel hostname");
    Json::Value config; config["target_id"]=target["Id"]; config["port"]=ports.container; config["token"]=token; config["public_url"]=publicUrl;
    state["configuration_encrypted"]=TokenCrypto::encrypt(json(config)); state["named_url"]=publicUrl; state["state"]="queued";
    if(!save(id,d.container,state,"","","",ports.container)) throw std::runtime_error("The runtime changed. Refresh and retry.");
    { std::lock_guard<std::mutex> lock(c->mutex); c->pullError.clear(); }
    schedule(c,id,state["request_id"].asString()); d.snapshot["public_exposure"]=state;
    return publicStatus(d.snapshot,d.url,d.mode);
}

Json::Value status(const std::string& id, const std::string& user) {
    const auto d=load(id,user,false); const auto& state=d.snapshot["public_exposure"];
    if(pending(state.get("state","").asString())) schedule(control(),id,state["request_id"].asString());
    return publicStatus(d.snapshot,d.url,d.mode);
}

void release(const std::string& id, const std::string& user) {
    auto deploymentLock=lockFor(control(),id); std::lock_guard<std::mutex> guard(*deploymentLock);
    const auto d=load(id,user);
    if(d.provider!="local_docker" || !d.snapshot["public_exposure"].isObject()) return;
    Json::Value state;
    state["request_id"]=drogon::utils::getUuid(); state["state"]="cancelled";
    // Invalidate scheduled work before removing the owned connector. Deletion
    // must not allow a delayed connect step to recreate a public endpoint.
    if(!save(id,d.container,state)) throw std::runtime_error("The runtime changed during tunnel cleanup");
    removeOwned(id);
}

void resumePending() {
    const auto c=control(); c->stopped=false;
    BlockingTaskRunner::run([c] { try {
        auto connection=Database::getInstance().getConnection(); pqxx::work tx(*connection);
        const auto rows=tx.exec("SELECT id::text,runtime_snapshot->'public_exposure'->>'request_id' FROM deployments WHERE runtime_snapshot->'public_exposure'->>'state' IN ('queued','preparing','connecting') LIMIT 128");
        for(const auto& row:rows) schedule(c,row[0].as<std::string>(),row[1].as<std::string>());
    } catch(...) {} });
}
void stop() { control()->stopped=true; }
}
