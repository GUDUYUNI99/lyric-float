# my-lyric-widget 迭代文档

独立悬浮歌词模组 `mods/my-lyric-widget/` 的迭代记录：每一轮做了什么、为什么这么做、哪些没做。
接手时先读 [交接文档](my-lyric-widget-handoff.md)，那里是「现在是什么样、下一步做什么」；本文件是「为什么长成这样」的来龙去脉。

- 模组 id：`my-lyric-widget`，名称「独立悬浮歌词」。`mod.json` 里的版本号现在是 **1.6.3**（client 1.6.2 / main 1.6.3）。
  早期红线「不动 `mod.json`」已由用户放开：版本号随每轮改动更新（功能迭代进 y、修 bug 进 z）。
- 目录里只有 3 个文件：`mod.json`、`client.mjs`、`main.cjs`（外加 `docs/`）；目录本身是个独立 git 仓库。
- 最后更新：2026-11-07（1.6.3：固定键与循环键不再重叠、换歌重置过期帧基准解决偶发卡死；1.6.2：× 关掉再打开不再卡死、固定键真正居中、固定态藏切换键、滚动词首加延迟）。

## 1. 它是什么

Folia 桌面版里一个「把歌词拿到播放器窗口之外去显示」的模组。用户选中本模组注册的歌词样式（`mod:my-lyric-widget:lyric-widget`）后：

- 渲染进程的 `client.mjs` 只做数据搬运：订阅播放状态和歌词上下文，把整份快照用 `folium.rpc.call('update-data', payload)` 发给本模组的主进程；
- 主进程的 `main.cjs` 开一个无边框、透明、置顶、不抢焦点的 640×180 小窗，把最新快照渲染出来，窗口上的按钮/音量条再把控制指令用 `api.rpc.send('action', ...)` 发回渲染进程执行。

歌词样式的画面本身是空的：真正的界面在主进程那个独立窗口里，所以模组没有被选中时窗口显示「等待播放...」。

## 2. 当前版本状态（代码 1.6.3，`mod.json` 记 1.6.3）

| 文件 | 行数 | 说明 |
| --- | --- | --- |
| `mod.json` | 13 | `folium: 1`，`permissions: ["playback.control", "playback.read"]`，`version: "1.6.3"`（1.0.1 任务栏遮挡见 §4.10；1.1.0 顶部控制条见 §4.11；1.2.0 部分点击穿透 + 去系统阴影见 §4.12 / §4.14；1.3.0 第三态改罗马音、窗口压到 180 高见 §4.15；1.4.0 播放条「词」开关 + 右上角关闭见 §4.16；1.4.1 修 shadow DOM 样式与关闭键重叠、1.4.2 按钮改成原生造型并退出收起态，见 §4.16；1.5.0 设置表单 / 字号 / 逐字 / 字体 / 外观 / 命令面板 / 1.6 兼容见 §4.17；1.6.0 砍掉单行与歌词板、引入「桌面歌词 / 悬浮窗歌词」两种显示形态见 §4.18；1.6.1 的六条真机修复见 §4.18 末尾） |
| `client.mjs` | 1391 | client 入口：**独立常驻**同步引擎（100ms 自主轮询 + 事件），不注册 visualizer、无 mount / ctx；接收 action；1.4.0 起注册播放条上的「词」开关按钮（`progressButtons`），1.4.1 起样式注入它的 ShadowRoot、并用 `widget-state` 对齐首帧，1.4.2 起 `hideWhenCollapsed` + 原生造型；1.5.0 起注册模组设置表单（`settingsSections`）与命令（`commands`），并把 `line.words` / `line.next` 一起透传；1.6.0 配置改三段结构（`shared` / `desktop` / `window`）；1.6.1 起形态切换回到 schema 下拉（`display`），不再自绘设置面板 |
| `main.cjs` | 2672 | main 入口：悬浮窗（data URL 页面，宽 640、高随字号算）+ 宿主窗口跟踪 + 指令归一化 + 顶部控制条（正中「固定」、左侧「切换形态」）+ 右上角关闭按钮 + 字号 / 悬停显隐 + 窗口状态持久化（位置 / 固定 / 排版 / 显示隐藏 / 形态）+ 任务栏守卫（§4.10）+ 固定态部分点击穿透（§4.12）+ 1.5.0 配置归一化（`normalizeConfig`）与窗口尺寸互推 + 1.6.0 形态切换（`displaySurface` / `setDisplaySurface` / `syncDisplaySurface`）+ 1.6.1 长句横向滚动（走马灯）与重开补发最新快照 |

`playback.control`：`folium.playback` 的切歌/播放暂停/音量/循环模式（`mods/README.md` 权限表）。
`playback.read`：main 侧的 `api.runtime.getPlaybackSnapshot()`（`mods/README.md` 权限表；client 端读播放状态不需要权限）。

## 3. 功能状态

| 编号 | 功能 | 状态 |
| --- | --- | --- |
| F01 | 空歌词视觉组件注册（`registries.visualizers`，id `lyric-widget`） | **已下线**（1.0.0 起不再注册，见 §4.9） |
| F02 | 快照同步：歌曲、播放状态、位置/时长、喜爱、音量/静音、循环模式、当前行、主题 | 已上线 |
| F03 | 句间保留上一句（`getRecentCompletedLine`），只有第一句之前/无歌词才显示「等待播放...」 | 已上线 |
| F04 | `playSessionId`：同一次播放内不变，换歌 / 从 stopped 重新开始时换新 | 已上线 |
| F05 | 控制指令：next / prev / toggle / set-volume / set-loop / request-sync | 已上线 |
| F06 | 悬浮窗：无边框透明置顶、不抢焦点、底部居中、页面 data URL 内联、CSP 锁死 | 已上线 |
| F07 | 宿主窗口生命周期跟随（宿主窗口全关时收窗、宿主出现新窗口时重建） | 已上线 |
| F08 | 崩溃自愈：页面进程退出每分钟最多自动 reload 2 次 | 已上线 |
| F09 | 窗口页面：原文 / 翻译·罗马音 / 上一首·播放暂停·下一首·循环·排版·音量（1.1.0 起不再显示歌曲名，按钮移到顶部） | 已上线 |
| F10 | 音量 150ms 节流（宿主每次 `setVolume` 都会保存设置） | 已上线 |
| F11 | 任意歌词样式下同步（不选中本样式也继续同步） | 已上线（0.3.3 混合同步；1.0.0 起彻底独立：不再注册样式，见 §4.9） |
| F12 | 逐字歌词：已唱部分染色 / 未唱部分变淡（`line.words` 透传，页面 rAF 外推） | 已上线（1.5.0，默认关闭，见 §4.17） |
| F13 | 主进程侧进度条 / 时间显示 | 未规划 |
| F14 | 窗口位置持久化、窗口尺寸 / 窗口关闭入口 | 位置持久化已上线（0.3.4）；尺寸 1.5.0 起随字号与形态自动算；关闭入口见 F32 |
| F15 | 底部控件图标化（内联 lucide SVG；播放/暂停实心、循环三态、音量档位） | 已上线（main 0.3.4） |
| F16 | 悬停中文提示：自绘气泡（1.1.0 起从图标**下方**弹出，因为控制条在顶部） | 已上线（main 0.3.4，1.1.0 调方向） |
| F17 | 排版三态：都灭=只原文 / 只亮图标里的「文」=原文+译文 / 只亮「A」=原文+罗马音（行里没有罗马音就退回译文） | 已上线（main 0.3.4；0.3.5 改成按字形点亮并记住选择；1.3.0 第三态由「三行全亮」改成「只亮 A」，见 §4.15） |
| F18 | 字号：默认原文 38px、第二行 27px；1.5.0 起 20–50 可调（下拉、步进 1），窗口高度跟着字号缩放 | 已上线（main 0.3.4 固定 38；1.5.0 可调，见 §4.17） |
| F19 | 字体 / 颜色自定义 | 1.5.0 部分上线：字体「系统无衬线 / 跟随主题」两项、已唱字色、未唱透明度、圆角、描边、底色、底衬、暂停变淡（见 §4.17）；其余（任意字体、任意字色）仍是想法 |
| F20 | 窗口尺寸：宽 640 固定，高按字号与形态算（38px 双行 = 180、单行 = 124、字号 50 双行 = 218） | 已上线（0.3.4 为 236；1.3.0 压到 200 → 180；1.5.0 起动态，见 §4.17） |
| F21 | 从「歌词样式」独立成单独功能 + 主程序设置里的自有设置界面 | **部分上线**：功能已独立（1.0.0，F26）；自有设置界面仍是想法（评估见 §4.8） |
| F26 | 独立常驻功能模组：只要模组启用就工作，与当前歌词样式无关（不再注册 visualizer / 不再依赖 mount） | 已上线（client 1.0.0，见 §4.9） |
| F27 | 任务栏守卫（仅 Windows、非自动隐藏任务栏）：窗口压在任务栏上时显示在任务栏之上；该位置重启后仍能恢复 | 已上线（main 1.0.1，见 §4.10） |
| F28 | 1.1.0 顶部控制条：删掉歌曲名行；按钮全部移到窗口顶部；固定键严格水平居中，锁定时变成高亮的「取消锁定」图标按钮（不带文字） | 已上线（main 1.1.0，见 §4.11） |
| F29 | 部分点击穿透：锁定时只有「取消锁定」按钮接收鼠标，其余矩形（含歌词区）穿透 | 已上线（main 1.2.0，见 §4.12；真机待验） |
| F30 | 去掉窗口四周系统阴影 / 圆角描边；固定态悬停不再铺底色、不描边 | 已上线（main 1.2.0，见 §4.14；真机待验） |
| F31 | 1.3.0 排版第三态改成「原文 + 罗马音」（没有罗马音回退译文）、三行排版下线、窗口高度 236 → 200 → 180 | 已上线（main 1.3.0，见 §4.15；真机待验） |
| F32 | 1.4.0 显示 / 隐藏：播放条进度右侧的「词」按钮（`progressButtons`，`order: 480`）切换悬浮窗显隐并高亮当前状态；窗口右上角的 × 只隐藏窗口，模组继续启用；显隐状态写进状态文件 `open` | 已上线（main + client 1.4.0，见 §4.16；真机待验） |
| F33 | 1.5.0 模组设置表单（设置 → 高级 → 模组 → 独立悬浮歌词）：字号下拉、逐字歌词、字体、外观 8 项（1.6.0 起砍掉窗口形态项；1.6.1 起加「显示形态」下拉与「长句滚动显示」开关，设置改由 schema 渲染） | 已上线（client + main 1.5.0 / 1.6.1，见 §4.17 / §4.18；真机待验） |
| F34 | 窗口形态三态：双行（默认）/ 单行 / 歌词板 | **已下线**（1.6.0 砍掉单行与歌词板：长歌词显示不全、切几次会失效，桌面歌词固定两行，见 §4.18） |
| F35 | 命令面板入口（显示 / 隐藏、锁定 / 解锁、字号 ±1、切换形态）+ Folium 1.6 兼容层（无 `api.rpc.send` 时走 `take-commands` 轮询） | 已上线（1.5.0；形态命令 1.6.0 加，见 §4.17 / §4.18） |
| F36 | 1.6.0 两种显示形态互斥：桌面歌词（现状）/ 悬浮窗歌词；三个入口（设置「通用」组的 `display` 下拉、窗口控制条「固定」**左边**的切换键、命令面板）走同一条 `set-surface`；形态记在状态文件 `surface` | 已上线（main + client 1.6.0 / 1.6.1，见 §4.18；悬浮窗视图 1.7.0 才填，真机待验） |
| F37 | 1.6.1 六条真机修复：切换键移到固定键左边（固定键仍居中）、设置回到 schema 表单（`display` 下拉 + 「长句滚动显示」）、长句横向滚动不缩小、重开补发最新歌词、句间空隙帧不再闪回上一句、逐字随设置恢复 | 已上线（main + client 1.6.1，见 §4.18 末尾；真机待验） |

## 4. 设计决策与保留意见

### 4.1 已上线部分的关键决策

| 决策 | 理由 |
| --- | --- |
| client → main 用 `folium.rpc.call`，不是 `folium.rpc.send` | client 侧根本没有 `send`，只有 `call` / `on`；用户最初写的 `folium.rpc.send('update-data')` 是 main 侧的 API |
| main → client 用 `api.rpc.send('action', ...)` | `api.rpc.send` 是 1.7 才有的 fire-and-forget，不排队、不重放、未激活直接丢 |
| IPC 通道加模组前缀 `my-lyric-widget:` | `ipcMain` 通道全应用共用，别的模组撞名会收到本窗口的消息 |
| 页面用内联 data URL + `nodeIntegration` | 用户要求：不依赖外部文件、页面里 `require('electron')`；代价见 4.3 |
| 收到 `request-sync` 时绕过内容去重强制重发 | 窗口 reload、主进程重建窗口后要立刻拿到当前状态 |
| 主进程 64KB 上限只约束 main → client | 已知；`lines` 只带当前行，payload 远小于上限 |
| 空字符串 `line.text` 原样显示，不退回「等待播放...」 | 只有翻译、没有原文的歌词行是合法的 |

### 4.2 任意样式下同步（F11，0.3.3 上线；1.0.0 起由 §4.9 的自主轮询取代，本节保留历史）

> 1.0.0 已删除 visualizer 注册与 mount，本节描述的「挂载精确 / 兜底轮询」双路径中，只剩原来那条兜底路径（现在由 100ms 自主轮询驱动），详见 §4.9。

**想要的效果**：不把歌词样式切成「悬浮歌词」，悬浮窗也继续显示歌词。

**0.3.2 为什么做不到**：`mount` 只在本样式被选中时调用；切到别的样式，client 的监听全部撤掉，窗口冻在最后一帧。
`activate` 阶段没有 `ctx`（`lines` / `getLineIndex()` 都在 `FoliumStageContext` 上），
`folium.lyrics` 里只有无状态的纯函数（`getRecentCompletedLine` 等），拿不到宿主当前行。

**0.3.3 的做法（混合同步）**：两条路径共用一个同步引擎，`activate` 时创建、`mount` 只负责交上下文：

- **主路径（样式被选中，精确）**：`mount` 交出 `ctx`，用 `ctx.lines` / `ctx.getLineIndex()` / `ctx.lyricTime.get()`，
  精度与 0.3.2 一致；
- **兜底路径（样式未选中，近似）**：不依赖 `ctx`，用 `folium.lyrics.getLines()` + `playback.getState().position`
  比对每行 `startTime/endTime` 求当前行；`songChanged` / `stateChanged` / `seeked` / `lyrics.loaded` / `theme.changed`
  等事件驱动即时同步，再叠加 `folium.every(200ms)` 轮询兜住漏事件；
- 卸下 `mount` 时立刻用兜底视图补发一帧，避免切样式瞬间窗口停在旧行。

**兜底路径已知的两项偏差**（真机验证后才明确）：

- 手动歌词偏移（单曲 + 设备）已从 `localStorage` 复算，见 §4.5；
- **预览片段起点拿不到**：预览从歌中间开始时，播放进度从片段起点重新计，歌词时钟仍从整首 0 秒计，
  两者相差「片段起点」；宿主没有把这个值暴露给模组，兜底路径也没有 `ctx.lyricTime`，于是整体错开一个片段起点。
  整首播放没有这个问题，切到「悬浮歌词」后立刻回到宿主精确时钟（`mount` 路径）。

### 4.3 已接受的已知限制

- **窗口安全配置**：`nodeIntegration: true` + `contextIsolation: false` + `sandbox: false`（用户明确要求）。
  已有兜底：页面内容全部由 `main.cjs` 生成、CSS 锁 `default-src 'none'`、`setWindowOpenHandler` 拒绝开窗、
  `will-navigate` 拦截导航、歌词只经 `textContent` 写入（无 `innerHTML`）。**改 F12 逐字高亮时不能拼 HTML。**
- **导出窗口**：导出窗口里 visualizer 注册照常保留（否则导出会报错停下），但 `mount` 早退，不推数据；
  导出画面里的本样式是空白的，可以配合 `hostLayers: { background: false, subtitles: false }` 不占层。
- **`position` 是事件时刻的快照**：不是持续推流，进度条要主进程自己按 `duration` 外推（可用 `api.runtime.getPlaybackSnapshot()` 轮询）。
- **换样式后窗口冻结**：0.3.2 的问题，0.3.3 混合同步后已解决（未选中样式走兜底路径继续推数据，见 §4.2）。
- **兜底路径的精度上限**：手动歌词偏移可复算（§4.5），但预览片段起点拿不到，预览播放时会有固定偏差（§4.2）。
- **用户手动关窗后被下一条数据复活**：窗口没有关闭入口，属第 1 轮既定行为。
- **点击穿透（click-through）**：整窗穿透不做（与「整窗可拖拽 / 按钮可点击」冲突）；用户 2026-11-05 改口，
  接受「固定时只留解锁按钮可点、其余穿透」，1.2.0 已按方案 B 实现（见 §4.12）。**未固定时窗口仍然占着
  640×236 的矩形，照旧挡住下方应用的点击与滚轮**；只有固定态才穿透。
- **macOS 也随宿主收窗**：宿主 `app.on('activate')` 只在没有任何窗口时才重建主窗口
  （`electron/main.cjs` 的 `app.on('activate')`），留着悬浮窗点 Dock 打不开主窗口。

### 4.4 混合同步的实现取舍

| 决策 | 理由 |
| --- | --- |
| 轮询 200ms 而不是更快 | 歌词行的粒度是秒级；200ms 足够跟上换行，又不会让主进程每秒收几十条 IPC |
| 去重键里把 `position` 归零 | 位置每秒都在变，但窗口只是按 `duration` 自己外推进度条，不值得每秒推流 |
| 发送失败时清空去重键，靠下一次轮询重试 | 窗口比 client 晚就绪时首帧会失败；只报一次错再自动补发，比让用户手动切样式可靠 |
| `rpc.on('action')` 挪到 `activate` 注册 | 0.3.2 写在 `mount` 里，没选中样式时按钮把指令发到 client 就没人接（真机排查的直接原因） |
| 兜底行号用 `position` 近似 | 宿主没有全局歌词时钟（`lyricTime` 只存在于 `FoliumStageContext`）；近似比完全不显示好，且选中样式后立刻精确 |

### 4.5 兜底路径的歌词偏移复算

宿主把歌词偏移分两处存，实际偏移是两者相加（`src/App.tsx` 里 `perSong + global`）：

- **单曲偏移**：`localStorage['lyric_timeline_offsets']`，JSON map，key 是歌曲 id，值是毫秒
  （`src/utils/lyrics/lyricOffsetMemory.ts`，缺省 0）；
- **设备偏移**：`localStorage['global_lyric_timeline_offset_ms']`，范围 ±2000ms
  （`src/stores/useLyricSettingsStore.ts` 的 `GLOBAL_LYRIC_TIMELINE_OFFSET_LIMIT_MS`）。

`src/utils/lyrics/lyricSeekTime.ts` 顶部注释写明 `lyric clock = media time + preview clip start - manual lyric offset`，
所以 `client.mjs` 的兜底路径用 `lyricTime = position - offsetSec` 找行；`mount` 路径直接用宿主时钟，不用复算。

代价与边界：这两处 key 是宿主内部实现，不是 Folium 契约；宿主改名或改格式时读到的是空/坏数据，
client 解析失败就按 0 偏移处理（不会崩，只是偏差回来）。每次轮询都读 `localStorage` 是渲染进程本地操作，成本可忽略。

### 4.6 0.3.4 悬浮窗 UI：图标、字号、排版

