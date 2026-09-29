/**
 * 翻页几何 —— 真 3D 卷曲的数学核心，三端共用。
 *
 * ## 模型
 * 把翻页过程看成纸张的**横截面曲线**（x = 纸面宽度方向，z = 垂直纸面向观察者）：
 *
 *      e=0（未翻）          e≈0.5（卷曲中）        e=1（翻完）
 *   ●━━━━━━━━━━●          ╭────╮                 ●
 *   0          1        ╱       ╲               ╱ │
 *                          ↑ 站起、卷向左     ╱  │ (落到左侧 -1)
 *
 * 截面由**切线角场**积分而来，而不是用三次贝塞尔：
 *     ψ(u) = A(e) + B(e)·u^γ        （u = 材质坐标，0=书脊，1=自由边）
 *     pos(u) = ∫₀^u (cos ψ, sin ψ) ds
 *
 * 选这个参数化只有一个理由：**ψ 关于 u 单调不减**，即纸只能朝一个方向弯。
 * 这条不变量从数学上杜绝了自交、回折、打卷（曾经用贝塞尔控制柄摆位时就翻过车：
 * 控制点连线方向非单调，中间会出现反向曲率，纸面会出现错误的折痕）。
 *
 * A(e) 控制书脊处的抬起角（e=0 → 0 平铺向右；e=1 → π 平铺向左），
 * B(e) 是纸中段的额外弯曲量，两端归零 → 起手和落页都是「平」的真实纸张。
 *
 * ## 与渲染端的契约
 * 本文件只输出**数字**（位置 / 角度 / 光照）。
 * Web 端转 matrix3d，Taro 端转 wx canvas 变换矩阵，RN 端转 Skia 矩阵，
 * 同一个函数喂三端 → 「同一套翻页视觉」。
 */

export interface FlipShapeConfig {
  /** 书脊处最大抬起角（弧度），e=1 时必须等于 π 才能落到左侧平铺 */
  spineAngle: number;
  /**
   * 书脊角曲线的指数。A(e) = spineAngle·e^bias
   * 指数越大 → 书脊越晚才抬起（像捏着纸角翻，整张纸最后才落平）
   */
  spineBias: number;
  /** 纸中段最大弯曲量（弧度） */
  curlAngle: number;
  /** 弯曲分布锐度：越大越集中在自由边（像捏着纸角翻） */
  curlBias: number;
  /** 条带数量 */
  strips: number;
  /** 光源方向（x, z），已归一化 */
  light: { x: number; z: number };
  /** 环境光强度 0..1 */
  ambient: number;
  /** 弯曲高光强度 0..1 */
  gloss: number;
}

export const DEFAULT_FLIP_SHAPE: FlipShapeConfig = {
  spineAngle: Math.PI,
  spineBias: 3.0,
  curlAngle: 1.6,
  curlBias: 2.0,
  strips: 18,
  light: { x: -0.5, z: 0.87 },
  ambient: 0.2,
  gloss: 1.0,
};

export interface Strip {
  index: number;
  /** 材质坐标区间（0 = 书脊，1 = 自由边） */
  uFrom: number;
  uTo: number;
  /** 条带中心点在纸面局部坐标中的位置（x 向右，z 指向观察者），单位 = 页宽 */
  x: number;
  z: number;
  /** 截面切线角：0 = 指向 +x，π = 指向 -x */
  psi: number;
  /** 对应 CSS rotateY 的角度（= -psi） */
  cssRotateY: number;
  /** 0..1.25 光照强度 */
  shade: number;
  /** 该处是否朝向观察者（false = 看到纸背面） */
  frontFacing: boolean;
  /** 弯曲度（相邻切线夹角），用于折痕高光 */
  curvature: number;
  /**
   * 条带两端在截面上的精确位置（页宽单位）。
   * 渲染端按这条**弦**做刚体变换 + 横向缩放，
   * 相邻条带才能严丝合缝——否则弯曲处会漏缝，纸面也不会随弯曲压缩，
   * 看起来就像一叠旋转的切片而不是卷起来的纸。
   */
  head: { x: number; z: number };
  tail: { x: number; z: number };
  /** 横向压缩系数 = 弦长 / 材料宽度，≈ cos(ψ) */
  squash: number;
  /** 弦的倾角（弧度） */
  chordAngle: number;
  /** 条带左右端的亮度：用渐变在条带内过渡，消除条带间的色阶断层 */
  shadeLeft: number;
  shadeRight: number;
}

export interface FlipFrame {
  /** 翻页进度 0..1 */
  progress: number;
  strips: Strip[];
  /** 自由边在纸面局部坐标中的位置 */
  freeEdge: { x: number; z: number };
  /** 纸是否已越过垂直面（true = 该看背面了） */
  flipped: boolean;
}

