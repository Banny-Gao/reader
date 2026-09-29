/**
 * 阅读器控制器（Web 端 MVP）。
 *
 * 职责：把 core 的分页 / 主题 / 手势 / 翻页几何组装成一个可用的阅读器。
 * 里面没有任何跨端逻辑——所有判断要么在 core，要么在平台适配层。
 */

import {
  clamp01,
  createGestureMachine,
  createThemeStore,
  easeOutCubic,
  makeTheme,
  parseMarkdown,
  paginate,
  progressForFingerOffset,
  snapDuration,
  themeSignature,
  type PageLayout,
  type ReadingTheme,
  type ReaderIntent,
  type ThemeStore,
} from '../../core';

import { attachLineBoxes, DomLayoutProvider, geometryOf, renderPage, type PageGeometry } from './domRenderer';
import { FlipRenderer } from './flipRenderer';
import { bindGestures, hasSelectionInside } from './gestureBinding';
import { createWebThemePersistence, loadReadingProgress, saveReadingProgress } from './storage';

export interface ReaderAppOptions {
  root: HTMLElement;
  markdown: string;
}

interface Elements {
  reader: HTMLElement;
  stage: HTMLElement;
  slot: HTMLElement;
  pageStatic: HTMLElement;
  shadow: HTMLElement;
  flipLayer: HTMLElement;
  indicator: HTMLElement;
  progressFill: HTMLElement;
  stateLabel: HTMLElement;
  panel: HTMLElement;
  selectionBar: HTMLElement;
}

export class ReaderApp {
  private els: Elements;
  private blocks = parseMarkdown('').blocks;
  private themeStore: ThemeStore;
  private provider: DomLayoutProvider;
  private geometry!: PageGeometry;
  private pages: PageLayout[] = [];
  private index = 0;
  private flip!: FlipRenderer;
  private machine = createGestureMachine();
  private selecting = false;
  private animating = false;
  private rafId = 0;
  private lastLayoutSignature = '';
  private lastMarkup = '';

  constructor(private opts: ReaderAppOptions) {
    this.els = {
      reader: must(opts.root.querySelector('#reader')),
      stage: must(opts.root.querySelector('#stage')),
      slot: must(opts.root.querySelector('#page-slot')),
      pageStatic: must(opts.root.querySelector('#page-static')),
      shadow: must(opts.root.querySelector('#cast-shadow')),
      flipLayer: must(opts.root.querySelector('#flip-layer')),
      indicator: must(opts.root.querySelector('[data-testid="page-indicator"]')),
      progressFill: must(opts.root.querySelector('#progress-fill')),
      stateLabel: must(opts.root.querySelector('[data-testid="gesture-state"]')),
      panel: must(opts.root.querySelector('#panel')),
      selectionBar: must(opts.root.querySelector('#selection-bar')),
    };

    const measureRoot = document.createElement('div');
    measureRoot.className = 'measure-root';
    measureRoot.id = 'measure-root';
    document.body.appendChild(measureRoot);

    this.provider = new DomLayoutProvider(measureRoot);
    this.themeStore = createThemeStore(createWebThemePersistence(), makeTheme('sepia'));
  }

  mount(markdown?: string): void {
    const md = markdown ?? this.opts.markdown;
    this.lastMarkup = md;
    this.blocks = parseMarkdown(md).blocks;
    this.index = Math.min(loadReadingProgress(), 9999);

    this.layoutGeometry();
    this.themeStore.subscribe(() => this.onThemeChange());
    this.applyTheme(this.themeStore.get());
    this.repaginate(true);

    this.flip = new FlipRenderer({
      layer: this.els.flipLayer,
      geometry: this.geometry,
      strips: 28,
    });

    // 绑 stage 而不是 reader：设置面板覆盖在 stage 上，
    // 绑 reader 会导致拖滑块时把页面也翻了
    bindGestures(this.els.stage, this.machine, {
      onIntent: (i) => this.onIntent(i),
      isAnimating: () => this.animating,
      isSelecting: () => this.selecting,
    });

    document.addEventListener('selectionchange', () => this.syncSelection());
    window.addEventListener('resize', () => {
      this.layoutGeometry();
      this.flip?.setGeometry(this.geometry);
      this.repaginate(true);
    });

    this.bindPanel();
    this.updateChrome();
  }

  /* ---------------------------------------------------------------- */
  /* 排版与分页                                                        */
  /* ---------------------------------------------------------------- */