| 决策 | 理由 |
| --- | --- |
| 图标用内联 SVG，不用图标字体 / 网络资源 | 窗口页面是 data URL + `CSP default-src 'none'`，且不能加依赖 |
| 形状数据取自 Folia 自带的 lucide v1.48.0（ISC） | 和播放器控件同一个图标集；Play / Pause 按播放器做法用 `fill="currentColor"` 实心，其余描边 `stroke-width 2` |
| 图标 20px、按钮 32×32 | 对齐播放器 `PlayerControlSlotButton` 的 20px（小屏 18px）；32px 是稳定的点击命中区 |
| 中文提示不用原生 `title` | 原生气泡固定在指针右下方、位置不可控；改用 `data-tip` + 按钮 `::after` 气泡，固定出现在图标右上方 |
| 原文 38px、译文 / 罗马音 27px | 用户指定；`38 × 0.7 = 26.6`，向上取整为 27；译文与罗马音同字号 |
| 窗口 600×200 → 640×236 →（1.3.0）640×200 → 640×180 | 0.3.4 加三行排版时 200 高会顶到控件，所以加宽加高到 640×236；1.3.0 三行下线、只留两行，高度压回 200；随后用户要求「离顶部按钮再远一点、底部空白砍掉」，`.lyric` 加上内边距把歌词压下去、窗口再压到 180（宽度仍 640，长句靠省略号），见 §4.15 |
| 排版三态按图标字形点亮 | 图标「文A」拆成两组 SVG 子图形：都灭 = 只原文；只亮「文」= 原文 + 译文（`#7dd3fc`，按钮本身不变色）；1.3.0 起第三态只亮「A」= 原文 + 罗马音（原来「文」+「A」都亮的三行态已下线）。点一下前进一态，第三态回到第一态；当前选择存进状态文件，重启恢复 |
| 三态排版是纯显示逻辑，不改变 RPC 协议 | 点按钮后直接用最后一次快照就地重渲染；`payload` 字段不变。只有「记住这次选择」走一条本模组自己的 `my-lyric-widget:layout` IPC（页面→主进程存、下次启动主进程→页面恢复） |
| 译文 / 罗马音只来自歌词源，不生成 | `client.mjs` 的 `readLine` 直接取宿主 `line.translation` / `line.romanization`（`client.mjs:233-234`），宿主不机器翻译、也不生成拼音；纯中文歌没有罗马音时第三态第二行退回译文，译文也没有才只显示原文 |
| 音量图标只做状态指示 | 协议里没有 `toggle-mute` 动作；要能点需在 `main.cjs` 归一化里加动作，client 用 `folium.playback.setMuted?`（宿主公开面里没有 `setMuted`，只能读 `muted`） |

### 4.7 想法存档：字体大小 / 字体颜色自定义（F19，可行，本轮不做）

**结论：可行，而且不需要新增权限、不需要改 `mod.json`。** 宿主自带两套设置通道：

1. **模组自有设置区**（`FoliumSettingsSectionDef`，`contract.ts` §"The mod's own settings, shown in the mods
   panel when the mod's row is expanded. Values are readable in every context."）：注册到
   `folium.registries.settingsSections`，宿主在模组面板里渲染表单、负责持久化，**任何上下文都能读值**——
   正好适合本模组（真正渲染界面在主进程悬浮窗，不在舞台里）。
2. **visualizer def 的 `settings`**：宿主在样式选择器下方渲染表单，值随视觉配置一起导入导出；
   缺点是跟着「本样式被选中」走，没选中样式时读不到（与 F11 的诉求相冲）。

字段草案（都是宿主原生控件）：

| key | 类型 | 说明 |
| --- | --- | --- |
| `fontSize` | number，12–72，step 1 | 原文字号；译文按 0.7 倍向上取整自动算（或单独给 `translationFontSize`） |
| `textColor` | color | 原文颜色，默认 `#ffffff` |
| `translationColor` | color | 译文/罗马音颜色，默认 `#b8b8c0` |
| `lineHeight` | number，1–2，step 0.05 | 行高 |
| `showRomanization` | boolean | 是否显示罗马音副行 |

落地方式（将来）：`client.mjs` 注册 settingsSection 并读值 → 随 payload 多发一个 `typography` 字段（协议加字段，
main 侧带默认值兜底）→ `main.cjs` 把它写成窗口里的 CSS 变量（如 `--lyric-size` / `--lyric-color`）。
工作量约半天，风险点是 payload 协议变更要与旧版本 main 兼容（main 缺字段时用当前 38/27 的默认值）。

**本轮明确不做**：用户只要求把这个想法存档。

**2026-11-03 追加决定**：将来做这些自定义项时，入口固定用通道 1（`settingsSections` → 设置 → 高级 → 模组 → 展开 my-lyric-widget）；通道 2（visualizer def 的 `settings`）不再考虑，因为它跟着「本样式被选中」走，与 F11 的独立化诉求相冲（见 §4.8.5）。

### 4.8 想法存档：从「歌词样式」独立成单独功能 + 自有设置界面（F21，可行，本轮不开发）

**结论：技术上可行，且不需要新增权限；过审（官方签名）以「先行测试 beta」概率高，完整「官方认证」需要先收拾几处审查敏感点。**

#### 4.8.1 现状：已经是「半独立」

- 悬浮窗由 `main.cjs` 的 `activate` 无条件创建，跟当前选中哪个歌词样式无关；
- 0.3.3 的混合同步在 `activate` 级自驱动（`folium.every` 轮询 + 播放事件订阅），不选中本样式也会持续推数据；
- 所以「不选中样式就看不到歌词 / 按钮全失效」这个问题已经不存在了（§4.2）。

残留的三处耦合：

| 耦合 | 影响 | 去掉的代价 |
| --- | --- | --- |
| 精确歌词时钟只在 visualizer `mount` 里给 | 兜底路径只能用 `position - 歌词偏移` 近似 | 失去精确时钟：±2 秒偏移之外的补偿、预览片段起点偏差（§4.2、§4.5） |
| 「歌词样式」选择器里多一个 `mod:my-lyric-widget:lyric-widget` 条目 | 用户看到两个入口 | 删掉注册就彻底脱离样式系统，但 `mount` 精确路径一起消失 |
| 字号 / 颜色 / 窗口参数全硬编码在 `main.cjs` | 改一次就要重新打包 | 无代价，只是没做 |

#### 4.8.2 宿主允许的「独立功能」入口

`src/mods/folium/kinds.ts` 一张表列全了模组能注册的东西（同 `docs/folium/api.md`）：

| kind | 出现在哪 | 权限 |
| --- | --- | --- |
| `commands` | 模组面板 + 命令面板 | 无 |
| `settingsSections` | **设置窗口 → 模组页 → 本模组展开后的区域** | 无 |
| `playerPanelTabs` | 播放器面板的标签页 | 无（uiOnly） |
| `progressButtons` / `progressLayers` | 进度条左右 / 轨道上 | 无（uiOnly） |
| `homeTabs` | 首页导航末尾的整页（`folium.ui.openHomeTab` 打开） | 无（uiOnly） |
| `stageLayers` | 播放页图层 | 需要 `stageLayers` 权限 |

即「在主程序设置里加一个它自己的设置界面」不用自己画窗口：注册一个 `settingsSections` 就行——宿主在设置 → 模组页渲染表单、负责持久化（值存 `settings:<id>`，随视觉配置导入导出），而 `handle.settings` 在任何上下文都能读，正好让 `client.mjs` 读到再随 payload 推给悬浮窗。

真正没有官方 API 的部分是**常驻悬浮窗本身**：宿主没有「模组自己的桌面窗口」这类注册点，只能像现在这样由 `main.cjs` 自己 `new BrowserWindow`。这属于 `main` 入口的能力（主进程模组本来就有完整 Electron 权限），能用，但换宿主大版本时要自己回归。

#### 4.8.3 过审（签名）的评估

`mods/README.md`：官方认证 / 先行测试（beta）都要 Folium 签名，未签名就是「未经官方审查的第三方模组」。所以「能不能过审」= 能不能拿到一把官方签名密钥。

- **权限面小是最大优势**：现在只声明 `playback.read` + `playback.control`，没有 `net.fetch` / `net.embed` / `filesystem.data` / `render.export` / `visualizer.mode` / `stageLayers` 这些更敏感的项目；注册 `settingsSections` / `commands` 都不要权限。安全审查大概率不会卡在权限上。
- **beta 概率高**：先行测试渠道的定义就是「只通过了安全审查，不保证功能整洁」；以现状「不联网、不读盘、只读播放状态与歌词」的行为，拿到 beta 签名是合理预期。
- **官方认证（verified）需要先处理 4 个审查敏感点**：
  1. 窗口页面目前是 `nodeIntegration: true` + `contextIsolation: false`（0.3.2 为在 data URL 页面里直接 `require('electron')` 而选）。审查方通常要求改成 `preload` + `contextIsolation: true`，只暴露白名单 `ipcRenderer` 小接口；改动集中在窗口构造与页面脚本，约半天。
  2. 透明置顶窗口的行为要可解释：不抢焦点（已 `showInactive`）、可拖拽，并且要有明确的关闭 / 隐藏入口（现在没有关闭按钮，靠宿主退出）。审查可能要求补一个。
  3. 200ms 轮询的 CPU / 电量：可改成事件驱动 + 窗口不可见时暂停（挂载路径本来就是事件驱动，只有兜底路径在轮询）。
  4. 页面是 data URL + 内联脚本：CSP 已 `default-src 'none'`，但审查更偏好「本地文件 + 严格 CSP」，可评估改成 `loadFile`。
- **功能形态**（把歌词搬到桌面透明窗）不属于宿主现有概念，但 beta 渠道正是给这类实验用的；要进 verified，建议同时保留 `visualizers` 注册（选中本样式时仍是标准玩法），把独立窗口当附加能力说明。

#### 4.8.4 如果将来开发，落地清单（估算 1–2 天，不动 `mod.json`）

1. `client.mjs`：注册 `settingsSections`（`fontSize` / `textColor` / `translationColor` / `lineHeight` / `showRomanization` / `windowOpacity` / `alwaysOnTop` / `lockedPosition`，全用 `FoliumSetting` 原生控件），`handle.settings.onChange` 时把值塞进 payload 新字段（如 `ui`）；旧 `main.cjs` 缺字段时用默认值兜底。
2. `main.cjs`：硬编码字号 / 颜色改成 CSS 变量，收到 `ui` 字段就更新；`windowOpacity` / `alwaysOnTop` 走 `BrowserWindow#setOpacity` / `setAlwaysOnTop`；`commands` 注册「显示 / 隐藏悬浮歌词」「重置悬浮窗位置」，经现有 `action` 通道下发到 main。
3. 取舍先定：`visualizers` 注册保留（精确时钟）还是删除（彻底独立）。建议保留，并在样式说明里写成「（可选）精确同步」。

**本轮明确不做**：用户只要求评估并写进迭代文档。

#### 4.8.5 「设置 → 音乐 → 悬浮歌词」这种独立设置页：目前做不到，必须改宿主

用户在真机上指出更想要的形态是：设置窗口左侧「音乐」分组里、「歌词」下面再加一项「悬浮歌词」，点开是本模组自己的设置页。**红线内做不到**，原因是宿主的设置页是硬编码的：

- 左侧导航分组写在 `src/components/modal/settings/navigation/settingsNavModel.ts:50-89` 的 `SETTINGS_NAV_GROUP_SPECS`：`music` 组固定只有 `playback`（播放控制）和 `lyrics`（歌词）两项；
- 可打开的页面 id 是联合类型 `SettingsSectionId`（同文件 `:7-20`），每个 id 对应 `src/components/modal/settings/pages/` 里的一个固定组件；
- 设置搜索锚点、最近访问页也各自有一张硬编码表（`settingsAnchorModel.ts`、`settingsLastSection.ts`）；
- Folium 给模组的注册表里**没有「设置页面 / 设置分类」这一 kind**（`src/mods/folium/kinds.ts` 全表见 §4.8.2），`settingsSections` 只落在「高级 → 模组 → 展开本模组」。

要新增这样一项，最小改动是「导航表 + 新页面组件 + i18n 文案 + 搜索锚点 + 页面渲染分支」，全都属于宿主源码（红线外）；而且改宿主就离开「模组」形态了，官方签名审查也不可能接受一个改宿主的包。

红线内最接近的三条替代（都不需要新权限）：

1. `settingsSections`：设置 → 高级 → 模组 → 展开 my-lyric-widget 后出现的设置卡片（官方支持，值可跨上下文读，见 §4.7）。
2. `playerPanelTabs`：播放器面板里多一个标签页（`folium.ui.openPlayerPanel('<id>')` 打开），位置就在播放控制旁边。
3. `commands`：命令面板（Ctrl+K）与模组面板里的「悬浮歌词：显示 / 隐藏」「重置悬浮窗位置」等命令。

**2026-11-03 决定（用户确认）**：`设置 → 音乐 → 悬浮歌词` 这个独立设置页**不开发**；本模组的个性化调整（字体大小、字体颜色、行高、是否显示罗马音等，字段见 §4.7）统一走 **`settingsSections`——设置 → 高级 → 模组 → 展开 my-lyric-widget（官方标准做法）**。`playerPanelTabs` / `commands` 仅作为将来的备选入口，本轮与下一轮都不实现。若以后仍想要「音乐」组里的一级入口，只能给上游提 feature request 增加 `settingsPages` 类注册点，或自己维护宿主分支（红线外，且失去官方签名可能）。

**本轮明确不做**：用户只要求评估并写进迭代文档。

### 4.9 1.0.0：独立常驻重构（F26，已上线）

**目标**：把模组从「一种歌词样式」变成「一个常驻功能」——只要模组启用，无论播放器当前用哪种内置
歌词样式，悬浮窗都能正常显示与操作。0.3.3 的混合同步仍保留着 visualizer 注册（为了拿到 `ctx` 的
精确行号），1.0.0 把这层依赖整个去掉。

**改动范围**：只改 `client.mjs`；`main.cjs` 一行未动（它在更早的版本里就已经是「activate 时直接建窗」）。

**client.mjs 的新结构**：

| 组成部分 | 做法 |
| --- | --- |
| 是否工作 | `activate` 里直接常驻；不再 `registries.visualizers.register`，也不再实现 `mount` |
| 行号来源 | `folium.playback.getState().position` 减用户歌词偏移，再与 `folium.lyrics.getLines()` 的 `startTime` / `endTime` 自行比对（`findApproximateLineIndex`） |
| 驱动方式 | `folium.every(100, ...)` 自主轮询 + `playback.*` / `lyrics.loaded` / `theme.changed` 事件即时触发 |
| 主题 | 宿主没有全局主题读取接口，只能靠 `theme.changed` 缓存；事件来之前 payload 的 `theme` 为 `null`，`main.cjs` 用默认样式兜底 |
| 去重 | 内容快照做 key（`position` 固定为 0 不参与），同一行每秒最多发一次 IPC |
| 按钮指令 | `folium.rpc.on('action', ...)` 在 activate 里注册一次，与「选中哪个样式」彻底解耦 |
| 旧选择残留 | activate 时只清理 `visualizer_mode` 里 `mod:my-lyric-widget:` 前缀的那一条，其它值不碰 |

**为什么 `main.cjs` 不用改**：它在 `activate` 里就 `state.win = createWidgetWindow()`，页面初始文本
本来就是 `WAITING_TEXT = '等待播放...'`，所以「窗口随 mount 创建 / 首次数据前白屏」这两点在 0.3.x 里
就不存在；`main.cjs` 里也没有任何 `visualizer` / `ctx` / `mount` 引用。

**用户提到但我们没有的代码**：`folium.registries.progressButtons.register` 在本模组里从未出现过
（`grep` 两个文件均无命中）。底部那排「上一首 / 播放暂停 / 下一首 / 循环 / 音量」是 `main.cjs`
里手写的 `WIDGET_HTML` 控件，不走宿主注册表，因此本次重构不影响它们，也没有可保留的注册代码。

**代价（仍然存在）**：
- 行号精度受「预览片段」影响：从歌曲中间播放时，播放位置与歌词时钟差一个片段起点，宿主没有暴露；
  整首播放没有这个问题（见 §4.2、§8）；
- 用户手动歌词偏移已由 client 自己复算（§4.5），延后 5 秒悬浮窗也延后 5 秒；
- 去掉了 visualizer 注册后，播放器「歌词样式」列表里不再出现「悬浮歌词」；旧选中值会被自动清理。

### 4.10 1.0.1：任务栏遮挡（F27，已上线）

**现象**：把悬浮窗拖到任务栏上（想多用那一条横向空间）时，歌词会被任务栏切掉一部分。

**根因**：Windows 的任务栏自己也是置顶（topmost）窗口，而置顶层只有**一层**——层内顺序按激活先后排。
悬浮窗用 `alwaysOnTop: true` 建窗、`showInactive()` 显示，建窗那一刻确实在任务栏之上，但之后只要用户点一下
任务栏（开始菜单、任务按钮、托盘都算），任务栏就排到悬浮窗前面，之后再也不会自己让开；拖动、切换应用后同样会被盖住。
`alwaysOnTop` 的第二个参数 `level`（`'screen-saver'` 等）只在 macOS 生效，Windows 下被忽略，加 level 解决不了。

**做法（`main.cjs`）**：

| 组成 | 做法 |
| --- | --- |
| 任务栏矩形 | `getTaskbarBands(display)`：显示器 `bounds` 减去 `workArea` 剩下的那几条边就是任务栏占的地方（四条边都算，任务栏可以在上/下/左/右；自动隐藏时两者相等，返回空） |
| 是否需要让开 | `overlapsTaskbar(windowBounds)`：窗口矩形和任一任务栏矩形至少重叠 `MIN_TASKBAR_OVERLAP = 8` 像素（`overlapSize` 取重叠矩形的较短边长）才算。透明窗口边缘压线 1px 不该让它长期抢占置顶层 |
| 何时生效 | 只在 Windows 上开（`process.platform !== 'win32'` 返回空实现）：macOS / Linux 的「`bounds` 减去 `workArea`」是菜单栏 / Dock / 面板，不是同一个问题，保持原行为 |
| 让开动作 | `startTaskbarGuard` 每 `TASKBAR_GUARD_MS = 500` 检查一次，命中时先补 `setAlwaysOnTop(true, 'screen-saver')`（防宿主把置顶改掉），再 `moveTop()`——它在 Windows 上是 `SetWindowPos(hwnd, HWND_TOP, …, SWP_NOACTIVATE \| SWP_NOMOVE \| SWP_NOSIZE)`，把窗口提到置顶层顶部，不抢焦点、不改大小；「恢复的坐标正好压在任务栏上」时由 `ready-to-show` 里的 `guard.tick()` 立刻提升，不等第一次轮询 |
| 副作用控制 | 窗口**没压到任务栏时一次都不调**；每次「从没压住变成压住」只记一条 info 日志，中间不刷屏 |
| 位置恢复 | `isPositionUsable()` 在 Windows 上按显示器 `bounds` 判断（留同样的 40/20px 余量），否则「停在任务栏上」的坐标会被判失效、重启后弹回默认位置；macOS / Linux 仍按 `workArea`，避免把窗口恢复成「藏在菜单栏 / Dock 后面」 |

**仍然存在的行为**：

- 窗口压在任务栏上时，它下面那一块任务栏按钮点不到（整窗穿透不做；1.2.0 起**锁定态**只有解锁按钮可点、
  其余部分穿透，见 §4.12；未锁定时仍然整窗挡点击）；
- 因为置顶层只有一层，压在任务栏上的那段时间里窗口也在**所有置顶窗口**之上（含开始菜单、通知中心 / 日历、
  任务栏缩略图预览）：用户点开这些界面后，最多约 0.5 秒窗口会重新回到最前面，并在 640×236 矩形内挡住它们。
  这是「盖过任务栏」的必然代价，没有「只盖任务栏、不盖开始菜单」的 Windows 公开接口；
- 任务栏**自动隐藏**时 `workArea == bounds`，守卫不工作：那时任务栏本来也不会长时间占着屏幕，弹出时短暂盖住窗口属预期。

### 4.11 1.1.0：顶部控制条改版（F28，已上线）

**用户要求**：删掉原来显示歌曲名的那一行；把全部功能按键移到窗口上方；固定键放正中间，锁定时变成更明显的「取消锁定」按钮。
做完第一版（带「取消锁定」文字胶囊）后用户追加要求：**锁定时只显示按钮、不要文字**，遂改成纯图标高亮按钮。

