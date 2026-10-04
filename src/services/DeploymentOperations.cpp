#include "DeploymentOperations.h"
#include "../db/Database.h"
#include "../utils/StringUtils.h"
#include "../utils/TokenCrypto.h"
#include "ClusterTargets.h"
#include "KubernetesService.h"
#include "SshService.h"
#include <pqxx/pqxx>
#include <cstdio>
#include <sys/wait.h>

namespace stackpilot {
namespace {
struct Target {
    std::string provider, container, ns, deployment, service, ingress, exposure, scheme;
    SshConnectionConfig remote;
};
Target target(const std::string& id, const std::string& user, bool mutate = false) {
    auto conn = Database::getInstance().getConnection(); pqxx::work txn(*conn);
    auto rows = txn.exec_params(
        "SELECT d.*, rs.host, rs.port, rs.username, rs.auth_type, rs.password_encrypted, "
        "rs.private_key_encrypted, rs.known_hosts_entry FROM deployments d "
        "JOIN projects p ON p.id=d.project_id LEFT JOIN project_environments e ON e.id=d.environment_id "
        "LEFT JOIN ssh_connections rs ON rs.id=COALESCE(d.remote_connection_id,e.remote_connection_id,p.remote_connection_id) "
        "WHERE d.id=$1 AND has_project_access(p.id,$2,$3)", id,user,mutate?"admin":"viewer");
    if (rows.empty()) throw std::runtime_error("Deployment not found or access denied");
    const auto row=rows[0]; auto text=[&](const char* key){return row[key].is_null()?std::string():row[key].as<std::string>();};
    Target t; t.provider=text("runtime_provider"); t.container=text("remote_container_name");
    t.ns=text("k8s_namespace"); t.deployment=text("k8s_deployment_name"); t.service=text("k8s_service_name");
    t.ingress=text("k8s_ingress_name");t.exposure=text("runtime_exposure");t.scheme="http";
    t.remote.host=text("host");t.remote.port=row["port"].is_null()?22:row["port"].as<int>();
    t.remote.username=text("username");t.remote.authType=text("auth_type");
    t.remote.password=TokenCrypto::decrypt(text("password_encrypted"));
    t.remote.privateKey=TokenCrypto::decrypt(text("private_key_encrypted"));
    t.remote.knownHostsEntry=text("known_hosts_entry"); txn.commit(); return t;
}
Json::Value command(const Target& t, const std::string& cmd) {
    std::string output; int code=1;
    if (t.provider.rfind("remote_",0)==0) {
        auto r=SshService().runRemoteCommand(t.remote,"/",cmd,30); output=r.output;code=r.success?0:1;
    } else {
        FILE* pipe=popen(("timeout 30s "+cmd+" 2>&1").c_str(),"r");
        if(pipe){char b[4096];while(fgets(b,sizeof(b),pipe)){if(output.size()<65536)output+=std::string(b).substr(0,65536-output.size());}int status=pclose(pipe);code=WIFEXITED(status)?WEXITSTATUS(status):1;}
    }
    Json::Value result;result["status"]=code==0?"observed":"unavailable";result["observed"]=code==0;
    result["output"]=output;result["exit_code"]=code;return result;
}
}
Json::Value DeploymentOperations::metrics(const std::string& id,const std::string& user) {
    try {
        auto t=target(id,user);
        if(t.provider=="local_docker"||t.provider=="remote_docker"){
            auto r=command(t,"docker stats --no-stream --format '{{json .}}' "+strings::shellQuote(t.container));
            r["source"]="docker_stats";return r;
        }
        if(t.provider=="remote_kubernetes") return command(t,"kubectl -n "+strings::shellQuote(t.ns)+" top pods -l app="+strings::shellQuote(t.deployment));
        Json::Value r;r["status"]="unavailable";r["observed"]=false;
        r["reason"]="No metrics adapter for this provider; no synthetic values returned";return r;
    } catch(const std::exception& e){Json::Value r;r["error"]=e.what();return r;}
}
Json::Value DeploymentOperations::events(const std::string& id,const std::string& user) {
    try {
        auto t=target(id,user);
        if(t.provider=="remote_kubernetes") return command(t,"kubectl -n "+strings::shellQuote(t.ns)+" get events --field-selector involvedObject.name="+strings::shellQuote(t.deployment)+" -o json");
        if(t.provider=="kubernetes"){
            KubernetesService service(ClusterTargets::forDeployment(id).kubeconfig);
            Json::Value r;r["output"]=service.collectEvents(t.ns,t.deployment,t.ingress,t.exposure);r["status"]="observed";r["source"]="kubernetes";return r;
        }
        Json::Value r;r["status"]="not_applicable";r["reason"]="This deployment does not run on Kubernetes";return r;
    } catch(const std::exception& e){Json::Value r;r["error"]=e.what();return r;}
}
Json::Value DeploymentOperations::scale(const std::string& id,const std::string& user,int replicas) {
    try {
        if(replicas<0||replicas>20)throw std::runtime_error("Replica count must be 0–20");
        auto t=target(id,user,true);KubernetesRuntimeInfo observed;
        if(t.provider=="remote_kubernetes")observed=SshService().scaleKubernetesRuntime(t.remote,t.ns,t.deployment,t.service,t.exposure,replicas,t.scheme);
        else if(t.provider=="kubernetes"){
            KubernetesService service(ClusterTargets::forDeployment(id).kubeconfig);
            observed=service.scale(t.ns,t.deployment,t.service,t.exposure,replicas,t.scheme);
        }else throw std::runtime_error("Replica scaling requires a Kubernetes provider; Docker scaling is not implemented");
        if(!observed.success)throw std::runtime_error(observed.error);
        auto conn=Database::getInstance().getConnection();pqxx::work txn(*conn);
        txn.exec_params("UPDATE deployments SET desired_replicas=$1,runtime_paused=$2,status=$3,updated_at=NOW() WHERE id=$4",replicas,replicas==0,observed.status,id);txn.commit();
        Json::Value r;r["status"]=observed.status;r["desired_replicas"]=replicas;r["ready_replicas"]=observed.readyReplicas;r["runtime_observed"]=true;return r;
    } catch(const std::exception& e){Json::Value r;r["error"]=e.what();return r;}
}
}
