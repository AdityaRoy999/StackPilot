#pragma once

#include <filesystem>
#include <json/json.h>
#include <map>
#include <string>

namespace stackpilot {

// Read-only, bounded manifest inspection. Results never include source contents,
// credentials, or environment values and never execute repository code.
class ProjectStackInspector {
public:
    using Manifests = std::map<std::string, std::string>;
    static bool isManifest(const std::string& path);
    static Json::Value detect(const Manifests& files, bool truncated = false);
    static Json::Value application(const std::string& image);
    static Json::Value local(const std::filesystem::path& root);
    static Json::Value github(const std::string& repositoryUrl, const std::string& token,
                              const std::string& branch = "HEAD");
    static std::string remoteCommand();
    static Json::Value remoteOutput(const std::string& output);
    static Json::Value unavailable(const std::string& message);
};

} // namespace stackpilot
