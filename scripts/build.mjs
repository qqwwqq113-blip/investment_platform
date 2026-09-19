import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'dist');
const server = resolve(dist, 'server');
await mkdir(server, { recursive: true });

const publicFiles = ['index.html', 'app.js', 'finance.js', 'styles.css'];
for (const file of publicFiles) await copyFile(resolve(root, file), resolve(dist, file));
await mkdir(resolve(dist, '.openai'), { recursive: true });
await copyFile(resolve(root, '.openai/hosting.json'), resolve(dist, '.openai/hosting.json'));

const mime = { 'index.html': 'text/html; charset=utf-8', 'app.js': 'application/javascript; charset=utf-8', 'finance.js': 'application/javascript; charset=utf-8', 'styles.css': 'text/css; charset=utf-8' };
const assets = {};
for (const file of publicFiles) {
  const encoded = Buffer.from(await readFile(resolve(root, file))).toString('base64');
  assets[`/${file}`] = [encoded, mime[file]];
  if (file === 'index.html') assets['/'] = [encoded, mime[file]];
}
await writeFile(resolve(server, 'assets.js'), `const decode=value=>new TextDecoder().decode(Uint8Array.from(atob(value),char=>char.charCodeAt(0)));\nconst files=${JSON.stringify(assets)};\nexport function staticAsset(pathname){const file=files[pathname];return file?new Response(decode(file[0]),{headers:{'content-type':file[1],'cache-control':'no-store'}}):null}\n`);

let worker = await readFile(resolve(root, 'worker.js'), 'utf8');
worker = `import { staticAsset } from './assets.js';\n${worker}`.replace(
  "return env.ASSETS.fetch(url.pathname === '/' ? new Request(new URL('/index.html', request.url), request) : request);",
  "return staticAsset(url.pathname) || new Response('찾을 수 없습니다.', { status: 404 });",
);
await writeFile(resolve(server, 'index.js'), worker);
console.log(`Built ${publicFiles.length} public assets and Worker output.`);
