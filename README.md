# 跨端 3D 翻页阅读器 · Web MVP

> 三端（移动 Web / Taro 小程序 / React Native）共用同一套分页、主题、手势语义与翻页几何。
> **本阶段只交付 Web 端跑通 + 可演示**，core 层是框架无关的，跨端路径没有被锁死。

---

## 快速开始

```bash
cd reader
npm install

npm run dev        # 开发服务器 http://localhost:5173
npm test           # 70 条 core 单元测试（不启动浏览器）
npm run e2e        # 12 条端到端验收（含翻页中间态断言 + 截图）
npm run build      # 生产构建 → dist/（26.5 KB gzip）
```

> 端到端测试需要 Chromium。沙箱内已有：`export PLAYWRIGHT_CHROMIUM_EXECUTABLE=<chrome 路径>`
> （`playwright.config.ts` 里已内置默认路径）。

---

## 交互说明

| 操作 | 行为 |
|---|---|
| 点屏幕左侧 30% | 上一页 |
| 点屏幕右侧 30% | 下一页 |
| 点屏幕中间 40% | 弹出设置面板 |
| 横向拖拽 | 纸张跟手卷曲，松手按距离/甩动速度吸附 |
| 长按 | 唤起系统级选区菜单（复制 / 搜索 / 翻译 / 分享） |

互斥规则由 `src/core/gesture.ts` 的纯函数状态机统一裁决，三端复用同一份实现，
20+ 条单测锁死（长按 vs 滑动、选区中不翻页、翻页动画优先）。

---

## 目录结构

```
src/
├── core/                  框架无关，零 DOM 依赖，三端共用
│   ├── model.ts           文档中间表示
│   ├── markdown.ts        Markdown → Block（零依赖纯函数）
│   ├── pagination.ts      分页引擎 + LayoutProvider 契约
│   ├── gesture.ts         手势状态机（互斥规则唯一实现处）
│   ├── flip.ts            翻页几何（切线角场 + 跟手反查表）
│   ├── theme.ts           主题模型 + 持久化接口
│   └── easing.ts          缓动 / 吸附时长
├── platform/web/          Web 适配层（本阶段交付端）
│   ├── domRenderer.ts     DOM 度量（Range.getClientRects）+ 页面渲染
│   ├── flipRenderer.ts    CSS 3D 条带渲染器
│   ├── gestureBinding.ts  指针事件 → 状态机
│   ├── reader.ts          阅读器控制器
│   ├── settings 面板      → 内置于 reader.ts
│   └── storage.ts         localStorage 适配
└── app/                   入口 + 样式 + 示例长文
tests/                     70 条单元测试
e2e/                       12 条端到端验收
scripts/                   视觉巡检（frames.ts 逐帧截图 / perf.ts 性能）
docs/architecture.md       架构设计 + 踩坑记录 + 下一阶段计划
```

---

## 三个关键设计

### 1. 真 3D 卷曲，不是伪 3D

整页 `rotateY` 只是刚性旋转，纸面始终是平的 —— 需求明确否掉了这种做法。

本实现把纸页沿宽度切成 28 条竖条，每条按截面曲线上的**一条弦**做刚体变换 + 横向缩放：

```
切线角场   ψ(u) = A(e) + B(e)·u^γ     （单调不减 ⟹ 纸不会自交）
截面积分   pos(u) = ∫₀^u (cos ψ, sin ψ) ds
条带变换   translate(head) rotateY(-θ) scaleX(弦长/材料宽) translate(-bandLeft)
```

相邻条带首尾**精确衔接**（单元测试断言 `cur.head == prev.tail`），
纸面文字随弯曲真实透视压缩，明暗在条带内用渐变过渡（不会出现阶梯色带）。

### 2. 真实 DOM 文本 ⇒ 原生选区菜单

页面内容是真实 `<div>` 文本节点，不是 canvas 画出来的位图。
只有这样浏览器才会给出系统级的复制 / 搜索 / 翻译 / 分享菜单。
代价是翻页时需要 28×2 份书页 DOM（实测翻页期 448 个节点，update 2.7ms/帧）。

### 3. 排版度量走真实 DOM

分页度量在离屏容器里用 `Range.getClientRects()` 取行盒，
保证「量出来的高度 = 渲染出来的高度」，主题变化后分页重排不会跳版。
离屏容器与真实书页共用同一套 CSS 变量（这点踩过坑，见架构文档）。

---

## 验证

| 维度 | 结果 |
|---|---|
| 单元测试 | 70 / 70 通过（分页、状态机、主题、翻页几何、Markdown） |
| 端到端 | 12 / 12 通过（tap 分区、拖拽、选区互斥、主题持久化、卷曲中间态断言） |
| 生产构建 | 61 KB JS（26.5 KB gzip），零运行时错误 |
| 性能 | 翻页 update 2.7ms/帧（60fps 预算 16.7ms 的 16%） |

视觉证据见 `shots/`：`frames/e15…e90.png` 是卷曲形态的逐帧截图，
`e2e-*.png` 是端到端各验收点的截图。

---

## 下一阶段

- **Taro 小程序**：`web-view` 复用本构建产物（视觉 100% 一致）；
  原生 canvas 方案需先确认产品是否接受仿射近似卷曲。
- **React Native**：Skia/GL 渲染，`computeFlipFrame` 的条带数组直接映射成变换矩阵，几何逻辑一行不改。

详见 `docs/architecture.md`。
