#include "AiRedaction.h"

#include <algorithm>
#include <cctype>
#include <regex>

namespace stackpilot {

namespace {

const std::regex kAssignmentSecretPattern(
    R"((api[_-]?key|access[_-]?key|client[_-]?secret|token|secret|password|private[_-]?key|pat)\s*[:=]\s*['"]?[^'"\s]+)",
    std::regex_constants::icase);
const std::regex kGitHubTokenPattern(R"(gh[pousr]_[A-Za-z0-9_]{20,})");
const std::regex kPrivateKeyPattern(
    R"(-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)",
    std::regex::ECMAScript);

std::string lowercase(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
    });
    return value;
}

} // namespace

std::string AiRedaction::clip(const std::string& value, std::size_t maxBytes) {
    if (maxBytes == 0 || value.size() <= maxBytes) {
        return value;
    }
    const std::size_t half = maxBytes / 2;
    return value.substr(0, half) + "\n...[clipped before AI request]...\n" +
           value.substr(value.size() - half);
}

bool AiRedaction::isSensitiveKey(const std::string& key) {
    const std::string lowered = lowercase(key);
    return lowered.find("secret") != std::string::npos ||
           lowered.find("token") != std::string::npos ||
           lowered.find("password") != std::string::npos ||
           lowered.find("private") != std::string::npos ||
           lowered.find("credential") != std::string::npos ||
           lowered.find("client_secret") != std::string::npos ||
           lowered.find("access_key") != std::string::npos ||
           lowered == "pat" ||
           lowered == "github_pat" ||
           lowered == "api_key";
}

std::string AiRedaction::redactText(const std::string& value, std::size_t maxBytes) {
    std::string redacted = clip(value, maxBytes);
    redacted = std::regex_replace(redacted, kPrivateKeyPattern, "[REDACTED_PRIVATE_KEY]");
    redacted = std::regex_replace(redacted, kGitHubTokenPattern, "[REDACTED_GITHUB_TOKEN]");
    redacted = std::regex_replace(redacted, kAssignmentSecretPattern, "$1=[REDACTED]");
    return redacted;
}

Json::Value AiRedaction::redactJson(const Json::Value& value, std::size_t maxBytes) {
    if (value.isString()) {
        return redactText(value.asString(), maxBytes);
    }

    if (value.isArray()) {
        Json::Value redacted(Json::arrayValue);
        const Json::ArrayIndex count = std::min<Json::ArrayIndex>(value.size(), 200);
        for (Json::ArrayIndex i = 0; i < count; ++i) {
            redacted.append(redactJson(value[i], maxBytes));
        }
        if (value.size() > count) {
            redacted.append("[clipped array]");
        }
        return redacted;
    }

    if (value.isObject()) {
        Json::Value redacted(Json::objectValue);
        const auto members = value.getMemberNames();
        std::size_t count = 0;
        for (const auto& key : members) {
            if (++count > 200) {
                redacted["__clipped__"] = true;
                break;
            }
            redacted[key] = isSensitiveKey(key) ? Json::Value("[REDACTED]") : redactJson(value[key], maxBytes);
        }
        return redacted;
    }

    return value;
}

} // namespace stackpilot
