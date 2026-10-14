# Project setup and Studio workspace

The default Studio theme uses neutral surfaces, fine borders, compact cards, and
shared light/dark tokens. Existing saved theme choices are preserved; use
the Appearance section in Settings to change the theme.
The same tokens style forms, tables, dialogs, and cards across the dashboard.

**New project** loads its editor on demand and follows four steps:

The dialog opens directly on the compact progress rail so the form has more
room. The Guide info button beside **New project** opens source-specific help
from the Projects page; it no longer takes up space inside the creation dialog.

Progress circles and connecting lines are dotted for upcoming steps. Reached
circles are filled, and the rail is solid through the current step.

1. **Source:** choose GitHub, an authorized local folder, a saved SSH folder, or
   an application image. GitHub connection and PAT controls are optional for a
   public repository. Expand deployment target settings to choose a remote host.
2. **Configure:** name the project and choose its workspace. The initial
   production environment uses the repository default branch. Extra
   environments, CI gates, automatic deploys, and variables are expandable.
3. **Review:** check the source, target, environment policies, and detected stack.
   This step performs read-only inspection and cannot create a project.
4. **Confirm:** inspect the complete configuration, image, ports, runtime,
   workspace, branches, deploy/CI policies, and variable names. Secret values
   stay private. Only **Create project** on this step saves the project;
   start the first deployment from its overview or project card.

Project cards show compact stack symbols with hover/focus tooltips. The info
button beside settings opens Stack, Configuration, and Environments sections.
Recognized technologies use local brand SVGs rather than category symbols.
All detected technologies remain visible; source files expand below each
technology in the wider details dialog. Deployment actions stay visible and
wrap within the table, and ingress selectors show readable labels and SVGs.
`POST /api/v1/projects/inspect-stack` previews source metadata without creating
anything. `GET /api/v1/projects/{id}/stack` checks project access and returns
stack evidence and public configuration; it never returns manifest contents,
PATs, passwords, or environment values.

Detection reads allowlisted manifests from GitHub, approved local roots, or
a saved SSH source. It does not execute repository code or call an LLM.
Inspection is bounded to 24 manifests and 64 KiB per file (local/GitHub), with
a smaller remote payload to fit SSH output limits. Remote inspection requires
Python 3. Installed dependencies, generated folders, secret files, and symbolic
links are excluded. Unsupported or inaccessible sources show an explicit state
and do not prevent project creation. Database **clients** indicate declared
integrations, not provisioned services. Cards cache results for ten minutes;
editing the project or retrying inspection refreshes them.

Automatic deploys and required GitHub CI are opt-in for new projects. Existing
environment policies remain in force. Required CI applies to manual deployment
and retries as well as webhook deployment. Enabling it on a repository without
checks blocks release rather than treating missing checks as a pass.

The worker resolves the default branch and records an immutable commit before
building or querying CI. Retries keep that commit. An explicitly selected branch
or commit is preserved. CI for the original repository cannot verify a modified
workspace archive; commit those changes before deploying to a CI-gated environment.

Project cards show the latest release, including failed or pending attempts.
**Health verified** means runtime or route checks passed. **Workflow tested**
means the declared workflow verification passed, not that every possible user
journey was tested. **Running · unverified** does not imply application correctness.
The list response contains compact verification flags, not full build logs or
source manifests. Deployment details retain the complete evidence.

The browser uses same-origin API and WebSocket proxies by default. Docker builds
configure the backend and AI destinations internally. Native frontend hosts can
set `STACKPILOT_BACKEND_INTERNAL_URL` and `STACKPILOT_AI_INTERNAL_URL` when their
services run elsewhere. Explicit public service URLs remain supported. A legacy
loopback override is replaced with same-origin routing when opened from a phone.

Public multi-tenant execution, wider compatibility qualification, remote hardware
and database migration guarantees remain covered by the
[completion plan](stackpilot-completion-plan.md) and
[self-hosting requirements](production-self-host.md).

The environment editor accepts several local env files in one selection. It
merges them with manual entries; later files override matching keys. Imports
are validated together before updating the form, and invalid files preserve
the current entries. Quoted values, `export` assignments, comments, empty
values, and quoted multiline values are supported; variable expressions stay
literal. Limits are ten files, 1 MiB per file, and 1,000 resulting variables.
Imported values use the existing project/environment save flow.
