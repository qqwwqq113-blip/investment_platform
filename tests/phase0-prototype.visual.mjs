import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/glory/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const prototype = resolve(import.meta.dirname, '../docs/investment-intelligence/phase0-responsive-prototype.html');
const screenshots = resolve(import.meta.dirname, '../docs/investment-intelligence/screenshots');
await mkdir(screenshots, { recursive: true });

const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
try {
  const cases = [
    { name: 'mobile-light-home', width: 390, height: 844, theme: 'light', page: 'home' },
    { name: 'mobile-dark-trade', width: 360, height: 800, theme: 'dark', page: 'trade' },
    { name: 'tablet-light-assets', width: 768, height: 1024, theme: 'light', page: 'assets' },
    { name: 'tablet-dark-home', width: 1024, height: 768, theme: 'dark', page: 'home' },
  ];

  for (const item of cases) {
    const page = await browser.newPage({ viewport: { width: item.width, height: item.height } });
    const errors = [];
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`file:///${prototype.replaceAll('\\', '/')}`);
    await page.locator('#theme').selectOption(item.theme);
    const navigation = item.width >= 1024 ? '.sidebar' : '.bottom-nav';
    await page.locator(`${navigation} [data-page="${item.page}"]`).click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `${item.name}: horizontal overflow`);
    assert.equal(await page.locator('.prototype-badge').isVisible(), true, `${item.name}: prototype disclosure`);
    if (item.width < 1024) assert.equal(await page.locator('.bottom-nav').isVisible(), true, `${item.name}: mobile navigation`);
    if (item.width >= 1024) assert.equal(await page.locator('.sidebar').isVisible(), true, `${item.name}: side navigation`);
    if (item.page === 'trade') {
      assert.equal(await page.locator('#trade-form button[type="submit"]').isVisible(), true, `${item.name}: trade CTA`);
      await page.locator('#trade-form button[type="submit"]').click();
      assert.equal(await page.locator('#toast').textContent(), '시안에서는 거래를 저장하지 않습니다.');
      await page.waitForTimeout(2700);
    }
    await page.screenshot({ path: resolve(screenshots, `${item.name}.png`), fullPage: true });
    assert.deepEqual(errors, [], `${item.name}: browser errors`);
    await page.close();
  }
  console.log('Phase 0 prototype passed: 390 light, 360 dark, 768 light, 1024 dark.');
} finally {
  await browser.close();
}
