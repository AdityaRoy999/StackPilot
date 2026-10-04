import sys
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'deployment-runtime'))
from desktop_entrypoint import visible_windows


class DesktopReadiness(unittest.TestCase):
    def observation(self,text):return SimpleNamespace(returncode=0,stdout=text)
    def test_mapped_native_window_is_ready_without_wmctrl_text(self):
        with patch('desktop_entrypoint.subprocess.run',side_effect=[self.observation('window id # 0x100001f'),
            self.observation('Width: 640\nHeight: 360\nMap State: IsViewable\nOverride Redirect State: no')]):
            self.assertEqual(visible_windows(),['0x100001f'])
    def test_hidden_windows_and_tiny_manager_windows_are_not_app_ready(self):
        with patch('desktop_entrypoint.subprocess.run',side_effect=[self.observation('window id # 0x1, 0x2'),
            self.observation('Width: 640\nHeight: 360\nMap State: IsUnMapped'),
            self.observation('Width: 1\nHeight: 1\nMap State: IsViewable')]):
            self.assertEqual(visible_windows(),[])
