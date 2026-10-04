/** WebRTC video only. Browser controls and session capabilities stay on the WebSocket. */
export function createBrowserPeer(video: HTMLVideoElement, signal: (message: object) => void,
                                  presented: () => void, failed: () => void,
                                  iceServers: RTCIceServer[] = [], acquireVideo: () => boolean = () => true) {
  const peer = new RTCPeerConnection({ iceServers });
  const transceiver = peer.addTransceiver("video", { direction: "recvonly" });
  // Interactive video favors fresh frames. The browser still enforces its
  // network-dependent minimum buffer; unsupported receivers retain defaults.
  if (transceiver?.receiver && "jitterBufferTarget" in transceiver.receiver) {
    try { transceiver.receiver.jitterBufferTarget = 0; } catch {}
  }
  let closed = false, ready = false, callback = 0, failureReported = false;
  let stream: MediaStream | null = null;
  let cancelGather: (() => void) | null = null;
  let priorStats: { id: string; emitted: number; delay: number; dropped: number } | null = null;
  const fail = () => {
    if (closed || failureReported) return;
    failureReported = true;
    failed();
  };
  const timeout = setTimeout(() => { if (!ready) fail(); }, 15000);
  const frame: VideoFrameRequestCallback = () => {
    if (closed || video.srcObject !== stream) return;
    if (!ready) { ready = true; clearTimeout(timeout); signal({ type: "rtc_ready" }); }
    presented();
    callback = video.requestVideoFrameCallback(frame);
  };
  peer.ontrack = event => {
    if (closed || !acquireVideo()) { event.track.stop(); return; }
    video.cancelVideoFrameCallback(callback);
    stream?.getTracks().forEach(track => track.stop());
    stream = new MediaStream([event.track]);
    video.srcObject = stream;
    callback = video.requestVideoFrameCallback(frame);
    void video.play().catch(fail);
  };
  peer.onconnectionstatechange = () => {
    if (["failed", "disconnected", "closed"].includes(peer.connectionState)) fail();
  };
  return {
    async offer() {
      const offer = await peer.createOffer();
      if (closed) return;
      await peer.setLocalDescription(offer);
      if (closed) return;
      // Complete ICE candidates are sent in SDP; no unauthenticated signaling endpoint.
      if (peer.iceGatheringState !== "complete") {
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(deadline); peer.removeEventListener("icegatheringstatechange", changed); cancelGather = null; resolve(); };
          const changed = () => { if (peer.iceGatheringState === "complete") done(); };
          const deadline = setTimeout(done, 6000);
          peer.addEventListener("icegatheringstatechange", changed);
          cancelGather = done;
        });
      }
      if (!closed) signal({ type: "rtc_offer", sdp: peer.localDescription?.sdp });
    },
    async answer(sdp: string) {
      if (!closed) await peer.setRemoteDescription({ type: "answer", sdp });
    },
    async metrics(): Promise<{ jitterBufferMs: number | null; droppedFrames: number }> {
      if (closed || !peer.getStats) return { jitterBufferMs: null, droppedFrames: 0 };
      const report = await peer.getStats();
      let result = { jitterBufferMs: null as number | null, droppedFrames: 0 };
      report.forEach(stat => {
        if (stat.type !== "inbound-rtp" || (stat.kind ?? stat.mediaType) !== "video") return;
        const emitted = Number(stat.jitterBufferEmittedCount);
        const delay = Number(stat.jitterBufferDelay);
        const dropped = Number(stat.framesDropped) || 0;
        const previous = priorStats;
        if (previous && previous.id === stat.id) {
          const count = emitted - previous.emitted;
          const elapsed = delay - previous.delay;
          result = { jitterBufferMs: count > 0 && elapsed >= 0 && Number.isFinite(elapsed)
            ? Math.round(elapsed / count * 1000) : null,
            droppedFrames: Math.max(0, dropped - previous.dropped) };
        }
        priorStats = { id: stat.id, emitted, delay, dropped };
      });
      return result;
    },
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(timeout);
      cancelGather?.();
      video.cancelVideoFrameCallback(callback);
      peer.close();
      stream?.getTracks().forEach(track => track.stop());
      if (video.srcObject === stream) video.srcObject = null;
    },
  };
}
