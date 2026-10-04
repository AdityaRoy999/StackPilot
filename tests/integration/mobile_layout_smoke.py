"""Render dashboard breakpoints with synthetic API data in an owned browser.

Run inside browser-sandbox. No login, user cookies, model calls, or deployments
are used. Every API response is intercepted before it reaches the backend.
"""
import asyncio
import argparse
import base64
import json
import subprocess
import tempfile
import urllib.request
from pathlib import Path

import websockets

PROJECTS = [dict(id=str(i), name=name, description="", source_type="github",
                 repo_url="https://github.com/example/" + "long-repository-name-" * 4,
                 created_at="2026-09-27", status="active", env_var_count=0)
            for i, name in enumerate(["Advanced calculator with a long project name", "club website", "portfolio"])]


class CDP:
    def __init__(self, ws):
        self.ws, self.serial, self.pending, self.errors = ws, 0, {}, []
        self.reader = asyncio.create_task(self.read())

    async def read(self):
        async for raw in self.ws:
            message = json.loads(raw)
            if message.get("method") == "Fetch.requestPaused":
                asyncio.create_task(self.fulfill(message["params"]))
            if message.get("method") == "Runtime.exceptionThrown":
                self.errors.append(message["params"].get("exceptionDetails", {}).get("text"))
            future = self.pending.pop(message.get("id"), None)
            if future:
                if "error" in message:
                    future.set_exception(RuntimeError(message["error"]))
                else:
                    future.set_result(message.get("result", {}))

    async def call(self, method, params=None):
        self.serial += 1
        future = asyncio.get_running_loop().create_future()
        self.pending[self.serial] = future
        await self.ws.send(json.dumps(dict(id=self.serial, method=method, params=params or {})))
        return await asyncio.wait_for(future, 90)

    async def evaluate(self, expression):
        result = await self.call("Runtime.evaluate", dict(expression=expression, returnByValue=True, awaitPromise=True))
        if result.get("exceptionDetails"):
            raise RuntimeError(result["exceptionDetails"])
        return result.get("result", {}).get("value")

    async def fulfill(self, params):
        url = params["request"]["url"]
        print("Intercepted sample-data request: " + url.split("?")[0], flush=True)
        data = dict(projects=PROJECTS, deployments=[], organizations=[], secrets=[],
                    servers=[], sessions=[], models=[], connections=[], providers=[],
                    templates=[], applications=[], events=[], logs=[], members=[], invitations=[],
                    settings={}, user=dict(id="mobile-fixture", username="Mobile QA", preferences={}))
        if "logging-monitoring" in url and "summary" in url:
            data = dict(status="ok", database_connected=True, projects=dict(active=3),
                        stack={}, deployments=dict(total=0, by_status={}, by_runtime={}),
                        jobs=dict(by_status={}), recent_failures=[])
        headers = [{"name": "Content-Type", "value": "application/json"},
                   {"name": "Access-Control-Allow-Origin", "value": "http://127.0.0.1:3000"},
                   {"name": "Access-Control-Allow-Credentials", "value": "true"},
                   {"name": "Access-Control-Allow-Headers", "value": "Content-Type,X-stackpilot-CSRF"},
                   {"name": "Access-Control-Allow-Methods", "value": "GET,POST,PUT,DELETE,OPTIONS"}]
        await self.call("Fetch.fulfillRequest", dict(requestId=params["requestId"], responseCode=200,
                        responseHeaders=headers, body=base64.b64encode(json.dumps(data).encode()).decode()))


async def wait_for(cdp, expression, seconds=120):
    for _ in range(seconds * 4):
        if await cdp.evaluate(expression):
            return
        await asyncio.sleep(.25)
    diagnostics = await cdp.evaluate("JSON.stringify({url:location.href,text:document.body.innerText.slice(0,300),resources:performance.getEntriesByType('resource').slice(-5).map(x=>x.name)})")
    raise AssertionError("Page condition timed out: " + expression + " " + diagnostics + " errors=" + str(cdp.errors))


async def proxy(reader, writer):
    remote_reader, remote_writer = await asyncio.open_connection("frontend", 3000)
    async def forward(source, destination):
        try:
            while data := await source.read(65536):
                destination.write(data)
                await destination.drain()
        finally:
            destination.close()
    await asyncio.gather(forward(reader, remote_writer), forward(remote_reader, writer), return_exceptions=True)


