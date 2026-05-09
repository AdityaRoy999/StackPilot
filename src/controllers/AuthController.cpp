// ============================================================
// AuthController.cpp - Authentication API Implementation
// ============================================================

#include "AuthController.h"

#include "../db/Database.h"
#include "../services/EmailService.h"
#include "../services/GitHubAuthService.h"
#include "../services/GoogleAuthService.h"
#include "../utils/JwtHelper.h"
#include "../utils/PasswordHelper.h"
#include "../utils/AuditLogger.h"
#include "../utils/TokenCrypto.h"

#include <drogon/utils/Utilities.h>
#include <openssl/crypto.h>
#include <openssl/hmac.h>
#include <openssl/rand.h>
#include <pqxx/pqxx>
#include <spdlog/spdlog.h>

#include <algorithm>
#include <chrono>
#include <cctype>
#include <cstdlib>
#include <iomanip>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <unordered_map>
#include <vector>

namespace dokscp {

namespace {

std::string toLower(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
    });
    return value;
}

std::string trim(const std::string& value) {
    size_t start = 0;
    while (start < value.size() && std::isspace(static_cast<unsigned char>(value[start]))) {
        ++start;
    }

    size_t end = value.size();
    while (end > start && std::isspace(static_cast<unsigned char>(value[end - 1]))) {
        --end;
    }

    return value.substr(start, end - start);
}

std::string sanitizeUsername(const std::string& raw) {
    std::string out;
    out.reserve(raw.size());

    for (char c : raw) {
        if (std::isalnum(static_cast<unsigned char>(c))) {
            out.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(c))));
        } else if ((c == ' ' || c == '-' || c == '_' || c == '.') &&
                   (out.empty() || out.back() != '_')) {
            out.push_back('_');
        }
    }

    while (!out.empty() && out.front() == '_') out.erase(out.begin());
    while (!out.empty() && out.back() == '_') out.pop_back();

    if (out.size() > 32) out.resize(32);
    if (out.empty()) out = "user";
    return out;
}

std::string uniqueUsername(pqxx::work& txn, const std::string& base) {
    std::string candidate = sanitizeUsername(base);
    for (int attempt = 0; attempt < 1000; ++attempt) {
        auto check = txn.exec_params("SELECT 1 FROM users WHERE username = $1", candidate);
        if (check.empty()) {
            return candidate;
        }
        candidate = sanitizeUsername(base) + "_" + std::to_string(attempt + 1);
    }
    throw std::runtime_error("Failed to allocate unique username");
}

std::string googlePasswordPlaceholder(const GoogleIdentity& identity);
std::string googlePasswordPlaceholder(const std::string& subject, const std::string& email);
std::string githubPasswordPlaceholder(const std::string& githubId, const std::string& email);
bool hasUsableLocalPassword(const pqxx::row& row);

std::string getEnvOrDefault(const char* name, const std::string& fallback = "") {
    const char* value = std::getenv(name);
    return (value && *value) ? value : fallback;
}

struct AuthRateLimitPolicy {
    int maxAttempts;
    int windowSeconds;
    int blockSeconds;
};

struct AuthRateLimitState {
    int attempts = 0;
    std::chrono::steady_clock::time_point windowStart = std::chrono::steady_clock::now();
    std::chrono::steady_clock::time_point blockedUntil = std::chrono::steady_clock::time_point::min();
};

std::mutex authRateLimitMutex;
std::unordered_map<std::string, AuthRateLimitState> authRateLimitStates;

std::string getClientAddress(const drogon::HttpRequestPtr& req) {
    if (!req) {
        return "unknown";
    }

    const std::string forwarded = trim(req->getHeader("X-Forwarded-For"));
    if (!forwarded.empty()) {
        const auto comma = forwarded.find(',');
        return toLower(trim(forwarded.substr(0, comma)));
    }

    return toLower(req->peerAddr().toIp());
}

std::string trimForStorage(const std::string& value, size_t maxLength) {
    if (value.size() <= maxLength) {
        return value;
    }
    return value.substr(0, maxLength);
}

std::string getUserAgent(const drogon::HttpRequestPtr& req) {
    if (!req) {
        return "";
    }
    return trimForStorage(trim(req->getHeader("User-Agent")), 500);
}

std::string detectDeviceLabel(const std::string& userAgent) {
    const std::string ua = toLower(userAgent);
    std::string os = "Unknown OS";
    std::string browser = "Unknown browser";

    if (ua.find("windows") != std::string::npos) os = "Windows";
    else if (ua.find("mac os") != std::string::npos || ua.find("macintosh") != std::string::npos) os = "macOS";
    else if (ua.find("android") != std::string::npos) os = "Android";
    else if (ua.find("iphone") != std::string::npos || ua.find("ipad") != std::string::npos) os = "iOS";
    else if (ua.find("linux") != std::string::npos || ua.find("x11") != std::string::npos) os = "Linux";

    if (ua.find("edg/") != std::string::npos || ua.find("edge/") != std::string::npos) browser = "Edge";
    else if (ua.find("firefox/") != std::string::npos) browser = "Firefox";
    else if (ua.find("chrome/") != std::string::npos || ua.find("chromium/") != std::string::npos) browser = "Chrome";
    else if (ua.find("safari/") != std::string::npos) browser = "Safari";

    return browser + " on " + os;
}

void recordSuccessfulLogin(const std::string& userId,
                           const std::string& method,
                           const std::string& ipAddress,
                           const std::string& userAgent) {
    if (userId.empty()) {
        return;
    }

    try {
        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);
        txn.exec_params(
            "INSERT INTO login_history (user_id, login_method, ip_address, device, user_agent) "
            "VALUES ($1, $2, $3, $4, $5)",
            userId,
            trimForStorage(method, 30),
            trimForStorage(ipAddress, 128),
            trimForStorage(detectDeviceLabel(userAgent), 160),
            trimForStorage(userAgent, 500)
        );
        txn.commit();
    } catch (const std::exception& e) {
        spdlog::warn("Login history record skipped: {}", e.what());
    }
}

std::string makeRateLimitKey(const std::string& scope,
                             const drogon::HttpRequestPtr& req,
                             const std::string& identity = "") {
    std::string key = scope + ":" + getClientAddress(req);
    if (!identity.empty()) {
        key += ":" + toLower(trim(identity));
    }
    return key;
}

int getRetryAfterSeconds(const std::string& key) {
    std::lock_guard<std::mutex> lock(authRateLimitMutex);
    auto it = authRateLimitStates.find(key);
    if (it == authRateLimitStates.end()) {
        return 0;
    }

    const auto now = std::chrono::steady_clock::now();
    if (now >= it->second.blockedUntil) {
        return 0;
    }

    return static_cast<int>(std::chrono::duration_cast<std::chrono::seconds>(
        it->second.blockedUntil - now
    ).count());
}

bool isRateLimited(const std::string& key, int& retryAfterSeconds) {
    retryAfterSeconds = getRetryAfterSeconds(key);
    return retryAfterSeconds > 0;
}

void recordRateLimitFailure(const std::string& key, const AuthRateLimitPolicy& policy) {
    std::lock_guard<std::mutex> lock(authRateLimitMutex);
    auto& state = authRateLimitStates[key];
    const auto now = std::chrono::steady_clock::now();

    if (now >= state.blockedUntil && now - state.windowStart > std::chrono::seconds(policy.windowSeconds)) {
        state.attempts = 0;
        state.windowStart = now;
    }

    if (state.blockedUntil > now) {
        return;
    }

    if (state.attempts == 0) {
        state.windowStart = now;
    }

    ++state.attempts;
    if (state.attempts >= policy.maxAttempts) {
        state.blockedUntil = now + std::chrono::seconds(policy.blockSeconds);
        state.attempts = 0;
        state.windowStart = now;
    }
}

void clearRateLimitState(const std::string& key) {
    std::lock_guard<std::mutex> lock(authRateLimitMutex);
    authRateLimitStates.erase(key);
}

