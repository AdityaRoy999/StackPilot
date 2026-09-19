/**
 * StackPilot High-Performance Browser Stream Worker
 * Runs dedicated 60 FPS hardware decoding and OffscreenCanvas rendering,
 * isolating video frame blitting from main-thread React UI reconciliation.
 */

// Worker context definitions
const ctx: Worker = self as any;

let canvas: OffscreenCanvas | null = null;
let bitmapCtx: ImageBitmapRenderingContext | null = null;
let ctx2d: OffscreenCanvasRenderingContext2D | null = null;

let nextBitmap: ImageBitmap | null = null;
let lastRenderedSeq = 0;
let lastReceivedSeq = 0;

let frameCount = 0;
let netFrameCount = 0;
let lastFpsCalc = performance.now();
let isPaused = false;
let animId: number | null = null;
let lastRecordTs = 0;
let lastLatencyPostTs = 0;

let canvasWidth = 1280;
let canvasHeight = 720;

// Hardware Accelerated Render Loop
function renderLoop(now: number) {
  if (canvas && !isPaused) {
    if (nextBitmap) {
      const bmp = nextBitmap;
      nextBitmap = null;

      if (bitmapCtx && typeof bitmapCtx.transferFromImageBitmap === "function") {
        bitmapCtx.transferFromImageBitmap(bmp);
      } else if (ctx2d) {
        ctx2d.drawImage(bmp, 0, 0, canvasWidth, canvasHeight);
        bmp.close();
      } else {
        bmp.close();
      }
      frameCount += 1;
    }
  }
  animId = requestAnimationFrame(renderLoop);
}

// Telemetry Reporting to Main Thread (every 1000ms)
setInterval(() => {
  const now = performance.now();
  const deltaSec = (now - lastFpsCalc) / 1000;
  if (deltaSec >= 0.8) {
    const measuredFps = Math.round(frameCount / deltaSec);
    const measuredNetFps = Math.round(netFrameCount / deltaSec);
    frameCount = 0;
    netFrameCount = 0;
    lastFpsCalc = now;

    ctx.postMessage({
      type: "stats",
      fps: measuredFps,
      netFps: measuredNetFps,
    });
  }
}, 1000);

let videoDecoder: any = null;
let isKeyframeExpected = true;
let lastChunkTs = 0;

function getOrCreateVideoDecoder() {
  if (typeof (self as any).VideoDecoder === "undefined") return null;
  if (!videoDecoder || videoDecoder.state === "closed") {
    try {
      videoDecoder = new (self as any).VideoDecoder({
        output: (frame: any) => {
          if (canvas && !isPaused) {
            if (ctx2d) {
              ctx2d.drawImage(frame, 0, 0, canvasWidth, canvasHeight);
            }
            frameCount += 1;
            frame.close();
          } else if (!isPaused) {
            try {
              // Direct zero-copy transfer of hardware VideoFrame to main thread
              ctx.postMessage({ type: "video_frame", frame }, [frame]);
              frameCount += 1;
            } catch {
              frame.close();
            }
          } else {
            frame.close();
          }
        },
        error: (err: any) => {
          console.warn("[BrowserStreamWorker] VideoDecoder notice:", err);
          isKeyframeExpected = true;
          try {
            if (videoDecoder?.state !== "closed") {
              videoDecoder?.close();
            }
          } catch {}
          videoDecoder = null;
        },
      });
      videoDecoder.configure({
        codec: "avc1.42001f", // Canonical Baseline Level 3.1 profile
        optimizeForLatency: true,
      });
    } catch (e) {
      console.warn("[BrowserStreamWorker] VideoDecoder configuration error:", e);
      videoDecoder = null;
    }
  }
  return videoDecoder;
}

