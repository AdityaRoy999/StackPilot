"use client";
// Copied to a temporary Next dev route only while running browser_stream_smoke.py.
import { useEffect, useState } from "react";
import { InteractiveBrowserCanvas } from "@/components/InteractiveBrowserCanvas";

export default function StreamFixture() {
  const [config, setConfig] = useState<{ session: string; url: string; mode: "local" | "remote" } | null>(null);
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    setConfig({ session: query.get("session") || "stream-qa", url: query.get("url") || "about:blank",
      mode: query.get("mode") === "remote" ? "remote" : "local" });
  }, []);
  return <div style={{ width: "100vw", height: "100vh" }}>
    {config && <InteractiveBrowserCanvas sessionId={config.session} initialUrl={config.url}
      sandboxMode={config.mode} isOpen embedded onClose={() => {}} />}
  </div>;
}
