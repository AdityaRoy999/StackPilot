const assert = require('assert');
const {spawnSync} = require('child_process');
const result = spawnSync(process.execPath, ['cli.cjs'], {input: '12\n-7\ninvalid\n', encoding:'utf8', timeout:5000});
assert.equal(result.status, 0);
assert(result.stdout.includes('Square: 144'));
assert(result.stdout.includes('Square: 49'));
assert(result.stdout.includes('Invalid number'));
