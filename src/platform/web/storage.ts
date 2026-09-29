/**
 * Web 端持久化适配器。
 *
 * core 只定义 ThemePersistence 接口，具体存储由各端注入：
 *   Web  → localStorage（这里）
 *   Taro → Taro.setStorageSync
 *   RN   → AsyncStorage
 * 三端换存储不影响主题逻辑。
 */

import type { ReadingTheme, ThemePersistence } from '../../core';

const KEY = 'reader.theme.v1';
const PAGE_KEY = 'reader.page.v1';

interface PersistedTheme {
  id?: string;
  fontSize?: number;
  lineHeight?: number;
  paragraphSpacing?: number;
  indentEm?: number;
  padding?: ReadingTheme['padding'];
}

export function safeStorage(): Storage | null {
  try {
    const s = window.localStorage;
    const probe = '__probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null; // 隐私模式 / 无痕
  }
}

export function createWebThemePersistence(): ThemePersistence | null {
  const store = safeStorage();
  if (!store) return null;
  return {
    load() {
      try {
        const raw = store.getItem(KEY);
        return raw ? (JSON.parse(raw) as PersistedTheme) : null;
      } catch {
        return null;
      }
    },
    save(theme) {
      try {
        const payload: PersistedTheme = {
          id: theme.id,
          fontSize: theme.fontSize,
          lineHeight: theme.lineHeight,
          paragraphSpacing: theme.paragraphSpacing,
          indentEm: theme.indentEm,
          padding: theme.padding,
        };
        store.setItem(KEY, JSON.stringify(payload));
      } catch {
        /* 存不下就算了，不影响阅读 */
      }
    },
  };
}

export function saveReadingProgress(index: number, total: number): void {
  const store = safeStorage();
  if (!store) return;
  try {
    store.setItem(PAGE_KEY, JSON.stringify({ index, total, at: Date.now() }));
  } catch {
    /* ignore */
  }
}

export function loadReadingProgress(): number {
  const store = safeStorage();
  if (!store) return 0;
  try {
    const raw = store.getItem(PAGE_KEY);
    if (!raw) return 0;
    return JSON.parse(raw).index ?? 0;
  } catch {
    return 0;
  }
}
