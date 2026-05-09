// ============================================================
// PasswordHelper.h - Password Hashing
// ============================================================

#pragma once

#include <string>

namespace dokscp {

class PasswordHelper {
public:
    static std::string hashPassword(const std::string& password);

    static bool verifyPassword(const std::string& password,
                               const std::string& hash);
};

} // namespace dokscp
