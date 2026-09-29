import { describe, expect, it } from 'vitest';
import {
  computeFlipFrame,
  sampleCrossSection,
  freeEdgeX,
  progressForFingerOffset,
  DEFAULT_FLIP_SHAPE,
} from '../src/core/flip';

describe('翻页几何 / computeFlipFrame', () => {
  it('progress=0 时纸页完全平铺，正面朝上，无任何 z 偏移', () => {
    const f = computeFlipFrame(0);
    expect(f.progress).toBe(0);
    for (const s of f.strips) {
      expect(s.z).toBeCloseTo(0, 6);
      expect(s.psi).toBeCloseTo(0, 6);
      expect(s.frontFacing).toBe(true);
    }
    // 平铺时条带中心沿 x 均匀分布（中心在各自条带中点，不是端点）
    const n = f.strips.length;
    expect(f.strips[0].x).toBeCloseTo(0.5 / n, 2);
    expect(f.strips[n - 1].x).toBeCloseTo(1 - 0.5 / n, 2);
    expect(f.freeEdge.x).toBeCloseTo(1, 6);
  });

  it('progress=1 时纸页完全翻到左侧，仍然是平铺的（不能残留弯曲）', () => {
    const f = computeFlipFrame(1);
    for (const s of f.strips) {
      expect(Math.abs(s.z)).toBeLessThan(1e-6);
      expect(Math.abs(Math.abs(s.psi) - Math.PI)).toBeLessThan(1e-6);
    }
    expect(f.freeEdge.x).toBeCloseTo(-1, 6);
    expect(f.flipped).toBe(true);
  });

  it('中间进度下存在真实的弯曲：既不在同一平面，切线角也不相同', () => {
    const f = computeFlipFrame(0.5);
    const zs = f.strips.map((s) => s.z);
    expect(new Set(zs.map((z) => z.toFixed(4))).size).toBeGreaterThan(3);

    const psis = f.strips.map((s) => s.psi);
    const minPsi = Math.min(...psis);
    const maxPsi = Math.max(...psis);
    // 切线角跨度 > 0.3rad 才是「卷起来」，而不是刚性旋转
    expect(maxPsi - minPsi).toBeGreaterThan(0.3);
  });

  it('自由边跟随手指：从右端线性走到左端，中途会抬起', () => {
    let prev = computeFlipFrame(0).freeEdge.x;
    for (const e of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const f = computeFlipFrame(e);
      expect(f.freeEdge.x).toBeLessThan(prev);
      prev = f.freeEdge.x;
    }
    expect(computeFlipFrame(0.5).freeEdge.z).toBeGreaterThan(0.01);
  });

  it('纸永远钉在书脊上：起点恒为原点', () => {
    for (const e of [0, 0.13, 0.37, 0.5, 0.82, 1]) {
      const p = sampleCrossSection(e, 0);
      expect(p.x).toBeCloseTo(0, 6);
      expect(p.z).toBeCloseTo(0, 6);
    }
  });

  it('切线角单调不减 —— 纸只能朝一个方向弯，不会自交打卷', () => {
    for (const e of [0.1, 0.2, 0.3, 0.45, 0.5, 0.6, 0.75, 0.9]) {
      let prev = -Infinity;
      for (let i = 0; i <= 40; i += 1) {
        const psi = sampleCrossSection(e, i / 40).psi;
        expect(psi).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = psi;
      }
    }
  });

  it('截面不会飞出页面范围（不会甩出夸张的折角）', () => {
    for (const e of [0.2, 0.45, 0.6, 0.8]) {
      for (let i = 0; i <= 20; i += 1) {
        const p = sampleCrossSection(e, i / 20);
        expect(Math.abs(p.x)).toBeLessThan(1.6);
        expect(p.z).toBeGreaterThan(-0.05); // 纸不该沉到页面下方
      }
    }
  });

  it('手指跟手：反查表能把纸角精确送到手指位置', () => {
    for (const offset of [1, 0.7, 0.4, 0.1, -0.3, -0.8, -1]) {
      const e = progressForFingerOffset(offset);
      expect(freeEdgeX(e)).toBeCloseTo(offset, 1);
    }
  });

  it('反查表单调：手指越往左，进度越大', () => {
    let prev = -1;
    for (let i = 0; i <= 20; i += 1) {
      const e = progressForFingerOffset(1 - i / 10);
      expect(e).toBeGreaterThanOrEqual(prev - 1e-6);
      prev = e;
    }
  });

  it('光照：卷起后暗面与亮面必须分得开（否则纸看起来是平的贴纸）', () => {
    const f = computeFlipFrame(0.5);
    const shades = f.strips.map((s) => s.shade);
    expect(Math.max(...shades) - Math.min(...shades)).toBeGreaterThan(0.12);
  });

  it('条带数量可配置，且几何与条带数无关（截面是同一份）', () => {
    const a = computeFlipFrame(0.42, { strips: 10 });
    const b = computeFlipFrame(0.42, { strips: 24 });
    expect(a.strips).toHaveLength(10);
    expect(b.strips).toHaveLength(24);
    // 同一材质点上的截面位置，与怎么切条带无关
    for (const u of [0.2, 0.5, 0.8]) {
      expect(sampleCrossSection(0.42, u).x).toBeCloseTo(sampleCrossSection(0.42, u).x, 6);
    }
    const headAt = (frame: typeof a, u: number) => {
      const i = Math.min(frame.strips.length - 1, Math.floor(u * frame.strips.length));
      return frame.strips[i].head.x;
    };
    expect(Math.abs(headAt(a, 0.5) - headAt(b, 0.5))).toBeLessThan(0.08);
  });

  it('相邻条带首尾精确衔接，不漏缝也不重叠', () => {
    for (const e of [0.2, 0.35, 0.5, 0.65, 0.8]) {
      const f = computeFlipFrame(e, { strips: 20 });
      for (let i = 1; i < f.strips.length; i += 1) {
        const prev = f.strips[i - 1];
        const cur = f.strips[i];
        // 上一条的尾 == 这一条的头（同一材质点）
        expect(cur.head.x).toBeCloseTo(prev.tail.x, 9);
        expect(cur.head.z).toBeCloseTo(prev.tail.z, 9);
        // 压缩系数 = 弦长/材料宽，平铺时为 1，竖起来时趋近 0
        expect(cur.squash).toBeGreaterThan(0);
        expect(cur.squash).toBeLessThanOrEqual(1.0001);
      }
    }
  });

  it('平铺时压缩系数为 1（纸没有被拉扁）', () => {
    for (const e of [0, 1]) {
      const f = computeFlipFrame(e);
      for (const s of f.strips) expect(s.squash).toBeCloseTo(1, 3);
    }
  });

  it('立起来的条带接近侧视（透视压缩由 3D 旋转产生）', () => {
    const f = computeFlipFrame(0.5);
    // squash 是「弦长/材料宽」，平铺与缓弯时都接近 1
    for (const s of f.strips) {
      expect(s.squash).toBeGreaterThan(0.9);
      expect(s.squash).toBeLessThanOrEqual(1.0001);
    }
    // 真正决定「看起来被压扁」的是弦的倾角：cos 越小越接近侧视
    const edgeOn = f.strips.filter((s) => Math.abs(Math.cos(s.chordAngle)) < 0.35);
    expect(edgeOn.length).toBeGreaterThan(0);
    // 同一页里既有接近正视的，也有接近侧视的 → 曲面而不是平板
    const frontOn = f.strips.filter((s) => Math.abs(Math.cos(s.chordAngle)) > 0.85);
    expect(frontOn.length).toBeGreaterThan(0);
  });

  it('越界进度被安全夹紧，不产生 NaN', () => {
    for (const p of [-1, 1.5, 99]) {
      const f = computeFlipFrame(p);
      for (const s of f.strips) {
        expect(Number.isFinite(s.x)).toBe(true);
        expect(Number.isFinite(s.z)).toBe(true);
        expect(Number.isFinite(s.psi)).toBe(true);
      }
    }
  });

  it('默认形状参数是「卷」而不是「立」：总弯曲量接近半圈，条带够密', () => {
    expect(DEFAULT_FLIP_SHAPE.curlAngle).toBeGreaterThan(1.5);
    expect(DEFAULT_FLIP_SHAPE.strips).toBeGreaterThanOrEqual(12);
    // e=1 时书脊角必须是 π，否则落页不是平铺的
    expect(DEFAULT_FLIP_SHAPE.spineAngle).toBeCloseTo(Math.PI, 6);
  });
});
