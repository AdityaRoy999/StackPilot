#include "ReleaseCheckpointService.h"
#include "../db/Database.h"
#include "../utils/StringUtils.h"
#include "../utils/TokenCrypto.h"
#include "LocalDockerRuntime.h"
#include "ComponentRuntimeVerification.h"
#include "AiServiceClient.h"
#include <pqxx/pqxx>
#include <chrono>
#include <cstdlib>
#include <sstream>

namespace stackpilot {
namespace {
struct CandidateCleanup {
    std::string name;
    bool promoted=false;
    ~CandidateCleanup(){if(!promoted)try{LocalDockerRuntime::removeContainer(name,"",false);}catch(...) {}}
};
}
Json::Value ReleaseCheckpointService::rollbackLocal(const std::string& deploymentId,const std::string& userId){
    auto connection=Database::getInstance().getConnection();pqxx::work txn(*connection);
    auto lock=txn.exec_params("SELECT pg_try_advisory_xact_lock(hashtextextended(COALESCE(d.environment_id::text,d.project_id::text),0)) AS acquired FROM deployments d WHERE d.id=$1 AND has_project_access(d.project_id,$2,'admin')",deploymentId,userId);
    if(lock.empty() || !lock[0]["acquired"].as<bool>())throw std::runtime_error("Another rollback is active or deployment unavailable");
    auto current=txn.exec_params("SELECT d.project_id,d.environment_id,d.job_id,d.status FROM deployments d JOIN projects p ON p.id=d.project_id WHERE d.id=$1 AND has_project_access(p.id,$2,'admin') FOR UPDATE OF d",deploymentId,userId);
    if(current.empty())throw std::runtime_error("Deployment unavailable");
    const auto state=current[0]["status"].as<std::string>();
    if(state=="building" || state=="deploying" || state=="queued")throw std::runtime_error("Wait for or cancel the active deployment before rollback");
    auto rows=txn.exec_params("SELECT c.id,c.deployment_id,c.job_id,c.attempt,c.image_digest,c.runtime_snapshot::text,c.runtime_config_encrypted FROM deployment_release_checkpoints c WHERE c.project_id=$1 AND c.environment_id IS NOT DISTINCT FROM NULLIF($2,'')::uuid AND c.job_id IS DISTINCT FROM NULLIF($3,'')::uuid AND c.provider='local_docker' ORDER BY c.created_at DESC LIMIT 1",current[0]["project_id"].as<std::string>(),current[0]["environment_id"].is_null()?"":current[0]["environment_id"].as<std::string>(),current[0]["job_id"].is_null()?"":current[0]["job_id"].as<std::string>());
    if(rows.empty()){Json::Value result;result["status"]="unavailable";return result;}
    const auto row=rows[0];const auto owner=row["deployment_id"].as<std::string>();
    // Lock the release row that will be restored as well as the requesting row.
    auto restored=txn.exec_params("SELECT d.id,d.status,d.job_id,d.runtime_url,d.remote_container_name,COALESCE(d.runtime_snapshot::text,'{}') AS runtime_snapshot,d.artifact_available,d.runtime_paused FROM deployments d LEFT JOIN deployment_jobs j ON j.id=d.job_id WHERE d.id=$1 AND COALESCE(j.status,'') NOT IN ('queued','running','retrying') FOR UPDATE OF d",owner);
    if(restored.empty())throw std::runtime_error("Checkpoint has an active build; rollback refused");
    Json::Value snapshot,config;Json::CharReaderBuilder reader;std::string errors;
    std::istringstream saved(row["runtime_snapshot"].as<std::string>()),env(TokenCrypto::decrypt(row["runtime_config_encrypted"].as<std::string>()));
    if(!Json::parseFromStream(reader,saved,&snapshot,&errors)||!Json::parseFromStream(reader,env,&config,&errors)||!config.isArray())throw std::runtime_error("Checkpoint configuration is invalid");
    const auto plan=snapshot["deployment_plan"];const auto image=row["image_digest"].as<std::string>();
    if(plan["repository_plan"]["components"].isArray() && plan["repository_plan"]["components"].size()>1)
        throw std::runtime_error("A Compose graph checkpoint requires a component-aware recovery executor; single-image rollback refused");
    if(image.rfind("sha256:",0)!=0)throw std::runtime_error("Checkpoint lacks immutable image identity");
    std::vector<std::pair<std::string,std::string>> vars;for(const auto& e:config)vars.emplace_back(e["key"].asString(),e["value"].asString());
    const auto name="stackpilot-rollback-"+row["id"].as<std::string>().substr(0,12)+"-"+std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
    CandidateCleanup candidate{name};
    std::string output;const auto cmd=LocalDockerRuntime::makeRunCommand(name,image,plan.get("port",snapshot.get("container_port",0)).asInt(),vars,plan.get("protocol","http").asString(),plan.get("health_path","/").asString());
    if(LocalDockerRuntime::run("timeout 120s sh -lc "+strings::shellQuote(cmd),output)!=0){LocalDockerRuntime::removeContainer(name,"",false);throw std::runtime_error("Checkpoint runtime failed to start");}
    const auto url=LocalDockerRuntime::markerValue(output,"runtime_url");
    Json::Value proof;
    if(plan.get("protocol","http").asString()=="process"){
        std::string state;proof["verified"]=LocalDockerRuntime::run("timeout 8s docker inspect --format '{{.State.Running}} {{.RestartCount}}' "+strings::shellQuote(name),state)==0 && strings::trim(state)=="true 0";proof["scope"]="process";
    } else {
        Json::Value probe;probe["url"]=url;probe["contract"]=plan;
        const auto checked=AiServiceClient::instance().postWorkflow("/runtime/verify",probe);proof=checked.body;if(!checked.ok)proof["verified"]=false;
    }
    if(!proof.get("verified",false).asBool()){LocalDockerRuntime::removeContainer(name,"",false);throw std::runtime_error("Checkpoint application verification failed");}
    snapshot["runtime_url"]=url;snapshot["runtime_verification"]=proof;snapshot["restored_checkpoint"]=row["id"].as<std::string>();
    Json::StreamWriterBuilder writer;writer["indentation"]="";
    std::string published=url;
    const auto environment=current[0]["environment_id"].is_null()?"":current[0]["environment_id"].as<std::string>();
    Json::Value previousRoute;
    if(!environment.empty()) {
        auto prior=txn.exec_params("SELECT deployment_id::text,job_id::text,upstream_url,verification::text FROM environment_runtime_routes WHERE environment_id=$1",environment);
        if(!prior.empty())for(const auto& key:{"deployment_id","job_id","upstream_url","verification"})previousRoute[key]=prior[0][key].as<std::string>();
    }
    const char* suffix=std::getenv("STACKPILOT_LOCAL_PREVIEW_SUFFIX");
    if(!environment.empty() && suffix && *suffix && plan.get("protocol","http").asString()=="http") {
        published="http://"+environment+suffix;snapshot["candidate_url"]=url;snapshot["runtime_url"]=published;snapshot["stable_origin"]=true;
        txn.exec_params("INSERT INTO environment_runtime_routes(environment_id,deployment_id,job_id,upstream_url,verification) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(environment_id) DO UPDATE SET deployment_id=EXCLUDED.deployment_id,job_id=EXCLUDED.job_id,upstream_url=EXCLUDED.upstream_url,verification=EXCLUDED.verification,generation=environment_runtime_routes.generation+1,updated_at=NOW()",environment,owner,row["job_id"].as<std::string>(),url,Json::writeString(writer,proof));
    }
    txn.exec_params("UPDATE deployments SET status='running',job_id=$2::uuid,runtime_url=$3,remote_container_name=$4,runtime_snapshot=$5::jsonb,artifact_available=TRUE,runtime_paused=FALSE,updated_at=NOW() WHERE id=$1",owner,row["job_id"].as<std::string>(),published,name,Json::writeString(writer,snapshot));
    txn.exec_params("UPDATE project_environments SET current_deployment_id=$1,updated_at=NOW() WHERE id=(SELECT environment_id FROM deployments WHERE id=$1)",owner);
    txn.exec_params("INSERT INTO deployment_runtime_candidates(job_id,attempt,deployment_id,provider,resource_key,status) VALUES($1,$2,$3,'local_docker',$4,'promoted') ON CONFLICT DO NOTHING",row["job_id"].as<std::string>(),row["attempt"].as<int>(),owner,name);
    txn.commit();candidate.promoted=true;
    // Confirm that the stable origin actually reaches the recovered runtime.
    // Do not replay mutating browser/device scenarios twice.
    if(published!=url) {
        Json::Value transport=plan;transport["verification_scope"]="http_contract";transport["workload"]="api";
        for(const auto& key:{"repository_plan","component_contracts","component_runtime"})transport.removeMember(key);
        Json::Value request;request["url"]=published;request["contract"]=transport;
        auto routed=AiServiceClient::instance().postWorkflow("/runtime/verify",request);
        pqxx::work observed(*connection);
        observed.exec_params("UPDATE deployments SET runtime_snapshot=runtime_snapshot||jsonb_build_object('routed_verification',$2::jsonb) WHERE id=$1 AND job_id=$3",owner,Json::writeString(writer,routed.body),row["job_id"].as<std::string>());
        observed.commit();
        if(!routed.ok || !routed.body.get("verified",false).asBool()) {
            pqxx::work compensate(*connection);
            auto stillOwned=compensate.exec_params("SELECT environment_id FROM environment_runtime_routes WHERE environment_id=$1 AND job_id=$2 AND upstream_url=$3 FOR UPDATE",environment,row["job_id"].as<std::string>(),url);
            if(!stillOwned.empty()) {
                if(!previousRoute.empty()) {
                    compensate.exec_params("UPDATE environment_runtime_routes SET deployment_id=$2::uuid,job_id=$3::uuid,upstream_url=$4,verification=$5::jsonb,generation=generation+1,updated_at=NOW() WHERE environment_id=$1",environment,previousRoute["deployment_id"].asString(),previousRoute["job_id"].asString(),previousRoute["upstream_url"].asString(),previousRoute["verification"].asString());
                    compensate.exec_params("UPDATE project_environments SET current_deployment_id=$2::uuid WHERE id=$1",environment,previousRoute["deployment_id"].asString());
                } else {
                    compensate.exec_params("DELETE FROM environment_runtime_routes WHERE environment_id=$1",environment);
                    compensate.exec_params("UPDATE project_environments SET current_deployment_id=NULL WHERE id=$1",environment);
                }
                const auto before=restored[0];
                compensate.exec_params("UPDATE deployments SET status=$2,job_id=NULLIF($3,'')::uuid,runtime_url=$4,remote_container_name=$5,runtime_snapshot=$6::jsonb,artifact_available=$7,runtime_paused=$8,updated_at=NOW() WHERE id=$1 AND job_id=$9",owner,before["status"].as<std::string>(),before["job_id"].is_null()?"":before["job_id"].as<std::string>(),before["runtime_url"].is_null()?"":before["runtime_url"].as<std::string>(),before["remote_container_name"].is_null()?"":before["remote_container_name"].as<std::string>(),before["runtime_snapshot"].as<std::string>(),before["artifact_available"].as<bool>(),before["runtime_paused"].as<bool>(),row["job_id"].as<std::string>());
                candidate.promoted=false;
            }
            compensate.commit();
            throw std::runtime_error("Routed rollback verification failed; recovery was not declared successful");
        }
    }
    Json::Value result;result["success"]=true;result["status"]="restored";result["verification"]=proof;result["restored_deployment_id"]=owner;result["runtime_url"]=published;return result;
}
}
