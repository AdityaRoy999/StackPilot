"""Bounded live-video buffering, preserving H.264 dependency boundaries."""
import asyncio
import math
import time
from collections import deque


class ViewerFeedbackAggregator:
    """A shared encoder receives one fair measurement across its live viewers."""
    fields = ("gap_ms", "decode_queue", "rtt_ms", "presentation_interval_ms",
              "frames_presented", "jitter_buffer_ms")

    def __init__(self):
        self.viewers = {}

    def put(self, viewer, message, now=None):
        def number(key):
            value = message.get(key)
            return max(0, min(10000, float(value))) if type(value) in {int, float} and math.isfinite(value) else 0
        self.viewers[viewer] = {"at": time.monotonic() if now is None else now,
                               "visible": message.get("visible") is not False,
                               **{field: number(field) for field in self.fields}}

    def remove(self, viewer):
        return self.viewers.pop(viewer, None) is not None

    def aggregate(self, listeners, now=None):
        now = time.monotonic() if now is None else now
        self.viewers = {viewer: value for viewer, value in self.viewers.items()
                        if viewer in listeners and now - value["at"] < 6}
        if not self.viewers:
            return None
        visible = [value for value in self.viewers.values() if value["visible"]]
        if not visible:
            return {"type": "feedback", "visible": False}
        result = {"type": "feedback", "visible": True,
                  **{field: max(value[field] for value in visible)
                     for field in ("gap_ms", "decode_queue", "rtt_ms", "jitter_buffer_ms")}}
        # Every visible receiver must qualify the shared rate. Missing samples
        # must not be hidden by a healthy second viewer's measurements.
        result["presentation_interval_ms"] = (max(value["presentation_interval_ms"] for value in visible)
                                               if all(value["presentation_interval_ms"] > 0 for value in visible) else 0)
        result["frames_presented"] = min(value["frames_presented"] for value in visible)
        result["all_viewers_measured"] = all(value["frames_presented"] >= 2 and
            value["presentation_interval_ms"] > 0 and value["rtt_ms"] > 0 for value in visible)
        return result


class LiveControlBuffer:
    """Coalesce replaceable state; keep control feedback bounded and ahead of video."""
    def __init__(self, capacity=256):
        self.capacity = capacity
        self.events = deque()
        self.latest = {}
        self.ready = asyncio.Event()

    def clear(self):
        self.events.clear()
        self.latest.clear()
        self.ready.clear()

    def put_nowait(self, event):
        kind = event.get("type")
        if kind in {"page_state", "navigated", "stream_health"} or (
                kind == "cursor_action" and event.get("action") == "move"):
            if kind == "page_state":
                previous = self.latest.get(kind, {})
                if previous.get("state_seq", -1) > event.get("state_seq", -1):
                    return
                # Preserve the latest same-page DOM tree when a title-only event arrives.
                if previous.get("url") == event.get("url") and "elements" not in event and "elements" in previous:
                    event = {**previous, **event}
            self.latest[kind] = event
        else:
            if len(self.events) >= self.capacity:
                self.events.popleft()
            self.events.append(event)
        self.ready.set()

    async def get(self):
        while True:
            for kind in ("page_state", "navigated", "cursor_action", "stream_health"):
                if kind in self.latest:
                    return self.latest.pop(kind)
            if self.events:
                return self.events.popleft()
            self.ready.clear()
            await self.ready.wait()


class LiveFrameBuffer:
    def __init__(self, capacity=12, max_residence_ms=150):
        # A few pictures commonly arrive together over SSH. Three slots
        # discarded the entire dependency chain on normal network jitter.
        # Keep a bounded burst allowance and expire delayed chains instead.
        self.queue = asyncio.Queue(maxsize=capacity)
        self.max_residence_ms_limit = max_residence_ms
        self.waiting_for_keyframe = True
        self.waiting_since = time.monotonic()
        self.received_frames = 0
        self.emitted_frames = 0
        self.discarded_frames = 0
        self.rejected_deltas = 0
        self.overflow_resets = 0
        self.manual_resets = 0
        self.keyframe_flushes = 0
        self.last_residence_ms = 0.0
        self.max_residence_ms = 0.0
        self.max_keyframe_wait_ms = 0.0

    def clear(self):
        while not self.queue.empty():
            self.queue.get_nowait()
            self.discarded_frames += 1

    def reset(self, *, overflow=False):
        self.clear()
        if overflow:
            self.overflow_resets += 1
        else:
            self.manual_resets += 1
        if not self.waiting_for_keyframe:
            self.waiting_since = time.monotonic()
        self.waiting_for_keyframe = True

    def push(self, event):
        self.received_frames += 1
        metadata = event.get("metadata") or {}
        if metadata.get("codec") not in {"h264", "avc1"}:
            # JPEGs are independently decodable; only the latest is useful.
            self.clear()
            self.queue.put_nowait({**event, '_buffer_enqueued_at': time.monotonic()})
            return True
        if metadata.get("isKeyFrame"):
            if not self.queue.empty():
                self.keyframe_flushes += 1
            self.clear()
            if self.waiting_for_keyframe:
                self.max_keyframe_wait_ms = max(self.max_keyframe_wait_ms,
                    (time.monotonic() - self.waiting_since) * 1000)
            self.waiting_for_keyframe = False
        elif self.waiting_for_keyframe:
            self.rejected_deltas += 1
            return False
        elif self.queue.full():
            self.reset(overflow=True)
            self.rejected_deltas += 1
            return False
        self.queue.put_nowait({**event, '_buffer_enqueued_at': time.monotonic()})
        return True

    async def get(self):
        while True:
            event = await self.queue.get()
            now = time.monotonic()
            residence = max(0.0, (now - event.get('_buffer_enqueued_at', now)) * 1000)
            self.max_residence_ms = max(self.max_residence_ms, residence)
            if residence > self.max_residence_ms_limit and (event.get('metadata') or {}).get('codec') in {'h264','avc1'}:
                self.discarded_frames += 1
                self.reset(overflow=True)
                continue
            self.emitted_frames += 1
            self.last_residence_ms = residence
            return event

    def status(self):
        now = time.monotonic()
        return {
            'queued_frames': self.queue.qsize(),
            'waiting_for_keyframe': self.waiting_for_keyframe,
            'keyframe_wait_ms': round((now - self.waiting_since) * 1000, 2) if self.waiting_for_keyframe else 0,
            'max_keyframe_wait_ms': round(self.max_keyframe_wait_ms, 2),
            'received_frames': self.received_frames, 'emitted_frames': self.emitted_frames,
            'discarded_frames': self.discarded_frames, 'rejected_deltas': self.rejected_deltas,
            'overflow_resets': self.overflow_resets, 'manual_resets': self.manual_resets,
            'keyframe_flushes': self.keyframe_flushes,
            'last_residence_ms': round(self.last_residence_ms, 2),
            'max_residence_ms': round(self.max_residence_ms, 2),
        }
