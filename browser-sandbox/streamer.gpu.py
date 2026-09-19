import asyncio
import os
import signal
import struct
import subprocess
import sys
import time

PORT = int(os.getenv("STREAM_PORT", "8099"))
DISPLAY = os.getenv("DISPLAY", ":99")
FPS = int(os.getenv("STREAM_FPS", "60"))
WIDTH = int(os.getenv("STREAM_WIDTH", "1920"))
HEIGHT = int(os.getenv("STREAM_HEIGHT", "1080"))
BITRATE = os.getenv("STREAM_BITRATE", "4000k")
# Auto-detect: prefer NVENC, fallback to libx264
USE_NVENC = os.getenv("USE_NVENC", "auto")

active_clients = set()
cached_sps = None
cached_pps = None
cached_keyframe_bundle = None
running = True

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

async def broadcast_packet(packet_bytes: bytes):
    dead = []
    for client in list(active_clients):
        try:
            client.write(packet_bytes)
        except Exception:
            dead.append(client)
    for d in dead:
        active_clients.discard(d)

async def handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
    global cached_keyframe_bundle
    addr = writer.get_extra_info("peername")
    print(f"[Streamer-GPU] Client connected from {addr}", flush=True)

    if cached_keyframe_bundle:
        try:
            pkt = struct.pack(">IB", len(cached_keyframe_bundle), 1) + cached_keyframe_bundle
            writer.write(pkt)
            await writer.drain()
        except Exception as e:
            print(f"[Streamer-GPU] Error sending initial keyframe: {e}", flush=True)
            writer.close()
            return

    active_clients.add(writer)
    try:
        while running:
            data = await reader.read(1024)
            if not data:
                break
    except Exception:
        pass
    finally:
        active_clients.discard(writer)
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass
        print(f"[Streamer-GPU] Client {addr} disconnected", flush=True)


def detect_nvenc() -> bool:
    """Check if NVENC hardware encoding is available."""
    if USE_NVENC == "false":
        return False
    if USE_NVENC == "true":
        return True
    # Auto-detect
    try:
        result = subprocess.run(
            ["ffmpeg", "-hide_banner", "-encoders"],
            capture_output=True, text=True, timeout=5
        )
        if "h264_nvenc" in result.stdout:
            # Verify NVENC actually works
            test = subprocess.run(
                ["ffmpeg", "-hide_banner", "-loglevel", "error",
                 "-f", "lavfi", "-i", "testsrc=duration=0.1:size=64x64:rate=1",
                 "-c:v", "h264_nvenc", "-f", "null", "-"],
                capture_output=True, timeout=10
            )
            if test.returncode == 0:
                print("[Streamer-GPU] ✅ NVENC hardware encoder detected and working", flush=True)
                return True
            else:
                print(f"[Streamer-GPU] ⚠️ NVENC listed but test failed: {test.stderr.decode()}", flush=True)
    except Exception as e:
        print(f"[Streamer-GPU] NVENC detection error: {e}", flush=True)
    return False


