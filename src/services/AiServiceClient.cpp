#include "AiServiceClient.h"

#include <curl/curl.h>
#include <json/json.h>

#include <algorithm>
#include <cstdlib>
#include <sstream>

namespace dokscp {

namespace {

std::size_t writeCallback(void* contents, std::size_t size, std::size_t nmemb, void* userp) {
    auto* buffer = static_cast<std::string*>(userp);
    buffer->append(static_cast<char*>(contents), size * nmemb);
    return size * nmemb;
}

std::string compactJson(const Json::Value& value) {
    Json::StreamWriterBuilder builder;
    builder["indentation"] = "";
    return Json::writeString(builder, value);
}

bool parseJson(const std::string& value, Json::Value& out) {
    Json::CharReaderBuilder builder;
    std::string errors;
    std::istringstream stream(value);
    return Json::parseFromStream(builder, stream, &out, &errors);
}

AiServiceResult performRequest(const std::string& url,
                               const std::string& method,
                               const std::string& body,
                               long timeoutSeconds) {
    AiServiceResult result;
    CURL* curl = curl_easy_init();
    if (!curl) {
        result.error = "curl_init_failed";
        return result;
    }

    std::string responseBody;
    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, "Content-Type: application/json");

    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, timeoutSeconds);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, writeCallback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &responseBody);
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);

    if (method == "POST") {
        curl_easy_setopt(curl, CURLOPT_POST, 1L);
        curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body.c_str());
    }

    const CURLcode code = curl_easy_perform(curl);
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &result.statusCode);
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);

    if (code != CURLE_OK) {
        result.error = curl_easy_strerror(code);
        return result;
    }

    Json::Value parsed;
    if (!parseJson(responseBody, parsed)) {
        result.error = "invalid_ai_service_json";
        result.body["raw"] = responseBody;
        return result;
    }

    result.body = parsed;
    result.ok = result.statusCode >= 200 && result.statusCode < 300;
    if (!result.ok) {
        result.error = parsed.isMember("detail") ? parsed["detail"].asString() : "ai_service_http_error";
    }
    return result;
}

} // namespace

AiServiceClient& AiServiceClient::instance() {
    static AiServiceClient client;
    return client;
}

std::string AiServiceClient::serviceUrl() const {
    const char* value = std::getenv("DOKSCP_AI_SERVICE_URL");
    std::string url = (value && *value) ? value : "http://ai-service:8010";
    while (!url.empty() && url.back() == '/') {
        url.pop_back();
    }
    return url;
}

long AiServiceClient::timeoutSeconds() const {
    const char* value = std::getenv("DOKSCP_AI_SERVICE_TIMEOUT_SECONDS");
    if (!value || !*value) {
        return 60;
    }
    try {
        return std::max<long>(5, std::stol(value));
    } catch (...) {
        return 60;
    }
}

AiServiceResult AiServiceClient::health() const {
    return performRequest(serviceUrl() + "/health", "GET", "", timeoutSeconds());
}

AiServiceResult AiServiceClient::get(const std::string& path) const {
    return performRequest(serviceUrl() + path, "GET", "", timeoutSeconds());
}

AiServiceResult AiServiceClient::postWorkflow(const std::string& path, const Json::Value& payload) const {
    return performRequest(serviceUrl() + path, "POST", compactJson(payload), timeoutSeconds());
}

} // namespace dokscp
