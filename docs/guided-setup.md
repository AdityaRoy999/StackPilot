# Guided local setup

On the StackPilot website, choose Windows, macOS, or Linux and download the setup ZIP. Extract the whole ZIP before running its launcher:

- Windows: double-click **Start StackPilot.cmd**.
- macOS: open **Start StackPilot.command**. If your extraction tool removes executable permissions, run `chmod +x "Start StackPilot.command"` in that directory. macOS may ask you to approve opening a downloaded script.
- Linux: run `bash "Start StackPilot.sh"` in the extracted directory.

These are transparent source launchers, not signed native installers. Python 3.10+ must be installed to open the local wizard. Windows Python installation should include **Add Python to PATH**. The launcher explains a missing Python installation; it does not silently install system software.

The wizard opens on a random loopback port with a private session token. Keep its terminal open until setup completes. It checks Python, Git, Docker, a running Docker daemon, and Compose v2, and links missing tools to their official installation instructions. Install those tools, start Docker Desktop or Docker Engine, and press **Check prerequisites** again. Docker Desktop may require virtualization to be enabled, administrator approval, or a restart. Linux Docker users need access to the Docker daemon. First builds require several GB of free storage and an internet connection.

Choose a service profile and press **Install / start StackPilot**. The wizard reuses the checkout remembered by the CLI, or clones the official repository into `~/stackpilot` for a new installation. It installs the CLI in that checkout's private virtual environment, generates independent secrets locally, starts containers, and waits for both the backend and dashboard to pass health checks. It never replaces an existing `.env` or deletes application volumes. If an existing StackPilot database is detected without its original configuration, setup stops and asks you to reopen the original checkout. It does not need cloud, GitHub OAuth, SSH, or AI credentials to start the deployment platform. First builds can take several minutes; subsequent starts use cached images.

Once ready, open the dashboard, create an account, and sign in. The first-launch guide lets you save an encrypted AI provider connection, enter a model identifier, and **Test AI connection**. This sends one small real completion request to the selected provider and may incur its normal API charge. It does not execute agent tools. A catalog fallback is not treated as a successful connection. You can skip AI and configure it later using **Setup guide** in the sidebar.

## Reopen setup and update

Run the downloaded launcher again, or run `stackpilot setup` from an installed checkout. `stackpilot setup --no-browser` prints its loopback link for opening manually. Windows checkouts can also use `./stackpilot.ps1 setup`; Linux/macOS can use `.stackpilot-venv/bin/stackpilot setup`.

Press **Check updates** to fetch the official main branch without changing your checkout. Press **Update installation** to apply an available update. Terminal equivalents are `stackpilot update --check` and `stackpilot update`.

Updates require the official Git origin, a clean main branch, and no local commits. They stop rather than overwrite local changes. Before applying a fast-forward update, StackPilot backs up `.env`, the current revision, and PostgreSQL to `.stackpilot-backups/<timestamp>/`. PostgreSQL must be running and the backup must succeed. It then reinstalls the CLI, rebuilds the existing service profile, and waits for health checks. It never runs `down --volumes`, resets Git, or silently attempts to reverse a database migration. Treat backups as private; restrict access on shared computers. A backup is retained if a later build or health check fails. Investigate the failed step before retrying; database recovery is an explicit administrator operation.

The setup UI keeps operation status in its launcher process. Keep that process running during installs or updates; reopening it will check the current installation again. If an update applies the revision but a later build fails, correct the reported problem and use **Install / start StackPilot** to rebuild that revision. Updates may briefly interrupt service while containers are recreated. This local workflow does not manage public HTTPS server deployments; use the [server setup guide](production-self-host.md) and your server maintenance procedure instead.

Installer diagnostics are saved to `~/.stackpilot/setup.log`. Update build and CLI installation logs stay with that update's recovery backup. These files are private and are not served by the setup web interface. Check them for a build error if startup fails; keep secrets out of shared logs.

Official prerequisite instructions: [Python](https://www.python.org/downloads/), [Git](https://git-scm.com/downloads), [Docker](https://docs.docker.com/get-started/get-docker/).
