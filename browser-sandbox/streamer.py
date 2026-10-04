import asyncio
import json
import math
import os
import signal
import socket
import struct
import subprocess
import sys
import time

PORT = int(os.getenv("STREAM_PORT", "8099"))
DISPLAY = os.getenv("DISPLAY", ":99")
FPS = max(15, min(60, int(os.getenv("STREAM_FPS", "30"))))
MAX_FPS = max(FPS, min(60, int(os.getenv("STREAM_MAX_FPS", "60"))))
IDLE_FPS = max(2, min(FPS, int(os.getenv("STREAM_IDLE_FPS", "8"))))
WIDTH = int(os.getenv("STREAM_WIDTH", "1280"))
HEIGHT = int(os.getenv("STREAM_HEIGHT", "720"))
BITRATE = os.getenv("STREAM_BITRATE", "2000k")
MAX_CLIENT_BUFFER = max(65536, int(os.getenv("STREAM_MAX_CLIENT_BUFFER_BYTES", "262144")))

active_clients = set()
waiting_for_keyframe = set()
timestamp_clients = set()
cached_sps = None
cached_pps = None
cached_keyframe_bundle = None
running = True


class CapturePolicy:
    def __init__(self):
        self.activity_at = time.monotonic()
        self.feedback = {}
        self.speed = 1.0
        self.capture_rate = FPS
        self.encoder_started = time.monotonic()
        self.low_fps_since = None
        self.boost_blocked_until = 0
        self.last_frame_report = None

    def begin_encoder(self, rate, now=None):
        self.capture_rate = rate
        self.encoder_started = time.monotonic() if now is None else now
        self.speed = 1.0
        self.low_fps_since = None
        self.last_frame_report = None

    def record_encoder_frame_count(self, frames, now=None):
        """FFmpeg's fps field is cumulative; qualify the latest report interval."""
        now = time.monotonic() if now is None else now
        previous = self.last_frame_report
        if previous is None or frames < previous[1]:
            self.last_frame_report = (now, frames)
            return
        elapsed = now - previous[0]
        if elapsed < .25:
            return
        self.last_frame_report = (now, frames)
        self.record_encoder_fps((frames - previous[1]) / elapsed, now)

    def record_encoder_fps(self, value, now=None):
        now = time.monotonic() if now is None else now
        if not math.isfinite(value) or value < 0 or now - self.encoder_started < 3:
            return
        if value < self.capture_rate * .85:
            if self.low_fps_since is None:
                self.low_fps_since = now
        else:
            self.low_fps_since = None

    def update(self, client, message, now=None):
        now = time.monotonic() if now is None else now
        if message.get("type") == "activity":
            self.activity_at = now
        elif message.get("type") == "feedback":
            def number(key, default=0):
                value = message.get(key, default)
                return max(0, min(10000, float(value))) if type(value) in {int, float} and math.isfinite(value) else default
            self.feedback[client] = {"at": now, "visible": message.get("visible") is not False,
                                     "gap": number("gap_ms"), "queue": number("decode_queue"),
                                     "rtt": number("rtt_ms"),
                                     "interval": number("presentation_interval_ms"),
                                     "presented": number("frames_presented"),
                                     "jitter_buffer": number("jitter_buffer_ms"),
                                     "measured": message.get("all_viewers_measured") is not False}

    def rate(self, now=None):
        now = time.monotonic() if now is None else now
        feedback = [value for client, value in self.feedback.items()
                    if client in active_clients and now - value["at"] < 6]
        visible = [value for value in feedback if value["visible"]]
        if feedback and not visible:
            return IDLE_FPS
        # A page can animate even while the operator has not moved the mouse.
        # Fresh visible presentation feedback must not be classified as idle.
        if not visible and now - self.activity_at > 6:
            return IDLE_FPS
        # vfr can keep speed=1x while dropping pictures; actual encoder FPS
        # therefore has to qualify throughput independently of timestamp speed.
        if self.speed < .85 or (self.low_fps_since is not None and now - self.low_fps_since >= 2):
            self.boost_blocked_until = now + 30
            return FPS if self.capture_rate > FPS else 15
        if any(value["queue"] >= 4 or value["gap"] > 150 or
               value["rtt"] > 250 or value["jitter_buffer"] > 200 for value in visible):
            return 15
        # gap_ms is excess presentation gap (p90 minus median), not cadence.
        # Missing/zero samples cannot prove the decoder can sustain 60 FPS.
        if (now >= self.boost_blocked_until and now - self.activity_at <= 6 and visible and self.speed >= .98 and
            all(value["measured"] and value["presented"] >= 2 and 0 < value["interval"] < 45 and
                value["gap"] < 45 and value["queue"] < 2 and 0 < value["rtt"] < 80 and
                value["jitter_buffer"] < 80 for value in visible)):
            return MAX_FPS
        return FPS


