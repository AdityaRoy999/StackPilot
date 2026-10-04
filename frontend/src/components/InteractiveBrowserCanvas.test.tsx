import React, { act, Profiler } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import api from "@/lib/api";
import * as peerLibrary from "@/lib/browser-peer";
import * as sinkLibrary from "@/lib/browser-video-sink";
import * as cursorLibrary from "@/lib/browser-cursor";
import { InteractiveBrowserCanvas } from "./InteractiveBrowserCanvas";

vi.mock("@/lib/api", () => ({ default: { get: vi.fn() } }));
vi.mock("@/lib/platform-icons", async () => import("lucide-react"));
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  await act(async () => roots.splice(0).forEach(root => root.unmount()));
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.mocked(api.get).mockReset();
});

it("zooms without reconnecting and maps manual taps and swipes to the unchanged browser viewport", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(390);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  class Socket {
    static OPEN = 1;
    static instances: Socket[] = [];
    readyState = Socket.OPEN;
    onopen: (() => void) | null = null;
    send = vi.fn(); close = vi.fn();
    constructor() { Socket.instances.push(this); }
  }
  vi.stubGlobal("WebSocket", Socket);
  vi.mocked(api.get).mockResolvedValue({ data: { ticket: "fixture" } });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); roots.push(root);
  await act(async () => root.render(<InteractiveBrowserCanvas sessionId="phone-zoom" isOpen embedded />));
  const socket = Socket.instances[0];
  await act(async () => socket.onopen!());
  await act(async () => (host.querySelector('[aria-label="Zoom browser 2 times"]') as HTMLButtonElement).click());
  expect(Socket.instances).toHaveLength(1);
  expect(socket.close).not.toHaveBeenCalled();
  const screen = host.querySelector('[data-browser-screen]') as HTMLDivElement;
  expect(screen.style.width).toBe("780px");
  expect(screen.style.height).toBe("438px");
  vi.spyOn(screen, "getBoundingClientRect").mockReturnValue({ x: 10, y: 20, left: 10, top: 20, right: 790, bottom: 458, width: 780, height: 438, toJSON() {} });
  const inputs = (type: string) => socket.send.mock.calls.map(([raw]) => JSON.parse(raw)).filter(message => message.type === type);
  await act(async () => screen.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 205, clientY: 239 })));
  expect(inputs("user_click")).toHaveLength(0);
  await act(async () => (host.querySelector('[aria-label="Take browser control"]') as HTMLButtonElement).click());
  await act(async () => screen.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 205, clientY: 239 })));
  expect(inputs("user_click")).toEqual([expect.objectContaining({ x: 320, y: 360 })]);
  screen.setPointerCapture = vi.fn();
  function pointer(type: string, y: number) {
    const event = new Event(type, { bubbles: true });
    Object.assign(event, { pointerType: "touch", pointerId: 7, clientX: 205, clientY: y });
    screen.dispatchEvent(event);
  }
  await act(async () => { pointer("pointerdown", 300); pointer("pointermove", 200); pointer("pointerup", 200); });
  expect(inputs("user_scroll")[0].delta_y).toBeCloseTo(100 * 720 / 438);
  await act(async () => screen.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 205, clientY: 200 })));
  expect(inputs("user_click")).toHaveLength(1);
});

it("keeps the viewer connected after socket open and telemetry updates", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  class Socket {
    static OPEN = 1;
    static instances: Socket[] = [];
    readyState = Socket.OPEN;
    onopen: (() => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    send = vi.fn();
    close = vi.fn();
    constructor() { Socket.instances.push(this); }
  }
  vi.stubGlobal("WebSocket", Socket);
  vi.mocked(api.get).mockReset().mockResolvedValue({ data: { ticket: "fixture" } });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); roots.push(root);
  await act(async () => root.render(<InteractiveBrowserCanvas sessionId="viewer-fixture" isOpen initialUrl="https://fixture.invalid/" />));
  expect(host.textContent).toContain("Connecting to Live Screencast");
  const socket = Socket.instances[0];
  await act(async () => socket.onopen!());
  expect(host.textContent).not.toContain("Connecting to Live Screencast");
  expect(host.textContent).toContain("Live • Idle");
  expect(socket.send).toHaveBeenCalledWith(expect.stringContaining('"type":"attach"'));
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(host.textContent).not.toContain("Connecting to Live Screencast");
  expect(host.textContent).toContain("Live • Idle");
  await act(async () => socket.onclose!({ code: 1000 }));
  expect(host.textContent).toContain("Connecting to Live Screencast");
});

