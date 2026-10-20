# Documentation

| Guide | Contents |
| --- | --- |
| [Quickstart](quickstart.md) | Local installation, service profiles and first account |
| [Guided setup](guided-setup.md) | Downloadable launchers, first launch, real AI connection test, and conservative local updates |
| [Configuration](configuration.md) | Generated secrets, AI configuration and advanced settings |
| [Architecture](architecture.md) | Control plane, data storage and runtime services |
| [Deployment workflows](deployment-workflows.md) | Project sources, builds and runtime delivery |
| [Project stack persistence](project-stack-persistence.md) | Saved source inspection, database snapshots and refresh behavior |
| [Docker](docker.md) | Local container operations |
| [Production self-hosting](production-self-host.md) | HTTPS, backups, privileges and updates |
| [Cluster management](production-cluster-management.md) | Kubernetes provisioning and runtime prerequisites |
| [AI agent](ai-agent.md) | Providers, task execution and approval boundaries |
| [Browser streaming](browser-streaming-validation.md) | Transport, performance measurements and limitations |
| [Page synchronization](browser-page-synchronization.md) | Browser observations and control ownership |
| [Browser agent qualification](browser-agent-reliability-2026-10-17.md) | Reproduced failures, fixes, six public workflows and measured limits |
| [CPU decision models](browser-decision-model-training.md) | Candidate ranking, data sources, licensing and training approach |
| [MCP integration](mcp-ide-agents.md) | IDE tools and scopes |
| [GitHub integration](github-app.md) | App installation and webhooks |
| [Environments and CI](environments-ci.md) | Branch mapping and deployment gates |
| [Operations](operations.md) | Logs, monitoring, cleanup and recovery |
| [Remote tunnel startup](remote-tunnel-startup-2026-10-15.md) | Asynchronous startup, status and connection recovery |
| [Project exposure](project-tunnel-exposure-2026-10-15.md) | Runtime URL selection, tunnel state and public exposure |
| [Windows connections](windows-connection-setup.md) | VM access, host probing and native-worker limits |
| [RDP desktops](rdp-connections.md) | Saved desktops, imported RDP files and in-platform access |
| [Security](security.md) | Trust boundaries and secret handling |
| [Troubleshooting](troubleshooting.md) | Diagnosis and recovery |
| [Completion plan](stackpilot-completion-plan.md) | Deferred work and repository support limitations |

CLI commands are documented in [stackpilot-cli](../stackpilot-cli/README.md). Regression fixtures belong in `tests/`; generated probe output belongs in ignored `tests/artifacts/`. Superseded audit reports and screenshots are retained in Git history instead of the working tree.
