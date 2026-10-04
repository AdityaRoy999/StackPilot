"""Qualify a real artifact preview: health, delivery hash and source confinement.

Usage: python tests/integration/native_artifact_smoke.py http://localhost:PORT
This proves artifact delivery, not app installation or device workflows.
"""
import hashlib
import json
import sys
import urllib.error
import urllib.parse
import urllib.request


def qualify(base):
    base = base.rstrip('/')
    with urllib.request.urlopen(base + '/healthz', timeout=10) as response:
        health = json.load(response)
    assert health['status'] == 'ready' and health['scope'] == 'artifact_delivery', health
    assert health['artifacts'], 'No build artifacts'
    downloads = []
    for artifact in health['artifacts']:
        digest = hashlib.sha256()
        size = 0
        with urllib.request.urlopen(base + '/artifacts/' + urllib.parse.quote(artifact['name']), timeout=30) as response:
            assert response.headers.get('Content-Disposition', '').startswith('attachment;')
            while chunk := response.read(1024 * 1024):
                digest.update(chunk)
                size += len(chunk)
        assert size == artifact['size'] and digest.hexdigest() == artifact['sha256'], artifact
        downloads.append({**artifact, 'download_verified': True})
    denied = ['/.env', '/manifest.json', '/Dockerfile', '/artifacts/../manifest.json',
              '/artifacts/%2e%2e%2f.env', '/artifacts/manifest.json']
    for path in denied:
        try:
            urllib.request.urlopen(base + path, timeout=10).close()
        except urllib.error.HTTPError as error:
            assert error.code == 404, (path, error.code)
        else:
            raise AssertionError('Private/source path exposed: ' + path)
    return {'url': base, 'scope': 'artifact_delivery', 'verified': True,
            'artifacts': downloads, 'denied_paths': denied, 'device_workflows': 'unverified'}


if __name__ == '__main__':
    print(json.dumps(qualify(sys.argv[1]), indent=2))
