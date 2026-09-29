/**
 * Web MVP 入口。
 *
 * MVP 范围说明：这一版只交付 Web 端，但 core 层（分页 / 手势 / 主题 / 翻页几何）
 * 是框架无关的，Taro 与 RN 通过各自的适配器消费，见 docs/architecture.md。
 */

import './styles.css';
import markdown from './sample-book.md?raw';
import { ReaderApp } from '../platform/web/reader';

const root = document.getElementById('app');
if (!root) throw new Error('#app not found');

const app = new ReaderApp({ root, markdown: String(markdown) });
app.mount();

// 调试入口：e2e 与手动验证都靠它读内部状态
declare global {
  interface Window {
    __reader?: unknown;
  }
}
window.__reader = app;

const title = document.getElementById('doc-title');
if (title) title.textContent = '翻页这件小事';

const clock = document.getElementById('clock');
const tick = () => {
  if (!clock) return;
  const d = new Date();
  clock.textContent = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
};
tick();
window.setInterval(tick, 30_000);
