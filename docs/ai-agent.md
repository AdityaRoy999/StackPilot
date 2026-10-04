# AI agent

StackPilot's FastAPI service coordinates provider requests, repository tasks and browser tools. The backend supplies authenticated ownership, saved chat context and provider connections. Public clients and the CLI use backend APIs; they do not need an internal administrator service token.

## Configure

Create your account, open Settings, connect a provider and select its models. Environment configuration can also select NVIDIA NIM or an OpenAI-compatible API. Model support and availability depend on the configured endpoint. A local model server must be reachable from the AI service container and explicitly allowed by the configured network policy.

Fast and thinking modes select configured models. Browser planning uses structured tool calls, fresh control observations and explicit assertions. A model response, a screenshot or a queued build alone is not proof that a task succeeded.

## Workflows

- Inspect build and runtime failures, repository sources, logs and deployment state.
- Edit isolated task workspaces, run configured toolchains, collect verification evidence and queue a release when permitted.
- Provision task-owned Docker instances and coordinate scoped child work.
- Navigate websites, test safe interactions and form validation, observe current controls and verify outcomes.
- Preserve progress across permission pauses, cancellation and documented recovery paths.

Repository completion depends on requirements, available credentials, runtime support and actual validation. Unknown prerequisites remain blocked or unverified; the platform cannot infer a complete product from a tiny fragment reliably.

## Permissions and reliability

Consequential operations request review of an exact step. Approval tokens bind the authenticated owner, chat/run and signed parameters. Browser approval also checks the current page/control. A changed page, expired token or missing prerequisites must produce a fresh review rather than executing an inferred replacement.

The CLI prints the public action parameters, defaults confirmation to decline, and resumes the same backend session after acceptance. It never blanket-approves submissions because a user requested broad testing. The dashboard records permissions in the associated assistant message.

Provider timeouts, lost tool results and ambiguous dispatched actions remain unverified until reconciled. Builds are successful only after queue and runtime evidence exist; browser tests distinguish observed, passed, failed, blocked and untested coverage. See the [completion plan](stackpilot-completion-plan.md) for deferred work and the [streaming guide](browser-streaming-validation.md) for measured performance.
