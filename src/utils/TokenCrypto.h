// ============================================================
// TokenCrypto.h - encrypted storage for provider tokens
// ============================================================

#pragma once

#include <string>

namespace aids {

class TokenCrypto {
public:
    static std::string encrypt(const std::string& plaintext);
    static std::string decrypt(const std::string& storedValue);
    static bool isConfigured(const std::string& storedValue);
};

} // namespace aids
