"""
StackPilot Lightweight Real-Time Browser Driver & Live Screencast Bridge
Ultra-low memory (~60MB), pure async CDP (Chrome DevTools Protocol) client.
Zero heavy dependencies: uses standard asyncio, httpx, and websockets.
"""

import asyncio
import re
import base64
import json
import logging
import os
import random
import socket
import struct
import time
import uuid
from collections import deque
from typing import Any, Callable, Dict, List, Optional, Set
from urllib.parse import urljoin, urlparse, urlunparse
import httpx
import websockets
from websockets.exceptions import ConnectionClosed
from .browser_page_state import PAGE_STATE_BINDING, PAGE_STATE_SCRIPT

try:
    from .skg_models import SiteKnowledgeGraph, PageArchetype, ArchetypeClassifier
    from .navigation_pda import PushdownNavigationAutomaton, NavigationFrame
    from .apv_engine import ActionPerceptionVerification, ActionVerificationResult, PerceptionSnapshot
except ImportError:
    from skg_models import SiteKnowledgeGraph, PageArchetype, ArchetypeClassifier
    from navigation_pda import PushdownNavigationAutomaton, NavigationFrame
    from apv_engine import ActionPerceptionVerification, ActionVerificationResult, PerceptionSnapshot

logger = logging.getLogger("stackpilot.browser_driver")

CHROME_HOST = os.getenv("BROWSER_SANDBOX_URL", "http://browser-sandbox:9222").rstrip("/")
BROWSER_STREAM_HOST = os.getenv("BROWSER_STREAM_HOST", "browser-sandbox")
BROWSER_STREAM_PORT = int(os.getenv("BROWSER_STREAM_PORT", "8099"))

# Remote GPU sandbox (used when sandbox_mode == "remote")
REMOTE_CHROME_HOST = os.getenv("REMOTE_BROWSER_SANDBOX_URL", "").rstrip("/")
REMOTE_BROWSER_STREAM_HOST = os.getenv("REMOTE_BROWSER_STREAM_HOST", "")
REMOTE_BROWSER_STREAM_PORT = int(os.getenv("REMOTE_BROWSER_STREAM_PORT", "8099"))

def get_sandbox_config(mode: str = "local") -> tuple:
    """Returns (chrome_host, stream_host, stream_port) based on sandbox mode."""
    if mode == "remote" and REMOTE_CHROME_HOST:
        return REMOTE_CHROME_HOST, REMOTE_BROWSER_STREAM_HOST, REMOTE_BROWSER_STREAM_PORT
    return CHROME_HOST, BROWSER_STREAM_HOST, BROWSER_STREAM_PORT


def to_container_accessible_url(raw_url: str) -> str:
    """
    Translates localhost / loopback URLs to container-accessible endpoints.
    Inside the Docker network:
    - localhost:3000 / 127.0.0.1:3000 -> frontend:3000
    - localhost:8090 / 127.0.0.1:8090 -> backend:8090
    - localhost:8010 / 127.0.0.1:8010 -> ai-service:8010
    - localhost:<port> / 127.0.0.1:<port> -> host.docker.internal:<port>
    """
    if not raw_url or raw_url == "about:blank":
        return raw_url or "about:blank"

    url = raw_url.strip()
    if not url.startswith("http://") and not url.startswith("https://") and not url.startswith("about:") and not url.startswith("data:") and not url.startswith("chrome:"):
        url = f"http://{url}"

    if url.startswith("data:") or url.startswith("about:") or url.startswith("chrome:"):
        return url

    try:
        parsed = urlparse(url)
        host = (parsed.hostname or "").lower()
        port = parsed.port

        if host in {"localhost", "127.0.0.1", "0.0.0.0", "::1"}:
            if port == 3000 or (not port and "3000" in url):
                target_host = "frontend:3000"
            elif port == 8090 or (not port and "8090" in url):
                target_host = "backend:8090"
            elif port == 8010:
                target_host = "ai-service:8010"
            elif port:
                target_host = f"host.docker.internal:{port}"
            else:
                target_host = "frontend:3000"
            return urlunparse(parsed._replace(netloc=target_host))
    except Exception:
        pass

    return url


def to_frontend_display_url(url: str, fallback_url: str = "http://localhost:3000") -> str:
    """
    Translates internal Docker hostnames back to user-friendly localhost URLs for display in frontend.
    - frontend:3000 -> localhost:3000
    - backend:8090 -> localhost:8090
    - host.docker.internal:<port> -> localhost:<port>
    """
    if not url:
        return fallback_url
    if "chrome-error://" in url:
        return fallback_url

    return (
        url.replace("frontend:3000", "localhost:3000")
           .replace("backend:8090", "localhost:8090")
           .replace("host.docker.internal", "localhost")
    )


def is_transitioning_or_submit_action(element: Optional[Dict[str, Any]] = None, label: str = "", action: str = "click") -> bool:
    """Detects whether an action triggers submission, authentication, navigation, or asynchronous state changes."""
    if action in {"navigate", "navigate_back"}:
        return True

    text_corpus = (label or "").lower()
    if element:
        el_text = (element.get("text") or element.get("aria_label") or "").lower()
        el_tag = (element.get("tag") or "").lower()
        el_type = (element.get("type") or "").lower()
        el_role = (element.get("role") or "").lower()
        el_href = (element.get("href") or "").lower()
        text_corpus += f" {el_text}"
        if el_tag == "a" and el_href and not el_href.startswith(("#", "javascript:", "void(")):
            return True
        if el_type == "submit" and (el_tag != "button" or element.get("form_id")):
            return True
        # Field activation and picker opening are immediate UI changes. Their
        # placeholder text often contains verbs such as "Enter" or "Search";
        # treating those as a submission made ordinary clicks wait ~1.5 s.
        if el_tag in {"input", "textarea", "select"} or el_role in {
            "combobox", "listbox", "option", "checkbox", "radio", "switch", "textbox"
        } or el_type in {"checkbox", "radio", "date", "time", "search", "text"}:
            return False
        if re.search(r"\b(?:enter|search|choose|select)\s+(?:source|destination|origin|arrival|departure|date|city|location|name)\b", text_corpus):
            return False

    transition_keywords = [
        "login", "log in", "signin", "sign in", "sign-in", "log-in",
        "submit", "save", "send", "register", "signup", "sign up", "sign-up",
        "continue", "next", "confirm", "proceed", "checkout",
        "apply", "book", "delete", "destroy", "create", "search", "verify",
        "authenticate", "reset", "start", "join", "connect", "auth"
    ]
    return text_corpus.strip() == "enter" or any(
        re.search(r"\b" + re.escape(kw) + r"\b", text_corpus) for kw in transition_keywords
    )


