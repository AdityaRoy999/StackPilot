import hashlib
import io
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'deployment-runtime'))
from gradle_transport import seed,cache_location


class GradleTransport(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.previous=Path.cwd();os.chdir(self.root);self.addCleanup(os.chdir,self.previous)
        path=self.root/'gradle/wrapper/gradle-wrapper.properties';path.parent.mkdir(parents=True)
        self.url='https://services.gradle.org/distributions/gradle-8.13-bin.zip'
        self.path=path;path.write_text('distributionUrl='+self.url+'\n')
        self.home=self.root/'home';self.environment=patch.dict(os.environ,{'GRADLE_USER_HOME':str(self.home)});self.environment.start();self.addCleanup(self.environment.stop)
    def test_legacy_wrapper_uses_exact_official_release_checksum_without_source_changes(self):
        body=b'fixture-distribution';original=self.path.read_bytes();urls=[]
        def response(url,**kwargs):
            urls.append(url);return io.BytesIO(hashlib.sha256(body).hexdigest().encode() if url.endswith('.sha256') else body)
        with patch('gradle_transport.urllib.request.urlopen',side_effect=response):self.assertTrue(seed(time.monotonic()+30))
        self.assertEqual(cache_location(self.url,self.home).read_bytes(),body)
        self.assertEqual(self.path.read_bytes(),original)
        self.assertTrue(all(url.startswith('https://downloads.gradle.org/distributions/gradle-8.13-bin.zip') for url in urls))
    def test_repository_pin_mismatch_never_falls_back_to_a_new_checksum(self):
        self.path.write_text(self.path.read_text()+'distributionSha256Sum='+'0'*64+'\n')
        with patch('gradle_transport.urllib.request.urlopen',return_value=io.BytesIO(b'corrupt')) as download:
            with self.assertRaisesRegex(ValueError,'checksum mismatch'):seed(time.monotonic()+30)
            self.assertEqual(download.call_count,1)
        self.assertFalse(cache_location(self.url,self.home).exists())
        self.assertFalse(list(self.home.rglob('*.stackpilot-download')))
    def test_custom_distributions_are_not_rewritten_to_official_releases(self):
        self.path.write_text('distributionUrl=https://private.example/gradle-8.13-bin.zip\n')
        with patch('gradle_transport.urllib.request.urlopen') as download:
            self.assertFalse(seed(time.monotonic()+30));download.assert_not_called()

if __name__=='__main__':unittest.main()