**做法（全在 `main.cjs` 的 `WIDGET_HTML` 里）**：

| 组成 | 做法 | 理由 |
| --- | --- | --- |
| 删歌曲行 | 删 `.song` 的 CSS、`<div class="song">`、`els.song` 与 render 里的写入 | 用户明确不要；`payload.song` 仍在协议里，将来要显示随时能加回 |
| 控制条位置 | `.controls` 改成 `position:absolute; top:10px; left:16px; right:16px`、`padding-bottom:6px`，不占文档流 | 若占流，歌词会被整体下移；绝对定位后歌词仍在窗口垂直正中 |
| 固定键居中 | `.controls` = flex，左右各一个 `.controls-side{flex:1}` 夹住 `#pin` | 两侧宽度自适应，`#pin` 严格落在 320px 中线上，不靠手调 margin |
| 锁定更明显 | `#pin[data-mode="pinned"]` 变成 32×32 高亮图标按钮（深底 `rgba(8,22,36,.72)`、`#7dd3fc` 描边、`0 2px 12px` 外发光），图标换成 `pin-off`，颜色 `#bfe9ff` | 原来只是一个变蓝的图钉图标，用户看不出能点；固定态窗口底只有 `.14` 黑，浅色壁纸上浅蓝图标读不清，所以按钮自带深底 |
| 不带文字 | 不做可见文字标签，「取消锁定」只写在悬停气泡（`data-tip`）和 `aria-label` 里 | 用户 2026-11-05 追加要求「只显示按钮」；第一版用 `::before` 生成文字胶囊，改动时整条删掉，`::before`/`order` 相关规则一并移除 |
| 固定后只留它 | `body.pinned .controls-side{visibility:hidden}`、`#pin` 悬停才显形（`:focus-visible` 也显形，键盘用户 Tab 过来不至于对着看不见的按钮按回车） | 固定状态要「只留解锁入口」，两侧按钮不该再被误点 |
| 删右上角解锁 | 删除 `#unlock` 的 CSS / 元素 / 事件，`#pin` 单击改为切换 `isPinned` | 两套解锁入口容易不同步；现在只有一个 |
| 气泡 | 从向上弹改向下弹，并补 `transform:translateX(-50%)` 真正居中 | 控制条在顶部，向上会被窗口上沿裁掉；原来只写 `left:50%`，气泡是「左边贴按钮中心」向右铺的 |

**几何余量（别乱调大字号）**：1.3.0 起窗口 640×180，内容区 158px（`.widget` 上 12 / 下 10），`.lyric` 里再留
33px 上内边距（把歌词往下压，见 §4.15），剩下 125px 装两行（原文 38px→47.5px + 次行 27px→35.1px + 4px 间隙 ≈ 86.6px）。
两行居中后首行盒顶 ≈ 64px，底部余量 ≈ 29px；控制条底边 = 1 + 10 + 32 + 6 + 1 = 50px，**首行离控制条约 14px**。
单行排版时首行盒顶 ≈ 84px、底部约 49px（窗口是透明的，静态时只有文字可见）。
任何字号 / 行高 / 按钮高度上调都会挤掉这 14px，改之前先按这个式子算一遍（要加第三行就必须把 `WINDOW_HEIGHT` 加回去，见 §4.15）。

**仍然存在的行为**：锁定后两侧按钮不是 `display:none` 而是 `visibility:hidden`（保留布局，`#pin` 不会因两侧收缩而偏移）；
未锁定时整条控制条仍然只在悬停时出现（`.widget` 默认透明，看不到按钮）；拖动仍靠整窗 `-webkit-app-region: drag`，按钮 `no-drag`。

### 4.12 1.2.0：部分点击穿透（F29，已上线）

**需求（用户 2026-11-05）**：锁定后只有「取消锁定」按钮接收鼠标，其余位置（含歌词显示区）都能把点击穿透给下方应用。

**评估阶段的方案对比（保留，结论选 B）**：

| 方案 | 做法 | 评价 |
| --- | --- | --- |
| A. 整窗 `setIgnoreMouseEvents(true,{forward:true})` + 页面自己判断光标是否在按钮里 | 穿透时仍收到 `mousemove`，命中按钮就回调主进程临时关掉忽略 | 最省事，但「临时关掉」到真正接到 `mousedown` 之间有几毫秒窗口，快速划过时可能点空；且必须处理 `mouseleave` 漏事件，否则窗口会永久卡在「可点」状态 |
| B. 主进程轮询光标 + 只按按钮矩形开关忽略 | 复用现有 80ms 光标轮询；光标进入按钮屏幕矩形 → `setIgnoreMouseEvents(false)`，离开 → `true` | 不依赖页面事件，逻辑集中、好测；代价是最多 80ms 的「刚进入按钮还没放开」 |
| C. 把「取消锁定」拆成独立小窗口（大窗口全程穿透） | 两个 `BrowserWindow`，小窗口只放按钮 | 行为最干净，但要同步两个窗口的位置/层级/生命周期/任务栏守卫，复杂度最高 |
| D. `setShape()` 在窗口上挖洞 | 用 4 个矩形绕出按钮位置的洞 | **不可行**：洞外的按钮不再渲染，按钮会直接消失 |

**最终实现（方案 B，`main.cjs` 约 90 行含注释）**：

| 环节 | 做法 |
| --- | --- |
| 页面报矩形 | 固定 / 解锁、窗口 `resize` 时报新通道 `my-lyric-widget:pin-rect`（`#pin` 的 `getBoundingClientRect()`，CSS 像素、相对内容区）。控制条有 0.18s 的 transform 过渡，切换后 260ms 再补报一次最终位置；`width/height <= 0` 不报 |
| 主进程判定 | 复用 80ms 的光标轮询：`state.pinned && pinRect && 光标不在按钮矩形（外扩 `PIN_HIT_PADDING=2`px）` → `setIgnoreMouseEvents(true, { forward: true })`，否则 `false`；只在值变化时调用。命中用 `getContentBounds()`（内容区），和页面报上来的 CSS 像素同源 |
| 状态同步 | 页面 `IPC_PINNED` → 记进 `state.pinned` 并立刻调一次 `hoverTick()`（不等下一次 80ms）；窗口重建时 `did-finish-load` 同步；窗口 `closed` 清空 `pinRect` |
| 失败兜底 | ① 没收到矩形 / 矩形非法时 `pinRect=null`、整窗保持可点（宁可挡一下，也别让人解不开锁）；② `setIgnoreMouseEvents` 调用成功才记 `lastIgnore`，失败时置空，下一轮真的重试；③ 轮询一次异常（显示器热插拔 / 会话切换 / 销毁竞态）不清空一切：先 `setIgnoreMouseEvents(false)` fail-open、提醒页面把按钮显出来，再继续轮询（连续失败约 8 秒才停） |
| 页面不放第二道门 | 固定态 `#pin` 常驻 `pointer-events:auto`，`hover` 只控制透明度；能否点到由主进程几何命中决定，避免「窗口放行了、页面却把按钮设成不可点」；固定态 `blur` 不再清 hover（否则按钮消失、主进程又不会再补发 hover） |
| 悬停 | 悬停仍由主进程轮询推 `IPC_HOVER`，所以穿透状态下页面照样能显示解锁按钮 |

**仍然存在的行为**：命中判定最多有 80ms 延迟（极快划入按钮就点，第一下可能落到下方应用）；按钮四周 2px 也算命中；未锁定时整窗照旧接收鼠标（不做穿透），拖动、按钮、音量条行为不变。
**真机待验**：`setIgnoreMouseEvents(true,{forward:true})` 在 Win11 上是否让远处窗口的悬停状态正确复位；`devicePixelRatio` 不是 1 的显示器上矩形是否需要换算（当前按 CSS 像素直接用，`useContentSize` 下 1 CSS px = 1 DIP，主进程 `getBounds()` 也是 DIP，理论上一致）。

### 4.13 阴影调查结论 + 穿透示意（调查；部分结论已在 1.2.0 处理，见 §4.14）

**「歌词这一块有背景阴影」的结论：是设计，不是 bug。** 除了固定胶囊自身那圈淡蓝外发光
（`#pin[data-mode="pinned"]{box-shadow:0 2px 12px rgba(125,211,252,.28)}`，提示「这里能点」）之外，页面没有任何块级
`box-shadow` / `filter`；窗口 `hasShadow: false`、`backgroundColor: '#00000000'`。肉眼看到的「阴影」只有三处，都是有意为之：

| 现象 | 来源 | 性质 |
| --- | --- | --- |
| 歌词文字周围一圈发暗、发虚 | `.lyric-text/.lyric-trans/.lyric-sub` 的 `text-shadow: 0 1px 2px rgba(0,0,0,.9), 0 2px 12px rgba(0,0,0,.6)` 等 | 设计：壁纸可能是纯白，歌词要自带描边才读得清 |
| 悬停时整块变暗 | `body.hover:not(.pinned) .widget{background:rgba(0,0,0,.58)}`（固定态 1.2.0 起改为完全透明，见 §4.14） | 设计：给按钮和文字一个可读的玻璃底 |
| 气泡下面一小片阴影 | `button::after{box-shadow:0 4px 14px rgba(0,0,0,.45)}` | 设计：气泡的浮起感 |

如果看到的是**窗口矩形四周**的一圈灰边/残影，那不是页面画的，是 Windows 11 给无边框窗口加的系统阴影/圆角描边
（`hasShadow:false` 拦不住 DWM 那一圈）——1.2.0 已改成 `roundedCorners:false` + `thickFrame:false`，是否真的
把那一圈去干净要等真机确认（Electron 文档只承诺去掉 shadow 与窗口动画，「连圆角描边一起去掉」是推断），见 §4.14。

**穿透示意**（锁定态；绘图时窗口还是 640×236，1.3.0 起高度先改 200、再改 180，比例略有差异，交互区域不变）：见
`docs/click-through-plan.svg`（浏览器直接打开即可；同样内容另存了一份位图在工作区 `mod-preview/click-through-plan.png`）。
要点：整个窗口矩形都是穿透区，只有正中那颗「取消锁定」按钮（32×32）恢复成可点；锁定后两侧按钮隐藏、也在穿透区内。
（示意图画的是带文字的胶囊版，1.1.0 最终版已去掉文字，尺寸按 32×32 计。）

### 4.14 1.2.0：去掉窗口四周系统阴影 / 描边（F30，已上线，等真机确认）

**现象**：透明窗口矩形四周一圈灰边/残影；固定态悬停时整块还有半透明底 + 细描边。

**做法**：

| 位置 | 改动 | 理由 |
| --- | --- | --- |
| 窗口选项 | 加 `roundedCorners: false` | Win11 会给无边框窗口画圆角，那圈灰边是圆角的副产品；关掉圆角才是根治 |
| 窗口选项 | 加 `thickFrame: false` | Electron 文档：`thickFrame:false` 会「remove window shadow and window animations」；能否连 DWM 描边一起去掉属推断，等真机确认 |
| 页面 | `body.hover.pinned .widget` 的 `background` / `border-color` 改成 `transparent` | 用户要求「固定时悬停只显示解锁按钮、没有阴影背景和边框描边」 |

**代价**：`thickFrame:false` 同时关掉窗口动画与「拖边缘缩放」（本来就是 `resizable:false`，无影响）；`hasShadow:false` 保留；未固定态悬停的玻璃底不受影响。
**真机待验**：圆角位置是否还有 1px 描边；整窗拖拽（`-webkit-app-region: drag`）是否仍正常——`thickFrame:false` 理论上不影响拖拽，但要真机确认一次。

### 4.15 1.3.0：排版第三态改成「原文 + 罗马音」、三行下线、窗口压到 180 高（F31，已上线，等真机确认）

**需求（用户 2026-11-05）**：
1. 前两态**完全不变**：都灭 = 只原文；只亮「文」= 原文 + 译文；
2. 第三态不再是「文 + A 都亮（三行）」，改成**只亮「A」= 原文 + 罗马音**，且「有罗马音就只显示罗马音，不要多一行」；
3. 罗马音**缺失时第二行回退成译文**（译文也没有就整行隐藏）；
4. 三行排版不再需要：直接去掉，或者在代码里注释掉以便将来恢复；
5. 只剩两行之后窗口高度压缩。

**做法**：

| 位置 | 改动 | 理由 |
| --- | --- | --- |
| `LAYOUT_MODE_IDS` / `LAYOUT_MODES` | 第三项 `full` → `roman` | 语义变了（不再是「全部」），旧 id 复用会误导 |
| 老存档兼容 | 新增 `LEGACY_LAYOUT_IDS = { full: 'roman' }`，`did-finish-load` 恢复排版时先映射 | 不改的话升级后老用户存的 `full` 通不过校验，排版静默退回「只原文」 |
| 图标高亮 CSS | 删掉 `[data-mode="full"]` 双亮规则，新增 `[data-mode="roman"] .icon-a{color:#7dd3fc}` | 第三态只亮「A」，与前两态（都不亮 / 只亮「文」）一眼可分 |
| `render()` | 第二行改成单槽位 `secondLine`：`text-trans` → 译文；`roman` → 罗马音，缺省回退译文；`text` → 空 | 用户要求第二行只放一行，罗马音优先、缺失时退回译文 |
| 第三行 | `els.sub.textContent = ''` 恒空，保留 `.lyric-sub` 元素与样式，注释写明恢复步骤 | 用户要求「删掉或注释掉，以后要了再开回来」；保留 DOM 与样式 = 恢复只需改 3 处 |
| 窗口 | `WINDOW_HEIGHT` 236 → 200，随后按「底部空白太多」再压到 180（宽度仍 640） | 两行不需要三行的高度；180 时底部只剩约 29px；顺带把文件头注释、`placeWindow`、恢复校验一起对齐 |
| 垂直排布 | `.lyric` 加 `padding: 33px 0 0`（仍是 `justify-content:center`） | 顶部控制条是绝对定位浮层、不占布局，只能靠内边距把歌词整块往下压，才能做到「离按钮更远、底部更少」 |

**几何验算**：内容区 180−22＝158px；`.lyric` 再让出 33px 上内边距，剩 125px 装两行 = 47.5 + 4 + 35.1 ≈ 86.6px，
居中后首行盒顶 ≈ 64px（控制条底边 50px，余量 ≈ 14px），底部余量 ≈ 29px；单行态首行盒顶 ≈ 84px（见 §4.11 的几何段）。

**仍然存在的行为**：`roman` 态里如果这一行有译文也有罗马音，只显示罗马音（用户明确要求「不要多一行」）；
一行内的译文/罗马音仍然只来自歌词源（不做机器翻译、不做拼音生成）；第三行元素还在 DOM 里但恒空，`display:none`；
窗口变小后长句仍然 `nowrap + ellipsis`，不换行。

**真机待验**：两行在 180 高里的真实留白与观感（首行离控制条约 14px、底部约 29px 是否合适）；三种态切换时第二行文字变化是否即时；老存档（`layout: "full"`）升级后是否落在 `roman`；
125%/150% 缩放下 180 高是否仍有余量；窗口变矮后默认落点（工作区底部居中）与任务栏守卫是否正常。

### 4.16 1.4.0：播放条「词」开关 + 窗口右上角 ✕ 关闭（F32，已上线，等真机确认）

**需求（用户 2026-11-06）**：
1. 「用词这个字，放的位置和 enhanced-remote-widget 一致」——播放控制条上一个汉字「词」按钮，切换桌面悬浮窗的显示 / 隐藏；
2. 「桌面显示了图标就高亮」——窗口可见时按钮高亮；
3. 「显示窗口里面加一个关闭功能，图标就用一个 ×，点击后悬浮窗歌词关闭但是模组还在启用，位置放到窗口的右上角」。

**做法**：

| 位置 | 改动 | 理由 |
| --- | --- | --- |
| `client.mjs` 按钮 | `folium.registries.progressButtons.register({ id:'lyric-widget-toggle', slot:'progress.trailing', order:480, mount })` | 与 enhanced-remote-widget 的实现一致（同 slot、同 order），落在进度条右侧那组小按钮里；注意宿主 `byOrder` 在 order 相同时按 `id.localeCompare` 排，`my-lyric-widget:` 在 `enhanced-remote-widget:` 之后，所以两者都装时本模组的「词」排在它右边 |
| 按钮外观 | 1.4.0–1.4.1：24×24、`margin:0 1px`、`border-radius:6`、`font-size:13`、`font-weight:500`、`color: inherit` + `opacity:.66`、`data-on="true"` 时蓝字 `#7dd3fc` + 淡蓝底 + 淡蓝描边。**1.4.2 起改成宿主原生造型**（见下一行） | 宿主挂载容器带 `all: initial`，字体 / 颜色 / 背景必须自己写；`var(--folium-font, inherit)` 在没有 `theme` 时会落到系统默认字体，所以写成和悬浮窗页面同一套确定字体栈 |
| 按钮外观（1.4.2，原生风） | 22×22、`margin:0 2px`、`border-radius:50%`、`border:none`、`font-size:12`、常态 `opacity:.4`；hover `opacity:1` + `color-mix(in srgb, currentColor 10%, transparent)` 底；`data-on="true"` → `currentColor 20%` 底 + `opacity:1`（hover 28%）；焦点环也用 `currentColor` | 对齐 `PlayerControlSlotButton.tsx`：常态 `opacity-40` 无边框无底色、hover `bg-white/10`、开启态 `bg-white/20`；`color-mix(currentColor …)` 让深色主题下是白底、浅色主题下自动变黑底，和宿主 `bg-white/10` / `bg-black/5` 的判断等价，不用模组自己猜主题。用户原话「有一点点突出」指的就是原来那个蓝框 chip 比旁边 10px 时间、6px 轨道都高、都亮 |
| 收起态（1.4.2） | `register` 里加 `hideWhenCollapsed: true`；宿主按 `collapsed && entry.def.hideWhenCollapsed` 整条剔除 | 用户决定「收起态不保留功能」：收起态只在那条窄胶囊里露一个小按钮、鼠标已经离开控制条，基本点不到，留着只会显得突出；展开态与 Lattice 里照常出现。注意收起态原本是**可点**的（`ProgressBar.tsx` 始终渲染 `FoliumProgressButtons`），是这一行主动放弃的 |
| 样式注入（1.4.1） | `mount` 里先 `mountStyle(container.getRootNode())` 再塞按钮；target 优先用根节点（ShadowRoot），拿不到才退回 `document.head` | **宿主把 `progressButtons` 挂进 ShadowRoot**（`runtime/FoliumMountHost.tsx` 对 `shadow` 条目 `attachShadow` + `replaceChildren`），挂在 `document.head` 的 `<style>` 根本进不去，按钮会退化成浏览器默认的白底黑字方框——1.4.0 的「很丑 / 永远同一个样子」就是这个原因 |
| 按钮状态 | `registerWidgetToggleButton()` 内部维护 `visible`，`paint()` 只改 `data-on` / `aria-pressed` / `title`；返回 `{ setVisible, dispose }` | 宿主只按 `mount` 渲染一次（`registries/progress.tsx` 不重渲染），所以状态必须自己写进 DOM；`dispose()` 在 `activate` 的 disposer 里退注册项并从注入的根节点（ShadowRoot）移除 `<style>`，免得热重载把样式堆起来 |
| 首帧对齐（1.4.1） | 新增 `widget-state` RPC：`api.rpc.handle('widget-state', () => ({ visible: state.widgetOpen }))`；client 激活后 `folium.rpc.call('widget-state')` 取一次真值 `setVisible()`，rejected 静默 | 主进程 activate 里的首帧 `widget-visibility` 可能早于 client 注册监听（推给空气），`reportedOpen` 又已记为已推、不再补发，按钮就会一直停在灰态——这正是用户看到的「无论窗口有没有显示它都是这个样子」 |
| 点击 | 先本地翻转 → `folium.rpc.call('toggle-widget')` → 返回 `{visible}` 对齐；`rpc.call` 同步抛错或 Promise 拒绝都回滚到点击前的值 | 点下去立刻有反馈，真值仍以主进程为准 |
| 状态回推 | `api.rpc.send('widget-visibility', { visible })`，只在变化时推，且**只在 `setWidgetOpen()` 里推一次**；去重键 `state.reportedOpen` 只在 send **成功返回后**才更新；client 在 `activate` 里订阅 | 状态变化可能来自主进程（比如页面上的 ×），按钮要跟着变；推两遍只是白跑 IPC（审查提醒过，别再在 `rpc.handle` 里补 force）；send 失败（client 监听没挂上 / 抛错）时保留旧键，下一次 `update-data` 自动重推 |
| main 显隐 | `state.widgetOpen` + `setWidgetOpen(open)`；显示 `showInactive()`、隐藏 `hide()`；窗口已被销毁且要显示则 `ensureWidgetWindow()` | 隐藏只是不显示窗口，模组本身照常运行 |
| 隐藏期间 | `sendPayloadToWindow()` 首行 `if (!state.widgetOpen) return;`；`ensureWidgetWindow()` 同样短路；`ready-to-show` 只在 `widgetOpen` 时 `showInactive()` | 别让下一条数据把窗口「复活」，也别白建窗口 |
| 持久化 | 状态文件新增 `open`（`persistWidgetOpen` 写内存后走 `scheduleSave()` 防抖落盘） | 老存档没有这个字段时按「显示」处理，升级后行为不变；用户关掉后重启仍是关着；防抖和其他落盘路径一致，`dispose` / `cleanupWidgetWindow` 会同步补写 |
| 窗口内 × | 页面新增 `#close`（`position:absolute; top:10px; right:16px; z-index:3`），`opacity:0` + `pointer-events:none`，`body.hover #close` / `body.pinned.hover #close` / `:focus-visible` 才显示并接事件；点击 `ipcRenderer.send('my-lyric-widget:close')` | 和已有的悬停显隐一致，静态时不打扰画面；不悬停时不仅透明也不接点击，免得变成看不见的点击陷阱（它正好压在固定态隐藏的循环/排版/音量单按钮位置上） |
| × 与音量百分比（1.4.1） | `body.hover:not(.pinned) .controls-side.right { padding-right: 44px }`（关闭按钮 32px + 12px 间距） | 两者同为 `top:10`、`right:16`，悬停时百分比正好压在 × 下面；只给右侧这一组让出内边距、不动 `.controls` 的盒子，固定键仍然严格居中 |
| main 收 × | `onCloseFromWindow` 校验 `event.sender === state.win.webContents` → `setWidgetOpen(false)`；`dispose` 里 `removeListener`；debug 日志通道也补了同一套 sender 校验 | 只认自己窗口发来的关闭，别的 webContents 不可信 |
| 固定态 | `body.pinned .controls { visibility:hidden; pointer-events:none }` + `body.pinned .controls-side { visibility:hidden; pointer-events:none }` + `body.pinned #pin { visibility:visible; pointer-events:auto }` | 1.1.0 起固定态本来是靠 `.controls-side` 的 `visibility:hidden` 藏两侧按钮、`.controls` 自身一直 `opacity:1`；本轮把「藏」提到 `.controls` 层并显式断掉点击，`#pin` 单独放回来，保证固定态仍能解锁、也能点 ×（`#close` 不在控制条里，不受影响） |