  private layoutGeometry(): void {
    const stage = this.els.stage;
    const theme = this.themeStore.get();
    const availW = Math.max(240, stage.clientWidth - 16);
    const availH = Math.max(320, stage.clientHeight - 10);
    const width = Math.min(availW, 430);
    const height = Math.min(availH, width * 1.52);
    this.geometry = geometryOf(width, height, theme.padding);
    this.els.reader.style.setProperty('--page-w', `${width}px`);
    this.els.reader.style.setProperty('--page-h', `${height}px`);
  }

  private repaginate(force = false): void {
    const theme = this.themeStore.get();
    const sig = `${themeSignature(theme)}|${this.geometry.contentWidth}x${this.geometry.contentHeight}`;
    if (!force && sig === this.lastLayoutSignature) return;
    this.lastLayoutSignature = sig;

    const ctx = {
      theme,
      contentWidth: this.geometry.contentWidth,
      contentHeight: this.geometry.contentHeight,
    };
    const result = paginate(this.blocks, this.provider, ctx);
    attachLineBoxes(this.blocks, this.provider, ctx, result);
    this.pages = result.pages;
    this.index = Math.max(0, Math.min(this.index, this.pages.length - 1));
    this.renderCurrent();
    this.updateChrome();
  }

  private renderCurrent(): void {
    const page = this.pages[this.index];
    if (!page) return;
    renderPage(page, this.geometry, this.els.pageStatic);
    saveReadingProgress(this.index, this.pages.length);
  }

  /* ---------------------------------------------------------------- */
  /* 主题                                                              */
  /* ---------------------------------------------------------------- */

  private applyTheme(theme: ReadingTheme): void {
    // 关键：变量挂在根元素上。
    // 离屏度量容器是 document.body 的直接子节点，不在 .reader 里 ——
    // 变量只挂在 reader 上会导致「量出来的高度 ≠ 渲染出来的高度」，分页全线错位。
    const s = document.documentElement.style;
    const c = theme.colors;
    s.setProperty('--page-bg', c.pageBg);
    s.setProperty('--page-edge', c.pageEdge);
    s.setProperty('--text', c.text);
    s.setProperty('--text-secondary', c.textSecondary);
    s.setProperty('--accent', c.accent);
    s.setProperty('--code-bg', c.codeBg);
    s.setProperty('--code-text', c.codeText);
    s.setProperty('--quote-border', c.quoteBorder);
    s.setProperty('--rule', c.rule);
    s.setProperty('--selection', c.selection);
    s.setProperty('--font-family', theme.fontFamily);
    s.setProperty('--font-size', `${theme.fontSize}px`);
    s.setProperty('--line-height', String(theme.lineHeight));
    s.setProperty('--indent', `${theme.indentEm}em`);
    s.setProperty('--pad-top', `${theme.padding.top}px`);
    s.setProperty('--pad-right', `${theme.padding.right}px`);
    s.setProperty('--pad-bottom', `${theme.padding.bottom}px`);
    s.setProperty('--pad-left', `${theme.padding.left}px`);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', c.pageBg);
    // 纸口高光等「按配色微调」的样式挂在根元素的 data-theme 上
    document.documentElement.dataset.theme = theme.id;
    this.syncPanelInputs(theme);
  }

  private onThemeChange(): void {
    this.applyTheme(this.themeStore.get());
    // 主题影响排版 → 必须重新分页（验收项）
    this.repaginate();
  }

  /* ---------------------------------------------------------------- */
  /* 手势                                                              */
  /* ---------------------------------------------------------------- */

  private onIntent(intent: ReaderIntent): void {
    this.els.stateLabel.textContent = this.machine.state.phase;
    switch (intent.type) {
      case 'prevPage':
        this.turn(-1);
        break;
      case 'nextPage':
        this.turn(1);
        break;
      case 'openSettings':
        this.togglePanel();
        break;
      case 'dragStart':
        this.beginDrag(intent.direction);
        break;
      case 'dragMove':
        this.flip.update(this.feelProgress(intent.progress));
        this.updateShadow();
        break;
      case 'dragEnd': {
        const shouldComplete = intent.fling || intent.progress >= 0.42;
        this.settle(shouldComplete ? 1 : 0, intent.velocity);
        break;
      }
      case 'beginSelection':
        this.selecting = true;
        this.els.selectionBar.hidden = false;
        break;
      case 'exitSelection':
        this.selecting = false;
        this.els.selectionBar.hidden = true;
        break;
      default:
        break;
    }
  }

  private turn(direction: 1 | -1): void {
    const target = this.index + direction;
    if (target < 0 || target >= this.pages.length) {
      this.bump(direction);
      return;
    }
    this.startFlip(direction, 0, 0, true);
  }

