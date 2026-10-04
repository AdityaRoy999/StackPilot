#pragma once
#include <drogon/HttpController.h>
namespace stackpilot {
class RuntimeObservationController:public drogon::HttpController<RuntimeObservationController> {
public:
    METHOD_LIST_BEGIN
    ADD_METHOD_TO(RuntimeObservationController::observe,"/api/v1/internal/runtime-observation/{1}",drogon::Post);
    METHOD_LIST_END
    void observe(const drogon::HttpRequestPtr&,std::function<void(const drogon::HttpResponsePtr&)>&&,const std::string&);
};
}
