/**
 * 主题模型 —— 跨端统一的排版参数 + 颜色。
 *
 * 验收项「主题参数变化后必须重新分页」靠 themeSignature() 实现：
 * 任何影响排版的字段变化都会改变签名，上层据此让分页缓存失效。
 */

export interface ThemeColors {
  pageBg: string;
  pageEdge: string;
  text: string;
  textSecondary: string;
  accent: string;
  codeBg: string;
  codeText: string;
  quoteBorder: string;
  rule: string;
  selection: string;
}

export interface ReadingTheme {
  id: string;
  label: string;
  /** 正文字号，px */
  fontSize: number;
  /** 行高倍数（相对 fontSize） */
  lineHeight: number;
  /** 段落间距，px */
  paragraphSpacing: number;
  /** 页内边距，px */
  padding: { top: number; right: number; bottom: number; left: number };
  /** 段首缩进倍数，0 = 不缩进 */
  indentEm: number;
  fontFamily: string;
  colors: ThemeColors;
}

export interface ThemeBounds {
  fontSize: [number, number];
  lineHeight: [number, number];
  paragraphSpacing: [number, number];
  indentEm: [number, number];
  padding: [number, number];
}

export const DEFAULT_BOUNDS: ThemeBounds = {
  fontSize: [13, 34],
  lineHeight: [1.2, 2.4],
  paragraphSpacing: [0, 40],
  indentEm: [0, 2],
  padding: [12, 72],
};

export const FONT_STACK =
  '"Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", Georgia, serif';

const BASE_COLORS: Record<'light' | 'sepia' | 'dark', ThemeColors> = {
  light: {
    pageBg: '#ffffff',
    pageEdge: '#e6e2da',
    text: '#1d1b18',
    textSecondary: '#6b6659',
    accent: '#b0522b',
    codeBg: '#f4f1ea',
    codeText: '#3b3527',
    quoteBorder: '#c9c2b2',
    rule: '#ddd8cc',
    selection: 'rgba(64, 132, 214, 0.28)',
  },
  sepia: {
    pageBg: '#f4ecd8',
    pageEdge: '#ddd0ae',
    text: '#40382a',
    textSecondary: '#7d7159',
    accent: '#a3552a',
    codeBg: '#e9dfc4',
    codeText: '#4a4130',
    quoteBorder: '#c3b48c',
    rule: '#d6c8a4',
    selection: 'rgba(168, 120, 40, 0.3)',
  },
  dark: {
    pageBg: '#1a1c20',
    pageEdge: '#0d0e10',
    text: '#d7d9dd',
    textSecondary: '#8b9098',
    accent: '#e08a4b',
    codeBg: '#24272c',
    codeText: '#c9ccd2',
    quoteBorder: '#3c4148',
    rule: '#31353b',
    selection: 'rgba(90, 150, 235, 0.35)',
  },
};

export function makeTheme(
  id: 'light' | 'sepia' | 'dark',
  overrides: Partial<Omit<ReadingTheme, 'colors'>> = {},
  colorOverrides: Partial<ThemeColors> = {},
): ReadingTheme {
  const base: ReadingTheme = {
    id,
    label: id === 'light' ? '白' : id === 'sepia' ? '护眼' : '夜间',
    fontSize: 17,
    lineHeight: 1.75,
    paragraphSpacing: 12,
    padding: { top: 26, right: 22, bottom: 26, left: 22 },
    indentEm: 0,
    fontFamily: FONT_STACK,
    colors: { ...BASE_COLORS[id], ...colorOverrides },
  };
  return { ...base, ...overrides, colors: { ...base.colors, ...colorOverrides } };
}

export const DEFAULT_THEME: ReadingTheme = makeTheme('sepia');

/** 夹紧到合法区间，避免用户把行高拉到 3.0 或字号拉到 4px */
export function clampTheme(theme: ReadingTheme, bounds: ThemeBounds = DEFAULT_BOUNDS): ReadingTheme {
  const c = (v: number, r: [number, number]) => Math.min(r[1], Math.max(r[0], v));
  return {
    ...theme,
    fontSize: c(theme.fontSize, bounds.fontSize),
    lineHeight: c(theme.lineHeight, bounds.lineHeight),
    paragraphSpacing: c(theme.paragraphSpacing, bounds.paragraphSpacing),
    indentEm: c(theme.indentEm, bounds.indentEm),
    padding: {
      top: c(theme.padding.top, [bounds.padding[0], bounds.padding[0] * 4]),
      right: c(theme.padding.right, [bounds.padding[0], bounds.padding[0] * 4]),
      bottom: c(theme.padding.bottom, [bounds.padding[0], bounds.padding[0] * 4]),
      left: c(theme.padding.left, [bounds.padding[0], bounds.padding[0] * 4]),
    },
  };
}

const LAYOUT_KEYS = ['fontSize', 'lineHeight', 'paragraphSpacing', 'indentEm', 'fontFamily', 'padding'] as const;

/**
 * 分页缓存签名。只包含影响排版的字段——
 * 换配色不该重新分页（纯视觉），改字号必须重新分页。
 */
export function themeSignature(theme: ReadingTheme): string {
  const p = theme.padding;
  return LAYOUT_KEYS.map((k) => {
    if (k === 'padding') return `${p.top}/${p.right}/${p.bottom}/${p.left}`;
    if (k === 'fontFamily') return theme.fontFamily;
    return String(theme[k]);
  }).join('|');
}

export function themesEqual(a: ReadingTheme, b: ReadingTheme): boolean {
  return themeSignature(a) === themeSignature(b) && a.id === b.id && colorSignature(a) === colorSignature(b);
}

/** 配色签名：只换配色不该触发重新分页，但要算作「主题变了」 */
export function colorSignature(theme: ReadingTheme): string {
  const c = theme.colors;
  return [
    c.pageBg, c.pageEdge, c.text, c.textSecondary, c.accent,
    c.codeBg, c.codeText, c.quoteBorder, c.rule, c.selection,
  ].join(',');
}

/* ------------------------------------------------------------------ */
/* 持久化：core 只定义接口，具体实现由各端注入                             */
/* ------------------------------------------------------------------ */

export interface ThemePersistence {
  load(): Partial<ReadingTheme> | null;
  save(theme: ReadingTheme): void;
}

export interface ThemeStore {
  get(): ReadingTheme;
  set(theme: ReadingTheme): void;
  subscribe(fn: (t: ReadingTheme) => void): () => void;
}

export function createThemeStore(
  persistence: ThemePersistence | null,
  initial: ReadingTheme = DEFAULT_THEME,
  bounds: ThemeBounds = DEFAULT_BOUNDS,
): ThemeStore {
  let current = clampTheme({ ...initial, ...(persistence?.load() ?? {}) }, bounds);
  const listeners = new Set<(t: ReadingTheme) => void>();

  return {
    get: () => current,
    set(next) {
      const normalized = clampTheme(next, bounds);
      if (themesEqual(normalized, current)) return;
      current = normalized;
      persistence?.save(normalized);
      listeners.forEach((fn) => fn(current));
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
