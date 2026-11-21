import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/glory/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const dist = resolve(import.meta.dirname, '../dist');
const phase1aScreenshots = resolve(import.meta.dirname, '../docs/investment-intelligence/screenshots/phase1a');
const phase1bScreenshots = resolve(import.meta.dirname, '../docs/investment-intelligence/screenshots/phase1b');
const phase2Screenshots = resolve(import.meta.dirname, '../docs/investment-intelligence/screenshots/phase2');
const phase3Screenshots = resolve(import.meta.dirname, '../docs/investment-intelligence/screenshots/phase3');
const phase4Screenshots = resolve(import.meta.dirname, '../docs/investment-intelligence/screenshots/phase4');
const phase5Screenshots = resolve(import.meta.dirname, '../docs/investment-intelligence/screenshots/phase5');
await mkdir(phase1aScreenshots, { recursive: true });
await mkdir(phase1bScreenshots, { recursive: true });
await mkdir(phase2Screenshots, { recursive: true });
await mkdir(phase3Screenshots, { recursive: true });
await mkdir(phase4Screenshots, { recursive: true });
await mkdir(phase5Screenshots, { recursive: true });
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
const benchmark = Array.from({ length: 680 }, (_, index) => ({
  date: new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10),
  value: 500 + index * 0.24 + Math.sin(index / 18) * 22 + Math.sin(index / 61) * 35,
}));
const json = value => Buffer.from(JSON.stringify(value));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
let postedTransaction = null;
let postRequestCount = 0;
let patchedTransaction = null;
let deletedTransactionId = null;

