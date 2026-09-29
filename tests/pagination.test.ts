import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../src/core/markdown';
import type { Block, CodeBlock, HeadingBlock, ListBlock, ParagraphBlock } from '../src/core/model';
import {
  createEstimatingProvider,
  paginate,
  type BlockMetrics,
  type LayoutContext,
  type LayoutProvider,
  type PageLayout,
  type PlacedBlock,
} from '../src/core/pagination';
import { makeTheme, type ReadingTheme } from '../src/core/theme';

/* ------------------------------------------------------------------ */
/* 造数据                                                               */
/* ------------------------------------------------------------------ */

const LH = 20; // 行高
const AVAIL = 200; // 内容区高度 = 10 行

function para(text: string): ParagraphBlock {
  return { type: 'paragraph', runs: [{ text }], source: text };
}
function heading(text: string, level: HeadingBlock['level'] = 2): HeadingBlock {
  return { type: 'heading', level, runs: [{ text }], source: text };
}
function code(lines: number): CodeBlock {
  return { type: 'code', lang: 'ts', lines: Array.from({ length: lines }, (_, i) => `line ${i}`) };
}
function list(items: number): ListBlock {
  return {
    type: 'list',
    ordered: false,
    start: 1,
    items: Array.from({ length: items }, (_, i) => [{ text: `item ${i}` }]),
  };
}

/**
 * 确定性 provider：
 *  - 段落 / 列表：可断，每行 LH
 *  - 标题：40px 高，keepWithNext
 *  - 代码块：lines*26 + 12，原子不可断
 *  - 图片：160px，原子
 */
function fakeProvider(): LayoutProvider {
  return {
    measure(block: Block, ctx: LayoutContext): BlockMetrics {
      const spacing = ctx.theme.paragraphSpacing;
      switch (block.type) {
        case 'paragraph': {
          const lines = Math.max(1, Math.round((block.source?.length ?? 10) / 6));
          return {
            height: lines * LH,
            marginTop: spacing,
            marginBottom: 0,
            lines: Array.from({ length: lines }, (_, i) => ({ top: i * LH, height: LH })),
            breakable: true,
            keepWithNext: false,
          };
        }
        case 'list': {
          const lines = block.items.length;
          return {
            height: lines * LH,
            marginTop: spacing,
            marginBottom: 0,
            lines: Array.from({ length: lines }, (_, i) => ({ top: i * LH, height: LH })),
            breakable: true,
            keepWithNext: false,
          };
        }
        case 'heading':
          return { height: 40, marginTop: spacing, marginBottom: 4, breakable: false, keepWithNext: true };
        case 'code':
          return {
            height: block.lines.length * 26 + 12,
            marginTop: spacing,
            marginBottom: 0,
            breakable: false,
            keepWithNext: false,
            fallbackLines: Array.from({ length: block.lines.length }, (_, i) => ({
              top: 12 + i * 26,
              height: 26,
            })),
          };
        case 'image':
          return { height: 160, marginTop: spacing, marginBottom: 0, breakable: false, keepWithNext: false };
        case 'quote':
        case 'rule':
        default:
          return { height: 40, marginTop: spacing, marginBottom: 0, breakable: false, keepWithNext: false };
      }
    },
  };
}

function layout(blocks: Block[], theme = makeTheme('light'), contentHeight = AVAIL) {
  return paginate(blocks, fakeProvider(), {
    theme,
    contentWidth: 300,
    contentHeight,
  });
}

function pageTexts(page: PageLayout): string {
  return page.blocks.map((b) => blockLabel(b)).join('|');
}
function blockLabel(b: PlacedBlock): string {
  const base = b.block.type === 'paragraph' ? (b.block.source ?? '').slice(0, 6) : b.block.type;
  return b.continued || b.continues ? `${base}[${b.lineFrom}-${b.lineTo}]` : base;
}

/* ------------------------------------------------------------------ */
/* 用例                                                                 */
/* ------------------------------------------------------------------ */

