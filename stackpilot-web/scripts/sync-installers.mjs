import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const publicDirectory = new URL('../public/', import.meta.url);
mkdirSync(publicDirectory, { recursive: true });
for (const name of ['install.sh', 'install.ps1']) {
  copyFileSync(new URL(`../../scripts/${name}`, import.meta.url), new URL(name, publicDirectory));
}
console.log('Synchronized canonical installers for website downloads.');
