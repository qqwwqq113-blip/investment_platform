import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/glory/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const dist = resolve(import.meta.dirname, '../dist');
const transactions = [
  { id: '11111111-1111-4111-8111-111111111111', traded_at: '2026-09-17T05:00:00Z', ticker: 'QLD', trade_type: 'BUY', quantity: 5, price: 87, amount: 435, fee: 1, memo: '' },
  { id: '22222222-2222-4222-8222-222222222222', traded_at: '2026-09-16T05:00:00Z', ticker: 'QQQ', trade_type: 'BUY', quantity: 2, price: 590, amount: 1180, fee: 1, memo: '' },
  { id: '33333333-3333-4333-8333-333333333333', traded_at: '2026-09-15T05:00:00Z', ticker: 'SGOV', trade_type: 'BUY', quantity: 40, price: 100, amount: 4000, fee: 0, memo: '' },
  { id: '44444444-4444-4444-8444-444444444444', traded_at: '2026-09-14T05:00:00Z', ticker: 'CASH', trade_type: 'DEPOSIT', quantity: 0, price: 30000, amount: 30000, fee: 0, memo: '' },
];
const snapshots = Array.from({ length: 12 }, (_, index) => ({
  snapshot_date: `2026-09-${String(index + 7).padStart(2, '0')}`,
  total_equity: 30000 + index * 75,
  total_cost: 30000,
  net_contributions: 30000,
  cash_balance: 24384,
  holdings: [{ ticker: 'QQQ', quantity: 2, price: 590 + index }, { ticker: 'QLD', quantity: 5, price: 87 + index / 2 }, { ticker: 'SGOV', quantity: 40, price: 100 }],
  twr_daily_return: index ? 0.002 : null,
  twr_coverage_start: '2026-09-08',
}));
const settings = { targetQQQ: 10, targetQLD: 70, targetSGOV: 20, qqqTrigger1: -20, qqqTrigger1SgovPct: 50, qqqTrigger2: -30, qqqTrigger2RemainingPct: 100, qldRebalanceTrigger: 85 };
const benchmark = snapshots.filter(item => item.twr_daily_return !== null).map((item, index) => ({ date: item.snapshot_date, value: 500 + index * 2 }));
const json = value => Buffer.from(JSON.stringify(value));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const server = createServer(async (request, response) => {
  if (request.url === '/api/session') { response.setHeader('content-type', 'application/json'); response.end(json({ authenticated: true })); return; }
  if (request.url === '/api/data') { response.setHeader('content-type', 'application/json'); response.end(json({ transactions, snapshots })); return; }
  if (request.url === '/api/settings') { response.setHeader('content-type', 'application/json'); response.end(json({ settings })); return; }
  if (request.url === '/api/benchmark') { response.setHeader('content-type', 'application/json'); response.end(json({ basis: 'adjusted_close', points: benchmark })); return; }
  if (request.url === '/api/strategy') { response.setHeader('content-type', 'application/json'); response.end(json({ drawdown: { peak: 700, peakDate: '2026-08-01', current: -0.213, cycleMinimum: -0.23, stage: 1, first20: '2026-09-10', latestPrice: 550.9, latestDate: '2026-09-18', cycleId: 'QQQ:2026-08-01' } })); return; }
  if (request.url === '/api/quotes') { response.setHeader('content-type', 'application/json'); response.end(json({ fetchedAt: new Date().toISOString(), quotes: [{ ticker: 'QQQ', price: 600 }, { ticker: 'QLD', price: 91 }, { ticker: 'SGOV', price: 100.5 }] })); return; }
  const path = request.url === '/' ? join(dist, 'index.html') : join(dist, request.url.replace(/^\//, ''));
  try { response.setHeader('content-type', types[extname(path)] || 'application/octet-stream'); response.end(await readFile(path)); } catch { response.statusCode = 404; response.end('not found'); }
});
await new Promise(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
const port = server.address().port;
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
try {
  for (const viewport of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'tablet-landscape', width: 1024, height: 768 }, { name: 'tablet-portrait', width: 768, height: 1024 }, { name: 'mobile', width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle' });
    await page.locator('#total-equity').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `${viewport.name}: horizontal overflow`);
    await page.screenshot({ path: join(tmpdir(), `portfolio-home-${viewport.name}.png`), fullPage: true });
    await page.locator('[data-performance-view="benchmark"]').click();
    await page.locator('#benchmark-chart svg').waitFor();
    await page.screenshot({ path: join(tmpdir(), `portfolio-benchmark-${viewport.name}.png`), fullPage: true });
    await page.locator('[data-page="settings"]').click();
    assert.equal(await page.locator('#target-save').isEnabled(), true, `${viewport.name}: strategy form`);
    await page.screenshot({ path: join(tmpdir(), `portfolio-settings-${viewport.name}.png`), fullPage: true });
    await page.locator('[data-page="portfolio"]').click();
    await page.locator('.holding-detail').first().click();
    await page.locator('[data-page="transactions"]').click();
    await page.locator('.more-button').first().click();
    assert.equal(await page.locator('.row-menu.open').count(), 1, `${viewport.name}: transaction menu`);
    await page.screenshot({ path: join(tmpdir(), `portfolio-transactions-${viewport.name}.png`), fullPage: true });
    assert.deepEqual(errors, [], `${viewport.name}: browser errors`);
    await page.close();
  }
  console.log('Visual smoke passed: desktop, tablet landscape, tablet portrait, mobile.');
} finally {
  await browser.close();
  server.close();
}
