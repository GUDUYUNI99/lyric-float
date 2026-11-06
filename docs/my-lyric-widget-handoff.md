# my-lyric-widget 交接文档

给接手的人 / 下一个会话：**现在是什么状态、下一步做什么、坑在哪**。
设计来龙去脉读 [迭代文档](my-lyric-widget-iterations.md)；1.3.0 与 1.6.3 的完整差距读
`D:\folia-dev\1.3.0-vs-1.6.3-功能对比与风险.md`。

最后更新：**2026-11-07**，对应状态「1.6.3 已存档、准备回滚到 1.3.0、回滚尚未执行」。

---

## 1. 一句话现状

代码做到 **1.6.3**（分支 `wip/1.6.3`，已推 GitHub），但真机上「换歌偶发卡死」反复无法稳定修复，
用户决定**回滚到 1.3.0** 作为可用版本。回滚**还没有执行**，先写下这份交接。

职责边界不变：`client.mjs` 只搬数据，`main.cjs` 管窗口与渲染；界面本体在那个独立悬浮窗里。

---

## 2. 三条分支（这是最重要的一节）

仓库：`D:\folia-dev\folia-major\mods\my-lyric-widget`（模组目录自己是个 git 仓库）
远端：`https://github.com/GUDUYUNI99/my-lyric-widget.git`

| 分支 | 提交 | 内容 | 用途 |
| --- | --- | --- | --- |
| `wip/1.6.3`（**当前**） | `3861698` | 1.6.3 全量（1.4.0–1.6.3 所有功能） | 存档；已推 GitHub；提交说明里标注了「bug 较多，不建议直接用」 |
| `feature/standalone-mod` | `bea218b` | **1.3.0 快照**（2026-11-05 23:21） | 回滚目标 |
| `main` | `9a3df47` | 1.0.0 基线 | 历史 |

回滚（一条命令，10 秒，改完重启 Folia 生效）：

```bash
cd D:\folia-dev\folia-major\mods\my-lyric-widget
git switch feature/standalone-mod
```

