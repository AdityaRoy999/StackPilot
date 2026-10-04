from typing import Optional
import typer
from rich.spinner import Spinner
from rich.live import Live
from ..ui import console, print_banner, print_success, print_error, print_info, render_table
from ..config import load_config
from ..services.docker_service import (
    run_compose_up,
    run_compose_down,
    get_container_status,
    stream_service_logs,
    is_docker_running,
    restart_services
)

def up_command(
    profile: Optional[str] = typer.Option(None, "--profile", "-p", help="Profile to run: base, core, full, or monitoring"),
    detach: bool = typer.Option(True, "--detach/--no-detach", "-d", help="Run containers in the background"),
    build: bool = typer.Option(False, "--build", "-b", help="Rebuild container images before starting")
):
    if not is_docker_running():
        print_error("Docker is not running. Please start Docker Desktop or the dockerd service.")
        raise typer.Exit(1)

    cfg = load_config()
    selected_profile = profile or cfg.get("default_profile", "core")
    print_info(f"Starting StackPilot services (Profile: [bold cyan]{selected_profile}[/bold cyan])...")

    with console.status(f"[bold cyan]Launching profile '{selected_profile}'...[/bold cyan]", spinner="dots"):
        ok, out = run_compose_up(profile=selected_profile, detach=detach, build=build)

    if ok:
        print_success(f"StackPilot profile '{selected_profile}' started successfully!")
        status_command()
    else:
        print_error(f"Failed to start services:\n{out}")
        raise typer.Exit(1)

def down_command(
    volumes: bool = typer.Option(False, "--volumes", "-v", help="Remove data volumes too")
):
    print_info("Stopping StackPilot services...")
    with console.status("[bold yellow]Tearing down containers...[/bold yellow]", spinner="dots"):
        ok, out = run_compose_down(volumes=volumes)

    if ok:
        print_success("StackPilot services stopped.")
    else:
        print_error(f"Failed to stop services:\n{out}")
        raise typer.Exit(1)

def restart_command(
    service: Optional[str] = typer.Argument(None, help="Optional specific service to restart")
):
    print_info(f"Restarting {'all services' if not service else service}...")
    ok, output = restart_services(service)
    if not ok:
        print_error(output)
        raise typer.Exit(1)
    print_success("Restart complete.")

def status_command():
    containers = get_container_status()
    if not containers:
        print_info("No StackPilot containers found. Run [bold cyan]stackpilot up[/bold cyan] to boot.")
        return

    rows = []
    for c in containers:
        status_icon = "🟢" if "Up" in c["status"] else "🔴"
        rows.append([
            c["name"],
            c["image"],
            f"{status_icon} {c['status']}",
            c["ports"][:40]
        ])

    render_table("StackPilot Running Containers", ["Container Name", "Image", "Status", "Ports"], rows)

def logs_command(
    service: Optional[str] = typer.Argument(None, help="Service name (e.g. backend, ai-service, browser-sandbox)"),
    follow: bool = typer.Option(True, "--follow/--no-follow", "-f", help="Follow live output")
):
    print_info(f"Streaming logs for [bold cyan]{service or 'all services'}[/bold cyan] (Press Ctrl+C to exit)...")
    stream_service_logs(service=service, follow=follow)
