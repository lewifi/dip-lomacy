import { readFile, writeFile, mkdir, cp } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = dirname(fileURLToPath(import.meta.url));

const arena = await readFile(join(root, 'arena.html'), 'utf8');

// Read pre-namespaced SVGs (tst/dst prefixes already baked in)
const tendie = (await readFile(join(root, 'public', 'assets', 'tendie.svg'), 'utf8'))
  .replace(/<\?xml[^>]*\?>/, '');
const dimmie = (await readFile(join(root, 'public', 'assets', 'XLB.svg'), 'utf8'))
  .replace(/<\?xml[^>]*\?>/, '');
const cheese = (await readFile(join(root, 'public', 'assets', 'cheesey.svg'), 'utf8'))
  .replace(/<\?xml[^>]*\?>/, '');

const out = arena
  .replace('{{TENDIE_SVG}}', () => tendie)
  .replace('{{DIMMIE_SVG}}', () => dimmie)
  .replace('{{CHEESE_SVG}}', () => cheese);

await mkdir(join(root, 'dist'), { recursive: true });
await writeFile(join(root, 'dist', 'index.html'), out, 'utf8');

// Copy assets folder (OG images, etc.)
try {
  await cp(join(root, 'public', 'assets'), join(root, 'dist', 'assets'), { recursive: true });
  console.log('Copied public/assets to dist/assets/');
} catch (e) {
  console.error('Failed copying public/assets:', e);
}

// Copy favicon
const faviconSrc = join(root, 'public', 'assets', 'favicon.svg');
try {
  const fav = await readFile(faviconSrc, 'utf8');
  await writeFile(join(root, 'dist', 'favicon.svg'), fav, 'utf8');
  console.log('Copied favicon.svg to dist/');
} catch { console.log('⚠ No favicon.svg found in public/assets/'); }

// Copy service worker to dist root (must be served from root scope)
try {
  const sw = await readFile(join(root, 'public', 'sw.js'), 'utf8');
  await writeFile(join(root, 'dist', 'sw.js'), sw, 'utf8');
  console.log('Copied sw.js to dist/');
} catch { console.log('⚠ No sw.js found in public/'); }

console.log(`Built dist/index.html (${(out.length / 1024).toFixed(0)} KB)`);