**仍然存在的行为**：× 只在悬停时出现（锁定态也是悬停才出现），不悬停时既不显示也不接点击；点 × 后没有任何提示，靠播放条的「词」按钮变灰来反映状态；
隐藏期间模组仍在运行（继续轮询播放状态、继续收 payload），只是不画窗口；`skipTaskbar:true`，任务栏看不到入口，
想再打开只能用播放条上的「词」按钮。

**窗口被销毁但状态仍是「开」**：宿主主窗口全关时 `closeWidgetWindow()` 只销毁悬浮窗、不动 `widgetOpen` / `open`，
所以播放条的「词」按钮仍高亮；下次有 `update-data`（或宿主窗口重开后）会走 `ensureWidgetWindow()` 重新建窗，
新页面先显示占位符「等待播放...」，等下一份数据到达才恢复歌词。

**1.4.1 修订（用户 2026-11-06 真机回归报的三个问题）**：
1. 「窗口的关闭键和音量的百分比显示重叠」→ 右侧组在「悬停且未固定」时让出 44px 内边距（只动这一组，不动 `.controls`）。
2. 「词这个图标很突兀和丑」→ 1.4.0 的 `<style>` 挂在 `document.head`，而宿主把按钮挂在 ShadowRoot 里，样式根本没生效，按钮是浏览器默认的白底黑字方框；改成往按钮所在的根节点注入样式，按钮回到 24×24、继承播放条文字色、未开时 66% 透明度。
3. 「无论窗口有没有显示它都是这个样子的」→ 同一个根因（样式没生效，两态看不出差别）；另外补了 `widget-state` RPC，让按钮在 client 激活后主动取一次真值，不再依赖可能已经错过的首帧推送。

**1.4.2 修订（用户 2026-11-06：按钮在收起态「有一点点突出」）**：
1. 外观从蓝框 chip 改成宿主原生风：22×22 圆形、无描边、常态 40% 透明、hover / 开启态都用 `color-mix(currentColor …)` 同色底，不再用 `#7dd3fc` 强调色；
2. 收起态不挂载（`hideWhenCollapsed: true`）——用户明确「收起态不保留功能，正常点不到的」；
3. `main.cjs` 未改动、IPC 契约未变，只是 `client.mjs` 的注册项与样式常量。

**真机待验**：「词」按钮在进度条右侧的位置与 enhanced-remote-widget 是否真的挨在一起（两者同 slot 同 order 480，
宿主按 `id.localeCompare` 排在 enhanced-remote-widget 之后）、蓝 / 灰两态是否够明显、`hideWhenCollapsed` 后收起态里是否彻底不出现；
「词」字与胶囊字体是否一致；点按钮与点 × 的显隐是否即时、有无闪烁；隐藏期间切歌 / 暂停是否不再弹窗；重启宿主后隐藏状态是否保持；
固定态静止时 × 与隐藏的循环/排版/音量按钮几何重叠，点击归属是否正确（× 不悬停不接事件）；
固定态下悬停能否只出现 × 和「取消锁定」两个按钮；`order: 480` 与其他模组按钮的排序是否冲突；
1.4.1：悬停时音量百分比右侧空出约 44px 是否自然、× 在 ShadowRoot 内的 hover 底色是否正常；
1.4.2：22px 圆形「词」和旁边图标是否同一视觉重量、常态 40% 透明是否够淡、开启态 20% 同色底是否看得出来、浅色主题下 `color-mix(currentColor)` 是否变成深底。

### 4.17 1.5.0：设置表单、字号 / 形态 / 逐字 / 字体 / 外观、命令面板、1.6 兼容（F33–F35，已上线，等真机确认）

**需求来源**：用户对照 amll-desktop-lyric 后拍板（m03412）——字号 20–50 下拉（步进 1、默认 38）、
窗口形态三态（双行默认 / 单行 / 歌词板，后者「当前句高亮、下一句淡」）、逐字歌词只做「已唱染色 / 未唱变淡」、
外观自定义全做、字体先做两项并留扩展位、命令面板入口、写 1.6 兼容层；硬前提是**不能改变现有默认观感**。

**做法**

| 项 | 做法 | 为什么 |
| --- | --- | --- |
| 配置真源 | 宿主的 `settingsSections`（设置 → 高级 → 模组 → 独立悬浮歌词）声明表单，宿主持久化；`onChange` 时 `folium.rpc.call('config', cfg)` 推给 main | client 不另存一份配置，避免两边互相覆盖 |
| 校验 | main 的 `normalizeConfig()` 兜底：字号 clamp 20–50、圆角 0–28、`surfaceOpacity` clamp 0.2–1、`sungColor` 接受 `#rgb` 并展开成 `#rrggbb`、枚举不合法回落默认 | 设置值来自宿主存储，可能是旧版本写的脏值 |
| 文案 | 所有 `label` / `description` / `group` / `options[].label` / 命令 `label` 都是**语言映射**（`{ 'zh-CN': …, en: … }`，`FoliumLabel = Record<language, string>`），不是字符串 | 宿主对非对象的 label 直接置空、界面回落成 `fontSize` / `double` 这类 key 名；`folium:check` 查不出这一层 |
| 窗口高度 | `windowHeightFor(config) = round(55 + block × 1.4435)`，`block` = 主行 1.25×字号 + 副行 0.71×1.3×字号 + 4px gap（单行只算主行）；`setSize` 后按 `workArea` 上移保持底边不动 | 38px 双行算出 180，与 1.4.2 手调的高度完全一致，默认观感不变 |
| 页面样式 | 全部走 CSS 变量（`--lyric-size` / `--trans-size` / `--widget-radius` / `--surface-alpha` / `--border-alpha` / `--sung-color` / `--unsung-opacity`）+ body 上的 `data-mode`、`data-surface`、`data-backdrop`、`data-paused-dim`、`data-playback` 属性 | 渲染逻辑不用到处写 if；变量默认值就是旧样式 |
| 逐字 | client 透传 `line.words`（收窄成 `{text,startTime}`）；页面按 `text+JSON(words)` 做 key 重建 `<span class="word">`，rAF 外推 `position + (now - startedAt)`，`time >= startTime` 加 `sung`；`visibilitychange` 隐藏时 `stopKaraoke()` | 宿主只给 100ms 一次的位置，逐字必须自己外推；窗口被 × 隐藏后不再收数据帧，不停 rAF 就会 60fps 空转（`backgroundThrottling:false`） |
| 歌词板 | 当前句用 `#line`（正常白字），下一句复用 `#trans`（50% 白、下沉 6px）；单行形态把第二行整块 `display:none` | 复用已有两行结构，不动窗口布局 |
| 字体 | `fontMode`：`system` / `theme`；页面在 `applyConfig` 里选字体栈（`system` = 系统无衬线栈，`theme` = `payload.theme.fontStack`） | 用户要「先两项、留接口」——新增字体只需在这个下拉里加 option |
| 命令面板 | `folium.registries.commands.register` 四条：显示/隐藏、锁定/解锁、字号 ±1；`globalShortcut` 只在 `host.folium.minor >= 7` 时加 | 1.6 的 `commands.register` 没有这个能力（宿主对未知字段是忽略而非报错，这里按 minor 判断更直白） |
| 1.6 兼容 | main 在 `typeof api.rpc.send !== 'function'` 时把消息塞进 `state.pendingCommands`（上限 32，超出丢最旧），**可见性消息只在 `take-commands` 取走时才记「已推」**；`widget-state` 返回 `canSend`，client 按它决定要不要起 150ms 轮询 | 1.6 没有主进程→client 的推送通道；不补这层，老宿主上显示/隐藏按钮永远不变灰。记账放在送达时刻，队列被挤掉时下次还会重发 |

**仍然存在的行为**

1. 设置表单在宿主「高级 → 模组」里，不在播放器的播放页设置里——这是宿主的模组设置面板，不是自绘设置页（`settingsPanel` 自定义面板仍未做）。
2. 字号 20 时第二行只有 14px（0.71 倍），极小时翻译/罗马音偏小；用户要的是窗口跟着缩，未做最小可读保护。
3. 逐字只在宿主提供词级时间时生效；整行一个词的歌词仍按整行染色（`words` 长度 1 时会整行同时 `sung`）。
4. 歌词板形态下窗口高度按两行算，比单行高；切回单行要等 `setSize` 之后底边对齐（有一次性轻微跳动）。
5. 外观里的底色四态（深色 / 更深的深色 / 浅色毛玻璃 / 不铺底）都只在「悬停且未锁定」时出现；浅色毛玻璃固定 18% 白，不跟「底色不透明度」滑块走。

**真机待验**：38px 默认是否与 1.4.2 完全一致；字号 20/50 两端窗口高度、歌词是否被裁；
单行/歌词板切换时底边是否跳动；逐字染色边界是否踩点（rAF 外推 100ms 内是否有滞后感）；
「词」按钮与设置改动是否互相独立；命令面板四条是否能跑；1.6 宿主上按钮高亮是否仍会更新（无 `api.rpc.send` 时）。

**1.5.0 独立审查与修复**（审查代理 2026-11-06，结论「修完再上线」；已全部处理）

1. **阻断**：设置与命令的文案当时按字符串传，宿主的 `FoliumLabel` 是语言映射，会被 sanitize 整片丢掉——界面显示成 `fontSize` / `double` 这类 key 名。改成 `L(zh, en)` 统一生成 `{'zh-CN', en}`。
2. **高**：窗口被 × 隐藏后不再收数据帧，逐字 rAF 没有停止路径（`backgroundThrottling:false`）→ 页面加 `visibilitychange` 停 rAF，恢复可见时重绘一次。
3. **高**：发布版还留着 100ms/条的排查日志与 `DEBUG=true` → 删掉逐帧日志、页面 debug 通道（`IPC_DEBUG`）、模块级 `console.log`，`DEBUG` 默认 false。
4. **中**：浅色底色原用同一个 `--surface-alpha`（58% 白，糊成白板）→ 改独立 `--surface-light-alpha: .18`。
5. **中**：底色 dark/light 是常驻的，与「只在悬停且未锁定时出现」的说明相反 → 四态统一挂到 `body.hover:not(.pinned)[data-surface=…]`。
6. **中**：`isPositionUsable` 只要求 20px 露头，换分辨率后窗口会大半跑出屏幕 → 底边也必须在屏内。
7. **中**：1.6 队列分支提前记「已推」，队列被挤掉就永久丢失高亮 → 记账挪到 `take-commands` 真正取走时，并跳过队列里已有的同值消息。
8. **中**：1.7 上 `api.rpc.send` 抛错只 warn、指令丢失 → catch 里退到队列。
9. **中**：client 用「有没有 `rpc.on`」决定轮询、main 用「有没有 `api.rpc.send`」决定入队，两条独立推断 → `widget-state` 返回 `canSend`，client 按它起轮询；轮询也移到 main 上下文判断之后（导出窗口不再抽队列）。
10. **低**：逐字 span 里存了没用到的 `end`、`stopped/loading` 也吃「暂停变淡」、`surfaceOpacity` 下限与表单不一致（0 vs 0.2）、`#rgb` 颜色回落默认 → 分别删除、改成写真实 `payload.state`、统一 0.2、支持 `#rgb` 展开。

### 4.18 1.6.0：砍掉单行 / 歌词板，引入「桌面歌词 / 悬浮窗歌词」两种显示形态（F36，已上线，等真机确认）

**需求来源**：1.5.0 真机反馈（用户 m04164）指出窗口形态三态在长句上显示不全、反复切换会失效；
用户随后决定「窗口形态直接砍了吧，就显示默认样式」（m04407），并把工作重心转到架构：
**默认桌面歌词，按钮切换到「功能更多、可自行调节大小、能显示更多歌词」的悬浮窗歌词**；
切换键只放桌面歌词窗口（「固定」键右边）+ 设置里一个（m04509 定 B+ 画法），图标取「显示器 + 三行」。

**为什么先做架构、后做悬浮窗视图**：两种形态要共用歌词数据、逐字、外观、设置与命令入口，
如果先把悬浮窗画出来、再回头拆公共部分，等于把 1.5.0 的耦合重演一遍；先把形态链路与配置分层落地，
1.7.0 只需要填 `window` 那一半的渲染与几何。

**做法**

| 项 | 做法 | 为什么 |
| --- | --- | --- |
| 形态状态 | main 的 `displaySurface()` = `desktopOpen && config.shared.display !== 'window' ? 'desktop' : 'window'`；形态真源在 main（`state.config.shared.display`），`normalizeConfig` **不读** `display` | 形态如果由 client 推来的 config 决定，任何一次设置改动（比如拖不透明度）都可能把形态冲回去 |
| 切换 | `setDisplaySurface()` / `toggleDisplaySurface()`：切到 window 就 `hide()` 桌面窗口；切回 desktop 把 `desktopOpen = true` 并 `showInactive()` + `applyWindowSize()`；两个方向都 `reportWidgetVisibility()` + `sendConfigToWindow()` + `webContents.send(IPC_SURFACE, …)` | 三个入口（窗口切换键 / 设置分段控件 / 命令面板）只有一条路径，不会出现「按钮亮了窗口没切」 |
| 三个入口 | ① 窗口控制条里 `#pin` **左边**的 `#switch-surface`（`data-mode` 为 `window` 时变蓝、提示改成「切换到桌面歌词」）；② 设置表单「通用」组第一项 `display` 下拉（1.6.1 起）；③ 命令面板「歌词：切换桌面歌词 / 悬浮窗歌词」 | 用户明确要求「不放播放控制条，只放桌面歌词上，设置里也放一个」；1.6.1 又要求切换键挪到固定键左边、设置走原生下拉 |
| B+ 面板（1.6.0 试过，1.6.1 撤回） | 1.6.0 传 `settingsPanel: { mount }` 想「上面自绘分段控件、下面宿主表单」；1.6.1 全部删掉，改成一个 `display` 下拉 | 宿主 `settingsSections.register` 要求 `settingsPanel` 是**函数**，传对象会直接抛错（被 client 的 try/catch 吞掉后整个设置分区都不注册）；而且 `FoliumSettingsCard` 是二选一渲染——有 `settingsPanel` 就完全不画 schema 表单，B+ 在宿主里根本不存在 |
| 配置分层 | `DEFAULT_CONFIG` 改三段：`shared`（字号 / 逐字 / 字体 / 外观 / `display`）、`desktop`（`marquee`，1.6.0 叫 `fitText`）、`window`（1.7.0 用）；`normalizeConfig` 兼容 1.5.x 的扁平结构（`raw.shared ?? raw`） | 两种形态共用的是「歌词长什么样」，独有的是「窗口怎么摆」；不分层的话 1.7.0 会把两套设置搅在一起 |
| 砍掉三态 | 删 `WINDOW_MODE_IDS`、`fontSize` 之外的高度来源、页面 `body[data-mode="board"/"single"]` 规则与 `render()` 里的 board/single 分支；桌面歌词固定两行 | 三态的失败点在真机上已经暴露（长句不全、反复切换失效），先把桌面歌词收敛到一个稳定的样子 |
| 分组改名 | 设置项分组改「通用 / 桌面歌词」，`fontMode` 的 label 从「字体」改成「字体来源」 | 宿主分组标题是写死的 `text-xs font-medium`，模组改不了字号字重，只能靠命名避免「两个字体」 |
| 持久化 | 形态偏好写进状态文件 `persisted.surface`（`scheduleSave()` 防抖）；`open` 仍表示「桌面歌词窗口是否被 × 关掉」 | 形态与显隐是两件事：切到悬浮窗不能把 `open=false` 写进去，否则切回来窗口就没了 |
| 1.6 兼容 | `widget-state` 返回 `{ visible, surface, canSend }`；`set-surface` 走 `api.rpc.call`（client→main，1.6 也有） | 切换本身不依赖 `api.rpc.send`；只有「main 推给页面」这一段在老宿主靠 `take-commands` 兜底 |

**仍然存在的行为**

1. 悬浮窗形态目前只切状态、**不显示任何窗口**（`syncDisplaySurface()` 在 window 分支只 `hide()` 桌面窗口）。这是 1.6.0 的阶段性状态，1.7.0 才填视图；用户在悬浮窗形态下唯一能看到的是设置里的分段控件位置与命令面板回执。
2. 桌面歌词窗口被 × 关掉后处 `desktopOpen=false`，此时 `displaySurface()` 返回 `window`——设置里的分段控件会显示「悬浮窗歌词」。这是语义上的必然（桌面窗口确实没开），但看起来可能像「自己跳过去了」；1.7.0 有真实视图后需要重新审视。
3. 「长句横向滚动」（`desktop.marquee`）只是桌面歌词的属性，悬浮窗形态会用自己的滚动/换行策略，不共用。
4. 外观四项（字号 / 逐字 / 字体 / 底色等）对两种形态共用；`window` 段现在是空对象，1.7.0 加字段时不会影响桌面歌词。

