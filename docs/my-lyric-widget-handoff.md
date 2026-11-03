# my-lyric-widget 交接文档

给接手的人或下一个会话：**现在是什么状态、怎么验证、下一步做什么**。为什么长成这样读
[迭代文档](my-lyric-widget-iterations.md)；Folium 的接口细节读 `mods/README.md`、`docs/folium/api.md`、`mods/folium.d.ts`。

最后更新：2026-11-03，对应模组版本 0.3.2。

## 1. 一句话

在 `mods/my-lyric-widget/`：`client.mjs` 把播放状态和当前歌词行搬给本模组的主进程，`main.cjs` 开一个独立的
无边框透明置顶小窗显示歌词和播放控制。歌词样式本身是空白的。

## 2. 文件

| 路径 | 作用 |
| --- | --- |
| `mods/my-lyric-widget/mod.json` | 版本 0.3.2；`folium: 1`；`permissions: ["playback.control", "playback.read"]`；`client: client.mjs`，`main: main.cjs` |
| `mods/my-lyric-widget/client.mjs` | 323 行。注册空 visualizer（id `lyric-widget`，模式 id `mod:my-lyric-widget:lyric-widget`），挂载时同步快照、接收 action |
| `mods/my-lyric-widget/main.cjs` | 743 行。悬浮窗页面（内联 HTML）、宿主窗口跟踪、指令归一化、RPC 收发、dispose |
| `mods/my-lyric-widget/.git` | 模组目录自己是个 git 仓库（`2ad2d6e` 是 client 首版；之后 main/client/mod.json 的改动都还没提交） |
| 本文件 / `my-lyric-widget-iterations.md` | 放在仓库 `docs/`，**不在模组目录里**（模组目录里的每个文件都算模组内容） |

## 3. 数据流与协议

```
client.mjs  --folium.rpc.call('update-data', payload)--> main.cjs: api.rpc.handle('update-data', ...)
client.mjs  <--folium.rpc.on('action', handler)---------- main.cjs: api.rpc.send('action', action)
悬浮窗页面  --ipcRenderer.send('my-lyric-widget:action-to-client', ...)--> main.cjs: ipcMain.on(...)
悬浮窗页面  <--ipcRenderer.on('my-lyric-widget:data-from-client')------- main.cjs: webContents.send(...)
```

- **client → main 只有 `rpc.call`**，client 侧没有 `rpc.send`（那是 main 侧的 API）。名字 `update-data` 两边各有一个常量（`RPC_UPDATE`）。
- **main → client 只有 `rpc.send`**（Folium 1.7+，不排队、不重放，client 未激活/窗口重建时直接丢）。
  所以窗口 `did-finish-load` 时主进程会补发最后一份快照，再发一次 `request-sync`。
- **payload 字段**（client.mjs 文件头有完整注释）：
  `playSessionId`、`song{id,title,artist,album,source}|null`、`state`、`position`、`duration`、`liked`、`canLike`、
  `volume`、`muted`、`loopMode`、`line{index,text,translation,romanization,words,startTime,endTime}`、
  `theme{name,isDaylight,backgroundColor,primaryColor,accentColor,secondaryColor,fontStyle,fontStack}`。
  窗口目前只用到 `song`、`state`、`volume`、`loopMode`、`line`。
- **action 的规范形状**：`{action:'next'|'prev'|'toggle'|'request-sync'}`、`{action:'set-volume',volume:0–1}`、
  `{action:'set-loop',mode:'off'|'all'|'one'}`。窗口页面发简写（`'next'`、`{type:'set-volume',value:0–100}`、
  `{type:'set-loop',value}`、`{type:'cycle-loop'}`），由 `main.cjs` 的 `normalizeAction` 归一化。
- 窗口的 `sender` 必须等于本悬浮窗的 `webContents`，否则只记 warn、不转发。

## 4. 关键位置（按行号）

`mods/my-lyric-widget/client.mjs`

| 行 | 内容 |
| --- | --- |
| 1–50 | 文件头：payload / action 形状、约定 |
| 52–56 | 常量：`RPC_UPDATE`、`RPC_ACTION`、`ACTION_REQUEST_SYNC`、`WAITING_LINE_TEXT`、`LOOP_MODES` |
| 61–74 | `createPlaySessionId`、`createPlaySession`（`id` / `songKey` / `state` / `pendingSongStart`） |
| 77–93 | `getSongKey`（source+id，没有 id 退回 title+artist）、`readSong`（去掉 `ref`） |
| 96–126 | `readLine`：`ctx.getLineIndex()` ≥ 0 取 `ctx.lines[index]`，否则 `folium.lyrics.getRecentCompletedLine` |
| 129–141 | `readTheme`（含 `folium.theme.resolveFontStack`） |
| 144–161 | `buildPayload` |
| 164–188 | `refreshPlaySession`：换歌 / 从 stopped 重新开始才换 `playSessionId` |
| 191–226 | `handleAction`：next / prev / toggle / set-volume（只收有限 number）/ set-loop |
| 232–311 | `mountLyricWidget`：守卫、`syncData`（JSON 去重 + 失败清键 + 每个挂载周期只 warn 一次）、监听登记、卸载只撤监听 |
| 313–323 | `activate`：`registries.visualizers.register` |

`mods/my-lyric-widget/main.cjs`

