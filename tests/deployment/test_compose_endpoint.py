import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
import urllib.error
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'deployment-runtime'))
from compose_endpoint import resolve


class ComposeEndpointTests(unittest.TestCase):
    def probe(self,records,contract,opener):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); model=root/'compose.json'; plan=root/'plan.json'
            model.write_text(json.dumps({'services':{r['Service']:{} for r in records}}))
            plan.write_text(json.dumps({'health_path':'/','accepted_statuses':[200],**contract}))
            with patch('compose_endpoint.subprocess.run',return_value=SimpleNamespace(stdout=json.dumps(records))), patch('compose_endpoint.urllib.request.urlopen',side_effect=opener):
                resolve('fixture',model,plan)

    def record(self,service,port):
        return {'Service':service,'State':'running','Health':'healthy','Publishers':[{'Protocol':'tcp','PublishedPort':port}]}

    def test_healthy_container_with_wrong_route_is_not_ambiguous_or_verified(self):
        def reject(url,**_):raise urllib.error.HTTPError(url,404,'not found',{},None)
        with self.assertRaisesRegex(RuntimeError,"No endpoint passed health path '/' .+api: HTTP 404"):
            self.probe([self.record('api',54321)],{},reject)

    def test_selected_api_health_route_resolves_exactly_one_url(self):
        def accept(url,**_):
            self.assertTrue(url.endswith('/health'))
            return contextlib.nullcontext(SimpleNamespace(status=200))
        output=io.StringIO()
        with contextlib.redirect_stdout(output):self.probe([self.record('api',54321)],{'primary_service':'api','health_path':'/health'},accept)
        self.assertEqual(output.getvalue().strip(),'__STACKPILOT_COMPOSE_URL__=http://localhost:54321')

    def test_multiple_viable_services_still_require_explicit_selection(self):
        with self.assertRaisesRegex(RuntimeError,'Multiple HTTP endpoints passed: api, web'):
            self.probe([self.record('api',54321),self.record('web',54322)],{},lambda *_a,**_k:contextlib.nullcontext(SimpleNamespace(status=200)))


if __name__=='__main__':unittest.main()
