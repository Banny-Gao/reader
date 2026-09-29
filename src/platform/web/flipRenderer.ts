/**
 * 真 3D 翻页渲染器（Web 端）。
 *
 * 做法：把纸页沿宽度切成 N 条竖条，每条是一个独立 3D 刚体，
 * 位置与角度直接来自 core/flip 的截面计算 —— 于是**条带之间自然形成曲面**，
 * 能看到纸卷起来的中间态，而不是一张贴图在 rotateY。
 *
 * 为什么要切片而不是整页一个 transform：
 *   整页 rotateY = 刚性旋转，纸面始终是平的 → 就是「伪 3D」；
 *   切片 + 逐条不同角度 = 真正的柱面弯曲 → 才有卷起感。
 *
 * 每条内部仍然是真实 DOM 文本（与静态书页同一套渲染函数），
 * 所以落页那一刻纸上的字和下面的字严丝合缝。
 */

import { computeFlipFrame, DEFAULT_FLIP_SHAPE, type FlipShapeConfig, type Strip } from '../../core';
import { renderPage } from './domRenderer';
import type { PageGeometry } from './domRenderer';
import type { PageLayout } from '../../core';

/** 条带整体抬一点，避免与下方书页共面导致 z-fighting */
const Z_LIFT = 0.5;

export interface FlipRendererOptions {
  layer: HTMLElement;
  geometry: PageGeometry;
  strips?: number;
  shape?: Partial<FlipShapeConfig>;
}

export class FlipRenderer {
  private layer: HTMLElement;
  private geometry: PageGeometry;
  private cfg: Partial<FlipShapeConfig>;
  private stripEls: HTMLElement[] = [];
  private frontPages: HTMLElement[] = [];
  private backPages: HTMLElement[] = [];
  private active = false;
  private lastProgress = 0;
  /** 背面内容懒建：翻过去之前根本看不见 */
  private backsBuilt = false;
  /** 上一次写入的亮度，用于跳过无意义���样式写入 */
  private lastShade: Array<[number, number]> = [];

  constructor(opts: FlipRendererOptions) {
    this.layer = opts.layer;
    this.geometry = opts.geometry;
    this.cfg = { strips: opts.strips ?? DEFAULT_FLIP_SHAPE.strips, ...opts.shape };
  }

  /** 覆盖卷曲形状（视觉调参 / 主题化用） */
  setShape(shape?: Record<string, number>): void {
    this.cfg = { ...this.cfg, ...(shape ?? {}) };
  }

  /** 视口变化时更新页宽（条带位置是按页宽归一化的，必须同步） */
  setGeometry(geometry: PageGeometry): void {
    this.geometry = geometry;
  }

  isActive(): boolean {
    return this.active;
  }

  get progress(): number {
    return this.lastProgress;
  }

  /**
   * 开始一次翻页。
   * @param from 当前显示的页（纸的正面）
   * @param to   目标页（纸的背面，同时也是落页后下层显示的页）
   */
  begin(from: PageLayout, to: PageLayout): void {
    this.destroy();
    this.active = true;
    this.backsBuilt = false;
    const n = Math.max(2, Math.round(this.cfg.strips ?? 18));
    const frag = document.createDocumentFragment();

    for (let i = 0; i < n; i += 1) {
      const strip = document.createElement('div');
      strip.className = 'strip';
      strip.dataset.index = String(i);

      const front = document.createElement('div');
      front.className = 'face front page';
      renderPage(from, this.geometry, front);

      const back = document.createElement('div');
      back.className = 'face back page';
      renderPage(to, this.geometry, back);
      back.style.visibility = 'hidden';

      const tint = document.createElement('div');
      tint.className = 'tint';

      const gloss = document.createElement('div');
      gloss.className = 'gloss';

      // clip-path 只跟条带材质区间有关，与翻页进度无关 —— 摆一次就够，
      // 每帧重写会让浏览器每帧重算裁剪区域
      const W = this.geometry.width;
      const bandLeft = (i / n) * W;
      const bandRight = ((i + 1) / n) * W;
      strip.style.clipPath =
        `inset(0 ${Math.max(0, W - bandRight - 0.3).toFixed(2)}px ` +
        `0 ${Math.max(0, bandLeft - 0.3).toFixed(2)}px)`;

      strip.append(front, back, tint, gloss);
      frag.appendChild(strip);

      this.stripEls.push(strip);
      this.frontPages.push(front);
      this.backPages.push(back);
    }

    this.lastShade = new Array(n);
    this.layer.appendChild(frag);
  }

