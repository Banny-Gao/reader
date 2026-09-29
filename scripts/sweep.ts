/** 参数扫描：一次渲染多组卷曲参数，拼成对比图用肉眼选。 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const OUT = '/workspace/reader/shots/sweep';
mkdirSync(OUT, { recursive: true });

const COMBOS: Array<{ label: string; shape: Record<string, number> }> = [
  { label: 'A_spine3.0_curl2.1_b1.5', shape: { spineBias: 3.0, curlAngle: 2.1, curlBias: 1.5 } },
  { label: 'A_spine3.0_curl1.6_b2.0', shape: { spineBias: 3.0, curlAngle: 1.6, curlBias: 2.0 } },
  { label: 'A_spine2.0_curl2.1_b1.5', shape: { spineBias: 2.0, curlAngle: 2.1, curlBias: 1.5 } },
  { label: 'A_spine2.6_curl1.8_b1.2', shape: { spineBias: 2.6, curlAngle: 1.8, curlBias: 1.2 } },
  { label: 'A_spine1.75_curl1.2_b1.4', shape: { spineBias: 1.75, curlAngle: 1.2, curlBias: 1.4 } },
  { label: 'A_spine3.0_curl1.0_b2.4', shape: { spineBias: 3.0, curlAngle: 1.0, curlBias: 2.4 } },
];

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 1,
});
const page = await ctx.newPage();
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
const slot = page.locator('#page-slot');

for (const combo of COMBOS) {
  for (const e of [0.35, 0.55]) {
    await page.evaluate(
      ([v, shape]) => (window as never as { __reader: { previewFlip(v: number, d: number, s: unknown): void } }).__reader.previewFlip(v as number, 1, shape),
      [e, combo.shape] as const,
    );
    await page.waitForTimeout(100);
    await slot.screenshot({ path: `${OUT}/${combo.label}__e${e}.png` });
  }
  const stat = await page.evaluate(() => {
    const strips = [...document.querySelectorAll('#flip-layer .strip')] as HTMLElement[];
    const xs = strips.map((s) => Number(/translate3d\(([-\d.]+)px/.exec(s.style.transform)?.[1] ?? 0));
    return { min: Math.round(Math.min(...xs)), max: Math.round(Math.max(...xs)) };
  });
  console.log(`${combo.label.padEnd(26)} 条带 x 跨度 ${stat.min}..${stat.max}px`);
}

await browser.close();
console.log('->', OUT);
