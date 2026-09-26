"""
StackPilot Lightweight Real-Time Browser Driver & Live Screencast Bridge
Ultra-low memory (~60MB), pure async CDP (Chrome DevTools Protocol) client.
Zero heavy dependencies: uses standard asyncio, httpx, and websockets.
"""

import asyncio
import base64
import json
import logging
import os
import random
import socket
import struct
import time
from typing import Any, Callable, Dict, List, Optional, Set
from urllib.parse import urlparse, urlunparse
import httpx
import websockets

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
        el_text = (element.get("text") or element.get("aria_label") or element.get("placeholder") or element.get("name") or "").lower()
        el_tag = (element.get("tag") or "").lower()
        el_type = (element.get("type") or "").lower()
        el_role = (element.get("role") or "").lower()
        el_href = (element.get("href") or "").lower()
        text_corpus += f" {el_text} {el_tag} {el_type} {el_role} {el_href}"
        if el_type == "submit" or (el_tag == "button" and el_type != "button"):
            return True

    transition_keywords = [
        "login", "log in", "signin", "sign in", "sign-in", "log-in",
        "submit", "save", "send", "register", "signup", "sign up", "sign-up",
        "continue", "next", "confirm", "proceed", "enter", "checkout",
        "apply", "book", "delete", "destroy", "create", "search", "verify",
        "authenticate", "reset", "start", "join", "connect", "auth"
    ]
    return any(kw in text_corpus for kw in transition_keywords)


