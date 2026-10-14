"""Reproduce the client bundle from the verified Apache source release."""
import hashlib
import io
from pathlib import Path
import tarfile
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
URL = 'https://downloads.apache.org/guacamole/1.6.0/source/guacamole-client-1.6.0.tar.gz'
SHA256 = '81f9fd5a7b4377fb0ee295d0d4fec92e9667f2aafaa3d0ed8937f535deabdee4'


def main():
    data = urlopen(URL, timeout=60).read()
    if hashlib.sha256(data).hexdigest() != SHA256:
        raise RuntimeError('Apache source checksum mismatch')
    target = ROOT / 'frontend/public/vendor'
    target.mkdir(exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        prefix = 'guacamole-client-1.6.0/guacamole-common-js/src/main/webapp/'
        modules = sorted(item.name for item in archive.getmembers()
                         if item.name.startswith(prefix + 'modules/') and item.name.endswith('.js'))
        namespace = prefix + 'modules/Namespace.js'
        modules.remove(namespace)
        parts = [prefix + 'common/license.js', namespace] + modules
        bundle = '\n'.join(archive.extractfile(name).read().decode() for name in parts)
        (target / 'guacamole-1.6.0.js').write_text(bundle, encoding='utf-8')
        for name in ('LICENSE', 'NOTICE'):
            (target / ('guacamole-' + name + '.txt')).write_bytes(archive.extractfile('guacamole-client-1.6.0/' + name).read())


if __name__ == '__main__':
    main()