drogon::HttpResponsePtr makeRateLimitedResponse(int retryAfterSeconds) {
    Json::Value err;
    err["error"] = "Too many authentication attempts. Please wait and try again.";
    auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
    resp->setStatusCode(drogon::k429TooManyRequests);
    resp->addHeader("Retry-After", std::to_string(std::max(1, retryAfterSeconds)));
    return resp;
}

const AuthRateLimitPolicy kLoginRateLimit{8, 600, 900};
const AuthRateLimitPolicy kRegisterRateLimit{6, 600, 900};
const AuthRateLimitPolicy kOAuthStartRateLimit{20, 300, 600};
const AuthRateLimitPolicy kGoogleVerifyRateLimit{10, 600, 600};
const AuthRateLimitPolicy kPasswordResetRequestRateLimit{5, 900, 1800};
const AuthRateLimitPolicy kPasswordResetVerifyRateLimit{8, 900, 1800};

constexpr int kPasswordResetOtpLength = 6;
constexpr int kPasswordResetOtpMaxAttempts = 5;
constexpr int kPasswordResetCooldownSeconds = 60;
constexpr int kPasswordResetExpiryMinutesDefault = 10;

std::string getFrontendBaseUrl() {
    return getEnvOrDefault("FRONTEND_PUBLIC_URL", getEnvOrDefault("CORS_ALLOWED_ORIGIN", "http://localhost:3000"));
}

bool isGitHubOAuthConfigured() {
    return !getEnvOrDefault("GITHUB_CLIENT_ID").empty() &&
           !getEnvOrDefault("GITHUB_CLIENT_SECRET").empty();
}

bool isProductionEnvironment() {
    const std::string value = toLower(getEnvOrDefault("DOKSCP_ENV", getEnvOrDefault("NODE_ENV", "development")));
    return value == "production" || value == "prod";
}

std::string registrationMode() {
    std::string mode = toLower(trim(getEnvOrDefault("DOKSCP_AUTH_REGISTRATION_MODE")));
    if (mode.empty()) {
        mode = isProductionEnvironment() ? "first_user_only" : "open";
    }
    if (mode != "open" && mode != "first_user_only" && mode != "invite" && mode != "disabled") {
        return isProductionEnvironment() ? "first_user_only" : "open";
    }
    return mode;
}

bool inviteCodeAccepted(const Json::Value* body) {
    const std::string expected = trim(getEnvOrDefault("DOKSCP_AUTH_INVITE_CODE"));
    if (expected.empty()) {
        return true;
    }
    if (!body || !body->isMember("invite_code") || !(*body)["invite_code"].isString()) {
        return false;
    }
    return trim((*body)["invite_code"].asString()) == expected;
}

bool registrationAllowed(pqxx::work& txn, const Json::Value* body, std::string& reason) {
    const std::string mode = registrationMode();
    if (mode == "disabled") {
        reason = "New account registration is disabled on this DOKSCP instance.";
        return false;
    }
    if ((mode == "invite" || !getEnvOrDefault("DOKSCP_AUTH_INVITE_CODE").empty()) && !inviteCodeAccepted(body)) {
        reason = "A valid invite code is required to create a new account.";
        return false;
    }
    if (mode == "first_user_only") {
        const auto countRows = txn.exec("SELECT COUNT(*) FROM users");
        const long long userCount = countRows.empty() || countRows[0][0].is_null()
            ? 0
            : countRows[0][0].as<long long>();
        if (userCount > 0) {
            reason = "This production DOKSCP instance already has an owner account. Ask the owner to create or invite additional users.";
            return false;
        }
    }
    return true;
}

Json::Value registrationClosedPayload(const std::string& reason) {
    Json::Value err;
    err["error"] = reason.empty() ? "New account registration is not allowed on this DOKSCP instance." : reason;
    err["registration_mode"] = registrationMode();
    return err;
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
        if (in.fail()) {
            return {};
        }
        bytes.push_back(static_cast<unsigned char>(value));
    }

    return bytes;
}

std::string hmacSha256Hex(const std::string& key, const std::string& value) {
    unsigned char digest[EVP_MAX_MD_SIZE];
    unsigned int digestLength = 0;
    HMAC(EVP_sha256(),
         key.data(),
         static_cast<int>(key.size()),
         reinterpret_cast<const unsigned char*>(value.data()),
         value.size(),
         digest,
         &digestLength);
    return toHex(digest, digestLength);
}

std::string getOAuthStateSecret() {
    const std::string tokenKey = getEnvOrDefault("TOKEN_ENCRYPTION_KEY");
    if (tokenKey.size() >= 32) {
        return tokenKey;
    }

    const std::string jwtSecret = getEnvOrDefault("JWT_SECRET");
    if (jwtSecret.size() >= 32) {
        return jwtSecret;
    }
    throw std::runtime_error("OAuth state secret is not configured");
}

std::string randomHex(size_t byteCount) {
    std::vector<unsigned char> bytes(byteCount);
    if (RAND_bytes(bytes.data(), static_cast<int>(bytes.size())) != 1) {
        throw std::runtime_error("Failed to generate secure random state");
    }
    return toHex(bytes.data(), bytes.size());
}

int getPasswordResetExpiryMinutes() {
    const std::string raw = getEnvOrDefault("PASSWORD_RESET_OTP_EXPIRY_MINUTES", std::to_string(kPasswordResetExpiryMinutesDefault));
    try {
        return std::clamp(std::stoi(raw), 5, 30);
    } catch (...) {
        return kPasswordResetExpiryMinutesDefault;
    }
}

std::string makeNumericOtp(size_t digits) {
    std::vector<unsigned char> bytes(digits);
    if (RAND_bytes(bytes.data(), static_cast<int>(bytes.size())) != 1) {
        throw std::runtime_error("Failed to generate password reset code");
    }

    std::string otp;
    otp.reserve(digits);
    for (unsigned char byte : bytes) {
        otp.push_back(static_cast<char>('0' + (byte % 10)));
    }
    return otp;
}

bool isReasonableEmail(const std::string& value) {
    const auto at = value.find('@');
    if (value.empty() || at == std::string::npos || at == 0 || at == value.size() - 1) {
        return false;
    }
    return value.find(' ') == std::string::npos && value.find('\n') == std::string::npos && value.find('\r') == std::string::npos;
}

std::string getPasswordResetSecret() {
    const std::string tokenKey = getEnvOrDefault("TOKEN_ENCRYPTION_KEY");
    if (tokenKey.size() >= 32) {
        return tokenKey;
    }
    return getOAuthStateSecret();
}

std::string hashPasswordResetOtp(const std::string& email, const std::string& otp) {
    return hmacSha256Hex(getPasswordResetSecret(), toLower(trim(email)) + ":" + otp);
}

std::string buildGitHubState(const std::string& mode, const std::string& userId) {
    Json::Value payload;
    payload["mode"] = mode;
    payload["user_id"] = userId;
    payload["nonce"] = randomHex(12);
    payload["exp"] = static_cast<Json::Int64>(
        std::chrono::duration_cast<std::chrono::seconds>(
            std::chrono::system_clock::now().time_since_epoch()
        ).count() + 600
    );

    Json::StreamWriterBuilder writer;
    writer["indentation"] = "";
    const std::string payloadJson = Json::writeString(writer, payload);
    const std::string payloadHex = toHex(
        reinterpret_cast<const unsigned char*>(payloadJson.data()),
        payloadJson.size()
    );

    return payloadHex + "." + hmacSha256Hex(getOAuthStateSecret(), payloadHex);
}

