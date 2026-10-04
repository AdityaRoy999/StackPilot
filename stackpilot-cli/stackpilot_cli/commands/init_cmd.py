from pathlib import Path
from typing import Optional
import typer
from rich.prompt import Prompt
from ..config import load_config, save_config
from ..setup import normalize_profile, write_environment
from ..services.docker_service import get_workspace_root
from ..ui import console, print_success, print_error, print_info


def run_init(
    workspace: Optional[Path] = typer.Option(None, "--workspace", help="StackPilot checkout"),
    profile: str = typer.Option("core", "--profile", help="base, core, full, monitoring"),
    provider: str = typer.Option("later", "--provider", help="later, nvidia_nim, openai_compatible"),
    base_url: str = typer.Option("", "--base-url", help="OpenAI-compatible API URL"),
    model: str = typer.Option("", "--model", help="Provider model identifier"),
    domain: str = typer.Option("", "--domain", help="Optional production HTTPS hostname"),
    email: str = typer.Option("", "--email", help="ACME email for production HTTPS"),
    yes: bool = typer.Option(False, "--yes", "-y", help="Generate configuration without prompts; configure AI later"),
):
    root = workspace.resolve() if workspace else get_workspace_root()
    api_key = ""
    try:
        if not yes:
            profile = Prompt.ask("Services", choices=["base", "core", "full", "monitoring"], default=profile)
            provider = Prompt.ask("AI provider (can be configured in dashboard Settings later)",
                                  choices=["later", "nvidia_nim", "openai_compatible"], default=provider)
            if provider == "openai_compatible":
                base_url = base_url or Prompt.ask("API base URL", default="https://api.openai.com/v1")
                model = model or Prompt.ask("Model identifier")
            if provider != "later":
                api_key = Prompt.ask("API key (leave empty for a local provider)", password=True, default="")
        profile = normalize_profile(profile)
        path, created = write_environment(root, provider=provider, base_url=base_url, model=model,
                                          api_key=api_key, domain=domain, email=email)
        if not created:
            # Read only routing metadata; credentials never enter the CLI config.
            metadata = {}
            for line in path.read_text(encoding="utf-8").splitlines():
                key, separator, value = line.partition("=")
                if separator and key.strip() in {"STACKPILOT_ENV", "STACKPILOT_DOMAIN"}:
                    metadata[key.strip()] = value.strip().strip("\"'")
            existing_domain = metadata.get("STACKPILOT_DOMAIN", "")
            if domain and existing_domain != domain:
                raise ValueError("Existing .env has a different hostname. Update its HTTPS configuration explicitly before selecting production mode.")
            domain = existing_domain if metadata.get("STACKPILOT_ENV") == "production" else ""
        config = load_config()
        config.update(default_profile=profile, workspace=str(root), production=bool(domain))
        if domain:
            config.update(backend_url=f"https://{domain}", frontend_url=f"https://{domain}")
        save_config(config)
    except (OSError, ValueError) as error:
        print_error(str(error))
        raise typer.Exit(1)
    print_success(f"{'Created' if created else 'Preserved existing'} {path}")
    if not created:
        print_info("Existing credentials and provider settings were preserved; use dashboard Settings to change AI.")
    console.print(f"Run [bold]stackpilot up --profile {profile} --build[/bold], then open {config['frontend_url']}.")
    print_info("Create your account and configure AI in Settings. Advanced environment variables are optional.")