it("replaces an authorization failure with an actionable error and can retry", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.mocked(api.get).mockRejectedValueOnce({ response: { status: 404 } })
    .mockRejectedValueOnce({ response: { status: 503, data: { error: "Browser service is restarting" } } });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); roots.push(root);
  await act(async () => root.render(<InteractiveBrowserCanvas sessionId="aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa" isOpen initialUrl="about:blank" />));
  expect(host.textContent).toContain("This chat is no longer available");
  expect(host.textContent).not.toContain("Connecting to Live Screencast");
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "Retry connection")!.click());
  expect(api.get).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain("Browser service is restarting");
});

it("shows worker capacity failures and waits for an explicit retry", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  class Socket {
    static OPEN = 1; static instances: Socket[] = [];
    readyState = Socket.OPEN;
    onopen: (() => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    send = vi.fn(); close = vi.fn();
    constructor() { Socket.instances.push(this); }
  }
  vi.stubGlobal("WebSocket", Socket);
  vi.mocked(api.get).mockResolvedValue({ data: { ticket: "fixture" } });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); roots.push(root);
  await act(async () => root.render(<InteractiveBrowserCanvas sessionId="capacity-fixture" isOpen initialUrl="about:blank" />));
  const socket = Socket.instances[0];
  await act(async () => {
    socket.onopen!();
    socket.onmessage!({ data: JSON.stringify({ type: "browser_error", message: "The browser worker is at capacity." }) });
    socket.onclose!({ code: 1013 });
  });
  expect(host.textContent).toContain("The browser worker is at capacity.");
  expect(host.textContent).not.toContain("Connecting to Live Screencast");
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(Socket.instances).toHaveLength(1);
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "Retry connection")!.click());
  expect(Socket.instances).toHaveLength(2);
});

it("moves the cursor without React commits per packet and honors reduced motion", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  class Socket {
    static OPEN = 1;
    static latest: Socket;
    readyState = Socket.OPEN;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    send = vi.fn(); close = vi.fn();
    constructor() { Socket.latest = this; }
  }
  vi.stubGlobal("WebSocket", Socket);
  vi.mocked(api.get).mockResolvedValue({ data: { ticket: "fixture" } });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); roots.push(root);
  const commits = vi.fn();
  await act(async () => root.render(<Profiler id="viewer" onRender={commits}>
    <InteractiveBrowserCanvas sessionId="cursor-fixture" isOpen />
  </Profiler>));
  const socket = Socket.latest;
  await act(async () => socket.onopen!());
  const raf = vi.mocked(requestAnimationFrame);
  await act(async () => raf.mock.calls[0][0](performance.now()));
  expect(raf).toHaveBeenCalledOnce(); // no perpetual canvas loop on idle/native video
  const move = (x: number) => socket.onmessage!({ data: JSON.stringify({ type: "cursor_action", action: "move", x, y: x }) });
  await act(async () => move(0));
  const before = commits.mock.calls.length;
  await act(async () => { for (let x = 1; x <= 500; x++) move(x); });
  expect(commits).toHaveBeenCalledTimes(before);
  const cursor = host.querySelector<HTMLElement>("[data-browser-cursor]")!;
  expect(cursor.style.transform).toBe("translate3d(497px, 497px, 0)");
  expect(cursor.style.visibility).toBe("visible");
  expect(cursor.className).not.toContain("transition-all");
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  const feedback = socket.send.mock.calls.map(([message]) => JSON.parse(message)).find(message => message.type === "stream_feedback");
  expect(feedback).toMatchObject({ frames_presented: 0, gap_ms: 0, presentation_interval_ms: 0 });
});