  private beginDrag(direction: 1 | -1): void {
    const target = this.index + direction;
    if (target < 0 || target >= this.pages.length) {
      // 到头了：给一个阻尼反馈，不进入翻页
      this.bump(direction);
      this.animating = true;
      window.setTimeout(() => {
        this.animating = false;
        this.machine.send({ type: 'settleEnd' }, this.ctx());
        this.els.stateLabel.textContent = this.machine.state.phase;
      }, 160);
      return;
    }
    this.startFlip(direction, 0, 0, false);
  }

  private startFlip(direction: 1 | -1, from: number, velocity: number, animate: boolean): void {
    const targetIndex = this.index + direction;
    if (targetIndex < 0 || targetIndex >= this.pages.length) return;

    // 下层必须先切到目标页：翻起来的纸露出的是它的背面，
    // 背面和下层是同一页内容，纸落下去时才能严丝合缝。
    renderPage(this.pages[targetIndex], this.geometry, this.els.pageStatic);

    // 正面 = 当前页，背面 = 目标页
    this.flip.begin(this.pages[this.index], this.pages[targetIndex]);
    this.targetIndex = targetIndex;
    this.flip.update(from);
    this.updateShadow();
    if (animate) this.settle(1, velocity);
  }

  /**
   * 手感映射：手指横向行程（页宽倍数）→ 翻页进度。
   *
   * 直接线性映射会让纸角跑在手指前面；完全跟手又会导致拖满整屏只翻了 1/4。
   * 这里用 core 的反查表做「跟手 + 拉伸」：纸角始终落后手指约 0.2 个页宽
   * （真实纸张被拖着走本来就会滞后一点），拖满一屏能翻到 6 成，
   * 松手由吸附动画补完 —— 跟手感和「拖到底就翻完」两个诉求都保住。
   */
  private feelProgress(fingerProgress: number): number {
    const offset = 1 - FEEL_STRETCH * Math.abs(fingerProgress);
    return progressForFingerOffset(offset);
  }

  private settle(to: number, velocity: number): void {
    const from = this.flip.progress;
    const dur = snapDuration(Math.abs(to - from), velocity);
    this.animating = true;
    const start = performance.now();

    const step = (now: number) => {
      const t = clamp01((now - start) / dur);
      const e = from + (to - from) * easeOutCubic(t);
      this.flip.update(e);
      this.updateShadow();
      if (t < 1) {
        this.rafId = requestAnimationFrame(step);
      } else {
        this.commit(e >= 0.5);
      }
    };
    cancelAnimationFrame(this.rafId);
    this.rafId = requestAnimationFrame(step);
  }

  private commit(advanced: boolean): void {
    this.animating = false;
    if (advanced && this.targetIndex !== this.index) {
      this.index = this.targetIndex;
    }
    this.flip.destroy();
    this.els.shadow.style.opacity = '0';
    this.renderCurrent();
    this.updateChrome();
    this.machine.send({ type: 'settleEnd' }, this.ctx());
    this.els.stateLabel.textContent = this.machine.state.phase;
  }

  /** 到达首/末页时的阻尼反馈 */
  private bump(direction: 1 | -1): void {
    this.els.reader.animate(
      [
        { transform: 'translateX(0)' },
        { transform: `translateX(${-direction * 7}px)` },
        { transform: 'translateX(0)' },
      ],
      { duration: 180, easing: 'ease-out' },
    );
  }

  private updateShadow(): void {
    const { peak, tail, strength } = this.flip.shadowSpan();
    this.els.shadow.style.setProperty('--shadow-peak', `${(peak * 100).toFixed(1)}%`);
    this.els.shadow.style.setProperty('--shadow-tail', `${(tail * 100).toFixed(1)}%`);
    this.els.shadow.style.opacity = strength > 0 ? String(Math.min(0.9, strength)) : '0';
  }

  private ctx() {
    return {
      zoneWidth: this.els.reader.clientWidth || 1,
      isAnimating: this.animating,
      isSelecting: this.selecting,
    };
  }

  private syncSelection(): void {
    if (this.machine.state.phase !== 'selection' && !this.selecting) return;
    const inside = hasSelectionInside(this.els.reader);
    if (!inside && this.selecting) {
      this.selecting = false;
      this.els.selectionBar.hidden = true;
    }
  }

  /* ---------------------------------------------------------------- */
  /* 设置面板                                                          */
  /* ---------------------------------------------------------------- */

