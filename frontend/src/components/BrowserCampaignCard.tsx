"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { ChatMarkdown } from "@/components/ui/chat-markdown";
import { campaignEnded, campaignFetch, campaignStatus, controlCampaign, recordingManifest,
  type CampaignEvent, type CampaignStatus, type RecordingFrame } from "@/lib/browser-campaign";

function count(status: CampaignStatus | null, kind: string, state?: string) {
  return status?.tasks.filter(task => task.kind === kind && (!state || task.state === state)).reduce((sum, task) => sum + task.count, 0) || 0;
}

export function BrowserCampaignCard({ sessionId, campaignId }: { sessionId: string; campaignId: string }) {
  const [status, setStatus] = useState<CampaignStatus | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [request, setRequest] = useState<CampaignEvent | null>(null);
  const [answer, setAnswer] = useState("");
  const [report, setReport] = useState<Array<{ kind: string; state: string; task: { label?: string; url?: string }; result?: { summary?: string } }> | null>(null);
  const [reportOffset, setReportOffset] = useState<number | null>(0);
  const [frames, setFrames] = useState<RecordingFrame[]>([]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [image, setImage] = useState("");
  const cursor = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    cursor.current = 0;
    const poll = async () => {
      try {
        const next = await campaignStatus(sessionId, campaignId, cursor.current, controller.signal);
        if (controller.signal.aborted) return;
        for (const event of next.events) {
          cursor.current = Math.max(cursor.current, event.sequence);
          if (["permission_request", "agent_question"].includes(event.type)) setRequest(event);
        }
        if (next.pending_request) setRequest(next.pending_request);
        else if (!["waiting_for_permission", "waiting_for_input"].includes(next.state)) setRequest(null);
        setStatus(next); setNotice("");
        // Drain backlogged evidence before settling into the slower status poll.
        if (!campaignEnded(next.state) || next.events.length === 100) timer = setTimeout(poll, next.events.length === 100 ? 100 : 3000);
      } catch (error) {
        if (!controller.signal.aborted) {
          setNotice(error instanceof Error ? error.message : "Could not load campaign progress.");
          timer = setTimeout(poll, 5000);
        }
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [sessionId, campaignId]);

  useEffect(() => {
    if (!frames[index]) return;
    const controller = new AbortController();
    let objectUrl = "";
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const response = await campaignFetch(sessionId, campaignId, `/recording/${frames[index].sequence}`, { signal: controller.signal });
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob); setImage(objectUrl);
        if (playing && index < frames.length - 1) {
          const delay = Math.max(50, (frames[index + 1].timestamp - frames[index].timestamp) * 1000);
          timer = setTimeout(() => setIndex(value => value + 1), delay);
        } else if (playing) setPlaying(false);
      } catch (error) {
        if (!controller.signal.aborted) { setPlaying(false); setNotice(error instanceof Error ? error.message : "Recording unavailable."); }
      }
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [frames, index, playing, sessionId, campaignId]);

  async function control(action: string, data: { message?: string; approval_token?: string } = {}) {
    setBusy(true);
    try { setStatus(await controlCampaign(sessionId, campaignId, action, data)); setNotice(""); setRequest(null); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Campaign control failed."); }
    finally { setBusy(false); }
  }

  async function viewReport(offset = 0) {
    setBusy(true);
    try { const result = await (await campaignFetch(sessionId, campaignId, `/report?offset=${offset}`)).json(); setReport(result.tasks); setReportOffset(result.next_offset); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Report unavailable."); }
    finally { setBusy(false); }
  }

  async function replay() {
    setBusy(true);
    try { setFrames(await recordingManifest(sessionId, campaignId)); setIndex(0); setPlaying(true); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Recording unavailable."); }
    finally { setBusy(false); }
  }

  const ended = status && campaignEnded(status.state);
  const waiting = status?.state === "waiting_for_permission" || status?.state === "waiting_for_input";
  return <section aria-label="Background website test" className="my-3 min-w-0 rounded-xl border border-border bg-muted/20 p-3 text-xs sm:p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <strong>Website test campaign</strong><span className="text-muted-foreground capitalize">{status?.state.replaceAll("_", " ") || "Connecting…"}</span>
    </div>
    <p className="mt-2 text-muted-foreground">{count(status, "page", "completed")} / {count(status, "page")} pages explored · {count(status, "workflow", "completed")} / {count(status, "workflow")} workflows verified</p>
    {!!count(status, "workflow", "unverified") && <p className="mt-1 text-muted-foreground">{count(status, "workflow", "unverified")} workflows remain unverified.</p>}
    {status?.reason && <p className="mt-2 leading-relaxed text-muted-foreground">{status.reason}</p>}
    <div className="mt-3 flex flex-wrap gap-2">
      {!ended && status?.state === "running" && <Button size="sm" variant="outline" disabled={busy} onClick={() => void control("pause")}>Pause</Button>}
      {!ended && status?.state === "paused" && <Button size="sm" variant="outline" disabled={busy} onClick={() => void control("resume")}>Resume</Button>}
      {!ended && status?.state === "needs_reconciliation" && <Button size="sm" variant="outline" disabled={busy} onClick={() => void control("reconcile")}>Inspect interrupted workflow</Button>}
      {!ended && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void control("cancel")}>Stop</Button>}
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void viewReport()}>Results</Button>
      <Button size="sm" variant="outline" disabled={busy || !ended || !status?.recording.count} onClick={() => void replay()}>Replay</Button>
    </div>
    {waiting && request && <section aria-label="Campaign question or permission" className="mt-3 rounded-lg border border-border bg-background/70 p-3">
      <strong>{request.type === "permission_request" ? "Permissions" : "Question"}</strong>
      <p className="mt-1 break-words">{request.browser_step?.label || request.question || request.description}</p>
      {request.fields?.map(field => <p key={field.id} className="mt-1 text-muted-foreground">{field.label}{field.options?.length ? `: ${field.options.join(" / ")}` : ""}</p>)}
      {request.type === "permission_request" ? <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => void control("answer", { approval_token: request.token })}>Approve & continue</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void control("answer", { message: "Review the current live step and request a fresh exact approval before dispatching it." })}>Refresh review</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void control("answer", { message: "Declined this step. Do not execute it; record it as skipped and continue other safe work." })}>Decline</Button>
      </div> : <form onSubmit={event => { event.preventDefault(); void control("answer", { message: answer }); }}>
        <textarea aria-label="Answer campaign question" value={answer} onChange={event => setAnswer(event.target.value)} className="mt-2 w-full rounded-md border border-border bg-background p-2" />
        <Button size="sm" disabled={busy || !answer.trim()} type="submit">Continue</Button>
      </form>}
    </section>}
    {notice && <p role="status" className="mt-2 text-muted-foreground">{notice}</p>}
    {!!frames.length && <div className="mt-3 space-y-2">
      {image && <Image src={image} alt="Recorded browser test" width={1280} height={720} unoptimized className="h-auto w-full rounded-md border border-border" />}
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => setPlaying(value => !value)}>{playing ? "Pause replay" : "Play replay"}</Button>
        <input aria-label="Recording position" type="range" min={0} max={frames.length - 1} value={index} onChange={event => { setPlaying(false); setIndex(Number(event.target.value)); }} className="min-w-0 flex-1" />
      </div>
      <p className="text-muted-foreground">Sampled server recording · {Math.round(frames[index].timestamp - frames[0].timestamp)}s</p>
    </div>}
    {report && <details open className="mt-3">
      <summary className="cursor-pointer text-muted-foreground">Recorded task results · {report.length}</summary>
      <div className="mt-2 max-h-96 space-y-2 overflow-auto">
        {report.map((task, i) => <div key={i} className="rounded-md border border-border p-2">
          <p className="break-words font-medium">{task.task.label || task.task.url} · {task.state.replaceAll("_", " ")}</p>
          {task.result?.summary && <ChatMarkdown content={task.result.summary} />}
        </div>)}
      </div>
      {reportOffset !== null && <Button className="mt-2" size="sm" variant="outline" disabled={busy} onClick={() => void viewReport(reportOffset)}>Next results</Button>}
      <p className="mt-2 text-muted-foreground">Coverage is limited to discovered pages and recorded scenarios.</p>
    </details>}
  </section>;
}
