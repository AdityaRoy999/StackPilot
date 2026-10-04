from pathlib import Path
import sys
import tempfile
import tarfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'deployment-runtime'))
from source_snapshot import snapshot
from planner import plan

class SourceSnapshot(unittest.TestCase):
    def test_archive_traversal_and_links_never_escape_the_private_context(self):
        real_open=tarfile.open
        for name,kind in (('../escaped.txt',tarfile.REGTYPE),('/escaped.txt',tarfile.REGTYPE),
                          ('link',tarfile.SYMTYPE)):
            with self.subTest(name=name),tempfile.TemporaryDirectory() as directory:
                base=Path(directory);root=base/'source';root.mkdir();(root/'app.py').write_text('same')
                def tampered_reader(*args,**kwargs):
                    archive=real_open(*args,**kwargs)
                    if archive.mode=='r':
                        next_member=archive.next
                        def altered_next():
                            member=next_member()
                            if member is not None:
                                member.name=name;member.type=kind;member.linkname='../escaped.txt'
                            return member
                        archive.next=altered_next
                    return archive
                with patch('source_snapshot.tarfile.open',side_effect=tampered_reader):
                    with self.assertRaisesRegex(ValueError,'unsafe entry'):
                        snapshot(root,base/'store',base/'candidate')
                self.assertFalse((base/'escaped.txt').exists())

    def test_sealed_context_stays_unchanged_after_workspace_edit(self):
        with tempfile.TemporaryDirectory() as directory:
            base=Path(directory);root=base/'source';root.mkdir();(root/'app.py').write_text('original')
            (root/'.env').write_text('private');(root/'.env.production.local').write_text('PUBLIC=value')
            first=snapshot(root,base/'store',base/'candidate-one')
            (root/'app.py').write_text('edited')
            second=snapshot(root,base/'store',base/'candidate-two')
            self.assertNotEqual(first['sha256'],second['sha256'])
            self.assertEqual((base/'candidate-one/app.py').read_text(),'original')
            self.assertFalse((base/'candidate-one/.env').exists())
            self.assertTrue((base/'candidate-one/.env.production.local').exists())
    def test_identical_source_has_same_identity_and_cannot_replace_existing_context(self):
        with tempfile.TemporaryDirectory() as directory:
            base=Path(directory);root=base/'source';root.mkdir();(root/'app.py').write_text('same')
            a=snapshot(root,base/'store',base/'one');b=snapshot(root,base/'store',base/'two')
            self.assertEqual(a['sha256'],b['sha256'])
            with self.assertRaises(ValueError):snapshot(root,base/'store',base/'one')
    def test_scenario_without_final_assertion_is_not_a_valid_release_test(self):
        import json
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'stackpilot.json').write_text(json.dumps({'scenarios':[{'name':'submit','steps':[{'action':'click','selector':'button'}]}]}))
            with self.assertRaises(ValueError):plan(root,'standard_web')

    def test_broker_export_preserves_all_accepted_bytes_including_target_and_templates(self):
        import json
        from agent_source import export,tree_digest
        with tempfile.TemporaryDirectory() as directory:
            base=Path(directory);root=base/'sealed';root.mkdir();(root/'target').mkdir()
            (root/'target/application.jar').write_bytes(b'accepted prebuilt artifact')
            (root/'.env.example').write_text('API_URL=https://example.test')
            (root/'.stackpilot-source.json').write_text(json.dumps({'revision':'a'*40,'tree_digest':tree_digest(root),'acceptance':{}}))
            result=export(root,base/'candidate','a'*40)
            self.assertEqual((Path(result['build_context'])/'target/application.jar').read_bytes(),b'accepted prebuilt artifact')
            self.assertTrue((Path(result['build_context'])/'.env.example').is_file())
            (root/'target/application.jar').write_bytes(b'tampered')
            with self.assertRaisesRegex(ValueError,'sealed bytes'):export(root,base/'other','a'*40)
