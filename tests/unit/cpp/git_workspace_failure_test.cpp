#include "testing.h"
#include "../../../src/services/BuildService.h"
#include "../../../src/services/GitWorkspaceFailure.h"
#include <cstdlib>
#include <fstream>
#include <sys/stat.h>
#include <unistd.h>

using namespace stackpilot;

namespace {
struct GitFixture {
    std::filesystem::path root;
    std::string oldPath, oldWorkspace;
    bool hadWorkspace;
    GitFixture() {
        char pattern[] = "/tmp/stackpilot-git-retry-XXXXXX";
        root = mkdtemp(pattern);
        oldPath = std::getenv("PATH") ? std::getenv("PATH") : "";
        hadWorkspace = std::getenv("BUILD_WORKSPACE_DIR") != nullptr;
        if (hadWorkspace) oldWorkspace = std::getenv("BUILD_WORKSPACE_DIR");
        setenv("PATH", (root.string() + ":/usr/bin:/bin").c_str(), 1);
        setenv("BUILD_WORKSPACE_DIR", (root / "builds").c_str(), 1);
    }
    ~GitFixture() {
        setenv("PATH", oldPath.c_str(), 1);
        if (hadWorkspace) setenv("BUILD_WORKSPACE_DIR", oldWorkspace.c_str(), 1);
        else unsetenv("BUILD_WORKSPACE_DIR");
        std::filesystem::remove_all(root);
    }
    void git(bool persistent) {
        std::ofstream script(root / "git");
        script << "#!/bin/sh\nfor arg; do target=\"$arg\"; done\n"
               << "counter='" << (root / "count").string() << "'\n"
               << "n=0; [ ! -f \"$counter\" ] || n=$(cat \"$counter\"); n=$((n+1)); echo $n > \"$counter\"\n"
               << "if [ $n -gt 1 ] && [ -e \"$target\" ]; then echo 'incomplete checkout was not removed' >&2; exit 99; fi\n";
        if (!persistent) script << "if [ $n -gt 1 ]; then echo 'remote: repository not found' >&2; exit 128; fi\n";
        script << "mkdir -p \"$target/.git\"; echo partial > \"$target/.git/config\"\n"
               << "echo \"error: could not write config file $target/.git/config: Permission denied\" >&2\nexit 128\n";
        script.close();
        chmod((root / "git").c_str(), 0700);
    }
    int count() { int n = 0; std::ifstream(root / "count") >> n; return n; }
};
}

TEST(GitWorkspace, OnlyLocalMetadataPermissionErrorsAreRetryable) {
    EXPECT_TRUE(isRetryableGitWorkspaceFailure("error: could not write config file /work/source/.git/config: Permission denied"));
    EXPECT_TRUE(isRetryableGitWorkspaceFailure("fatal: unable to create /work/source/.git/config.lock: Device or resource busy"));
    EXPECT_FALSE(isRetryableGitWorkspaceFailure("git@github.com: Permission denied (publickey)."));
    EXPECT_FALSE(isRetryableGitWorkspaceFailure("remote: Invalid username or token"));
    EXPECT_FALSE(isRetryableGitWorkspaceFailure("fatal: repository not found"));
    EXPECT_TRUE(isRetryableGitCloneFailure("fatal: unable to access repo: Could not resolve host: github.com"));
    EXPECT_FALSE(isRetryableGitCloneFailure("fatal: SSL certificate problem: certificate verification failed"));
    EXPECT_FALSE(isRetryableGitCloneFailure("remote: Invalid username or token"));
}

TEST(GitWorkspace, FreshRetryRemovesIncompleteCheckoutAndClassifiesOnlyLatestFailure) {
    GitFixture fixture;
    fixture.git(false);
    const auto result = BuildService().buildFromRepository("checkout", "https://github.com/fixture/repo.git", "v1");
    EXPECT_FALSE(result.success);
    EXPECT_EQ(fixture.count(), 2);
    EXPECT_FALSE(result.retryableInfrastructureFailure);
    EXPECT_TRUE(result.logs.find("retrying once") != std::string::npos);
    EXPECT_TRUE(result.logs.find("incomplete checkout was not removed") == std::string::npos);
}

TEST(GitWorkspace, PersistentMetadataFailureRequestsBoundedWorkerRetry) {
    GitFixture fixture;
    fixture.git(true);
    const auto result = BuildService().buildFromRepository("checkout", "https://github.com/fixture/repo.git", "v1");
    EXPECT_EQ(fixture.count(), 2);
    EXPECT_TRUE(result.retryableInfrastructureFailure);
    EXPECT_TRUE(result.error.find("storage permissions or file locks") != std::string::npos);
}
