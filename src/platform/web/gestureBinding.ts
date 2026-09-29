/**
 * 手势绑定：把浏览器事件翻译成 core 手势状态机的输入。
 *
 * 这一层**只做翻译，不做决策**。所有互斥规则都在 core/gesture 里，
 * 所以 Taro / RN 只要写同样薄的一层，就能拿到完全一致的手势语义。
 *
 * 与原生选区的配合（这是最容易打架的地方）：
 *   · 容器用 `touch-action: pan-y` —— 保留浏览器原生长按选词
 *   · 只有当状态机确认「这是横向翻页拖拽」时，才在 touchmove 里 preventDefault 抢回控制权
 *   · 一旦进入选区态，move 全部交给系统，翻页不再响应
 */

import type { GestureMachine, ReaderIntent } from '../../core/gesture';

export interface GestureHost {
  onIntent(intent: ReaderIntent): void;
  isAnimating(): boolean;
  isSelecting(): boolean;
}

export interface Binding {
  destroy(): void;
}

export function bindGestures(
  target: HTMLElement,
  machine: GestureMachine,
  host: GestureHost,
): Binding {
  let longPressTimer: number | null = null;
  let longPressRetries = 0;
  let pointerActive = false;
  const now = () => performance.now();

  const clearLongPress = () => {
    if (longPressTimer !== null) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    longPressRetries = 0;
  };

  /**
   * 长按到期检查。
   *
   * 这里必须能「重排」：浏览器的 setTimeout 受时间粒度影响，可能比预期早零点几毫秒触发。
   * 早期版本只判断一次「到没到期」，没到期就丢弃 —— 于是长按会**静默失效**
   * （表现是偶尔长按没反应），而且再也等不到第二次。
   */
  const fireLongPress = () => {
    longPressTimer = null;
    const t = now();
    machine.send({ type: 'tick', t }, context()).forEach((i) => host.onIntent(i));

    const deadline = machine.longPressDeadline;
    if (deadline !== null && machine.state.phase === 'pending' && t < deadline) {
      if (longPressRetries < 8) {
        longPressRetries += 1;
        longPressTimer = window.setTimeout(fireLongPress, Math.max(1, deadline - t));
      }
    } else {
      longPressRetries = 0;
    }
  };

  const scheduleLongPress = () => {
    clearLongPress();
    const deadline = machine.longPressDeadline;
    if (deadline === null) return;
    longPressTimer = window.setTimeout(fireLongPress, Math.max(0, deadline - now()));
  };

  const context = () => ({
    zoneWidth: target.clientWidth || 1,
    isAnimating: host.isAnimating(),
    isSelecting: host.isSelecting(),
  });

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    pointerActive = true;
    const intents = machine.send({ type: 'down', x: e.clientX, y: e.clientY, t: now() }, context());
    intents.forEach((i) => host.onIntent(i));
    if (machine.state.phase === 'pending') scheduleLongPress();
  };

  const onMove = (e: PointerEvent) => {
    if (!pointerActive) return;
    const intents = machine.send({ type: 'move', x: e.clientX, y: e.clientY, t: now() }, context());
    if (intents.some((i) => i.type.startsWith('drag'))) {
      // 确认是横向翻页：抢回控制权，同时关掉这一下的原生选区
      target.classList.add('is-dragging');
      e.preventDefault();
    }
    intents.forEach((i) => host.onIntent(i));
  };

  const onUp = (e: PointerEvent) => {
    if (!pointerActive) return;
    pointerActive = false;
    clearLongPress();
    target.classList.remove('is-dragging');
    const intents = machine.send({ type: 'up', x: e.clientX, y: e.clientY, t: now() }, context());
    intents.forEach((i) => host.onIntent(i));
  };

  const onCancel = () => {
    if (!pointerActive) return;
    pointerActive = false;
    clearLongPress();
    target.classList.remove('is-dragging');
    machine.send({ type: 'cancel', t: now() }, context()).forEach((i) => host.onIntent(i));
  };

  // 纵向 touchmove 要阻止默认行为，否则会和翻页手势打架
  const onTouchMove = (e: TouchEvent) => {
    if (machine.state.phase === 'dragging') e.preventDefault();
  };

  const onSelectionChange = () => {
    // 选区变化由 selectionchange 事件驱动，state 读 host.isSelecting()
  };

  target.addEventListener('pointerdown', onDown, { passive: true });
  window.addEventListener('pointermove', onMove, { passive: false });
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  target.addEventListener('touchmove', onTouchMove, { passive: false });
  document.addEventListener('selectionchange', onSelectionChange);

  return {
    destroy() {
      clearLongPress();
      target.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      target.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('selectionchange', onSelectionChange);
    },
  };
}

/** 选区是否落在阅读区域内（由宿主维护这个状态） */
export function hasSelectionInside(root: HTMLElement): boolean {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed) return false;
  const text = sel.toString().trim();
  if (!text) return false;
  const node = sel.anchorNode;
  if (!node) return false;
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement);
  return !!el && root.contains(el);
}