  /** 更新翻页进度 0..1 */
  update(progress: number): void {
    if (!this.active) return;
    this.lastProgress = progress;
    const frame = computeFlipFrame(progress, this.cfg);
    const W = this.geometry.width;

    // 背面在纸转过 90° 之前不可见，延后构建省一半 DOM
    if (!this.backsBuilt && progress > 0.18) {
      this.backsBuilt = true;
      for (const b of this.backPages) b.style.visibility = 'visible';
    }

    for (let i = 0; i < this.stripEls.length; i += 1) {
      const s: Strip = frame.strips[i];
      if (!s) continue;
      const el = this.stripEls[i];

      // 条带 = 截面上一段「弦」：起点落在 head，方向沿弦，按弦长/材料宽 横向压缩。
      // 这样相邻条带首尾精确衔接（不漏缝），纸面文字也会随弯曲真实压缩。
      const hx = s.head.x * W;
      const hz = s.head.z * W + Z_LIFT;
      const matLeft = s.uFrom * W;

      el.style.transform =
        `translate3d(${hx.toFixed(2)}px, 0, ${hz.toFixed(2)}px) ` +
        `rotateY(${(-s.chordAngle).toFixed(5)}rad) ` +
        `scaleX(${s.squash.toFixed(5)}) ` +
        `translate3d(${(-matLeft).toFixed(2)}px, 0, 0)`;

      // 光影：条带内用左右端亮度做渐变，卷曲上不会出现阶梯色带。
      // 乘完再夹紧：rgba 的 alpha 一旦 >1 会被浏览器夹成 1，条带直接变纯黑。
      // 变化小于阈值就不写样式 —— 拖拽时大多数帧的亮度差是微小的。
      const prev = this.lastShade[i];
      if (!prev || Math.abs(prev[0] - s.shadeLeft) > 0.012 || Math.abs(prev[1] - s.shadeRight) > 0.012) {
        this.lastShade[i] = [s.shadeLeft, s.shadeRight];
        const a0 = Math.max(0, Math.min(1, (1 - s.shadeLeft) * 1.05));
        const a1 = Math.max(0, Math.min(1, (1 - s.shadeRight) * 1.05));
        el.style.setProperty(
          '--tint',
          `linear-gradient(to right, rgba(24,20,14,${a0.toFixed(3)}), rgba(24,20,14,${a1.toFixed(3)}))`,
        );
        const g0 = Math.max(0, Math.min(1, (s.shadeLeft - 1) * 1.25));
        const g1 = Math.max(0, Math.min(1, (s.shadeRight - 1) * 1.25));
        el.style.setProperty('--gloss-alpha', Math.max(g0, g1).toFixed(3));
        el.style.setProperty(
          '--gloss',
          `linear-gradient(to right, rgba(255,255,255,${g0.toFixed(3)}), rgba(255,255,255,${g1.toFixed(3)}))`,
        );
      }
    }
  }

  /** 纸抬起时投在下层书页上的阴影位置（0..1，相对页宽） */
  shadowSpan(): { peak: number; tail: number; strength: number } {
    if (!this.active) return { peak: 0.5, tail: 1, strength: 0 };
    const frame = computeFlipFrame(this.lastProgress, this.cfg);
    const fx = frame.freeEdge.x; // 页宽单位
    const peak = Math.max(0, Math.min(1, fx));
    const fz = frame.freeEdge.z;
    return {
      peak,
      tail: Math.max(peak, Math.min(1, peak + 0.35 + fz * 0.4)),
      strength: Math.min(0.85, 0.18 + fz * 1.6),
    };
  }

  destroy(): void {
    this.layer.replaceChildren();
    this.stripEls = [];
    this.lastShade = [];
    this.frontPages = [];
    this.backPages = [];
    this.active = false;
    this.lastProgress = 0;
  }
}
