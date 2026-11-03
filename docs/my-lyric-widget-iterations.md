# my-lyric-widget 迭代文档

独立悬浮歌词模组 `mods/my-lyric-widget/` 的迭代记录：每一轮做了什么、为什么这么做、哪些没做。
接手时先读 [交接文档](my-lyric-widget-handoff.md)，那里是「现在是什么样、下一步做什么」；本文件是「为什么长成这样」的来龙去脉。

- 模组 id：`my-lyric-widget`，名称「独立悬浮歌词」。`mod.json` 里的版本号仍是 **0.3.2**
  （红线：只允许改 `client.mjs` / `main.cjs`，不动 `mod.json`），代码实际已迭代到 **0.3.5**（client 0.3.3 / main 0.3.5）。
- 目录里只有 3 个文件：`mod.json`、`client.mjs`、`main.cjs`；目录本身是个独立 git 仓库。
- 最后更新：2026-11-03。

## 1. 它是什么

Folia 桌面版里一个「把歌词拿到播放器窗口之外去显示」的模组。用户选中本模组注册的歌词样式（`mod:my-lyric-widget:lyric-widget`）后：

- 渲染进程的 `client.mjs` 只做数据搬运：订阅播放状态和歌词上下文，把整份快照用 `folium.rpc.call('update-data', payload)` 发给本模组的主进程；
- 主进程的 `main.cjs` 开一个无边框、透明、置顶、不抢焦点的 640×236 小窗，把最新快照渲染出来，窗口上的按钮/音量条再把控制指令用 `api.rpc.send('action', ...)` 发回渲染进程执行。

歌词样式的画面本身是空的：真正的界面在主进程那个独立窗口里，所以模组没有被选中时窗口显示「等待播放...」。

## 2. 当前版本状态（代码 0.3.5，`mod.json` 记 0.3.2）

| 文件 | 行数 | 说明 |
| --- | --- | --- |
| `mod.json` | 13 | `folium: 1`，`permissions: ["playback.control", "playback.read"]`；版本号停在 0.3.2（红线不许改） |
| `client.mjs` | 635 | client 入口：注册空 visualizer + 混合同步引擎（挂载精确 / 兜底轮询）+ 接收 action |
| `main.cjs` | 1366 | main 入口：悬浮窗（data URL 页面，640×236）+ 宿主窗口跟踪 + 指令归一化 + 图标 / 三态排版 / 字号 / 悬停显隐 + 固定解锁 + 窗口状态持久化（位置 / 固定 / 排版） |

`playback.control`：`folium.playback` 的切歌/播放暂停/音量/循环模式（`mods/README.md` 权限表）。
`playback.read`：main 侧的 `api.runtime.getPlaybackSnapshot()`（`mods/README.md` 权限表；client 端读播放状态不需要权限）。

## 3. 功能状态

| 编号 | 功能 | 状态 |
| --- | --- | --- |
| F01 | 空歌词视觉组件注册（`registries.visualizers`，id `lyric-widget`） | 已上线 |
| F02 | 快照同步：歌曲、播放状态、位置/时长、喜爱、音量/静音、循环模式、当前行、主题 | 已上线 |
| F03 | 句间保留上一句（`getRecentCompletedLine`），只有第一句之前/无歌词才显示「等待播放...」 | 已上线 |
| F04 | `playSessionId`：同一次播放内不变，换歌 / 从 stopped 重新开始时换新 | 已上线 |
| F05 | 控制指令：next / prev / toggle / set-volume / set-loop / request-sync | 已上线 |
| F06 | 悬浮窗：无边框透明置顶、不抢焦点、底部居中、页面 data URL 内联、CSP 锁死 | 已上线 |
| F07 | 宿主窗口生命周期跟随（宿主窗口全关时收窗、宿主出现新窗口时重建） | 已上线 |
| F08 | 崩溃自愈：页面进程退出每分钟最多自动 reload 2 次 | 已上线 |
| F09 | 窗口页面：歌曲信息 / 原文 / 翻译·罗马音 / 上一首·播放暂停·下一首·循环·音量 | 已上线 |
| F10 | 音量 150ms 节流（宿主每次 `setVolume` 都会保存设置） | 已上线 |
| F11 | 任意歌词样式下同步（不选中本样式也继续同步） | 已上线（0.3.3，见 §4.2 / §4.4） |
| F12 | 逐字 / 卡拉 OK 高亮（payload 里 `line.words` 恒为 `null`，位置已留） | 未规划 |
| F13 | 主进程侧进度条 / 时间显示 | 未规划 |
| F14 | 窗口位置持久化、窗口尺寸 / 窗口关闭入口 | 未规划（字体自定义见 §4.7） |
| F15 | 底部控件图标化（内联 lucide SVG；播放/暂停实心、循环三态、音量档位） | 已上线（main 0.3.4） |
| F16 | 悬停中文提示：自绘气泡，固定出现在图标右上方 | 已上线（main 0.3.4） |
| F17 | 排版三态：都灭=只原文 / 只亮图标里的「文」=原文+译文 / 「文」+「A」都亮=原文+译文+罗马音 | 已上线（main 0.3.4，0.3.5 改成按字形点亮并记住选择） |
| F18 | 字号：原文 38px、译文与罗马音 27px（原文 0.7 倍向上取整） | 已上线（main 0.3.4） |
| F19 | 字体大小 / 字体颜色自定义 | 想法，未实现；入口已定为 `settingsSections`（设置 → 高级 → 模组，见 §4.7） |
| F20 | 窗口尺寸 640×236（三行排版留白） | 已上线（main 0.3.4） |
| F21 | 从「歌词样式」独立成单独功能 + 主程序设置里的自有设置界面 | 想法，未实现（评估见 §4.8） |

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

