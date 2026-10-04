from typing import Dict, List, Optional
import typer
from rich.live import Live
from rich.markdown import Markdown
from rich.panel import Panel
from rich.text import Text
from prompt_toolkit import PromptSession
from prompt_toolkit.history import InMemoryHistory
from ..ui import console, print_banner, print_info, print_error, print_warning
from ..services.ai_client import AIClient
from ..permissions import confirm_step

def run_chat(
    model: Optional[str] = typer.Option(None, "--model", "-m", help="Model name override"),
    session_id: Optional[str] = typer.Option(None, "--session-id", "-s", help="Resume an existing session ID"),
    sandbox: str = typer.Option("local", "--sandbox", help="local, remote, host"),
    model_mode: str = typer.Option("fast", "--model-mode", help="fast or thinking"),
):
    print_banner("Interactive AI Co-Pilot Console")
    if sandbox not in {"local", "remote", "host"} or model_mode not in {"fast", "thinking"}:
        print_error("Choose local/remote/host for --sandbox and fast/thinking for --model-mode")
        raise typer.Exit(1)
    console.print("[dim]Type your prompt and press Enter. Special commands: [bold cyan]/exit[/bold cyan], [bold cyan]/clear[/bold cyan], [bold cyan]/stop[/bold cyan][/dim]\n")

    client = AIClient()
    health = client.check_health()
    if health.get("status") != "ok":
        print_error(f"AI health check failed: {health.get('error')}. Start StackPilot and run stackpilot auth login.")
        raise typer.Exit(1)

    try:
        sess_id = session_id or client.create_session()
    except Exception as error:
        print_error(str(error))
        raise typer.Exit(1)
    history: List[Dict[str, str]] = []
    prompt_session = PromptSession(history=InMemoryHistory())

    while True:
        try:
            user_input = prompt_session.prompt("╭─ [You]\n╰─> ").strip()
        except (KeyboardInterrupt, EOFError):
            console.print("\n[dim]Session closed.[/dim]")
            break

        if not user_input:
            continue

        if user_input in {"/exit", "/quit", "exit", "quit"}:
            console.print("[dim]Goodbye![/dim]")
            break

        if user_input == "/clear":
            console.clear()
            print_banner("Interactive AI Co-Pilot Console")
            continue

        if user_input == "/stop":
            client.stop_agent(session_id=sess_id)
            print_warning("Sent stop signal to agent.")
            continue

        # Add user message to history
        history.append({"role": "user", "content": user_input})

        console.print("\n[bold cyan]╭─ [StackPilot AI][/bold cyan]")
        assembled_content: List[str] = []
        assembled_reasoning: List[str] = []
        last_tool_call: Optional[str] = None

        with Live(console=console, refresh_per_second=10) as live:
            for ev in client.reviewed_stream(
                confirm=confirm_step,
                message=user_input,
                history=history,
                model=model,
                session_id=sess_id,
                workflow_type="agent_chat",
                sandbox_mode=sandbox,
                model_mode=model_mode,
            ):
                ev_type = ev.get("type")
                if ev_type == "content":
                    delta = ev.get("delta", "")
                    assembled_content.append(delta)
                    full_text = "".join(assembled_content)
                    live.update(Markdown(full_text))
                elif ev_type == "reasoning":
                    delta = ev.get("delta", "")
                    assembled_reasoning.append(delta)
                elif ev_type == "tool_call":
                    name = ev.get("name", "")
                    args = ev.get("arguments", {})
                    last_tool_call = name
                    tool_text = f"[bold yellow]🔧 Executing tool:[/bold yellow] [bold]{name}[/bold]"
                    live.update(Text.from_markup(f"{tool_text}\n" + "".join(assembled_content)))
                elif ev_type == "tool_result":
                    tool_res_text = f"[bold green]✔ Completed tool:[/bold green] [dim]{last_tool_call}[/dim]"
                    live.update(Text.from_markup(f"{tool_res_text}\n" + "".join(assembled_content)))
                elif ev_type == "error":
                    live.update(Text.from_markup(f"[bold red]Error:[/bold red] {ev.get('error', '')}"))
                    break
                elif ev_type == "done":
                    continue

        console.print("[bold cyan]╰──────────────────────────────────────────[/bold cyan]\n")
        full_reply = "".join(assembled_content).strip()
        if full_reply:
            history.append({"role": "assistant", "content": full_reply})
