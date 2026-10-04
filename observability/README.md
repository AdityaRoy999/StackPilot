# StackPilot Observability

This folder adds a local production-style observability stack:

- Prometheus scrapes backend platform metrics from `/metrics`.
- Grafana provisions a StackPilot dashboard automatically.
- Loki stores logs.
- Grafana Alloy streams Docker container logs into Loki and keeps its Docker log positions on a named volume.
- cAdvisor exposes container CPU and memory metrics for Prometheus.

Default local URLs:

- Prometheus: http://localhost:9090
- Grafana: http://localhost:3001
- Loki: http://localhost:3100

Alloy labels logs per Docker container and drops entries older than seven days before sending them to Loki. Loki accepts that same seven-day ingest window; stored logs are not automatically deleted. Its local UI is http://localhost:12345.

For production, set a strong `GRAFANA_ADMIN_PASSWORD` and optionally set
`STACKPILOT_METRICS_BEARER_TOKEN` so `/metrics` requires a bearer token.
