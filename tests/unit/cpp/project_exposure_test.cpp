#include "testing.h"
#include "../../../src/services/ProjectExposure.h"
using namespace stackpilot::projectExposure;
namespace {
const std::string id="ac9c8772-6694-4aaa-9786-2ae6c271953c";
Json::Value ports() {
    Json::Value value;
    value["NetworkSettings"]["Ports"]["3000/tcp"][0]["HostPort"]="12345";
    value["NetworkSettings"]["Ports"]["8000/tcp"][0]["HostPort"]="64345";
    return value;
}
}
TEST(ProjectExposure, PublishedMappingWinsOverAStalePortDraft) {
    Json::Value snapshot;snapshot["container_port"]=3000;
    const auto found=discoverPorts(ports(),snapshot,"http://localhost:64345");
    EXPECT_EQ(found.container,8000);EXPECT_EQ(found.host,64345);
}
TEST(ProjectExposure, PublicUrlUsesSavedContainerPortToSelectMapping) {
    Json::Value snapshot;snapshot["container_port"]=8000;
    EXPECT_EQ(discoverPorts(ports(),snapshot,"https://old.trycloudflare.com").container,8000);
}
TEST(ProjectExposure, MissingPublishedPortDoesNotGuess3000) {
    bool failed=false;try{discoverPorts(Json::Value(Json::objectValue),Json::Value(),"");}catch(const std::invalid_argument&){failed=true;}
    EXPECT_TRUE(failed);
}
TEST(ProjectExposure, QuickTunnelTargetsTheOwnedNamespaceAndActualPort) {
    const auto spec=tunnelSpec(id,std::string(64,'a'),8000,"");
    EXPECT_EQ(spec["Image"].asString(),std::string("cloudflare/cloudflared:2026.9.1"));
    EXPECT_CONTAINS(spec["Cmd"].toStyledString(),"http://127.0.0.1:8000");
    EXPECT_EQ(spec["HostConfig"]["NetworkMode"].asString(),"container:"+std::string(64,'a'));
    EXPECT_FALSE(spec["HostConfig"].isMember("PortBindings"));
    EXPECT_TRUE(spec["HostConfig"]["ReadonlyRootfs"].asBool());
    EXPECT_CONTAINS(spec["Healthcheck"]["Test"].toStyledString(),"ready");
}
TEST(ProjectExposure, NamedTokenDoesNotAppearInCommandArguments) {
    const auto spec=tunnelSpec(id,std::string(64,'a'),8000,"fixture-secret-token");
    EXPECT_NOT_CONTAINS(spec["Cmd"].toStyledString(),"fixture-secret-token");
    EXPECT_EQ(spec["Env"][0].asString(),std::string("TUNNEL_TOKEN=fixture-secret-token"));
}
TEST(ProjectExposure, PrivateJobConfigurationNeverAppearsInStatus) {
    Json::Value snapshot;
    snapshot["public_exposure"]["state"]="connecting";
    snapshot["public_exposure"]["configuration_encrypted"]="private-ciphertext";
    snapshot["public_exposure"]["requested_by"]="private-user-id";
    const auto result=publicStatus(snapshot,"http://localhost:64345","local_docker");
    EXPECT_EQ(result["runtime_exposure"].asString(),std::string("local_docker"));
    EXPECT_EQ(result["state"].asString(),std::string("connecting"));
    EXPECT_NOT_CONTAINS(result.toStyledString(),"private-");
}
TEST(ProjectExposure, ContainerIdentityRetainsTheEntireDeploymentId) {
    EXPECT_TRUE(tunnelName(id)!=tunnelName("ac9c8772-6694-4aaa-9786-2ae6c271953d"));
    bool failed=false;try{tunnelSpec(id,"other-container; command",8000,"");}catch(const std::invalid_argument&){failed=true;}
    EXPECT_TRUE(failed);
}
