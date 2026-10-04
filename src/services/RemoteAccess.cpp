#include "RemoteAccess.h"
#include "../db/Database.h"
#include "../utils/StringUtils.h"
#include "../utils/JwtHelper.h"
#include "../utils/BlockingTaskRunner.h"
#include <drogon/HttpAppFramework.h>
#include <openssl/rand.h>
#include <openssl/sha.h>
#include <pqxx/pqxx>
#include <mutex>
#include <unordered_set>
#include <regex>
#include <stdexcept>
#include <sstream>

namespace stackpilot::remote {
namespace {
std::mutex runMutex;
std::unordered_set<std::string> liveRuns;
std::string hex(const unsigned char* data, size_t n) {
    const char* chars="0123456789abcdef"; std::string out; out.reserve(n*2);
    for(size_t i=0;i<n;++i){out+=chars[data[i]>>4];out+=chars[data[i]&15];} return out;
}
void removeBrowserFrames(Json::Value& value) {
    if(value.isObject()) {
        value.removeMember("frame");
        value.removeMember("som_frame");
        for(const auto& key:value.getMemberNames())removeBrowserFrames(value[key]);
    } else if(value.isArray()) {
        for(Json::ArrayIndex i=0;i<value.size();++i)removeBrowserFrames(value[i]);
    }
}
}
std::string randomSecret() { unsigned char bytes[32]; if(RAND_bytes(bytes,32)!=1)throw std::runtime_error("Random generator unavailable"); return hex(bytes,32); }
std::string hash(const std::string& value) { unsigned char bytes[SHA256_DIGEST_LENGTH]; SHA256(reinterpret_cast<const unsigned char*>(value.data()),value.size(),bytes);return hex(bytes,sizeof(bytes)); }
bool permitted(const std::string& path, drogon::HttpMethod method) {
    // Pairing grants the same account access as signing in. Each controller
    // still checks resource ownership and organization roles.
    return path.rfind("/api/v1/",0)==0 || path=="/ws/logs" || path=="/ws/ssh-terminal";
}
Json::Value authenticate(const drogon::HttpRequestPtr& req) {
    const auto token=JwtHelper::extractTokenFromRequest(req);
    if(!std::regex_match(token,std::regex("sp_remote_[a-f0-9]{64}")) || !permitted(req->path(),req->method())) return Json::Value();
    auto connection=Database::getInstance().getConnection();pqxx::work tx(*connection);
    auto rows=tx.exec_params("UPDATE remote_devices d SET last_seen_at=NOW() FROM users u WHERE d.user_id=u.id AND d.token_hash=$1 AND d.status='approved' AND d.expires_at>NOW() AND (u.token_invalid_before IS NULL OR d.created_at>=u.token_invalid_before) RETURNING d.id,d.user_id",hash(token));
    tx.commit();if(rows.empty())return Json::Value();
    Json::Value user;user["user_id"]=rows[0]["user_id"].as<std::string>();user["remote_device_id"]=rows[0]["id"].as<std::string>();return user;
}
void watchConnection(const drogon::HttpRequestPtr& req,const drogon::WebSocketConnectionPtr& connection) {
    std::weak_ptr<drogon::WebSocketConnection> weak=connection;
    drogon::app().getLoop()->runAfter(1.0,[req,weak]{
        auto socket=weak.lock();if(!socket||!socket->connected())return;
        BlockingTaskRunner::run([req,weak]{
            auto socket=weak.lock();if(!socket||!socket->connected())return;
            try { if(!authenticate(req).isNull()){watchConnection(req,socket);return;} }catch(...){}
            socket->forceClose();
        });
    });
}
void activateRun(const std::string& id) {std::lock_guard<std::mutex> lock(runMutex);liveRuns.insert(id);}
void deactivateRun(const std::string& id) {std::lock_guard<std::mutex> lock(runMutex);liveRuns.erase(id);}
bool activeRun(const std::string& id) {std::lock_guard<std::mutex> lock(runMutex);return liveRuns.count(id)>0;}
void appendEvent(const std::string& id,const std::string& frame) {
    if(frame.rfind("data: ",0)!=0)return;
    Json::Value event;Json::CharReaderBuilder reader;std::string error;std::istringstream stream(frame.substr(6));
    if(!Json::parseFromStream(reader,stream,&event,&error)||!event.isObject())return;
    // Browser video has its own authenticated transport, never put frames in chat history.
    removeBrowserFrames(event);
    auto connection=Database::getInstance().getConnection();pqxx::work tx(*connection);
    auto rows=tx.exec_params("UPDATE remote_runs SET last_sequence=last_sequence+1,updated_at=NOW() WHERE id=$1 RETURNING last_sequence",id);
    if(!rows.empty())tx.exec_params("INSERT INTO remote_run_events(run_id,sequence,event) VALUES($1,$2,$3::jsonb)",id,rows[0][0].as<long long>(),strings::compactJson(event));
    tx.commit();
}
void finishRun(const std::string& id,const std::string& state) {
    auto connection=Database::getInstance().getConnection();pqxx::work tx(*connection);
    tx.exec_params("UPDATE remote_runs SET state=$2,updated_at=NOW() WHERE id=$1",id,state);tx.commit();
    std::lock_guard<std::mutex> lock(runMutex);liveRuns.erase(id);
}
}
