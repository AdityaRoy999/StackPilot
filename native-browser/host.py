"""Authenticated proxy for one dedicated host Chrome process, never a personal profile.

The CDP listener remains on loopback. Only this authenticated proxy can be exposed
to Docker. A non-default profile is owned under the specified state directory.
"""
import argparse
import asyncio
import hmac
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
from contextlib import asynccontextmanager

import httpx
import uvicorn
import websockets
from fastapi import FastAPI, HTTPException, Request, WebSocket
from fastapi.responses import Response


def chrome_executable(explicit=None):
    candidates = [explicit, shutil.which("google-chrome"), shutil.which("chromium"),
                  shutil.which("chrome")]
    for root in (os.getenv("PROGRAMFILES"), os.getenv("PROGRAMFILES(X86)"), os.getenv("LOCALAPPDATA")):
        if root:
            candidates.append(str(Path(root) / "Google/Chrome/Application/chrome.exe"))
    candidates.append("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return candidate
    raise RuntimeError("Chrome was not found. Pass --chrome with its executable path.")


def launch_args(executable, state, port, show_window=False):
    # The caller chooses a state root; never accept an arbitrary existing Chrome profile.
    profile = Path(state).resolve() / "stackpilot-chrome-profile"
    profile.mkdir(parents=True, exist_ok=True)
    args = [executable, f"--user-data-dir={profile}", f"--remote-debugging-port={port}",
            "--remote-debugging-address=127.0.0.1", "--no-first-run", "--no-default-browser-check",
            "--window-size=1280,720", "--disable-backgrounding-occluded-windows"]
    if not show_window:
        args.append("--headless=new")
    return args + ["about:blank"]


def create_app(token, cdp_port, process=None):
    if len(token) < 32:
        raise ValueError("HOST_BROWSER_TOKEN must contain at least 32 characters")
    endpoint = f"http://127.0.0.1:{cdp_port}"

    @asynccontextmanager
    async def lifespan(app):
        yield
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                await asyncio.to_thread(process.wait, 5)
            except subprocess.TimeoutExpired:
                process.kill()
                await asyncio.to_thread(process.wait)

    app = FastAPI(lifespan=lifespan)

    def authorized(headers):
        return hmac.compare_digest(headers.get("authorization", "").encode(), ("Bearer " + token).encode())

    @app.api_route("/json/{path:path}", methods=["GET", "PUT"])
    async def discovery(path: str, request: Request):
        if not authorized(request.headers):
            raise HTTPException(401, "Host browser authentication required")
        if path not in {"version", "list", "protocol"} and not path.startswith("close/"):
            raise HTTPException(404)
        async with httpx.AsyncClient(trust_env=False, timeout=5) as client:
            response = await client.request(request.method, endpoint + "/json/" + path,
                                            headers={"Host": "localhost"})
        return Response(response.content, response.status_code, media_type=response.headers.get("content-type"))

    @app.websocket("/devtools/{path:path}")
    async def bridge(path: str, socket: WebSocket):
        if not authorized(socket.headers) or not path.startswith(("browser/", "page/")):
            await socket.close(code=1008)
            return
        await socket.accept()
        try:
            async with websockets.connect(f"ws://127.0.0.1:{cdp_port}/devtools/{path}",
                                          max_size=16 * 1024 * 1024, compression=None) as upstream:
                async def incoming():
                    while True:
                        await upstream.send(await socket.receive_text())

                async def outgoing():
                    async for message in upstream:
                        await socket.send_text(message)

                tasks = [asyncio.create_task(incoming()), asyncio.create_task(outgoing())]
                try:
                    await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                finally:
                    for task in tasks:
                        task.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)
        finally:
            try:
                await socket.close()
            except RuntimeError:
                pass

    return app


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--chrome")
    parser.add_argument("--state-dir", default=str(Path.home() / ".stackpilot/browser"))
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9225)
    parser.add_argument("--cdp-port", type=int, default=9226)
    parser.add_argument("--show-window", action="store_true")
    args = parser.parse_args()
    token = os.getenv("HOST_BROWSER_TOKEN", "")
    # Fail before starting Chrome if authentication is missing.
    app = create_app(token, args.cdp_port)
    # Refuse to attach to a pre-existing listener, which could be a different profile.
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", args.cdp_port))
    process = subprocess.Popen(launch_args(chrome_executable(args.chrome), args.state_dir,
                                          args.cdp_port, args.show_window),
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    app = create_app(token, args.cdp_port, process)
    uvicorn.run(app, host=args.bind, port=args.port, access_log=False, ws_per_message_deflate=False)


if __name__ == "__main__":
    main()
