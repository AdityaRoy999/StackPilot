/** Present decoded frames through the browser's video compositor when supported. */
type Generator = { writable: WritableStream<VideoFrame>; track?: MediaStreamTrack };
type TrackAPIs = {
  MediaStreamTrackGenerator?: new (options: { kind: "video" }) => Generator & MediaStreamTrack;
  VideoTrackGenerator?: new () => Generator & { track: MediaStreamTrack };
};

export interface NativeVideoSink {
  push(frame: VideoFrame): void;
  close(): void;
}

export function createNativeVideoSink(video: HTMLVideoElement, presented: (frames: number) => void,
                                      failed: () => void): NativeVideoSink | null {
  const apis = globalThis as unknown as TrackAPIs;
  if (!video.requestVideoFrameCallback || (!apis.MediaStreamTrackGenerator && !apis.VideoTrackGenerator)) return null;
  try {
    const generator = apis.MediaStreamTrackGenerator ? new apis.MediaStreamTrackGenerator({ kind: "video" }) : new apis.VideoTrackGenerator!();
    const track = generator.track ?? generator as Generator & MediaStreamTrack;
    const stream = new MediaStream([track]);
    const writer = generator.writable.getWriter();
    let closed = false, writing = false;
    let pending: VideoFrame | null = null;
    let callback = 0;
    const onPresented: VideoFrameRequestCallback = () => {
      if (closed) return;
      // A new transport can replace srcObject before a queued callback runs.
      // This sink must never count another track's frames or keep its writer alive.
      if (video.srcObject !== stream) { close(); return; }
      // presentedFrames also counts frames submitted while the main thread
      // missed callbacks. Those are not proof of smooth visible presentation.
      presented(1);
      callback = video.requestVideoFrameCallback(onPresented);
    };
    callback = video.requestVideoFrameCallback(onPresented);
    video.srcObject = stream;
    const close = () => {
      if (closed) return;
      closed = true;
      video.cancelVideoFrameCallback(callback);
      pending?.close();
      pending = null;
      track.stop();
      void writer.abort().catch(() => {});
      if (video.srcObject === stream) video.srcObject = null;
    };
    const pump = () => {
      const frame = pending;
      if (!frame || closed || writing) return;
      pending = null;
      writing = true;
      void writer.write(frame).catch(() => {
        if (!closed) { close(); failed(); }
      }).finally(() => {
        frame.close();
        writing = false;
        pump();
      });
    };
    void video.play().catch(() => { if (!closed) { close(); failed(); } });
    return {
      push(frame) {
        if (closed || video.srcObject !== stream) { close(); frame.close(); return; }
        pending?.close();
        pending = frame;
        pump();
      },
      close,
    };
  } catch {
    return null;
  }
}
