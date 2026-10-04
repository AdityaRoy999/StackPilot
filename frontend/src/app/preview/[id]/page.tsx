"use client";
import { HostRuntimeView } from "@/components/HostRuntimeView";
import { useRemotePlatform } from "@/lib/use-remote-platform";

import React, { useState, useEffect, useRef, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import api from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Smartphone,
  RotateCw,
  ExternalLink,
  Copy,
  Check,
  QrCode,
  ArrowLeft,
  Wifi,
  BatteryCharging,
  Download,
  Terminal,
  Hash,
  Globe,
} from "@/lib/platform-icons";
import { ReactQRCode } from "@lglab/react-qr-code";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface Deployment {
  id: string;
  project_id: string;
  project_name: string;
  status: string;
  version: string;
  commit_hash?: string;
  runtime_url?: string;
  runtime_snapshot?: {
    runtime_url?: string;
    archetype?: string;
    archetype_details?: string;
    detected_subservices?: string[];
    test_evidence?: { artifacts?: string[] };
    mobile_metadata?: {
      framework?: string;
      app_name?: string;
      bundle_id?: string;
      sdk_version?: string;
      preview_strategy?: string;
      qr_target_url?: string;
    };
  };
}

type TestingMode = "simulator" | "download" | "qr" | "adb";
type DeviceModel = "pixel9" | "iphone16" | "tablet";
type ZoomMode = "fit" | "100" | "75" | "50";
type HostMode = "nip" | "ip" | "custom";

interface DeviceSpec {
  name: string;
  model: DeviceModel;
  portraitWidth: number;
  portraitHeight: number;
  screenRadius: string;
  outerRadius: string;
  bezelBorder: string;
  bezelColor: string;
  notchType: "dynamic-island" | "punch-hole" | "none";
}

const DEVICE_SPECS: Record<DeviceModel, DeviceSpec> = {
  pixel9: {
    name: "Pixel 9",
    model: "pixel9",
    portraitWidth: 412,
    portraitHeight: 860,
    screenRadius: "rounded-[38px]",
    outerRadius: "rounded-[46px]",
    bezelBorder: "border-[9px] border-zinc-800 shadow-2xl",
    bezelColor: "bg-zinc-950",
    notchType: "punch-hole",
  },
  iphone16: {
    name: "iPhone 16",
    model: "iphone16",
    portraitWidth: 393,
    portraitHeight: 852,
    screenRadius: "rounded-[48px]",
    outerRadius: "rounded-[54px]",
    bezelBorder: "border-[10px] border-zinc-800 shadow-2xl",
    bezelColor: "bg-zinc-950",
    notchType: "dynamic-island",
  },
  tablet: {
    name: "iPad Mini",
    model: "tablet",
    portraitWidth: 744,
    portraitHeight: 960,
    screenRadius: "rounded-[24px]",
    outerRadius: "rounded-[30px]",
    bezelBorder: "border-[14px] border-zinc-800 shadow-2xl",
    bezelColor: "bg-zinc-950",
    notchType: "none",
  },
};

