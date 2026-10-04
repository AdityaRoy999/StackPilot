"""Session-owned browser routing. Never change endpoints globally between users."""
import os
from dataclasses import dataclass, field
from urllib.parse import urlparse, urlunparse


@dataclass(frozen=True)
class BrowserConfig:
    mode: str
    endpoint: str
    stream_host: str = ""
    stream_port: int = 8099
    headers: dict = field(default_factory=dict)

    def resolve_url(self, url):
        if self.mode != "host":
            from .browser_driver import to_container_accessible_url
            return to_container_accessible_url(url)
        if not url or url == "about:blank":
            return url or "about:blank"
        parsed = urlparse(url if "://" in url else "http://" + url)
        hosts = {"frontend": 3000, "backend": 8090, "ai-service": 8010}
        if parsed.hostname in hosts:
            return urlunparse(parsed._replace(netloc=f"localhost:{parsed.port or hosts[parsed.hostname]}"))
        if parsed.hostname == "host.docker.internal":
            return urlunparse(parsed._replace(netloc="localhost" + (f":{parsed.port}" if parsed.port else "")))
        return url


def browser_config(mode="local"):
    if mode == "host":
        endpoint = os.getenv("HOST_BROWSER_CDP_URL", "").rstrip("/")
        token = os.getenv("HOST_BROWSER_TOKEN", "")
        if not endpoint or len(token) < 32:
            raise ValueError("Host Chrome is not configured. Start the dedicated host browser worker and configure HOST_BROWSER_CDP_URL and HOST_BROWSER_TOKEN.")
        return BrowserConfig(mode, endpoint, headers={"Authorization": "Bearer " + token})
    if mode == "remote":
        endpoint = os.getenv("REMOTE_BROWSER_SANDBOX_URL", "").rstrip("/")
        if not endpoint:
            raise ValueError("Remote browser worker is not configured.")
        return BrowserConfig(mode, endpoint, os.getenv("REMOTE_BROWSER_STREAM_HOST", ""),
                             int(os.getenv("REMOTE_BROWSER_STREAM_PORT", "8099")))
    if mode != "local":
        raise ValueError("Unknown browser mode")
    return BrowserConfig(mode, os.getenv("BROWSER_SANDBOX_URL", "http://browser-sandbox:9222").rstrip("/"),
                         os.getenv("BROWSER_STREAM_HOST", "browser-sandbox"),
                         int(os.getenv("BROWSER_STREAM_PORT", "8099")))