// Binary Frame Processor
async function processBinaryFrame(buffer: ArrayBuffer) {
  if (isPaused || buffer.byteLength < 16) return;

  const view = new DataView(buffer);
  let seq = 0;
  let serverTs = 0;
  let payloadOffset = 0;
  let metadata: Record<string, any> = {};

  if (view.getUint8(0) === 0x53 && view.getUint8(1) === 0x50) {
    // Magic 'SP'
    seq = view.getUint32(2);
    serverTs = Number(view.getBigUint64(6));
    const metaLen = view.getUint16(14);
    payloadOffset = 16 + metaLen;

    if (metaLen > 2) {
      try {
        const metaBytes = new Uint8Array(buffer, 16, metaLen);
        const metaStr = new TextDecoder().decode(metaBytes);
        metadata = JSON.parse(metaStr);
      } catch {}
    }

    const now = Date.now();
    if (serverTs > 0 && now >= serverTs && now - lastLatencyPostTs >= 800) {
      lastLatencyPostTs = now;
      ctx.postMessage({ type: "latency", latencyMs: now - serverTs });
    }

    if (seq > 0 && seq < lastReceivedSeq) {
      // Sequence reset by server
      lastReceivedSeq = seq;
      lastRenderedSeq = 0;
      lastChunkTs = 0;
      isKeyframeExpected = true;
    } else if (seq > 0) {
      lastReceivedSeq = seq;
    }

    // Heartbeat packet (zero payload)
    if (payloadOffset >= buffer.byteLength) {
      netFrameCount += 1;
      return;
    }
  }

  netFrameCount += 1;
  const capturedSeq = seq;

  // 1. WebCodecs VideoDecoder Fast-Path (for raw H.264 NALUs)
  if (metadata.codec === "h264" || metadata.codec === "avc1") {
    if (isKeyframeExpected && !metadata.isKeyFrame) {
      return; // Drop delta frames until first IDR / Keyframe arrives
    }
    isKeyframeExpected = false;

    const decoder = getOrCreateVideoDecoder();
    if (decoder && typeof (self as any).EncodedVideoChunk !== "undefined") {
      try {
        // Calculate strictly monotonic, perfectly spaced microsecond presentation timestamp
        // Each sequential packet sequence corresponds to 16,666 microseconds (60 FPS)
        let chunkTs = capturedSeq > 0 ? capturedSeq * 16666 : Math.round(performance.now() * 1000);
        if (chunkTs <= lastChunkTs) {
          chunkTs = lastChunkTs + 16666;
        }
        lastChunkTs = chunkTs;

        const chunk = new (self as any).EncodedVideoChunk({
          type: metadata.isKeyFrame ? "key" : "delta",
          timestamp: chunkTs,
          data: new Uint8Array(buffer, payloadOffset),
        });
        decoder.decode(chunk);
        return;
      } catch (e) {
        console.warn("[BrowserStreamWorker] decode chunk error:", e);
        isKeyframeExpected = true;
      }
    }
    return; // Don't fall through to JPEG decoding for H.264 packets
  }

  // 2. Hardware-Accelerated ImageBitmap Pipeline (for JPEG packets)
  try {
    const blob = new Blob([new Uint8Array(buffer, payloadOffset)], { type: "image/jpeg" });
    const bitmap = await createImageBitmap(blob, {
      premultiplyAlpha: "none",
      colorSpaceConversion: "none",
    });

    // Sequence ordering: discard stale frames if newer already rendered
    if (capturedSeq > 0 && capturedSeq < lastRenderedSeq) {
      bitmap.close();
      return;
    }

    if (capturedSeq > 0) {
      lastRenderedSeq = capturedSeq;
    }

    const now = Date.now();
    if (now - lastRecordTs >= 1000) {
      lastRecordTs = now;
      ctx.postMessage({
        type: "record_blob",
        blob,
        seq: capturedSeq,
        ts: now,
      });
    }

    if (canvas && !isPaused) {
      if (nextBitmap) {
        nextBitmap.close();
      }
      nextBitmap = bitmap;
    } else if (!isPaused) {
      // Transfer hardware-decoded ImageBitmap to main thread with zero-copy
      ctx.postMessage(
        {
          type: "bitmap",
          bitmap,
          seq: capturedSeq,
        },
        [bitmap]
      );
      frameCount += 1;
    } else {
      bitmap.close();
    }
  } catch (err) {
    // Ignore transient frame decode drops
  }
}

// Worker Message Router
ctx.onmessage = (e: MessageEvent) => {
  const data = e.data;
  if (!data) return;

  switch (data.type) {
    case "init": {
      canvas = data.canvas as OffscreenCanvas;
      canvasWidth = data.width || 1280;
      canvasHeight = data.height || 720;
      canvas.width = canvasWidth;
      canvas.height = canvasHeight;

      try {
        bitmapCtx = canvas.getContext("bitmaprenderer", { alpha: false }) as ImageBitmapRenderingContext;
      } catch {
        bitmapCtx = null;
      }

      if (!bitmapCtx) {
        ctx2d = canvas.getContext("2d", {
          alpha: false,
          desynchronized: true,
        }) as OffscreenCanvasRenderingContext2D;
      }

      if (!animId) {
        lastFpsCalc = performance.now();
        animId = requestAnimationFrame(renderLoop);
      }
      break;
    }

    case "resize": {
      if (canvas) {
        canvasWidth = data.width || canvasWidth;
        canvasHeight = data.height || canvasHeight;
        canvas.width = canvasWidth;
        canvas.height = canvasHeight;
      }
      break;
    }

    case "frame": {
      if (data.buffer instanceof ArrayBuffer) {
        processBinaryFrame(data.buffer);
      }
      break;
    }

    case "pause": {
      isPaused = Boolean(data.paused);
      if (isPaused && nextBitmap) {
        nextBitmap.close();
        nextBitmap = null;
      }
      break;
    }

    case "playback_blob": {
      if (data.blob instanceof Blob) {
        createImageBitmap(data.blob, {
          premultiplyAlpha: "none",
          colorSpaceConversion: "none",
        })
          .then((bitmap) => {
            if (bitmapCtx && typeof bitmapCtx.transferFromImageBitmap === "function") {
              bitmapCtx.transferFromImageBitmap(bitmap);
            } else if (ctx2d) {
              ctx2d.drawImage(bitmap, 0, 0, canvasWidth, canvasHeight);
              bitmap.close();
            } else {
              bitmap.close();
            }
          })
          .catch(() => {});
      }
      break;
    }

    case "destroy": {
      if (animId) {
        cancelAnimationFrame(animId);
        animId = null;
      }
      if (nextBitmap) {
        nextBitmap.close();
        nextBitmap = null;
      }
      canvas = null;
      bitmapCtx = null;
      ctx2d = null;
      break;
    }
  }
};

export {};