async def main(args):
    output = Path(args.output)
    output.mkdir(exist_ok=True)
    results = []
    server = await asyncio.start_server(proxy, "127.0.0.1", 3000)
    with tempfile.TemporaryDirectory(prefix="stackpilot-mobile-qa-") as profile:
        process = subprocess.Popen(["/usr/lib/chromium/chromium", "--headless=new", "--no-sandbox",
            "--disable-dev-shm-usage", "--disable-gpu", "--remote-debugging-port=9228",
            "--user-data-dir=" + profile, "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            target = None
            for _ in range(80):
                try:
                    with urllib.request.urlopen("http://127.0.0.1:9228/json", timeout=2) as response:
                        target = json.load(response)[0]
                    break
                except OSError:
                    await asyncio.sleep(.25)
            if not target:
                raise RuntimeError("Owned QA Chromium did not start")
            async with websockets.connect(target["webSocketDebuggerUrl"], max_size=16 * 1024 * 1024) as ws:
                cdp = CDP(ws)
                await cdp.call("Page.enable")
                await cdp.call("Runtime.enable")
                await cdp.call("Fetch.enable", dict(patterns=[dict(urlPattern="*api/v1/*")]))
                await cdp.call("Page.addScriptToEvaluateOnNewDocument", dict(source="localStorage.setItem('theme','dark'); localStorage.setItem('sidebar-collapsed','true');"))
                for width, height in [(320, 740), (390, 844), (768, 1024), (844, 390), (1280, 800)]:
                    await cdp.call("Emulation.setDeviceMetricsOverride", dict(width=width, height=height, deviceScaleFactor=1, mobile=width < 640))
                    await cdp.call("Page.navigate", dict(url="http://127.0.0.1:3000/dashboard"))
                    await wait_for(cdp, "!!document.querySelector('[data-slot=card-footer]')")
                    await asyncio.sleep(1)
                    metrics = await cdp.evaluate("""(() => {
                      const main=document.querySelector('main'), r=main.getBoundingClientRect();
                      return {width:innerWidth,documentWidth:document.documentElement.scrollWidth,
                        mainWidth:r.width,mainScrollWidth:main.scrollWidth,
                        sidebarVisible:!!document.querySelector('aside')?.getBoundingClientRect().width,
                        cards:[...document.querySelectorAll('[data-slot=card]')].map(c=>({left:c.getBoundingClientRect().left,right:c.getBoundingClientRect().right})),
                        searchHeight:document.querySelector('input')?.getBoundingClientRect().height};
                    })()""")
                    assert metrics["documentWidth"] <= width + 1, metrics
                    assert metrics["mainScrollWidth"] <= metrics["mainWidth"] + 1, metrics
                    assert all(card["right"] <= width + 1 for card in metrics["cards"]), metrics
                    if width < 640:
                        assert not metrics["sidebarVisible"], metrics
                        assert metrics["searchHeight"] >= 44, metrics
                        small_buttons = await cdp.evaluate("[...document.querySelectorAll('main button')].filter(b=>b.getBoundingClientRect().width>0).filter(b=>b.getBoundingClientRect().height<43).map(b=>b.textContent||b.getAttribute('aria-label')||b.dataset.slot)")
                        assert not small_buttons, small_buttons
                        await cdp.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('New Project')).click()")
                        await wait_for(cdp, "!!document.querySelector('[data-slot=dialog-content]')")
                        dialog_metrics = await cdp.evaluate("""(() => {const d=document.querySelector('[data-slot=dialog-content]'),r=d.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:d.clientWidth,scrollWidth:d.scrollWidth};})()""")
                        assert dialog_metrics["left"] >= 0 and dialog_metrics["right"] <= width + 1 and dialog_metrics["bottom"] <= height + 1, dialog_metrics
                        assert dialog_metrics["scrollWidth"] <= dialog_metrics["width"] + 1, dialog_metrics
                        await cdp.call("Input.dispatchKeyEvent", dict(type="keyDown", key="Escape", code="Escape", windowsVirtualKeyCode=27))
                        await cdp.call("Input.dispatchKeyEvent", dict(type="keyUp", key="Escape", code="Escape", windowsVirtualKeyCode=27))
                        await wait_for(cdp, "!document.querySelector('[data-slot=dialog-content]')")
                        await cdp.evaluate("document.querySelector('[aria-label=\"Open navigation\"]').click()")
                        await wait_for(cdp, "!!document.querySelector('[data-mobile-navigation]')")
                        await cdp.evaluate("document.querySelector('[data-mobile-navigation] a[href=\"/dashboard\"]').click()")
                        await wait_for(cdp, "!document.querySelector('[data-mobile-navigation]')")
                    shot = await cdp.call("Page.captureScreenshot")
                    (output / f"projects-{width}.png").write_bytes(base64.b64decode(shot["data"]))
                    results.append(dict(route="/dashboard", **metrics))
                await cdp.call("Emulation.setDeviceMetricsOverride", dict(width=390, height=844, deviceScaleFactor=1, mobile=True))
                for route in ([] if args.projects_only else ["deployments", "secrets", "organization", "settings", "logging-monitoring", "ai"]):
                    cdp.errors.clear()
                    await cdp.call("Page.navigate", dict(url="http://127.0.0.1:3000/dashboard/" + route))
                    await wait_for(cdp, "!!document.querySelector('main h1, main header')")
                    await asyncio.sleep(2)
                    metrics = await cdp.evaluate("""(() => {const m=document.querySelector('main');return {
                      documentWidth:document.documentElement.scrollWidth,mainWidth:m.clientWidth,
                      mainScrollWidth:m.scrollWidth,pageError:document.body.innerText.includes('This page hit an error')};})()""")
                    assert metrics["documentWidth"] <= 391 and metrics["mainScrollWidth"] <= metrics["mainWidth"] + 1, (route, metrics)
                    assert not metrics["pageError"] and not cdp.errors, (route, cdp.errors)
                    results.append(dict(route="/dashboard/" + route, **metrics))
                    shot = await cdp.call("Page.captureScreenshot")
                    (output / f"{route}-390.png").write_bytes(base64.b64decode(shot["data"]))
                (output / "results.json").write_text(json.dumps(results, indent=2))
                print(json.dumps(results))
                cdp.reader.cancel()
        finally:
            server.close()
            await server.wait_closed()
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--projects-only", action="store_true")
    parser.add_argument("--output", default="/tmp/stackpilot-mobile-qa-results")
    asyncio.run(main(parser.parse_args()))
