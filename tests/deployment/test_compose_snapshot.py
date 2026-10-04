import sys
from pathlib import Path
import tempfile
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'deployment-runtime'))
from compose_snapshot import relocate

class ComposeSnapshot(unittest.TestCase):
    def test_source_references_point_to_sealed_context(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)/'source';sealed=Path(directory)/'candidate';root.mkdir();sealed.mkdir()
            model={'services':{'app':{'build':{'context':str(root/'web')},'volumes':[{'type':'bind','source':str(root/'public')}]}}}
            result=relocate(model,root,sealed)['services']['app']
            self.assertEqual(Path(result['build']['context']),sealed/'web')
            self.assertEqual(Path(result['volumes'][0]['source']),sealed/'public')
    def test_relocation_cannot_import_host_files(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):relocate({'services':{'app':{'build':{'context':'../private'}}}},Path(directory)/'source',Path(directory)/'candidate')
