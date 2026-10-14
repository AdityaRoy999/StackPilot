import copy
import json
from pathlib import Path
import tempfile
import unittest

from app.hosted_frontend import infer, nginx, dockerfile
from app.agent_runtime.execution_profiles import repair_completion


class HostedFrontendTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root/'apps/web').mkdir(parents=True)
        (self.root/'package.json').write_text(json.dumps({'engines':{'node':'24.x'},'workspaces':['apps/web']}))
        (self.root/'apps/web/package.json').write_text(json.dumps({'devDependencies':{'vite':'7'}}))
        self.production = {'framework':'vite','installCommand':'npm ci',
            'buildCommand':'npm --workspace @example/web run build','outputDirectory':'apps/web/dist',
            'rewrites':[{'source':'/api/:path*','destination':'https://api.example.com/:path*'},
                        {'source':'/(.*)','destination':'/index.html'}]}
        self.save()
        (self.root/'compose.yaml').write_text('services:\n  postgres:\n    image: postgres:17\n  api:\n    build: apps/api\n')

    def save(self):
        (self.root/'vercel.json').write_text(json.dumps(self.production))

    def test_environment_selects_development_compose_without_changing_hosted_production(self):
        self.assertIsNone(infer(self.root,{'deployment':{'environment_name':'development','branch':'dev'}}))
        production=infer(self.root,{'deployment':{'environment_name':'production','branch':'main','execution_mode':'local'}})
        self.assertEqual(production['deployment_mode'],'dockerfile')
        self.assertIn('api.example.com',json.dumps(production))
        self.assertEqual(infer(self.root),production)

    def test_declared_frontend_reuses_external_api_and_preserves_development_compose(self):
        original = (self.root/'compose.yaml').read_bytes()
        result = infer(self.root)
        self.assertEqual(result['deployment_mode'],'dockerfile')
        self.assertEqual(result['static_frontend']['root'],'apps/web')
        self.assertEqual(result['static_frontend']['image'],'node:24-bookworm-slim')
        self.assertEqual(result['tests'],[['npm','--workspace','@example/web','run','build']])
        self.assertEqual((self.root/'compose.yaml').read_bytes(), original)

    def test_generated_frontend_routes_api_before_spa_and_supports_streaming(self):
        result = infer(self.root)
        server = nginx(result)
        self.assertIn('proxy_pass https://api.example.com/;',server)
        self.assertIn('proxy_ssl_verify on;',server)
        self.assertIn('proxy_buffering off;',server)
        self.assertLess(server.index('location /api/'),server.index('location / {'))
        image = dockerfile(result)
        self.assertIn('hosted_frontend.py build',image)
        self.assertIn('USER 65534:65534',image)
        self.assertNotIn('postgres',image)

    def test_recovery_checks_frontend_production_build_instead_of_external_api_source(self):
        result = infer(self.root)
        (self.root/'stackpilot.json').write_text(json.dumps(result))
        completion = repair_completion(self.root)
        check = completion['features'][0]['checks'][0]
        self.assertEqual(completion['workload'],'web')
        self.assertEqual(check['root'],'.')
        self.assertEqual(check['argv'],self.production['buildCommand'].split())
        self.assertEqual(check['setup'],[['npm','ci']])
        self.assertNotIn('pytest',str(completion))

    def test_unrelated_or_unsupported_deployment_is_not_reinterpreted(self):
        for edit in ({'framework':'nextjs'}, {'rewrites':[]}, {'outputDirectory':None}):
            value = copy.deepcopy(self.production); value.update(edit)
            (self.root/'vercel.json').write_text(json.dumps(value))
            self.assertIsNone(infer(self.root))

    def test_unsafe_or_unsupported_remote_rewrites_fail_with_actionable_error(self):
        for destination in ('http://api.example.com/:path*', 'https://user:password@api.example.com/:path*',
                            'https://api.example.com/;bad/:path*','https://localhost/:path*',
                            'https://api.example.com:123;bad/:path*','https://api.example.com:99999/:path*',
                            'https://api.example.com/fixed'):
            self.production['rewrites'][0]['destination'] = destination
            self.save()
            with self.assertRaises(ValueError):infer(self.root)

    def test_output_traversal_and_shell_command_injection_are_rejected(self):
        for output in ('../dist','/dist','apps/web/../../dist'):
            self.production['outputDirectory']=output; self.save()
            with self.assertRaises(ValueError):infer(self.root)
        self.production['outputDirectory']='apps/web/dist'
        for build in ('npm run build && curl attacker','npm run build;touch hacked','npm run $(whoami)'):
            self.production['buildCommand']=build; self.save()
            with self.assertRaises(ValueError):infer(self.root)

    def test_changed_production_inputs_cannot_retain_a_stale_repair_recipe(self):
        result=infer(self.root)
        (self.root/'stackpilot.json').write_text(json.dumps(result))
        self.production['buildCommand']='npm run different';self.save()
        with self.assertRaisesRegex(ValueError,'declared production'):repair_completion(self.root)

    def test_original_dockerfile_is_not_replaced_by_implicit_production_detection(self):
        (self.root/'Dockerfile').write_text('FROM python:3.12-slim\nCMD ["python","server.py"]\n')
        self.assertIsNone(infer(self.root))

    def test_declared_hosted_health_path_becomes_a_real_proxy_release_check(self):
        (self.root/'render.yaml').write_text('services:\n  - name: api\n    healthCheckPath: /health\n')
        self.assertEqual(infer(self.root)['checks'],[{'path':'/api/health','statuses':[200]}])
