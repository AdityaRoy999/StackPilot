// ============================================================
// LocalDockerRuntime.h — shell commands for the local Docker runtime
// ============================================================
// Every function that builds a `docker ...` command line for the local
// execution mode. Extracted from DeploymentController's anonymous namespace,
// where none of it could be tested.
//
// That mattered more here than anywhere else in the controller: these
// functions interpolate user-controlled strings — container names, image
// references, environment values — into shell commands. A mistake is a command
// injection with the platform's own privileges, and the only thing standing in
// the way is quoting that was previously unreachable from a test.
//
// Builders do not execute commands. makeRunCommand also reads the configured
// runtime network. Only run(), removeContainer() and removeImage() execute.

#pragma once

#include "SshService.h"  // SshOperationResult

#include <string>
#include <utility>
#include <vector>

namespace stackpilot {

class LocalDockerRuntime {
public:
    // ─── pure helpers ───────────────────────────────────────────

    /// Reads `marker=value` out of command output, or "" when absent.
    static std::string markerValue(const std::string& output, const std::string& marker);

    /// Coerces an arbitrary string into a legal Docker container name:
    /// lowercase, `[a-z0-9_.-]`, no leading or trailing dash, max 96 chars.
    /// Never returns empty — falls back to "deployment".
    static std::string sanitizeContainerName(const std::string& raw);

    /// Candidate identities retain the full job UUID and attempt while fitting
    /// Docker DNS's 63-character label limit, regardless of project name.
    static std::string candidateContainerName(const std::string& jobId, int attempt);

    /// True for a POSIX-shaped environment variable name. Keys that fail this
    /// are dropped rather than escaped: a key is not a value, and there is no
    /// safe way to quote `FOO=bar; rm -rf /` as a variable name.
    static bool isValidRuntimeEnvKey(const std::string& key);

    /// Conservative allow-list for an image reference used in a cleanup
    /// command. Rejects anything outside `[A-Za-z0-9_.\-/:@]`.
    static bool isValidImageRef(const std::string& value);

    /// `docker run` for a built image, with the port either pinned or
    /// discovered from the image's exposed ports, followed by a readiness
    /// polling loop that verifies the container does not crash on startup
    /// and that the mapped port or container status is ready.
    static std::string makeRunCommand(const std::string& containerName,
                                      const std::string& imageName,
                                      int containerPort,
                                      const std::vector<std::pair<std::string, std::string>>& envVars,
                                      const std::string& protocol = "http",
                                      const std::string& healthPath = "/");

    /// `docker pause`/`unpause`, followed by an inspect so the caller can
    /// report the resulting state without a second round trip.
    static std::string makePauseCommand(const std::string& containerName, bool paused);

    /// Broker-owned observations of each declared Compose component. The
    /// identity-only mode does not repeat potentially stateful worker checks.
    static std::string makeComposeObservationCommand(const std::string& runtimeRoot,
                                                     const std::string& project,
                                                     const std::string& modelPath,
                                                     const std::string& planPath,
                                                     const std::string& outputPath,
                                                     bool identityOnly = true,
                                                     bool allowRestarts = false);

    /// Re-observe a saved local Compose graph without editing sealed source.
    /// Throws when metadata, contained paths, or current daemon evidence fail.
    static Json::Value freshComponentContract(const Json::Value& snapshot, bool executeChecks = true);

    // ─── execution ──────────────────────────────────────────────

    /// Runs a command through the shell, capturing stdout. Returns the exit
    /// status, or the raw wait status when the child did not exit normally.
    static int run(const std::string& command, std::string& output);

    static SshOperationResult removeContainer(const std::string& containerName,
                                              const std::string& imageName,
                                              bool removeImage);

    static SshOperationResult removeImage(const std::string& imageName);
};

}  // namespace stackpilot
