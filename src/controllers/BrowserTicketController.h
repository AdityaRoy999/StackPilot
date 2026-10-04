#pragma once
#include <drogon/HttpController.h>
namespace stackpilot {
class BrowserTicketController : public drogon::HttpController<BrowserTicketController> {
public:
    METHOD_LIST_BEGIN
    ADD_METHOD_TO(BrowserTicketController::ticket,"/api/v1/ai/browser-ticket/{1}",drogon::Get);
    ADD_METHOD_TO(BrowserTicketController::nativeTicket,"/api/v1/deployments/{1}/native-preview-ticket",drogon::Get);
    METHOD_LIST_END
    void nativeTicket(const drogon::HttpRequestPtr&,std::function<void(const drogon::HttpResponsePtr&)>&&,const std::string&);
    void ticket(const drogon::HttpRequestPtr&,std::function<void(const drogon::HttpResponsePtr&)>&&,const std::string&);
};
}
