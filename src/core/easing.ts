/** 缓动函数集合 —— 翻页动画与手势惯性共用，保证三端手感一致。 */

export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

export const easeInCubic = (t: number): number => t * t * t;

export const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

export const easeOutQuint = (t: number): number => 1 - Math.pow(1 - t, 5);

export const linear = (t: number): number => t;

/**
 * 翻页吸附：拖拽释放后根据剩余距离与甩动速度决定时长。
 * 距离越短越快（最短 120ms），全页翻完最长 420ms —— 手感接近原生阅读器。
 */
export function snapDuration(
  remaining: number,
  velocity: number,
  opts: { min?: number; max?: number; velocityBoost?: number } = {},
): number {
  const { min = 120, max = 420, velocityBoost = 90 } = opts;
  const base = 120 + remaining * 300;
  const flingCut = Math.min(base - min, Math.abs(velocity) * velocityBoost);
  return Math.max(min, Math.min(max, base - flingCut));
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
