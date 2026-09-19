"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  Bot,
  CheckCircle2,
  ChevronDown,
  Copy,
  Eye,
  EyeOff,
  Film,
  Globe,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  SkipBack,
  SkipForward,
  Terminal,
  User,
  X,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export interface InteractiveElement {
  id: number;
  tag: string;
  role: string;
  type?: string;
  text: string;
  disabled?: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ConsoleLogItem {
  type: "log" | "warn" | "error" | "info";
  text: string;
  timestamp: number;
}

export interface RecordedFrame {
  id: number;
  blob: Blob;
  cursor: {
    x: number;
    y: number;
    visible: boolean;
    action?: string;
  };
  ripples: Array<{ id: number; x: number; y: number; type?: string }>;
  url: string;
  pageTitle: string;
  timestamp: number;
}

function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(s / 60);
  const secs = Math.floor(s % 60);
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

interface InteractiveBrowserCanvasProps {
  sessionId?: string;
  initialUrl?: string;
  isOpen: boolean;
  onClose?: () => void;
  className?: string;
  embedded?: boolean;
  onUrlChange?: (url: string) => void;
}

export function InteractiveBrowserCanvas({
  sessionId = "default",
  initialUrl = "http://localhost:3000",
  isOpen,
  onClose,
  className,
  embedded = false,
  onUrlChange,
}: InteractiveBrowserCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctx2dRef = useRef<CanvasRenderingContext2D | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const [connected, setConnected] = useState(false);
  const [currentUrl, setCurrentUrl] = useState(initialUrl);
  const [urlInput, setUrlInput] = useState(initialUrl);
  const prevInitialUrlRef = useRef(initialUrl);
  const [pageTitle, setPageTitle] = useState("");
  const [elements, setElements] = useState<InteractiveElement[]>([]);
  const [showElementTags, setShowElementTags] = useState(false);
  const [takeOver, setTakeOver] = useState(false);

  // AI Cursor state
  const [cursorPos, setCursorPos] = useState({ x: 640, y: 360 });
  const [cursorVisible, setCursorVisible] = useState(false);
  const [cursorAction, setCursorAction] = useState<string>("");
  const [clickRipples, setClickRipples] = useState<Array<{ id: number; x: number; y: number; type?: string }>>([]);

  // Synchronous tracking refs for frame recording
  const cursorPosRef = useRef({ x: 640, y: 360 });
  const cursorVisibleRef = useRef(false);
  const cursorActionRef = useRef<string>("");
  const clickRipplesRef = useRef<Array<{ id: number; x: number; y: number; type?: string }>>([]);
  const currentUrlRef = useRef(initialUrl);
  const pageTitleRef = useRef("");

  // Playback & Session Recording State
  const recordedFramesRef = useRef<RecordedFrame[]>([]);
  const [hasRecording, setHasRecording] = useState(false);
  const [isPlaybackMode, setIsPlaybackMode] = useState(false);
  const isPlaybackModeRef = useRef(false);
  const [playbackIndex, setPlaybackIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1);
  const [showCompletionPrompt, setShowCompletionPrompt] = useState(false);
  const [recordedDurationSec, setRecordedDurationSec] = useState(0);
  const lastRecordedTimeRef = useRef(0);
  const playbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    isPlaybackModeRef.current = isPlaybackMode;
  }, [isPlaybackMode]);

  // Console drawer state with resizable height
  const [consoleLogs, setConsoleLogs] = useState<ConsoleLogItem[]>([]);
  const [showConsole, setShowConsole] = useState(false);
  const [consoleFilter, setConsoleFilter] = useState<"all" | "error">("all");
  const [consoleHeight, setConsoleHeight] = useState(180);
  const [isDraggingConsole, setIsDraggingConsole] = useState(false);
  const dragStartYRef = useRef(0);
  const dragStartHeightRef = useRef(180);

  // Performance telemetry, throttled mouse move & anti-flicker sequence tracking
  const [fps, setFps] = useState(0);
  const [networkFps, setNetworkFps] = useState(0);
  const [latencyMs, setLatencyMs] = useState(0);
  const frameCountRef = useRef(0);
  const netFrameCountRef = useRef(0);
  const nextBitmapRef = useRef<ImageBitmap | null>(null);
  const nextVideoFrameRef = useRef<VideoFrame | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const workerReadyRef = useRef<boolean>(false);
  const fallbackDecoderRef = useRef<any>(null);
  const keyframeExpectedRef = useRef<boolean>(true);
  const lastFallbackChunkTsRef = useRef<number>(0);
  const lastFpsCalcRef = useRef(Date.now());
  const lastMoveSentRef = useRef(0);
  const lastLatencyUpdateRef = useRef(0);
  const lastFrameSeqRef = useRef(0);
  const lastDrawnSeqRef = useRef(0);
  const lastFrameTimeRef = useRef(0);
  const scrollDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isRefreshingElements, setIsRefreshingElements] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);

  // Independent 1-second telemetry timer to ensure FPS is always displayed accurately
  useEffect(() => {
    if (!isOpen) return;
    const interval = setInterval(() => {
      const now = performance.now();
      const deltaSec = (now - lastFpsCalcRef.current) / 1000;
      if (deltaSec >= 0.8) {
        const renderFps = Math.round(frameCountRef.current / deltaSec);
        const netFps = Math.round(netFrameCountRef.current / deltaSec);
        if (connected) {
          setFps(renderFps);
          setNetworkFps(netFps);
        } else {
          setFps(0);
          setNetworkFps(0);
        }
        frameCountRef.current = 0;
        netFrameCountRef.current = 0;
        lastFpsCalcRef.current = now;
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [isOpen, connected]);

  // Sync with initialUrl prop changes (e.g. when user selects a project with runtime_url)
  useEffect(() => {
    if (initialUrl && initialUrl !== prevInitialUrlRef.current) {
      prevInitialUrlRef.current = initialUrl;
      setCurrentUrl(initialUrl);
      setUrlInput(initialUrl);
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({
            type: "user_navigate",
            url: initialUrl,
          })
        );
      }
    }
  }, [initialUrl]);

  // Console dragging listeners
  useEffect(() => {
    if (!isDraggingConsole) return;
    const onPointerMove = (e: PointerEvent) => {
      const delta = dragStartYRef.current - e.clientY;
      const newHeight = Math.max(90, Math.min(500, dragStartHeightRef.current + delta));
      setConsoleHeight(newHeight);
    };
    const onPointerUp = () => {
      setIsDraggingConsole(false);
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [isDraggingConsole]);

  const startDraggingConsole = (e: React.PointerEvent) => {
    e.preventDefault();
    setIsDraggingConsole(true);
    dragStartYRef.current = e.clientY;
    dragStartHeightRef.current = consoleHeight;
  };

  // Determine WebSocket URL
  const getWsUrl = useCallback(() => {
    if (process.env.NEXT_PUBLIC_AI_SERVICE_WS_URL) {
      return `${process.env.NEXT_PUBLIC_AI_SERVICE_WS_URL}/ws/browser/${sessionId}`;
    }
    if (typeof window === "undefined") return "ws://127.0.0.1:8010/ws/browser/" + sessionId;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    let host = window.location.hostname || "127.0.0.1";
    // Avoid IPv6 [::1] connection refusal on Windows when localhost is used
    if (host === "localhost") {
      host = "127.0.0.1";
    }
    return `${protocol}//${host}:8010/ws/browser/${sessionId}`;
  }, [sessionId]);

  // Connect to WebSocket with resilient reconnection and StrictMode safety
  useEffect(() => {
    if (!isOpen) return;

    let isDisposed = false;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let activeWs: WebSocket | null = null;
    let animId: number | null = null;

    // Record incoming frames into the playback buffer
    const recordFrame = (jpegBlob: Blob) => {
      // Do not mutate or shift playback buffer while user is inspecting replay
      if (isPlaybackModeRef.current) return;
      const now = Date.now();
      const recentAction = Boolean(cursorActionRef.current);
      if (now - lastRecordedTimeRef.current < 65 && !recentAction) {
        return;
      }
      lastRecordedTimeRef.current = now;

      const frame: RecordedFrame = {
        id: now,
        blob: jpegBlob,
        cursor: {
          x: cursorPosRef.current.x,
          y: cursorPosRef.current.y,
          visible: cursorVisibleRef.current,
          action: cursorActionRef.current,
        },
        ripples: [...clickRipplesRef.current],
        url: currentUrlRef.current,
        pageTitle: pageTitleRef.current,
        timestamp: now,
      };

      const buffer = recordedFramesRef.current;
      buffer.push(frame);
      if (buffer.length > 700) {
        buffer.shift();
      }
      if (buffer.length >= 5) {
        setHasRecording(true);
        const dur = (buffer[buffer.length - 1].timestamp - buffer[0].timestamp) / 1000;
        setRecordedDurationSec(Math.max(1, Math.round(dur)));
      }
    };

    // Direct main-thread WebCodecs and ImageBitmap decoding (bypasses worker thread-hop ping-pong)
    workerRef.current = null;
    workerReadyRef.current = false;

    const connect = () => {
      if (isDisposed) return;

      try {
        const wsUrl = getWsUrl();
        const ws = new WebSocket(wsUrl);
        ws.binaryType = "arraybuffer";
        activeWs = ws;
        wsRef.current = ws;

        ws.onopen = () => {
          if (isDisposed) {
            ws.close();
            return;
          }
          lastFrameSeqRef.current = 0;
          lastDrawnSeqRef.current = 0;
          lastFrameTimeRef.current = 0;
          lastFallbackChunkTsRef.current = 0;
          setConnected(true);
          const openUrl = (initialUrl && initialUrl !== "about:blank" && !initialUrl.includes("localhost:3000") && !initialUrl.includes("127.0.0.1:3000"))
            ? initialUrl
            : (currentUrl && currentUrl !== "about:blank" && !currentUrl.includes("localhost:3000") && !currentUrl.includes("127.0.0.1:3000"))
            ? currentUrl
            : initialUrl || currentUrl || "http://localhost:3000";
          ws.send(
            JSON.stringify({
              type: "open",
              url: openUrl,
            })
          );
        };

        ws.onclose = () => {
          if (isDisposed) return;
          setConnected(false);
          // Automatic reconnection attempt after 2 seconds if canvas remains open
          reconnectTimeout = setTimeout(() => {
            if (!isDisposed && isOpen) {
              connect();
            }
          }, 2000);
        };

        ws.onerror = (err) => {
          // Use console.warn instead of console.error so Next.js dev overlay does not pop up a full-screen fatal error
          console.warn("[BrowserCanvas] WebSocket connection notice:", err);
          if (!isDisposed) {
            setConnected(false);
          }
        };

        // Decoupled 60 FPS requestAnimationFrame render loop with zero-copy hardware acceleration
        const renderLoop = (now: number) => {
          if (isDisposed) return;
          if (isPlaybackModeRef.current) {
            // In playback mode, discard any live frames to let playback effect control canvas exclusively
            if (nextVideoFrameRef.current) {
              nextVideoFrameRef.current.close();
              nextVideoFrameRef.current = null;
            }
            if (nextBitmapRef.current) {
              nextBitmapRef.current.close();
              nextBitmapRef.current = null;
            }
            animId = requestAnimationFrame(renderLoop);
            return;
          }

          const canvas = canvasRef.current;
          if (canvas) {
            if (nextVideoFrameRef.current) {
              const frame = nextVideoFrameRef.current;
              nextVideoFrameRef.current = null;
              try {
                if (!ctx2dRef.current || ctx2dRef.current.canvas !== canvas) {
                  ctx2dRef.current = canvas.getContext("2d", {
                    alpha: false,
                    desynchronized: true,
                  });
                }
                const ctx = ctx2dRef.current;
                if (ctx) {
                  ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
                  frameCountRef.current += 1;
                }
              } catch {
              } finally {
                frame.close();
              }
            } else if (nextBitmapRef.current) {
              const bitmap = nextBitmapRef.current;
              nextBitmapRef.current = null;
              try {
                if (!ctx2dRef.current || ctx2dRef.current.canvas !== canvas) {
                  ctx2dRef.current = canvas.getContext("2d", {
                    alpha: false,
                    desynchronized: true,
                  });
                }
                const ctx = ctx2dRef.current;
                if (ctx) {
                  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
                  frameCountRef.current += 1;
                }
              } catch {
              } finally {
                bitmap.close();
              }
            }
          }

          animId = requestAnimationFrame(renderLoop);
        };
        // Always run the vsync-locked renderLoop for buttery-smooth 60 FPS presentation
        animId = requestAnimationFrame(renderLoop);

        ws.onmessage = (evt) => {
          if (isDisposed) return;
          try {
            // Direct binary frame handling (16-byte header + worker / hardware decoding)
            if (evt.data instanceof ArrayBuffer) {
              const buffer = evt.data;
              netFrameCountRef.current += 1;
              // While inspecting replay, ignore incoming live binary frames completely
              if (isPlaybackModeRef.current) {
                return;
              }

              // Direct main-thread decoding (zero-copy hardware acceleration, zero thread-hopping)
              let payloadOffset = 0;
              let seq = 0;
              let serverTs = 0;
              let metadata: Record<string, any> = {};
              if (buffer.byteLength >= 16) {
                const view = new DataView(buffer);
                if (view.getUint8(0) === 0x53 && view.getUint8(1) === 0x50) {
                  // Magic 'SP'
                  seq = view.getUint32(2);
                  serverTs = Number(view.getBigUint64(6));
                  const metaLen = view.getUint16(14);
                  payloadOffset = 16 + metaLen;
                  if (metaLen > 2) {
                    try {
                      const metaBytes = new Uint8Array(buffer, 16, metaLen);
                      metadata = JSON.parse(new TextDecoder().decode(metaBytes));
                    } catch {}
                  }
                  const now = Date.now();
                  if (serverTs > 0 && now >= serverTs && now - lastLatencyUpdateRef.current >= 800) {
                    lastLatencyUpdateRef.current = now;
                    setLatencyMs(now - serverTs);
                  }
                  // Accept sequence resets: if server restarts seq (e.g. re-arm screencast or new session),
                  // reset decode filter baseline so no incoming frames are discarded!
                  if (seq > 0 && seq < lastFrameSeqRef.current) {
                    lastFrameSeqRef.current = seq;
                    lastDrawnSeqRef.current = 0;
                    keyframeExpectedRef.current = true;
                  } else if (seq > 0) {
                    lastFrameSeqRef.current = seq;
                  }
                  // Validate frame integrity or handle lightweight heartbeat packet (payload length 0)
                  if (payloadOffset >= buffer.byteLength) {
                    return;
                  }
                }
              }

              // H.264 WebCodecs Fast-Path (direct hardware decoding)
              if (metadata.codec === "h264" || metadata.codec === "avc1") {
                if (typeof (window as any).VideoDecoder !== "undefined") {
                  if (keyframeExpectedRef.current && !metadata.isKeyFrame) {
                    return; // Await initial IDR keyframe to prevent decode corruption
                  }
                  keyframeExpectedRef.current = false;

                  if (!fallbackDecoderRef.current || fallbackDecoderRef.current.state === "closed") {
                    try {
                      fallbackDecoderRef.current = new (window as any).VideoDecoder({
                        output: (frame: any) => {
                          if (isDisposed || isPlaybackModeRef.current) {
                            frame.close();
                            return;
                          }
                          const canvas = canvasRef.current;
                          if (canvas) {
                            try {
                              const ctx2d = canvas.getContext("2d", { alpha: false, desynchronized: true });
                              if (ctx2d) {
                                ctx2d.drawImage(frame, 0, 0, canvas.width, canvas.height);
                                frameCountRef.current += 1;
                              }
                            } catch {}
                          }
                          frame.close();
                        },
                        error: (err: any) => {
                          console.warn("[BrowserCanvas] VideoDecoder reset notice:", err);
                          keyframeExpectedRef.current = true;
                          try {
                            fallbackDecoderRef.current?.close();
                          } catch {}
                          fallbackDecoderRef.current = null;
                        },
                      });
                      fallbackDecoderRef.current.configure({
                        codec: "avc1.420029",
                        optimizeForLatency: true,
                      });
                    } catch {
                      fallbackDecoderRef.current = null;
                    }
                  }
                  if (fallbackDecoderRef.current && typeof (window as any).EncodedVideoChunk !== "undefined") {
                    try {
                      let chunkTs = Math.round(serverTs > 0 ? serverTs * 1000 : performance.now() * 1000);
                      if (chunkTs <= lastFallbackChunkTsRef.current) {
                        chunkTs = lastFallbackChunkTsRef.current + 1000;
                      }
                      lastFallbackChunkTsRef.current = chunkTs;

                      const chunk = new (window as any).EncodedVideoChunk({
                        type: metadata.isKeyFrame ? "key" : "delta",
                        timestamp: chunkTs,
                        data: new Uint8Array(buffer, payloadOffset),
                      });
                      fallbackDecoderRef.current.decode(chunk);
                      return;
                    } catch (e) {
                      keyframeExpectedRef.current = true;
                    }
                  }
                }
                return;
              }

              // JPEG Fallback on Main Thread
              const jpegBlob = new Blob([new Uint8Array(buffer, payloadOffset)], { type: "image/jpeg" });
              recordFrame(jpegBlob);
              const capturedSeq = seq;
              createImageBitmap(jpegBlob, {
                premultiplyAlpha: "none",
                colorSpaceConversion: "none",
              })
                .then((bitmap) => {
                  if (isDisposed) {
                    bitmap.close();
                    return;
                  }
                  // Decode order tracking: discard if a newer frame was already decoded
                  if (capturedSeq > 0 && capturedSeq < lastDrawnSeqRef.current) {
                    bitmap.close();
                    return;
                  }
                  if (nextBitmapRef.current) {
                    nextBitmapRef.current.close();
                  }
                  nextBitmapRef.current = bitmap;
                  if (capturedSeq > 0) lastDrawnSeqRef.current = capturedSeq;
                })
                .catch(() => {});
              return;
            }

            const msg = JSON.parse(evt.data);
            if (msg.type === "frame" && msg.data) {
              if (isPlaybackModeRef.current) {
                return;
              }
              const frameSeq = typeof msg.seq === "number" ? msg.seq : 0;
              const frameTime = typeof msg.timestamp === "number" ? msg.timestamp : Date.now();

              // Accept sequence resets gracefully and reset decode baseline
              if (frameSeq > 0 && frameSeq < lastFrameSeqRef.current) {
                lastFrameSeqRef.current = frameSeq; // Server reset — accept and track
                lastDrawnSeqRef.current = 0;        // Reset decode baseline
              } else if (frameSeq > 0) {
                lastFrameSeqRef.current = frameSeq;
              }
              if (frameSeq === 0 && frameTime < lastFrameTimeRef.current) {
                return;
              }
              if (frameTime > 0) lastFrameTimeRef.current = frameTime;

              try {
                const byteChars = atob(msg.data);
                const byteNums = new Uint8Array(byteChars.length);
                for (let i = 0; i < byteChars.length; i++) {
                  byteNums[i] = byteChars.charCodeAt(i);
                }
                const blob = new Blob([byteNums], { type: "image/jpeg" });
                recordFrame(blob);

                const capturedJsonSeq = frameSeq || 0;
                createImageBitmap(blob, {
                  premultiplyAlpha: "none",
                  colorSpaceConversion: "none",
                })
                  .then((bitmap) => {
                    if (isDisposed) {
                      bitmap.close();
                      return;
                    }
                    // Decode order tracking: discard if a newer frame was already decoded
                    if (capturedJsonSeq > 0 && capturedJsonSeq < lastDrawnSeqRef.current) {
                      bitmap.close();
                      return;
                    }
                    if (nextBitmapRef.current) {
                      nextBitmapRef.current.close();
                    }
                    nextBitmapRef.current = bitmap;
                    if (capturedJsonSeq > 0) lastDrawnSeqRef.current = capturedJsonSeq;
                    netFrameCountRef.current += 1;
                  })
                  .catch(() => {});
              } catch {
                // Ignore base64 decode errors on malformed payloads
              }
            } else if (msg.type === "cursor_action") {
              if (isPlaybackModeRef.current) {
                return;
              }
              if (typeof msg.x === "number" && typeof msg.y === "number") {
                cursorPosRef.current = { x: msg.x, y: msg.y };
                cursorVisibleRef.current = true;
                setCursorPos({ x: msg.x, y: msg.y });
                setCursorVisible(true);
              }
              if (msg.label) {
                cursorActionRef.current = msg.label;
                setCursorAction(msg.label);
                setTimeout(() => {
                  if (cursorActionRef.current === msg.label) {
                    cursorActionRef.current = "";
                    setCursorAction("");
                  }
                }, 1800);
              }
              if (
                (msg.action === "click" || msg.action === "double_click" || msg.action === "right_click" || msg.action === "hover") &&
                typeof msg.x === "number" &&
                typeof msg.y === "number"
              ) {
                const rippleId = Date.now() + Math.random();
                const actionType = msg.action;
                const newRipples = [...clickRipplesRef.current.slice(-4), { id: rippleId, x: msg.x, y: msg.y, type: actionType }];
                clickRipplesRef.current = newRipples;
                setClickRipples(newRipples);
                setTimeout(() => {
                  if (!isDisposed) {
                    const filtered = clickRipplesRef.current.filter((r) => r.id !== rippleId);
                    clickRipplesRef.current = filtered;
                    setClickRipples(filtered);
                  }
                }, 800);
              }
            } else if (msg.type === "page_state") {
              if (msg.url && !msg.url.includes("chrome-error://")) {
                currentUrlRef.current = msg.url;
                setCurrentUrl(msg.url);
                setUrlInput(msg.url);
                if (typeof onUrlChange === "function") {
                  onUrlChange(msg.url);
                }
              }
              if (msg.title) {
                pageTitleRef.current = msg.title;
                setPageTitle(msg.title);
              }
              if (Array.isArray(msg.elements)) {
                setElements(msg.elements);
                setIsRefreshingElements(false);
              }
            } else if (msg.type === "console" && msg.log) {
              setConsoleLogs((prev) => [...prev.slice(-100), msg.log]);
            } else if (msg.type === "navigated" && msg.url) {
              if (!msg.url.includes("chrome-error://")) {
                currentUrlRef.current = msg.url;
                setCurrentUrl(msg.url);
                setUrlInput(msg.url);
                if (typeof onUrlChange === "function") {
                  onUrlChange(msg.url);
                }
              }
            } else if (msg.type === "testing_completed" || msg.type === "testing_stopped") {
              if (recordedFramesRef.current.length >= 6) {
                setShowCompletionPrompt(true);
              }
            }
          } catch (e) {
            console.warn("[BrowserCanvas] Message parse warning:", e);
          }
        };
      } catch (err) {
        console.warn("[BrowserCanvas] Initialization error:", err);
      }
    };

    connect();

    const handleBrowserStop = () => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({
            type: "stop_testing",
          })
        );
      }
    };

    const handleTestCompleted = () => {
      if (recordedFramesRef.current.length >= 6) {
        setShowCompletionPrompt(true);
      }
    };

    const handleStreamStart = () => {
      if (isPlaybackModeRef.current) {
        setIsPlaybackMode(false);
        isPlaybackModeRef.current = false;
        setIsPlaying(false);
      }
      // Reset sequence trackers so new stream frames are not dropped
      lastFrameSeqRef.current = 0;
      lastFrameTimeRef.current = 0;
      lastDrawnSeqRef.current = 0;
    };

    if (typeof window !== "undefined") {
      window.addEventListener("stackpilot:browser:stop", handleBrowserStop);
      window.addEventListener("stackpilot:browser:test_completed", handleTestCompleted);
      window.addEventListener("stackpilot:browser:stream_start", handleStreamStart);
    }

    return () => {
      isDisposed = true;
      if (animId !== null) {
        cancelAnimationFrame(animId);
      }
      if (workerRef.current) {
        workerRef.current.postMessage({ type: "destroy" });
        workerRef.current.terminate();
        workerRef.current = null;
        workerReadyRef.current = false;
      }
      if (fallbackDecoderRef.current) {
        try {
          fallbackDecoderRef.current.close();
        } catch {}
        fallbackDecoderRef.current = null;
      }
      if (nextVideoFrameRef.current) {
        nextVideoFrameRef.current.close();
        nextVideoFrameRef.current = null;
      }
      if (nextBitmapRef.current) {
        nextBitmapRef.current.close();
        nextBitmapRef.current = null;
      }
      if (typeof window !== "undefined") {
        window.removeEventListener("stackpilot:browser:stop", handleBrowserStop);
        window.removeEventListener("stackpilot:browser:test_completed", handleTestCompleted);
        window.removeEventListener("stackpilot:browser:stream_start", handleStreamStart);
      }
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
      }
      if (scrollDebounceRef.current) {
        clearTimeout(scrollDebounceRef.current);
      }
      if (activeWs) {
        activeWs.close();
      }
      wsRef.current = null;
    };
  }, [isOpen, getWsUrl]);

  // ─── Playback Engine ───
  const enterPlaybackMode = () => {
    if (!recordedFramesRef.current.length) return;
    isPlaybackModeRef.current = true;
    setIsPlaybackMode(true);
    setPlaybackIndex(0);
    setIsPlaying(true);
    setShowCompletionPrompt(false);
    if (workerRef.current) {
      workerRef.current.postMessage({ type: "pause", paused: true });
    }
    if (nextBitmapRef.current) {
      nextBitmapRef.current.close();
      nextBitmapRef.current = null;
    }
  };

  const exitPlaybackMode = () => {
    isPlaybackModeRef.current = false;
    setIsPlaybackMode(false);
    setIsPlaying(false);
    lastFrameSeqRef.current = 0;
    lastDrawnSeqRef.current = 0;
    if (workerRef.current) {
      workerRef.current.postMessage({ type: "pause", paused: false });
    }
  };

  const currentPlaybackFrame =
    isPlaybackMode && recordedFramesRef.current[playbackIndex]
      ? recordedFramesRef.current[playbackIndex]
      : null;

  // Render current recorded frame to canvas when in playback mode
  useEffect(() => {
    if (!isPlaybackMode) return;
    const frames = recordedFramesRef.current;
    if (!frames.length || playbackIndex >= frames.length) return;

    const frame = frames[playbackIndex];

    let cancelled = false;
    createImageBitmap(frame.blob, {
      premultiplyAlpha: "none",
      colorSpaceConversion: "none",
    })
      .then((bitmap) => {
        if (cancelled) {
          bitmap.close();
          return;
        }
        const canvas = canvasRef.current;
        if (canvas) {
          try {
            const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
            if (ctx) {
              ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            }
          } catch {
          } finally {
            bitmap.close();
          }
        } else {
          bitmap.close();
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [isPlaybackMode, playbackIndex]);

  // Advance playback frames smoothly according to recorded timing & speed
  useEffect(() => {
    if (!isPlaybackMode || !isPlaying) return;

    const frames = recordedFramesRef.current;
    if (playbackIndex >= frames.length - 1) {
      setIsPlaying(false);
      return;
    }

    const currentFrame = frames[playbackIndex];
    const nextFrame = frames[playbackIndex + 1];
    let interval = 60;
    if (currentFrame && nextFrame) {
      const delta = nextFrame.timestamp - currentFrame.timestamp;
      if (delta > 10 && delta < 600) {
        interval = delta;
      }
    }
    const scaledInterval = Math.max(15, Math.round(interval / playbackSpeed));

    playbackTimerRef.current = setTimeout(() => {
      setPlaybackIndex((prev) => {
        if (prev >= frames.length - 1) {
          setIsPlaying(false);
          return prev;
        }
        return prev + 1;
      });
    }, scaledInterval);

    return () => {
      if (playbackTimerRef.current) {
        clearTimeout(playbackTimerRef.current);
      }
    };
  }, [isPlaybackMode, isPlaying, playbackIndex, playbackSpeed]);

  // Keyboard navigation for playback
  useEffect(() => {
    if (!isPlaybackMode) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === "Space") {
        e.preventDefault();
        setIsPlaying((p) => !p);
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        setPlaybackIndex((prev) => Math.max(0, prev - 1));
        setIsPlaying(false);
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        setPlaybackIndex((prev) => Math.min(recordedFramesRef.current.length - 1, prev + 1));
        setIsPlaying(false);
      } else if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        setPlaybackIndex(0);
        setIsPlaying(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        setIsPlaybackMode(false);
        setIsPlaying(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isPlaybackMode]);

  // Coordinate translation from display CSS pixels to 1280x720 canvas coordinates
  const getCanvasCoords = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const scaleX = 1280 / rect.width;
    const scaleY = 720 / rect.height;
    return {
      x: Math.round((e.clientX - rect.left) * scaleX),
      y: Math.round((e.clientY - rect.top) * scaleY),
    };
  }, []);

  // Handle direct User Clicks on the canvas
  const handleCanvasClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (isPlaybackMode) {
      setIsPlaying((p) => !p);
      return;
    }
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const { x, y } = getCanvasCoords(e);
    wsRef.current.send(
      JSON.stringify({
        type: "user_click",
        x,
        y,
      })
    );
    const rippleId = Date.now();
    setClickRipples((prev) => [...prev.slice(-4), { id: rippleId, x, y }]);
    setTimeout(() => {
      setClickRipples((prev) => prev.filter((r) => r.id !== rippleId));
    }, 800);
  };

  // Handle throttled mouse move to trigger live :hover styles in Chromium
  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (isPlaybackMode) return;
    const now = Date.now();
    if (now - lastMoveSentRef.current < 35) return;
    lastMoveSentRef.current = now;
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const { x, y } = getCanvasCoords(e);
    wsRef.current.send(
      JSON.stringify({
        type: "user_move",
        x,
        y,
      })
    );
  };

  // Handle User Scroll
  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (isPlaybackMode) {
      const delta = Math.sign(e.deltaY);
      setPlaybackIndex((prev) => Math.max(0, Math.min(recordedFramesRef.current.length - 1, prev + delta * 2)));
      setIsPlaying(false);
      return;
    }
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const deltaY = Math.sign(e.deltaY) * 150;
    wsRef.current.send(
      JSON.stringify({
        type: "user_scroll",
        delta_y: deltaY,
      })
    );

    // Immediately adjust element positions during scrolling to prevent visual desync
    setElements((prev) =>
      prev.map((el) => ({
        ...el,
        y: el.y - deltaY,
      }))
    );

    // Debounce send refresh_elements after 120ms to keep element tags locked to the scrolled content
    if (scrollDebounceRef.current) {
      clearTimeout(scrollDebounceRef.current);
    }
    scrollDebounceRef.current = setTimeout(() => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({
            type: "refresh_elements",
          })
        );
      }
    }, 120);
  };

  // Handle Manual URL Navigation
  const handleNavigate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    let target = urlInput.trim();
    if (!target.startsWith("http://") && !target.startsWith("https://")) {
      target = `http://${target}`;
    }
    wsRef.current.send(
      JSON.stringify({
        type: "user_navigate",
        url: target,
      })
    );
    if (onUrlChange) {
      onUrlChange(target);
    }
  };

  // Refresh page elements
  const handleRefresh = () => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    setIsRefreshingElements(true);
    wsRef.current.send(
      JSON.stringify({
        type: "refresh_elements",
      })
    );
    setTimeout(() => setIsRefreshingElements(false), 2000);
  };

  if (!isOpen) return null;

  return (
    <div
      ref={containerRef}
      className={cn(
        "flex flex-col border border-border/80 bg-background/95 backdrop-blur-xl shadow-2xl rounded-2xl overflow-hidden transition-all duration-300",
        embedded ? "h-full w-full" : isMaximized ? "fixed inset-4 z-50" : "h-[640px] w-full",
        className
      )}
    >
      {/* ─── Top Control Bar ─── */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/60 bg-muted/40 text-xs select-none">
        {/* Left: Status & Mode Badges */}
        <div className="flex items-center gap-2">
          {!isPlaybackMode ? (
            <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-background/80 border border-border/60 font-medium">
              <span
                className={cn(
                  "h-2 w-2 rounded-full",
                  connected ? "bg-emerald-500 animate-pulse shadow-sm shadow-emerald-500/50" : "bg-amber-500"
                )}
              />
              <span className="font-mono text-[11px] text-foreground/90">
                {connected ? (fps > 0 || networkFps > 0 ? `Live • ${fps > 0 ? fps : networkFps} fps` : "Live • Standby") : "Connecting..."}
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <Badge
                variant="outline"
                className="bg-purple-500/20 text-purple-300 border-purple-500/50 flex items-center gap-1.5 h-7 px-2.5 shadow-sm"
              >
                <Film className="h-3.5 w-3.5 text-purple-400 animate-pulse" />
                <span className="font-semibold text-xs">Replay Mode</span>
              </Badge>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2.5 text-xs bg-emerald-500/20 text-emerald-300 border-emerald-500/40 hover:bg-emerald-500/30 hover:text-white gap-1.5 font-medium shadow-sm transition-all"
                onClick={exitPlaybackMode}
                title="Return to real-time live browser stream (Esc)"
              >
                <RotateCcw className="h-3 w-3" /> Return to Live
              </Button>
            </div>
          )}

          {/* Replay Mode Trigger when recording is available */}
          {hasRecording && !isPlaybackMode && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2.5 text-xs font-semibold gap-1.5 border-purple-500/50 bg-purple-500/10 hover:bg-purple-500/25 text-purple-300 transition-all shadow-sm"
              onClick={enterPlaybackMode}
              title="Watch session recording replay with AI cursor"
            >
              <Film className="h-3.5 w-3.5 text-purple-400" />
              <span>Replay ({recordedDurationSec}s)</span>
            </Button>
          )}

          {!isPlaybackMode && (
            <Button
              size="sm"
              variant={takeOver ? "default" : "outline"}
              className={cn(
                "h-7 px-2.5 text-xs font-semibold gap-1.5 transition-all shadow-sm",
                takeOver
                  ? "bg-amber-500 hover:bg-amber-600 text-black border-amber-400"
                  : "bg-background/80 text-foreground/80 hover:text-foreground"
              )}
              onClick={() => {
                const nextState = !takeOver;
                setTakeOver(nextState);
                if (nextState) {
                  toast.info("Human Take Over Active", {
                    description: "Click and scroll directly inside the screen to interact.",
                  });
                } else {
                  toast.success("AI Autopilot Restored", {
                    description: "The AI agent is driving the browser session.",
                  });
                }
              }}
            >
              {takeOver ? (
                <>
                  <User className="h-3.5 w-3.5" />
                  <span>Manual Control</span>
                </>
              ) : (
                <>
                  <Bot className="h-3.5 w-3.5 text-sky-400" />
                  <span>AI Driving</span>
                </>
              )}
            </Button>
          )}

          {!isPlaybackMode && (
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              onClick={() => setShowElementTags(!showElementTags)}
              title={showElementTags ? "Hide Element IDs" : "Show Element IDs"}
            >
              {showElementTags ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5 opacity-50" />}
            </Button>
          )}
        </div>

        {/* Center: Address Bar */}
        <form onSubmit={handleNavigate} className="flex-1 min-w-[160px] sm:min-w-[220px] max-w-xl mx-2">
          <div className="relative flex items-center">
            <Globe className="absolute left-2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              value={isPlaybackMode ? (currentPlaybackFrame?.url || urlInput) : urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              disabled={isPlaybackMode}
              placeholder="https://..."
              title={urlInput}
              className="h-7 pl-7 pr-7 font-mono text-[11px] bg-background/90 border-border/80 focus-visible:ring-1 focus-visible:ring-primary/40 rounded-md w-full truncate"
            />
            <button
              type="button"
              onClick={handleRefresh}
              className="absolute right-2 text-muted-foreground hover:text-foreground transition-colors"
              title="Refresh DOM element tags"
            >
              <RefreshCw className={cn("h-3 w-3", isRefreshingElements && "animate-spin text-primary")} />
            </button>
          </div>
        </form>

        {/* Right: Window Controls */}
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className={cn(
              "h-7 px-2 text-[11px] gap-1 text-muted-foreground hover:text-foreground",
              showConsole && "text-primary font-medium"
            )}
            onClick={() => setShowConsole(!showConsole)}
          >
            <Terminal className="h-3.5 w-3.5" />
            <span>Console</span>
            {consoleLogs.filter((l) => l.type === "error").length > 0 && (
              <Badge variant="destructive" className="h-4 px-1 text-[9px]">
                {consoleLogs.filter((l) => l.type === "error").length}
              </Badge>
            )}
          </Button>

          {!embedded && (
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              onClick={() => setIsMaximized(!isMaximized)}
            >
              {isMaximized ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </Button>
          )}

          {onClose && (
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              onClick={onClose}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* ─── Main Live View Area ─── */}
      <div className="relative flex-1 bg-zinc-950 flex items-center justify-center overflow-hidden">
        <div
          className={cn(
            "relative aspect-video w-full max-h-full select-none cursor-pointer",
            takeOver && "cursor-crosshair"
          )}
          onClick={handleCanvasClick}
          onMouseMove={handleCanvasMouseMove}
          onWheel={handleWheel}
        >
          {/* Hardware-accelerated Canvas */}
          <canvas
            ref={canvasRef}
            width={1280}
            height={720}
            className="w-full h-full object-contain block bg-zinc-950 shadow-inner"
          />

          {/* Real-time Telemetry HUD (FPS & Latency) */}
          {connected && (
            <div className="absolute top-2.5 right-2.5 flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-black/80 border border-white/10 text-[10px] font-mono text-zinc-300 backdrop-blur pointer-events-none z-30 shadow-lg">
              {isPlaybackMode ? (
                <span className="flex items-center gap-1.5 text-purple-300 font-semibold">
                  <span className="h-1.5 w-1.5 rounded-full bg-purple-400 animate-pulse" />
                  <span>REPLAY MODE ({playbackSpeed}x)</span>
                </span>
              ) : (
                <>
                  <span className="flex items-center gap-1">
                    <span
                      className={cn(
                        "h-1.5 w-1.5 rounded-full",
                        fps >= 25 ? "bg-emerald-400 animate-pulse" : (connected ? "bg-emerald-500" : "bg-zinc-500")
                      )}
                    />
                    <span className="font-semibold text-white">
                      {fps > 0 ? `${fps} FPS` : (networkFps > 0 ? `${networkFps} net` : (connected ? "LIVE" : "OFFLINE"))}
                    </span>
                  </span>
                  {networkFps > 0 && networkFps !== fps && (
                    <>
                      <span className="text-zinc-600">•</span>
                      <span>{networkFps} net</span>
                    </>
                  )}
                  {latencyMs > 0 && (
                    <>
                      <span className="text-zinc-600">•</span>
                      <span>{latencyMs}ms</span>
                    </>
                  )}
                </>
              )}
            </div>
          )}

          {/* Interactive Element Tags Overlay */}
          {showElementTags &&
            elements.map((el) => {
              if (el.x < 0 || el.y < 0 || el.x > 1280 || el.y > 720) return null;
              const left = `${(el.x / 1280) * 100}%`;
              const top = `${(el.y / 720) * 100}%`;
              const width = `${(el.w / 1280) * 100}%`;
              const height = `${(el.h / 720) * 100}%`;

              return (
                <div
                  key={`${el.id}-${el.x}-${el.y}`}
                  style={{
                    left: `calc(${left} - ${(el.w / 2 / 1280) * 100}%)`,
                    top: `calc(${top} - ${(el.h / 2 / 720) * 100}%)`,
                    width,
                    height,
                  }}
                  className="absolute pointer-events-none border border-sky-400/60 bg-sky-500/15 rounded-[2px] transition-opacity duration-150"
                >
                  <span className="absolute -top-3.5 -left-1 px-1 py-0.5 text-[8px] font-mono font-bold bg-sky-600 text-white rounded shadow-sm leading-none select-none">
                    {el.id}
                  </span>
                </div>
              );
            })}

          {/* Animated AI Cursor (Active in both Live & Playback Replay modes) */}
          {(isPlaybackMode ? (currentPlaybackFrame?.cursor.visible ?? false) : (cursorVisible && !takeOver)) && (
            <div
              style={{
                left: `${((isPlaybackMode ? currentPlaybackFrame?.cursor.x ?? 640 : cursorPos.x) / 1280) * 100}%`,
                top: `${((isPlaybackMode ? currentPlaybackFrame?.cursor.y ?? 360 : cursorPos.y) / 720) * 100}%`,
              }}
              className="absolute pointer-events-none -translate-x-1 -translate-y-1 transition-all duration-150 ease-out z-30"
            >
              <div className="relative">
                <svg
                  className={cn(
                    "w-6 h-6",
                    isPlaybackMode
                      ? "drop-shadow-[0_2px_8px_rgba(168,85,247,0.85)]"
                      : "drop-shadow-[0_2px_8px_rgba(56,189,248,0.7)]"
                  )}
                  viewBox="0 0 24 24"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    d="M3 3L10.07 19.97L12.58 12.58L19.97 10.07L3 3Z"
                    fill={isPlaybackMode ? "#a855f7" : "#38bdf8"}
                    stroke="#ffffff"
                    strokeWidth="1.5"
                    strokeLinejoin="round"
                  />
                </svg>

                {(isPlaybackMode ? currentPlaybackFrame?.cursor.action : cursorAction) && (
                  <div
                    className={cn(
                      "absolute left-5 -top-1 px-2 py-0.5 rounded-full text-[10px] font-mono whitespace-nowrap shadow-lg backdrop-blur-md animate-in fade-in zoom-in-95 duration-150 flex items-center gap-1",
                      isPlaybackMode
                        ? "bg-purple-950/90 border border-purple-400/80 text-purple-200"
                        : "bg-sky-950/90 border border-sky-400/80 text-sky-200"
                    )}
                  >
                    <Zap className={cn("h-2.5 w-2.5 animate-pulse", isPlaybackMode ? "text-purple-400" : "text-sky-400")} />
                    <span>{isPlaybackMode ? currentPlaybackFrame?.cursor.action : cursorAction}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Action Ripple & Halo Waves */}
          {(isPlaybackMode ? currentPlaybackFrame?.ripples || [] : clickRipples).map((ripple) => {
            let ringClass = "border-sky-400 animate-ping opacity-75 h-10 w-10";
            if (ripple.type === "hover") {
              ringClass = "border-cyan-300 bg-cyan-400/25 animate-pulse opacity-90 h-9 w-9 shadow-[0_0_12px_rgba(6,182,212,0.6)]";
            } else if (ripple.type === "right_click") {
              ringClass = "border-purple-400 animate-ping opacity-80 h-11 w-11 shadow-[0_0_10px_rgba(168,85,247,0.5)]";
            } else if (ripple.type === "double_click") {
              ringClass = "border-amber-400 animate-ping opacity-85 h-12 w-12 shadow-[0_0_12px_rgba(251,191,36,0.6)]";
            }
            return (
              <div
                key={ripple.id}
                style={{
                  left: `${(ripple.x / 1280) * 100}%`,
                  top: `${(ripple.y / 720) * 100}%`,
                }}
                className="absolute pointer-events-none -translate-x-1/2 -translate-y-1/2 z-20"
              >
                <span className={`block rounded-full border-2 ${ringClass}`} />
              </div>
            );
          })}

          {/* Page Title & Route Banner */}
          {(isPlaybackMode ? currentPlaybackFrame?.pageTitle || pageTitle : pageTitle) && (
            <div className="absolute bottom-2 left-2 px-2.5 py-1 rounded bg-black/70 backdrop-blur-md border border-white/10 text-white/80 text-[11px] font-sans flex items-center gap-1.5 pointer-events-none shadow-md">
              <span className={cn("h-1.5 w-1.5 rounded-full", isPlaybackMode ? "bg-purple-400" : "bg-emerald-400")} />
              <span className="max-w-[300px] truncate">
                {isPlaybackMode ? currentPlaybackFrame?.pageTitle || pageTitle : pageTitle}
              </span>
            </div>
          )}

          {/* Fallback Screen when disconnected */}
          {!connected && !isPlaybackMode && (
            <div className="absolute inset-0 bg-background/90 backdrop-blur-sm flex flex-col items-center justify-center gap-3 text-muted-foreground z-40">
              <Activity className="h-8 w-8 animate-spin text-primary/60" />
              <p className="text-xs font-mono">Connecting to Live Screencast...</p>
            </div>
          )}

          {/* ─── Floating Test Run Completion Banner ─── */}
          {showCompletionPrompt && !isPlaybackMode && hasRecording && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-xl bg-purple-950/95 border border-purple-500/60 shadow-2xl backdrop-blur-md flex items-center gap-3 z-40 animate-in fade-in slide-in-from-bottom-3 duration-300">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                <span className="text-xs font-semibold text-white">AI Testing Session Completed</span>
                <span className="text-[11px] text-purple-300 font-mono">({recordedDurationSec}s captured)</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  className="h-6 px-2.5 text-xs bg-purple-600 hover:bg-purple-500 text-white font-semibold gap-1 shadow-md"
                  onClick={() => {
                    setShowCompletionPrompt(false);
                    enterPlaybackMode();
                  }}
                >
                  <Play className="h-3 w-3 fill-current" />
                  <span>Watch Replay</span>
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6 text-zinc-400 hover:text-white"
                  onClick={() => setShowCompletionPrompt(false)}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ─── Modern Playback Control Dock ─── */}
      {isPlaybackMode && (
        <div className="px-4 py-2.5 bg-zinc-900/95 border-t border-purple-500/30 backdrop-blur-xl flex flex-col gap-2 select-none z-40 text-xs">
          {/* Top Row: Scrub bar & time readout */}
          <div className="flex items-center gap-3 w-full">
            <span className="font-mono text-[11px] text-purple-300 font-medium min-w-[36px]">
              {formatTime(
                recordedFramesRef.current[playbackIndex] && recordedFramesRef.current[0]
                  ? (recordedFramesRef.current[playbackIndex].timestamp - recordedFramesRef.current[0].timestamp) / 1000
                  : 0
              )}
            </span>
            <div className="relative flex-1 flex items-center group">
              <input
                type="range"
                min={0}
                max={Math.max(0, recordedFramesRef.current.length - 1)}
                value={playbackIndex}
                onChange={(e) => {
                  setPlaybackIndex(Number(e.target.value));
                  setIsPlaying(false);
                }}
                className="w-full h-1.5 bg-zinc-800 accent-purple-500 rounded-lg cursor-pointer transition-all hover:h-2"
              />
            </div>
            <span className="font-mono text-[11px] text-zinc-400 min-w-[36px] text-right">
              {formatTime(recordedDurationSec)}
            </span>
          </div>

          {/* Bottom Row: Controls, Step buttons, Speed, Action chip, Exit */}
          <div className="flex items-center justify-between">
            {/* Left: Play/Pause, Restart, Step Back/Fwd */}
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant="outline"
                className="h-7 w-7 p-0 bg-purple-500/20 border-purple-500/40 text-purple-300 hover:bg-purple-500/30 hover:text-white"
                onClick={() => setIsPlaying(!isPlaying)}
                title={isPlaying ? "Pause (Space)" : "Play (Space)"}
              >
                {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5 ml-0.5" />}
              </Button>

              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0 text-zinc-400 hover:text-white"
                onClick={() => {
                  setPlaybackIndex(0);
                  setIsPlaying(true);
                }}
                title="Restart from beginning (R)"
              >
                <RotateCcw className="h-3 w-3" />
              </Button>

              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0 text-zinc-400 hover:text-white"
                onClick={() => {
                  setPlaybackIndex((prev) => Math.max(0, prev - 1));
                  setIsPlaying(false);
                }}
                title="Step back 1 frame (←)"
              >
                <SkipBack className="h-3 w-3" />
              </Button>

              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0 text-zinc-400 hover:text-white"
                onClick={() => {
                  setPlaybackIndex((prev) => Math.min(recordedFramesRef.current.length - 1, prev + 1));
                  setIsPlaying(false);
                }}
                title="Step forward 1 frame (→)"
              >
                <SkipForward className="h-3 w-3" />
              </Button>

              {/* Speed toggle */}
              <div className="flex items-center bg-zinc-800/80 rounded-md p-0.5 border border-zinc-700/50 ml-1">
                {[0.5, 1, 1.5, 2].map((spd) => (
                  <button
                    key={spd}
                    onClick={() => setPlaybackSpeed(spd)}
                    className={cn(
                      "px-1.5 py-0.5 text-[10px] font-mono rounded transition-colors",
                      playbackSpeed === spd
                        ? "bg-purple-500 text-white font-bold"
                        : "text-zinc-400 hover:text-zinc-200"
                    )}
                  >
                    {spd}x
                  </button>
                ))}
              </div>
            </div>

            {/* Center: Current Action Chip */}
            {currentPlaybackFrame?.cursor.action && (
              <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-purple-950/60 border border-purple-500/30 text-purple-200 text-[11px] font-mono">
                <Zap className="h-3 w-3 text-purple-400 animate-pulse" />
                <span className="max-w-[240px] truncate">{currentPlaybackFrame.cursor.action}</span>
              </div>
            )}

            {/* Right: Frame Counter and Exit */}
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-mono text-zinc-500">
                Frame {playbackIndex + 1}/{recordedFramesRef.current.length}
              </span>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-3 text-xs bg-purple-600/30 border-purple-500/50 hover:bg-purple-600 text-purple-200 hover:text-white font-medium flex items-center gap-1.5 transition-all shadow-sm"
                onClick={exitPlaybackMode}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Return to Live Feed
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Bottom Console Tray (Resizable) ─── */}
      {showConsole && (
        <>
          <div
            role="separator"
            aria-orientation="horizontal"
            onPointerDown={startDraggingConsole}
            className={cn(
              "h-1.5 w-full cursor-row-resize bg-border/40 hover:bg-primary/50 transition-colors select-none flex items-center justify-center shrink-0 group",
              isDraggingConsole && "bg-primary/70"
            )}
            title="Drag to resize console"
          >
            <div className="w-8 h-0.5 rounded-full bg-muted-foreground/30 group-hover:bg-primary/80 transition-colors" />
          </div>
          <div
            style={{ height: `${consoleHeight}px` }}
            className="border-t border-border/70 bg-background/95 flex flex-col font-mono text-[11px] select-text shrink-0"
          >
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/50 bg-muted/30">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-foreground/80">Browser Console</span>
                <div className="flex gap-1 ml-2">
                  <button
                    onClick={() => setConsoleFilter("all")}
                    className={cn(
                      "px-2 py-0.5 rounded text-[10px] transition-colors",
                      consoleFilter === "all"
                        ? "bg-muted text-foreground font-semibold"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    All ({consoleLogs.length})
                  </button>
                  <button
                    onClick={() => setConsoleFilter("error")}
                    className={cn(
                      "px-2 py-0.5 rounded text-[10px] transition-colors",
                      consoleFilter === "error"
                        ? "bg-destructive/20 text-destructive font-semibold"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    Errors ({consoleLogs.filter((l) => l.type === "error").length})
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    const text = consoleLogs.map((l) => `[${l.type}] ${l.text}`).join("\n");
                    navigator.clipboard.writeText(text);
                    toast.success("Console logs copied to clipboard");
                  }}
                  className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-[10px]"
                >
                  <Copy className="h-3 w-3" />
                  <span>Copy</span>
                </button>
                <button
                  onClick={() => setShowConsole(false)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            <div className="flex-1 p-2 overflow-y-auto space-y-1 font-mono text-[10.5px]">
              {consoleLogs
                .filter((l) => (consoleFilter === "error" ? l.type === "error" : true))
                .map((log, i) => (
                  <div
                    key={i}
                    className={cn(
                      "px-2 py-1 rounded leading-relaxed border-l-2",
                      log.type === "error"
                        ? "bg-destructive/10 border-destructive text-destructive"
                        : log.type === "warn"
                        ? "bg-amber-500/10 border-amber-500 text-amber-400"
                        : "bg-muted/20 border-border/40 text-foreground/80"
                    )}
                  >
                    <span className="opacity-50 mr-2">[{log.type.toUpperCase()}]</span>
                    <span>{log.text}</span>
                  </div>
                ))}
              {consoleLogs.length === 0 && (
                <p className="text-muted-foreground/60 italic text-center py-4">No console logs captured yet.</p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
