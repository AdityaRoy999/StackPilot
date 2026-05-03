# AIDS Observability

Phase 6 adds a local production-style observability stack:

- Prometheus scrapes backend platform metrics from `/metrics`.
- Grafana provisions an AIDS dashboard automatically.
- Loki stores logs.
- Promtail streams Docker container logs into Loki.
- cAdvisor exposes container CPU and memory metrics for Prometheus.

Default local URLs:

- Prometheus: http://localhost:9090
- Grafana: http://localhost:3001
- Loki: http://localhost:3100

For production, set a strong `GRAFANA_ADMIN_PASSWORD` and optionally set
`AIDS_METRICS_BEARER_TOKEN` so `/metrics` requires a bearer token.
