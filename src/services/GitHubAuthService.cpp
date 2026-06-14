// ============================================================
// GitHubAuthService.cpp - GitHub OAuth exchange + profile lookup
// ============================================================

#include "GitHubAuthService.h"

#include <drogon/HttpClient.h>
#include <drogon/utils/Utilities.h>
#include <json/json.h>
#include <spdlog/spdlog.h>

#include <cstdlib>
#include <memory>
#include <sstream>

namespace stackpilot {

namespace {

std::string getEnvOrDefault(const char* name, const std::string& fallback = "") {
    const char* value = std::getenv(name);
    return (value && *value) ? value : fallback;
}

std::string pickBestEmail(const Json::Value& emails) {
    if (!emails.isArray()) {
        return "";
    }

    for (const auto& email : emails) {
        if (email.isObject() &&
            email.isMember("email") &&
            email.isMember("verified") &&
            email["verified"].asBool() &&
            email.isMember("primary") &&
            email["primary"].asBool()) {
            return email["email"].asString();
        }
    }

    for (const auto& email : emails) {
        if (email.isObject() &&
            email.isMember("email") &&
            email.isMember("verified") &&
            email["verified"].asBool()) {
            return email["email"].asString();
        }
    }

    return "";
}

std::string describeGitHubError(const Json::Value& body) {
    if (!body.isObject()) {
        return "";
    }

    const std::string error = body.isMember("error") ? body["error"].asString() : "";
    const std::string description =
        body.isMember("error_description") ? body["error_description"].asString() : "";

    if (error.empty() && description.empty()) {
        return "";
    }

    if (description.empty()) {
        return error;
    }

    if (error.empty()) {
        return description;
    }

    return error + ": " + description;
}

Json::Value parseUrlEncodedBody(const std::string& body) {
    Json::Value out;
    std::istringstream stream(body);
    std::string pair;

    while (std::getline(stream, pair, '&')) {
        if (pair.empty()) {
            continue;
        }

        const auto equals = pair.find('=');
        const std::string key = drogon::utils::urlDecode(
            equals == std::string::npos ? pair : pair.substr(0, equals)
        );
        const std::string value = drogon::utils::urlDecode(
            equals == std::string::npos ? "" : pair.substr(equals + 1)
        );

        if (!key.empty()) {
            out[key] = value;
        }
    }

    return out;
}

Json::Value parseGitHubTokenResponse(const drogon::HttpResponsePtr& response) {
    if (!response) {
        return {};
    }

    if (auto json = response->getJsonObject()) {
        return *json;
    }

    const auto bodyView = response->body();
    const std::string body(bodyView.begin(), bodyView.end());
    if (body.empty()) {
        return {};
    }

    return parseUrlEncodedBody(body);
}

} // namespace

bool GitHubAuthService::isConfigured() const {
    return !getClientId().empty() && !getClientSecret().empty();
}

std::string GitHubAuthService::getClientId() const {
    return getEnvOrDefault("GITHUB_CLIENT_ID");
}

std::string GitHubAuthService::getClientSecret() const {
    return getEnvOrDefault("GITHUB_CLIENT_SECRET");
}

std::string GitHubAuthService::getCallbackUrl() const {
    const std::string explicitUrl = getEnvOrDefault("GITHUB_CALLBACK_URL");
    if (!explicitUrl.empty()) {
        return explicitUrl;
    }

    const std::string backendBase =
        getEnvOrDefault("BACKEND_PUBLIC_URL", "http://localhost:8090");
    return backendBase + "/api/v1/auth/github/callback";
}

std::string GitHubAuthService::getExplicitOAuthRedirectUrl() const {
    const std::string explicitOAuthUrl = getEnvOrDefault("GITHUB_OAUTH_REDIRECT_URL");
    if (!explicitOAuthUrl.empty()) {
        return explicitOAuthUrl;
    }

    const std::string forceLegacyRedirect = getEnvOrDefault("GITHUB_FORCE_REDIRECT_URI");
    if (forceLegacyRedirect == "1" ||
        forceLegacyRedirect == "true" ||
        forceLegacyRedirect == "yes" ||
        forceLegacyRedirect == "on") {
        return getCallbackUrl();
    }

    return "";
}

std::string GitHubAuthService::buildAuthorizationUrl(const std::string& state) const {
    const std::string explicitRedirectUrl = getExplicitOAuthRedirectUrl();
    std::ostringstream url;
    url << "https://github.com/login/oauth/authorize"
        << "?client_id=" << drogon::utils::urlEncode(getClientId())
        << "&scope=" << drogon::utils::urlEncode("read:user user:email read:org repo admin:repo_hook")
        << "&state=" << drogon::utils::urlEncode(state);
    if (!explicitRedirectUrl.empty()) {
        url << "&redirect_uri=" << drogon::utils::urlEncode(explicitRedirectUrl);
    }
    return url.str();
}

void GitHubAuthService::exchangeCode(const std::string& code,
                                     SuccessCallback onSuccess,
                                     ErrorCallback onError) const {
    if (code.empty()) {
        onError("GitHub authorization code is required");
        return;
    }

    if (!isConfigured()) {
        onError("GitHub OAuth is not configured on the server");
        return;
    }

    auto githubClient = drogon::HttpClient::newHttpClient("https://github.com");
    auto tokenReq = drogon::HttpRequest::newHttpRequest();
    tokenReq->setMethod(drogon::Post);
    std::string tokenPath =
        "/login/oauth/access_token?client_id=" + drogon::utils::urlEncode(getClientId()) +
        "&client_secret=" + drogon::utils::urlEncode(getClientSecret()) +
        "&code=" + drogon::utils::urlEncode(code);
    const std::string explicitRedirectUrl = getExplicitOAuthRedirectUrl();
    if (!explicitRedirectUrl.empty()) {
        tokenPath += "&redirect_uri=" + drogon::utils::urlEncode(explicitRedirectUrl);
    }
    tokenReq->setPath(tokenPath);
    tokenReq->addHeader("Accept", "application/json");
    tokenReq->addHeader("User-Agent", "stackpilot-Platform");

    githubClient->sendRequest(
        tokenReq,
        [onSuccess, onError](drogon::ReqResult result, const drogon::HttpResponsePtr& response) {
            const Json::Value tokenPayload = parseGitHubTokenResponse(response);
            if (result != drogon::ReqResult::Ok || tokenPayload.isNull()) {
                spdlog::warn("GitHub token exchange transport failure: result={}", static_cast<int>(result));
                onError("Failed to exchange GitHub authorization code");
                return;
            }

            const std::string accessToken =
                tokenPayload.isMember("access_token") ? tokenPayload["access_token"].asString() : "";
            if (response->getStatusCode() != drogon::k200OK || accessToken.empty()) {
                const std::string detail = describeGitHubError(tokenPayload);
                if (!detail.empty()) {
                    spdlog::warn("GitHub token exchange rejected code: {}", detail);
                    onError("GitHub rejected the authorization code: " + detail);
                } else {
                    spdlog::warn("GitHub token exchange rejected code with status {}", static_cast<int>(response->getStatusCode()));
                    onError("GitHub rejected the authorization code");
                }
                return;
            }

            auto apiClient = drogon::HttpClient::newHttpClient("https://api.github.com");
            auto identity = std::make_shared<GitHubIdentity>();
            identity->accessToken = accessToken;

            auto userReq = drogon::HttpRequest::newHttpRequest();
            userReq->setMethod(drogon::Get);
            userReq->setPath("/user");
            userReq->addHeader("Authorization", "Bearer " + accessToken);
            userReq->addHeader("User-Agent", "stackpilot-Platform");
            userReq->addHeader("Accept", "application/vnd.github+json");

            apiClient->sendRequest(
                userReq,
                [apiClient, identity, onSuccess, onError](
                    drogon::ReqResult userResult,
                    const drogon::HttpResponsePtr& userResponse
                ) {
                    if (userResult != drogon::ReqResult::Ok || !userResponse || !userResponse->getJsonObject()) {
                        onError("Failed to fetch GitHub profile");
                        return;
                    }

                    const auto& userJson = *userResponse->getJsonObject();
                    identity->id = userJson.isMember("id")
                        ? (userJson["id"].isString()
                            ? userJson["id"].asString()
                            : std::to_string(userJson["id"].asLargestInt()))
                        : "";
                    identity->username = userJson.isMember("login") ? userJson["login"].asString() : "";
                    identity->name = userJson.isMember("name") ? userJson["name"].asString() : "";
                    identity->email = userJson.isMember("email") ? userJson["email"].asString() : "";

                    if (identity->id.empty() || identity->username.empty()) {
                        onError("GitHub returned an incomplete profile");
                        return;
                    }

                    if (!identity->email.empty()) {
                        onSuccess(*identity);
                        return;
                    }

                    auto emailsReq = drogon::HttpRequest::newHttpRequest();
                    emailsReq->setMethod(drogon::Get);
                    emailsReq->setPath("/user/emails");
                    emailsReq->addHeader("Authorization", "Bearer " + identity->accessToken);
                    emailsReq->addHeader("User-Agent", "stackpilot-Platform");
                    emailsReq->addHeader("Accept", "application/vnd.github+json");

                    apiClient->sendRequest(
                        emailsReq,
                        [identity, onSuccess, onError](
                            drogon::ReqResult emailResult,
                            const drogon::HttpResponsePtr& emailResponse
                        ) {
                            if (emailResult != drogon::ReqResult::Ok || !emailResponse || !emailResponse->getJsonObject()) {
                                onError("Failed to fetch GitHub email addresses");
                                return;
                            }

                            identity->email = pickBestEmail(*emailResponse->getJsonObject());
                            if (identity->email.empty()) {
                                onError("GitHub account must expose at least one verified email address");
                                return;
                            }

                            onSuccess(*identity);
                        }
                    );
                }
            );
        }
    );
}

} // namespace stackpilot
