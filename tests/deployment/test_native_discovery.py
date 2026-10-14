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

    def test_transient_wrapper_download_is_retried(self):
        body = '''if [ ! -f attempted ]; then
touch attempted
echo 'Downloading https://services.gradle.org/distributions/gradle-8.13-bin.zip'
echo 'java.net.SocketTimeoutException: Read timed out'
echo 'at org.gradle.wrapper.Download.downloadInternal'
exit 1
fi
echo 'app:assembleDebug'
'''
        tasks, output = self.discover(body)
        self.assertEqual(tasks, {'app:assembleDebug'})
        self.assertIn('native_wrapper_retry', output)

    def test_compile_error_and_checksum_failure_are_not_retried(self):
        for message in ['Compilation failed', 'Downloading https://example.test/gradle.zip\njava.net.SocketTimeoutException\nat org.gradle.wrapper.Download\nChecksum mismatch']:
            with self.subTest(message=message), self.assertRaises(subprocess.CalledProcessError) as failure:
                # A second execution would succeed, making the expected failure
                # disappear. This catches accidental replay of compiler/integrity errors.
                self.discover("if [ -f attempted ]; then echo 'app:assembleDebug'; exit 0; fi\ntouch attempted\necho '" + message + "'\nexit 3\n")
            self.assertEqual(failure.exception.output.count('Compilation failed') if message=='Compilation failed' else failure.exception.output.count('Checksum mismatch'), 1)

    def test_wrapper_transport_override_restores_exact_project_properties(self):
        from native_build import wrapper_network_settings
        previous = Path.cwd()
        with tempfile.TemporaryDirectory() as directory:
            os.chdir(directory)
            try:
                properties = Path('gradle/wrapper/gradle-wrapper.properties')
                properties.parent.mkdir(parents=True)
                original = b'distributionUrl=https\\://example.test/gradle.zip\r\ndistributionSha256Sum=abc\r\nnetworkTimeout=10000\r\n'
                properties.write_bytes(original)
                with patch.dict(os.environ, {'STACKPILOT_GRADLE_NETWORK_TIMEOUT_MS':'60000'}):
                    with self.assertRaises(RuntimeError):
                        with wrapper_network_settings():
                            self.assertIn('networkTimeout=60000', properties.read_text())
                            self.assertIn('distributionSha256Sum=abc', properties.read_text())
                            raise RuntimeError('Failure must restore settings too')
                self.assertEqual(properties.read_bytes(), original)
            finally:
                os.chdir(previous)