/* ------------------------------------------------------------------ */
/* 截面模型：单调切线角场 + 数值积分                                     */
/* ------------------------------------------------------------------ */

interface Pt {
  x: number;
  z: number;
}

interface TangentField {
  A: number;
  B: number;
  gamma: number;
}

function fieldFor(e: number, cfg: FlipShapeConfig): TangentField {
  const t = Math.max(0, Math.min(1, e));
  return {
    // 书脊角：e=0 → 0（平铺向右）；e=1 → π（平铺向左）
    A: cfg.spineAngle * Math.pow(t, cfg.spineBias),
    // 弯曲量：两端归零 → 起手/落页都是平的真实纸张
    B: cfg.curlAngle * Math.pow(Math.sin(Math.PI * t), 0.85),
    gamma: cfg.curlBias,
  };
}

function psiAt(f: TangentField, u: number): number {
  return f.A + f.B * Math.pow(Math.max(0, u), f.gamma);
}

const SECTION_SAMPLES = 64;

function integrateSection(f: TangentField, samples = SECTION_SAMPLES): Pt[] {
  const pts: Pt[] = [{ x: 0, z: 0 }];
  let x = 0;
  let z = 0;
  for (let i = 1; i <= samples; i += 1) {
    const psi = psiAt(f, (i - 0.5) / samples);
    x += Math.cos(psi) / samples;
    z += Math.sin(psi) / samples;
    pts.push({ x, z });
  }
  return pts;
}

function lerpPt(pts: Pt[], u: number): Pt {
  const n = pts.length - 1;
  const idx = Math.max(0, Math.min(n - 1, Math.floor(u * n)));
  const t = Math.max(0, Math.min(1, u * n - idx));
  const a = pts[idx];
  const b = pts[idx + 1];
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
}

/** 计算某一进度下的翻页帧（页宽归一化为 1） */
export function computeFlipFrame(
  progress: number,
  config: Partial<FlipShapeConfig> = {},
): FlipFrame {
  const cfg = { ...DEFAULT_FLIP_SHAPE, ...config };
  const t = Math.max(0, Math.min(1, progress));
  const field = fieldFor(t, cfg);
  const section = integrateSection(field);

  const n = Math.max(2, Math.round(cfg.strips));
  const strips: Strip[] = [];
  const angles: number[] = [];

  for (let i = 0; i < n; i += 1) {
    const uFrom = i / n;
    const uTo = (i + 1) / n;
    const um = (uFrom + uTo) / 2;
    const pos = lerpPt(section, um);
    const psi = psiAt(field, um);
    angles.push(psi);

    // 条带两端取截面的精确点，用弦来定义这条带的刚体变换
    const head = lerpPt(section, uFrom);
    const tail = lerpPt(section, uTo);
    const dx = tail.x - head.x;
    const dz = tail.z - head.z;
    const chord = Math.hypot(dx, dz);
    const material = uTo - uFrom;
    const squash = material > 0 ? chord / material : 1;
    const chordAngle = Math.atan2(dz, dx);

    strips.push({
      index: i,
      uFrom,
      uTo,
      x: pos.x,
      z: pos.z,
      psi,
      cssRotateY: -psi,
      shade: 0,
      frontFacing: Math.cos(chordAngle) >= 0,
      curvature: 0,
      head,
      tail,
      squash: Math.max(0.02, Math.min(1, squash)),
      chordAngle,
      shadeLeft: 0,
      shadeRight: 0,
    });
  }

  // 曲率：相邻切线夹角，驱动折痕高光
  for (let i = 0; i < n; i += 1) {
    const a = angles[Math.max(0, i - 1)];
    const b = angles[Math.min(n - 1, i + 1)];
    strips[i].curvature = Math.abs(b - a);
  }

  // 光照：法线 n = (-sinψ, cosψ)
  // 在**条带边界**上采样亮度，条带内部再插值 —— 否则每条一个平色，
  // 卷曲上会出现阶梯状色带，看起来像渲染错误而不是纸的弯曲。
  const { light, ambient, gloss } = cfg;
  const shadeAt = (u: number, curvature: number, frontFacing: boolean): number => {
    const psi = psiAt(field, u);
    const nx = -Math.sin(psi);
    const nz = Math.cos(psi);
    const raw = nx * light.x + nz * light.z;
    const lambert = Math.max(0, raw);
    const facing = frontFacing ? 1 : 0.55;
    let shade = (ambient + (1 - ambient) * Math.pow(lambert, 0.75)) * facing;
    // 折痕处的镜面高光：曲率越大越亮，模拟纸面转折那一道反光
    const crease = Math.min(1, curvature * 6.5);
    shade += gloss * crease * crease * 0.45;
    // 背向光源的一侧再压一档，避免整片灰蒙蒙
    shade *= 1 - 0.25 * Math.max(0, -raw);
    return Math.max(0, Math.min(1.3, shade));
  };

  const edgeShades: number[] = [];
  for (let i = 0; i <= n; i += 1) {
    const u = i / n;
    const lo = Math.max(0, i - 1);
    const hi = Math.min(n - 1, i);
    const curv = Math.abs(angles[hi] - angles[lo]);
    edgeShades.push(shadeAt(u, curv, Math.cos(psiAt(field, u)) >= 0));
  }
  for (let i = 0; i < n; i += 1) {
    strips[i].shadeLeft = edgeShades[i];
    strips[i].shadeRight = edgeShades[i + 1];
    strips[i].shade = (strips[i].shadeLeft + strips[i].shadeRight) / 2;
  }

  return {
    progress: t,
    strips,
    freeEdge: section[SECTION_SAMPLES],
    flipped: Math.cos(psiAt(field, 1)) < 0,
  };
}