it("restores native streaming when WebRTC negotiation takes over the video and then fails", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("VideoDecoder", class {});
  vi.stubGlobal("EncodedVideoChunk", class {});
  vi.stubGlobal("RTCPeerConnection", class {});
  const oldSink = { push: vi.fn(), close: vi.fn() }, newSink = { push: vi.fn(), close: vi.fn() };
  const sinks = vi.spyOn(sinkLibrary, "createNativeVideoSink").mockReturnValueOnce(oldSink).mockReturnValueOnce(newSink);
  const peer = { offer: vi.fn(async () => {}), answer: vi.fn(async () => {}), close: vi.fn(),
    metrics: vi.fn(async () => ({ jitterBufferMs: null, droppedFrames: 0 })) };
  const peers = vi.spyOn(peerLibrary, "createBrowserPeer").mockReturnValue(peer);
  class Socket {
    static OPEN = 1;
    static latest: Socket;
    readyState = Socket.OPEN;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    send = vi.fn(); close = vi.fn();
    constructor() { Socket.latest = this; }
  }
  vi.stubGlobal("WebSocket", Socket);
  vi.mocked(api.get).mockResolvedValue({ data: { ticket: "fixture" } });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); roots.push(root);
  await act(async () => root.render(<InteractiveBrowserCanvas sessionId="rtc-fallback-fixture" isOpen />));
  const video = host.querySelector("video")!;
  video.requestVideoFrameCallback = vi.fn(() => 1);
  const socket = Socket.latest;
  await act(async () => socket.onopen!());
  expect(sinks).toHaveBeenCalledOnce();
  await act(async () => socket.onmessage!({ data: JSON.stringify({ type: "stream_capabilities", webrtc: true }) }));
  await act(async () => peers.mock.calls[0][3]());
  expect(peer.close).toHaveBeenCalledOnce();
  expect(oldSink.close).toHaveBeenCalledOnce();
  expect(sinks).toHaveBeenCalledTimes(2);
  expect(socket.send.mock.calls.some(([message]) => JSON.parse(message).type === "rtc_stop")).toBe(true);
  expect(socket.send.mock.calls.some(([message]) => JSON.parse(message).type === "user_navigate")).toBe(false);
});

it("does not show a testing-completed banner when a recorded run is stopped", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ close: vi.fn() })));
  class Socket {
    static OPEN = 1;
    static latest: Socket;
    readyState = Socket.OPEN;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    send = vi.fn(); close = vi.fn();
    constructor() { Socket.latest = this; }
  }
  vi.stubGlobal("WebSocket", Socket);
  vi.mocked(api.get).mockResolvedValue({ data: { ticket: "fixture" } });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); roots.push(root);
  await act(async () => root.render(<InteractiveBrowserCanvas sessionId="stopped-replay-fixture" isOpen />));
  const socket = Socket.latest;
  await act(async () => socket.onopen!());
  for (let i = 1; i <= 6; i++) {
    await act(async () => { await vi.advanceTimersByTimeAsync(110); socket.onmessage!({data:JSON.stringify({type:"frame",data:"eA==",seq:i})}); });
  }
  expect(host.textContent).toContain("Replay (");
  await act(async () => socket.onmessage!({ data: JSON.stringify({ type: "testing_stopped" }) }));
  expect(host.textContent).not.toContain("AI Testing Session Completed");
  await act(async () => socket.onmessage!({ data: JSON.stringify({ type: "testing_completed" }) }));
  expect(host.textContent).toContain("AI Testing Session Completed");
  await act(async () => socket.onmessage!({ data: JSON.stringify({ type: "testing_stopped" }) }));
  expect(host.textContent).not.toContain("AI Testing Session Completed");
});

