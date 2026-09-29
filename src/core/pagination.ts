/**
 * 分页引擎 —— 三端共用的核心算法。
 *
 * 设计目标（直接对应需求 3.2）：
 *   1. 每页尽可能填满  → 贪心填充 + 孤行/寡行控制
 *   2. 不该断开的不断  → 原子块整体搬家；标题 keep-with-next；只允许在行边界断开
 *   3. 主题变化重排    → 上层用 themeSignature 驱动重跑
 *
 * 平台差异被收敛到一个接口上：
 *   Web   → 隐藏 DOM 量测（真排版，与渲染 100% 一致）
 *   Taro  → 小程序 selectorQuery 逐块量测
 *   RN    → react-native-skia / measure 逐块量测
 * 只要实现 LayoutProvider，三端分页结果就一致。
 */

import type { Block } from './model';
import { isAtomic, isBreakable, isKeepWithNext } from './model';
import type { ReadingTheme } from './theme';
import { themeSignature } from './theme';

export interface LineBox {
  /** 行盒顶边相对块顶边的偏移，px */
  top: number;
  height: number;
}

export interface BlockMetrics {
  /** 整块高度（含内边距，不含外边距） */
  height: number;
  marginTop: number;
  marginBottom: number;
  /** 行盒列表；原子块为 undefined */
  lines?: LineBox[];
  /**
   * 降级切分点：当整块高于整页时，允许按这些行边界拆。
   * 用于「超长代码块」——放得下时绝不切开，放不下时按行切，绝不丢内容。
   */
  fallbackLines?: LineBox[];
  /** 允许在行边界拆分 */
  breakable: boolean;
  keepWithNext: boolean;
}

export interface LayoutContext {
  theme: ReadingTheme;
  /** 内容区宽度（已扣除 padding） */
  contentWidth: number;
  /** 内容区高度（已扣除 padding） */
  contentHeight: number;
}

export interface LayoutProvider {
  measure(block: Block, ctx: LayoutContext): BlockMetrics;
}

export interface PlacedBlock {
  block: Block;
  /** 该块被拆分时的行区间（左闭右开） */
  lineFrom: number;
  lineTo: number;
  /** 相对内容区顶边的 y */
  y: number;
  /** 落位后的实际高度 */
  height: number;
  /** 由上一页延续而来 */
  continued: boolean;
  /** 还有后续内容在下一页 */
  continues: boolean;
}

export interface PageLayout {
  index: number;
  blocks: PlacedBlock[];
  /** 内容填充率，用于「不要留大块空白」的自检 */
  fillRatio: number;
  height: number;
}

export interface PaginationOptions {
  /** 寡行控制：分页后剩余行数少于该值时，回退一行 */
  widow?: number;
  /** 单块高于整页时是否允许溢出一页（代码块超长场景） */
  allowOversizeBlock?: boolean;
}

export interface PaginationResult {
  pages: PageLayout[];
  pageCount: number;
  themeSignatureValue: string;
}

function linesHeight(lines: LineBox[], from: number, to: number): number {
  if (to <= from) return 0;
  const startTop = from === 0 ? 0 : lines[from].top;
  const last = lines[to - 1];
  return last.top + last.height - startTop;
}

function fitsFragment(
  lines: LineBox[],
  y: number,
  avail: number,
  from: number,
  total: number,
): number {
  /**
   * 返回「当前页从 from 开始最多能放下多少行」。
   * 碎片高度会扣掉首行上方的块内偏移——续页上那部分偏移不该重复计入。
   */
  let best = 0;
  for (let k = from + 1; k <= total; k += 1) {
    const h = linesHeight(lines, from, k);
    if (y + h <= avail + 0.01) best = k - from;
    else break;
  }
  return best;
}