/** 采样截面上的一个点（页宽归一化），给阴影/高光投影用 */
export function sampleCrossSection(
  progress: number,
  u: number,
  config: Partial<FlipShapeConfig> = {},
): { x: number; z: number; psi: number } {
  const cfg = { ...DEFAULT_FLIP_SHAPE, ...config };
  const field = fieldFor(Math.max(0, Math.min(1, progress)), cfg);
  const section = integrateSection(field);
  const p = lerpPt(section, Math.max(0, Math.min(1, u)));
  return { x: p.x, z: p.z, psi: psiAt(field, Math.max(0, Math.min(1, u))) };
}

/* ------------------------------------------------------------------ */
/* 手指跟手：反查表                                                     */
/* ------------------------------------------------------------------ */

const INVERSE_STEPS = 128;
let inverseTable: Float64Array | null = null;
let inverseSignature = '';

function buildInverse(cfg: FlipShapeConfig): Float64Array {
  const table = new Float64Array(INVERSE_STEPS + 1);
  for (let i = 0; i <= INVERSE_STEPS; i += 1) {
    table[i] = integrateSection(fieldFor(i / INVERSE_STEPS, cfg), 32)[32].x;
  }
  return table;
}

/**
 * 手指横向位置（页宽单位，0=书脊 1=纸角）→ 翻页进度。
 * x_free(progress) 单调递减，所以可以二分反查 ——
 * 这样「自由边精确跟随手指」和「几何始终合法」两件事同时成立。
 */
export function progressForFingerOffset(
  offset: number,
  config: Partial<FlipShapeConfig> = {},
): number {
  const cfg = { ...DEFAULT_FLIP_SHAPE, ...config };
  const sig = `${cfg.spineAngle}|${cfg.spineBias}|${cfg.curlAngle}|${cfg.curlBias}`;
  if (!inverseTable || inverseSignature !== sig) {
    inverseTable = buildInverse(cfg);
    inverseSignature = sig;
  }
  const table = inverseTable;
  // table 单调递减：table[0] = 1（纸角在右），table[STEPS] = -1（纸角在左）
  const target = Math.min(table[0], Math.max(table[INVERSE_STEPS], offset));

  let lo = 0;
  let hi = INVERSE_STEPS;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (table[mid] >= target) lo = mid;
    else hi = mid - 1;
  }
  const x0 = table[lo];
  const x1 = table[Math.min(INVERSE_STEPS, lo + 1)];
  const frac = x1 === x0 ? 0 : (target - x0) / (x1 - x0);
  return Math.max(0, Math.min(1, (lo + frac) / INVERSE_STEPS));
}

/** 调试/测试用：某一进度下自由边的横向位置（页宽单位） */
export function freeEdgeX(progress: number, config: Partial<FlipShapeConfig> = {}): number {
  const cfg = { ...DEFAULT_FLIP_SHAPE, ...config };
  return integrateSection(fieldFor(Math.max(0, Math.min(1, progress)), cfg), 64)[64].x;
}

/** 调试/测试用：某一进度下自由边的高度（页宽单位） */
export function freeEdgeZ(progress: number, config: Partial<FlipShapeConfig> = {}): number {
  const cfg = { ...DEFAULT_FLIP_SHAPE, ...config };
  return integrateSection(fieldFor(Math.max(0, Math.min(1, progress)), cfg), 64)[64].z;
}
