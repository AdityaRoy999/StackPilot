FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    DEBIAN_FRONTEND=noninteractive \
    STACKPILOT_AGENT_RUN_DB=/app/browser-state/browser-runs.sqlite3

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl git \
    && rm -rf /var/lib/apt/lists/* \
    && adduser --uid 10001 --disabled-password --gecos "" stackpilot

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY --chown=stackpilot:stackpilot app ./app
RUN mkdir -p /app/app/.runtime /app/browser-state /app/agent-workspaces && chown stackpilot:stackpilot /app/app/.runtime /app/browser-state /app/agent-workspaces

USER stackpilot

EXPOSE 8010

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
    CMD curl -fsS http://127.0.0.1:8010/health >/dev/null || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8010", "--ws-per-message-deflate", "false"]
