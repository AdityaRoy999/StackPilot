#pragma once

#include <algorithm>
#include <cctype>
#include <string>

namespace stackpilot {

// Match local Git metadata failures only. Remote SSH/authentication permission
// errors must not be retried as a filesystem problem.
inline bool isRetryableGitWorkspaceFailure(std::string output) {
    std::transform(output.begin(), output.end(), output.begin(),
        [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    const bool metadataWrite = output.find("could not write config file") != std::string::npos ||
        (output.find("unable to create") != std::string::npos &&
         output.find(".git/") != std::string::npos);
    return metadataWrite && (output.find("permission denied") != std::string::npos ||
        output.find("resource temporarily unavailable") != std::string::npos ||
        output.find("device or resource busy") != std::string::npos);
}

inline bool isRetryableGitCloneFailure(const std::string& output) {
    return isRetryableGitWorkspaceFailure(output) ||
        output.find("Could not resolve host:") != std::string::npos ||
        output.find("Failed to connect to github.com") != std::string::npos ||
        output.find("Connection timed out") != std::string::npos ||
        output.find("RPC failed; curl 56") != std::string::npos ||
        output.find("fatal: early EOF") != std::string::npos;
}

} // namespace stackpilot
