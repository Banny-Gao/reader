import { chromium } from '@playwright/test';
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage();
const errs: string[] = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
const d = await page.evaluate(() => (window as never as { __reader: { debug(): { pageCount: number; index: number } } }).__reader.debug());
console.log('生产构建：页数=', d.pageCount, ' 当前页=', d.index, ' JS错误=', errs.length);
const box = (await page.locator('#stage').boundingBox())!;
await page.mouse.click(box.x + box.width * 0.85, box.y + box.height / 2);
await page.waitForTimeout(700);
const d2 = await page.evaluate(() => (window as never as { __reader: { debug(): { index: number } } }).__reader.debug());
console.log('点击右侧翻页后 index=', d2.index);
await page.screenshot({ path: '/workspace/reader/shots/prod-check.png' });
await browser.close();