  private bindPanel(): void {
    const bind = (id: string, key: 'fontSize' | 'lineHeight' | 'paragraphSpacing') => {
      const input = must(this.opts.root.querySelector<HTMLInputElement>(id));
      const out = must(this.opts.root.querySelector<HTMLOutputElement>(id.replace('#set-', '#out-')));
      input.addEventListener('input', () => {
        const theme = this.themeStore.get();
        this.themeStore.set({ ...theme, [key]: Number(input.value) } as ReadingTheme);
        out.value = input.value;
      });
    };
    bind('#set-fontSize', 'fontSize');
    bind('#set-lineHeight', 'lineHeight');
    bind('#set-paragraphSpacing', 'paragraphSpacing');

    const padInput = must(this.opts.root.querySelector<HTMLInputElement>('#set-padding'));
    const padOut = must(this.opts.root.querySelector<HTMLOutputElement>('#out-padding'));
    padInput.addEventListener('input', () => {
      const theme = this.themeStore.get();
      const p = Number(padInput.value);
      this.themeStore.set({ ...theme, padding: { top: p, right: p, bottom: p, left: p } });
      padOut.value = String(p);
    });

    for (const btn of this.opts.root.querySelectorAll<HTMLButtonElement>('#swatches button')) {
      btn.addEventListener('click', () => {
        const id = btn.dataset.theme as 'light' | 'sepia' | 'dark';
        const current = this.themeStore.get();
        const preset = makeTheme(id);
        this.themeStore.set({
          ...current,
          id: preset.id,
          label: preset.label,
          colors: preset.colors,
        });
        this.updateChrome();
      });
    }

    must(this.opts.root.querySelector('#panel-close')).addEventListener('click', () => this.closePanel());
  }

  private syncPanelInputs(theme: ReadingTheme): void {
    const set = (sel: string, v: string) => {
      const el = this.opts.root.querySelector<HTMLInputElement>(sel);
      const out = this.opts.root.querySelector<HTMLOutputElement>(sel.replace('#set-', '#out-'));
      if (el && el.value !== v) el.value = v;
      if (out) out.value = v;
    };
    set('#set-fontSize', String(theme.fontSize));
    set('#set-lineHeight', String(theme.lineHeight));
    set('#set-paragraphSpacing', String(theme.paragraphSpacing));
    set('#set-padding', String(theme.padding.left));
    for (const btn of this.opts.root.querySelectorAll<HTMLButtonElement>('#swatches button')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.theme === theme.id));
    }
  }

  private togglePanel(): void {
    this.els.panel.hidden = !this.els.panel.hidden;
  }

  private closePanel(): void {
    this.els.panel.hidden = true;
  }

  /* ---------------------------------------------------------------- */

  private updateChrome(): void {
    const total = this.pages.length;
    this.els.indicator.textContent = `${this.index + 1} / ${total}`;
    this.els.progressFill.style.width = total > 1 ? `${(this.index / (total - 1)) * 100}%` : '0%';
    const density = total > 0 ? this.pages[this.index]?.fillRatio ?? 0 : 0;
    this.els.slot.dataset.fill = density.toFixed(2);
  }

  /** 测试/调试用 */
  debug() {
    return {
      now: Math.round(performance.now()),
      index: this.index,
      pageCount: this.pages.length,
      phase: this.machine.state.phase,
      selecting: this.selecting,
      animating: this.animating,
      longPressDeadline: this.machine.longPressDeadline,
      longPressArmed: this.machine.longPressDeadline !== null,
      geometry: this.geometry,
      theme: this.themeStore.get(),
      markdownLength: this.lastMarkup.length,
    };
  }

  private targetIndex = 0;

  /** 视觉调试：把翻页钉在指定进度（不吸附），用于逐帧检查卷曲形态 */
  previewFlip(e: number, direction: 1 | -1 = 1, shape?: Record<string, number>) {
    const target = Math.max(0, Math.min(this.pages.length - 1, this.index + direction));
    if (target === this.index) return;
    renderPage(this.pages[target], this.geometry, this.els.pageStatic);
    this.flip.setShape(shape);
    this.flip.begin(this.pages[this.index], this.pages[target]);
    this.targetIndex = target;
    this.flip.update(e);
    this.updateShadow();
  }

  clearPreview() {
    this.flip.destroy();
    this.els.shadow.style.opacity = '0';
  }

  /** 供 e2e 使用：直接跳到某一页 */
  goTo(index: number) {
    this.index = Math.max(0, Math.min(index, this.pages.length - 1));
    this.renderCurrent();
    this.updateChrome();
  }
}

function must<T extends Element>(el: T | null): T {
  if (!el) throw new Error('缺少必要的 DOM 节点');
  return el;
}

/** 手指行程 → 翻页进度的拉伸系数，见 feelProgress 注释 */
const FEEL_STRETCH = 1.15;

export { progressForFingerOffset };
