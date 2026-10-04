"""Request-local execution events; independent of planner turn boundaries."""
from contextvars import ContextVar

progress_sink = ContextVar('tool_progress_sink', default=None)
leased_session = ContextVar('browser_tool_lease', default=None)


async def publish_step(name, arguments, result):
    sink = progress_sink.get()
    if sink is not None:
        await sink({'type': 'tool_step', 'name': name, 'arguments': arguments, 'result': result})


async def snapshot_step(session, name, arguments, result, *, include_frame=True):
    if progress_sink.get() is None:
        return
    # Capture after the action, before the next one can change the page.
    # DOM-only workflows already publish verified structured state. Respect
    # their frame opt-out instead of competing with live video for CDP time.
    frame = await session.capture_screenshot(quality=45, use_cache=False) if include_frame else None
    await publish_step(name, arguments, {**result, 'url': session.current_url,
        'title': session.page_title, 'frame': f'data:image/jpeg;base64,{frame}' if frame else ''})