bool parseGitHubState(const std::string& state, Json::Value& payloadOut) {
    const auto dot = state.find('.');
    if (dot == std::string::npos) {
        return false;
    }

    const std::string payloadHex = state.substr(0, dot);
    const std::string signatureHex = state.substr(dot + 1);
    const std::string expectedHex = hmacSha256Hex(getOAuthStateSecret(), payloadHex);
    if (signatureHex.size() != expectedHex.size() ||
        CRYPTO_memcmp(signatureHex.data(), expectedHex.data(), expectedHex.size()) != 0) {
        return false;
    }

    const auto payloadBytes = fromHex(payloadHex);
    if (payloadBytes.empty()) {
        return false;
    }

    std::string payloadJson(payloadBytes.begin(), payloadBytes.end());
    Json::CharReaderBuilder reader;
    std::string errors;
    std::istringstream stream(payloadJson);
    if (!Json::parseFromStream(reader, stream, &payloadOut, &errors) || !payloadOut.isObject()) {
        return false;
    }

    if (!payloadOut.isMember("exp")) {
        return false;
    }

    const auto now = std::chrono::duration_cast<std::chrono::seconds>(
        std::chrono::system_clock::now().time_since_epoch()
    ).count();
    return payloadOut["exp"].asInt64() >= now;
}

std::string extractBearerToken(const drogon::HttpRequestPtr& req) {
    return JwtHelper::extractTokenFromRequest(req);
}

std::string extractUserIdFromRequest(const drogon::HttpRequestPtr& req) {
    Json::Value payload = JwtHelper::verifyRequestToken(req);
    if (payload.isNull() || !payload.isMember("user_id")) {
        return "";
    }
    return payload["user_id"].asString();
}

drogon::HttpResponsePtr makeRedirectResponse(const std::string& location) {
    auto resp = drogon::HttpResponse::newHttpResponse();
    resp->setStatusCode(drogon::k302Found);
    resp->addHeader("Location", location);
    return resp;
}

void attachAuthCookie(const drogon::HttpResponsePtr& resp, const std::string& token) {
    if (token.empty()) {
        return;
    }

    const std::string maxAge = getEnvOrDefault("JWT_EXPIRY_SECONDS", "86400");
    const std::string backendPublicUrl = getEnvOrDefault("BACKEND_PUBLIC_URL", "http://localhost:8090");
    const bool secure = backendPublicUrl.rfind("https://", 0) == 0;

    std::ostringstream cookie;
    cookie << "token=" << drogon::utils::urlEncode(token)
           << "; Path=/"
           << "; Max-Age=" << maxAge
           << "; HttpOnly"
           << "; SameSite=Lax";

    if (secure) {
        cookie << "; Secure";
    }

    resp->addHeader("Set-Cookie", cookie.str());
}

void clearAuthCookie(const drogon::HttpResponsePtr& resp) {
    const std::string backendPublicUrl = getEnvOrDefault("BACKEND_PUBLIC_URL", "http://localhost:8090");
    const bool secure = backendPublicUrl.rfind("https://", 0) == 0;

    std::ostringstream cookie;
    cookie << "token="
           << "; Path=/"
           << "; Max-Age=0"
           << "; Expires=Thu, 01 Jan 1970 00:00:00 GMT"
           << "; HttpOnly"
           << "; SameSite=Lax";

    if (secure) {
        cookie << "; Secure";
    }

    resp->addHeader("Set-Cookie", cookie.str());
}

drogon::HttpResponsePtr makeRedirectResponseWithAuthCookie(const std::string& location,
                                                           const std::string& token) {
    auto resp = makeRedirectResponse(location);
    attachAuthCookie(resp, token);
    return resp;
}

std::string buildGitHubFrontendRedirect(const std::string& status,
                                        const std::string& mode,
                                        const std::string& message = "",
                                        const std::string& username = "") {
    std::ostringstream url;
    url << getFrontendBaseUrl() << "/auth/github/callback"
        << "?status=" << drogon::utils::urlEncode(status)
        << "&mode=" << drogon::utils::urlEncode(mode);

    if (!message.empty()) {
        url << "&message=" << drogon::utils::urlEncode(message);
    }

    if (!username.empty()) {
        url << "&username=" << drogon::utils::urlEncode(username);
    }

    return url.str();
}

Json::Value userJsonFromRow(const pqxx::row& row) {
    Json::Value userJson;
    userJson["id"] = row["id"].as<std::string>();
    userJson["username"] = row["username"].as<std::string>();
    userJson["email"] = row["email"].as<std::string>();
    userJson["full_name"] = row["full_name"].is_null() ? "" : row["full_name"].as<std::string>();
    userJson["sign_in_type"] = row["sign_in_type"].is_null() ? "local" : row["sign_in_type"].as<std::string>();
    userJson["google_connected"] = !row["google_sub"].is_null();
    userJson["github_connected"] = !row["github_id"].is_null();
    userJson["github_username"] = row["github_username"].is_null() ? "" : row["github_username"].as<std::string>();
    userJson["password_enabled"] = hasUsableLocalPassword(row);
    userJson["github_oauth_available"] = isGitHubOAuthConfigured();
    userJson["created_at"] = row["created_at"].as<std::string>();
    if (!row["updated_at"].is_null()) {
        userJson["updated_at"] = row["updated_at"].as<std::string>();
    }
    return userJson;
}

Json::Value authPayloadFromRow(const pqxx::row& row) {
    Json::Value body;
    body["message"] = "Login successful";
    body["user"] = userJsonFromRow(row);
    return body;
}

std::string googlePasswordPlaceholder(const GoogleIdentity& identity) {
    return "google-auth:" + identity.subject + ":" + identity.email;
}

std::string googlePasswordPlaceholder(const std::string& subject, const std::string& email) {
    return "google-auth:" + subject + ":" + email;
}

std::string githubPasswordPlaceholder(const std::string& githubId, const std::string& email) {
    return "github-auth:" + githubId + ":" + email;
}

bool hasUsableLocalPassword(const pqxx::row& row) {
    if (row["password_hash"].is_null()) {
        return false;
    }

    const std::string passwordHash = row["password_hash"].as<std::string>();

    if (!row["google_sub"].is_null()) {
        const std::string googlePlaceholder = googlePasswordPlaceholder(
            row["google_sub"].as<std::string>(),
            row["email"].as<std::string>()
        );
        if (PasswordHelper::verifyPassword(googlePlaceholder, passwordHash)) {
            return false;
        }
    }

    if (!row["github_id"].is_null()) {
        const std::string githubPlaceholder = githubPasswordPlaceholder(
            row["github_id"].as<std::string>(),
            row["email"].as<std::string>()
        );
        if (PasswordHelper::verifyPassword(githubPlaceholder, passwordHash)) {
            return false;
        }
    }

    return true;
}

} // namespace

