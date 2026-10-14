#include "testing.h"
#include "../../../src/services/ProjectStackInspector.h"
#include <fstream>

using namespace stackpilot;
namespace {
bool has(const Json::Value& stack, const std::string& id, const std::string& kind = "") {
    for (const auto& component : stack["components"]) if (component["id"].asString() == id && (kind.empty() || component["kind"].asString() == kind)) return true;
    return false;
}
}

TEST(ProjectStack, DetectsMonorepoFrameworksAndDatabaseClientsWithoutCreatingServices) {
    auto stack = ProjectStackInspector::detect({
        {"frontend/package.json", R"({"dependencies":{"next":"16","react":"19"}})"},
        {"backend/package.json", R"({"dependencies":{"express":"5","pg":"8"}})"},
        {"ai/requirements.txt", "fastapi>=0.1\nredis==5\n"}});
    EXPECT_TRUE(has(stack, "nextjs")); EXPECT_TRUE(has(stack, "express")); EXPECT_TRUE(has(stack, "fastapi"));
    EXPECT_TRUE(has(stack, "postgres", "client")); EXPECT_FALSE(has(stack, "postgres", "service"));
}

TEST(ProjectStack, DoesNotInferAFrameworkOrDatabaseFromNamesAndComments) {
    auto stack = ProjectStackInspector::detect({{"package.json", R"({"name":"postgres-next-react","description":"express pg"})"},
        {"requirements.txt", "# flask and django could be added later\nrequests==2.31\n"}});
    EXPECT_FALSE(has(stack, "postgres")); EXPECT_FALSE(has(stack, "nextjs")); EXPECT_FALSE(has(stack, "react"));
    EXPECT_FALSE(has(stack, "flask")); EXPECT_FALSE(has(stack, "django"));
}

TEST(ProjectStack, IdentifiesDeclaredComposeServicesAndDoesNotExposeValues) {
    auto stack = ProjectStackInspector::detect({{"compose.yaml", "services:\n  db:\n    image: postgres:16\n    environment:\n      PASSWORD: private-fixture-value\n  web:\n    image: nginx:latest\n"}});
    EXPECT_TRUE(has(stack, "postgres", "service")); EXPECT_TRUE(has(stack, "nginx", "service"));
    EXPECT_TRUE(stack.toStyledString().find("private-fixture-value") == std::string::npos);
}

TEST(ProjectStack, DetectsPresetImagesWithoutGuessingCustomImages) {
    EXPECT_TRUE(has(ProjectStackInspector::application("postgres:16"), "postgres", "service"));
    auto custom = ProjectStackInspector::application("company/my-web:latest");
    EXPECT_TRUE(has(custom, "container")); EXPECT_FALSE(has(custom, "react"));
}

TEST(ProjectStack, HandlesMalformedManifestsAndMissingDependencySections) {
    EXPECT_EQ(ProjectStackInspector::detect({{"package.json", "[invalid"}})["status"].asString(), "unknown");
    EXPECT_TRUE(has(ProjectStackInspector::detect({{"package.json", R"({"dependencies":[],"devDependencies":"wrong"})"}}), "node"));
    EXPECT_FALSE(has(ProjectStackInspector::detect({{"composer.json", "null"}}), "laravel"));
}

TEST(ProjectStack, IgnoresSecretFilesTraversalAndInstalledDependencies) {
    EXPECT_FALSE(ProjectStackInspector::isManifest(".env"));
    EXPECT_FALSE(ProjectStackInspector::isManifest("../package.json"));
    EXPECT_FALSE(ProjectStackInspector::isManifest("node_modules/next/package.json"));
    EXPECT_FALSE(ProjectStackInspector::isManifest("/etc/package.json"));
    EXPECT_TRUE(ProjectStackInspector::isManifest("frontend/package.json"));
}

TEST(ProjectStack, ReportsInspectionLimitsAndUnknownStacksHonestly) {
    auto stack = ProjectStackInspector::detect({{"package.json", std::string(65537, 'x')}});
    EXPECT_TRUE(stack["truncated"].asBool()); EXPECT_EQ(stack["status"].asString(), "unknown");
    EXPECT_EQ(ProjectStackInspector::detect({})["status"].asString(), "unknown");
}

TEST(ProjectStack, RefusesLinksToFilesOutsideTheSourceFolder) {
    namespace fs = std::filesystem;
    auto root = fs::temp_directory_path() / "stackpilot-stack-inspection-test";
    fs::create_directories(root / "outside"); fs::create_directories(root / "source");
    std::ofstream(root / "outside/package.json") << R"({"dependencies":{"react":"19"}})";
    fs::create_symlink(root / "outside/package.json", root / "source/package.json");
    fs::create_directory_symlink(root / "outside", root / "source/linked");
    EXPECT_FALSE(has(ProjectStackInspector::local(root / "source"), "react"));
    fs::remove_all(root);
}

TEST(ProjectStack, RemoteProtocolParsesOnlyManifestDataAndReturnsNoContents) {
    auto stack = ProjectStackInspector::remoteOutput("__STACKPILOT_CWD__=/fixture\n__STACKPILOT_MANIFESTS__{\"files\":{\"requirements.txt\":\"fastapi==1\\n# secret-value\"},\"truncated\":false}\n__STACKPILOT_EXIT_CODE__=0\n");
    EXPECT_TRUE(has(stack, "fastapi")); EXPECT_TRUE(stack.toStyledString().find("secret-value") == std::string::npos);
    EXPECT_EQ(ProjectStackInspector::remoteOutput("invalid")["status"].asString(), "unavailable");
}
