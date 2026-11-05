#!/usr/bin/env python3
"""
Incident-Sentinel: Interactive Live War Room Simulation.
Demonstrates the full autonomous SRE triage, diagnosis, human approval gate,
and deployment rollback on Switch in high-definition terminal output.
"""

import sys
import time
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.text import Text
from rich.layout import Layout
from rich.live import Live

console = Console()

def print_separator():
    console.print("[dim]─" * 70 + "[/dim]")

def run_simulation(auto_approve: bool = True):
    console.clear()
    
    # 1. Header
    header = Panel(
        Text("INCIDENT-SENTINEL 🛡️  |  Autonomous SRE Incident War Room on Switch\n"
             "Room: #incident-war-room  |  Platform: Mattermost/Slack  |  Active: @triager, @remediator, @operator",
             justify="center", style="bold cyan"),
        border_style="cyan"
    )
    console.print(header)
    time.sleep(1)

    # 2. Outage Alert
    alert_box = Panel(
        "[bold red]🚨 CRITICAL ALERT TRIGGERED: HIGH ERROR RATE DETECTED[/bold red]\n"
        "[white]• Service: [bold yellow]cart-service[/bold yellow] (Production APAC)\n"
        "• Target: [bold yellow]/api/v1/checkout[/bold yellow]\n"
        "• Condition: HTTP 500 error rate exceeded 45.0% threshold (Current: 48.7%)\n"
        "• Time: 09:42:10 UTC[/white]",
        title="[red]PagerDuty / Telemetry Ingestion[/red]",
        border_style="red"
    )
    console.print(alert_box)
    time.sleep(1.5)

    # 3. Human On-Call Callout
    console.print("\n[bold white]👤 SRE-Lead (Human):[/bold white] [yellow]@sentinel-triager checkout is failing since 09:40. Can you investigate root cause?[/yellow]")
    time.sleep(1.2)

    # 4. Agent 1: Triager
    with console.status("[bold cyan]@sentinel-triager querying telemetry & deployment logs via MCP...[/bold cyan]"):
        time.sleep(1.5)

    triager_report = Table(title="🔍 Incident Telemetry Diagnosis (@sentinel-triager)", border_style="cyan")
    triager_report.add_column("Metric", style="bold white")
    triager_report.add_column("Observed Value", style="bold red")
    triager_report.add_column("Normal Baseline", style="green")

    triager_report.add_row("Status", "DEGRADED (P1)", "HEALTHY")
    triager_report.add_row("HTTP 500 Error Rate", "48.7% (1,420 errors/5m)", "< 0.01%")
    triager_report.add_row("p99 Latency", "3,840.5 ms", "28.0 ms")
    triager_report.add_row("Culprit Deploy", "v2.14.0 (Commit 8f3a91b)", "v2.13.2 (Commit 4e1c07a)")
    triager_report.add_row("Root Cause", "NullPointerException: CartSession.getDiscount()", "Clean")

    console.print(triager_report)
    console.print("[cyan][bold]@sentinel-triager:[/bold] Diagnosis complete. Culprit deployment is [bold yellow]v2.14.0[/bold yellow]. Handing off to [bold]@sentinel-remediator[/bold] to evaluate rollback blast radius.[/cyan]")
    time.sleep(1.5)

    # 5. Agent 2: Remediator & Human Approval Gate
    with console.status("[bold magenta]@sentinel-remediator analyzing git diff and blast radius...[/bold magenta]"):
        time.sleep(1.5)

    approval_card = Panel(
        "[bold yellow]⚠️ HUMAN-IN-THE-LOOP APPROVAL REQUIRED FOR ROLLBACK[/bold yellow]\n\n"
        "[white]• Proposed Action: [bold green]Rollback deployment[/bold green] [yellow]v2.14.0 ➔ v2.13.2[/yellow]\n"
        "• Impacted Pods: [cyan]cart-service-prod-01..12[/cyan] (100% traffic shift)\n"
        "• Schema Compatibility: [bold green]PASS[/bold green] (v2.13.2 DB migration is fully backwards-compatible)\n"
        "• Estimated Recovery Time: [bold green]< 45 seconds[/bold green]\n\n"
        "[bold red]Safety Invariant:[/bold red] Destructive actions require explicit human sign-off from on-call engineer.\n"
        "[bold white]Action:[/bold white] Reply [bold green]'APPROVE'[/bold green] to authorize execution or [bold red]'REJECT'[/bold red] to cancel.[/white]",
        title="[magenta]Mitigation Gate (@sentinel-remediator)[/magenta]",
        border_style="magenta"
    )
    console.print(approval_card)
    time.sleep(1)

    # 6. Human Sign-Off
    if not auto_approve:
        user_input = console.input("\n[bold green]Enter decision (APPROVE / REJECT): [/bold green]")
    else:
        console.print("\n[bold white]👤 Ronit Gupta (On-Call SRE):[/bold white] [bold green]APPROVE[/bold green]")
        user_input = "APPROVE"
    time.sleep(1)

    if user_input.strip().upper() != "APPROVE":
        console.print("[bold red]❌ Rollback aborted by engineer.[/bold red]")
        return

    # 7. Agent 3: Operator Execution & Synthetic Probes
    console.print("\n[bold green]@sentinel-operator:[/bold green] Authorization verified. Executing deployment rollback...")
    with console.status("[bold green]Executing rollback: shifting traffic to v2.13.2...[/bold green]"):
        time.sleep(1.8)

    # Health Verification Probes
    probes_table = Table(title="🩺 Synthetic Health & Verification Probes (@sentinel-operator)", border_style="green")
    probes_table.add_column("Probe ID", style="dim")
    probes_table.add_column("Endpoint", style="bold white")
    probes_table.add_column("Response", style="bold green")
    probes_table.add_column("Latency", style="cyan")

    probes = [
        ("PRB-01", "/api/v1/cart/session", "HTTP 200 OK", "18.2 ms"),
        ("PRB-02", "/api/v1/checkout/calculate", "HTTP 200 OK", "22.4 ms"),
        ("PRB-03", "/api/v1/checkout/payment", "HTTP 200 OK", "26.1 ms"),
        ("PRB-04", "/api/v1/inventory/reserve", "HTTP 200 OK", "19.5 ms"),
    ]
    for pid, ep, res, lat in probes:
        probes_table.add_row(pid, ep, res, lat)

    console.print(probes_table)
    time.sleep(1)

    # 8. Resolution Banner
    success_box = Panel(
        "[bold green]🎉 INCIDENT DECLARED RESOLVED — SYSTEM OPERATIONAL[/bold green]\n"
        "[white]• Current Version: [bold green]v2.13.2[/bold green] (Stable)\n"
        "• Error Rate: [bold green]0.0%[/bold green] (All pods healthy)\n"
        "• p99 Latency: [bold green]24.5 ms[/bold green]\n"
        "• Total Outage Duration: [bold green]2 minutes, 48 seconds[/bold green] (MTTR cut by 93%)\n"
        "• Post-Mortem Report: Compiled and saved to [bold cyan]docs/postmortems/INC-8924.md[/bold cyan][/white]",
        title="[green]Recovery Summary[/green]",
        border_style="green"
    )
    console.print(success_box)
    console.print("\n[dim]✨ Simulation complete. Powered by Switch Agent Rooms.[/dim]")

if __name__ == "__main__":
    run_simulation(auto_approve=True)
