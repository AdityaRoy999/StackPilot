import unittest
from app.browser_testing.coverage import reconcile_native_validation, coverage_obligations


class CoverageTests(unittest.TestCase):
    def setUp(self):
        self.url='https://fixture.invalid/'
        self.control={'id':30,'tag':'input','type':'email','name':'email'}
        self.coverage={'controls_requiring_review':[
            {'url':self.url,'label':'email','tag':'input','name':'email','reason':'Validation untested'},
            {'url':self.url,'label':'Send','tag':'button','type':'submit','reason':'Approval required'}]}

    def result(self,expected,status='passed'):
        return {'assertions':[{'status':status,'expectation':{'kind':'validity','element_id':30,'expected':expected}}]}

    def test_complementary_checks_update_only_native_validation_obligation(self):
        reconcile_native_validation(self.coverage,self.result(False),self.url,[self.control])
        self.assertEqual(self.coverage['controls_requiring_review'][0]['native_validation_states'],[False])
        reconcile_native_validation(self.coverage,{'results':[self.result(True)]},self.url,[self.control])
        review=self.coverage['controls_requiring_review'][0]
        self.assertEqual(review['native_validation_states'],[False,True])
        self.assertIn('native validation checks passed',review['reason'])
        self.assertIn('business/server validation remain unverified',review['reason'])
        self.assertEqual(coverage_obligations(self.coverage)[1]['reason'],'Approval required')

    def test_failed_wrong_route_superseded_or_ambiguous_checks_cannot_complete_field(self):
        for result,url,controls in ((self.result(True,'failed'),self.url,[self.control]),
                                    (self.result(True),'https://fixture.invalid/other',[self.control]),
                                    (self.result(True),self.url,[{**self.control,'id':31}])):
            reconcile_native_validation(self.coverage,result,url,controls)
        self.assertNotIn('native_validation_states',self.coverage['controls_requiring_review'][0])
        self.coverage['controls_requiring_review'].append(dict(self.coverage['controls_requiring_review'][0]))
        reconcile_native_validation(self.coverage,self.result(True),self.url,[self.control])
        self.assertNotIn('native_validation_states',self.coverage['controls_requiring_review'][0])
