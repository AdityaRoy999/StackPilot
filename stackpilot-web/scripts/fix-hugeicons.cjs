const fs = require('fs');
const path = require('path');

const targetDir = path.resolve(__dirname, '..', 'node_modules', '@hugeicons', 'core-free-icons');

if (!fs.existsSync(targetDir)) {
  // Not installed yet
  process.exit(0);
}

console.log('[fix-hugeicons] Inspecting @hugeicons/core-free-icons for case-sensitivity fixes...');

// 1. Fix export paths inside index.js (both ESM and CJS)
const indexFiles = [
  path.join(targetDir, 'dist', 'esm', 'index.js'),
  path.join(targetDir, 'dist', 'cjs', 'index.js'),
  path.join(targetDir, 'dist', 'types', 'index.d.ts'),
];

for (const file of indexFiles) {
  if (fs.existsSync(file)) {
    let content = fs.readFileSync(file, 'utf8');
    const updated = content
      .replace(/\.\/Grid2x2/g, './Grid2X2')
      .replace(/\.\/Grid3x/g, './Grid3X');
    if (content !== updated) {
      fs.writeFileSync(file, updated, 'utf8');
      console.log(`[fix-hugeicons] Patched export paths in ${path.relative(targetDir, file)}`);
    }
  }
}

// 2. Create lowercase copies for any case-sensitive Linux systems expecting lowercase
const subdirs = ['dist/esm', 'dist/cjs', 'dist/types'];
const pairs = [
  ['Grid2X2CheckIcon', 'Grid2x2CheckIcon'],
  ['Grid2X2PlusIcon', 'Grid2x2PlusIcon'],
  ['Grid2X2Icon', 'Grid2x2Icon'],
  ['Grid2X2XIcon', 'Grid2x2XIcon'],
  ['Grid3X2Icon', 'Grid3x2Icon'],
  ['Grid3X3Icon', 'Grid3x3Icon'],
];
const extensions = ['.js', '.js.map', '.d.ts', '.d.ts.map', '.min.js'];

for (const sub of subdirs) {
  const dirPath = path.join(targetDir, sub);
  if (!fs.existsSync(dirPath)) continue;

  for (const [upper, lower] of pairs) {
    for (const ext of extensions) {
      const upperFile = path.join(dirPath, `${upper}${ext}`);
      const lowerFile = path.join(dirPath, `${lower}${ext}`);

      if (fs.existsSync(upperFile) && !fs.existsSync(lowerFile)) {
        try {
          fs.copyFileSync(upperFile, lowerFile);
          console.log(`[fix-hugeicons] Created fallback copy: ${sub}/${lower}${ext}`);
        } catch (err) {
          // Ignore if unable to copy
        }
      }
    }
  }
}

console.log('[fix-hugeicons] Case-sensitivity patch completed successfully.');
