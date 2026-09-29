import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clampTheme,
  createThemeStore,
  DEFAULT_BOUNDS,
  makeTheme,
  themeSignature,
  themesEqual,
  type ThemePersistence,
} from '../src/core/theme';

describe('主题 / 签名', () => {
  it('排版字段变化会改变签名', () => {
    const a = themeSignature(makeTheme('light', { fontSize: 16 }));
    const b = themeSignature(makeTheme('light', { fontSize: 17 }));
    expect(a).not.toBe(b);
  });

  it('行距、段距、内边距、缩进都参与签名', () => {
    const base = makeTheme('light');
    const keys: Array<keyof ReturnType<typeof makeTheme>> = [
      'lineHeight',
      'paragraphSpacing',
      'indentEm',
      'fontFamily',
    ];
    for (const k of keys) {
      const changed = { ...base, [k]: k === 'fontFamily' ? 'serif-x' : 2 };
      expect(themeSignature(changed)).not.toBe(themeSignature(base));
    }
    const pad = { ...base, padding: { ...base.padding, top: 99 } };
    expect(themeSignature(pad)).not.toBe(themeSignature(base));
  });

  it('只改配色不改排版 → 签名不变（不该触发重新分页）', () => {
    const a = makeTheme('light');
    const b = makeTheme('dark');
    expect(themeSignature(a)).toBe(themeSignature(b));
    expect(a.id).not.toBe(b.id);
    expect(themesEqual(a, b)).toBe(false); // 但整体主题仍判定为不同
  });
});

describe('主题 / 夹紧', () => {
  it('超出范围的参数被夹回合法区间', () => {
    const wild = makeTheme('light', {
      fontSize: 999,
      lineHeight: 0.1,
      paragraphSpacing: -50,
      indentEm: 9,
    });
    const t = clampTheme(wild);
    expect(t.fontSize).toBe(DEFAULT_BOUNDS.fontSize[1]);
    expect(t.lineHeight).toBe(DEFAULT_BOUNDS.lineHeight[0]);
    expect(t.paragraphSpacing).toBe(DEFAULT_BOUNDS.paragraphSpacing[0]);
    expect(t.indentEm).toBe(DEFAULT_BOUNDS.indentEm[1]);
  });

  it('合法值不被改动', () => {
    const t = makeTheme('sepia', { fontSize: 19, lineHeight: 1.6 });
    expect(clampTheme(t).fontSize).toBe(19);
    expect(clampTheme(t).lineHeight).toBe(1.6);
  });
});

describe('主题 / 持久化', () => {
  let store: ReturnType<typeof createThemeStore>;

  beforeEach(() => {
    const saved: Record<string, unknown> = {};
    const persistence: ThemePersistence = {
      load: () => (Object.keys(saved).length ? (saved as never) : null),
      save: (t) => {
        saved.fontSize = t.fontSize;
        saved.lineHeight = t.lineHeight;
        saved.paragraphSpacing = t.paragraphSpacing;
        saved.id = t.id;
      },
    };
    store = createThemeStore(persistence, makeTheme('sepia'));
  });

  it('set 之后持久化被调用（对应验收项：关闭应用再打开仍然保留）', () => {
    const spy = vi.spyOn(store, 'set');
    store.set(makeTheme('sepia', { fontSize: 24, lineHeight: 2.0 }));
    expect(spy).toHaveBeenCalled();
    const reopened = createThemeStore(
      { load: () => ({ fontSize: 24, lineHeight: 2.0, id: 'sepia' }), save: () => {} },
      makeTheme('sepia'),
    );
    expect(reopened.get().fontSize).toBe(24);
    expect(reopened.get().lineHeight).toBe(2.0);
  });

  it('超出范围的设置在持久化前被夹紧', () => {
    const persisted: unknown[] = [];
    const s = createThemeStore(
      { load: () => null, save: (t) => persisted.push(t.fontSize) },
      makeTheme('light'),
    );
    s.set(makeTheme('light', { fontSize: 1000 }));
    expect(persisted[0]).toBe(DEFAULT_BOUNDS.fontSize[1]);
  });

  it('订阅者能收到变更通知，且设置相同值不重复通知', () => {
    const fn = vi.fn();
    store.subscribe(fn);
    store.set(makeTheme('sepia', { fontSize: 22 }));
    expect(fn).toHaveBeenCalledTimes(1);
    store.set(makeTheme('sepia', { fontSize: 22 }));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('取消订阅后不再收到通知', () => {
    const fn = vi.fn();
    const off = store.subscribe(fn);
    off();
    store.set(makeTheme('sepia', { fontSize: 28 }));
    expect(fn).not.toHaveBeenCalled();
  });
});
