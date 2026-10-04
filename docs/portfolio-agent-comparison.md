# Portfolio audit comparison

The comparison uses the same user prompt, `test the website`, and the same portfolio URL.

| Measure | Previous StackPilot run | Corrected audit worker |
| --- | ---: | ---: |
| End-to-end elapsed time | 166.86 s | 57.85 s |
| Same-origin routes recorded | 3 | 6 discovered / 6 visited |
| Evidence records | 14 actions | 49 cases |
| Explicit expectations | 7 passed, 2 failed | 10 passed, 0 failed |
| Console errors | 1 | 0 |
| Form submission | Contact form was submitted | Blocked by broad-audit read-only policy |
| Section navigation | Hash URL was assumed and failed | `in_viewport` section oracle passed |
| Theme toggle | Unverified | Visual state is captured and verified when selected |

The new run still takes about a minute because it intentionally visits six documents, waits for each route to settle, exercises pointer targets and section links, and records evidence. A 2–3 second target is realistic for a small, already-observed workflow; it is not realistic for a whole-site crawl over six pages with a hosted model and page loads. The worker therefore removes redundant planner turns and stale retries, while retaining bounded coverage and honest review items.

Evidence: [baseline report](portfolio-agent-audit-baseline.jsonl), [final real-provider run](portfolio-agent-audit-final.jsonl), and the reusable [audit smoke runner](../tests/integration/browser_site_audit_smoke.py).

The audit is not a universal proof of business correctness. It does not invent credentials or test data, submit messages, make purchases, accept legal terms, traverse external services, validate downloaded PDF contents, or infer that a visual hover effect is correct. Those require explicit scenarios and expected postconditions. This is the boundary that prevents a generic “test the website” prompt from creating irreversible side effects or false passes.
