"""Portable installation configuration. Secrets are generated on the user's host."""
import os
import re
import secrets
from pathlib import Path
from urllib.parse import urlparse

PROFILES = {"base": (), "core": ("ai", "browser"), "full": ("full",), "monitoring": ("full", "monitoring")}
ALIASES = {"lite": "base", "standard": "core", "enterprise": "monitoring", "all": "monitoring"}
SECRET_NAMES = ("DB_PASSWORD", "JWT_SECRET", "TOKEN_ENCRYPTION_KEY", "STACKPILOT_AI_SERVICE_TOKEN", "GRAFANA_ADMIN_PASSWORD", "GITHUB_WEBHOOK_SECRET")


def normalize_profile(profile):
    profile = ALIASES.get(profile.lower(), profile.lower())
    if profile not in PROFILES:
        raise ValueError("Choose base, core, full, or monitoring")
    return profile


def environment_values(*, provider="later", base_url="", model="", api_key="", domain="", email=""):
    if provider not in {"later", "nvidia_nim", "openai_compatible"}:
        raise ValueError("Choose later, nvidia_nim, or openai_compatible")
    if domain and (not re.fullmatch(r"[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?", domain) or "." not in domain):
        raise ValueError("Domain must be a hostname, such as stackpilot.example.com")
    if domain and (not email or "@" not in email):
        raise ValueError("Production HTTPS requires an ACME email")
    if provider == "openai_compatible" and (urlparse(base_url).scheme not in {"http", "https"} or not urlparse(base_url).hostname or not model):
        raise ValueError("An OpenAI-compatible provider requires an HTTP(S) base URL and model")
    origin = f"https://{domain}" if domain else "http://localhost:3000"
    values = {"STACKPILOT_ENV": "production" if domain else "development",
        "DB_USER": "stackpilot_admin", "DB_NAME": "stackpilot_platform",
        **{name: secrets.token_hex(48) for name in SECRET_NAMES},
        "CORS_ALLOWED_ORIGIN": origin, "FRONTEND_PUBLIC_URL": origin,
        "BACKEND_PUBLIC_URL": origin if domain else "http://localhost:8090",
        "NEXT_PUBLIC_API_BASE_URL": "/api/v1" if domain else "http://localhost:8090/api/v1",
        "NEXT_PUBLIC_WS_BASE_URL": f"wss://{domain}" if domain else "ws://localhost:8090",
        "STACKPILOT_REQUIRE_HTTPS": str(bool(domain)).lower(),
        "STACKPILOT_TRUST_PROXY_HEADERS": str(bool(domain)).lower(),
        "STACKPILOT_AI_ENABLED": "true", "STACKPILOT_AI_PROVIDER": "nvidia_nim" if provider == "later" else provider}
    if domain:
        values.update(STACKPILOT_DOMAIN=domain, STACKPILOT_CADDY_SITE_ADDRESS=domain, ACME_EMAIL=email,
                      STACKPILOT_AUTH_REGISTRATION_MODE="first_user_only")
    if provider == "nvidia_nim":
        values["NVIDIA_NIM_API_KEY"] = api_key
        if model:
            values["NVIDIA_NIM_MODEL"] = model
    elif provider == "openai_compatible":
        values.update(OPENAI_COMPATIBLE_BASE_URL=base_url, OPENAI_COMPATIBLE_MODEL=model, OPENAI_COMPATIBLE_API_KEY=api_key)
    for value in values.values():
        if any(character in value for character in "\r\n\x00'"):
            raise ValueError("Configuration values cannot contain newlines, null bytes, or single quotes")
    return values


def write_environment(root, **options):
    root = Path(root).resolve()
    if not (root / "docker-compose.yml").is_file():
        raise ValueError("Choose the StackPilot checkout with --workspace")
    path = root / ".env"
    if path.exists():
        return path, False
    values = environment_values(**options)
    contents = "# Generated locally by stackpilot init. Keep this file private.\n"
    # Literal dollar signs in provider keys must not be interpolated by Compose.
    contents += "\n".join(f"{name}='{value}'" for name, value in values.items()) + "\n"
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as target:
        target.write(contents)
    return path, True
