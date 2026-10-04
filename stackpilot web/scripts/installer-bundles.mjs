// A small deterministic ZIP writer using only Node's standard library.
// Website builds need no Python, platform-specific archiver, or signing secret.
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function archive(files) {
  const local = [], central = [];
  let offset = 0;
  for (const { name, data, executable = false } of files) {
    const filename = Buffer.from(`StackPilot Setup/${name}`);
    const compressed = deflateRawSync(data);
    const checksum = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8); header.writeUInt16LE(33, 12);
    header.writeUInt32LE(checksum, 14); header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, compressed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(0x314, 4); entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x800, 8); entry.writeUInt16LE(8, 10); entry.writeUInt16LE(33, 14);
    entry.writeUInt32LE(checksum, 16); entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(filename.length, 28);
    entry.writeUInt32LE(((executable ? 0o100755 : 0o100644) << 16) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, filename);
    offset += header.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

export function buildBundles(publicDirectory) {
  const root = new URL('../../', import.meta.url);
  const read = path => Buffer.from(readFileSync(new URL(path, root), 'utf8').replace(/\r\n/g, '\n'));
  const common = ['setup_server.py', 'lifecycle.py', 'setup.html'].map(name => ({ name, data: read(`stackpilot-cli/stackpilot_cli/${name}`) }));
  common.push(...['install.sh', 'install.ps1'].map(name => ({ name, data: read(`scripts/${name}`), executable: name.endsWith('.sh') })));
  common.push({ name: 'README.md', data: read('docs/guided-setup.md') });
  const sums = [];
  for (const platform of ['windows', 'macos', 'linux']) {
    const launcher = platform === 'windows' ? [
      { name: 'Start StackPilot.cmd', data: read('scripts/launch-setup.cmd') },
      { name: 'launch-setup.ps1', data: read('scripts/launch-setup.ps1') },
    ] : [{ name: platform === 'macos' ? 'Start StackPilot.command' : 'Start StackPilot.sh', data: read('scripts/launch-setup.sh'), executable: true }];
    const name = `stackpilot-setup-${platform}.zip`, data = archive([...common, ...launcher]);
    writeFileSync(new URL(name, publicDirectory), data);
    sums.push(`${createHash('sha256').update(data).digest('hex')}  ${name}`);
  }
  writeFileSync(new URL('stackpilot-setup-checksums.txt', publicDirectory), sums.join('\n') + '\n');
}
