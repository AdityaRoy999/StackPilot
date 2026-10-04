# Dedicated host Chrome worker

From the StackPilot root on Windows:

```powershell
./native-browser/start.ps1
```

This creates a local Python environment, saves a random host-worker token in the
existing ignored `.env`, and runs the worker. Keep this process running. In a
second terminal, recreate the AI service once to load the new configuration:

```powershell
docker compose up -d --no-deps ai-service
```

Choose **Host Chrome** in Agent Settings. The choice applies to the current chat
as soon as its new worker connects, keeping the current URL. Failed connections
keep the previous worker. Browser cookies/form state are isolated per worker.
Add `-ShowWindow` to the setup command
if you want to see the dedicated Chrome window. The default is native headless
Chrome; it never attaches to a personal browser profile.

Chrome keeps its sandbox and normal graphics selection. This removes the default
Docker browser's forced SwiftShader path, but does not guarantee GPU acceleration
on a particular driver/machine. The worker stores its own profile under
`~/.stackpilot/browser/stackpilot-chrome-profile` and refuses an already occupied
debugging port. CDP binds to `127.0.0.1:9226`; the token-authenticated proxy is on
port 9225. The setup script binds the proxy on all interfaces so Docker can reach
it. Restrict that port to the local Docker/host environment. Tokens are never
sent to the frontend.

On other supported desktop environments, install `requirements.txt` in a virtual
environment, supply `HOST_BROWSER_TOKEN` (at least 32 characters), and run
`python host.py --bind <Docker-accessible-interface>`. Configure the same token
and `HOST_BROWSER_CDP_URL` for ai-service. macOS/native-host execution was not
qualified by this change.

Host mode captures the owned tab through CDP. Its WebRTC path decodes JPEGs and
encodes H.264 in the AI service; it does not yet provide a native hardware desktop
encoder. Docker mode can relay the existing H.264 without re-encoding. CPU
capacity and measured performance should determine which mode you select.

Host WebRTC uses a dedicated low-latency JPEG-to-H.264 worker in the AI service.
The default cap is 30 FPS at 2 Mbit/s, with two encoder threads and periodic
independent keyframes. Compose accepts `BROWSER_HOST_MEDIA_FPS` (5–60) and
`BROWSER_HOST_MEDIA_BITRATE` (128000–8000000) from the root environment; changing
them requires recreating ai-service. A 60 FPS cap does not prove 60 FPS capture or
visible presentation. See the measured interaction results in
[browser streaming validation](../docs/browser-streaming-validation.md).
