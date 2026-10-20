import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from stackpilot_cli.local_sources import host_filesystems, local_sources_override


class LocalSourcesTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def test_all_drives_are_mounted_readonly_only_in_backend(self):
        drives = [("C:/", "/app/host-drives/c", "C:"), ("D:/", "/app/host-drives/d", "D:")]
        with patch("stackpilot_cli.local_sources.host_filesystems", return_value=drives):
            path = local_sources_override(self.root)
            before = path.stat().st_mtime_ns
            self.assertEqual(local_sources_override(self.root).stat().st_mtime_ns, before)
        services = json.loads(path.read_text())["services"]
        self.assertEqual(list(services), ["backend"])
        mounts = services["backend"]["volumes"]
        self.assertEqual([mount["source"] for mount in mounts], ["C:/", "D:/"])
        self.assertTrue(all(mount["read_only"] and not mount["bind"]["create_host_path"] for mount in mounts))
        mappings = json.loads(services["backend"]["environment"]["LOCAL_SOURCE_ROOT_MAPPINGS"])
        self.assertEqual(mappings[1]["host_path"], "D:/")

    def test_environment_and_credentials_are_never_modified(self):
        environment = self.root / ".env"
        environment.write_text("DB_PASSWORD='keep-exactly'\n")
        original = environment.read_bytes()
        with patch("stackpilot_cli.local_sources.host_filesystems", return_value=[("/", "/app/host-filesystem", "This computer")]):
            local_sources_override(self.root)
        self.assertEqual(environment.read_bytes(), original)

    def test_production_and_explicit_restriction_never_share_host_drives(self):
        for contents, production in [("", True), ("STACKPILOT_ENV='production'\n", False), ("STACKPILOT_LOCAL_FILESYSTEM=false\n", False)]:
            (self.root / ".env").write_text(contents)
            with patch("stackpilot_cli.local_sources.host_filesystems") as enumerate_drives:
                self.assertIsNone(local_sources_override(self.root, production=production))
                enumerate_drives.assert_not_called()

    def test_windows_enumerates_real_available_drives_and_ignores_networks(self):
        kernel = Mock()
        kernel.GetLogicalDrives.return_value = (1 << 2) | (1 << 3) | (1 << 4)
        kernel.GetDriveTypeW.side_effect = [3, 2, 4]
        with patch("stackpilot_cli.local_sources.platform.system", return_value="Windows"), \
             patch("stackpilot_cli.local_sources.ctypes.windll", create=True) as windll, \
             patch("stackpilot_cli.local_sources.Path.is_dir", return_value=True):
            windll.kernel32 = kernel
            self.assertEqual([drive[0] for drive in host_filesystems()], ["C:/", "D:/"])

    def test_mounts_refresh_when_a_drive_is_attached_or_removed(self):
        with patch("stackpilot_cli.local_sources.host_filesystems", side_effect=[[("C:/", "/app/host-drives/c", "C:")], [("D:/", "/app/host-drives/d", "D:")]]):
            local_sources_override(self.root)
            path = local_sources_override(self.root)
        self.assertEqual(json.loads(path.read_text())["services"]["backend"]["volumes"][0]["source"], "D:/")
