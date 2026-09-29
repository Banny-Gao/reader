/**
 * 极简 Markdown → Block IR 解析器。
 *
 * 设计原则：**不引三方依赖、纯函数、可单测**。
 * 覆盖范围（阅读器正文够用的子集）：
 *   标题 / 段落 / 围栏代码块 / 引用 / 有序无序列表 / 图片 / 分隔线
 *   行内：**粗体** *斜体* `代码` ~~删除~~ [链接](url) 以及 \ 转义
 *
 * 已知取舍：
 *   - 列表只支持单层，缩进嵌套会被当作新的列表项（README 里有登记）
 *   - 不支持 HTML 内嵌（会被当纯文本输出，避免 XSS）
 *   - 表格按普通段落处理
 */

import type {
  Block,
  CodeBlock,
  Document,
  HeadingBlock,
  ImageBlock,
  InlineRun,
  ListBlock,
  ParagraphBlock,
  QuoteBlock,
  RuleBlock,
} from './model';

const FENCE_RE = /^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const HR_RE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const UL_RE = /^(\s*)[-*+]\s+(.*)$/;
const OL_RE = /^(\s*)(\d+)[.)]\s+(.*)$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
const IMAGE_ONLY_RE = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/;
const BLANK_RE = /^\s*$/;

/* ------------------------------------------------------------------ */
/* 行内解析                                                             */
/* ------------------------------------------------------------------ */

interface InlineRule {
  re: RegExp;
  build: (m: RegExpExecArray) => InlineRun | InlineRun[] | null;
}

// 顺序敏感：先匹配引用块级语法，避免 `[a](b)` 里的括号被误解
const INLINE_RULES: InlineRule[] = [
  {
    re: /`([^`]+)`/,
    build: (m) => ({ text: m[1], code: true }),
  },
  {
    re: /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/,
    build: (m) => ({ text: m[1], href: m[2] }),
  },
  {
    re: /\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/,
    build: (m) => ({ text: m[1], href: m[2] }),
  },
  {
    re: /\*\*([^*]+)\*\*/,
    build: (m) => ({ text: m[1], bold: true }),
  },
  {
    re: /__([^_]+)__/,
    build: (m) => ({ text: m[1], bold: true }),
  },
  {
    re: /~~([^~]+)~~/,
    build: (m) => ({ text: m[1], strike: true }),
  },
  {
    re: /\*([^*\n]+)\*/,
    build: (m) => ({ text: m[1], italic: true }),
  },
  {
    re: /_([^_\n]+)_/,
    build: (m) => ({ text: m[1], italic: true }),
  },
];

/**
 * 解析一行内联语法。
 * 采用「左到右扫描 + 规则表」而非全局正则链，避免 `**a *b* c**` 这类嵌套被截断。
 */
export function parseInline(input: string): InlineRun[] {
  const runs: InlineRun[] = [];
  let buffer = '';
  let i = 0;

  const flush = () => {
    if (buffer) {
      runs.push({ text: buffer });
      buffer = '';
    }
  };

  while (i < input.length) {
    const ch = input[i];

    // 反斜杠转义
    if (ch === '\\' && i + 1 < input.length) {
      buffer += input[i + 1];
      i += 2;
      continue;
    }

    // 候选规则的起始字符，快速跳过
    const canStart =
      ch === '`' || ch === '!' || ch === '[' || ch === '*' || ch === '_' || ch === '~';
    let matched = false;

    if (canStart) {
      const rest = input.slice(i);
      for (const rule of INLINE_RULES) {
        const m = rule.re.exec(rest);
        // 必须紧贴当前位置，否则普通文本里的星号会被误吃
        if (m && m.index === 0) {
          const built = rule.build(m);
          if (built) {
            flush();
            if (Array.isArray(built)) runs.push(...built);
            else runs.push(built);
            i += m[0].length;
            matched = true;
            break;
          }
        }
      }
    }

    if (matched) continue;

    buffer += ch;
    i += 1;
  }

  flush();
  return runs.length ? runs : [{ text: '' }];
}

/* ------------------------------------------------------------------ */
/* 块级解析                                                             */
/* ------------------------------------------------------------------ */

