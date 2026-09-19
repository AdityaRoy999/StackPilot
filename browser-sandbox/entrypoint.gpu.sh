#!/bin/bash
set -e

export DISPLAY=:99
mkdir -p /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix

# Clean up stale locks and display sockets
rm -f /tmp/.X11-unix/X99 /tmp/.X99-lock 2>/dev/null || true
rm -rf /tmp/chromium-data/Singleton* 2>/dev/null || true
rm -rf /tmp/chromium-data/Default/Preferences* 2>/dev/null || true
rm -rf /tmp/chromium-data/Crash* 2>/dev/null || true

# GPU-accelerated Xvfb at 1080p for sharper rendering
STREAM_WIDTH=${STREAM_WIDTH:-1920}
STREAM_HEIGHT=${STREAM_HEIGHT:-1080}

echo "[Entrypoint-GPU] Starting Xvfb virtual display on :99 (${STREAM_WIDTH}x${STREAM_HEIGHT})..."
Xvfb :99 -screen 0 ${STREAM_WIDTH}x${STREAM_HEIGHT}x24 -nocursor -nolisten tcp +extension MIT-SHM &
XVFB_PID=$!

# Wait for Xvfb socket to appear
for i in $(seq 1 30); do
  if [ -e /tmp/.X11-unix/X99 ]; then
    echo "[Entrypoint-GPU] Xvfb is ready on display :99"
    break
  fi
  sleep 0.1
done

echo "[Entrypoint-GPU] Detecting GPU..."
if nvidia-smi > /dev/null 2>&1; then
  echo "[Entrypoint-GPU] NVIDIA GPU detected:"
  nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader
  USE_GPU=true
else
  echo "[Entrypoint-GPU] No NVIDIA GPU detected, falling back to software rendering"
  USE_GPU=false
fi

echo "[Entrypoint-GPU] Starting Chromium on DISPLAY=:99 (port 9223)..."
if [ "$USE_GPU" = "true" ]; then
  # GPU-accelerated Chromium with EGL
  chromium-browser \
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
    --window-size=${STREAM_WIDTH},${STREAM_HEIGHT} \
    --window-position=0,0 \
    --start-maximized \
    --ignore-gpu-blocklist \
    --enable-webgl \
    --enable-webgl2 \
    --use-gl=egl \
    --enable-gpu-rasterization \
    --enable-zero-copy \
    --num-raster-threads=4 \
    --enable-features=UseSkiaRenderer,CanvasOopRasterization,VaapiVideoDecodeLinuxGL \
    --disable-background-timer-throttling \
    --disable-backgrounding-occluded-windows \
    --disable-renderer-backgrounding \
    --disable-ipc-flooding-protection \
    --force-color-profile=srgb \
    --enable-font-antialiasing \
    --font-render-hinting=medium \
    --user-data-dir=/tmp/chromium-data \
    "about:blank" &
else
  # Fallback: Software rendering (same as CPU Dockerfile)
  chromium-browser \
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
    --window-size=${STREAM_WIDTH},${STREAM_HEIGHT} \
    --window-position=0,0 \
    --start-maximized \
    --ignore-gpu-blocklist \
    --enable-webgl \
    --enable-webgl2 \
    --use-gl=swiftshader \
    --num-raster-threads=4 \
    --disable-background-timer-throttling \
    --disable-backgrounding-occluded-windows \
    --disable-renderer-backgrounding \
    --disable-ipc-flooding-protection \
    --force-color-profile=srgb \
    --enable-font-antialiasing \
    --font-render-hinting=medium \
    --user-data-dir=/tmp/chromium-data \
    "about:blank" &
fi
CHROME_PID=$!

echo "[Entrypoint-GPU] Starting High-FPS Video Streamer on TCP 8099..."
python3 /usr/local/bin/streamer.py &
STREAMER_PID=$!

trap "kill -TERM $CHROME_PID $STREAMER_PID $XVFB_PID 2>/dev/null" SIGTERM SIGINT

wait $CHROME_PID
