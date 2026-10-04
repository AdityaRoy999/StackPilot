"""Terminate the preview when the application/display dies; never show an empty desktop as ready."""
import http.server
import json
import os
from pathlib import Path
import signal
import re
import subprocess
import time
import urllib.request


def visible_windows():
    # wmctrl -l returned an empty list for a real, mapped Tk window during
    # qualification. Read the window manager's client IDs and actual X map
    # state instead of depending on its formatted text listing.
    clients=subprocess.run(['xprop','-root','_NET_CLIENT_LIST'],capture_output=True,text=True,timeout=2)
    if clients.returncode or len(clients.stdout)>65536:return []
    visible=[]
    for window in re.findall(r'0x[0-9a-fA-F]+',clients.stdout)[:32]:
        observed=subprocess.run(['xwininfo','-id',window],capture_output=True,text=True,timeout=2)
        if observed.returncode or 'Map State: IsViewable' not in observed.stdout or 'Override Redirect State: yes' in observed.stdout:continue
        width=re.search(r'Width:\s*(\d+)',observed.stdout)
        height=re.search(r'Height:\s*(\d+)',observed.stdout)
        if width and height and int(width[1])>=64 and int(height[1])>=64:visible.append(window)
    return visible


def main():
    app = json.loads(os.environ['STACKPILOT_APP_COMMAND'])
    if not isinstance(app, list) or not app:
        raise RuntimeError('An explicit application launch command is required')
    os.environ['DISPLAY'] = ':99'
    children = []
    def stop(*_):
        for child in reversed(children):
            if child.poll() is None:
                child.terminate()
        for child in children:
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
    signal.signal(signal.SIGTERM, stop)
    try:
        children.append(subprocess.Popen(['Xvfb',':99','-screen','0','1280x720x24','-ac']))
        deadline = time.monotonic()+20
        while not Path('/tmp/.X11-unix/X99').exists():
            if children[0].poll() is not None or time.monotonic()>deadline:
                raise RuntimeError('Virtual display failed to start')
            time.sleep(.1)
        children.append(subprocess.Popen(['openbox']))
        children.append(subprocess.Popen(['x11vnc','-display',':99','-forever','-shared','-nopw','-rfbport','5900','-listen','127.0.0.1']))
        application = subprocess.Popen(app)
        children.append(application)
        # A real visible application window is required before serving noVNC.
        deadline = time.monotonic()+60
        while True:
            if application.poll() is not None:
                raise RuntimeError('Application exited before preview was ready')
            windows = visible_windows()
            if windows:
                break
            if time.monotonic()>deadline:
                raise RuntimeError('Application did not create a visible window')
            time.sleep(.2)
        # noVNC distributions do not consistently ship an index page. A real
        # viewer must open at the preview root, rather than a directory listing.
        import shutil
        web=Path('/tmp/stackpilot-novnc')
        shutil.copytree('/usr/share/novnc',web,dirs_exist_ok=True)
        (web/'index.html').write_text('<!doctype html><meta http-equiv="refresh" content="0;url=vnc.html?autoconnect=1&resize=scale"><title>Application preview</title>')
        children.append(subprocess.Popen(['websockify','--web',str(web),'0.0.0.0:3000','127.0.0.1:5900']))
        while all(child.poll() is None for child in children):
            time.sleep(.25)
        raise RuntimeError('Application or preview dependency stopped')
    finally:
        stop()


if __name__ == '__main__':
    main()