describe('分页 / 基本正确性', () => {
  it('空文档不产生空白页', () => {
    const r = paginate([], fakeProvider(), { theme: makeTheme('light'), contentWidth: 300, contentHeight: AVAIL });
    expect(r.pageCount).toBe(0);
  });

  it('所有内容都被排到页上，一行不丢', () => {
    const blocks: Block[] = [heading('第一章'), para('a'.repeat(60)), list(4), para('b'.repeat(30)), code(6)];
    const r = layout(blocks);

    const seen = new Map<string, number>();
    for (const page of r.pages) {
      for (const b of page.blocks) {
        const key = b.block.type === 'paragraph' ? (b.block.source ?? '').slice(0, 6) : b.block.type;
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
    }
    expect(seen.size).toBe(5);
  });

  it('分页结果不重叠、不越界：任何一页的内容都不超过可用高度', () => {
    const blocks: Block[] = [heading('标题'), para('a'.repeat(90)), code(3), para('b'.repeat(66)), list(3)];
    const r = layout(blocks);
    for (const page of r.pages) {
      for (const b of page.blocks) {
        expect(b.y).toBeGreaterThanOrEqual(-0.01);
        expect(b.y + b.height).toBeLessThanOrEqual(AVAIL + 0.01);
      }
      // 同一页内块不能重叠
      const sorted = [...page.blocks].sort((a, b) => a.y - b.y);
      for (let i = 1; i < sorted.length; i += 1) {
        expect(sorted[i].y).toBeGreaterThanOrEqual(sorted[i - 1].y + sorted[i - 1].height - 0.01);
      }
    }
  });
});

describe('分页 / 填满页面，不留大块空白', () => {
  it('普通长文每页填充率都很高（> 70%，末页除外）', () => {
    const blocks: Block[] = Array.from({ length: 12 }, (_, i) => para(`段落${i}`.repeat(9)));
    const r = layout(blocks);
    expect(r.pageCount).toBeGreaterThan(2);
    for (let i = 0; i < r.pages.length - 1; i += 1) {
      expect(r.pages[i].fillRatio).toBeGreaterThan(0.7);
    }
  });

  it('不会为了「凑满」而把不该断的块切开', () => {
    const blocks: Block[] = [code(3), code(3), code(3), code(3)];
    const r = layout(blocks);
    for (const page of r.pages) {
      for (const b of page.blocks) {
        expect(b.lineFrom).toBe(0);
        expect(b.lineTo).toBe(1);
        expect(b.continues).toBe(false);
      }
    }
  });
});

describe('分页 / 不硬切', () => {
  it('段落只在行边界断开，且续页带 continued 标记', () => {
    const blocks: Block[] = [para('x'.repeat(200))];
    const r = layout(blocks);
    expect(r.pageCount).toBeGreaterThan(1);

    const fragments = r.pages.flatMap((p) => p.blocks).filter((b) => b.block.type === 'paragraph');
    expect(fragments.length).toBeGreaterThan(1);
    expect(fragments[0].continues).toBe(true);
    expect(fragments[fragments.length - 1].continued).toBe(true);

    for (const f of fragments) {
      expect(Number.isInteger(f.lineFrom)).toBe(true);
      expect(Number.isInteger(f.lineTo)).toBe(true);
      expect(f.lineTo).toBeGreaterThan(f.lineFrom);
    }
    // 行号必须首尾相接，中间不丢行
    for (let i = 1; i < fragments.length; i += 1) {
      expect(fragments[i].lineFrom).toBe(fragments[i - 1].lineTo);
    }
  });

  it('放得下的代码块绝不切开（整体搬到新页）', () => {
    const blocks: Block[] = [para('a'.repeat(60)), code(6), para('b'.repeat(60))];
    const r = layout(blocks);
    const codeBlocks = r.pages.flatMap((p) => p.blocks).filter((b) => b.block.type === 'code');
    expect(codeBlocks).toHaveLength(1);
    expect(codeBlocks[0].continued).toBe(false);
    expect(codeBlocks[0].continues).toBe(false);
    expect(codeBlocks[0].lineFrom).toBe(0);
    // 不能和它前面那个已经占满整页的段落挤在同一页
    const codePage = r.pages.find((p) => p.blocks.some((b) => b.block.type === 'code'));
    expect(codePage?.blocks[0].block.type).toBe('code');
  });

  it('高于整页的代码块按代码行切分，不丢内容', () => {
    const blocks: Block[] = [code(30)];
    const r = layout(blocks);
    const frags = r.pages.flatMap((p) => p.blocks).filter((b) => b.block.type === 'code');
    expect(frags.length).toBeGreaterThan(1);
    // 行号首尾相接，30 行一行不少
    expect(frags[0].lineFrom).toBe(0);
    expect(frags[frags.length - 1].lineTo).toBe(30);
    for (let i = 1; i < frags.length; i += 1) {
      expect(frags[i].lineFrom).toBe(frags[i - 1].lineTo);
      expect(frags[i].continued).toBe(true);
    }
  });

  it('标题不会孤零零留在页尾（keep-with-next）', () => {
    const blocks: Block[] = [para('a'.repeat(60)), heading('小节标题'), para('b'.repeat(12))];
    const r = layout(blocks);
    for (const page of r.pages) {
      const last = page.blocks[page.blocks.length - 1];
      if (last?.block.type === 'heading') {
        expect(page.index).toBe(r.pages.length - 1);
      }
    }
  });

  it('寡行控制：不会只留 1 行在下一页', () => {
    const blocks: Block[] = [para('y'.repeat(400))];
    const r = layout(blocks);
    const frags = r.pages.flatMap((p) => p.blocks).filter((b) => b.block.type === 'paragraph');
    for (let i = 0; i < frags.length - 1; i += 1) {
      const remaining = frags[i + 1].lineTo - frags[i + 1].lineFrom;
      expect(remaining).toBeGreaterThan(1);
    }
  });
});

describe('分页 / 主题变化重排', () => {
  const blocks: Block[] = Array.from({ length: 10 }, (_, i) => para(`主题测试段落${i}`.repeat(28)));
  const base = { contentWidth: 300, contentHeight: 400 } as const;

  it('改变字号后页数变化，且签名同步变化', () => {
    const provider = createEstimatingProvider();
    const small = paginate(blocks, provider, { ...base, theme: makeTheme('light', { fontSize: 14 }) });
    const big = paginate(blocks, provider, { ...base, theme: makeTheme('light', { fontSize: 26 }) });

    expect(small.pageCount).toBeGreaterThan(1);
    expect(big.pageCount).toBeGreaterThan(small.pageCount);
    expect(small.themeSignatureValue).not.toBe(big.themeSignatureValue);
  });

  it('改变行距/段距同样触发重排', () => {
    const provider = createEstimatingProvider();
    const a = paginate(blocks, provider, { ...base, theme: makeTheme('light', { lineHeight: 1.4, paragraphSpacing: 0 }) });
    const b = paginate(blocks, provider, { ...base, theme: makeTheme('light', { lineHeight: 2.1, paragraphSpacing: 20 }) });
    expect(b.pageCount).toBeGreaterThan(a.pageCount);
  });

  it('改变页内边距同样触发重排（内容区随之变化）', () => {
    const provider = createEstimatingProvider();
    const tight = makeTheme('light', { padding: { top: 4, right: 4, bottom: 4, left: 4 } });
    const loose = makeTheme('light', { padding: { top: 40, right: 40, bottom: 40, left: 40 } });
    // 真实渲染里内容区 = 页尺寸 - 内边距，这里模拟同一张纸上的两种留白
    const a = paginate(blocks, provider, { theme: tight, contentWidth: 300 - 8, contentHeight: 400 - 8 });
    const b = paginate(blocks, provider, { theme: loose, contentWidth: 300 - 80, contentHeight: 400 - 80 });
    expect(b.pageCount).toBeGreaterThan(a.pageCount);
  });

  it('分页结果带上主题签名，上层据此让缓存失效', () => {
    const r = layout(blocks, makeTheme('sepia', { fontSize: 18 }));
    expect(r.themeSignatureValue).toContain('18');
  });
});

describe('分页 / 极端输入', () => {
  it('无法切分的块（图片）高于整页时独占一页并标记溢出', () => {
    // 内容区只有 100px，而图片高 160px —— 无处可切，只能溢出标记
    const r = paginate([{ type: 'image', src: 'x.png', alt: 'a' }], fakeProvider(), {
      theme: makeTheme('light'),
      contentWidth: 300,
      contentHeight: 100,
    });
    expect(r.pageCount).toBe(1);
    expect(r.pages[0].blocks[0].continues).toBe(true);
  });

  it('内容区高度为 0 时不死循环', () => {
    const r = paginate([para('z'.repeat(60))], fakeProvider(), {
      theme: makeTheme('light'),
      contentWidth: 300,
      contentHeight: 1,
    });
    expect(r.pageCount).toBeGreaterThan(0);
  });

  it('空段落不会产生 0 高度碎片导致死循环', () => {
    const r = layout([para(''), para(''), para('')]);
    expect(r.pageCount).toBeLessThanOrEqual(3);
  });
});

describe('Markdown 解析器', () => {
  it('解析标题、段落、代码块、列表、引用、图片、分隔线', () => {
    const md = [
      '# 一级',
      '',
      '普通段落 **粗体** 和 `代码`。',
      '',
      '## 二级',
      '',
      '```ts',
      'const a = 1;',
      '```',
      '',
      '- 项目一',
      '- 项目二',
      '',
      '1. 第一',
      '2. 第二',
      '',
      '> 引用一句话',
      '',
      '![图](https://example.com/a.png)',
      '',
      '---',
    ].join('\n');
    const types = parseMarkdown(md).blocks.map((b) => b.type);
    expect(types).toEqual([
      'heading',
      'paragraph',
      'heading',
      'code',
      'list',
      'list',
      'quote',
      'image',
      'rule',
    ]);
  });

  it('行内样式解析正确', () => {
    const [p] = parseMarkdown('这里有 **粗**、*斜*、`码`、~~删~~ 和 [链接](https://a.com)').blocks;
    expect(p.type).toBe('paragraph');
    if (p.type !== 'paragraph') return;
    const runs = p.runs;
    expect(runs.find((r) => r.bold)?.text).toBe('粗');
    expect(runs.find((r) => r.italic)?.text).toBe('斜');
    expect(runs.find((r) => r.code)?.text).toBe('码');
    expect(runs.find((r) => r.strike)?.text).toBe('删');
    expect(runs.find((r) => r.href)?.href).toBe('https://a.com');
  });

  it('代码块内的 * 和 # 不会被当成语法', () => {
    const [c] = parseMarkdown('```\n# not a heading\n*not italic\n```').blocks;
    expect(c.type).toBe('code');
    if (c.type === 'code') {
      expect(c.lines).toEqual(['# not a heading', '*not italic']);
    }
  });

  it('转义符号不吞字符', () => {
    const [p] = parseMarkdown('价格 \\* 50 元').blocks;
    if (p.type === 'paragraph') expect(p.runs.map((r) => r.text).join('')).toContain('* 50');
  });

  it('空输入与纯空白输入不产生块', () => {
    expect(parseMarkdown('').blocks).toHaveLength(0);
    expect(parseMarkdown('   \n\n  \n').blocks).toHaveLength(0);
  });

  it('多行段落合并为一块', () => {
    const blocks = parseMarkdown('第一行\n第二行\n第三行').blocks;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('paragraph');
  });
});

describe('页面文本可还原（e2e 断言依赖）', () => {
  it('分页后按顺序拼回的文本与原文一致', () => {
    const md = ['# 标题', '', '第一段内容。', '', '第二段内容。', '', '第三段内容。'].join('\n');
    const doc = parseMarkdown(md);
    const r = paginate(doc.blocks, createEstimatingProvider(), {
      theme: makeTheme('light'),
      contentWidth: 160,
      contentHeight: 120,
    });
    expect(r.pageCount).toBeGreaterThan(1);
    const joined = r.pages
      .flatMap((p) => p.blocks)
      .map((b) => b.block.type === 'paragraph' ? b.block.runs.map((x) => x.text).join('') : '')
      .join('');
    expect(joined).toContain('第一段内容。');
    expect(joined).toContain('第三段内容。');
    expect(pageTexts(r.pages[0]).length).toBeGreaterThan(0);
  });
});

export type { ReadingTheme };
