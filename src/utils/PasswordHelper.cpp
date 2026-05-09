// ============================================================
// PasswordHelper.cpp - PBKDF2-HMAC-SHA256 password hashing
// ============================================================

#include "PasswordHelper.h"

#include <drogon/utils/Utilities.h>
#include <openssl/crypto.h>
#include <openssl/evp.h>
#include <openssl/rand.h>

#include <cstdlib>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <vector>

namespace dokscp {

namespace {

constexpr int kIterations = 210000;
constexpr int kSaltBytes = 16;
constexpr int kKeyBytes = 32;

std::string toHex(const unsigned char* data, size_t length) {
    std::ostringstream out;
    out << std::hex << std::setfill('0');
    for (size_t i = 0; i < length; ++i) {
        out << std::setw(2) << static_cast<int>(data[i]);
    }
    return out.str();
}

std::vector<unsigned char> fromHex(const std::string& hex) {
    if (hex.size() % 2 != 0) return {};
    std::vector<unsigned char> bytes;
    bytes.reserve(hex.size() / 2);

    for (size_t i = 0; i < hex.size(); i += 2) {
        unsigned int value = 0;
        std::istringstream in(hex.substr(i, 2));
        in >> std::hex >> value;
        if (in.fail()) return {};
        bytes.push_back(static_cast<unsigned char>(value));
    }

    return bytes;
}

std::vector<std::string> split(const std::string& value, char delimiter) {
    std::vector<std::string> parts;
    std::stringstream stream(value);
    std::string part;
    while (std::getline(stream, part, delimiter)) {
        parts.push_back(part);
    }
    return parts;
}

std::string deriveKey(const std::string& password,
                      const std::vector<unsigned char>& salt,
                      int iterations) {
    std::vector<unsigned char> key(kKeyBytes);
    const int ok = PKCS5_PBKDF2_HMAC(
        password.c_str(),
        static_cast<int>(password.size()),
        salt.data(),
        static_cast<int>(salt.size()),
        iterations,
        EVP_sha256(),
        static_cast<int>(key.size()),
        key.data()
    );

    if (ok != 1) {
        throw std::runtime_error("Password key derivation failed");
    }

    return toHex(key.data(), key.size());
}

} // namespace

std::string PasswordHelper::hashPassword(const std::string& password) {
    std::vector<unsigned char> salt(kSaltBytes);
    if (RAND_bytes(salt.data(), static_cast<int>(salt.size())) != 1) {
        throw std::runtime_error("Secure salt generation failed");
    }

    const std::string keyHex = deriveKey(password, salt, kIterations);
    return "pbkdf2_sha256$" + std::to_string(kIterations) + "$" +
           toHex(salt.data(), salt.size()) + "$" + keyHex;
}

bool PasswordHelper::verifyPassword(const std::string& password,
                                    const std::string& storedHash) {
    const auto parts = split(storedHash, '$');

    if (parts.size() == 4 && parts[0] == "pbkdf2_sha256") {
        int iterations = 0;
        try {
            iterations = std::stoi(parts[1]);
        } catch (...) {
            return false;
        }

        const auto salt = fromHex(parts[2]);
        if (salt.empty()) return false;

        std::string computedHash;
        try {
            computedHash = deriveKey(password, salt, iterations);
        } catch (...) {
            return false;
        }

        return computedHash.size() == parts[3].size() &&
               CRYPTO_memcmp(computedHash.data(), parts[3].data(), computedHash.size()) == 0;
    }

    const char* allowLegacy = std::getenv("ALLOW_LEGACY_MD5_PASSWORDS");
    if (!allowLegacy || std::string(allowLegacy) != "true") {
        return false;
    }

    // Legacy compatibility for explicitly opted-in development accounts created before PBKDF2.
    if (parts.size() == 2) {
        const std::string computedHash = drogon::utils::getMd5(parts[0] + password);
        return computedHash.size() == parts[1].size() &&
               CRYPTO_memcmp(computedHash.data(), parts[1].data(), computedHash.size()) == 0;
    }

    return false;
}

} // namespace dokscp