class CaptureRateTransition:
    """Require stable feedback before interrupting an encoder for a new rate."""
    def __init__(self, rate, now=None):
        now = time.monotonic() if now is None else now
        self.rate = self.candidate = rate
        self.changed_at = self.candidate_at = now

    def should_restart(self, desired, now=None):
        now = time.monotonic() if now is None else now
        if desired != self.candidate:
            self.candidate, self.candidate_at = desired, now
        return (desired != self.rate and now - self.changed_at >= 6 and
                now - self.candidate_at >= 1.5)


policy = CapturePolicy()


def select_encoder():
    if os.getenv("STREAM_ENCODER", "auto") == "software":
        return "libx264"
    try:
        result = subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=s=128x128",
                                 "-frames:v", "1", "-c:v", "h264_nvenc", "-f", "null", "-"],
                                capture_output=True, timeout=5)
        if result.returncode == 0:
            return "h264_nvenc"
    except (OSError, subprocess.TimeoutExpired):
        pass
    return "libx264"


def encoder_command(encoder, rate):
    codec_args = (["-preset", "p1", "-tune", "ull", "-zerolatency", "1", "-bf", "0",
                   "-cq", "28", "-b:v", BITRATE] if encoder == "h264_nvenc" else
                  ["-preset", "ultrafast", "-tune", "zerolatency", "-x264-params",
                   # Parallelize within one picture. Frame threading overrides
                   # zerolatency and buffers a future picture before output.
                   "sliced-threads=1:sync-lookahead=0:rc-lookahead=0:no-mbtree=1:repeat-headers=1",
                   "-slices", "2", "-threads", "2", "-crf", "28"])
    return ["ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error",
            "-filter_threads", "1", "-filter_complex_threads", "1",
            "-progress", "pipe:2", "-stats_period", "1",
            "-probesize", "32", "-analyzeduration", "0",
            "-f", "x11grab", "-draw_mouse", "0", "-framerate", str(rate),
            "-video_size", f"{WIDTH}x{HEIGHT}", "-i", f"{DISPLAY}.0",
            # Avoid duplicating historical frames to catch up after a CPU stall.
            "-fps_mode", "vfr", "-c:v", encoder, *codec_args,
            "-profile:v", "baseline", "-level:v", "4.1", "-pix_fmt", "yuv420p",
            "-g", str(max(4, rate // 2)), "-keyint_min", str(max(2, rate // 4)),
            "-sc_threshold", "0", "-maxrate", BITRATE,
            # Static pages produce tiny deltas. Do not hold them in the muxer's
            # 32 KiB output buffer while the viewer waits for a first frame.
            "-bufsize", os.getenv("STREAM_BUF_SIZE", BITRATE), "-flush_packets", "1",
            "-bsf:v", "h264_metadata=aud=insert", "-f", "h264", "pipe:1"]


def find_annexb_units(buffer: bytearray):
    units = []
    pos = 0
    start_positions = []
    buf_len = len(buffer)
    while pos < buf_len - 3:
        idx4 = buffer.find(b"\x00\x00\x00\x01", pos)
        idx3 = buffer.find(b"\x00\x00\x01", pos)
        if idx4 == -1 and idx3 == -1:
            break
        if idx4 != -1 and (idx3 == -1 or idx4 <= idx3):
            start_positions.append(idx4)
            pos = idx4 + 4
        else:
            start_positions.append(idx3)
            pos = idx3 + 3

    if len(start_positions) < 2:
        return units, buffer

    for i in range(len(start_positions) - 1):
        s1 = start_positions[i]
        s2 = start_positions[i + 1]
        nalu = bytes(buffer[s1:s2])
        if nalu.startswith(b"\x00\x00\x01"):
            nalu = b"\x00" + nalu
        sc_len = 4
        if len(nalu) > sc_len:
            nal_header = nalu[sc_len]
            nal_type = nal_header & 0x1F
            units.append((nal_type, nalu))

    last_start = start_positions[-1]
    remainder = buffer[last_start:]
    return units, remainder


class H264AccessUnits:
    """Keep all slices of one picture together for WebCodecs and RTP markers."""
    def __init__(self):
        self.sps = self.pps = None
        self.units = []
        self.has_picture = self.keyframe = False
        self.size = 0

    def push(self, nal_type, nalu):
        completed = None
        if nal_type == 9:  # AUD inserted by FFmpeg for every encoded picture.
            if self.has_picture:
                payload = b"".join(self.units)
                if self.keyframe:
                    types = {unit[4] & 0x1f for unit in self.units}
                    payload = (self.sps if self.sps and 7 not in types else b"") + (
                        self.pps if self.pps and 8 not in types else b"") + payload
                completed = (self.keyframe, payload)
            self.units, self.has_picture, self.keyframe, self.size = [], False, False, 0
        if nal_type == 7:
            self.sps = nalu
        elif nal_type == 8:
            self.pps = nalu
        elif nal_type in {1, 5}:
            self.has_picture = True
            self.keyframe |= nal_type == 5
        self.units.append(nalu)
        self.size += len(nalu)
        if self.size > 16 * 1024 * 1024:
            raise ValueError("Encoded picture exceeds the live-video packet limit")
        return completed


async def broadcast_packet(packet_bytes: bytes, source_timestamp_us=None):
    dead = []
    for client in list(active_clients):
        try:
            if client in waiting_for_keyframe:
                if len(packet_bytes) < 5 or packet_bytes[4] != 1:
                    continue
                waiting_for_keyframe.discard(client)
            packet = packet_bytes
            if client in timestamp_clients and source_timestamp_us is not None:
                # Opt-in extension: legacy clients retain the original wire
                # format. Timestamp before transport so SSH jitter cannot
                # collapse distinct frames into one presentation instant.
                packet = packet_bytes[:4] + bytes([packet_bytes[4] | 0x80]) + struct.pack('>Q',source_timestamp_us) + packet_bytes[5:]
            if client.is_closing() or client.transport.get_write_buffer_size() + len(packet) > MAX_CLIENT_BUFFER:
                # Disconnect instead of dropping H.264 dependencies and then
                # serving undecodable deltas. Reconnection starts at a keyframe.
                client.close()
                dead.append(client)
                continue
            client.write(packet)
        except Exception:
            client.close()
            dead.append(client)
    for d in dead:
        active_clients.discard(d)
        waiting_for_keyframe.discard(d)
        timestamp_clients.discard(d)

async def handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
    global cached_keyframe_bundle
    addr = writer.get_extra_info("peername")
    print(f"[Streamer] Client connected from {addr}", flush=True)

    sock = writer.get_extra_info("socket")
    if sock:
        try:
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 256 * 1024)
        except Exception:
            pass

    # A cached I-frame followed by a P-frame from later in its GOP is
    # missing intervening dependencies. Join only at a fresh live I-frame.
    waiting_for_keyframe.add(writer)
    active_clients.add(writer)
    policy.update(writer, {"type": "activity"})
    try:
        while running:
            data = await reader.readline()
            if not data:
                break
            if len(data) > 2048:
                break
            try:
                message = json.loads(data)
                if isinstance(message, dict):
                    if message.get('type') == 'protocol' and message.get('source_timestamps') is True:
                        timestamp_clients.add(writer)
                    policy.update(writer, message)
            except (ValueError, TypeError):
                continue
    except Exception:
        pass
    finally:
        active_clients.discard(writer)
        waiting_for_keyframe.discard(writer)
        timestamp_clients.discard(writer)
        policy.feedback.pop(writer, None)
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass
        print(f"[Streamer] Client {addr} disconnected", flush=True)

async def terminate_encoder(proc):
    if proc.returncode is None:
        try:
            proc.terminate()
        except ProcessLookupError:
            pass
        try:
            await asyncio.wait_for(proc.wait(), timeout=2)
        except asyncio.TimeoutError:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            await proc.wait()
    else:
        await proc.wait()


async def drain_encoder_errors(stream):
    # Drain concurrently: a full stderr pipe must never stall video stdout.
    tail = bytearray()
    pending_line = ""
    while True:
        chunk = await stream.read(4096)
        if not chunk:
            return bytes(tail)
        tail.extend(chunk)
        del tail[:-8192]
        pending_line += chunk.decode(errors="ignore")
        lines = pending_line.split("\n")
        pending_line = lines.pop()[-8192:]
        for line in lines:
            if line.startswith("speed="):
                try:
                    measured = float(line.split("=", 1)[1].rstrip("x"))
                    # The first report has no output timestamp yet. Treating
                    # that zero as overload restarts an encoder before it warms.
                    if measured > 0:
                        policy.speed = measured
                except ValueError:
                    pass
            elif line.startswith("frame="):
                try:
                    policy.record_encoder_frame_count(int(line.split("=", 1)[1]))
                except ValueError:
                    pass


async def ffmpeg_capture_loop():
    global cached_sps, cached_pps, cached_keyframe_bundle, running

    display_num = DISPLAY.lstrip(":")
    x11_socket = f"/tmp/.X11-unix/X{display_num}"
    print(f"[Streamer] Waiting for Xvfb socket {x11_socket}...", flush=True)
    for _ in range(60):
        if os.path.exists(x11_socket):
            break
        await asyncio.sleep(0.5)

    await asyncio.sleep(1.0)
    print(f"[Streamer] Display {DISPLAY} confirmed ready. Launching FFmpeg...", flush=True)

    encoder = await asyncio.to_thread(select_encoder)
    print(f"[Streamer] Qualified encoder: {encoder}", flush=True)

    while running:
        # The desktop producer is demand-driven. Keeping a 60 FPS x11grab and
        # H.264 encoder alive with zero viewers wastes CPU and competes with
        # Chromium's compositor, which is exactly the condition that makes a
        # live stream appear frozen under load.
        while running and not active_clients:
            await asyncio.sleep(0.20)
        if not running:
            break
        proc = None
        errors_task = None
        rate_task = None
        restart_requested = False
        emitted_frames = 0
        try:
            cached_sps = cached_pps = cached_keyframe_bundle = None
            waiting_for_keyframe.update(active_clients)
            rate = policy.rate()
            transition = CaptureRateTransition(rate)
            policy.begin_encoder(rate)
            cmd = encoder_command(encoder, rate)
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            errors_task = asyncio.create_task(drain_encoder_errors(proc.stderr))
            async def adjust_rate():
                nonlocal restart_requested
                started = time.monotonic()
                while proc.returncode is None:
                    await asyncio.sleep(.25)
                    if (not active_clients or
                        (emitted_frames and transition.should_restart(policy.rate())) or
                        (not emitted_frames and time.monotonic() - started >= 10)):
                        restart_requested = True
                        try:
                            proc.terminate()
                        except ProcessLookupError:
                            pass
                        return
            rate_task = asyncio.create_task(adjust_rate())
            print(f"[Streamer] FFmpeg pipeline started: {rate} FPS", flush=True)

            buffer = bytearray()
            access_units = H264AccessUnits()
            while running and proc.returncode is None:
                chunk = await proc.stdout.read(32768)
                if not chunk:
                    break
                if not active_clients:
                    restart_requested = True
                    break
                buffer.extend(chunk)

                units, buffer = find_annexb_units(buffer)
                for nal_type, nalu in units:
                    picture = access_units.push(nal_type, nalu)
                    cached_sps, cached_pps = access_units.sps, access_units.pps
                    if picture:
                        keyframe, payload = picture
                        if keyframe:
                            cached_keyframe_bundle = payload
                        await broadcast_packet(struct.pack(">IB", len(payload), int(keyframe)) + payload,
                                               source_timestamp_us=time.monotonic_ns() // 1000)
                        emitted_frames += 1

            await terminate_encoder(proc)
            stderr = await errors_task
            if stderr:
                print(f"[Streamer] FFmpeg stderr: {stderr.decode('utf-8', errors='ignore')}", flush=True)

            print(f"[Streamer] Encoder exited: {proc.returncode}", flush=True)
            if proc.returncode and not restart_requested and encoder == "h264_nvenc":
                # A small qualification frame can pass before an encoder fails
                # at full resolution. Recover instead of repeatedly failing NVENC.
                encoder = "libx264"
                print("[Streamer] Hardware encoder failed; falling back to software", flush=True)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            print(f"[Streamer] FFmpeg loop error: {e}", flush=True)
        finally:
            if proc:
                await terminate_encoder(proc)
            if errors_task:
                if not errors_task.done():
                    errors_task.cancel()
                await asyncio.gather(errors_task, return_exceptions=True)
            if rate_task:
                rate_task.cancel()
                await asyncio.gather(rate_task, return_exceptions=True)
        if running:
            await asyncio.sleep(0.1)

async def cdp_proxy_handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
    try:
        remote_reader, remote_writer = await asyncio.open_connection("127.0.0.1", 9223)
    except Exception:
        writer.close()
        return

    async def fwd_client_to_chrome():
        try:
            import re
            is_handshake = True
            while running:
                data = await reader.read(65536)
                if not data:
                    break
                if is_handshake:
                    if b"Host:" in data or b"host:" in data:
                        data = re.sub(rb"(?i)\r?\nhost:[^\r\n]+", b"\r\nHost: 127.0.0.1:9223", data)
                    if b"\r\n\r\n" in data:
                        is_handshake = False
                remote_writer.write(data)
                await remote_writer.drain()
        except Exception:
            pass
        finally:
            try:
                remote_writer.close()
                await remote_writer.wait_closed()
            except Exception:
                pass

    async def fwd_chrome_to_client():
        try:
            is_handshake = True
            while running:
                data = await remote_reader.read(65536)
                if not data:
                    break
                if is_handshake:
                    if b":9223" in data:
                        data = data.replace(b":9223", b":9222")
                    if b"\r\n\r\n" in data:
                        is_handshake = False
                writer.write(data)
                await writer.drain()
        except Exception:
            pass
        finally:
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass

    await asyncio.gather(fwd_client_to_chrome(), fwd_chrome_to_client())

async def cdp_proxy_loop():
    proxy_server = await asyncio.start_server(cdp_proxy_handler, "0.0.0.0", 9222)
    print("[Streamer] CDP Proxy listening on 0.0.0.0:9222 -> 127.0.0.1:9223", flush=True)
    async with proxy_server:
        await proxy_server.serve_forever()

async def main():
    global running
    stopped = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stopped.set)
    server = await asyncio.start_server(handle_client, "0.0.0.0", PORT)
    addrs = ", ".join(str(sock.getsockname()) for sock in server.sockets)
    print(f"[Streamer] TCP Video Server listening on {addrs}", flush=True)

    capture_task = asyncio.create_task(ffmpeg_capture_loop())
    proxy_task = asyncio.create_task(cdp_proxy_loop())
    stop_task = asyncio.create_task(stopped.wait())
    try:
        async with server:
            done, _ = await asyncio.wait({capture_task, proxy_task, stop_task}, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                if task is not stop_task:
                    task.result()
    finally:
        running = False
        for task in (capture_task, proxy_task, stop_task):
            task.cancel()
        await asyncio.gather(capture_task, proxy_task, stop_task, return_exceptions=True)
        for client in list(active_clients):
            client.close()
        active_clients.clear()
        waiting_for_keyframe.clear()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("[Streamer] Shutting down", flush=True)
