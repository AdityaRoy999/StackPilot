#!/usr/bin/env python3
"""Generate only the essential configuration without installing CLI dependencies."""
import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "stackpilot-cli"))
from stackpilot_cli.setup import write_environment

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--domain", default="", help="Production HTTPS hostname")
    parser.add_argument("--email", default="", help="ACME contact email")
    parser.add_argument("--workspace", type=Path, default=ROOT)
    options = parser.parse_args()
    try:
        path, created = write_environment(options.workspace, domain=options.domain, email=options.email)
    except (ValueError, OSError) as error:
        parser.exit(1, f"Configuration failed: {error}\n")
    print(f"{'Created' if created else 'Preserved existing'} {path}. Configure AI in dashboard Settings.")