void AuthController::registerUser(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback
) {
    spdlog::info("POST /api/v1/auth/register");

    try {
        auto body = req->getJsonObject();
        if (!body) {
            Json::Value err; err["error"] = "Invalid JSON body";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp);
            return;
        }

        std::string username = trim((*body)["username"].asString());
        std::string email = toLower(trim((*body)["email"].asString()));
        std::string password = (*body)["password"].asString();
        const std::string rateLimitKey = makeRateLimitKey("register", req, email);
        int retryAfterSeconds = 0;
        if (isRateLimited(rateLimitKey, retryAfterSeconds)) {
            callback(makeRateLimitedResponse(retryAfterSeconds));
            return;
        }

        if (username.empty() || email.empty() || password.empty()) {
            Json::Value err; err["error"] = "username, email, and password are required";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            recordRateLimitFailure(rateLimitKey, kRegisterRateLimit);
            callback(resp);
            return;
        }

        if (password.length() < 12) {
            Json::Value err; err["error"] = "Password must be at least 12 characters";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            recordRateLimitFailure(rateLimitKey, kRegisterRateLimit);
            callback(resp);
            return;
        }

        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);

        std::string registrationReason;
        if (!registrationAllowed(txn, body.get(), registrationReason)) {
            auto resp = drogon::HttpResponse::newHttpJsonResponse(registrationClosedPayload(registrationReason));
            resp->setStatusCode(drogon::k403Forbidden);
            recordRateLimitFailure(rateLimitKey, kRegisterRateLimit);
            callback(resp);
            return;
        }

        auto existingUser = txn.exec_params(
            "SELECT id, username, email, password_hash, full_name, sign_in_type, google_sub, github_id, github_username, created_at, updated_at "
            "FROM users WHERE email = $1",
            email
        );

        Json::Value respBody;
        drogon::HttpStatusCode statusCode = drogon::k201Created;

        if (!existingUser.empty()) {
            Json::Value err;
            err["error"] = "An account with this email already exists. Sign in with an existing method before adding a password.";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k409Conflict);
            recordRateLimitFailure(rateLimitKey, kRegisterRateLimit);
            callback(resp);
            return;
        } else {
            auto result = txn.exec_params(
                "INSERT INTO users (username, email, password_hash, sign_in_type) "
                "VALUES ($1, $2, $3, 'local') "
                "RETURNING id, username, email, password_hash, full_name, sign_in_type, google_sub, github_id, github_username, created_at, updated_at",
                sanitizeUsername(username), email, PasswordHelper::hashPassword(password)
            );
            txn.commit();
            respBody["message"] = "User registered successfully";
            respBody["user"] = userJsonFromRow(result[0]);
            spdlog::info("User registered: {}", email);
            clearRateLimitState(rateLimitKey);
        }

        auto resp = drogon::HttpResponse::newHttpJsonResponse(respBody);
        if (respBody.isMember("user") && respBody["user"].isMember("id") && respBody["user"].isMember("email")) {
            const std::string token = JwtHelper::createToken(
                respBody["user"]["id"].asString(),
                respBody["user"]["email"].asString()
            );
            attachAuthCookie(resp, token);
        }
        resp->setStatusCode(statusCode);
        if (respBody.isMember("user") && respBody["user"].isMember("id")) {
            Json::Value metadata;
            metadata["method"] = "email";
            AuditLogger::recordFromRequest(req, respBody["user"]["id"].asString(), "auth.register", "user", respBody["user"]["id"].asString(), metadata);
        }
        callback(resp);
    } catch (const pqxx::unique_violation&) {
        Json::Value err; err["error"] = "Username or email already exists";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k409Conflict);
        callback(resp);
    } catch (const std::exception& e) {
        spdlog::error("Registration error: {}", e.what());
        Json::Value err; err["error"] = "Internal server error";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void AuthController::loginUser(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback
) {
    spdlog::info("POST /api/v1/auth/login");

    try {
        auto body = req->getJsonObject();
        if (!body) {
            Json::Value err; err["error"] = "Invalid JSON body";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp);
            return;
        }

        const std::string email = toLower(trim((*body)["email"].asString()));
        const std::string password = (*body)["password"].asString();
        const std::string rateLimitKey = makeRateLimitKey("login", req, email);
        int retryAfterSeconds = 0;
        if (isRateLimited(rateLimitKey, retryAfterSeconds)) {
            callback(makeRateLimitedResponse(retryAfterSeconds));
            return;
        }

        if (email.empty() || password.empty()) {
            Json::Value err; err["error"] = "email and password are required";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            recordRateLimitFailure(rateLimitKey, kLoginRateLimit);
            callback(resp);
            return;
        }

        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);

        auto result = txn.exec_params(
            "SELECT id, username, email, password_hash, full_name, sign_in_type, google_sub, github_id, github_username, created_at, updated_at "
            "FROM users WHERE email = $1",
            email
        );
        txn.commit();

        if (result.empty()) {
            Json::Value err; err["error"] = "Invalid email or password";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k401Unauthorized);
            recordRateLimitFailure(rateLimitKey, kLoginRateLimit);
            callback(resp);
            return;
        }

        const auto& row = result[0];
        if (!hasUsableLocalPassword(row)) {
            Json::Value err; err["error"] = "This account does not have an email password yet. Sign in with Google first or set a password using the same email on sign up.";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            recordRateLimitFailure(rateLimitKey, kLoginRateLimit);
            callback(resp);
            return;
        }

        if (!PasswordHelper::verifyPassword(password, row["password_hash"].as<std::string>())) {
            Json::Value err; err["error"] = "Invalid email or password";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k401Unauthorized);
            recordRateLimitFailure(rateLimitKey, kLoginRateLimit);
            callback(resp);
            return;
        }

        const std::string token = JwtHelper::createToken(row["id"].as<std::string>(), row["email"].as<std::string>());
        auto resp = drogon::HttpResponse::newHttpJsonResponse(authPayloadFromRow(row));
        attachAuthCookie(resp, token);
        clearRateLimitState(rateLimitKey);
        recordSuccessfulLogin(row["id"].as<std::string>(), "email", getClientAddress(req), getUserAgent(req));
        AuditLogger::recordFromRequest(req, row["id"].as<std::string>(), "auth.login", "user", row["id"].as<std::string>(), Json::Value(Json::objectValue));
        callback(resp);
        spdlog::info("User logged in: {}", email);
    } catch (const std::exception& e) {
        spdlog::error("Login error: {}", e.what());
        Json::Value err; err["error"] = "Internal server error";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void AuthController::googleAuth(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback
) {
    spdlog::info("POST /api/v1/auth/google");
    const std::string rateLimitKey = makeRateLimitKey("google", req);
    int retryAfterSeconds = 0;
    if (isRateLimited(rateLimitKey, retryAfterSeconds)) {
        callback(makeRateLimitedResponse(retryAfterSeconds));
        return;
    }

    auto body = req->getJsonObject();
    if (!body || !body->isMember("credential")) {
        Json::Value err; err["error"] = "Google credential is required";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k400BadRequest);
        recordRateLimitFailure(rateLimitKey, kGoogleVerifyRateLimit);
        callback(resp);
        return;
    }

    const std::string ipAddress = getClientAddress(req);
    const std::string userAgent = getUserAgent(req);
    GoogleAuthService service;
    service.verifyCredential(
        (*body)["credential"].asString(),
        [callback, rateLimitKey, ipAddress, userAgent](const GoogleIdentity& identity) {
            try {
                auto& db = Database::getInstance();
                auto conn = db.getConnection();
                pqxx::work txn(*conn);

                auto existing = txn.exec_params(
                    "SELECT id, username, email, password_hash, full_name, sign_in_type, google_sub, github_id, github_username, created_at, updated_at "
                    "FROM users "
                    "WHERE google_sub = $1 OR email = $2 "
                    "ORDER BY CASE WHEN google_sub = $1 THEN 0 ELSE 1 END "
                    "LIMIT 1",
                    identity.subject,
                    toLower(identity.email)
                );

                pqxx::result finalResult;
                if (existing.empty()) {
                    std::string registrationReason;
                    if (!registrationAllowed(txn, nullptr, registrationReason)) {
                        Json::Value err = registrationClosedPayload(registrationReason);
                        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
                        resp->setStatusCode(drogon::k403Forbidden);
                        callback(resp);
                        return;
                    }
                    const std::string usernameSeed =
                        !identity.name.empty() ? identity.name :
                        identity.email.substr(0, identity.email.find('@'));
                    const std::string username = uniqueUsername(txn, usernameSeed);
                    finalResult = txn.exec_params(
                        "INSERT INTO users (username, email, password_hash, full_name, sign_in_type, google_sub) "
                        "VALUES ($1, $2, $3, $4, 'google', $5) "
                        "RETURNING id, username, email, password_hash, full_name, sign_in_type, google_sub, github_id, github_username, created_at, updated_at",
                        username,
                        toLower(identity.email),
                        PasswordHelper::hashPassword(googlePasswordPlaceholder(identity)),
                        identity.name,
                        identity.subject
                    );
                } else {
                    const auto& row = existing[0];
                    const std::string currentSignInType = row["sign_in_type"].is_null() ? "local" : row["sign_in_type"].as<std::string>();
                    finalResult = txn.exec_params(
                        "UPDATE users "
                        "SET google_sub = COALESCE(google_sub, $1), "
                        "    full_name = CASE WHEN COALESCE(full_name, '') = '' THEN $2 ELSE full_name END, "
                        "    updated_at = NOW() "
                        "WHERE id = $3 "
                        "RETURNING id, username, email, password_hash, full_name, sign_in_type, google_sub, github_id, github_username, created_at, updated_at",
                        identity.subject,
                        identity.name,
                        row["id"].as<std::string>()
                    );

                    if (currentSignInType == "google" && row["google_sub"].is_null()) {
                        finalResult = txn.exec_params(
                            "UPDATE users SET google_sub = $1, updated_at = NOW() WHERE id = $2 "
                            "RETURNING id, username, email, password_hash, full_name, sign_in_type, google_sub, github_id, github_username, created_at, updated_at",
                            identity.subject,
                            row["id"].as<std::string>()
                        );
                    }
                }

                txn.commit();
                const std::string token = JwtHelper::createToken(
                    finalResult[0]["id"].as<std::string>(),
                    finalResult[0]["email"].as<std::string>()
                );
                auto resp = drogon::HttpResponse::newHttpJsonResponse(authPayloadFromRow(finalResult[0]));
                attachAuthCookie(resp, token);
                clearRateLimitState(rateLimitKey);
                recordSuccessfulLogin(finalResult[0]["id"].as<std::string>(), "google", ipAddress, userAgent);
                Json::Value auditMeta;
                auditMeta["method"] = "google";
                AuditLogger::record(finalResult[0]["id"].as<std::string>(), "auth.login", "user", finalResult[0]["id"].as<std::string>(), ipAddress, userAgent, auditMeta);
                callback(resp);
                spdlog::info("Google auth successful: {}", identity.email);
            } catch (const std::exception& e) {
                spdlog::error("Google auth DB error: {}", e.what());
                recordRateLimitFailure(rateLimitKey, kGoogleVerifyRateLimit);
                Json::Value err; err["error"] = "Failed to complete Google sign-in";
                auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
                resp->setStatusCode(drogon::k500InternalServerError);
                callback(resp);
            }
        },
        [callback, rateLimitKey](const std::string& message) {
            recordRateLimitFailure(rateLimitKey, kGoogleVerifyRateLimit);
            Json::Value err; err["error"] = message;
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp);
        }
    );
}

