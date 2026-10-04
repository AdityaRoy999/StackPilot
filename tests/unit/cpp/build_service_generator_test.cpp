#include "testing.h"
#include "../../../src/services/BuildService.h"
#include <fstream>
#include <unistd.h>

using namespace stackpilot;
namespace {
struct SourceFixture {
    std::filesystem::path root;
    SourceFixture() {
        char pattern[] = "/tmp/stackpilot-generator-XXXXXX";
        root = mkdtemp(pattern);
    }
    ~SourceFixture() { std::filesystem::remove_all(root); }
    void write(const std::string& path, const std::string& value) { std::ofstream(root / path) << value; }
    std::string generated() {
        std::string reason;
        EXPECT_TRUE(BuildService().ensureDockerfile(root, root / "build.log", reason, nullptr));
        std::ifstream in(root / "Dockerfile");
        return std::string(std::istreambuf_iterator<char>(in), {});
    }
};
}

TEST(BuildGenerator, ViteIndexDoesNotOverridePackageManifest) {
    SourceFixture fixture;
    fixture.write("index.html", "<div id='root'></div><script type='module' src='/src/main.tsx'></script>");
    fixture.write("package.json", R"({"scripts":{"build":"vite build"},"devDependencies":{"vite":"6.0.0"}})");
    fixture.write("package-lock.json", "{}");
    const auto dockerfile = fixture.generated();
    EXPECT_TRUE(dockerfile.find("node .stackpilot-runtime/node_tasks.cjs build") != std::string::npos);
    EXPECT_TRUE(dockerfile.find("repository_tests.py") != std::string::npos);
    EXPECT_TRUE(dockerfile.find("RUN node .stackpilot-runtime/node_tasks.cjs install\n") != std::string::npos);
    EXPECT_TRUE(dockerfile.find("COPY --from=builder /stackpilot-output/") != std::string::npos);
    EXPECT_TRUE(dockerfile.find("COPY . /usr/share/nginx/html/") == std::string::npos);
}

TEST(BuildGenerator, PlainHtmlRemainsStatic) {
    SourceFixture fixture;
    fixture.write("index.html", "<h1>Hello</h1>");
    EXPECT_TRUE(fixture.generated().find("COPY . /usr/share/nginx/html/") != std::string::npos);
}

TEST(BuildGenerator, RepositoryDockerfileIsPreservedExactly) {
    SourceFixture fixture;
    const std::string original = "FROM example/custom:1\nCMD [\"serve\"]\n";
    fixture.write("Dockerfile", original);
    fixture.write("package.json", "{}");
    EXPECT_EQ(fixture.generated(), original);
}
