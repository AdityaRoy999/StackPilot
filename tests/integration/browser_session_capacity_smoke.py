"""Worker capacity recovery using fake owned sessions; no Chrome or AI calls."""
import asyncio
import os
import time
from unittest.mock import patch
from app import browser_driver


class Session:
    def __init__(self, session_id, target_url='about:blank', sandbox_mode='local'):
        self.session_id=session_id; self.current_url=target_url
        self.is_connected=True; self.listeners=set(); self.last_used=time.monotonic()
        self.closed=False; self.h264_active=False; self._video_needs_keyframe=False
    async def connect(self): self.is_connected=True
    async def close(self): self.closed=True; self.is_connected=False
    async def send_command(self, *args): return {}


async def main():
    with patch.dict(os.environ, {'BROWSER_MAX_SESSIONS':'2'}), patch.object(browser_driver,'BrowserSession',Session):
        manager=browser_driver.BrowserManager()
        dead=Session('owned-disconnected'); dead.is_connected=False
        viewed=Session('viewed'); viewed.listeners.add(object())
        manager.sessions.update({dead.session_id:dead,viewed.session_id:viewed})
        created=await manager.get_or_create_session('new')
        assert dead.closed and created.is_connected and not viewed.closed
        assert set(manager.sessions)=={'viewed','new'}
        try: await manager.get_or_create_session('over-capacity')
        except RuntimeError as exc: assert 'capacity' in str(exc).lower()
        else: raise AssertionError('Capacity was exceeded')
        assert set(manager.sessions)=={'viewed','new'} and not viewed.closed
        busy=Session('busy-disconnected'); busy.is_connected=False
        manager.sessions={busy.session_id:busy}; manager.busy_sessions.add(busy.session_id)
        await manager.reap_idle()
        assert not busy.closed and busy.session_id in manager.sessions
    print('BROWSER_SESSION_CAPACITY_PASS disconnected_slots_recovered=True viewed_and_busy_sessions_preserved=True capacity_remains_enforced=True')


if __name__=='__main__': asyncio.run(main())
