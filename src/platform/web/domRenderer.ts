/**
 * Web 端 DOM 渲染 + 度量。
 *
 * 关键设计：**书页内容是真实 DOM 文本，不是 canvas 画出来的图**。
 * 这是需求 2.2「系统级选区菜单」能落地的前提 ——
 * 只有真实文本节点，浏览器才会给出复制/搜索/翻译/分享的原生菜单。
 * canvas 方案在这条上直接出局。
 *
 * 排版度量同样走真实 DOM（隐藏容器 + Range.getClientRects），
 * 保证「量出来的高度 = 渲染出来的高度」，分页不会出现重排跳变。
 */

import type { Block, PageLayout, PlacedBlock, InlineRun } from '../../core';
import type { BlockMetrics, LayoutContext, LayoutProvider, LineBox } from '../../core';

export interface PageGeometry {
  width: number;
  height: number;
  padding: { top: number; right: number; bottom: number; left: number };
  get contentWidth(): number;
  get contentHeight(): number;
}

export function geometryOf(width: number, height: number, padding: PageGeometry['padding']): PageGeometry {
  return {
    width,
    height,
    padding,
    get contentWidth() {
      return width - padding.left - padding.right;
    },
    get contentHeight() {
      return height - padding.top - padding.bottom;
    },
  };
}

/* ------------------------------------------------------------------ */
/* 块 → DOM                                                            */
/* ------------------------------------------------------------------ */

function runsToFragment(runs: InlineRun[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const run of runs) {
    const classes = [
      run.bold && 'inline-bold',
      run.italic && 'inline-italic',
      run.strike && 'inline-strike',
      run.code && 'inline-code',
    ]
      .filter(Boolean)
      .join(' ');
    let node: HTMLElement | Text;
    if (classes) {
      const span = document.createElement('span');
      span.className = classes;
      span.textContent = run.text;
      node = span;
    } else {
      node = document.createTextNode(run.text);
    }
    if (run.href) {
      const a = document.createElement('a');
      a.href = run.href;
      a.target = '_blank';
      a.rel = 'noreferrer noopener';
      a.textContent = node.textContent ?? '';
      frag.appendChild(a);
    } else {
      frag.appendChild(node);
    }
  }
  return frag;
}