async function rtcRecoveryFixture() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("VideoDecoder", class {
    state = "configured"; decodeQueueSize = 0;
    configure() {} decode() {} close() { this.state = "closed"; }
  });
  vi.stubGlobal("EncodedVideoChunk", class {});
  vi.stubGlobal("RTCPeerConnection", class {});
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ close: vi.fn() })));
  const sinks = vi.spyOn(sinkLibrary, "createNativeVideoSink").mockImplementation(() => ({ push: vi.fn(), close: vi.fn() }));
  type Peer = ReturnType<typeof peerLibrary.createBrowserPeer>;
  const peers: Peer[] = [];
  const hooks: { presented: () => void; failed: () => void; acquire: () => boolean; signal: (message: object) => void }[] = [];
  const createPeer = vi.spyOn(peerLibrary, "createBrowserPeer").mockImplementation((_video, signal, presented, failed, _servers, acquire) => {
    const peer = { offer: vi.fn(async () => { signal({ type: "rtc_offer", sdp: `offer-${peers.length}` }); }),
      answer: vi.fn(async () => {}), close: vi.fn(),
      metrics: vi.fn(async () => ({ jitterBufferMs: null, droppedFrames: 0 })) };
    peers.push(peer); hooks.push({ presented, failed, acquire: acquire!, signal });
    return peer;
  });
  class Socket {
    static OPEN = 1;
    static instances: Socket[] = [];
    readyState = Socket.OPEN;
    onopen: (() => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
    send = vi.fn(); close = vi.fn();
    constructor() { Socket.instances.push(this); }
  }
  vi.stubGlobal("WebSocket", Socket);
  vi.mocked(api.get).mockResolvedValue({ data: { ticket: "fixture" } });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); roots.push(root);
  await act(async () => root.render(<InteractiveBrowserCanvas sessionId="rtc-recovery-fixture" isOpen />));
  const video = host.querySelector("video")!;
  video.requestVideoFrameCallback = vi.fn(() => 1);
  const socket = Socket.instances[0];
  await act(async () => socket.onopen!());
  const message = async (data: object, ws = socket) => {
    await act(async () => ws.onmessage!({ data: JSON.stringify(data) }));
  };
  const capabilities = () => message({ type: "stream_capabilities", webrtc: true });
  const negotiationIds = (ws = socket) => ws.send.mock.calls.map(([raw]) => JSON.parse(raw))
    .filter(msg => msg.type === "rtc_offer").map(msg => msg.negotiation_id as string);
  return { host, socket, Socket, message, capabilities, negotiationIds, peers, hooks, sinks, createPeer };
}

it("isolates the live video from parent chat updates while applying real viewer changes", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  class Socket {
    static OPEN = 1;
    static instances: Socket[] = [];
    readyState = Socket.OPEN;
    onopen: (() => void) | null = null;
    send = vi.fn(); close = vi.fn();
    constructor() { Socket.instances.push(this); }
  }
  vi.stubGlobal("WebSocket", Socket);
  vi.mocked(api.get).mockResolvedValue({ data: { ticket: "fixture" } });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); roots.push(root);
  const CursorMotion = cursorLibrary.BrowserCursorMotion;
  const cursorAllocations = vi.spyOn(cursorLibrary, "BrowserCursorMotion").mockImplementation(function () { return new CursorMotion(); });
  const onClose = vi.fn(), onUrlChange = vi.fn();
  const render = (chatText: string, sandboxMode: "local" | "remote" = "local") => root.render(<>
    <p>{chatText}</p>
    <InteractiveBrowserCanvas sessionId="chat-update-fixture" isOpen sandboxMode={sandboxMode}
      initialUrl="https://fixture.invalid/" onClose={onClose} onUrlChange={onUrlChange} />
  </>);
  await act(async () => render("Starting"));
  await act(async () => Socket.instances[0].onopen!());
  const video = host.querySelector("video");
  const before = cursorAllocations.mock.calls.length;
  for (let i = 0; i < 30; i++) await act(async () => render(`Streamed token ${i}`));
  // No viewer body runs or animation objects are allocated for chat updates.
  expect(cursorAllocations).toHaveBeenCalledTimes(before);
  expect(host.querySelector("video")).toBe(video);
  expect(Socket.instances).toHaveLength(1);
  expect(Socket.instances[0].close).not.toHaveBeenCalled();
  await act(async () => render("Switch worker", "remote"));
  expect(Socket.instances[0].close).toHaveBeenCalledOnce();
  expect(Socket.instances).toHaveLength(2);
  await act(async () => Socket.instances[1].onopen!());
  expect(Socket.instances[1].send).toHaveBeenCalledWith(expect.stringContaining('"sandbox_mode":"remote"'));
});

