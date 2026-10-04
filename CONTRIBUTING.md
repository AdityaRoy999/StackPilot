# Contributing

Start from a current checkout and keep each change focused. Describe the problem, final behavior and validation in the pull request. Do not commit `.env`, provider credentials, private keys, runtime state, logs or generated probe reports.

## Development

Run `python scripts/configure.py` for local configuration. Use `docker compose --profile ai --profile browser up -d --build` for the application, or `docker-compose.dev.yml` for dashboard development. The public website is a separate Vite project in `stackpilot web/`.

```bash
cd frontend
npm ci
npm run lint
npm test
npm run build
```

```bash
cd "stackpilot web"
npm ci
npm test
npm run build
```

```bash
PYTHONPATH=ai-service python -m unittest discover -s ai-service/tests
python -m unittest discover -s tests/deployment
PYTHONPATH=stackpilot-cli python -m unittest discover -s stackpilot-cli/tests
```

AI tests require `ai-service/requirements.txt`. C++ tests run through `docker build --target unit-tests -t stackpilot-unit-tests .` followed by `docker run --rm stackpilot-unit-tests`. Live browser and deployment smoke tests need a disposable stack; do not run destructive qualification against a personal installation.

Add migrations instead of editing already-applied SQL. Preserve authorization, ownership and exact-action approval checks. Tests should verify behavior and failure boundaries, not only mirror implementation. Public documentation imports current Markdown guides from the repository; update the source guide once.

Place generated qualification output in ignored `tests/artifacts/`. Keep durable architectural decisions and measured results in the corresponding guide. Historical screenshots and one-off diagnostics belong in Git history, not new source commits.

## Existing lint debt

Frontend CI uses a lint ratchet instead of ignoring lint failures. Every ESLint rule remains active; `frontend/eslint-baseline.json` records existing typing and React hook violations. `npm run lint` fails on new violations. `npm run lint:strict` reports all unresolved errors. When fixing existing violations, update the baseline with `npm run lint:baseline` and review its diff; do not add entries to bypass CI.
