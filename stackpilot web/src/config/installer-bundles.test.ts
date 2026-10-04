// @vitest-environment node
import { expect, it } from 'vitest';
import { readFileSync, mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
// @ts-expect-error The build-time ZIP writer is a standard Node ESM module.
import { archive, buildBundles } from '../../scripts/installer-bundles.mjs';

it('produces deterministic ZIP entries that unzip to the original bytes', () => {
  const files = [{ name: 'fixture.sh', executable: true, data: Buffer.from('#!/bin/bash\nprintf OK\n') }];
  const first = archive(files);
  expect(archive(files)).toEqual(first);
  expect(first.readUInt32LE(0)).toBe(0x04034b50);
  const size = first.readUInt32LE(18), nameSize = first.readUInt16LE(26);
  expect(first.subarray(30, 30 + nameSize).toString()).toBe('StackPilot Setup/fixture.sh');
  expect(inflateRawSync(first.subarray(30 + nameSize, 30 + nameSize + size))).toEqual(files[0].data);
  const directory = 30 + nameSize + size;
  expect(first.readUInt32LE(directory)).toBe(0x02014b50);
  expect(first.readUInt32LE(directory + 38) >>> 16).toBe(0o100755);
});

it('builds all platform downloads with working launcher targets and matching checksums', () => {
  const directory = mkdtempSync(join(tmpdir(), 'stackpilot-bundles-test-'));
  const names = ['windows', 'macos', 'linux'].map(platform => `stackpilot-setup-${platform}.zip`);
  try {
    buildBundles(pathToFileURL(directory + sep));
    const checksums = readFileSync(join(directory, 'stackpilot-setup-checksums.txt'), 'utf8');
    for (const [index, name] of names.entries()) {
      const zip = readFileSync(join(directory, name)), entries = new Map<string, Buffer>();
      for (let offset = 0; zip.readUInt32LE(offset) === 0x04034b50;) {
        const size = zip.readUInt32LE(offset + 18), nameSize = zip.readUInt16LE(offset + 26);
        const filename = zip.subarray(offset + 30, offset + 30 + nameSize).toString().replace('StackPilot Setup/', '');
        entries.set(filename, inflateRawSync(zip.subarray(offset + 30 + nameSize, offset + 30 + nameSize + size)));
        offset += 30 + nameSize + size;
      }
      expect(entries.has('setup_server.py')).toBe(true);
      expect(entries.has('lifecycle.py')).toBe(true);
      expect(entries.has('setup.html')).toBe(true);
      expect(entries.has('.env')).toBe(false);
      const launcher = index === 0 ? 'launch-setup.ps1' : index === 1 ? 'Start StackPilot.command' : 'Start StackPilot.sh';
      expect(entries.get(launcher)?.toString()).toContain('setup_server.py');
      expect(checksums).toContain(`${createHash('sha256').update(zip).digest('hex')}  ${name}`);
    }
  } finally {
    // Remove only known files in this test's freshly created temporary directory.
    for (const name of [...names, 'stackpilot-setup-checksums.txt']) {
      try { unlinkSync(join(directory, name)); } catch { /* failed build may not create every file */ }
    }
    rmdirSync(directory);
  }
});
