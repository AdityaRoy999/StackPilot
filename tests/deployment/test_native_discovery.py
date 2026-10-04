"""Real child-process checks for native task discovery and bounded failure."""
import contextlib
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'deployment-runtime'))
from native_build import gradle_tasks


@unittest.skipIf(os.name == 'nt', 'Native builders execute on Linux workers')
class NativeDiscovery(unittest.TestCase):
    def discover(self, body, timeout='10'):
        previous = Path.cwd()
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, 'gradlew').write_text('#!/bin/sh\n' + body)
            os.chdir(directory)
            try:
                with patch.dict(os.environ, {'BUILD_STAGE_TIMEOUT': timeout}), contextlib.redirect_stdout(io.StringIO()) as output:
                    tasks = gradle_tasks()
                return tasks, output.getvalue()
            finally:
                os.chdir(previous)

    def test_task_discovery_streams_progress_and_parses_qualified_tasks(self):
        tasks, output = self.discover("echo 'Downloading dependencies...'\necho 'app:assembleDebug'\necho 'app:testDebugUnitTest - Runs tests'\n")
        self.assertEqual(tasks, {'app:assembleDebug', 'app:testDebugUnitTest'})
        self.assertIn('Downloading dependencies...', output)

    def test_failed_discovery_cannot_start_build(self):
        with self.assertRaises(subprocess.CalledProcessError):
            self.discover("echo 'Plugin resolution failed'\nexit 7\n")

    def test_stalled_discovery_kills_child_process_group(self):
        with self.assertRaises(TimeoutError):
            self.discover('sleep 30\n', timeout='1')
