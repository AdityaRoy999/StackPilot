#include "AiServiceClient.h"

#include <curl/curl.h>
#include <json/json.h>

#include <algorithm>
#include <cstdlib>
#include <sstream>

namespace stackpilot {

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
    // Shared secret proving the caller is the backend. ai-service enforces this
    // on every route except /health; without it anything on the docker network
    // could drive the model and reach its provider base_url SSRF sink.
    const char* serviceToken = std::getenv("STACKPILOT_AI_SERVICE_TOKEN");
    const std::string effectiveToken = (serviceToken && *serviceToken) ? serviceToken : "";
    if (!effectiveToken.empty()) {
        const std::string tokenHeader = std::string("X-StackPilot-Service-Token: ") + effectiveToken;
        headers = curl_slist_append(headers, tokenHeader.c_str());
    }

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
        // FastAPI validation errors return `detail` as an ARRAY. Calling
        // asString() on a non-string throws Json::LogicError, which escaped this
        // function and turned every 422 into an opaque 500.
        if (!parsed.isMember("detail")) {
            result.error = "ai_service_http_error";
        } else if (parsed["detail"].isString()) {
            result.error = parsed["detail"].asString();
        } else {
            Json::StreamWriterBuilder writer;
            writer["indentation"] = "";
            result.error = Json::writeString(writer, parsed["detail"]);
        }
    }
    return result;
}

} // namespace

AiServiceClient& AiServiceClient::instance() {
    static AiServiceClient client;
    return client;
}

std::string AiServiceClient::serviceUrl() const {
    const char* value = std::getenv("STACKPILOT_AI_SERVICE_URL");
    std::string url = (value && *value) ? value : "http://ai-service:8010";
    while (!url.empty() && url.back() == '/') {
        url.pop_back();
    }
    return url;
}

long AiServiceClient::timeoutSeconds() const {
    const char* value = std::getenv("STACKPILOT_AI_SERVICE_TIMEOUT_SECONDS");
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
    // Repair includes real builds and runtime verification; the short planning
    // timeout otherwise severs the caller while executor work continues.
    const long timeout = path.rfind("/repair/", 0) == 0 ? std::max<long>(timeoutSeconds(), 600) :
        path == "/runtime/verify" ? std::max<long>(timeoutSeconds(),240) : timeoutSeconds();
    return performRequest(serviceUrl() + path, "POST", compactJson(payload), timeout);
}

} // namespace stackpilot
