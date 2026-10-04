#pragma once
#include <json/json.h>
#include <algorithm>
#include <cctype>
#include <sstream>
#include "../utils/StringUtils.h"
namespace stackpilot::aiMemory {
inline std::string clipText(const std::string& value, std::size_t limit) {
    if (value.size() <= limit) {
        return value;
    }
    auto start = value.size() - limit;
    // JSON/PostgreSQL require valid UTF-8. A byte budget must never start
    // in the middle of a multibyte character in multilingual conversations.
    while (start < value.size() && (static_cast<unsigned char>(value[start]) & 0xc0) == 0x80) ++start;
    return value.substr(start);
}

inline Json::Value sessionMemory(const std::string& summary, const std::string& graphText) {
    Json::Value memory(Json::objectValue);
    memory["summary"] = summary;
    Json::Value graph = strings::parseJsonObject(graphText);
    memory["graph"] = graph.isObject() ? graph : Json::Value(Json::objectValue);
    return memory;
}

inline Json::Value updateMemoryGraph(Json::Value graph, const std::string& userMessage, const std::string& assistantMessage) {
    if (!graph.isObject()) {
        graph = Json::Value(Json::objectValue);
    }
    graph["last_user_request"] = clipText(userMessage, 1000);
    graph["last_assistant_response"] = clipText(assistantMessage, 1000);

    std::string lower = userMessage;
    std::transform(lower.begin(), lower.end(), lower.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
    });
    const bool looksLikePreference =
        lower.find("remember") != std::string::npos ||
        lower.find("prefer") != std::string::npos ||
        lower.find("always") != std::string::npos ||
        lower.find("my ") != std::string::npos;
    if (looksLikePreference) {
        Json::Value preferences = graph.isMember("preferences") && graph["preferences"].isArray()
                                      ? graph["preferences"]
                                      : Json::Value(Json::arrayValue);
        preferences.append(clipText(userMessage, 500));
        while (preferences.size() > 24) {
            Json::Value trimmed(Json::arrayValue);
            for (Json::ArrayIndex i = 1; i < preferences.size(); ++i) {
                trimmed.append(preferences[i]);
            }
            preferences = trimmed;
        }
        graph["preferences"] = preferences;
    }
    return graph;
}

inline std::string updateMemorySummary(const std::string& current,
                                const std::string& userMessage,
                                const std::string& assistantMessage) {
    std::ostringstream next;
    if (!current.empty()) {
        next << current << "\n";
    }
    next << "User: " << clipText(userMessage, 700) << "\n";
    next << "Assistant: " << clipText(assistantMessage, 700);
    return clipText(next.str(), 6000);
}

}
