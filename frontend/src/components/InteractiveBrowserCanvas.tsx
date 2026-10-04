"use client";

import api from "@/lib/api";
import { browserSocketUrl } from "@/lib/browser-sandbox";
import React, { memo, useCallback, useEffect, useRef, useState } from "react";
import { LiveVideoDecoder } from "@/lib/browser-video";
import { BrowserLatency } from "@/lib/browser-latency";
import { BrowserCursorMotion } from "@/lib/browser-cursor";
import { createBrowserPeer } from "@/lib/browser-peer";
import { LivePageState } from "@/lib/browser-page-state";
import { createNativeVideoSink, type NativeVideoSink } from "@/lib/browser-video-sink";
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
  Loader2,
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
} from "@/lib/platform-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
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
  sessionId: string;
  initialUrl?: string;
  isOpen: boolean;
  onClose?: () => void;
  closeLabel?: string;
  className?: string;
  embedded?: boolean;
  sandboxMode?: "local" | "remote" | "host";
  onUrlChange?: (url: string) => void;
}

export const InteractiveBrowserCanvas = memo(function InteractiveBrowserCanvas({
  sessionId,
  initialUrl = "http://localhost:3000",
  isOpen,
  onClose,
  closeLabel,
  className,
  embedded = false,
  sandboxMode = "local",
  onUrlChange,
}: InteractiveBrowserCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [nativeVideoVisible, setNativeVideoVisible] = useState(false);
  const nativeVideoVisibleRef = useRef(false);
  const updateNativeVideoVisibility = useCallback((visible: boolean) => {
    if (nativeVideoVisibleRef.current === visible) return;
    nativeVideoVisibleRef.current = visible;
    setNativeVideoVisible(visible);
  }, []);
  const ctx2dRef = useRef<CanvasRenderingContext2D | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mainViewRef = useRef<HTMLDivElement | null>(null);
  const [canvasDisplaySize, setCanvasDisplaySize] = useState<{ width: number; height: number } | null>(null);
  const [viewZoom, setViewZoom] = useState(1);
  const canvasDisplaySizeRef = useRef({ width: 1280, height: 720 });
  const wsRef = useRef<WebSocket | null>(null);

  const [connected, setConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [currentUrl, setCurrentUrl] = useState(initialUrl);
  const [urlInput, setUrlInput] = useState(initialUrl);
  const prevInitialUrlRef = useRef(initialUrl);
  const [pageTitle, setPageTitle] = useState("");
  const [elements, setElements] = useState<InteractiveElement[]>([]);
  const [showElementTags, setShowElementTags] = useState(false);
  const [takeOver, setTakeOver] = useState(false);
  const touchGestureRef = useRef<{ id: number; x: number; y: number; lastY: number; moved: boolean } | null>(null);
  const suppressClickUntilRef = useRef(0);

  // AI Cursor state
  const [cursorVisible, setCursorVisible] = useState(false);
  const [cursorAction, setCursorAction] = useState<string>("");
  const [clickRipples, setClickRipples] = useState<Array<{ id: number; x: number; y: number; type?: string }>>([]);

  // Synchronous tracking refs for frame recording
  const cursorPosRef = useRef({ x: 640, y: 360 });
  const cursorNodeRef = useRef<HTMLDivElement | null>(null);
  const cursorMotionRef = useRef(new BrowserCursorMotion());
  const reducedMotionRef = useRef(false);
  const lastCursorPaintRef = useRef("");
  const cursorVisibleRef = useRef(false);
  const cursorActionRef = useRef<string>("");
  const clickRipplesRef = useRef<Array<{ id: number; x: number; y: number; type?: string }>>([]);
  const currentUrlRef = useRef(initialUrl);
  const previousSessionRef = useRef(sessionId);
  const pageTitleRef = useRef("");
  const onUrlChangeRef = useRef(onUrlChange);
  const initialUrlRef = useRef(initialUrl);
  const urlEditingRef = useRef(false);
  const urlDraftChangedRef = useRef(false);
  const pendingNavigationRef = useRef<string | null>(null);
  useEffect(() => { onUrlChangeRef.current = onUrlChange; }, [onUrlChange]);
  useEffect(() => { initialUrlRef.current = initialUrl; }, [initialUrl]);

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
  const recordingBytesRef = useRef(0);
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
  const [rttMs, setRttMs] = useState(0);
  const latencyRef = useRef(new BrowserLatency());
  const [inputLatencyMs, setInputLatencyMs] = useState(0);
  const [transport, setTransport] = useState("Stream");
  const sendInput = useCallback((message: Record<string, unknown>) => {
    const socket = wsRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return;
    const id = crypto.randomUUID();
    latencyRef.current.input(id);
    socket.send(JSON.stringify({ ...message, input_id: id }));
  }, []);
  const frameCountRef = useRef(0);
  const presentedFeedbackRef = useRef(0);
  const netFrameCountRef = useRef(0);
  const nextBitmapRef = useRef<ImageBitmap | null>(null);
  const nextVideoFrameRef = useRef<VideoFrame | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const workerReadyRef = useRef<boolean>(false);
  const fallbackDecoderRef = useRef<LiveVideoDecoder | null>(null);
  const lastFpsCalcRef = useRef(0);
  const lastMoveSentRef = useRef(0);
  const lastLatencyUpdateRef = useRef(0);
  const lastFrameSeqRef = useRef(0);
  const lastDrawnSeqRef = useRef(0);
  const lastFrameTimeRef = useRef(0);
  const scrollDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isRefreshingElements, setIsRefreshingElements] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);

  const paintCursor = useCallback((now: number) => {
    const node = cursorNodeRef.current;
    if (!node) return;
    const point = cursorMotionRef.current.position(now);
    const size = canvasDisplaySizeRef.current;
    const transform = `translate3d(${point.x / 1280 * size.width - 3}px, ${point.y / 720 * size.height - 3}px, 0)`;
    if (transform !== lastCursorPaintRef.current) {
      node.style.transform = transform;
      lastCursorPaintRef.current = transform;
    }
  }, []);
  const attachCursorNode = useCallback((node: HTMLDivElement | null) => {
    cursorNodeRef.current = node;
    lastCursorPaintRef.current = "";
    if (node) paintCursor(performance.now());
  }, [paintCursor]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      reducedMotionRef.current = preference.matches;
      if (preference.matches) {
        const point = cursorPosRef.current;
        cursorMotionRef.current.move(point.x, point.y, performance.now(), 0);
        paintCursor(performance.now());
      }
    };
    update();
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, [paintCursor]);

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

  // Zoom only the viewer; the agent's viewport and coordinates remain unchanged.
  // A scrollable wrapper keeps the full desktop readable on a narrow phone.
  useEffect(() => {
    if (!isOpen) return;
    const updateSize = () => {
      if (!mainViewRef.current) return;
      const { clientWidth, clientHeight } = mainViewRef.current;
      if (!clientWidth || !clientHeight) return;
      const targetAspect = 1280 / 720;
      const currentAspect = clientWidth / clientHeight;
      let w: number;
      let h: number;
      if (currentAspect > targetAspect) {
        h = clientHeight;
        w = Math.round(clientHeight * targetAspect);
      } else {
        w = clientWidth;
        h = Math.round(clientWidth / targetAspect);
      }
      w = Math.round(w * viewZoom);
      h = Math.round(h * viewZoom);
      canvasDisplaySizeRef.current = { width: w, height: h };
      setCanvasDisplaySize(previous => previous?.width === w && previous.height === h ? previous : { width: w, height: h });
      paintCursor(performance.now());
    };

    updateSize();
    const ro = new ResizeObserver(updateSize);
    if (mainViewRef.current) {
      ro.observe(mainViewRef.current);
    }
    return () => ro.disconnect();
  }, [isOpen, isMaximized, consoleHeight, showConsole, viewZoom, paintCursor]);

  // Sync with initialUrl prop changes (e.g. when user selects a project with runtime_url)
  useEffect(() => {
    if (initialUrl && initialUrl !== prevInitialUrlRef.current) {
      prevInitialUrlRef.current = initialUrl;
      const normInit = initialUrl;
      const normCurr = currentUrlRef.current;
      // If browser is already at this URL or route, do NOT send user_navigate to prevent page reload
      if (normInit && normInit === normCurr) {
        return;
      }
      setUrlInput(initialUrl);
      pendingNavigationRef.current = initialUrl;
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({
            type: "user_navigate",
            url: initialUrl,
          })
        );
        pendingNavigationRef.current = null;
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
  const getWsUrl = useCallback(() => browserSocketUrl(sessionId), [sessionId]);

  // Connect to WebSocket with resilient reconnection and StrictMode safety
  useEffect(() => {
    if (!isOpen) return;
    setConnected(false);
    setConnectionError(null);

    if (previousSessionRef.current !== sessionId) {
      previousSessionRef.current = sessionId;
      currentUrlRef.current = initialUrlRef.current;
      prevInitialUrlRef.current = initialUrlRef.current;
      pageTitleRef.current = "";
      setCurrentUrl(initialUrlRef.current);
      setUrlInput(initialUrlRef.current);
      setPageTitle("");
      setElements([]);
      recordedFramesRef.current = [];
      recordingBytesRef.current = 0;
      cursorVisibleRef.current = false;
      setCursorVisible(false);
      setHasRecording(false);
      isPlaybackModeRef.current = false;
      setIsPlaybackMode(false);
      setIsPlaying(false);
    }

    let isDisposed = false;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let connectionGeneration = 0;
    let activeWs: WebSocket | null = null;
    let animId: number | null = null;
    let cursorLabelTimeout: ReturnType<typeof setTimeout> | null = null;
    const rippleTimeouts = new Set<ReturnType<typeof setTimeout>>();

    let lastPacketAt = performance.now();
    let lastPresentedAt = performance.now();
    let videoStartedAt: number | null = null;
    let jpegFallback = false;
    let jpegDecoding = false;
    let pendingJpeg: { blob: Blob; seq: number } | null = null;
    let decodeGeneration = 0;
    let nativeVideo: NativeVideoSink | null = null;
    let nativeGeneration = 0;
    let rtc: ReturnType<typeof createBrowserPeer> | null = null;
    let rtcGeneration = 0;
    let rtcNegotiationId: string | null = null;
    let rtcActive = false;
    let rtcHasTrack = false;
    let h264Failed = false;
    let actualMode = sandboxMode;
    let requestPresentation = () => {};
    const onPresented = () => {
      presentedFeedbackRef.current++;
      lastPresentedAt = performance.now();
      latencyRef.current.presented(lastPresentedAt);
    };
    const detachNativeVideo = () => {
      nativeGeneration++;
      nativeVideo?.close();
      nativeVideo = null;
      updateNativeVideoVisibility(false);
    };
    const stopRtc = (restore = true, notify = true) => {
      const hadRtc = Boolean(rtc);
      const negotiationId = rtcNegotiationId;
      rtcGeneration++;
      rtcNegotiationId = null;
      rtc?.close();
      rtc = null;
      rtcActive = false;
      rtcHasTrack = false;
      videoStartedAt = null;
      setTransport("Stream");
      updateNativeVideoVisibility(false);
      if (hadRtc && notify && activeWs?.readyState === WebSocket.OPEN) {
        activeWs.send(JSON.stringify({ type: "rtc_stop", negotiation_id: negotiationId }));
      }
      if (hadRtc && restore && !isDisposed && activeWs?.readyState === WebSocket.OPEN) {
        if (h264Failed) recoverStream();
        else attachNativeVideo();
      }
    };
    const attachNativeVideo = () => {
      detachNativeVideo();
      if (!jpegFallback && videoRef.current) {
        const generation = nativeGeneration;
        const socket = activeWs;
        nativeVideo = createNativeVideoSink(videoRef.current, count => {
          if (isDisposed || activeWs !== socket || generation !== nativeGeneration || rtcHasTrack || isPlaybackModeRef.current) return;
          updateNativeVideoVisibility(true);
          frameCountRef.current += count;
          onPresented();
        }, () => {
          if (isDisposed || activeWs !== socket || generation !== nativeGeneration || rtcHasTrack) return;
          // A track-generator failure can still use H.264 canvas decoding.
          // It must not shut down an independent WebRTC negotiation.
          detachNativeVideo();
          requestPresentation();
        });
      }
    };
    const livePage = new LivePageState(sessionId);
    const updateLivePage = (value: unknown) => {
      const page = livePage.accept(value);
      if (!page) return false;
      const changed = page.url !== currentUrlRef.current;
      currentUrlRef.current = page.url;
      prevInitialUrlRef.current = page.url;
      if (changed) {
        setCurrentUrl(page.url);
        if (!urlEditingRef.current) setUrlInput(page.url);
      }
      const title = typeof page.title === "string" ? page.title : (changed ? "" : pageTitleRef.current);
      if (title !== pageTitleRef.current) {
        pageTitleRef.current = title;
        setPageTitle(title);
      }
      if (changed) {
        setElements([]);
        onUrlChangeRef.current?.(page.url);
      }
      return true;
    };

    // Recovery never reloads the site or repeats an input action.
    const recoverStream = () => {
      if (isDisposed || isPlaybackModeRef.current) return;
      h264Failed = true;
      fallbackDecoderRef.current?.close();
      fallbackDecoderRef.current = null;
      // RTC has its own decoder and timeout. A stalled auxiliary stream during
      // startup must not abort a peer before its first frame arrives.
      if (rtc || jpegFallback) return;
      jpegFallback = true;
      detachNativeVideo();
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "stream_recover" }));
      }
    };

    // At most one JPEG decode and one newest pending image on slow clients.
    const decodeJpeg = (blob: Blob, seq: number) => {
      pendingJpeg = { blob, seq };
      if (jpegDecoding) return;
      const run = () => {
        const pending = pendingJpeg;
        if (!pending || isDisposed) return;
        pendingJpeg = null;
        jpegDecoding = true;
        const generation = decodeGeneration;
        createImageBitmap(pending.blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" })
          .then(bitmap => {
            if (isDisposed || generation !== decodeGeneration || isPlaybackModeRef.current ||
                (pending.seq > 0 && pending.seq < lastDrawnSeqRef.current)) {
              bitmap.close();
              return;
            }
            nextBitmapRef.current?.close();
            nextBitmapRef.current = bitmap;
            if (pending.seq > 0) lastDrawnSeqRef.current = pending.seq;
            requestPresentation();
          })
          .catch(() => {})
          .finally(() => {
            jpegDecoding = false;
            if (pendingJpeg) run();
          });
      };
      run();
    };

    // Record incoming frames into the playback buffer
    const recordFrame = (jpegBlob: Blob) => {
      // Do not mutate or shift playback buffer while user is inspecting replay
      if (isPlaybackModeRef.current) return;
      const now = Date.now();
      if (now - lastRecordedTimeRef.current < 100) {
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
      recordingBytesRef.current += jpegBlob.size;
      while (buffer.length > 600 || recordingBytesRef.current > 32 * 1024 * 1024) {
        recordingBytesRef.current -= buffer.shift()!.blob.size;
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

    const connect = async () => {
      if (isDisposed) return;
      const generation = ++connectionGeneration;

      try {
        const capability = await api.get(`/ai/browser-ticket/${encodeURIComponent(sessionId)}`);
        if (isDisposed || generation !== connectionGeneration) return;
        const wsUrl = new URL(getWsUrl());
        wsUrl.searchParams.set("ticket", capability.data.ticket);
        const ws = new WebSocket(wsUrl.toString());
        ws.binaryType = "arraybuffer";
        activeWs = ws;
        wsRef.current = ws;

        ws.onopen = () => {
          if (isDisposed || activeWs !== ws) {
            ws.close();
            return;
          }
          lastFrameSeqRef.current = 0;
          stopRtc(false, false);
          detachNativeVideo();
          livePage.reset();
          lastDrawnSeqRef.current = 0;
          lastFrameTimeRef.current = 0;
          fallbackDecoderRef.current?.close();
          fallbackDecoderRef.current = null;
          decodeGeneration++;
          pendingJpeg = null;
          nextVideoFrameRef.current?.close();
          nextVideoFrameRef.current = null;
          nextBitmapRef.current?.close();
          nextBitmapRef.current = null;
          lastPacketAt = lastPresentedAt = performance.now();
          latencyRef.current = new BrowserLatency();
          presentedFeedbackRef.current = 0;
          setInputLatencyMs(0);
          videoStartedAt = null;
          h264Failed = false;
          lastFpsCalcRef.current = performance.now();
          frameCountRef.current = netFrameCountRef.current = 0;
          jpegFallback = typeof VideoDecoder === "undefined" || typeof EncodedVideoChunk === "undefined";
          attachNativeVideo();
          setConnected(true);
          setConnectionError(null);
          const openUrl = currentUrlRef.current || initialUrlRef.current || "about:blank";
          ws.send(
            JSON.stringify({
              type: "attach",
              url: openUrl,
              video_codec: jpegFallback ? "jpeg" : "h264",
              sandbox_mode: sandboxMode,
            })
          );
          if (pendingNavigationRef.current) {
            ws.send(JSON.stringify({ type: "user_navigate", url: pendingNavigationRef.current }));
            pendingNavigationRef.current = null;
          }
        };

        ws.onclose = event => {
          if (isDisposed || activeWs !== ws) return;
          stopRtc(false, false);
          detachNativeVideo();
          decodeGeneration++;
          pendingJpeg = null;
          fallbackDecoderRef.current?.close();
          fallbackDecoderRef.current = null;
          nextVideoFrameRef.current?.close();
          nextVideoFrameRef.current = null;
          nextBitmapRef.current?.close();
          nextBitmapRef.current = null;
          setConnected(false);
          if (event.code === 1013) {
            setConnectionError(previous => previous || "The browser worker could not start. Check the worker and retry.");
            return;
          }
          if (event.code === 1008) {
            setConnectionError("This browser session is no longer authorized. Start a new chat or retry.");
            return;
          }
          // Automatic reconnection attempt after 2 seconds if canvas remains open
          reconnectTimeout = setTimeout(() => {
            reconnectTimeout = null;
            if (!isDisposed && isOpen) {
              connect();
            }
          }, 2000);
        };

        ws.onerror = (err) => {
          // Use console.warn instead of console.error so Next.js dev overlay does not pop up a full-screen fatal error
          console.warn("[BrowserCanvas] WebSocket connection notice:", err);
          if (!isDisposed && activeWs === ws) {
            setConnected(false);
          }
        };

        if (animId !== null) cancelAnimationFrame(animId);
        animId = null;
        // Present the newest decoded frame once per display refresh.
        const renderLoop = () => {
          animId = null;
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
            return;
          }

          const now = performance.now();
          paintCursor(now);

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
                  onPresented();
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
                  onPresented();
                }
              } catch {
              } finally {
                bitmap.close();
              }
            }
          }

          if (cursorMotionRef.current.active(now) || nextVideoFrameRef.current || nextBitmapRef.current) requestPresentation();
        };
        // Native video uses its compositor. Wake canvas/cursor work only when
        // there is a fresh frame or an active cursor glide, coalesced at vsync.
        requestPresentation = () => {
          if (!isDisposed && animId === null) animId = requestAnimationFrame(renderLoop);
        };
        requestPresentation();

        ws.onmessage = (evt) => {
          if (isDisposed || activeWs !== ws) return;
          lastPacketAt = performance.now();
          try {
            // Direct binary frame handling (16-byte header + worker / hardware decoding)
            if (evt.data instanceof ArrayBuffer) {
              if (rtcHasTrack || rtcActive) return;
              const buffer = evt.data;
              // While inspecting replay, ignore incoming live binary frames completely
              if (isPlaybackModeRef.current) {
                return;
              }

              // Direct main-thread decoding (zero-copy hardware acceleration, zero thread-hopping)
              let payloadOffset = 0;
              let seq = 0;
              let serverTs = 0;
              let metadata: Record<string, unknown> = {};
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
                  // Late snapshots are not stream resets. Resetting on reordered
                  // packets invalidated in-flight images and could starve painting.
                  if (seq > 0 && seq < lastFrameSeqRef.current) {
                    return;
                  } else if (seq > 0) {
                    lastFrameSeqRef.current = seq;
                  }
                  // Validate frame integrity or handle lightweight heartbeat packet (payload length 0)
                  if (payloadOffset >= buffer.byteLength) {
                    return;
                  }
                }
              }

              netFrameCountRef.current += 1;
              if (metadata.page) updateLivePage(metadata.page);
              if (metadata.codec === "h264" || metadata.codec === "avc1") {
                if (jpegFallback || h264Failed) return;
                if (videoStartedAt === null) {
                  // Session creation/navigation is not a decoder stall. Start
                  // the presentation watchdog only when video actually arrives.
                  videoStartedAt = lastPresentedAt = performance.now();
                }
                if (!fallbackDecoderRef.current) {
                  const decoderGeneration = decodeGeneration;
                  fallbackDecoderRef.current = new LiveVideoDecoder(frame => {
                    if (isDisposed || activeWs !== ws || decoderGeneration !== decodeGeneration || rtcHasTrack || isPlaybackModeRef.current) {
                      frame.close();
                      return;
                    }
                    if (nativeVideo) {
                      nativeVideo.push(frame);
                      return;
                    }
                    nextVideoFrameRef.current?.close();
                    nextVideoFrameRef.current = frame;
                    requestPresentation();
                  }, () => {
                    if (!isDisposed && activeWs === ws && decoderGeneration === decodeGeneration && !rtcHasTrack) recoverStream();
                  });
                }
                fallbackDecoderRef.current.push(new Uint8Array(buffer, payloadOffset),
                  Boolean(metadata.isKeyFrame), serverTs > 0 ? serverTs * 1000 : performance.now() * 1000);
                return;
              }

              // JPEG Fallback on Main Thread
              const jpegBlob = new Blob([new Uint8Array(buffer, payloadOffset)], { type: "image/jpeg" });
              recordFrame(jpegBlob);
              decodeJpeg(jpegBlob, seq);
              return;
            }

            const msg = JSON.parse(evt.data);
            if (msg.type === "stream_capabilities" && msg.browser_mode) actualMode = msg.browser_mode;
            if (msg.type === "browser_error") {
              setConnected(false);
              setConnectionError(msg.message);
              toast.error(msg.message);
              return;
            }
            if (msg.type === "stream_capabilities" && msg.webrtc && !rtc && videoRef.current &&
                typeof RTCPeerConnection !== "undefined" && typeof videoRef.current.requestVideoFrameCallback === "function") {
              const generation = ++rtcGeneration;
              const negotiationId = crypto.randomUUID();
              rtcNegotiationId = negotiationId;
              const ownsPeer = () => !isDisposed && activeWs === ws && generation === rtcGeneration;
              const failPeer = () => { if (ownsPeer()) stopRtc(); };
              rtc = createBrowserPeer(videoRef.current, message => {
                if (ownsPeer() && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ...message, negotiation_id: negotiationId }));
              }, () => {
                if (!ownsPeer() || isPlaybackModeRef.current) return;
                if (!rtcActive) {
                  detachNativeVideo();
                  fallbackDecoderRef.current?.close(); fallbackDecoderRef.current = null;
                  decodeGeneration++;
                  pendingJpeg = null;
                  nextVideoFrameRef.current?.close(); nextVideoFrameRef.current = null;
                  nextBitmapRef.current?.close(); nextBitmapRef.current = null;
                  rtcActive = true;
                  setTransport("WebRTC");
                  updateNativeVideoVisibility(true);
                }
                frameCountRef.current++;
                onPresented();
              }, failPeer, msg.ice_servers, () => {
                if (!ownsPeer()) return false;
                // Only one track owns the video element. Detach the generator
                // before RTC replaces srcObject, rather than at its first frame.
                detachNativeVideo();
                rtcHasTrack = true;
                decodeGeneration++;
                pendingJpeg = null;
                fallbackDecoderRef.current?.close(); fallbackDecoderRef.current = null;
                nextVideoFrameRef.current?.close(); nextVideoFrameRef.current = null;
                nextBitmapRef.current?.close(); nextBitmapRef.current = null;
                return true;
              });
              void rtc.offer().catch(failPeer);
            } else if (msg.type === "rtc_answer" && rtc) {
              if (msg.negotiation_id && msg.negotiation_id !== rtcNegotiationId) return;
              const generation = rtcGeneration;
              void rtc.answer(msg.sdp).catch(() => {
                if (!isDisposed && activeWs === ws && generation === rtcGeneration) stopRtc();
              });
            } else if (msg.type === "rtc_unavailable") {
              if (msg.negotiation_id && msg.negotiation_id !== rtcNegotiationId) return;
              stopRtc();
            } else if (msg.type === "input_applied" && typeof msg.id === "string") {
              latencyRef.current.applied(msg.id, msg.dispatch_ms);
            } else if (msg.type === "pong" && typeof msg.id === "string") {
              latencyRef.current.pong(msg.id);
            }
            if (msg.type === "frame" && msg.data) {
              if (rtcHasTrack || rtcActive || isPlaybackModeRef.current) {
                return;
              }
              const frameSeq = typeof msg.seq === "number" ? msg.seq : 0;
              const frameTime = typeof msg.timestamp === "number" ? msg.timestamp : Date.now();

              // Epoch changes arrive explicitly; older snapshots can be discarded.
              if (frameSeq > 0 && frameSeq < lastFrameSeqRef.current) {
                return;
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

                decodeJpeg(blob, frameSeq);
                netFrameCountRef.current += 1;
              } catch {
                // Ignore base64 decode errors on malformed payloads
              }
            } else if (msg.type === "stream_reset") {
              stopRtc(false);
              detachNativeVideo();
              livePage.reset();
              videoStartedAt = null;
              decodeGeneration++;
              pendingJpeg = null;
              lastFrameSeqRef.current = lastDrawnSeqRef.current = 0;
              fallbackDecoderRef.current?.close();
              fallbackDecoderRef.current = null;
              nextVideoFrameRef.current?.close();
              nextVideoFrameRef.current = null;
              nextBitmapRef.current?.close();
              nextBitmapRef.current = null;
              if (!jpegFallback) attachNativeVideo();
            } else if (msg.type === "cursor_action") {
              if (isPlaybackModeRef.current) {
                return;
              }
              if (typeof msg.x === "number" && typeof msg.y === "number") {
                cursorPosRef.current = { x: msg.x, y: msg.y };
                if (!cursorVisibleRef.current) {
                  cursorVisibleRef.current = true;
                  setCursorVisible(true);
                }
                const duration = reducedMotionRef.current || msg.action !== "move" ? 0
                  : typeof msg.duration_ms === "number" ? msg.duration_ms : 48;
                cursorMotionRef.current.move(msg.x, msg.y, performance.now(), duration);
                paintCursor(performance.now());
                requestPresentation();
              }
              if (msg.label) {
                if (cursorActionRef.current !== msg.label) {
                  cursorActionRef.current = msg.label;
                  setCursorAction(msg.label);
                }
                if (cursorLabelTimeout) clearTimeout(cursorLabelTimeout);
                cursorLabelTimeout = setTimeout(() => {
                  if (!isDisposed) {
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
                const timeout = setTimeout(() => {
                  rippleTimeouts.delete(timeout);
                  if (!isDisposed) {
                    const filtered = clickRipplesRef.current.filter((r) => r.id !== rippleId);
                    clickRipplesRef.current = filtered;
                    setClickRipples(filtered);
                  }
                }, 800);
                rippleTimeouts.add(timeout);
              }
            } else if (msg.type === "page_state") {
              if (!updateLivePage(msg)) return;
              if (Array.isArray(msg.elements)) {
                setElements(msg.elements);
                setIsRefreshingElements(false);
              }
            } else if (msg.type === "console" && msg.log) {
              setConsoleLogs((prev) => [...prev.slice(-100), msg.log]);
            } else if (msg.type === "navigated" && msg.url) {
              updateLivePage(msg);
            } else if (msg.type === "testing_completed") {
              if (recordedFramesRef.current.length >= 6) {
                setShowCompletionPrompt(true);
              }
            } else if (msg.type === "testing_stopped") {
              setShowCompletionPrompt(false);
            }
          } catch (e) {
            console.warn("[BrowserCanvas] Message parse warning:", e);
          }
        };
      } catch (err) {
        if (isDisposed || generation !== connectionGeneration) return;
        const response = (err as { response?: { status?: number; data?: { error?: string } } }).response;
        setConnected(false);
        setConnectionError(response?.status === 404
          ? "This chat is no longer available. Start a new chat to reconnect Live App."
          : response?.data?.error || "Could not connect to Live App. Check the connection and retry.");
      }
    };

    connect();
    let feedbackPending = false;
    const feedback = setInterval(async () => {
      const socket = activeWs;
      if (isDisposed || socket?.readyState !== WebSocket.OPEN || feedbackPending) return;
      feedbackPending = true;
      const metrics = latencyRef.current.snapshot();
      const framesPresented = presentedFeedbackRef.current;
      presentedFeedbackRef.current = 0;
      setInputLatencyMs(metrics.inputP95);
      setRttMs(metrics.rtt);
      const id = crypto.randomUUID();
      latencyRef.current.ping(id);
      socket.send(JSON.stringify({ type: "ping", id }));
      try {
        const rtcMetrics = await rtc?.metrics().catch(() => null);
        if (isDisposed || activeWs !== socket || socket.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify({ type: "stream_feedback", visible: !document.hidden && !isPlaybackModeRef.current,
          gap_ms: metrics.jitterP90, presentation_interval_ms: metrics.intervalMs,
          presentation_gap_ms: metrics.gapP90, frames_presented: framesPresented,
          jitter_buffer_ms: rtcMetrics?.jitterBufferMs ?? null, dropped_frames: rtcMetrics?.droppedFrames ?? 0,
          rtt_ms: metrics.rtt, decode_queue: fallbackDecoderRef.current?.queueSize ?? 0 }));
      } finally { feedbackPending = false; }
    }, 1000);
    const watchdog = setInterval(() => {
      if (isDisposed || isPlaybackModeRef.current || document.hidden) return;
      const now = performance.now();
      if (rtcActive && actualMode !== "host" && now - lastPresentedAt > 3000) stopRtc();
      if (!rtc && !jpegFallback && videoStartedAt !== null && now - lastPresentedAt > 2500) recoverStream();
      else if (now - lastPacketAt > 6000 && activeWs?.readyState === WebSocket.OPEN) activeWs.close();
    }, 1000);

    const handleBrowserStop = () => {
      setShowCompletionPrompt(false);
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
      setShowCompletionPrompt(false);
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
      clearInterval(feedback);
      if (cursorLabelTimeout) clearTimeout(cursorLabelTimeout);
      rippleTimeouts.forEach(clearTimeout);
      stopRtc(false);
      clearInterval(watchdog);
      decodeGeneration++;
      pendingJpeg = null;
      detachNativeVideo();
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
  }, [isOpen, getWsUrl, sandboxMode, connectionAttempt, paintCursor, updateNativeVideoVisibility]);

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

  useEffect(() => {
    const point = isPlaybackMode ? recordedFramesRef.current[playbackIndex]?.cursor : cursorPosRef.current;
    if (point) cursorMotionRef.current.move(point.x, point.y, performance.now(), 0);
    paintCursor(performance.now());
  }, [isPlaybackMode, playbackIndex, paintCursor]);

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
    if (!rect.width || !rect.height) return { x: 640, y: 360 };
    const scaleX = 1280 / rect.width;
    const scaleY = 720 / rect.height;
    return {
      x: Math.max(0, Math.min(1280, Math.round((e.clientX - rect.left) * scaleX))),
      y: Math.max(0, Math.min(720, Math.round((e.clientY - rect.top) * scaleY))),
    };
  }, []);

  // Handle direct User Clicks on the canvas
  const handleCanvasClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (isPlaybackMode) {
      setIsPlaying((p) => !p);
      return;
    }
    if (!takeOver || Date.now() < suppressClickUntilRef.current) return;
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const { x, y } = getCanvasCoords(e);
    sendInput({
        type: "user_click",
        x,
        y,
      });
    const rippleId = Date.now();
    setClickRipples((prev) => [...prev.slice(-4), { id: rippleId, x, y }]);
    setTimeout(() => {
      setClickRipples((prev) => prev.filter((r) => r.id !== rippleId));
    }, 800);
  };

  // Handle throttled mouse move to trigger live :hover styles in Chromium
  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (isPlaybackMode || !takeOver) return;
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

  const scrollRemotePage = (deltaY: number) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || !deltaY) return;
    sendInput({ type: "user_scroll", delta_y: Math.max(-720, Math.min(720, deltaY)) });
    if (showElementTags) setElements(prev => prev.map(el => ({ ...el, y: el.y - deltaY })));
    if (scrollDebounceRef.current) clearTimeout(scrollDebounceRef.current);
    scrollDebounceRef.current = setTimeout(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) sendInput({ type: "refresh_elements" });
    }, 120);
  };

  // Observing a zoomed view pans locally. Manual control sends a vertical
  // touch gesture to Chromium, with the same scaling as clicks and the cursor.
  const handleScreenPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!takeOver || isPlaybackMode || event.pointerType !== "touch") return;
    touchGestureRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, lastY: event.clientY, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const handleScreenPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = touchGestureRef.current;
    if (!gesture || gesture.id !== event.pointerId) return;
    if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 8) gesture.moved = true;
    if (!gesture.moved) return;
    const height = event.currentTarget.getBoundingClientRect().height;
    if (height) scrollRemotePage((gesture.lastY - event.clientY) * 720 / height);
    gesture.lastY = event.clientY;
  };
  const handleScreenPointerEnd = () => {
    if (touchGestureRef.current?.moved) suppressClickUntilRef.current = Date.now() + 500;
    touchGestureRef.current = null;
  };

  // Handle User Scroll
  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (isPlaybackMode) {
      const delta = Math.sign(e.deltaY);
      setPlaybackIndex((prev) => Math.max(0, Math.min(recordedFramesRef.current.length - 1, prev + delta * 2)));
      setIsPlaying(false);
      return;
    }
    if (!takeOver) return;
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 720 : 1;
    const deltaY = Math.max(-720, Math.min(720, e.deltaY * unit));
    if (!deltaY) return;
    scrollRemotePage(deltaY);
  };

  // Handle Manual URL Navigation
  const handleNavigate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    let target = urlInput.trim();
    if (!target.startsWith("http://") && !target.startsWith("https://")) {
      target = `http://${target}`;
    }
    urlEditingRef.current = false;
    urlDraftChangedRef.current = false;
    sendInput({
        type: "user_navigate",
        url: target,
      });
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
      data-browser-view
      data-mobile-surface
      className={cn(
        "flex min-h-0 min-w-0 flex-col border border-border/80 bg-background shadow-lg rounded-2xl overflow-hidden transition-colors duration-150",
        embedded ? "h-full w-full" : isMaximized ? "fixed inset-2 z-50 sm:inset-4" : "h-[min(640px,calc(100dvh-1rem))] w-full",
        className
      )}
    >
      {/* ─── Top Control Bar ─── */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-1 gap-y-1 px-2 py-1.5 sm:gap-y-2 sm:py-2 sm:px-3 border-b border-border/60 bg-muted/40 text-xs select-none">
        {/* Left: Status & Mode Badges */}
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1 sm:flex-none sm:gap-2">
          {!isPlaybackMode ? (
            <div title="Observed video presentation callbacks per second; a high rate alone does not prove smooth frame pacing." className="flex min-w-0 max-w-full items-center gap-1.5 px-2 py-1 rounded-md bg-background/80 border border-border/60 font-medium sm:flex-wrap">
              <span
                className={cn(
                  "h-2 w-2 rounded-full",
                  connected ? "bg-emerald-500 animate-pulse shadow-sm shadow-emerald-500/50" : "bg-amber-500"
                )}
              />
              <span className="truncate font-mono text-[11px] text-foreground/90">
                {connected ? (fps > 0 ? `Live • ${fps} fps · ${transport}` : networkFps > 0 ? "Recovering video…" : "Live • Idle") : connectionError ? "Browser unavailable" : "Connecting..."}
              </span>
              {connected && rttMs > 0 && (
                <>
                  <span className="hidden text-muted-foreground/60 sm:inline">•</span>
                  <span title={`Control round-trip time, measured on the client clock. Last WebSocket packet delivery estimate: ${latencyMs}ms; excludes capture/encoding/display and assumes synchronized clocks.`} className="hidden font-mono text-[10px] text-muted-foreground sm:inline">RTT {rttMs}ms</span>
                </>
              )}
              {connected && inputLatencyMs > 0 && (
                <span title="p95 input-to-next-presented-frame after acknowledgment. Includes dispatch and display waiting; does not prove the page visibly responded." className="hidden font-mono text-[10px] text-muted-foreground sm:inline">Input {inputLatencyMs}ms</span>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <Badge
                variant="outline"
                className="bg-purple-500/20 text-purple-300 border-purple-500/50 flex items-center gap-1.5 h-7 px-2.5 shadow-sm"
              >
                <Film className="h-3.5 w-3.5 text-purple-400 animate-pulse" />
                <span className="font-semibold text-xs">Replay Mode ({playbackSpeed}x)</span>
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
              className="hidden h-7 px-2.5 text-xs font-semibold gap-1.5 border-purple-500/50 bg-purple-500/10 hover:bg-purple-500/25 text-purple-300 transition-all shadow-sm sm:inline-flex"
              onClick={enterPlaybackMode}
              title="Watch session recording replay with AI cursor"
            >
              <Film className="h-3.5 w-3.5 text-purple-400" />
              <span>Replay ({recordedDurationSec}s)</span>
            </Button>
          )}

          {!isPlaybackMode && (
            <Button
              size="icon"
              variant={takeOver ? "default" : "outline"}
              className={cn(
                "hidden h-7 w-7 transition-all shadow-sm shrink-0 sm:inline-flex",
                takeOver
                  ? "bg-amber-500 hover:bg-amber-600 text-black border-amber-400"
                  : "bg-background/80 text-foreground/80 hover:text-foreground hover:bg-muted"
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
              title={takeOver ? "Human Driving (Click to return to AI Autopilot)" : "AI Driving (Click to take over manual control)"}
              aria-label={takeOver ? "Return control to AI" : "Take browser control"}
            >
              {takeOver ? (
                <User className="h-3.5 w-3.5 text-black" />
              ) : (
                <Bot className="h-3.5 w-3.5 text-sky-400" />
              )}
            </Button>
          )}

          {!isPlaybackMode && (
            <Button
              size="icon"
              variant="ghost"
              className="hidden h-7 w-7 text-muted-foreground hover:text-foreground sm:inline-flex"
              onClick={() => setShowElementTags(!showElementTags)}
              title={showElementTags ? "Hide Element IDs" : "Show Element IDs"}
              aria-label={showElementTags ? "Hide Element IDs" : "Show Element IDs"}
            >
              {showElementTags ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5 opacity-50" />}
            </Button>
          )}
        </div>

        {/* Center: Address Bar */}
        <form onSubmit={handleNavigate} className="order-last w-full min-w-0 sm:order-none sm:w-auto sm:flex-1 sm:min-w-[160px] max-w-xl sm:mx-2">
          <div className="relative flex items-center">
            <Globe className="absolute left-2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              value={isPlaybackMode ? (currentPlaybackFrame?.url || urlInput) : urlInput}
              onFocus={() => { urlEditingRef.current = true; urlDraftChangedRef.current = false; }}
              onBlur={() => {
                urlEditingRef.current = false;
                if (!urlDraftChangedRef.current) setUrlInput(currentUrlRef.current);
              }}
              onChange={(e) => { urlDraftChangedRef.current = true; setUrlInput(e.target.value); }}
              disabled={isPlaybackMode}
              placeholder="https://..."
              aria-label="Browser address"
              title={urlInput}
              className="h-11 pl-7 pr-11 font-mono text-[16px] bg-background/90 border-border/80 focus-visible:ring-1 focus-visible:ring-primary/40 rounded-md w-full truncate sm:h-7 sm:pr-7 sm:text-[11px]"
            />
            <button
              type="button"
              onClick={handleRefresh}
              className="absolute right-0 flex h-11 w-11 items-center justify-center text-muted-foreground hover:text-foreground transition-colors sm:right-1 sm:h-6 sm:w-6"
              title="Refresh DOM element tags"
              aria-label="Refresh browser elements"
            >
              <RefreshCw className={cn("h-3 w-3", isRefreshingElements && "animate-spin text-primary")} />
            </button>
          </div>
        </form>

        {/* Right: Window Controls */}
        <div className="flex items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button size="icon" variant="ghost" className="h-11 w-11 sm:hidden" aria-label="Browser options" />}>
              <ChevronDown className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52 [&>[role=menuitem]]:min-h-11">
              <DropdownMenuItem onClick={() => setTakeOver(value => !value)}><User className="h-4 w-4" />{takeOver ? "Return control to AI" : "Take browser control"}</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setShowElementTags(value => !value)}><Eye className="h-4 w-4" />{showElementTags ? "Hide Element IDs" : "Show Element IDs"}</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setShowConsole(value => !value)}><Terminal className="h-4 w-4" />{showConsole ? "Hide console" : "Show console"}</DropdownMenuItem>
              {hasRecording && !isPlaybackMode && <DropdownMenuItem onClick={enterPlaybackMode}><Film className="h-4 w-4" />Replay session</DropdownMenuItem>}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            size="sm"
            variant="ghost"
            className={cn(
              "hidden h-7 px-2 text-[11px] gap-1 text-muted-foreground hover:text-foreground sm:inline-flex",
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
              className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
              onClick={() => setIsMaximized(!isMaximized)}
              aria-label={isMaximized ? "Restore browser" : "Maximize browser"}
            >
              {isMaximized ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </Button>
          )}

          {onClose && (
            <Button
              size={closeLabel ? "sm" : "icon"}
              variant="ghost"
              className={cn("h-7 shrink-0 text-muted-foreground hover:text-foreground", closeLabel ? "gap-1.5 px-2 text-xs" : "w-7")}
              onClick={onClose}
              aria-label="Close browser"
            >
              <X className="h-3.5 w-3.5" />
              {closeLabel && <span>{closeLabel}</span>}
            </Button>
          )}
        </div>
      </div>

      {/* ─── Main Live View Area ─── */}
      <div
        ref={mainViewRef}
        data-browser-viewport
        className="relative min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain bg-zinc-950 p-0"
      >
        <div className="grid min-h-full min-w-full w-max place-items-center">
        <div
          data-browser-screen
          style={
            canvasDisplaySize
              ? { width: `${canvasDisplaySize.width}px`, height: `${canvasDisplaySize.height}px`, touchAction: takeOver ? "none" : "auto" }
              : undefined
          }
          className={cn(
            "relative select-none shrink-0",
            !canvasDisplaySize && "aspect-video w-full max-h-full",
            takeOver ? "cursor-crosshair" : "cursor-default"
          )}
          onClick={handleCanvasClick}
          onMouseMove={handleCanvasMouseMove}
          onWheel={handleWheel}
          onPointerDown={handleScreenPointerDown}
          onPointerMove={handleScreenPointerMove}
          onPointerUp={handleScreenPointerEnd}
          onPointerCancel={handleScreenPointerEnd}
        >
          {/* Hardware-accelerated Canvas with exact 1:1 pixel mapping */}
          <canvas
            ref={canvasRef}
            width={1280}
            height={720}
            className="w-full h-full block bg-zinc-950 shadow-inner"
          />
          <video
            ref={videoRef}
            autoPlay muted playsInline
            className="absolute inset-0 w-full h-full object-contain pointer-events-none"
            style={{ visibility: nativeVideoVisible && !isPlaybackMode ? "visible" : "hidden" }}
          />

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
            <div
              ref={attachCursorNode}
              data-browser-cursor=""
              aria-hidden="true"
              style={{
                visibility: (isPlaybackMode ? currentPlaybackFrame?.cursor.visible : cursorVisible && !takeOver) ? "visible" : "hidden",
                willChange: "transform",
              }}
              className="absolute left-0 top-0 pointer-events-none z-30"
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
                      "absolute left-5 -top-1 px-2 py-0.5 rounded-full text-[10px] font-mono whitespace-nowrap shadow-lg backdrop-blur-md animate-in fade-in zoom-in-95 duration-150 motion-reduce:animate-none flex items-center gap-1",
                      isPlaybackMode
                        ? "bg-purple-950/90 border border-purple-400/80 text-purple-200"
                        : "bg-sky-950/90 border border-sky-400/80 text-sky-200"
                    )}
                  >
                    <Zap className={cn("h-2.5 w-2.5", isPlaybackMode ? "text-purple-400" : "text-sky-400")} />
                    <span>{isPlaybackMode ? currentPlaybackFrame?.cursor.action : cursorAction}</span>
                  </div>
                )}
              </div>
            </div>

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
                <span className={`block rounded-full border-2 motion-reduce:animate-none ${ringClass}`} />
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
            <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-3 bg-background/90 text-muted-foreground backdrop-blur-sm" role="status" aria-live="polite">
              {connectionError ? (
                <>
                  <p className="px-6 text-center text-sm">{connectionError}</p>
                  <Button variant="outline" size="sm" onClick={() => setConnectionAttempt(attempt => attempt + 1)}>Retry connection</Button>
                </>
              ) : (
                <>
                  <Loader2 className="h-8 w-8 animate-spin text-primary" aria-hidden="true" />
                  <p className="text-xs font-mono">Connecting to Live Screencast...</p>
                </>
              )}
            </div>
          )}

          {/* ─── Floating Test Run Completion Banner ─── */}
          {showCompletionPrompt && !isPlaybackMode && hasRecording && (
            <div className="absolute bottom-4 left-1/2 max-w-full -translate-x-1/2 px-3 py-2 rounded-xl bg-purple-950/95 border border-purple-500/60 shadow-2xl backdrop-blur-md flex flex-wrap items-center gap-2 z-40 animate-in fade-in slide-in-from-bottom-3 duration-300">
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
      </div>

      <div data-browser-zoom className="flex shrink-0 items-center gap-1 border-t border-border/60 bg-muted/20 px-2 py-1 text-xs">
        <span className="mr-auto min-w-0 truncate text-muted-foreground">{takeOver ? "Manual control" : viewZoom > 1 ? "Swipe to pan" : "Live computer"}</span>
        {[1, 2, 3].map(zoom => <Button key={zoom} size="sm" variant={viewZoom === zoom ? "secondary" : "ghost"}
          className="h-7 px-2 text-xs" aria-pressed={viewZoom === zoom}
          aria-label={zoom === 1 ? "Fit browser to screen" : `Zoom browser ${zoom} times`}
          onClick={() => setViewZoom(zoom)}>{zoom === 1 ? "Fit" : `${zoom}×`}</Button>)}
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
            className="max-h-[40%] min-h-0 border-t border-border/70 bg-background/95 flex flex-col font-mono text-[11px] select-text shrink-0"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 border-b border-border/50 bg-muted/30">
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

            <div className="min-h-0 flex-1 p-2 overflow-y-auto space-y-1 font-mono text-[10.5px]">
              {consoleLogs
                .filter((l) => (consoleFilter === "error" ? l.type === "error" : true))
                .map((log, i) => (
                  <div
                    key={i}
                    className={cn(
                      "px-2.5 py-1.5 rounded-md leading-relaxed [overflow-wrap:anywhere] transition-colors",
                      log.type === "error"
                        ? "bg-destructive/10 text-destructive"
                        : log.type === "warn"
                        ? "bg-amber-500/10 text-amber-400"
                        : "bg-muted/20 text-foreground/80"
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
});
