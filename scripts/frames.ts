/**
 * 逐帧视觉巡检：把翻页钉在指定进度上截图。
 * 这是调卷曲形态的主要手段 —— 靠肉眼判断纸卷得够不够。
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const OUT = '/workspace/reader/shots/frames';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);

const slot = page.locator('#page-slot');

for (const e of [0.15, 0.3, 0.45, 0.6, 0.75, 0.9]) {
  await page.evaluate((v) => (window as never as { __reader: { previewFlip(v: number): void } }).__reader.previewFlip(v), e);
  await page.waitForTimeout(120);
  await slot.screenshot({ path: `${OUT}/e${String(Math.round(e * 100)).padStart(2, '0')}.png` });
  const info = await page.evaluate(() => {
    const strips = [...document.querySelectorAll('#flip-layer .strip')] as HTMLElement[];
    const rot = strips.map((s) => {
      const m = /rotateY\(([-\d.]+)rad\)/.exec(s.style.transform);
      return m ? +(((+m[1]) * 180) / Math.PI).toFixed(0) : NaN;
    });
    const z = strips.map((s) => {
      const m = /translate3d\([^,]+, 0, ([-\d.]+)px\)/.exec(s.style.transform);
      return m ? +(+m[1]).toFixed(0) : NaN;
    });
    const fin = window.navigator;
    void fin;
    return {
      rotMin: Math.min(...rot),
      rotMax: Math.max(...rot),
      zMin: Math.min(...z),
      zMax: Math.max(...z),
      edgeX: (() => {
        const m = /translate3d\(([-\d.]+)px[^)]*\)\s*rotateY/.exec(strips[strips.length - 1].style.transform);
        return m ? +(+m[1]).toFixed(0) : null;
      })(),
    };
  });
  console.log(
    `e=${e}  rotateY ${info.rotMin}°..${info.rotMax}°  z ${info.zMin}..${info.zMax}px  纸角x=${info.edgeX}`,
  );
}

await browser.close();
console.log('->', OUT);
