# 跨端 3D 翻页阅读器 · 架构设计

> 目标：三端（移动 Web / Taro 小程序 / React Native）共用**同一份分页、同一套主题、同一套手势语义、同一套翻页几何**，
> 差异只允许存在于「怎么把字画出来」这一层。

---

## 1. 分层与依赖方向

```
┌──────────────────────────────────────────────────────────┐
│  platform/web        platform/taro        platform/rn    │  ← 平台适配层（各写各的）
│  ├ DOM 渲染/量测      ├ 小程序视图          ├ Skia/Text   │
│  ├ Pointer 事件       ├ touch 事件         ├ PanResponder │
│  └ localStorage       ├ wx.setStorage     └ AsyncStorage │
├──────────────────────────────────────────────────────────┤
│                       core（框架无关）                    │  ← 纯 TS，零 DOM
│  model / markdown │ pagination │ gesture │ flip │ theme  │
└──────────────────────────────────────────────────────────┘
```

依赖方向是**单向的**：platform 依赖 core，core 不认识 platform。
这一点由 lint 约束（`src/core/**` 禁止出现 `document` / `window`），
也是"架构没有因为单端 MVP 锁死"的硬保证。

`src/core/` 当前 100% 由 `tests/` 覆盖，且这些测试**不启动浏览器**——
这意味着 Taro / RN 的 CI 可以直接跑同一套测试来验证一致性。

---

## 2. core 契约清单

| 契约 | 文件 | 作用 | 三端是否共用 |
|---|---|---|---|
| `Block` / `Document` | `core/model.ts` | Markdown 解析后的中间表示 | ✅ |
| `parseMarkdown()` | `core/markdown.ts` | Markdown → Block，零依赖纯函数 | ✅ |
| `paginate()` + `LayoutProvider` | `core/pagination.ts` | 分页算法 | ✅ |
| `ReadingTheme` + `ThemeStore` + `ThemePersistence` | `core/theme.ts` | 主题模型与持久化接口 | ✅ |
| `createGestureMachine()` | `core/gesture.ts` | 手势状态机 | ✅ |
| `computeFlipFrame()` / `progressForFingerOffset()` | `core/flip.ts` | 翻页几何 | ✅ |
| `core/version.ts` | `CORE_VERSION` | 契约版本号，三端升级需对齐 | ✅ |

### 2.1 分页一致性怎么保证

分页结果的差异只会来自一个地方：**度量**。所以契约被收敛成一个接口：

```ts
interface LayoutProvider {
  measure(block: Block, ctx: LayoutContext): BlockMetrics;
}
interface BlockMetrics {
  height: number;
  marginTop: number;
  lines?: LineBox[];        // 行盒：段落只能在这里断
  fallbackLines?: LineBox[];// 整块高于整页时的降级切分点（如超长代码块）
  breakable: boolean;
  keepWithNext: boolean;
}
```

- **Web**：隐藏 DOM + `Range.getClientRects()`，量到什么就渲染什么，误差为 0。
- **Taro**：隐藏 `view` + `Taro.createSelectorQuery().select().boundingClientRect()`，
  逐块量；行盒需要用 `wx.createSelectorQuery` 的 `getRectsByRange`（基础库 2.19+）或退化为「按字符数估算行数」。
- **RN**：`react-native-skia` 的 `measureText` + 自研断行器，或直接用
  `Text` 的 `onTextLayout`（0.71+）拿到行盒。

**跨端一致性验收方式**：同一份 Markdown + 同一份主题，分别在三端跑，
与 `tests/golden/` 下的黄金分页结果对比（页数、每页首块类型、每页行数）。
MVP 阶段先把 Web 的结果落成黄金样本。

### 2.2 手势一致性

core 的状态机是纯函数 reducer，输入 `PointerSample`、输出 `ReaderIntent`。
平台层只做事件翻译：

```ts
// platform/web
pointerdown → machine.send({type:'down', x, y, t})
// platform/rn
onStartShouldSetResponder → machine.send({type:'down', x, y, t})
```

互斥规则全部写在 `core/gesture.ts`，并有 20+ 条单测锁死：

| 规则 | 实现位置 | 对应用例 |
|---|---|---|
| 长按 vs 滑动互斥 | `move` 超容差即取消长按计时 | `移动超过容差会立刻取消长按计时` |
| 选区中不响应滑动 | `selection` 态下 `move` 直接吞掉 | `进入选区后，横向滑动不再翻页` |
| 退出选区后恢复 | `up` → `exitSelection` → `idle` | `释放手指退出选区后，滑动翻页重新可用` |
| 翻页中长按无效 | 闸门在 reducer 最前面 | `动画进行中，长按不触发选区` |
| tap 三分区 | `tapIntent()` 按 30%/40%/30% | `分区边界` 系列 |

