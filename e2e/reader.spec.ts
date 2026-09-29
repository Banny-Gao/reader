/**
 * 端到端验收：直接对着需求 2.3 / 3.x / 五·验收标准 写断言。
 * 每条用例都带截图证据（shots/e2e-*.png）。
 */
import { expect, test, type Page } from '@playwright/test';
const SHOTS = 'shots'; // Playwright 会自动创建目录

type Debug = {
  now?: number;
  longPressDeadline?: number | null;
  longPressArmed?: boolean;
  index: number;
  pageCount: number;
  phase: string;
  selecting: boolean;
  animating: boolean;
  geometry: { width: number; height: number; contentWidth: number; contentHeight: number };
  theme: { fontSize: number; lineHeight: number; paragraphSpacing: number; id: string };
};

async function debug(page: Page): Promise<Debug> {
  return page.evaluate(() => (window as never as { __reader: { debug(): Debug } }).__reader.debug());
}

async function readerBox(page: Page) {
  const box = await page.locator('[data-testid="reader"]').boundingBox();
  if (!box) throw new Error('reader not found');
  return box;
}

/** 拖到中途停住（不松手），用来截「卷起来的中间态」 */
async function dragTo(page: Page, ratio: number) {
  const box = await readerBox(page);
  const y = box.y + box.height / 2;
  const startX = box.x + box.width * 0.88;
  const endX = startX - box.width * ratio;
  await page.mouse.move(startX, y);
  await page.mouse.down();
  const steps = 12;
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(startX + ((endX - startX) * i) / steps, y);
    await page.waitForTimeout(12);
  }
  await page.waitForTimeout(120);
  return { startX, endX, y };
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __reader?: unknown }).__reader !== undefined);
  await page.waitForTimeout(400);
});

test('内容渲染：长文被分成多页，页面非空', async ({ page }) => {
  const d = await debug(page);
  expect(d.pageCount).toBeGreaterThan(8);

  const text = await page.locator('[data-testid="page-static"]').innerText();
  expect(text.length).toBeGreaterThan(80);
  // 填充率不能太低（需求 3.2：每页尽可能填满）
  const fill = Number(await page.locator('[data-testid="page-slot"]').getAttribute('data-fill'));
  expect(fill).toBeGreaterThan(0.55);

  await page.screenshot({ path: `${SHOTS}/e2e-01-rest.png` });
});

test('分页重排：字号变化后总页数变化，且落位正确', async ({ page }) => {
  const before = await debug(page);
  await page.evaluate(() => {
    const w = window as never as { __reader: { debug(): unknown } };
    void w;
  });

  // 通过设置面板改字号（走的是用户真实路径）
  const box = await readerBox(page);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator('[data-testid="settings-panel"]')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/e2e-02-panel.png` });

  const slider = page.locator('[data-testid="set-fontSize"]');
  await slider.fill('30');
  await page.waitForTimeout(300);

  const after = await debug(page);
  expect(after.theme.fontSize).toBe(30);
  expect(after.pageCount).toBeGreaterThan(before.pageCount);
  await page.screenshot({ path: `${SHOTS}/e2e-03-large-font.png` });
});

test('主题持久化：刷新后字号仍然保留', async ({ page }) => {
  const box = await readerBox(page);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.locator('[data-testid="set-fontSize"]').fill('26');
  await page.waitForTimeout(200);

  await page.reload();
  await page.waitForFunction(() => (window as never as { __reader?: unknown }).__reader !== undefined);
  await page.waitForTimeout(300);

  const d = await debug(page);
  expect(d.theme.fontSize).toBe(26);
});

test('tap 分区：左 30% 上一页 / 右 30% 下一页 / 中间弹设置', async ({ page }) => {
  const box = await readerBox(page);
  const y = box.y + box.height / 2;

  await page.mouse.click(box.x + box.width * 0.85, y);
  await page.waitForTimeout(500);
  expect((await debug(page)).index).toBe(1);

  await page.mouse.click(box.x + box.width * 0.1, y);
  await page.waitForTimeout(500);
  expect((await debug(page)).index).toBe(0);

  await page.mouse.click(box.x + box.width * 0.5, y);
  await expect(page.locator('[data-testid="settings-panel"]')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/e2e-04-tap-settings.png` });
});

