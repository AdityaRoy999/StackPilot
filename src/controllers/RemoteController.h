#pragma once
#include <drogon/HttpController.h>
namespace stackpilot {
class RemoteController : public drogon::HttpController<RemoteController> {
public:
    METHOD_LIST_BEGIN
    ADD_METHOD_TO(RemoteController::manage,"/api/v1/remote/pairings",drogon::Post);
    ADD_METHOD_TO(RemoteController::manage,"/api/v1/remote/devices",drogon::Get);
    ADD_METHOD_TO(RemoteController::manage,"/api/v1/remote/devices",drogon::Post);
    ADD_METHOD_TO(RemoteController::manage,"/api/v1/remote/access",drogon::Get,drogon::Post);
    ADD_METHOD_TO(RemoteController::connect,"/api/v1/remote/connect",drogon::Post);
    ADD_METHOD_TO(RemoteController::device,"/api/v1/remote/device",drogon::Get,drogon::Delete);
    ADD_METHOD_TO(RemoteController::session,"/api/v1/remote/session",drogon::Post);
    ADD_METHOD_TO(RemoteController::authorize,"/api/v1/remote/authorize",drogon::Get);
    ADD_METHOD_VIA_REGEX(RemoteController::proxy,"/api/v1/remote/api/(.*)",drogon::Get,drogon::Post);
    ADD_METHOD_TO(RemoteController::runs,"/api/v1/remote/runs",drogon::Get);
    ADD_METHOD_TO(RemoteController::run,"/api/v1/remote/runs/{1}",drogon::Get);
    METHOD_LIST_END
    void manage(const drogon::HttpRequestPtr&,std::function<void(const drogon::HttpResponsePtr&)>&&);
    void connect(const drogon::HttpRequestPtr&,std::function<void(const drogon::HttpResponsePtr&)>&&);
    void device(const drogon::HttpRequestPtr&,std::function<void(const drogon::HttpResponsePtr&)>&&);
    void session(const drogon::HttpRequestPtr&,std::function<void(const drogon::HttpResponsePtr&)>&&);
    void authorize(const drogon::HttpRequestPtr&,std::function<void(const drogon::HttpResponsePtr&)>&&);
    void proxy(const drogon::HttpRequestPtr&,std::function<void(const drogon::HttpResponsePtr&)>&&,const std::string&);
    void runs(const drogon::HttpRequestPtr&,std::function<void(const drogon::HttpResponsePtr&)>&&);
    void run(const drogon::HttpRequestPtr&,std::function<void(const drogon::HttpResponsePtr&)>&&,const std::string&);
};
}