void AuthController::startGitHubAuth(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback
) {
    spdlog::info("POST /api/v1/auth/github/start");
    const std::string rateLimitKey = makeRateLimitKey("github-start", req);
    int retryAfterSeconds = 0;
    if (isRateLimited(rateLimitKey, retryAfterSeconds)) {
        callback(makeRateLimitedResponse(retryAfterSeconds));
        return;
    }

    GitHubAuthService service;
    if (!service.isConfigured()) {
        Json::Value err; err["error"] = "GitHub OAuth is not configured";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k503ServiceUnavailable);
        recordRateLimitFailure(rateLimitKey, kOAuthStartRateLimit);
        callback(resp);
        return;
    }

    std::string mode = "signin";
    auto body = req->getJsonObject();
    if (body && (*body).isMember("mode")) {
        mode = trim((*body)["mode"].asString());
    }

    if (mode.empty()) {
        mode = "signin";
    }

    if (mode != "signin" && mode != "signup" && mode != "connect") {
        Json::Value err; err["error"] = "Invalid GitHub auth mode";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k400BadRequest);
        recordRateLimitFailure(rateLimitKey, kOAuthStartRateLimit);
        callback(resp);
        return;
    }

    std::string userId;
    if (mode == "connect") {
        userId = extractUserIdFromRequest(req);
        if (userId.empty()) {
            Json::Value err; err["error"] = "Unauthorized";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k401Unauthorized);
            recordRateLimitFailure(rateLimitKey, kOAuthStartRateLimit);
            callback(resp);
            return;
        }
    }

    Json::Value respBody;
    respBody["authorization_url"] = service.buildAuthorizationUrl(buildGitHubState(mode, userId));
    respBody["callback_url"] = service.getCallbackUrl();
    clearRateLimitState(rateLimitKey);
    callback(drogon::HttpResponse::newHttpJsonResponse(respBody));
}

void AuthController::githubCallback(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback
) {
    spdlog::info("GET /api/v1/auth/github/callback");

    const std::string error = req->getParameter("error");
    const std::string errorDescription = req->getParameter("error_description");
    if (!error.empty()) {
        callback(makeRedirectResponse(buildGitHubFrontendRedirect(
            "error",
            "signin",
            errorDescription.empty() ? "GitHub authorization was cancelled" : errorDescription
        )));
        return;
    }

    const std::string code = req->getParameter("code");
    const std::string state = req->getParameter("state");
    Json::Value statePayload;
    if (code.empty() || state.empty() || !parseGitHubState(state, statePayload)) {
        callback(makeRedirectResponse(buildGitHubFrontendRedirect(
            "error",
            "signin",
            "GitHub authorization session is invalid or expired"
        )));
        return;
    }

    const std::string mode = statePayload.isMember("mode") ? statePayload["mode"].asString() : "signin";
    const std::string requestedUserId = statePayload.isMember("user_id") ? statePayload["user_id"].asString() : "";
    const std::string ipAddress = getClientAddress(req);
    const std::string userAgent = getUserAgent(req);

    GitHubAuthService service;
    service.exchangeCode(
        code,
        [callback, mode, requestedUserId, ipAddress, userAgent](const GitHubIdentity& identity) {
            try {
                auto& db = Database::getInstance();
                auto conn = db.getConnection();
                pqxx::work txn(*conn);

                pqxx::result finalResult;

                if (mode == "connect") {
                    if (requestedUserId.empty()) {
                        callback(makeRedirectResponse(buildGitHubFrontendRedirect(
                            "error",
                            mode,
                            "Missing current user context for GitHub connection"
                        )));
                        return;
                    }

                    auto currentRows = txn.exec_params(
                        "SELECT id, username, email, password_hash, full_name, sign_in_type, google_sub, github_id, github_username, created_at, updated_at "
                        "FROM users WHERE id = $1",
                        requestedUserId
                    );
                    if (currentRows.empty()) {
                        callback(makeRedirectResponse(buildGitHubFrontendRedirect(
                            "error",
                            mode,
                            "Current account was not found"
                        )));
                        return;
                    }

                    auto conflictRows = txn.exec_params(
                        "SELECT id FROM users WHERE github_id = $1 AND id <> $2",
                        identity.id,
                        requestedUserId
                    );
                    if (!conflictRows.empty()) {
                        callback(makeRedirectResponse(buildGitHubFrontendRedirect(
                            "error",
                            mode,
                            "This GitHub account is already linked to another user"
                        )));
                        return;
                    }

                    finalResult = txn.exec_params(
                        "UPDATE users "
                        "SET github_id = $1, "
                        "    github_username = $2, "
                        "    github_access_token = $3, "
                        "    full_name = CASE WHEN COALESCE(full_name, '') = '' THEN $4 ELSE full_name END, "
                        "    updated_at = NOW() "
                        "WHERE id = $5 "
                        "RETURNING id, username, email, password_hash, full_name, sign_in_type, google_sub, github_id, github_username, created_at, updated_at",
                        identity.id,
                        identity.username,
                        TokenCrypto::encrypt(identity.accessToken),
                        identity.name,
                        requestedUserId
                    );
                } else {
                    auto existing = txn.exec_params(
                        "SELECT id, username, email, password_hash, full_name, sign_in_type, google_sub, github_id, github_username, created_at, updated_at "
                        "FROM users "
                        "WHERE github_id = $1 OR email = $2 "
                        "ORDER BY CASE WHEN github_id = $1 THEN 0 ELSE 1 END "
                        "LIMIT 1",
                        identity.id,
                        toLower(identity.email)
                    );

                    if (existing.empty()) {
                        std::string registrationReason;
                        if (!registrationAllowed(txn, nullptr, registrationReason)) {
                            callback(makeRedirectResponse(buildGitHubFrontendRedirect(
                                "error",
                                mode,
                                registrationReason
                            )));
                            return;
                        }
                        const std::string usernameSeed =
                            !identity.username.empty() ? identity.username :
                            (!identity.name.empty() ? identity.name :
                             identity.email.substr(0, identity.email.find('@')));
                        const std::string username = uniqueUsername(txn, usernameSeed);
                        finalResult = txn.exec_params(
                            "INSERT INTO users (username, email, password_hash, full_name, sign_in_type, github_id, github_username, github_access_token) "
                            "VALUES ($1, $2, $3, $4, 'github', $5, $6, $7) "
                            "RETURNING id, username, email, password_hash, full_name, sign_in_type, google_sub, github_id, github_username, created_at, updated_at",
                            username,
                            toLower(identity.email),
                            PasswordHelper::hashPassword(githubPasswordPlaceholder(identity.id, toLower(identity.email))),
                            identity.name,
                            identity.id,
                            identity.username,
                            TokenCrypto::encrypt(identity.accessToken)
                        );
                    } else {
                        const auto& row = existing[0];
                        if (!row["github_id"].is_null() && row["github_id"].as<std::string>() != identity.id) {
                            callback(makeRedirectResponse(buildGitHubFrontendRedirect(
                                "error",
                                mode,
                                "This email is already linked to a different GitHub account"
                            )));
                            return;
                        }

                        finalResult = txn.exec_params(
                            "UPDATE users "
                            "SET github_id = COALESCE(github_id, $1), "
                            "    github_username = $2, "
                            "    github_access_token = $3, "
                            "    full_name = CASE WHEN COALESCE(full_name, '') = '' THEN $4 ELSE full_name END, "
                            "    updated_at = NOW() "
                            "WHERE id = $5 "
                            "RETURNING id, username, email, password_hash, full_name, sign_in_type, google_sub, github_id, github_username, created_at, updated_at",
                            identity.id,
                            identity.username,
                            TokenCrypto::encrypt(identity.accessToken),
                            identity.name,
                            row["id"].as<std::string>()
                        );
                    }
                }

                txn.commit();

                if (mode == "connect") {
                    spdlog::info("GitHub account connected for user {} as {}", requestedUserId, identity.username);
                    Json::Value auditMeta;
                    auditMeta["github_username"] = identity.username;
                    AuditLogger::record(requestedUserId, "integration.github.connected", "user", requestedUserId, ipAddress, userAgent, auditMeta);
                    callback(makeRedirectResponse(buildGitHubFrontendRedirect(
                        "connected",
                        mode,
                        "GitHub account connected successfully",
                        identity.username
                    )));
                    return;
                }

                const std::string jwtToken = JwtHelper::createToken(
                    finalResult[0]["id"].as<std::string>(),
                    finalResult[0]["email"].as<std::string>()
                );
                recordSuccessfulLogin(finalResult[0]["id"].as<std::string>(), "github", ipAddress, userAgent);
                Json::Value auditMeta;
                auditMeta["method"] = "github";
                auditMeta["github_username"] = identity.username;
                AuditLogger::record(finalResult[0]["id"].as<std::string>(), "auth.login", "user", finalResult[0]["id"].as<std::string>(), ipAddress, userAgent, auditMeta);
                spdlog::info("GitHub sign-in successful for {}", finalResult[0]["email"].as<std::string>());
                callback(makeRedirectResponseWithAuthCookie(buildGitHubFrontendRedirect(
                    "success",
                    mode,
                    "Signed in with GitHub",
                    identity.username
                ), jwtToken));
            } catch (const std::exception& e) {
                spdlog::error("GitHub auth DB error: {}", e.what());
                callback(makeRedirectResponse(buildGitHubFrontendRedirect(
                    "error",
                    mode,
                    "Failed to complete GitHub sign-in"
                )));
            }
        },
        [callback, mode](const std::string& message) {
            spdlog::warn("GitHub auth failed during callback: {}", message);
            callback(makeRedirectResponse(buildGitHubFrontendRedirect("error", mode, message)));
        }
    );
}

