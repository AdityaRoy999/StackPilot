// ============================================================
// LocalDockerRuntime.cpp
// ============================================================

#include "LocalDockerRuntime.h"

#include "../utils/StringUtils.h"

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <json/json.h>
#include <sstream>
#include <stdexcept>
#ifndef _WIN32
#include <sys/wait.h>
#endif

namespace stackpilot {

using strings::shellQuote;
using strings::trim;

std::string LocalDockerRuntime::markerValue(const std::string& output, const std::string& marker) {
    std::istringstream stream(output);
    std::string line;
    const std::string prefix = marker + "=";
    while (std::getline(stream, line)) {
        if (line.rfind(prefix, 0) == 0) {
            return trim(line.substr(prefix.size()));
        }
    }
    return "";
}

std::string LocalDockerRuntime::sanitizeContainerName(const std::string& raw) {
    std::string cleaned;
    cleaned.reserve(std::min<size_t>(raw.size(), 96));
    for (char c : raw) {
        const bool ok = std::isalnum(static_cast<unsigned char>(c)) || c == '_' || c == '.' || c == '-';
        cleaned.push_back(ok ? static_cast<char>(std::tolower(static_cast<unsigned char>(c))) : '-');
        if (cleaned.size() >= 96) {
            break;
        }
    }
    while (!cleaned.empty() && cleaned.front() == '-') {
        cleaned.erase(cleaned.begin());
    }
    while (!cleaned.empty() && cleaned.back() == '-') {
        cleaned.pop_back();
    }
    return cleaned.empty() ? "deployment" : cleaned;
}

bool LocalDockerRuntime::isValidRuntimeEnvKey(const std::string& key) {
    if (key.empty()) {
        return false;
    }
    if (!(std::isalpha(static_cast<unsigned char>(key.front())) || key.front() == '_')) {
        return false;
    }
    for (char c : key) {
        if (!(std::isalnum(static_cast<unsigned char>(c)) || c == '_')) {
            return false;
        }
    }
    return true;
}

bool LocalDockerRuntime::isValidImageRef(const std::string& value) {
    const std::string cleaned = trim(value);
    if (cleaned.empty() || cleaned.size() > 255) {
        return false;
    }
    for (char c : cleaned) {
        const bool ok = std::isalnum(static_cast<unsigned char>(c)) ||
                        c == '_' || c == '.' || c == '-' || c == '/' ||
                        c == ':' || c == '@';
        if (!ok) {
            return false;
        }
    }
    return true;
}

std::string LocalDockerRuntime::makeRunCommand(const std::string& containerName,
                                      const std::string& imageName,
                                      int containerPort,
                                      const std::vector<std::pair<std::string, std::string>>& envVars,
                                      const std::string& protocol,
                                      const std::string& healthPath) {
    std::string envArgs;
    for (const auto& envVar : envVars) {
        if (!isValidRuntimeEnvKey(envVar.first)) {
            continue;
        }
        const std::string& value = envVar.second;
        envArgs += " --env " + shellQuote(envVar.first + "=" + value);
    }

    const std::string container = shellQuote(containerName);
    const std::string image = shellQuote(imageName);
    const char* network = std::getenv("STACKPILOT_RUNTIME_NETWORK");
    const bool internalNetwork = network && *network;
    const std::string networkArgs = internalNetwork ? " --network " + shellQuote(network) : "";
    if (protocol == "process") {
        return "set -e; docker image inspect " + image + " >/dev/null; "
            "if docker inspect " + container + " >/dev/null 2>&1; then echo 'Existing runtime requires a separate candidate identity'; exit 14; fi; "
            "docker run -d --restart unless-stopped --cpus 2 --memory 2g --pids-limit 256 --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID --cap-add DAC_OVERRIDE --security-opt no-new-privileges:true --label stackpilot.managed=true --name " + container + envArgs + " " + image + "; echo __STACKPILOT_CANDIDATE_CREATED__; "
            "sleep 3; [ \"$(docker inspect --format '{{.State.Running}}' " + container + ")\" = true ] || { docker logs --tail 50 " + container + "; exit 1; }; "
            "echo __STACKPILOT_LOCAL_DOCKER_RUNNING__; echo __STACKPILOT_PROCESS_OBSERVED__; echo container_name=" + containerName + "; echo status=running;";
    }
    const std::string requestedPort = std::to_string(std::clamp(containerPort, 0, 65535));
    return
        "set -e; "
        "command -v docker >/dev/null 2>&1 || { echo __STACKPILOT_DOCKER_MISSING__; exit 10; }; "
        "docker info >/dev/null 2>&1 || { echo __STACKPILOT_DOCKER_DAEMON_DOWN__; exit 11; }; "
        "docker image inspect " + image + " >/dev/null 2>&1 || { echo __STACKPILOT_IMAGE_MISSING__; exit 12; }; "
        "requested_port=" + requestedPort + "; "
        "if [ \"$requested_port\" -gt 0 ]; then "
        "container_port=\"$requested_port\"; "
        "else "
        "ports=$(docker image inspect --format '{{range $p, $_ := .Config.ExposedPorts}}{{println $p}}{{end}}' " + image + " 2>/dev/null | sed -n 's#/tcp$##p'); "
        "[ \"$(printf '%s\\n' \"$ports\" | sed '/^$/d' | wc -l)\" -eq 1 ] || { echo 'Declare one application port in stackpilot.json; EXPOSE is missing or ambiguous'; exit 15; }; "
        "container_port=$ports; "
        "fi; "
        "container=" + container + "; "
        "if docker inspect " + container + " >/dev/null 2>&1; then echo 'Existing runtime requires a separate candidate identity; replacement refused'; exit 14; fi; "
        "docker run -d --restart unless-stopped --cpus 2 --memory 2g --pids-limit 256 --cap-drop ALL --cap-add NET_BIND_SERVICE --cap-add CHOWN --cap-add SETUID --cap-add SETGID --cap-add DAC_OVERRIDE --security-opt no-new-privileges:true --label stackpilot.managed=true --name " + container + envArgs +
        networkArgs + " -p 127.0.0.1::$container_port " + image + " >/tmp/stackpilot-local-container-id; "
        "echo __STACKPILOT_CANDIDATE_CREATED__; "
        "host_port=$(docker port " + container + " $container_port/tcp 2>/dev/null | awk -F: 'NF {print $NF; exit}'); "
        "[ -n \"$host_port\" ] || { echo __STACKPILOT_PORT_MISSING__; docker logs --tail 80 " + container + " || true; exit 13; }; "
        + (internalNetwork ? "probe_host=" + container + "; probe_port=$container_port; " : "probe_host=127.0.0.1; probe_port=$host_port; ") +
        "ready=0; "
        "for i in $(seq 1 45); do "
        "status=$(docker inspect --format '{{.State.Status}}' \"$container\" 2>/dev/null || echo \"exited\"); "
        "if [ \"$status\" = \"exited\" ] || [ \"$status\" = \"dead\" ]; then "
        "echo \"Container crashed on startup:\"; "
        "docker logs --tail 50 \"$container\" 2>&1; "
        "exit 1; "
        "fi; "
        "if [ -n \"$host_port\" ]; then "
        + (protocol == "tcp" ?
        "if python3 -c 'import socket,sys; socket.create_connection((sys.argv[1],int(sys.argv[2])),2).close()' \"$probe_host\" \"$probe_port\" >/dev/null 2>&1 || python3 -c 'import socket,sys; socket.create_connection((\"host.docker.internal\",int(sys.argv[1])),2).close()' \"$host_port\" >/dev/null 2>&1; then ready=1; break; fi; " : "") +
        "health_path=" + shellQuote(healthPath) + "; "
        "code=$(curl -s -o /dev/null -w \"%{http_code}\" --max-time 3 \"http://$probe_host:$probe_port$health_path\" 2>/dev/null || true); "
        "case \"$code\" in "
        "  2*|3*|401|403|404) ready=1; break ;; "
        "  5*) echo \"Container HTTP server returned fatal error code: $code\"; docker logs --tail 60 \"$container\" 2>&1; exit 1 ;; "
        "  *) "
        "    code_alt=$(curl -s -o /dev/null -w \"%{http_code}\" --max-time 3 \"http://host.docker.internal:$host_port$health_path\" 2>/dev/null || true); "
        "    case \"$code_alt\" in "
        "      2*|3*|401|403|404) ready=1; break ;; "
        "      5*) echo \"Container HTTP server returned fatal error code: $code_alt\"; docker logs --tail 60 \"$container\" 2>&1; exit 1 ;; "
        "    esac ;; "
        "esac; "
        "else "
        "if [ \"$status\" = \"running\" ]; then ready=1; break; fi; "
        "fi; "
        "sleep 1; "
        "done; "
        "status=$(docker inspect --format '{{.State.Status}}' \"$container\" 2>/dev/null || echo \"exited\"); "
        "if [ \"$status\" = \"exited\" ] || [ \"$status\" = \"dead\" ]; then "
        "echo \"Container crashed on startup:\"; "
        "docker logs --tail 50 \"$container\" 2>&1; "
        "exit 1; "
        "fi; "
        "if [ \"$ready\" -ne 1 ]; then "
        "echo \"Container readiness probe failed or timed out:\"; "
        "docker logs --tail 50 \"$container\" 2>&1 || true; "
        "exit 1; "
        "fi; "
        "running=$(docker inspect --format '{{.State.Running}}' \"$container\" 2>/dev/null || echo \"false\"); "
        "[ \"$running\" = true ] || { echo 'Candidate disappeared before acceptance'; exit 16; }; "
        "echo __STACKPILOT_LOCAL_DOCKER_RUNNING__; "
        "echo __STACKPILOT_LOCAL_DOCKER_PORT__=$host_port; "
        "echo container_name=" + containerName + "; "
        "echo container_port=$container_port; "
        "echo host_port=$host_port; "
        "echo runtime_url=" + (protocol == "tcp" ? std::string("tcp") : std::string("http")) + "://localhost:$host_port; "
        + (internalNetwork ? "echo runtime_internal_url=" + shellQuote((protocol == "tcp" ? std::string("tcp") : std::string("http")) + "://" + containerName) + ":$container_port; " : "") +
        "echo status=$status; "
        "echo running=$running; "
        "echo image=" + imageName + "; "
        "echo __STACKPILOT_LOCAL_LOG_TAIL__; "
        "docker logs --tail 80 \"$container\" 2>&1 || true";
}

std::string LocalDockerRuntime::makePauseCommand(const std::string& containerName, bool paused) {
    const std::string container = shellQuote(containerName);
    return "set -e; "
           "command -v docker >/dev/null 2>&1 || { echo __STACKPILOT_DOCKER_MISSING__; exit 10; }; "
           "docker info >/dev/null 2>&1 || { echo __STACKPILOT_DOCKER_DAEMON_DOWN__; exit 11; }; "
           "docker inspect " + container + " >/dev/null 2>&1 || { echo __STACKPILOT_CONTAINER_MISSING__; exit 12; }; "
           "docker " + std::string(paused ? "pause " : "unpause ") + container + " >/dev/null; "
           "docker inspect --format 'status={{.State.Status}}\nrunning={{.State.Running}}\npaused={{.State.Paused}}\nimage={{.Config.Image}}\nstarted_at={{.State.StartedAt}}\nfinished_at={{.State.FinishedAt}}\nrestart_count={{.RestartCount}}' " + container;
}

std::string LocalDockerRuntime::makeComposeObservationCommand(const std::string& runtimeRoot,
                                                             const std::string& project,
                                                             const std::string& modelPath,
                                                             const std::string& planPath,
                                                             const std::string& outputPath,
                                                             bool identityOnly,
                                                             bool allowRestarts) {
    return "timeout 90s python3 " + shellQuote(runtimeRoot + "/compose_runtime_evidence.py") +
           " " + shellQuote(project) + " " + shellQuote(modelPath) + " " + shellQuote(planPath) +
           " " + shellQuote(outputPath) + (identityOnly ? " --identity-only" : "") + (allowRestarts ? " --allow-restarts" : "");
}

Json::Value LocalDockerRuntime::freshComponentContract(const Json::Value& snapshot, bool executeChecks) {
    namespace fs=std::filesystem;
    Json::Value plan=snapshot["deployment_plan"];
    if(!plan["repository_plan"].isObject())return plan;
    const auto project=snapshot.get("compose_project","").asString();
    const auto rawWorkdir=snapshot.get("compose_workdir","").asString();
    const auto rawFile=snapshot.get("compose_file","").asString();
    if(project.empty() || rawWorkdir.empty() || rawFile.empty())throw std::runtime_error("Saved local component topology is unavailable");
    const char* configured=std::getenv("BUILD_WORKSPACE_DIR");
    const auto workspace=fs::weakly_canonical(configured&&*configured?fs::path(configured):fs::path("uploads/builds"));
    const auto workdir=fs::canonical(rawWorkdir);
    const auto relative=workdir.lexically_relative(workspace);
    if(relative.empty() || relative.is_absolute() || *relative.begin()==".." || relative==".")
        throw std::runtime_error("Saved component workspace is outside the managed build root");
    const fs::path file(rawFile);
    if(file.is_absolute() || file.empty())throw std::runtime_error("Invalid saved Compose model path");
    for(const auto& part:file)if(part=="..")throw std::runtime_error("Saved Compose model escapes its candidate");
    const auto model=fs::canonical(workdir/file);
    const auto modelRelative=model.lexically_relative(workdir);
    if(modelRelative.empty() || modelRelative.is_absolute() || *modelRelative.begin()==".." || !fs::is_regular_file(model))
        throw std::runtime_error("Saved Compose model is unavailable or escaping");
    const auto nonce=std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
    const auto input=workdir/("component-refresh-"+nonce+"-plan.json");
    const auto output=workdir/("component-refresh-"+nonce+"-evidence.json");
    struct Files {
        fs::path input,output;
        ~Files(){std::error_code ignored;fs::remove(input,ignored);fs::remove(output,ignored);}
    } files{input,output};
    Json::StreamWriterBuilder writer;writer["indentation"]="";
    {std::ofstream stream(input);stream<<Json::writeString(writer,plan);if(!stream)throw std::runtime_error("Component observation plan could not be saved");}
    fs::permissions(input,fs::perms::owner_read|fs::perms::owner_write,fs::perm_options::replace);
    const char* runtime=std::getenv("STACKPILOT_DEPLOYMENT_RUNTIME_ROOT");
    std::string observed;
    if(run(makeComposeObservationCommand(runtime&&*runtime?runtime:"/app/deployment-runtime",project,model.string(),input.string(),output.string(),!executeChecks,true)+" 2>&1",observed)!=0)
        throw std::runtime_error("Fresh component daemon observations are unavailable");
    Json::Value evidence;Json::CharReaderBuilder reader;std::string errors;std::ifstream stream(output);
    if(!stream || !Json::parseFromStream(reader,stream,&evidence,&errors) || !evidence["components"].isObject())
        throw std::runtime_error("Fresh component daemon evidence is invalid");
    plan["component_runtime"]=evidence;return plan;
}

int LocalDockerRuntime::run(const std::string& command, std::string& output) {
    output.clear();
    FILE* pipe = popen(command.c_str(), "r");
    if (!pipe) {
        output = "Failed to start local command";
        return 1;
    }

    char buffer[4096];
    while (fgets(buffer, sizeof(buffer), pipe) != nullptr) {
        output += buffer;
    }

    const int status = pclose(pipe);
#ifdef _WIN32
    return status;
#else
    if (WIFEXITED(status)) {
        return WEXITSTATUS(status);
    }
    return status;
#endif
}

SshOperationResult LocalDockerRuntime::removeContainer(const std::string& containerName,
                                             const std::string& imageName,
                                             bool removeImage) {
    SshOperationResult result;
    if (trim(containerName).empty()) {
        result.error = "Local Docker container name is missing";
        return result;
    }
    const std::string command =
        "timeout 60s sh -lc " + shellQuote(
            std::string("set -e; ")
            + "command -v docker >/dev/null 2>&1 || { echo __STACKPILOT_DOCKER_MISSING__; exit 10; }; "
            + "docker info >/dev/null 2>&1 || { echo __STACKPILOT_DOCKER_DAEMON_DOWN__; exit 11; }; "
            + "if docker inspect " + shellQuote(containerName) + " >/dev/null 2>&1; then docker rm -f " + shellQuote(containerName) + " >/dev/null || exit 17; fi; "
            + "if docker inspect " + shellQuote(containerName) + " >/dev/null 2>&1; then echo 'Container still exists after removal'; exit 18; fi; "
            + "echo __STACKPILOT_LOCAL_CONTAINER_REMOVED__; "
            + (removeImage && !imageName.empty()
                ? "docker image rm -f " + shellQuote(imageName) + " >/dev/null 2>&1 || true; echo __STACKPILOT_LOCAL_IMAGE_REMOVE_ATTEMPTED__;"
                : "")
        );
    std::string output;
    const int exitCode = run(command, output);
    result.exitCode = exitCode;
    result.output = output;
    if (exitCode != 0 || output.find("__STACKPILOT_LOCAL_CONTAINER_REMOVED__") == std::string::npos) {
        result.error = exitCode == 124 ? "Local Docker runtime removal timed out" : "Failed to remove local Docker runtime";
        return result;
    }
    result.success = true;
    return result;
}

SshOperationResult LocalDockerRuntime::removeImage(const std::string& imageName) {
    SshOperationResult result;
    if (!isValidImageRef(imageName)) {
        result.error = "Invalid or missing Docker image reference";
        return result;
    }

    std::string registryImage = "localhost:5000/" + imageName;
    const std::string dockerIoPrefix = "localhost:5000/docker.io/";
    if (registryImage.rfind(dockerIoPrefix, 0) == 0) {
        registryImage = "localhost:5000/" + registryImage.substr(dockerIoPrefix.size());
    }

    const std::string command =
        "timeout 45s sh -lc " + shellQuote(
            "set -e; "
            "command -v docker >/dev/null 2>&1 || { echo __STACKPILOT_DOCKER_MISSING__; exit 10; }; "
            "docker info >/dev/null 2>&1 || { echo __STACKPILOT_DOCKER_DAEMON_DOWN__; exit 11; }; "
            "failed=0; "
            "for img in " + shellQuote(imageName) + " " + shellQuote(registryImage) + "; do "
            "  [ -n \"$img\" ] || continue; "
            "  if docker image inspect \"$img\" >/dev/null 2>&1; then "
            "    if docker image rm \"$img\" >/dev/null 2>&1; then "
            "      echo __STACKPILOT_LOCAL_IMAGE_REMOVED__=$img; "
            "    else "
            "      echo __STACKPILOT_LOCAL_IMAGE_REMOVE_FAILED__=$img; failed=1; "
            "    fi; "
            "  else "
            "    echo __STACKPILOT_LOCAL_IMAGE_ALREADY_ABSENT__=$img; "
            "  fi; "
            "done; "
            "[ \"$failed\" -eq 0 ] || exit 12; "
            "echo __STACKPILOT_LOCAL_IMAGE_CLEANUP_DONE__"
        );

    std::string output;
    const int exitCode = run(command, output);
    result.exitCode = exitCode;
    result.output = output;
    if (exitCode != 0 || output.find("__STACKPILOT_LOCAL_IMAGE_CLEANUP_DONE__") == std::string::npos) {
        if (output.find("__STACKPILOT_DOCKER_MISSING__") != std::string::npos) {
            result.error = "Docker is not installed on this host";
        } else if (output.find("__STACKPILOT_DOCKER_DAEMON_DOWN__") != std::string::npos) {
            result.error = "Docker daemon is not reachable on this host";
        } else if (output.find("__STACKPILOT_LOCAL_IMAGE_REMOVE_FAILED__") != std::string::npos) {
            result.error = "Docker image could not be deleted because it may still be in use";
        } else if (exitCode == 124) {
            result.error = "Docker image cleanup timed out";
        } else {
            result.error = "Failed to remove Docker image";
        }
        return result;
    }
    result.success = true;
    return result;
}

}  // namespace stackpilot