it("reconnects with a fresh peer and ignores callbacks from the closed connection", async () => {
  const qa = await rtcRecoveryFixture();
  await qa.capabilities();
  await act(async () => { expect(qa.hooks[0].acquire()).toBe(true); qa.hooks[0].presented(); });
  expect(qa.host.querySelector("video")!.style.visibility).toBe("visible");
  qa.socket.readyState = 3;
  await act(async () => qa.socket.onclose!({ code: 1000 }));
  expect(qa.peers[0].close).toHaveBeenCalledOnce();
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  const next = qa.Socket.instances[1];
  await act(async () => next.onopen!());
  await qa.message({ type: "stream_capabilities", webrtc: true }, next);
  await qa.message({ type: "stream_capabilities", webrtc: true }, next);
  expect(qa.createPeer).toHaveBeenCalledTimes(2);
  expect(JSON.parse(next.send.mock.calls[0][0])).toMatchObject({ type: "attach", video_codec: "h264" });
  await act(async () => {
    qa.hooks[0].failed(); qa.hooks[0].presented();
    expect(qa.hooks[0].acquire()).toBe(false);
    qa.sinks.mock.calls[0][2](); // late native writer failure
    qa.socket.onopen!(); // stale socket cannot reset the new transport
    expect(qa.hooks[1].acquire()).toBe(true); qa.hooks[1].presented();
  });
  expect(qa.peers[1].close).not.toHaveBeenCalled();
  expect(qa.host.querySelector("video")!.style.visibility).toBe("visible");
  expect(next.send.mock.calls.some(([raw]) => ["rtc_stop", "stream_recover", "user_navigate"].includes(JSON.parse(raw).type))).toBe(false);
  await qa.message({ type: "frame", data: "eA==", seq: 1 }, next);
  expect(createImageBitmap).not.toHaveBeenCalled(); // stale fallback snapshots cannot paint over RTC
});

it("ignores stale answers and offer/answer failures after a same-socket stream reset", async () => {
  const qa = await rtcRecoveryFixture();
  let rejectOffer!: (reason: Error) => void;
  let rejectAnswer!: (reason: Error) => void;
  qa.createPeer.mockImplementationOnce((_video, signal, presented, failed, _servers, acquire) => {
    const peer = { offer: vi.fn(() => { signal({ type: "rtc_offer", sdp: "pending-offer" });
        return new Promise<void>((_resolve, reject) => { rejectOffer = reject; }); }),
      answer: vi.fn(() => new Promise<void>((_resolve, reject) => { rejectAnswer = reject; })), close: vi.fn(),
      metrics: vi.fn(async () => ({ jitterBufferMs: null, droppedFrames: 0 })) };
    qa.peers.push(peer); qa.hooks.push({ presented, failed, acquire: acquire!, signal }); return peer;
  });
  await qa.capabilities();
  const oldId = qa.negotiationIds()[0];
  await qa.message({ type: "rtc_answer", sdp: "old-answer", negotiation_id: oldId });
  await qa.message({ type: "stream_reset" });
  await qa.capabilities();
  const nextId = qa.negotiationIds()[1];
  expect(nextId).not.toBe(oldId);
  await qa.message({ type: "rtc_answer", sdp: "late-answer", negotiation_id: oldId });
  await qa.message({ type: "rtc_unavailable", negotiation_id: oldId });
  await act(async () => { rejectOffer(new Error("old offer failed")); rejectAnswer(new Error("old answer failed")); });
  expect(qa.peers[1].answer).not.toHaveBeenCalled();
  expect(qa.peers[1].close).not.toHaveBeenCalled();
  await qa.message({ type: "rtc_answer", sdp: "fresh-answer", negotiation_id: nextId });
  expect(qa.peers[1].answer).toHaveBeenCalledWith("fresh-answer");
  await act(async () => { expect(qa.hooks[1].acquire()).toBe(true); qa.hooks[1].presented(); });
  expect(qa.host.querySelector("video")!.style.visibility).toBe("visible");
});