**真机待验**：切换键在「固定」右边是否与固定键间距一致、切到 window 后是否变蓝且提示改成「切换到桌面歌词」；
设置卡片顶部分段控件是否吃宿主深浅色、点击后窗口是否立即隐藏而按钮状态同步；命令面板切换是否可用；
切到 window 后重启 Folia，是否仍记住悬浮窗形态（且桌面窗口不出现）；切回 desktop 后窗口位置与大小是否复原。

**1.6.0 与 1.5.1 的关系**：1.5.1 原本要单独发（修 1.5.0 真机反馈的 6 条），因用户要求「直接做 1.6.0」而合并——
1.5.1 的修复（换句跳回上一句、单行换句延迟、反复切形态失效、长句显示不全、拖不透明度卡顿、
设置面板重名）都已包含在 1.6.0 里；其中「反复切形态失效」「单行换句延迟」随三态一起下线。

**1.6.1 修订（2026-11-06 真机反馈六条 + 逐字消失）**

| 反馈 | 根因 | 改法 |
| --- | --- | --- |
| 固定键与切换键位置不对（切换键应在左、固定键居中） | 1.6.0 把两键并列放进 flex 流，中间格变成「两键的组合」，`#pin` 实际偏左 | `#pin` 单独放进 `.controls-mid`（32×32、`flex:none`），`#switch-surface` 用 `position:absolute; right:calc(100% + 8px)` 定位到它左边——不参与 flex，固定键恢复严格居中 |
| 设置卡片里没有任何设置表单 | `settingsPanel` 必须是**函数**（`contract.ts:538`），1.6.0 传的是对象 → `settingsSections.register` 抛 `settingsPanel must be a mount function` → 被 try/catch 吞掉，整个分区未注册 | 删掉自绘面板，形态改成 schema `select`（`display`：桌面歌词 / 悬浮窗歌词），回到宿主原生渲染 |
| 逐字显示没了 | 与上一条同根因：没有 settings handle → 从不推 `config` → 页面停在默认 `karaoke:false` | 随设置分区恢复；`config` 首帧重新下发 |
| 长句要「不缩小也能看全」 | `.lyric-text` 是 `nowrap + ellipsis`，只会截断；1.6.0 的自适应缩小只是兜底 | 视口 + 轨道两层（`.line-track`），溢出时 `translateX` 向左滚动；换句立刻复位，不排队 |
| 换句仍闪回上一句（只有单语言歌曲明显） | `findApproximateLineIndex` 在句间空隙返回 `-1`，页面旧的「过期帧」判据 `incoming.index === previous.line.index - 1` 被 `-1` 帧写坏 | 改用模块级 `shownLineIndex` / `shownLinePosition`：行号更小且非 seek 回退就沿用上一帧；`-1` 帧不再污染比较基准 |
| 重开桌面歌词显示的是关闭前最后一句 | 隐藏期间 `sendPayloadToWindow` 早退，重新显示后没有补发；页面 DOM 停在旧内容 | `setWidgetOpen(true)` 与 `syncDisplaySurface()` 的显示分支都补 `sendPayloadToWindow(state.lastPayload)`；另 `resize` 时重新量歌词 |

**1.6.2 修订（2026-11-06 第二轮真机反馈）**

| 反馈 | 根因 | 改法 |
| --- | --- | --- |
| 未固定时「固定」键不在中线上 | `.controls-mid` 仍是 flex 项，左侧 3 个按钮、右侧 5 个，`flex:1` 的两组宽度不等 → 中线被推偏 | `.controls-mid` 改 `position:absolute; left:50%; transform:translateX(-50%)`，彻底脱离 flex；切换键仍绝对定位在它左边 8px |
| 固定态左边还看得见切换键 | 1.6.1 只做了 `opacity:0` + 悬停复现 | `body.pinned #switch-surface { visibility:hidden; pointer-events:none }`，固定态只留正中解锁按钮 |
| 设置下拉初值 / 播放条高亮与当前形态不一致 | `displaySurface()` 把「桌面歌词被 × 关掉」也算成 `window`，于是关一次窗口就变成「悬浮窗形态」 | 形态只由设置 `shared.display` 决定；「桌面窗口是否显示」由 `desktopOpen` 单独表达（`widget-visibility.visible`） |
| × 关掉再打开：画面卡在旧句、之后换歌也不动，只能用设置里的命令强行救回 | 上一条的连锁反应：`sendPayloadToWindow` 用 `displaySurface() !== 'desktop'` 早退，关过窗口之后数据通道被永久关掉，连补发都进不去 | 转发条件改成只看「形态偏好 + `desktopOpen`」；`setWidgetOpen(true)` 在悬浮窗形态下自动把形态拉回桌面，并补推 `config` 与 `IPC_SURFACE`；`did-finish-load` 也补推一次形态 |
| 长句滚动「快了一点」 | 换句后立刻开始平移，句首没有读句时间 | `MARQUEE_LEAD_IN` 0.5 → 1.2 秒（`state.delay` 倒数完才动），速度上限 400 → 380 px/s |

**1.6.3 修订（2026-11-07 第三轮真机反馈）**

| 反馈 | 根因 | 改法 |
| --- | --- | --- |
| 「固定」键和「循环」键重叠 | 固定键改成绝对定位居中后，右组内容（循环 / 排版 / 音量图标 / 音量条 / 百分比）仍然铺满右半边，最左边那颗循环键正好压在 50% 上 | 右组恒定 `padding-left: 40px` 让出中间空档；音量条压窄（`min-width: 40px`、`max-width: 76px`），把右组总宽收回来 |
| × 关掉再打开后偶发卡死，第一帧是旧句、之后换歌也不动 | 页面「过期帧」判据记的是**全局最大行号**，换歌后行号从 0 重新开始，`incomingIndex < shownLineIndex` 一直成立 → 新歌的每一帧都被当成迟到旧帧丢掉，画面永远停在上一次显示的那句 | 记一份 `shownSessionId`（`payload.playSessionId`），会话一变就把 `shownLineIndex` / `shownLinePosition` 清零；另外窗口重新显示时除了补发最后快照，再发一次 `request-sync` 让 client 绕过内容去重补一帧 |

**走马灯速度**：换句永远立即复位（滚动只做 `transform`，不排队）；速度按本句剩余可唱时间反推
`可用 = endTime - 当前位置 - 0.5s(句首留白) - 0.15s(句尾)`，`速度 = clamp(溢出 / 可用, 60, 400) px/s`；
只有在这个速度下也看不完（`MARQUEE_MAX_SPEED` 不够）时，才**对这一句**临时缩字号兜底（最多缩到 80%）。

## 5. 协议（与 `main.cjs` / `client.mjs` 文件头一致）

```
client.mjs --folium.rpc.call('update-data', payload)--> main.cjs  api.rpc.handle('update-data', handler)
client.mjs <--folium.rpc.on('action', handler)---------- main.cjs  api.rpc.send('action', action)
窗口页面 --ipcRenderer.send('my-lyric-widget:action-to-client', ...)--> main.cjs   ipcMain.on(...)
窗口页面 <--ipcRenderer.on('my-lyric-widget:data-from-client')------- main.cjs   webContents.send(...)
```

**payload**：`playSessionId`、`song{id,title,artist,album,source}|null`（不含 `ref`）、`state`、
`position`、`duration`（未知为 0）、`liked`、`canLike`、`volume`(0–1)、`muted`、`loopMode`、
`line{index,text,translation,romanization,words,next,startTime,endTime}`、
`theme{name,isDaylight,backgroundColor,primaryColor,accentColor,secondaryColor,fontStyle,fontStack}`。

1.5.0 起 `line.words` 恒为数组（宿主契约：没有词级时间的行也会有一个覆盖整行的 word），
本模组把它收窄成 `[{text,startTime}]` 透传；长度为 1 就表示「这一行没有逐字时间」，页面按整行染色。
`line.next` 是下一句原文（只在拿到真实行下标时给字符串，句间/末句为 `null`），供歌词板形态使用。

**action（main → client 的规范形状）**：`{action:'next'|'prev'|'toggle'|'request-sync'}`、
`{action:'set-volume',volume:0–1}`、`{action:'set-loop',mode:'off'|'all'|'one'}`。
**窗口页面的简写**（main.cjs 归一化）：`'prev'|'next'|'toggle'|'request-sync'`、
`{type:'set-volume',value:0–100}`、`{type:'set-loop',value}`、`{type:'cycle-loop'}`。

**1.4.0 新增的显示 / 隐藏链路**（与上面的播放数据流互不影响）：

```
client.mjs --folium.rpc.call('toggle-widget')----------------> main.cjs  api.rpc.handle('toggle-widget', ...) -> { visible }
client.mjs <--folium.rpc.on('widget-visibility', { visible })-- main.cjs  api.rpc.send(...)（只在显隐变化时推）
client.mjs --folium.rpc.call('widget-state')-----------------> main.cjs  api.rpc.handle('widget-state', ...) -> { visible, canSend }（1.4.1 首帧对齐；canSend 供 1.6 判断要不要轮询）
窗口页面 --ipcRenderer.send('my-lyric-widget:close')---------> main.cjs  ipcMain.on(...)（只隐藏，不注销模组）
```

`toggle-widget` 返回 `{ visible: boolean }`；`widget-state` 也返回 `{ visible: boolean }`，只读、无副作用（1.4.1 加，
因为主进程 activate 时的首帧推送可能早于 client 注册监听）。窗口隐藏期间 `update-data` 照收，但不往窗口发（`sendPayloadToWindow` 首行直接 return）。
窗口**没被重建**时，再打开立刻就是最后一份快照（1.6.1 起 `setWidgetOpen(true)` 与 `syncDisplaySurface()` 的显示分支都会补发 `state.lastPayload`，
修掉了「重开显示关闭前最后一句之外还可能是更旧的句子」这一类问题）；隐藏期间若发生过 reload / 宿主窗口全关重建（`closeWidgetWindow()`），
新页面只会显示占位符「等待播放...」，等下一份 `update-data` 到达才恢复歌词（隐藏期间 `ensureWidgetWindow()` 短路，不会主动拉数据）。
显隐状态写在状态文件的 `open` 字段里。

**1.5.0 新增的配置 / 命令链路**：

```
client.mjs --folium.rpc.call('config', cfg)------------------> main.cjs  api.rpc.handle('config', ...) -> 归一化后的 cfg
client.mjs --folium.rpc.call('toggle-pin')-------------------> main.cjs  api.rpc.handle('toggle-pin', ...) -> { pinned }（命令面板用）
窗口页面 <--ipcRenderer.on('my-lyric-widget:config')--------- main.cjs  webContents.send(...)（activated 后每次改动都发）
client.mjs --folium.rpc.call('take-commands')---------------> main.cjs  api.rpc.handle('take-commands', ...) -> [{kind,payload}]（仅 1.6）
```

`config` 形状（1.6.0 起三段）：`{ shared: { display, fontSize, karaoke, fontMode, surface, surfaceOpacity, radius,
border, sungColor, unsungOpacity, pausedDim, backdrop }, desktop: { marquee }, window: { } }`，返回值是 main 归一化后的
同一份对象再多一个 `surface`（当前形态，供设置下拉对齐）。1.5.x 的扁平形状仍被 `normalizeConfig` 接受（`raw.shared ?? raw`），
1.6.0 的 `desktop.fitText` 会迁移成 `desktop.marquee`。`take-commands` 的 `kind` 目前有 `action`（等同 `action` 通道的 payload）与 `widget-visibility`
（等同 `{visible}` 事件）；队列上限 32 条，超出丢最旧。1.7+ 有 `api.rpc.send` 时队列始终为空。

**1.6.0 新增的形态链路（1.6.1 起形态也走设置项 `display`）**：

```
client.mjs --folium.rpc.call('set-surface', { surface })--> main.cjs  api.rpc.handle('set-surface', ...) -> { surface }
client.mjs --folium.rpc.call('set-surface')---------------> main.cjs  （不带参数 = 来回切换）
窗口页面 --ipcRenderer.send('my-lyric-widget:surface')----> main.cjs  ipcMain.on(...)（切换键，只认本窗口）
窗口页面 <--ipcRenderer.on('my-lyric-widget:surface')------ main.cjs  webContents.send(...)（切换键高亮同步）
client.mjs --folium.rpc.call('widget-state')--------------> main.cjs  -> { visible, surface, canSend }
client.mjs <--folium.rpc.on('widget-visibility', ...)------ main.cjs  推送 { visible, surface }
```

`surface` 取值 `'desktop' | 'window'`；形态真源在 main 的 `state.config.shared.display`，偏好写状态文件
`persisted.surface`。`window` 形态下桌面窗口 `hide()` 且 `sendPayloadToWindow` 直接 return；
`visible` 仍表示「桌面窗口是否没被 × 关掉」，与形态正交。`widget-visibility` 从 1.6.1 起同时带 `surface`，
client 收到后把设置里的 `display` 下拉写回一致（窗口上的切换键、命令面板改了形态时，下拉不会停在旧值）。

## 6. 迭代记录

时间均为本地时间（Asia/Shanghai）。

### 2026-11-02

- **21:23 起，client.mjs 第一版**。需求原话里写的是 `folium.rpc.send('update-data', ...)`；核对
  `mods/folium.d.ts` 与 `src/mods/folium/contract.ts` 后确认 client 侧只有 `call` / `on`，改为 `folium.rpc.call`，
  main 侧对应 `api.rpc.handle`。同期发现：空的 `main.cjs` 会让整个模组加载失败
  （`electron/modSystem/nodeEntry.cjs`：`mod main must export a function`），所以 main 入口必须先能导出一个函数，client 才会跑。
- **句间处理**：最初 `getLineIndex() === -1` 时直接显示「等待播放...」，每句之间会闪一下；
  改为用 `folium.lyrics.getRecentCompletedLine` 保留上一句。最后一句结束后它仍返回最后一句，
  只有第一句开始前 / 没有歌词时才落到「等待播放...」。
- **0.2.1 client 定稿**（312 行）：两轮独立审查。第 1 轮 12 条、2 条阻断（阻断项是「main 侧协议对不上」类）；
  第 2 轮 0 中/高，3 条低观察（其中「最后一句结束后显示等待」是文档写错、行为本身正确，已订正注释与文档）。
  mock 冒烟 21 项全过。
- **当时的设计取舍**：`line.words` 预留但恒 `null`；不加 `set-muted`（payload 里的 `muted` 只读）。

### 2026-11-03

- **00:24 模组目录提交**（`mods/my-lyric-widget` 独立仓库，commit `2ad2d6e`，"feat: 完成 client.mjs 数据收集逻辑"）：
  当时是 `client.mjs` 312 行、`main.cjs` 0 字节。
- **main.cjs 第一版（0.3.0）**：用户给出规格（600×200、无边框透明置顶、data URL、页面内按钮与音量条、`api.onDispose` 关窗）。
  实现时在规格之外补了：IPC 通道加模组前缀、窗口简写归一化、循环显示中文名
  （不循环/列表循环/单曲循环——宿主 `playback` 没有「随机」循环模式）、`show:false` + `ready-to-show`、
  底部居中、CSP、`request-sync` 补发、`render-process-gone` 日志、音量 150ms 节流、`sender` 校验、`sandbox:false`。
- **第 1 轮 main 审查**（1 阻断 + 2 高 + 6 中 + 10 低），阻断项：
  **悬浮窗是独立窗口，宿主窗口全关后 `window-all-closed` 不再触发**——非 macOS 退不出应用、Windows 壁纸模式不会重建。
  修法：跟踪宿主窗口集合（`BrowserWindow.getAllWindows()` 起始 + `app.on('browser-window-created')` 增补 + 每窗 `closed` 移除），
  宿主集合空了延迟 300ms 再收窗（给壁纸模式「先销毁旧窗再建新窗」留交接时间），宿主出现新窗口且悬浮窗已被关掉时重建。
- **第 2 轮 main 审查（0.3.1）**：`render-process-gone` 增加自动 reload、无关闭入口时记 warn 并在下一条数据懒重建、
  长歌词溢出（当时 `ellipsis` 截断，记录为待办）、`activate` 同步抛错时 `disposer` 不执行导致 `ipcMain` 监听泄漏
  （`createWidgetWindow` 包 try/catch、先清理再 rethrow）、`api.log` 传对象会被 `String` 成 `[object Object]` 等。
- **第 4 轮（0.3.2 / client 0.2.2）**：两份独立审查给 0 阻断 0 高、可进真机联调。落地：
  - 空字符串行文本原样显示（main.cjs:273）；
  - 崩溃 reload 真正限次：`CRASH_RELOAD_WINDOW_MS = 60 * 1000`、`MAX_CRASH_RELOADS = 2`，成功加载不清零；
  - `ready-to-show` 改 `showInactive()`，不抢键盘焦点；
  - `loadURL` 失败清引用并销毁窗口，下一条数据重建；
  - `cycle-loop` 连点：发出后立即写 `state.lastLoopMode`，下一次基于刚发出的模式；
  - 规范 `set-volume` 只收有限 `number`（数字字符串只走窗口简写分支）；
  - 低项：发送/关闭包 try/catch、重建上限只 warn 一次、`webviewTag: false`、`aria-live`、`dragover/drop` 防导航；
  - client 0.2.2：`folium.rpc` 成员缺失时降级并 warn（需要 1.7+），并保证先登记 `action` 监听再发第一份数据。
- **当时的验证**：`node --check` 两个入口均通过；`npm run folium:check -- my-lyric-widget` 退出码 0
  （只有两条 note：没有 `preview` 图、没有签名）；临时 mock 冒烟（伪 `electron` / 伪 `api`）覆盖窗口参数、payload 转发、
  `next/toggle/set-volume/set-loop/cycle-loop`、外来 sender 拒收、`dispose` 撤监听、崩溃限次、`loadURL` 失败重建、内联脚本可编译。
- **迭代文档被误删后按工作区现状重写**，另补交接文档（本文件与 `my-lyric-widget-handoff.md`）。
- **真机 IPC 排查（日志法）**：真机上歌词不显示、按钮无反应。用 `console.log` + `api.log.info` 在两个进程、
  窗口页面和内联脚本里各埋一串日志（main 侧显示为 `[Mod:my-lyric-widget]`，渲染侧进「设置 → 开发者 → 运行日志」、
  勾选「写入本地文件」后落盘 `userData/logs/runtime/<日期>.log`）。日志证明：窗口页面 → 主进程 → `api.rpc.send` 通；
  client 模块已求值、`activate` 成功、visualizer 已注册，但 **264 行日志里没有 `mount 进入`、没有 `update-data`、
  没有 `收到 action`**。
- **根因**：`client activate` 日志里的 `savedVisualizerMode: null`——`localStorage['visualizer_mode']` 从未被写成
  `mod:my-lyric-widget:lyric-widget`，宿主当前样式不是本模组，`mount` 从不调用。而 0.3.2 把 `syncData`
  和 `rpc.on('action')` 都写在 `mount` 里 → 两个症状同一个根因。用户在「播放页 → 控制 → 歌词样式」里真正选中本样式后，
  歌词与按钮立刻全部正常。
- **0.3.3 混合同步（F11）**：`activate` 建同步引擎并注册 action 监听，`mount` 只交精确上下文；
  未选中样式时用 `lyrics.getLines()` + `position` 近似行号 + 200ms 轮询兜底（见 §4.2 / §4.4）。
- **`playback-unavailable-in-main-context` 修复**：模组 `activate` 早于宿主注册 `hostActions`
  （`src/mods/runtime/hostActions.ts` 在主窗口 App 挂载后才注册），0.3.3 一进 `activate` 就 `syncData` → 抛错。
  改为先探测宿主就绪、未就绪时静默跳过并靠轮询重试，就绪后强制补发首帧；`handleActionMessage` 也不再外抛。
- **兜底路径的歌词偏移复算（§4.5）**：从 `localStorage` 读单曲偏移 + 设备偏移，按 `lyricTime = position - offset`
  找行；真机上手动延后 5s 时悬浮窗同步延后 5s。
