"use client";
import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useAiSession } from "@/lib/use-ai-session";
const Browser = dynamic(() => import("@/components/InteractiveBrowserCanvas").then(m => m.InteractiveBrowserCanvas), { ssr: false });
// A phone cannot embed its host's localhost HTTP URL. Show the same runtime
// through the existing authenticated host browser, without making it public.
export function HostRuntimeView({ url, className }: {url: string; className?: string}) {
  const {activeSessionId, ensureSession} = useAiSession();
  const [error, setError] = useState("");
  useEffect(() => { let disposed = false; void ensureSession().catch(e => {if(!disposed)setError(e.message);}); return () => {disposed=true;}; }, [ensureSession]);
  return <div className={className || "h-full min-h-0 w-full"}>{activeSessionId ? <Browser sessionId={activeSessionId} initialUrl={url} sandboxMode="local" isOpen embedded /> : <p className="p-4 text-sm">{error || "Opening runtime on your StackPilot host..."}</p>}</div>;
}
