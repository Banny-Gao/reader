import { describe, expect, it } from 'vitest';
import {
  createGestureMachine,
  DEFAULT_GESTURE_CONFIG,
  type GestureContext,
  type ReaderIntent,
} from '../src/core/gesture';

const W = 1000;
const ctx = (over: Partial<GestureContext> = {}): GestureContext => ({
  zoneWidth: W,
  isAnimating: false,
  ...over,
});

const types = (intents: ReaderIntent[]) => intents.map((i) => i.type);

describe('手势状态机 / tap 分区', () => {
  it('左侧 30% → 上一页', () => {
    const m = createGestureMachine();
    m.send({ type: 'down', x: 100, y: 500, t: 0 }, ctx());
    expect(types(m.send({ type: 'up', x: 105, y: 502, t: 120 }, ctx()))).toContain('prevPage');
  });

  it('右侧 30% → 下一页', () => {
    const m = createGestureMachine();
    m.send({ type: 'down', x: 900, y: 500, t: 0 }, ctx());
    expect(types(m.send({ type: 'up', x: 902, y: 501, t: 100 }, ctx()))).toContain('nextPage');
  });

  it('中间 40% → 弹出设置面板', () => {
    const m = createGestureMachine();
    m.send({ type: 'down', x: 500, y: 500, t: 0 }, ctx());
    expect(types(m.send({ type: 'up', x: 502, y: 500, t: 100 }, ctx()))).toContain('openSettings');
  });

  it('分区边界：29.9% 上一页，30.1% 中间，69.9% 中间，70.1% 下一页', () => {
    const probe = (x: number) => {
      const m = createGestureMachine();
      m.send({ type: 'down', x, y: 500, t: 0 }, ctx());
      return types(m.send({ type: 'up', x, y: 500, t: 80 }, ctx()));
    };
    expect(probe(299)).toContain('prevPage');
    expect(probe(301)).toContain('openSettings');
    expect(probe(699)).toContain('openSettings');
    expect(probe(701)).toContain('nextPage');
  });

  it('按住超过 tapMaxMs 不再算点击', () => {
    const m = createGestureMachine();
    m.send({ type: 'down', x: 500, y: 500, t: 0 }, ctx());
    const out = m.send({ type: 'up', x: 500, y: 500, t: 900 }, ctx());
    expect(types(out)).not.toContain('openSettings');
  });
});

describe('手势状态机 / 长按选区', () => {
  it('长按满时长且未移动 → 唤起选区', () => {
    const m = createGestureMachine();
    m.send({ type: 'down', x: 500, y: 500, t: 0 }, ctx());
    expect(m.longPressDeadline).toBe(DEFAULT_GESTURE_CONFIG.longPressMs);
    const out = m.send({ type: 'tick', t: DEFAULT_GESTURE_CONFIG.longPressMs }, ctx());
    expect(types(out)).toContain('beginSelection');
    expect(m.state.phase).toBe('selection');
  });

  it('进入选区后，横向滑动不再翻页（需求 2.3 互斥规则第 1 条）', () => {
    const m = createGestureMachine();
    m.send({ type: 'down', x: 600, y: 500, t: 0 }, ctx());
    m.send({ type: 'tick', t: 500 }, ctx());

    const out = m.send({ type: 'move', x: 200, y: 505, t: 600 }, ctx({ isSelecting: true }));
    expect(types(out)).toEqual(['none']);
    expect(m.state.phase).toBe('selection');
  });

  it('移动超过容差会立刻取消长按计时', () => {
    const m = createGestureMachine();
    m.send({ type: 'down', x: 600, y: 500, t: 0 }, ctx());
    m.send({ type: 'move', x: 580, y: 502, t: 60 }, ctx());
    expect(m.longPressDeadline).toBeNull();
    // 之后再 tick 也不该触发选区
    expect(types(m.send({ type: 'tick', t: 900 }, ctx()))).toEqual(['none']);
  });

  it('释放手指退出选区后，滑动翻页重新可用（需求 2.3 互斥规则第 2 条）', () => {
    const m = createGestureMachine();
    m.send({ type: 'down', x: 600, y: 500, t: 0 }, ctx());
    m.send({ type: 'tick', t: 500 }, ctx());
    m.send({ type: 'up', x: 600, y: 500, t: 560 }, ctx({ isSelecting: true }));
    expect(m.state.phase).toBe('idle');

    // 下一次手势：拖拽翻页必须恢复
    m.send({ type: 'down', x: 800, y: 500, t: 700 }, ctx());
    const out = m.send({ type: 'move', x: 500, y: 505, t: 760 }, ctx());
    expect(types(out)).toContain('dragStart');
  });

  it('退出选区的那次抬手不触发翻页，避免选完字顺手翻页', () => {
    const m = createGestureMachine();
    m.send({ type: 'down', x: 500, y: 500, t: 0 }, ctx());
    m.send({ type: 'tick', t: 500 }, ctx());
    const out = m.send({ type: 'up', x: 500, y: 500, t: 540 }, ctx({ isSelecting: true }));
    expect(types(out)).toEqual(['exitSelection']);
  });
});

