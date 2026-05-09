#pragma once

#include <json/value.h>

#include <cstddef>
#include <string>

namespace dokscp {

class AiRedaction {
public:
    static std::string redactText(const std::string& value, std::size_t maxBytes = 32000);
    static Json::Value redactJson(const Json::Value& value, std::size_t maxBytes = 32000);

private:
    static std::string clip(const std::string& value, std::size_t maxBytes);
    static bool isSensitiveKey(const std::string& key);
};

} // namespace dokscp
