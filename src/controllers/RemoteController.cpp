#include "RemoteController.h"
#include "../services/RemoteAccess.h"
#include "../db/Database.h"
#include "../utils/JwtHelper.h"
#include "../utils/BlockingTaskRunner.h"
#include <drogon/HttpClient.h>
#include <pqxx/pqxx>
#include <openssl/rand.h>
#include <regex>
#include <cstdio>
#include <cstdlib>
#include <limits>

namespace stackpilot {
namespace {
using Callback=std::function<void(const drogon::HttpResponsePtr&)>;
void reply(const Callback& cb,const Json::Value& body,drogon::HttpStatusCode status=drogon::k200OK) {
    auto response=drogon::HttpResponse::newHttpJsonResponse(body);response->setStatusCode(status);response->addHeader("Cache-Control","no-store");cb(response);
}
void error(const Callback& cb,const std::string& message,drogon::HttpStatusCode status=drogon::k400BadRequest){Json::Value body;body["error"]=message;reply(cb,body,status);}
bool uuid(const std::string& id){return std::regex_match(id,std::regex("[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}"));}
std::string execute(const char* command){std::string out;FILE* pipe=popen(command,"r");if(!pipe)return out;char buffer[1024];while(fgets(buffer,sizeof(buffer),pipe)&&out.size()<16000)out+=buffer;pclose(pipe);return out;}
Json::Value identity(const drogon::HttpRequestPtr& req){return JwtHelper::verifyRequestToken(req);}
bool account(const Json::Value& user){return !user.get("user_id","").asString().empty() && !user.get("mcp",false).asBool();}
Json::Value rowsJson(const pqxx::result& rows){Json::Value out(Json::arrayValue);for(const auto& row:rows){Json::Value item;for(const auto& field:row)item[field.name()]=field.is_null()?Json::Value():Json::Value(field.as<std::string>());out.append(item);}return out;}
}
void RemoteController::manage(const drogon::HttpRequestPtr& req,Callback&& cb){
    BlockingTaskRunner::run([req,cb=std::move(cb)]{
        try {
            auto user=identity(req);if(!account(user)){error(cb,"Account sign-in required",drogon::k401Unauthorized);return;}
            const auto uid=user["user_id"].asString();auto body=req->getJsonObject();
            if(req->path()=="/api/v1/remote/access"){
                if(req->method()==drogon::Post){
                    auto action=body?body->get("action","").asString():"";
                    if(action=="start")execute("docker start stackpilot-remote-tunnel 2>/dev/null");
                    else if(action=="stop")execute("docker stop -t 3 stackpilot-remote-tunnel 2>/dev/null");
                    else{error(cb,"Choose start or stop");return;}
                }
                const auto running=execute("docker inspect -f '{{.State.Running}}' stackpilot-remote-tunnel 2>/dev/null").rfind("true",0)==0;
                auto started=execute("docker inspect -f '{{.State.StartedAt}}' stackpilot-remote-tunnel 2>/dev/null");
                while(!started.empty()&&(started.back()=='\n'||started.back()=='\r'))started.pop_back();
                const auto logs=running&&std::regex_match(started,std::regex("[0-9T:Z.-]{20,40}"))?execute(("docker logs --since "+started+" --tail 60 stackpilot-remote-tunnel 2>&1").c_str()):"";
                std::smatch match;Json::Value result;result["running"]=running;result["url"]="";
                if(logs.find("Registered tunnel connection")!=std::string::npos && std::regex_search(logs,match,std::regex("https://[a-z0-9-]+\\.trycloudflare\\.com")))result["url"]=match.str();
                const char* configured=std::getenv("STACKPILOT_REMOTE_PUBLIC_URL");if(configured&&*configured)result["url"]=configured;
                result["available"]=!execute("docker inspect -f '{{.Name}}' stackpilot-remote-tunnel 2>/dev/null").empty();reply(cb,result);return;
            }
            auto connection=Database::getInstance().getConnection();pqxx::work tx(*connection);
            if(req->path()=="/api/v1/remote/pairings"){
                // Limit outstanding links and expire previous unclaimed links from this account.
                tx.exec_params("UPDATE remote_pairings SET expires_at=NOW() WHERE user_id=$1 AND NOT claimed",uid);
                const auto secret=remote::randomSecret();auto rows=tx.exec_params("INSERT INTO remote_pairings(user_id,secret_hash) VALUES($1,$2) RETURNING id,expires_at::text",uid,remote::hash(secret));
                Json::Value result;result["id"]=rows[0][0].as<std::string>();result["secret"]=secret;result["expires_at"]=rows[0][1].as<std::string>();tx.commit();reply(cb,result);return;
            }
            if(req->method()==drogon::Get){
                auto rows=tx.exec_params("SELECT d.id,d.name,d.confirmation_code,d.status,d.created_at::text,d.expires_at::text,d.last_seen_at::text FROM remote_devices d JOIN remote_pairings p ON p.id=d.pairing_id WHERE d.user_id=$1 AND (d.status!='pending' OR p.expires_at>NOW()) ORDER BY d.created_at DESC",uid);
                Json::Value result;result["devices"]=rowsJson(rows);tx.commit();reply(cb,result);return;
            }
            auto id=body?body->get("id","").asString():"";auto action=body?body->get("action","").asString():"";
            if(!uuid(id)||(action!="approve"&&action!="deny"&&action!="revoke")){error(cb,"Invalid device action");return;}
            pqxx::result rows;
            if(action=="approve")rows=tx.exec_params("UPDATE remote_devices d SET status='approved' FROM remote_pairings p WHERE d.id=$1 AND d.user_id=$2 AND d.status='pending' AND d.pairing_id=p.id AND p.expires_at>NOW() AND d.confirmation_code=$3 RETURNING d.id",id,uid,body->get("confirmation_code","").asString());
            else rows=tx.exec_params("UPDATE remote_devices SET status=$3 WHERE id=$1 AND user_id=$2 RETURNING id",id,uid,action=="deny"?"denied":"revoked");
            tx.commit();if(rows.empty()){error(cb,"Device expired, confirmation code changed, or access denied",drogon::k409Conflict);return;}Json::Value result;result["ok"]=true;reply(cb,result);
        }catch(...){error(cb,"Remote management unavailable",drogon::k503ServiceUnavailable);}
    });
}
void RemoteController::connect(const drogon::HttpRequestPtr& req,Callback&& cb){
    BlockingTaskRunner::run([req,cb=std::move(cb)]{
        try{
            const auto body=req->getJsonObject();const auto header=req->getHeader("Authorization");
            if(!body||header.size()!=81||header.rfind("Bearer sp_remote_",0)!=0){error(cb,"Invalid pairing request");return;}
            auto secret=body->get("secret","").asString();auto name=body->get("name","Phone").asString();
            if(!std::regex_match(secret,std::regex("[a-f0-9]{64}"))||name.empty()||name.size()>80){error(cb,"Invalid pairing request");return;}
            auto connection=Database::getInstance().getConnection();pqxx::work tx(*connection);
            auto pair=tx.exec_params("UPDATE remote_pairings SET claimed=TRUE WHERE secret_hash=$1 AND NOT claimed AND expires_at>NOW() RETURNING id,user_id",remote::hash(secret));
            if(pair.empty()){error(cb,"Pairing link expired or already used",drogon::k410Gone);return;}
            unsigned int random=0;do{if(RAND_bytes(reinterpret_cast<unsigned char*>(&random),sizeof(random))!=1)throw std::runtime_error("Random unavailable");}while(random>4293999999U);
            auto code=std::to_string(100000+random%900000);
            auto rows=tx.exec_params("INSERT INTO remote_devices(pairing_id,user_id,name,token_hash,confirmation_code) VALUES($1,$2,$3,$4,$5) RETURNING id",pair[0][0].as<std::string>(),pair[0][1].as<std::string>(),name,remote::hash(header.substr(7)),code);
            Json::Value result;result["id"]=rows[0][0].as<std::string>();result["confirmation_code"]=code;result["status"]="pending";tx.commit();reply(cb,result,drogon::k201Created);
        }catch(...){error(cb,"Pairing unavailable",drogon::k503ServiceUnavailable);}
    });
}
void RemoteController::device(const drogon::HttpRequestPtr& req,Callback&& cb){
    BlockingTaskRunner::run([req,cb=std::move(cb)]{
        try{
            const auto token=JwtHelper::extractTokenFromRequest(req);if(!std::regex_match(token,std::regex("sp_remote_[a-f0-9]{64}"))){error(cb,"Pair your phone first",drogon::k401Unauthorized);return;}
            auto connection=Database::getInstance().getConnection();pqxx::work tx(*connection);
            auto rows=tx.exec_params("SELECT d.id,d.name,d.status,d.confirmation_code,d.expires_at::text,u.email, (d.expires_at>NOW() AND (d.status!='pending' OR p.expires_at>NOW()) AND (u.token_invalid_before IS NULL OR d.created_at>=u.token_invalid_before)) AS valid FROM remote_devices d JOIN remote_pairings p ON p.id=d.pairing_id JOIN users u ON u.id=d.user_id WHERE d.token_hash=$1",remote::hash(token));
            if(rows.empty()||!rows[0]["valid"].as<bool>()||rows[0]["status"].as<std::string>()=="revoked"||rows[0]["status"].as<std::string>()=="denied"){error(cb,"Pairing expired or this device was disconnected",drogon::k401Unauthorized);return;}
            if(req->method()==drogon::Delete)tx.exec_params("UPDATE remote_devices SET status='revoked' WHERE id=$1",rows[0]["id"].as<std::string>());
            else tx.exec_params("UPDATE remote_devices SET last_seen_at=NOW() WHERE id=$1",rows[0]["id"].as<std::string>());
            auto result=rowsJson(rows)[0];result.removeMember("valid");tx.commit();reply(cb,result);
        }catch(...){error(cb,"Host is unavailable",drogon::k503ServiceUnavailable);}
    });
}
void RemoteController::session(const drogon::HttpRequestPtr& req,Callback&& cb){
    BlockingTaskRunner::run([req,cb=std::move(cb)]{
        try{
            auto user=remote::authenticate(req);if(user.isNull()){error(cb,"Approve this phone before opening StackPilot",drogon::k401Unauthorized);return;}
            Json::Value result;result["ok"]=true;auto response=drogon::HttpResponse::newHttpJsonResponse(result);
            response->addHeader("Cache-Control","no-store");
            drogon::Cookie cookie("stackpilot_remote_device",JwtHelper::extractTokenFromRequest(req));
            cookie.setPath("/");cookie.setHttpOnly(true);cookie.setSecure(true);cookie.setSameSite(drogon::Cookie::SameSite::kLax);cookie.setMaxAge(30*24*60*60);response->addCookie(cookie);
            cb(response);
        }catch(...){error(cb,"Host connection unavailable",drogon::k503ServiceUnavailable);}
    });
}
void RemoteController::authorize(const drogon::HttpRequestPtr& req,Callback&& cb){
    BlockingTaskRunner::run([req,cb=std::move(cb)]{
        try{
            const auto origin=req->getHeader("Origin");
            const auto method=req->getHeader("X-Forwarded-Method");
            if(req->getHeader("Authorization").empty() && !origin.empty() && method!="GET" && method!="HEAD" && origin!="https://"+req->getHeader("X-Forwarded-Host")){
                error(cb,"Untrusted request origin",drogon::k403Forbidden);return;
            }
            auto user=remote::authenticate(req);
            if(user.isNull()){
                const auto uri=req->getHeader("X-Forwarded-Uri");
                if(req->getHeader("Accept").find("text/html")!=std::string::npos && uri.rfind("/dashboard",0)==0){
                    auto response=drogon::HttpResponse::newRedirectionResponse("/remote?next="+drogon::utils::urlEncode(uri));response->addHeader("Cache-Control","no-store");cb(response);return;
                }
                error(cb,"Phone disconnected. Pair again.",drogon::k401Unauthorized);return;
            }
            auto response=drogon::HttpResponse::newHttpResponse();response->addHeader("Cache-Control","no-store");
            // The gateway copies this into the upstream request, never into the
            // public response. Cookie navigation and WebSocket upgrades retain
            // the same revocable capability; no unrestricted JWT is issued.
            response->addHeader("X-StackPilot-Device-Authorization","Bearer "+JwtHelper::extractTokenFromRequest(req));cb(response);
        }catch(...){error(cb,"Host connection unavailable",drogon::k503ServiceUnavailable);}
    });
}
void RemoteController::proxy(const drogon::HttpRequestPtr& req,Callback&& cb,const std::string& suffix){
    const auto path="/api/v1/"+suffix;
    if(!remote::permitted(path,req->method())||path.rfind("/api/v1/remote/",0)==0||path=="/api/v1/auth/register"||path=="/api/v1/auth/login"||path=="/api/v1/ai/tools/execute"){error(cb,"This operation is not available through the remote proxy",drogon::k403Forbidden);return;}
    BlockingTaskRunner::run([req,cb=std::move(cb),path]{
        try{
            auto user=remote::authenticate(req);if(user.isNull()){error(cb,"Phone disconnected. Pair again.",drogon::k401Unauthorized);return;}
            auto forwarded=drogon::HttpRequest::newHttpRequest();forwarded->setMethod(req->method());forwarded->setPath(path);forwarded->addHeader("Authorization",req->getHeader("Authorization"));forwarded->addHeader("Content-Type","application/json");
            forwarded->setContentTypeCode(drogon::CT_APPLICATION_JSON);
            forwarded->addHeader("X-Forwarded-Proto","https");
            // No client-supplied origin, host, cookies or arbitrary query/URL reaches the private API.
            for(const auto& parameter:req->getParameters())forwarded->setParameter(parameter.first,parameter.second);
            if(path=="/api/v1/ai/chat/stream"){
                auto body=req->getJsonObject();if(!body){error(cb,"Message required");return;}Json::Value payload=*body;payload["background"]=true;
                payload["agent_access_mode"]="ask";payload["remote_terminal"]="ask";
                if(!payload["runtime"].isObject())payload["runtime"]=Json::Value(Json::objectValue);
                payload["runtime"]["permissions"]["agent_access_mode"]="ask";payload["runtime"]["permissions"]["remote_terminal"]="ask";
                auto json=drogon::HttpRequest::newHttpJsonRequest(payload);json->setMethod(drogon::Post);json->setPath(path);json->addHeader("Authorization",req->getHeader("Authorization"));json->addHeader("X-Forwarded-Proto","https");forwarded=json;
            }else forwarded->setBody(std::string(req->body()));
            auto client=drogon::HttpClient::newHttpClient("http://127.0.0.1:8090");
            client->sendRequest(forwarded,[cb,client](drogon::ReqResult result,const drogon::HttpResponsePtr& response){
                if(result!=drogon::ReqResult::Ok||!response){error(cb,"Host API did not respond",drogon::k502BadGateway);return;}
                response->addHeader("Cache-Control","no-store");cb(response);
            },30);
        }catch(...){error(cb,"Host connection unavailable",drogon::k503ServiceUnavailable);}
    });
}
void RemoteController::runs(const drogon::HttpRequestPtr& req,Callback&& cb){run(req,std::move(cb),"");}
void RemoteController::run(const drogon::HttpRequestPtr& req,Callback&& cb,const std::string& id){
    if(!id.empty()&&!uuid(id)){error(cb,"Invalid run");return;}
    BlockingTaskRunner::run([req,cb=std::move(cb),id]{
        try{
            auto user=identity(req);if(user.isNull()){error(cb,"Authentication required",drogon::k401Unauthorized);return;}
            auto uid=user["user_id"].asString();auto connection=Database::getInstance().getConnection();pqxx::work tx(*connection);
            auto rows=tx.exec_params("SELECT r.id,r.session_id,r.state,r.last_sequence,r.context::text,r.created_at::text,s.title FROM remote_runs r JOIN ai_sessions s ON s.id=r.session_id WHERE r.user_id=$1 AND ($2='' OR r.id::text=$2) ORDER BY r.created_at DESC LIMIT 50",uid,id);
            if(!id.empty()&&rows.empty()){error(cb,"Run unavailable",drogon::k404NotFound);return;}
            Json::Value result;result["runs"]=rowsJson(rows);
            for(Json::ArrayIndex i=0;i<result["runs"].size();++i){auto& run=result["runs"][i];Json::Value context;Json::Reader parser;if(parser.parse(run["context"].asString(),context))run["context"]=context;if(run["state"]=="working"&&!remote::activeRun(run["id"].asString())){
                run["state"]="interrupted";tx.exec_params("UPDATE remote_runs SET state='interrupted',updated_at=NOW() WHERE id=$1 AND state='working'",run["id"].asString());
            }}
            if(!id.empty()){
                result["run"]=result["runs"][0];result.removeMember("runs");long long cursor=0;try{cursor=std::max(0LL,std::stoll(req->getParameter("after")));}catch(...){}
                auto events=tx.exec_params("SELECT sequence,event::text FROM remote_run_events WHERE run_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 200",id,cursor);result["events"]=Json::Value(Json::arrayValue);
                for(const auto& row:events){Json::Value event;Json::Reader parser;if(parser.parse(row[1].as<std::string>(),event)){event["sequence"]=Json::Int64(row[0].as<long long>());result["events"].append(event);}}
            }
            tx.commit();reply(cb,result);
        }catch(...){error(cb,"Run progress unavailable",drogon::k503ServiceUnavailable);}
    });
}
}
