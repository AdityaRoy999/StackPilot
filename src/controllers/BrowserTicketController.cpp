#include "BrowserTicketController.h"
#include "../db/Database.h"
#include "../utils/BlockingTaskRunner.h"
#include "../utils/JwtHelper.h"
#include <openssl/hmac.h>
#include <pqxx/pqxx>
#include <chrono>
#include <cstdlib>
#include <regex>

namespace stackpilot {
namespace {
std::string hex(const unsigned char* data,size_t length){
    const char* chars="0123456789abcdef";std::string value;value.reserve(length*2);
    for(size_t i=0;i<length;++i){value+=chars[data[i]>>4];value+=chars[data[i]&15];}return value;
}
void issueTicket(const drogon::HttpRequestPtr& req,std::function<void(const drogon::HttpResponsePtr&)>&& callback,const std::string& id,bool native){
    BlockingTaskRunner::run([req,id,native,callback=std::move(callback)]() mutable {
        auto respond=[&](drogon::HttpStatusCode status,const std::string& error){Json::Value body;body["error"]=error;auto response=drogon::HttpResponse::newHttpJsonResponse(body);response->setStatusCode(status);callback(response);};
        try {
            const auto user=JwtHelper::verifyRequestToken(req);const auto uid=user.get("user_id","").asString();
            if(uid.empty()){respond(drogon::k401Unauthorized,"Authentication required");return;}
            if(!std::regex_match(id,std::regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"))){respond(drogon::k400BadRequest,"Invalid session");return;}
            auto connection=Database::getInstance().getConnection();pqxx::work txn(*connection);
            auto rows=native?txn.exec_params("SELECT has_project_access(d.project_id,$2,'admin') AS control FROM deployments d WHERE d.id=$1 AND has_project_access(d.project_id,$2,'viewer') AND d.runtime_snapshot->'runtime_verification'->'native'->>'preview_available'='true'",id,uid):txn.exec_params("SELECT (s.user_id=$2::uuid OR has_project_access(s.project_id,$2,'admin')) AS control FROM ai_sessions s WHERE s.id=$1 AND (s.user_id=$2::uuid OR has_project_access(s.project_id,$2,'viewer'))",id,uid);txn.commit();
            if(rows.empty()){respond(drogon::k404NotFound,"Session unavailable");return;}
            const char* key=std::getenv("STACKPILOT_AI_SERVICE_TOKEN");
            if(!key||!*key){respond(drogon::k503ServiceUnavailable,"Browser authentication is not configured");return;}
            Json::Value payload;payload["session_id"]=id;payload["kind"]=native?"native":"browser";payload["user_id"]=uid;payload["control"]=rows[0]["control"].as<bool>() && !user.get("mcp",false).asBool();
            if(user.isMember("remote_device_id"))payload["remote_device_id"]=user["remote_device_id"];
            payload["expires"]=Json::Int64(std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count()+300);
            Json::StreamWriterBuilder writer;writer["indentation"]="";const auto encoded=Json::writeString(writer,payload);
            unsigned char digest[EVP_MAX_MD_SIZE];unsigned int size=0;
            HMAC(EVP_sha256(),key,static_cast<int>(std::char_traits<char>::length(key)),reinterpret_cast<const unsigned char*>(encoded.data()),encoded.size(),digest,&size);
            Json::Value body;body["ticket"]=hex(reinterpret_cast<const unsigned char*>(encoded.data()),encoded.size())+"."+hex(digest,size);body["expires"]=payload["expires"];body["control"]=payload["control"];
            if(native){const char* base=std::getenv("STACKPILOT_ANDROID_WORKER_PUBLIC_URL");body["preview_url"]=std::string(base&&*base?base:"http://localhost:8077")+"/preview/"+id+"?ticket="+body["ticket"].asString();}
            auto response=drogon::HttpResponse::newHttpJsonResponse(body);response->addHeader("Cache-Control","no-store");callback(response);
        } catch(...) {respond(drogon::k500InternalServerError,"Browser authorization failed");}
    });
}
} // namespace
void BrowserTicketController::ticket(const drogon::HttpRequestPtr& req,std::function<void(const drogon::HttpResponsePtr&)>&& callback,const std::string& id){issueTicket(req,std::move(callback),id,false);}
void BrowserTicketController::nativeTicket(const drogon::HttpRequestPtr& req,std::function<void(const drogon::HttpResponsePtr&)>&& callback,const std::string& id){issueTicket(req,std::move(callback),id,true);}
} // namespace stackpilot
