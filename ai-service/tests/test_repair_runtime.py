import unittest
from app.repair_evidence import repair_evidence, pending_build_wait
from app.runtime_verification import judge_render


class RepairEvidenceTests(unittest.TestCase):
    def test_unmonitored_queued_build_requires_exact_wait(self):
        calls = [self.call('workspace_trigger_rebuild',status='rebuild_queued',job_id='new',deployment_id='deployment')]
        self.assertEqual(pending_build_wait(calls),{'job_id':'new','deployment_id':'deployment'})
        calls.append({'name':'wait_for_deployment','arguments':{'job_id':'new'},'result':{'status':'failed'}})
        self.assertIsNone(pending_build_wait(calls))
    def call(self, name, **result):
        return {'name':name, 'result':result}

    def test_failed_write_and_queued_rebuild_cannot_claim_success(self):
        calls = [{'name':'workspace_write_file', 'arguments':{'file_path':'Dockerfile'}, 'result':{'error':'denied'}},
            self.call('workspace_trigger_rebuild',status='rebuild_queued',job_id='new')]
        evidence = repair_evidence(calls)
        self.assertFalse(evidence['verified'])
        self.assertEqual(evidence['written_paths'],[])

    def test_old_or_superseding_build_cannot_verify_repair(self):
        queued = self.call('workspace_trigger_rebuild',status='rebuild_queued',job_id='new')
        for job, completed, verified in [('old','completed',True),('new','running',True),('new','completed',False)]:
            self.assertFalse(repair_evidence([queued,self.call('wait_for_deployment',
                status='running',job_id=job,job_status=completed,verified=verified)])['verified'])

    def test_exact_verified_build_passes_and_later_rebuild_invalidates_it(self):
        calls = [self.call('workspace_trigger_rebuild',status='rebuild_queued',job_id='new'),
            self.call('wait_for_deployment',status='running',job_id='new',job_status='completed',verified=True)]
        self.assertTrue(repair_evidence(calls)['verified'])
        calls.append(self.call('workspace_trigger_rebuild',status='rebuild_queued',job_id='later'))
        self.assertFalse(repair_evidence(calls)['verified'])

    def test_api_and_artifact_repairs_do_not_claim_browser_verification(self):
        for scope in ('http_contract', 'artifact_delivery', 'process_observation'):
            calls = [self.call('workspace_trigger_rebuild',status='rebuild_queued',job_id='new'),
                self.call('wait_for_deployment',status='running',job_id='new',job_status='completed',
                    verified=True,verification_scope=scope)]
            evidence = repair_evidence(calls)
            self.assertTrue(evidence['verified'])
            self.assertEqual(evidence['scope'],scope)
            self.assertNotIn('render smoke',evidence['reason'])


class RenderGateTests(unittest.TestCase):
    def test_raw_vite_source_fails_even_with_title_and_http_success(self):
        self.assertFalse(judge_render({'ready':'complete','text':'Loading','title':'App',
            'source_modules':['http://runtime/src/main.tsx'],'response_status':200})[0])

    def test_blank_and_asset_failure_fail(self):
        for state in ({'ready':'complete'}, {'ready':'complete','text':'Hello','failed_assets':[{'status':404}]},
                      {'ready':'complete','text':'Server error','response_status':500}):
            self.assertFalse(judge_render(state)[0])

    def test_render_smoke_scope_is_explicit(self):
        passed, reason = judge_render({'ready':'complete','text':'Welcome','response_status':200})
        self.assertTrue(passed)
        self.assertIn('business workflows remain unverified',reason)
