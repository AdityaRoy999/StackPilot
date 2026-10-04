"""Run inside ai-service: real Chromium metadata events, with no LLM dependency."""
import asyncio
import json
import statistics
import time
import httpx
from app.browser_driver import BrowserSession, CHROME_HOST


async def main():
    timings = []
    events = []
    session = BrowserSession("page-state-regression")
    previous = None
    async with httpx.AsyncClient(headers={"Host": "localhost"}) as client:
        tabs = (await client.get(CHROME_HOST + "/json/list")).json()
        previous = next((t["id"] for t in tabs if t.get("type") == "page"), None)

    async def serve(reader, writer):
        line = await reader.readline()
        path = line.decode().split(" ")[1] if line else "/"
        while await reader.readline() not in {b"\r\n", b"", b"\n"}: pass
        if path == "/redirect":
            response = b"HTTP/1.1 302 Found\r\nLocation: /Destination?Case=YES\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        else:
            body = ("<!doctype html><title>" + path + "</title><a href='/second'>Next</a><button>Button</button>").encode()
            response = b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body
        writer.write(response)
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_server(serve, "0.0.0.0", 8756)
    base = "http://ai-service:8756"
    async def expect(expression, url=None, title=None):
        started = time.perf_counter()
        await session.evaluate(expression)
        async with asyncio.timeout(2):
            while (url is not None and session.current_url != url) or (title is not None and session.page_title != title):
                await asyncio.sleep(0.005)
        timings.append(round((time.perf_counter() - started) * 1000, 2))

    try:
        await session.connect()
        session.add_listener(events.append)
        # Stop the polling fallback: success must come from protocol events/binding.
        session._keepalive_task.cancel()
        await session.navigate(base + "/")
        await expect("document.title='Immediate title'", title="Immediate title")
        await expect("history.pushState({}, '', '/Spa?Case=YES#section');document.title='SPA'", base + "/Spa?Case=YES#section", "SPA")
        await expect("history.replaceState({}, '', '/Replaced?Case=YES');document.title='Replaced'", base + "/Replaced?Case=YES", "Replaced")
        await expect("location.hash='hash-change'", base + "/Replaced?Case=YES#hash-change")
        await expect("document.title=''", title="")
        for i in range(20):
            await expect(f"history.replaceState({{}}, '', '/rapid/{i}');document.title='Rapid {i}'", base + f"/rapid/{i}", f"Rapid {i}")
        before = session.page_metadata().copy()
        await session.evaluate("const f=document.createElement('iframe');f.src='/iframe';document.body.append(f)")
        await asyncio.sleep(0.2)
        assert session.current_url == before["url"] and session.page_title == before["title"], session.page_metadata()
        await expect("location.href='/redirect'", base + "/Destination?Case=YES", "/Destination?Case=YES")
        revision = session._page_state_seq
        await session.evaluate("location.reload()")
        async with asyncio.timeout(2):
            while session._page_state_seq <= revision or session.page_title != "/Destination?Case=YES":
                await asyncio.sleep(0.005)
        assert all(e.get("session_id") == session.session_id for e in events if e.get("type") == "page_state")
        result = {"cases": ["title", "empty title", "pushState", "replaceState", "hash", "rapid routes", "iframe isolation", "redirect", "reload"],
                  "samples": len(timings), "p50_ms": round(statistics.median(timings), 2),
                  "max_ms": max(timings), "final_page": session.page_metadata(),
                  "polling_disabled": True}
        print("PAGE_STATE_SMOKE_PASS " + json.dumps(result), flush=True)
    finally:
        session.remove_listener(events.append)
        await session.close()
        server.close()
        await server.wait_closed()
        if previous:
            async with httpx.AsyncClient(headers={"Host": "localhost"}) as client:
                await client.get(CHROME_HOST + "/json/activate/" + previous)


if __name__ == "__main__":
    asyncio.run(main())
