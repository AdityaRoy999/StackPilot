import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'deployment-runtime'))
from sandbox_capabilities import image_admitted,registry,select


class SandboxCapabilitiesTests(unittest.TestCase):
    def setUp(self):
        self.environment=patch.dict(os.environ,{'STACKPILOT_AGENT_LOCAL_WORKERS':'true','STACKPILOT_AGENT_WORKER_NETWORK':'true'},clear=True)
        self.environment.start();self.addCleanup(self.environment.stop)

    def test_manifest_versioned_sdk_admission_without_fake_verification(self):
        for image in ['node:20-bookworm-slim','python:3.11-slim','golang:1.24-bookworm','rust:1.86-bookworm','ruby:3.3-slim','php:8.3-cli','mcr.microsoft.com/dotnet/sdk:8.0']:
            self.assertTrue(image_admitted(image),image)
        result=select(['linux','toolchain.node'],'node:20-bookworm-slim',purpose='command')
        self.assertEqual(result['status'],'ready');self.assertFalse(result['verified'])
        self.assertEqual(result['registry']['executors'][0]['observation']['state'],'not_probed')

    def test_unknown_images_and_unversioned_tags_need_registration(self):
        for image in ['evil.example/python:3.12','node:latest','ubuntu:latest','debian:stable','alpine:edge','python:3.11@sha256:'+'a'*64]:
            self.assertFalse(image_admitted(image))
        with patch.dict(os.environ,{'STACKPILOT_AGENT_WORKER_IMAGES':'company.test/private:1'}):
            self.assertTrue(image_admitted('company.test/private:1'))

    def test_missing_capability_keeps_cloud_provisioning_deferred(self):
        result=select(['gpu','linux.arm64'],purpose='command')
        self.assertEqual(result['status'],'unavailable');self.assertIn('gpu',result['missing'])
        self.assertEqual(result['provisioning']['backend'],'docker')
        self.assertFalse(result['provisioning']['implemented']);self.assertFalse(result['verified'])
        self.assertTrue(result['registry']['provisioning']['implemented'])
        self.assertFalse(result['provisioning']['fulfillable'])
        self.assertEqual(result['provisioning']['cloud'],{'implemented':False,'backend':'deferred'})
        with patch.dict(os.environ,{'STACKPILOT_DOCKER_CAPABILITIES':'gpu,windows,macos,distro.ubuntu,arch.foreign,linux.foreign'}):
            result=select(['gpu','windows','macos','distro.ubuntu','arch.foreign','linux.foreign'],image='node:22-bookworm-slim')
            self.assertEqual(result['status'],'unavailable')
            self.assertEqual(set(result['missing']),{'gpu','windows','macos','distro.ubuntu','arch.foreign','linux.foreign'})

    def test_linux_base_images_are_versioned_and_operator_controlled(self):
        for image in ['ubuntu:24.04','ubuntu:22.04','debian:12-slim','debian:bookworm','debian:bullseye-slim','debian:trixie','alpine:3.21','alpine:3.21.2']:
            self.assertTrue(image_admitted(image),image)
        with patch.dict(os.environ,{'STACKPILOT_AGENT_WORKER_FAMILIES':'python','STACKPILOT_AGENT_WORKER_IMAGES':'python:3.12-slim'}):
            self.assertFalse(image_admitted('ubuntu:24.04'))
            self.assertEqual(select(['distro.ubuntu'],purpose='command')['status'],'unavailable')
            profiles=registry(purpose='command')['executors'][0]['distribution_profiles']
            self.assertFalse(next(item for item in profiles if item['id']=='ubuntu')['enabled'])

    def test_distribution_selects_only_a_matching_image(self):
        for name,image in [('ubuntu','ubuntu:24.04'),('debian','debian:bookworm-slim'),('alpine','alpine:3.21')]:
            result=select(['distro.'+name],purpose='command')
            self.assertEqual(result['status'],'ready');self.assertEqual(result['image'],image)
            self.assertEqual(result['distribution'],name);self.assertFalse(result['verified'])
        result=select(['distro.ubuntu'],image='node:22-bookworm-slim',purpose='command')
        self.assertEqual(result['status'],'unavailable');self.assertIn('distro.ubuntu',result['missing'])
        self.assertNotIn('distro.ubuntu',registry(purpose='command')['executors'][0]['capabilities'])
        self.assertEqual(select(['distro.debian'],image='node:22-bookworm-slim')['status'],'ready')
        self.assertEqual(select(['distro.debian'],image='python:3.12-slim')['status'],'unavailable')
        self.assertEqual(select(['distro.alpine'],image='node:22-alpine3.21')['status'],'ready')
        self.assertEqual(select(['distro.ubuntu','distro.debian'])['status'],'unavailable')

    def test_provisioning_operator_flag_and_command_enablement(self):
        self.assertTrue(registry(purpose='command')['provisioning']['implemented'])
        with patch.dict(os.environ,{'STACKPILOT_AGENT_DOCKER_PROVISIONING':'false'}):
            self.assertFalse(registry(purpose='command')['provisioning']['implemented'])
            self.assertTrue(registry(purpose='command')['executors'][0]['enabled'])
        with patch.dict(os.environ,{'STACKPILOT_AGENT_LOCAL_WORKERS':'false'}):
            self.assertFalse(registry(purpose='command')['provisioning']['implemented'])

    def test_command_network_cannot_be_fabricated_by_extra_capabilities(self):
        with patch.dict(os.environ,{'STACKPILOT_AGENT_WORKER_NETWORK':'false','STACKPILOT_DOCKER_CAPABILITIES':'network'}):
            self.assertEqual(select(['network'],purpose='command')['status'],'unavailable')
            self.assertEqual(select(['network'],purpose='deployment')['status'],'ready')

    def test_observed_capacity_and_bounded_instance_hints(self):
        observed=subprocess.CompletedProcess([],0,json.dumps({'OSType':'linux','Architecture':'x86_64','NCPU':4,'MemTotal':1024*1024*1024}))
        with patch('sandbox_capabilities.subprocess.run',return_value=observed):
            data=registry(purpose='command',probe=True)
        executor=data['executors'][0]
        self.assertEqual(executor['observation']['cpu_count'],4)
        self.assertEqual(executor['observation']['memory_bytes'],1024*1024*1024)
        self.assertEqual(executor['limits']['instance_max_total'],8)
        self.assertEqual(executor['limits']['instance_max_per_run'],3)
        self.assertEqual(executor['limits']['instance_max_ttl_seconds'],3600)
        self.assertEqual(executor['limits']['instance_max_memory_mb'],4096)
        self.assertEqual(executor['limits']['instance_max_cpus'],8)
        self.assertEqual(executor['limits']['instance_total_memory_mb'],4096)
        self.assertEqual(executor['limits']['instance_total_cpus'],4)
        with patch.dict(os.environ,{'STACKPILOT_AGENT_INSTANCE_CPUS':'999','STACKPILOT_AGENT_INSTANCE_MEMORY_MB':'nan','STACKPILOT_AGENT_INSTANCE_MAX_TTL_SECONDS':'999999','STACKPILOT_AGENT_INSTANCE_MAX_TOTAL':'broken'}):
            limits=registry()['executors'][0]['limits']
        self.assertEqual(limits['instance_cpus'],8)
        self.assertEqual(limits['instance_memory_mb'],512)
        self.assertEqual(limits['instance_max_ttl_seconds'],86400)
        self.assertEqual(limits['instance_max_total'],8)
        with patch.dict(os.environ,{'STACKPILOT_AGENT_INSTANCE_MAX_MEMORY_MB':'256','STACKPILOT_AGENT_INSTANCE_MAX_CPUS':'2','STACKPILOT_AGENT_INSTANCE_CPUS':'3','STACKPILOT_AGENT_INSTANCE_PIDS_LIMIT':'64','STACKPILOT_AGENT_INSTANCE_TOTAL_MEMORY_MB':'2048','STACKPILOT_AGENT_INSTANCE_TOTAL_CPUS':'2'}):
            limits=registry()['executors'][0]['limits']
        self.assertEqual(limits['instance_max_memory_mb'],256)
        self.assertEqual(limits['instance_memory_mb'],256)
        self.assertEqual(limits['instance_cpus'],2)
        self.assertEqual(limits['instance_pids_limit'],64)
        self.assertEqual(limits['instance_total_memory_mb'],2048)
        self.assertEqual(limits['instance_total_cpus'],2)

    def test_disabled_or_non_linux_daemon_cannot_claim_ready(self):
        with patch.dict(os.environ,{'STACKPILOT_AGENT_LOCAL_WORKERS':'false'}):
            self.assertEqual(select(purpose='command')['status'],'unavailable')
        observed=subprocess.CompletedProcess([],0,json.dumps({'OSType':'windows','Architecture':'x86_64'}))
        with patch('sandbox_capabilities.subprocess.run',return_value=observed):
            result=select(purpose='command',probe=True)
            self.assertEqual(result['status'],'unavailable')
            self.assertEqual(result['registry']['executors'][0]['observation']['os'],'windows')

    def test_architecture_is_observed_from_daemon(self):
        observed=subprocess.CompletedProcess([],0,json.dumps({'OSType':'linux','Architecture':'aarch64'}))
        with patch('sandbox_capabilities.subprocess.run',return_value=observed):
            self.assertEqual(select(['arch.arm64'],purpose='command',probe=True)['status'],'ready')
        with patch.dict(os.environ,{'STACKPILOT_DOCKER_ARCHITECTURE':'amd64'}),patch('sandbox_capabilities.subprocess.run',return_value=observed):
            self.assertEqual(select(['arch.amd64'],purpose='command',probe=True)['status'],'unavailable')
        incomplete=subprocess.CompletedProcess([],0,json.dumps({'OSType':'linux'}))
        with patch('sandbox_capabilities.subprocess.run',return_value=incomplete):
            self.assertEqual(select(purpose='command',probe=True)['status'],'unavailable')

    def test_immutable_sdk_must_belong_to_current_run(self):
        image='sha256:'+'a'*64;run='12345678-1234-1234-1234-123456789abc'
        observed=subprocess.CompletedProcess([],0,json.dumps([{'Id':image,'Config':{'Labels':{
            'stackpilot.agent-run':run,'stackpilot.agent-sdk':'true','stackpilot.agent-task':'task'}}}]))
        with patch('sandbox_capabilities.subprocess.run',return_value=observed):
            self.assertEqual(select(image=image,purpose='command',owned_run=run)['status'],'ready')
            self.assertEqual(select(image=image,purpose='command',owned_run='87654321-1234-1234-1234-123456789abc')['status'],'unavailable')
            self.assertEqual(select(image=image,purpose='command')['status'],'unavailable')

    def test_capability_input_is_bounded(self):
        for value in [['GPU'],['linux; touch /host'],['gpu']*33]:
            with self.assertRaises(ValueError):select(value)


if __name__=='__main__':unittest.main()
