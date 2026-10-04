#pragma once
#include <json/json.h>
#include <string>
namespace stackpilot {
class ReleaseCheckpointService {
public:
    static Json::Value rollbackLocal(const std::string& deploymentId,const std::string& userId);
};
}
