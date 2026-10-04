"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, ShieldCheck, Square } from "@/lib/platform-icons";
import { isRemotePlatform } from "@/lib/remote-platform";
import { remoteRunRequest, type RemoteRun, type RemoteRunBatch } from "@/lib/remote-agent";
import { applyRemoteEvents, emptyProgress, type RemoteProgress, type RemoteEvent } from "@/lib/remote";
import type { AgentStreamEvent } from "@/lib/stream-agent";
import api from "@/lib/api";

interface Props {
  sessionId: string; busy: boolean;
  onWorking: (working: boolean) => void;
  onSettled: () => void;
  onPermission: (event: Extract<AgentStreamEvent, { type: "permission_request" }>) => void;
  onQuestion: (event: Extract<AgentStreamEvent, { type: "agent_question" }>) => void;
}
// Navigation only detaches the phone. Restore the host's existing run and its
// exact approval/question; never dispatch a second run to recover the screen.
export function RemoteRunRecovery(props: Props) {
  const latest = useRef(props);
  useEffect(() => { latest.current = props; });
  const [run, setRun] = useState<RemoteRun | null>(null);
  const [progress, setProgress] = useState<RemoteProgress>(emptyProgress);
  const [error, setError] = useState("");
  const [acting, setActing] = useState(false);
  const { sessionId, busy } = props;
  useEffect(() => {
    if (!isRemotePlatform() || !sessionId || busy) return;
    let disposed = false; let timer: ReturnType<typeof setTimeout>;
    let saved = emptyProgress; let selected = ""; let state = ""; let restoredQuestion = ""; let restoredPermission = "";
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const list = await remoteRunRequest<{ runs: RemoteRun[] }>("/runs", controller.signal);
        const current = list.runs.find(r => r.session_id === sessionId);
        if (disposed) return;
        if (!current || !["working", "awaiting_approval", "awaiting_input", "interrupted"].includes(current.state)) {
          if (selected && state === "working") latest.current.onSettled();
          setRun(null); latest.current.onWorking(false);
        } else {
          if (selected !== current.id) { selected = current.id; saved = emptyProgress; }
          const batch = await remoteRunRequest<RemoteRunBatch>(`/runs/${selected}?after=${saved.cursor}`, controller.signal);
          if (disposed) return;
          saved = applyRemoteEvents(saved, batch.events as RemoteEvent[]);
          setProgress(saved); setRun(batch.run);
          latest.current.onWorking(batch.run.state === "working");
          if (state === "working" && batch.run.state !== state) latest.current.onSettled();
          state = batch.run.state;
          if (state === "awaiting_input" && saved.question && restoredQuestion !== selected) {
            restoredQuestion = selected;
            latest.current.onQuestion(saved.question as Extract<AgentStreamEvent, {type: "agent_question"}>);
          }
          if (state === "awaiting_approval" && saved.approval && restoredPermission !== selected) {
            restoredPermission=selected;
            latest.current.onPermission(saved.approval as Extract<AgentStreamEvent,{type:"permission_request"}>);
          }
          // Drain long event histories immediately before settling into polling.
          if (saved.cursor < Number(batch.run.last_sequence)) { timer = setTimeout(refresh, 0); return; }
        }
        setError("");
      } catch (e) { if (!disposed) setError(e instanceof Error ? e.message : "Could not restore host activity."); }
      if (!disposed) timer = setTimeout(refresh, 2000);
    };
    void refresh();
    return () => { disposed = true; controller.abort(); clearTimeout(timer); latest.current.onWorking(false); };
  }, [sessionId, busy]);

  if (!isRemotePlatform() || busy || (!run && !error) || (run?.state === "awaiting_approval" && !error)) return null;
  const approval = run?.state === "awaiting_approval" ? progress.approval : null;
  async function stop() {
    setActing(true);
    try { await api.post("/ai/chat/stop", { session_id: sessionId }); setRun(null); latest.current.onWorking(false); latest.current.onSettled(); }
    catch { setError("The host did not confirm stopping. Check its connection."); }
    finally { setActing(false); }
  }
  return <section className="mb-4 space-y-3 rounded-xl border bg-card p-4" aria-label="Host activity">
    <div className="flex flex-wrap items-center gap-2 text-sm font-medium">{run?.state === "working" ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}{run?.state === "working" ? "Continuing on your StackPilot host" : run?.state === "interrupted" ? "Host work was interrupted" : "Host activity restored"}
      {run && run.state !== "interrupted" && <Button className="ml-auto" size="sm" variant="outline" disabled={acting} onClick={() => void stop()}><Square className="size-3" />{approval ? "Decline" : "Stop"}</Button>}
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {run?.state === "working" && progress.content && <p className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-sm">{progress.content}</p>}
    {run?.state === "interrupted" && <p className="text-sm text-muted-foreground">Check the last actions in chat history before continuing. No action was automatically replayed.</p>}
  </section>;
}
