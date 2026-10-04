import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'deployment-runtime'))
sys.path.insert(0, str(ROOT/'ai-service'/'app'))
from repository_toolchains import discover, satisfies, verification_profile
from repository_discovery import analyze
from planner import prepare


class Toolchains(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
    def tearDown(self): self.temp.cleanup()
    def write(self, name, content):
        path = self.root/name; path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content); return path
    def selected(self, kind): return next(item for item in discover(self.root, nested=True) if item['kind'] == kind)
    def test_pinned_node_and_engine_range_are_combined(self):
        self.write('package.json', json.dumps({'engines': {'node': '>=18 <20'}}))
        self.write('.nvmrc', 'v18.20.8\n')
        value = self.selected('node')
        self.assertEqual(value['image'], 'node:18.20.8-bookworm-slim')
        self.assertFalse(value['assumed']); self.assertFalse(value['execution_verified'])
    def test_conflicting_node_evidence_is_actionable(self):
        self.write('package.json', json.dumps({'engines': {'node': '>=22'}}))
        self.write('.node-version', '18.20.8')
        value = self.selected('node'); self.assertEqual(value['status'], 'requires_configuration')
        self.assertIsNone(value['image'])
        with self.assertRaisesRegex(ValueError, 'compatible version evidence'): prepare(self.root, 'standard_web')
    def test_explicit_dockerfile_overrides_automatic_recipe_evidence(self):
        self.write('package.json', '{"engines":{"node":">=22"}}'); self.write('.nvmrc', '16')
        docker = self.write('Dockerfile', 'FROM provided-toolchain:fixture\n')
        prepare(self.root, 'standard_web'); self.assertEqual(docker.read_text(), 'FROM provided-toolchain:fixture\n')
    def test_explicit_portable_recipe_remains_authoritative(self):
        self.write('package.json', '{"engines":{"node":">=22"}}'); self.write('.nvmrc', '16')
        self.write('stackpilot.json', json.dumps({'workload': 'api', 'build_recipe': {'image': 'node:20-bookworm-slim', 'commands': [['node', 'build.js']], 'outputs': ['dist'], 'runtime_command': ['node', 'dist/app.js']}}))
        prepare(self.root, 'standard_web')
        self.assertIn('FROM node:20-bookworm-slim', (self.root/'Dockerfile').read_text())
    def test_python_requires_python_selects_compatible_version(self):
        self.write('pyproject.toml', '[project]\nname="fixture"\nversion="1.0.0"\nrequires-python=">=3.10,<3.12"\n')
        self.assertEqual(self.selected('python')['image'], 'python:3.11-slim')
    def test_python_pin_can_match_exact_patch(self):
        self.write('pyproject.toml', '[project]\nrequires-python="==3.11.8"\n')
        self.assertEqual(self.selected('python')['version'], '3.11.8')
    def test_exact_python_minor_does_not_become_moving_patch_tag(self):
        self.write('pyproject.toml', '[project]\nrequires-python="==3.11"\n')
        self.assertEqual(self.selected('python')['image'], 'python:3.11.0-slim')
    def test_poetry_ranges_and_version_file_are_respected(self):
        self.write('pyproject.toml', '[tool.poetry.dependencies]\npython="~3.10"\n'); self.write('.python-version', '3.10.15')
        self.assertEqual(self.selected('python')['version'], '3.10.15')
    def test_go_toolchain_is_not_lost_to_old_fixed_default(self):
        self.write('go.mod', 'module example.com/fixture\ngo 1.23.0\ntoolchain go1.25.2\n')
        self.assertEqual(self.selected('go')['image'], 'golang:1.25.2-bookworm')
    def test_rust_pin_and_minimum_are_combined(self):
        self.write('Cargo.toml', '[package]\nname="fixture"\nversion="0.1.0"\nrust-version="1.80"\n')
        self.write('rust-toolchain.toml', '[toolchain]\nchannel="1.85.0"\n')
        self.assertEqual(self.selected('rust')['image'], 'rust:1.85.0-bookworm')
    def test_nightly_rust_requires_explicit_recipe(self):
        self.write('Cargo.toml', '[package]\nname="fixture"\nversion="0.1.0"\n'); self.write('rust-toolchain', 'nightly-2026-09-30')
        self.assertEqual(self.selected('rust')['status'], 'requires_configuration')
    def test_java_compiler_properties_and_legacy_version(self):
        self.write('pom.xml', '<project><properties><java.version>1.8</java.version><maven.compiler.release>${java.version}</maven.compiler.release></properties></project>')
        self.assertEqual(self.selected('java')['image'], 'eclipse-temurin:8-jdk')
        self.write('.java-version', '1.8')
        self.assertEqual(self.selected('java')['image'], 'eclipse-temurin:8-jdk')
    def test_gradle_toolchain_selects_java_17(self):
        self.write('build.gradle.kts', 'java { toolchain { languageVersion.set(JavaLanguageVersion.of(17)) } }')
        self.assertEqual(self.selected('java')['version'], '17')
    def test_dotnet_global_sdk_and_runtime_are_distinct(self):
        self.write('global.json', '{"sdk":{"version":"9.0.102"}}')
        self.write('server/server.csproj', '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>')
        value = self.selected('dotnet')
        self.assertEqual((value['image'], value['runtime_version']), ('mcr.microsoft.com/dotnet/sdk:9.0.102', '8.0'))
    def test_dotnet_platform_target_is_not_linux_substituted(self):
        self.write('app.csproj', '<Project><PropertyGroup><TargetFramework>net8.0-windows</TargetFramework></PropertyGroup></Project>')
        self.assertEqual(self.selected('dotnet')['status'], 'requires_configuration')
    def test_selected_dotnet_project_controls_runtime_with_shared_library(self):
        self.write('stackpilot.json', '{"project":"server/server.csproj"}')
        self.write('server/server.csproj', '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>')
        self.write('shared/shared.csproj', '<Project><PropertyGroup><TargetFramework>net6.0</TargetFramework></PropertyGroup></Project>')
        value = self.selected('dotnet')
        self.assertEqual((value['version'], value['runtime_version'], value['issues']), ('8.0', '8.0', []))
    def test_ruby_and_php_numeric_ranges(self):
        self.write('Gemfile', 'source "https://rubygems.org"\nruby "~> 3.2"\n')
        self.assertEqual(self.selected('ruby')['version'], '3.3')
        self.write('Gemfile', 'ruby ">=3.1,<3.3"\n')
        self.assertEqual(self.selected('ruby')['version'], '3.2')
        self.write('composer.json', '{"require":{"php":"^7.4 || ^8.1"}}')
        self.assertEqual(self.selected('php')['version'], '8.3')
    def test_numeric_range_semantics(self):
        for version, constraint, expected in [('20.1.0', '^20.0', True), ('21.0', '^20.0', False),
                                             ('3.11.8', '>=3.10,!=3.12.*,<3.13', True), ('3.12.1', '!=3.12.*', False),
                                             ('3.10.15', '~=3.10.2', True), ('3.11', '~=3.10.2', False),
                                             ('18.4', '18.x', True), ('20', '18 || 20', True)]:
            with self.subTest(version=version, constraint=constraint): self.assertEqual(satisfies(version, constraint), expected)
        for constraint in ('lts/*', '>=3.10; DROP', 'system', '1.2rc1'):
            with self.assertRaises(ValueError): satisfies('3.12', constraint)
    def test_untrusted_source_is_only_read(self):
        sentinel = self.root/'executed'
        self.write('setup.py', "from pathlib import Path; Path('executed').touch()\n")
        result = analyze(self.root)
        self.assertFalse(sentinel.exists()); self.assertEqual(result['toolchains'][0]['kind'], 'python')
    def test_runtime_assets_include_version_discovery(self):
        self.write('main.py', "print(input('Number: '))\n")
        prepare(self.root, 'standard_web')
        self.assertTrue((self.root/'.stackpilot-runtime/repository_toolchains.py').is_file())
    def test_default_recipe_performs_build_then_repository_tests(self):
        self.write('package.json', '{"scripts":{"start":"node server.js"},"engines":{"node":"20.x"}}')
        prepare(self.root, 'standard_web')
        contents = (self.root/'Dockerfile').read_text()
        self.assertIn('FROM node:20-bookworm-slim', contents)
        self.assertIn('linux_build.py node', contents)
        self.assertNotIn('|| true', contents)
    def test_acceptance_profile_respects_node_lock_and_manager_pin(self):
        self.write('package.json', '{"packageManager":"pnpm@9.15.4","engines":{"node":"20.x"}}')
        self.write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n")
        value = verification_profile(self.root)
        self.assertEqual(value['image'], 'node:20-bookworm-slim')
        self.assertIn(['corepack', 'prepare', 'pnpm@9.15.4', '--activate'], value['setup'])
        self.assertIn(['pnpm', 'install', '--frozen-lockfile'], value['setup'])
        self.assertTrue(value['network']); self.assertFalse(value['execution_verified'])
    def test_acceptance_installs_python_dependencies_and_test_runner(self):
        self.write('requirements.txt', ''); self.write('.python-version', '3.11'); self.write('tests/test_math.py', 'assert 2+2==4\n')
        value = verification_profile(self.root)
        self.assertEqual(value['image'], 'python:3.11-slim')
        self.assertEqual(value['setup'], [['python', '-m', 'pip', 'install', '--no-cache-dir', '-r', 'requirements.txt'], ['python', '-m', 'pip', 'install', '--no-cache-dir', 'pytest']])
    def test_acceptance_unknown_kind_requires_explicit_image(self):
        value = verification_profile(self.root)
        self.assertIsNone(value['image']); self.assertTrue(value['issues'])
    def test_acceptance_does_not_force_absent_rust_lockfile(self):
        self.write('Cargo.toml', '[package]\nname="fixture"\nversion="0.1.0"\n')
        self.assertEqual(verification_profile(self.root)['setup'], [['cargo', 'fetch']])
        self.write('Cargo.lock', '# fixture lock\n')
        self.assertEqual(verification_profile(self.root)['setup'], [['cargo', 'fetch', '--locked']])
    def test_acceptance_php_verifies_installer_signature(self):
        self.write('composer.json', '{"require":{"php":"^8.2"}}')
        value = verification_profile(self.root)
        self.assertEqual(value['image'], 'php:8.3-cli')
        self.assertIn("hash_file('sha384',$p)!==$s", value['setup'][0][2])
        self.assertNotIn('--ignore-platform-reqs', json.dumps(value))
    def test_missing_gpu_persists_provisioning_request_before_build(self):
        self.write('stackpilot.json', '{"workload":"api","capabilities":["gpu"]}')
        with patch.dict('os.environ', {'STACKPILOT_DOCKER_CAPABILITIES': ''}):
            with self.assertRaisesRegex(ValueError, 'provisioning request'): prepare(self.root, 'standard_web')
        value = json.loads((self.root/'.stackpilot-plan.json').read_text())
        self.assertEqual(value['sandbox']['status'], 'unavailable')
        self.assertIn('gpu', value['sandbox']['provisioning']['requested_capabilities'])
        self.assertFalse(value['sandbox']['provisioning']['implemented'])
        self.assertFalse((self.root/'Dockerfile').exists())
    def test_mismatched_architecture_is_not_admitted_as_native_execution(self):
        self.write('stackpilot.json', '{"capabilities":["arch.arm64"]}')
        with patch.dict('os.environ', {'STACKPILOT_DOCKER_ARCHITECTURE': 'amd64', 'STACKPILOT_DOCKER_CAPABILITIES': ''}):
            with self.assertRaisesRegex(ValueError, 'unavailable'): prepare(self.root, 'standard_web')
        value = json.loads((self.root/'.stackpilot-plan.json').read_text())
        self.assertIn('arch.arm64', value['sandbox']['missing'])


if __name__ == '__main__': unittest.main()