void AuthController::logoutUser(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback
) {
    const std::string userId = extractUserIdFromRequest(req);
    if (!userId.empty()) {
        AuditLogger::recordFromRequest(req, userId, "auth.logout", "user", userId, Json::Value(Json::objectValue));
    }
    Json::Value body;
    body["message"] = "Logged out";
    auto resp = drogon::HttpResponse::newHttpJsonResponse(body);
    clearAuthCookie(resp);
    callback(resp);
}

void AuthController::requestPasswordResetOtp(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback
) {
    spdlog::info("POST /api/v1/auth/forgot-password/request");

    try {
        auto body = req->getJsonObject();
        if (!body) {
            Json::Value err; err["error"] = "Invalid JSON body";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp);
            return;
        }

        const std::string email = toLower(trim((*body)["email"].asString()));
        const std::string rateLimitKey = makeRateLimitKey("password_reset_request", req, email);
        int retryAfterSeconds = 0;
        if (isRateLimited(rateLimitKey, retryAfterSeconds)) {
            callback(makeRateLimitedResponse(retryAfterSeconds));
            return;
        }

        if (!isReasonableEmail(email)) {
            Json::Value err; err["error"] = "A valid email is required";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            recordRateLimitFailure(rateLimitKey, kPasswordResetRequestRateLimit);
            callback(resp);
            return;
        }

        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);
        auto rows = txn.exec_params(
            "SELECT id, username, email, password_hash, full_name, sign_in_type, google_sub, github_id, github_username, created_at, updated_at "
            "FROM users WHERE email = $1",
            email
        );

        Json::Value bodyJson;
        bodyJson["message"] = "If an eligible account exists, a verification code has been sent to the email address.";

        if (rows.empty() || !hasUsableLocalPassword(rows[0])) {
            txn.commit();
            clearRateLimitState(rateLimitKey);
            callback(drogon::HttpResponse::newHttpJsonResponse(bodyJson));
            return;
        }

        const auto& userRow = rows[0];
        const std::string userId = userRow["id"].as<std::string>();

        auto cooldownRows = txn.exec_params(
            "SELECT created_at "
            "FROM password_reset_otps "
            "WHERE user_id = $1 AND consumed_at IS NULL "
            "ORDER BY created_at DESC "
            "LIMIT 1",
            userId
        );

        if (!cooldownRows.empty()) {
            auto cooldownCheck = txn.exec_params(
                "SELECT EXTRACT(EPOCH FROM (NOW() - $1::timestamptz)) AS age_seconds",
                cooldownRows[0]["created_at"].as<std::string>()
            );
            if (!cooldownCheck.empty() && !cooldownCheck[0]["age_seconds"].is_null()) {
                const double ageSeconds = cooldownCheck[0]["age_seconds"].as<double>();
                if (ageSeconds < kPasswordResetCooldownSeconds) {
                    txn.commit();
                    clearRateLimitState(rateLimitKey);
                    callback(drogon::HttpResponse::newHttpJsonResponse(bodyJson));
                    return;
                }
            }
        }

        if (!EmailService::isConfigured()) {
            txn.commit();
            Json::Value err; err["error"] = "Password reset email is not configured on the server";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k503ServiceUnavailable);
            callback(resp);
            return;
        }

        const int expiryMinutes = getPasswordResetExpiryMinutes();
        const std::string otp = makeNumericOtp(kPasswordResetOtpLength);
        const std::string otpHash = hashPasswordResetOtp(email, otp);

        txn.exec_params(
            "UPDATE password_reset_otps "
            "SET consumed_at = NOW() "
            "WHERE user_id = $1 AND consumed_at IS NULL",
            userId
        );

        auto inserted = txn.exec_params(
            "INSERT INTO password_reset_otps (user_id, otp_hash, delivery_email, request_ip, max_attempts, expires_at) "
            "VALUES ($1, $2, $3, $4, $5, NOW() + ($6 || ' minutes')::interval) "
            "RETURNING id",
            userId,
            otpHash,
            email,
            trimForStorage(getClientAddress(req), 128),
            kPasswordResetOtpMaxAttempts,
            expiryMinutes
        );
        const std::string resetId = inserted[0]["id"].as<std::string>();
        txn.commit();

        try {
            EmailService::sendPasswordResetOtp(
                email,
                userRow["full_name"].is_null() ? userRow["username"].as<std::string>() : userRow["full_name"].as<std::string>(),
                otp,
                expiryMinutes
            );
        } catch (const std::exception& e) {
            spdlog::error("Password reset email delivery failed for {}: {}", email, e.what());
            auto cleanupConn = db.getConnection();
            pqxx::work cleanupTxn(*cleanupConn);
            cleanupTxn.exec_params(
                "UPDATE password_reset_otps SET consumed_at = NOW() WHERE id = $1 AND consumed_at IS NULL",
                resetId
            );
            cleanupTxn.commit();

            Json::Value err; err["error"] = "Failed to send the verification code. Please try again.";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k503ServiceUnavailable);
            callback(resp);
            return;
        }

        Json::Value auditMeta;
        auditMeta["method"] = "otp_email";
        auditMeta["delivery"] = "gmail_smtp";
        AuditLogger::recordFromRequest(req, userId, "auth.password_reset_requested", "user", userId, auditMeta);

        clearRateLimitState(rateLimitKey);
        callback(drogon::HttpResponse::newHttpJsonResponse(bodyJson));
    } catch (const std::exception& e) {
        spdlog::error("Password reset request error: {}", e.what());
        Json::Value err; err["error"] = "Internal server error";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void AuthController::resetPasswordWithOtp(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback
) {
    spdlog::info("POST /api/v1/auth/forgot-password/verify");

    try {
        auto body = req->getJsonObject();
        if (!body) {
            Json::Value err; err["error"] = "Invalid JSON body";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp);
            return;
        }

        const std::string email = toLower(trim((*body)["email"].asString()));
        const std::string otp = trim((*body)["otp"].asString());
        const std::string newPassword = (*body)["new_password"].asString();
        const std::string rateLimitKey = makeRateLimitKey("password_reset_verify", req, email);
        int retryAfterSeconds = 0;
        if (isRateLimited(rateLimitKey, retryAfterSeconds)) {
            callback(makeRateLimitedResponse(retryAfterSeconds));
            return;
        }

        if (!isReasonableEmail(email) || otp.empty() || newPassword.empty()) {
            Json::Value err; err["error"] = "Email, verification code, and new password are required";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            recordRateLimitFailure(rateLimitKey, kPasswordResetVerifyRateLimit);
            callback(resp);
            return;
        }

        if (newPassword.length() < 12) {
            Json::Value err; err["error"] = "Password must be at least 12 characters";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            recordRateLimitFailure(rateLimitKey, kPasswordResetVerifyRateLimit);
            callback(resp);
            return;
        }

        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);
        auto userRows = txn.exec_params(
            "SELECT id, username, email, password_hash, full_name, sign_in_type, google_sub, github_id, github_username, created_at, updated_at "
            "FROM users WHERE email = $1",
            email
        );

        if (userRows.empty() || !hasUsableLocalPassword(userRows[0])) {
            Json::Value err; err["error"] = "Invalid or expired verification code";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            recordRateLimitFailure(rateLimitKey, kPasswordResetVerifyRateLimit);
            callback(resp);
            return;
        }

        const auto& userRow = userRows[0];
        const std::string userId = userRow["id"].as<std::string>();
        auto resetRows = txn.exec_params(
            "SELECT id, otp_hash, attempts_used, max_attempts, expires_at, consumed_at "
            "FROM password_reset_otps "
            "WHERE user_id = $1 AND consumed_at IS NULL "
            "ORDER BY created_at DESC "
            "LIMIT 1",
            userId
        );

        if (resetRows.empty()) {
            Json::Value err; err["error"] = "Invalid or expired verification code";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            recordRateLimitFailure(rateLimitKey, kPasswordResetVerifyRateLimit);
            callback(resp);
            return;
        }

        const auto& resetRow = resetRows[0];
        const std::string resetId = resetRow["id"].as<std::string>();

        auto expiryRows = txn.exec_params(
            "SELECT CASE WHEN $1::timestamptz > NOW() THEN 1 ELSE 0 END AS valid",
            resetRow["expires_at"].as<std::string>()
        );
        const bool notExpired = !expiryRows.empty() && expiryRows[0]["valid"].as<int>() == 1;
        if (!notExpired) {
            txn.exec_params(
                "UPDATE password_reset_otps SET consumed_at = NOW() WHERE id = $1 AND consumed_at IS NULL",
                resetId
            );
            txn.commit();
            Json::Value err; err["error"] = "Invalid or expired verification code";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            recordRateLimitFailure(rateLimitKey, kPasswordResetVerifyRateLimit);
            callback(resp);
            return;
        }

        const int attemptsUsed = resetRow["attempts_used"].as<int>();
        const int maxAttempts = resetRow["max_attempts"].as<int>();
        if (attemptsUsed >= maxAttempts) {
            txn.exec_params(
                "UPDATE password_reset_otps SET consumed_at = NOW() WHERE id = $1 AND consumed_at IS NULL",
                resetId
            );
            txn.commit();
            Json::Value err; err["error"] = "Invalid or expired verification code";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            recordRateLimitFailure(rateLimitKey, kPasswordResetVerifyRateLimit);
            callback(resp);
            return;
        }

        const std::string expectedHash = resetRow["otp_hash"].as<std::string>();
        const std::string providedHash = hashPasswordResetOtp(email, otp);
        const bool hashMatches = providedHash.size() == expectedHash.size() &&
                                 CRYPTO_memcmp(providedHash.data(), expectedHash.data(), expectedHash.size()) == 0;

        if (!hashMatches) {
            txn.exec_params(
                "UPDATE password_reset_otps "
                "SET attempts_used = attempts_used + 1, "
                "    consumed_at = CASE WHEN attempts_used + 1 >= max_attempts THEN NOW() ELSE consumed_at END "
                "WHERE id = $1",
                resetId
            );
            txn.commit();
            Json::Value err; err["error"] = "Invalid or expired verification code";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            recordRateLimitFailure(rateLimitKey, kPasswordResetVerifyRateLimit);
            callback(resp);
            return;
        }

        txn.exec_params(
            "UPDATE users "
            "SET password_hash = $1, updated_at = NOW(), token_invalid_before = NOW() "
            "WHERE id = $2",
            PasswordHelper::hashPassword(newPassword),
            userId
        );
        txn.exec_params(
            "UPDATE password_reset_otps "
            "SET attempts_used = attempts_used + 1, consumed_at = NOW() "
            "WHERE id = $1",
            resetId
        );
        txn.commit();

        Json::Value auditMeta;
        auditMeta["method"] = "otp_email";
        AuditLogger::recordFromRequest(req, userId, "auth.password_reset_completed", "user", userId, auditMeta);

        clearRateLimitState(rateLimitKey);
        Json::Value bodyJson;
        bodyJson["message"] = "Password updated successfully. Please sign in with your new password.";
        callback(drogon::HttpResponse::newHttpJsonResponse(bodyJson));
    } catch (const std::exception& e) {
        spdlog::error("Password reset verify error: {}", e.what());
        Json::Value err; err["error"] = "Internal server error";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void AuthController::disconnectGitHub(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback
) {
    const std::string userId = extractUserIdFromRequest(req);
    if (userId.empty()) {
        Json::Value err; err["error"] = "Unauthorized";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp);
        return;
    }

    try {
        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);

        auto userRows = txn.exec_params(
            "SELECT id, username, email, password_hash, full_name, sign_in_type, google_sub, github_id, github_username, created_at, updated_at "
            "FROM users WHERE id = $1",
            userId
        );

        if (userRows.empty()) {
            Json::Value err; err["error"] = "User not found";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp);
            return;
        }

        const auto& row = userRows[0];
        if (row["github_id"].is_null()) {
            Json::Value err; err["error"] = "GitHub is not connected to this account";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp);
            return;
        }

        if (!hasUsableLocalPassword(row) && row["google_sub"].is_null()) {
            Json::Value err; err["error"] = "Add another sign-in method before disconnecting GitHub";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp);
            return;
        }

        auto updatedRows = txn.exec_params(
            "UPDATE users "
            "SET github_id = NULL, github_username = '', github_access_token = '', updated_at = NOW() "
            "WHERE id = $1 "
            "RETURNING id, username, email, password_hash, full_name, sign_in_type, google_sub, github_id, github_username, created_at, updated_at",
            userId
        );
        txn.commit();

        Json::Value body;
        body["message"] = "GitHub disconnected successfully";
        body["user"] = userJsonFromRow(updatedRows[0]);
        AuditLogger::recordFromRequest(req, userId, "integration.github.disconnected", "user", userId, Json::Value(Json::objectValue));
        callback(drogon::HttpResponse::newHttpJsonResponse(body));
    } catch (const std::exception& e) {
        spdlog::error("Disconnect GitHub error: {}", e.what());
        Json::Value err; err["error"] = "Internal server error";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void AuthController::getMe(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback
) {
    spdlog::info("GET /api/v1/auth/me");

    try {
        const std::string userId = extractUserIdFromRequest(req);
        if (userId.empty()) {
            Json::Value err; err["error"] = "Invalid or expired token";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k401Unauthorized);
            callback(resp);
            return;
        }

        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);
        auto result = txn.exec_params(
            "SELECT id, username, email, password_hash, full_name, sign_in_type, google_sub, github_id, github_username, github_access_token, created_at, updated_at "
            "FROM users WHERE id = $1",
            userId
        );
        txn.commit();

        if (result.empty()) {
            Json::Value err; err["error"] = "User not found";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp);
            return;
        }

        Json::Value body;
        body["user"] = userJsonFromRow(result[0]);
        const bool hasGitHubToken =
            !result[0]["github_access_token"].is_null() &&
            !TokenCrypto::decrypt(result[0]["github_access_token"].as<std::string>()).empty();
        body["user"]["github_connected"] = !result[0]["github_id"].is_null() && hasGitHubToken;
        callback(drogon::HttpResponse::newHttpJsonResponse(body));
    } catch (const std::exception& e) {
        spdlog::error("GetMe error: {}", e.what());
        Json::Value err; err["error"] = "Internal server error";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void AuthController::getLoginHistory(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback
) {
    try {
        const std::string userId = extractUserIdFromRequest(req);
        if (userId.empty()) {
            Json::Value err; err["error"] = "Invalid or expired token";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k401Unauthorized);
            callback(resp);
            return;
        }

        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);
        auto rows = txn.exec_params(
            "SELECT id, login_method, ip_address, device, user_agent, created_at "
            "FROM login_history "
            "WHERE user_id = $1 "
            "ORDER BY created_at DESC "
            "LIMIT 50",
            userId
        );
        txn.commit();

        Json::Value body;
        Json::Value history(Json::arrayValue);
        for (const auto& row : rows) {
            Json::Value item;
            item["id"] = row["id"].as<std::string>();
            item["login_method"] = row["login_method"].is_null() ? "" : row["login_method"].as<std::string>();
            item["ip_address"] = row["ip_address"].is_null() ? "" : row["ip_address"].as<std::string>();
            item["device"] = row["device"].is_null() ? "" : row["device"].as<std::string>();
            item["user_agent"] = row["user_agent"].is_null() ? "" : row["user_agent"].as<std::string>();
            item["created_at"] = row["created_at"].as<std::string>();
            history.append(item);
        }
        body["history"] = history;
        body["count"] = static_cast<int>(rows.size());
        callback(drogon::HttpResponse::newHttpJsonResponse(body));
    } catch (const std::exception& e) {
        spdlog::error("GetLoginHistory error: {}", e.what());
        Json::Value err; err["error"] = "Internal server error";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void AuthController::getAuditLogs(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback
) {
    try {
        const std::string userId = extractUserIdFromRequest(req);
        if (userId.empty()) {
            Json::Value err; err["error"] = "Invalid or expired token";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k401Unauthorized);
            callback(resp);
            return;
        }

        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);
        auto rows = txn.exec_params(
            "SELECT id, action, target_type, target_id, ip_address, user_agent, metadata::text AS metadata, created_at "
            "FROM audit_logs "
            "WHERE user_id = $1 "
            "ORDER BY created_at DESC "
            "LIMIT 100",
            userId
        );
        txn.commit();

        Json::Value body;
        Json::Value logs(Json::arrayValue);
        Json::CharReaderBuilder readerBuilder;
        for (const auto& row : rows) {
            Json::Value item;
            item["id"] = row["id"].as<std::string>();
            item["action"] = row["action"].as<std::string>();
            item["target_type"] = row["target_type"].is_null() ? "" : row["target_type"].as<std::string>();
            item["target_id"] = row["target_id"].is_null() ? "" : row["target_id"].as<std::string>();
            item["ip_address"] = row["ip_address"].is_null() ? "" : row["ip_address"].as<std::string>();
            item["user_agent"] = row["user_agent"].is_null() ? "" : row["user_agent"].as<std::string>();
            item["created_at"] = row["created_at"].as<std::string>();

            const std::string metadataText = row["metadata"].is_null() ? "{}" : row["metadata"].as<std::string>();
            Json::Value metadata(Json::objectValue);
            std::string parseErrors;
            std::istringstream metadataStream(metadataText);
            if (Json::parseFromStream(readerBuilder, metadataStream, &metadata, &parseErrors)) {
                item["metadata"] = metadata;
            } else {
                item["metadata"] = Json::Value(Json::objectValue);
            }
            logs.append(item);
        }
        body["logs"] = logs;
        body["count"] = static_cast<int>(rows.size());
        callback(drogon::HttpResponse::newHttpJsonResponse(body));
    } catch (const std::exception& e) {
        spdlog::error("GetAuditLogs error: {}", e.what());
        Json::Value err; err["error"] = "Internal server error";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void AuthController::updateMe(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback
) {
    try {
        const std::string userId = extractUserIdFromRequest(req);
        if (userId.empty()) {
            Json::Value err; err["error"] = "Invalid or expired token";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k401Unauthorized);
            callback(resp);
            return;
        }

        auto json = req->getJsonObject();
        if (!json || !json->isMember("full_name")) {
            Json::Value err; err["error"] = "Missing full_name field";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k400BadRequest);
            callback(resp);
            return;
        }

        auto& db = Database::getInstance();
        auto conn = db.getConnection();
        pqxx::work txn(*conn);
        auto result = txn.exec_params(
            "UPDATE users SET full_name = $1, updated_at = NOW() "
            "WHERE id = $2 "
            "RETURNING id, username, email, password_hash, full_name, sign_in_type, google_sub, github_id, github_username, created_at, updated_at",
            trim((*json)["full_name"].asString()),
            userId
        );
        txn.commit();

        if (result.empty()) {
            Json::Value err; err["error"] = "User not found";
            auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
            resp->setStatusCode(drogon::k404NotFound);
            callback(resp);
            return;
        }

        Json::Value respBody;
        respBody["message"] = "Profile updated successfully";
        respBody["user"] = userJsonFromRow(result[0]);
        AuditLogger::recordFromRequest(req, userId, "account.profile_updated", "user", userId, Json::Value(Json::objectValue));
        callback(drogon::HttpResponse::newHttpJsonResponse(respBody));
    } catch (const std::exception& e) {
        spdlog::error("UpdateMe error: {}", e.what());
        Json::Value err; err["error"] = "Internal server error";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

void AuthController::handleOptions(
    const drogon::HttpRequestPtr&,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback
) {
    auto resp = drogon::HttpResponse::newHttpResponse();
    resp->setStatusCode(drogon::k204NoContent);
    const char* allowedOrigin = std::getenv("CORS_ALLOWED_ORIGIN");
    resp->addHeader("Access-Control-Allow-Origin", allowedOrigin && *allowedOrigin ? allowedOrigin : "http://localhost:3000");
    resp->addHeader("Access-Control-Allow-Credentials", "true");
    resp->addHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    resp->addHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    resp->addHeader("Access-Control-Max-Age", "86400");
    callback(resp);
}

} // namespace dokscp
