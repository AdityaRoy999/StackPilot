"""Backward-compatible entry point for the complete paired phone platform test.

Copy remote_platform_live_smoke.py and its helper scripts alongside this file
when running inside ai-service. The historical chat-only gateway is superseded.
"""
import asyncio
from remote_platform_live_smoke import main

if __name__ == "__main__":
    asyncio.run(main())