class BrowserSession:
    """Manages an active CDP connection to a Chromium tab with real-time screencast."""

    def __init__(self, session_id: str, target_url: str = "about:blank", sandbox_mode: str = "local"):
        from .browser_config import browser_config
        self.config = browser_config(sandbox_mode)
        self.session_id = session_id
        self.last_used = time.monotonic()
        display = to_frontend_display_url(target_url) if target_url != "about:blank" else "http://localhost:3000"
        self.target_url = self.config.resolve_url(target_url or "http://localhost:3000")
        self.current_url = "about:blank"
        self.page_title = ""
        self._stream_id = uuid.uuid4().hex
        self._page_state_seq = 0
        self._navigation_generation = 0
        self._main_frame_id = None
        self._main_context_id = None
        self.native_dialog = None
        self._native_dialog_event = asyncio.Event()
        self.download_events: Dict[str, Dict[str, Any]] = {}
        self._download_event = asyncio.Event()
        self.last_download: Optional[Dict[str, Any]] = None
        self.dispatched_inputs = 0
        self.dispatched_activations = 0
        self.consequential_dispatches = {}
        self.related_targets = {}
        self.frame_contexts = {}
        self.frame_parents = {}
        self.frame_session_roots = {}
        self._selected_frame = None
        self.frame_offset = (0,0)
        self.frame_scale = (1,1)
        self.target_id: Optional[str] = None
        self.ws_url: Optional[str] = None
        self.cdp_ws: Optional[websockets.WebSocketClientProtocol] = None
        self._msg_id = 0
        self._pending_requests: Dict[int, asyncio.Future] = {}
        self._send_queue: asyncio.PriorityQueue = asyncio.PriorityQueue()
        self._send_task: Optional[asyncio.Task] = None
        self._read_task: Optional[asyncio.Task] = None
        self.interactive_elements: List[Dict[str, Any]] = []
        self.discovered_subpages: List[Dict[str, str]] = []
        self.console_logs: List[Dict[str, Any]] = []
        self.latest_frame: Optional[str] = None
        self.listeners: Set[Callable[[Dict[str, Any]], Any]] = set()
        from .browser_streaming import ViewerFeedbackAggregator
        self._viewer_feedback = ViewerFeedbackAggregator()
        self.viewer_codecs: Dict[Callable, str] = {}
        self._jpeg_streaming = False
        self._capture_lock = asyncio.Lock()
        self._tree_lock = asyncio.Lock()
        self._tree_refresh_task = None
        self._jpeg_started_at = 0.0
        self._jpeg_demand_since = None
        self._jpeg_restart_at = float('-inf')
        self._last_jpeg_frame_at = None
        self._jpeg_frame_times = deque(maxlen=240)
        self._h264_frame_times = deque(maxlen=240)
        # Fresh opaque references prevent history from addressing a different
        # control after a worker/session restart; remain exact JavaScript integers.
        self._next_element_id = (uuid.uuid4().int >> 76) + (1 << 32)
        self._element_cache_owner = uuid.uuid4().hex
        self.browser_context_id = None
        self._context_owner = None
        self.is_connected = False
        self.cursor_x = 640
        self.cursor_y = 360
        self._input_generation = 0
        self._frame_seq = 0
        self._inflight_requests: Dict[str, float] = {}
        self._last_network_activity: float = time.time()
        self._last_navigation_time: float = time.time()
        self._lifecycle_events: Set[str] = set()
        self._last_frame_time: float = time.time()
        self._last_chromium_frame_time: float = time.time()
        self._last_pump_time: float = 0.0
        self._last_raw_jpeg: Optional[bytes] = None
        self._last_keyframe_packet: Optional[bytes] = None
        self._navigating: bool = False  # True during page navigation to suppress stale keepalive
        self._keepalive_task: Optional[asyncio.Task] = None
        self.h264_active: bool = False
        self._h264_task: Optional[asyncio.Task] = None
        self._video_needs_keyframe = True
        self._stream_writer = None
        self._stream_reader = None
        self._h264_connections = 0
        self._h264_connection_errors = 0
        self._last_activity = time.monotonic()
        # Phase 2: Site Knowledge Graph (SKG) & Pushdown Navigation Automaton (PNA)
        self.skg = SiteKnowledgeGraph(origin_url=self.target_url)
        self.pda = PushdownNavigationAutomaton(root_url=self.current_url)
        self.current_archetype: PageArchetype = PageArchetype.UNKNOWN
        self.last_action_verification: Optional[Dict[str, Any]] = None
        self.observed_targets: Dict[int, Any] = {}
        self.pda.push(url=self.current_url, title="Initial Root", archetype=PageArchetype.LANDING.value, parent_url="")

    def _next_id(self) -> int:
        self._msg_id += 1
        return self._msg_id

    def stream_control(self, message):
        writer = self._stream_writer
        if writer and not writer.is_closing():
            writer.write((json.dumps(message) + "\n").encode())

    def forward_stream_feedback(self, viewer, message):
        """Hidden or disconnected sockets cannot overwrite visible-viewer pacing."""
        if viewer not in self.listeners:
            return
        self._viewer_feedback.put(viewer, message)
        aggregate = self._viewer_feedback.aggregate(self.listeners)
        if aggregate:
            self.stream_control(aggregate)

    def mark_activity(self):
        self._last_activity = time.monotonic()
        self.stream_control({"type": "activity"})

    def needs_h264_capture(self):
        """The shared desktop encoder is needed only by actual video consumers."""
        return bool(self.config.stream_host and self.listeners
                    and browser_manager.display_session_id == self.session_id
                    and any(self.viewer_codecs.get(viewer, 'h264') == 'h264'
                            for viewer in self.listeners))

    def _record_media_frame(self, codec):
        now = time.monotonic()
        if codec == 'jpeg':
            self._last_jpeg_frame_at = now
            self._jpeg_frame_times.append(now)
        else:
            self._h264_frame_times.append(now)

    def media_status(self):
        """Actual capture arrivals, excluding screenshot snapshots and heartbeats."""
        now = time.monotonic()
        def source_fps(samples):
            recent = [value for value in samples if now - value <= 2.0]
            if len(recent) < 2:
                return 0.0
            # Include time since the last frame so a stalled source does not
            # continue to report its previous healthy delivery rate.
            return round((len(recent) - 1) / max(now - recent[0], 0.001), 2)
        return {
            'h264_active': self.h264_active,
            'h264_capture_demand': self.needs_h264_capture(),
            'jpeg_streaming': self._jpeg_streaming,
            'h264_connections': self._h264_connections,
            'h264_connection_errors': self._h264_connection_errors,
            'h264_tcp_buffered_bytes': len(getattr(self._stream_reader, '_buffer', b'')),
            'h264_source_fps': source_fps(self._h264_frame_times),
            'jpeg_screencast_fps': source_fps(self._jpeg_frame_times),
            'last_jpeg_age_ms': (round((now - self._last_jpeg_frame_at) * 1000)
                                 if self._last_jpeg_frame_at is not None else None),
            'viewer_codecs': {codec: sum(self.viewer_codecs.get(viewer, 'h264') == codec
                                        for viewer in self.listeners)
                              for codec in ('h264', 'jpeg')},
        }

    def is_url_in_target_domain(self, url: str) -> bool:
        """Determines whether a candidate URL belongs to the target application's allowed domain."""
        if not isinstance(url, str) or not url.strip():
            return False
        # In-memory CDP fixtures start at about:blank. Permit only that exact
        # document when no web origin was selected; it grants no network scope.
        if self.target_url == "about:blank" and url.strip() == "about:blank":
            return True
        try:
            base_url = self.target_url or self.current_url or ""
            target = urlparse(base_url)
            link = urlparse(urljoin(base_url, url.strip()))
            if (target.scheme not in {"http", "https"} or link.scheme not in {"http", "https"}
                    or not target.hostname or not link.hostname or link.username or link.password):
                return False
            # str.lstrip('www.') strips *any* leading w/dot characters and can
            # turn wow.com into com, accidentally admitting unrelated .com sites.
            target_h = target.hostname.lower().removeprefix("www.")
            link_h = link.hostname.lower().removeprefix("www.")
            if link_h == target_h or link_h.endswith("." + target_h):
                return True
            # Cross-match local docker / localhost addresses
            local_hosts = {"localhost", "127.0.0.1", "host.docker.internal", "0.0.0.0"}
            if target_h in local_hosts and link_h in local_hosts:
                return True
            return False
        except Exception:
            return False

    async def _h264_stream_loop(self):
        """Reads length-prefixed H.264 NALUs from the container video streamer on port 8099.
        Dispatches pre-packed binary packets to frontend WebCodecs VideoDecoder with zero JSON/Base64 overhead."""
        stream_host, stream_port = self.config.stream_host, self.config.stream_port
        logger.info(f"Starting H.264 video reader targeting {stream_host}:{stream_port}")

        while self.is_connected:
            writer = None
            try:
                # Background tabs must not each consume and discard the
                # shared 60 FPS desktop stream. Connect only while viewed.
                if not self.needs_h264_capture():
                    self.h264_active = False
                    self._video_needs_keyframe = True
                    await asyncio.sleep(0.1)
                    continue
                reader, writer = await asyncio.open_connection(stream_host, stream_port)
                self._stream_writer = writer
                self._stream_reader = reader
                self._h264_connections += 1
                self.stream_control({'type':'protocol','source_timestamps':True})
                self.mark_activity()
                self._video_needs_keyframe = True
                sock = writer.get_extra_info("socket")
                if sock:
                    try:
                        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                        sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 256 * 1024)
                    except Exception:
                        pass
                logger.info(f"Connected to adaptive H.264 video stream at {stream_host}:{stream_port}")

                while self.is_connected:
                    if not self.needs_h264_capture():
                        self.h264_active = False
                        self._video_needs_keyframe = True
                        break
                    # Packet format from streamer.py: [4B length] [1B is_keyframe] [payload]
                    header = await asyncio.wait_for(reader.readexactly(5), timeout=2.0)
                    nal_len, flags = struct.unpack(">IB", header)
                    is_kf = bool(flags & 1)
                    if not 0 < nal_len <= 16 * 1024 * 1024:
                        raise OSError("Invalid video packet length")
                    source_timestamp_us = (struct.unpack('>Q',await asyncio.wait_for(reader.readexactly(8),timeout=2.0))[0]
                                           if flags & 0x80 else None)
                    nalu = await asyncio.wait_for(reader.readexactly(nal_len), timeout=2.0)

                    # X11 capture belongs only to the tab explicitly selected for display.
                    if not self.needs_h264_capture():
                        self.h264_active = False
                        self._video_needs_keyframe = True
                        break
                    if self._video_needs_keyframe and not is_kf:
                        continue
                    self._video_needs_keyframe = False
                    self.h264_active = True
                    self._record_media_frame('h264')

                    self._frame_seq += 1
                    now_ts = time.time()
                    ts_ms = int(now_ts * 1000)
                    self._last_frame_time = now_ts
                    self._last_chromium_frame_time = now_ts
                    self._navigating = False

                    metadata = {"codec": "h264", "isKeyFrame": bool(is_kf), "page": self.page_metadata()}
                    if source_timestamp_us is not None:
                        metadata['source_timestamp_us'] = source_timestamp_us
                    meta_bytes = json.dumps(metadata).encode("utf-8")
                    sp_header = struct.pack(">2sIQH", b"SP", self._frame_seq, ts_ms, len(meta_bytes))
                    raw_bytes = sp_header + meta_bytes + nalu

                    if is_kf:
                        self._last_keyframe_packet = raw_bytes

                    self._notify_listeners({
                        "type": "frame",
                        "raw_bytes": raw_bytes,
                        "seq": self._frame_seq,
                        "metadata": metadata,
                        "timestamp": now_ts,
                        "_media_received_at": time.monotonic(),
                    })
            except (asyncio.IncompleteReadError, ConnectionRefusedError, OSError, asyncio.TimeoutError):
                self.h264_active = False
                if self.needs_h264_capture():
                    self._h264_connection_errors += 1
                await asyncio.sleep(0.5)
            except asyncio.CancelledError:
                break
            except Exception as e:
                self.h264_active = False
                logger.debug(f"H.264 stream loop notice: {e}")
                await asyncio.sleep(0.5)
            finally:
                self._stream_writer = None
                self._stream_reader = None
                if writer:
                    try:
                        writer.close()
                        await writer.wait_closed()
                    except Exception:
                        pass

    async def _keepalive_loop(self):
        """Monitors session URL synchronization, active page state, and sends heartbeats."""
        try:
            last_url_check = 0.0
            while self.is_connected:
                await asyncio.sleep(0.05)
                now = time.time()

                # 1. Periodic active URL sync (checks window.location.href every 1.0s)
                if now - last_url_check >= 1.0 and not self._selected_frame and not self.native_dialog:
                    last_url_check = now
                    try:
                        generation = self._navigation_generation
                        identity = await self.evaluate("({url: location.href, title: document.title})", timeout=0.5)
                        if generation == self._navigation_generation and isinstance(identity, dict):
                            self.update_page_metadata(identity.get("url"), identity.get("title"))
                    except Exception:
                        pass

                if self.h264_active:
                    continue  # Continuous 60 FPS H.264 stream handles all frame updates
                now = time.time()

                # Auto-clear navigation flag after 2.0s fallback timeout
                if self._navigating and (now - self._last_navigation_time > 2.0):
                    self._navigating = False


                if not self.listeners:
                    continue

                # Skip sending frames during active navigation to prevent ghost page display
                if self._navigating:
                    continue

                # ─── Silky-Smooth Live Stream Telemetry & Liveness ───
                # When Chromium is idle between actions, send lightweight heartbeats (18 bytes) every 250ms
                # This maintains connection liveness & RTT latency telemetry without saturating the WebSocket with 72 Mbps redundant JPEGs.
                chromium_idle_ms = (now - self._last_chromium_frame_time) * 1000
                if chromium_idle_ms >= 250 and (now - self._last_frame_time >= 0.250):
                    self._frame_seq += 1
                    ts_ms = int(now * 1000)
                    header = struct.pack(">2sIQH", b"SP", self._frame_seq, ts_ms, 2)
                    heartbeat_packet = header + b"{}"
                    self._notify_listeners({
                        "type": "frame",
                        "raw_bytes": heartbeat_packet,
                        "seq": self._frame_seq,
                        "metadata": {},
                        "timestamp": now,
                    })
                    self._last_frame_time = now
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.debug(f"Keepalive loop exit: {e}")

    async def _send_loop(self):
        """Dedicated outbound worker ensuring strictly sequential CDP message delivery.
        PriorityQueue ensures priority 0 (screencast ACKs) are ALWAYS delivered before priority 10 (regular commands).
        This prevents ACK starvation during rapid mouse/keyboard interactions with zero polling overhead."""
        try:
            while self.is_connected and self.cdp_ws:
                priority, msg_id, msg = await self._send_queue.get()
                try:
                    if self.cdp_ws:
                        await self.cdp_ws.send(msg)
                except Exception as e:
                    logger.debug(f"CDP send failed: {e}")
                finally:
                    self._send_queue.task_done()
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"Error in CDP send loop: {e}")

    def send_command_nowait(self, method: str, params: Optional[Dict[str, Any]] = None):
        if method.startswith("Input.") or method == "Page.navigate":
            self.mark_activity()
        """Fire-and-forget CDP command without waiting for or allocating an asyncio Future."""
        if not self.cdp_ws or not self.is_connected:
            return
        msg_id = self._next_id()
        payload = {"id": msg_id, "method": method}
        if params:
            payload["params"] = params
        try:
            self._send_queue.put_nowait((10, msg_id, json.dumps(payload)))
        except Exception:
            pass

    async def send_command(self, method: str, params: Optional[Dict[str, Any]] = None, timeout: float = 3.5, cdp_session_id=None) -> Any:
        if method.startswith("Input.") or method == "Page.navigate":
            self.mark_activity()
        if not self.cdp_ws or not self.is_connected:
            raise RuntimeError("CDP WebSocket is not connected.")
        if self.native_dialog:
            if method.startswith('Input.'):
                return {'dialogOpened':True}
            if method.startswith(('Runtime.','DOM.')):
                raise RuntimeError('Resolve the native dialog before evaluating page state.')
        msg_id = self._next_id()
        payload = {"id": msg_id, "method": method}
        if method == 'Runtime.evaluate' and self._selected_frame and 'contextId' not in (params or {}) and cdp_session_id is None:
            context=self.frame_contexts.get(self._selected_frame)
            if not context:raise RuntimeError('Selected frame was replaced; select a current frame before input.')
            params={**(params or {}),'contextId':context['context_id']}
            cdp_session_id=cdp_session_id or context.get('session_id')
        if params: payload["params"] = params
        if cdp_session_id:payload['sessionId']=cdp_session_id

        loop = asyncio.get_running_loop()
        fut = loop.create_future()
        self._pending_requests[msg_id] = fut

        self._send_queue.put_nowait((10, msg_id, json.dumps(payload)))
        if (method in {'Input.insertText', 'Input.dispatchKeyEvent', 'Page.navigate'} or
                (method=='Input.dispatchMouseEvent' and (params or {}).get('type') in {'mousePressed','mouseReleased','mouseWheel'})):
            self.dispatched_inputs+=1
        if ((method == 'Input.dispatchMouseEvent' and (params or {}).get('type') == 'mousePressed'
             and (params or {}).get('button') == 'left') or
            (method == 'Input.dispatchKeyEvent' and (params or {}).get('type') in {'keyDown','rawKeyDown'}
             and str((params or {}).get('key') or '').lower() in {'enter','return','space',' '})):
            # Count at enqueue, before ACK: a timeout cannot authorize replay.
            self.dispatched_activations += 1
        started = time.monotonic()
        dialog_wait = None
        try:
            if method in {'Input.dispatchMouseEvent','Input.dispatchKeyEvent'}:
                # Chrome may withhold the input ACK until a JavaScript dialog
                # is closed. Observe its opening without replaying the input.
                self._native_dialog_event.clear()
                dialog_wait=asyncio.create_task(self._native_dialog_event.wait())
                ready,_=await asyncio.wait({fut,dialog_wait},timeout=timeout,return_when=asyncio.FIRST_COMPLETED)
                if fut in ready:return fut.result()
                if dialog_wait in ready and self.native_dialog:return {'dialogOpened':True}
                raise TimeoutError('Browser input acknowledgment timed out; do not replay before reconciliation.')
            return await asyncio.wait_for(fut, timeout=timeout)
        finally:
            if dialog_wait:
                dialog_wait.cancel()
                await asyncio.gather(dialog_wait,return_exceptions=True)
            if not fut.done():fut.cancel()
            self._pending_requests.pop(msg_id, None)
            elapsed = time.monotonic()-started
            if elapsed >= 1.0:
                logger.warning('Slow browser command %s: %.2fs (mode=%s)',method,elapsed,self.config.mode)

    async def _listen_loop(self):
        try:
            while self.is_connected and self.cdp_ws:
                raw = await self.cdp_ws.recv()
                data = json.loads(raw)

                # Check if this is a response to a pending request
                if "id" in data and data["id"] in self._pending_requests:
                    fut = self._pending_requests.pop(data["id"])
                    if not fut.done():
                        if "error" in data:
                            fut.set_exception(RuntimeError(data["error"].get("message", "CDP Error")))
                        else:
                            fut.set_result(data.get("result", {}))
                    continue

                # Check if this is an event
                method = data.get("method", "")
                params = data.get("params", {})

                if method == "Browser.downloadWillBegin":
                    guid = params.get("guid")
                    if guid:
                        self.download_events[guid] = {
                            "guid": guid, "filename": params.get("suggestedFilename", ""),
                            "state": "inProgress", "received_bytes": 0,
                        }
                        if len(self.download_events) > 100:
                            self.download_events.pop(next(iter(self.download_events)))
                        self._download_event.set()
                elif method == "Browser.downloadProgress":
                    guid = params.get("guid")
                    if guid and guid in self.download_events:
                        event = self.download_events[guid]
                        event["state"] = params.get("state", event["state"])
                        event["received_bytes"] = params.get("receivedBytes", event["received_bytes"])
                        self._download_event.set()

                if method == "Runtime.executionContextCreated":
                    context = params.get("context", {})
                    aux = context.get("auxData", {})
                    if aux.get('isDefault') and aux.get('frameId'):
                        self.frame_contexts[aux['frameId']]={'context_id':context.get('id'),'session_id':data.get('sessionId'),
                                                           'url':context.get('origin',''),'name':context.get('name','')}
                    if not data.get('sessionId') and aux.get("isDefault") and aux.get("frameId") == self._main_frame_id:
                        self._main_context_id = context.get("id")
                elif method == "Runtime.executionContextDestroyed":
                    self.frame_contexts={k:v for k,v in self.frame_contexts.items() if not(v['context_id']==params.get('executionContextId') and v.get('session_id')==data.get('sessionId'))}
                    if not data.get('sessionId') and params.get("executionContextId") == self._main_context_id:
                        self._main_context_id = None
                elif method == "Runtime.executionContextsCleared":
                    self.frame_contexts={k:v for k,v in self.frame_contexts.items() if v.get('session_id')!=data.get('sessionId')}
                    if not data.get('sessionId'):self._main_context_id = None
                elif method == 'Target.attachedToTarget' and params.get('targetInfo',{}).get('type')=='iframe':
                    child=params.get('sessionId')
                    root=params.get('targetInfo',{}).get('targetId')
                    self.frame_session_roots[child]=root
                    if data.get('sessionId') in self.frame_session_roots:
                        self.frame_parents.setdefault(root,self.frame_session_roots[data['sessionId']])
                    asyncio.create_task(self._initialize_frame_session(child))
                elif method=='Page.frameAttached':
                    self.frame_parents[params.get('frameId')]=params.get('parentFrameId')
                elif method=='Page.frameDetached' and params.get('reason')!='swap':
                    self.frame_contexts.pop(params.get('frameId'),None)
                    self.frame_parents.pop(params.get('frameId'),None)
                elif method == "Runtime.bindingCalled" and params.get("name") == PAGE_STATE_BINDING:
                    if params.get("executionContextId") == self._main_context_id and self._main_context_id is not None:
                        try:
                            payload = params.get("payload", "")
                            if len(payload) <= 16384:
                                identity = json.loads(payload)
                                if isinstance(identity, dict):
                                    self.update_page_metadata(identity.get("url"), identity.get("title"))
                        except (ValueError, TypeError):
                            pass
                    continue

                # 1. Screencast Frame received from Chromium
                if method == "Page.screencastFrame":
                    frame_data = params.get("data")
                    session_id = params.get("sessionId")
                    # Send frame acknowledgment IMMEDIATELY via send queue to unlock next frame in Chromium
                    if session_id is not None and self.is_connected:
                        try:
                            ack_id = self._next_id()
                            ack_msg = json.dumps({
                                "id": ack_id,
                                "method": "Page.screencastFrameAck",
                                "params": {"sessionId": session_id}
                            })
                            self._send_queue.put_nowait((0, ack_id, ack_msg))
                        except Exception:
                            pass

                    if frame_data:
                        self._record_media_frame('jpeg')
                        metadata = {**params.get("metadata", {}), "page": self.page_metadata()}
                        now_ts = time.time()
                        self.latest_frame = frame_data
                        self._last_frame_time = now_ts
                        self._last_chromium_frame_time = now_ts
                        self._navigating = False  # Real frame arrived — navigation complete
                        self._frame_seq += 1
                        raw_bytes = None
                        try:
                            raw_jpeg = base64.b64decode(frame_data)
                            self._last_raw_jpeg = raw_jpeg
                            meta_bytes = json.dumps(metadata).encode("utf-8")
                            ts_ms = int(now_ts * 1000)
                            # 16-byte header: 'SP' (2B) + seq (4B) + ts_ms (8B) + metaLen (2B)
                            header = struct.pack(">2sIQH", b"SP", self._frame_seq, ts_ms, len(meta_bytes))
                            raw_bytes = b"".join([header, meta_bytes, raw_jpeg])
                        except Exception:
                            pass

                        self._notify_listeners({
                            "type": "frame",
                            "data": frame_data,
                            "raw_bytes": raw_bytes,
                            "seq": self._frame_seq,
                            "metadata": metadata,
                            "timestamp": now_ts,
                            "_media_received_at": self._last_jpeg_frame_at,
                        })

                # 2. Console log event
                elif method == "Runtime.consoleAPICalled":
                    args = params.get("args", [])
                    text = " ".join(str(a.get("value", a.get("description", ""))) for a in args)
                    if "__STACKPILOT_DOM_SCROLLED__" in text:
                        self.schedule_tree_refresh()
                        continue
                    if "__sp_" in text or "__STACKPILOT_" in text:
                        continue
                    log_item = {
                        "type": params.get("type", "log"),
                        "text": text,
                        "timestamp": params.get("timestamp", time.time()),
                    }
                    self.console_logs.append(log_item)
                    self._notify_listeners({"type": "console", "log": log_item})

                # 3. Exception event
                elif method == "Runtime.exceptionThrown":
                    details = params.get("exceptionDetails", {})
                    err_text = details.get("text", "") + " " + str(details.get("exception", {}).get("description", ""))
                    # Filter internal StackPilot runtime/style injection errors
                    if any(internal_term in err_text for internal_term in ["__sp_", "__STACKPILOT_", "appendChild", "__sp_click_ripple", "__sp_ripple_style"]):
                        continue
                    exc_item = {
                        "type": "error",
                        "text": err_text,
                        "timestamp": time.time(),
                    }
                    self.console_logs.append(exc_item)
                    self._notify_listeners({"type": "console", "log": exc_item})

                # 4. Navigated within page (full document or SPA in-document)
                elif not data.get('sessionId') and method in {"Page.frameNavigated", "Page.navigatedWithinDocument"}:
                    raw_nav_url = ""
                    if method == "Page.frameNavigated":
                        frame = params.get("frame", {})
                        if frame.get('id') in self.frame_contexts:
                            self.frame_contexts[frame['id']].update(url=frame.get('url',''),name=frame.get('name',''))
                        if not frame.get("parentId"):
                            self._main_frame_id = frame.get("id")
                            self._main_context_id = None
                            self._navigation_generation += 1
                            raw_nav_url = frame.get("url", "")
                    elif method == "Page.navigatedWithinDocument":
                        if params.get("frameId") == self._main_frame_id:
                            raw_nav_url = params.get("url", "")

                    if raw_nav_url and "chrome-error://" not in raw_nav_url:
                        self._last_navigation_time = time.time()
                        self._lifecycle_events.clear()
                        self.update_page_metadata(raw_nav_url, "" if method == "Page.frameNavigated" else None,
                                                  reset_document=method == "Page.frameNavigated")

                elif method == "Page.javascriptDialogOpening":
                    self.native_dialog = {'dialog_id':uuid.uuid4().hex, 'type':params.get('type'),
                                          'message':str(params.get('message',''))[:2000], 'url':params.get('url',''),
                                          '_cdp_session_id':data.get('sessionId')}
                    self._native_dialog_event.set()
                elif method == "Page.javascriptDialogClosed":
                    self.native_dialog = None
                    self._native_dialog_event.clear()
                # Preserve legitimate login/payment/help windows in this session's context.
                elif method in {"Target.targetCreated", "Target.targetInfoChanged"}:
                    target_info = params.get("targetInfo", {})
                    if (target_info.get("type") == "page" and target_info.get("targetId") != self.target_id
                            and (target_info.get("openerId") == self.target_id or target_info.get('targetId') in self.related_targets)):
                        extra_id = target_info.get("targetId")
                        self.related_targets[extra_id] = {k:target_info.get(k,'') for k in ('targetId','url','title','openerId','browserContextId')}
                elif method == 'Target.targetDestroyed':
                    self.related_targets.pop(params.get('targetId'),None)

                # 5. Network tracking for Quiescence
                elif method == "Network.requestWillBeSent":
                    req_id = params.get("requestId")
                    if req_id:
                        self._inflight_requests[str(req_id)] = time.time()
                        self._last_network_activity = time.time()

                elif method in {"Network.loadingFinished", "Network.loadingFailed"}:
                    req_id = params.get("requestId")
                    if req_id and str(req_id) in self._inflight_requests:
                        self._inflight_requests.pop(str(req_id), None)
                        self._last_network_activity = time.time()

                # 6. Page Lifecycle events (DOMContentLoaded, load, networkIdle)
                elif method == "Page.lifecycleEvent":
                    ev_name = params.get("name")
                    if ev_name:
                        self._lifecycle_events.add(str(ev_name))

        except ConnectionClosed:
            logger.info(f"CDP connection closed for session {self.session_id}")
        except Exception as e:
            logger.error(f"Error in CDP listener loop: {e}", exc_info=True)
        finally:
            self.is_connected = False

    def page_metadata(self):
        return {"url": self.current_url, "title": self.page_title,
                "session_id": self.session_id, "stream_id": self._stream_id,
                "state_seq": self._page_state_seq}

    def update_page_metadata(self, url, title=None, reset_document=False):
        if not isinstance(url, str) or not url or url.startswith("chrome-error://"):
            return
        clean_url = to_frontend_display_url(url)
        changed_url = clean_url != self.current_url
        next_title = title if isinstance(title, str) else ("" if changed_url else self.page_title)
        if not changed_url and next_title == self.page_title and not reset_document:
            return
        if changed_url or reset_document:
            self._selected_frame=None
            self.frame_offset=(0,0)
            self.frame_scale=(1,1)
            self._navigation_generation += 1
            self.interactive_elements = []
            self.discovered_subpages = []
            self._last_raw_jpeg = None
            self.latest_frame = None
        self.current_url, self.page_title = clean_url, next_title
        self._page_state_seq += 1
        event = {"type": "page_state", **self.page_metadata()}
        if changed_url or reset_document:
            event["elements"] = []
        self._notify_listeners(event)

    def add_listener(self, callback: Callable[[Dict[str, Any]], Any]):
        self.last_used = time.monotonic()
        self.listeners.add(callback)

    def remove_listener(self, callback: Callable[[Dict[str, Any]], Any]):
        self.last_used = time.monotonic()
        self.listeners.discard(callback)
        self.viewer_codecs.pop(callback,None)
        if self._viewer_feedback.remove(callback):
            aggregate = self._viewer_feedback.aggregate(self.listeners)
            if aggregate:
                self.stream_control(aggregate)

    def _notify_listeners(self, event: Dict[str, Any]):
        for listener in list(self.listeners):
            try:
                listener(event)
            except Exception as e:
                logger.error(f"Error notifying browser listener: {e}")

    async def _close_extra_tab(self, target_id: str):
        if not target_id:
            return
        try:
            headers = {"Host": "localhost", **self.config.headers}
            async with httpx.AsyncClient(timeout=2.0, trust_env=False, headers=headers) as client:
                await client.put(f"{self.config.endpoint}/json/close/{target_id}")
        except Exception:
            pass

    async def handle_native_dialog(self, arguments):
        dialog=self.native_dialog
        if not dialog or dialog['dialog_id']!=arguments.get('dialog_id') or type(arguments.get('accept')) is not bool:
            return {'status':'failed','error':'Native dialog is missing, changed or not explicitly accepted/dismissed. No action dispatched.'}
        # Clear before dispatch: a lost response must never replay a decision.
        self.native_dialog=None
        await self.send_command('Page.handleJavaScriptDialog',{'accept':arguments['accept'],'promptText':arguments.get('text','')},cdp_session_id=dialog.get('_cdp_session_id'))
        return {'status':'passed','verification':{'verified':True,'effect_type':'native_dialog_handled'}}

    async def switch_tab(self, target_id):
        if target_id not in self.related_targets or target_id==self.target_id:
            return {'status':'failed','error':'Select a different observed tab owned by this browser session.'}
        from .browser_testing.isolation import browser_command
        info=(await browser_command(self.config.endpoint,'Target.getTargetInfo',{'targetId':target_id},self.config.headers)).get('targetInfo',{})
        if self.browser_context_id and info.get('browserContextId')!=self.browser_context_id:
            return {'status':'failed','error':'Tab belongs to a different browser context. No switch performed.'}
        old=self.target_id
        self.related_targets[old]={'targetId':old,'url':self.current_url,'title':self.page_title,'browserContextId':self.browser_context_id}
        self.is_connected=False
        tasks=[self._read_task,self._send_task,self._keepalive_task,self._h264_task]
        for task in tasks:
            if task:task.cancel()
        await asyncio.gather(*(t for t in tasks if t),return_exceptions=True)
        await self.cdp_ws.close()
        for future in self._pending_requests.values():
            if not future.done():future.set_exception(RuntimeError('Tab switched before command completed.'))
        self._pending_requests.clear()
        self._send_queue=asyncio.PriorityQueue()
        self._jpeg_streaming=False
        self._selected_frame=None
        self.frame_offset=(0,0)
        self.frame_scale=(1,1)
        self.frame_contexts={}
        self.frame_parents={}
        self.frame_session_roots={}
        self._main_frame_id=self._main_context_id=None
        self.native_dialog=None
        self.pending_browser_approval=None
        self.target_id=target_id
        self.ws_url='ws://'+urlparse(self.config.endpoint).netloc+'/devtools/page/'+target_id
        self.cdp_ws=await websockets.connect(self.ws_url,max_size=10*1024*1024,additional_headers=self.config.headers,compression=None)
        self.update_page_metadata(info.get('url','about:blank'),info.get('title',''),reset_document=True)
        await self._initialize_target()
        await self.send_command('Page.bringToFront')
        await self.extract_interactive_tree()
        return {'status':'passed','target_id':target_id,'verification':{'verified':True,'effect_type':'tab_switch'}}

    async def switch_frame(self, frame_id):
        if frame_id in {'main',self._main_frame_id}:
            self._selected_frame=None
            self.frame_offset=(0,0)
            self.frame_scale=(1,1)
        elif frame_id in self.frame_contexts:
            # Obtain the owner box in the parent document before selecting its context.
            old=self._selected_frame
            self._selected_frame=None
            try:
                tree=(await self.send_command('Page.getFrameTree')).get('frameTree',{})
                def index_frames(node,parent=None):
                    frame=node.get('frame',{})
                    if parent:self.frame_parents[frame.get('id')]=parent
                    if frame.get('id') in self.frame_contexts:
                        self.frame_contexts[frame['id']].update(url=frame.get('url',''),name=frame.get('name',''))
                    for child in node.get('childFrames',[]):index_frames(child,frame.get('id'))
                index_frames(tree)
                from .browser_testing.frames import frame_transform
                ox,oy,sx,sy=await frame_transform(self,frame_id)
                self.frame_offset=(ox,oy);self.frame_scale=(sx,sy)
            except Exception:
                self._selected_frame=old
                return {'status':'failed','error':'Frame owner cannot be located; no frame input dispatched.'}
            self._selected_frame=frame_id
        else:return {'status':'failed','error':'Frame is missing or replaced. Observe current frame IDs.'}
        self.interactive_elements=[]
        await self.extract_interactive_tree()
        return {'status':'passed','frame_id':frame_id,'verification':{'verified':True,'effect_type':'frame_switch'}}

    async def connect(self):
        """Create a session-owned tab with isolated cookies and browser storage."""
        from .browser_testing.isolation import create_isolated_target, open_context_owner, dispose_context
        if self.config.mode == "remote":
            from .remote_browser_recovery import ensure_remote_browser_ready
            await ensure_remote_browser_ready(self.config.endpoint)
        self._context_owner = await open_context_owner(self.config.endpoint, self.config.headers)
        try:
            self.browser_context_id,self.target_id = await create_isolated_target(self.config.endpoint, self._context_owner,
                                                                                  fullscreen=bool(self.config.stream_host))
        except BaseException:
            await self._context_owner.close()
            self._context_owner = None
            raise
        self.ws_url = 'ws://'+urlparse(self.config.endpoint).netloc+'/devtools/page/'+self.target_id

        logger.info(f"Connecting to CDP at {self.ws_url}")
        try:
            self.cdp_ws = await websockets.connect(self.ws_url,max_size=10 * 1024 * 1024,
                                                   additional_headers=self.config.headers,
                                                   compression=None)
        except BaseException:
            await dispose_context(self.config.endpoint,self.browser_context_id,self.config.headers)
            self.browser_context_id = None
            await self._context_owner.close()
            self._context_owner = None
            raise
        await self._initialize_target()

    async def _initialize_target(self):
        self.related_targets.setdefault(self.target_id,{'targetId':self.target_id,'url':self.current_url,'title':self.page_title,'browserContextId':self.browser_context_id})
        self.is_connected = True
        self._read_task = asyncio.create_task(self._listen_loop())
        self._send_task = asyncio.create_task(self._send_loop())
        self._keepalive_task = asyncio.create_task(self._keepalive_loop())

        # Enable core domains
        await asyncio.gather(self.send_command("Page.enable"),
                             self.send_command("Runtime.enable"))
        if self.browser_context_id:
            # Save into the browser worker instead of opening a GTK Save File
            # dialog that CDP cannot dismiss. Never save to the user's host
            # machine when using Host Chrome. GUID names avoid collisions.
            download_behavior = {
                "behavior": "allowAndName" if self.config.mode in {"local", "remote"} else "deny",
                "browserContextId": self.browser_context_id, "eventsEnabled": True,
            }
            if self.config.mode in {"local", "remote"}:
                download_behavior["downloadPath"] = "/tmp"
            await self.send_command("Browser.setDownloadBehavior", download_behavior)
        tree = await self.send_command("Page.getFrameTree")
        self._main_frame_id = tree.get("frameTree", {}).get("frame", {}).get("id")
        self._main_context_id=self.frame_contexts.get(self._main_frame_id,{}).get('context_id')
        await self.send_command("Runtime.addBinding", {"name": PAGE_STATE_BINDING})
        await self.send_command("Page.addScriptToEvaluateOnNewDocument", {"source": PAGE_STATE_SCRIPT})
        await self.evaluate(PAGE_STATE_SCRIPT)
        # Tab-specific JPEG capture remains available if the video encoder stalls
        # or the client's browser does not support H.264 WebCodecs.
        await self.start_jpeg_stream()
        try:
            await self.send_command("Network.enable")
            await self.send_command("Page.setLifecycleEventsEnabled", {"enabled": True})
        except Exception as e:
            logger.debug(f"Optional network/lifecycle domain notice: {e}")

        # Set viewport to standard 1280x720
        await self.send_command("Emulation.setDeviceMetricsOverride", {
            "width": 1280,
            "height": 720,
            "deviceScaleFactor": 1,
            "mobile": False,
        })
        # Keep rAF/menus and CSS animations rendering smoothly even in background or headless tabs
        try:
            await self.send_command("Emulation.setFocusEmulationEnabled", {"enabled": True})
        except Exception as e:
            logger.debug(f"Focus emulation notice: {e}")


        # Observe target creation without rewriting application navigation semantics.
        try:
            await self.send_command("Page.addScriptToEvaluateOnNewDocument", {
                "source": """
                (() => {
                    try {
                        // WebGL Defensive Polyfill: Prevent Three.js/Canvas crashes on headless Chromium software contexts
                        if (typeof WebGLRenderingContext !== 'undefined') {
                            const origGetParam = WebGLRenderingContext.prototype.getParameter;
                            WebGLRenderingContext.prototype.getParameter = function(p) {
                                if (p === this.VERSION || p === 0x1F02) {
                                    return origGetParam.apply(this, arguments) || 'WebGL 1.0 (OpenGL ES 2.0 Chromium)';
                                }
                                return origGetParam.apply(this, arguments);
                            };
                        }
                        if (typeof WebGL2RenderingContext !== 'undefined') {
                            const origGetParam2 = WebGL2RenderingContext.prototype.getParameter;
                            WebGL2RenderingContext.prototype.getParameter = function(p) {
                                if (p === this.VERSION || p === 0x1F02) {
                                    return origGetParam2.apply(this, arguments) || 'WebGL 2.0 (OpenGL ES 3.0 Chromium)';
                                }
                                return origGetParam2.apply(this, arguments);
                            };
                        }

                    } catch(e) {}
                })();
                """
            })
            await self.send_command("Target.setAutoAttach", {
                "autoAttach": True,
                "waitForDebuggerOnStart": False,
                "flatten": True
            })
            await self.send_command("Target.setDiscoverTargets", {"discover": True})
        except Exception as e:
            logger.debug(f"Target/navigation policy notice: {e}")

        # The demand-aware reader retries a restarting media worker. A failed
        # one-time startup probe must not permanently pin this tab to JPEG.
        if self.config.stream_host:
            self._h264_task = asyncio.create_task(self._h264_stream_loop())

        # Inject in-page scroll event listener, stealth normalization, click ripple styles, and compositor pulse
        injection_js = """
        (() => {
          try {
            // 1. Headless Chrome Stealth Fingerprint Normalization
            try {
              Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined,
                configurable: true
              });
            } catch(e) {}

            try {
              Object.defineProperty(navigator, 'languages', {
                get: () => ['en-US', 'en'],
                configurable: true
              });
            } catch(e) {}

            try {
              if (!window.chrome) window.chrome = {};
              window.chrome.runtime = window.chrome.runtime || {
                PlatformOs: { MAC: 'mac', WIN: 'win', ANDROID: 'android', CROS: 'cros', LINUX: 'linux', OPENBSD: 'openbsd' },
                PlatformArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64' },
                OnInstalledReason: { INSTALL: 'install', UPDATE: 'update', CHROME_UPDATE: 'chrome_update' }
              };
            } catch(e) {}

            try {
              if (window.WebGLRenderingContext && !window.__sp_webgl_hooked) {
                window.__sp_webgl_hooked = true;
                const origGetParam = WebGLRenderingContext.prototype.getParameter;
                WebGLRenderingContext.prototype.getParameter = function(parameter) {
                  if (parameter === 37445) return 'Google Inc. (Intel)';
                  if (parameter === 37446) return 'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0)';
                  return origGetParam.apply(this, arguments);
                };
              }
            } catch(e) {}

            // 2. Canvas 2D Text Discovery Hook
            try {
              window.__sp_canvas_elements = window.__sp_canvas_elements || [];
              if (window.CanvasRenderingContext2D && !window.__sp_canvas_hooked) {
                window.__sp_canvas_hooked = true;
                const origFillText = CanvasRenderingContext2D.prototype.fillText;
                CanvasRenderingContext2D.prototype.fillText = function(text, x, y, maxWidth) {
                  try {
                    const str = String(text || '').trim();
                    if (str.length > 0 && str.length < 60 && this.canvas) {
                      const m = this.measureText(str);
                      const rect = this.canvas.getBoundingClientRect();
                      const fs = parseFloat(this.font) || 14;
                      if (rect.width > 10 && rect.height > 10) {
                        window.__sp_canvas_elements.push({
                          tag: 'canvas_text',
                          text: str,
                          x: Math.round(rect.left + x + m.width / 2),
                          y: Math.round(rect.top + y - fs / 2),
                          w: Math.round(m.width),
                          h: Math.round(fs),
                          page_x: Math.round(rect.left + (window.scrollX || 0) + x + m.width / 2),
                          page_y: Math.round(rect.top + (window.scrollY || 0) + y - fs / 2),
                          is_in_viewport: (rect.top + y) >= 0 && (rect.top + y) <= window.innerHeight,
                          timestamp: Date.now()
                        });
                        if (window.__sp_canvas_elements.length > 100) {
                          window.__sp_canvas_elements.splice(0, 40);
                        }
                      }
                    }
                  } catch(e) {}
                  return origFillText.apply(this, arguments);
                };
              }
            } catch(e) {}

            window.addEventListener('scroll', () => {
              clearTimeout(window.__sp_scroll_timer);
              window.__sp_scroll_timer = setTimeout(() => {
                console.log('__STACKPILOT_DOM_SCROLLED__');
              }, 80);
            }, { passive: true });

            // Hook history pushState & replaceState to intercept SPA client-side route transitions
            window.__sp_discovered_routes = window.__sp_discovered_routes || [];
            try {
              const origPush = history.pushState;
              history.pushState = function(state, title, url) {
                if (url) {
                  try {
                    const u = new URL(url, window.location.href);
                    if (u.origin === window.location.origin) {
                      const p = u.pathname + u.search + u.hash;
                      if (!window.__sp_discovered_routes.includes(p)) window.__sp_discovered_routes.push(p);
                    }
                  } catch(e) {}
                }
                return origPush.apply(this, arguments);
              };
              const origReplace = history.replaceState;
              history.replaceState = function(state, title, url) {
                if (url) {
                  try {
                    const u = new URL(url, window.location.href);
                    if (u.origin === window.location.origin) {
                      const p = u.pathname + u.search + u.hash;
                      if (!window.__sp_discovered_routes.includes(p)) window.__sp_discovered_routes.push(p);
                    }
                  } catch(e) {}
                }
                return origReplace.apply(this, arguments);
              };
            } catch(e) {}

            // 3. Autonomous In-Page Explorer & Anti-Trap Engine
            try {
              if (!window.__EXPLORER_ENGINE__) {
                class ExplorerEngine {
                  constructor() {
                    this.lastMutation = performance.now();
                    this.mutationCount = 0;
                    this.initObserver();
                  }

                  initObserver() {
                    try {
                      const obs = new MutationObserver((mutations) => {
                        this.mutationCount += mutations.length;
                        this.lastMutation = performance.now();
                      });
                      const target = document.documentElement || document.body;
                      if (target) {
                        obs.observe(target, { childList: true, attributes: true, subtree: true, characterData: true });
                      }
                    } catch(e) {}
                  }

                  async waitForSettle(quietMs = 35, maxTimeoutMs = 700) {
                    const start = performance.now();
                    await new Promise(r => setTimeout(r, 0));
                    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
                    while (performance.now() - start < maxTimeoutMs) {
                      const timeSince = performance.now() - this.lastMutation;
                      const runningAnims = document.getAnimations
                        ? document.getAnimations().filter(a => {
                            if (a.playState !== 'running') return false;
                            try {
                              const timing = a.effect ? a.effect.getComputedTiming() : {};
                              if (timing.iterations === Infinity || timing.duration === Infinity) return false;
                            } catch(e) {}
                            return true;
                          })
                        : [];
                      if (timeSince >= quietMs && runningAnims.length === 0) {
                        return { settled: true, duration: performance.now() - start };
                      }
                      await new Promise(r => setTimeout(r, 10));
                    }
                    return { settled: true, duration: performance.now() - start };
                  }

                  detectModals() {
                    const modals = [];
                    try {
                      document.querySelectorAll('dialog[open], [aria-modal="true"], [role="dialog"], [role="alertdialog"]').forEach(m => {
                        const style = window.getComputedStyle(m);
                        if (style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity || '1') > 0) {
                          modals.push(m);
                        }
                      });
                      document.querySelectorAll('div').forEach(d => {
                        const style = window.getComputedStyle(d);
                        if (style.position === 'fixed') {
                          const z = parseInt(style.zIndex, 10);
                          if (z >= 900) {
                            const rect = d.getBoundingClientRect();
                            if (rect.width >= window.innerWidth * 0.4 && rect.height >= window.innerHeight * 0.4) {
                              modals.push(d);
                            }
                          }
                        }
                      });
                    } catch(e) {}
                    return modals;
                  }

                  dismissModal() {
                    const modals = this.detectModals();
                    if (modals.length === 0) return false;
                    const top = modals[modals.length - 1];
                    const closeBtn = top.querySelector('button[aria-label*="close" i], button[title*="close" i], .close, .modal-close, [data-testid*="close" i]');
                    if (closeBtn && typeof closeBtn.click === 'function') {
                      closeBtn.click();
                      return true;
                    }
                    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
                    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
                    return true;
                  }

                  fillReactInput(el, val) {
                    try {
                      el.focus();
                      const proto = Object.getPrototypeOf(el);
                      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set ||
                                     Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set ||
                                     Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
                      if (setter) {
                        setter.call(el, val);
                      } else {
                        el.value = val;
                      }
                      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                      el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
                      return true;
                    } catch(e) {
                      return false;
                    }
                  }
                }
                window.__EXPLORER_ENGINE__ = new ExplorerEngine();
              }
            } catch(e) {}


            // WebGL Resilience Guard: prevents 3D framework crashes if context fails
            try {
              if (typeof HTMLCanvasElement !== 'undefined' && HTMLCanvasElement.prototype && !window.__sp_gl_guarded) {
                window.__sp_gl_guarded = true;
                const _origGetContext = HTMLCanvasElement.prototype.getContext;
                HTMLCanvasElement.prototype.getContext = function(type, ...args) {
                  const ctx = _origGetContext.call(this, type, ...args);
                  if (ctx) return ctx;
                  if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') {
                    const dummy = new Proxy({
                      canvas: this,
                      drawingBufferWidth: this.width || 300,
                      drawingBufferHeight: this.height || 150,
                      isDummyContext: true,
                    }, {
                      get(target, prop) {
                        if (prop in target) return target[prop];
                        if (prop === 'getExtension') return () => null;
                        if (prop === 'getParameter') return () => 0;
                        if (prop === 'getShaderPrecisionFormat') return () => ({ precision: 1, rangeMin: 1, rangeMax: 1 });
                        if (typeof prop === 'string' && prop.toUpperCase() === prop) return 0;
                        return () => {};
                      },
                      set(target, prop, val) {
                        target[prop] = val;
                        return true;
                      }
                    });
                    return dummy;
                  }
                  return ctx;
                };
              }
            } catch (e) {}
          } catch (e) {}
        })()
        """
        try:
            await self.send_command("Page.addScriptToEvaluateOnNewDocument", {"source": injection_js})
            await self.send_command("Runtime.evaluate", {"expression": injection_js})
        except Exception as e:
            logger.warning(f"Failed to inject scroll & ripple scripts: {e}")

    async def _initialize_frame_session(self,session_id):
        try:
            await asyncio.gather(self.send_command('Runtime.enable',cdp_session_id=session_id),
                                 self.send_command('Page.enable',cdp_session_id=session_id))
            await self.send_command('Target.setAutoAttach',{'autoAttach':True,'waitForDebuggerOnStart':False,'flatten':True},cdp_session_id=session_id)
            tree=(await self.send_command('Page.getFrameTree',cdp_session_id=session_id)).get('frameTree',{})
            def record(node,parent=None):
                frame=node.get('frame',{})
                if parent:self.frame_parents[frame['id']]=parent
                if frame.get('id') in self.frame_contexts:
                    self.frame_contexts[frame['id']].update(url=frame.get('url',''),name=frame.get('name',''))
                for child in node.get('childFrames',[]):record(child,frame.get('id'))
            self.frame_session_roots[session_id]=tree['frame']['id']
            record(tree)
        except Exception as exc:
            logger.debug('Child frame initialization unavailable: %s',exc)

    async def capture_screenshot(self, quality: int = 60, use_cache: bool = False) -> Optional[str]:
        """Captures a direct JPEG screenshot from Chromium via CDP or returns cached frame."""
        if use_cache and self.latest_frame:
            return self.latest_frame
        if not self.cdp_ws or not self.is_connected:
            return self.latest_frame or None
        try:
            res = await self.send_command("Page.captureScreenshot", {
                "format": "jpeg",
                "quality": quality,
            }, timeout=2.5)
            data = res.get("data") if isinstance(res, dict) else None
            if data:
                self.latest_frame = data
                try:
                    self._last_raw_jpeg = base64.b64decode(data)
                except Exception:
                    pass
                self._last_frame_time = time.time()
                return data
            return self.latest_frame
        except Exception as e:
            logger.debug(f"capture_screenshot notice: {e}")
            return self.latest_frame or None

    async def capture_som_screenshot(self, quality: int = 65) -> Optional[str]:
        """
        Captures a Set-of-Marks (SoM) visual grounding screenshot.
        Temporarily injects high-contrast numeric badge overlays over all active interactive elements ([data-sp-id]),
        captures a crisp CDP screenshot, and immediately cleans up the overlay from the DOM.
        """
        if not self.cdp_ws or not self.is_connected:
            return self.latest_frame or None

        som_inject_js = """
        (() => {
            try {
                const old = document.getElementById('__sp_som_overlay__');
                if (old) old.remove();

                const container = document.createElement('div');
                container.id = '__sp_som_overlay__';
                container.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483646;overflow:hidden;';

                const elements = document.querySelectorAll('[data-sp-id]');
                elements.forEach(el => {
                    const rect = el.getBoundingClientRect();
                    const spId = el.getAttribute('data-sp-id');
                    if (rect.width >= 4 && rect.height >= 4 && rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth) {
                        const badge = document.createElement('div');
                        badge.className = '__sp_som_badge__';
                        badge.textContent = spId;
                        const bx = Math.max(0, Math.min(window.innerWidth - 30, rect.left));
                        const by = Math.max(0, Math.min(window.innerHeight - 20, rect.top - 12));
                        badge.style.cssText = `
                            position: fixed;
                            left: ${bx}px;
                            top: ${by}px;
                            background: #facc15;
                            color: #000000;
                            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
                            font-size: 11px;
                            font-weight: 800;
                            line-height: 1;
                            padding: 2px 4px;
                            border-radius: 3px;
                            border: 1.5px solid #000000;
                            box-shadow: 0 1px 4px rgba(0,0,0,0.6);
                            z-index: 2147483647;
                            white-space: nowrap;
                        `;
                        container.appendChild(badge);

                        const box = document.createElement('div');
                        box.style.cssText = `
                            position: fixed;
                            left: ${rect.left}px;
                            top: ${rect.top}px;
                            width: ${rect.width}px;
                            height: ${rect.height}px;
                            border: 1.5px solid rgba(234, 179, 8, 0.7);
                            border-radius: 2px;
                            pointer-events: none;
                        `;
                        container.appendChild(box);
                    }
                });

                const target = document.body || document.documentElement;
                if (target) target.appendChild(container);
                return true;
            } catch (e) {
                return false;
            }
        })()
        """

        som_cleanup_js = """
        (() => {
            try {
                const el = document.getElementById('__sp_som_overlay__');
                if (el) el.remove();
                return true;
            } catch (e) {
                return false;
            }
        })()
        """

        try:
            await self.send_command("Runtime.evaluate", {
                "expression": som_inject_js,
                "returnByValue": True
            }, timeout=0.6)

            await self.send_command("Runtime.evaluate", {
                "expression": "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))",
                "awaitPromise": True
            }, timeout=0.6)

            res = await self.send_command("Page.captureScreenshot", {
                "format": "jpeg",
                "quality": quality,
            }, timeout=1.5)
            som_data = res.get("data") if isinstance(res, dict) else None

            await self.send_command("Runtime.evaluate", {
                "expression": som_cleanup_js,
                "returnByValue": True
            }, timeout=0.6)

            return som_data
        except Exception as e:
            logger.debug(f"capture_som_screenshot error: {e}")
            try:
                await self.send_command("Runtime.evaluate", {"expression": som_cleanup_js})
            except Exception:
                pass
            return self.latest_frame or None

    async def check_active_modal_or_overlay(self) -> Dict[str, Any]:
        """
        Checks if a modal dialog, drawer, alert popup, or subview overlay is actively visible on the page.
        Returns:
            {"is_modal": bool, "type": str, "title": str, "back_btn_text": str}
        """
        try:
            res = await self.send_command("Runtime.evaluate", {
                "expression": """(() => {
                    // 1. Explicit ARIA / Dialog elements (including PrimeNG, Angular CDK, SweetAlert2, AntD, Bootstrap)
                    const dialogSelectors = [
                        '[role="dialog"]',
                        '[role="alertdialog"]',
                        '[aria-modal="true"]',
                        'dialog[open]',
                        '.ui-dialog',
                        '.p-dialog',
                        '.cdk-overlay-pane',
                        '.swal2-container',
                        '.modal.show',
                        '.ant-modal-wrap',
                        '[class*="modal"][class*="open"]',
                        '[class*="Modal_open"]',
                        '[class*="dialog-content"]',
                        '[class*="modal-content"]'
                    ];
                    const dialogs = Array.from(document.querySelectorAll(dialogSelectors.join(', ')));
                    for (const dialog of dialogs) {
                        const style = window.getComputedStyle(dialog);
                        if (style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity || '1') > 0.1) {
                            const rect = dialog.getBoundingClientRect();
                            if (rect.width > 120 && rect.height > 80) {
                                const heading = dialog.querySelector('h1, h2, h3, h4, [class*="title"], [class*="header"]');
                                return {
                                    is_modal: true,
                                    type: 'dialog',
                                    title: heading ? (heading.textContent || '').trim() : 'Modal Dialog',
                                    back_btn_text: ''
                                };
                            }
                        }
                    }

                    // 2. Fixed/absolute overlay covering substantial viewport with high z-index or active mask
                    const masks = Array.from(document.querySelectorAll('.ui-dialog-mask, .p-dialog-mask, .modal-backdrop, .cdk-overlay-backdrop')).filter(m => {
                        const style = window.getComputedStyle(m);
                        return style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity || '1') > 0.05;
                    });
                    if (masks.length > 0) {
                        return {
                            is_modal: true,
                            type: 'dialog_mask',
                            title: 'Active Dialog Overlay',
                            back_btn_text: ''
                        };
                    }

                    const fixedEls = Array.from(document.querySelectorAll('div, section, aside, article')).filter(el => {
                        const style = window.getComputedStyle(el);
                        if (style.position === 'fixed' || (style.position === 'absolute' && parseInt(style.zIndex, 10) >= 10)) {
                            const z = parseInt(style.zIndex, 10);
                            if (!isNaN(z) && z >= 10) {
                                const rect = el.getBoundingClientRect();
                                return (
                                    rect.width >= window.innerWidth * 0.4 &&
                                    rect.height >= window.innerHeight * 0.35 &&
                                    style.visibility !== 'hidden' &&
                                    style.display !== 'none' &&
                                    parseFloat(style.opacity || '1') > 0.5
                                );
                            }
                        }
                        return false;
                    });
                    if (fixedEls.length > 0) {
                        const topEl = fixedEls[fixedEls.length - 1];
                        const heading = topEl.querySelector('h1, h2, h3, h4, [class*="title"]');
                        const backBtn = topEl.querySelector('button, a');
                        return {
                            is_modal: true,
                            type: 'fixed_overlay',
                            title: heading ? (heading.textContent || '').trim() : 'Active Overlay',
                            back_btn_text: backBtn ? (backBtn.textContent || '').trim() : ''
                        };
                    }

                    // 3. In-page Subview with prominent "Back to..." / "← Back" button near top of screen
                    const candidateBacks = Array.from(document.querySelectorAll('button, a')).filter(b => {
                        const t = (b.textContent || '').trim().toLowerCase();
                        return t.includes('back to') || t.includes('← back') || t === 'back' || t.includes('return to');
                    });
                    for (const b of candidateBacks) {
                        const rect = b.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0 && rect.top <= 250) {
                            return {
                                is_modal: true,
                                type: 'subview_with_back',
                                title: (b.textContent || '').trim(),
                                back_btn_text: (b.textContent || '').trim()
                            };
                        }
                    }

                    return { is_modal: false, type: 'none', title: '', back_btn_text: '' };
                })()""",
                "returnByValue": True
            }, timeout=1.0)
            val = res.get("result", {}).get("value")
            if isinstance(val, dict):
                return val
            return {"is_modal": False, "type": "none", "title": "", "back_btn_text": ""}
        except Exception:
            return {"is_modal": False, "type": "none", "title": "", "back_btn_text": ""}

    async def dismiss_active_modal(self) -> bool:
        """Close one observed, harmless overlay through the normal native executor."""
        from .browser_testing.widgets import observe_widgets
        from .browser_testing.permissions import observe_step, permission_reason
        await self.extract_interactive_tree()
        overlay=(await observe_widgets(self)).get('active_overlay')
        if not overlay:return False
        candidates=[c for c in overlay['controls'] if not c.get('disabled') and
                    re.fullmatch(r'(?:close(?:\s+(?:dialog|advisory|popup|window))?|dismiss|cancel|back|go back|[×✕])',c.get('text',''),re.I)]
        if len(candidates)!=1:return False
        arguments={'action':'click','element_id':candidates[0]['id']}
        control=await observe_step(self,arguments)
        if permission_reason(arguments,control):return False
        if not await self.click_element(candidates[0]['id'],label=candidates[0]['text']):return False
        current=(await observe_widgets(self)).get('active_overlay')
        return not current or current['id']!=overlay['id']

    async def auto_dismiss_startup_modals(self) -> bool:
        """Legacy entry point; never selects consent/language or hides a backdrop."""
        return await self.dismiss_active_modal()

    async def force_fresh_frame(self) -> Optional[str]:
        """Forces Chromium to render and capture an immediate fresh frame, broadcasting it to live stream listeners."""
        if not self.cdp_ws or not self.is_connected:
            return None
        # Action feedback is demand-driven. Explicit vision observations use
        # capture_screenshot; do not render duplicate JPEGs for unviewed tabs
        # or viewers already receiving the desktop video stream.
        if not self.listeners or (self.h264_active and all(self.viewer_codecs.get(v) == 'h264' for v in self.listeners)):
            return self.latest_frame
        # Fast path: If a fresh screencast frame arrived recently (< 200ms ago) from the live screencast stream,
        # return it immediately without blocking on Page.captureScreenshot (saves 250-300ms per action).
        now_ts = time.time()
        if self.latest_frame and (now_ts - self._last_frame_time) < 0.20:
            return self.latest_frame
        try:
            res = await self.send_command("Page.captureScreenshot", {
                "format": "jpeg",
                "quality": 60,
            }, timeout=2.0)
            frame_data = res.get("data") if isinstance(res, dict) else None
            if frame_data:
                now_ts = time.time()
                self.latest_frame = frame_data
                self._last_frame_time = now_ts
                self._last_chromium_frame_time = now_ts
                self._frame_seq += 1
                raw_jpeg = base64.b64decode(frame_data)
                self._last_raw_jpeg = raw_jpeg
                ts_ms = int(now_ts * 1000)
                header = struct.pack(">2sIQH", b"SP", self._frame_seq, ts_ms, 2)
                packet = header + b"{}" + raw_jpeg
                self._notify_listeners({
                    "type": "frame",
                    "data": frame_data,
                    "raw_bytes": packet,
                    "seq": self._frame_seq,
                    "metadata": {},
                    "timestamp": now_ts,
                })
                return frame_data
        except Exception as e:
            logger.debug(f"force_fresh_frame notice: {e}")
        return self.latest_frame

    async def evaluate(self, expression: str, timeout: float = 2.5) -> Any:
        """Evaluates a JavaScript expression in the page context and returns the value."""
        try:
            res = await self.send_command("Runtime.evaluate", {
                "expression": expression,
                "returnByValue": True,
                "awaitPromise": True,
            }, timeout=timeout)
            return res.get("result", {}).get("value")
        except Exception as e:
            logger.debug(f"evaluate error: {e}")
            return None

    async def wait_for_scroll_settled(self, min_quiet_ms: int = 150, max_timeout_s: float = 2.5) -> bool:
        """
        Guarantees that page scrolling has come to a dead stop before proceeding.
        Uses requestAnimationFrame to sample window.scrollY / window.scrollX until:
        1. Position delta is < 1px for at least 4 consecutive frames (no velocity).
        2. At least min_quiet_ms has elapsed with no scroll events or coordinate shift.
        3. Double RAF pass ensures repaint and layout are committed.
        """
        settle_js = f"""
        new Promise((resolve) => {{
            let start = performance.now();
            let lastY = window.scrollY || window.pageYOffset || 0;
            let lastX = window.scrollX || window.pageXOffset || 0;
            let lastMoveTime = performance.now();
            let unchangedFrames = 0;
            let settled = false;

            const onScroll = () => {{
                lastMoveTime = performance.now();
                lastY = window.scrollY || window.pageYOffset || 0;
                lastX = window.scrollX || window.pageXOffset || 0;
                unchangedFrames = 0;
            }};
            window.addEventListener('scroll', onScroll, {{ passive: true, capture: true }});
            if ('onscrollend' in window) {{
                window.addEventListener('scrollend', onScroll, {{ passive: true, capture: true }});
            }}

            function check() {{
                if (settled) return;
                const now = performance.now();
                const currY = window.scrollY || window.pageYOffset || 0;
                const currX = window.scrollX || window.pageXOffset || 0;

                if (Math.abs(currY - lastY) < 1.0 && Math.abs(currX - lastX) < 1.0) {{
                    unchangedFrames++;
                }} else {{
                    unchangedFrames = 0;
                    lastMoveTime = now;
                    lastY = currY;
                    lastX = currX;
                }}

                const quietMs = now - lastMoveTime;
                const totalElapsed = now - start;

                if ((unchangedFrames >= 4 && quietMs >= {min_quiet_ms}) || totalElapsed >= {int(max_timeout_s * 1000)}) {{
                    settled = true;
                    window.removeEventListener('scroll', onScroll, {{ capture: true }});
                    if ('onscrollend' in window) {{
                        window.removeEventListener('scrollend', onScroll, {{ capture: true }});
                    }}
                    requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
                }} else {{
                    requestAnimationFrame(check);
                }}
            }}

            requestAnimationFrame(() => requestAnimationFrame(check));
        }})
        """
        try:
            res = await self.send_command("Runtime.evaluate", {
                "expression": settle_js,
                "awaitPromise": True,
                "returnByValue": True,
            }, timeout=max_timeout_s + 1.0)
            return res.get("result", {}).get("value") is True
        except Exception:
            return True

    async def wait_for_quiescence(
        self,
        network_idle_ms: int = 80,
        dom_quiet_ms: int = 40,
        scroll_quiet_ms: int = 80,
        max_timeout_s: float = 2.0,
        fast_mode: bool = False,
        fast_check: Optional[bool] = None,
    ) -> bool:
        """
        Quad-Phase Quiescence Strategy:
        1. Fast Check: Only bypass if document is complete, network is idle, no active scroll or running animations, and fast_mode is explicit.
        2. Network Idle: Wait until in-flight requests drop to 0.
        3. Scroll & CSS Animation Settling: Await window.scrollY motion rest and document.getAnimations() completion.
        4. DOM Mutation Quiescence + Double RAF: Ensures painting and layout commits are finished.
        """
        if fast_check is not None:
            fast_mode = fast_check
        start = time.time()
        # Fast path check for already settled pages (only if fast_mode is explicitly enabled)
        if fast_mode:
            try:
                chk = await self.send_command("Runtime.evaluate", {
                    "expression": """
                    (() => {
                        if (document.readyState !== 'complete') return false;
                        if (typeof document.getAnimations === 'function') {
                            const active = document.getAnimations().some(a => {
                                if (a.playState !== 'running') return false;
                                const timing = a.effect && a.effect.getTiming ? a.effect.getTiming() : {};
                                return timing.iterations !== Infinity && timing.duration !== Infinity;
                            });
                            if (active) return false;
                        }
                        return true;
                    })()
                    """,
                    "returnByValue": True
                }, timeout=0.3)
                if chk.get("result", {}).get("value") is True and len(self._inflight_requests) == 0:
                    return True
            except Exception:
                pass

        # 1. Network quiescence check
        now_ts = time.time()
        stale_keys = [k for k, start_t in self._inflight_requests.items() if (now_ts - start_t) > 1.5]
        for k in stale_keys:
            self._inflight_requests.pop(k, None)

        while (time.time() - start) < (max_timeout_s * 0.25):
            inflight = len(self._inflight_requests)
            quiet_time = (time.time() - self._last_network_activity) * 1000
            if inflight == 0 or quiet_time >= (network_idle_ms * 0.3):
                break
            await asyncio.sleep(0.01)

        # 2. Comprehensive Scroll, Animation, and DOM Settling Script
        # A fast click is explicitly capped below 400 ms. The former 400 ms
        # floor silently defeated that cap whenever the site had animations.
        remaining = max(0.05 if fast_mode else 0.4, max_timeout_s - (time.time() - start))
        settle_js = f"""
        new Promise((resolve) => {{
            let done = false;
            let lastMutation = performance.now();
            let lastScroll = performance.now();
            let lastScrollY = window.scrollY || 0;
            let lastScrollX = window.scrollX || 0;
            let timer = null;

            const onScroll = () => {{
                lastScroll = performance.now();
                lastScrollY = window.scrollY || 0;
                lastScrollX = window.scrollX || 0;
            }};
            window.addEventListener('scroll', onScroll, {{ passive: true, capture: true }});
            if ('onscrollend' in window) {{
                window.addEventListener('scrollend', onScroll, {{ passive: true, capture: true }});
            }}

            let observer = null;
            try {{
                observer = new MutationObserver(() => {{
                    lastMutation = performance.now();
                }});
                const target = document.body || document.documentElement;
                if (target) {{
                    observer.observe(target, {{ childList: true, subtree: true, attributes: true, characterData: true }});
                }}
            }} catch(e) {{}}

            const complete = () => {{
                if (done) return;
                done = true;
                window.removeEventListener('scroll', onScroll, {{ capture: true }});
                if ('onscrollend' in window) {{
                    window.removeEventListener('scrollend', onScroll, {{ capture: true }});
                }}
                if (observer) {{
                    try {{ observer.disconnect(); }} catch(e) {{}}
                }}
                if (timer) clearTimeout(timer);
                requestAnimationFrame(() => {{
                    requestAnimationFrame(() => {{
                        resolve(true);
                    }});
                }});
            }};

            const safetyTimeout = setTimeout(complete, {int(remaining * 1000)});

            const areAnimationsSettled = () => {{
                try {{
                    if (typeof document.getAnimations === 'function') {{
                        const anims = document.getAnimations();
                        for (const anim of anims) {{
                            if (anim.playState !== 'running') continue;
                            const effect = anim.effect;
                            if (effect) {{
                                const timing = effect.getTiming ? effect.getTiming() : {{}};
                                if (timing.iterations === Infinity || timing.duration === Infinity) continue;
                                const target = effect.target;
                                if (target && target.className && typeof target.className === 'string' && target.className.includes('__sp_')) continue;
                            }}
                            return false;
                        }}
                    }}
                }} catch(e) {{}}
                return true;
            }};

            const isScrollSettled = () => {{
                const now = performance.now();
                const currY = window.scrollY || 0;
                const currX = window.scrollX || 0;
                if (Math.abs(currY - lastScrollY) > 0.5 || Math.abs(currX - lastScrollX) > 0.5) {{
                    lastScroll = now;
                    lastScrollY = currY;
                    lastScrollX = currX;
                    return false;
                }}
                return (now - lastScroll) >= {scroll_quiet_ms};
            }};

            const check = () => {{
                if (done) return;
                const now = performance.now();
                const domQuiet = (now - lastMutation) >= {dom_quiet_ms};
                const scrollQuiet = isScrollSettled();
                const animQuiet = areAnimationsSettled();

                if (domQuiet && scrollQuiet && animQuiet) {{
                    complete();
                }} else {{
                    timer = setTimeout(check, 25);
                }}
            }};

            timer = setTimeout(check, 30);
        }})
        """
        try:
            await self.send_command("Runtime.evaluate", {
                "expression": settle_js,
                "awaitPromise": True,
                "returnByValue": True
            }, timeout=remaining + 1.0)
        except Exception:
            pass

        return True

    async def wait_for_action_quiescence(
        self,
        pre_url: str = "",
        is_transition: bool = False,
        min_grace_ms: int = 35,
        max_timeout_s: float = 1.2,
        fast_mode: bool = False,
    ) -> bool:
        """
        Wait until an action (form submission, login, button click, route navigation)
        has completely finished executing on the website with sub-second responsiveness.
        """
        if fast_mode:
            min_grace_ms = min(min_grace_ms, 15)
            max_timeout_s = min(max_timeout_s, 0.25)
        start = time.time()
        # 1. Brief grace period for action dispatch and event initiation
        await asyncio.sleep(min_grace_ms / 1000.0)

        # 2. Purge stale inflight requests and wait for short-lived network activity
        now_ts = time.time()
        stale_keys = [k for k, start_t in self._inflight_requests.items() if (now_ts - start_t) > 1.5]
        for k in stale_keys:
            self._inflight_requests.pop(k, None)

        network_wait_limit = min(max_timeout_s, 0.25 if is_transition else (0.05 if fast_mode else 0.12))
        while (time.time() - start) < network_wait_limit:
            inflight = len(self._inflight_requests)
            if inflight == 0:
                break
            quiet_time = (time.time() - self._last_network_activity) * 1000
            if quiet_time >= (15 if fast_mode else 35):
                break
            await asyncio.sleep(0.01)

        # 3. Check for document loading or visible spinners / busy states in DOM
        busy_check_js = """
        (() => {
            if (document.readyState !== 'complete') return true;
            const busyEls = Array.from(document.querySelectorAll('[aria-busy="true"], [data-loading="true"], .spinner, .loading, [class*="animate-spin"], [class*="loading-spinner"]'));
            for (const el of busyEls) {
                if (el.offsetParent !== null || el.getClientRects().length > 0) {
                    const s = window.getComputedStyle(el);
                    if (s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0') return true;
                }
            }
            const disBtns = Array.from(document.querySelectorAll('button[disabled], input[type="submit"][disabled]'));
            for (const b of disBtns) {
                const t = (b.innerText || b.value || '').toLowerCase().trim();
                // Never treat static disabled buttons (e.g. waitlist, unauthenticated login) as loading spinners
                if (t.includes('waitlist') || t === 'log in' || t === 'login' || t.includes('log in')) continue;
                if (t.includes('submitting...') || t.includes('processing...') || t.includes('please wait') || t.includes('loading...')) return true;
            }
            return false;
        })()
        """
        busy_limit = min(max_timeout_s, 0.6 if is_transition else 0.15)
        while (time.time() - start) < busy_limit:
            try:
                chk = await self.send_command("Runtime.evaluate", {
                    "expression": busy_check_js,
                    "returnByValue": True
                }, timeout=0.4)
                is_busy = bool(chk.get("result", {}).get("value"))
                if not is_busy:
                    break
            except Exception:
                break
            await asyncio.sleep(0.03)

        # 4. Check if route changed (window.location.href vs pre_url)
        try:
            url_res = await self.send_command("Runtime.evaluate", {
                "expression": "window.location.href",
                "returnByValue": True
            }, timeout=0.4)
            live_href = str(url_res.get("result", {}).get("value") or "")
            if live_href and "chrome-error://" not in live_href:
                disp_url = to_frontend_display_url(live_href)
                norm_live = disp_url.rstrip("/").lower()
                norm_pre = (pre_url or "").rstrip("/").lower()
                if norm_pre and norm_live and norm_live != norm_pre:
                    self.current_url = disp_url
                    # Route changed: brief wait for hydration
                    await asyncio.sleep(0.08)
        except Exception:
            pass

        # 5. Fast DOM quiescence & layout commit
        await self.wait_for_quiescence(
            network_idle_ms=40,
            dom_quiet_ms=20,
            scroll_quiet_ms=30,
            max_timeout_s=0.35,
            fast_mode=True
        )
        return True

    async def navigate(self, url: str, force: bool = False) -> Dict[str, Any]:
        """Navigate to URL and wait for tri-phase quiescence (network idle, DOM mutations quiet, double RAF)."""
        internal_url = self.config.resolve_url(url)
        display_url = to_frontend_display_url(url)
        norm_target = display_url
        norm_curr = self.current_url or ""
        if not force and norm_curr and norm_target == norm_curr and norm_target not in {"about:blank", ""}:
            # Already on this exact URL, skip redundant reload
            return {"url": self.current_url}

        # Suppress stale keepalive re-broadcast during navigation
        self._navigating = True
        self._last_raw_jpeg = None  # Clear raw screenshot cache
        # Retain self.latest_frame so screencast clients have smooth persistent visuals until next frame paints
        self._notify_listeners({"type": "action", "action": "navigate", "url": display_url})
        self._lifecycle_events.clear()
        res = None
        try:
            try:
                res = await self.send_command("Page.navigate", {"url": internal_url}, timeout=15.0)
            except asyncio.TimeoutError:
                logger.warning(f"Page.navigate timed out after 15s for {internal_url}; checking if navigation committed...")
                curr_href = await self.evaluate("window.location.href", timeout=1.5)
                if curr_href and curr_href != "about:blank":
                    res = {"url": curr_href}
                else:
                    raise
        except BaseException:
            self._navigating = False
            raise

        if isinstance(res, dict) and res.get('errorText'):
            self._navigating = False
            raise RuntimeError(f"Browser navigation failed: {str(res['errorText'])[:160]}")

        for _ in range(30):
            if "DOMContentLoaded" in self._lifecycle_events or "load" in self._lifecycle_events:
                break
            try:
                state = await self.evaluate("document.readyState", timeout=0.25)
                if state in {"interactive", "complete"}:
                    break
            except Exception:
                pass
            await asyncio.sleep(0.08)

        await self.wait_for_quiescence(network_idle_ms=80, dom_quiet_ms=30, max_timeout_s=1.2, fast_mode=True)

        # Fast hydration check (up to 400ms max, breaks immediately once controls exist)
        for _ in range(5):
            try:
                chk = await self.send_command("Runtime.evaluate", {
                    "expression": """
                    (() => {
                        const txt = (document.body ? document.body.textContent : '') || '';
                        const hasControls = document.querySelectorAll('button, input, a[href], [role="button"]').length >= 2;
                        if (hasControls) return false; // Ready immediately!
                        const isHydrating = txt.includes('Loading') || (txt.length < 50 && txt.toLowerCase().includes('loading'));
                        return isHydrating;
                    })()
                    """,
                    "returnByValue": True
                }, timeout=0.4)
                if chk.get("result", {}).get("value") is True:
                    await asyncio.sleep(0.06)
                else:
                    break
            except Exception:
                break


        # Present dialogs to the planner. Their choices can carry consent or
        # submit a transaction; navigation must not accept them implicitly.

        try:
            await self.extract_interactive_tree()
            if hasattr(self, "pda") and self.pda:
                cur_top = self.pda.current_frame()
                if not cur_top or cur_top.url != self.current_url:
                    arch_val = self.current_archetype.value if hasattr(self.current_archetype, "value") else str(self.current_archetype)
                    self.pda.push(
                        url=self.current_url,
                        title=self.page_title,
                        archetype=arch_val,
                        parent_url=cur_top.url if cur_top else ""
                    )
        except Exception:
            pass
        finally:
            self._navigating = False
            try:
                await self.force_fresh_frame()
            except Exception:
                pass
        return res

    def schedule_tree_refresh(self):
        """Coalesce passive scroll notifications; agent tools obtain fresh state themselves."""
        if self._tree_refresh_task is not None and not self._tree_refresh_task.done():
            return
        async def refresh():
            try:
                await asyncio.sleep(.12)
                if self.is_connected and self.session_id not in browser_manager.busy_sessions:
                    await self.extract_interactive_tree()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.debug("Passive browser observation failed: %s", type(exc).__name__)
            finally:
                self._tree_refresh_task = None
        self._tree_refresh_task = asyncio.create_task(refresh())

    async def extract_interactive_tree(self) -> Dict[str, Any]:
        # Keep explicit observations fresh, but never run overlapping full DOM scans.
        async with self._tree_lock:
            return await self._extract_interactive_tree()

    async def _extract_interactive_tree(self) -> Dict[str, Any]:
        """Traverses light DOM + open shadow roots to return interactive elements (buttons, links, inputs, tabs, toggles) with viewport and page coordinates."""
        from .browser_testing.overlays import OVERLAY_HELPERS
        from .browser_testing.accessibility import CONTROL_NAME_HELPERS
        from .browser_testing.checkables import CHECKABLE_HELPERS
        generation = self._navigation_generation
        state_seq = self._page_state_seq
        js_code = r"""
        (() => {
            const elements = [];
            const seen = new Set();
            __SP_OVERLAY_HELPERS__
            __SP_CONTROL_NAME_HELPERS__
            __SP_CHECKABLE_HELPERS__
            const activeOverlay = window.__spOverlay.active();
            const overlayControls = new Set(activeOverlay ? window.__spOverlay.controls(activeOverlay) : []);
            
            // Persistent in-browser DOM node cache with WeakMap identity preservation
            const cache = window.__spFast = window.__spFast || {
                ids: new WeakMap(),
                nodes: new Map(),
                nextId: __SP_INITIAL_ID__
            };
            // BFCache restores the old DOM and its WeakMap. Its references
            // belong to a previous navigation, even when the URL is unchanged.
            if (cache.generation !== __SP_GENERATION__ || cache.owner !== __SP_CACHE_OWNER__) {
                cache.ids = new WeakMap();
                cache.nodes.clear();
                cache.generation = __SP_GENERATION__;
                cache.owner = __SP_CACHE_OWNER__;
            }
            cache.nextId = Math.max(cache.nextId, __SP_INITIAL_ID__);
            // Clean up disconnected nodes to prevent memory leaks
            for (const [id, e] of cache.nodes) {
                if (!e || !e.isConnected) cache.nodes.delete(id);
            }

            // Global persistent ID allocator (shared by tree extraction & autocomplete harvester)
            window.__spGetOrAssignId = function(node) {
                if (!node) return null;
                let id = cache.ids.get(node);
                if (id === undefined) {
                    // Cloned/replaced controls may copy data attributes.
                    // Only node identity can preserve an existing reference.
                    id = cache.nextId++;
                    cache.ids.set(node, id);
                }
                cache.nodes.set(id, node);
                // Rewriting an unchanged ID triggers page mutation observers on
                // every action. Preserve node identity without that extra work.
                try {
                    if (node.getAttribute('data-sp-id') !== String(id)) node.setAttribute('data-sp-id', String(id));
                } catch(e) {}
                return id;
            };

            const isVisible = (e) => {
                if (!e || !e.isConnected) return false;
                if (e.closest && e.closest('[inert]')) return false;
                if (e.closest && e.closest('[aria-hidden="true"]') && !overlayControls.has(e)) return false;
                if (spNativeCheckable(e)) return !!spCheckableSurface(e);
                if (typeof e.checkVisibility === 'function') {
                    return e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
                }
                const s = window.getComputedStyle(e);
                return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
            };

            function collectNodes(root, depth = 0) {
                const list = [];
                if (depth > 2 || !root || !root.querySelectorAll) return list;
                const selector = 'button, a[href], input, select, textarea, .ace_editor, .CodeMirror, .cm-editor, .monaco-editor, [role="textbox"], [role="button"], [role="link"], [role="tab"], [role="switch"], [role="checkbox"], [role="combobox"], [role="option"], [role="menuitem"], [role="alert"], [role="status"], [contenteditable="true"], [tabindex="0"], summary, details, li.ui-autocomplete-list-item, li.p-autocomplete-item, [class*="autocomplete-item"], [class*="suggestion-item"], [class*="dropdown-item"], .ui-message-error, .invalid-feedback, .alert, .toast, .pac-item';
                try {
                    const matched = [...root.querySelectorAll(selector)].map(node => {
                        const r=node.getBoundingClientRect();
                        return {node, inView:isVisible(node) && r.bottom>0 && r.top<innerHeight && r.right>0 && r.left<innerWidth};
                    }).sort((a,b)=>Number(b.inView)-Number(a.inView)).map(item=>item.node);
                    for (let i = 0; i < matched.length && list.length < 450; i++) {
                        list.push(matched[i]);
                    }
                    const known = new Set(list);
                    const customIncluded = [];
                    // Frameworks often attach handlers through event delegation.
                    // Include visible custom hit targets whose pointer cursor
                    // identifies the boundary of a clickable region, even when
                    // onclick/role/tabindex are absent. Reserve a separate quota
                    // so a link-heavy page cannot hide its search/date controls.
                    const custom = root.querySelectorAll('div,span');
                    let customCount = 0;
                    for (let i=0;i<custom.length && customCount<150;i++) {
                        const node=custom[i];
                        if (known.has(node) || node.closest('a,button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[role="switch"],[role="checkbox"],[role="combobox"],[role="option"],[role="menuitem"],[contenteditable="true"],[tabindex="0"],summary')) continue;
                        if (customIncluded.some(ancestor => ancestor.contains(node))) continue;
                        const box=node.getBoundingClientRect();
                        if (box.width<12 || box.height<12 || box.bottom<=0 || box.top>=innerHeight || box.right<=0 || box.left>=innerWidth) continue;
                        const name=(node.getAttribute('aria-label') || node.getAttribute('title') || node.innerText || '').trim();
                        if (!name || name.length>180 || !isVisible(node)) continue;
                        const directClick=typeof node.onclick==='function';
                        const pointer=getComputedStyle(node).cursor==='pointer';
                        if (!directClick && !pointer) continue;
                        // Only suppress descendants of a control we actually
                        // admitted. An oversized pointer parent may be just a
                        // layout shell around a smaller delegated target.
                        list.push(node); known.add(node); customIncluded.push(node); customCount++;
                    }
                    // For shadow DOM, inspect custom elements with shadow roots (limit sample to 60)
                    const shadowHosts = Array.from(root.querySelectorAll('*')).filter(n=>n.shadowRoot).slice(0,60);
                    for (let i = 0; i < shadowHosts.length; i++) {
                        if (shadowHosts[i].shadowRoot) {
                            list.push(...collectNodes(shadowHosts[i].shadowRoot, depth + 1));
                        }
                    }
                } catch(e) {}
                return list;
            }

            // Portals can mount after hundreds of background links. Reserve
            // their controls before any document quota or prompt pagination.
            const nodes = [...overlayControls, ...collectNodes(document)];
            const scrollY = Math.round(window.scrollY || window.pageYOffset || 0);
            const scrollX = Math.round(window.scrollX || window.pageXOffset || 0);
            const winH = window.innerHeight || 720;
            const winW = window.innerWidth || 1280;
            const docH = Math.max(
                document.body ? document.body.scrollHeight : 0,
                document.documentElement ? document.documentElement.scrollHeight : 0,
                winH
            );

            for (let i = 0; i < nodes.length; i++) {
                const el = nodes[i];
                if (seen.has(el)) continue;
                seen.add(el);

                // Fast C++ visibility check avoids expensive getComputedStyle layout thrashing
                if (!isVisible(el)) continue;

                const checkable = spCheckableSurface(el);
                const surface = checkable?.node || el;
                const rect = surface.getBoundingClientRect();
                if (rect.width < 3 || rect.height < 3) continue;

                const visibleText = (el.innerText || '').trim();
                const accessibleText = (spControlName(el) || checkable?.caption?.innerText || el.getAttribute('title') || '').trim();
                let text = /SafeValue|<\/?(?:body|html|script)|\[property\]/i.test(accessibleText) ? visibleText : accessibleText;
                if (!text) {
                    text = (visibleText || el.placeholder ||
                            (el.type === 'password' ? '' : el.value) || el.name || '').trim();
                }
                if (!text && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
                    // Custom autocomplete inputs often have no own label. A
                    // short wrapper caption (for example "From") is useful
                    // context without leaking an unrelated page section.
                    let parent = el.parentElement;
                    for (let depth = 0; parent && depth < 3 && !text; depth++, parent = parent.parentElement) {
                        const caption = (parent.innerText || '').replace(/\s+/g, ' ').trim();
                        if (caption && caption.length <= 48) text = caption;
                    }
                }
                if (!text && overlayControls.has(el)) text = window.__spOverlay.name(el);
                if (!text) text = (el.id || '').trim();
                text = text.replace(/\s+/g, ' ').slice(0, 80);
                const href = el.getAttribute('href') || '';
                if (text.toLowerCase().includes('skip to content') || text.toLowerCase().includes('skip to main') || href === '#main-content') {
                    continue;
                }
                const isInViewport = (rect.bottom > 0 && rect.top < winH && rect.right > 0 && rect.left < winW);
                const cx = Math.round(rect.left + rect.width / 2);
                const cy = Math.round(rect.top + rect.height / 2);
                const pageX = cx + scrollX;
                const pageY = cy + scrollY;

                // Hit-testing / point occlusion verification (limited to top visible elements to prevent layout thrashing)
                let isOccluded = Boolean(activeOverlay && (!activeOverlay.contains(el) || !activeOverlay.contains(surface)));
                if (isInViewport && cx >= 0 && cy >= 0 && cx < winW && cy < winH && elements.length < 35) {
                    try {
                        let topNode = document.elementFromPoint(cx, cy);
                        for (let depth=0;depth<8 && topNode?.shadowRoot;depth++) {
                            const child=topNode.shadowRoot.elementFromPoint(cx,cy);
                            if(!child || child===topNode) break;
                            topNode=child;
                        }
                        if (topNode && topNode !== surface && !surface.contains(topNode) && !topNode.contains(surface)) {
                            isOccluded = true;
                        }
                    } catch(e) {}
                }

                const tagL = (el.tagName || '').toLowerCase();
                const hasPop = ['true','dialog','menu','listbox','tree','grid'].includes(el.getAttribute('aria-haspopup')) || el.hasAttribute('data-toggle') || (el.className && typeof el.className === 'string' && (el.className.includes('dropdown') || el.className.includes('has-sub')));
                const isHoverCand = hasPop || (el.closest('nav, header, [role="navigation"], [class*="menu"]') !== null && (tagL === 'a' || tagL === 'button' || el.getAttribute('role') === 'menuitem'));
                const isInsideModal = Boolean(activeOverlay && activeOverlay.contains(el));
                
                const parentForm = el.form || el.closest('form');
                const formId = parentForm ? (parentForm.id || parentForm.getAttribute('name') || ('form_' + Array.from(document.querySelectorAll('form')).indexOf(parentForm))) : '';
                let cardHeading = '';
                // Tailwind/React cards need not have a "card" class. Use the
                // nearest container with one heading, rather than assigning
                // every repeated action the whole section's heading.
                for (let parent = el.parentElement, depth = 0; parent && parent !== document.body && depth < 8; parent = parent.parentElement, depth++) {
                    const headings = [...parent.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')];
                    if (headings.length === 1 && !headings[0].contains(el)) {
                        cardHeading = (headings[0].textContent || '').trim().replace(/\s+/g, ' ').slice(0, 160);
                        break;
                    }
                }

                const elemId = window.__spGetOrAssignId(el);
                let isExternalLink = false;
                if (href && !href.startsWith('#') && !href.startsWith('javascript:') && !href.startsWith('mailto:') && !href.startsWith('tel:') && !href.startsWith('/')) {
                    try {
                        const targetU = new URL(href, window.location.href);
                        const curH = window.location.hostname.toLowerCase().replace(/^www\./, '');
                        const linkH = targetU.hostname.toLowerCase().replace(/^www\./, '');
                        if (linkH && curH && linkH !== curH && !linkH.endsWith('.' + curH)) {
                            const isLocal = (curH === 'localhost' || curH === '127.0.0.1' || curH.includes('docker')) && 
                                            (linkH === 'localhost' || linkH === '127.0.0.1' || linkH.includes('docker'));
                            if (!isLocal) {
                                isExternalLink = true;
                            }
                        }
                    } catch(e) {}
                }

                elements.push({
                    id: elemId,
                    tag: tagL,
                    role: el.getAttribute('role') || (overlayControls.has(el) && !['input','select','textarea','a','button','iframe'].includes(tagL) ? 'button' : tagL),
                    type: el.type || '',
                    editor_kind: el.closest('.ace_editor') ? 'ace' : el.closest('.CodeMirror') ? 'codemirror' : el.closest('.cm-editor') ? 'codemirror6' : el.closest('.monaco-editor') ? 'monaco' : el.isContentEditable ? 'contenteditable' : undefined,
                    classes: (typeof el.className === 'string') ? el.className : '',
                    href: href,
                    download: el.hasAttribute('download'),
                    is_external: isExternalLink,
                    text: text,
                    name: el.name || '',
                    input_id: el.id || '',
                    placeholder: el.placeholder || '',
                    value: el.type === 'password' ? '[redacted]' : (el.value || '').slice(0, 80),
                    required: Boolean(el.required || el.getAttribute('aria-required') === 'true'),
                    invalid: Boolean(el.willValidate && !el.validity.valid || el.getAttribute('aria-invalid') === 'true'),
                    expanded: el.getAttribute('aria-expanded'),
                    selected: el.getAttribute('aria-selected'),
                    pressed: el.getAttribute('aria-pressed'),
                    aria_controls: el.getAttribute('aria-controls') || el.getAttribute('aria-owns') || '',
                    min: el.min || '', max: el.max || '', readonly: Boolean(el.readOnly || el.getAttribute('aria-readonly') === 'true'),
                    options: tagL === 'select' ? [...el.options].slice(0,60).map(o=>({text:o.label || o.text,value:o.value,disabled:o.disabled || !!o.parentElement?.disabled,selected:o.selected})) : undefined,
                    multiple: tagL === 'select' ? Boolean(el.multiple) : undefined,
                    checked: Boolean(el.checked || el.getAttribute('aria-checked') === 'true'),
                    disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
                    is_in_viewport: isInViewport,
                    is_occluded: isOccluded,
                    is_inside_modal: isInsideModal,
                    overlay_id: isInsideModal ? window.__spGetOrAssignId(activeOverlay) : null,
                    is_hover_candidate: Boolean(isHoverCand),
                    has_popup: Boolean(hasPop),
                    form_id: formId,
                    card_context: cardHeading,
                    page_y: pageY,
                    page_x: pageX,
                    x: cx,
                    y: cy,
                    w: Math.round(rect.width),
                    h: Math.round(rect.height),
                    box: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)]
                });
                if (elements.length >= 600) break;
            }

            if (elements.some(e => e.is_inside_modal)) {
                elements.sort((a, b) => (b.is_inside_modal ? 1 : 0) - (a.is_inside_modal ? 1 : 0));
            }

            // Collect any text/buttons recorded by the Canvas 2D interception hook
            try {
                if (window.__sp_canvas_elements && window.__sp_canvas_elements.length > 0) {
                    const now = Date.now();
                    const recentCanvas = window.__sp_canvas_elements.filter(c => (now - c.timestamp) < 6000);
                    const seenCanvasTexts = new Set(elements.map(e => (e.text || '').toLowerCase()));
                    for (const ce of recentCanvas) {
                        const cText = (ce.text || '').trim();
                        if (cText.length > 1 && !seenCanvasTexts.has(cText.toLowerCase())) {
                            seenCanvasTexts.add(cText.toLowerCase());
                            elements.push({
                                id: counter++,
                                tag: 'canvas_text',
                                role: 'button',
                                type: '',
                                href: '',
                                text: cText,
                                name: '',
                                input_id: '',
                                placeholder: '',
                                disabled: false,
                                is_in_viewport: Boolean(ce.is_in_viewport),
                                is_hover_candidate: false,
                                has_popup: false,
                                page_y: ce.page_y,
                                page_x: ce.page_x,
                                x: ce.x,
                                y: ce.y,
                                w: ce.w,
                                h: ce.h
                            });
                            if (elements.length >= 140) break;
                        }
                    }
                }
            } catch(e) {}

            // Discover internal same-origin sub-pages across light DOM + shadow roots
            // Normalize origins: Docker container hostnames (frontend, host.docker.internal)
            // and localhost/127.0.0.1 are all treated as same-origin
            const _normalizeOrigin = (o) => {
                return o.replace(/\/\/(localhost|127\.0\.0\.1|host\.docker\.internal|frontend)(?=:|\/|$)/, '//localhost');
            };
            const currentOrigin = window.location.origin;
            const normalizedCurrentOrigin = _normalizeOrigin(currentOrigin);
            const currentPath = (window.location.pathname || '/').replace(/\/$/, '') || '/';
            const currentHash = window.location.hash || '';
            const subpages = [];
            const seenSubpages = new Set();
            const ignoreExts = ['.png', '.jpg', '.jpeg', '.svg', '.gif', '.webp', '.pdf', '.zip', '.tar', '.gz', '.mp4', '.mp3', '.css', '.js', '.ico', '.woff', '.woff2', '.ttf'];

            // Query all possible navigation elements from collectNodes(document)
            for (const node of nodes) {
                try {
                    let rawHref = '';
                    let navType = 'link';
                    if (node.tagName && node.tagName.toLowerCase() === 'a' && node.hasAttribute('href')) {
                        rawHref = (node.getAttribute('href') || '').trim();
                    } else if (node.hasAttribute && node.hasAttribute('data-href')) {
                        rawHref = (node.getAttribute('data-href') || '').trim();
                        navType = 'data-href';
                    } else if (node.hasAttribute && node.hasAttribute('data-to')) {
                        rawHref = (node.getAttribute('data-to') || '').trim();
                        navType = 'router';
                    } else if (node.hasAttribute && node.hasAttribute('to')) {
                        rawHref = (node.getAttribute('to') || '').trim();
                        navType = 'router';
                    } else if (node.hasAttribute && node.hasAttribute('routerlink')) {
                        rawHref = (node.getAttribute('routerlink') || '').trim();
                        navType = 'router';
                    } else if (node.hasAttribute && node.hasAttribute('data-route')) {
                        rawHref = (node.getAttribute('data-route') || '').trim();
                        navType = 'router';
                    } else if (node.hasAttribute && node.hasAttribute('data-path')) {
                        rawHref = (node.getAttribute('data-path') || '').trim();
                        navType = 'router';
                    } else if (node.hasAttribute && node.hasAttribute('onclick')) {
                        const oc = node.getAttribute('onclick') || '';
                        const m = oc.match(/['"](\/[a-zA-Z0-9_\-\/]+)['"]/);
                        if (m && !m[1].startsWith('/_') && !m[1].startsWith('/api')) {
                            rawHref = m[1];
                            navType = 'onclick';
                        }
                    }

                    if (!rawHref) continue;
                    if (rawHref.startsWith('javascript:') || rawHref.startsWith('mailto:') || rawHref.startsWith('tel:')) {
                        continue;
                    }

                    // Check for Single Page App (SPA) Hash Routing (e.g. #/about, #/docs, #!/contact)
                    let isSpaHash = false;
                    if (rawHref.startsWith('#')) {
                        if (rawHref.startsWith('#/') || rawHref.startsWith('#!/')) {
                            isSpaHash = true;
                            navType = 'hash_spa';
                        } else {
                            // Section anchors on single-page apps (e.g. #projects, #certifications)
                            if (rawHref.length > 2 && !rawHref.includes('main') && !rawHref.includes('top') && !rawHref.includes('content') && !rawHref.includes('skip')) {
                                isSpaHash = true;
                                navType = 'section_anchor';
                            } else {
                                continue;
                            }
                        }
                    }

                    const urlObj = new URL(rawHref, window.location.href);
                    if (_normalizeOrigin(urlObj.origin) === normalizedCurrentOrigin) {
                        const pathOnly = (urlObj.pathname || '/').replace(/\/$/, '') || '/';
                        const fullRouteKey = isSpaHash ? (pathOnly + urlObj.hash) : pathOnly;
                        const isCurrent = isSpaHash ? (fullRouteKey === (currentPath + currentHash)) : (pathOnly === currentPath);
                        
                        const hasExt = ignoreExts.some(ext => pathOnly.toLowerCase().endsWith(ext));
                        if (!isCurrent && !hasExt && !seenSubpages.has(fullRouteKey) && !pathOnly.includes('/api/')) {
                            seenSubpages.add(fullRouteKey);
                            let linkText = (node.innerText || node.getAttribute('aria-label') || node.getAttribute('title') || fullRouteKey).trim();
                            linkText = linkText.replace(/\s+/g, ' ').slice(0, 50);
                            subpages.push({
                                path: fullRouteKey,
                                url: urlObj.href,
                                text: linkText || fullRouteKey,
                                type: navType,
                                is_hash: isSpaHash
                            });
                        }
                    }
                } catch(e) {}
            }

            // Ingest dynamically intercepted SPA routes from history.pushState/replaceState
            try {
                if (window.__sp_discovered_routes && window.__sp_discovered_routes.length > 0) {
                    for (const r of window.__sp_discovered_routes) {
                        try {
                            const urlObj = new URL(r, window.location.href);
                            if (_normalizeOrigin(urlObj.origin) === normalizedCurrentOrigin) {
                                const pathOnly = (urlObj.pathname || '/').replace(/\/$/, '') || '/';
                                if (!seenSubpages.has(pathOnly) && pathOnly !== currentPath && !pathOnly.includes('/api/')) {
                                    seenSubpages.add(pathOnly);
                                    subpages.push({
                                        path: pathOnly,
                                        url: urlObj.href,
                                        text: pathOnly.replace('/', '').replace(/-/g, ' ').toUpperCase() || 'Page',
                                        type: 'spa_intercepted',
                                        is_hash: false
                                    });
                                }
                            }
                        } catch(e) {}
                    }
                }
            } catch(e) {}

            // Ingest Next.js build manifest routes if available
            try {
                if (window.__BUILD_MANIFEST) {
                    Object.keys(window.__BUILD_MANIFEST).forEach(r => {
                        if (r.startsWith('/') && !r.startsWith('/_') && !r.startsWith('/api')) {
                            const cleanR = r.replace(/\/$/, '') || '/';
                            if (cleanR !== currentPath && !seenSubpages.has(cleanR)) {
                                seenSubpages.add(cleanR);
                                subpages.push({
                                    path: cleanR,
                                    url: new URL(cleanR, window.location.href).href,
                                    text: cleanR.replace('/', '').replace(/-/g, ' ').toUpperCase() || 'Page',
                                    type: 'next_manifest',
                                    is_hash: false
                                });
                            }
                        }
                    });
                }
            } catch(e) {}

            return {
                url: window.location.href,
                title: document.title,
                scroll_y: scrollY,
                scroll_height: docH,
                viewport_height: winH,
                viewport_width: winW,
                elements: elements,
                next_element_id: cache.nextId,
                subpages: subpages
            };
        })()
        """
        try:
            res = await self.send_command("Runtime.evaluate", {
                "expression": js_code.replace('__SP_INITIAL_ID__', str(self._next_element_id)).replace('__SP_GENERATION__', str(generation)).replace('__SP_CACHE_OWNER__', json.dumps(self._element_cache_owner)).replace('__SP_OVERLAY_HELPERS__', OVERLAY_HELPERS).replace('__SP_CONTROL_NAME_HELPERS__', CONTROL_NAME_HELPERS).replace('__SP_CHECKABLE_HELPERS__', CHECKABLE_HELPERS),
                "returnByValue": True,
            }, timeout=6.0)
            val = res.get("result", {}).get("value", {})
        except Exception as e:
            logger.debug(f"extract_interactive_tree evaluation notice: {e}")
            val = {}
        if not val or generation != self._navigation_generation or (
                not self._selected_frame and state_seq != self._page_state_seq and val.get("title") != self.page_title):
            return {**self.page_metadata(), "fresh": False, "elements": self.interactive_elements,
                    "subpages": self.discovered_subpages}
        if not self._selected_frame:self.update_page_metadata(val.get("url"), val.get("title"))
        if type(val.get('next_element_id')) is int:
            self._next_element_id = max(self._next_element_id,val['next_element_id'])
        self.scroll_y = val.get("scroll_y", 0)
        self.scroll_height = val.get("scroll_height", 720)
        self.viewport_height = val.get("viewport_height", 720)
        raw_ret_url = val.get("url", "")
        if not self._selected_frame and raw_ret_url and "chrome-error://" not in raw_ret_url:
            self.current_url = to_frontend_display_url(raw_ret_url)
        self.interactive_elements = val.get("elements", [])
        if self._selected_frame:
            ox,oy=self.frame_offset
            sx,sy=self.frame_scale
            for element in self.interactive_elements:
                element['x']=element['x']*sx+ox; element['y']=element['y']*sy+oy
                box=element['box'];element['box']=[box[0]*sx+ox,box[1]*sy+oy,box[2]*sx,box[3]*sy]
        from .browser_testing.targets import remember_targets
        remember_targets(self)
        raw_subpages = val.get("subpages", [])
        self.discovered_subpages = [
            {
                "path": sp.get("path", ""),
                "url": to_frontend_display_url(sp.get("url", "")),
                "text": sp.get("text", ""),
                "type": sp.get("type", "link"),
                "is_hash": sp.get("is_hash", False),
            }
            for sp in raw_subpages
            if self.is_url_in_target_domain(sp.get("url", "") or sp.get("path", ""))
        ]

        # Phase 2: Update Site Knowledge Graph & Dynamic Page Archetype
        if hasattr(self, "skg") and self.skg:
            node = self.skg.update_page_state(
                url=self.current_url,
                title=self.page_title,
                elements=self.interactive_elements,
                is_modal=False
            )
            self.current_archetype = node.archetype
            for sp in self.discovered_subpages:
                sp_url = sp.get("url") or sp.get("path") or ""
                if sp_url:
                    self.skg.get_or_create_node(
                        url=sp_url,
                        title=sp.get("text", ""),
                        discovered_from=self.current_url,
                        depth=getattr(self.pda, "depth", 1)
                    )

        arch_val = self.current_archetype.value if hasattr(self.current_archetype, "value") else str(self.current_archetype)
        pda_depth_val = getattr(self.pda, "depth", 1) if hasattr(self, "pda") else 1
        skg_summary_val = self.skg.get_summary() if hasattr(self, "skg") else {}

        state_payload = {
            "type": "page_state",
            **self.page_metadata(),
            "scroll_y": self.scroll_y,
            "scroll_height": self.scroll_height,
            "elements": self.interactive_elements,
            "subpages": self.discovered_subpages,
            "archetype": arch_val,
            "pda_depth": pda_depth_val,
            "skg_summary": skg_summary_val,
        }
        self._notify_listeners(state_payload)
        return {
            "fresh": True,
            "url": self.current_url,
            "title": self.page_title,
            "scroll_y": self.scroll_y,
            "scroll_height": self.scroll_height,
            "elements": self.interactive_elements,
            "subpages": self.discovered_subpages,
            "archetype": arch_val,
            "pda_depth": pda_depth_val,
            "skg_summary": skg_summary_val,
        }

    def update_element_viewport_coordinates(self, scroll_x: int, scroll_y: int):
        """Updates live viewport coordinates of all interactive elements using absolute page coordinates after scroll."""
        self.scroll_x = scroll_x
        self.scroll_y = scroll_y
        win_h = getattr(self, "viewport_height", 720) or 720
        win_w = getattr(self, "viewport_width", 1280) or 1280
        for el in (self.interactive_elements or []):
            if "page_x" in el and "page_y" in el:
                # page_x/page_y are center coordinates in document space
                ox,oy=self.frame_offset if self._selected_frame else (0,0)
                sx,sy=self.frame_scale if self._selected_frame else (1,1)
                new_cx = (el["page_x"] - scroll_x)*sx + ox
                new_cy = (el["page_y"] - scroll_y)*sy + oy
                el_w = el.get("w", 0)*sx
                el_h = el.get("h", 0)*sy
                el["x"] = new_cx
                el["y"] = new_cy
                # Update bounding box (left, top, w, h)
                el["box"] = [new_cx - el_w // 2, new_cy - el_h // 2, el_w, el_h]
                # Element is in viewport if its bounding rect intersects the viewport
                el_top = new_cy - el_h // 2
                el_bottom = new_cy + el_h // 2
                el_left = new_cx - el_w // 2
                el_right = new_cx + el_w // 2
                el["is_in_viewport"] = (el_bottom > 0 and el_top < win_h and el_right > 0 and el_left < win_w)

    def _generate_bezier_path(self, start_x: int, start_y: int, end_x: int, end_y: int, fast_mode: bool = False) -> List[tuple[int, int]]:
        """Generates an organic Cubic Bézier cursor trajectory with randomized control points."""
        dx = end_x - start_x
        dy = end_y - start_y
        dist = (dx * dx + dy * dy) ** 0.5
        if dist < 8 or fast_mode:
            return [(end_x, end_y)]

        steps = max(6, min(14, int(dist / 45)))
        norm_x = -dy / (dist or 1)
        norm_y = dx / (dist or 1)
        
        dev1 = (random.random() - 0.5) * 0.18 * dist
        dev2 = (random.random() - 0.5) * 0.18 * dist
        
        p1_x = start_x + dx * 0.28 + norm_x * dev1
        p1_y = start_y + dy * 0.28 + norm_y * dev1
        p2_x = start_x + dx * 0.72 + norm_x * dev2
        p2_y = start_y + dy * 0.72 + norm_y * dev2

        path = []
        for i in range(1, steps + 1):
            t = i / steps
            u = 1.0 - t
            bx = (u**3)*start_x + 3*(u**2)*t*p1_x + 3*u*(t**2)*p2_x + (t**3)*end_x
            by = (u**3)*start_y + 3*(u**2)*t*p1_y + 3*u*(t**2)*p2_y + (t**3)*end_y
            path.append((int(round(bx)), int(round(by))))
        return path

    async def _move_pointer(self, x: int, y: int, label: str = "", fast_mode: bool = False, buttons: int = 0):
        """Bound native movement and announce one compositor animation, not every sample."""
        generation = self._input_generation
        origin = (self.cursor_x, self.cursor_y)
        # Fast mode controls settling, not whether the viewer sees the gesture.
        path = self._generate_bezier_path(*origin, x, y)
        duration = 0 if len(path) == 1 else min(.18, max(.09, len(path) * .012))
        self._notify_listeners({"type": "cursor_action", "action": "move", "phase": "moving",
                                "x": x, "y": y, "duration_ms": round(duration * 1000),
                                "path": [list(origin), *[list(point) for point in path]], "label": label})
        # The viewer interpolates the announced path. For ordinary fast clicks,
        # send only the final native move before pressing: queuing a dozen CDP
        # events over a remote tunnel delays the actual click without making
        # the visible cursor any smoother. Drag gestures keep native samples.
        native_path = [path[-1]] if fast_mode and not buttons else path
        started = time.monotonic()
        for index, (cx, cy) in enumerate(native_path):
            due = started + duration * ((index + 1) / len(native_path)) if not fast_mode else started
            remaining = due - time.monotonic()
            if remaining > 0:
                await asyncio.sleep(remaining)
            if generation != self._input_generation:
                raise asyncio.CancelledError('Pointer movement stopped')
            params = {"type": "mouseMoved", "x": cx, "y": cy, "buttons": buttons}
            # The event may reach Chromium even if its acknowledgement times out.
            # A drag release must use the latest dispatched position, not jump back.
            self.cursor_x, self.cursor_y = cx, cy
            if index == len(native_path) - 1:
                # A click/drag must never overtake an unacknowledged final move.
                await self.send_command("Input.dispatchMouseEvent", params)
            else:
                self.send_command_nowait("Input.dispatchMouseEvent", params)
        if generation != self._input_generation:
            raise asyncio.CancelledError('Pointer movement stopped')
        self.cursor_x, self.cursor_y = x, y

    async def _pointer_click_cycle(self, x: int, y: int, button: str = "left", count: int = 1, dwell: float = 0):
        """Release even if cancellation arrives while the press acknowledgement is unknown."""
        params = {"x": x, "y": y, "button": button, "clickCount": count}
        try:
            await self.send_command("Input.dispatchMouseEvent", {"type": "mousePressed", **params})
            if dwell:
                await asyncio.sleep(dwell)
        finally:
            await asyncio.shield(self.send_command("Input.dispatchMouseEvent", {"type": "mouseReleased", **params}))

    async def click(self, x: int, y: int, label: str = "", fast_mode: bool = False, exact_coords: bool = False):
        """Simulate fast organic cursor glide and realistic click with in-DOM visual ripple."""
        # 8px Euclidean Radius Snapping to eliminate vision downscaling discretization drift (bypassed if exact_coords or fast_mode)
        if not exact_coords and not fast_mode and self.interactive_elements:
            best_el = None
            best_dist = 8.0
            for el in self.interactive_elements:
                if el.get("disabled") or el.get("is_occluded") or not el.get("is_in_viewport", True):
                    continue
                el_x = el.get("x", -999)
                el_y = el.get("y", -999)
                dist = ((x - el_x)**2 + (y - el_y)**2)**0.5
                if dist < best_dist:
                    best_dist = dist
                    best_el = el
            if best_el:
                x, y = best_el["x"], best_el["y"]
                if not label:
                    label = f"Clicking {best_el.get('text') or best_el.get('tag') or ''}"

        await self._move_pointer(x, y, label or f"Moving to ({x}, {y})", fast_mode=fast_mode)

        # 4. Dispatch mousePressed, pause briefly for visual active state rendering, then mouseReleased
        await self._pointer_click_cycle(x, y)
        self._notify_listeners({"type": "cursor_action", "action": "click", "phase": "applied",
                                "x": x, "y": y, "duration_ms": 0, "label": label or f"Clicking ({x}, {y})"})

        # Settle click action (only if not in fast_mode/APV which manages its own quiescence)
        if not fast_mode:
            pre_url = (self.current_url or "").rstrip("/")
            matched_el = None
            if self.interactive_elements:
                for el in self.interactive_elements:
                    el_x = el.get("x", -999)
                    el_y = el.get("y", -999)
                    if ((x - el_x)**2 + (y - el_y)**2)**0.5 < 15.0:
                        matched_el = el
                        break
            is_trans = is_transitioning_or_submit_action(matched_el, label=label, action="click")
            await self.wait_for_action_quiescence(
                pre_url=pre_url,
                is_transition=is_trans,
                min_grace_ms=80 if is_trans else 40,
                max_timeout_s=1.2 if is_trans else 0.4
            )
        else:
            await asyncio.sleep(0.04)

    async def hover(self, x: int, y: int, duration: float = 0.35, label: str = "") -> Dict[str, Any]:
        """Simulate organic cursor glide to (x, y) and dwell to trigger CSS :hover and pointer events, capturing ephemeral UI."""
        # 8px Radius snap
        if self.interactive_elements:
            for el in self.interactive_elements:
                el_x = el.get("x", -999)
                el_y = el.get("y", -999)
                if ((x - el_x)**2 + (y - el_y)**2)**0.5 < 8.0:
                    x, y = el_x, el_y
                    if not label:
                        label = f"Hovering over {el.get('text') or el.get('tag') or ''}"
                    break

        await self._move_pointer(x, y, label or f"Hovering ({x}, {y})")
        self._notify_listeners({
            "type": "cursor_action",
            "action": "hover",
            "phase": "applied",
            "duration_ms": 0,
            "x": x,
            "y": y,
            "label": label or f"Hovering at ({x}, {y})",
        })

        # Dwell to let CSS transitions, animations, and JS popover handlers mount
        await asyncio.sleep(max(0.1, duration))

        # Capture any newly spawned ephemeral portals (tooltips, dropdown menus)
        portal_check_js = """
        (() => {
            const portals = [];
            const candidates = document.querySelectorAll(
                '[role="tooltip"], [role="menu"], [role="listbox"], [role="dialog"], ' +
                '[data-radix-popper-content-wrapper], [id*="portal"], [id*="popover"], ' +
                '[class*="dropdown-menu"], [class*="tooltip"], [class*="popover"], [class*="menu-panel"]'
            );
            const winW = window.innerWidth;
            const winH = window.innerHeight;
            for (const el of candidates) {
                const rect = el.getBoundingClientRect();
                if (rect.width > 5 && rect.height > 5 && rect.bottom > 0 && rect.top < winH && rect.right > 0 && rect.left < winW) {
                    const style = window.getComputedStyle(el);
                    if (style.visibility !== 'hidden' && style.display !== 'none' && parseFloat(style.opacity || '1') > 0.1) {
                        const links = Array.from(el.querySelectorAll('a[href], button, [role="menuitem"]')).map(n => ({
                            text: (n.innerText || n.getAttribute('aria-label') || '').trim().slice(0, 50),
                            tag: n.tagName.toLowerCase(),
                            href: n.getAttribute('href') || '',
                            x: Math.round(n.getBoundingClientRect().left + n.getBoundingClientRect().width / 2),
                            y: Math.round(n.getBoundingClientRect().top + n.getBoundingClientRect().height / 2),
                        }));
                        portals.push({
                            tag: el.tagName.toLowerCase(),
                            role: el.getAttribute('role') || 'portal',
                            text: (el.innerText || '').trim().slice(0, 100),
                            x: Math.round(rect.left + rect.width / 2),
                            y: Math.round(rect.top + rect.height / 2),
                            items: links
                        });
                    }
                }
            }
            return portals;
        })()
        """
        try:
            res = await self.send_command("Runtime.evaluate", {"expression": portal_check_js, "returnByValue": True})
            portals = res.get("result", {}).get("value", []) or []
        except Exception:
            portals = []

        return {
            "status": "passed",
            "action": "hover",
            "x": x,
            "y": y,
            "portals_found": len(portals),
            "portals": portals
        }

    async def double_click(self, x: int, y: int, label: str = ""):
        """Dispatches two rapid click cycles (clickCount=1 then clickCount=2)."""
        if self.interactive_elements:
            for el in self.interactive_elements:
                if ((x - el.get("x", -999))**2 + (y - el.get("y", -999))**2)**0.5 < 8.0:
                    x, y = el["x"], el["y"]
                    break

        await self._move_pointer(x, y, label or f"Double-clicking ({x}, {y})")

        await self._pointer_click_cycle(x, y, count=1, dwell=.02)
        await asyncio.sleep(0.06)
        await self._pointer_click_cycle(x, y, count=2, dwell=.02)
        self._notify_listeners({"type": "cursor_action", "action": "double_click", "phase": "applied",
                                "x": x, "y": y, "duration_ms": 0, "label": label or f"Double-clicking ({x}, {y})"})

    async def right_click(self, x: int, y: int, label: str = ""):
        """Dispatches right-click context menu event with visual indicator."""
        if self.interactive_elements:
            for el in self.interactive_elements:
                if ((x - el.get("x", -999))**2 + (y - el.get("y", -999))**2)**0.5 < 8.0:
                    x, y = el["x"], el["y"]
                    break

        await self._move_pointer(x, y, label or f"Right-clicking ({x}, {y})")

        await self._pointer_click_cycle(x, y, button="right", dwell=.03)
        self._notify_listeners({"type": "cursor_action", "action": "right_click", "phase": "applied",
                                "x": x, "y": y, "duration_ms": 0, "label": label or f"Right-clicking ({x}, {y})"})

    async def drag_and_drop(self, start_x: int, start_y: int, end_x: int, end_y: int, label: str = ""):
        """Simulates native drag and drop from start coordinate to end coordinate."""
        await self._move_pointer(start_x, start_y, label or "Moving to drag source")

        try:
            await self.send_command("Input.dispatchMouseEvent", {
                "type": "mousePressed", "x": start_x, "y": start_y, "button": "left", "clickCount": 1,
            })
            self._notify_listeners({"type": "cursor_action", "action": "drag_start", "phase": "applied",
                                    "x": start_x, "y": start_y, "duration_ms": 0,
                                    "label": label or f"Dragging to ({end_x}, {end_y})"})
            await asyncio.sleep(0.05)
            await self._move_pointer(end_x, end_y, label or "Dragging", buttons=1)
        finally:
            # Cancellation or a failed drag must not leave the native button held.
            await asyncio.shield(self.send_command("Input.dispatchMouseEvent", {
                "type": "mouseReleased",
                "x": self.cursor_x,
                "y": self.cursor_y,
                "button": "left",
                "clickCount": 1,
            }))
        self._notify_listeners({"type": "cursor_action", "action": "drag_end", "phase": "applied",
                                "x": end_x, "y": end_y, "duration_ms": 0, "label": label or "Dropped"})
        await asyncio.sleep(0.04)

    async def toggle_checkbox(self, element_id: int) -> bool:
        """Toggle through a current hit-tested native click; never force DOM state."""
        return await self.click_element(element_id, label='Toggle checked state', fast_mode=True)

    async def set_checked(self, element_id: int, desired: bool) -> bool:
        """Idempotent native selection with explicit postcondition, including ARIA controls."""
        probe = await self.evaluate(f"""(() => {{
            const el=window.__spFast?.nodes.get({int(element_id)});
            if (!el?.isConnected) return null;
            const native=['checkbox','radio'].includes(el.type);
            if (!native && !['checkbox','switch','radio'].includes(el.getAttribute('role'))) return null;
            return native ? el.checked : ({{true:true,false:false}}[el.getAttribute('aria-checked')] ?? null);
        }})()""")
        if type(probe) is not bool:
            return False
        if probe == desired:
            return True
        await self.scroll_to_element(element_id)
        return await ActionPerceptionVerification.dispatch_two_tier_click(self, element_id, label='Set checked state', fast_mode=True)

    async def select_option(self, element_id: int, value: str = "") -> bool:
        """Select one exact live native option and read its state back.

        Match the browser-visible option label as well as its value. Native
        selection is a widget transaction, so it must honor the same overlay,
        frame, disabled and visibility boundaries as pointer/text input.
        """
        self.last_action_verification = None
        from .browser_testing.actionability import prepare_pointer_target
        await self.scroll_to_element(element_id)
        actionable = await prepare_pointer_target(self, element_id)
        self.last_actionability = actionable
        if actionable.get('reason') != 'ready':
            raise RuntimeError('Native select is blocked or unavailable (' + str(actionable.get('reason')) + '). No choice was changed.')
        select_js = f"""
        (() => {{
            const target = window.__spFast?.nodes.get({int(element_id)});
            if (!target?.isConnected || target.tagName !== 'SELECT' || target.matches(':disabled') ||
                target.getAttribute('aria-disabled') === 'true' || target.closest('[inert]')) return {{error:'unavailable'}};
            if (target.multiple) return {{error:'multiple'}};
            const requested = {json.dumps(value)}, options = [...target.options];
            const normalize = text => String(text).replace(/\\s+/g,' ').trim().toLocaleLowerCase();
            const matches = options.filter(o => o.value === requested || normalize(o.label || o.text) === normalize(requested));
            if (matches.length !== 1 || matches[0].disabled || matches[0].parentElement?.disabled) return {{error:'option'}};
            const chosen = matches[0];
            if (target.value === chosen.value && chosen.selected) return {{selected:true,changed:false,value:chosen.value}};
            Object.getOwnPropertyDescriptor(target.ownerDocument.defaultView.HTMLSelectElement.prototype, 'value').set.call(target, chosen.value);
            target.dispatchEvent(new Event('input', {{ bubbles:true }}));
            target.dispatchEvent(new Event('change', {{ bubbles:true }}));
            return {{selected:target.isConnected && target.value === chosen.value && chosen.selected,changed:true,value:chosen.value}};
        }})()
        """
        result = await self.evaluate(select_js)
        if not isinstance(result, dict):
            raise RuntimeError('Native selection readback was unavailable. Observe its live value before retrying; dispatch outcome is unknown.')
        if result.get('error') == 'multiple':
            raise RuntimeError('This is a multiple-select control. A single-option replacement could clear existing choices; no choice was changed.')
        if not result.get('changed') and result.get('selected') is not True:
            raise RuntimeError("Select target or exact option is missing, disabled, or ambiguous. Observe current options; no choice was changed.")
        # Let controlled frameworks finish their event/microtask/render work.
        # Native selection's readback is stronger evidence than a generic DOM
        # delta, and an already-selected value is an idempotent checkpoint.
        if result.get('changed'):
            await self.wait_for_action_quiescence(pre_url=self.current_url, min_grace_ms=35,
                                                  max_timeout_s=.35, fast_mode=False)
        await self.extract_interactive_tree()
        from .browser_testing.targets import resolve_target_reference
        resolved = await resolve_target_reference(self, element_id)
        current_ref = resolved.get('element_id') if resolved.get('status') == 'ready' else None
        readback = await self.evaluate(f"""(() => {{
            const target=window.__spFast?.nodes.get({int(current_ref or 0)});
            if(!target?.isConnected || target.tagName!=='SELECT') return null;
            const matches=[...target.options].filter(option=>option.value==={json.dumps(result.get('value'))});
            return {{value:target.value,selected:matches.length===1 && matches[0].selected && target.value===matches[0].value}};
        }})()""")
        verified = isinstance(readback, dict) and readback.get('selected') is True
        self.last_action_verification = {
            'verified':verified,
            'control_kind':'native_select',
            'effect_type':('control_change' if result.get('changed') else 'value_already_set') if verified else 'selection_unverified',
            'changed':bool(result.get('changed')), 'already_satisfied':verified and not bool(result.get('changed')),
            'selected_value':readback.get('value') if isinstance(readback,dict) else None,
            'description':'Exact selected native value read back after control handlers settled.' if verified else
                          'Selection was dispatched but the live control did not retain the requested value.'}
        if not verified:
            if result.get('changed'):
                raise RuntimeError('Selection was dispatched but its current value could not be verified or was reverted by the application. Observe its live state before any retry.')
            raise RuntimeError('The previously selected value could not be confirmed in the current control. No input was dispatched; observe its live state.')
        return True

    async def scroll_to(self, y: int, extract_tree: bool = True):
        """Scrolls page to absolute Y position, waits for motion to settle completely, and captures fresh frame."""
        target_y = max(0, int(y))
        self._notify_listeners({
            "type": "cursor_action",
            "action": "scroll",
            "scroll_y": target_y,
            "label": f"Scrolling to {target_y}px",
        })
        js = f"try {{ window.scrollTo({{ top: {target_y}, behavior: 'smooth' }}); }} catch(e) {{ window.scrollTo(0, {target_y}); }}"
        try:
            await self.send_command("Runtime.evaluate", {"expression": js})
        except Exception:
            pass
        await self.wait_for_scroll_settled(min_quiet_ms=180, max_timeout_s=2.5)
        await self.force_fresh_frame()
        try:
            curr_scroll = await self.evaluate("[window.scrollX || 0, window.scrollY || 0]", timeout=0.5)
            if isinstance(curr_scroll, list) and len(curr_scroll) >= 2:
                self.update_element_viewport_coordinates(int(curr_scroll[0]), int(curr_scroll[1]))
        except Exception:
            pass
        if extract_tree:
            try:
                await self.extract_interactive_tree()
            except Exception:
                pass

    async def scroll_to_element(self, element_id: int) -> bool:
        """Scrolls a specific element into viewport center using DOM scrollIntoView or coordinates and waits for standstill."""
        from .browser_testing.checkables import CHECKABLE_HELPERS
        scrolled = await self.evaluate(f"""
        (() => {{
            {CHECKABLE_HELPERS}
            const el = window.__spFast?.nodes.get({element_id});
            if (el?.isConnected) {{
                const surface = spCheckableSurface(el)?.node || el;
                const r = surface.getBoundingClientRect();
                const cx = r.left+r.width/2, cy = r.top+r.height/2;
                const hit = document.elementFromPoint(cx,cy);
                const inView = r.top >= 20 && r.bottom <= innerHeight-20 && r.left >= 0 && r.right <= innerWidth &&
                    (hit === surface || surface.contains(hit));
                if (inView) return 'in_view';
                try {{
                    surface.scrollIntoView({{ behavior: 'instant', block: 'center', inline: 'nearest' }});
                }} catch(e) {{
                    surface.scrollIntoView();
                }}
                return 'scrolled';
            }}
            return false;
        }})()
        """, timeout=1.5)
        if scrolled == 'scrolled':
            # scrollIntoView also scrolls nested containers. Measure their live
            # bounds at dispatch instead of guessing from window.scrollY.
            try:
                curr_scroll = await self.evaluate("[window.scrollX || 0, window.scrollY || 0]", timeout=0.5)
                if isinstance(curr_scroll, list) and len(curr_scroll) >= 2:
                    self.update_element_viewport_coordinates(int(curr_scroll[0]), int(curr_scroll[1]))
            except Exception:
                pass
            return True
        elif scrolled == 'in_view':
            return True

        return False

    async def click_element(self, element_id: int, label: str = "", fast_mode: bool = True) -> bool:
        """Scrolls element into view if needed, performs APV two-tier click, awaits action completion, and verifies outcome."""
        phase_started = time.monotonic()
        self.last_action_timing = {}
        def mark(phase):
            nonlocal phase_started
            now = time.monotonic()
            self.last_action_timing[phase + '_ms'] = round((now - phase_started) * 1000, 1)
            phase_started = now
        el = next((e for e in (self.interactive_elements or []) if str(e.get("id")) == str(element_id)), None)
        target_name = label or (el.get("text") if el else f"Element #{element_id}")
        self.last_download = None
        prior_downloads = set(self.download_events)
        self._download_event.clear()
        is_transition = is_transitioning_or_submit_action(el, label=target_name, action="click")
        # Scroll element into viewport center before capturing snapshot & clicking
        try:
            await self.scroll_to_element(element_id)
        except Exception:
            pass
        mark('prepare')

        # 1. Capture Pre-action Perception Snapshot
        pre_snap = await ActionPerceptionVerification.capture_snapshot(self)
        mark('pre_observe')

        # 2. Dispatch Two-Tier Click (CDP synthetic input events + Native Blink DOM synthetic sequence)
        dispatched = await ActionPerceptionVerification.dispatch_two_tier_click(
            self, element_id, label=target_name, fast_mode=fast_mode)
        mark('dispatch')
        if not dispatched:
            # Some sites intentionally place a transparent/fixed layer over
            # their navigation while the pointer animation settles. A native
            # keyboard activation is the accessible equivalent of a click and
            # avoids guessing coordinates or forcing an occluded hit target.
            href = (el or {}).get("href") or ""
            tag = str((el or {}).get("tag") or "").lower()
            blocked=getattr(self,'last_actionability',{}) or {}
            if href and tag == "a" and not (el or {}).get("is_external") and blocked.get('navigation_hover_blocker') and not (blocked.get('blocker') or {}).get('dialog'):
                focused = await self.evaluate(f"(() => {{ const e=window.__spFast?.nodes.get({int(element_id)}); if(!e?.isConnected) return false; e.focus(); return document.activeElement===e; }})()")
                if focused is True and await self.press_key("Enter"):
                    await self.wait_for_action_quiescence(pre_url=pre_snap.url,is_transition=True,
                        min_grace_ms=60,max_timeout_s=1.2,fast_mode=True)
                    try:
                        await self.extract_interactive_tree()
                    except Exception:
                        pass
                    post_snap = await ActionPerceptionVerification.capture_snapshot(self)
                    verification = ActionPerceptionVerification.verify_action_outcome(pre_snap, post_snap, action="click", target=target_name)
                    self.last_action_verification = verification.to_dict()
                    return bool(verification.verified)
            self.last_action_verification = ActionVerificationResult(
                "click", target_name, False, "dispatch_failed",
                f"Target is not actionable: {getattr(self, 'last_actionability', {}).get('reason', 'unknown')}. Inspect recovery evidence before retrying.").to_dict()
            return False

        if self.native_dialog:
            self.last_action_verification = ActionVerificationResult(
                'click', target_name, True, 'native_dialog_opened',
                'A native dialog opened. Its decision and the business outcome remain to be verified.').to_dict()
            return True
        # 3. Action Completion Quiescence (awaits network idle, loading spinners cleared, route changes settled)
        if fast_mode and not is_transition:
            # For an ordinary field/picker click the post-action observation
            # itself checks the effect; waiting on unrelated page animations
            # before that observation made these clicks needlessly slow.
            await asyncio.sleep(.03)
        else:
            await self.wait_for_action_quiescence(
                pre_url=pre_snap.url,
                is_transition=is_transition,
                min_grace_ms=80 if is_transition else (15 if fast_mode else 40),
                max_timeout_s=1.5 if is_transition else (0.25 if fast_mode else 0.6),
                fast_mode=fast_mode,
            )
        mark('site_wait')

        # 4. Refresh interactive tree
        try:
            await self.extract_interactive_tree()
        except Exception:
            pass
        mark('post_observe')

        # 5. Capture Post-action Perception Snapshot and Verify Outcome
        post_snap = await ActionPerceptionVerification.capture_snapshot(self)
        verification = ActionPerceptionVerification.verify_action_outcome(pre_snap, post_snap, action="click", target=target_name)
        from .browser_testing.transactions import editable_control
        if (verification.effect_type in {'focus', 'no_effect'} and editable_control(el)
                and element_id is not None and str(post_snap.focused_id) == str(element_id)):
            verification = ActionVerificationResult('click', target_name, True, 'field_focus',
                'The observed editable field has focus. This is a preparation checkpoint, not a submitted form outcome.')
        from .browser_testing.site_audit import download_control
        if download_control(el or {'label': target_name}) and not (set(self.download_events) - prior_downloads):
            try:
                await asyncio.wait_for(self._download_event.wait(), timeout=0.75)
            except asyncio.TimeoutError:
                pass
        new_downloads = [event for guid, event in self.download_events.items() if guid not in prior_downloads]
        if new_downloads:
            download = new_downloads[-1]
            if download['state'] == 'inProgress':
                try:
                    self._download_event.clear()
                    await asyncio.wait_for(self._download_event.wait(), timeout=1.0)
                except asyncio.TimeoutError:
                    pass
            self.last_download = dict(download)
            completed = download['state'] == 'completed'
            verification = ActionVerificationResult(
                'click', target_name, completed,
                'download_completed' if completed else 'download_' + download['state'].lower(),
                (f"Browser saved {download['filename']} on the browser worker." if completed else
                 f"Browser download {download['state']}: {download['filename']}."),
            )
        if fast_mode and not is_transition and verification.effect_type == "no_effect":
            # An asynchronous picker may mount after the first fast snapshot.
            # Give only that case a bounded settling retry, never a second click.
            await self.wait_for_action_quiescence(
                pre_url=pre_snap.url, is_transition=False,
                min_grace_ms=15, max_timeout_s=.25, fast_mode=True,
            )
            await self.extract_interactive_tree()
            post_snap = await ActionPerceptionVerification.capture_snapshot(self)
            verification = ActionPerceptionVerification.verify_action_outcome(pre_snap, post_snap, action="click", target=target_name)
        self.last_action_verification = verification.to_dict()
        mark('verify')

        # Domain Boundary Guard: If the click navigated outside the target application's allowed domain,
        # immediately block exploration, log the event, navigate back to pre_snap.url, and abort further SKG/PNA updates.
        current_post_url = post_snap.url or self.current_url or ""
        is_breach = False
        target_breach_url = ""
        if current_post_url and not self.is_url_in_target_domain(current_post_url):
            is_breach = True
            target_breach_url = current_post_url
        elif verification.effect_type == "route_change" and verification.delta_url and not self.is_url_in_target_domain(verification.delta_url):
            is_breach = True
            target_breach_url = verification.delta_url

        if is_breach:
            snap_back_url = pre_snap.url if (pre_snap.url and pre_snap.url != "about:blank") else (self.target_url or "about:blank")
            logger.warning(f"🚫 [Domain Boundary Breach] Action navigated outside target domain to {target_breach_url}. Snapping back to {snap_back_url}.")
            if getattr(self, "_event_listener", None):
                try:
                    await self._event_listener({
                        "type": "external_link_blocked",
                        "url": target_breach_url,
                        "original_url": snap_back_url,
                        "target_name": target_name
                    })
                except Exception:
                    pass
            await self.navigate(snap_back_url)
            verification.effect_type = "external_navigation"
            verification.verified = False
            verification.description = f"Navigation outside target domain blocked: {target_breach_url}"
            self.last_action_verification = verification.to_dict()
            return True

        # 7. Update SKG transition & PNA stack if route changed or modal opened
        if verification.effect_type == "route_change" and verification.delta_url:
            if hasattr(self, "skg") and self.skg:
                self.skg.record_transition(
                    source_url=pre_snap.url,
                    target_url=verification.delta_url,
                    edge_type="click",
                    trigger_label=target_name,
                    trigger_element_id=element_id
                )
            if hasattr(self, "pda") and self.pda:
                arch_val = self.current_archetype.value if hasattr(self.current_archetype, "value") else str(self.current_archetype)
                self.pda.push(
                    url=verification.delta_url,
                    title=self.page_title,
                    archetype=arch_val,
                    parent_url=pre_snap.url,
                    trigger_label=target_name,
                    trigger_element_id=element_id,
                    scroll_y=pre_snap.scroll_y
                )
                self.pda.trap_detector.record(verification.delta_url, action_sig=f"click:{element_id}")
        elif verification.effect_type == "modal_open":
            if hasattr(self, "pda") and self.pda:
                self.pda.push(
                    url=self.current_url,
                    title=self.page_title,
                    archetype=PageArchetype.MODAL_VIEW.value,
                    parent_url=pre_snap.url,
                    trigger_label=target_name,
                    trigger_element_id=element_id,
                    is_modal=True
                )

        return True

    async def type_text(self, text: str, element_id: Optional[int] = None, clear_first: bool = True, auto_select_suggestion: Optional[str] = None):
        """Types text into an input or textarea with universal framework binding (Angular Reactive Forms, React 18, Vue, Svelte) and native CDP event propagation.

        Args:
            auto_select_suggestion: An explicitly requested option label. Commit only
                a unique visible match; otherwise leave the choice to the planner.
        """
        self.last_action_verification = None
        # Focus the requested control and use Chromium's native text insertion.
        # Do not set its value, append trigger characters, then rewrite it: that
        # sends several contradictory input events and breaks controlled forms.
        if element_id is not None:
            await self.scroll_to_element(element_id)
            if self._selected_frame:
                from .browser_testing.actionability import inspect_actionability
                actionable=await inspect_actionability(self,element_id)
                if actionable.get('is_occluded') or actionable.get('disabled'):
                    raise RuntimeError('Input frame is blocked in its parent page. No text input dispatched.')
        target_js = f"window.__spFast?.nodes.get({int(element_id)})" if element_id is not None else "document.activeElement"
        from .browser_testing.editors import focus_editor_script, read_editor_script
        focus_js = focus_editor_script(target_js)
        probe = await self.evaluate(focus_js)
        if probe is None:
            # A lost CDP observation is not evidence of a disabled input.
            # Only repeat the focus probe: no text/key input has been sent.
            probe = await self.evaluate(focus_js)
        if not isinstance(probe,dict):
            raise RuntimeError('Input focus could not be observed because the browser did not respond. No text input was dispatched.')
        if probe.get('error'):
            if probe.get('control_kind') == 'native_select':
                self.last_actionability = {'reason':'control_action_mismatch', 'expected_action':'select_option',
                                          'element_id':element_id, 'options':probe.get('options', [])}
            raise RuntimeError(probe['error']+' No text input was dispatched.')
        # Native segmented controls do not accept Input.insertText. Use a typed
        # control fill (as browser testing libraries do), never the ordinary
        # text-input fallback. Validate before mutation; send input/change once.
        if probe.get("type") in {"date", "time", "datetime-local", "month", "week", "color"}:
            requested = text.strip()
            if probe.get("type") == "date":
                from datetime import datetime
                parsed = None
                for fmt in ("%Y-%m-%d", "%d/%m/%Y"):
                    try:
                        parsed = datetime.strptime(requested, fmt)
                        break
                    except ValueError:
                        pass
                if parsed is None:
                    raise RuntimeError("Date input requires a valid YYYY-MM-DD or DD/MM/YYYY date.")
                requested = parsed.strftime("%Y-%m-%d")
            filled = await self.evaluate(f"""(() => {{
                const el = {target_js};
                if (!el || el.disabled || el.readOnly) return false;
                const requested = {json.dumps(requested)};
                const candidate = document.createElement('input');
                candidate.type = el.type;
                for(const attr of ['min','max','step'])if(el.hasAttribute(attr))candidate.setAttribute(attr,el.getAttribute(attr));
                candidate.value = requested;
                if (candidate.value !== requested || !candidate.validity.valid) return false;
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, requested);
                el.dispatchEvent(new Event('input', {{bubbles:true, composed:true}}));
                el.dispatchEvent(new Event('change', {{bubbles:true}}));
                return el.value === requested;
            }})()""")
            if not filled:
                raise RuntimeError("Typed control rejected the requested value.")
            self._notify_listeners({"type":"cursor_action","action":"type","phase":"applied","label":"Value entered"})
            return True
        from .browser_testing.editors import typing_guard_script, private_input_matches_script
        from .browser_testing.motion import typing_plan
        generation = self._input_generation
        if isinstance(probe.get('x'), (int,float)) and isinstance(probe.get('y'), (int,float)):
            px,py=probe['x'],probe['y']
            if self._selected_frame:
                from .browser_testing.frames import frame_transform
                ox,oy,sx,sy=await frame_transform(self,self._selected_frame)
                px=px*sx+ox;py=py*sy+oy
            await self._move_pointer(round(px),round(py),'Typing')
        initial = str(probe.get('value') or '').replace('\r\n','\n').replace('\r','\n')
        if generation != self._input_generation:
            raise asyncio.CancelledError('Typing stopped')
        if await self.evaluate(typing_guard_script(target_js,initial)) is not True:
            raise RuntimeError('Input changed or lost focus before typing. No text input was dispatched.')
        if clear_first:
            for event_type in ("rawKeyDown", "keyUp"):
                if generation != self._input_generation:
                    raise asyncio.CancelledError('Typing stopped')
                await self.send_command("Input.dispatchKeyEvent", {"type": event_type, "windowsVirtualKeyCode": 65,
                                        "modifiers": 2, "key": "a", "code": "KeyA"})
            for event_type in ("rawKeyDown", "keyUp"):
                if generation != self._input_generation:
                    raise asyncio.CancelledError('Typing stopped')
                await self.send_command("Input.dispatchKeyEvent", {"type": event_type, "windowsVirtualKeyCode": 8,
                                        "key": "Backspace", "code": "Backspace"})
        # Number inputs reject incomplete signs/exponents, so preserve atomic fill.
        chunks,interval=typing_plan(text,atomic=probe.get('type')=='number')
        prefix = '' if clear_first else initial
        expected = (prefix + text).replace('\r\n','\n').replace('\r','\n')
        private = probe.get('type')=='password'
        event = {"type":"cursor_action","action":"type","label":"Typing","private":private}
        self._notify_listeners({**event,"phase":"started"})
        try:
            last_progress=time.monotonic()
            for index,chunk in enumerate(chunks):
                if index:
                    # Always give the browser a paint opportunity, even after a slow ACK.
                    await asyncio.sleep(interval)
                if generation != self._input_generation:
                    raise asyncio.CancelledError('Typing stopped')
                if await self.evaluate(typing_guard_script(target_js,prefix)) is not True:
                    raise RuntimeError('Typing stopped because the input changed or lost focus. Read the current editor before retrying; no remaining text was dispatched.')
                await self.send_command("Input.insertText", {"text": chunk})
                prefix=(prefix+chunk).replace('\r\n','\n').replace('\r','\n')
                now=time.monotonic()
                if now-last_progress>=.10:
                    self._notify_listeners({**event,"phase":"progress"})
                    last_progress=now
            deadline = time.monotonic() + 1
            while True:
                if generation != self._input_generation:
                    raise asyncio.CancelledError('Typing stopped')
                actual = await self.evaluate(private_input_matches_script(target_js,expected) if private else read_editor_script(target_js))
                matched = actual is True if private else isinstance(actual, dict) and actual.get('value') == expected
                if matched:
                    break
                if time.monotonic() >= deadline:
                    raise RuntimeError("Editor document did not match the requested text after native insertion. Input may have changed; read the editor before retrying. Preserve the requested program and inspect the source editor, not the output pane.")
                await asyncio.sleep(.05)
        except BaseException:
            self._notify_listeners({**event,"phase":"interrupted","label":"Typing interrupted"})
            raise
        self._notify_listeners({**event,"phase":"applied","label":"Text entered"})

        if private:
            # APV deliberately masks password values, so its generic DOM delta
            # cannot establish a successful private fill. Preserve the native
            # executor's equality check as a preparation checkpoint only. No
            # value, length, prefix or hash enters the model-visible result.
            self.last_autocomplete_suggestions = []
            await self.extract_interactive_tree()
            if await self.evaluate(private_input_matches_script(target_js,expected)) is not True:
                raise RuntimeError('Private input changed after native typing. Observe its current control before retrying; no secret value is exposed.')
            self.last_action_verification = {'verified':True,'effect_type':'control_change',
                                            'control_kind':'password','private':True,'value_matches':True,
                                            'description':'Private input matched the requested text after native typing. Authentication remains unverified until its actual outcome is asserted.'}
            return True

        # 4. Autocomplete harvest with progressive retry loop
        # Angular/PrimeNG autocompletes have debounce timers (typically 200-500ms) before
        # firing HTTP requests for suggestions. We retry harvesting with increasing delays.
        harvest_js = """
        (() => {
            const control = __CONTROL__;
            const ids = control ? ((control.getAttribute('aria-controls') || '') + ' ' + (control.getAttribute('aria-owns') || '')).trim().split(/\\s+/).filter(Boolean) : [];
            const roots = ids.map(id => document.getElementById(id) || (control.getRootNode().getElementById ? control.getRootNode().getElementById(id) : null)).filter(Boolean);
            // An explicitly associated popup takes priority over unrelated lists.
            const searchRoots = roots.length ? roots : [control ? control.getRootNode() : document];
            const selectors = [
                ...(roots.length ? ['[role="option"]'] : []),
                'ul.ui-autocomplete-items li',
                'ul.p-autocomplete-items li',
                '.ui-autocomplete-panel li',
                '.p-autocomplete-panel li',
                'p-autocomplete li',
                'li.ui-autocomplete-list-item',
                'li.p-autocomplete-item',
                '[role="listbox"] [role="option"]',
                'li[role="option"]',
                '[role="combobox"] ~ ul li',
                '.autocomplete-suggestions > *',
                '.pac-container .pac-item',
                '.dropdown-menu.show > *',
                '[class*="autocomplete"] li',
                '[class*="suggestion"] li',
                '[class*="option-list"] > *',
                'div[id*="autocomplete"] li',
                'mat-option',
                '.ant-select-item-option',
                '.select2-results__option'
            ];
            for (const sel of selectors) {
                const items = [...new Set(searchRoots.flatMap(root => Array.from(root.querySelectorAll(sel))))].filter(el => {
                    const s = window.getComputedStyle(el);
                    return el.getAttribute('aria-disabled') !== 'true' && s.display !== 'none' && s.visibility !== 'hidden' && (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0);
                });
                if (items.length > 0) {
                    return items.slice(0, 15).map((el, idx) => {
                        // Framework clones can copy data-sp-id; only node identity is authoritative.
                        const spId = window.__spGetOrAssignId ? String(window.__spGetOrAssignId(el)) : null;
                        const rect = el.getBoundingClientRect();
                        return {
                            id: spId ? Number(spId) : null,
                            text: (el.textContent || '').trim().replace(/\\s+/g, ' '),
                            index: idx,
                            x: Math.round(rect.left + rect.width / 2),
                            y: Math.round(rect.top + rect.height / 2)
                        };
                    });
                }
            }
            return [];
        })()
        """.replace('__CONTROL__', target_js)

        self.last_autocomplete_suggestions = []
        # Some sites do not expose ARIA autocomplete metadata even though they
        # render a real suggestion popup. Probe ordinary fields immediately;
        # known comboboxes get a bounded debounce window.
        # Start after common suggestion debounce timers. Harvesting the first
        # transient option too early can race a later replacement, causing a
        # click to land on an unmounted node while appearing dispatched.
        harvest_delays = [0.25, 0.15, 0.25, 0.4, 0.6, 0.6] if probe.get("autocomplete") or auto_select_suggestion else [0]

        for delay in harvest_delays:
            await asyncio.sleep(delay)
            try:
                sugg_res = await self.send_command("Runtime.evaluate", {"expression": harvest_js, "returnByValue": True}, timeout=1.0)
                val = sugg_res.get("result", {}).get("value")
                if isinstance(val, list) and val:
                    self.last_autocomplete_suggestions = val
                    logger.info(f"Autocomplete harvest: {len(val)} suggestions found after {delay}s delay")
                    break
            except Exception:
                pass

        # Autocomplete controls commonly require committing a suggestion before
        # their parent form enables its submit button. Typing alone does not
        # authorize choosing the first or a fuzzy matching option.
        suggestion_query = auto_select_suggestion
        if suggestion_query and not self.last_autocomplete_suggestions:
            raise RuntimeError("Requested autocomplete option was not observed. Observe the current control and its options before retrying.")
        if suggestion_query and self.last_autocomplete_suggestions:
            query_lower = suggestion_query.strip().lower()
            exact = [s for s in self.last_autocomplete_suggestions if (s.get('text') or '').strip().lower() == query_lower]
            matches = exact or [s for s in self.last_autocomplete_suggestions if query_lower in (s.get('text') or '').lower()]
            best_match = matches[0] if len(matches) == 1 else None
            if not best_match:
                raise RuntimeError("Autocomplete choice is ambiguous or missing. Observe the options and choose an explicit current element ID.")

            # An unrelated first suggestion must not silently satisfy the user goal.

            if best_match:
                match_text = best_match.get("text", "")
                logger.info(f"Auto-selecting suggestion: '{match_text}' for query '{suggestion_query}'")

                # Dispatch exactly once; never replay a successful hardware click.
                sugg_id = best_match.get("id")
                if sugg_id is not None:
                    dispatched = await ActionPerceptionVerification.dispatch_two_tier_click(
                        self, sugg_id, label=match_text, fast_mode=True)
                    # A debounced autocomplete can replace the observed option
                    # between harvesting and hit testing. No input was sent for
                    # a stale node, so reacquire the same unique choice once.
                    for _ in range(2):
                        if dispatched or (getattr(self, 'last_actionability', {}) or {}).get('reason') != 'stale_element':
                            break
                        await asyncio.sleep(.06)
                        current = await self.evaluate(harvest_js, timeout=1.0)
                        matches = [item for item in (current or [])
                                   if (item.get('text') or '').strip().casefold() == match_text.strip().casefold()]
                        if len(matches) != 1 or matches[0].get('id') is None:
                            break
                        self.last_autocomplete_suggestions = current
                        dispatched = await ActionPerceptionVerification.dispatch_two_tier_click(
                            self, matches[0]['id'], label=match_text, fast_mode=True)
                    if not dispatched:
                        raise RuntimeError("Autocomplete suggestion is no longer actionable.")
                elif best_match.get("x") is not None and best_match.get("y") is not None:
                    await self.click(best_match["x"], best_match["y"], label=match_text, fast_mode=True, exact_coords=True)
                else:
                    raise RuntimeError("Autocomplete suggestion has no current target.")

                # Only dispatch Escape to close dropdown if still open (avoid Enter which submits forms prematurely)
                try:
                    dropdown_still_open = await self.evaluate("""
                    (() => {
                        const sels = ['ul.ui-autocomplete-items', '.p-autocomplete-panel', '[role="listbox"]:not([style*="display: none"])',
                                       '.autocomplete-dropdown', '.dropdown-menu.show', '.mat-autocomplete-panel', '.ng-dropdown-panel'];
                        return sels.some(s => { const el = document.querySelector(s); return el && el.offsetHeight > 0; });
                    })()
                    """, timeout=0.3)
                    if dropdown_still_open:
                        await self.send_command("Input.dispatchKeyEvent", {"type": "rawKeyDown", "windowsVirtualKeyCode": 27, "key": "Escape", "code": "Escape"})
                        await self.send_command("Input.dispatchKeyEvent", {"type": "keyUp", "windowsVirtualKeyCode": 27, "key": "Escape", "code": "Escape"})
                except Exception:
                    pass

                self._notify_listeners({
                    "type": "cursor_action",
                    "action": "click",
                    "text": match_text,
                    "label": f"Selected '{match_text[:40]}'",
                })

        return True

    async def press_key(self, key: str, modifiers: Optional[List[str]] = None) -> bool:
        """Dispatches key event supporting special keys and shortcut combinations (Ctrl, Alt, Shift, Escape, Enter, Tab, Arrows)."""
        mod_mask = 0
        if modifiers:
            for m in modifiers:
                m_low = str(m).lower()
                if "alt" in m_low:
                    mod_mask |= 1
                elif "ctrl" in m_low or "control" in m_low:
                    mod_mask |= 2
                elif "meta" in m_low or "command" in m_low or "win" in m_low:
                    mod_mask |= 4
                elif "shift" in m_low:
                    mod_mask |= 8

        key_map = {
            "enter": ("Enter", "Enter", 13),
            "return": ("Enter", "Enter", 13),
            "escape": ("Escape", "Escape", 27),
            "esc": ("Escape", "Escape", 27),
            "tab": ("Tab", "Tab", 9),
            "backspace": ("Backspace", "Backspace", 8),
            "space": (" ", "Space", 32),
            "arrowdown": ("ArrowDown", "ArrowDown", 40),
            "arrowup": ("ArrowUp", "ArrowUp", 38),
            "arrowleft": ("ArrowLeft", "ArrowLeft", 37),
            "arrowright": ("ArrowRight", "ArrowRight", 39),
        }

        k_clean = key.lower().strip()
        if k_clean in key_map:
            k_val, code_val, vk_val = key_map[k_clean]
        else:
            k_val = key
            code_val = f"Key{key.upper()}" if len(key) == 1 and key.isalpha() else key
            vk_val = ord(key.upper()) if len(key) == 1 else 0

        self._notify_listeners({
            "type": "cursor_action",
            "action": "key_press",
            "key": key,
            "modifiers": modifiers or [],
            "label": f"Pressing '{'+'.join((modifiers or []) + [key])}'",
        })

        await self.send_command("Input.dispatchKeyEvent", {
            "type": "rawKeyDown",
            "windowsVirtualKeyCode": vk_val,
            "modifiers": mod_mask,
            "key": k_val,
            "code": code_val,
        })
        if len(k_val) == 1 and not mod_mask:
            await self.send_command("Input.dispatchKeyEvent", {
                "type": "char",
                "text": k_val,
            })
        await asyncio.sleep(0.03)
        await self.send_command("Input.dispatchKeyEvent", {
            "type": "keyUp",
            "windowsVirtualKeyCode": vk_val,
            "modifiers": mod_mask,
            "key": k_val,
            "code": code_val,
        })
        await asyncio.sleep(0.04)
        if k_clean in {"enter", "return"}:
            pre_url = (self.current_url or "").rstrip("/")
            await self.wait_for_action_quiescence(
                pre_url=pre_url,
                is_transition=True,
                min_grace_ms=350,
                max_timeout_s=10.0
            )
        return True

    async def get_theme(self) -> Dict[str, Any]:
        """Detects whether current page theme is dark or light mode."""
        js = """
        (() => {
            const html = document.documentElement;
            const body = document.body;
            const bg = window.getComputedStyle(body).backgroundColor;
            const isDark = html.classList.contains('dark') || 
                           html.getAttribute('data-theme') === 'dark' ||
                           bg.includes('rgb(0') || bg.includes('rgb(1') || bg.includes('rgb(2');
            return {
                theme: isDark ? 'dark' : 'light',
                classes: Array.from(html.classList),
                bg: bg
            };
        })()
        """
        try:
            res = await self.send_command("Runtime.evaluate", {"expression": js, "returnByValue": True})
            return res.get("result", {}).get("value", {})
        except Exception:
            return {"theme": "unknown"}

    get_theme_state = get_theme

    async def navigate_back(self, fallback_url: str = "") -> Dict[str, Any]:
        """Move one actual browser history entry; parent recovery is explicit."""
        from .browser_testing.navigation import move_history
        return await move_history(self, -1)

    async def navigate_forward(self) -> Dict[str, Any]:
        from .browser_testing.navigation import move_history
        return await move_history(self, 1)

    async def return_to_parent(self) -> Dict[str, Any]:
        result = await self.pda.backtrack_to_parent(self)
        self.last_action_verification = {
            'verified': result.get('success') is True, 'effect_type': 'parent_restored' if result.get('success') else 'no_effect',
            'description': 'Returned to the observed parent context.' if result.get('success') else result.get('reason', 'Parent recovery failed.'),
            'method': result.get('method'), 'expected_url': result.get('target_url'), 'actual_url': self.current_url}
        return {'status': 'passed' if result.get('success') else 'unverified', 'action': 'return_to_parent',
                'verification': self.last_action_verification, 'backtrack_result': result}

    async def scroll(self, delta_y: int = 300, extract_tree: bool = True, fast_mode: bool = True):
        """Scrolls the page up or down and awaits scroll rest."""
        self._notify_listeners({
            "type": "cursor_action",
            "action": "scroll",
            "delta_y": delta_y,
            "label": f"Scrolling {'down' if delta_y > 0 else 'up'}",
        })
        self.send_command_nowait("Input.dispatchMouseEvent", {
            "type": "mouseWheel",
            "x": 640,
            "y": 360,
            "deltaX": 0,
            "deltaY": delta_y,
        })
        if fast_mode:
            await self.wait_for_scroll_settled(min_quiet_ms=50, max_timeout_s=0.6)
            await self.wait_for_quiescence(network_idle_ms=40, dom_quiet_ms=20, scroll_quiet_ms=40, max_timeout_s=0.6, fast_mode=True)
        else:
            await self.wait_for_scroll_settled(min_quiet_ms=180, max_timeout_s=2.5)
            await self.wait_for_quiescence(network_idle_ms=60, dom_quiet_ms=30, scroll_quiet_ms=80, max_timeout_s=2.0, fast_mode=False)
        await self.force_fresh_frame()
        if extract_tree:
            try:
                await self.extract_interactive_tree()
            except Exception:
                pass
    async def harvest_in_page_credentials(self) -> Dict[str, Any]:
        """Scans the visible DOM for published demo credentials, test logins, or quick-fill buttons."""
        harvester_js = r"""
        (() => {
            const credentialPatterns = {
                email: /(?:demo|test|sample|admin|user(?:name)?|login|account)?[\s:=]*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i,
                username: /(?:demo|test|sample|admin|user(?:name)?|login|account)[\s:=]+['"`]?([a-zA-Z0-9_.-]{3,30})['"`]?/i,
                password: /(?:password|pass|pwd|secret)[\s:=]+['"`]?([^\s'",;]{4,40})['"`]?/i,
                pair: /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}|[a-zA-Z0-9_.-]{3,30})[\s/|:=-]+([^\s/|'",;]{4,40})/i
            };

            const candidateSelectors = [
                '[role="alert"]', '.alert', '.demo-credentials', '.test-account',
                '.login-helper', 'pre', 'code', 'blockquote', '.card-body', '.modal-body',
                'form p', 'form span', 'form div', 'form small', '.helper-text', '.text-muted'
            ];

            let rawTexts = [];
            for (const sel of candidateSelectors) {
                document.querySelectorAll(sel).forEach(el => {
                    const txt = (el.innerText || "").trim();
                    if (txt.length > 5 && txt.length < 600) rawTexts.push(txt);
                });
            }

            if (rawTexts.length === 0 && document.body) {
                rawTexts.push(document.body.textContent.slice(0, 4000));
            }

            let harvested = { email: null, username: null, password: null, quick_button_id: null, quick_button_label: null };

            // Look for 1-click demo filler buttons: e.g. "Use Demo Account", "Fill Admin", "Auto Fill"
            const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'));
            for (const btn of buttons) {
                const bText = (btn.textContent || btn.getAttribute('aria-label') || '').toLowerCase().trim();
                if (bText && (bText.includes('demo') || bText.includes('test account') || bText.includes('fill cred') || bText.includes('guest login') || bText.includes('quick login'))) {
                    harvested.quick_button_id = btn.id || btn.className || bText;
                    harvested.quick_button_label = bText;
                    break;
                }
            }

            for (const txt of rawTexts) {
                if (!harvested.email) {
                    const emailMatch = txt.match(credentialPatterns.email);
                    if (emailMatch && !emailMatch[1].endsWith('.png') && !emailMatch[1].endsWith('.jpg')) {
                        harvested.email = emailMatch[1];
                    }
                }
                if (!harvested.password) {
                    const pwdMatch = txt.match(credentialPatterns.password);
                    if (pwdMatch) {
                        harvested.password = pwdMatch[1];
                    }
                }
                // If text is in format: user@demo.com / password123
                if (!harvested.password && harvested.email) {
                    const pairRegex = new RegExp(harvested.email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s/|:=-]+([^\\s/|\'",;]{4,40})', 'i');
                    const pairMatch = txt.match(pairRegex);
                    if (pairMatch) {
                        harvested.password = pairMatch[1];
                    }
                }
                if (!harvested.username && !harvested.email) {
                    const userMatch = txt.match(credentialPatterns.username);
                    if (userMatch) harvested.username = userMatch[1];
                }
            }

            return harvested;
        })()
        """
        try:
            res = await self.send_command("Runtime.evaluate", {"expression": harvester_js, "returnByValue": True})
            return res.get("result", {}).get("value", {}) or {}
        except Exception:
            return {}

    async def extract_site_profile(self) -> Dict[str, Any]:
        """Extracts document metadata, headings, and nav tags to establish domain context and provide authentic search queries."""
        profile_js = r"""
        (() => {
            const ogTitle = document.querySelector('meta[property="og:title"]')?.content || "";
            const ogDesc = document.querySelector('meta[property="og:description"]')?.content || "";
            const metaDesc = document.querySelector('meta[name="description"]')?.content || "";
            const title = document.title || "";
            const h1s = Array.from(document.querySelectorAll('h1, h2')).map(h => (h.textContent || '').trim()).filter(Boolean).slice(0, 6);
            const navLinks = Array.from(document.querySelectorAll('nav a, header a')).map(a => (a.textContent || '').trim()).filter(Boolean).slice(0, 10);
            const bodySample = (document.body ? document.body.textContent.slice(0, 2000) : "").toLowerCase();
            return { title, ogTitle, ogDesc, metaDesc, headings: h1s, navLinks, bodySample };
        })()
        """
        try:
            res = await self.send_command("Runtime.evaluate", {"expression": profile_js, "returnByValue": True})
            info = res.get("result", {}).get("value", {}) or {}
        except Exception:
            info = {}

        combined_text = f"{info.get('title', '')} {info.get('ogTitle', '')} {info.get('metaDesc', '')} {info.get('ogDesc', '')} {' '.join(info.get('headings', []))} {' '.join(info.get('navLinks', []))} {info.get('bodySample', '')}".lower()

        # Domain Taxonomy Matching
        if any(w in combined_text for w in ["movie", "cinema", "film", "watch", "streaming", "actor", "trailer", "imdb", "tmdb", "netflix"]):
            return {
                "category": "movies",
                "label": "Movie / Cinema Catalog",
                "suggested_queries": ["Inception", "Interstellar", "The Dark Knight", "Oppenheimer", "Avatar"],
            }
        elif any(w in combined_text for w in ["shop", "store", "ecommerce", "cart", "checkout", "product", "shoe", "clothing", "price"]):
            return {
                "category": "ecommerce",
                "label": "E-Commerce / Shopping",
                "suggested_queries": ["wireless headphones", "running shoes", "mechanical keyboard", "leather jacket"],
            }
        elif any(w in combined_text for w in ["music", "song", "artist", "album", "playlist", "track", "spotify"]):
            return {
                "category": "music",
                "label": "Music & Audio",
                "suggested_queries": ["Bohemian Rhapsody", "Hotel California", "Imagine", "Billie Jean"],
            }
        elif any(w in combined_text for w in ["recipe", "food", "restaurant", "pizza", "burger", "dish", "cook", "chef", "menu"]):
            return {
                "category": "food",
                "label": "Food & Culinary",
                "suggested_queries": ["Margherita Pizza", "Pasta Carbonara", "Chocolate Cake", "Burger"],
            }
        elif any(w in combined_text for w in ["real estate", "property", "rent", "apartment", "house", "villa", "realtor"]):
            return {
                "category": "realestate",
                "label": "Real Estate / Housing",
                "suggested_queries": ["2 Bedroom Apartment", "Downtown Loft", "Modern Villa", "Studio"],
            }
        elif any(w in combined_text for w in ["documentation", "docs", "api", "sdk", "endpoint", "reference", "webhook", "github"]):
            return {
                "category": "tech_docs",
                "label": "Technical Documentation / Developer Portal",
                "suggested_queries": ["authentication", "webhooks", "rate limits", "endpoints"],
            }
        elif any(w in combined_text for w in ["portfolio", "resume", "cv", "developer", "engineer", "projects", "skills"]):
            return {
                "category": "portfolio",
                "label": "Developer Portfolio",
                "suggested_queries": ["projects", "experience", "skills", "contact"],
            }
        else:
            headings = info.get("headings", [])
            fallback_query = headings[0].split()[0] if headings and headings[0] else "features"
            return {
                "category": "general",
                "label": "Web Application",
                "suggested_queries": [fallback_query, "overview", "details"],
            }

    async def start_jpeg_stream(self, *, force_restart=False):
        if force_restart:
            # Repeated recovery messages must not continuously restart Chrome's
            # capture session. Preserve the current tab and browser actions.
            now = time.monotonic()
            if now - self._jpeg_restart_at < 5.0:
                return
            self._jpeg_restart_at = now
            if self._jpeg_streaming:
                try:
                    await self.send_command('Page.stopScreencast')
                finally:
                    # If the command failed, do not leave a stale local flag
                    # preventing the next bounded recovery from starting capture.
                    self._jpeg_streaming = False
        if self._jpeg_streaming:
            return
        try:
            await self.send_command("Page.startScreencast", {
                "format": "jpeg", "quality": 60, "maxWidth": 1280,
                "maxHeight": 720, "everyNthFrame": 1,
            })
        except Exception as exc:
            message = str(exc).lower()
            if not ('screencast' in message and 'already' in message):
                raise
        self._jpeg_streaming = True
        self._jpeg_started_at = time.monotonic()

    async def restart_jpeg_stream(self):
        async with self._capture_lock:
            await self.start_jpeg_stream(force_restart=True)

    async def sync_capture_mode(self):
        """Capture images only for viewers who need them or video recovery."""
        async with self._capture_lock:
            if not self.needs_h264_capture():
                self.h264_active = False
                self._video_needs_keyframe = True
                writer = self._stream_writer
                if writer and not writer.is_closing():
                    writer.close()
            needs_jpeg = bool(self.listeners) and (
                not self.h264_active or browser_manager.display_session_id != self.session_id
                or any(self.viewer_codecs.get(viewer) == 'jpeg' for viewer in self.listeners))
            if needs_jpeg:
                now = time.monotonic()
                if self._jpeg_demand_since is None:
                    self._jpeg_demand_since = now
                expected_frame_at = max(self._jpeg_demand_since, self._last_activity)
                last_frame_at = self._last_jpeg_frame_at
                # Static tabs legitimately stop producing CDP frames. Restart
                # only when fresh viewer/input demand has received no new frame,
                # after a startup grace period and with a bounded cooldown.
                stalled = (self._jpeg_streaming and now - expected_frame_at <= 4.0
                           and (last_frame_at is None or expected_frame_at > last_frame_at)
                           and now - max(self._jpeg_started_at, last_frame_at or 0.0) >= 2.0)
                await self.start_jpeg_stream(force_restart=stalled)
            else:
                self._jpeg_demand_since = None
                if self._jpeg_streaming:
                    await self.send_command('Page.stopScreencast')
                    self._jpeg_streaming = False

    async def cancel_actions(self):
        """Immediately aborts any ongoing user interaction / animations in Chromium."""
        self._input_generation += 1
        self._notify_listeners({"type":"cursor_action","action":"cancel","phase":"interrupted",
                                "x":self.cursor_x,"y":self.cursor_y,"duration_ms":0,"label":"Stopped"})
        try:
            # Release mouse buttons and clear keys
            await self.send_command("Input.dispatchMouseEvent", {
                "type": "mouseReleased",
                "x": self.cursor_x,
                "y": self.cursor_y,
                "button": "left"
            })
        except Exception:
            pass

    async def close(self):
        """Clean up tabs and WebSocket connection."""
        self.is_connected = False
        if self._read_task:
            self._read_task.cancel()
        if self._send_task:
            self._send_task.cancel()
        if self._keepalive_task:
            self._keepalive_task.cancel()
        if self._h264_task:
            self._h264_task.cancel()
        if self._tree_refresh_task:
            self._tree_refresh_task.cancel()
        if self.cdp_ws:
            await self.cdp_ws.close()
        if self.target_id:
            try:
                headers = {"Host": "localhost", **self.config.headers}
                async with httpx.AsyncClient(timeout=2.0, trust_env=False, headers=headers) as client:
                    await client.put(f"{self.config.endpoint}/json/close/{self.target_id}")
            except Exception:
                pass
        if self.browser_context_id:
            from .browser_testing.isolation import dispose_context
            try:
                await dispose_context(self.config.endpoint,self.browser_context_id,self.config.headers)
            except Exception as exc:
                logger.warning(f'Owned browser context cleanup failed for {self.session_id}: {exc}')
            finally:
                self.browser_context_id = None
        if self._context_owner:
            await self._context_owner.close()
            self._context_owner = None


class BrowserManager:
    """Singleton manager tracking active live browser sessions."""

    def __init__(self):
        self.sessions: Dict[str, BrowserSession] = {}
        self.display_session_id: Optional[str] = None
        self._display_lock = asyncio.Lock()
        from weakref import WeakValueDictionary
        self.operation_locks = WeakValueDictionary()
        self.busy_sessions = set()
        self.protected_sessions = set()
        self.session_modes = {}
        self.switching_sessions = set()

    def _capacity_reached(self, purpose):
        # Server-side release checks have bounded reserved slots. Opening chats
        # must not exhaust deployment verification capacity (or evict a viewer).
        limit = max(1, int(os.getenv('BROWSER_VERIFICATION_MAX_SESSIONS', '2') if purpose == 'verification'
                           else os.getenv('BROWSER_MAX_SESSIONS', '4')))
        return sum(getattr(session, 'purpose', 'interactive') == purpose
                   for session in self.sessions.values()) >= limit

    async def _reclaim_unused_slot(self, purpose):
        if purpose != 'interactive' or not self._capacity_reached(purpose):
            return
        candidates = [(session.last_used, session_id) for session_id, session in self.sessions.items()
            if getattr(session, 'purpose', 'interactive') == purpose and not session.listeners
            and session_id not in self.busy_sessions and session_id not in self.protected_sessions
            and session_id not in self.switching_sessions]
        if candidates:
            # A closed chat's background tab can be recreated from its saved
            # target. Never interrupt a viewer, tool, campaign, or active run.
            await self.close_session(min(candidates)[1])

    def configure_session(self, session_id, mode):
        from .browser_config import browser_config
        browser_config(mode)  # Validate before storing anything or touching a tab.
        session = self.sessions.get(session_id)
        if session and session.is_connected and getattr(getattr(session, "config", None), "mode", "local") != mode:
            raise ValueError("The selected sandbox differs from this chat's browser. Apply the sandbox change in Agent Settings before testing.")
        self.session_modes[session_id] = mode

    async def switch_session(self, session_id, mode, url="about:blank"):
        """Prepare an owned tab, then commit the worker change without losing the chat.

        Failed/unreachable workers leave the existing tab and routing untouched.
        Browser operations share this lock so no action crosses the transition.
        """
        from .browser_config import browser_config
        browser_config(mode)
        await self.reap_idle(protected=self.busy_sessions)
        lock = self.operation_locks.setdefault(session_id, asyncio.Lock())
        async with lock:
            existing = self.sessions.get(session_id)
            if existing and existing.is_connected and existing.config.mode == mode:
                self.session_modes[session_id] = mode
                return existing
            target = (getattr(existing, "current_url", None) or url or "about:blank")
            candidate = BrowserSession(session_id, target, sandbox_mode=mode)
            self.switching_sessions.add(session_id)
            try:
                async with self._display_lock:
                    if existing is None: await self._reclaim_unused_slot('interactive')
                    if existing is None and self._capacity_reached('interactive'):
                        raise RuntimeError("Browser session capacity reached. Close an idle browser first.")
                    displayed = self.display_session_id
                    try:
                        await asyncio.wait_for(candidate.connect(), timeout=27 if mode == "remote" else 12)
                        if target != "about:blank":
                            await candidate.navigate(target)
                    except BaseException:
                        await candidate.close()
                        raise
                    finally:
                        previous = self.sessions.get(displayed) if displayed else None
                        if previous and previous.is_connected:
                            await previous.send_command("Page.bringToFront")
                    self.sessions[session_id] = candidate
                    self.session_modes[session_id] = mode
                    if self.display_session_id == session_id:
                        self.display_session_id = None
                if existing:
                    try:
                        await existing.close()
                    except Exception as exc:
                        logger.warning("Previous browser cleanup failed: %s", type(exc).__name__)
                return candidate
            finally:
                self.switching_sessions.discard(session_id)

    async def reap_idle(self, protected=()):
        ttl = max(60, float(os.getenv('BROWSER_SESSION_IDLE_SECONDS', '900')))
        for session_id, session in list(self.sessions.items()):
            if session_id not in protected and session_id not in self.busy_sessions and session_id not in self.protected_sessions and not session.listeners and (not session.is_connected or time.monotonic() - session.last_used > ttl):
                await self.close_session(session_id)

    async def activate_display(self, session_id: str):
        """Select the exact tab shown by the single local X11 video surface."""
        async with self._display_lock:
            session = self.sessions.get(session_id)
            if not session or not session.is_connected:
                raise RuntimeError("No connected tab to display")
            self.display_session_id = None
            for existing in self.sessions.values():
                existing.h264_active = False
                existing._video_needs_keyframe = True
                existing._last_keyframe_packet = None
            await session.send_command("Page.bringToFront")
            self.display_session_id = session_id

    def get_active_session(self) -> Optional[BrowserSession]:
        for s in self.sessions.values():
            if s.is_connected:
                return s
        return None

    async def get_or_create_session(self, session_id: str = "default", url: str = "about:blank", *, purpose="interactive") -> BrowserSession:
        if purpose not in {'interactive', 'verification'}:
            raise ValueError('Unknown browser session purpose')
        norm_url = url.rstrip("/").strip() if url else ""
        from .browser_config import browser_config
        config = browser_config(self.session_modes.get(session_id, "local"))
        container_url = config.resolve_url(url) if url else ""
        # A closed CDP target must not occupy a worker slot until the idle TTL.
        # Preserve viewed tabs and all sessions currently running operations.
        await self.reap_idle(protected=self.busy_sessions)
        if session_id in self.sessions and self.sessions[session_id].is_connected:
            session = self.sessions[session_id]
            session.last_used = time.monotonic()
            if norm_url and norm_url not in {"about:blank", "http://localhost:3000", "http://127.0.0.1:3000"}:
                session.target_url = container_url or url
                if hasattr(session, "skg") and session.skg:
                    session.skg.origin_url = session.target_url
            curr = (session.current_url or "").rstrip("/").strip()
            # Origin persistence: If already on the same website/domain, DO NOT reload! Keep current state/subpage.
            curr_parsed = urlparse(curr) if curr else None
            norm_parsed = urlparse(norm_url) if norm_url else None
            same_origin = bool(
                curr_parsed and norm_parsed and
                curr_parsed.netloc and norm_parsed.netloc and
                curr_parsed.netloc == norm_parsed.netloc
            )
            should_navigate = (
                bool(norm_url) and
                norm_url not in {"about:blank", "http://localhost:3000", "http://127.0.0.1:3000"} and
                (curr in {"about:blank", ""} or not same_origin)
            )
            if should_navigate:
                await session.navigate(url)
            return session

        session = BrowserSession(session_id=session_id, target_url=url, sandbox_mode=config.mode)
        session.purpose = purpose
        # Creating another tab must not change the surface sent to an existing viewer.
        async with self._display_lock:
            if session_id in self.sessions and self.sessions[session_id].is_connected:
                return self.sessions[session_id]
            if session_id not in self.sessions: await self._reclaim_unused_slot(purpose)
            if session_id not in self.sessions and self._capacity_reached(purpose):
                raise RuntimeError('Browser session capacity reached. Close an idle session or allocate another browser worker; no additional tab was created.')
            stale = self.sessions.pop(session_id,None)
            if stale:
                await stale.close()
            displayed = self.display_session_id
            self.display_session_id = None
            try:
                await session.connect()
            except BaseException:
                await session.close()
                raise
            finally:
                previous = self.sessions.get(displayed) if displayed else None
                if previous and previous.is_connected:
                    previous.h264_active = False
                    previous._video_needs_keyframe = True
                    await previous.send_command("Page.bringToFront")
                    self.display_session_id = displayed
            # Commit the slot under the same lock used for allocation, before
            # another request can count available capacity.
            self.sessions[session_id] = session
        if norm_url and norm_url not in {"about:blank", "http://localhost:3000", "http://127.0.0.1:3000"}:
            await session.navigate(url)
        return session

    async def stop_session(self, session_id: str):
        """Immediately stops running actions on the session."""
        session = self.sessions.get(session_id)
        if session:
            await session.cancel_actions()

    async def close_session(self, session_id: str):
        session = self.sessions.pop(session_id, None)
        if session is not None:
            if self.display_session_id == session_id:
                self.display_session_id = None
            await session.close()


# Global instance
browser_manager = BrowserManager()