### 2.3 翻页视觉一致性

`computeFlipFrame()` 输出的是**数字**：每个条带的 `x / z / psi / shade`。
渲染端各显各的：

| 端 | 渲染方式 |
|---|---|
| Web | CSS 3D：`translate3d() rotateY() translate3d()` + `clip-path` 切条带 |
| Taro | 小程序原生不支持 preserve-3d → 走 WebView 容器（`web-view`）复用 Web 实现；或在 canvas 2D 上做**仿射近似**（退化方案，需产品确认是否接受） |
| RN | `@shopify/react-native-skia` 的 `Canvas` + `Path`/自定义 shader，或 `react-native-gl` |

关键点：**弯曲形状的数学只有一份**。即便 Taro 端最终只能做近似卷曲，
也能保证形状来自同一个函数，而不是各画各的。

---

## 3. 三个核心算法各自踩过的坑

### 3.1 翻页几何：切线角场 + 弦缩放条带

**第一版踩的坑：用三次贝塞尔描述截面。**
控制柄一摆就自交 —— 控制点连线方向非单调时，曲线中间会出现反向曲率，
纸面出现错误折痕。`tests/flip.test.ts` 的「截面不自交」用例第一次跑就抓到（x 回退 0.032）。

**第二版：切线角场积分。**

```
ψ(u) = A(e) + B(e)·u^γ          单调不减 ⟹ 纸只能朝一个方向弯
pos(u) = ∫₀^u (cos ψ, sin ψ) ds
A(e) = spineAngle·e^spineBias   书脊角（e=1 时 = π，落页平铺）
B(e) = curlAngle·sin(πe)^0.85  弯曲量，两端归零
```

单调性从数学上杜绝自交，比「摆控制柄再调参」可靠得多。

**第三版（关键）：条带必须按弦缩放。**
最初每条带子用「中心点位置 + 中心切线角」做刚体变换，结果两个问题：

1. **漏缝**：条带的投影宽度（材料宽 × cos ψ）与相邻中心间距（截面上的真实间距）
   在弯曲处对不上，弯得越紧漏得越多。表现为卷曲区域出现一条条绿缝（透出下层）。
2. **纸面文字不跟着卷**：刚体变换只旋转不压缩，文字在纸上的相对位置始终是平的，
   看起来像「一叠旋转的切片」而不是「一张卷起来的纸」。

正确做法是让每条带子**精确等于截面上的一段弦**：

```
transform = translate3d(head) rotateY(-θ) scaleX(弦长/材料宽) translate3d(-bandLeft)
```

这样相邻条带首尾严格衔接（单测断言 `cur.head === prev.tail`），
文字也随纸面弯曲真实透视压缩。`computeFlipFrame` 因此多输出
`head / tail / squash / chordAngle` 四个字段 —— **这三个字段就是三端共享的几何契约**。

**跟手问题**：自由边 x 从 +1 走到 −1（共 2 个页宽），而手指最多只能走 1 个页宽，
两个诉求天然冲突。解法是 core 提供 `progressForFingerOffset()` 反查表，
上层用「跟手 + 拉伸」映射（`reader.ts` 的 `FEEL_STRETCH = 1.15`），
纸角始终落后手指约 0.2 个页宽 —— 真实纸张被拖着走本来就会滞后一点。

### 3.2 分页：原子块放得下就不切，放不下才降级

- 标题：`keepWithNext`，不能孤零零留在页尾；
- 代码块/图片/分隔线：放得下就整体搬页，绝不切开；
- 代码块高于整页：按代码行切（`fallbackLines`），**一行都不丢**；
- 段落：只能在行边界断，带寡行控制，不给下一页留 1 行。

### 3.3 主题：签名要区分「排版」与「配色」

`themeSignature()` 只包含影响排版的字段。换配色签名不变 → **不该触发重新分页**；
改字号/行距/段距/内边距/字体 → 签名变化 → 分页缓存失效、重排。
用 `colorSignature()` 单独判断「主题变了」但「不用重排」。

### 3.4 平台层踩过的坑（都不在 core，但会让验收项静默失效）

