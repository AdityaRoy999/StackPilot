# StackPilot dashboard

The Next.js application for projects, deployments, AI testing, runtime viewers, infrastructure and paired phone access. The public installation website is a separate project in `stackpilot web/`.

## Development

Use Node 22 and npm. Start the backend and selected worker services with the root Compose setup, then run:

```bash
npm ci
npm run dev
```

The dashboard listens on http://localhost:3000. Configure the backend URL through the root setup; see [configuration](../docs/configuration.md). Provider keys belong in the backend's settings, never in public `NEXT_PUBLIC_*` variables.

## Validation

```bash
npm run lint
npm test
npm run build
```

Lint rejects new errors against the reviewed legacy baseline in `eslint-baseline.json`. `npm run lint:strict` reports all existing debt; update the baseline only after review. Unit tests use Vitest and Testing Library. Live browser and deployment checks require a running stack; see [the test guide](../tests/README.md).

The Dockerfile creates a standalone production build and runs the dashboard as an unprivileged user. Deploy it with the root production Compose topology and controlled reverse proxy; see [production self-hosting](../docs/production-self-host.md).

Before changing Next.js code, follow [AGENTS.md](AGENTS.md) and read the installed version's relevant guides. The copied CSS variants and their license are documented in [third-party notices](../THIRD_PARTY_NOTICES.md).
