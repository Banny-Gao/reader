/**
 * 视觉巡检脚本：把翻页过程的每一帧截下来。
 * 用途：确认「纸张卷起的中间态」真的存在，而不是一张贴图在转。
 */
import { chromium, devices } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const OUT = process.env.SHOT_DIR ?? '/workspace/reader/shots';
mkdirSync(OUT, { recursive: true });

// 用完整 chromium（而不是 headless-shell）——沙箱里只有完整版
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
});
const ctx = await browser.newContext({
  ...devices['iPhone 13'],
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
page.on('console', (m) => console.log('[console]', m.type(), m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(600);

const reader = page.locator('[data-testid="reader"]');
const box = await reader.boundingBox();
if (!box) throw new Error('no reader box');

console.log('debug:', JSON.stringify(await page.evaluate(() => (window as never as { __reader: { debug(): unknown } }).__reader.debug()), null, 1));

await page.screenshot({ path: `${OUT}/01-rest.png` });

// 用拖拽抓住翻页中间态：按下 → 慢慢往左拖 → 停在若干进度上截图
const y = box.y + box.height / 2;
const startX = box.x + box.width * 0.85;

await page.mouse.move(startX, y);
await page.mouse.down();

const frames = [0.12, 0.22, 0.32, 0.42, 0.5, 0.62, 0.75];
let i = 2;
for (const p of frames) {
  const x = startX - box.width * p * 0.9;
  // 分多步移动，触发 pointermove
  for (let s = 0; s < 6; s += 1) {
    await page.mouse.move(startX - (startX - x) * ((s + 1) / 6), y);
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(80);
  const state = await page.evaluate(() => (window as never as { __reader: { debug(): { phase: string } } }).__reader.debug());
  console.log(`drag ${p} -> phase=${state.phase}`);
  await page.screenshot({ path: `${OUT}/${String(i).padStart(2, '0')}-drag-${Math.round(p * 100)}.png` });
  i += 1;
}

await page.mouse.up();
await page.waitForTimeout(700);
await page.screenshot({ path: `${OUT}/${String(i).padStart(2, '0')}-settled.png` });
console.log('after:', JSON.stringify(await page.evaluate(() => (window as never as { __reader: { debug(): unknown } }).__reader.debug())));

await browser.close();
console.log('shots ->', OUT);
