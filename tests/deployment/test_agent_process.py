import io
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'deployment-runtime'))
import agent_process


class AgentProcessTests(unittest.TestCase):
    def test_verbose_dependency_output_retains_final_error_with_bounded_memory(self):
        captured=bytearray()
        for block in [b'header\n', b'x'*80000, b'\nERROR final dependency resolution failure']:
            agent_process.capture_output(captured,block)
        self.assertLessEqual(len(captured),65536)
        self.assertTrue(captured.startswith(b'header\n'))
        self.assertTrue(captured.endswith(b'ERROR final dependency resolution failure'))

    def test_setup_and_check_share_container_cwd_and_quote_arguments(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); (root/'api').mkdir(); commands=[]
            def run(argv,**kwargs):
                commands.append(argv)
                output=b''
                if argv[:2]==['docker','inspect']:
                    output=b'{"ExitCode":0}' if '.State' in argv[3] else b'sha256:fixture'
                return SimpleNamespace(stdout=output,returncode=0)
            process=SimpleNamespace(stdout=io.BytesIO(b'check passed'),poll=lambda:0)
            with patch.object(agent_process,'select',return_value={'status':'ready'}), patch.object(agent_process,'lease_valid',return_value=True), patch.object(agent_process.subprocess,'run',side_effect=run), patch.object(agent_process.subprocess,'Popen',return_value=process), patch.dict(os.environ,{'STACKPILOT_AGENT_WORKER_NETWORK':'true'}):
                result=agent_process.execute(root,{'argv':['python','-c','assert "$(secret)" == "$(secret)"'],'root':'api','setup':[['python','-m','pip','install','.[dev]']], 'network':True,'task_id':'fixture','write_scope':[]})
            creation=next(c for c in commands if c[:2]==['docker','create'])
            self.assertEqual(creation[creation.index('--workdir')+1],'/workspace/api')
            self.assertEqual(creation[creation.index('--entrypoint')+1],'sh')
            self.assertEqual(creation[creation.index('--memory')+1],os.getenv('STACKPILOT_AGENT_WORKER_MEMORY','1g'))
            self.assertIn("'.[dev]'",creation[-1])
            self.assertIn('set -e\n',creation[-1])
            self.assertIn("'assert \"$(secret)\" == \"$(secret)\"'",creation[-1])
            self.assertEqual(result['exit_code'],0)
            self.assertFalse(result['verified'])

    def test_bad_shell_argv_and_offline_install_fail_before_creating_guest(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(agent_process,'select',return_value={'status':'ready'}), patch.object(agent_process.subprocess,'run') as docker:
            for spec in ({'argv':['cd','api','&&','pytest']}, {'argv':['pytest'],'setup':[['pip','install','pytest']],'network':False}):
                with self.assertRaises(ValueError):agent_process.execute(Path(directory),spec)
            docker.assert_not_called()


if __name__=='__main__':unittest.main()
