// ============================================================
// main.cpp — Application Entry Point
// ============================================================
// CONCEPT: This is where your application starts. Think of it
// as the "ignition" of your server.
//
// What happens here:
// 1. Initialize logging (spdlog)
// 2. Connect to PostgreSQL database
// 3. Start the Drogon HTTP server
//
// Drogon is an ASYNC framework — it uses an event loop
// (like Node.js) to handle thousands of connections without
// creating a thread per request. This is why C++ web servers
// can be so fast.
// ============================================================

#include <drogon/drogon.h>
#include <spdlog/spdlog.h>
#include <spdlog/sinks/stdout_color_sinks.h>
#include "db/Database.h"
#include "services/JobQueueService.h"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>
#include <pqxx/pqxx>

namespace {

std::string getEnvOrDefault(const char* name, const std::string& fallback) {
    const char* value = std::getenv(name);
    return (value && *value) ? value : fallback;
}

int getEnvIntOrDefault(const char* name, int fallback) {
    const char* value = std::getenv(name);
    if (!value || !*value) return fallback;
    try {
        return std::stoi(value);
    } catch (...) {
        return fallback;
    }
}

bool getEnvBoolOrDefault(const char* name, bool fallback) {
    const char* value = std::getenv(name);
    if (!value || !*value) return fallback;
    std::string normalized(value);
    std::transform(normalized.begin(), normalized.end(), normalized.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return normalized == "1" || normalized == "true" || normalized == "yes" || normalized == "on";
}

std::string trim(std::string value) {
    auto isSpace = [](unsigned char c) { return std::isspace(c) != 0; };
    value.erase(value.begin(), std::find_if(value.begin(), value.end(), [&](char c) {
        return !isSpace(static_cast<unsigned char>(c));
    }));
    value.erase(std::find_if(value.rbegin(), value.rend(), [&](char c) {
        return !isSpace(static_cast<unsigned char>(c));
    }).base(), value.end());
    return value;
}

std::vector<std::string> splitCsv(const std::string& value) {
    std::vector<std::string> entries;
    std::string current;
    for (char c : value) {
        if (c == ',') {
            current = trim(current);
            if (!current.empty()) entries.push_back(current);
            current.clear();
        } else {
            current.push_back(c);
        }
    }
    current = trim(current);
    if (!current.empty()) entries.push_back(current);
    return entries;
}

bool startsWith(const std::string& value, const std::string& prefix) {
    return value.rfind(prefix, 0) == 0;
}

bool isProductionEnv() {
    const std::string env = getEnvOrDefault("AIDS_ENV", getEnvOrDefault("NODE_ENV", "development"));
    return env == "production";
}

bool isOriginAllowed(const std::string& origin, const std::vector<std::string>& allowedOrigins) {
    return std::find(allowedOrigins.begin(), allowedOrigins.end(), origin) != allowedOrigins.end();
}

std::string chooseCorsOrigin(const drogon::HttpRequestPtr& req,
                             const std::vector<std::string>& allowedOrigins) {
    const std::string origin = req->getHeader("Origin");
    if (!origin.empty() && isOriginAllowed(origin, allowedOrigins)) {
        return origin;
    }
    return allowedOrigins.empty() ? "" : allowedOrigins.front();
}

bool isMutatingMethod(drogon::HttpMethod method) {
    return method != drogon::Get &&
           method != drogon::Head &&
           method != drogon::Options;
}

bool hasBearerToken(const drogon::HttpRequestPtr& req) {
    const std::string authHeader = req->getHeader("Authorization");
    return startsWith(authHeader, "Bearer ");
}

bool hasAuthCookie(const drogon::HttpRequestPtr& req) {
    if (!req->getCookie("token").empty()) {
        return true;
    }
    return req->getHeader("cookie").find("token=") != std::string::npos;
}

bool hasCsrfHeader(const drogon::HttpRequestPtr& req) {
    const std::string header = req->getHeader("X-AIDS-CSRF");
    return header == "1" || header == "true";
}

bool isTrustedBrowserOrigin(const drogon::HttpRequestPtr& req,
                            const std::vector<std::string>& allowedOrigins) {
    const std::string origin = req->getHeader("Origin");
    if (!origin.empty()) {
        return isOriginAllowed(origin, allowedOrigins);
    }

    const std::string referer = req->getHeader("Referer");
    if (!referer.empty()) {
        for (const auto& allowedOrigin : allowedOrigins) {
            if (startsWith(referer, allowedOrigin + "/") || referer == allowedOrigin) {
                return true;
            }
        }
    }

    return false;
}

std::string clientIp(const drogon::HttpRequestPtr& req, bool trustProxyHeaders) {
    if (trustProxyHeaders) {
        const std::string forwardedFor = req->getHeader("X-Forwarded-For");
        if (!forwardedFor.empty()) {
            const auto comma = forwardedFor.find(',');
            return trim(forwardedFor.substr(0, comma));
        }
        const std::string realIp = req->getHeader("X-Real-IP");
        if (!realIp.empty()) {
            return trim(realIp);
        }
    }
    return req->peerAddr().toIp();
}

struct WindowCounter {
    std::chrono::steady_clock::time_point windowStart{};
    int count = 0;
};

std::mutex rateLimitMutex;
std::unordered_map<std::string, WindowCounter> rateLimitCounters;

bool isApiRateLimited(const std::string& key, int limitPerMinute, int& retryAfterSeconds) {
    if (limitPerMinute <= 0) return false;

    const auto now = std::chrono::steady_clock::now();
    std::lock_guard<std::mutex> lock(rateLimitMutex);
    auto& counter = rateLimitCounters[key];
    if (counter.count == 0 ||
        std::chrono::duration_cast<std::chrono::seconds>(now - counter.windowStart).count() >= 60) {
        counter.windowStart = now;
        counter.count = 0;
    }

    ++counter.count;
    if (counter.count <= limitPerMinute) {
        return false;
    }

    const auto elapsed = std::chrono::duration_cast<std::chrono::seconds>(now - counter.windowStart).count();
    retryAfterSeconds = static_cast<int>(std::max<int64_t>(1, 60 - elapsed));
    return true;
}

void validateProductionConfiguration(const std::string& jwtSecret,
                                     const std::string& tokenKey,
                                     const std::vector<std::string>& allowedOrigins,
                                     const std::string& frontendUrl,
                                     const std::string& backendUrl) {
    if (!isProductionEnv()) {
        return;
    }

    std::vector<std::string> errors;
    if (!startsWith(frontendUrl, "https://")) {
        errors.push_back("FRONTEND_PUBLIC_URL must use https:// in production");
    }
    if (!startsWith(backendUrl, "https://")) {
        errors.push_back("BACKEND_PUBLIC_URL must use https:// in production");
    }
    for (const auto& origin : allowedOrigins) {
        if (!startsWith(origin, "https://")) {
            errors.push_back("CORS_ALLOWED_ORIGIN entries must use https:// in production: " + origin);
        }
    }
    if (jwtSecret.find("local-development") != std::string::npos ||
        tokenKey.find("local-development") != std::string::npos) {
        errors.push_back("JWT_SECRET and TOKEN_ENCRYPTION_KEY must be replaced with high-entropy production secrets");
    }
    if (getEnvOrDefault("DB_PASSWORD", "").find("aids_secret") != std::string::npos) {
        errors.push_back("DB_PASSWORD must be changed from the local default in production");
    }

    if (!errors.empty()) {
        for (const auto& error : errors) {
            std::cerr << "Production configuration error: " << error << std::endl;
        }
        throw std::runtime_error("Production configuration validation failed");
    }
}

} // namespace

int main() {
    const std::string jwtSecret = getEnvOrDefault("JWT_SECRET", "");
    const std::string tokenKey = getEnvOrDefault("TOKEN_ENCRYPTION_KEY", "");
    if (jwtSecret.size() < 32) {
        std::cerr << "JWT_SECRET must be set to at least 32 characters" << std::endl;
        return 1;
    }
    if (tokenKey.size() < 32) {
        std::cerr << "TOKEN_ENCRYPTION_KEY must be set to at least 32 characters" << std::endl;
        return 1;
    }
    // ─── Step 1: Setup logging ──────────────────────────────
    // spdlog is a fast C++ logging library
    // "info" level means we see INFO, WARN, ERROR (not DEBUG)
    auto console = spdlog::stdout_color_mt("aids");
    spdlog::set_default_logger(console);
    spdlog::set_level(spdlog::level::info);
    const std::string frontendPublicUrl = getEnvOrDefault("FRONTEND_PUBLIC_URL", "http://localhost:3000");
    const std::string backendPublicUrlForValidation = getEnvOrDefault("BACKEND_PUBLIC_URL", "http://localhost:8090");
    const std::vector<std::string> allowedOriginsForValidation = splitCsv(
        getEnvOrDefault("CORS_ALLOWED_ORIGIN", frontendPublicUrl)
    );
    try {
        validateProductionConfiguration(
            jwtSecret,
            tokenKey,
            allowedOriginsForValidation,
            frontendPublicUrl,
            backendPublicUrlForValidation
        );
    } catch (const std::exception& e) {
        std::cerr << e.what() << std::endl;
        return 1;
    }
    spdlog::info("===========================================");
    spdlog::info("  AIDS Platform — Starting up...");
    spdlog::info("===========================================");

    // ─── Step 2: Initialize database connection ─────────────
    // We connect to PostgreSQL before starting the HTTP server
    // so that all controllers can use the DB immediately
    try {
        auto& db = aids::Database::getInstance();
        db.initialize(
            getEnvOrDefault("DB_HOST", "localhost"),
            getEnvIntOrDefault("DB_PORT", 5433),
            getEnvOrDefault("DB_NAME", "aids_platform"),
            getEnvOrDefault("DB_USER", "aids_admin"),
            getEnvOrDefault("DB_PASSWORD", "")
        );
        spdlog::info("Database connection initialized successfully");

        // ─── Step 2.5: Run migrations ───────────────────────────
        const char* migrationsPath = std::getenv("MIGRATIONS_PATH");
        if (!migrationsPath) migrationsPath = "sql/migrations";
        db.runMigrations(migrationsPath);

        try {
            auto conn = db.getConnection();
            pqxx::work txn(*conn);
            txn.exec(
                "UPDATE deployments "
                "SET status = 'failed', "
                "logs = COALESCE(NULLIF(logs, ''), 'Build was interrupted before logs were persisted.') "
                "       || E'\\nBuild marked failed during backend recovery because it was left building for too long. Re-run the build to capture fresh diagnostics.\\n', "
                "updated_at = NOW() "
                "WHERE status = 'building' AND job_id IS NULL AND updated_at < NOW() - INTERVAL '10 minutes'"
            );
            txn.commit();
        } catch (const std::exception& e) {
            spdlog::warn("Interrupted deployment recovery skipped: {}", e.what());
        }
        
    } catch (const std::exception& e) {
        spdlog::error("Failed to initialize database: {}", e.what());
        spdlog::info("Tip: Make sure PostgreSQL is running via 'docker-compose up -d'");
        return 1;
    }

    // ─── Step 3: Configure and run Drogon ───────────────────
    // CONCEPT: Drogon auto-discovers controllers at compile time
    // using the METHOD_LIST macros. You don't need to manually
    // register routes — just define controllers and they work.

    aids::JobQueueService::getInstance().start();

    auto& app = drogon::app();
    const std::vector<std::string> allowedOrigins = splitCsv(
        getEnvOrDefault("CORS_ALLOWED_ORIGIN", "http://localhost:3000")
    );
    const std::string backendPublicUrl = getEnvOrDefault("BACKEND_PUBLIC_URL", "http://localhost:8090");
    const bool backendUsesHttps = startsWith(backendPublicUrl, "https://");
    const bool requireHttps = getEnvBoolOrDefault("AIDS_REQUIRE_HTTPS", isProductionEnv());
    const bool trustProxyHeaders = getEnvBoolOrDefault("AIDS_TRUST_PROXY_HEADERS", isProductionEnv());
    const int apiRateLimitPerMinute = getEnvIntOrDefault("AIDS_API_RATE_LIMIT_PER_MINUTE", isProductionEnv() ? 240 : 0);

    // Load config from file
    app.loadConfigFile("config.json");

    // ─── CORS Configuration ─────────────────────────────────────
    // 1. Intercept OPTIONS preflight BEFORE Drogon's router touches it
    app.registerPreRoutingAdvice(
        [allowedOrigins, requireHttps, trustProxyHeaders, apiRateLimitPerMinute](const drogon::HttpRequestPtr& req,
           drogon::AdviceCallback&& callback,
           drogon::AdviceChainCallback&& chainCallback) {
            const std::string corsOrigin = chooseCorsOrigin(req, allowedOrigins);
            if (req->method() == drogon::Options) {
                auto resp = drogon::HttpResponse::newHttpResponse();
                resp->setStatusCode(drogon::k204NoContent);
                resp->addHeader("Access-Control-Allow-Origin", corsOrigin);
                resp->addHeader("Access-Control-Allow-Credentials", "true");
                resp->addHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH");
                resp->addHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-AIDS-CSRF");
                resp->addHeader("Access-Control-Max-Age", "86400");
                callback(resp);
                return;
            }

            if (requireHttps && trustProxyHeaders && req->getHeader("X-Forwarded-Proto") != "https") {
                Json::Value err;
                err["error"] = "HTTPS is required";
                auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
                resp->setStatusCode(drogon::k403Forbidden);
                resp->addHeader("Access-Control-Allow-Origin", corsOrigin);
                resp->addHeader("Access-Control-Allow-Credentials", "true");
                callback(resp);
                return;
            }

            if (startsWith(req->path(), "/api/")) {
                int retryAfterSeconds = 0;
                if (isApiRateLimited(clientIp(req, trustProxyHeaders), apiRateLimitPerMinute, retryAfterSeconds)) {
                    Json::Value err;
                    err["error"] = "Too many requests. Please wait and try again.";
                    auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
                    resp->setStatusCode(drogon::k429TooManyRequests);
                    resp->addHeader("Retry-After", std::to_string(retryAfterSeconds));
                    resp->addHeader("Access-Control-Allow-Origin", corsOrigin);
                    resp->addHeader("Access-Control-Allow-Credentials", "true");
                    callback(resp);
                    return;
                }
            }

            if (isMutatingMethod(req->method()) && !hasBearerToken(req) &&
                (!isTrustedBrowserOrigin(req, allowedOrigins) || !hasCsrfHeader(req))) {
                Json::Value err;
                err["error"] = "Untrusted request origin";
                auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
                resp->setStatusCode(drogon::k403Forbidden);
                resp->addHeader("Access-Control-Allow-Origin", corsOrigin);
                resp->addHeader("Access-Control-Allow-Credentials", "true");
                callback(resp);
                return;
            }
            chainCallback();
        }
    );

    // 2. Add CORS headers to all normal responses
    app.registerPostHandlingAdvice(
        [allowedOrigins, backendUsesHttps](const drogon::HttpRequestPtr& req,
           const drogon::HttpResponsePtr& resp) {
            resp->addHeader("Access-Control-Allow-Origin", chooseCorsOrigin(req, allowedOrigins));
            resp->addHeader("Access-Control-Allow-Credentials", "true");
            resp->addHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH");
            resp->addHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-AIDS-CSRF");
            resp->addHeader("Vary", "Origin");
            resp->addHeader("X-Content-Type-Options", "nosniff");
            resp->addHeader("X-Frame-Options", "DENY");
            resp->addHeader("Referrer-Policy", "strict-origin-when-cross-origin");
            resp->addHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
            resp->addHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
            if (backendUsesHttps) {
                resp->addHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
            }
        }
    );


    spdlog::info("Server starting on http://0.0.0.0:8090");
    spdlog::info("Press Ctrl+C to stop");

    // This blocks — runs the event loop
    app.run();

    return 0;
}
