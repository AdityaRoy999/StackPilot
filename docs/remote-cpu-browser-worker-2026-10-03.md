# Remote CPU browser worker

The saved `browser-sandbox` SSH connection was configured on 3 October 2026.
The live host is Ubuntu 26.04 x86_64 with two CPUs, about 8 GiB RAM and a 48 GiB
root filesystem. Docker Engine and the Compose plugin were installed from
[Docker's official Ubuntu repository](https://docs.docker.com/engine/install/ubuntu/).
No NVIDIA driver or Deep Learning AMI is required for this CPU worker.

## Installed components

The worker source and `docker-compose.cpu.yml` are installed at
`/home/ubuntu/stackpilot-browser-worker`. The remote `stackpilot-remote-browser`
container runs Chromium, Xvfb, Openbox and the demand-aware FFmpeg H.264 streamer.
The initial profile requested 1280×720 at 30 FPS, capped activity at 30 FPS and dropped
hidden viewers to 8 FPS. The encoder is software `libx264`. Actual throughput
depends on the page, CPU and network; the configured rate is not a measurement.
The worker was subsequently raised to a 60 FPS target on the user's request;
the producer qualification and current profile are recorded below.

The container has a 4 GiB memory limit, two-CPU limit, 2 GiB shared memory, a PID
limit, rotated logs, a CDP healthcheck and automatic restart. No host Docker
socket, GPU device or private administrator key is mounted into it. CDP 9222 and
H.264 TCP 8099 are published only on the server's `127.0.0.1` interface.

The local `stackpilot-remote-browser-tunnel` container forwards those ports over
SSH onto StackPilot's private Docker network. It runs as UID 10001 with a read-only
filesystem, no capabilities and a read-only key volume. It publishes no host
ports. SSH verifies the host keys already pinned in the saved connection and
exits if its keepalive or forwarding checks fail; Docker restarts it.

A separate Ed25519 private key lives only in Docker volume
`stackpilot_remote_browser_ssh` with mode 0600. The public key was added to
Ubuntu's existing `authorized_keys` without replacing the administrator entry.
Its `restrict`, `permitopen`, `permitlisten` and forced `/bin/false` options
limit forwarding destinations and listeners to `127.0.0.1:9222` and
`127.0.0.1:8099`. Tests confirmed that command execution, forwarding to SSH port
22 and opening a remote listener on port 8098 are denied. Do not commit or print the
private volume contents. Removing that volume requires regenerating the tunnel
key and updating its public-key entry on the server.

## StackPilot configuration and use

The ignored root `.env` contains the saved SSH host, user and port, plus:

```dotenv
REMOTE_BROWSER_SANDBOX_URL=http://remote-browser-tunnel:9222
REMOTE_BROWSER_STREAM_HOST=remote-browser-tunnel
REMOTE_BROWSER_STREAM_PORT=8099
```

The AI service was recreated after its diagnostics confirmed zero active runs,
tools, sessions and viewers. The local browser endpoints remain available.
The saved server's capability probe now reports Docker CLI, daemon and Compose
ready.

In **AI Agent → settings (gear) → Browser sandbox**, select **Remote**, then open
a **New Chat** and set a public website URL. Existing chats keep their assigned
browser. Public sites load from the EC2 server. URLs bound only to the Windows
PC, including `localhost` development ports and private preview hostnames, need
an additional reverse tunnel or reachable deployment; use Local for those URLs.

The browser renders and encodes on the remote CPU host. The AI service relays
encoded H.264 to the authorized local WebRTC viewer without re-encoding; browser
control stays on the authenticated session WebSocket. No public EC2 browser or
WebRTC ports were opened during setup.

## Operations

Run from the local repository to restore the tunnel after it was stopped:

```powershell
docker compose --profile remote-browser up -d --no-deps remote-browser-tunnel
docker inspect stackpilot-remote-browser-tunnel --format '{{.State.Health.Status}}'
```

After changing the remote endpoint variables:

```powershell
docker compose --profile ai up -d --no-deps ai-service
```

Run over the saved administrator SSH connection to inspect or restart the worker:

```sh
cd /home/ubuntu/stackpilot-browser-worker
sudo docker compose -f docker-compose.cpu.yml ps
sudo docker compose -f docker-compose.cpu.yml logs --tail=40
sudo docker compose -f docker-compose.cpu.yml up -d
```

Docker starts automatically after a server reboot. A changed EC2 address must be
updated in the saved connection and `REMOTE_BROWSER_SSH_HOST`; verify and pin
its host key before restarting the tunnel. No instance, security group or AWS
resource was created or deleted by this setup.

## Verification

The live SSH connection, remote Docker installation, both container healthchecks,
owner-isolated CDP navigation to `https://example.com`, tunnel restrictions and
loopback port bindings passed. Direct connections from this PC to the server's
public ports 9222 and 8099 failed as expected. The tunnel reconnected successfully
after a deliberate container restart with the final key restrictions.

The real `InteractiveBrowserCanvas` smoke test passed remote navigation and
title synchronization, all eight clicks without duplicates, reconnect without
rewinding the page, and JPEG recovery after a deliberately failing decoder.
It made no AI-provider calls and disposed its owned source context afterward.
Raw observations are in
[`remote-browser-stream-first-2026-10-03.json`](remote-browser-stream-first-2026-10-03.json).

| Sample | Presented FPS | 95th-percentile frame gap | Maximum frame gap |
| --- | ---: | ---: | ---: |
| Initial WebRTC animation | 21.42 | 100 ms | 217 ms |
| WebRTC after reconnect | 11.39 | 250 ms | 1,033 ms |
| Deliberate JPEG fallback | 11.17 | 302 ms | 337 ms |

These are software headless Chromium viewer measurements inside the local
Docker environment. The first remote source sample reached approximately
26–30 FPS; reconnect sampling later showed approximately 15–16 FPS after
adaptive capture reduced the rate. Receiver packet loss was zero. The measured
viewer click-to-visible median was 744 ms and the 95th percentile was 2,344 ms.
The source-to-visible subtraction in the original raw artifact uses clocks on
two machines and is not valid latency evidence; use its single-viewer-clock
samples instead. The harness now excludes that subtraction in remote mode.

Functional streaming passed. Sustained 720p30, 60 FPS and hardware-accelerated
Windows browser performance are **not qualified** by this run. This setup
offloads browser rendering and encoding, but the two-CPU server and the local
software viewer do not establish a smoothness improvement over the prior local
results. Additional profiling should separate local development compilation,
viewer presentation, network variability and adaptive source capture.

## 60 FPS producer trial

The remote worker's `.env` now sets `STREAM_FPS=60`, `STREAM_MAX_FPS=60` and
`STREAM_IDLE_FPS=8`. Its container was recreated with those values. The original
two-CPU and memory limits, software encoder, private ports and adaptive overload
fallback remain in force. `browser-sandbox/cpu-60.env.example` records this
opt-in profile; the general CPU Compose defaults still use 30 FPS.

An owned full-screen page changed color and its frame counter on every animation
frame. A producer probe counted encoded frame arrivals over the actual SSH path
and decoded a sample to check that its contents changed. It did not send invented
viewer-performance feedback or call a model provider.

| Remote profile | Sampling window | Encoded arrivals | Arrivals per second | Decoded sample changes |
| --- | ---: | ---: | ---: | ---: |
| 720p30 | 15.05 s | 452 | 30.04 | 179 of 179 transitions |
| 720p60 | 25.07 s | 1,506 | 60.06 | 178 of 179 transitions |

The 60 FPS trial's page animation counter advanced at 60.34 FPS. One resource
sample showed the remote container using about 127% CPU across its two available
CPUs and 334 MiB RAM. Raw producer observations are in
[`remote-browser-capture-30-2026-10-03.json`](remote-browser-capture-30-2026-10-03.json)
and [`remote-browser-capture-60-2026-10-03.json`](remote-browser-capture-60-2026-10-03.json).

The producer sustained the 60 FPS target on this controlled page. That does not
qualify a frontend viewer at 60 FPS or every website at this rate. The remote
arrival gaps still had a 46.69 ms 95th percentile and a 250.16 ms maximum, so
producer throughput alone does not establish consistently smooth presentation.
The adaptive policy can reduce capture to 15 FPS for an overloaded encoder or
slow viewer, and to 8 FPS for hidden viewers.

A new full-viewer measurement could not complete while the local development
frontend rebuilt its pages. The temporary fixture and signed capability were
removed. Its generated Next.js cache was rebuilt after manifest parse errors;
the dashboard and health endpoint subsequently returned HTTP 200. No new 60 FPS
frontend presentation measurement is claimed. The earlier viewer table is still
the latest completed full-component result, and was measured with the 30 FPS
producer profile.
