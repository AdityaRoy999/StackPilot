"""Serve only an immutable artifact directory, never the submitted source tree."""
import hashlib
import html
import http.server
import json
import os
from pathlib import Path
import urllib.parse


def inventory(root):
    root = Path(root).resolve()
    entries = []
    for path in sorted(root.iterdir()):
        if path.is_symlink() or not path.is_file() or path.name.startswith('.') or path.name == 'manifest.json':
            continue
        if path.suffix.lower() not in {'.apk', '.aab', '.zip', '.exe', '.msi', '.dmg', '.deb', '.appimage', '.tar', '.gz', '.whl', '.jar'}:
            continue
        digest = hashlib.sha256()
        with path.open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(chunk)
        entries.append({'name':path.name, 'size':path.stat().st_size, 'sha256':digest.hexdigest()})
    return entries


def make_handler(root):
    root = Path(root).resolve()
    entries = inventory(root)
    if not entries:
        raise RuntimeError('No validated build artifacts: refusing to start a successful preview')
    allowed = {entry['name'] for entry in entries}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
            if path == '/healthz':
                return self.respond(200, json.dumps({'status':'ready', 'scope':'artifact_delivery', 'artifacts':entries}), 'application/json')
            if path == '/':
                links = ''.join(f'<li><a href="/artifacts/{urllib.parse.quote(e["name"])}" download>{html.escape(e["name"])}</a> — {e["size"]:,} bytes<br><small>SHA-256: {e["sha256"]}</small></li>' for e in entries)
                return self.respond(200, '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Application build artifacts</title><style>body{font:16px system-ui;margin:40px auto;padding:0 24px;max-width:780px;color:#182126;background:#f6f8f9}li{margin:24px 0}small{overflow-wrap:anywhere}a{color:#006f78}</style><h1>Build artifacts available</h1><p>Download from this URL on a reachable device. This page confirms artifact delivery; native installation and device workflows require separate verification.</p><ul>'+links+'</ul>', 'text/html; charset=utf-8')
            name = path.removeprefix('/artifacts/')
            if not path.startswith('/artifacts/') or name not in allowed or (root/name).is_symlink():
                return self.respond(404, 'Not found', 'text/plain')
            file = root/name
            self.send_response(200)
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Content-Length', str(file.stat().st_size))
            self.send_header('Content-Disposition', "attachment; filename*=UTF-8''"+urllib.parse.quote(name))
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            with file.open('rb') as stream:
                for chunk in iter(lambda: stream.read(1024*1024), b''):
                    self.wfile.write(chunk)

        def respond(self, status, body, content_type):
            payload = body.encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(payload)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            self.wfile.write(payload)

    return Handler


if __name__ == '__main__':
    http.server.ThreadingHTTPServer(('0.0.0.0', int(os.getenv('PORT','3000'))), make_handler(os.getenv('ARTIFACT_ROOT','/artifacts'))).serve_forever()