it("does not abort RTC negotiation when the auxiliary H.264 decoder stalls or its native sink fails", async () => {
  const qa = await rtcRecoveryFixture();
  await qa.capabilities();
  const metadata = new TextEncoder().encode(JSON.stringify({ codec: "h264", isKeyFrame: true }));
  const packet = new ArrayBuffer(16 + metadata.length + 8);
  const view = new DataView(packet);
  view.setUint8(0, 0x53); view.setUint8(1, 0x50); view.setUint32(2, 1); view.setUint16(14, metadata.length);
  new Uint8Array(packet, 16, metadata.length).set(metadata);
  await act(async () => qa.socket.onmessage!({ data: packet }));
  await act(async () => { qa.sinks.mock.calls[0][2](); await vi.advanceTimersByTimeAsync(5000); });
  expect(qa.peers[0].close).not.toHaveBeenCalled();
  expect(qa.socket.send.mock.calls.some(([raw]) => JSON.parse(raw).type === "stream_recover")).toBe(false);
  await act(async () => { expect(qa.hooks[0].acquire()).toBe(true); qa.hooks[0].presented(); });
  expect(qa.host.querySelector("video")!.style.visibility).toBe("visible");
});

it("falls back once after both decoders fail and negotiates RTC again after reconnect", async () => {
  const qa = await rtcRecoveryFixture();
  vi.stubGlobal("VideoDecoder", class {
    state = "configured"; decodeQueueSize = 0;
    configure() { throw new Error("fixture decoder unsupported"); }
    close() { this.state = "closed"; }
  });
  await qa.capabilities();
  const metadata = new TextEncoder().encode(JSON.stringify({ codec: "h264", isKeyFrame: true }));
  const packet = new ArrayBuffer(16 + metadata.length + 8);
  const view = new DataView(packet);
  view.setUint8(0, 0x53); view.setUint8(1, 0x50); view.setUint32(2, 1); view.setUint16(14, metadata.length);
  new Uint8Array(packet, 16, metadata.length).set(metadata);
  await act(async () => qa.socket.onmessage!({ data: packet }));
  const recoveries = () => qa.socket.send.mock.calls.filter(([raw]) => JSON.parse(raw).type === "stream_recover");
  expect(recoveries()).toHaveLength(0); // the independent RTC decoder still has a chance
  await act(async () => { qa.hooks[0].failed(); qa.hooks[0].failed(); });
  expect(recoveries()).toHaveLength(1);
  await qa.message({ type: "stream_reset" });
  qa.socket.readyState = 3;
  await act(async () => { qa.socket.onclose!({ code: 1000 }); await vi.advanceTimersByTimeAsync(2000); });
  const next = qa.Socket.instances[1];
  await act(async () => next.onopen!());
  await qa.message({ type: "stream_capabilities", webrtc: true }, next);
  expect(JSON.parse(next.send.mock.calls[0][0])).toMatchObject({ type: "attach", video_codec: "h264" });
  await act(async () => { expect(qa.hooks[1].acquire()).toBe(true); qa.hooks[1].presented(); });
  expect(qa.host.querySelector("video")!.style.visibility).toBe("visible");
  expect(qa.peers[1].close).not.toHaveBeenCalled();
});