- **预览片段偏差（已知，不修）**：预览从歌中间开始时兜底路径整体错一个片段起点（§4.2），向用户解释为
  「播放进度尺从片段起点量、歌词尺从整首 0 秒量」。宿主没有暴露片段起点，模组侧无解。
- **0.3.4 图标化（F15 / F16）**：底部 5 个中文文字按钮换成内联 SVG，形状数据取自 Folia 自带的 lucide v1.48.0
  （ISC，`node_modules/lucide-react/dist/esm/icons/*.mjs`）；Play / Pause 实心、其余描边 2px、20px、按钮 32×32。
  同时把原生 `title` 的悬停气泡换成自绘 `data-tip` 气泡（固定在图标右上方，原生气泡位置不可控）。
- **0.3.4 字号与排版（F17 / F18）**：原文 26px → 38px，新增译文 27px（0.7 倍向上取整）；新增 `#layout` 按钮，
  在「原文 + 译文 · 罗马音」与「原文 + 大号译文（罗马音另起一行）」之间切换，纯显示逻辑、不新增 IPC；无译文时不留空行。
- **0.3.4 排版改三态（F17 / F18 / F20）**：按用户要求把两态改成三态——按钮不高亮只显示原文（38px）；
  半高亮（`rgba(125,211,252,0.55)`）显示原文 + 译文（译文 27px）；全高亮（`#7dd3fc`）显示原文 + 译文 + 罗马音
  （三行 38/27/27，罗马音与译文同字号）。窗口从 600×200 加宽加高到 640×236，保证三行不挤；点第三态回到第一态，
  仍是纯显示逻辑。（0.3.5 已把「整按钮半亮」改成「只亮图标里的『文』」，亮度与第三态相同，见下文 F25。
  2026-11-05 的 1.3.0 又改回两行：第三态只亮「A」显示原文 + 罗马音，窗口先压到 640×200、再压到 640×180，见 §4.15。）
- **想法存档（F19，§4.7）**：字体大小 / 颜色自定义确认可行（宿主 `settingsSections` + `FoliumSetting`），
  本轮按用户要求只存档、不改代码。
- **想法存档（F21，§4.8）**：评估「把悬浮歌词从歌词样式独立成单独功能 + 主程序设置里的自有设置界面」。
  结论：技术上可行、不需要新增权限；宿主 `settingsSections` 正好落在设置 → 模组页，`commands` 可加开关入口；
  过审以「先行测试 beta」概率高，官方认证需先处理 `nodeIntegration` / `contextIsolation`、窗口关闭入口、
  轮询 CPU、data URL 四个审查敏感点。本轮按用户要求只存档、不改代码。
- **设置入口定案（F19 / F21，§4.7 / §4.8.5）**：用户确认「设置 → 音乐 → 悬浮歌词」这个独立设置页**不开发**
  （宿主设置导航硬编码、模组注册表没有设置页 kind，红线内无法实现）；模组个性化调整（字号、字体颜色、行高、
  是否显示罗马音等）统一用 `settingsSections`，出现在 **设置 → 高级 → 模组 → 展开 my-lyric-widget**。
  本轮仍只更新文档、不改代码。
- **0.3.5 悬停显隐 + 固定/解锁（F22 / F23）**：默认（未固定且鼠标移开）窗口完全透明、只留带暗描边的歌词，
  歌名行与底栏一起淡出（`opacity: 0` + `pointer-events: none`）；悬停时 `.widget` 过渡成 `rgba(0,0,0,.58)`
  半透明黑并淡入底栏（0.22s / 0.18s transition）。底栏新增 `#pin` 固定按钮：未固定时整窗
  `-webkit-app-region: drag`；固定后 `body.pinned` 改 `no-drag`（整窗不可拖拽），悬停只给 `rgba(0,0,0,.14)`
  的极弱高亮、不出底栏，改为右上角淡入 `#unlock`（pin-off 图标）。**关键技术点**：Windows 下拖拽区不会把鼠标
  事件交给渲染进程（页面 `:hover` / `mouseenter` 在整窗 drag 时失效），所以悬停状态由主进程
  `startHoverWatch()` 每 80ms 用 `screen.getCursorScreenPoint()` + `getBounds()` 轮询后经
  `my-lyric-widget:hover` 通道推给页面，页面只负责切 `body.hover` 类；RPC 协议零改动。
- **0.3.5 窗口状态持久化（F24）**：位置、固定状态、排版选择存到 `userData/my-lyric-widget-state.json`（`{x, y, pinned, layout}`）。
  拖动时 `'move'` 事件先写内存、`scheduleSave()` 合并 500ms 后落盘；关窗 / 停用模组时立刻补写。
  下次启动 `placeWindow()` 优先恢复上次坐标，并用 `isPositionUsable()` 校验：至少有一部分落在某个显示器工作区内，
  否则（拔了副屏、分辨率变了）回退到「主屏底部居中」。固定状态在页面 `did-finish-load` 后由主进程
  `webContents.send('my-lyric-widget:pinned', …)` 推回页面；用户点图钉/解锁时页面 `ipcRenderer.send` 上报，
  主进程只认悬浮窗自己 `webContents` 发来的消息。**点击穿透当时按用户决定不做；2026-11-05 用户改口为部分穿透，见 §4.12。**
- **0.3.5 排版选择持久化 + 按字形高亮（F25）**：排版按钮的图标「文A」在 `main.cjs` 里拆成
  `<g class="icon-zh">` / `<g class="icon-a">` 两组，CSS 按 `data-mode` 只给对应那组上 `#7dd3fc`——
  中间态只亮「文」（亮度与第三态相同），按钮底色不变。当前模式经 `my-lyric-widget:layout` 上报主进程写进
  状态文件，`did-finish-load` 后推回页面恢复（值只接受 `text` / `text-trans` / `roman`，坏值忽略；
  1.3.0 起第三态由 `full` 改名 `roman`，老存档里的 `full` 在恢复时映射过去，见 §4.15）。

### 2026-11-04

- **1.0.0 独立常驻重构（F26，见 §4.9）**：`mod.json` 版本由用户改为 `1.0.0`。按用户要求把模组从
  「歌词样式（visualizers）」改成「独立常驻功能」：
  - `client.mjs` 重写（635 → 581 行）：删除 `folium.registries.visualizers.register` 与整个 `mount`
    实现，不再使用 `ctx`（`getLineIndex` / `onChange` / `lyricTime` 全部去掉）；
  - `activate` 里改为 `folium.every(100)` 自主轮询：`folium.playback.getState()` 取 position，
    `folium.lyrics.getLines()` 取歌词，自己按 `startTime` / `endTime` 比对当前行，组装**同形状** payload
    后 `folium.rpc.call('update-data', payload)`；`folium.rpc.on('action')` 保留；
  - 用户歌词偏移继续自行复算（单曲 `lyric_timeline_offsets` + 设备 `global_lyric_timeline_offset_ms`，
    `lyricTime = position - offset`），手动延后 5 秒悬浮窗同样延后；
  - 保留：`playSessionId`、内容去重（`position` 不参与）、事件订阅、`request-sync`、宿主未就绪探测
    （`playback-unavailable-in-main-context` 不再被记成激活/事件故障）、非 main 上下文早退；
  - 新增：activate 时只清理 `visualizer_mode` 中 `mod:my-lyric-widget:` 前缀的旧选择；
  - **`main.cjs` 零改动**：它本来就在 activate 里建窗、页面初始文本就是「等待播放...」，且全文没有
    `visualizer` / `ctx` / `mount` 引用。用户提到的 `progressButtons.register` 在本模组中不存在，
    底部控制栏是 `WIDGET_HTML` 手写控件，不受影响。
- **验证**：`node --check` 两个文件通过；离线 mock harness（伪 playback / lyrics / events / rpc / every /
  localStorage）14 项全过（见 §7）。真机效果待用户重启验证。

### 2026-11-05

- **1.0.1 修任务栏遮挡（F27，见 §4.10）**：用户反馈「歌词放在任务栏时会被任务栏挡住」。
  - 根因：Windows 的置顶层只有一层、后激活者在上，点一下任务栏它就会排到悬浮窗前面；`setAlwaysOnTop` 的
    `level` 参数只在 macOS 生效，Windows 下加 level 无效；
  - `main.cjs` 新增 `getTaskbarBands` / `overlapSize` / `overlapsTaskbar` 与 `startTaskbarGuard`
    （500ms 轮询，只在窗口与任务栏区域重叠 ≥8px 时 `moveTop()`；只在 Windows 上开），建窗时与悬停监听一起挂上，
    窗口 `closed` 时自动停，`ready-to-show` 后立刻提升一次；
  - `isPositionUsable()` 在 Windows 上改用显示器 `bounds`（macOS / Linux 仍用 `workArea`），
    让「停在任务栏上」的坐标重启后也能恢复；
  - `mod.json` 版本 `1.0.0` → `1.0.1`（x.y.z：y 是功能迭代号、z 是修 bug 号，本次纯修 bug）。
- **验证**：`node --check` 两个文件通过；stub electron 的守卫 harness 21 项全过（见 §7）。真机待验证。
- **独立审查（1 轮）**：无阻断、无高危。审查提的 M1（`isPositionUsable` 放宽没加平台门，macOS / Linux 会把窗口恢复成藏在
  Dock / 菜单栏后面）与 M2（1px 压线就每 500ms 抢占整个置顶层）已按建议修掉（平台门 + 8px 最小重叠，并把「压在任务栏上时
  也在开始菜单等所有置顶窗之上」写进 §4.10）；低优先级项：`overlapsTaskbar` 不再静默吞异常（交给守卫的 catch 记 warn 并停），
  文档日志描述与代码对齐，`ready-to-show` 后立即提升一次。其余低项（`closed` 后靠 tick 自停、40/20px 余量偏松）经确认无泄漏、
  属既有行为，保持不动。
- **为什么不是「加个更高的层级参数」**：Electron 在 Windows 下没有比任务栏更高的层级可设，
  可靠做法就是在需要时重新把自己提到置顶层顶部（`moveTop()` = `SetWindowPos(HWND_TOP, …)`）。
- **1.1.0 顶部控制条改版（F28，见 §4.11）**：用户要求删掉歌曲名行、按钮移到顶部、固定键居中并在锁定时变成更明显的
  「取消锁定」。`main.cjs` 1476 → 1483 行：
  - `.controls` 改为顶部绝对定位浮层（不占流，歌词仍在垂直正中），左右 `.controls-side{flex:1}` 夹住 `#pin` → 严格居中；
  - `#pin` 锁定态变成 32×32 高亮图标按钮（深底 + 蓝色描边 + 外发光，图标换 `pin-off`）；用户随后要求去掉文字，
    第一版的 `::before` 文案胶囊已整条移除，文案只留在悬停气泡与 `aria-label`；
  - 删除 `.song` 与右上角 `#unlock`（`#pin` 单击改为切换锁定），悬停气泡从向上弹改为向下弹；
  - `mod.json` 版本 `1.0.1` → `1.1.0`（x.y.z：功能迭代进 y、修 bug 进 z，本次是功能改版）。
- **验证（1.1.0）**：`node --check main.cjs` / `node --check client.mjs` 通过；jsdom 结构 + 交互 harness 19 项全过（见 §7）；
  真机待验证（沙箱里起不了 GUI 浏览器，也起不了 Electron）。
- **独立审查（1 轮，1.1.0）**：0 阻断 / 0 高 / 2 中 / 9 低。已修：M1（三行排版首行距控制条只有 2.15px，控制条 `top` 12→10px、
  `padding-bottom` 8→6px，余量提到约 6px，并把约束写进 §4.11）、M2（§4.13 原文称「页面没有任何块级 box-shadow」，与同轮
  新增的胶囊外发光矛盾，已改准）、L1（气泡补 `translateX(-50%)` 居中）、L2（`body.pinned .controls` 补 `transform:none`，
  原来锁定态整条比设计位置高 6px）、L3（文件头「窗口只用到 song…」与气泡注释「右上方」已过时）、L4（胶囊 `:focus-visible`
  也显形）、L5（`aria-label` 收成「取消锁定」，长文案只留 `data-tip`）、L6（`::before` 加 `order:2`，图标在前）、
  L7/L8/L9（文档行数、气泡阴影值、§4.10 旧措辞）。
- **同轮的两项调查（只出结论，未改代码）**：「歌词块背景阴影」判定为设计（文字 `text-shadow` + 悬停玻璃底，页面无块级阴影，
  见 §4.13）；「锁定态部分点击穿透」评估为可做、中等难度，推荐「整窗忽略鼠标 + 主进程光标轮询只在按钮矩形内恢复可点」，
  见 §4.12（用户要求先评估再动手，本轮未实现）。
- **1.2.0 部分点击穿透 + 去系统阴影（F29 / F30，见 §4.12 / §4.14）**：用户要求「固定时悬停只显示解锁按钮、没有阴影背景和
  边框描边」，并把点击穿透按方案 B 做出来（测完上真机）。`main.cjs` 1483 → 1630 行（含审查修复）：
  - 新 IPC `my-lyric-widget:pin-rect`：页面在固定/解锁、窗口 `resize` 时上报 `#pin` 的 `getBoundingClientRect()`
    （CSS 像素），并在 260ms 后补报一次（控制条有 0.18s 的 transform 过渡，立刻量到的是中间值）；
  - 主进程 `state.pinned` / `state.pinRect`：在 80ms 悬停轮询里一并判定，`pinned && pinRect && 光标不在按钮矩形（外扩 2px）`
    时 `setIgnoreMouseEvents(true, { forward: true })`，否则 `false`，只在值变化时调用；收到 `IPC_PINNED` / `pin-rect` 立刻
    重算一次，不等下一次轮询；
  - 兜底（独立审查 H1 修完后的版本）：没收到矩形或矩形非法时 `pinRect=null`、整窗保持可点；
    `setIgnoreMouseEvents` 调用成功才记状态、失败下一轮重试；轮询单次异常先 fail-open 恢复可点并继续跑
    （连续失败约 8 秒才停）；固定态 `#pin` 常驻 `pointer-events:auto`、`blur` 不清 hover；
    窗口 `closed` / 页面加载失败 / 主动关窗走同一套幂等收尾（清矩形、落盘、`state.win=null`）；
  - 窗口选项加 `roundedCorners: false` + `thickFrame: false` 去掉 DWM 圆角描边与系统阴影；页面
    `body.hover.pinned .widget` 的背景/描边改为 `transparent`（固定态悬停只剩解锁按钮）；
  - `mod.json` 版本 `1.1.0` → `1.2.0`（x.y.z：功能迭代进 y）。
- **验证（1.2.0）**：`node --check` 两个文件通过；stub electron 跑真实 `activate()` 的穿透 harness 14 项全过
  （未固定不吃鼠标、固定后整窗穿透、命中按钮恢复可点、歌词区穿透、2px 余量、取消固定立刻恢复、不可见/销毁兜底、
  `setIgnoreMouseEvents` 抛错后重试、光标接口抛错后 fail-open 且继续轮询、畸形矩形清空后保持可点）；
  jsdom 页面 harness 8 项全过（固定态 `pointer-events:auto`、hover 只控透明度、未固定 `blur` 清 hover /
  固定态保留、主进程推 pinned 后切态、点按钮解锁并上报）。
  未覆盖（需真机或补测）：真实 `setIgnoreMouseEvents` 在 Win11 的行为、`thickFrame:false` 对整窗拖拽的影响、
  混合 DPI 多显示器、窗口反复重建后 hover 轮询与 `state.win` 的一致性。
- **1.3.0 排版第三态改罗马音 + 窗口压高（F31，见 §4.15）**：用户要求「前两态不变，第三态只亮 A 显示原文 + 罗马音，
  没有罗马音就显示译文，三行不要了」并把窗口压矮。`main.cjs` 1630 → 1645 行：
  - `LAYOUT_MODE_IDS` / `LAYOUT_MODES` 第三项 `full` → `roman`；新增 `LEGACY_LAYOUT_IDS = { full: 'roman' }`，
    `did-finish-load` 恢复排版时先映射，老存档不丢；
  - 图标 CSS：删 `[data-mode="full"]` 双亮，新增 `[data-mode="roman"] .icon-a`；
  - `render()`：第二行改单槽位（`text-trans` → 译文；`roman` → 罗马音 ?: 译文；`text` → 空），
    第三行 `els.sub` 恒空、DOM 与 `.lyric-sub` 样式保留，注释写清恢复步骤；
  - `WINDOW_HEIGHT` 236 → 200，随后按「底部空白太多」再压到 180；`.lyric` 加 `padding: 33px 0 0` 把歌词往下压，
    文件头注释 / `placeWindow` / 位置恢复校验随之对齐；
  - `mod.json` 版本 `1.2.0` → `1.3.0`（功能迭代进 y）。
- **验证（1.3.0）**：`node --check main.cjs`、`client.mjs` 通过；jsdom + vm 页面 harness 23 项全过
  （三态循环与上报、全程无 `full` 残留、`text` 只一行、`text-trans` 第二行为译文、`roman` 有罗马音时只显示罗马音、
  缺罗马音回退译文、两者都缺整行隐藏、空原文不被等待文案顶掉、主进程推 `roman` 生效 / 推非法值被忽略、
  `WINDOW_HEIGHT` 236→200→180（`180` 与 `.lyric` 上内边距 33px 为同轮追加调整，靠 `node --check` + 几何验算保证）、
  `LEGACY_LAYOUT_IDS` 映射、CSS 只亮 A）；`npm run folium:check` 无问题。
- **1.4.0 显示 / 隐藏 + 右上角关闭（F32，见 §4.16）**：用户要求「播放条上放一个『词』按钮，位置和 enhanced-remote-widget 一致，
  窗口显示时高亮」，以及「窗口右上角加一个 ×，点了只关悬浮窗、模组继续启用」。`main.cjs` 1650 → 1801 行、`client.mjs` 581 → 758 行
  （含下一条审查修复）：
  - 新增 RPC：`toggle-widget`（client → main，返回 `{ visible }`）与 `widget-visibility`（main → client，只在变化时推）；
  - 新增 IPC：`my-lyric-widget:close`（页面 × → main，只认 `state.win` 的 webContents）；
  - `state.widgetOpen` + `setWidgetOpen()`；隐藏时 `sendPayloadToWindow()` / `ensureWidgetWindow()` 短路，
    `ready-to-show` 只在可见时 `showInactive()`；显隐写进状态文件的 `open`（缺省视为显示，老存档不受影响）；
  - 页面：右上角 `#close`（悬停才出现，固定态也悬停可见；不悬停时 `opacity:0` 且 `pointer-events:none`）；
    固定态控制条的隐藏从 1.1.0 的「`.controls-side` 单独 `visibility:hidden`」提到 `.controls` 层，
    并显式 `pointer-events:none` 断点击、`#pin` 单独 `visibility:visible; pointer-events:auto` 放回来，保证固定态仍能解锁与点 ×；
  - client：注册 `progressButtons`（`slot:'progress.trailing'`、`order:480`）画「词」字按钮，内部维护 `visible`
    并 `paint()` 到 DOM（宿主只按 `mount` 渲染一次），点击本地翻转 → `rpc.call('toggle-widget')` → 按返回值对齐，
    同步抛错和 Promise 拒绝都回滚；返回 `{ setVisible, dispose }`，`dispose` 在卸载时退注册项并移除注入的 `<style>`；
  - `mod.json` 版本 `1.3.0` → `1.4.0`。老宿主没有 `progressButtons` 注册表时静默跳过，悬浮窗功能不受影响。
