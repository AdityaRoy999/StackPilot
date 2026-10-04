import sys
from pathlib import Path
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'deployment-runtime'))
from github_ci import judge,query

class SourceBoundCI(unittest.TestCase):
    sha='a'*40
    def check(self,**values):return {'name':'tests','head_sha':self.sha,'app':{'id':1},'status':'completed','conclusion':'success',**values}
    def test_skipped_missing_wrong_source_or_untrusted_check_never_passes(self):
        policy={'checks':[{'name':'tests','app_id':1}]}
        for runs in ([],[self.check(conclusion='skipped')],[self.check(head_sha='b'*40)],[self.check(app={'id':2})]):
            self.assertFalse(judge(runs,[],self.sha,policy).get('passed'))
    def test_legacy_status_and_pending_are_accounted_for(self):
        self.assertFalse(judge([self.check()],[{'context':'integration','state':'failure'}],self.sha)['passed'])
        self.assertTrue(judge([],[{'context':'integration','state':'success'}],self.sha)['passed'])
        self.assertTrue(judge([self.check(status='in_progress',conclusion=None)],[],self.sha)['pending'])
    def test_check_evidence_is_paginated(self):
        def fetch(path):
            if '/statuses?' in path:return []
            page=int(path.split('page=')[-1]);batch=[self.check(name=str(i)) for i in range((page-1)*100,min(page*100,101))]
            return {'total_count':101,'check_runs':batch}
        result=query('fixture/repo',self.sha,'',fetch=fetch)
        self.assertTrue(result['passed']);self.assertEqual(result['check_count'],101)
