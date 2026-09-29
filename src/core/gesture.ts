/**
 * 手势状态机 —— 需求 2.3 的唯一实现处。
 *
 * 这里是纯函数 reducer，不碰任何 DOM / 原生事件，
 * 所以三端（Web Pointer / Taro touch / RN PanResponder）只要把事件翻译成
 * PointerSample 就能复用完全一致的手势语义——这正是「同一套手势语义」的实现方式。
 *
 * 互斥规则落点：
 *   · 长按先于滑动？—— 移动超过容差即取消长按计时（needs 2.3 第 1 条）
 *   · 进入选区后不响应滑动 —— selection 态下 move 直接吞掉（第 2 条）
 *   · 翻页动画中长按无效 —— settling 态下一切输入丢弃（第 3 条）
 */

export type GesturePhase = 'idle' | 'pending' | 'dragging' | 'settling' | 'selection' | 'abandoned';

export type GestureInputType = 'down' | 'move' | 'up' | 'cancel' | 'tick' | 'settleEnd';

export interface PointerSample {
  x: number;
  y: number;
  /** 毫秒时间戳，单调递增 */
  t: number;
}

export interface GestureContext {
  /** 可点击区域宽度（用于左右 30% 判定） */
  zoneWidth: number;
  /** 翻页动画进行中 */
  isAnimating: boolean;
  /** 宿主是否已经处于系统选区模式（Web 上由原生选区事件驱动） */
  isSelecting?: boolean;
}

export interface GestureConfig {
  /** 小于该时长 + 未移动 → 判定为 tap */
  tapMaxMs: number;
  /** 超过该时长未移动 → 长按选区 */
  longPressMs: number;
  /** 判定为移动的容差，px */
  moveTolerancePx: number;
  /** 横向移动需超过纵向多少倍才认定为翻页拖拽 */
  horizontalBias: number;
  /** 左 / 右 tap 区占比 */
  leftZoneRatio: number;
  rightZoneRatio: number;
  /** 翻页所需的横向位移（页面宽度倍数） */
  fullDragRatio: number;
}

export const DEFAULT_GESTURE_CONFIG: GestureConfig = {
  tapMaxMs: 300,
  longPressMs: 450,
  moveTolerancePx: 10,
  horizontalBias: 1.1,
  leftZoneRatio: 0.3,
  rightZoneRatio: 0.3,
  fullDragRatio: 1.0,
};

export type TapZone = 'prev' | 'next' | 'settings';

export type ReaderIntent =
  | { type: 'none' }
  | { type: 'prevPage' }
  | { type: 'nextPage' }
  | { type: 'openSettings' }
  | { type: 'beginSelection' }
  | { type: 'exitSelection' }
  | { type: 'dragStart'; direction: 1 | -1; progress: number }
  | { type: 'dragMove'; direction: 1 | -1; progress: number }
  | { type: 'dragEnd'; direction: 1 | -1; progress: number; velocity: number; fling: boolean };

export interface GestureState {
  phase: GesturePhase;
  startX: number;
  startY: number;
  startT: number;
  lastX: number;
  lastY: number;
  lastT: number;
  /** 拖拽中的有符号进度：正=下一页，负=上一页 */
  progress: number;
  direction: 1 | -1;
}

export function initialGestureState(): GestureState {
  return {
    phase: 'idle',
    startX: 0,
    startY: 0,
    startT: 0,
    lastX: 0,
    lastY: 0,
    lastT: 0,
    progress: 0,
    direction: 1,
  };
}

const NONE: ReaderIntent = { type: 'none' };

export interface GestureMachine {
  state: GestureState;
  /** 长按计时到期时间戳；null 表示当前不需要计时 */
  longPressDeadline: number | null;
  send(input: { type: GestureInputType } & Partial<PointerSample>, ctx: GestureContext): ReaderIntent[];
  isSettled(): boolean;
}

