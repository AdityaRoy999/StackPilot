# StackPilot completion plan

Recorded: 1 October 2026.

**Status: deferred at the owner's request.** Preserve this plan for later work.
Recording it does not start implementation, schedule follow-ups, enable cloud
spending, or mark any remaining capability complete. Resume when the owner asks
to work on the completion plan.

## Intended outcome

Accept a broad range of repositories, understand their workloads, complete or
repair source against agreed requirements, provision a suitable environment,
verify actual behavior, and deliver and monitor the verified result. Preserve
the appropriate delivery type: websites/APIs, CLI applications, workers, jobs,
packages, and native applications.

The owner's ambition is to support any repository, including substantially
unfinished projects. Qualification must still use an explicit, measured support
contract. No universal success percentage has been established. Missing product
requirements, credentials, operating systems, proprietary dependencies, or
hardware are resumable prerequisites; they cannot be inferred reliably from a
repository that contains only a small part of a product.

## Existing foundation

Local Docker provisioning for Ubuntu, Debian and Alpine is implemented and
qualified, including task ownership, persistent setup/workspaces, resource
admission, lease checks, restart observation and lifecycle cleanup. Existing
repository analysis, scoped editing and patch integration, frozen feature
acceptance, independent verification, local component execution, durable jobs,
and verified local delivery remain the starting point.

These capabilities do not establish successful autonomous completion on unseen
repositories. Earlier live model completion qualification did not pass because
of provider failures; the successful scripted fixtures used known repairs and
made no model calls. Preserve that distinction in future status reports.

Current evidence and boundaries:

- [Docker instance architecture and qualification](docker-instance-provisioning-2026-10-01.md)
- [Linux repository execution](linux-repository-execution-2026-10-01.md)
- [Repository completion contracts and model qualification](repository-completion-2026-10-01.md)
- [Original repository-agent architecture](universal-repository-agent-plan-2026-09-29.md)

## Nine remaining workstreams

All nine remain pending as broader implementation/qualification work. Existing
partial support should be extended, not reported as absent or universally done.

| # | Workstream | Remaining work and completion evidence |
| --- | --- | --- |
| 1 | Autonomous completion and healing | Demonstrate real AI completing unfinished repositories and repairing failures against original requirements. Require independent feature checks and a verified delivered result; scripted repair fixtures do not satisfy this milestone. |
| 2 | Reliable recovery | Handle provider outages, interruptions and unsuccessful repair attempts with durable progress and bounded retries. Reconcile uncertain actions before continuing; prove restart/cancellation behavior without silently replaying side effects. |
| 3 | Complex repository planning | Expand legacy build, ambiguous monorepo, dependency graph and unusual toolchain support. Qualify representative fixtures and return explicit resumable requirements where the intended build cannot be determined. |
| 4 | Stateful applications | Implement and qualify migrations, backups, restore and data-safe rollback. Test recovery using real persisted data and agreed recovery objectives. |
| 5 | Native operating systems and hardware | Add suitable Windows, macOS/iOS, architecture, GPU and device worker adapters. Qualify on actual suitable runners; Linux Docker userspace cannot establish these capabilities. |
| 6 | Remote orchestration | Extend component-aware verification and recovery to remote Docker and Kubernetes. Test partial service failures, authenticated connectivity and preservation of the last verified release. Cloud allocation remains a later, separately configured capability. |
| 7 | Broader verification and delivery | Extend meaningful TUI, native GUI, protocol and authenticated workflow assertions, plus required signing and publication adapters. Verify actual application/artifact behavior using applicable credentials and environments. |
| 8 | Production execution | Qualify isolation, fleet scheduling, shared artifact storage, retention, writable-layer disk limits and load/recovery behavior. The current local Docker adapter is not a qualified hostile multi-tenant execution boundary. |
| 9 | Compatibility benchmark | Assemble a representative, versioned repository suite covering languages, frameworks, workloads, broken/incomplete source and environment constraints. Publish reproducible successes, failures and prerequisites against an explicit denominator. |

## Information needed from the owner

The existing Docker/Linux setup is sufficient to begin much of the engineering
work when this plan is resumed. StackPilot can select sensible implementation
defaults and assemble public compatibility fixtures.

For qualification or capabilities that require external resources, obtain:

1. **Working AI provider/model:** configure it through StackPilot Settings.
   Do not ask for API keys in chat. Live completion/healing needs a functioning
   provider, and the selected model must not be silently replaced.
2. **Intent for unfinished projects:** intended features and what counts as
   finished, expressed as meaningful acceptance criteria. Existing source and
   README behavior can supply requirements where sufficiently explicit.
3. **Target platforms and suitable runners:** Linux is the agreed starting
   point. Windows, macOS/iOS, GPU and device lanes need matching environments
   before they can be claimed as qualified.
4. **Remote deployment targets:** authorized Docker servers or Kubernetes
   environments when those lanes are pursued. Automatic cloud provisioning
   additionally requires an account, region and explicit spending limit.
5. **Production objectives:** expected concurrency, databases, backup retention
   and acceptable recovery time/data loss. Use documented development defaults
   until production targets are agreed.
6. **Delivery credentials where applicable:** private dependency access,
   signing identities or publication accounts for requested workflows. Their
   absence should be reported as a precise prerequisite.

## Resume order and completion rules

Start by reviewing the current implementation and evidence, then establish a
working model and prove real completion/healing on broken repositories. Develop
recovery and the compatibility benchmark alongside that work. Extend planning
and stateful execution, then remote/native/delivery lanes as the necessary
targets become available. Qualify production limits against agreed load.

Keep original tests and frozen requirements protected. Source edits invalidate
earlier proof. A release must match the accepted source/artifacts and pass actual
runtime or artifact verification; an agent message or running container is
insufficient. Report code implemented, deterministic qualification and live
autonomous model qualification separately. Mark each milestone complete only
after its evidence passes, and measure compatibility against the published suite
rather than assigning an unsupported universal percentage.
