import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const publicFiles = ['index.html', 'app.js', 'finance.js', 'styles.css'];
const normalized = value => value.replaceAll('\r\n', '\n');

test('배포 공개 파일은 정규화된 원본과 일치한다', async () => {
  for (const file of publicFiles) {
    const source = normalized(await readFile(resolve(root, file), 'utf8'));
    const built = await readFile(resolve(root, 'dist', file), 'utf8');
    assert.equal(built, source, `${file} build output`);
  }
});

test('Worker 자산 번들은 정규화된 공개 파일을 포함한다', async () => {
  const bundle = await readFile(resolve(root, 'dist/server/assets.js'), 'utf8');
  const match = bundle.match(/const files=(.*);/);
  assert.ok(match, 'asset manifest');
  const files = JSON.parse(match[1]);

  for (const file of publicFiles) {
    const source = normalized(await readFile(resolve(root, file), 'utf8'));
    const [encoded] = files[`/${file}`];
    assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), source, `${file} embedded asset`);
  }
  assert.deepEqual(files['/'], files['/index.html'], 'root asset alias');
});

test('Worker 배포본은 정적 자산 어댑터와 원본 Worker를 결합한다', async () => {
  const source = normalized(await readFile(resolve(root, 'worker.js'), 'utf8'));
  const built = await readFile(resolve(root, 'dist/server/index.js'), 'utf8');
  assert.ok(built.startsWith("import { staticAsset } from './assets.js';\n"));
  assert.ok(built.includes("return staticAsset(url.pathname) || new Response('찾을 수 없습니다.', { status: 404 });"));
  assert.ok(source.includes('return env.ASSETS.fetch('), 'source Worker keeps the hosting adapter boundary');
});