async def ffmpeg_capture_loop():
    global cached_sps, cached_pps, cached_keyframe_bundle, running

    display_num = DISPLAY.lstrip(":")
    x11_socket = f"/tmp/.X11-unix/X{display_num}"
    print(f"[Streamer-GPU] Waiting for Xvfb socket {x11_socket}...", flush=True)
    for _ in range(60):
        if os.path.exists(x11_socket):
            break
        await asyncio.sleep(0.5)

    await asyncio.sleep(1.0)
    print(f"[Streamer-GPU] Display {DISPLAY} confirmed ready. Detecting encoder...", flush=True)

    has_nvenc = detect_nvenc()

    if has_nvenc:
        print(f"[Streamer-GPU] 🚀 Using NVENC hardware encoding @ {FPS}fps {WIDTH}x{HEIGHT}", flush=True)
        cmd = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel", "error",
            "-f", "x11grab",
            "-draw_mouse", "0",
            "-framerate", str(FPS),
            "-video_size", f"{WIDTH}x{HEIGHT}",
            "-i", f"{DISPLAY}.0",
            "-fps_mode", "cfr",
            "-c:v", "h264_nvenc",
            "-preset", "p1",         # Fastest NVENC preset
            "-tune", "ull",          # Ultra-low latency
            "-zerolatency", "1",
            "-rc", "cbr",            # Constant bitrate for consistent streaming
            "-b:v", BITRATE,
            "-maxrate", "6000k",
            "-bufsize", "2000k",     # Small buffer = low latency
            "-profile:v", "baseline",
            "-level:v", "4.0",
            "-g", str(FPS // 2),     # Keyframe every 0.5s
            "-keyint_min", str(FPS // 2),
            "-f", "h264",
            "pipe:1"
        ]
    else:
        print(f"[Streamer-GPU] Using libx264 software encoding @ {FPS}fps {WIDTH}x{HEIGHT}", flush=True)
        cmd = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel", "error",
            "-f", "x11grab",
            "-draw_mouse", "0",
            "-framerate", str(FPS),
            "-video_size", f"{WIDTH}x{HEIGHT}",
            "-i", f"{DISPLAY}.0",
            "-fps_mode", "cfr",
            "-c:v", "libx264",
            "-preset", "ultrafast",
            "-tune", "zerolatency",
            "-x264-params", "sliced-threads=0:sync-lookahead=0:rc-lookahead=0:no-mbtree=1",
            "-threads", "4",
            "-profile:v", "baseline",
            "-level:v", "3.1",
            "-pix_fmt", "yuv420p",
            "-g", str(FPS // 2),
            "-keyint_min", str(FPS // 2),
            "-sc_threshold", "0",
            "-crf", "28",
            "-maxrate", "5000k",
            "-bufsize", "5000k",
            "-f", "h264",
            "pipe:1"
        ]

    while running:
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            encoder_name = "NVENC" if has_nvenc else "libx264"
            print(f"[Streamer-GPU] FFmpeg {encoder_name} pipeline started", flush=True)

            buffer = bytearray()
            while running and proc.returncode is None:
                chunk = await proc.stdout.read(32768)
                if not chunk:
                    break
                buffer.extend(chunk)

                units, buffer = find_annexb_units(buffer)
                for nal_type, nalu in units:
                    if nal_type == 7:
                        cached_sps = nalu
                    elif nal_type == 8:
                        cached_pps = nalu
                    elif nal_type == 5:
                        bundle = bytearray()
                        if cached_sps:
                            bundle.extend(cached_sps)
                        if cached_pps:
                            bundle.extend(cached_pps)
                        bundle.extend(nalu)
                        cached_keyframe_bundle = bytes(bundle)

                        pkt = struct.pack(">IB", len(cached_keyframe_bundle), 1) + cached_keyframe_bundle
                        await broadcast_packet(pkt)
                    elif nal_type == 1:
                        pkt = struct.pack(">IB", len(nalu), 0) + nalu
                        await broadcast_packet(pkt)

            stderr = await proc.stderr.read()
            if stderr:
                print(f"[Streamer-GPU] FFmpeg stderr: {stderr.decode('utf-8', errors='ignore')}", flush=True)

            await proc.wait()
            print(f"[Streamer-GPU] FFmpeg exited with code {proc.returncode}. Restarting in 1s...", flush=True)
            await asyncio.sleep(1.0)
        except Exception as e:
            print(f"[Streamer-GPU] FFmpeg loop error: {e}", flush=True)
            await asyncio.sleep(1.0)

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
    print("[Streamer-GPU] CDP Proxy listening on 0.0.0.0:9222 -> 127.0.0.1:9223", flush=True)
    async with proxy_server:
        await proxy_server.serve_forever()

async def main():
    server = await asyncio.start_server(handle_client, "0.0.0.0", PORT)
    addrs = ", ".join(str(sock.getsockname()) for sock in server.sockets)
    print(f"[Streamer-GPU] TCP Video Server listening on {addrs}", flush=True)

    capture_task = asyncio.create_task(ffmpeg_capture_loop())
    proxy_task = asyncio.create_task(cdp_proxy_loop())
    async with server:
        await server.serve_forever()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("[Streamer-GPU] Shutting down", flush=True)