### 4.2 任意样式下同步（F11，0.3.3 已上线：混合同步）

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
- **点击穿透（click-through）：明确不做，以后也不做**。透明窗口仍然占着 640×236 的矩形，会挡住其下方应用的
  点击与滚轮（未固定时点上去还会把窗口拖走）。彻底解决要 `setIgnoreMouseEvents(true, { forward: true })`，
  但它和「整窗可拖拽 / 底栏可点击」直接冲突（穿透后既拖不动也点不到），需要额外的模式开关和大量边界处理。
  用户 2026-11-03 明确决定永久放弃这个功能，后续不要再提议实现。
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
| 窗口 600×200 → 640×236 | 三行排版（原文 + 译文 + 罗马音）在 200 高里会顶到控件；按内容实测加宽加高 |
| 排版三态按图标字形点亮 | 图标「文A」拆成两组 SVG 子图形：都灭 = 只原文；只亮「文」= 原文 + 译文（`#7dd3fc`，按钮本身不变色）；「文」+「A」都亮 = 三行。点一下前进一态，第三态回到第一态；当前选择存进状态文件，重启恢复 |
| 三态排版是纯显示逻辑，不改变 RPC 协议 | 点按钮后直接用最后一次快照就地重渲染；`payload` 字段不变。只有「记住这次选择」走一条本模组自己的 `my-lyric-widget:layout` IPC（页面→主进程存、下次启动主进程→页面恢复） |
| 译文 / 罗马音只来自歌词源，不生成 | `client.mjs` 的 `readLine` 直接取宿主 `line.translation` / `line.romanization`（`client.mjs:233-234`），宿主不机器翻译、也不生成拼音；纯中文歌若歌词文件没有译文轨，第三态也只显示原文 |
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

## 5. 协议（与 `main.cjs` / `client.mjs` 文件头一致）

```
client.mjs --folium.rpc.call('update-data', payload)--> main.cjs  api.rpc.handle('update-data', handler)
client.mjs <--folium.rpc.on('action', handler)---------- main.cjs  api.rpc.send('action', action)
窗口页面 --ipcRenderer.send('my-lyric-widget:action-to-client', ...)--> main.cjs   ipcMain.on(...)
窗口页面 <--ipcRenderer.on('my-lyric-widget:data-from-client')------- main.cjs   webContents.send(...)
```

**payload**：`playSessionId`、`song{id,title,artist,album,source}|null`（不含 `ref`）、`state`、
`position`、`duration`（未知为 0）、`liked`、`canLike`、`volume`(0–1)、`muted`、`loopMode`、
`line{index,text,translation,romanization,words,startTime,endTime}`、
`theme{name,isDaylight,backgroundColor,primaryColor,accentColor,secondaryColor,fontStyle,fontStack}`。

**action（main → client 的规范形状）**：`{action:'next'|'prev'|'toggle'|'request-sync'}`、
`{action:'set-volume',volume:0–1}`、`{action:'set-loop',mode:'off'|'all'|'one'}`。
**窗口页面的简写**（main.cjs 归一化）：`'prev'|'next'|'toggle'|'request-sync'`、
`{type:'set-volume',value:0–100}`、`{type:'set-loop',value}`、`{type:'cycle-loop'}`。

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
  仍是纯显示逻辑。（0.3.5 已把「整按钮半亮」改成「只亮图标里的『文』」，亮度与第三态相同，见下文 F25。）
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
  主进程只认悬浮窗自己 `webContents` 发来的消息。**点击穿透按用户决定永久不做，见 §4.3。**
- **0.3.5 排版选择持久化 + 按字形高亮（F25）**：排版按钮的图标「文A」在 `main.cjs` 里拆成
  `<g class="icon-zh">` / `<g class="icon-a">` 两组，CSS 按 `data-mode` 只给对应那组上 `#7dd3fc`——
  中间态只亮「文」（亮度与第三态相同），按钮底色不变。当前模式经 `my-lyric-widget:layout` 上报主进程写进
  状态文件，`did-finish-load` 后推回页面恢复（值只接受 `text` / `text-trans` / `full`，坏值忽略）。

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
| 未做 | 真机 Electron 联调 | 沙箱里 Electron 起不来（`exited-without-window`，exitCode 2147483651=0x80000003） |

## 8. 无 HEADLESS 覆盖的部分

以下只能真机 / 完整桌面构建里验证（`skills/run-desktop`）：

- 透明窗口、圆角、置顶、`showInactive` 的实际显示效果，DWM 圆角残影；
- data URL 页面里 `require('electron')` 是否可用；
- `browser-window-created` 的触发时机（悬浮窗构造期间用 `state.creatingWidget` 自我排除）；
- 宿主换主窗口 / 壁纸模式重建主窗口时窗口集合的交接；
- macOS 全屏空间与点 Dock 恢复主窗口；
- 拖动（`-webkit-app-region: drag`）与按钮 `no-drag` 的实际手感。
- 38px 原文 + 27px 译文 + 27px 罗马音在 640×236 窗口里的真实留白（无头浏览器与 Windows 字体度量有差异）；
- 640×236 在 125% / 150% 缩放的 Windows 上是否仍够高（窗口尺寸是逻辑像素，系统缩放会放大实际占位）。
- 自绘悬停气泡在真实窗口（无边框、置顶）上是否被窗口边缘裁掉；
- 预览片段起点造成的兜底路径偏差（真实播放器里才有的状态，见 §4.2）。
