#!/bin/bash
set -e

export DISPLAY=:99
mkdir -p /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix

# Clean up stale locks and display sockets BEFORE starting Xvfb
rm -f /tmp/.X11-unix/X99 /tmp/.X99-lock 2>/dev/null || true
rm -rf /tmp/chromium-data/Singleton* 2>/dev/null || true
rm -rf /tmp/chromium-data/Default/Preferences* 2>/dev/null || true
rm -rf /tmp/chromium-data/Crash* 2>/dev/null || true
rm -rf /etc/chromium.d 2>/dev/null || true

echo "[Entrypoint] Starting Xvfb virtual display on :99..."
Xvfb :99 -screen 0 1280x720x24 -nocursor -nolisten tcp +extension MIT-SHM &
XVFB_PID=$!

# Wait for Xvfb socket to appear
for i in $(seq 1 30); do
  if [ -e /tmp/.X11-unix/X99 ]; then
    echo "[Entrypoint] Xvfb is ready on display :99"
    break
  fi
  sleep 0.1
done

# CDP Page.bringToFront uses the window manager's activation protocol.
# Without one, isolated Chromium windows can stay behind a different website
# while x11grab continues broadcasting that unrelated window.
echo "[Entrypoint] Starting window manager for reliable browser activation..."
openbox --sm-disable &
WM_PID=$!
sleep 0.3

echo "[Entrypoint] Starting Chromium on DISPLAY=:99 (port 9223)..."
PREVIEW_GATEWAY_IP=$(getent ahostsv4 host.docker.internal | awk 'NR==1 {print $1}')
# Keep page rasterization on CPU when no graphics device is exposed. Running
# the entire GPU compositor through SwiftShader competes with video encoding;
# swiftshader-webgl preserves WebGL while avoiding that extra page-render cost.
RENDER_ARGS=(--enable-unsafe-swiftshader --use-gl=angle --use-angle=swiftshader-webgl --disable-gpu-rasterization --disable-accelerated-2d-canvas --disable-features=Translate,OptimizationGuideModelDownloading,CanvasOopRasterization)
if [ "${BROWSER_RENDERER:-auto}" != "software" ] && { [ -d /dev/dri ] || [ -e /dev/nvidia0 ]; }; then
  RENDER_ARGS=(--use-gl=angle --use-angle=gl-egl --enable-features=CanvasOopRasterization --enable-gpu-rasterization --enable-zero-copy --disable-features=Translate,OptimizationGuideModelDownloading)
  echo "[Entrypoint] Host graphics device exposed; requesting hardware rendering"
else
  echo "[Entrypoint] Using CPU page rendering with SwiftShader WebGL fallback"
fi
/usr/lib/chromium/chromium \
  "${RENDER_ARGS[@]}" \
  --host-resolver-rules="MAP *.preview.localhost ${PREVIEW_GATEWAY_IP:-127.0.0.1}" \
  --no-sandbox \
  --test-type \
  --disable-infobars \
  --no-first-run \
  --no-default-browser-check \
  --disable-session-crashed-bubble \
  --disable-breakpad \
  --password-store=basic \
  --use-mock-keychain \
  --kiosk \
  --remote-debugging-port=9223 \
  --remote-allow-origins=* \
  --window-size=1280,720 \
  --window-position=0,0 \
  --start-maximized \
  --ignore-gpu-blocklist \
  --enable-webgl \
  --disable-gpu-watchdog \
  --enable-threaded-compositing \
  --blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4 \
  --disable-ipc-flooding-protection \
  --force-color-profile=srgb \
  --enable-font-antialiasing \
  --font-render-hinting=medium \
  --user-data-dir=/tmp/chromium-data \
  "about:blank" &
CHROME_PID=$!

echo "[Entrypoint] Starting High-FPS Video Streamer on TCP 8099..."
python3 /usr/local/bin/streamer.py &
STREAMER_PID=$!

trap "kill -TERM $CHROME_PID $STREAMER_PID $WM_PID $XVFB_PID 2>/dev/null" SIGTERM SIGINT

wait $CHROME_PID
