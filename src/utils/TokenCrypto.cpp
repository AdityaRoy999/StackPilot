// ============================================================
// TokenCrypto.cpp - AES-256-GCM token encryption
// ============================================================

#include "TokenCrypto.h"

#include <openssl/evp.h>
#include <openssl/rand.h>
#include <openssl/sha.h>
#include <spdlog/spdlog.h>

#include <cstdlib>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <vector>

namespace dokscp {

namespace {

constexpr int kIvBytes = 12;
constexpr int kTagBytes = 16;
constexpr const char* kPrefix = "enc:v1:";

std::string getKeyMaterial() {
    const char* key = std::getenv("TOKEN_ENCRYPTION_KEY");
    if (key && std::string(key).size() >= 32) {
        return key;
    }
    throw std::runtime_error("TOKEN_ENCRYPTION_KEY must be set to at least 32 characters");
}

std::vector<unsigned char> deriveKey() {
    const std::string material = getKeyMaterial();
    std::vector<unsigned char> key(SHA256_DIGEST_LENGTH);
    SHA256(reinterpret_cast<const unsigned char*>(material.data()), material.size(), key.data());
    return key;
}

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

} // namespace

std::string TokenCrypto::encrypt(const std::string& plaintext) {
    if (plaintext.empty()) return "";

    const auto key = deriveKey();
    std::vector<unsigned char> iv(kIvBytes);
    if (RAND_bytes(iv.data(), static_cast<int>(iv.size())) != 1) {
        throw std::runtime_error("Token IV generation failed");
    }

    EVP_CIPHER_CTX* ctx = EVP_CIPHER_CTX_new();
    if (!ctx) throw std::runtime_error("Failed to create cipher context");

    std::vector<unsigned char> ciphertext(plaintext.size() + EVP_MAX_BLOCK_LENGTH);
    std::vector<unsigned char> tag(kTagBytes);
    int len = 0;
    int ciphertextLen = 0;

    const int ok =
        EVP_EncryptInit_ex(ctx, EVP_aes_256_gcm(), nullptr, nullptr, nullptr) == 1 &&
        EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_IVLEN, static_cast<int>(iv.size()), nullptr) == 1 &&
        EVP_EncryptInit_ex(ctx, nullptr, nullptr, key.data(), iv.data()) == 1 &&
        EVP_EncryptUpdate(ctx,
                          ciphertext.data(),
                          &len,
                          reinterpret_cast<const unsigned char*>(plaintext.data()),
                          static_cast<int>(plaintext.size())) == 1;

    if (ok) {
        ciphertextLen = len;
    }

    const int finalOk = ok &&
        EVP_EncryptFinal_ex(ctx, ciphertext.data() + ciphertextLen, &len) == 1 &&
        EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_GET_TAG, static_cast<int>(tag.size()), tag.data()) == 1;

    EVP_CIPHER_CTX_free(ctx);

    if (!finalOk) {
        throw std::runtime_error("Token encryption failed");
    }

    ciphertextLen += len;
    ciphertext.resize(ciphertextLen);

    return std::string(kPrefix) + toHex(iv.data(), iv.size()) + ":" +
           toHex(tag.data(), tag.size()) + ":" +
           toHex(ciphertext.data(), ciphertext.size());
}

std::string TokenCrypto::decrypt(const std::string& storedValue) {
    if (storedValue.empty()) return "";
    if (storedValue.rfind(kPrefix, 0) != 0) {
        return storedValue;
    }

    const std::string payload = storedValue.substr(std::string(kPrefix).size());
    const auto parts = split(payload, ':');
    if (parts.size() != 3) {
        throw std::runtime_error("Invalid encrypted token format");
    }

    const auto iv = fromHex(parts[0]);
    const auto tag = fromHex(parts[1]);
    const auto ciphertext = fromHex(parts[2]);
    if (iv.size() != kIvBytes || tag.size() != kTagBytes || ciphertext.empty()) {
        throw std::runtime_error("Invalid encrypted token data");
    }

    const auto key = deriveKey();
    EVP_CIPHER_CTX* ctx = EVP_CIPHER_CTX_new();
    if (!ctx) throw std::runtime_error("Failed to create cipher context");

    std::vector<unsigned char> plaintext(ciphertext.size());
    int len = 0;
    int plaintextLen = 0;

    const int ok =
        EVP_DecryptInit_ex(ctx, EVP_aes_256_gcm(), nullptr, nullptr, nullptr) == 1 &&
        EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_IVLEN, static_cast<int>(iv.size()), nullptr) == 1 &&
        EVP_DecryptInit_ex(ctx, nullptr, nullptr, key.data(), iv.data()) == 1 &&
        EVP_DecryptUpdate(ctx,
                          plaintext.data(),
                          &len,
                          ciphertext.data(),
                          static_cast<int>(ciphertext.size())) == 1;

    if (ok) {
        plaintextLen = len;
    }

    const int finalOk = ok &&
        EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_TAG, static_cast<int>(tag.size()), const_cast<unsigned char*>(tag.data())) == 1 &&
        EVP_DecryptFinal_ex(ctx, plaintext.data() + plaintextLen, &len) == 1;

    EVP_CIPHER_CTX_free(ctx);

    if (!finalOk) {
        throw std::runtime_error("Token decryption failed");
    }

    plaintextLen += len;
    plaintext.resize(plaintextLen);
    return std::string(reinterpret_cast<char*>(plaintext.data()), plaintext.size());
}

bool TokenCrypto::isConfigured(const std::string& storedValue) {
    return !storedValue.empty();
}

} // namespace dokscp
