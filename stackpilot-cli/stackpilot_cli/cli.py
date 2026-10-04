import typer
from typing import Optional
from . import __version__
from .ui import console, print_banner
from .commands import (
    run_init,
    run_doctor,
    up_command,
    down_command,
    restart_command,
    status_command,
    logs_command,
    run_chat,
    run_test,
    auth_app,
    project_app,
    env_app,
    deploy_app,
    cluster_app
)

app = typer.Typer(
    name="stackpilot",
    help="StackPilot CLI — setup, browser QA, deployments, and container management",
    add_completion=False,
    no_args_is_help=True
)

def version_callback(value: bool):
    if value:
        console.print(f"[bold cyan]StackPilot CLI[/bold cyan] version [bold]{__version__}[/bold]")
        raise typer.Exit()

@app.callback()
def main(
    version: Optional[bool] = typer.Option(
        None, "--version", "-v", help="Show CLI version", callback=version_callback, is_eager=True
    )
):
    pass

# Top-level primary commands
app.command("init", help="Generate local configuration and select services and an AI provider")(run_init)
app.command("doctor", help="Diagnose environment health, ports, RAM, and Docker status")(run_doctor)
app.command("up", help="Start StackPilot services with modular profiles")(up_command)
app.command("down", help="Stop StackPilot services")(down_command)
app.command("status", help="Show running containers and port status")(status_command)
app.command("ps", help="Alias for 'status'")(status_command)
app.command("restart", help="Restart StackPilot services")(restart_command)
app.command("logs", help="Stream container logs in real time")(logs_command)
app.command("chat", help="Launch interactive terminal AI co-pilot")(run_chat)
app.command("test", help="Run autonomous browser QA crawl against any target website")(run_test)

# Sub-command groups
app.add_typer(auth_app, name="auth")
app.add_typer(project_app, name="project")
app.add_typer(env_app, name="env")
app.add_typer(deploy_app, name="deploy")
app.add_typer(cluster_app, name="cluster")

if __name__ == "__main__":
    app()
