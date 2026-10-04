# Provider, history, icon, dialog, and cluster fixes

## Result

Agent Settings now supports named AI connections instead of a two-provider toggle. Users can add, edit, remove, and activate connections; an inactive list uses their existing AI configuration. NVIDIA NIM and public HTTPS OpenAI-compatible endpoints are supported. OpenAI, OpenRouter, and Groq are presets; a custom endpoint can be supplied. Keys are encrypted on the backend, never returned in settings responses, and an empty key during editing preserves the saved credential.

Activating a connection refreshes settings and its model catalog. Model selection and other partial settings updates retain permissions and the fallback provider configuration. Provider activation is serialized per user and the database enforces one active connection. Connections are scoped to their owner.

The model picker has company filters, company logos, a search field with the actual catalog count, and capability filters. The chat history page has search, serving-provider filters, company logos, explicit loading failures, and expandable saved context. The long subtitle was removed.

## Conversation context

Streamed conversations now reload and update the same rolling context used by non-streamed requests. The current user message is supplied once. Successful, completed turns update the saved summary and bounded preference list; interrupted replies remain visible in history without becoming successful memory. UTF-8 truncation preserves complete characters in long multilingual conversations.

This is bounded context within a conversation, not unlimited semantic memory across every chat. The preference extraction remains heuristic. The history UI calls this “Saved context” and shows the stored contents directly.

## Icons and dialogs

- The 155-entry Icon Studio catalog covers the functional Lucide icons used by the platform. Company logos remain separate brand marks.
- Platform icon imports use a shared configurable wrapper with a consistent default stroke.
- Changing modes preserves uploaded SVGs. Batch updates use the latest store snapshot, preventing edits from overwriting each other.
- Database restores replace the signed-in account's cached settings; an unauthenticated sync can retry after login. Saves are serialized and failures are visible.
- SVG previews and stored uploads pass through an allowlist sanitizer. Outline rectangles and other legitimate geometry survive repeated normalization.
- The icon editor uses a wider, two-column desktop layout, with a single column on phones. Edits stay in a draft until Apply.
- Create Project has a wider desktop canvas, a compact mobile header, a separate scrolling body, and a stationary footer. Workspace options display names and fill the available width. Viewer-only workspaces cannot be selected for creation.
- Shared dialogs use viewport height limits and more practical desktop width.

## Saved servers and Cluster Builder

The flow is:

1. Save SSH connection in Settings.
2. Probe the host. Capabilities, observation time, and probe errors persist and appear in Cluster Builder after reload.
3. Prepare Docker to install/check Docker on that host. This prepares a runtime host; it does not create a Kubernetes cluster.
4. Prepare Kubernetes or initialize a cluster to install/check K3s and register the control plane. Registration requires the API URL, token, and kubeconfig; incomplete registration cannot return a successful result.
5. Cluster Builder reads those saved connections and registered clusters, selects an eligible control plane, probes readiness, and joins selected eligible workers.

Already managed workers cannot be prepared as standalone control planes, cannot join another cluster, and cannot join themselves. Renamed control-plane connections reuse their existing cluster registration. Cluster-name collisions and conflicting membership fail before remote provisioning. Successful rejoining clears a prior removal marker. The builder refreshes shared connection/cluster data after preparation and displays stale or failed observations honestly.

Docker preparation no longer makes the Docker socket world-writable.

## Verification

- Backend unit suite: **203 passed, 0 failed**, including rolling context, bounded preferences, and UTF-8 boundaries.
- Frontend unit suite: **111 passed** across 14 files. The final icon batch change also passed its targeted 7-test icon/SVG run.
- Frontend production build (including TypeScript) and backend Docker build: passed.
- Isolated HTTP/database qualification: **20 cases passed**, including encrypted provider routing, ownership, successful and interrupted streamed context, model changes preserving fallback routing, and cluster membership preflight. Fixture containers and database were removed after the run.
- Desktop visual checks: provider settings, model company filtering, history context, workspace names, and the wider icon editor.
- Phone viewport: 390 × 844, provider controls and Create Project layout checked visually.
- The updated backend and the Docker frontend are running and healthy. The temporary UI account and personal workspace were removed after verification.

The integration fixture uses the selected Nemotron model ID with deterministic replies to check routing and persistence. It is not a live model accuracy or latency benchmark. No real remote Linux server was provided, so Docker/K3s installation and joining a real remote cluster remain unverified.

Direct native Anthropic API protocol support was not added; a compatible gateway can be configured. Private/local compatible endpoints remain blocked by the existing endpoint validation.

## Evidence

- [HTTP qualification](provider-memory-qualification.json)
- [Provider settings](screenshots/provider-settings-20260929.png)
- [Model company filter](screenshots/model-company-filter-20260929.png)
- [History context](screenshots/history-context-20260929.png)
- [Workspace names](screenshots/create-project-workspace-20260929.png)
- [Wide icon editor](screenshots/icon-editor-wide-20260929.png)
- [Mobile Create Project](screenshots/create-project-mobile-20260929.png)

Provider logo source and attribution are recorded in `frontend/public/provider-logos/README.md`.