export function createGestureMachine(config: GestureConfig = DEFAULT_GESTURE_CONFIG): GestureMachine {
  let state = initialGestureState();
  let deadline: number | null = null;
  /** 是否还按着手指（用于「settling 期间禁止一切输入」） */
  let pointerDown = false;

  const setPhase = (p: GesturePhase) => {
    state = { ...state, phase: p };
  };

  const machine: GestureMachine = {
    get state() {
      return state;
    },
    get longPressDeadline() {
      return deadline;
    },
    isSettled: () => state.phase === 'idle' || state.phase === 'selection',

    send(input, ctx) {
      const { type } = input;

      /* ---------------- 全局闸门：翻页动画优先 ---------------- */
      if (ctx.isAnimating || state.phase === 'settling') {
        if (type === 'settleEnd') {
          setPhase('idle');
          deadline = null;
          pointerDown = false;
          return [NONE];
        }
        // 动画中：长按、滑动、点击统统不响应
        return [NONE];
      }

      switch (type) {
        case 'down': {
          const x = input.x ?? 0;
          const y = input.y ?? 0;
          const t = input.t ?? 0;
          if (pointerDown) return [NONE]; // 忽略第二根手指
          pointerDown = true;
          // 已经在系统选区模式：本次按下只用于退出选区，不产生其它意图
          if (state.phase === 'selection' || ctx.isSelecting) {
            setPhase('selection');
            state = { ...state, startX: x, startY: y, startT: t, lastX: x, lastY: y, lastT: t };
            deadline = null;
            return [NONE];
          }
          setPhase('pending');
          state = {
            ...state,
            startX: x,
            startY: y,
            startT: t,
            lastX: x,
            lastY: y,
            lastT: t,
            progress: 0,
            direction: 1,
          };
          deadline = t + config.longPressMs;
          return [NONE];
        }

        case 'move': {
          if (!pointerDown) return [NONE];
          const x = input.x ?? state.lastX;
          const y = input.y ?? state.lastY;
          const t = input.t ?? state.lastT;
          state = { ...state, lastX: x, lastY: y, lastT: t };

          // 选区模式：滑动交给系统，不翻页
          if (state.phase === 'selection' || ctx.isSelecting) return [NONE];
          // 已放弃（纵向滑动 / 交给系统滚动）：不再产生任何意图
          if (state.phase === 'abandoned' || state.phase === 'idle') return [NONE];
          if (state.phase === 'settling') return [NONE];

          const dx = x - state.startX;
          const dy = y - state.startY;
          const dist = Math.hypot(dx, dy);

          if (state.phase === 'pending') {
            if (dist <= config.moveTolerancePx) return [NONE];
            // 一旦确认为移动，长按立刻作废
            deadline = null;
            if (Math.abs(dx) > Math.abs(dy) * config.horizontalBias) {
              const direction: 1 | -1 = dx < 0 ? 1 : -1;
              const progress = clampProgress((Math.abs(dx) / ctx.zoneWidth) * config.fullDragRatio);
              setPhase('dragging');
              state = { ...state, direction, progress };
              return [{ type: 'dragStart', direction, progress }];
            }
            // 纵向为主 → 交还给系统（滚动/原生选择），本层不处理
            setPhase('abandoned');
            return [NONE];
          }

          if (state.phase === 'dragging') {
            const direction: 1 | -1 = dx < 0 ? 1 : -1;
            const progress = clampProgress((Math.abs(dx) / ctx.zoneWidth) * config.fullDragRatio);
            state = { ...state, direction, progress };
            return [{ type: 'dragMove', direction, progress }];
          }
          return [NONE];
        }

        case 'tick': {
          // 长按计时到期
          if (state.phase !== 'pending' || deadline === null) return [NONE];
          const t = input.t ?? 0;
          if (t < deadline) return [NONE];
          deadline = null;
          setPhase('selection');
          return [{ type: 'beginSelection' }];
        }

        case 'up': {
          if (!pointerDown) return [NONE];
          pointerDown = false;
          const x = input.x ?? state.lastX;
          const y = input.y ?? state.lastY;
          const t = input.t ?? state.lastT;
          const dt = t - state.startT;
          const dist = Math.hypot(x - state.startX, y - state.startY);
          deadline = null;

          if (state.phase === 'selection' || ctx.isSelecting) {
            setPhase('idle');
            // 退出选区的那一次抬手不触发翻页，避免「选完字顺手翻页」
            return [{ type: 'exitSelection' }];
          }

          if (state.phase === 'dragging') {
            const velocity = velocityOf(state, x, t, config.moveTolerancePx);
            const fling = velocity > 0.55 && state.progress < 0.85;
            setPhase('settling');
            const intent: ReaderIntent = {
              type: 'dragEnd',
              direction: state.direction,
              progress: state.progress,
              velocity,
              fling,
            };
            state = { ...state, lastX: x, lastY: y, lastT: t };
            return [intent];
          }

          if (state.phase === 'pending') {
            if (dt <= config.tapMaxMs && dist <= config.moveTolerancePx) {
              setPhase('idle');
              return [tapIntent(x, ctx.zoneWidth, config)];
            }
            setPhase('idle');
            return [NONE];
          }

          setPhase('idle');
          return [NONE];
        }

        case 'cancel': {
          pointerDown = false;
          deadline = null;
          if (state.phase === 'dragging') {
            setPhase('settling');
            return [
              { type: 'dragEnd', direction: state.direction, progress: state.progress, velocity: 0, fling: false },
            ];
          }
          setPhase('idle');
          return [NONE];
        }

        case 'settleEnd': {
          setPhase('idle');
          deadline = null;
          pointerDown = false;
          return [NONE];
        }

        default:
          return [NONE];
      }
    },
  };

  return machine;
}

function clampProgress(v: number): number {
  return Math.max(-0.35, Math.min(1, v));
}

function velocityOf(state: GestureState, x: number, t: number, tolerance: number): number {
  const dt = Math.max(1, t - state.lastT);
  const dx = x - state.lastX;
  if (Math.abs(dx) < tolerance * 0.5) return 0;
  // 归一化到「整页宽度 / 秒」
  return Math.abs(dx) / dt; // px/ms
}

function tapIntent(x: number, zoneWidth: number, config: GestureConfig): ReaderIntent {
  const ratio = zoneWidth > 0 ? x / zoneWidth : 0.5;
  if (ratio < config.leftZoneRatio) return { type: 'prevPage' };
  if (ratio > 1 - config.rightZoneRatio) return { type: 'nextPage' };
  return { type: 'openSettings' };
}
