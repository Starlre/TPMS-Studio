import { build } from '../desktop/node_modules/vite/dist/node/index.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root,'docs/viewer-assets');
const oldFiles = await fs.readdir(assets).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
const result = await build({
  configFile: false,
  root: path.join(root, 'web'), base: './', publicDir: false,
  resolve: { alias: [
    { find: 'three/addons', replacement: path.join(root, 'desktop/node_modules/three/examples/jsm') },
    { find: 'three', replacement: path.join(root, 'desktop/node_modules/three/build/three.module.js') },
  ] },
  build: { outDir: path.join(root, 'docs'), assetsDir: 'viewer-assets', emptyOutDir: false },
});
const current = new Set(result.output.map(entry => entry.fileName));
await fs.copyFile(path.join(root,'desktop/node_modules/three/LICENSE'),path.join(assets,'license-three.txt'));
await fs.copyFile(path.join(root,'desktop/node_modules/lucide-react/LICENSE'),path.join(assets,'license-lucide.txt'));
// Remove only obsolete bundles created by this builder. Markdown, screenshots,
// model files and other documentation in docs are never cleared by the build.
for (const file of oldFiles) {
  if (/^(?:index|model\.worker)-[-A-Za-z0-9_]+\.(?:js|css)$/.test(file) && !current.has(`viewer-assets/${file}`)) await fs.unlink(path.join(assets,file));
}