export function blockToElement(block: Block): HTMLElement {
  switch (block.type) {
    case 'heading': {
      const el = document.createElement('div');
      el.className = 'block block--heading';
      el.dataset.level = String(block.level);
      el.appendChild(runsToFragment(block.runs));
      return el;
    }
    case 'paragraph': {
      const el = document.createElement('div');
      el.className = 'block block--paragraph';
      el.appendChild(runsToFragment(block.runs));
      return el;
    }
    case 'quote': {
      const el = document.createElement('div');
      el.className = 'block block--quote';
      el.appendChild(runsToFragment(block.runs));
      return el;
    }
    case 'code': {
      const el = document.createElement('div');
      el.className = 'block block--code';
      for (const line of block.lines) {
        const row = document.createElement('div');
        row.className = 'code-line';
        row.textContent = line.length ? line : ' ';
        el.appendChild(row);
      }
      return el;
    }
    case 'list': {
      const el = document.createElement('div');
      el.className = 'block block--list';
      el.dataset.ordered = String(block.ordered);
      block.items.forEach((item, i) => {
        const li = document.createElement('div');
        li.className = 'list-item';
        if (block.ordered) li.dataset.num = String(block.start + i);
        li.appendChild(runsToFragment(item));
        el.appendChild(li);
      });
      return el;
    }
    case 'image': {
      const el = document.createElement('figure');
      el.className = 'block block--image';
      const img = document.createElement('img');
      img.src = block.src;
      img.alt = block.alt;
      img.loading = 'lazy';
      img.draggable = false;
      // 固定宽高比：图片没加载出来时分页高度也是确定的
      img.style.aspectRatio = '3 / 2';
      el.appendChild(img);
      if (block.alt) {
        const cap = document.createElement('figcaption');
        cap.textContent = block.alt;
        el.appendChild(cap);
      }
      return el;
    }
    case 'rule': {
      const el = document.createElement('div');
      el.className = 'block block--rule';
      return el;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 行盒提取                                                            */
/* ------------------------------------------------------------------ */

const EPS = 0.5;

function lineBoxesFromRects(top: number, rects: DOMRect[]): LineBox[] {
  const merged = new Map<number, number>();
  for (const r of rects) {
    if (r.height <= 0) continue;
    const key = Math.round((r.top - top) / EPS);
    const offset = key * EPS;
    const prev = merged.get(key);
    if (prev === undefined) {
      merged.set(key, r.height);
    } else {
      merged.set(key, Math.max(prev, r.height + 0));
      // 行盒顶边取最靠上的那个
      void offset;
    }
  }
  return [...merged.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([key, height]) => ({ top: key * EPS, height }));
}

/** 连续文本块：用 Range 按行取矩形 */
function textLineBoxes(el: HTMLElement, top: number): LineBox[] {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  const rects: DOMRect[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.textContent ?? '';
    if (!text.trim()) continue;
    range.selectNodeContents(node);
    for (const r of range.getClientRects()) rects.push(r);
  }
  const boxes = lineBoxesFromRects(top, rects);
  if (boxes.length > 0) return boxes;
  const h = el.getBoundingClientRect().height;
  return [{ top: 0, height: h }];
}

/** 列表/代码块：每个子元素就是一个行盒 */
function childLineBoxes(el: HTMLElement, selector: string, top: number): LineBox[] {
  const children = [...el.querySelectorAll<HTMLElement>(selector)];
  if (children.length === 0) return [];
  return children.map((child) => {
    const r = child.getBoundingClientRect();
    return { top: r.top - top, height: r.height };
  });
}

/* ------------------------------------------------------------------ */
/* DOM 度量 Provider                                                    */
/* ------------------------------------------------------------------ */

interface CacheEntry {
  signature: string;
  metrics: BlockMetrics;
}

export class DomLayoutProvider implements LayoutProvider {
  private root: HTMLElement;
  private cache = new WeakMap<Block, CacheEntry>();

  constructor(root: HTMLElement) {
    this.root = root;
  }

  setRoot(root: HTMLElement) {
    this.root = root;
  }

  measure(block: Block, ctx: LayoutContext): BlockMetrics {
    const sig = `${ctx.contentWidth}|${ctx.theme.fontSize}|${ctx.theme.lineHeight}|${ctx.theme.paragraphSpacing}|${ctx.theme.indentEm}|${ctx.theme.id}`;
    const hit = this.cache.get(block);
    if (hit && hit.signature === sig) return hit.metrics;

    this.root.style.width = `${ctx.contentWidth}px`;
    const el = blockToElement(block);
    el.style.cssText = 'position:relative;left:auto;right:auto;';
    this.root.appendChild(el);

    const rect = el.getBoundingClientRect();
    const height = rect.height;

    let lines: LineBox[] | undefined;
    let fallbackLines: LineBox[] | undefined;
    let breakable = false;

    if (block.type === 'paragraph' || block.type === 'quote') {
      lines = textLineBoxes(el, rect.top);
      breakable = lines.length > 1;
    } else if (block.type === 'list') {
      lines = childLineBoxes(el, '.list-item', rect.top);
      breakable = lines.length > 1;
    } else if (block.type === 'code') {
      fallbackLines = childLineBoxes(el, '.code-line', rect.top);
    }

    const spacing = ctx.theme.paragraphSpacing;
    const metrics: BlockMetrics = {
      height,
      marginTop: block.type === 'heading' ? spacing * 1.4 : spacing,
      marginBottom: 0,
      lines,
      fallbackLines,
      breakable,
      keepWithNext: block.type === 'heading',
    };

    this.root.removeChild(el);
    this.cache.set(block, { signature: sig, metrics });
    return metrics;
  }
}

/* ------------------------------------------------------------------ */
/* 页面渲染                                                            */
/* ------------------------------------------------------------------ */

/**
 * 把 PageLayout 渲染成一页真实 DOM。
 * 静态书页和翻页条带共用这个函数 —— 这是「翻页时纸上的文字和落页后完全一致」的前提。
 */
export function renderPage(page: PageLayout, geometry: PageGeometry, target: HTMLElement): void {
  target.replaceChildren();
  const content = document.createElement('div');
  content.className = 'page__content';
  target.appendChild(content);

  for (const placed of page.blocks) {
    content.appendChild(renderPlacedBlock(placed, geometry));
  }
}

export function renderPlacedBlock(placed: PlacedBlock, geometry: PageGeometry): HTMLElement {
  const { block } = placed;
  const el = blockToElement(block);

  // 需要切分的块：放进带裁剪的槽子里
  const needsClip = block.type === 'paragraph' || block.type === 'quote';
  const listOrCode = block.type === 'list' || block.type === 'code';

  let host: HTMLElement = el;
  if (needsClip && (placed.lineFrom > 0 || placed.continues)) {
    const slot = document.createElement('div');
    slot.className = 'block-slot';
    slot.style.cssText = `position:absolute;left:${geometry.padding.left}px;right:${geometry.padding.right}px;top:${geometry.padding.top + placed.y}px;height:${placed.height}px;overflow:hidden;`;
    const startOffset = startOffsetOf(placed);
    el.style.marginTop = `${-startOffset}px`;
    slot.appendChild(el);
    host = slot;
  } else {
    el.style.cssText = `position:absolute;left:${geometry.padding.left}px;right:${geometry.padding.right}px;top:${geometry.padding.top + placed.y}px;`;
    if (listOrCode) {
      // 列表/代码按行显隐
      const selector = block.type === 'list' ? '.list-item' : '.code-line';
      const rows = [...el.querySelectorAll<HTMLElement>(selector)];
      rows.forEach((row, i) => {
        if (i < placed.lineFrom || i >= placed.lineTo) row.style.display = 'none';
      });
    } else if (placed.continues && placed.height < el.getBoundingClientRect().height) {
      // 放不下时裁掉溢出部分
      el.style.overflow = 'hidden';
      el.style.maxHeight = `${placed.height}px`;
    }
  }

  if (placed.continued) {
    el.classList.add('block--continued');
    // 段首缩进只该出现在段落的第一行，跨页续接的那一行不能缩进
    if (block.type === 'paragraph') el.classList.add('block--no-indent');
  }
  if (placed.continues) el.classList.add('block--continues');
  return host;
}

/** 碎片起始行在块内的偏移 */
function startOffsetOf(placed: PlacedBlock): number {
  const lines = lineCache.get(placed);
  if (!lines || placed.lineFrom === 0) return 0;
  return lines[placed.lineFrom]?.top ?? 0;
}

/**
 * 行盒缓存：渲染时需要知道「第 lineFrom 行在块内偏移多少」，
 * 而这些行盒是在度量阶段算出来的。用 PlacedBlock 做键挂上去，避免二次测量。
 */
const lineCache = new WeakMap<PlacedBlock, LineBox[]>();

/** paginate 之后调用：把度量阶段的行盒挂到每个落位块上 */
export function attachLineBoxes(
  blocks: Block[],
  provider: LayoutProvider,
  ctx: LayoutContext,
  result: { pages: PageLayout[] },
): void {
  const byBlock = new Map<Block, LineBox[] | undefined>();
  for (const b of blocks) {
    byBlock.set(b, provider.measure(b, ctx).lines ?? []);
  }
  for (const page of result.pages) {
    for (const placed of page.blocks) {
      lineCache.set(placed, byBlock.get(placed.block) ?? []);
    }
  }
}
