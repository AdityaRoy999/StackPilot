# Selected Nemotron model: live StackPilot qualification

Tested exactly `nvidia/nemotron-3-super-120b-a12b`. No fallback model was used and no saved/default model preference was changed. Live runs used disposable local repositories and accounts; their projects and runtimes were removed afterwards.

**Result: this hosted model is not yet qualified for reliable end-to-end delivery.** It generated actual tool calls and source repairs, but neither the plain-prompt delivery nor the two-worker delivery completed the required release verification during this qualification.

## Live evidence

| Test | Result | Evidence |
| --- | --- | --- |
| Initial plain prompt, “Deploy this repository.” | Failed after 43.30 seconds at an unnecessary terminal permission pause. | `agent-lead-nemotron-initial-qualification.json` |
| Subsequent plain prompt | Failed after 37.53 seconds. A legacy rebuild schema required a nonexistent first-deployment ID; the model supplied the project ID and the ownership guard rejected it. | `agent-lead-nemotron-schema-failure-qualification.json` |
| Bound-schema plain prompt | Executed original tests, observed the seeded defects, then encountered an error inside the provider stream. Failed after 38.19 seconds. An unregistered guessed toolchain image was also correctly rejected before retrying the registered image. | `agent-lead-nemotron-provider-failure-qualification.json` |
| Plain prompt with stream-error detection/retries | Failed after 13.43 seconds. Repeated HTTP-200 stream envelopes contained code 503 and “Service temporarily overloaded”; consecutive retries exhausted their bound. No verified deployment. | `agent-lead-model-nvidia-nemotron-3-super-120b-a12b-qualification.json` |
| Initial two model workers | Both edited their assigned files and the original square regression passed in a real Docker worker. A subsequent NVIDIA HTTP 500 interrupted completion after 9.66 seconds. The peer was canceled during cleanup. | `agent-team-nemotron-initial-qualification.json` and its run events |
| Two model workers with 500/envelope retries | Failed after 4.84 seconds. One worker encountered three consecutive NVIDIA HTTP 500 responses, including two retries. | `agent-team-model-nvidia-nemotron-3-super-120b-a12b-qualification.json` |
| Provider-only tool generation probe | Both the documented Fast profile and baseline generated `workspace_read_file`, HTTP 200, in 1.21 and 1.33 seconds. No tools were executed by this probe. | `agent-nemotron-provider-profile-probe.json` |

Successful model calls were often around 1–3 seconds, but earlier calls ranged up to 20.609 seconds. These timings do not establish successful-task latency, accuracy on unseen repositories, a model-wide speedup, or browser-stream frame rate. The small probe confirms profile acceptance at that moment; it does not establish why other requests failed. The streamed 503 errors explicitly identify overload; the worker's generic HTTP 500 does not establish its underlying cause.

## Changes applied locally

- Repository tool discovery no longer advertises the disabled control-plane terminal. Lead discovery also omits worker-only command/submission tools and the deprecated delegation alias.
- Isolated lead and worker schemas omit project, deployment, user and session targets owned by execution. First deployment no longer requires the model to invent a deployment ID. Original legacy schemas and ownership checks remain intact.
- The selected Nemotron model uses NVIDIA's documented coding-agent sampling and template settings: temperature 1.0, top-p 0.95, reasoning enabled, low effort in Fast mode, and nonempty content. Thinking mode retains full effort. This profile is shared by lead and workers.
- HTTP-200 error envelopes in streams and ordinary responses are recognized. Transient 500/503 failures are retried with a bound while preserving the selected model. Partially generated tool calls are discarded before execution; already completed tools are not replayed.
- Empty lead responses receive bounded retries and then an explicit unverified result. Provider error/retry events are retained by actual actor ID.
- SSE errors supply the dashboard's `error` field, preventing message-only failures from rendering “undefined”. Qualification records distinguish lead and worker timing and retain actual failures.

NVIDIA's parameter guidance: [official Nemotron API/model documentation](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-super-120b-a12b).

## Regression validation

Provider tests: **9 passed**. Agent-team tests: **32 passed**. Stream tests: **20 passed**. These **61 regression checks** cover request parameters, capability discovery, target ownership, independent acceptance, bounded retries, partial-call discard and error serialization; they are separate from the failed live model qualification. The final local AI image was rebuilt and activated.

No live fixture URL is offered as a persistent deployment. Test success cannot be fabricated by increasing retries indefinitely or replacing the requested model. A further end-to-end qualification is required when the hosted provider is stable; realistic repositories and workflows are still required for broader reliability claims.

## Reproduction

From the repository root with the local Docker stack running:

```powershell
python tests/integration/agent_team_smoke.py --lead nvidia/nemotron-3-super-120b-a12b
python tests/integration/agent_team_smoke.py nvidia/nemotron-3-super-120b-a12b
```
