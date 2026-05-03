// ============================================================
// GoogleAuthService.cpp - Google Identity token verification
// ============================================================

#include "GoogleAuthService.h"

#include <drogon/HttpClient.h>
#include <drogon/utils/Utilities.h>
#include <json/json.h>
#include <spdlog/spdlog.h>

#include <cstdlib>

namespace aids {

void GoogleAuthService::verifyCredential(const std::string& credential,
                                         SuccessCallback onSuccess,
                                         ErrorCallback onError) const {
    if (credential.empty()) {
        onError("Google credential is required");
        return;
    }

    const char* clientId = std::getenv("GOOGLE_CLIENT_ID");
    if (!clientId || !*clientId) {
        onError("Google sign-in is not configured on the server");
        return;
    }

    auto client = drogon::HttpClient::newHttpClient("https://oauth2.googleapis.com");
    auto req = drogon::HttpRequest::newHttpRequest();
    req->setMethod(drogon::Get);
    req->setPath("/tokeninfo?id_token=" + drogon::utils::urlEncode(credential));

    client->sendRequest(req, [client, onSuccess, onError, expectedAud = std::string(clientId)](
        drogon::ReqResult result,
        const drogon::HttpResponsePtr& response
    ) {
        if (result != drogon::ReqResult::Ok || !response) {
            spdlog::warn("Google credential verification request failed with result {}", static_cast<int>(result));
            onError("Failed to verify Google credential");
            return;
        }

        if (response->getStatusCode() != drogon::k200OK || !response->getJsonObject()) {
            onError("Google credential was rejected");
            return;
        }

        const auto& json = *response->getJsonObject();
        const std::string aud = json.isMember("aud") ? json["aud"].asString() : "";
        const std::string email = json.isMember("email") ? json["email"].asString() : "";
        const std::string subject = json.isMember("sub") ? json["sub"].asString() : "";
        const std::string name = json.isMember("name") ? json["name"].asString() : "";
        const std::string picture = json.isMember("picture") ? json["picture"].asString() : "";
        const std::string emailVerified = json.isMember("email_verified") ? json["email_verified"].asString() : "";

        if (aud != expectedAud) {
            onError("Google credential audience mismatch");
            return;
        }

        if (email.empty() || subject.empty() || emailVerified != "true") {
            onError("Google account email is not verified");
            return;
        }

        GoogleIdentity identity;
        identity.subject = subject;
        identity.email = email;
        identity.name = name;
        identity.picture = picture;
        onSuccess(identity);
    }, 8.0);
}

} // namespace aids
