#pragma once

#include <drogon/HttpController.h>

namespace stackpilot {
class BrowserTunnelController : public drogon::HttpController<BrowserTunnelController> {
public:
    METHOD_LIST_BEGIN
    ADD_METHOD_TO(BrowserTunnelController::ensure, "/api/v1/internal/browser-tunnel/ensure", drogon::Post);
    METHOD_LIST_END

    void ensure(const drogon::HttpRequestPtr&,
                std::function<void(const drogon::HttpResponsePtr&)>&&);
};
}
