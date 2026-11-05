# my-lyric-widget 迭代文档

独立悬浮歌词模组 `mods/my-lyric-widget/` 的迭代记录：每一轮做了什么、为什么这么做、哪些没做。
接手时先读 [交接文档](my-lyric-widget-handoff.md)，那里是「现在是什么样、下一步做什么」；本文件是「为什么长成这样」的来龙去脉。

- 模组 id：`my-lyric-widget`，名称「独立悬浮歌词」。`mod.json` 里的版本号现在是 **1.3.0**（client 1.0.0 / main 1.3.0）。
  早期红线「不动 `mod.json`」已由用户放开：版本号随每轮改动更新（功能迭代进 y、修 bug 进 z）。
- 目录里只有 3 个文件：`mod.json`、`client.mjs`、`main.cjs`（外加 `docs/`）；目录本身是个独立 git 仓库。
- 最后更新：2026-11-05。

## 1. 它是什么

Folia 桌面版里一个「把歌词拿到播放器窗口之外去显示」的模组。用户选中本模组注册的歌词样式（`mod:my-lyric-widget:lyric-widget`）后：

- 渲染进程的 `client.mjs` 只做数据搬运：订阅播放状态和歌词上下文，把整份快照用 `folium.rpc.call('update-data', payload)` 发给本模组的主进程；
- 主进程的 `main.cjs` 开一个无边框、透明、置顶、不抢焦点的 640×180 小窗，把最新快照渲染出来，窗口上的按钮/音量条再把控制指令用 `api.rpc.send('action', ...)` 发回渲染进程执行。

歌词样式的画面本身是空的：真正的界面在主进程那个独立窗口里，所以模组没有被选中时窗口显示「等待播放...」。

## 2. 当前版本状态（代码 1.3.0，`mod.json` 记 1.3.0）

| 文件 | 行数 | 说明 |
| --- | --- | --- |
| `mod.json` | 13 | `folium: 1`，`permissions: ["playback.control", "playback.read"]`，`version: "1.3.0"`（1.0.1 任务栏遮挡见 §4.10；1.1.0 顶部控制条见 §4.11；1.2.0 部分点击穿透 + 去系统阴影见 §4.12 / §4.14；1.3.0 第三态改罗马音、窗口压到 180 高见 §4.15） |
| `client.mjs` | 581 | client 入口：**独立常驻**同步引擎（100ms 自主轮询 + 事件），不注册 visualizer、无 mount / ctx；接收 action |
| `main.cjs` | 1650 | main 入口：悬浮窗（data URL 页面，640×180）+ 宿主窗口跟踪 + 指令归一化 + 顶部控制条（左：上一首 / 播放 / 下一首，正中：固定 / 取消锁定，右：循环 / 排版 / 音量）+ 三态排版（两行）/ 字号 / 悬停显隐 + 窗口状态持久化（位置 / 固定 / 排版）+ 任务栏守卫（§4.10）+ 固定态部分点击穿透（§4.12） |

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
| F12 | 逐字 / 卡拉 OK 高亮（payload 里 `line.words` 恒为 `null`，位置已留） | 未规划 |
| F13 | 主进程侧进度条 / 时间显示 | 未规划 |
| F14 | 窗口位置持久化、窗口尺寸 / 窗口关闭入口 | 未规划（字体自定义见 §4.7） |
| F15 | 底部控件图标化（内联 lucide SVG；播放/暂停实心、循环三态、音量档位） | 已上线（main 0.3.4） |
| F16 | 悬停中文提示：自绘气泡（1.1.0 起从图标**下方**弹出，因为控制条在顶部） | 已上线（main 0.3.4，1.1.0 调方向） |
| F17 | 排版三态：都灭=只原文 / 只亮图标里的「文」=原文+译文 / 只亮「A」=原文+罗马音（行里没有罗马音就退回译文） | 已上线（main 0.3.4；0.3.5 改成按字形点亮并记住选择；1.3.0 第三态由「三行全亮」改成「只亮 A」，见 §4.15） |
| F18 | 字号：原文 38px、译文与罗马音 27px（原文 0.7 倍向上取整） | 已上线（main 0.3.4） |
| F19 | 字体大小 / 字体颜色自定义 | 想法，未实现；入口已定为 `settingsSections`（设置 → 高级 → 模组，见 §4.7） |
| F20 | 窗口尺寸 640×180（两行排版） | 已上线（main 0.3.4 为 640×236 三行版；1.3.0 压到 640×200，随后按「底部空白太多」再压到 640×180，见 §4.15） |
| F21 | 从「歌词样式」独立成单独功能 + 主程序设置里的自有设置界面 | **部分上线**：功能已独立（1.0.0，F26）；自有设置界面仍是想法（评估见 §4.8） |
| F26 | 独立常驻功能模组：只要模组启用就工作，与当前歌词样式无关（不再注册 visualizer / 不再依赖 mount） | 已上线（client 1.0.0，见 §4.9） |
| F27 | 任务栏守卫（仅 Windows、非自动隐藏任务栏）：窗口压在任务栏上时显示在任务栏之上；该位置重启后仍能恢复 | 已上线（main 1.0.1，见 §4.10） |
| F28 | 1.1.0 顶部控制条：删掉歌曲名行；按钮全部移到窗口顶部；固定键严格水平居中，锁定时变成高亮的「取消锁定」图标按钮（不带文字） | 已上线（main 1.1.0，见 §4.11） |
| F29 | 部分点击穿透：锁定时只有「取消锁定」按钮接收鼠标，其余矩形（含歌词区）穿透 | 已上线（main 1.2.0，见 §4.12；真机待验） |
| F30 | 去掉窗口四周系统阴影 / 圆角描边；固定态悬停不再铺底色、不描边 | 已上线（main 1.2.0，见 §4.14；真机待验） |
| F31 | 1.3.0 排版第三态改成「原文 + 罗马音」（没有罗马音回退译文）、三行排版下线、窗口高度 236 → 200 → 180 | 已上线（main 1.3.0，见 §4.15；真机待验） |

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
| 未做 | 真机 Electron 联调 | 沙箱里 Electron 起不来（`exited-without-window`，exitCode 2147483651=0x80000003；`mojo platform_channel` 拒绝访问）；同样起不了 GUI 浏览器截图（Edge headless 报 `OpenProcess: 拒绝访问 (0x5)` + `platform_channel.cc:187 Check failed`），1.1.0 的视觉只能靠 jsdom 断言 + 真机 |

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
