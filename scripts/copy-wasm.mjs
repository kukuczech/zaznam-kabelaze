// Zkopíruje web-ifc.wasm z node_modules do public/, aby ho Vite servíroval i zabalil.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'public'), { recursive: true });
copyFileSync(
  join(root, 'node_modules', 'web-ifc', 'web-ifc.wasm'),
  join(root, 'public', 'web-ifc.wasm'),
);
console.log('web-ifc.wasm zkopírován do public/');
