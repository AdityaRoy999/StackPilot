// ============================================================
// GoogleAuthService.h - Google Identity token verification
// ============================================================

#pragma once

#include <functional>
#include <string>

namespace stackpilot {

struct GoogleIdentity {
    std::string subject;
    std::string email;
    std::string name;
    std::string picture;
};

class GoogleAuthService {
public:
    using SuccessCallback = std::function<void(const GoogleIdentity&)>;
    using ErrorCallback = std::function<void(const std::string&)>;

    void verifyCredential(const std::string& credential,
                          SuccessCallback onSuccess,
                          ErrorCallback onError) const;
};

} // namespace stackpilot
