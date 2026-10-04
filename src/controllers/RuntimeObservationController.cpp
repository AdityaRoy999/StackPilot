#include "RuntimeObservationController.h"
#include "../db/Database.h"
#include "../services/LocalDockerRuntime.h"
#include "../utils/BlockingTaskRunner.h"
#include "../utils/StringUtils.h"
#include <openssl/crypto.h>
#include <pqxx/pqxx>
#include <cstdlib>

namespace stackpilot {
void RuntimeObservationController::observe(const drogon::HttpRequestPtr& req,std::function<void(const drogon::HttpResponsePtr&)>&& callback,const std::string& id){
    BlockingTaskRunner::run([req,id,callback=std::move(callback)]() mutable {
        auto respond=[&](Json::Value body,drogon::HttpStatusCode status=drogon::k200OK){auto response=drogon::HttpResponse::newHttpJsonResponse(body);response->setStatusCode(status);callback(response);};
        const auto presented=req->getHeader("x-stackpilot-service-token");const char* raw=std::getenv("STACKPILOT_AI_SERVICE_TOKEN");const std::string expected=raw?raw:"";
        if(expected.empty()||presented.size()!=expected.size()||CRYPTO_memcmp(presented.data(),expected.data(),expected.size())!=0){Json::Value error;error["error"]="Internal service authentication required";respond(error,drogon::k401Unauthorized);return;}
        try {
            auto body=req->getJsonObject();const auto job=body?body->get("job_id","").asString():"";
            auto connection=Database::getInstance().getConnection();pqxx::work txn(*connection);
            auto rows=txn.exec_params("SELECT runtime_provider,remote_container_name FROM deployments WHERE id::text=$1 AND job_id::text=$2 AND runtime_paused=FALSE AND status IN ('running','ready')",id,job);txn.commit();
            Json::Value result;result["verified"]=false;result["status"]="unverified";result["scope"]="process";
            if(rows.empty()){result["reason"]="Runtime identity changed or is no longer active";respond(result);return;}
            if(rows[0]["runtime_provider"].as<std::string>()!="local_docker"){result["reason"]="No fresh process adapter for this provider";respond(result);return;}
            std::string output;const auto name=rows[0]["remote_container_name"].as<std::string>();
            const int code=LocalDockerRuntime::run("timeout 8s docker inspect --format '{{.State.Running}} {{.State.Paused}} {{.RestartCount}}' "+strings::shellQuote(name)+" 2>/dev/null",output);
            if(code!=0){result["reason"]="Container observation unavailable";respond(result);return;}
            result["verified"]=strings::trim(output)=="true false 0";result["status"]=result["verified"].asBool()?"passed":"failed";
            result["observation"]=strings::trim(output);result["reason"]="Fresh container process observation; application job outcomes require declared probes";respond(result);
        } catch(...) {Json::Value result;result["verified"]=false;result["status"]="unverified";result["reason"]="Process observation unavailable";respond(result);}
    });
}
}