const server = createServer(async (request, response) => {
  if (request.url === '/api/session') { response.setHeader('content-type', 'application/json'); response.end(json({ authenticated: true })); return; }
  if (request.url === '/api/data') { response.setHeader('content-type', 'application/json'); response.end(json({ transactions, snapshots, adjustments: [] })); return; }
  if (request.url === '/api/settings') { response.setHeader('content-type', 'application/json'); response.end(json({ settings })); return; }
  if (request.url === '/api/benchmark') { response.setHeader('content-type', 'application/json'); response.end(json({ basis: 'adjusted_close', points: benchmark })); return; }
  if (request.url === '/api/market-history' && request.method === 'POST') {
    response.setHeader('content-type', 'application/json'); response.end(json({ source: 'Yahoo Finance', adjustedPrices: true, fetchedAt: new Date().toISOString(), histories: {
      QQQ: benchmark,
      QLD: benchmark.map((point, index) => ({ date: point.date, value: 80 + index * 0.18 + Math.sin(index / 14) * 16 })),
      SGOV: benchmark.map((point, index) => ({ date: point.date, value: 100 + index * 0.01 })),
    } })); return;
  }
  if (request.url === '/api/strategy') { response.setHeader('content-type', 'application/json'); response.end(json({ drawdown: { peak: 700, peakDate: '2026-08-01', current: -0.213, cycleMinimum: -0.23, stage: 1, first20: '2026-09-10', latestPrice: 550.9, latestDate: '2026-09-18', cycleId: 'QQQ:2026-08-01' }, drawdownHistory: snapshots.map((snapshot, index) => ({ date: snapshot.snapshot_date, drawdown: -0.1 - index * 0.01 })) })); return; }
  if (request.url === '/api/quotes') { response.setHeader('content-type', 'application/json'); response.end(json({ fetchedAt: new Date().toISOString(), quotes: [{ ticker: 'QQQ', price: 600 }, { ticker: 'QLD', price: 91 }, { ticker: 'SGOV', price: 100.5 }] })); return; }
  if (request.url === '/api/transactions' && request.method === 'POST') {
    postRequestCount += 1;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    postedTransaction = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    response.setHeader('content-type', 'application/json'); response.statusCode = 201; response.end(json({ id: '55555555-5555-4555-8555-555555555555' })); return;
  }
  const transactionMatch = request.url.match(/^\/api\/transactions\/([0-9a-f-]{36})$/i);
  if (transactionMatch && request.method === 'PATCH') {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    patchedTransaction = { id: transactionMatch[1], ...JSON.parse(Buffer.concat(chunks).toString('utf8')) };
    response.setHeader('content-type', 'application/json'); response.end(json(patchedTransaction)); return;
  }
  if (transactionMatch && request.method === 'DELETE') {
    deletedTransactionId = transactionMatch[1];
    response.statusCode = 204; response.end(); return;
  }
  const path = request.url === '/' ? join(dist, 'index.html') : join(dist, request.url.replace(/^\//, ''));
  try { response.setHeader('content-type', types[extname(path)] || 'application/octet-stream'); response.end(await readFile(path)); } catch { response.statusCode = 404; response.end('not found'); }
});
await new Promise(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
const port = server.address().port;
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
try {
  for (const viewport of [{ name: 'desktop', width: 1440, height: 900, theme: 'light' }, { name: 'tablet-landscape', width: 1024, height: 768, theme: 'dark' }, { name: 'tablet-portrait', width: 768, height: 1024, theme: 'light' }, { name: 'mobile-390', width: 390, height: 844, theme: 'dark' }, { name: 'mobile-360', width: 360, height: 800, theme: 'light' }]) {
    const page = await browser.newPage({ viewport });
    await page.addInitScript(theme => {
      if (!localStorage.getItem('portfolio_theme_preference')) localStorage.setItem('portfolio_theme_preference', theme);
    }, viewport.theme);
    const errors = [];
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle' });
    await page.locator('#total-equity').waitFor();
    assert.equal(await page.locator('html').getAttribute('data-theme'), viewport.theme, `${viewport.name}: initial theme`);
    assert.equal(await page.locator('#theme-preference').inputValue(), viewport.theme, `${viewport.name}: theme control`);
    assert.equal(await page.locator('.nav').evaluate(element => getComputedStyle(element).position), viewport.width <= 900 ? 'fixed' : 'static', `${viewport.name}: responsive navigation`);
    assert.equal(await page.locator('#cash-weight').count(), 0, `${viewport.name}: cash metric removed`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `${viewport.name}: horizontal overflow`);
    await page.screenshot({ path: join(phase1aScreenshots, `${viewport.name}-${viewport.theme}-home.png`), fullPage: true });
    if (viewport.name === 'desktop') {
      await page.locator('#edit-dashboard').click();
      await page.locator('[data-editor-card="market"] input').uncheck();
      await page.locator('#save-dashboard').click();
      assert.equal(await page.locator('[data-dashboard-card="market"]').isVisible(), false, 'desktop: dashboard card hidden');
      await page.reload({ waitUntil: 'networkidle' });
      assert.equal(await page.locator('[data-dashboard-card="market"]').isVisible(), false, 'desktop: dashboard layout persists');
      await page.locator('#edit-dashboard').click();
      await page.locator('#reset-dashboard').click();
      await page.locator('#save-dashboard').click();
      assert.equal(await page.locator('[data-dashboard-card="market"]').isVisible(), true, 'desktop: dashboard reset');
      await page.screenshot({ path: join(phase2Screenshots, 'desktop-light-command-center.png'), fullPage: true });
    }
    if (viewport.name === 'mobile-390') {
      await page.screenshot({ path: join(phase2Screenshots, 'mobile-390-dark-command-center.png'), fullPage: true });
      await page.locator('[data-action="new-transaction"]').click();
      assert.equal(await page.locator('#page-transactions').getAttribute('class'), 'page active', 'mobile: one-tap trade entry');
      await page.locator('[data-page="home"]').click();
    }
    if (viewport.name === 'tablet-landscape') {
      await page.locator('[data-page="market"]').click();
      await page.locator('#market-comparison-chart svg').waitFor();
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark', 'tablet landscape: market dark theme');
      await page.screenshot({ path: join(phase3Screenshots, 'tablet-landscape-dark-market-analysis.png'), fullPage: true });
      await page.locator('[data-page="lab"]').click();
      await page.locator('#run-research').click();
      await page.locator('.strategy-result').first().waitFor();
      assert.equal(await page.locator('.strategy-result').count(), 3, 'tablet landscape: three strategy comparison');
      assert.match(await page.locator('#research-data-status').textContent(), /공통 거래일/);
      await page.locator('#run-stress').click();
      assert.match(await page.locator('#stress-result').textContent(), /예상 자산/);
      await page.screenshot({ path: join(phase4Screenshots, 'tablet-landscape-dark-strategy-lab.png'), fullPage: true });
      await page.locator('#start-optimizer').click();
      await page.waitForFunction(() => document.querySelector('#optimizer-status').textContent.includes('264개 완료'), null, { timeout: 30000 });
      assert.equal(await page.locator('.optimizer-row').count(), 5, 'tablet landscape: optimizer top five');
      await page.screenshot({ path: join(phase5Screenshots, 'tablet-landscape-dark-optimizer.png'), fullPage: true });
      await page.locator('#start-optimizer').click();
      await page.locator('#cancel-optimizer').click();
      await page.waitForFunction(() => document.querySelector('#optimizer-status').textContent.includes('취소됨'), null, { timeout: 30000 });
      await page.locator('[data-page="home"]').click();
    }
    if (viewport.name === 'tablet-portrait') {
      await page.locator('[data-page-link="market"]').first().click();
      await page.locator('#market-comparison-chart svg').waitFor();
      assert.equal(await page.locator('.analog-row').count(), 3, 'tablet: three historical analogs');
      await page.locator('[data-market-series="equity"]').check();
      await page.locator('#market-period').selectOption('90');
      await page.locator('#market-normalization').selectOption('return');
      assert.match(await page.locator('#market-chart-summary').textContent(), /누적 변화율/);
      const scoreBefore = await page.locator('#market-risk-score').textContent();
      await page.locator('#risk-trend-chart svg').waitFor();
      assert.match(await page.locator('#risk-trend-summary').textContent(), /일별 스냅샷/);
      await page.locator('#risk-score-method').click();
      assert.match(await page.locator('#risk-score-method').textContent(), /QQQ가 직전 일중 최고가/);
      await page.locator('#risk-weight-drawdown').fill('100');
      await page.locator('#risk-weight-concentration').fill('0');
      await page.locator('#risk-weight-leverage').fill('0');
      const scoreAfter = await page.locator('#market-risk-score').textContent();
      assert.notEqual(scoreAfter, scoreBefore, 'tablet: risk weights recalculate score');
      assert.equal(await page.locator('#risk-weight-drawdown + output').textContent(), '100%', 'tablet: weight output');
      assert.match(await page.locator('#market-freshness').textContent(), /종가 기준/);
      await page.locator('#reset-risk-weights').click();
      assert.equal(await page.locator('#risk-weight-drawdown + output').textContent(), '45%', 'tablet: default risk weights restored');
      await page.screenshot({ path: join(phase3Screenshots, 'tablet-portrait-light-market-analysis.png'), fullPage: true });
      await page.locator('[data-page="home"]').click();
    }
    await page.locator('[data-performance-view="benchmark"]').click();
    await page.locator('#benchmark-chart svg').waitFor();
    await page.screenshot({ path: join(tmpdir(), `portfolio-benchmark-${viewport.name}.png`), fullPage: true });
    await page.locator('[data-page="settings"]').click();
    assert.equal(await page.locator('#target-save').isEnabled(), true, `${viewport.name}: strategy form`);
    await page.screenshot({ path: join(tmpdir(), `portfolio-settings-${viewport.name}.png`), fullPage: true });
    await page.locator('[data-page="portfolio"]').click();
    await page.locator('.holding-detail').first().click();
    await page.locator('[data-page="transactions"]').click();
    await page.locator('#open-adjustment').click();
    await page.locator('#actual-balance').fill('24380');
    assert.equal(await page.locator('#save-adjustment').isEnabled(), true, `${viewport.name}: adjustment preview`);
    await page.locator('#close-adjustment').click();
    assert.deepEqual(await page.locator('#ticker option').allTextContents(), ['QLD', 'QQQ', 'SGOV'], `${viewport.name}: ticker choices`);
    assert.deepEqual(await page.locator('.trade-type').allTextContents(), ['매수', '매도'], `${viewport.name}: stock transactions only`);
    assert.equal(await page.locator('#fee').count(), 0, `${viewport.name}: fee input removed`);
    assert.equal(await page.locator('#funding-source').inputValue(), 'NEW_CAPITAL', `${viewport.name}: new capital default`);
    if (viewport.name === 'mobile-360') {
      await page.locator('#quantity').fill('0');
      await page.locator('#price').fill('0');
      await page.locator('#transaction-submit').click();
      assert.equal(await page.locator('#quantity').getAttribute('aria-invalid'), 'true', 'mobile: quantity field error');
      assert.match(await page.locator('#quantity-error').textContent(), /0보다 커야/);
      await page.locator('[data-page="portfolio"]').click();
      await page.locator('.holding-detail').first().click();
      const quickTicker = await page.locator('[data-quick-trade="SELL"]').first().getAttribute('data-quick-ticker');
      await page.locator('[data-quick-trade="SELL"]').first().click();
      assert.equal(await page.locator('#trade-type').inputValue(), 'SELL', 'mobile: holding quick sell');
      assert.equal(await page.locator('#ticker').inputValue(), quickTicker, 'mobile: quick trade ticker');
      assert.match(await page.locator('#ticker-availability').textContent(), /매도 가능/);
      await page.screenshot({ path: join(phase1bScreenshots, 'mobile-360-light-trade-ticket.png'), fullPage: true });
    }
    if (viewport.name === 'desktop') {
      await page.locator('[data-page="settings"]').click();
      await page.locator('#theme-preference').selectOption('dark');
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark', 'desktop: theme switches immediately');
      await page.reload({ waitUntil: 'networkidle' });
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark', 'desktop: theme persists after reload');
      await page.locator('[data-page="transactions"]').click();
      await page.locator('#ticker').selectOption('QQQ');
      await page.locator('#quantity').fill('1');
      await page.locator('#price').fill('600');
      await page.locator('#transaction-form button[type="submit"]').evaluate(button => { button.click(); button.click(); });
      await page.locator('#toast.visible').waitFor();
      assert.equal(await page.locator('#toast').textContent(), '매수 거래 입력이 완료되었습니다.');
      assert.equal(postRequestCount, 1, 'desktop: duplicate submit guarded');
      assert.equal(postedTransaction.funding_source, 'NEW_CAPITAL');
      assert.equal(postedTransaction.fee, 0);
    }
    await page.locator('.more-button').first().click();
    assert.equal(await page.locator('.row-menu.open').count(), 1, `${viewport.name}: transaction menu`);
    if (viewport.name === 'mobile-360') {
      await page.locator('.row-menu.open [data-edit]').click();
      await page.locator('#quantity').fill('4');
      await page.locator('#price').fill('88');
      await page.locator('#transaction-submit').click();
      await page.locator('#toast.visible').waitFor();
      assert.equal(patchedTransaction.id, transactions[0].id, 'mobile: edited transaction id');
      assert.equal(patchedTransaction.quantity, 4, 'mobile: edited transaction quantity');
      await page.locator('.more-button').nth(1).click();
      await page.locator('.row-menu.open [data-delete]').click();
      assert.match(await page.locator('#delete-transaction-summary').textContent(), /QQQ 매수/);
      await page.screenshot({ path: join(phase1bScreenshots, 'mobile-360-light-delete-confirmation.png'), fullPage: true });
      const deleteResponse = page.waitForResponse(response => response.url().includes(`/api/transactions/${transactions[1].id}`) && response.request().method() === 'DELETE');
      await page.locator('#delete-dialog [value="confirm"]').click();
      await page.locator('#delete-dialog').waitFor({ state: 'hidden' });
      await deleteResponse;
      assert.equal(deletedTransactionId, transactions[1].id, 'mobile: deleted transaction id');
    }
    await page.screenshot({ path: join(tmpdir(), `portfolio-transactions-${viewport.name}.png`), fullPage: true });
    assert.deepEqual(errors, [], `${viewport.name}: browser errors`);
    await page.close();
  }
  console.log('Visual smoke passed: 1440, 1024, 768, 390 and 360 with light/dark themes.');
} finally {
  await browser.close();
  server.close();
}