export function parseMarkdown(markdown: string): Document {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (BLANK_RE.test(line)) {
      i += 1;
      continue;
    }

    // ---- 围栏代码块
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1][0];
      const buf: string[] = [];
      i += 1;
      while (i < lines.length) {
        const cur = lines[i];
        if (cur.trimStart().startsWith(marker.repeat(3)) && FENCE_RE.test(cur)) break;
        buf.push(cur);
        i += 1;
      }
      i += 1; // 吃掉收尾围栏
      const block: CodeBlock = {
        type: 'code',
        lang: fence[2] ?? '',
        lines: buf,
        source: buf.join('\n'),
      };
      blocks.push(block);
      continue;
    }

    // ---- 分隔线
    if (HR_RE.test(line)) {
      const block: RuleBlock = { type: 'rule', source: line };
      blocks.push(block);
      i += 1;
      continue;
    }

    // ---- 标题
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = Math.min(6, heading[1].length) as HeadingBlock['level'];
      const block: HeadingBlock = {
        type: 'heading',
        level,
        runs: parseInline(heading[2].trim()),
        source: line,
      };
      blocks.push(block);
      i += 1;
      continue;
    }

    // ---- 引用
    const quote = QUOTE_RE.exec(line);
    if (quote) {
      const buf: string[] = [];
      while (i < lines.length) {
        const m = QUOTE_RE.exec(lines[i]);
        if (!m) break;
        buf.push(m[1]);
        i += 1;
      }
      const block: QuoteBlock = {
        type: 'quote',
        runs: parseInline(buf.join(' ').trim()),
        source: buf.join('\n'),
      };
      blocks.push(block);
      continue;
    }

    // ---- 列表（连续的同类型行合并成一个 ListBlock）
    const ul = UL_RE.exec(line);
    const ol = OL_RE.exec(line);
    if (ul || ol) {
      const ordered = !!ol;
      const start = ordered ? Number((ol as RegExpExecArray)[2]) : 1;
      const items: InlineRun[][] = [];
      const sources: string[] = [];
      while (i < lines.length) {
        const cur = lines[i];
        const mu = UL_RE.exec(cur);
        const mo = OL_RE.exec(cur);
        if (ordered && mo) {
          items.push(parseInline(mo[3].trim()));
          sources.push(cur);
          i += 1;
          continue;
        }
        if (!ordered && mu) {
          items.push(parseInline(mu[2].trim()));
          sources.push(cur);
          i += 1;
          continue;
        }
        // 列表项内的续行（缩进文本）并入上一项
        if (!BLANK_RE.test(cur) && items.length > 0 && /^\s+\S/.test(cur)) {
          const last = items[items.length - 1];
          last.push({ text: ' ' });
          last.push(...parseInline(cur.trim()));
          sources.push(cur);
          i += 1;
          continue;
        }
        break;
      }
      const block: ListBlock = {
        type: 'list',
        ordered,
        start,
        items,
        source: sources.join('\n'),
      };
      blocks.push(block);
      continue;
    }

    // ---- 独占一行的图片 → ImageBlock
    const img = IMAGE_ONLY_RE.exec(line.trim());
    if (img) {
      const block: ImageBlock = {
        type: 'image',
        src: img[2],
        alt: img[1],
        source: line,
      };
      blocks.push(block);
      i += 1;
      continue;
    }

    // ---- 段落（连续非空行合并）
    const buf: string[] = [];
    while (i < lines.length && !BLANK_RE.test(lines[i])) {
      const cur = lines[i];
      if (
        HEADING_RE.test(cur) ||
        FENCE_RE.test(cur) ||
        HR_RE.test(cur) ||
        QUOTE_RE.test(cur) ||
        UL_RE.test(cur) ||
        OL_RE.test(cur)
      ) {
        if (buf.length === 0) break; // 让下一轮按各自规则处理
        break;
      }
      buf.push(cur.trim());
      i += 1;
    }
    if (buf.length) {
      const block: ParagraphBlock = {
        type: 'paragraph',
        runs: parseInline(buf.join(' ')),
        source: buf.join('\n'),
      };
      blocks.push(block);
    } else {
      // 防御：无法消费的行跳过，避免死循环
      i += 1;
    }
  }

  return { blocks, markdown };
}