- **1.4.0 独立审查与修复**：审查报告 0 阻断 / 4 高 / 6 中 / 5 低，结论「修完再上线」。已修：
  ① 点击切换失败时回滚方向反了（`client.mjs` 记 `before` 再翻，rejected 回到 `before`；`rpc.call` 同步抛错也立刻回滚）；
  ② 同一次 toggle 推两条重复 `widget-visibility`（保留 `setWidgetOpen()` 里那一处，删掉 `rpc.handle` 里的 force）；
  ③ 去重键 `reportedOpen` 在 send 成功前就被消费，失败后永不重推 → 改成 send 成功后才更新；
  ④ `persistWidgetOpen` 从同步写盘改成 `scheduleSave()` 防抖（写盘失败由 `savePersistedState` 内部 warn，不再冒泡成 rpc 错误）；
  ⑤ `#close` 补 `pointer-events:none` 默认值、`.controls` / `.controls-side` 在固定态显式断点击（原先是隐形点击陷阱）；
  ⑥ `onDebugFromWindow` 补 sender 校验（nodeIntegration 页面能往任意通道发）；
  ⑦ 删死代码 `applyWidgetButtonState`（它用 `document.getElementById` 找按钮，而按钮在 shadow root 里，永远找不到）；
  ⑧ 「词」字体写成确定字体栈（`all: initial` 下 `var(--folium-font, inherit)` 会落到系统默认）；
  ⑨ `registerWidgetToggleButton` 返回 `dispose()`，卸载时退注册项 + 移除 `<style>`；
  ⑩ 文档纠正：1.4.0 前的固定态是 `.controls-side` 的 `visibility:hidden` 而非整条 `opacity:0`、「再打开立刻是最后一份快照」
      只在窗口未重建时成立、宿主窗口全关销毁悬浮窗后靠下一条数据重建（按钮仍高亮）、同 `order:480` 实际按 id 排在后。
  修复后：stub electron harness 19 项、client 按钮 harness 11 项全过；`node --check` 两文件通过；`folium:check` 无问题。

- **验证（1.4.0）**：`node --check main.cjs` / `client.mjs` 通过；stub electron 跑真实 `activate()` 的 harness 16 项全过
  （toggle 两次、隐藏期间不发数据也不复活窗口、状态文件写 `open`、页面 × 关闭只认本窗口、老存档无 `open` 视为显示、
  `open:false` 启动保持隐藏、`dispose` 清理监听）；jsdom 页面 + client harness 10 项全过（× 存在 / 默认透明 / 点击上报
  close、固定态控制条隐藏但 `#pin` 可见、固定态点解锁仍上报、hover 让 × 出现、注册 `progress.trailing` / `order:480` /
  文字为「词」、点按钮调用 `toggle-widget` 并按返回高亮、主进程推 `widget-visibility` 切高亮、老宿主无 `progressButtons`
  静默跳过）；`npm run folium:check -- my-lyric-widget` 无问题。
- **验证（1.4.0 审查修复后重跑）**：stub electron harness 19 项（推送失败不置键→`update-data` 重推成功→去重生效、
  toggle 隐藏 + 只推一条、落盘走防抖且到期后 `open:false` 落地、debug 通道拒绝陌生 sender 接受本窗口、
  固定态 CSS 断点击、`dispose` 移除监听）；client 按钮 harness 11 项（`progress.trailing` / `order:480` / 文字「词」、
  同步抛错回滚、成功按返回值、Promise 拒绝回滚、`dispose` 退订阅 + 回收注册项 + 移除 `<style>`）。
  临时 harness 目录 `.tmp-v14b` 用完已删。

### 2026-11-06

- **调研两个新增的同类模组（只读，未改任何文件）**：`mods/amll-desktop-lyric-0.1.0/amll-desktop-lyric` 与
  `mods/enhanced-remote-widget-1.15.5/enhanced-remote-widget`。
  - amll 有而本模组没有的：逐字歌词（`@applemusic-like-lyrics/core` + rAF 外推）、单行 / 双行 / 多行歌词板三形态、
    字号与窗口高度互推、外观全套自定、本机字体枚举与字体栈、窗口行为开关组、自建拖动、命令面板 + 全局快捷键；
  - enhanced-remote-widget 的显隐链路（本模组 1.4.0 照抄的部分）：`progressButtons`（`progress.trailing` / `order:480`）
    → `folium.rpc.call('toggleWidget')` → main 维护 `shouldShowWidget` 并 `showInactive()` / `hide()`；该模组的 `mod.json`
    里没有专门的开关声明，能力全在代码里。
- **1.4.0 显示 / 隐藏 + 右上角关闭（F32，见 §4.16）**：用户先问「有没有现成的歌词开关图标」，确认宿主图标池里没有
  （`PLAYER_CONTROL_SLOT_OPTIONS` 里唯一相关的 `lyrics-timeline` 是 ChartBar，语义是「查看歌词时间轴」；lucide 1.48 的
  `captions` / `subtitles` 之类都是字幕语义），于是按用户要求自制「词」字按钮；随后追加「窗口右上角加 ×，关了但模组继续启用」。
  `main.cjs` 1650 → 1801 行、`client.mjs` 581 → 758 行（含审查修复；细节见 §4.16 与本节上一条）。
- **验证（1.4.0）**：见上一条与 §7；真机待验证。
- **1.4.1 真机回归修复（三个问题，见 §4.16 的「1.4.1 修订」）**：用户报 ①右上角 × 与音量百分比重叠
  ②「词」按钮是个白底黑字方框、很丑 ③按钮不随窗口显隐变高亮。②③ 同一根因：宿主把 `progressButtons` 挂进 ShadowRoot，
  而 1.4.0 把 `<style>` 挂在 `document.head`，样式完全没生效；改成注入按钮所在的根节点，并补 `widget-state` 只读 RPC
  让按钮在 client 激活后主动取一次真值。①给控制条右组加 `padding-right:44px`（只影响悬停且未固定态）。
  `main.cjs` 1801 → 1814 行、`client.mjs` 758 → 788 行。验证：13 项 harness 全过（见 §7）。
- **1.4.2「词」按钮改成原生造型 + 退出收起态（见 §4.16）**：用户报「鼠标不悬停播放控制条时按钮有一点点突出」，
  评估后选 B + `hideWhenCollapsed`：22px 圆形、无描边、常态 40% 透明、hover / 开启态用 `color-mix(currentColor …)` 同色底，
  不再用 `#7dd3fc` 蓝框；收起态（鼠标离开后的窄胶囊）整条不挂载。`main.cjs` 未动、IPC 契约未变；`client.mjs` 788 → 803 行。
- **1.5.0 设置表单 / 字号 / 形态 / 逐字 / 字体 / 外观 / 命令面板 / 1.6 兼容（F33–F35，见 §4.17）**：用户对照 amll 拍板后一次性做完。
  `client.mjs` 803 → 1250 行（新增 `buildSettingsSection` / `readConfigFromHandle` / `registerSettingsSection` /
  `registerWidgetCommands` / `startCommandPolling`，`readLine` 增加 `words` 投影与 `next`）；
  `main.cjs` 1814 → 2165 行（`DEFAULT_CONFIG` / `normalizeConfig` / `lyricBlockHeight` / `windowHeightFor` /
  `applyWindowSize` / `sendConfigToWindow` / `queueToClient`，新增 `config`、`toggle-pin`、`take-commands` 三个 RPC）；
  `mod.json` 1.4.2 → **1.5.0**。
- **验证（1.5.0）**：`node --check` 两文件通过；页面 + client harness 30/30（`.tmp-v15`，用完即删）；
  主进程 harness 16/16（同一目录，覆盖配置→窗口高度、1.6 队列上限 32、`toggle-pin` 回推页面）；
  `npm run folium:check -- my-lyric-widget` → `no problem found`（仅 preview / 未签名两条 note）。细节见 §7。
- **1.5.0 独立审查与修复**：审查代理结论「修完再上线」（0 阻断前一轮的初版被它判了 2 个阻断：
  设置 / 命令文案按字符串传会被宿主整片丢弃；命令面板四条同名）。修完后 `client.mjs` 1250 → 1304 行、
  `main.cjs` 2165 → 2160 行；另修 rAF 隐藏不停、逐帧排查日志、浅色底色 58% 白、dark/light 常驻底色、
  位置校验缺底边、1.6 队列提前记账、1.7 `rpc.send` 抛错丢指令、轮询能力判断不同源、`#rgb` 颜色、
  `surfaceOpacity` 下限、`stopped` 也变淡等 10 项。清单见 §4.17 末尾。
- **1.5.0 真机反馈六条（m04164）与定位**：①换句时先跳回上一句再跳正——事件帧与 100ms 轮询帧交叉，旧快照后到；
  ②设置面板两个「字体」——分组标题「字体」与 `fontMode` 的 label 重名；③单行换句延迟——`sendPayloadToWindow`
  当时每帧还有一条 `api.log.info` 写盘日志；④反复切单行/双行失效——`RPC_CONFIG` 只在 `changed` 时 `applyWindowSize()`，
  已更新但尺寸没落地之后就再也调不回来；⑤长句显示不全——`.lyric-text` 是 `nowrap + ellipsis`（设定，不是 bug）；
  ⑥拖「未播不透明度」卡——`applyConfig` 无条件 `render(lastPayload)`，每次拖动整页重渲染。
  对应修复（过期帧保护、`pushNow/push` 拆分、删逐帧日志、无条件 `applyWindowSize`、`fitLyricText()`、外观只改变量）
  已全部写进代码，但因用户决定直接做 1.6.0，**不单独发 1.5.1**。
- **1.6.0 砍掉单行 / 歌词板 + 两种显示形态（F36，见 §4.18）**：用户定「窗口形态直接砍了吧，就显示默认样式」、
  「默认桌面歌词，切换后是悬浮窗歌词」、「切换键只放桌面歌词上，位置在固定旁边，设置里也放一个」、
  「图标做 A（显示器 + 三行）」、「设置入口做 B+」。`main.cjs` 2160 → 2373 行（`DISPLAY_SURFACES` /
  `displaySurface` / `syncDisplaySurface` / `setDisplaySurface` / `toggleDisplaySurface` / `state.desktopOpen` /
  `RPC_SET_SURFACE` / `IPC_SURFACE` / `#switch-surface` 按钮与图标 / 三段 `DEFAULT_CONFIG`）；
  `client.mjs` 1304 → 1513 行（`createSurfacePanel`（B+ 分段控件）/ `settingsPanel.mount` / `applySurface` /
  `set-surface` 命令 / 三段 `readConfigFromHandle`）；`mod.json` 1.5.0 → **1.6.0**。
  悬浮窗视图本身留到 1.7.0，这一点在 §4.18「仍然存在的行为」里写明。
- **验证（1.6.0）**：`node --check` 两文件通过；主进程 harness 22/22（`.tmp-160`，含形态切换、老存档迁移、
  陌生 sender 拒绝、dispose 清理）；页面 + client harness 9/9（切换键、`IPC_SURFACE` 双向、分段控件与宿主 token、
  三段配置读取、命令存在）；`npm run folium:check -- my-lyric-widget` → `no problem found`。细节见 §7。
- **1.6.1 六条真机修复（F37，见 §4.18 末尾）**：用户 m04894 反馈「固定和切换按钮换个位置」「设置里没有表单」
  「长句要完整显示」「换句闪回上一句」「重开显示旧句」「逐字没了」。定位到的两个真 bug：
  ① `settingsPanel` 必须是函数，传对象让 `settingsSections.register` 直接抛错，整个设置分区（含逐字开关）都没注册；
  ② 句间空隙帧（`index: -1`）把页面「过期帧」判据的比较基准写坏，迟到帧因此能盖掉当前句。
  改法：`#pin` 单独放进 `.controls-mid`、切换键绝对定位到它左边；设置删掉自绘面板、形态改 `display` 下拉；
  歌词改「视口 + 轨道」两层并由 `translateX` 滚动（速度按剩余可唱时间反推，`60~400 px/s`，实在不够才缩到 80%）；
  `setWidgetOpen(true)` / `syncDisplaySurface()` 显示分支补发 `state.lastPayload`；`render()` 用
  `shownLineIndex` / `shownLinePosition` 判过期帧。`main.cjs` 2373 → 2603 行（+230）、`client.mjs` 1513 → 1391 行
  （−122，删掉整块自绘面板）；`mod.json` 1.6.0 → **1.6.1**。
- **验证（1.6.1）**：`node --check` 两文件通过；harness **25/25**（`.tmp-161`：按钮 DOM 顺序与绝对定位、
  视口+轨道结构、滚动真的在 `translateX`、离谱长句才缩字号、迟到旧帧不覆盖、空隙帧后正常前进、重开补发最后快照、
  `widget-visibility` 带 `surface`、client 有 `display` 下拉且不再传 `settingsPanel`）；
  `npm run folium:check -- my-lyric-widget` → `no problem found`。细节见 §7。
- **1.6.2 八条真机反馈（见 §4.18 末尾「1.6.2 修订」）**：用户 m05396 报「未固定时固定键不在中线」「固定态左边还露着切换键」
  「设置下拉初值与形态不一致」「× 关掉再打开卡死且之后换歌也不动」「滚动快了一点」。定位到的关键 bug：
  `displaySurface()` 把「桌面歌词被 × 关掉」也算成 `window` 形态，于是关一次窗口就让 `sendPayloadToWindow` 永久早退。
  改法：形态只由 `shared.display` 决定、`desktopOpen` 单独表达窗口开关；`setWidgetOpen(true)` 在悬浮窗形态下自动拉回桌面
  并补推 `config` / `IPC_SURFACE`；`.controls-mid` 改绝对定位居中；固定态给切换键 `visibility:hidden`；
  「显示 / 隐藏」命令按「屏幕上是否真看得见」判断；滚动词首延迟 0.5 → 1.2 秒、速度上限 400 → 380 px/s。
  `main.cjs` 2603 → 2645 行、`client.mjs` 未动（1391）；`mod.json` 1.6.1 → **1.6.2**。
- **验证（1.6.2）**：`node --check` 两文件通过；harness **14/14**（`.tmp-162`：关掉后形态仍是 desktop、
  命令重开后 `visible:true` 且数据帧继续转发、补发最新一句、悬浮窗形态下「显示」自动切回桌面、
  `.controls-mid` 绝对定位 50%、固定态切换键 `visibility:hidden`、词首延迟 1.2 秒）；
  `npm run folium:check -- my-lyric-widget` → `no problem found`。
- **1.6.3 第三轮真机反馈（见 §4.18 末尾「1.6.3 修订」）**：用户 m05569 报「固定键和循环键重叠」
  「× 关掉再打开偶发卡死、第一帧是旧句、之后换歌也不动」。第二个才是真 bug：页面过期帧判据记的是全局最大行号，
  换歌后行号从 0 重来，新歌每一帧都被当迟到旧帧丢掉。改法：记 `shownSessionId`，会话变即清零基准；
  窗口重新显示时补发快照后再发 `request-sync`。第一个是布局：右组恒定 `padding-left:40px`，音量条压到 `40~76px`。
  `main.cjs` 2645 → 2672 行、`client.mjs` 未动；`mod.json` 1.6.2 → **1.6.3**。
- **验证（1.6.3）**：`node --check` 两文件通过；harness **10/10**（`.tmp-163`：右组 40px 留空、固定键仍绝对居中、
  音量条 `max-width:76px`、同会话内迟到旧帧仍被挡住、换歌后新歌第一句立刻显示、换歌后继续正常前进）；
  `npm run folium:check -- my-lyric-widget` → `no problem found`。

## 7. 验证记录

