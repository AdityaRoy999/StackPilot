#pragma once
#include <drogon/HttpRequest.h>
#include <drogon/WebSocketConnection.h>
#include <json/json.h>
#include <string>

namespace stackpilot::remote {
std::string randomSecret();
std::string hash(const std::string& value);
bool permitted(const std::string& path, drogon::HttpMethod method);
Json::Value authenticate(const drogon::HttpRequestPtr& request);
void watchConnection(const drogon::HttpRequestPtr& request,const drogon::WebSocketConnectionPtr& connection);
void activateRun(const std::string& id);
void deactivateRun(const std::string& id);
bool activeRun(const std::string& id);
void appendEvent(const std::string& id, const std::string& frame);
void finishRun(const std::string& id, const std::string& state);
}
