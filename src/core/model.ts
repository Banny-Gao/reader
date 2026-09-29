/**
 * 文档模型 —— 框架无关的中间表示。
 *
 * 为什么要自己定义一层 IR，而不是让各端直接消费 Markdown：
 * 1. 分页算法需要「块 + 行盒 + 原子性」这种结构化信息，Markdown 源码给不了；
 * 2. 三端（Taro / RN / Web）的渲染能力不同，但 IR 可以完全一致，
 *    保证「同一份 Markdown → 同一份分页结果」这条验收项可被单元测试锁死。
 *
 * 契约稳定性：本文件是 core 的对外契约，改动需要同步 core/VERSION。
 */

export type BlockType =
  | 'heading'
  | 'paragraph'
  | 'code'
  | 'quote'
  | 'list'
  | 'image'
  | 'rule';

export interface InlineRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
  href?: string;
}

export interface BlockBase {
  /** 原始文本，用于 e2e 断言与调试 */
  source?: string;
}

export interface HeadingBlock extends BlockBase {
  type: 'heading';
  level: 1 | 2 | 3 | 4 | 5 | 6;
  runs: InlineRun[];
}

export interface ParagraphBlock extends BlockBase {
  type: 'paragraph';
  runs: InlineRun[];
}

export interface CodeBlock extends BlockBase {
  type: 'code';
  lang: string;
  lines: string[];
}

export interface QuoteBlock extends BlockBase {
  type: 'quote';
  runs: InlineRun[];
}

export interface ListBlock extends BlockBase {
  type: 'list';
  ordered: boolean;
  start: number;
  items: InlineRun[][];
}

export interface ImageBlock extends BlockBase {
  type: 'image';
  src: string;
  alt: string;
  captionRuns?: InlineRun[];
}

export interface RuleBlock extends BlockBase {
  type: 'rule';
}

export type Block =
  | HeadingBlock
  | ParagraphBlock
  | CodeBlock
  | QuoteBlock
  | ListBlock
  | ImageBlock
  | RuleBlock;

/**
 * 哪些块「允许在行边界处断开」。
 * 段落、引言、列表项之间可以断；
 * 代码块、图片、标题、分隔线不���许硬切（标题另走 keepWithNext）。
 */
export function isBreakable(block: Block): boolean {
  return block.type === 'paragraph' || block.type === 'quote' || block.type === 'list';
}

/** 标题不能孤零零地留在页尾 */
export function isKeepWithNext(block: Block): boolean {
  return block.type === 'heading';
}

/** 整块不可分割，必须整体搬到下一页 */
export function isAtomic(block: Block): boolean {
  return block.type === 'code' || block.type === 'image' || block.type === 'rule' || block.type === 'heading';
}

export function blockPlainText(block: Block): string {
  switch (block.type) {
    case 'heading':
    case 'paragraph':
    case 'quote':
      return block.runs.map((r) => r.text).join('');
    case 'code':
      return block.lines.join('\n');
    case 'list':
      return block.items.map((i) => i.map((r) => r.text).join('')).join('\n');
    case 'image':
      return block.alt;
    case 'rule':
      return '';
  }
}

export interface Document {
  blocks: Block[];
  /** 原始 Markdown，便于回溯与调试 */
  markdown: string;
}