export default function MobilePreviewStudioPage() {
  const remotePlatform = useRemotePlatform();
  const params = useParams();
  const router = useRouter();
  const deploymentId = params?.id as string;

  const [testMode, setTestMode] = useState<TestingMode>("simulator");
  const [device, setDevice] = useState<DeviceModel>("pixel9");
  const [orientation, setOrientation] = useState<"portrait" | "landscape">("portrait");
  const [zoomMode, setZoomMode] = useState<ZoomMode>("fit");
  const [calculatedFitScale, setCalculatedFitScale] = useState<number>(0.85);
  const [copiedUrl, setCopiedUrl] = useState<boolean>(false);
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);
  const [iframeKey, setIframeKey] = useState<number>(0);
  const [isLoadingIframe, setIsLoadingIframe] = useState<boolean>(true);
  const [iframeError, setIframeError] = useState<boolean>(false);

  // Network & nip.io settings to open on real phones
  const [hostMode, setHostMode] = useState<HostMode>("nip");
  const [customHost, setCustomHost] = useState<string>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("stackpilot_phone_host");
      if (saved) return saved;
      const h = window.location.hostname;
      if (h && h !== "localhost" && h !== "127.0.0.1") return h;
    }
    return "";
  });
  const [isEditingHost, setIsEditingHost] = useState<boolean>(false);
  const [hostInput, setHostInput] = useState<string>(customHost);

  const canvasRef = useRef<HTMLDivElement>(null);

  // Fetch deployment data
  const { data: deployment, isLoading: isFetchingDeployment } = useQuery<Deployment>({
    queryKey: ["deployment-preview", deploymentId],
    queryFn: async () => {
      try {
        const res = await api.get(`/deployments/${deploymentId}`);
        return res.data?.data || res.data;
      } catch {
        const res = await api.get("/deployments");
        const list = res.data?.deployments || res.data?.data || [];
        return list.find((d: Deployment) => d.id === deploymentId) || null;
      }
    },
    enabled: Boolean(deploymentId),
  });

  const rawRuntimeUrl =
    deployment?.runtime_url ||
    deployment?.runtime_snapshot?.runtime_url ||
    "";

  // Base runtime URL
  const runtimeUrl = useMemo(() => {
    return rawRuntimeUrl;
  }, [rawRuntimeUrl]);

  // Compute phone-accessible network URL using nip.io / LAN IP
  const phoneNetworkUrl = useMemo(() => {
    if (!customHost) return runtimeUrl;
    try {
      const url = new URL(runtimeUrl);
      const port = url.port ? `:${url.port}` : "";
      const pathname = url.pathname === "/" ? "" : url.pathname;
      const search = url.search;

      if (hostMode === "nip") {
        const cleanHost = customHost.replace(/\.nip\.io$/, "").trim();
        return `${url.protocol}//${cleanHost}.nip.io${port}${pathname}${search}`;
      }
      if (hostMode === "ip") {
        const cleanHost = customHost.replace(/\.nip\.io$/, "").trim();
        return `${url.protocol}//${cleanHost}${port}${pathname}${search}`;
      }
      if (hostMode === "custom") {
        if (customHost.startsWith("http://") || customHost.startsWith("https://")) {
          return `${customHost.replace(/\/$/, "")}${pathname}${search}`;
        }
        return `${url.protocol}//${customHost}${port}${pathname}${search}`;
      }
      return runtimeUrl;
    } catch {
      return runtimeUrl;
    }
  }, [runtimeUrl, hostMode, customHost]);

  const archetype = deployment?.runtime_snapshot?.archetype || "web";
  const mobileMetadata = deployment?.runtime_snapshot?.mobile_metadata;
  const isAndroid = archetype === "native_android" || archetype === "android_gradle";

  const appName = mobileMetadata?.app_name || deployment?.project_name || "Mobile App";
  const bundleId = mobileMetadata?.bundle_id || "Not reported by this build";
  const sdkVersion = mobileMetadata?.sdk_version || "Not reported by this build";
  const apkFileName = deployment?.runtime_snapshot?.test_evidence?.artifacts?.find((name) => name.endsWith('.apk')) || "";
  const phoneApkUrl = apkFileName ? `${phoneNetworkUrl.replace(/\/$/, '')}/artifacts/${encodeURIComponent(apkFileName)}` : runtimeUrl;

  const [qrType, setQrType] = useState<"apk" | "web">("apk");
  const activeQrTarget = qrType === "apk" && isAndroid ? phoneApkUrl : phoneNetworkUrl;

  const currentSpec = DEVICE_SPECS[device] || DEVICE_SPECS.pixel9;
  const deviceWidth = orientation === "portrait" ? currentSpec.portraitWidth : currentSpec.portraitHeight;
  const deviceHeight = orientation === "portrait" ? currentSpec.portraitHeight : currentSpec.portraitWidth;

  // Auto-calculate fit zoom scale
  useEffect(() => {
    function recalculateFit() {
      if (!canvasRef.current) return;
      const canvasHeight = canvasRef.current.clientHeight;
      const canvasWidth = canvasRef.current.clientWidth;

      const availHeight = Math.max(300, canvasHeight - 60);
      const availWidth = Math.max(300, canvasWidth - 60);

      const scaleH = availHeight / (deviceHeight + 24);
      const scaleW = availWidth / (deviceWidth + 24);

      const fit = Math.min(scaleH, scaleW, 1.0);
      setCalculatedFitScale(Math.max(0.4, Number(fit.toFixed(2))));
    }

    recalculateFit();
    window.addEventListener("resize", recalculateFit);
    return () => window.removeEventListener("resize", recalculateFit);
  }, [deviceHeight, deviceWidth, testMode]);

  const currentScale = useMemo(() => {
    if (zoomMode === "100") return 1.0;
    if (zoomMode === "75") return 0.75;
    if (zoomMode === "50") return 0.5;
    return calculatedFitScale;
  }, [zoomMode, calculatedFitScale]);

  const handleCopy = async (text: string, type: "url" | "cmd", cmdKey?: string) => {
    try {
      await navigator.clipboard.writeText(text);
      if (type === "url") {
        setCopiedUrl(true);
        toast.success("URL copied to clipboard!");
        setTimeout(() => setCopiedUrl(false), 2000);
      } else {
        setCopiedCmd(cmdKey || text);
        toast.success("Command copied to clipboard!");
        setTimeout(() => setCopiedCmd(null), 2000);
      }
    } catch {
      toast.error("Failed to copy to clipboard");
    }
  };

  const handleReload = () => {
    setIsLoadingIframe(true);
    setIframeError(false);
    setIframeKey((prev) => prev + 1);
  };

  const saveCustomHost = (host: string) => {
    const trimmed = host.trim();
    if (trimmed) {
      setCustomHost(trimmed);
      localStorage.setItem("stackpilot_phone_host", trimmed);
      setIsEditingHost(false);
      toast.success("Host address updated!");
    }
  };

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-zinc-950 font-sans text-zinc-100 select-none">
      {/* Minimal Monochrome Header */}
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-zinc-800/80 bg-zinc-950 px-4 z-30">
        {/* Left: Back button & Title */}
        <div className="flex items-center gap-3 min-w-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push("/dashboard/deployments")}
            className="h-7 px-2 text-xs text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900 gap-1.5"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Deployments</span>
          </Button>

          <div className="h-3.5 w-px bg-zinc-800 shrink-0" />

          <div className="flex items-center gap-2 min-w-0 truncate">
            <span className="text-xs font-medium text-zinc-200 truncate">{appName}</span>
            <span className="px-1.5 py-0.5 rounded text-[10px] font-mono text-zinc-500 bg-zinc-900 border border-zinc-800 shrink-0">
              {isAndroid ? "android" : archetype}
            </span>
          </div>
        </div>

        {/* Center: Minimal Segmented Mode Switcher */}
        <div className="flex items-center gap-0.5 rounded-lg border border-zinc-800/90 bg-zinc-900/60 p-0.5">
          <button
            type="button"
            onClick={() => setTestMode("simulator")}
            className={cn(
              "h-6 px-2.5 rounded-md text-xs transition-all",
              testMode === "simulator"
                ? "bg-zinc-800 text-zinc-100 font-medium shadow-sm"
                : "text-zinc-400 hover:text-zinc-200"
            )}
          >
            Web viewport
          </button>

          {isAndroid && (
            <button
              type="button"
              onClick={() => setTestMode("download")}
              className={cn(
                "h-6 px-2.5 rounded-md text-xs transition-all",
                testMode === "download"
                  ? "bg-zinc-800 text-zinc-100 font-medium shadow-sm"
                  : "text-zinc-400 hover:text-zinc-200"
              )}
            >
              Download APK
            </button>
          )}

          <button
            type="button"
            onClick={() => setTestMode("qr")}
            className={cn(
              "h-6 px-2.5 rounded-md text-xs transition-all",
              testMode === "qr"
                ? "bg-zinc-800 text-zinc-100 font-medium shadow-sm"
                : "text-zinc-400 hover:text-zinc-200"
            )}
          >
            QR Code
          </button>

          {isAndroid && (
            <button
              type="button"
              onClick={() => setTestMode("adb")}
              className={cn(
                "h-6 px-2.5 rounded-md text-xs transition-all",
                testMode === "adb"
                  ? "bg-zinc-800 text-zinc-100 font-medium shadow-sm"
                  : "text-zinc-400 hover:text-zinc-200"
              )}
            >
              ADB Sideload
            </button>
          )}
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-2 shrink-0">
          {testMode === "simulator" && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleReload}
              className="h-7 w-7 p-0 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900"
              title="Reload simulator"
            >
              <RotateCw className="h-3.5 w-3.5" />
            </Button>
          )}

          <a
            href={phoneNetworkUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-2 text-xs text-zinc-300 hover:text-white hover:bg-zinc-800 transition-colors"
            title="Open runtime in new tab"
          >
            <ExternalLink className="h-3 w-3" />
            <span className="hidden sm:inline text-[11px]">Open</span>
          </a>
        </div>
      </header>

      {/* Main Content Area */}
      <div className="flex-1 flex overflow-hidden relative">
        <div
          ref={canvasRef}
          className="flex-1 flex items-center justify-center p-4 overflow-y-auto relative bg-[radial-gradient(#27272a_1px,transparent_1px)] [background-size:20px_20px]"
        >
          {isFetchingDeployment ? (
            <div className="flex flex-col items-center gap-2 text-zinc-500 font-mono text-xs">
              <div className="h-5 w-5 animate-spin rounded-full border border-zinc-400 border-t-transparent" />
              <span>Loading deployment...</span>
            </div>
          ) : !runtimeUrl ? (
            <p className="text-sm text-zinc-400">No runtime preview is attached to this deployment.</p>
          ) : testMode === "simulator" && isAndroid ? (
            <div className="max-w-lg space-y-3 text-center text-sm text-zinc-300">
              <p>This native Android build requires a connected emulator or device worker for an interactive screen preview.</p>
              <p className="text-zinc-500">The browser viewport does not emulate Android. Build artifacts are available in the download view.</p>
              <Button onClick={() => setTestMode("download")}>View build artifacts</Button>
            </div>
          ) : testMode === "simulator" ? (
            /* =======================================================================
               MINIMAL SIMULATOR VIEW
            ======================================================================= */
            <div className="flex flex-col items-center justify-center gap-3 w-full h-full">
              {/* Device Selector Controls */}
              <div className="flex items-center gap-2 rounded-lg border border-zinc-800/80 bg-zinc-950/90 px-2.5 py-1 text-xs shadow-sm">
                <div className="flex items-center gap-1">
                  {(Object.keys(DEVICE_SPECS) as DeviceModel[]).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setDevice(m)}
                      className={cn(
                        "h-6 px-2 rounded text-[11px] transition-colors",
                        device === m
                          ? "bg-zinc-800 text-zinc-100 font-medium"
                          : "text-zinc-500 hover:text-zinc-300"
                      )}
                    >
                      {DEVICE_SPECS[m].name}
                    </button>
                  ))}
                </div>

                <div className="h-3 w-px bg-zinc-800" />

                <button
                  type="button"
                  onClick={() => setOrientation(orientation === "portrait" ? "landscape" : "portrait")}
                  className="h-6 px-1.5 rounded text-[11px] text-zinc-500 hover:text-zinc-200 transition-colors flex items-center gap-1"
                  title="Rotate orientation"
                >
                  <RotateCw className="h-3 w-3" />
                  <span className="capitalize">{orientation}</span>
                </button>

                <div className="h-3 w-px bg-zinc-800" />

                <div className="flex items-center gap-1">
                  {(['fit', '100', '75'] as ZoomMode[]).map((z) => (
                    <button
                      key={z}
                      type="button"
                      onClick={() => setZoomMode(z)}
                      className={cn(
                        "rounded px-1.5 py-0.5 text-[10px] transition-colors",
                        zoomMode === z ? "bg-zinc-800 text-zinc-200" : "text-zinc-500 hover:text-zinc-300"
                      )}
                    >
                      {z === 'fit' ? 'Fit' : `${z}%`}
                    </button>
                  ))}
                </div>
              </div>

              {/* Hardware Chassis */}
              <div
                className="transition-transform duration-300 ease-out origin-center flex items-center justify-center"
                style={{
                  transform: `scale(${currentScale})`,
                  width: `${deviceWidth + 20}px`,
                  height: `${deviceHeight + 20}px`,
                }}
              >
                <div
                  className={cn(
                    "relative flex items-center justify-center transition-all duration-300",
                    currentSpec.outerRadius,
                    currentSpec.bezelBorder,
                    currentSpec.bezelColor
                  )}
                  style={{
                    width: `${deviceWidth}px`,
                    height: `${deviceHeight}px`,
                  }}
                >
                  {/* Screen Viewport */}
                  <div
                    className={cn(
                      "relative w-full h-full overflow-hidden bg-black flex flex-col",
                      currentSpec.screenRadius
                    )}
                  >
                    {/* Status Bar */}
                    <div className="relative z-20 flex h-9 w-full shrink-0 items-center justify-between px-6 pt-1 text-[11px] font-mono text-zinc-400 select-none">
                      <span>9:41</span>
                      {currentSpec.notchType === "dynamic-island" && (
                        <div className="absolute left-1/2 top-2 -translate-x-1/2 h-5 w-24 rounded-full bg-black border border-zinc-800 flex items-center justify-between px-2">
                          <div className="h-2 w-2 rounded-full bg-zinc-900 border border-zinc-800" />
                          <div className="h-1.5 w-1.5 rounded-full bg-zinc-600" />
                        </div>
                      )}
                      {currentSpec.notchType === "punch-hole" && (
                        <div className="absolute left-1/2 top-2 -translate-x-1/2 h-3 w-3 rounded-full bg-black border border-zinc-800" />
                      )}
                      <div className="flex items-center gap-1.5 text-zinc-400">
                        <Wifi className="h-3 w-3" />
                        <BatteryCharging className="h-3 w-3" />
                      </div>
                    </div>

                    {/* Viewport Iframe */}
                    <div className="relative flex-1 w-full h-full bg-zinc-950 overflow-hidden">
                      {isLoadingIframe && !remotePlatform && (
                        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-zinc-950/80 backdrop-blur-sm gap-2 text-zinc-500 font-mono text-xs">
                          <div className="h-5 w-5 animate-spin rounded-full border border-zinc-400 border-t-transparent" />
                          <span>Loading runtime...</span>
                        </div>
                      )}

                      {remotePlatform ? <HostRuntimeView key={iframeKey} url={runtimeUrl} /> : iframeError ? (
                        <div className="flex flex-col items-center justify-center h-full p-6 text-center text-zinc-500 font-mono text-xs gap-2">
                          <Smartphone className="h-8 w-8 text-zinc-600 stroke-[1.5]" />
                          <p className="text-zinc-300 font-medium">Container Offline or Non-Web</p>
                          <p className="text-[11px] text-zinc-500 max-w-xs">
                            {isAndroid
                              ? "This is a Native Android binary. Use the Download APK or ADB Sideload tab to run on your device."
                              : `Unable to connect to ${runtimeUrl}. The container may still be booting.`}
                          </p>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={handleReload}
                            className="mt-2 h-7 text-xs border-zinc-800 text-zinc-300 hover:bg-zinc-900"
                          >
                            <RotateCw className="h-3 w-3 mr-1.5" /> Retry Connection
                          </Button>
                        </div>
                      ) : (
                        <iframe
                          key={iframeKey}
                          src={runtimeUrl}
                          onLoad={() => setIsLoadingIframe(false)}
                          onError={() => setIframeError(true)}
                          title="StackPilot Mobile Simulator"
                          className="w-full h-full border-0 bg-zinc-950"
                          allow="accelerometer; camera; encrypted-media; geolocation; gyroscope; microphone; midi; clipboard-read; clipboard-write;"
                        />
                      )}
                    </div>

                    {/* Home Indicator */}
                    <div className="relative z-20 flex h-4 w-full shrink-0 items-center justify-center pb-1">
                      <div className="h-1 w-28 rounded-full bg-zinc-700" />
                    </div>
                  </div>
                </div>
              </div>

              {/* Bottom Network URL Indicator */}
              <div className="flex items-center gap-2 text-[11px] font-mono text-zinc-500">
                <span>Preview URL (phone reachability requires routing):</span>
                <span className="text-zinc-300 bg-zinc-900 px-2 py-0.5 rounded border border-zinc-800">
                  {phoneNetworkUrl}
                </span>
                <button
                  type="button"
                  onClick={() => handleCopy(phoneNetworkUrl, "url")}
                  className="text-zinc-400 hover:text-zinc-100 p-1 rounded hover:bg-zinc-900"
                  title="Copy phone URL"
                >
                  {copiedUrl ? <Check className="h-3 w-3 text-zinc-200" /> : <Copy className="h-3 w-3" />}
                </button>
              </div>
            </div>
          ) : testMode === "download" ? (
            /* =======================================================================
               MINIMAL DOWNLOAD APK VIEW
            ======================================================================= */
            <div className="max-w-xl w-full flex flex-col gap-4 py-4">
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/90 p-6 shadow-xl space-y-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-sm font-semibold text-zinc-100">{appName}</h2>
                    <p className="text-xs font-mono text-zinc-500 mt-0.5">{bundleId}</p>
                  </div>
                  <a
                    href={phoneApkUrl}
                    download={apkFileName}
                    className="inline-flex items-center gap-2 rounded-lg bg-white px-4 py-2 text-xs font-medium text-zinc-950 hover:bg-zinc-200 transition-colors shadow-sm"
                  >
                    <Download className="h-3.5 w-3.5" />
                      <span>{apkFileName ? "Download APK" : "Open build artifacts"}</span>
                  </a>
                </div>

                {/* Spec details grid */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs font-mono">
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-2.5">
                    <span className="text-[10px] text-zinc-500 uppercase">Format</span>
                    <p className="mt-0.5 text-zinc-200 font-medium">Android APK</p>
                  </div>
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-2.5">
                    <span className="text-[10px] text-zinc-500 uppercase">Target SDK</span>
                    <p className="mt-0.5 text-zinc-200 font-medium">{sdkVersion}</p>
                  </div>
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-2.5">
                    <span className="text-[10px] text-zinc-500 uppercase">Architecture</span>
                    <p className="mt-0.5 text-zinc-200 font-medium">Universal</p>
                  </div>
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-2.5">
                    <span className="text-[10px] text-zinc-500 uppercase">Variant</span>
                    <p className="mt-0.5 text-zinc-200 font-medium">Debug</p>
                  </div>
                </div>

                {/* Sideload Guide */}
                <div className="border-t border-zinc-800 pt-4 space-y-2.5 text-xs text-zinc-400">
                  <span className="text-[11px] font-medium text-zinc-300 uppercase tracking-wide">
                    Sideloading Guide
                  </span>
                  <div className="space-y-1.5 font-mono text-[11px]">
                    <p>1. Download the APK onto your Android device or transfer via USB.</p>
                    <p>2. Open Files or Downloads on the phone and tap <strong>{apkFileName}</strong>.</p>
                    <p>3. Allow &quot;Install unknown apps&quot; if prompted by Android Settings.</p>
                    <p>4. Tap Install to run the application.</p>
                  </div>
                </div>
              </div>
            </div>
          ) : testMode === "qr" ? (
            /* =======================================================================
               BEAUTIFUL WHITE QR CODE VIEW (@lglab/react-qr-code + nip.io)
            ======================================================================= */
            <div className="max-w-md w-full flex flex-col items-center gap-4 py-4">
              <div className="w-full rounded-2xl border border-zinc-800 bg-zinc-900/95 p-6 shadow-2xl text-center flex flex-col items-center">
                <h2 className="text-sm font-semibold text-zinc-100">Scan with Phone Camera</h2>
                <p className="text-xs text-zinc-400 mt-1 max-w-xs">
                  Point your phone camera at this code to open directly over Wi-Fi.
                </p>

                {/* Android Target Switcher */}
                {isAndroid && (
                  <div className="mt-3 flex rounded-lg border border-zinc-800 bg-zinc-950 p-0.5 w-full max-w-xs">
                    <button
                      type="button"
                      onClick={() => setQrType("apk")}
                      className={cn(
                        "flex-1 py-1 text-xs rounded font-medium transition-all",
                        qrType === "apk"
                          ? "bg-zinc-800 text-zinc-100 shadow"
                          : "text-zinc-500 hover:text-zinc-300"
                      )}
                    >
                      Direct APK Download
                    </button>
                    <button
                      type="button"
                      onClick={() => setQrType("web")}
                      className={cn(
                        "flex-1 py-1 text-xs rounded font-medium transition-all",
                        qrType === "web"
                          ? "bg-zinc-800 text-zinc-100 shadow"
                          : "text-zinc-500 hover:text-zinc-300"
                      )}
                    >
                      Web App
                    </button>
                  </div>
                )}

                {/* Beautiful Pure-White QR Code with @lglab/react-qr-code */}
                <div className="mt-5 rounded-2xl border border-zinc-800 bg-zinc-950 p-4 shadow-xl flex items-center justify-center">
                  <div className="p-2 bg-zinc-950 rounded-xl border border-zinc-900 flex items-center justify-center">
                    <ReactQRCode
                      value={activeQrTarget}
                      size={220}
                      background="#09090b"
                      dataModulesSettings={{
                        color: "#FFFFFF",
                        style: "rounded",
                      }}
                      finderPatternOuterSettings={{
                        color: "#FFFFFF",
                        style: "rounded-sm",
                      }}
                      finderPatternInnerSettings={{
                        color: "#FFFFFF",
                        style: "rounded-sm",
                      }}
                      marginSize={2}
                    />
                  </div>
                </div>

                {/* Target URL with Copy Button */}
                <div className="mt-4 w-full flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950 p-1.5 text-left font-mono">
                  <span className="px-1.5 text-[10px] uppercase font-bold text-zinc-500 shrink-0">URL</span>
                  <input
                    type="text"
                    readOnly
                    value={activeQrTarget}
                    className="flex-1 bg-transparent px-1 text-xs text-zinc-300 outline-none select-all truncate"
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => handleCopy(activeQrTarget, "url")}
                    className="h-7 px-2 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900 shrink-0"
                  >
                    {copiedUrl ? <Check className="h-3.5 w-3.5 text-zinc-200" /> : <Copy className="h-3.5 w-3.5" />}
                  </Button>
                </div>

                {/* Host & nip.io Network Resolver Controls */}
                <div className="mt-4 w-full border-t border-zinc-800/80 pt-3 text-left space-y-2">
                  <div className="flex items-center justify-between text-[11px] text-zinc-400">
                    <span>Network Address Mode</span>
                    <div className="flex items-center gap-1 font-mono">
                      <button
                        type="button"
                        onClick={() => setHostMode("nip")}
                        className={cn(
                          "px-2 py-0.5 rounded text-[10px] transition-colors",
                          hostMode === "nip"
                            ? "bg-zinc-800 text-zinc-100 font-medium"
                            : "text-zinc-500 hover:text-zinc-300"
                        )}
                      >
                        nip.io
                      </button>
                      <button
                        type="button"
                        onClick={() => setHostMode("ip")}
                        className={cn(
                          "px-2 py-0.5 rounded text-[10px] transition-colors",
                          hostMode === "ip"
                            ? "bg-zinc-800 text-zinc-100 font-medium"
                            : "text-zinc-500 hover:text-zinc-300"
                        )}
                      >
                        LAN IP
                      </button>
                      <button
                        type="button"
                        onClick={() => setHostMode("custom")}
                        className={cn(
                          "px-2 py-0.5 rounded text-[10px] transition-colors",
                          hostMode === "custom"
                            ? "bg-zinc-800 text-zinc-100 font-medium"
                            : "text-zinc-500 hover:text-zinc-300"
                        )}
                      >
                        Tunnel
                      </button>
                    </div>
                  </div>

                  {/* Host IP Config */}
                  <div className="flex items-center gap-1.5 text-xs font-mono bg-zinc-950 p-1.5 rounded-lg border border-zinc-800">
                    <Globe className="h-3.5 w-3.5 text-zinc-500 shrink-0 ml-1" />
                    {isEditingHost ? (
                      <div className="flex items-center gap-1 flex-1 min-w-0">
                        <input
                          type="text"
                          value={hostInput}
                          onChange={(e) => setHostInput(e.target.value)}
                          placeholder="e.g. 172.20.10.2 or ngrok URL"
                          className="flex-1 bg-transparent text-xs text-zinc-200 outline-none px-1 border-b border-zinc-700"
                        />
                        <button
                          type="button"
                          onClick={() => saveCustomHost(hostInput)}
                          className="px-2 py-0.5 text-[10px] rounded bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
                        >
                          Save
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between flex-1 min-w-0 pr-1">
                        <span className="text-zinc-400 text-[11px] truncate">
                          {hostMode === "nip" ? `${customHost}.nip.io` : customHost}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            setHostInput(customHost);
                            setIsEditingHost(true);
                          }}
                          className="text-[10px] text-zinc-500 hover:text-zinc-300 underline"
                        >
                          Change IP
                        </button>
                      </div>
                    )}
                  </div>
                  <p className="text-[10px] text-zinc-500 leading-normal">
                    {hostMode === "nip"
                      ? "Using nip.io: resolves host machine IP directly across local Wi-Fi or mobile hotspots."
                      : hostMode === "ip"
                      ? "Direct LAN IP: connect your phone to the same Wi-Fi network."
                      : "Custom / Tunnel: paste an ngrok or public domain."}
                  </p>
                </div>
              </div>
            </div>
          ) : (
            /* =======================================================================
               MINIMAL ADB COMMANDS VIEW
            ======================================================================= */
            <div className="max-w-xl w-full flex flex-col gap-3 py-4">
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/90 p-5 shadow-xl space-y-4 text-xs font-mono">
                <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
                  <div>
                    <h2 className="text-sm font-semibold text-zinc-200 font-sans">ADB Sideload & Terminal</h2>
                    <p className="text-[11px] text-zinc-500 mt-0.5">Commands for connected Android devices or emulators.</p>
                  </div>
                </div>

                {/* Command 1 */}
                <div className="space-y-1.5 rounded-lg border border-zinc-800 bg-zinc-950 p-3">
                  <div className="flex items-center justify-between text-zinc-400 text-[11px]">
                    <span>1. Install APK directly</span>
                    <button
                      type="button"
                      onClick={() => handleCopy(`adb install -r ${apkFileName}`, "cmd", "cmd1")}
                      className="hover:text-zinc-100 flex items-center gap-1"
                    >
                      {copiedCmd === "cmd1" ? <Check className="h-3 w-3 text-zinc-200" /> : <Copy className="h-3 w-3" />}
                      <span>Copy</span>
                    </button>
                  </div>
                  <pre className="text-zinc-200 bg-zinc-900 p-2 rounded text-[11px] overflow-x-auto">
                    adb install -r {apkFileName}
                  </pre>
                </div>

                {/* Command 2 */}
                <div className="space-y-1.5 rounded-lg border border-zinc-800 bg-zinc-950 p-3">
                  <div className="flex items-center justify-between text-zinc-400 text-[11px]">
                    <span>2. Download from StackPilot & Install</span>
                    <button
                      type="button"
                      onClick={() => handleCopy(`curl -sLO ${phoneApkUrl} && adb install -r ${apkFileName}`, "cmd", "cmd2")}
                      className="hover:text-zinc-100 flex items-center gap-1"
                    >
                      {copiedCmd === "cmd2" ? <Check className="h-3 w-3 text-zinc-200" /> : <Copy className="h-3 w-3" />}
                      <span>Copy</span>
                    </button>
                  </div>
                  <pre className="text-zinc-200 bg-zinc-900 p-2 rounded text-[11px] overflow-x-auto">
                    curl -sLO {phoneApkUrl} && adb install -r {apkFileName}
                  </pre>
                </div>

                {/* Command 3 */}
                <div className="space-y-1.5 rounded-lg border border-zinc-800 bg-zinc-950 p-3">
                  <div className="flex items-center justify-between text-zinc-400 text-[11px]">
                    <span>3. Launch Activity</span>
                    <button
                      type="button"
                      onClick={() => handleCopy(`adb shell monkey -p ${bundleId} -c android.intent.category.LAUNCHER 1`, "cmd", "cmd3")}
                      className="hover:text-zinc-100 flex items-center gap-1"
                    >
                      {copiedCmd === "cmd3" ? <Check className="h-3 w-3 text-zinc-200" /> : <Copy className="h-3 w-3" />}
                      <span>Copy</span>
                    </button>
                  </div>
                  <pre className="text-zinc-200 bg-zinc-900 p-2 rounded text-[11px] overflow-x-auto">
                    adb shell monkey -p {bundleId} -c android.intent.category.LAUNCHER 1
                  </pre>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