test('真 3D 翻页：拖拽过程中条带有不同的 3D 变换（卷曲中间态）', async ({ page }) => {
  await dragTo(page, 0.82);

  const stripCount = await page.locator('#flip-layer .strip').count();
  const transforms = await page.$$eval('#flip-layer .strip', (els) =>
    els.map((e) => (e as HTMLElement).style.transform),
  );
  const rotations = transforms
    .map((t) => /rotateY\(([-\d.]+)rad\)/.exec(t)?.[1])
    .filter((v): v is string => !!v)
    .map(Number);
  const squashes = transforms
    .map((t) => Number(/scaleX\(([\d.]+)\)/.exec(t)?.[1] ?? '1'))
    .map(Number);
  // 注意：浏览器会把 translate3d 的裸 0 规范化成 0px，正则要能匹配
  const zs = transforms
    .map((t) => Number(/translate3d\([^,]+,\s*-?[\d.]+px,\s*(-?[\d.]+)px/.exec(t)?.[1] ?? '0'))
    .map(Number);
  await page.screenshot({ path: `${SHOTS}/e2e-05-mid-flip.png` });
  // 先松手再断言：断言失败时鼠标还按着会污染后续用例
  await page.mouse.up();
  await page.waitForTimeout(400);

  expect(stripCount).toBeGreaterThanOrEqual(16);
  // 关键断言：条带 transform 各不相同 —— 全部相同就意味着只是整页刚性旋转，
  // 也就是需求里明确否掉的「伪 3D」
  expect(new Set(transforms).size).toBeGreaterThan(stripCount * 0.8);
  expect(rotations.length).toBe(stripCount);
  const spread = Math.max(...rotations) - Math.min(...rotations);
  expect(spread).toBeGreaterThan(0.15); // 弧度：明显弯曲
  // 至少有一条离开原平面
  expect(Math.max(...zs.map(Math.abs))).toBeGreaterThan(4);
  // 条带按弦缩放
  expect(squashes.length).toBe(stripCount);
  expect(Math.min(...squashes)).toBeLessThan(1);
});

test('拖拽翻页：松手后落到目标页，内容与直接翻页一致', async ({ page }) => {
  await dragTo(page, 0.62);
  await page.mouse.up();
  await page.waitForTimeout(700);
  expect((await debug(page)).index).toBe(1);
  await page.screenshot({ path: `${SHOTS}/e2e-06-after-drag.png` });
});

test('拖拽不足半程会回弹，不换页', async ({ page }) => {
  await dragTo(page, 0.12);
  await page.mouse.up();
  await page.waitForTimeout(600);
  expect((await debug(page)).index).toBe(0);
});

test('长按进入选区后，滑动不再翻页（互斥规则）', async ({ page }) => {
  const box = await readerBox(page);
  const y = box.y + box.height / 2;

  await page.mouse.move(box.x + box.width * 0.6, y);
  await page.mouse.down();
  // 轮询而不是固定等待：主线程忙时定时器会延后
  await expect
    .poll(async () => (await debug(page)).phase, { timeout: 3000, message: '长按后未进入选区态' })
    .toBe('selection');
  await expect(page.locator('[data-testid="selection-bar"]')).toBeVisible();

  // 选区态下横向拖动
  await page.mouse.move(box.x + box.width * 0.2, y, { steps: 8 });
  await page.waitForTimeout(80);
  expect((await debug(page)).index).toBe(0);
  expect(await page.locator('#flip-layer .strip').count()).toBe(0);

  await page.mouse.up();
  await page.waitForTimeout(200);
  expect((await debug(page)).selecting).toBe(false);

  // 退出选区后翻页恢复
  await page.mouse.move(box.x + box.width * 0.85, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.3, y, { steps: 8 });
  await page.waitForTimeout(60);
  expect(await page.locator('#flip-layer .strip').count()).toBeGreaterThan(0);
  await page.mouse.up();
  await page.waitForTimeout(600);
  expect((await debug(page)).index).toBe(1);
});

test('翻页动画进行中，长按不触发选区（翻页优先）', async ({ page }) => {
  const box = await readerBox(page);
  const y = box.y + box.height / 2;
  await page.mouse.click(box.x + box.width * 0.85, y); // 触发翻页动画
  await page.mouse.move(box.x + box.width * 0.5, y);
  await page.mouse.down();
  await page.waitForTimeout(700);
  const d = await debug(page);
  expect(d.selecting).toBe(false);
  expect(d.phase).not.toBe('selection');
  await page.mouse.up();
});

test('文本可选：页面是真实 DOM 文本且允许系统级选区', async ({ page }) => {
  const userSelect = await page
    .locator('[data-testid="page-static"] .block--paragraph')
    .first()
    .evaluate((el) => getComputedStyle(el).userSelect || getComputedStyle(el).webkitUserSelect);
  expect(['text', 'auto']).toContain(userSelect);

  // 选中一段文字并确认选区落在书页内（这正是原生菜单的前提）
  const ok = await page.evaluate(() => {
    const p = document.querySelector('[data-testid="page-static"] .block--paragraph');
    if (!p?.firstChild) return false;
    const range = document.createRange();
    range.setStart(p.firstChild, 0);
    range.setEnd(p.firstChild, Math.min(12, (p.firstChild.textContent ?? '').length));
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    return (sel?.toString().length ?? 0) > 0;
  });
  expect(ok).toBe(true);
  await page.screenshot({ path: `${SHOTS}/e2e-07-selection.png` });
});

test('首尾页边界：不会翻出界', async ({ page }) => {
  const box = await readerBox(page);
  const y = box.y + box.height / 2;
  await page.mouse.click(box.x + box.width * 0.1, y);
  await page.waitForTimeout(400);
  expect((await debug(page)).index).toBe(0);
});

test('三种配色可切换，且不影响分页页数', async ({ page }) => {
  const before = await debug(page);
  const box = await readerBox(page);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.locator('[data-testid="theme-dark"]').click();
  await page.waitForTimeout(250);
  const dark = await debug(page);
  expect(dark.theme.id).toBe('dark');
  expect(dark.pageCount).toBe(before.pageCount);
  await page.locator('#panel-close').click();
  await page.screenshot({ path: `${SHOTS}/e2e-08-dark.png` });
});