| # | 现象 | 根因 | 处理 |
|---|---|---|---|
| 1 | 分页高度与渲染对不上，主题一改就跳版 | 主题 CSS 变量挂在 `.reader` 上，而离屏度量容器是 `document.body` 子节点，**继承不到变量** | 变量挂 `:root`（`documentElement`），度量容器与书页共享同一套变量 |
| 2 | 长按偶尔没反应（E2E 间歇失败） | `setTimeout` 受时间粒度影响，可能比 deadline **早 0.5ms** 触发；tick 处理器判定「未到期」就丢弃，**再也不会重试** | 未到期就重新排一次（上限 8 次） |
| 3 | 拖设置滑块会把书页也翻了 | 手势绑在整个 `.reader` 上，面板覆盖其上 | 手势绑到 `.stage` |
| 4 | 卷曲区域出现一条条「绿缝」 | 条带用中心点刚体变换，投影宽度与中心间距在弯曲处对不上 | 改为按弦缩放（见 3.1） |
| 5 | 卷曲上出现阶梯状色带 | 每条带子一个平色 | 条带内改用左右端亮度的渐变 |
| 6 | 某次调试整页变黑 | `rgba(...,1.05)` 的 alpha 被浏览器夹成 1，条带直接纯黑 | 乘完再夹紧到 [0,1] |
| 7 | 条带边缘出现 N 道竖直黑边 | 每个条带的 `.face` 都带 box-shadow | 翻页层不加阴影，投影交给下层书页的 `.cast-shadow` |
| 8 | Vite 改了代码但页面行为不变 | 转换缓存陈旧 | `rm -rf node_modules/.vite` 后重启 |

> 第 2 条值得单说：它不是测试问题，是**真机上会复现的交互缺陷**。
> 验收标准里「长按可唤起文本选区菜单」如果只在 90% 的情况下成立，就是不合格。

---

## 4. 下一阶段交付项

### 4.1 Taro 小程序（预计 3～5 天）

1. `platform/taro/` 目录，实现 `LayoutProvider`（`createSelectorQuery` 量测）。
2. 翻页：`web-view` 内嵌本页面的构建产物（复用 Web 端，视觉 100% 一致）；
   如需原生 canvas 方案，先确认产品是否接受"仿射近似卷曲"。
3. 手势：把 `touchstart/touchmove/touchend` 翻译成 `PointerSample`。
4. 持久化：`Taro.setStorageSync` 实现 `ThemePersistence`。
5. 风险点：小程序 `web-view` 无法长按唤起系统级选区菜单（iOS 限制），
   需要产品决策：接受自定义选区菜单，还是保留 WebView 方案。

### 4.2 React Native（预计 5～8 天）

1. 排版：优先 `Text` + `onTextLayout` 拿行盒；`measureText` 做降级。
2. 翻页：`@shopify/react-native-skia`，把 `computeFlipFrame` 的条带数组
   直接映射成 `Path`/变换矩阵，**几何逻辑一行不改**。
3. 手势：`PanResponder` → `PointerSample`。
4. 持久化：`AsyncStorage`。
5. 风险点：长按选区需要自研（RN 没有系统级文本选区菜单），
   这一项在三端里天然不一致，需要在产品层面明确。

### 4.3 共性风险登记

| 风险 | 影响端 | 现状 |
|---|---|---|
| 系统级选区菜单 | Taro / RN 拿不到原生菜单 | Web 已满足；另两端需产品决策 |
| 分页结果跨端逐页一致 | 全部 | MVP 阶段只保证 Web；黄金样本机制已就位，待补 Taro/RN 侧测试 |
| 60fps 翻页性能 | 全部 | Web 端 20 条带 × 双面 DOM，待真机压测；RN 端预计无压力 |

---

## 5. 已知限制（MVP 诚实登记）

1. **Web 端条带翻页是 DOM 实现**：28 条带 × 双面 = 56 份书页 DOM
   （实测翻页期 448 个节点，`update` 2.7ms/帧）。
   低端机可能掉帧。后续可换成「静止页 DOM + 翻页页 canvas 位图」混合方案
   （选区只在静止页发生，不影响功能）。
2. **沙箱内未做真机性能验证**：上表数据来自无头 Chromium（软件光栅化），
   只能量化 JS 开销，**不能替代真机 60fps 验证**。上真机前不要对帧率下结论。
3. **图片分页依赖 `aspect-ratio`**：图片未加载时按 3:2 预留高度，
   加载完成后不触发重排。极端宽高比的图会有留白。
4. **Markdown 解析器是子集实现**：不支持表格、HTML 内嵌、多层嵌套列表。
5. **单页模式**：没有做左右双页对开（书页跨页），翻页时书脊固定在页面左边缘。
6. **E2E 用鼠标事件模拟手势**（PointerEvent 通路），
   真实移动端的 `touchstart/touchmove` 与原生长按选区需要真机复核。