切回 1.6.3：`git switch wip/1.6.3`。
注意：`git switch` 会连带把 `docs/` 里的文档恢复成对应版本——本文件与上述对比文档在
`D:\folia-dev\` 下另存了一份，不受影响。

---

## 3. 回滚后会得到什么

1.3.0 的能力边界（这些是**设计如此**，不是缺陷）：

- 窗口固定 **640×180**，不随字号变（没有字号设置）；
- 两行歌词（原文 + 译文 / 罗马音，由顶部排版按钮三态循环）；
- 长句**直接截断**（`nowrap + ellipsis`）；
- 没有逐字歌词（`line.words` 恒为 `null`）；
- 没有设置面板、没有命令面板、没有播放条「词」按钮、没有窗口右上角 ×；
- 有：任务栏置顶守卫（1.0.1）、固定态部分点击穿透（1.2.0）、去 DWM 阴影/圆角（1.2.0）、
  位置/固定/排版持久化。

会失去什么、每条对应哪个版本，见对比文档第 3 节表格。简言之：**15 项功能与 +1929 行代码**。

---

## 4. 回滚后如果要继续做，建议顺序

1. **先解决「换歌偶发卡死」再谈功能**。1.6.3 的定位是「页面用全局最大行号判旧帧，换歌后行号从 0 重来，
   新歌每一帧都被当旧帧丢掉」；已经加了 `shownSessionId` 重置，但用户复测仍有，说明还有第二条路径。
   建议的下一步（约 40 行）：把排序逻辑搬到主进程——按 `playSessionId` 分桶，同一首歌里
   `position` 明显后退（>0.5s）且行号不前进的帧直接丢弃，页面删掉 `shownLineIndex` 那套保护。
2. 修「× 关掉再打开第一帧是旧句」：补发 + `request-sync` 已做，仍偶发，怀疑补发早于页面监听注册，
   可在 `did-finish-load` 里再补一次（现在只在 load 时发一次 config，未发 payload）。
3. 再按 1.4 → 1.5 → 1.6 的顺序**分批**加回功能，每批都真机验证一遍再进下一批。
4. 逐字 + 长句滚动同时开启时的观感（染色是否跟着滚、换句是否立即复位）一直没真机确认过。

---

## 5. 文件地图

当前（1.6.3）：

| 路径 | 行数 | 说明 |
| --- | --- | --- |
| `mod.json` | 13 | `folium: 1`；权限 `playback.control` + `playback.read`；`version: 1.6.3` |
| `client.mjs` | 1391 | 数据投影（`readLine` / `projectWords`）、独立轮询引擎、设置分区（`buildSettingsSection`，13 项）、5 条命令、播放条「词」按钮、1.6 轮询兜底 |
| `main.cjs` | 2672 | 悬浮窗与内联页面、`normalizeConfig`（三段配置）、`windowHeightFor`（字号→高度）、`displaySurface` / `setDisplaySurface`（形态）、`setWidgetOpen`（显隐）、走马灯滚动、逐字 rAF、任务栏守卫、部分点击穿透 |
| `docs/` | 597 → 1124 | 迭代文档 |

1.3.0（回滚后）：`client.mjs` 536 行、`main.cjs` 1564 行、文档 597 行。

关键函数（1.6.3 行号，会随改动漂移，仅供定位）：

- `main.cjs:253` `normalizeConfig`、`:303` `lyricBlockHeight`、`:308` `windowHeightFor`
- `main.cjs:1788` `sendPayloadToWindow`、`:1828` `displaySurface`、`:1836` `reportWidgetVisibility`
- `main.cjs:1870` `setWidgetOpen`、`:1931` `syncDisplaySurface`、`:1973` `setDisplaySurface`
- `main.cjs:2020` `applyWindowSize`、`:2060` `startHoverWatch`、`:2155` `startTaskbarGuard`
- `main.cjs:2197` `createWidgetWindow`、`:2418` `ensureWidgetWindow`
- `client.mjs:221` `findApproximateLineIndex`、`:238` `projectWords`、`:255` `readLine`
- `client.mjs:625` `registerWidgetToggleButton`、`:752` `buildSettingsSection`、`:984` `registerSettingsSection`
- `client.mjs:1071` `registerWidgetCommands`、`:1160` `startCommandPolling`

---

## 6. 协议（1.6.3）

### 6.1 RPC / IPC

| 通道 | 方向 | 用途 |
| --- | --- | --- |
| `update-data` | client → main | 每次内容变化推一份快照（`position` 变化会被去重掉） |
| `action` | main → client | 播放控制指令 |
| `config` | client → main | 13 项设置（三段结构），main 归一化后转给页面 |
| `toggle-pin` | client → main | 命令面板的锁定/解锁 |
| `toggle-widget` | client → main | 播放条「词」按钮：显示 / 隐藏桌面歌词，返回 `{visible}` |
| `widget-state` | client → main | 首帧对齐查询，返回 `{visible, surface, canSend}` |
| `set-surface` | client → main | 切换形态，返回 `{surface}` |
| `take-commands` | client → main | 1.6 宿主兼容：取走主进程排队的消息 |
| `widget-visibility` | main → client | 显隐 + 形态变化推送 |
| `my-lyric-widget:data-from-client` | main → 页面 | 快照 |
| `my-lyric-widget:action-to-client` | 页面 → main | 按钮指令 |
| `my-lyric-widget:hover` | main → 页面 | 悬停态（拖拽区吞鼠标，只能主进程轮询光标） |
| `my-lyric-widget:pinned` | main → 页面 | 固定态 |
| `my-lyric-widget:layout` | main → 页面 | 排版 |
| `my-lyric-widget:pin-rect` | 页面 → main | 解锁按钮矩形（固定态命中判定） |
| `my-lyric-widget:close` | 页面 → main | 右上角 × |
| `my-lyric-widget:config` | main → 页面 | 设置 |
| `my-lyric-widget:surface` | main ↔ 页面 | 形态（图标高亮 + 点击切换） |

### 6.2 payload

```js
{
  playSessionId, song, state, position, duration, liked, canLike,
  volume, muted, loopMode,
  line: { index, text, translation, romanization, words, next, startTime, endTime },
  theme
}
```

- `words`：1.5.0 起有值；宿主保证恒为数组，长度 1 = 没有逐字时间。
- `next`：1.5.0 为「歌词板」形态准备的，1.6.0 砍掉形态后**已无渲染路径消费**，属于契约残留。

### 6.3 设置（13 项，宿主 `settingsSections`）

`display`、`fontSize`(20–50)、`karaoke`、`fontMode`、`surface`、`surfaceOpacity`、`radius`、
`border`、`backdrop`、`sungColor`、`unsungOpacity`、`pausedDim`、`marquee`。

### 6.4 持久化

- `userData/my-lyric-widget-state.json`：`{x, y, pinned, layout, open, surface}`
  （1.3.0 只有前四项，多出来的键会被忽略，双向兼容）。
- 设置由宿主保存在 `folia_folium_params_v1` 的 `lyric-widget` 分区；回滚到 1.3.0 后这些值仍在，
  只是没人读，重新升级会自动生效。

---

## 7. 怎么验证

静态检查（沙箱里可跑）：

```bash
cd D:\folia-dev\folia-major
npm run folium:check -- my-lyric-widget          # 期待 no problem found + 两条 note
node --check mods/my-lyric-widget/main.cjs
node --check mods/my-lyric-widget/client.mjs
```

真机（只能在 Folia 里做，沙箱起不了 Electron 的 GUI）：

1. 连播 3 首歌（上一首听到后半段），看新歌第一句是否立刻出现、全程跟随 —— 这是 1.6.x 的卡死点。
2. × 关掉 → 等两句 → 再打开，第一帧是否当前句；之后换歌是否继续。
3. 字号 20 / 38 / 50 来回切，窗口高度与位置是否正确。
4. 逐字 + 长句滚动同时开，染色是否跟着文字走、换句是否立即复位。
5. 设置改形态 ↔ 窗口切换键高亮是否互相同步。
6. 125% / 150% 缩放、双屏不同 DPI 下拖到副屏。

回滚后的验证（1.3.0）：窗口 640×180、三态排版、长句截断、无 ×、无播放条按钮，属预期。

---

## 8. 踩过的坑（别重复）

1. **`settingsPanel` 必须是函数**（`FoliumMount`），传 `{ mount }` 对象会让 `settingsSections.register`
   直接抛错，被 try/catch 吞掉后**整个设置分区消失**（1.6.0 的真机现象）。
2. **宿主设置卡是二选一**：传了 `settingsPanel` 就不再渲染 schema 表单，做不到「上面自绘 + 下面表单」。
3. **`progressButtons` 挂在 ShadowRoot 里**：`<style>` 必须注入按钮所在的 root，挂 `document.head` 全不生效（1.4.0 的白框 bug）。
4. **设置文案必须是语言映射对象** `{ 'zh-CN': ..., en: ... }`，传字符串会被宿主整片丢弃。
5. **拖拽区（`-webkit-app-region: drag`）吞鼠标事件**，页面收不到 hover，只能主进程轮询光标。
6. **固定态整窗 `setIgnoreMouseEvents`** 时，命中判定靠页面报上来的按钮矩形（`pin-rect`），坐标用 `getContentBounds()`。
7. **换歌时行号从 0 重来**，任何「按行号单调性」做的保护都必须带会话号，否则会吞掉新歌的所有帧（1.6.3 的卡死）。
8. **不要改仓库根配置**（`package.json`、`main.js`、`vite.config.*`）；模组只动自己目录。
9. **沙箱里 shell 写不进 `folia-major/`**（`Permission denied`），要写文件用编辑器 / `write` 工具；git 操作需要更高权限。
10. **Electron GUI 在沙箱起不来**（`mojo ... platform_channel.cc Check failed: 拒绝访问`），一切窗口观感只能真机验。

---

## 9. 参考资料

- `D:\folia-dev\1.3.0-vs-1.6.3-功能对比与风险.md` —— 两版功能差距、协议差异、已知/潜在 bug 清单
- `D:\folia-dev\folia-major\mods\my-lyric-widget\docs\my-lyric-widget-iterations.md` —— 每轮改动与原因
- `D:\folia-dev\folia-major\mods\README.md`、`docs/folium/api.md`、`mods/folium.d.ts` —— 宿主接口
