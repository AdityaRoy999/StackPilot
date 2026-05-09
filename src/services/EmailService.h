#pragma once

#include <string>

namespace dokscp {

class EmailService {
public:
    static bool isConfigured();
    static void sendPasswordResetOtp(const std::string& toEmail,
                                     const std::string& toName,
                                     const std::string& otpCode,
                                     int expiryMinutes);

private:
    static std::string getSmtpHost();
    static int getSmtpPort();
    static std::string getSmtpUsername();
    static std::string getSmtpPassword();
    static std::string getFromEmail();
    static std::string getFromName();
};

} // namespace dokscp
