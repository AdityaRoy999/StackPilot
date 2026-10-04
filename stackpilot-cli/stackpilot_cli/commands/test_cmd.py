import time
import webbrowser
from typing import Any, Dict, List, Optional
import typer
from rich.live import Live
from rich.table import Table
from rich.markdown import Markdown
from rich.panel import Panel
from ..ui import console, print_banner, print_info, print_success, print_error, print_warning, render_table, print_step
from ..services.ai_client import AIClient
from ..permissions import confirm_step
from ..config import load_config

def run_test(
    url: str = typer.Argument(..., help="The target URL to test (e.g. https://example.com or http://localhost:3000)"),
    depth: int = typer.Option(2, "--depth", "-d", min=1, max=10, help="Max crawl depth for subpages"),
    model: Optional[str] = typer.Option(None, "--model", "-m", help="AI Model override"),
    session_id: Optional[str] = typer.Option(None, "--session-id", "-s", help="Custom session ID"),
    open_browser: bool = typer.Option(False, "--open", "-o", help="Automatically open web playback and AI canvas in default browser"),
    sandbox: str = typer.Option("local", "--sandbox", help="local, remote, host"),
):
    print_banner(f"Autonomous Browser QA Testing")
    if sandbox not in {"local", "remote", "host"}:
        print_error("Choose --sandbox local, remote, or host")
        raise typer.Exit(1)
    
    if not url.startswith("http://") and not url.startswith("https://"):
        url = "https://" + url

    print_step("🌐", "Target Website", url)
    print_step("🤖", "Autonomous Mode", f"APV Navigation Crawler (Depth: {depth})")

    client = AIClient(timeout=300)
    health = client.check_health()
    if health.get("status") != "ok":
        print_error(f"AI health check failed: {health.get('error')}. Start StackPilot and run stackpilot auth login.")
        raise typer.Exit(1)

    try:
        sess_id = session_id or client.create_session()
    except Exception as error:
        print_error(str(error))
        raise typer.Exit(1)
    playback_url = f"{load_config()['frontend_url']}/dashboard/ai?session_id={sess_id}"
    test_prompt = (
        f"Perform an exhaustive autonomous QA audit of the website at {url}. "
        f"Discover interactive elements, test navigation and safe form validation; request a specific permission before critical submissions. "
        f"explore subpages up to depth {depth}, monitor console errors, and verify responsiveness."
    )

    console.print("\n[bold cyan]─── Live Action & Perception Stream ──────────────────────────────────────────[/bold cyan]\n")
    
    start_time = time.time()
    passed_cases = 0
    failed_cases = 0
    total_actions = 0
    console_errors = 0
    final_markdown_report = ""
    outcome = "incomplete"
    execution_error = False

    for ev in client.reviewed_stream(
        confirm=confirm_step,
        message=test_prompt,
        custom_url=url,
        model=model,
        session_id=sess_id,
        workflow_type="browser_test",
        sandbox_mode=sandbox,
    ):
        ev_type = ev.get("type")
        if ev_type == "tool_call":
            total_actions += 1
            name = ev.get("name", "")
            args = ev.get("arguments", {})
            if name == "browser_open_live_session":
                print_step("🚀", "Browser session requested", args.get("url", url))
            elif name == "browser_interact":
                action = args.get("action", "interact")
                target = args.get("label") or args.get("element_id") or args.get("text") or "element"
                if action == "click":
                    print_step("🖱️", f"Click requested [{target}]")
                elif action == "type":
                    print_step("⌨️", f"Input requested [{target}]")
                elif action == "scroll":
                    print_step("📜", f"Scroll requested (delta: {args.get('delta_y', 300)}px)")
                else:
                    print_step("⚡", f"Action {action} on [{target}]")
            else:
                print_step("🔧", f"Tool {name}", str(args)[:60])

        elif ev_type == "tool_result":
            res = ev.get("result", {})
            if isinstance(res, dict):
                if res.get("status") in {"passed", "ok", "success"}:
                    passed_cases += 1
                elif res.get("status") in {"failed", "error"} or res.get("ok") is False:
                    failed_cases += 1
                if res.get("console_errors_count", 0) > 0:
                    console_errors += res["console_errors_count"]
                    print_warning(f"Detected {res['console_errors_count']} browser console error(s)")

        elif ev_type == "content":
            final_markdown_report += ev.get("delta", "")
        elif ev_type == "error":
            print_error(f"Execution Error: {ev.get('error', '')}")
            execution_error = True
            outcome = "error"
            break

        elif ev_type == "done":
            final_markdown_report = ev.get("content") or final_markdown_report
            outcome = "stopped" if ev.get("stopped") else ev.get("status", "completed")

    elapsed = time.time() - start_time
    console.print(f"\n[bold cyan]─── Test run: {outcome} ───────────────────────────────────────────[/bold cyan]\n")

    # 1. Print Comprehensive Markdown Report first (if available) so it doesn't push the summary table away
    if final_markdown_report:
        console.print("\n[bold magenta]📋 Comprehensive Audit Report:[/bold magenta]\n")
        console.print(Markdown(final_markdown_report))
        console.print("")

    # 2. Render Final Scorecard Table at the very bottom
    summary_rows = [
        ["Target URL", url],
        ["Duration", f"{elapsed:.1f} seconds"],
        ["Outcome", outcome],
        ["Tool Calls Requested", str(total_actions)],
        ["Successful Tool Results", str(passed_cases)],
        ["Failed Tool Results", str(failed_cases)],
        ["Console Errors Caught", f"⚠️ {console_errors}" if console_errors > 0 else "✅ 0"],
        ["Session ID", sess_id],
        ["Web Playback URL", playback_url]
    ]
    render_table("QA Audit Scorecard", ["Metric", "Value"], summary_rows)

    # 3. Print clickable Web Playback Panel
    console.print(
        Panel.fit(
            f"[bold green]▶ Live Canvas & Playback Available:[/bold green]\n"
            f"[bold cyan underline]{playback_url}[/bold cyan underline]\n\n"
            f"[dim]Open this link to view the live browser and review verified actions.[/dim]",
            title="[bold yellow]🌐 Web Playback Link[/bold yellow]",
            border_style="cyan"
        )
    )

    if open_browser:
        print_info(f"Opening web playback in default browser...")
        webbrowser.open(playback_url)
    if execution_error or failed_cases:
        raise typer.Exit(1)
    if outcome != "completed":
        print_warning("This audit remains incomplete; review the session before claiming verification.")
        raise typer.Exit(2)
