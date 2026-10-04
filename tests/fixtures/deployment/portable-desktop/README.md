# Real Linux desktop qualification

This Tk application proves the portable build recipe, required repository tests,
mapped-window readiness and noVNC pointer input. It is not a web reimplementation
of a desktop app. The recipe can use other Linux toolchains and application argv;
native Windows/macOS/mobile need their OS workers.

From the repository root:

```powershell
python deployment-runtime/planner.py tests/fixtures/deployment/portable-desktop --archetype desktop_portable
docker build -t stackpilot-portable-desktop:qualification tests/fixtures/deployment/portable-desktop
docker run --rm --memory 256m --cpus 1 --pids-limit 128 -p 127.0.0.1:53000:3000 stackpilot-portable-desktop:qualification
```

Open http://localhost:53000, click Increment, and observe the native counter.
Close the native application to verify the preview exits instead of serving an
empty desktop. Production requires authenticated preview routing and isolated
workers; the fixture is loopback-only.
