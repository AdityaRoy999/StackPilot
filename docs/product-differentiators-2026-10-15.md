# StackPilot differentiation: concrete next features

These are product recommendations based on the current repository, not completed features or claims that nobody else offers them.

## What competitors already cover

Git push deployments, branch previews, rollbacks and build checks are established features. [Vercel Git deployments](https://vercel.com/docs/git) and [blocking Checks](https://vercel.com/docs/checks/creating-checks) document these flows. [Railway PR environments](https://docs.railway.com/guides/preview-deployments-with-pr-environments) also provide automatic preview environments. Vercel now offers investigations, approved fixes and PR creation through [Vercel Agent](https://vercel.com/changelog/an-expanded-vercel-agent-chat-investigations-and-approved-actions-now-in-public-beta). An AI chat or repair PR alone is insufficient differentiation.

## Recommended priorities

| Priority | Feature | StackPilot foundation | Concrete work still needed |
| --- | --- | --- | --- |
| 1 | **One commit, every delivery**: one release page combines the web/API runtime, Android APK/AAB, Windows installer, Linux desktop and CLI/package artifacts. | Selected adapters have passed pinned sample builds, downloads and some native workflows. | A first-class target matrix, compatible worker scheduling, per-target signing identities, durable artifact storage, independent target status and coordinated promotion. Native Windows/iOS execution remains unqualified without the corresponding enrolled workers. |
| 2 | **Portable, verified repair PR**: fix a failed release on the customer's own machine/VM, attach original test results and actual UI evidence, then create a reviewable PR. | Scoped source edits, independent acceptance, repair incidents and runtime/browser verification exist. | Scoped GitHub App write access, repair branch/PR lifecycle, conflict handling, immutable evidence links and merge/promotion binding. Preserve the previous serving release until the exact repaired artifact passes. Extend the same evidence to native applications. |
| 3 | **Environment explanation and replay**: explain why the same commit works in development but fails in production, using branch mappings and private credential references. | Environment overlays, key-only project context and hosted-service checks exist. | A comparison UI covering recipe, toolchain, dependency topology, key presence and artifact differences; isolated replay with redacted fixtures; a concrete proposed configuration diff. Credentials stay executor-side. |
| 4 | **Release impact map**: a Git diff identifies affected services, desktop/mobile targets, APIs and data migrations before building. | Repository/component discovery and contracts exist. | Dependency edges tied to actual build inputs, affected-target scheduling, migration compatibility checks, measurable cache hits and evidence that skipped targets remain valid. |

Lead with priorities 1 and 2 together: **repair, test and deliver applications across platforms on infrastructure the customer controls**. Validate this combination with repeatable public sample repositories and complete release evidence. Do not market universal framework support from one successful sample.

## First acceptance demo

Use a pinned repository containing a web/API and an Android or desktop client. Introduce one reproducible deployment configuration failure. StackPilot should preserve the serving release, propose a minimal repair, run original tests and a declared user journey, publish both target outputs from the same commit, and open a PR containing the diff and evidence. The demo must report missing workers/signing inputs as prerequisites rather than substituting a different application type.
