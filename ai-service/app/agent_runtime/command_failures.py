"""Stable, bounded failure reasons for retry accounting and model feedback."""
import re


def failure_summary(result):
    if result.get('error'):
        return str(result['error'])[:1000]
    output = str(result.get('output') or '').lower()
    if any(text in output for text in ('javascript heap out of memory', 'reached heap limit', 'allocation failed - javascript')):
        return 'Build worker exhausted its Node heap; inspect the configured worker memory limit before retrying the unchanged build. Source tests or package installation changes will not fix a resource limit.'
    if 'pytest: error: argument' in output:
        return 'Pytest rejected a command option; use the original test command from get_completion_status and the actual reported option syntax'
    if 'error: file or directory not found:' in output:
        return 'Test path does not exist in the selected command root; argv paths are relative to root, so use tests/test_file.py within apps/api'
    if any(text in output for text in ('temporary failure in name resolution', 'network is unreachable', 'could not resolve host')):
        return 'Dependency network unavailable; inspect admitted network policy before retrying'
    if 'no module named' in output or 'executable file not found' in output or 'command not found' in output:
        return 'Missing command/dependency; select the component root and prepare its SDK/dependencies in the same worker'
    if result.get('timed_out'):
        return 'Command exceeded its execution deadline'
    failed_test = re.search(r'^FAILED (.{1,700})', str(result.get('output') or ''), re.MULTILINE)
    if failed_test:
        return 'Repository test failed: '+failed_test.group(1)
    collection_error = re.search(r'^_+ ERROR collecting (.{1,500}?) _+$', str(result.get('output') or ''), re.MULTILINE)
    if collection_error:
        return 'Test collection failed: '+collection_error.group(1)
    if 'required test coverage' in output and 'not reached' in output:
        return 'Original test coverage requirement was not met; add meaningful tests without reducing the protected threshold'
    return 'Command exited with status '+str(result.get('exit_code', 'unknown'))
