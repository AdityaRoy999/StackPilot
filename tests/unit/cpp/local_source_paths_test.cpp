#include "testing.h"
#include "../../../src/utils/LocalSourcePaths.h"
#include <chrono>

namespace {
namespace local = stackpilot::LocalSourcePaths;
namespace fs = std::filesystem;
struct Sources {
    fs::path base = fs::temp_directory_path() / ("stackpilot-source-path-test-" +
        std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    std::string oldRoots = std::getenv("LOCAL_SOURCE_ROOTS") ? std::getenv("LOCAL_SOURCE_ROOTS") : "";
    std::string oldMappings = std::getenv("LOCAL_SOURCE_ROOT_MAPPINGS") ? std::getenv("LOCAL_SOURCE_ROOT_MAPPINGS") : "";
    Sources() {
        fs::create_directories(base / "c/Users/Developer/My Project");
        fs::create_directories(base / "d/Another Project");
        fs::create_directories(base / "legacy");
        fs::create_directories(base / "outside");
        setenv("LOCAL_SOURCE_ROOTS", (base / "legacy").c_str(), 1);
        Json::Value mappings(Json::arrayValue);
        for (const auto& drive : {"c", "d"}) {
            Json::Value root;
            root["path"] = (base / drive).string();
            root["host_path"] = std::string(drive == std::string("c") ? "C:/" : "D:/");
            root["name"] = root["host_path"];
            mappings.append(root);
        }
        setenv("LOCAL_SOURCE_ROOT_MAPPINGS", mappings.toStyledString().c_str(), 1);
    }
    ~Sources() {
        setenv("LOCAL_SOURCE_ROOTS", oldRoots.c_str(), 1);
        setenv("LOCAL_SOURCE_ROOT_MAPPINGS", oldMappings.c_str(), 1);
        std::error_code ec; fs::remove_all(base, ec);
    }
};
}

TEST(LocalSourcePaths, AcceptsWindowsDrivePathsAndSavedContainerPaths) {
    Sources fixture;
    fs::path resolved; std::string error;
    EXPECT_TRUE(local::resolve("c:\\Users\\Developer\\My Project", resolved, error));
    EXPECT_EQ(resolved.string(), (fixture.base / "c/Users/Developer/My Project").string());
    EXPECT_EQ(local::hostPath(resolved), std::string("C:\\Users\\Developer\\My Project"));
    EXPECT_TRUE(local::resolve(resolved.string(), resolved, error));
    EXPECT_TRUE(local::resolve("D:/Another Project", resolved, error));
    EXPECT_EQ(local::hostPath(resolved), std::string("D:\\Another Project"));
}

TEST(LocalSourcePaths, RoundTripsDriveRoots) {
    Sources fixture;
    fs::path resolved; std::string error;
    EXPECT_TRUE(local::resolve("C:\\", resolved, error));
    EXPECT_EQ(local::hostPath(resolved), std::string("C:\\"));
}

TEST(LocalSourcePaths, RejectsTraversalAndSymlinkEscapes) {
    Sources fixture;
    fs::path resolved; std::string error;
    EXPECT_FALSE(local::resolve("C:/../outside", resolved, error));
    fs::create_directory_symlink(fixture.base / "outside", fixture.base / "c/escape");
    EXPECT_FALSE(local::resolve("C:/escape", resolved, error));
}

TEST(LocalSourcePaths, PreservesExplicitRootsAndRejectsSimilarPrefixes) {
    Sources fixture;
    fs::path resolved; std::string error;
    EXPECT_TRUE(local::resolve((fixture.base / "legacy").string(), resolved, error));
    fs::create_directories(fixture.base / "legacy-not-shared");
    EXPECT_FALSE(local::resolve((fixture.base / "legacy-not-shared").string(), resolved, error));
    EXPECT_FALSE(local::resolve("E:/Unknown", resolved, error));
}

TEST(LocalSourcePaths, MapsLinuxHostPathsWithoutChangingSavedContainerPaths) {
    Sources fixture;
    Json::Value mappings(Json::arrayValue), root;
    root["path"] = (fixture.base / "c").string(); root["host_path"] = "/";
    mappings.append(root);
    setenv("LOCAL_SOURCE_ROOT_MAPPINGS", mappings.toStyledString().c_str(), 1);
    fs::path resolved; std::string error;
    EXPECT_TRUE(local::resolve("/Users/Developer/My Project", resolved, error));
    EXPECT_EQ(local::hostPath(resolved), std::string("/Users/Developer/My Project"));
    EXPECT_TRUE(local::resolve(resolved.string(), resolved, error));
    EXPECT_TRUE(local::resolve((fixture.base / "legacy").string(), resolved, error));
}

TEST(LocalSourcePaths, InvalidMappingsFailClosedAndRejectMissingFolders) {
    Sources fixture;
    setenv("LOCAL_SOURCE_ROOT_MAPPINGS", "not-json", 1);
    fs::path resolved; std::string error;
    EXPECT_FALSE(local::resolve("C:/Users/Developer/My Project", resolved, error));
    EXPECT_TRUE(local::resolve((fixture.base / "legacy").string(), resolved, error));
    EXPECT_FALSE(local::resolve((fixture.base / "legacy/missing").string(), resolved, error));
    EXPECT_FALSE(local::resolve(std::string("/etc\0/ignored", 13), resolved, error));
}