| 时间 | 做了什么 | 结果 |
| --- | --- | --- |
| 2026-11-02 | `node --check client.mjs`；`npm run folium:check -- my-lyric-widget` | 通过；只读静态检查，不运行模组 |
| 2026-11-03 | mock 冒烟（伪 electron / 伪 api，临时脚本用完即删） | 全部 PASS |
| 2026-11-03 | `node --check main.cjs` / `client.mjs` | 通过 |
| 2026-11-03 | `npm run folium:check -- my-lyric-widget` | 退出码 0，仅 `preview` / 签名两条 note |
| 2026-11-03 | 真机联调 + 「设置 → 开发者 → 运行日志」双进程日志 | 复现「歌词不显示 / 按钮无反应」，定位到 `mount` 从未调用（`savedVisualizerMode: null`） |
| 2026-11-03 | mock folium 冒烟（伪 playback / lyrics / events / rpc / every） | 16 项全过：兜底换行、句间保留、mount 精确优先、卸载回退、action 转发、request-sync 等 |
| 2026-11-03 | mock 冒烟第二轮（宿主未就绪 / 歌词偏移） | 12 项全过：未就绪不抛错、就绪后补发、单曲 +5s / 设备 -1s 叠加、偏移清零立即生效 |
| 2026-11-03 | Playwright 渲染悬浮窗三态（播放 / 暂停 / 停止 × 循环三态 × 音量档位） | 按钮 32×32、图标 20px、状态切换正确 |
| 2026-11-03 | Playwright 渲染排版与字号（compact / bilingual / 无译文 / 悬停气泡） | 38px / 27px、居中、无溢出、气泡在图标右上方 |
| 2026-11-03 | Playwright 渲染三态排版（640×236：text / text-trans / full / 长句） | 12 项全过：38/27/27、中间态只亮「文」且按钮本身不变色、全亮时「文」+「A」都亮、居中、短句与长句都不溢出、三次点击回到初始态 |
| 2026-11-03 | 结构检查 `check5.cjs`（stub electron + 取 `WIDGET_HTML` + `vm.Script` 编译页面脚本） | 25 项全过：默认透明 / 悬停出底栏 / 固定后 no-drag / 解锁按钮只在 pinned+hover 出现 / 页面监听 hover 通道 / 主进程轮询 / 位置与固定状态的读写调用 |
| 2026-11-03 | Playwright 交互测试（640×236：默认 / 悬停 / 固定 / 固定+悬停 / 解锁） | 21 项全过：默认透明、悬停 `rgba(0,0,0,.58)`、固定后 `rgba(0,0,0,.14)` 且底栏保持隐藏、解锁恢复、`app-region` 按钮全 no-drag |
| 2026-11-03 | 持久化冒烟 `persist.cjs`（stub electron 跑真实 `activate()`，两轮模拟重启） | 10 项全过：默认位置 640,756、拖动后写入 100,200、固定 true/false 落盘、非悬浮窗来源的消息被忽略、重启恢复坐标、加载后推固定状态、越界坐标回退默认 |
| 2026-11-03 | Playwright 页面恢复测试（`ipcRenderer._h` 注入 pinned 事件） | 7 项全过：恢复固定态 / 图标 pin-off / 点解锁上报 false / 点图钉上报 true |
| 2026-11-03 | 持久化冒烟追加排版（`persist.cjs` 扩到 14 项 / `restore.cjs` 扩到 12 项） | 全过：排版 full/text 落盘、坏值忽略、重启后推给页面、页面恢复三行并隐藏译文、点按钮上报新模式 |
| 2026-11-04 | `node --check client.mjs` / `node --check main.cjs`（独立常驻重构后） | 通过 |
| 2026-11-04 | 独立常驻重构 mock harness（伪 folium + localStorage，直接 import 真实 client.mjs） | 14 项全过：不注册 visualizer、首帧 payload 结构与内容、内容去重、action 转发与参数校验（音量 clamp）、request-sync 强制重发、theme.changed 缓存、100ms 轮询、卸载清理、单曲 +5s 偏移、设备级 -1s 叠加、宿主未就绪不抛错且就绪后补发、旧样式选择清理且不误伤其它值、非 main 上下文早退、句间保留上一句 |
| 2026-11-05 | `node --check main.cjs` / `node --check client.mjs`（1.0.1 任务栏守卫后） | 通过 |
| 2026-11-05 | 任务栏守卫 harness（stub electron 跑真实 `activate()`，伪显示器 / 伪定时器，临时脚本用完即删） | 21 项全过：工作区内不调 `moveTop`、压住底部 / 顶部 / 左侧 / 右侧任务栏都调、只压 7px 不调 / 压 8px 调、置顶被改掉时先补 `setAlwaysOnTop(true,'screen-saver')`、任务栏自动隐藏不调、副屏有任务栏而主屏没有时只在副屏命中、窗口不可见不调、`closed` / `dispose` 后不再调、`ready-to-show` 后立即提升、Windows 恢复「停在任务栏上」的坐标、跑出屏幕的坐标回退默认、macOS 按 `workArea` 判位置（只落在 Dock 带的坐标回退默认）且不开守卫 |
| 2026-11-05 | 穿透 harness（stub electron 跑真实 `activate()`，伪光标 / 伪显示器；审查 H1 修复后重跑） | 14 项全过：未固定不吃鼠标、固定 + 光标在外整窗穿透、光标落在按钮上恢复可点、歌词区穿透、按钮外 1px 仍命中（2px 余量）/ 外 5px 穿透、取消固定立刻恢复、窗口不可见按穿透处理、销毁后轮询自停、`setIgnoreMouseEvents` 抛错后下一轮重试成功、光标接口抛错后 fail-open 且轮询继续、畸形矩形清空后保持可点（含光标在窗外） |
| 2026-11-05 | jsdom 页面 harness（1.2.0 改动；审查 M2 修复后重跑） | 8 项全过：固定态 `#pin` 常驻 `pointer-events:auto`、`.hover #pin` 不再重复设 pointer-events、未固定 `blur` 清 hover、固定态 `blur` 保留 hover、主进程推送 `pinned=true` 后切固定态、点按钮解锁并上报 `pinned=false` |
| 2026-11-05 | 1.1.0 结构 + 交互 harness（`vm` 取 `WIDGET_HTML` + jsdom 跑页面脚本 + 桩 `ipcRenderer`，临时脚本用完即删） | 19 项全过：无 `.song`、无 `#unlock`、无 `#pin::before` 文字、`.controls` 是 `.widget` 首子元素且后接 `.lyric`、左右组 3/5 个控件、`#pin` 夹在两组之间居中、初始 floating + 「固定位置」、点击切到 pinned + pin-off + 上报 true、再点回 floating + 上报 false、`IPC_PINNED` 双向、hover 类切换、数据渲染（原文/译文/罗马音/循环图标/音量/暂停图标）、排版三态循环并上报、prev/next/toggle 指令、气泡向下弹并居中、固定态隐藏两侧、锁定按钮 `width:32px` |
| 2026-11-05 | jsdom 页面 harness（1.3.0 排版改名与窗口压高；临时脚本用完即删） | 23 项全过：初始 `text`、点击循环 `text → text-trans → roman → text` 且上报正确、全程无 `full` 上报、`text` 只一行、`text-trans` 第二行=译文、`roman` 有罗马音时只显示罗马音（第三行恒空）、`roman` 缺罗马音回退译文、两者都缺第二行隐藏、空原文不被「等待播放...」顶掉、主进程推 `roman` 生效 / 推非法值被忽略、`WINDOW_HEIGHT` 已随压缩调整、`LEGACY_LAYOUT_IDS` 映射 `full→roman`、CSS 只亮「A」且无 `full` 残留 |
| 2026-11-06 | 显隐 + 关闭 harness（stub electron 跑真实 `activate()`：`toggle-widget`、页面 × 关闭、状态文件 `open`；临时脚本用完即删） | 16 项全过：`toggle-widget` 两次切换、隐藏期间不往窗口发数据且不被下一条数据复活、状态文件写 `open`、页面 × 只关悬浮窗不注销模组、只认本窗口 webContents 的关闭消息、老存档无 `open` 视为显示、`open:false` 启动保持隐藏、`dispose` 清理 IPC 监听 |
| 2026-11-06 | jsdom 页面 + client harness（右上角 ×、固定态可见性、播放条「词」按钮；临时脚本用完即删） | 10 项全过：`#close` 存在且默认透明、点击上报 close 通道、固定态控制条隐藏但 `#pin` 可见、固定态点解锁仍上报、`hover` 让 × 出现、client 注册 `progress.trailing` / `order:480` / 文字为「词」、点按钮调用 `toggle-widget` 并按返回高亮、主进程推 `widget-visibility` 切高亮、老宿主无 `progressButtons` 静默跳过 |
| 2026-11-06 | 审查修复回归 harness（stub electron 跑真实 `activate()` + client 按钮；`.tmp-v14b` 用完即删） | 19 项全过：`widget-visibility` 推送失败时不记去重键 → `update-data` 重推成功 → 之后去重生效、toggle 隐藏且只推一条、落盘走防抖且到期 `open:false` 落地、debug 通道拒绝陌生 sender / 接受本窗口、固定态 `.controls` 断点击、`dispose` 移除监听；client 按钮 11 项全过：`progress.trailing` / `order:480` / 文字「词」、`rpc.call` 同步抛错立即回滚、成功按返回值对齐、Promise 拒绝回滚、`dispose` 退订阅 + 回收注册项 + 移除 `<style>` |
| 2026-11-06 | 1.4.1 shadow DOM / 首帧 / 重叠 harness（`vm` 载入真实 `client.mjs` + 伪 ShadowRoot；`.tmp-fix` 用完即删） | 13 项全过：main 注册 `widget-state`、悬停未固定时右组 `padding-right:44px`、`#close` 仍 `right:16`；client 注册「词」按钮、样式注入 ShadowRoot（`document.head` 为空）、样式节点是 `<style>`、CSS 不再写死灰色、按钮 24×24、启动调用 `widget-state`、首帧按返回值高亮、推送 `false` 后变灰、无 shadow 时回退到 `document.head`、`dispose` 回收注册项 |
| 2026-11-06 | 1.4.2 原生造型 / 收起态 harness（`vm` 载入真实 `client.mjs` + 伪 ShadowRoot + 伪注册表；`.tmp-142` 用完即删） | 13 项全过：注册项带 `hideWhenCollapsed: true`、`slot`/`order` 不变、样式注入 ShadowRoot、`border-radius:50%`、`border:none`、22×22、常态 `opacity:.4`、hover 用 `color-mix(currentColor 10%)`、`data-on="true"` 用 `currentColor 20%` 底、CSS 里不再有 `#7dd3fc` / 蓝底 / 24px 旧尺寸 |
| 2026-11-06 | 1.5.0 页面 + client harness（`vm` 取 `WIDGET_HTML` + jsdom 跑页面脚本；`vm` 载入真实 `client.mjs` + 伪注册表；`.tmp-v15` 用完即删） | 30 项全过：默认配置与主进程一致、默认窗高仍是 180、单行更矮、字号 50 更高；配置写入 `--lyric-size` / `--widget-radius` / `--surface-alpha`、切歌词板 / 浅色、无描边时 `--border-alpha:0`；逐字拆词（2 个 span）、1.2s 时只有第一个词 `sung`、歌词板第二行=下一句且可见、暂停态 `data-playback=paused`、关逐字回到整行文本；client 注册 `lyric-widget` 分区、字号下拉 31 项（20…50）、默认 38、外观 8 项齐全、形态 3 项、字体 2 项、激活即推配置、注册 4 条命令并带 `globalShortcut`、字号 +1 写回设置并重推、显示/隐藏命令走 `toggle-widget`、`dispose` 退订阅 |
| 2026-11-06 | 1.5.0 主进程 harness（stub electron 跑真实 `activate()`，故意不给 `api.rpc.send` 走 1.6 兼容；`.tmp-v15` 用完即删） | 16 项全过：默认窗高 180、注册 `config` / `take-commands` / `toggle-pin`、字号 50 时窗高 218、切单行 124、`toggle-widget` 返回 `{visible:false}`、队列里能取到 `widget-visibility`、取空后再取为空、`toggle-pin` 翻 true 并推给页面、再翻回 false、队列上限 32、`dispose` 不抛错 |
| 2026-11-06 | 1.5.0 审查修复 harness（静态断言 `main.cjs` 页面侧 + `import()` 真实 `client.mjs` 检查注册项；`.tmp-v15b` 用完即删） | 27 项全过：浅色底色独立 18%、四态只在悬停且未锁定时出现、`visibilitychange` 停 rAF、`data-playback` 写真实状态、逐字 span 无冗余 `end`、`surfaceOpacity` 下限 0.2、`#rgb` 展开、`widget-state` 带 `canSend`、`take-commands` 送达才记账、1.6 队列不提前记账、`rpc.send` 抛错退队列、位置校验底边、逐帧日志与 `IPC_DEBUG` 已删、`DEBUG=false`；client 分区标题 / 说明 / 12 项设置 / 31 项字号 / 所有下拉选项 / 4 条命令的文案全是语言映射、关键词仍是字符串数组、`activate` 返回 disposer、`dispose` 不抛错 |
| 未做 | 真机 Electron 联调 | 沙箱里 Electron 起不来（`exited-without-window`，exitCode 2147483651=0x80000003；`mojo platform_channel` 拒绝访问）；同样起不了 GUI 浏览器截图（Edge headless 报 `OpenProcess: 拒绝访问 (0x5)` + `platform_channel.cc:187 Check failed`），1.5.0 的视觉效果只能靠 jsdom 断言 + 真机 |
| 2026-11-06 | 1.6.0 形态链路 harness（stub electron 跑真实 `activate()` + jsdom 页面；`.tmp-160` 用完即删） | 22 项全过：默认形态 desktop、`widget-state` 返回 `{visible,surface,canSend}`、切 window 后桌面窗口 `hide()` 且不再发数据帧、切回 desktop 窗口重现并按 workArea 复位尺寸、不带参数来回切换、老存档 `surface:'window'` 启动即隐藏、1.5.x 扁平配置迁移成三段、`config` 回包带 `surface` 且不覆盖形态、页面 `IPC_SURFACE` 触发切换、陌生 sender 被忽略、`dispose` 移除监听 |
| 2026-11-06 | 1.6.0 页面 + client harness（`vm` 取 `WIDGET_HTML` + jsdom 跑页面脚本；`vm` 载入真实 `client.mjs` 做静态与结构断言；`.tmp-160` 用完即删） | 9 项全过：`#switch-surface` 存在且初始 `data-mode="desktop"`、点击发 `my-lyric-widget:surface`、收到 `window` 后变蓝并把提示改成「切换到桌面歌词」、页面无 board/single 分支、逐字读 `config.shared` / 长句缩放读 `config.desktop`、client `readConfigFromHandle` 输出三段、设置分区带 `settingsPanel` 与「通用」分组、分段控件两项 + `aria-pressed` + 宿主 `--st-fill`/`--st-raise`、命令面板含 `lyric-widget-switch-surface` |
| 2026-11-06 | 1.6.1 harness（stub electron 跑真实 `activate()` + jsdom 跑真实页面脚本 + 静态断言 `client.mjs`；`.tmp-161` 用完即删） | 25 项全过：`DEFAULT_CONFIG.desktop` 有 `marquee` 无 `fitText`、main 里不再出现 `settingsPanel`、页面是视口+轨道两层、切换键在 `.controls-mid` 内且排在 `#pin` 之后、`#switch-surface` 绝对定位到 `calc(100% + 8px)`、数据监听注册成功、文本写进轨道、溢出加 `is-scrolling`、溢出时不改字号、短句复位、迟到旧帧不覆盖当前句、空隙帧之后正常前进、`display:'window'` 生效并隐藏窗口、切回 desktop 恢复、× 能关窗口、重开立刻补发最后一份快照（`line.index === 7`）、`widget-visibility` 带 `surface`、rAF 真的在平移轨道、需要速度过大时才把字号缩到 80%、client 有 `display` 下拉且不再传 `settingsPanel:`、`readConfigFromHandle` 带 `display`/`marquee` |
| 2026-11-06 | 1.6.2 harness（stub electron 跑真实 `activate()`；`.tmp-162` 用完即删） | 14 项全过：打开状态转发数据帧、`closed` 处理器不抛错、× 关掉后 `widget-state` 仍报 `surface:'desktop'` 且 `visible:false`、命令打开后 `visible:true`、重开后数据帧继续转发（不再卡死）、重开补发的是最新一句（`line.index === 2`）、能切到 `window` 形态、悬浮窗形态下「显示」会切回桌面、切回后继续转发；静态断言 `.controls-mid` 绝对定位 50%、`#switch-surface` 定位 `calc(100% + 8px)`、固定态 `visibility:hidden` + `pointer-events:none`、`MARQUEE_LEAD_IN = 1.2`、走马灯有 `delay` 状态 |
| 2026-11-07 | 1.6.3 harness（jsdom 跑真实 `WIDGET_HTML` 页面脚本；`.tmp-163` 用完即删） | 10 项全过：右组 `padding-left:40px`、固定键仍绝对居中 50%、音量条 `max-width:76px` / `min-width:40px`、同会话内迟到旧帧仍被挡住、**换歌后新歌第一句立刻显示**（`shownSessionId` 重置基准）、换歌后继续正常前进、渲染代码里存在 `sessionId !== shownSessionId` 分支 |

## 8. 无 HEADLESS 覆盖的部分

以下只能真机 / 完整桌面构建里验证（`skills/run-desktop`）：

- 透明窗口、圆角、置顶、`showInactive` 的实际显示效果，DWM 圆角残影；
- data URL 页面里 `require('electron')` 是否可用；
- `browser-window-created` 的触发时机（悬浮窗构造期间用 `state.creatingWidget` 自我排除）；
- 宿主换主窗口 / 壁纸模式重建主窗口时窗口集合的交接；
- macOS 全屏空间与点 Dock 恢复主窗口；
- 拖动（`-webkit-app-region: drag`）与按钮 `no-drag` 的实际手感。
- 38px 原文 + 27px 次行（译文 / 罗马音）在 640×180 窗口里的真实留白（无头浏览器与 Windows 字体度量有差异）；
- 640×180 在 125% / 150% 缩放的 Windows 上是否仍够高（窗口尺寸是逻辑像素，系统缩放会放大实际占位）。
- 自绘悬停气泡在真实窗口（无边框、置顶）上是否被窗口边缘裁掉；
- 预览片段起点造成的兜底路径偏差（真实播放器里才有的状态，见 §4.2）。
- Windows 上任务栏 `bounds - workArea` 的真实取值（多屏 / 缩放 / 第三方 AppBar 如 DisplayFusion 多屏任务栏）；
- 「拖到任务栏上 / 点任务栏 / 打开开始菜单 / 通知中心 / 任务栏缩略图预览」之后的真实 z 序（§4.10 的核心场景）；
- 每 500ms 一次的 `moveTop()` 在透明无边框窗口上会不会带来可见闪烁或拖拽手感变化（`SWP_NOACTIVATE` 下理论上不会）。
- 1.1.0 顶部控制条的真实观感：锁定态那颗 32×32 高亮按钮在浅色 / 深色壁纸上的对比度与「一眼看出能点」的程度、
  与两侧按钮的距离；顶部绝对定位的控制条与第一行歌词的真实间距（1.3.0 起窗口 180 高、`.lyric` 上内边距 33px，理论余量约 14px）；
- 气泡向下弹时是否压住第一行歌词（气泡 `z-index` 与歌词同层，靠 `opacity` 区分）；
- 文字 `text-shadow` 在浅色 / 深色 / 花哨壁纸上的实际可读性与「阴影感」强弱（§4.13 的判定依据之一）；
- Windows 11 DWM 是否给无边框透明窗口额外画一圈灰影 / 圆角描边（`hasShadow:false` 管不到 DWM）。
- 1.2.0 部分穿透：`setIgnoreMouseEvents(true, { forward: true })` 在 Win11 上是否让远处窗口的悬停状态正确复位；
  快速划入按钮时第一下是否会落空（命中判定最多 80ms 延迟）；125% / 150% 缩放下按钮矩形是否需要换算；
  穿透态与 `moveTop()` 任务栏守卫同时作用时的实际手感（`setIgnoreMouseEvents` 是否会打断置顶）。
- 1.2.0 去阴影：`roundedCorners:false` + `thickFrame:false` 之后圆角位置是否还有 1px 描边、整窗拖拽是否仍正常、
  窗口动画消失是否有可感知的副作用；固定态悬停「只剩按钮」在浅色壁纸上是否还看得清（按钮自带深底 + 蓝色描边）。
  都需要真机验证。
- 1.3.0 两行排版：180 高里两行的真实留白与观感（首行理论离控制条 ~14px、底部 ~29px；单行态首行 ~84px 是否显得偏下）、
  三种态切换时第二行是否即时变化、老存档 `layout:"full"` 升级后是否真的落在 `roman`、
  125% / 150% 缩放下 180 高是否仍够（逻辑像素 × 缩放）、
  窗口变矮后默认落点与任务栏守卫的手感是否变化。
- 1.4.0 显隐与播放条按钮：「词」按钮在进度条右侧的真实位置（是否和 enhanced-remote-widget 的按钮挨在一起、
  `order:480` 是否与其他模组冲突）、蓝 / 灰两态在深色与浅色播放条上的可辨识度；点按钮 / 点 × 时窗口显隐是否即时无闪烁；
  隐藏期间切歌、暂停、换壁纸是否都不再弹窗；重启宿主后隐藏状态是否保持；固定态悬停时能否同时看到 × 与「取消锁定」；
  宿主在别的页面（如设置页）时按钮是否存在、显隐状态是否被正确回推。
- 1.4.2 原生造型：22px 圆形「词」与旁边线性图标是否真的同一视觉重量、常态 40% 透明是否够淡又不至于看不见、
  开启态 `color-mix(currentColor 20%)` 底色在深色 / 浅色播放条上是否都看得出来（浅色主题下应变深底）、
  `hideWhenCollapsed` 之后收起态是否完全不出现按钮（宿主 `collapsed` 判定与实际收起动画一致）、
  展开态下按钮与时间 / 进度条 / 其他模组按钮的间距是否自然。
- 1.5.0 配置类：设置面板里 12 项控件的真实排版（下拉 31 项是否好滚）、改字号后窗口高度与底边是否稳定不跳、
  20 / 50 两端字号下歌词是否被裁、单行 ↔ 歌词板切换的一次性跳动是否可接受；
  逐字染色在真实播放器上是否跟得上（100ms 位置 + rAF 外推，句内是否有卡顿或超前）、
  `--sung-color` 在浅色 / 深色壁纸上的可读性、未唱透明度 0.2 时是否已经看不清；
  「跟随主题字体」在没收到 `theme.changed` 时是否回落到系统栈；
  命令面板四条在宿主里的实际入口与执行结果（含 1.6 宿主上是否仍能显示/隐藏并高亮）；
  1.6 兼容层的 150ms 轮询在低配机器上是否带来额外开销（理论可忽略：一次 RPC 空数组）。
- 1.6.0 形态切换：切到「悬浮窗歌词」后桌面窗口是否立即隐藏且不闪一下（`hide()` 与 `showInactive()` 的时序）；
  切换键（1.6.1 起在「固定」左边）与固定键的间距、两态（灰 / 蓝 `#7dd3fc`）在深色与浅色壁纸上的辨识度；
  设置「通用」组第一项 `display` 下拉在宿主里的真实排版；命令面板里「歌词：切换桌面歌词 / 悬浮窗歌词」的实际入口；
  切到悬浮窗形态后重启 Folia，是否仍记住形态且桌面窗口不出现；切回后窗口位置 / 尺寸 / 固定态是否复原；
  以及悬浮窗形态目前不显示任何窗口这一阶段性行为，在真机上是否会被误认为「坏了」（§4.18）。
- 1.6.1 六条修复：切换键在固定键左边之后，固定键是否**看起来**仍严格居中（左右两侧按钮数量不同，视觉重心会偏）；
  设置表单恢复后 13 项控件（含 `display` 下拉与「长句滚动显示」开关）在宿主的真实排版与滚动；
  长句滚动的真实观感（60~400 px/s 是否够快、换句复位是否干脆、滚动中切歌 / 暂停 / 拖不透明度是否卡）；
  单语言歌曲句间空隙帧是否真的不再闪回上一句；× 关掉再打开是否立刻是最新一句；
  逐字染色在长句滚动时是否跟着文字一起平移（`transform` 在视口上、染色在轨道上，理论上同步）。
- 1.6.2 修复：未固定时「固定」键是否真的落在窗口水平中线（左右按钮数量不同，1.6.1 偏左）；
  固定态是否只看见正中那颗解锁按钮（切换键应完全消失）；设置里 `display` 下拉初始值是否与窗口形态一致；
  × 关掉再打开后是否立刻是最新一句、且继续跟着换歌走（1.6.1 在这里会永久卡住）；
  长句滚动在句首是否留了约 1 秒再动、速度 380 px/s 上限是否合适。
