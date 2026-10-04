import sys
from pathlib import Path
import tempfile
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'deployment-runtime'))
from build_secrets import validate,redact
from planner import plan


class BuildInputs(unittest.TestCase):
    def test_public_empty_and_invalid_credentials_are_refused(self):
        for values in ({'NEXT_PUBLIC_TOKEN':'secret'},{'TOKEN':''},{'TOKEN':'x\0y'},{'../TOKEN':'secret'},[]):
            with self.subTest(values=values),self.assertRaises(ValueError):validate(values)
    def test_multiline_credentials_are_redacted_in_build_output(self):
        values={'PRIVATE_REGISTRY':'line-one\nline-two'}
        self.assertEqual(redact('output line-one line-two',values),'output [REDACTED] [REDACTED]')
    def test_contract_refuses_unbounded_ambiguous_or_public_inputs(self):
        import json
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            for names in (['TOKEN','TOKEN'],['PUBLIC_TOKEN'],[{}],['TOKEN']*21):
                (root/'stackpilot.json').write_text(json.dumps({'build_secrets':names}))
                with self.subTest(names=names),self.assertRaises(ValueError):plan(root,'standard_web')
            (root/'stackpilot.json').write_text(json.dumps({'build_secrets':['REGISTRY_TOKEN']}))
            self.assertEqual(plan(root,'standard_web')['build_secrets'],['REGISTRY_TOKEN'])