export function paginate(
  blocks: Block[],
  provider: LayoutProvider,
  ctx: LayoutContext,
  options: PaginationOptions = {},
): PaginationResult {
  const widow = options.widow ?? 2;
  const avail = Math.max(1, ctx.contentHeight);
  const pages: PageLayout[] = [];
  let current: PlacedBlock[] = [];
  let y = 0;

  const flush = () => {
    if (current.length === 0) return;
    const used = current.reduce((max, b) => Math.max(max, b.y + b.height), 0);
    pages.push({
      index: pages.length,
      blocks: current,
      height: used,
      fillRatio: Math.min(1, used / avail),
    });
    current = [];
    y = 0;
  };

  const startPage = () => {
    if (current.length > 0) flush();
    y = 0;
  };

  for (let bi = 0; bi < blocks.length; bi += 1) {
    const block = blocks[bi];
    const m = provider.measure(block, ctx);
    const isFirstOnPage = current.length === 0;
    const gap = isFirstOnPage ? 0 : m.marginTop;

    // ---- 标题孤行保护：标题 + 下一块首行必须同页
    let keepGuard = 0;
    if (isKeepWithNext(block) && bi + 1 < blocks.length) {
      const nextM = provider.measure(blocks[bi + 1], ctx);
      const nextFirst = nextM.lines?.[0]?.height ?? nextM.height;
      keepGuard = nextFirst + nextM.marginTop;
    }

    const fullH = m.height;

    // ---- 情况 1：整块放得下
    if (y + gap + fullH + keepGuard <= avail + 0.01) {
      current.push({
        block,
        lineFrom: 0,
        lineTo: m.lines?.length ?? 1,
        y: y + gap,
        height: fullH,
        continued: false,
        continues: false,
      });
      y += gap + fullH;
      if (y >= avail - 0.01) startPage();
      continue;
    }

    // ---- 情况 2：可拆分块，在行边界处断
    // 原子块只有在「整页都装不下」时才降级为可拆（超长代码块按行切，绝不丢内容）
    const lines = m.breakable && m.lines ? m.lines : m.height > avail ? m.fallbackLines : undefined;
    if (lines && lines.length > 0) {
      const total = lines.length;
      let from = 0;
      let carriedFromPrevious = false;
      // 同一段落可能跨多次循环（新页继续放），用 while 处理
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const pageStartY = y + (from === 0 ? gap : 0);
        let take = fitsFragment(lines, pageStartY, avail, from, total);

        // 寡行控制：下一页只剩 1 行 → 本页少放一行
        if (take > 0 && take < total - from && total - (from + take) === 1 && take > widow) {
          take -= 1;
        }
        // 放不下任何一行 → 换页重来
        if (take === 0) {
          if (current.length === 0) {
            // 空页仍放不下（单行高于整页）→ 强行放一行，避免死循环
            if (from < total) take = 1;
            else break;
          } else {
            startPage();
            continue;
          }
        }

        const h = linesHeight(lines, from, from + take);
        const continues = from + take < total;
        current.push({
          block,
          lineFrom: from,
          lineTo: from + take,
          y: pageStartY,
          height: h,
          continued: carriedFromPrevious,
          continues,
        });
        y = pageStartY + h;

        if (continues) {
          from += take;
          carriedFromPrevious = true;
          startPage();
          continue;
        }
        break;
      }
      if (y >= avail - 0.01) startPage();
      continue;
    }

    // ---- 情况 3：原子块 —— 整体搬到下一页
    const oversize = fullH > avail;
    if (current.length > 0) startPage();
    current.push({
      block,
      lineFrom: 0,
      lineTo: 1,
      y: 0,
      height: Math.min(fullH, avail),
      continued: false,
      continues: oversize,
    });
    y = Math.min(fullH, avail);
    startPage();
  }

  flush();

  return {
    pages,
    pageCount: pages.length,
    themeSignatureValue: themeSignature(ctx.theme),
  };
}

/* ------------------------------------------------------------------ */
/* 纯函数版度量：单测与无 DOM 环境（Taro/RN 首屏预估）使用                  */
/* ------------------------------------------------------------------ */

/** 估算字符宽度：中文 1em、拉丁 0.5em —— 只用于测试/降级，不用于真实渲染 */
export function estimateLineCount(text: string, contentWidth: number, fontSize: number): number {
  if (fontSize <= 0) return 1;
  const perLine = Math.max(1, Math.floor(contentWidth / (fontSize * 0.5)));
  let lines = 0;
  for (const seg of text.split('\n')) {
    const units = [...seg].reduce((acc, ch) => acc + (isWide(ch) ? 2 : 1), 0);
    lines += Math.max(1, Math.ceil(units / (perLine * 2)));
  }
  return lines;
}

export function isWide(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  );
}

export function createEstimatingProvider(): LayoutProvider {
  return {
    measure(block, ctx) {
      const { theme, contentWidth, contentHeight } = ctx;
      const lh = theme.fontSize * theme.lineHeight;
      const text = blockText(block);
      const lines = estimateLineCount(text, contentWidth, theme.fontSize);
      const atomic = isAtomic(block);
      let height: number;
      let breakable = isBreakable(block);
      let lineBoxes: LineBox[] | undefined;
      let fallbackLines: LineBox[] | undefined;

      if (block.type === 'heading') {
        height = lh * (block.level <= 2 ? 2 : block.level <= 3 ? 1.6 : 1.3) + theme.paragraphSpacing;
        breakable = false;
      } else if (block.type === 'rule') {
        height = theme.paragraphSpacing * 2 + 1;
        breakable = false;
      } else if (block.type === 'code') {
        const codeLh = theme.fontSize * 1.5;
        const pad = theme.fontSize;
        height = block.lines.length * codeLh + pad;
        breakable = false;
        lineBoxes = undefined;
        // 整页装不下时按代码行切分
        fallbackLines = Array.from({ length: block.lines.length }, (_, i) => ({
          top: pad + i * codeLh,
          height: codeLh,
        }));
      } else if (block.type === 'image') {
        height = Math.min(contentHeight * 0.5, contentWidth * 0.62) + theme.paragraphSpacing;
        breakable = false;
      } else {
        height = lines * lh + (block.type === 'paragraph' ? theme.paragraphSpacing : 0);
      }

      if (breakable) {
        lineBoxes = Array.from({ length: lines }, (_, i) => ({ top: i * lh, height: lh }));
      } else if (atomic) {
        lineBoxes = undefined;
      }

      return {
        height,
        marginTop: block.type === 'paragraph' ? theme.paragraphSpacing : theme.paragraphSpacing * 0.5,
        marginBottom: 0,
        lines: lineBoxes,
        fallbackLines,
        breakable,
        keepWithNext: isKeepWithNext(block),
      };
    },
  };
}

function blockText(block: Block): string {
  switch (block.type) {
    case 'heading':
    case 'paragraph':
    case 'quote':
      return block.runs.map((r) => r.text).join('');
    case 'list':
      return block.items.map((i) => i.map((r) => r.text).join('')).join('\n');
    case 'code':
      return block.lines.join('\n');
    case 'image':
      return '';
    case 'rule':
      return '';
  }
}

export { blockText, linesHeight };