class BrowserSession:
    """Manages an active CDP connection to a Chromium tab with real-time screencast."""

    def __init__(self, session_id: str, target_url: str = "about:blank"):
        self.session_id = session_id
        display = to_frontend_display_url(target_url) if target_url != "about:blank" else "http://localhost:3000"
        self.target_url = to_container_accessible_url(target_url or "http://localhost:3000")
        self.current_url = "about:blank"
        self.page_title = ""
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
        self.is_connected = False
        self.cursor_x = 640
        self.cursor_y = 360
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
        # Phase 2: Site Knowledge Graph (SKG) & Pushdown Navigation Automaton (PNA)
        self.skg = SiteKnowledgeGraph(origin_url=self.target_url)
        self.pda = PushdownNavigationAutomaton(root_url=self.current_url)
        self.current_archetype: PageArchetype = PageArchetype.UNKNOWN
        self.last_action_verification: Optional[Dict[str, Any]] = None
        self.pda.push(url=self.current_url, title="Initial Root", archetype=PageArchetype.LANDING.value, parent_url="")

    def _next_id(self) -> int:
        self._msg_id += 1
        return self._msg_id

    def is_url_in_target_domain(self, url: str) -> bool:
        """Determines whether a candidate URL belongs to the target application's allowed domain."""
        if not url or url.startswith("javascript:") or url.startswith("mailto:") or url.startswith("tel:"):
            return False
        if url.startswith("#") or url.startswith("/"):
            return True
        from urllib.parse import urlparse
        try:
            base_url = self.target_url or self.current_url or ""
            target_host = urlparse(base_url).hostname
            link_host = urlparse(url).hostname
            if not target_host or not link_host:
                return True
            target_h = target_host.lower().lstrip("www.")
            link_h = link_host.lower().lstrip("www.")
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
        stream_host = os.getenv("BROWSER_STREAM_HOST", BROWSER_STREAM_HOST)
        stream_port = int(os.getenv("BROWSER_STREAM_PORT", str(BROWSER_STREAM_PORT)))
        logger.info(f"Starting H.264 video reader targeting {stream_host}:{stream_port}")

        while self.is_connected:
            writer = None
            try:
                reader, writer = await asyncio.open_connection(stream_host, stream_port)
                self.h264_active = True
                sock = writer.get_extra_info("socket")
                if sock:
                    try:
                        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                        sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 256 * 1024)
                    except Exception:
                        pass
                logger.info(f"Connected to decoupled H.264 60 FPS video stream at {stream_host}:{stream_port}")

                while self.is_connected:
                    # Packet format from streamer.py: [4B length] [1B is_keyframe] [payload]
                    header = await reader.readexactly(5)
                    nal_len, is_kf = struct.unpack(">IB", header)
                    nalu = await reader.readexactly(nal_len)

                    self._frame_seq += 1
                    now_ts = time.time()
                    ts_ms = int(now_ts * 1000)
                    self._last_frame_time = now_ts
                    self._last_chromium_frame_time = now_ts
                    self._navigating = False

                    metadata = {"codec": "h264", "isKeyFrame": bool(is_kf)}
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
                    })
            except (asyncio.IncompleteReadError, ConnectionRefusedError, OSError):
                self.h264_active = False
                await asyncio.sleep(0.5)
            except asyncio.CancelledError:
                break
            except Exception as e:
                self.h264_active = False
                logger.debug(f"H.264 stream loop notice: {e}")
                await asyncio.sleep(0.5)
            finally:
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
                if now - last_url_check >= 1.0:
                    last_url_check = now
                    try:
                        loc = await self.evaluate("window.location.href")
                        if loc and "chrome-error://" not in loc:
                            clean_loc = to_frontend_display_url(loc)
                            if clean_loc != self.current_url:
                                logger.info(f"URL change detected via keepalive: {self.current_url} -> {clean_loc}")
                                self.current_url = clean_loc
                                self._notify_listeners({"type": "navigated", "url": self.current_url})
                                self._notify_listeners({
                                    "type": "page_state",
                                    "url": self.current_url,
                                    "title": self.page_title,
                                    "elements": self.interactive_elements,
                                })
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

    async def send_command(self, method: str, params: Optional[Dict[str, Any]] = None, timeout: float = 3.5) -> Any:
        if not self.cdp_ws or not self.is_connected:
            raise RuntimeError("CDP WebSocket is not connected.")
        msg_id = self._next_id()
        payload = {"id": msg_id, "method": method}
        if params:
            payload["params"] = params

        loop = asyncio.get_running_loop()
        fut = loop.create_future()
        self._pending_requests[msg_id] = fut

        self._send_queue.put_nowait((10, msg_id, json.dumps(payload)))
        return await asyncio.wait_for(fut, timeout=timeout)

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
                            metadata = params.get("metadata", {})
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
                            "metadata": params.get("metadata", {}),
                            "timestamp": now_ts
                        })

                # 2. Console log event
                elif method == "Runtime.consoleAPICalled":
                    args = params.get("args", [])
                    text = " ".join(str(a.get("value", a.get("description", ""))) for a in args)
                    if "__STACKPILOT_DOM_SCROLLED__" in text:
                        asyncio.create_task(self.extract_interactive_tree())
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
                elif method in {"Page.frameNavigated", "Page.navigatedWithinDocument"}:
                    raw_nav_url = ""
                    if method == "Page.frameNavigated":
                        frame = params.get("frame", {})
                        if not frame.get("parentId"):
                            raw_nav_url = frame.get("url", "")
                    elif method == "Page.navigatedWithinDocument":
                        raw_nav_url = params.get("url", "")

                    if raw_nav_url and "chrome-error://" not in raw_nav_url:
                        self.current_url = to_frontend_display_url(raw_nav_url)
                        self._last_navigation_time = time.time()
                        self._lifecycle_events.clear()
                        self._notify_listeners({"type": "navigated", "url": self.current_url})
                        self._notify_listeners({
                            "type": "page_state",
                            "url": self.current_url,
                            "title": self.page_title,
                            "elements": self.interactive_elements,
                        })

                # 4b. Target lifecycle: close orphan background tabs and keep session on primary tab
                elif method == "Target.targetCreated":
                    target_info = params.get("targetInfo", {})
                    if target_info.get("type") == "page" and target_info.get("targetId") != self.target_id:
                        extra_id = target_info.get("targetId")
                        extra_url = target_info.get("url", "")
                        logger.info(f"Closing extra popup tab: {extra_id} ({extra_url})")
                        asyncio.create_task(self._close_extra_tab(extra_id))

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

        except websockets.exceptions.ConnectionClosed:
            logger.info(f"CDP connection closed for session {self.session_id}")
        except Exception as e:
            logger.error(f"Error in CDP listener loop: {e}", exc_info=True)
        finally:
            self.is_connected = False

    def add_listener(self, callback: Callable[[Dict[str, Any]], Any]):
        self.listeners.add(callback)

    def remove_listener(self, callback: Callable[[Dict[str, Any]], Any]):
        self.listeners.discard(callback)

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
            headers = {"Host": "localhost"}
            async with httpx.AsyncClient(timeout=2.0, headers=headers) as client:
                await client.put(f"{CHROME_HOST}/json/close/{target_id}")
        except Exception:
            pass

    async def connect(self):
        """Creates or reuses a browser tab via CDP HTTP endpoint and connects via WebSocket."""
        headers = {"Host": "localhost"}
        async with httpx.AsyncClient(timeout=6.0, headers=headers) as client:
            target_data = None
            try:
                list_resp = await client.get(f"{CHROME_HOST}/json/list")
                if list_resp.status_code == 200:
                    page_tabs = [t for t in list_resp.json() if t.get("type") == "page"]
                    if page_tabs:
                        target_data = page_tabs[0]
                        # Close orphan extra popup tabs in the background
                        for tab in page_tabs[1:]:
                            try:
                                await client.put(f"{CHROME_HOST}/json/close/{tab.get('id')}")
                            except Exception:
                                pass
            except Exception as e:
                logger.debug(f"Tab list notice: {e}")

            if not target_data:
                resp = await client.put(f"{CHROME_HOST}/json/new")
                target_data = resp.json()

            self.target_id = target_data.get("id")
            raw_ws = target_data.get("webSocketDebuggerUrl")
            if not raw_ws:
                raise RuntimeError(f"Could not get webSocketDebuggerUrl from Chromium: {target_data}")

            # Correct hostname if running in docker
            # Chromium may report ws://127.0.0.1:9222, rewrite to CHROME_HOST host/port
            chrome_net_host = CHROME_HOST.replace("http://", "").replace("https://", "")
            raw_ws_parts = raw_ws.split("/devtools/")
            self.ws_url = f"ws://{chrome_net_host}/devtools/{raw_ws_parts[-1]}"

        logger.info(f"Connecting to CDP at {self.ws_url}")
        self.cdp_ws = await websockets.connect(
            self.ws_url,
            max_size=10 * 1024 * 1024
        )
        self.is_connected = True
        self._read_task = asyncio.create_task(self._listen_loop())
        self._send_task = asyncio.create_task(self._send_loop())
        self._keepalive_task = asyncio.create_task(self._keepalive_loop())

        # Enable core domains
        await self.send_command("Page.enable")
        await self.send_command("DOM.enable")
        await self.send_command("Runtime.enable")
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


        # Force all links (target="_blank") and window.open calls to navigate the current tab
        # so CDP session tracking and live stream never detach into zombie background tabs
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

                        window.open = function(url) {
                            if (url) window.location.href = url;
                            return window;
                        };
                        document.addEventListener('click', (e) => {
                            const a = e.target && e.target.closest ? e.target.closest('a') : null;
                            if (a && a.target && a.target.toLowerCase() !== '_self') {
                                a.target = '_self';
                            }
                        }, true);
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

        # Check if decoupled H.264 video streamer is reachable on port 8099
        try:
            stream_host = os.getenv("BROWSER_STREAM_HOST", BROWSER_STREAM_HOST)
            stream_port = int(os.getenv("BROWSER_STREAM_PORT", str(BROWSER_STREAM_PORT)))
            _, test_writer = await asyncio.wait_for(asyncio.open_connection(stream_host, stream_port), timeout=0.6)
            test_writer.close()
            await test_writer.wait_closed()
            self.h264_active = True
            logger.info(f"Decoupled H.264 video plane detected at {stream_host}:{stream_port}. Enabling 60 FPS WebCodecs streaming.")
        except Exception:
            self.h264_active = False
            logger.info("Decoupled H.264 stream not yet reachable, initializing optimized CDP screencast fallback.")

        if self.h264_active:
            self._h264_task = asyncio.create_task(self._h264_stream_loop())
        else:
            # Start native screencast with optimized parameters for maximum streaming FPS
            await self.send_command("Page.startScreencast", {
                "format": "jpeg",
                "quality": 50,
                "maxWidth": 1280,
                "maxHeight": 720,
                "everyNthFrame": 1,
            })

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


            // Continuous High-Performance Compositor Pulse (15-20 FPS)
            // Ensures smooth live screencast frames flow continuously without Python CDP polling overhead
            function installTicker() {
              if (document.getElementById('__sp_live_ticker')) return;
              const target = document.body || document.documentElement;
              if (!target) {
                if (document.readyState === 'loading') {
                  document.addEventListener('DOMContentLoaded', installTicker, { once: true });
                }
                return;
              }
              const c = document.createElement('canvas');
              c.id = '__sp_live_ticker';
              c.width = 1;
              c.height = 1;
              c.style.cssText = 'position:fixed;bottom:0;right:0;width:1px;height:1px;pointer-events:none;z-index:2147483647;';
              target.appendChild(c);
              const ctx = c.getContext('2d');
              let color = 0;
              let last = 0;
              function tick(now) {
                if (now - last >= 66) { // ~15 FPS solid floor
                  last = now;
                  color = color === 0 ? 1 : 0;
                  ctx.fillStyle = color === 0 ? '#000000' : '#111111';
                  ctx.fillRect(0, 0, 1, 1);
                }
                requestAnimationFrame(tick);
              }
              requestAnimationFrame(tick);
            }
            installTicker();

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
        """
        Dismisses any open modal or overlay via:
        1. In-modal acknowledgment/continue/language buttons (English, Hindi, OK, Accept, Got it, Continue, Close).
        2. Close buttons and 'X' icons (including PrimeNG .ui-dialog-titlebar-close, .p-dialog-header-close).
        3. In-page back buttons for subviews/case studies.
        4. In-DOM and CDP Escape keyboard event dispatch.
        5. Removal of stale or blocking backdrop masks.
        """
        try:
            res = await self.send_command("Runtime.evaluate", {
                "expression": """(() => {
                    if (window.__EXPLORER_ENGINE__ && typeof window.__EXPLORER_ENGINE__.dismissModal === 'function') {
                        if (window.__EXPLORER_ENGINE__.dismissModal()) return true;
                    }

                    // 1. Multilingual Acknowledgement / Confirmation / Language buttons
                    const confirmKeywords = [
                        'english', 'ok', 'okay', 'got it', 'accept', 'agree', 'i agree', 'continue',
                        'proceed', 'confirm', 'enter', 'yes', 'allow', 'done', 'close', 'dismiss', 'skip',
                        'हिंदी', 'स्वीकार', 'जारी रखें', 'ठीक है', 'बंद करें', 'आगे बढ़ें', 'सहमति'
                    ];

                    const modalContainers = Array.from(document.querySelectorAll(
                        '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open], ' +
                        '.ui-dialog, .p-dialog, .swal2-container, .modal.show, .ant-modal, .cdk-overlay-pane, ' +
                        '[class*="modal"][class*="open"], [class*="Modal_open"]'
                    )).filter(el => {
                        const s = window.getComputedStyle(el);
                        return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity || '1') > 0.1;
                    });

                    for (const modal of modalContainers) {
                        const btns = Array.from(modal.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'));
                        // Priority A: 'English' or standard 'OK' / 'Got it'
                        for (const b of btns) {
                            const txt = (b.textContent || b.getAttribute('aria-label') || b.value || '').trim().toLowerCase();
                            if (txt === 'english' || txt.includes('english') || txt === 'ok' || txt === 'okay' || txt === 'got it' || txt === 'accept' || txt === 'agree' || txt === 'i agree' || txt === 'continue' || txt === 'proceed') {
                                try { b.click(); return true; } catch(e) {}
                            }
                        }
                        // Priority B: Other confirmation keywords including multilingual
                        for (const b of btns) {
                            const txt = (b.textContent || b.getAttribute('aria-label') || b.value || '').trim().toLowerCase();
                            if (confirmKeywords.some(kw => txt === kw || txt.includes(kw))) {
                                try { b.click(); return true; } catch(e) {}
                            }
                        }
                    }

                    // 2. Standard modal close button selectors (including PrimeNG and Angular CDK)
                    const closeSelectors = [
                        '.ui-dialog-titlebar-close',
                        '.p-dialog-header-close',
                        '[role="dialog"] [class*="close"]',
                        '[role="dialog"] button[aria-label*="close" i]',
                        '[aria-modal="true"] [class*="close"]',
                        '[aria-modal="true"] button[aria-label*="close" i]',
                        '.modal [class*="close"]',
                        '.modal button[aria-label*="close" i]',
                        'button.close-btn',
                        'button.close',
                        '.close-btn',
                        '.close',
                        '[aria-label*="close" i]',
                        '[data-dismiss="modal"]',
                        '[data-bs-dismiss="modal"]'
                    ];
                    for (const sel of closeSelectors) {
                        const btn = document.querySelector(sel);
                        if (btn && typeof btn.click === 'function') {
                            btn.click();
                            return true;
                        }
                    }

                    // 3. Try in-page back buttons for subviews/case studies (e.g. "Back to Projects")
                    const backButtons = Array.from(document.querySelectorAll('button, a')).filter(el => {
                        const txt = (el.textContent || '').trim().toLowerCase();
                        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
                        return (
                            txt.includes('back to') ||
                            txt.includes('← back') ||
                            txt === 'back' ||
                            txt.includes('return to') ||
                            txt.includes('close case study') ||
                            txt.includes('close modal') ||
                            aria.includes('back') ||
                            aria.includes('close')
                        );
                    });
                    for (const btn of backButtons) {
                        const rect = btn.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0 && rect.top <= 300) {
                            btn.click();
                            return true;
                        }
                    }

                    // 4. In-DOM Escape dispatch
                    const esc = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true });
                    window.dispatchEvent(esc);
                    document.dispatchEvent(esc);
                    if (document.activeElement) document.activeElement.dispatchEvent(esc);

                    // 5. Hide leftover backdrop masks that intercept clicks
                    document.querySelectorAll('.ui-dialog-mask, .p-dialog-mask, .modal-backdrop, .cdk-overlay-backdrop').forEach(m => {
                        try {
                            m.style.display = 'none';
                            m.style.pointerEvents = 'none';
                        } catch(e) {}
                    });

                    return true;
                })()""",
                "returnByValue": True
            }, timeout=1.0)
            if res.get("result", {}).get("value") is True:
                await self.wait_for_quiescence(dom_quiet_ms=40, max_timeout_s=0.6)
        except Exception:
            pass

        # Fallback: dispatch CDP Escape key event
        try:
            await self.send_command("Input.dispatchKeyEvent", {
                "type": "rawKeyDown",
                "windowsVirtualKeyCode": 27,
                "key": "Escape",
                "code": "Escape",
            })
            await self.send_command("Input.dispatchKeyEvent", {
                "type": "keyUp",
                "windowsVirtualKeyCode": 27,
                "key": "Escape",
                "code": "Escape",
            })
            await self.wait_for_quiescence(dom_quiet_ms=40, max_timeout_s=0.6)
        except Exception:
            pass

        # Ensure no persistent blocking modals or masks remain visible
        try:
            await self.send_command("Runtime.evaluate", {
                "expression": """(() => {
                    const openModals = Array.from(document.querySelectorAll('[role="dialog"], dialog[open], .ui-dialog, .p-dialog, .modal.active, .modal.show'))
                        .filter(m => window.getComputedStyle(m).display !== 'none');
                    for (const m of openModals) {
                        if (typeof m.close === 'function') m.close();
                        m.classList.remove('active');
                        m.classList.remove('show');
                    }
                    document.querySelectorAll('.ui-dialog-mask, .p-dialog-mask, .modal-backdrop, .cdk-overlay-backdrop').forEach(m => {
                        try {
                            m.style.display = 'none';
                            m.style.pointerEvents = 'none';
                        } catch(e) {}
                    });
                    return true;
                })()""",
                "returnByValue": True
            }, timeout=0.6)
            await self.wait_for_quiescence(dom_quiet_ms=30, max_timeout_s=0.5)
            return True
        except Exception:
            return True

    async def auto_dismiss_startup_modals(self) -> bool:
        """
        Universally inspects and dismisses startup modal dialogs, alert popups, language selection modals,
        and cookie banners that appear immediately on page load across any framework and language.
        """
        dismiss_js = """
        (() => {
            const confirmKeywords = [
                'english', 'ok', 'okay', 'got it', 'accept', 'agree', 'i agree', 'continue', 'proceed', 'confirm',
                'enter', 'yes', 'allow', 'done', 'close', 'dismiss', 'skip',
                'हिंदी', 'स्वीकार', 'जारी रखें', 'ठीक है', 'बंद करें', 'आगे बढ़ें', 'सहमति'
            ];

            const modalSelectors = [
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
                '[class*="alert"][class*="dialog"]'
            ];

            let activeModal = null;
            for (const sel of modalSelectors) {
                const els = Array.from(document.querySelectorAll(sel));
                for (const el of els) {
                    const style = window.getComputedStyle(el);
                    if (style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity || '1') > 0.1) {
                        const rect = el.getBoundingClientRect();
                        if (rect.width >= 120 && rect.height >= 80) {
                            activeModal = el;
                            break;
                        }
                    }
                }
                if (activeModal) break;
            }

            if (!activeModal) {
                const fixedEls = Array.from(document.querySelectorAll('div, section, aside')).filter(el => {
                    const style = window.getComputedStyle(el);
                    if (style.position === 'fixed' || (style.position === 'absolute' && parseInt(style.zIndex, 10) >= 100)) {
                        const z = parseInt(style.zIndex, 10);
                        if (!isNaN(z) && z >= 100) {
                            const rect = el.getBoundingClientRect();
                            return (
                                rect.width >= window.innerWidth * 0.35 &&
                                rect.height >= window.innerHeight * 0.25 &&
                                style.visibility !== 'hidden' &&
                                style.display !== 'none' &&
                                parseFloat(style.opacity || '1') > 0.5
                            );
                        }
                    }
                    return false;
                });
                if (fixedEls.length > 0) {
                    activeModal = fixedEls[fixedEls.length - 1];
                }
            }

            if (!activeModal) return false;

            const candidates = Array.from(activeModal.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'));
            
            // Priority A: Preferred language button (English) or universal OK/Got it/Accept button
            for (const btn of candidates) {
                const txt = (btn.textContent || btn.getAttribute('aria-label') || btn.value || '').trim().toLowerCase();
                if (txt === 'english' || txt.includes('english') || txt === 'ok' || txt === 'okay' || txt === 'got it' || txt === 'i agree' || txt === 'accept' || txt === 'agree' || txt === 'continue' || txt === 'proceed') {
                    try {
                        btn.click();
                        return { dismissed: true, target: txt, type: 'button_click' };
                    } catch(e) {}
                }
            }

            // Priority B: Hindi / Multilingual buttons
            for (const btn of candidates) {
                const txt = (btn.textContent || btn.getAttribute('aria-label') || btn.value || '').trim().toLowerCase();
                for (const kw of confirmKeywords) {
                    if (txt === kw || txt.includes(kw)) {
                        try {
                            btn.click();
                            return { dismissed: true, target: txt, type: 'multilingual_click' };
                        } catch(e) {}
                    }
                }
            }

            // Priority C: Close / 'X' buttons
            const closeBtn = activeModal.querySelector('.ui-dialog-titlebar-close, .p-dialog-header-close, button[aria-label*="close" i], button[title*="close" i], .close, .modal-close, [class*="close"], [data-dismiss="modal"]');
            if (closeBtn && typeof closeBtn.click === 'function') {
                closeBtn.click();
                return { dismissed: true, target: 'close_btn', type: 'close_click' };
            }

            // Priority D: Fallback Escape event
            const esc = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true });
            activeModal.dispatchEvent(esc);
            document.dispatchEvent(esc);

            return { dismissed: true, target: 'escape', type: 'escape_dispatched' };
        })()
        """
        try:
            res = await self.send_command("Runtime.evaluate", {"expression": dismiss_js, "returnByValue": True}, timeout=1.5)
            val = res.get("result", {}).get("value")
            if isinstance(val, dict) and val.get("dismissed"):
                logger.info(f"Auto-dismissed startup modal/alert on '{self.current_url}': {val}")
                await self.wait_for_quiescence(network_idle_ms=60, dom_quiet_ms=30, max_timeout_s=0.8, fast_mode=True)
                return True
        except Exception as e:
            logger.debug(f"auto_dismiss_startup_modals notice: {e}")
        return False

    async def force_fresh_frame(self) -> Optional[str]:
        """Forces Chromium to render and capture an immediate fresh frame, broadcasting it to live stream listeners."""
        if not self.cdp_ws or not self.is_connected:
            return None
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
        remaining = max(0.4, max_timeout_s - (time.time() - start))
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
        internal_url = to_container_accessible_url(url)
        display_url = to_frontend_display_url(url)
        norm_target = display_url.rstrip("/").lower()
        norm_curr = (self.current_url or "").rstrip("/").lower()
        if not force and norm_curr and norm_target == norm_curr and norm_target not in {"about:blank", ""}:
            # Already on this exact URL, skip redundant reload
            return {"url": self.current_url}

        self.current_url = display_url
        # Suppress stale keepalive re-broadcast during navigation
        self._navigating = True
        self._last_raw_jpeg = None  # Clear raw screenshot cache
        # Retain self.latest_frame so screencast clients have smooth persistent visuals until next frame paints
        self._notify_listeners({"type": "action", "action": "navigate", "url": display_url})
        self._lifecycle_events.clear()
        res = None
        try:
            res = await self.send_command("Page.navigate", {"url": internal_url}, timeout=15.0)
        except asyncio.TimeoutError:
            logger.warning(f"Page.navigate timed out after 15s for {internal_url}; checking if navigation committed...")
            try:
                curr_href = await self.evaluate("window.location.href", timeout=1.5)
                if curr_href and curr_href != "about:blank":
                    res = {"url": curr_href}
                else:
                    raise
            except Exception:
                raise

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


        try:
            await self.auto_dismiss_startup_modals()
        except Exception:
            pass

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

    async def extract_interactive_tree(self) -> Dict[str, Any]:
        """Traverses light DOM + open shadow roots to return interactive elements (buttons, links, inputs, tabs, toggles) with viewport and page coordinates."""
        js_code = r"""
        (() => {
            const elements = [];
            const seen = new Set();
            
            // Persistent in-browser DOM node cache with WeakMap identity preservation
            const cache = window.__spFast = window.__spFast || {
                ids: new WeakMap(),
                nodes: new Map(),
                nextId: 1
            };
            // Clean up disconnected nodes to prevent memory leaks
            for (const [id, e] of cache.nodes) {
                if (!e || !e.isConnected) cache.nodes.delete(id);
            }

            // Global persistent ID allocator (shared by tree extraction & autocomplete harvester)
            window.__spGetOrAssignId = function(node) {
                if (!node) return null;
                let id = cache.ids.get(node);
                if (id === undefined) {
                    const attr = node.getAttribute('data-sp-id');
                    const parsed = attr ? parseInt(attr, 10) : null;
                    if (parsed && !cache.nodes.has(parsed)) {
                        id = parsed;
                        if (id >= cache.nextId) cache.nextId = id + 1;
                    } else {
                        id = cache.nextId++;
                    }
                    cache.ids.set(node, id);
                }
                cache.nodes.set(id, node);
                try { node.setAttribute('data-sp-id', String(id)); } catch(e) {}
                return id;
            };

            const isVisible = (e) => {
                if (!e || !e.isConnected) return false;
                if (e.closest && e.closest('[aria-hidden="true"],[inert]')) return false;
                if (typeof e.checkVisibility === 'function') {
                    return e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
                }
                const s = window.getComputedStyle(e);
                return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
            };

            function collectNodes(root, depth = 0) {
                const list = [];
                if (depth > 2 || !root || !root.querySelectorAll) return list;
                const selector = 'button, a[href], input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="switch"], [role="checkbox"], [role="combobox"], [role="option"], [role="menuitem"], [role="alert"], [role="status"], [contenteditable="true"], [tabindex="0"], summary, details, li.ui-autocomplete-list-item, li.p-autocomplete-item, [class*="autocomplete-item"], [class*="suggestion-item"], [class*="dropdown-item"], .ui-message-error, .invalid-feedback, .alert, .toast, .pac-item';
                try {
                    const matched = root.querySelectorAll(selector);
                    for (let i = 0; i < matched.length && list.length < 350; i++) {
                        list.push(matched[i]);
                    }
                    // For shadow DOM, inspect custom elements with shadow roots (limit sample to 60)
                    const shadowHosts = root.querySelectorAll(':not(:defined)');
                    for (let i = 0; i < Math.min(shadowHosts.length, 60); i++) {
                        if (shadowHosts[i].shadowRoot) {
                            list.push(...collectNodes(shadowHosts[i].shadowRoot, depth + 1));
                        }
                    }
                } catch(e) {}
                return list;
            }

            const nodes = collectNodes(document);
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

                const rect = el.getBoundingClientRect();
                if (rect.width < 3 || rect.height < 3) continue;

                let text = (el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
                if (!text) {
                    text = (el.textContent || el.placeholder || el.value || el.name || el.id || '').trim();
                }
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
                let isOccluded = false;
                if (isInViewport && cx >= 0 && cy >= 0 && cx < winW && cy < winH && elements.length < 35) {
                    try {
                        const topNode = document.elementFromPoint(cx, cy);
                        if (topNode && topNode !== el && !el.contains(topNode) && !topNode.contains(el)) {
                            isOccluded = true;
                        }
                    } catch(e) {}
                }

                const tagL = (el.tagName || '').toLowerCase();
                const hasPop = el.getAttribute('aria-haspopup') === 'true' || el.hasAttribute('data-toggle') || (el.className && typeof el.className === 'string' && (el.className.includes('dropdown') || el.className.includes('has-sub')));
                const isHoverCand = hasPop || (el.closest('nav, header, [role="navigation"], [class*="menu"]') !== null && (tagL === 'a' || tagL === 'button' || el.getAttribute('role') === 'menuitem'));
                const isInsideModal = Boolean(el.closest && el.closest('[role="dialog"], [role="alertdialog"], .ui-dialog, .p-dialog, .swal2-container, .modal.show, .ant-modal, .cdk-overlay-pane'));
                
                const parentForm = el.closest('form');
                const formId = parentForm ? (parentForm.id || parentForm.getAttribute('name') || ('form_' + Array.from(document.querySelectorAll('form')).indexOf(parentForm))) : '';
                const parentCard = el.parentElement ? el.parentElement.closest('[class*="card"], [class*="item"], [class*="box"], [class*="tile"], article, section') : null;
                let cardHeading = '';
                if (parentCard) {
                    const h = parentCard.querySelector('h1, h2, h3, h4, [class*="title"], [class*="heading"], strong');
                    if (h) cardHeading = (h.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
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
                    role: el.getAttribute('role') || tagL,
                    type: el.type || '',
                    classes: (typeof el.className === 'string') ? el.className : '',
                    href: href,
                    is_external: isExternalLink,
                    text: text,
                    name: el.name || '',
                    input_id: el.id || '',
                    placeholder: el.placeholder || '',
                    value: (el.value || '').slice(0, 80),
                    checked: Boolean(el.checked || el.getAttribute('aria-checked') === 'true'),
                    disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
                    is_in_viewport: isInViewport,
                    is_occluded: isOccluded,
                    is_inside_modal: isInsideModal,
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
                subpages: subpages
            };
        })()
        """
        try:
            res = await self.send_command("Runtime.evaluate", {
                "expression": js_code,
                "returnByValue": True,
            }, timeout=6.0)
            val = res.get("result", {}).get("value", {})
        except Exception as e:
            logger.debug(f"extract_interactive_tree evaluation notice: {e}")
            val = {}
        self.page_title = val.get("title", "")
        self.scroll_y = val.get("scroll_y", 0)
        self.scroll_height = val.get("scroll_height", 720)
        self.viewport_height = val.get("viewport_height", 720)
        raw_ret_url = val.get("url", "")
        if raw_ret_url and "chrome-error://" not in raw_ret_url:
            self.current_url = to_frontend_display_url(raw_ret_url)
        self.interactive_elements = val.get("elements", [])
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
        self._notify_listeners(state_payload)
        return {
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
                new_cx = el["page_x"] - scroll_x
                new_cy = el["page_y"] - scroll_y
                el_w = el.get("w", 0)
                el_h = el.get("h", 0)
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

        path = self._generate_bezier_path(self.cursor_x, self.cursor_y, x, y, fast_mode=fast_mode)

        # 1. Smooth kinematic Bézier glide (8ms intervals, ~50-100ms total)
        for curr_x, curr_y in path:
            self._notify_listeners({
                "type": "cursor_action",
                "action": "move",
                "x": curr_x,
                "y": curr_y,
                "label": label or f"Moving to ({x}, {y})",
            })
            self.send_command_nowait("Input.dispatchMouseEvent", {
                "type": "mouseMoved",
                "x": curr_x,
                "y": curr_y,
            })
            if not fast_mode and len(path) > 1:
                await asyncio.sleep(0.008)

        self.cursor_x = x
        self.cursor_y = y

        # 2. Notify click ripple and action to frontend
        self._notify_listeners({
            "type": "cursor_action",
            "action": "click",
            "x": x,
            "y": y,
            "label": label or f"Clicking ({x}, {y})",
        })

        # 4. Dispatch mousePressed, pause briefly for visual active state rendering, then mouseReleased
        await self.send_command("Input.dispatchMouseEvent", {
            "type": "mousePressed",
            "x": x,
            "y": y,
            "button": "left",
            "clickCount": 1,
        })
        await self.send_command("Input.dispatchMouseEvent", {
            "type": "mouseReleased",
            "x": x,
            "y": y,
            "button": "left",
            "clickCount": 1,
        })

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

        path = self._generate_bezier_path(self.cursor_x, self.cursor_y, x, y)
        for curr_x, curr_y in path:
            self._notify_listeners({
                "type": "cursor_action",
                "action": "move",
                "x": curr_x,
                "y": curr_y,
                "label": label or f"Hovering ({x}, {y})",
            })
            self.send_command_nowait("Input.dispatchMouseEvent", {
                "type": "mouseMoved",
                "x": curr_x,
                "y": curr_y,
            })
            await asyncio.sleep(0.008)

        self.cursor_x = x
        self.cursor_y = y


        self._notify_listeners({
            "type": "cursor_action",
            "action": "hover",
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

        path = self._generate_bezier_path(self.cursor_x, self.cursor_y, x, y)
        for curr_x, curr_y in path:
            self.send_command_nowait("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": curr_x, "y": curr_y})
            await asyncio.sleep(0.008)

        self.cursor_x = x
        self.cursor_y = y

        self._notify_listeners({
            "type": "cursor_action",
            "action": "double_click",
            "x": x,
            "y": y,
            "label": label or f"Double-clicking ({x}, {y})",
        })

        await self.send_command("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x, "y": y, "button": "left", "clickCount": 1})
        await asyncio.sleep(0.02)
        await self.send_command("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x, "y": y, "button": "left", "clickCount": 1})
        await asyncio.sleep(0.06)
        await self.send_command("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x, "y": y, "button": "left", "clickCount": 2})
        await asyncio.sleep(0.02)
        await self.send_command("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x, "y": y, "button": "left", "clickCount": 2})

    async def right_click(self, x: int, y: int, label: str = ""):
        """Dispatches right-click context menu event with visual indicator."""
        if self.interactive_elements:
            for el in self.interactive_elements:
                if ((x - el.get("x", -999))**2 + (y - el.get("y", -999))**2)**0.5 < 8.0:
                    x, y = el["x"], el["y"]
                    break

        path = self._generate_bezier_path(self.cursor_x, self.cursor_y, x, y)
        for curr_x, curr_y in path:
            self.send_command_nowait("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": curr_x, "y": curr_y})
            await asyncio.sleep(0.008)

        self.cursor_x = x
        self.cursor_y = y


        self._notify_listeners({
            "type": "cursor_action",
            "action": "right_click",
            "x": x,
            "y": y,
            "label": label or f"Right-clicking ({x}, {y})",
        })

        await self.send_command("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x, "y": y, "button": "right", "clickCount": 1})
        await asyncio.sleep(0.03)
        await self.send_command("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x, "y": y, "button": "right", "clickCount": 1})

    async def drag_and_drop(self, start_x: int, start_y: int, end_x: int, end_y: int, label: str = ""):
        """Simulates native drag and drop from start coordinate to end coordinate."""
        init_path = self._generate_bezier_path(self.cursor_x, self.cursor_y, start_x, start_y)
        for cx, cy in init_path:
            self.send_command_nowait("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": cx, "y": cy})
            await asyncio.sleep(0.008)

        self.cursor_x = start_x
        self.cursor_y = start_y

        self._notify_listeners({
            "type": "cursor_action",
            "action": "drag_start",
            "x": start_x,
            "y": start_y,
            "label": label or f"Dragging from ({start_x}, {start_y}) to ({end_x}, {end_y})",
        })

        await self.send_command("Input.dispatchMouseEvent", {
            "type": "mousePressed",
            "x": start_x,
            "y": start_y,
            "button": "left",
            "clickCount": 1,
        })
        await asyncio.sleep(0.05)

        drag_path = self._generate_bezier_path(start_x, start_y, end_x, end_y)
        for cx, cy in drag_path:
            self.send_command_nowait("Input.dispatchMouseEvent", {
                "type": "mouseMoved",
                "x": cx,
                "y": cy,
                "buttons": 1,
            })
            await asyncio.sleep(0.012)

        self.cursor_x = end_x
        self.cursor_y = end_y

        await self.send_command("Input.dispatchMouseEvent", {
            "type": "mouseReleased",
            "x": end_x,
            "y": end_y,
            "button": "left",
            "clickCount": 1,
        })
        await asyncio.sleep(0.04)

    async def toggle_checkbox(self, element_id: int) -> bool:
        """Toggles a checkbox or switch element reliably without double-reversion."""
        el = next((e for e in self.interactive_elements if e["id"] == element_id), None)
        if el and el.get("x") is not None and el.get("y") is not None:
            await self.scroll_to_element(element_id)
            await self.click(el["x"], el["y"], label=f"Toggle {el.get('text') or 'checkbox'}", fast_mode=True)
            return True

        toggle_js = f"""
        (() => {{
            try {{
                const target = (window.__spFast && window.__spFast.nodes.get({element_id})) || document.querySelector('[data-sp-id="{element_id}"]');
                if (target) {{
                    target.checked = !target.checked;
                    target.dispatchEvent(new Event('input', {{ bubbles: true }}));
                    target.dispatchEvent(new Event('change', {{ bubbles: true }}));
                }}
            }} catch(e) {{}}
        }})()
        """
        try:
            await self.send_command("Runtime.evaluate", {"expression": toggle_js})
        except Exception:
            pass
        return True

    async def select_option(self, element_id: int, value: str = "") -> bool:
        """Selects an option in a <select> element."""
        el = next((e for e in self.interactive_elements if e["id"] == element_id), None)
        select_js = f"""
        (() => {{
            try {{
                const target = (window.__spFast && window.__spFast.nodes.get({element_id})) || document.querySelector('[data-sp-id="{element_id}"]');
                if (target && target.options && target.options.length > 0) {{
                    let chosen = -1;
                    const valLow = "{value}".toLowerCase();
                    if (valLow) {{
                        for (let i = 0; i < target.options.length; i++) {{
                            if (target.options[i].value.toLowerCase().includes(valLow) || target.options[i].text.toLowerCase().includes(valLow)) {{
                                chosen = i;
                                break;
                            }}
                        }}
                    }}
                    if (chosen === -1) {{
                        chosen = Math.min(1, target.options.length - 1);
                    }}
                    target.selectedIndex = chosen;
                    target.dispatchEvent(new Event('input', {{ bubbles: true }}));
                    target.dispatchEvent(new Event('change', {{ bubbles: true }}));
                    return target.options[chosen].text;
                }}
            }} catch(e) {{}}
            return null;
        }})()
        """
        try:
            await self.send_command("Runtime.evaluate", {"expression": select_js})
        except Exception:
            pass
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
        scrolled = await self.evaluate(f"""
        (() => {{
            const el = (window.__spFast && window.__spFast.nodes.get({element_id})) || document.querySelector('[data-sp-id="{element_id}"]');
            if (el) {{
                const r = el.getBoundingClientRect();
                const inView = (r.top >= 20 && r.bottom <= (window.innerHeight || 720) - 20);
                if (inView) return 'in_view';
                try {{
                    el.scrollIntoView({{ behavior: 'smooth', block: 'center', inline: 'nearest' }});
                }} catch(e) {{
                    el.scrollIntoView();
                }}
                return 'scrolled';
            }}
            return false;
        }})()
        """, timeout=1.5)
        if scrolled == 'scrolled':
            await self.wait_for_scroll_settled(min_quiet_ms=50, max_timeout_s=0.35)
            await self.force_fresh_frame()
            try:
                curr_scroll = await self.evaluate("[window.scrollX || 0, window.scrollY || 0]", timeout=0.5)
                if isinstance(curr_scroll, list) and len(curr_scroll) >= 2:
                    self.update_element_viewport_coordinates(int(curr_scroll[0]), int(curr_scroll[1]))
            except Exception:
                pass
            return True
        elif scrolled == 'in_view':
            return True

        el = next((e for e in self.interactive_elements if e["id"] == element_id), None)
        if not el:
            return False
        curr_y = await self.evaluate("window.scrollY || 0", timeout=1.0) or 0
        page_y = el.get("page_y", el.get("y", 0) + curr_y)
        target_scroll = max(0, page_y - 280)
        await self.scroll_to(target_scroll, extract_tree=False)
        return True

    async def click_element(self, element_id: int, label: str = "", fast_mode: bool = True) -> bool:
        """Scrolls element into view if needed, performs APV two-tier click, awaits action completion, and verifies outcome."""
        el = next((e for e in (self.interactive_elements or []) if str(e.get("id")) == str(element_id)), None)
        target_name = label or (el.get("text") if el else f"Element #{element_id}")
        is_transition = is_transitioning_or_submit_action(el, label=target_name, action="click")
        # Scroll element into viewport center before capturing snapshot & clicking
        try:
            await self.scroll_to_element(element_id)
        except Exception:
            pass

        # 1. Capture Pre-action Perception Snapshot
        pre_snap = await ActionPerceptionVerification.capture_snapshot(self)

        # 2. Dispatch Two-Tier Click (CDP synthetic input events + Native Blink DOM synthetic sequence)
        await ActionPerceptionVerification.dispatch_two_tier_click(self, element_id, label=target_name, fast_mode=fast_mode and not is_transition)

        # 3. Action Completion Quiescence (awaits network idle, loading spinners cleared, route changes settled)
        await self.wait_for_action_quiescence(
            pre_url=pre_snap.url,
            is_transition=is_transition,
            min_grace_ms=80 if is_transition else (15 if fast_mode else 40),
            max_timeout_s=1.5 if is_transition else (0.25 if fast_mode else 0.6),
            fast_mode=fast_mode,
        )

        # 4. Refresh interactive tree
        try:
            await self.extract_interactive_tree()
        except Exception:
            pass

        # 5. Capture Post-action Perception Snapshot and Verify Outcome
        post_snap = await ActionPerceptionVerification.capture_snapshot(self)
        verification = ActionPerceptionVerification.verify_action_outcome(pre_snap, post_snap, action="click", target=target_name)
        self.last_action_verification = verification.to_dict()

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
            if self._event_listener:
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
            verification.effect_type = "external_link_verified"
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
            auto_select_suggestion: If set, after typing, automatically click the best-matching
                autocomplete suggestion whose text contains this value (case-insensitive).
                Used by System 1 engine to skip LLM round-trip for autocomplete selection.
        """
        if element_id:
            await self.scroll_to_element(element_id)
            coords = await self.evaluate(f"""
            (() => {{
                const el = (window.__spFast && window.__spFast.nodes.get({element_id})) || document.querySelector('[data-sp-id="{element_id}"]');
                if (!el) return null;
                try {{ el.focus(); }} catch(e) {{}}
                const r = el.getBoundingClientRect();
                return {{
                    x: Math.round(r.left + r.width / 2),
                    y: Math.round(r.top + r.height / 2),
                    text: (el.placeholder || el.name || el.id || '').trim()
                }};
            }})()
            """)
            if coords and coords.get("x") is not None:
                await self.click(coords["x"], coords["y"], label=f"Focusing {coords.get('text') or f'input #{element_id}'}", fast_mode=True)
            else:
                el = next((e for e in self.interactive_elements if e["id"] == element_id), None)
                if el:
                    await self.click(el["x"], el["y"], label=f"Focusing {el.get('text') or el.get('placeholder') or el.get('tag')}", fast_mode=True)

        # Universal clear_first via CDP keystroke stream
        if clear_first:
            try:
                await self.send_command("Input.dispatchKeyEvent", {"type": "rawKeyDown", "windowsVirtualKeyCode": 65, "modifiers": 2, "key": "a", "code": "KeyA"})
                await self.send_command("Input.dispatchKeyEvent", {"type": "keyUp", "windowsVirtualKeyCode": 65, "modifiers": 2, "key": "a", "code": "KeyA"})
                await asyncio.sleep(0.02)
                await self.send_command("Input.dispatchKeyEvent", {"type": "rawKeyDown", "windowsVirtualKeyCode": 8, "key": "Backspace", "code": "Backspace"})
                await self.send_command("Input.dispatchKeyEvent", {"type": "keyUp", "windowsVirtualKeyCode": 8, "key": "Backspace", "code": "Backspace"})
            except Exception:
                pass

        self._notify_listeners({
            "type": "cursor_action",
            "action": "type",
            "text": text,
            "label": f"Typing '{text[:25]}...'",
        })

        el_target_js = f"(window.__spFast && window.__spFast.nodes.get({element_id})) || document.querySelector('[data-sp-id=\"{element_id}\"]') || " if element_id else ""
        escaped_text = json.dumps(text)

        # 1. Framework-Universal Prototype Setter & Event Sequence (Angular Reactive Forms, React 18+, Vue 3)
        framework_type_js = f"""
        (() => {{
            const el = ({el_target_js}document.activeElement);
            if (!el) return false;
            try {{ el.focus(); }} catch(e) {{}}
            const val = {escaped_text};

            if (el.isContentEditable) {{
                return 'contenteditable';
            }}

            // Universal bypass for readonly inputs (e.g. calendar/date pickers)
            if (el.readOnly) {{
                try {{
                    el.readOnly = false;
                    el.removeAttribute('readonly');
                }} catch(e) {{}}
            }}

            // Prototype value setter for HTMLInputElement / HTMLTextAreaElement
            const proto = (el instanceof HTMLTextAreaElement) ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
            const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (nativeSetter) {{
                nativeSetter.call(el, val);
            }} else {{
                el.value = val;
            }}

            // React 18 controlled component tracker bypass
            const tracker = el._valueTracker;
            if (tracker) {{
                try {{ tracker.setValue(""); }} catch(e) {{}}
            }}

            // Full event lifecycle for Angular DefaultValueAccessor & HTML5 standards
            el.dispatchEvent(new InputEvent('input', {{ bubbles: true, cancelable: true, inputType: 'insertText', data: val }}));
            el.dispatchEvent(new Event('input', {{ bubbles: true, cancelable: true }}));
            el.dispatchEvent(new Event('change', {{ bubbles: true, cancelable: true }}));
            // NOTE: Do NOT dispatch 'blur' here as it prematurely closes autocomplete overlays like PrimeNG p-autoComplete
            return el.value === val;
        }})()
        """
        eval_res = None
        try:
            res = await self.send_command("Runtime.evaluate", {"expression": framework_type_js, "returnByValue": True})
            eval_res = res.get("result", {}).get("value")
        except Exception:
            pass

        # 2. CDP character-by-character keystroke dispatch (CRITICAL for Angular/PrimeNG reactive forms)
        # The prototype setter above sets the value instantly, but Angular's ControlValueAccessor
        # and PrimeNG's p-autoComplete listen for real keyboard events to trigger their debounced
        # HTTP search. We dispatch CDP keystrokes for the characters to trigger the framework's
        # input event listeners.
        if eval_res != 'contenteditable':
            trigger_chars = text[-4:] if len(text) > 4 else text
            try:
                for char in trigger_chars:
                    await self.send_command("Input.dispatchKeyEvent", {
                        "type": "keyDown", "text": char, "key": char,
                        "windowsVirtualKeyCode": ord(char.upper()) if char.isalpha() else 0
                    })
                    await asyncio.sleep(0.015)
                    await self.send_command("Input.dispatchKeyEvent", {
                        "type": "keyUp", "key": char,
                        "windowsVirtualKeyCode": ord(char.upper()) if char.isalpha() else 0
                    })
            except Exception:
                pass

        # 2b. If contenteditable or fallback required, insert text via CDP
        if eval_res == 'contenteditable' or not eval_res:
            try:
                await self.send_command("Input.insertText", {"text": text})
            except Exception:
                for char in text:
                    try:
                        await self.send_command("Input.dispatchKeyEvent", {"type": "char", "text": char})
                    except Exception:
                        pass

        # 3. Final seal & re-verification
        verify_js = f"""
        (() => {{
            const el = ({el_target_js}document.activeElement);
            if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {{
                if (el.value !== {escaped_text}) {{
                    const proto = (el instanceof HTMLTextAreaElement) ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
                    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                    if (nativeSetter) nativeSetter.call(el, {escaped_text});
                    else el.value = {escaped_text};
                }}
                el.dispatchEvent(new Event('input', {{ bubbles: true, cancelable: true }}));
                el.dispatchEvent(new Event('change', {{ bubbles: true, cancelable: true }}));
            }}
        }})()
        """
        try:
            await self.send_command("Runtime.evaluate", {"expression": verify_js, "returnByValue": True})
        except Exception:
            pass

        # 4. Autocomplete harvest with progressive retry loop
        # Angular/PrimeNG autocompletes have debounce timers (typically 200-500ms) before
        # firing HTTP requests for suggestions. We retry harvesting with increasing delays.
        harvest_js = """
        (() => {
            const selectors = [
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
                const items = Array.from(document.querySelectorAll(sel)).filter(el => {
                    const s = window.getComputedStyle(el);
                    return s.display !== 'none' && s.visibility !== 'hidden' && (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0);
                });
                if (items.length > 0) {
                    return items.slice(0, 15).map((el, idx) => {
                        let spId = el.getAttribute('data-sp-id');
                        if (!spId && window.__spGetOrAssignId) {
                            spId = String(window.__spGetOrAssignId(el));
                        } else if (!spId && window.__spFast) {
                            spId = String(window.__spFast.nextId++);
                            window.__spFast.nodes.set(Number(spId), el);
                            try { el.setAttribute('data-sp-id', spId); } catch(e) {}
                        }
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
        """

        self.last_autocomplete_suggestions = []
        harvest_delays = [0.2, 0.35, 0.6, 0.8]  # Progressive retry delays for async suggestions

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

        # 5. Auto-select matching suggestion if requested (System 1 fast path)
        if auto_select_suggestion and self.last_autocomplete_suggestions:
            query_lower = auto_select_suggestion.strip().lower()
            best_match = None
            best_score = -1

            for sugg in self.last_autocomplete_suggestions:
                sugg_text = (sugg.get("text") or "").strip().lower()
                if not sugg_text:
                    continue
                # Exact substring match gets highest priority
                if query_lower in sugg_text:
                    score = 100 + (1.0 / max(len(sugg_text), 1))  # Prefer shorter matches
                    if score > best_score:
                        best_score = score
                        best_match = sugg
                else:
                    # Word overlap scoring
                    q_words = set(query_lower.split())
                    s_words = set(sugg_text.split())
                    overlap = len(q_words & s_words)
                    if overlap > best_score:
                        best_score = overlap
                        best_match = sugg

            if not best_match and self.last_autocomplete_suggestions:
                best_match = self.last_autocomplete_suggestions[0]

            if best_match:
                match_text = best_match.get("text", "")
                logger.info(f"Auto-selecting suggestion: '{match_text}' for query '{auto_select_suggestion}'")

                # Click the suggestion element using its coordinates or element_id
                sugg_x = best_match.get("x")
                sugg_y = best_match.get("y")
                sugg_id = best_match.get("id")

                if sugg_x and sugg_y:
                    await self.click(sugg_x, sugg_y, label=f"Selecting '{match_text[:40]}'", fast_mode=True, exact_coords=True)
                
                # Also dispatch direct DOM event sequence to guarantee Angular/PrimeNG (onClick)/(select) binding
                if sugg_id:
                    click_js = f"""
                    (() => {{
                        const el = (window.__spFast && window.__spFast.nodes.get({sugg_id})) || document.querySelector('[data-sp-id="{sugg_id}"]');
                        if (el) {{
                            el.dispatchEvent(new MouseEvent('mousedown', {{bubbles: true, cancelable: true, view: window}}));
                            el.dispatchEvent(new MouseEvent('mouseup', {{bubbles: true, cancelable: true, view: window}}));
                            el.click();
                            return true;
                        }}
                        return false;
                    }})()
                    """
                    try:
                        await self.send_command("Runtime.evaluate", {"expression": click_js, "returnByValue": True})
                    except Exception:
                        pass

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

                await asyncio.sleep(0.25)

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
        """Navigates back to previous page in exploration hierarchy using PNA 4-tier escalation backtracking."""
        self._notify_listeners({"type": "action", "action": "navigate_back"})
        if hasattr(self, "pda") and self.pda and self.pda.can_backtrack():
            backtrack_res = await self.pda.backtrack_to_parent(self, fallback_parent_url=fallback_url)
            await self.force_fresh_frame()
            tree = await self.extract_interactive_tree()
            return {**tree, "backtrack_result": backtrack_res}

        pre_url = (self.current_url or "").rstrip("/")
        try:
            await self.send_command("Runtime.evaluate", {"expression": "window.history.back()"})
            await self.wait_for_quiescence(network_idle_ms=300, dom_quiet_ms=150, max_timeout_s=4.0)
            await self.extract_interactive_tree()
            curr_url = (self.current_url or "").rstrip("/")
            if fallback_url and (curr_url == pre_url or not self.interactive_elements):
                await self.navigate(fallback_url)
            return await self.extract_interactive_tree()
        except Exception as e:
            if fallback_url:
                await self.navigate(fallback_url)
                return await self.extract_interactive_tree()
            return {"error": str(e)}

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

    async def cancel_actions(self):
        """Immediately aborts any ongoing user interaction / animations in Chromium."""
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
        if self.cdp_ws:
            await self.cdp_ws.close()
        if self.target_id:
            try:
                headers = {"Host": "localhost"}
                async with httpx.AsyncClient(timeout=2.0, headers=headers) as client:
                    await client.put(f"{CHROME_HOST}/json/close/{self.target_id}")
            except Exception:
                pass


class BrowserManager:
    """Singleton manager tracking active live browser sessions."""

    def __init__(self):
        self.sessions: Dict[str, BrowserSession] = {}

    def get_active_session(self) -> Optional[BrowserSession]:
        for s in self.sessions.values():
            if s.is_connected:
                return s
        return None

    async def get_or_create_session(self, session_id: str = "default", url: str = "about:blank") -> BrowserSession:
        norm_url = url.rstrip("/").strip() if url else ""
        container_url = to_container_accessible_url(url) if url else ""
        if session_id in self.sessions and self.sessions[session_id].is_connected:
            session = self.sessions[session_id]
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

        # Reuse existing connected session to avoid creating redundant tabs
        active = self.get_active_session()
        if active:
            self.sessions[session_id] = active
            if norm_url and norm_url not in {"about:blank", "http://localhost:3000", "http://127.0.0.1:3000"}:
                active.target_url = container_url or url
                if hasattr(active, "skg") and active.skg:
                    active.skg.origin_url = active.target_url
            curr = (active.current_url or "").rstrip("/").strip()
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
                await active.navigate(url)
            return active

        session = BrowserSession(session_id=session_id, target_url=url)
        await session.connect()
        self.sessions[session_id] = session
        if norm_url and norm_url not in {"about:blank", "http://localhost:3000", "http://127.0.0.1:3000"}:
            await session.navigate(url)
        return session

    async def stop_session(self, session_id: str):
        """Immediately stops running actions on the session."""
        session = self.sessions.get(session_id) or self.get_active_session()
        if session:
            await session.cancel_actions()

    async def close_session(self, session_id: str):
        if session_id in self.sessions:
            await self.sessions[session_id].close()
            del self.sessions[session_id]


# Global instance
browser_manager = BrowserManager()