describe('手势状态机 / 拖拽翻页', () => {
  it('向左拖 → 下一页，向右拖 → 上一页', () => {
    const left = createGestureMachine();
    left.send({ type: 'down', x: 800, y: 400, t: 0 }, ctx());
    const l = left.send({ type: 'move', x: 500, y: 405, t: 50 }, ctx());
    expect(l[0]).toMatchObject({ type: 'dragStart', direction: 1 });

    const right = createGestureMachine();
    right.send({ type: 'down', x: 200, y: 400, t: 0 }, ctx());
    const r = right.send({ type: 'move', x: 500, y: 405, t: 50 }, ctx());
    expect(r[0]).toMatchObject({ type: 'dragStart', direction: -1 });
  });

  it('进度跟手：位移/页宽 = 进度', () => {
    const m = createGestureMachine();
    m.send({ type: 'down', x: 1000, y: 400, t: 0 }, ctx());
    const out = m.send({ type: 'move', x: 500, y: 400, t: 50 }, ctx());
    expect((out[0] as { progress: number }).progress).toBeCloseTo(0.5, 2);
  });

  it('拖拽中途反向，方向会跟着变（可以往回拖）', () => {
    const m = createGestureMachine();
    m.send({ type: 'down', x: 800, y: 400, t: 0 }, ctx());
    m.send({ type: 'move', x: 400, y: 400, t: 50 }, ctx());
    // 手指拖回起点右侧 → 方向翻转为「上一页」
    const back = m.send({ type: 'move', x: 900, y: 400, t: 90 }, ctx());
    expect(back[0]).toMatchObject({ type: 'dragMove', direction: -1 });
  });

  it('拖拽中途小幅回弹但没越过起点时，方向保持不变', () => {
    const m = createGestureMachine();
    m.send({ type: 'down', x: 800, y: 400, t: 0 }, ctx());
    m.send({ type: 'move', x: 400, y: 400, t: 50 }, ctx());
    const back = m.send({ type: 'move', x: 700, y: 400, t: 90 }, ctx());
    expect(back[0]).toMatchObject({ type: 'dragMove', direction: 1 });
    expect((back[0] as { progress: number }).progress).toBeCloseTo(0.1, 2);
  });

  it('甩动（快速小幅位移）标记 fling=true', () => {
    const m = createGestureMachine();
    m.send({ type: 'down', x: 800, y: 400, t: 0 }, ctx());
    m.send({ type: 'move', x: 600, y: 400, t: 40 }, ctx());
    const out = m.send({ type: 'up', x: 420, y: 400, t: 56 }, ctx());
    const intent = out[0] as { type: string; fling: boolean };
    expect(intent.type).toBe('dragEnd');
    expect(intent.fling).toBe(true);
  });

  it('慢速小幅拖拽不算甩动', () => {
    const m = createGestureMachine();
    m.send({ type: 'down', x: 800, y: 400, t: 0 }, ctx());
    m.send({ type: 'move', x: 700, y: 400, t: 200 }, ctx());
    const out = m.send({ type: 'up', x: 660, y: 400, t: 600 }, ctx());
    expect((out[0] as { fling: boolean }).fling).toBe(false);
  });

  it('纵向滑动交还给系统，不产生任何意图', () => {
    const m = createGestureMachine();
    m.send({ type: 'down', x: 500, y: 700, t: 0 }, ctx());
    const out = m.send({ type: 'move', x: 505, y: 300, t: 60 }, ctx());
    expect(types(out)).toEqual(['none']);
    expect(m.state.phase).toBe('abandoned');
  });
});

describe('手势状态机 / 翻页动画优先', () => {
  it('动画进行中，长按不触发选区', () => {
    const m = createGestureMachine();
    const anim = ctx({ isAnimating: true });
    m.send({ type: 'down', x: 500, y: 500, t: 0 }, anim);
    expect(types(m.send({ type: 'tick', t: 600 }, anim))).toEqual(['none']);
    expect(m.state.phase).toBe('idle');
  });

  it('动画进行中，滑动与点击全部忽略', () => {
    const m = createGestureMachine();
    const anim = ctx({ isAnimating: true });
    m.send({ type: 'down', x: 800, y: 400, t: 0 }, anim);
    expect(types(m.send({ type: 'move', x: 200, y: 400, t: 50 }, anim))).toEqual(['none']);
    expect(types(m.send({ type: 'up', x: 200, y: 400, t: 90 }, anim))).toEqual(['none']);
  });

  it('settleEnd 后恢复响应', () => {
    const m = createGestureMachine();
    m.send({ type: 'down', x: 800, y: 400, t: 0 }, ctx());
    m.send({ type: 'move', x: 500, y: 400, t: 40 }, ctx());
    m.send({ type: 'up', x: 500, y: 400, t: 90 }, ctx());
    expect(m.state.phase).toBe('settling');
    expect(m.isSettled()).toBe(false);

    m.send({ type: 'settleEnd' }, ctx());
    expect(m.state.phase).toBe('idle');

    m.send({ type: 'down', x: 900, y: 400, t: 200 }, ctx());
    expect(types(m.send({ type: 'up', x: 900, y: 400, t: 260 }, ctx()))).toContain('nextPage');
  });

  it('多指同时按下时忽略第二根手指', () => {
    const m = createGestureMachine();
    m.send({ type: 'down', x: 500, y: 500, t: 0 }, ctx());
    const out = m.send({ type: 'down', x: 100, y: 500, t: 10 }, ctx());
    expect(types(out)).toEqual(['none']);
  });
});
