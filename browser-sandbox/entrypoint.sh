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

echo "[Entrypoint] Starting Chromium on DISPLAY=:99 (port 9223)..."
/usr/lib/chromium/chromium \
  --no-sandbox \
  --disable-dev-shm-usage \
  --test-type \
  --disable-infobars \
  --no-first-run \
  --no-default-browser-check \
  --disable-session-crashed-bubble \
  --disable-breakpad \
  --disable-features=Translate,OptimizationGuideModelDownloading \
  --password-store=basic \
  --use-mock-keychain \
  --kiosk \
  --remote-debugging-port=9223 \
  --remote-allow-origins=* \
  --window-size=1280,720 \
  --window-position=0,0 \
  --start-maximized \
  --disable-gpu \
  --disable-gpu-rasterization \
  --disable-software-rasterizer \
  --run-all-compositor-stages-before-draw \
  --enable-surface-synchronization \
  --disable-threaded-scrolling \
  --blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4 \
  --disable-background-timer-throttling \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
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

trap "kill -TERM $CHROME_PID $STREAMER_PID $XVFB_PID 2>/dev/null" SIGTERM SIGINT

wait $CHROME_PID
