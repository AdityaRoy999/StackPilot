#pragma once

#include <json/json.h>
#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <filesystem>
#include <sstream>
#include <string>
#include <vector>

namespace stackpilot::LocalSourcePaths {
namespace fs = std::filesystem;

struct Root {
    fs::path path;
    std::string hostPath;
    std::string name;
};

inline std::string trim(std::string value) {
    const auto begin = value.find_first_not_of(" \t\r\n");
    if (begin == std::string::npos) return {};
    return value.substr(begin, value.find_last_not_of(" \t\r\n") - begin + 1);
}

inline bool within(const fs::path& candidate, const fs::path& root) {
    auto part = candidate.begin();
    for (const auto& rootPart : root) {
        if (part == candidate.end() || *part++ != rootPart) return false;
    }
    return true;
}

inline bool windowsPath(const std::string& value) {
    return value.size() >= 3 && std::isalpha(static_cast<unsigned char>(value[0])) &&
        value[1] == ':' && (value[2] == '/' || value[2] == '\\');
}

inline std::vector<Root> roots() {
    std::vector<Root> result;
    const char* mappings = std::getenv("LOCAL_SOURCE_ROOT_MAPPINGS");
    if (mappings && *mappings) {
        Json::Value data;
        Json::CharReaderBuilder builder;
        std::string errors;
        std::istringstream input(mappings);
        if (Json::parseFromStream(builder, input, &data, &errors) && data.isArray()) {
            for (const auto& item : data) {
                if (!item.isObject() || !item["path"].isString() || !item["host_path"].isString()) continue;
                const fs::path path(item["path"].asString());
                const auto host = item["host_path"].asString();
                if (!path.is_absolute() || host.empty() || host.find('\0') != std::string::npos) continue;
                if (!windowsPath(host) && !fs::path(host).is_absolute()) continue;
                result.push_back({path.lexically_normal(), host, item.get("name", host).asString()});
            }
        }
    }
    const char* configured = std::getenv("LOCAL_SOURCE_ROOTS");
    std::istringstream input(configured && *configured ? configured : "/app/local-projects");
    std::string item;
    while (std::getline(input, item, ';')) {
        fs::path path(trim(item));
        if (path.is_absolute() && std::none_of(result.begin(), result.end(), [&](const Root& root) { return root.path == path; }))
            result.push_back({path, "", path.filename().empty() ? path.string() : path.filename().string()});
    }
    return result;
}

inline fs::path containerPath(std::string requested, const std::vector<Root>& allowed) {
    // Saved projects retain their container path, even when the host is Windows.
    if (fs::path(requested).is_absolute()) {
        for (const auto& root : allowed)
            if (within(fs::path(requested).lexically_normal(), root.path)) return fs::path(requested);
    }
    for (const auto& root : allowed) {
        if (root.hostPath.empty()) continue;
        std::string host = root.hostPath;
        std::string candidate = requested;
        const bool windows = windowsPath(host);
        if (windows) {
            std::replace(host.begin(), host.end(), '\\', '/');
            std::replace(candidate.begin(), candidate.end(), '\\', '/');
        }
        while (host.size() > 1 && host.back() == '/') host.pop_back();
        auto prefix = candidate.substr(0, host.size());
        if (windows) {
            std::transform(prefix.begin(), prefix.end(), prefix.begin(), [](unsigned char c) { return std::tolower(c); });
            std::transform(host.begin(), host.end(), host.begin(), [](unsigned char c) { return std::tolower(c); });
        }
        if (prefix != host || (host != "/" && candidate.size() > host.size() && candidate[host.size()] != '/')) continue;
        const auto start = host == "/" ? 1 : host.size() + (candidate.size() > host.size() ? 1 : 0);
        return root.path / candidate.substr(start);
    }
    return fs::path(requested);
}

inline bool resolve(const std::string& raw, fs::path& resolved, std::string& error) {
    const auto cleaned = trim(raw);
    if (cleaned.empty() || cleaned.find('\0') != std::string::npos) {
        error = "Choose a local project folder";
        return false;
    }
    const auto allowed = roots();
    const auto requested = containerPath(cleaned, allowed);
    if (!requested.is_absolute()) {
        error = "Enter an absolute folder path on the computer running StackPilot";
        return false;
    }
    std::error_code ec;
    const auto canonical = fs::weakly_canonical(requested, ec);
    if (ec || !fs::is_directory(canonical, ec)) {
        error = "This folder is unavailable. Check the path, drive connection, and folder permissions";
        return false;
    }
    for (const auto& root : allowed) {
        const auto canonicalRoot = fs::weakly_canonical(root.path, ec);
        if (!ec && fs::is_directory(canonicalRoot, ec) && within(canonical, canonicalRoot)) {
            resolved = canonical;
            return true;
        }
    }
    error = "This folder is not shared with StackPilot. Start the desktop installation with stackpilot up to enable local drives";
    return false;
}

inline std::string hostPath(const fs::path& path) {
    // Prefer the most specific mapping when an administrator shares nested paths.
    const Root* best = nullptr;
    const auto allowed = roots();
    for (const auto& root : allowed)
        if (!root.hostPath.empty() && within(path, root.path) && (!best || root.path.native().size() > best->path.native().size())) best = &root;
    if (!best) return path.string();
    auto host = best->hostPath;
    std::replace(host.begin(), host.end(), '\\', '/');
    const auto relative = path.lexically_relative(best->path).generic_string();
    if (!relative.empty() && relative != ".") {
        if (host.back() != '/') host += '/';
        host += relative;
    }
    if (windowsPath(host)) std::replace(host.begin(), host.end(), '/', '\\');
    return host;
}
} // namespace stackpilot::LocalSourcePaths
