"""The two pinned SSH connections fail and stop as one service (no network)."""
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
import unittest


class RemoteTunnelLifecycleTests(unittest.TestCase):
    def setUp(self):
        source = Path('/tmp/remote-browser-tunnel-entrypoint.sh')
        if not source.exists():
            source = Path(__file__).resolve().parents[2] / 'browser-sandbox/ssh-tunnel/entrypoint.sh'
        if os.name != 'posix' or not source.exists():
            self.skipTest('Run in Linux with the tunnel entrypoint mounted in /tmp.')
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        keys = self.root / 'keys'
        keys.mkdir()
        for name in ('id_ed25519', 'known_hosts'):
            (keys / name).write_text('owned fake transport fixture')
        self.entry = self.root / 'entrypoint.sh'
        # Only relocate fixed filesystem paths for this isolated test. Run the
        # production process/exit/signal logic unchanged with a fake SSH binary.
        self.entry.write_text(source.read_text().replace('/run/remote-browser-ssh', str(keys)))
        fake = self.root / 'ssh'
        fake.write_text('''#!/bin/sh
port=
for arg in "$@"; do
  case "$arg" in
    0.0.0.0:9222:*) port=cdp ;;
    0.0.0.0:8099:*) port=media ;;
  esac
done
test -n "$port" || exit 45
printf '%s\\n' "$@" > "$FAKE_TUNNEL_DIR/$port.args"
echo $$ > "$FAKE_TUNNEL_DIR/$port.pid"
trap 'echo stopped > "$FAKE_TUNNEL_DIR/$port.stopped"; exit 0' TERM INT
if [ "$FAIL_TUNNEL" = "$port" ]; then sleep .2; exit 42; fi
while true; do sleep .1; done
''')
        fake.chmod(0o755)

    def run_tunnel(self, failed=''):
        env = dict(os.environ, PATH=str(self.root)+':'+os.environ['PATH'],
            REMOTE_BROWSER_SSH_HOST='fixture.invalid', REMOTE_BROWSER_SSH_USER='fixture',
            FAKE_TUNNEL_DIR=str(self.root), FAIL_TUNNEL=failed)
        process = subprocess.Popen(['/bin/sh', str(self.entry)], env=env,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        def stop():
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=5)
        self.addCleanup(stop)
        deadline = time.monotonic()+3
        while not all((self.root / (port+'.pid')).exists() for port in ('cdp', 'media')):
            if time.monotonic() > deadline:
                self.fail('Both independent SSH connections must start.')
            time.sleep(.01)
        args = [(self.root / (port+'.args')).read_text() for port in ('cdp', 'media')]
        self.assertIn('0.0.0.0:9222:', args[0])
        self.assertNotIn('0.0.0.0:8099:', args[0])
        self.assertIn('0.0.0.0:8099:', args[1])
        for value in args:
            self.assertIn('StrictHostKeyChecking=yes', value)
            self.assertIn('ControlMaster=no', value)
            self.assertIn('Compression=no', value)
        return process

    def test_cdp_failure_stops_media_and_fails_service(self):
        process = self.run_tunnel('cdp')
        self.assertEqual(process.wait(timeout=5), 1)
        self.assertTrue((self.root / 'media.stopped').exists())

    def test_media_failure_stops_cdp_and_fails_service(self):
        process = self.run_tunnel('media')
        self.assertEqual(process.wait(timeout=5), 1)
        self.assertTrue((self.root / 'cdp.stopped').exists())

    def test_service_termination_stops_both_connections(self):
        process = self.run_tunnel()
        process.terminate()
        self.assertEqual(process.wait(timeout=5), 143)
        self.assertTrue((self.root / 'cdp.stopped').exists())
        self.assertTrue((self.root / 'media.stopped').exists())
