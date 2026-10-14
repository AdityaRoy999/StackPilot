#pragma once
#include <json/json.h>
#include <pqxx/pqxx>
#include <map>
#include <set>
#include <string>
#include <stdexcept>

namespace stackpilot {
// Callers establish project access before loading this metadata. No value or
// encrypted-value column is selected; execution retains its own secret path.
inline Json::Value deploymentEnvironmentContext(pqxx::work& tx, const std::string& projectId,
                                                const std::string& deploymentId) {
    Json::Value out(Json::objectValue), environments(Json::arrayValue), keys(Json::arrayValue);
    const auto projects=tx.exec_params("SELECT id,name,repo_url,source_type,execution_mode FROM projects WHERE id=$1::uuid",projectId);
    if(projects.empty())throw std::runtime_error("Project context is unavailable");
    for(const auto* field:{"id","name","repo_url","source_type","execution_mode"})
        out["project"][field]=projects[0][field].is_null()?"":projects[0][field].as<std::string>();
    const auto envs=tx.exec_params(
        "SELECT e.id,e.name,e.branch,e.execution_mode,e.remote_runtime_type,e.runtime_scheme,e.remote_connection_id,"
        "s.name AS connection_name,e.require_ci,e.auto_deploy FROM project_environments e "
        "LEFT JOIN ssh_connections s ON s.id=e.remote_connection_id WHERE e.project_id=$1::uuid ORDER BY e.name",projectId);
    std::set<std::string> branches;
    for(const auto& row:envs) {
        Json::Value item(Json::objectValue);
        for(const auto* field:{"id","name","branch","execution_mode","remote_runtime_type","runtime_scheme","remote_connection_id","connection_name"})
            item[field]=row[field].is_null()?"":row[field].as<std::string>();
        item["require_ci"]=row["require_ci"].as<bool>();item["auto_deploy"]=row["auto_deploy"].as<bool>();
        branches.insert(item["branch"].asString());environments.append(item);
    }
    out["environments"]=environments;
    std::string selected;
    if(!deploymentId.empty()) {
        const auto deps=tx.exec_params(
            "SELECT d.id,d.branch,d.commit_sha,d.commit_hash,d.environment_id,e.name AS environment_name,"
            "COALESCE(e.execution_mode,p.execution_mode) AS execution_mode,"
            "COALESCE(e.remote_runtime_type,p.remote_runtime_type) AS remote_runtime_type,"
            "COALESCE(e.remote_connection_id,p.remote_connection_id) AS remote_connection_id,"
            "s.name AS connection_name,d.ci_required,d.ci_status FROM deployments d JOIN projects p ON p.id=d.project_id "
            "LEFT JOIN project_environments e ON e.id=d.environment_id AND e.project_id=p.id "
            "LEFT JOIN ssh_connections s ON s.id=COALESCE(e.remote_connection_id,p.remote_connection_id) "
            "WHERE d.id=$2::uuid AND p.id=$1::uuid",projectId,deploymentId);
        if(deps.empty())throw std::runtime_error("Deployment does not belong to the selected project");
        for(const auto* field:{"id","branch","commit_sha","commit_hash","environment_id","environment_name","execution_mode","remote_runtime_type","remote_connection_id","connection_name","ci_status"})
            out["deployment"][field]=deps[0][field].is_null()?"":deps[0][field].as<std::string>();
        out["deployment"]["ci_required"]=deps[0]["ci_required"].as<bool>();
        selected=out["deployment"]["environment_id"].asString();
        branches.insert(out["deployment"]["branch"].asString());
    }
    const auto variables=tx.exec_params(
        "SELECT key,''::text AS environment_id,'project' AS scope,0 AS priority FROM project_env_vars WHERE project_id=$1::uuid "
        "UNION ALL SELECT v.key,v.environment_id::text,'environment',1 FROM project_environment_env_vars v "
        "JOIN project_environments e ON e.id=v.environment_id WHERE e.project_id=$1::uuid "
        "UNION ALL SELECT key,COALESCE(environment_id::text,''),'credential',CASE WHEN environment_id IS NULL THEN 2 ELSE 3 END "
        "FROM project_secrets WHERE project_id=$1::uuid ORDER BY priority,key",projectId);
    std::map<std::string,Json::Value> effective;
    for(const auto& row:variables) {
        Json::Value item(Json::objectValue);
        item["key"]=row["key"].as<std::string>();item["scope"]=row["scope"].as<std::string>();
        item["environment_id"]=row["environment_id"].as<std::string>();
        item["visibility"]=row["priority"].as<int>()>=2?"secret":
            (item["key"].asString().rfind("VITE_",0)==0||item["key"].asString().rfind("NEXT_PUBLIC_",0)==0||
             item["key"].asString().rfind("REACT_APP_",0)==0||item["key"].asString().rfind("PUBLIC_",0)==0?"public":"server");
        keys.append(item);
        if(item["environment_id"].asString().empty()||(!selected.empty()&&item["environment_id"].asString()==selected))
            effective[item["key"].asString()]=item;
    }
    out["env_keys"]=keys;out["effective_env_keys"]=Json::Value(Json::arrayValue);
    for(const auto& entry:effective)out["effective_env_keys"].append(entry.second);
    out["configured_branches"]=Json::Value(Json::arrayValue);
    for(const auto& branch:branches)if(!branch.empty())out["configured_branches"].append(branch);
    out["branch_catalog_scope"]="selected_source_and_environment_mappings";
    out["environment_selected"]=!selected.empty();out["values_visible"]=false;out["version"]=1;
    return out;
}
}
