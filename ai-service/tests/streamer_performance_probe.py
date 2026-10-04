"""Qualify a copied producer on an owned X display, without touching user tabs.

Run inside the browser image. This measures delivered access units and offline
decodability of a synthetic animated screen; it does not measure UI presentation.
"""
import argparse
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import statistics
import struct
import subprocess
import tempfile
import time


async def probe(path, display):
    os.environ.update(DISPLAY=display, STREAM_FPS="30", STREAM_MAX_FPS="60", STREAM_IDLE_FPS="8",
                      STREAM_ENCODER="software")
    spec = importlib.util.spec_from_file_location("probe_streamer", path)
    streamer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(streamer)
    xvfb = subprocess.Popen(["Xvfb", display, "-screen", "0", "1280x720x24", "-nocursor", "-nolisten", "tcp"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    animation = None
    capture = server = writer = None
    tasks, arrivals, keys, phases = [], [], [], []
    try:
        for _ in range(40):
            if xvfb.poll() is not None:
                raise RuntimeError("Owned Xvfb failed to start (the display must be unused)")
            if Path("/tmp/.X11-unix/X" + display.lstrip(":" )).exists():
                break
            await asyncio.sleep(.1)
        animation = subprocess.Popen(["ffplay", "-loglevel", "error", "-f", "lavfi", "-i",
            "testsrc2=size=1280x720:rate=60", "-an", "-noborder", "-window_title", "StackPilot isolated streaming fixture",
            "-left", "0", "-top", "0"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        server = await asyncio.start_server(streamer.handle_client, "127.0.0.1", 0)
        capture = asyncio.create_task(streamer.ffmpeg_capture_loop())
        reader, writer = await asyncio.open_connection("127.0.0.1", server.sockets[0].getsockname()[1])
        with tempfile.TemporaryDirectory(prefix="stackpilot-encoder-qa-") as directory:
            video_path = Path(directory) / "synthetic.h264"
            with video_path.open("wb") as encoded:
                async def consume():
                    while True:
                        size, key = struct.unpack(">IB", await reader.readexactly(5))
                        if not 0 < size <= 16 * 1024 * 1024 or key not in {0, 1}:
                            raise RuntimeError("Invalid live video packet")
                        encoded.write(await reader.readexactly(size))
                        arrivals.append(time.monotonic())
                        if key:
                            keys.append(arrivals[-1])
                tasks.append(asyncio.create_task(consume()))
                for name, duration, visible, active in [("visible_without_input", 14, True, False),
                    ("active_healthy", 12, True, True), ("hidden", 10, False, False)]:
                    started = time.monotonic()
                    while time.monotonic() - started < duration:
                        now = time.monotonic()
                        recent = [at for at in arrivals if at >= now - 1]
                        intervals = [(b - a) * 1000 for a, b in zip(recent, recent[1:])]
                        interval = statistics.median(intervals) if intervals else 0
                        feedback = {"type": "feedback", "visible": visible, "gap_ms": 0,
                            "presentation_interval_ms": interval, "frames_presented": len(recent),
                            "rtt_ms": 20, "decode_queue": 0}
                        writer.write((json.dumps(feedback) + "\n").encode())
                        if active:
                            writer.write(b'{"type":"activity"}\n')
                        await writer.drain()
                        if tasks[0].done():
                            tasks[0].result()
                        await asyncio.sleep(.5)
                    ended = time.monotonic()
                    sample = [at for at in arrivals if started + duration - 4 <= at <= ended]
                    gaps = sorted((b - a) * 1000 for a, b in zip(sample, sample[1:]))
                    phases.append({"phase": name, "packets_per_second": round(len(sample) / 4, 2),
                        "p95_delivery_gap_ms": round(gaps[int((len(gaps) - 1) * .95)], 2) if gaps else None,
                        "max_delivery_gap_ms": round(max(gaps), 2) if gaps else None,
                        "keyframes": sum(started + duration - 4 <= at <= ended for at in keys)})
                    print(json.dumps(phases[-1]), flush=True)
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            decoder = await asyncio.create_subprocess_exec("ffmpeg", "-hide_banner", "-loglevel", "error",
                "-i", str(video_path), "-vf", "setpts=N/30/TB", "-r", "30", "-fps_mode", "passthrough",
                "-progress", "pipe:1", "-nostats", "-f", "null", "-",
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            decoded, errors = await decoder.communicate()
            decoded_frames = [int(line.split("=", 1)[1]) for line in decoded.decode().splitlines() if line.startswith("frame=")]
            result = {"phases": phases, "delivered_access_units": len(arrivals),
                "decoded_frames": decoded_frames[-1] if decoded_frames else 0,
                "decoder_returncode": decoder.returncode, "decoder_errors": errors.decode()[-2000:],
                "source": "owned Xvfb synthetic animated screen", "visible_presentation_verified": False,
                "existing_user_contexts_mutated": False}
            print(json.dumps(result, indent=2), flush=True)
            return result
    finally:
        streamer.running = False
        if writer:
            writer.close()
            await writer.wait_closed()
        if server:
            server.close()
            await server.wait_closed()
        for task in [capture, *tasks]:
            if task:
                task.cancel()
        await asyncio.gather(*[task for task in [capture, *tasks] if task], return_exceptions=True)
        for process in [animation, xvfb]:
            if process:
                process.terminate()
                try:
                    await asyncio.to_thread(process.wait, 3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    await asyncio.to_thread(process.wait)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--streamer", required=True)
    parser.add_argument("--display", default=":101")
    parser.add_argument("--output")
    args = parser.parse_args()
    result = asyncio.run(probe(args.streamer, args.display))
    if args.output:
        Path(args.output).write_text(json.dumps(result, indent=2) + "\n")
    raise SystemExit(0 if result["decoder_returncode"] == 0 and result["decoded_frames"] == result["delivered_access_units"] else 1)
