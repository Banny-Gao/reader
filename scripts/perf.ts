import { chromium } from '@playwright/test';
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-gpu-rasterization'],
});
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
const out = await page.evaluate(() => {
  const r = (window as never as { __reader: { previewFlip(v: number, d: number, s: unknown): void; clearPreview(): void } }).__reader;
  r.clearPreview();
  r.previewFlip(0.01, 1, {});
  const t0 = performance.now();
  for (let i = 0; i < 60; i++) r.previewFlip(i / 60, 1, {});
  const js = performance.now() - t0;
  // 强制布局/样式计算，看看有没有强制同步布局
  const t1 = performance.now();
  document.querySelectorAll('#flip-layer .strip').forEach((e) => (e as HTMLElement).offsetWidth);
  const layout = performance.now() - t1;
  return { perUpdate: +(js / 60).toFixed(2), layoutMs: +layout.toFixed(2), strips: document.querySelectorAll('.strip').length };
});
console.log(`单次 update（28 条带全量写样式）= ${out.perUpdate}ms`);
console.log(`强制读取布局 = ${out.layoutMs}ms  条带数=${out.strips}`);
console.log(`→ 60fps 每帧预算 16.7ms，JS 部分占 ${((out.perUpdate / 16.7) * 100).toFixed(0)}%`);
await browser.close();
