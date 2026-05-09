// ============================================================
// GitHubAuthService.h - GitHub OAuth exchange + profile lookup
// ============================================================

#pragma once

#include <functional>
#include <string>

namespace dokscp {

struct GitHubIdentity {
    std::string id;
    std::string username;
    std::string name;
    std::string email;
    std::string accessToken;
};

class GitHubAuthService {
public:
    using SuccessCallback = std::function<void(const GitHubIdentity&)>;
    using ErrorCallback = std::function<void(const std::string&)>;

    bool isConfigured() const;
    std::string buildAuthorizationUrl(const std::string& state) const;
    std::string getCallbackUrl() const;
    std::string getExplicitOAuthRedirectUrl() const;

    void exchangeCode(const std::string& code,
                      SuccessCallback onSuccess,
                      ErrorCallback onError) const;

private:
    std::string getClientId() const;
    std::string getClientSecret() const;
};

} // namespace dokscp
