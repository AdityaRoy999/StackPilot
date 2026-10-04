// Respect the repository's declared package manager and lockfile. Never fall
// through to another entrypoint after an application's startup failure.
const fs = require('fs');
const {spawnSync} = require('child_process');
process.env.COREPACK_ENABLE_AUTO_PIN = '0';
process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT = '0';
const pkg = JSON.parse(fs.readFileSync('package.json','utf8'));
const managerRef = pkg.packageManager || '';
if (typeof managerRef !== 'string' || managerRef.length > 256) throw new Error('Package manager declaration must be bounded text');
const declared = managerRef.split('@')[0];
const manager = declared || (fs.existsSync('pnpm-lock.yaml') ? 'pnpm' : fs.existsSync('yarn.lock') ? 'yarn' : fs.existsSync('bun.lock') || fs.existsSync('bun.lockb') ? 'bun' : 'npm');
if (!['npm','pnpm','yarn','bun'].includes(manager)) throw new Error('Unsupported declared package manager');
const task = process.argv[2];
if (task === 'install' && ['pnpm','yarn'].includes(manager)) {
  const enabled = spawnSync('corepack',['enable'],{stdio:'inherit'});
  if (enabled.status !== 0) process.exit(enabled.status || 1);
  if (managerRef) {
    if (!/^(pnpm|yarn)@\d+(?:\.\d+){0,2}(?:\+sha(?:224|256|384|512)\.[A-Za-z0-9]+)?$/.test(managerRef)) throw new Error('Package manager needs a numeric pinned version or explicit build recipe');
    const prepared = spawnSync('corepack',['prepare',managerRef,'--activate'],{stdio:'inherit'});
    if (prepared.status !== 0) process.exit(prepared.status || 1);
  }
}
if (task === 'install' && manager === 'npm' && managerRef) {
  if (!/^npm@\d+(?:\.\d+){0,2}$/.test(managerRef)) throw new Error('npm package manager needs a numeric version');
  const pinned = spawnSync('npm',['install','--global',managerRef],{stdio:'inherit'});
  if (pinned.status !== 0) process.exit(pinned.status || 1);
}
if (task === 'start' && fs.existsSync('.stackpilot-plan.json')) {
  const plan = JSON.parse(fs.readFileSync('.stackpilot-plan.json','utf8'));
  if (['cli','job'].includes(plan.workload)) {
    const result = spawnSync('python3',['.stackpilot-runtime/console_server.py'],{stdio:'inherit',env:process.env});
    if (result.error) throw result.error;
    process.exit(result.status === null ? 1 : result.status);
  }
}
let args;
if (task !== 'install') {
  if (!pkg.scripts || !pkg.scripts[task]) throw new Error(`No declared ${task} script; configure the application entrypoint`);
  args = ['run', task];
}
if (task === 'install') {
  if (manager === 'yarn') {
    const version = spawnSync('yarn',['--version'],{encoding:'utf8'});
    if (version.status !== 0) throw new Error('Declared Yarn toolchain is unavailable');
    args = fs.existsSync('yarn.lock') ? ['install', Number(version.stdout.trim().split('.')[0]) <= 1 ? '--frozen-lockfile' : '--immutable'] : ['install'];
  } else {
    const locked = manager === 'pnpm' ? fs.existsSync('pnpm-lock.yaml') : fs.existsSync('bun.lock') || fs.existsSync('bun.lockb');
    args = manager === 'npm' ? [fs.existsSync('package-lock.json') ? 'ci' : 'install'] : ['install', ...(locked ? ['--frozen-lockfile'] : [])];
  }
}
const result = spawnSync(manager,args,{stdio:'inherit',env:{...process.env,CI:'true'}});
if (result.error) throw result.error;
process.exit(result.status === null ? 1 : result.status);
