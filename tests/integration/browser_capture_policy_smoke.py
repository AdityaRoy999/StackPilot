"""Qualify the running adaptive producer without controlling a browser tab.

Connects one owned TCP viewer, sends pacing feedback, and counts H.264 access
units. These rates are producer delivery, not visible presentation or latency.
The last four seconds of each eight-second phase exclude encoder transitions.
"""
import argparse
import asyncio
import json
from pathlib import Path
import struct
import time


async def qualify(host, port):
    reader, writer = await asyncio.open_connection(host, port)
    arrivals, keys, results = [], [], []
    feedback = {}

    async def consume():
        while True:
            size, key = struct.unpack(">IB", await reader.readexactly(5))
            if not 0 < size <= 16 * 1024 * 1024 or key not in {0, 1}:
                raise ValueError("Invalid producer packet")
            await reader.readexactly(size)
            arrivals.append(time.monotonic())
            if key:
                keys.append(arrivals[-1])

    async def send_feedback():
        while True:
            if feedback:
                writer.write((json.dumps({"type": "feedback", **feedback}) + "\n").encode())
                if feedback.get("visible"):
                    writer.write(b'{"type":"activity"}\n')
                await writer.drain()
            await asyncio.sleep(.5)

    tasks = [asyncio.create_task(consume()), asyncio.create_task(send_feedback())]
    phases = [
        ("nominal", {"visible": True, "gap_ms": 60, "decode_queue": 0, "rtt_ms": 20}),
        ("congested", {"visible": True, "gap_ms": 180, "decode_queue": 4, "rtt_ms": 300}),
        ("healthy", {"visible": True, "gap_ms": 16, "decode_queue": 0, "rtt_ms": 20}),
        ("hidden", {"visible": False, "gap_ms": 16, "decode_queue": 0, "rtt_ms": 20}),
    ]
    try:
        for name, value in phases:
            feedback = value
            started = time.monotonic()
            await asyncio.sleep(8)
            ended = time.monotonic()
            for task in tasks:
                if task.done():
                    task.result()
            count = sum(started + 4 <= at <= ended for at in arrivals)
            results.append({"phase": name, "packets_per_second": round(count / (ended - started - 4), 2),
                            "keyframes": sum(started + 4 <= at <= ended for at in keys)})
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        writer.close()
        await writer.wait_closed()
    nominal, congested, healthy, hidden = [item["packets_per_second"] for item in results]
    return {"verified": all(item["keyframes"] > 0 for item in results)
                        and nominal > 0 and congested <= nominal + 2 and 0 < hidden < congested
                        and healthy >= congested,
            "source": "running X11 H.264 producer", "phases": results,
            "visible_presentation_verified": False, "browser_actions_performed": False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8099)
    parser.add_argument("--output")
    args = parser.parse_args()
    result = asyncio.run(qualify(args.host, args.port))
    serialized = json.dumps(result, indent=2)
    print(serialized)
    if args.output:
        Path(args.output).write_text(serialized + "\n", encoding="utf-8")
    raise SystemExit(0 if result["verified"] else 1)


if __name__ == "__main__":
    main()
