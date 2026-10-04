import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from typer.testing import CliRunner
from stackpilot_cli.cli import app
from stackpilot_cli.setup import environment_values, write_environment, normalize_profile, SECRET_NAMES, docker_socket_gid
from stackpilot_cli.services.ai_client import AIClient
from stackpilot_cli.services.docker_service import compose_command, compose_environment, restart_services, run_compose_up


class CLITests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / 'docker-compose.yml').write_text('services: {}\n')
        self.config = {'backend_url':'https://platform.example', 'frontend_url':'https://platform.example',
                       'default_profile':'core', 'workspace':str(self.root)}
        self.runner = CliRunner()

    def test_command_help_and_version(self):
        for args in (['--help'], ['--version'], ['init','--help'], ['test','--help'], ['chat','--help']):
            with self.subTest(args=args):
                self.assertEqual(self.runner.invoke(app, args).exit_code, 0)

    def test_each_secret_is_generated_independently(self):
        first, second = environment_values(), environment_values()
        self.assertEqual(len({first[name] for name in SECRET_NAMES}), len(SECRET_NAMES))
        for name in SECRET_NAMES:
            self.assertGreaterEqual(len(first[name]), 48)
            self.assertNotEqual(first[name], second[name])

    def test_existing_environment_is_never_overwritten(self):
        path, created = write_environment(self.root)
        self.assertTrue(created)
        original = path.read_bytes()
        self.assertFalse(write_environment(self.root)[1])
        self.assertEqual(path.read_bytes(), original)
        if os.name != 'nt':
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_compatible_provider_and_production_configuration(self):
        values = environment_values(provider='openai_compatible', base_url='http://host.docker.internal:11434/v1',
                                    model='fixture-model', domain='stackpilot.example.com', email='admin@example.com')
        self.assertEqual(values['NEXT_PUBLIC_API_BASE_URL'], '/api/v1')
        self.assertEqual(values['STACKPILOT_REQUIRE_HTTPS'], 'true')
        self.assertEqual(values['OPENAI_COMPATIBLE_MODEL'], 'fixture-model')

    def test_environment_injection_and_invalid_providers_are_rejected(self):
        for arguments in ({'email':'a@example.com\nBAD=1','domain':'platform.example'},
                          {'provider':'unsupported'}, {'provider':'openai_compatible'},
                          {'domain':'$(whoami).example','email':'admin@example.com'}):
            with self.subTest(arguments=arguments), self.assertRaises(ValueError):
                environment_values(**arguments)

    def test_init_noninteractive_creates_real_compose_secrets(self):
        with patch('stackpilot_cli.commands.init_cmd.load_config',return_value=self.config.copy()), \
             patch('stackpilot_cli.commands.init_cmd.save_config') as save:
            result = self.runner.invoke(app, ['init','--yes','--workspace',str(self.root),'--profile','core'])
        self.assertEqual(result.exit_code, 0, result.output)
        contents = (self.root / '.env').read_text()
        for name in SECRET_NAMES:
            self.assertIn(name+'=', contents)
        self.assertEqual(save.call_args.args[0]['workspace'],str(self.root))

    def test_profiles_map_to_existing_compose_profiles(self):
        with patch('stackpilot_cli.config.load_config',return_value=self.config):
            command = compose_command(self.root, 'core')
            self.assertEqual(command[-4:],['--profile','ai','--profile','browser'])
            self.assertEqual(compose_command(self.root,'monitoring')[-4:],['--profile','full','--profile','monitoring'])
            self.assertNotIn('--profile',compose_command(self.root,'base'))
        self.assertEqual(normalize_profile('standard'),'core')
        with self.assertRaises(ValueError): normalize_profile('unknown')

    def test_linux_socket_group_is_detected_without_root_or_credential_changes(self):
        with patch('stackpilot_cli.setup.Path.stat', return_value=Mock(st_gid=998)):
            self.assertEqual(docker_socket_gid(), '998')
            self.assertEqual(environment_values()['DOCKER_SOCKET_GID'], '998')
        with patch('stackpilot_cli.setup.Path.stat', side_effect=FileNotFoundError):
            self.assertEqual(docker_socket_gid(), '0')
        with patch.dict(os.environ, {}, clear=True), \
             patch('stackpilot_cli.services.docker_service.docker_socket_gid',return_value='998'), \
             patch('stackpilot_cli.config.load_config',return_value=self.config), \
             patch('stackpilot_cli.services.docker_service.subprocess.run',return_value=Mock(returncode=0,stdout='')) as run:
            self.assertTrue(run_compose_up()[0])
            self.assertEqual(run.call_args.kwargs['env']['DOCKER_SOCKET_GID'], '998')
            path = self.root / '.env'
            path.write_text("DB_PASSWORD=unchanged\nDOCKER_SOCKET_GID='123'\n")
            self.assertNotIn('DOCKER_SOCKET_GID', compose_environment(self.root))
            self.assertEqual(path.read_text(), "DB_PASSWORD=unchanged\nDOCKER_SOCKET_GID='123'\n")
            with patch.dict(os.environ, {'DOCKER_SOCKET_GID':'456'}):
                self.assertEqual(compose_environment(self.root)['DOCKER_SOCKET_GID'], '456')

    def test_restart_only_restarts_selected_service_without_removing_data(self):
        with patch('stackpilot_cli.config.load_config',return_value=self.config), \
             patch('stackpilot_cli.services.docker_service.subprocess.run',return_value=Mock(returncode=0,stdout='',stderr='')) as run:
            restart_services('ai-service')
        self.assertEqual(run.call_args.args[0][-2:],['restart','ai-service'])
        self.assertNotIn('down',run.call_args.args[0])

    def test_ai_uses_authenticated_backend_and_exact_signed_step(self):
        with patch('stackpilot_cli.services.ai_client.load_config',return_value=self.config), \
             patch('stackpilot_cli.services.ai_client.get_auth_token',return_value='fixture-session-token'):
            client = AIClient()
            self.assertEqual(client.base_url,'https://platform.example/api/v1/ai')
            self.assertEqual(client._headers()['Authorization'],'Bearer fixture-session-token')
            self.assertNotIn('X-StackPilot-Service-Token',client._headers())
        permission = {'type':'permission_request','token':'signed-fixture-step','tool_name':'workspace_trigger_rebuild'}
        with patch.object(client,'stream_chat',side_effect=[iter([permission,{'type':'done','status':'waiting_for_permission'}]),iter([{'type':'content','delta':'Queued.'},{'type':'done'}])]) as stream:
            events = list(client.reviewed_stream(confirm=lambda step:step is permission,message='Repair',session_id='owned-chat'))
        self.assertEqual(stream.call_count,2)
        self.assertEqual(stream.call_args.kwargs['approval_token'],'signed-fixture-step')
        self.assertEqual(stream.call_args.kwargs['session_id'],'owned-chat')
        self.assertEqual(events[-2]['delta'],'Queued.')

    def test_declining_permission_does_not_dispatch_a_second_request(self):
        with patch('stackpilot_cli.services.ai_client.load_config',return_value=self.config): client=AIClient()
        with patch.object(client,'stream_chat',return_value=iter([{'type':'permission_request','token':'fixture'},{'type':'done','status':'waiting_for_permission'}])) as stream:
            list(client.reviewed_stream(confirm=lambda _:False,message='Test',session_id='owned-chat'))
        self.assertEqual(stream.call_count,1)

    def test_stream_contract_includes_browser_mode_and_backend_session(self):
        with patch('stackpilot_cli.services.ai_client.load_config',return_value=self.config), \
             patch('stackpilot_cli.services.ai_client.get_auth_token',return_value='fixture'), \
             patch('stackpilot_cli.services.ai_client.requests.post') as post:
            response = post.return_value.__enter__.return_value
            response.status_code = 200
            response.iter_lines.return_value = ['data: '+json.dumps({'type':'done'})]
            self.assertEqual(list(AIClient().stream_chat(message='Test',session_id='owned-chat',sandbox_mode='remote')),[{'type':'done'}])
            self.assertTrue(post.call_args.args[0].endswith('/api/v1/ai/chat/stream'))
            self.assertEqual(post.call_args.kwargs['json']['sandbox_mode'],'remote')

    def test_interrupted_permission_stream_never_resumes_or_prompts(self):
        with patch('stackpilot_cli.services.ai_client.load_config',return_value=self.config): client=AIClient()
        for events in ([{'type':'permission_request','token':'fixture'}],
                       [{'type':'permission_request','token':'fixture'}, {'type':'error','error':'connection lost'},
                        {'type':'done','status':'waiting_for_permission'}]):
            with self.subTest(events=events), patch.object(client,'stream_chat',return_value=iter(events)) as stream:
                confirm = Mock(return_value=True)
                output = list(client.reviewed_stream(confirm=confirm,message='Test',session_id='owned-chat'))
                confirm.assert_not_called()
                self.assertEqual(stream.call_count,1)
                self.assertEqual(output[-1]['type'],'error')

    def test_existing_local_environment_cannot_be_silently_switched_to_production(self):
        write_environment(self.root)
        with patch('stackpilot_cli.commands.init_cmd.load_config',return_value=self.config.copy()), \
             patch('stackpilot_cli.commands.init_cmd.save_config') as save:
            result = self.runner.invoke(app, ['init','--yes','--workspace',str(self.root),
                                             '--domain','production.example','--email','admin@example.com'])
        self.assertEqual(result.exit_code,1)
        save.assert_not_called()

    def test_private_auth_storage_is_atomic_and_user_readable_only_on_posix(self):
        from stackpilot_cli import config
        directory = self.root / '.stackpilot'
        with patch.object(config,'CONFIG_DIR',directory), patch.object(config,'AUTH_FILE',directory/'auth.json'):
            config.save_auth({'token':'fixture-token'})
            config.save_auth({'token':'new-fixture-token'})
            self.assertEqual(config.get_auth_token(),'new-fixture-token')
            self.assertEqual(len(list(directory.glob('*.tmp'))),0)
            if os.name != 'nt':
                self.assertEqual((directory/'auth.json').stat().st_mode & 0o777,0o600)


if __name__ == '__main__': unittest.main()
