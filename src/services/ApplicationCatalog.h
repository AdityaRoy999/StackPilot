#pragma once

#include "BuildService.h"
#include <filesystem>
#include <json/value.h>
#include <string>
#include <vector>

namespace stackpilot {

struct ApplicationField {
    std::string id;
    std::string label;
    std::string type;
    std::string envKey;
    std::string defaultValue;
    bool secret = false;
    bool required = true;
};

struct ApplicationTemplate {
    std::string id;
    std::string name;
    std::string category;
    std::string description;
    std::string serviceName;
    std::string image;
    int primaryPort = 0;
    std::vector<ApplicationField> fields;
};

class ApplicationCatalog {
public:
    static std::vector<ApplicationTemplate> templates();
    static const ApplicationTemplate* findTemplate(const std::string& templateId);
    static bool isSupportedTemplate(const std::string& templateId);
    static Json::Value templatesJson();
    static Json::Value sanitizedConfig(const std::string& templateId, const Json::Value& config);
    static std::vector<std::string> missingRequiredFields(const std::string& templateId, const Json::Value& config);
    static std::vector<BuildEnvVar> envVarsForConfig(const std::string& templateId, const Json::Value& config);
    static std::filesystem::path materializeSource(const std::string& deploymentId,
                                                   const std::string& projectName,
                                                   const std::string& templateId,
                                                   const Json::Value& config,
                                                   const std::filesystem::path& baseDir);
};

} // namespace stackpilot
