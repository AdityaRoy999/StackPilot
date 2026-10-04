import sys
from pathlib import Path
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'deployment-runtime'))
from compose_evidence import qualify
from compose_policy import sanitize

class ComposeReleaseEvidence(unittest.TestCase):
    def test_missing_or_failed_tests_block_required_multi_service_release(self):
        model={'services':{'web':{'build':{'context':'.'}},'api':{'build':{'context':'.'}},'db':{'image':'fixture-db'}}}
        for state in ('failed','unrecorded','not_configured'):
            with self.subTest(state=state),self.assertRaises(RuntimeError):
                qualify('candidate',model,{'tests_required':True},lambda image:{'status':state if image.endswith('api') else 'passed'})
    def test_every_built_service_is_recorded_without_requiring_database_tests(self):
        calls=[]
        def inspector(image):calls.append(image);return {'status':'passed','image_digest':'sha256:fixture'}
        result=qualify('candidate',{'services':{'web':{'build':{'context':'.'}},'db':{'image':'fixture-db'}}},{'tests_required':True},inspector)
        self.assertEqual(calls,['candidate-web']);self.assertEqual(result['status'],'passed')
    def test_unknown_explicit_test_service_and_empty_required_suite_fail(self):
        for plan in ({'test_services':['missing']},{'tests_required':True}):
            with self.subTest(plan=plan),self.assertRaises((ValueError,RuntimeError)):
                qualify('candidate',{'services':{'db':{'image':'fixture'}}},plan)
    def test_built_images_are_scoped_to_candidate_not_shared_tags(self):
        with __import__('tempfile').TemporaryDirectory() as directory:
            result=sanitize({'services':{'app':{'build':{'context':directory},'image':'shared-serving-tag'}}},Path(directory))
        self.assertNotIn('image',result['services']['app'])
