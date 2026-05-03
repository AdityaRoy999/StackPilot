#include "EmailService.h"

#include <curl/curl.h>
#include <spdlog/spdlog.h>

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>

namespace aids {
namespace {

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

std::string getEnvOrDefault(const char* name, const std::string& fallback = "") {
    const char* value = std::getenv(name);
    return (value && *value) ? value : fallback;
}

std::string collapseWhitespace(std::string value) {
    std::replace_if(value.begin(), value.end(), [](unsigned char c) {
        return c == '\r' || c == '\n';
    }, ' ');
    return trim(value);
}

struct UploadPayload {
    const char* data = nullptr;
    size_t remaining = 0;
};

size_t payloadSource(char* ptr, size_t size, size_t nmemb, void* userData) {
    auto* payload = static_cast<UploadPayload*>(userData);
    const size_t bufferSize = size * nmemb;
    if (!payload || payload->remaining == 0 || bufferSize == 0) {
        return 0;
    }

    const size_t copySize = std::min(bufferSize, payload->remaining);
    std::memcpy(ptr, payload->data, copySize);
    payload->data += copySize;
    payload->remaining -= copySize;
    return copySize;
}

void ensureCurlInitialized() {
    static std::once_flag initFlag;
    std::call_once(initFlag, []() {
        if (curl_global_init(CURL_GLOBAL_DEFAULT) != CURLE_OK) {
            throw std::runtime_error("Failed to initialize libcurl");
        }
    });
}

} // namespace

std::string EmailService::getSmtpHost() {
    return getEnvOrDefault("SMTP_HOST", "smtp.gmail.com");
}

int EmailService::getSmtpPort() {
    const std::string raw = getEnvOrDefault("SMTP_PORT", "465");
    try {
        return std::max(1, std::stoi(raw));
    } catch (...) {
        return 465;
    }
}

std::string EmailService::getSmtpUsername() {
    std::string username = trim(getEnvOrDefault("SMTP_USERNAME"));
    if (!username.empty()) {
        return username;
    }
    username = trim(getEnvOrDefault("SMTP_FROM_EMAIL"));
    if (!username.empty()) {
        return username;
    }
    return trim(getEnvOrDefault("ACME_EMAIL"));
}

std::string EmailService::getSmtpPassword() {
    std::string password = getEnvOrDefault("SMTP_PASSWORD");
    if (!password.empty()) {
        return password;
    }
    return getEnvOrDefault("APP_PASSWORD");
}

std::string EmailService::getFromEmail() {
    std::string from = trim(getEnvOrDefault("SMTP_FROM_EMAIL"));
    if (!from.empty()) {
        return from;
    }
    return getSmtpUsername();
}

std::string EmailService::getFromName() {
    return collapseWhitespace(getEnvOrDefault("SMTP_FROM_NAME", "AIDS Platform"));
}

bool EmailService::isConfigured() {
    return !getSmtpHost().empty() &&
           !getSmtpUsername().empty() &&
           !getSmtpPassword().empty() &&
           !getFromEmail().empty();
}

void EmailService::sendPasswordResetOtp(const std::string& toEmail,
                                        const std::string& toName,
                                        const std::string& otpCode,
                                        int expiryMinutes) {
    if (!isConfigured()) {
        throw std::runtime_error("SMTP is not configured for password reset emails");
    }

    ensureCurlInitialized();

    const std::string smtpHost = getSmtpHost();
    const int smtpPort = getSmtpPort();
    const std::string smtpUsername = getSmtpUsername();
    const std::string smtpPassword = getSmtpPassword();
    const std::string fromEmail = getFromEmail();
    const std::string fromName = getFromName();
    const std::string safeName = collapseWhitespace(toName);

    std::ostringstream body;
    body << "From: " << fromName << " <" << fromEmail << ">\r\n"
         << "To: " << (safeName.empty() ? toEmail : safeName + " <" + toEmail + ">") << "\r\n"
         << "Subject: AIDS password reset code\r\n"
         << "MIME-Version: 1.0\r\n"
         << "Content-Type: text/plain; charset=UTF-8\r\n"
         << "\r\n"
         << "We received a request to reset your AIDS account password.\r\n"
         << "\r\n"
         << "Your verification code is: " << otpCode << "\r\n"
         << "\r\n"
         << "This code expires in " << expiryMinutes << " minutes and can only be used once.\r\n"
         << "If you did not request this reset, you can ignore this email.\r\n";

    const std::string payloadText = body.str();
    UploadPayload payload{payloadText.c_str(), payloadText.size()};

    CURL* curl = curl_easy_init();
    if (!curl) {
        throw std::runtime_error("Failed to initialize SMTP client");
    }

    struct curl_slist* recipients = nullptr;
    const std::string smtpUrl = "smtps://" + smtpHost + ":" + std::to_string(smtpPort);

    recipients = curl_slist_append(recipients, ("<" + toEmail + ">").c_str());

    curl_easy_setopt(curl, CURLOPT_URL, smtpUrl.c_str());
    curl_easy_setopt(curl, CURLOPT_USERNAME, smtpUsername.c_str());
    curl_easy_setopt(curl, CURLOPT_PASSWORD, smtpPassword.c_str());
    curl_easy_setopt(curl, CURLOPT_USE_SSL, static_cast<long>(CURLUSESSL_ALL));
    curl_easy_setopt(curl, CURLOPT_MAIL_FROM, ("<" + fromEmail + ">").c_str());
    curl_easy_setopt(curl, CURLOPT_MAIL_RCPT, recipients);
    curl_easy_setopt(curl, CURLOPT_READFUNCTION, payloadSource);
    curl_easy_setopt(curl, CURLOPT_READDATA, &payload);
    curl_easy_setopt(curl, CURLOPT_UPLOAD, 1L);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 30L);
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 15L);
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 1L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 2L);

    const CURLcode result = curl_easy_perform(curl);
    curl_slist_free_all(recipients);
    curl_easy_cleanup(curl);

    if (result != CURLE_OK) {
        spdlog::error("SMTP delivery failed: {}", curl_easy_strerror(result));
        throw std::runtime_error("Failed to deliver password reset email");
    }
}

} // namespace aids
