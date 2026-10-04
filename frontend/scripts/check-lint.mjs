import { ESLint } from 'eslint';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Brownfield lint ratchet: every rule stays active and new errors fail CI.
// The explicit baseline is reviewed source debt, not a blanket rule exemption.
const eslint = new ESLint();
const results = await eslint.lintFiles(['.']);
const baselinePath = new URL('../eslint-baseline.json', import.meta.url);
const current = new Map();
for (const result of results) {
  const file = path.relative(process.cwd(), result.filePath).split(path.sep).join('/');
  const source = (result.source ?? await readFile(result.filePath, 'utf8')).split(/\r?\n/);
  for (const message of result.messages.filter(message => message.severity === 2)) {
    const rule = message.ruleId ?? 'parse-error';
    const text = source[(message.line ?? 1) - 1]?.trim() ?? '';
    const fingerprint = createHash('sha256').update(`${file}\n${rule}\n${text}`).digest('hex');
    const previous = current.get(fingerprint);
    current.set(fingerprint, { file, rule, text, count: (previous?.count ?? 0) + 1 });
  }
}
if (process.argv.includes('--update-baseline')) {
  await writeFile(baselinePath, JSON.stringify(Object.fromEntries([...current].sort()), null, 2) + '\n');
  console.log('Updated reviewed lint debt. Review this diff before committing.');
} else {
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
  const added = [...current].filter(([key, value]) => value.count > (baseline[key]?.count ?? 0));
  const total = [...current.values()].reduce((sum, item) => sum + item.count, 0);
  const warnings = results.reduce((sum, result) => sum + result.warningCount, 0);
  console.log(`Lint: ${total} existing errors in the reviewed baseline; ${warnings} warnings; ${added.length} new violations.`);
  if (added.length) {
    console.error((await eslint.loadFormatter('stylish')).format(results));
    process.exitCode = 1;
  }
  const resolved = Object.keys(baseline).filter(key => !current.has(key));
  if (resolved.length) console.log(`${resolved.length} baseline entries resolved; remove them with npm run lint:baseline.`);
}