| 行 | 内容 |
| --- | --- |
| 1–37 | 文件头：数据流、约定 |
| 40–68 | 常量：RPC 名、IPC 通道、窗口尺寸/边距、`HOST_EMPTY_GRACE_MS = 300`、`MAX_CRASH_RELOADS = 2`、`CRASH_RELOAD_WINDOW_MS = 60000`、`MAX_WIDGET_RECREATES = 3` |
| 73–98 | `describeForLog`、`toFiniteNumber`、`nextLoopMode` |
| 104–356 | `WIDGET_HTML`：样式 + 页面脚本（`render`、音量节流 `scheduleVolume`/`sendVolume`、`ipcRenderer.on(IPC_DATA)`） |
| 358–375 | `activate` 内的 `state`（win / lastPayload / lastLoopMode / hostWindows / crashTimes / recreateAttempts / disposed） |
| 378–392 | `sendActionToClient`（`api.rpc.send`，1.7 检查） |
| 395–408 | `resolveLoopMode` |
| 414–463 | `normalizeAction` |
| 466–492 | `sendPayloadToWindow`、`onActionFromWindow` |
| 495–607 | `placeWindow`、`createWidgetWindow`（窗口选项、开窗/导航拦截、`showInactive`、`did-finish-load` 补发、崩溃 reload、`loadURL` 失败销毁） |
| 615–694 | 宿主窗口跟踪：`trackHostWindow` / `collectHostWindows` / `scheduleHostEmptyCheck` / `closeWidgetWindow` / `ensureWidgetWindow` / `onBrowserWindowCreated` |
| 697–743 | `api.rpc.handle('update-data')`、`ipcMain.on`、`app.on('browser-window-created')`、`api.onDispose(dispose)`、首建窗口 |

## 5. 怎么验证

1. `node --check mods/my-lyric-widget/client.mjs` 和 `node --check mods/my-lyric-widget/main.cjs`。
2. `npm run folium:check -- my-lyric-widget`：应退出码 0，只有「没有 preview 图」「没有签名」两条 note。
   它只读文件、不运行模组，改完 `mod.json` / 注册表名称 / 权限必须跑。
3. 真机：`skills/run-desktop` 的驱动（`node skills/run-desktop/driver.mjs serve`，隔离 profile），
   设置 → 模组打开「模组系统」→ 重载 → 启用 `my-lyric-widget` → 歌词动画选「悬浮歌词」。驱动用 `windows` 看悬浮窗、
   `ss` 截图、主进程日志在 `test-results/run-desktop/main.log`（找 `[lyric-widget]`）。
   **不要用 `npm run dev:electron`（真实 profile）。**
4. 注意：当前会话沙箱里 Electron 起不来（`exited-without-window` / exitCode 2147483651），只做过 mock 冒烟。

## 6. 已知限制（都不是 bug，改之前先确认要不要改）

- **必须选中「悬浮歌词」样式才同步**：`mount` 只在本样式选中时调用；切走后窗口冻在最后一帧。
  想任意样式下都同步，现有 API 做不到（见迭代文档 §4.2）。
- **导出窗口**：visualizer 注册必须保留，否则导出会报错停下；`mount` 在导出窗口/预览里早退，不推数据。
  导出画面里本样式是空白，可考虑加 `hostLayers: { background: false, subtitles: false }`。
- **`position` 是事件时刻的快照**，进度条要主进程自己外推。
- **窗口安全配置是用户指定的**：`nodeIntegration: true`、`contextIsolation: false`、`sandbox: false`。
  页面用 `textContent` 写歌词，**不要改成拼 HTML**。
- **循环模式只有 off/all/one**（宿主没有随机），窗口显示 不循环 / 列表循环 / 单曲循环。
- **窗口没有关闭入口**：用户关掉后，下一条数据到达时会重建；重建有次数上限（3 次），达上限后只 warn。
- **macOS 也随宿主收窗**，原因是宿主 `app.on('activate')` 只在没有任何窗口时才重建主窗口。
- **`muted` 只读**，没有 `set-muted` action。
- **长歌词**：`26px` 单行 `nowrap`，超出省略号；窗口 600px 约 21 个汉字。

## 7. 下一步建议（按优先级）

1. **真机联调**（最高优先级）：用 `skills/run-desktop` 过一遍第 5 节第 3 步，重点看透明窗口、`require('electron')`、
   拖动、按钮/音量是否真的发到播放器，主进程日志有没有 `[lyric-widget]` 警告。这是目前唯一没覆盖的大块。
2. **长歌词自适应**：26px 单行截断；可按长度降字号或允许两行。
3. **窗口位置持久化**：用 `api.storage`（需在 `mod.json` 加 `filesystem.data` 权限）记住用户拖到的位置；
   顺便考虑右下角默认位置、穿透开关、窗口关闭按钮（目前都没有）。
4. **进度条 / 时间**：需要主进程按 `position` + `duration` 外推，或轮询 `api.runtime.getPlaybackSnapshot()`（已声明 `playback.read`）。
5. **逐字 / 卡拉 OK**：payload 里 `line.words` 已留位置，client 改为传 `line.words`；渲染时仍然只能用 `textContent`/DOM 节点，不能拼 HTML。
6. **`set-muted`**：需要的话加 action，client 调 `folium.playback.setMuted`。

## 8. 工作区注意事项

- 仓库根目录 `package-lock.json` 有一处 `peer` 标记挪动的改动，**不是本任务产生的**，不要当成自己的改动提交。
- 仓库根目录的 `.cc-safety-net/` 是本机一个命令检查插件的项目级声明，与模组无关。
- 模组目录里的 `.git` 是独立仓库，提交模组改动要在 `mods/my-lyric-widget` 里操作。
