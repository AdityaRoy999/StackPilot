# AI Agent

The StackPilot AI Agent is meant to assist real deployment work, not decorate the dashboard.

## Provider Modes

StackPilot supports:

- NVIDIA NIM through `STACKPILOT_AI_PROVIDER=nvidia_nim`.
- OpenAI-compatible providers through `STACKPILOT_AI_PROVIDER=openai_compatible`.

Fast mode should use the lowest-latency reliable model. Thinking mode should use a stronger model for diagnosis, Dockerfile planning, and multi-step reasoning.

## What AI Can Do

- Explain build failures from logs.
- Diagnose runtime failures using logs and Kubernetes events.
- Help plan Dockerfiles for unknown project shapes.
- Answer project and deployment questions from StackPilot context.
- Interpret slash commands such as diagnose, build, deploy, and Dockerfile planning.

## What AI Should Not Do Silently

- Delete resources without a user action.
- Execute remote terminal commands without permissions.
- Override deterministic build generators without a recorded reason.
- Replace the platform worker or API audit path.

## Deterministic First, AI When Needed

The build system should use deterministic detection whenever possible. AI is the fallback for ambiguous source trees and the explainer for complex failures.

## Provider Configuration

NVIDIA NIM:

```bash
STACKPILOT_AI_PROVIDER=nvidia_nim
NVIDIA_API_KEY=...
NVIDIA_NIM_BASE_URL=https://integrate.api.nvidia.com/v1
NVIDIA_NIM_FAST_MODEL=meta/llama-3.1-8b-instruct
NVIDIA_NIM_THINKING_MODEL=meta/llama-3.1-70b-instruct
```

OpenAI-compatible:

```bash
STACKPILOT_AI_PROVIDER=openai_compatible
OPENAI_COMPATIBLE_BASE_URL=https://provider.example.com/v1
OPENAI_COMPATIBLE_API_KEY=...
OPENAI_COMPATIBLE_MODEL=...
```

## Latency Guidance

Use fast mode for chat, command explanation, and recent failure summaries. Use thinking mode for Dockerfile planning, deployment diagnosis, and workflows that need deeper context.
