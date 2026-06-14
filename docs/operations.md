# Operations

This page covers routine operational tasks.

## Health Checks

Backend:

```bash
curl http://localhost:8090/api/v1/health
```

AI service:

```bash
curl http://localhost:8010/health
```

Compose:

```bash
docker compose ps
```

## Logs

```bash
docker logs stackpilot-backend
docker logs stackpilot-ai-service
docker logs stackpilot-frontend
```

Deployment logs are stored in PostgreSQL and exposed in the dashboard.

## Database Backup

```bash
docker exec stackpilot-postgres pg_dump -U "$DB_USER" "$DB_NAME" > stackpilot-backup.sql
```

Restore into a fresh database after verifying the target environment.

## Cleanup

Project delete attempts to clean deployments before deleting the project row. It cancels queued jobs, refuses to delete while jobs are running, removes runtimes, optionally removes images, cleans workspaces, then deletes the project.

## Observability

Prometheus scrapes backend metrics. Grafana reads Prometheus and Loki. Loki stores service logs through Promtail.

Important metrics include:

- `STACKPILOT_database_connected`
- `STACKPILOT_projects_total`
- `STACKPILOT_deployments_total`
- `STACKPILOT_deployment_jobs_total`
- `STACKPILOT_deployment_failures_last_24h`

## Updating

```bash
git pull
docker compose build
docker compose up -d
```

For production:

```bash
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d
```

Review migrations before applying updates to production data.
