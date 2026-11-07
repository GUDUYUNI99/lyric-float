/**
 * my-lyric-widget 的主进程入口：开一个无边框、透明、置顶的悬浮歌词窗口，
 * 并在 client.mjs 和这个窗口之间搬运数据。
 *
 * 数据流（与 client.mjs 的协议）：
 *   client.mjs -> 主进程：folium.rpc.call('update-data', payload)；
 *       这里用 api.rpc.handle('update-data', ...) 接住，记下最后一份 payload，
 *       再用 win.webContents.send('my-lyric-widget:data-from-client', payload) 交给窗口。
 *   窗口 -> 主进程：ipcRenderer.send('my-lyric-widget:action-to-client', ...)，页面里用简写：
 *       'prev' | 'next' | 'toggle' | 'request-sync'
 *       { type: 'set-volume', value: 0–100 }
 *       { type: 'set-loop', value: 'off' | 'all' | 'one' }
 *       { type: 'cycle-loop' }
 *     也接受 client.mjs 的规范形状（{ action: 'next' }、{ action: 'set-volume', volume: 0–1 } 等）。
 *       这里归一化成 client.mjs 认识的形状，再用 api.rpc.send('action', action) 发回去：
 *       { action: 'prev' | 'next' | 'toggle' }
 *       { action: 'set-volume', volume: 0–1 }
 *       { action: 'set-loop', mode: 'off' | 'all' | 'one' }
 *       { action: 'request-sync' }
 *       { action: 'request-config' }   1.5.1：请 client 把设置整份重推一次（走 RPC_CONFIG）
 *
 * payload 字段见 client.mjs 文件头（playSessionId / song / state / position / duration / liked /
 * canLike / volume / muted / loopMode / line / theme）；窗口只用 state、volume、loopMode、line
 * （song 只出现在调试日志里）。
 *
 * 约定：
 *   - 窗口在模组启用时就创建；此时 client 通常还没发过数据，界面先显示「等待播放...」。
 *     悬浮歌词样式被选中后 client 才开始同步。
 *   - 悬浮窗必须跟着宿主的窗口生命周期走：宿主所有窗口都没了（用户关掉主窗口、Windows 壁纸模式
 *     重建主窗口）时要把它一起关掉，否则 electron 的 window-all-closed 永远不会触发 —— 非 macOS
 *     退不出应用，Windows 壁纸模式也不会重建壁纸。反过来，宿主出现新窗口时若悬浮窗已被关掉，
 *     这里会重新创建它（macOS 点 Dock 图标重开主窗口就靠这条）。
 *   - 循环模式只有 off / all / one；宿主的 playback 没有「随机」这个循环模式，所以窗口显示
 *     不循环 / 列表循环 / 单曲循环。
 *   - 窗口页面是本地 data URL（页面里要 require('electron')，所以开 nodeIntegration、关上下文隔离），
 *     内容全部由本文件生成，歌词只经 textContent 写入，不加载任何外部资源。
 *   - api.rpc.send 是 fire-and-forget：client 没挂载时消息直接丢弃。所以窗口加载完会先补发最后一份
 *     快照，再发一次 request-sync。
 *   - 快照按「帧顺序」挑：同一 playSessionId 内只丢「小幅后退且行号也退回去」的乱序旧帧，
 *     大幅后退（用户拖进度条）一律当真实跳转接受，且连续丢帧有超时兜底 —— 不会因为跳转而停住
 *     （见 isStaleFrame）；换歌由 playSessionId 分桶，新会话一律接受。
 *   - 形态（桌面歌词 / 悬浮窗歌词）：1.3.0 只有桌面歌词，applySurface 是 1.7.0 的接入点，
 *     状态和 IPC 通道已预留，请求 'window' 目前只记日志、不改行为。
 *   - 形态切换的调用协议：client.mjs 用 folium.rpc.call('set-surface', 'desktop' | 'window') 请求，
 *     主进程返回 { ok, code?, surface }。宿主只保留 activate 返回的 dispose 函数，所以不能靠返回值暴露接口。
 *   - 1.4.0 显隐：窗口不再跟着快照无条件显示。client.mjs 播放条上的「词」按钮用
 *     folium.rpc.call('toggle-widget') 切显示/隐藏（返回 { visible }），首帧用
 *     folium.rpc.call('widget-state') 对齐（主进程可能先于 client 推送）；每次显隐变化再用
 *     api.rpc.send('widget-visibility', { visible }) 推回 client 给按钮高亮。
 *     窗口右上角的 × 走 ipcRenderer.send('my-lyric-widget:close')，效果同样是隐藏（模组仍启用）。
 *     隐藏期间照收快照（记 lastPayload）但不转给页面；重新显示时补发最后一份并 request-sync。
 */
'use strict';

const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('fs');
const path = require('path');

const LOG_PREFIX = '[lyric-widget]';

// 和 client.mjs 约定的 RPC 名字（那边是 RPC_UPDATE / RPC_ACTION）。
const RPC_UPDATE = 'update-data';
const RPC_ACTION = 'action';
// 1.4.0：播放条「词」开关。client → main 用 folium.rpc.call 请求，main 用返回值回答。
const RPC_TOGGLE_WIDGET = 'toggle-widget';
// main → client：显隐变化（fire-and-forget，client 没挂载就丢，所以还有下面的首帧对齐）。
const RPC_WIDGET_VISIBILITY = 'widget-visibility';
// client 首帧对齐：问一次当前显隐，避免「main 已经推过、client 才开始监听」造成的按钮高亮错位。
const RPC_WIDGET_STATE = 'widget-state';

// 窗口页面的 IPC 通道。带上模组 id 前缀：ipcMain 的通道是全应用共用的，
// 别的模组若也叫 'action-to-client' 就会收到本窗口的消息。
const IPC_ACTION = 'my-lyric-widget:action-to-client';
const IPC_DATA = 'my-lyric-widget:data-from-client';// 排查用的页面→主进程调试通道（真机定位完连监听一起删掉）。
const IPC_DEBUG = 'my-lyric-widget:debug';
// 主进程→页面的悬停状态（true/false）。整窗是拖拽区时渲染进程收不到鼠标事件，
// 所以「鼠标是否停在窗口上」由主进程轮询光标位置后从这条通道推给页面。
const IPC_HOVER = 'my-lyric-widget:hover';
// 悬停检测的轮询间隔：40~120ms 都够用；80ms 既跟得上手速，又几乎不占 CPU。
const HOVER_POLL_MS = 80;
// 悬停轮询连续失败的次数上限（约 8 秒）：只在窗口已经不可用时才停，单次异常会 fail-open 后继续跑。
const MAX_HOVER_FAILURES = 100;
// 任务栏守卫的轮询间隔：只在窗口压在任务栏上时才动窗口，500ms 足够跟手，也不会频繁重排层序。
const TASKBAR_GUARD_MS = 500;
// 和任务栏至少重叠这么多像素才算「压在任务栏上」：窗口边缘 1px 压线不该让它长期抢占置顶层。
const MIN_TASKBAR_OVERLAP = 8;
// 固定/解锁状态（页面→主进程：用户点了图钉；主进程→页面：启动时恢复上次的固定状态）。
const IPC_PINNED = 'my-lyric-widget:pinned';
// 排版模式（页面→主进程：用户切了排版；主进程→页面：启动时恢复上次的排版）。
const IPC_LAYOUT = 'my-lyric-widget:layout';
// 解锁按钮的矩形（页面→主进程，CSS 像素、相对窗口内容区）。固定状态下整窗忽略鼠标，
// 主进程靠这个矩形判断光标是否落在按钮上，只有落在上面才把窗口重新变成可点（部分点击穿透）。
const IPC_PIN_RECT = 'my-lyric-widget:pin-rect';
// 命中测试往外放一点：按钮本体 32×32，光标擦边时提前 2px 恢复可点，免得第一下点空。
const PIN_HIT_PADDING = 2;
// 显示握手：主进程等页面回 IPC_SHOWN 的最长时间（页面 400ms 兜底回信，这里再留余量）。
// 等不到就照常上屏——宁可闪一下，「词」按钮点了没反应更糟。
const SHOWN_TIMEOUT_MS = 800;
// 右上角 ×（1.4.0，页面→主进程）：只隐藏悬浮窗，不停用模组。重新显示走播放条上的「词」按钮。
const IPC_CLOSE = 'my-lyric-widget:close';
// 1.5.1 显示握手（解决「× 关掉再打开时先闪一下旧画面」）：
//   IPC_SHOW  主进程 → 页面：准备显示了，页面回一句 handled 再让窗口真正上屏
//   IPC_SHOWN 页面 → 主进程：这一帧已经画好，可以 showInactive
// 隐藏期间主进程照收快照但没转给页面，页面上停的是关闭那一刻的画面（高亮停在旧位置）。
const IPC_SHOW = 'my-lyric-widget:show';
const IPC_SHOWN = 'my-lyric-widget:shown';
// 1.5.2 页面 → 主进程：页面自己改了整窗鼠标穿透（显示握手期间先全窗穿透，上屏后放开）。
const IPC_IGNORE_HINT = 'my-lyric-widget:ignore-hint';
// 排版三态（主进程侧只用来校验从页面收到的值，别让坏值写进状态文件）。
// 第三态 1.3.0 从「原文 + 译文 + 罗马音」(full) 改成「原文 + 罗马音」(roman)；老存档里的 full 在恢复时映射过来。
const LAYOUT_MODE_IDS = ['text', 'text-trans', 'roman'];
const LEGACY_LAYOUT_IDS = { full: 'roman' };
// 形态切换（1.7.0 落地「桌面歌词 / 悬浮窗歌词」两种形态）：1.3.0 只有桌面歌词，这里先把状态位和
// IPC 预留出来。页面此刻还不发这条消息，1.7.0 加「切换形态」按钮时直接复用。
const SURFACE_IDS = ['desktop', 'window'];
const IPC_SURFACE = 'my-lyric-widget:surface';
// 形态切换的调用协议：client.mjs（1.7.0 起）用 folium.rpc.call(RPC_SURFACE, 'window') 请求切换，
// 主进程在主窗口的渲染进程里 answer。宿主只保留 activate 返回的 dispose 函数（electron/modSystem/
// nodeEntry.cjs:135），所以接口只能走 RPC，不能靠 activate 返回值。
const RPC_SURFACE = 'set-surface';
// 1.7.0 起 applySurface 的返回值：ok=false 时 code 说明为什么没切成。
const SURFACE_INVALID = 'invalid';
const SURFACE_UNCHANGED = 'unchanged';
const SURFACE_UNSUPPORTED = 'unsupported';
// 窗口状态（位置 + 是否固定）存在 userData 下的一个小 JSON 里，重启后恢复。
// 只记这两个值：尺寸固定、不需要记。
const STATE_FILE_NAME = 'my-lyric-widget-state.json';
const SAVE_DEBOUNCE_MS = 500;

// ---- 图标（内联 SVG） ----
// 形状数据原样取自 lucide-react v1.48.0 的 dist/esm/icons/*.mjs，和 Folia 播放器自带的
// 控件用的是同一套图形（播放器主控条见 src/components/FloatingPlayerControls.tsx，
// 其余按钮见 src/components/floating-player/playerControlSlotActions.ts）：
//   - 24×24 viewBox、描边 stroke-width 2、颜色跟随 currentColor；
//   - 只有播放/暂停（以及播放器里「已喜爱」的心形）用实心，其余都是线性。
// 窗口页面是 data URL + CSP `default-src 'none'`，不能 require lucide-react、也不能加载
// 任何外部资源，所以这里把 path 数据直接内联进页面。
//
// lucide — ISC License
// Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT).
// All other copyright (c) for Lucide are held by Lucide Contributors 2022.
//
// Permission to use, copy, modify, and/or distribute this software for any purpose with or
// without fee is hereby granted, provided that the above copyright notice and this permission
// notice appear in all copies.
//
// THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS
// SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL
// THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY
// DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF
// CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE
// OR PERFORMANCE OF THIS SOFTWARE.
const ICON_PATHS = {
    'skip-back': '<path d="M17.971 4.285A2 2 0 0 1 21 6v12a2 2 0 0 1-3.029 1.715l-9.997-5.998a2 2 0 0 1-.003-3.432z"/><path d="M3 20V4"/>',
    'skip-forward': '<path d="M21 4v16"/><path d="M6.029 4.285A2 2 0 0 0 3 6v12a2 2 0 0 0 3.029 1.715l9.997-5.998a2 2 0 0 0 .003-3.432z"/>',
    play: '<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/>',
    pause: '<rect x="14" y="3" width="5" height="18" rx="1"/><rect x="5" y="3" width="5" height="18" rx="1"/>',
    repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
    'repeat-1': '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/><path d="M11 10h1v4"/>',
    'repeat-off': '<path d="M11.656 6H21l-4-4"/><path d="M17.898 17.898A4 4 0 0 1 17 18H3l4-4"/><path d="m2 2 20 20"/><path d="M21 13v1a4 4 0 0 1-.171 1.159"/><path d="m21 6-4 4"/><path d="M3 11v-1a4 4 0 0 1 3.102-3.898"/><path d="m7 22-4-4"/>',
    'volume-1': '<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/><path d="M16 9a5 5 0 0 1 0 6"/>',
    'volume-2': '<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/><path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.364 18.364a9 9 0 0 0 0-12.728"/>',
    'volume-x': '<path d="M11 4.702a.7.7 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.7.7 0 0 0 11 19.298z"/><path d="m16.5 14.5 5-5"/><path d="m16.5 9.5 5 5"/>',
    // 双语/单行排版切换按钮。「文」和「A」拆成两组，方便中间态只点亮「文」。
    'layout-zh': '<path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/>',
    'layout-a': '<path d="m22 22-5-10-5 10"/><path d="M14 18h6"/>',
    // 固定 / 解锁按钮：pin 表示「未固定，可点亮固定」，pin-off 表示「已固定，可点亮解锁」。图标两态共用同一颗按钮。
    pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
    'pin-off': '<path d="M12 17v5"/><path d="M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89"/><path d="m2 2 20 20"/><path d="M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11"/>',
    // 右上角 ×（1.4.0）：只关悬浮窗、不停用模组。
    close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
};

/** 包一层 <svg>：只有 filled 的图标用 currentColor 填实（和播放器的 Pause/Play 一致）。 */
const svgIcon = (name, options) => {
    const filled = options && options.filled;
    return '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"'
        + ' fill="' + (filled ? 'currentColor' : 'none') + '"'
        + ' stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
        + ICON_PATHS[name]
        + '</svg>';
};

/** 排版按钮专用：两组子图形各自带 class，中间态只点亮「文」，第三态再点亮「A」。 */
const layoutIcon = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"'
    + ' fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
    + '<g class="icon-zh">' + ICON_PATHS['layout-zh'] + '</g>'
    + '<g class="icon-a">' + ICON_PATHS['layout-a'] + '</g>'
    + '</svg>';

/** 页面里会直接用到的图标整段字符串（序列化进内联脚本，避免页面再拼一遍）。 */
const ICON_SVG = {
    prev: svgIcon('skip-back'),
    next: svgIcon('skip-forward'),
    play: svgIcon('play', { filled: true }),
    pause: svgIcon('pause', { filled: true }),
    'loop-off': svgIcon('repeat-off'),
    'loop-all': svgIcon('repeat'),
    'loop-one': svgIcon('repeat-1'),
    'volume-1': svgIcon('volume-1'),
    'volume-2': svgIcon('volume-2'),
    'volume-x': svgIcon('volume-x'),
    layout: layoutIcon,
    pin: svgIcon('pin'),
    'pin-off': svgIcon('pin-off'),
    close: svgIcon('close'),
};

// ---- 排查日志（真机 IPC 链路定位用，定位完删掉） ----
// 模块级：main.cjs 被 require 就会打印，用来确认模组主进程入口真的被宿主加载了。
console.log(`${LOG_PREFIX} main 模块已求值（main.cjs 被 require）`, {
    electron: process.versions.electron,
    node: process.versions.node,
});

// 排版最多两行（原文 + 译文 / 罗马音）。窗口按「两行 + 顶部让位 + 底部少量留白」定高：
// 首行顶 64 + 两行 86.6 + 底部 29.4 ≈ 180；再高底部空白就明显了（用户要求砍掉底部空间）。
// 1.5.0 起高度跟着字号走（38px 时仍是 180），见下面的 windowHeightFor；宽度始终 640。
const WINDOW_WIDTH = 640;
// 默认停在工作区底部中间，离底边和左右边这么多像素。
const WINDOW_MARGIN = 48;

// ---- 1.5.0 可配置项（字号 / 字体 / 外观） ----
// 这些值的「真源」在宿主的模组设置里（client.mjs 用 settingsSections 声明表单），
// client 每次变化都通过 folium.rpc.call('config', ...) 推给主进程；主进程只做校验、定尺寸、转给页面。
const RPC_CONFIG = 'config';
// 1.5.1：主进程 → client 的「重发一次配置」指令（和 request-sync 一样走 action 通道）。
// 配置真源在 client 侧，而宿主「重载模组」在模组文件没变时不会重跑 client，只能由这边主动去要。
const ACTION_REQUEST_CONFIG = 'request-config';
// 命令面板「锁定 / 解锁位置」：命令面板没有页面上下文，由主进程翻状态再推回页面。
const RPC_TOGGLE_PIN = 'toggle-pin';
// 主进程 → 页面：把配置下发进窗口页面（字号、字体、外观）。
const IPC_CONFIG = 'my-lyric-widget:config';

const SURFACE_MODES = ['auto', 'dark', 'light', 'transparent'];
const FONT_MODES = ['system', 'theme'];
const FONT_SIZE_MIN = 20;
const FONT_SIZE_MAX = 50;
const FONT_SIZE_DEFAULT = 38;

/**
 * 配置按「归属」分段，和设置面板的分组一一对应：
 *  shared  = 通用（外观、字号、字体）
 *  desktop = 桌面歌词专属（1.6.x 的长句滚动会落在这里，现在先占位）
 *  window  = 悬浮窗歌词专属（1.7.0 再填）
 * 默认值必须和 1.4.2 的观感完全一致：加设置项不允许改变现有默认样子。
 */
const DEFAULT_CONFIG = {
    shared: {
        fontSize: FONT_SIZE_DEFAULT,
        fontMode: 'system',
        surface: 'auto',
        surfaceOpacity: 0.58,
        radius: 16,
        border: true,
        pausedDim: false,
        backdrop: false,
    },
    desktop: {},
    window: {},
};

const clampNumber = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * 校验一份配置；坏值一律回落到默认值，绝不把非法数据传给页面。
 * 只认 shared 段；flat 结构（1.5.0 早期写法）把顶层当 shared 读，方便以后拆分。
 */
const normalizeConfig = (raw) => {
    const config = {
        shared: { ...DEFAULT_CONFIG.shared },
        desktop: { ...DEFAULT_CONFIG.desktop },
        window: { ...DEFAULT_CONFIG.window },
    };
    if (!raw || typeof raw !== 'object') return config;
    const sharedSource = raw.shared && typeof raw.shared === 'object' ? raw.shared : raw;

    const fontSize = toFiniteNumber(sharedSource.fontSize);
    if (fontSize !== null) config.shared.fontSize = Math.round(clampNumber(fontSize, FONT_SIZE_MIN, FONT_SIZE_MAX));
    if (FONT_MODES.includes(sharedSource.fontMode)) config.shared.fontMode = sharedSource.fontMode;
    if (SURFACE_MODES.includes(sharedSource.surface)) config.shared.surface = sharedSource.surface;

    const opacity = toFiniteNumber(sharedSource.surfaceOpacity);
    // 和表单声明对齐（min 0.2）：0 会让悬停底色彻底消失，用户会以为是 bug。
    if (opacity !== null) config.shared.surfaceOpacity = clampNumber(opacity, 0.2, 1);
    const radius = toFiniteNumber(sharedSource.radius);
    if (radius !== null) config.shared.radius = Math.round(clampNumber(radius, 0, 28));
    config.shared.border = sharedSource.border !== false;
    config.shared.pausedDim = sharedSource.pausedDim === true;
    config.shared.backdrop = sharedSource.backdrop === true;
    return config;
};

/**
 * 1.5.1：启动时先落一份默认配置，拿到 client 推来的真配置之前先用它建窗口。
 * 高度沿用上次的实际窗口高度（见 savePersistedState），字号 >38px 的用户重启不会先矮一截再变高；
 * 真配置一到就走 RPC_CONFIG → applyWindowSize，与这里无关。宽度始终 640。
 */
const prepareConfig = (persisted) => {
    const config = normalizeConfig(null);
    const savedHeight = persisted && persisted.height;
    if (Number.isFinite(savedHeight) && savedHeight >= 60 && savedHeight <= 600) {
        config.window.height = Math.round(savedHeight);
    }
    return config;
};

/**
 * 字号 ↔ 窗口高度：主行 1.25 倍行高、副行 0.71 × 1.3 倍（和页面 CSS 的比例一致），
 * 上下留白按同一比例缩放。38px + 两行正好是 180，保证默认配置下窗口尺寸和 1.4.x 一样。
 * 1.3.0 的窗口高度是写死的 180；1.5.0 起由字号推算，宽度仍固定 640。
 */
const lyricBlockHeight = (config) => {
    const size = config.shared.fontSize;
    return size * 1.25 + size * 0.71 * 1.3 + 4;
};

const windowHeightFor = (config) => Math.round(55 + lyricBlockHeight(config) * 1.4435);

const LOOP_MODES = ['off', 'all', 'one'];
const DIRECT_ACTIONS = ['next', 'prev', 'toggle', 'request-sync'];
const WAITING_TEXT = '等待播放...';

// 宿主窗口全部关闭后，等这么久再关悬浮窗：给「壁纸模式重建主窗口」「换主窗口」留出交接时间。
const HOST_EMPTY_GRACE_MS = 300;
// 崩溃时间窗内最多自动 reload 几次：成功加载不清零，否则「加载成功后崩溃」会无限重载。
const MAX_CRASH_RELOADS = 2;
const CRASH_RELOAD_WINDOW_MS = 60 * 1000;
// 创建悬浮窗失败时最多尝试重建几次（用户手动关闭后的重建不计入）；宿主出现新窗口时重新计数。
const MAX_WIDGET_RECREATES = 3;

// ---- 主进程侧的帧顺序保护（1.3.0 之前只有页面自己按行号兜底，换歌时会串帧） ----
// 目标：拦掉「同一会话里乱序到达的旧帧」，同时绝不能因为用户拖进度条而卡住。
// client 每 100ms 轮询一次，乱序造成的迟到帧只可能小幅后退，所以按后退幅度分档：
//   - 后退 > REORDER_MAX_BACKSTEP：只可能是真实跳转（用户拖进度条、单曲循环回到开头），
//     立刻接受并重定基准；
//   - 小幅后退且行号也退到更前面：可能是乱序旧帧，先丢，但最多丢 STALE_GUARD_MS，
//     超时说明是真实后退（往回拖了不到 1 秒、跨句拖），立刻接受并重定基准 —— 兜底保证不会停住；
//   - 同一句内的小幅后退一律接受（事件时刻快照、播放器抖动都落在这里）。
const REORDER_MAX_BACKSTEP = 1;
const STALE_GUARD_MS = 800;
/** 行号：只认 ≥0 的整数，其余（句间、没有歌词行、字段缺失）一律按 -1 处理。 */
const lineIndexOf = (payload) => {
    const line = payload && payload.line;
    return line && Number.isFinite(line.index) ? line.index : -1;
};
/** 播放位置（秒）：缺失或非数字时返回 null，表示这一帧不参与位置比较。 */
const positionOf = (payload) => {
    const position = payload && payload.position;
    return Number.isFinite(position) ? position : null;
};
/**
 * 判断这一帧是不是「同一会话里乱序到达的旧帧」。
 * 判据只看「后退幅度 + 行号是否也退回去 + 已经丢了多久」：
 *   - 换会话（playSessionId 变了）一律接受并重置基准 —— 换歌时行号、position 都从头上重来；
 *   - position 前进、不动、或同一句内小幅后退 → 接受；
 *   - 后退超过 REORDER_MAX_BACKSTEP → 真实跳转，接受并重定基准（用户拖进度条不能卡住）；
 *   - 小幅后退且行号后退 → 可能是旧帧，先丢；丢满 STALE_GUARD_MS 还在后退就认作真实后退，接受并重定基准。
 * 被丢的帧不写回基准；一旦接受，基准就重定到这一帧（不会永久停在旧的高位置上）。
 */
const isStaleFrame = (gate, payload) => {
    const session = payload && typeof payload.playSessionId === 'string' ? payload.playSessionId : '';
    const position = positionOf(payload);
    const lineIndex = lineIndexOf(payload);
    const accept = () => {
        gate.session = session;
        gate.position = position;
        gate.lineIndex = lineIndex;
        gate.droppingSince = null;
        return false;
    };
    if (gate.session !== session) return accept();
    // 缺 position 的帧不参与位置比较，顺便别让基准卡在 null 上。
    if (position === null || gate.position === null) {
        gate.position = position;
        gate.lineIndex = lineIndex;
        gate.droppingSince = null;
        return false;
    }
    const regression = gate.position - position;
    if (regression <= 0) return accept();
    // 大幅后退只可能是真实跳转，立刻接受。
    if (regression > REORDER_MAX_BACKSTEP) return accept();
    // 小幅后退：行号没退（同一句或更靠后）就是抖动，接受；行号也退回去才怀疑是旧帧。
    const looksReordered = gate.lineIndex >= 0 && lineIndex >= 0 && lineIndex < gate.lineIndex;
    if (!looksReordered) return accept();
    if (gate.droppingSince === null) gate.droppingSince = Date.now();
    if (Date.now() - gate.droppingSince > STALE_GUARD_MS) return accept();
    return true;
};

const clampVolume = (volume) => Math.min(1, Math.max(0, volume));

/** 日志里的普通对象用 JSON 表示（宿主把对象 String 成 [object Object]）；Error 原样交出去保留调用栈。 */
const describeForLog = (value) => {
    if (value instanceof Error) return value;
    try {
        return JSON.stringify(value);
    } catch (error) {
        return String(value);
    }
};

/** 把页面/滑块给的值转成有限数字；空字符串、null、非数字都返回 null（不要当成 0）。 */
const toFiniteNumber = (value) => {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
};

/** 循环模式按 不循环 -> 列表循环 -> 单曲循环 -> 不循环 轮换。 */
const nextLoopMode = (mode) => {
    const index = LOOP_MODES.indexOf(mode);
    return LOOP_MODES[(index + 1) % LOOP_MODES.length];
};

/**
 * 显示器 bounds 比工作区多出来的那几条就是任务栏占的地方（Windows 只在真有任务栏的屏幕上
 * 收紧工作区；任务栏自动隐藏或没有任务栏时两者相等）。返回各条边对应的矩形。
 */
const getTaskbarBands = (display) => {
    const bounds = display && display.bounds;
    const workArea = display && display.workArea;
    if (!bounds || !workArea) return [];
    const bands = [];
    const top = workArea.y - bounds.y;
    const left = workArea.x - bounds.x;
    const bottom = bounds.y + bounds.height - (workArea.y + workArea.height);
    const right = bounds.x + bounds.width - (workArea.x + workArea.width);
    if (top > 0) {
        bands.push({ x: bounds.x, y: bounds.y, width: bounds.width, height: top });
    }
    if (bottom > 0) {
        bands.push({ x: bounds.x, y: workArea.y + workArea.height, width: bounds.width, height: bottom });
    }
    if (left > 0) {
        bands.push({ x: bounds.x, y: workArea.y, width: left, height: workArea.height });
    }
    if (right > 0) {
        bands.push({ x: workArea.x + workArea.width, y: workArea.y, width: right, height: workArea.height });
    }
    return bands;
};

/** 两个矩形重叠部分的较短边长；不相交时为 0。 */
const overlapSize = (a, b) => {
    const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    if (width <= 0 || height <= 0) return 0;
    return Math.min(width, height);
};

/**
 * 窗口矩形是否压在某个显示器的任务栏区域上。
 * 要求至少重叠 MIN_TASKBAR_OVERLAP 像素：窗口边缘 1px 压线不该让它长期抢占置顶层。
 */
const overlapsTaskbar = (windowBounds) => screen.getAllDisplays().some((display) => (
    getTaskbarBands(display).some((band) => (
        overlapSize(windowBounds, band) >= MIN_TASKBAR_OVERLAP
    ))
));

/**
 * 窗口页面。640x180：顶部控制条（左：上一首 / 播放 / 下一首，正中：固定 / 取消锁定，
 * 右：循环 / 排版 / 音量）+ 歌词原文 + 第二行（译文 / 罗马音）。
 * 整页可拖动（-webkit-app-region: drag），按钮和滑块单独设回 no-drag。
 */
const WIDGET_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
    html, body {
        height: 100%;
        margin: 0;
        overflow: hidden;
        background: transparent;
    }
    body {
        -webkit-app-region: drag;
        color: #fff;
        font-family: 'Microsoft YaHei UI', 'PingFang SC', 'Noto Sans CJK SC', system-ui, sans-serif;
        user-select: none;
        cursor: default;
    }
    /*
     * 窗口默认完全透明：只留歌词文字。鼠标悬停（body.hover）才淡入半透明黑底和顶部控制条。
     * 固定（body.pinned）状态下悬停只给极弱高亮，两侧按钮不出现，只露正中的「取消锁定」按钮。
     */
    .widget {
        box-sizing: border-box;
        position: relative;
        display: flex;
        flex-direction: column;
        height: 100%;
        padding: 12px 16px 10px;
        background: transparent;
        border: 1px solid transparent;
        border-radius: var(--widget-radius, 16px);
        overflow: hidden;
        transition: background-color 0.22s ease, border-color 0.22s ease, opacity 0.2s ease;
    }
    body.hover:not(.pinned) .widget {
        background: rgba(0, 0, 0, var(--surface-alpha, 0.58));
        border-color: rgba(255, 255, 255, var(--border-alpha, 0.08));
    }
    /* 1.5.0 外观自定义：底色四态，都只在「悬停且未锁定」时出现（锁定穿透时不铺底色，
       和设置项说明一致）。auto = 深色半透明（默认，和以前一样）；dark = 深色更实；
       light = 浅色毛玻璃（固定 18% 白，不跟深色的不透明度滑块走）；transparent = 不铺。 */
    body.hover:not(.pinned)[data-surface="dark"] .widget {
        background: rgba(0, 0, 0, min(1, calc(var(--surface-alpha, 0.58) + 0.22)));
        border-color: rgba(255, 255, 255, var(--border-alpha, 0.08));
    }
    body.hover:not(.pinned)[data-surface="light"] .widget {
        background: rgba(255, 255, 255, var(--surface-light-alpha, 0.18));
        border-color: rgba(255, 255, 255, calc(var(--border-alpha, 0.08) * 4));
    }
    body.hover:not(.pinned)[data-surface="transparent"] .widget {
        background: transparent;
        border-color: transparent;
    }
    /* 暂停变淡：只压歌词块，播放中不跟着忽明忽暗。 */
    body[data-paused-dim="true"][data-playback="paused"] .widget {
        opacity: 0.55;
    }
    /* 固定态悬停只露解锁按钮，不铺底色、不描边：用户要求「固定时悬停没有阴影背景和边框」。 */
    body.hover.pinned .widget {
        background: transparent;
        border-color: transparent;
    }
    /* 固定模式下整窗不可拖动；未固定时 body 是 drag 区，按钮/滑块单独 no-drag。 */
    body.pinned {
        -webkit-app-region: no-drag;
    }
    /*
     * 歌词区仍然垂直居中，但整块往下压了一点（上内边距 33px）：用户要求「离顶部按钮再远一点、
     * 底部空白砍掉」——顶部控制条是绝对定位的浮层，不占布局，所以只能靠这里的内边距把歌词推下去。
     * 两行时首行约在 64px（控制条底边 50px，留 14px）；窗口 180 高时底部只剩约 29px。
     */
    .lyric {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 4px;
        min-height: 0;
        padding: 33px 0 0;
    }
    /* 1.5.0 外观自定义：歌词底衬（壁纸太花时给歌词块垫一层半透明黑）。默认关，开了才铺。 */
    body[data-backdrop="true"] .lyric {
        background: rgba(0, 0, 0, 0.35);
        padding: 33px 10px 0;
    }
    .lyric-text {
        max-width: 100%;
        font-size: var(--lyric-size, 38px);
        font-weight: 600;
        line-height: 1.25;
        text-align: center;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        /* 窗口背景可能是任意壁纸（甚至纯白），所以歌词要自带一圈暗描边保证可读。 */
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9), 0 2px 12px rgba(0, 0, 0, 0.6);
    }
    /* 双语排版（原文 + 译文）里的大号译文：原文的 0.7 倍。38 * 0.7 = 26.6，向上取整 27px。 */
    .lyric-trans {
        max-width: 100%;
        font-size: var(--trans-size, 27px);
        font-weight: 500;
        line-height: 1.3;
        text-align: center;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9), 0 2px 10px rgba(0, 0, 0, 0.55);
    }
    .lyric-trans:empty,
    .lyric-trans[hidden] {
        display: none;
    }
    /* 罗马音行：1.3.0 起三行排版下线，这一行不再填内容；样式保留，将来要恢复三行时直接用。 */
    .lyric-sub {
        max-width: 100%;
        font-size: 27px;
        line-height: 1.3;
        color: rgba(255, 255, 255, 0.64);
        text-align: center;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8), 0 2px 8px rgba(0, 0, 0, 0.45);
    }
    .lyric-sub:empty {
        display: none;
    }
    /*
     * 顶部控制条：左右两组各占一半（flex: 1），固定按钮独占正中那一格，
     * 所以不管两边按钮多少，固定按钮都严格落在窗口的水平中线上。
     * 用绝对定位让它浮在歌词上方、不占布局：控制条藏起来时歌词仍然垂直居中在窗口正中，
     * 不会因为上方多了一条而整体下移。
     */
    .controls {
        -webkit-app-region: no-drag;
        position: absolute;
        top: 10px;
        left: 16px;
        right: 16px;
        z-index: 2;
        display: flex;
        align-items: center;
        gap: 8px;
        padding-bottom: 6px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        /* 默认藏起来；位置和显隐都由 body.hover / body.pinned 控制。 */
        opacity: 0;
        pointer-events: none;
        transform: translateY(-6px);
        transition: opacity 0.18s ease, transform 0.18s ease, border-color 0.18s ease;
    }
    body.hover:not(.pinned) .controls {
        opacity: 1;
        pointer-events: auto;
        transform: none;
    }
    /* 固定模式：控制条整条不可用，只留正中的「取消锁定」按钮，悬停时出现。 */
    body.pinned .controls {
        opacity: 1;
        /* 固定态没有 hover 过渡来源，得显式归零，否则整条（含胶囊）比设计位置高 6px。 */
        transform: none;
        border-bottom-color: transparent;
    }
    body.pinned .controls-side {
        visibility: hidden;
    }
    body.pinned #pin {
        opacity: 0;
        /* 固定态能不能点到这一块由主进程的几何命中决定（窗口整体 ignore 鼠标时，点不到按钮就穿透），
           页面这层不再做第二道门：只要窗口放行，按钮就一定是可点的目标，避免「窗口可点但按钮不可点」。 */
        pointer-events: auto;
    }
    body.pinned.hover #pin,
    /* 键盘用户靠 Tab 过来时窗口没有 hover，焦点必须能把胶囊露出来。 */
    body.pinned #pin:focus-visible {
        opacity: 1;
    }
    .controls-side {
        display: flex;
        align-items: center;
        gap: 8px;
        flex: 1;
        min-width: 0;
        /* border-box：下面右组的内边距才算「盒内」，否则 padding 会把右组撑宽、把正中的固定键挤偏。 */
        box-sizing: border-box;
    }
    /*
     * 右组：靠右排布，并恒定留出 44px 给右上角 ×（按钮 32 + 间隙 12）。
     * 恒定而不是悬停时才留 —— 否则鼠标一进窗，右组会整体左移 44px，看着像跳了一下。
     * 两侧都是 flex: 1 + border-box，内边距只吃自己的内容宽，正中的固定键严格居中；
     * 右组内部只有音量条可伸缩（flex: 1），空间不够时先被压短的是它，胶囊和按钮都不缩。
     */
    .controls-side.right {
        justify-content: flex-end;
        padding-right: 44px;
    }
    button {
        -webkit-app-region: no-drag;
        position: relative;
        flex: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        padding: 0;
        font: inherit;
        color: rgba(255, 255, 255, 0.88);
        background: transparent;
        border: 0;
        border-radius: 8px;
        cursor: pointer;
    }
    button:hover {
        background: rgba(255, 255, 255, 0.14);
    }
    button:active {
        background: rgba(255, 255, 255, 0.24);
    }
    button:focus-visible {
        outline: 2px solid #7dd3fc;
        outline-offset: 1px;
    }
    /*
     * 悬停提示：原生 title 的气泡固定在指针右下方、位置由系统决定，改不了；
     * 所以去掉 title，用 data-tip + 伪元素自绘一个。控制条在最上方，气泡统一向下弹
     * （向上弹会被窗口上边缘裁掉）。
     */
    button::after {
        content: attr(data-tip);
        position: absolute;
        left: 50%;
        transform: translateX(-50%);
        top: calc(100% + 8px);
        padding: 3px 8px;
        font-size: 11px;
        font-weight: 400;
        line-height: 1.3;
        color: #fff;
        white-space: nowrap;
        background: rgba(18, 20, 26, 0.95);
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 6px;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.12s ease;
    }
    button:hover::after,
    button:focus-visible::after {
        opacity: 1;
    }
    /*
     * 排版按钮三态：点亮图标里对应的那一半，而不是整个按钮换色。
     *   text        ：都不亮 —— 只有原文
     *   text-trans  ：只亮「文」（第二行是译文）
     *   roman       ：只亮「A」（第二行是罗马音，没有罗马音时回退成译文）
     * 亮起来的颜色和循环/固定按钮一致，都是 #7dd3fc。
     */
    #layout .icon-zh,
    #layout .icon-a {
        transition: color 0.18s ease;
    }
    #layout[data-mode="text-trans"] .icon-zh {
        color: #7dd3fc;
    }
    #layout[data-mode="roman"] .icon-a {
        color: #7dd3fc;
    }
    /*
     * 固定按钮：未固定时是普通图标（pin）；固定后变成正中的「取消锁定」按钮。
     * 用户要求只显示按钮本身、不要文字，所以靠蓝色描边 + 半透明深底 + 外发光来强调「点这里解锁」，
     * 文字只留在悬停气泡里（data-tip）。固定后控制条两侧按钮整组隐藏，只剩这一颗，它是唯一的解锁入口。
     */
    #pin[data-mode="pinned"] {
        box-sizing: border-box;
        width: 32px;
        height: 32px;
        /* 固定态窗口完全透明（用户要求悬停不铺底色），浅色壁纸上浅蓝图标读不清，所以按钮自带深底。 */
        color: #bfe9ff;
        background: rgba(8, 22, 36, 0.72);
        border: 1px solid rgba(125, 211, 252, 0.75);
        box-shadow: 0 2px 12px rgba(125, 211, 252, 0.28);
    }
    #pin[data-mode="pinned"]:hover {
        background: rgba(8, 22, 36, 0.86);
        border-color: #7dd3fc;
    }
    /* 图标尺寸跟播放器控件一致：20px（播放器小屏是 18px，这里窗口固定，取 20px）。 */
    .icon {
        display: block;
        width: 20px;
        height: 20px;
    }
    /* 循环模式开了（列表/单曲）时图标点亮，和播放器里循环按钮的选中感一致。 */
    #loop[data-mode="all"],
    #loop[data-mode="one"] {
        color: #7dd3fc;
    }
    .volume-icon {
        flex: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        color: rgba(255, 255, 255, 0.7);
    }
    .volume-icon .icon {
        width: 18px;
        height: 18px;
    }
    .volume {
        -webkit-app-region: no-drag;
        flex: 1;
        /* 右侧空间优先砍这里：44px 的 × 让位 + 百分比胶囊加宽都从音量条身上让出来。 */
        min-width: 40px;
        height: 4px;
        margin: 0 2px;
        accent-color: #7dd3fc;
        cursor: pointer;
    }
    /*
     * 音量百分比：窗口底是桌面壁纸，浅色壁纸上 55% 白几乎看不见（用户反馈「显示不明显」）。
     * 改成和固定态按钮同款的深底小胶囊 + 更亮的字色，任何壁纸上都读得清；
     * 拖动滑块时字色变蓝，给一点「正在调音量」的反馈。
     */
    .volume-value {
        flex: none;
        /* 百分比胶囊宽度固定：数字位数变化时胶囊不跟着抖（tabular-nums 保证字形等宽）。 */
        min-width: 42px;
        box-sizing: border-box;
        padding: 2px 4px;
        font-size: 12px;
        font-weight: 600;
        line-height: 1.4;
        font-variant-numeric: tabular-nums;
        color: #eaf6ff;
        /* 居中对齐：2% / 5% 这种一位数也落在胶囊正中，和两位数的读数位置一致（tabular-nums 保证不跳）。 */
        text-align: center;
        background: rgba(8, 22, 36, 0.55);
        border-radius: 6px;
    }
    body.volume-dragging .volume-value {
        color: #7dd3fc;
        background: rgba(8, 22, 36, 0.78);
    }
    /*
     * 1.5.2 显示握手中（body.showing）：窗口还没上屏，页面正在等当下这一帧。
     * 控制条按悬停效果提前显出来 —— 上一帧画面里控制条是收起的，上屏时若还没展开，
     * 看起来就是「先闪一下光秃秃的旧歌词、再浮出控制条」。
     * 这几十毫秒里整窗是穿透的（见 IPC_IGNORE_HINT），显出来也点不到。
     */
    body.showing .widget {
        background-color: rgba(8, 22, 36, var(--surface-alpha, 0.58));
        border-color: rgba(125, 211, 252, var(--border-alpha, 0.08));
    }
    body.showing .controls {
        transform: none;
        opacity: 1;
    }
    /*
     * 右上角的关闭按钮（1.4.0）：只隐藏悬浮窗，不停用模组（播放条上的「词」按钮能找回来）。
     * 位置和控制条同一行（top 10px），悬停才露面；固定态不出现 —— 那时整窗忽略鼠标、
     * 只有解锁键那一小块可点，露出来也点不到，反而像个失效的按钮。
     */
    #close {
        -webkit-app-region: no-drag;
        position: absolute;
        top: 10px;
        right: 16px;
        z-index: 3;
        opacity: 0;
        /* 透明但可点会变成隐形点击陷阱（正好压在右侧按钮组上），显隐和可点性一起切。 */
        pointer-events: none;
        transition: opacity 0.18s ease;
    }
    body.hover:not(.pinned) #close,
    body:not(.pinned) #close:focus-visible {
        opacity: 1;
        pointer-events: auto;
    }
    /* 气泡贴右边缘，向右对齐，免得被窗口右边缘裁掉。 */
    #close::after {
        left: auto;
        right: 0;
        transform: none;
    }
</style>
</head>
<body>
<div class="widget">
    <div class="controls">
        <div class="controls-side">
            <button id="prev" type="button" data-tip="上一首" aria-label="上一首">${ICON_SVG.prev}</button>
            <button id="toggle" type="button" data-tip="播放" aria-label="播放">${ICON_SVG.play}</button>
            <button id="next" type="button" data-tip="下一首" aria-label="下一首">${ICON_SVG.next}</button>
        </div>
        <button id="pin" type="button" data-tip="固定位置" aria-label="固定位置" data-mode="floating">${ICON_SVG.pin}</button>
        <div class="controls-side right">
            <button id="loop" type="button" data-tip="循环模式：不循环" aria-label="循环模式：不循环" data-mode="off">${ICON_SVG['loop-off']}</button>
            <button id="layout" type="button" data-tip="排版：只显示原文" aria-label="排版" data-mode="text">${ICON_SVG.layout}</button>
            <span class="volume-icon" id="volume-icon" aria-hidden="true">${ICON_SVG['volume-2']}</span>
            <input id="volume" class="volume" type="range" min="0" max="100" step="1" value="100" title="音量" aria-label="音量">
            <span class="volume-value" id="volume-value">100%</span>
        </div>
    </div>
    <div class="lyric" id="lyric" data-layout="text">
        <div class="lyric-text" id="line" aria-live="polite">${WAITING_TEXT}</div>
        <div class="lyric-trans" id="trans" hidden></div>
        <div class="lyric-sub" id="sub"></div>
    </div>
    <button id="close" type="button" data-tip="关闭悬浮歌词（模组仍启用）" aria-label="关闭悬浮歌词">${ICON_SVG.close}</button>
</div>
<script>
const { ipcRenderer } = require('electron');

// ---- 排查日志：页面里的打印只有它自己的 DevTools 看得见，这里统一转发到主进程日志面板（定位完连监听一起删）。
const debugToMain = (message) => ipcRenderer.send('${IPC_DEBUG}', message);
debugToMain('page boot');
window.addEventListener('error', (event) =>
    debugToMain('page error: ' + event.message + ' @' + event.lineno + ':' + event.colno));

const els = {
    lyric: document.getElementById('lyric'),
    line: document.getElementById('line'),
    trans: document.getElementById('trans'),
    sub: document.getElementById('sub'),
    prev: document.getElementById('prev'),
    toggle: document.getElementById('toggle'),
    next: document.getElementById('next'),
    loop: document.getElementById('loop'),
    layout: document.getElementById('layout'),
    pin: document.getElementById('pin'),
    volume: document.getElementById('volume'),
    volumeIcon: document.getElementById('volume-icon'),
    volumeValue: document.getElementById('volume-value'),
    close: document.getElementById('close'),
};

// 图标整段字符串由主进程生成后塞进来（形状见 main.cjs 的 ICON_PATHS）。
const ICONS = ${JSON.stringify(ICON_SVG)};
// 只在图标真的换了才写 innerHTML，避免每帧重排。
const setIcon = (el, name) => {
    if (!el || !ICONS[name] || el.dataset.icon === name) return;
    el.dataset.icon = name;
    el.innerHTML = ICONS[name];
};

// 中文提示写到 data-tip（自绘气泡，固定在图标的正下方）+ aria-label（读屏可念）。
// 不再写 title：原生气泡的位置由系统决定，改不动，会和自绘气泡重叠。
const setButtonLabel = (el, label) => {
    if (!el || el.dataset.tip === label) return;
    el.dataset.tip = label;
    el.setAttribute('aria-label', label);
};

const LOOP_TITLES = { off: '不循环', all: '列表循环', one: '单曲循环' };
const WAITING_TEXT = '${WAITING_TEXT}';

/** 音量图标按档位切换，规则同播放器的音量按钮：静音/0 → 叉，<50% → 一格，其余 → 两格。 */
const volumeIconName = (percent) => {
    if (!(percent > 0)) return 'volume-x';
    return percent < 50 ? 'volume-1' : 'volume-2';
};

// 拖动音量条时，不要被主进程回传的音量覆盖；松手后再对齐。
let volumeDragging = false;
let volumeTimer = null;
let lastVolumeSent = null;

const sendAction = (payload) => {
    debugToMain('sendAction: ' + JSON.stringify(payload));
    ipcRenderer.send('${IPC_ACTION}', payload);
};

// 排版三态：text 只有原文 / text-trans 原文 + 译文 / roman 原文 + 罗马音（没有罗马音时第二行回退成译文）。
// 1.3.0 之前的第三态 full（原文 + 译文 + 罗马音，三行）已下线，恢复办法见 render() 里的注释。
const LAYOUT_MODES = ['text', 'text-trans', 'roman'];
const LAYOUT_TIPS = {
    text: '排版：只显示原文',
    'text-trans': '排版：原文 + 译文',
    roman: '排版：原文 + 罗马音',
};
let layoutMode = 'text';
let lastPayload = null;
// 1.5.1：lastPayload 第一次到手时的本地时刻（epoch ms）。重渲染（切排版）沿用它，
// 免得把「同一份旧快照」误当成刚收到的新数据。
let lastPayloadReceivedAt = 0;
// 1.5.2：页面收到过几份快照。显示握手要区分「上屏这一刻之前的旧画面」和「之后的新画面」。
let payloadFrame = 0;
let lastPayloadFrame = 0;

// ---- 1.5.0 配置（主进程下发），结构见 main.cjs 的 DEFAULT_CONFIG ----
// 默认值与 DEFAULT_CONFIG 一致：主进程还没下发时，页面就按这套渲染，观感等同 1.4.2。
let config = {
    shared: {
        fontSize: 38,
        fontMode: 'system',
        surface: 'auto',
        surfaceOpacity: 0.58,
        radius: 16,
        border: true,
        pausedDim: false,
        backdrop: false,
    },
    desktop: {},
    window: {},
};

const SYSTEM_FONT_STACK = "'Microsoft YaHei UI', 'PingFang SC', 'Noto Sans CJK SC', system-ui, sans-serif";

/**
 * 把配置写成 CSS 变量 / body[data-*]：外观全走 CSS，渲染逻辑不用到处判断。
 * 字号 / 圆角 / 颜色 / 不透明度都只是变量，改完浏览器自己重排，不需要重渲染。
 */
/**
 * 字体：system = 现在这套系统无衬线栈；theme = 跟随播放器主题解析出的字体栈。
 * 以后要加「指定字体」只需扩这项和 main.cjs 的 FONT_MODES，别处不用动。
 * 注意：配置先于首帧到达时 lastPayload 还是 null，光在 applyConfig 里设会在启动时写死成系统字体，
 * 所以 render() 每次拿到带 theme 的快照也要再调一次（主题切换、冷启动、页面重载都会经过 render）。
 */
const applyFontFamily = (theme) => {
    const themeStack = theme && typeof theme.fontStack === 'string' ? theme.fontStack : '';
    document.body.style.fontFamily = config.shared.fontMode === 'theme' && themeStack ? themeStack : SYSTEM_FONT_STACK;
};

const applyConfig = (next) => {
    if (!next || typeof next !== 'object') return;
    const shared = next.shared && typeof next.shared === 'object' ? next.shared : {};
    config = {
        shared: Object.assign({}, config.shared, shared),
        desktop: next.desktop && typeof next.desktop === 'object' ? next.desktop : config.desktop,
        window: next.window && typeof next.window === 'object' ? next.window : config.window,
    };
    const current = config.shared;
    const style = document.documentElement.style;
    style.setProperty('--lyric-size', current.fontSize + 'px');
    style.setProperty('--trans-size', Math.round(current.fontSize * 0.71) + 'px');
    style.setProperty('--widget-radius', current.radius + 'px');
    style.setProperty('--surface-alpha', String(current.surfaceOpacity));
    style.setProperty('--border-alpha', current.border ? '0.08' : '0');
    document.body.dataset.surface = current.surface;
    document.body.dataset.backdrop = String(current.backdrop === true);
    document.body.dataset.pausedDim = String(current.pausedDim === true);
    applyFontFamily(lastPayload && lastPayload.theme);
};

/** 这份快照里的 position 是「什么时候」的位置：优先用 client 打的 sentAt，缺了才退回收到时刻。 */
const payloadTimeOf = (payload, receivedAt) => {
    const sentAt = Number(payload && payload.sentAt);
    if (Number.isFinite(sentAt) && sentAt > 0) return sentAt;
    return Number.isFinite(receivedAt) ? receivedAt : Date.now();
};

/**
 * 把「快照位置」折算成「现在的位置」（1.5.1）。
 * 快照不连续：同一句内 client 去重不发帧、隐藏期间不发、重开/重载时补发的还是旧快照。
 * 直接拿 payload.position 当现在用，画面就会「闪回」到旧位置（重开后高亮滞后同理）。
 */
const positionNowFrom = (payload, receivedAt) => {
    const base = Number(payload && payload.position);
    if (!Number.isFinite(base)) return 0;
    if (!payload || payload.state !== 'playing') return base;
    const elapsed = (Date.now() - payloadTimeOf(payload, receivedAt)) / 1000;
    // 时钟异常（负数或离谱的大）就不外推，宁可少走一点，也不要一下子跳到后面。
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 30) return base;
    return base + elapsed;
};

/** 排版按钮的三态高亮、提示，以及 lyric 容器上的 data-layout，都跟着当前模式走。 */
const applyLayoutButton = () => {
    if (els.lyric) els.lyric.dataset.layout = layoutMode;
    if (els.layout) {
        els.layout.dataset.mode = layoutMode;
        setButtonLabel(els.layout, LAYOUT_TIPS[layoutMode]);
    }
};

const render = (payload, receivedAt) => {
    if (!payload || typeof payload !== 'object') return;
    // 1.5.1：同一个 payload 可能被重渲染多次（切排版、字体变了），第一次见到它时记下
    // 「主进程什么时候收到它的」，之后重渲染都沿用同一个时刻——这样旧快照不会被当成新数据。
    if (payload !== lastPayload) {
        receivedAt = Date.now();
        lastPayloadReceivedAt = receivedAt;
    } else if (!Number.isFinite(receivedAt)) {
        receivedAt = lastPayloadReceivedAt;
    }
    lastPayload = payload;

    const line = payload.line || {};
    debugToMain(
        'render: state=' + payload.state +
        ' line="' + (line.text || '') + '"' +
        ' title="' + ((payload.song && payload.song.title) || '') + '"',
    );
    // 空字符串是合法的行文本（只有翻译、没有原文的行），不要退回「等待播放...」。
    els.line.textContent = typeof line.text === 'string' ? line.text : WAITING_TEXT;
    // 暂停变淡要知道播放状态；只认 playing，其他都当暂停。
    document.body.dataset.playback = typeof payload.state === 'string' ? payload.state : 'paused';
    // 跟随主题字体：冷启动时配置比首帧先到（那时还没有 theme），所以每次快照都再对一次。
    applyFontFamily(payload.theme);

    // 三种排版：只原文 / 原文 + 译文 / 原文 + 罗马音。第二行只有一个槽位：
    // «roman» 优先放罗马音，行里没有罗马音时回退成译文（两者都没有就整行隐藏）。
    const translation = typeof line.translation === 'string' ? line.translation : '';
    const romanization = typeof line.romanization === 'string' ? line.romanization : '';
    let secondLine = '';
    if (layoutMode === 'text-trans') {
        secondLine = translation;
    } else if (layoutMode === 'roman') {
        secondLine = romanization !== '' ? romanization : translation;
    }
    els.trans.textContent = secondLine;
    els.trans.hidden = secondLine === '';
    // 三行排版（原文 + 译文 + 罗马音）已下线：这一行现在始终留空。
    // 要恢复：① 上面改成 secondLine = translation、并另算 showRoman；② 这里填罗马音；
    // ③ LAYOUT_MODES / LAYOUT_TIPS 和 CSS 的 #layout[data-mode="roman"] 规则各补一态。
    els.sub.textContent = '';

    const playing = payload.state === 'playing';
    setIcon(els.toggle, playing ? 'pause' : 'play');
    setButtonLabel(els.toggle, playing ? '暂停' : '播放');

    const loopMode = LOOP_TITLES[payload.loopMode] ? payload.loopMode : 'off';
    setIcon(els.loop, 'loop-' + loopMode);
    els.loop.setAttribute('data-mode', loopMode);
    setButtonLabel(els.loop, '循环模式：' + LOOP_TITLES[loopMode]);

    if (!volumeDragging) {
        const volume = Number.isFinite(payload.volume) ? payload.volume : 1;
        const percent = Math.round(Math.min(1, Math.max(0, volume)) * 100);
        els.volume.value = String(percent);
        els.volumeValue.textContent = percent + '%';
        lastVolumeSent = percent;
        setIcon(els.volumeIcon, payload.muted === true ? 'volume-x' : volumeIconName(percent));
    } else {
        // 拖动过程中以滑块自己的值为准，别被回传的旧音量顶回去。
        setIcon(els.volumeIcon, volumeIconName(Number(els.volume.value)));
    }
};

// 宿主每次 setVolume 都会保存设置，所以拖动时最多每 150ms 发一次，松手再补最终值。
const sendVolume = () => {
    if (volumeTimer) {
        clearTimeout(volumeTimer);
        volumeTimer = null;
    }
    const percent = Number(els.volume.value);
    if (percent === lastVolumeSent) return;
    lastVolumeSent = percent;
    sendAction({ type: 'set-volume', value: percent });
};

const scheduleVolume = () => {
    if (volumeTimer) return;
    volumeTimer = setTimeout(() => {
        volumeTimer = null;
        sendVolume();
    }, 150);
};

els.prev.addEventListener('click', () => sendAction('prev'));
els.toggle.addEventListener('click', () => sendAction('toggle'));
els.next.addEventListener('click', () => sendAction('next'));
els.loop.addEventListener('click', () => sendAction({ type: 'cycle-loop' }));
// 排版切换是纯显示逻辑，不用问宿主：切完用最后一次快照就地重渲染。
els.layout.addEventListener('click', () => {
    layoutMode = LAYOUT_MODES[(LAYOUT_MODES.indexOf(layoutMode) + 1) % LAYOUT_MODES.length];
    applyLayoutButton();
    if (lastPayload) render(lastPayload);
    // 记住这次选择，重启后恢复。
    ipcRenderer.send('${IPC_LAYOUT}', layoutMode);
});
// 1.5.2：窗口被动显示（× 关掉再打开、播放条「词」点回来）时的上屏顺序。
//
// 以前的做法是「主进程先 showInactive，再补发快照等纠正」，第一帧上的是页面里残留的旧画面，
// 所以会闪一下前面的句子 / 当前句的旧高亮。现在改成三段式：
//   ① 主进程 hide 之后窗口一直保持 ignore-mouse，客户端根本点不到它；
//   ② 要显示时先发 IPC_SHOW：页面先把控制器标成「显示中」（按钮点亮、鼠标穿透全窗，看见也点不到），
//      同时请求 client 绕过去重发一帧当下这一句，记下这一刻的帧号；
//   ③ 页面画完、并且等到一帧不早于「显示中」那一刻的快照之后，才回 IPC_SHOWN，主进程这时才
//      showInactive：上屏的第一帧就是当下这一句，不会先露出旧的。
// 兜底：主进程 800ms 等不到回信照常上屏；页面 400ms 等不到新帧就用现有画面回信（结果和旧版一样）。
let showMark = null;
let shownPending = false;
let showTimer = null;
const flushShown = () => {
    if (showTimer) {
        clearTimeout(showTimer);
        showTimer = null;
    }
    shownPending = false;
    document.body.classList.remove('showing');
    ipcRenderer.send('${IPC_SHOWN}');
};
const syncShownState = () => {
    if (!shownPending || !showMark || !showMark.rendered) return;
    // 还停在「显示中」那一刻之前的快照：等下一帧到了再回信，否则上屏的会是旧画面。
    if (lastPayloadFrame < showMark.frame) return;
    flushShown();
};
// 主进程在页面加载完后推来上次的排版选择（值不合法就保持默认的 text）。
ipcRenderer.on('${IPC_LAYOUT}', (event, value) => {
    if (!LAYOUT_MODES.includes(value)) return;
    layoutMode = value;
    applyLayoutButton();
    if (lastPayload) render(lastPayload);
});
// 主进程说「该显示了」：先别让旧画面见人，等当下这一帧到了再回信上屏。
ipcRenderer.on('${IPC_SHOW}', () => {
    shownPending = true;
    showMark = { frame: payloadFrame + 1, rendered: false };
    // 控制器标成「显示中」：按钮立刻点亮；同时整窗先穿透（窗口还没上屏，万一在握手期间露出来
    // 也不能吃点击；上屏后主进程会把穿透状态改回真实的，见 ignore-hint）。
    document.body.classList.add('showing');
    ipcRenderer.send('${IPC_IGNORE_HINT}', true);
    showTimer = setTimeout(flushShown, SHOWN_FRAME_WAIT_MS);
});
applyLayoutButton();

// 右上角 ×：只隐藏窗口（主进程 setWidgetOpen(false)，模组照常运行、快照照收），
// 重新显示靠播放条上的「词」按钮。窗口没有销毁，隐藏期间页面仍活着。
if (els.close) {
    els.close.addEventListener('click', () => {
        ipcRenderer.send('${IPC_CLOSE}');
    });
}

// ---- 悬停显示 / 固定位置 ----
// 未固定：整窗可拖拽（body 是 drag 区），鼠标离开后只剩透明歌词，悬停时浮出半透明底 + 完整控制条。
// 已固定：整窗 no-drag，控制条两侧按钮整组隐藏，只留正中那颗「取消锁定」按钮（悬停时出现）。
// 固定状态由主进程记在 userData 的小 JSON 里，启动时通过 IPC_PINNED 推回来。
let isPinned = false;
const applyPinState = () => {
    document.body.classList.toggle('pinned', isPinned);
    if (els.pin) {
        els.pin.dataset.mode = isPinned ? 'pinned' : 'floating';
        setIcon(els.pin, isPinned ? 'pin-off' : 'pin');
        setButtonLabel(els.pin, isPinned ? '取消锁定' : '固定位置');
        // 提示气泡比读屏文案长一点，说明点了会恢复拖拽。
        if (isPinned) els.pin.dataset.tip = '取消锁定（恢复拖拽）';
    }
    // 固定后整窗忽略鼠标，主进程要知道解锁按钮在哪儿才能只放开那一小块。
    reportPinRect();
};
// 把解锁按钮的位置（CSS 像素，相对内容区）报给主进程：部分点击穿透靠它做命中判定。
let pinRectTimer = null;
const sendPinRect = (rect) => {
    if (rect.width <= 0 || rect.height <= 0) return;
    ipcRenderer.send('${IPC_PIN_RECT}', {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
    });
};
const reportPinRect = () => {
    if (!els.pin) return;
    sendPinRect(els.pin.getBoundingClientRect());
    // 控制条有 0.18s 的 transform 过渡：切换固定态时立刻量到的是「还在 -6px」的中间值，
    // 过渡结束后再报一次最终位置（主进程以最后一次为准）。
    if (pinRectTimer) clearTimeout(pinRectTimer);
    pinRectTimer = setTimeout(() => {
        pinRectTimer = null;
        if (els.pin) sendPinRect(els.pin.getBoundingClientRect());
    }, 260);
};
window.addEventListener('resize', reportPinRect);
const reportPinState = () => {
    ipcRenderer.send('${IPC_PINNED}', isPinned);
};
ipcRenderer.on('${IPC_PINNED}', (event, value) => {
    isPinned = value === true;
    applyPinState();
});
if (els.pin) {
    // 同一颗按钮在两种状态间切换：未固定 → 固定；已固定 → 取消锁定（恢复拖拽）。
    els.pin.addEventListener('click', () => {
        isPinned = !isPinned;
        applyPinState();
        reportPinState();
    });
}
applyPinState();

// 悬停状态挂在 body 上（body.hover），纯 CSS 负责过渡，JS 只切换类。
// 主进程每 80ms 用光标位置算一次「在不在窗口上」，从这里推过来（拖拽区收不到鼠标事件）；
// 页面自己的 mouseenter/mouseleave 只在窗口不是拖拽区时才有效，保留作为即时补充。
let hovered = false;
const setHovered = (next) => {
    if (hovered === next) return;
    hovered = next;
    document.body.classList.toggle('hover', next);
};
ipcRenderer.on('${IPC_HOVER}', (event, value) => setHovered(value === true));
window.addEventListener('mouseenter', () => setHovered(true));
window.addEventListener('mouseleave', () => setHovered(false));
// 窗口失焦（比如点了别的程序）时也当成鼠标离开，免得控制栏一直挂在那儿。
// 固定态例外：那时「鼠标在不在窗口上」由主进程的几何命中说了算，页面自己清掉 hover 会
// 让解锁按钮消失、主进程却仍以为鼠标在窗内（不会再补发 hover），看着像「按钮失灵」。
window.addEventListener('blur', () => {
    if (!isPinned) setHovered(false);
});

// volumeDragging 为真时不信主进程回推的音量（否则拖动会被上一帧拽回去）；
// 同时给百分比胶囊挂 body.volume-dragging，拖动中高亮，松手复原。
const setVolumeDragging = (dragging) => {
    volumeDragging = dragging;
    document.body.classList.toggle('volume-dragging', dragging);
};

els.volume.addEventListener('pointerdown', () => {
    setVolumeDragging(true);
});
els.volume.addEventListener('input', () => {
    setVolumeDragging(true);
    els.volumeValue.textContent = els.volume.value + '%';
    setIcon(els.volumeIcon, volumeIconName(Number(els.volume.value)));
    scheduleVolume();
});
els.volume.addEventListener('change', () => {
    setVolumeDragging(false);
    sendVolume();
});
// 拖动被打断（指针取消、窗口失焦、指针捕获丢失）时也要收尾，否则滑块会一直不再跟随主进程。
const stopVolumeDragging = () => {
    if (!volumeDragging) return;
    setVolumeDragging(false);
    sendVolume();
};
window.addEventListener('pointerup', stopVolumeDragging);
window.addEventListener('pointercancel', stopVolumeDragging);
window.addEventListener('blur', stopVolumeDragging);
els.volume.addEventListener('lostpointercapture', stopVolumeDragging);

ipcRenderer.on('${IPC_DATA}', (event, payload) => {
    payloadFrame += 1;
    render(payload, Date.now());
    lastPayloadFrame = payloadFrame;
    // 1.5.2：画完了再看这次显示握手能不能回信（要等的是「显示中」那一刻之后的帧）。
    if (shownPending && showMark) {
        showMark.rendered = true;
        syncShownState();
    }
});
// 主进程在页面加载完后推来当前配置（字号 / 字体 / 外观），之后每次设置变化都会再推。
ipcRenderer.on('${IPC_CONFIG}', (event, payload) => applyConfig(payload));
window.addEventListener('contextmenu', (event) => event.preventDefault());
// 防止把文件拖进窗口触发导航（will-navigate 之外再兜一层）。
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => event.preventDefault());
</script>
</body>
</html>`;

module.exports = function activate(api) {
    // 主进程侧状态：窗口、最后一份快照、最后一次已知的循环模式。
    const state = {
        win: null,
        lastPayload: null,
        lastLoopMode: null,
        warnedNoRpcSend: false,
        // 宿主自己的窗口（主窗口等），用来判断「宿主是不是已经没窗口了」；不含悬浮窗。
        hostWindows: new Set(),
        hostCloseTimer: null,
        // 正在 new BrowserWindow（悬浮窗自己），用来把它从 browser-window-created 里排除掉。
        creatingWidget: false,
        // 最近一分钟内的崩溃时刻，用来限制自动 reload（不因加载成功而清零）。
        crashTimes: [],
        recreateAttempts: 0,
        warnedRecreateLimit: false,
        disposed: false,
        // 窗口状态持久化：{ x, y, pinned }，读自 userData 下的 STATE_FILE_NAME。
        persisted: null,
        persistTimer: null,
        // 当前是否固定（和页面同步）：固定时整窗忽略鼠标，只有解锁按钮的矩形可点。
        pinned: false,
        // 页面报上来的解锁按钮矩形（CSS 像素，相对内容区）；没收到之前不做穿透判定。
        pinRect: null,
        // 悬停 / 穿透判定的轮询 tick，固定状态或按钮矩形变化时立刻重算一次。
        hoverTick: null,
        // lastPayload 只在 update-data 处理函数里写，写之前先过 isStaleFrame（它的基准单独放，不进 state）。
        // 形态：1.3.0 只有「桌面歌词」一种，1.7.0 才做「悬浮窗歌词」，这里先留状态位。
        surface: 'desktop',
        // 1.5.0：显示配置（字号 / 字体 / 外观）。真源在宿主的模组设置里，client 推过来，
        // 主进程只做校验（normalizeConfig）、定窗口高度、再整份转给页面。
        config: normalizeConfig(null),
        // 1.4.0：悬浮窗当前是否显示（× / 播放条「词」按钮会改它；落盘在 persisted.open）。
        // 隐藏 ≠ 销毁：窗口还在，照收快照，只是不显示、不转发数据给页面。
        widgetOpen: true,
        // 上次成功推给 client 的显隐真值，用来给 reportWidgetVisibility 去重（null = 还没推过）。
        reportedOpen: null,
        // 1.5.1：等页面握手再上屏的超时计时器（null = 没在等）。
        shownTimer: null,
        // 1.5.2：页面自己设过的鼠标穿透值（显示握手期间页面先全窗穿透）。null = 主进程是唯一来源。
        ignoreHint: null,
    };

    // ---- 帧顺序 ----
    // 快照在进 state 之前先过 isStaleFrame：迟到帧直接丢掉，state.lastPayload 只记真正更新的那一帧，
    // 页面重载 / 重建时补发也就不会补到旧句。换歌由 playSessionId 分桶，新会话一律接受并重置基准。
    const frameGate = { session: undefined, position: null, lineIndex: -1, droppingSince: null };

    // ---- 窗口状态持久化（位置 + 是否固定） ----
    // 以前每次启动都把窗口摆回「主屏底部居中」，用户拖到的位置一重启就丢；
    // 这里在 userData 下记一个小 JSON，启动时恢复。
    const stateFilePath = () => path.join(app.getPath('userData'), STATE_FILE_NAME);

    const readPersistedState = () => {
        try {
            const parsed = JSON.parse(fs.readFileSync(stateFilePath(), 'utf8'));
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch (error) {
            // 第一次运行没有这个文件是正常情况，不打扰用户。
            if (!error || error.code !== 'ENOENT') {
                api.log.warn(LOG_PREFIX + ' 读取窗口状态失败，本次用默认位置', error);
            }
            return {};
        }
    };

    const savePersistedState = () => {
        if (!state.persisted) return;
        // 1.5.0：高度跟着字号走，而建窗那一刻只有默认配置（38px/180）。这里把窗口的实际高度也记下来，
        // 否则字号 >38px 的用户每次启动都要经历「先按 180 建窗、再变高」，见 createWidgetWindow。
        if (state.win && !state.win.isDestroyed()) {
            try {
                state.persisted.height = state.win.getSize()[1];
            } catch (error) {
                // 读不到就算了，下次启动按默认字号的高度建窗。
            }
        }
        try {
            fs.mkdirSync(path.dirname(stateFilePath()), { recursive: true });
            fs.writeFileSync(stateFilePath(), JSON.stringify(state.persisted));
        } catch (error) {
            api.log.warn(LOG_PREFIX + ' 保存窗口状态失败（不影响歌词显示）', error);
        }
    };

    /** 拖动时 'move' 触发得很密，合并成一次写盘。 */
    const scheduleSave = () => {
        if (state.persistTimer) return;
        state.persistTimer = setTimeout(() => {
            state.persistTimer = null;
            savePersistedState();
        }, SAVE_DEBOUNCE_MS);
    };

    /** 把窗口当前坐标记进内存（真正落盘由 scheduleSave / 退出时统一做）。 */
    const rememberWindowPosition = (widgetWindow) => {
        if (!state.persisted || !widgetWindow || widgetWindow.isDestroyed()) return;
        try {
            const bounds = widgetWindow.getBounds();
            state.persisted.x = bounds.x;
            state.persisted.y = bounds.y;
        } catch (error) {
            // 读不到就算了，下次启动回默认位置。
        }
    };

    /**
     * 保存的位置还算不算「看得见」：至少要有一部分落在某个显示器的可用范围里。
     * Windows 按整个屏幕（bounds）算：窗口允许停在任务栏上，守卫会把它提到任务栏之上；
     * 用 workArea 会把「停在任务栏上」的位置当成失效，重启后弹回默认位置。
     * macOS / Linux 仍按工作区算：那里的保留带是菜单栏 / Dock / 面板，被盖住就再也找不回来了。
     */
    const isPositionUsable = (position) => {
        try {
            const areaOf = (display) => (process.platform === 'win32' ? display.bounds : display.workArea);
            return screen.getAllDisplays().some((display) => {
                const area = areaOf(display);
                return position.x + WINDOW_WIDTH > area.x + 40
                    && position.x < area.x + area.width - 40
                    && position.y + windowHeightFor(state.config) > area.y + 20
                    && position.y < area.y + area.height - 20;
            });
        } catch (error) {
            return false;
        }
    };

    state.persisted = readPersistedState();
    // 1.4.0：显隐也持久化。老存档没有 open 字段 → 默认显示（不能因为升级就把歌词藏起来）。
    state.widgetOpen = state.persisted.open !== false;
    // 1.5.1：建窗用的初始配置（之后由 client 推来的真配置覆盖）。
    state.config = prepareConfig(state.persisted);
    api.log.info(LOG_PREFIX + ' 窗口状态', JSON.stringify({
        file: stateFilePath(),
        saved: state.persisted,
    }));

    // ---- 排查日志（真机 IPC 链路定位用，定位完删掉） ----
    api.log.info(LOG_PREFIX + ' main activate', JSON.stringify({
        version: api.manifest && api.manifest.version,
        folium: api.host && api.host.folium,
        hasHandle: typeof (api.rpc && api.rpc.handle),
        hasSend: typeof (api.rpc && api.rpc.send),
    }));

    /** 把归一化后的指令发给 client.mjs；主进程 -> client 用 api.rpc.send（Folium 1.7+）。 */
    const sendActionToClient = (action) => {
        if (!action) return;
        if (typeof api.rpc.send !== 'function') {
            if (!state.warnedNoRpcSend) {
                state.warnedNoRpcSend = true;
                api.log.warn(LOG_PREFIX + ' 需要 Folium 1.7+ 的 api.rpc.send，当前宿主版本过低，窗口指令无法发给 client');
            }
            return;
        }
        try {
            api.log.info(LOG_PREFIX + ' 转发 action 给 client', JSON.stringify(action));
            api.rpc.send(RPC_ACTION, action);
        } catch (error) {
            api.log.warn(LOG_PREFIX + ' 发送 action 给 client 失败', error);
        }
    };

    /** 当前循环模式：优先用最后一份快照，没有就向宿主读一次，再没有就按 off。 */
    const resolveLoopMode = () => {
        if (state.lastLoopMode) return state.lastLoopMode;
        try {
            if (api.runtime && typeof api.runtime.getPlaybackSnapshot === 'function') {
                const snapshot = api.runtime.getPlaybackSnapshot();
                if (snapshot && LOOP_MODES.includes(snapshot.loopMode)) {
                    return snapshot.loopMode;
                }
            }
        } catch (error) {
            api.log.warn(LOG_PREFIX + ' 读取播放快照失败，循环模式按 off 处理', error);
        }
        return 'off';
    };

    /**
     * 把窗口页面的简写指令归一化成 client.mjs 认识的形状；
     * 返回 null 表示无法识别（调用方记一条警告）。
     */
    const normalizeAction = (raw) => {
        if (typeof raw === 'string') {
            return DIRECT_ACTIONS.includes(raw) ? { action: raw } : null;
        }
        if (!raw || typeof raw !== 'object') return null;

        // 页面也可以直接发 client.mjs 认识的形状，校验后原样转发。
        if (typeof raw.action === 'string') {
            switch (raw.action) {
                case 'next':
                case 'prev':
                case 'toggle':
                case 'request-sync':
                    return { action: raw.action };
                case 'set-volume': {
                    // 规范形状固定是 0–1 的 number（页面简写 0–100 见下面的 type 分支）。
                    if (typeof raw.volume !== 'number' || !Number.isFinite(raw.volume)) return null;
                    return { action: 'set-volume', volume: clampVolume(raw.volume) };
                }
                case 'set-loop':
                    return LOOP_MODES.includes(raw.mode) ? { action: 'set-loop', mode: raw.mode } : null;
                default:
                    return null;
            }
        }

        // 窗口页面用的简写：{ type, value }。
        switch (raw.type) {
            case 'set-volume': {
                // 滑块给的是 0–100，client.mjs 要 0–1。
                const percent = toFiniteNumber(raw.value);
                return percent === null ? null : { action: 'set-volume', volume: clampVolume(percent / 100) };
            }
            case 'cycle-loop': {
                const mode = nextLoopMode(resolveLoopMode());
                // 连点时下一次要基于刚发出的模式，而不是上一份 payload。
                state.lastLoopMode = mode;
                return { action: 'set-loop', mode };
            }
            case 'set-loop':
                return LOOP_MODES.includes(raw.value) ? { action: 'set-loop', mode: raw.value } : null;
            case 'next':
            case 'prev':
            case 'toggle':
            case 'request-sync':
                return { action: raw.type };
            default:
                return null;
        }
    };

    /** 把最新快照交给窗口页面（窗口不在 / 已销毁 / 被 × 隐藏时丢弃）。 */
    const sendPayloadToWindow = (payload) => {
        // 1.4.0：隐藏期间不往页面推数据（页面还在，但没必要逐帧重绘不可见的内容）；
        // 重新显示时 setWidgetOpen 会补发最后一份快照 + request-sync，不会停在旧句。
        if (!state.widgetOpen) return;
        const widgetWindow = state.win;
        if (!widgetWindow || widgetWindow.isDestroyed()) {
            api.log.info(LOG_PREFIX + ' 转发中止：没有可用悬浮窗');
            return;
        }
        const contents = widgetWindow.webContents;
        if (!contents || contents.isDestroyed()) {
            api.log.info(LOG_PREFIX + ' 转发中止：webContents 不可用');
            return;
        }
        try {
            contents.send(IPC_DATA, payload);
            api.log.info(LOG_PREFIX + ' 已 send IPC_DATA 给悬浮窗页面', JSON.stringify({
                line: payload && payload.line && payload.line.text,
            }));
        } catch (error) {
            api.log.warn(LOG_PREFIX + ' 向悬浮窗发送数据失败', error);
        }
    };

    /** 1.5.0：字号变了就改窗口高度（宽度固定 640；底部贴边时向上让位，别掉出屏幕）。 */
    const applyWindowSize = () => {
        const widgetWindow = state.win;
        if (!widgetWindow || widgetWindow.isDestroyed()) return;
        // 1.5.1：启动初期只有默认配置，先用落盘的窗口高度顶着，免得第一帧矮一截；
        // client 把共享段里的真字号推来之后（config.window.height 被清掉）才按字号算。
        const saved = state.config.window && state.config.window.height;
        const height = Number.isFinite(saved) ? saved : windowHeightFor(state.config);
        try {
            const [width, currentHeight] = widgetWindow.getSize();
            if (width === WINDOW_WIDTH && currentHeight === height) return;
            const bounds = widgetWindow.getBounds();
            widgetWindow.setSize(WINDOW_WIDTH, height, false);
            // 变高时，只有底边本来就贴着工作区底才向上让位（保持底边不动）；
            // 停在屏幕上半部时应当向下长，否则顶边会莫名其妙往上跑。
            try {
                const area = screen.getDisplayMatching(bounds).workArea;
                const bottom = bounds.y + currentHeight;
                const atBottom = bottom >= area.y + area.height - 2;
                let nextY = bounds.y;
                if (atBottom) {
                    nextY = Math.min(Math.max(bounds.y, area.y), Math.max(area.y, bottom - height));
                } else if (bounds.y + height > area.y + area.height) {
                    nextY = Math.max(area.y, area.y + area.height - height);
                }
                if (nextY !== bounds.y) widgetWindow.setPosition(bounds.x, Math.round(nextY));
            } catch (error) {
                // 位置调不动就只改高度，不影响主流程。
            }
        } catch (error) {
            api.log.warn(LOG_PREFIX + ' 调整窗口尺寸失败', error);
        }
    };

    /** 把当前配置下发给页面（页面加载完后调用一次，配置变化时再调用）。 */
    const sendConfigToWindow = () => {
        const widgetWindow = state.win;
        if (!widgetWindow || widgetWindow.isDestroyed()) return;
        try {
            widgetWindow.webContents.send(IPC_CONFIG, state.config);
        } catch (error) {
            // 页面还没加载完：did-finish-load 里会再发一次。
        }
    };

    /**
     * 向 client 要一次配置（1.5.1）。配置真源在 client 侧的宿主设置里，这边可能在没有重跑 client
     * 的情况下被重建：宿主「重载模组」只 loadAll() 主进程 entry，模组文件没变时 clientUrl 不变，
     * client 不会重新 activate，于是它「激活即下发配置」那一次永远不会再发生，主进程只能停在默认值上
     * （字号回 38）。所以页面每次加载完、每次 activate 都主动要一次，拿回来的配置走 RPC_CONFIG。
     * 显隐无关：窗口隐藏时也要要，下一条快照不会把配置带回来。
     */
    const requestConfigFromClient = () => {
        sendActionToClient({ action: ACTION_REQUEST_CONFIG });
    };

    /** 窗口页面点了按钮：校验来源窗口，归一化后转发给 client.mjs。 */
    const onActionFromWindow = (event, raw) => {
        const widgetWindow = state.win;
        if (!widgetWindow || widgetWindow.isDestroyed() || event.sender !== widgetWindow.webContents) {
            // 不是本悬浮窗发来的：别的模组/页面误用了同一个通道名，记一条但绝不转发。
            api.log.warn(LOG_PREFIX + ' 收到非本悬浮窗的指令来源，已忽略');
            return;
        }
        const action = normalizeAction(raw);
        if (!action) {
            api.log.warn(LOG_PREFIX + ' 收到无法识别的窗口指令，已忽略', describeForLog(raw));
            return;
        }
        sendActionToClient(action);
    };

    /** 显隐落盘（只在真的切换时才动状态，写盘合并到 scheduleSave 的防抖里）。 */
    const persistWidgetOpen = (open) => {
        if (!state.persisted) state.persisted = {};
        state.persisted.open = open;
        scheduleSave();
    };

    /**
     * 1.4.0：把「悬浮窗现在开着 / 关着」告诉 client.mjs，播放条上的「词」按钮靠它高亮。
     * api.rpc.send 是 fire-and-forget：client 还没挂载时这条消息直接丢，所以 client 激活时
     * 还会用 widget-state 主动问一次对齐。去重记「上次推成功时的值」，推送失败保持旧值。
     */
    const reportWidgetVisibility = (force) => {
        if (!force && state.reportedOpen === state.widgetOpen) return;
        if (typeof api.rpc.send !== 'function') {
            if (!state.warnedNoRpcSend) {
                state.warnedNoRpcSend = true;
                api.log.warn(LOG_PREFIX + ' 需要 Folium 1.7+ 的 api.rpc.send，播放条按钮无法同步显隐状态');
            }
            return;
        }
        try {
            api.rpc.send(RPC_WIDGET_VISIBILITY, { visible: state.widgetOpen });
            state.reportedOpen = state.widgetOpen;
        } catch (error) {
            api.log.warn(LOG_PREFIX + ' 向 client 推送悬浮窗可见性失败', error);
        }
    };

    /**
     * 显示 / 隐藏悬浮窗（× 和播放条「词」按钮都走这里）。返回切换后的状态。
     * 隐藏只 hide()，不销毁窗口：模组继续收快照、页面继续存活，重新显示时立刻能画。
     * 1.5.2：「显示」在这里只是开始——真正上屏要等页面回 IPC_SHOWN（见 showWidgetWindow）。
     * 函数名保留 setWidgetOpen，因为它同时负责状态、落盘与向 client 汇报（hideWhenCollapsed 用）。
     */
    const setWidgetOpen = (open) => {
        state.widgetOpen = open === true;
        const widgetWindow = state.win;
        if (!state.disposed && (!widgetWindow || widgetWindow.isDestroyed())) {
            // 关着的时候窗口可能被别的路径销毁了：要显示就现在重建。
            if (state.widgetOpen) {
                ensureWidgetWindow();
                // 重建可能被「重试上限 / 没有宿主窗口」拦下：如实回到关闭态，
                // 否则会先 log「已显示」、把按钮点亮，用户却看不到窗口。
                if (!state.win || state.win.isDestroyed()) {
                    state.widgetOpen = false;
                    api.log.warn(LOG_PREFIX + ' 悬浮窗无法重建，仍保持隐藏');
                }
            }
        } else if (widgetWindow && !widgetWindow.isDestroyed()) {
            try {
                if (state.widgetOpen) {
                    // 1.5.2：显示分两段。这里只做「让页面先准备好」：请 client 绕过去重发一帧当下这一句，
                    // 但**不**补发旧快照（旧快照 = 关窗那一刻的画面，闪旧句就是从它来的），
                    // 也先不上屏。页面画完新帧回 IPC_SHOWN，才由 showWidgetWindow 上屏。
                    sendActionToClient({ action: 'request-sync' });
                    // 隐藏期间可能改过字号：上屏前按当前配置定一次高度。
                    applyWindowSize();
                    // 窗口可能已销毁 / 页面没加载完：拿不到握手就兜底上屏。
                    try {
                        widgetWindow.webContents.send(IPC_SHOW);
                    } catch (error) {
                        api.log.warn(LOG_PREFIX + ' 通知页面准备显示失败', error);
                    }
                    waitForShown();
                } else {
                    hideWidgetWindow();
                }
            } catch (error) {
                api.log.warn(LOG_PREFIX + (state.widgetOpen ? ' 显示悬浮窗失败' : ' 隐藏悬浮窗失败'), error);
            }
        }
        persistWidgetOpen(state.widgetOpen);
        reportWidgetVisibility();
        api.log.info(LOG_PREFIX + ' 悬浮窗' + (state.widgetOpen ? '已显示' : '已隐藏（模组仍在运行）'));
        return state.widgetOpen;
    };

    /**
     * 1.5.1：真正的上屏。showInactive 而不是 show：悬浮歌词不该把键盘焦点从主窗口 / 别的应用抢走。
     * 用 force 的是「页面没来得及握手」的兜底路径，正常路径由 onShownFromWindow 调用。
     * 1.5.2：上屏前先把整窗设成忽略鼠标——窗口之所以收不到鼠标，本来就是因为它是「隐藏着」的，
     * 上屏后要等 client 侧要一轮 widget-state 才放开，这里补上，免得刚上屏那几十毫秒能点到。
     */
    const showWidgetWindow = (force) => {
        const widgetWindow = state.win;
        cancelShownWait();
        // 期间被关掉 / 被销毁 / 模组已停用：不再上屏。
        if (!widgetWindow || widgetWindow.isDestroyed() || !state.widgetOpen || state.disposed) return;
        try {
            widgetWindow.setIgnoreMouseEvents(true, { forward: true });
        } catch (error) {
            api.log.warn(LOG_PREFIX + ' 上屏前设置鼠标穿透失败', error);
        }
        // 上屏后悬停轮询按正常规则接管穿透；它第一次推算出来的值若不是「穿透」，会真的重设一次。
        state.ignoreHint = null;
        try {
            widgetWindow.showInactive();
            api.log.info(LOG_PREFIX + ' 悬浮窗上屏' + (force ? '（页面未握手，兜底显示）' : ''));
        } catch (error) {
            api.log.warn(LOG_PREFIX + ' 显示悬浮窗失败', error);
        }
    };

    /** 等页面回 IPC_SHOWN；超时就兜底上屏，宁可闪一下也不能让「词」按钮点了没反应。 */
    const waitForShown = () => {
        cancelShownWait();
        state.shownTimer = setTimeout(() => {
            state.shownTimer = null;
            showWidgetWindow(true);
        }, SHOWN_TIMEOUT_MS);
    };

    const cancelShownWait = () => {
        if (!state.shownTimer) return;
        clearTimeout(state.shownTimer);
        state.shownTimer = null;
    };

    /**
     * 1.5.2：隐藏 = 页面上该收的状态 + 窗口隐藏 + 整窗忽略鼠标。
     * 忽略鼠标这一条是关键：窗口「看不见」本来就在挡鼠标，不补的话隐藏后窗口还在那儿吃点击。
     */
    const hideWidgetWindow = () => {
        // 还没上屏就又被关掉：作废这次握手，别让迟到的 IPC_SHOWN 把窗口重新弹出来。
        cancelShownWait();
        const widgetWindow = state.win;
        if (!widgetWindow || widgetWindow.isDestroyed()) return;
        try {
            if (widgetWindow.isVisible()) widgetWindow.hide();
            widgetWindow.setIgnoreMouseEvents(true, { forward: true });
        } catch (error) {
            api.log.warn(LOG_PREFIX + ' 隐藏悬浮窗失败', error);
        }
    };

    /** 页面把这一帧画好了（握手第二步）：现在才让窗口上屏。 */
    const onShownFromWindow = (event) => {
        if (!state.win || state.win.isDestroyed() || event.sender !== state.win.webContents) return;
        if (!state.shownTimer) return; // 不是这次握手要的那一句（超时后迟到的重复消息）
        showWidgetWindow(false);
    };

    /**
     * 1.5.2：页面在显示握手期间自己把整窗设成穿透（主进程侧的悬停轮询是按帧调用的，赶不上这一下）。
     * 记进 state.ignoreHint：页面自己已经设过，就不再在「窗口没上屏」那一帧重复调用；
     * 之后真上屏、进入正常判定时，若要恢复可点会绕开 hint 重新设一次。
     */
    const onIgnoreHintFromWindow = (event, value) => {
        if (!state.win || state.win.isDestroyed() || event.sender !== state.win.webContents) return;
        state.ignoreHint = value === true;
    };

    /** 页面点了右上角 ×：校验来源窗口后隐藏（不停用模组，播放条「词」按钮能找回）。 */
    const onCloseFromWindow = (event) => {
        if (!state.win || state.win.isDestroyed() || event.sender !== state.win.webContents) {
            api.log.warn(LOG_PREFIX + ' 收到非本悬浮窗的关闭请求，已忽略');
            return;
        }
        setWidgetOpen(false);
    };

    /** 默认位置：主显示器工作区底部中间。 */
    /** 窗口位置：优先恢复上次拖到的位置；没有记录 / 记录已跑出屏幕时回默认位置。 */
    const placeWindow = (widgetWindow) => {
        const saved = state.persisted;
        if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
            const position = { x: Math.round(saved.x), y: Math.round(saved.y) };
            if (isPositionUsable(position)) {
                try {
                    widgetWindow.setPosition(position.x, position.y);
                    return;
                } catch (error) {
                    api.log.warn(LOG_PREFIX + ' 恢复上次窗口位置失败，改用默认位置', error);
                }
            }
        }
        try {
            const { workArea } = screen.getPrimaryDisplay();
            const x = Math.round(workArea.x + (workArea.width - WINDOW_WIDTH) / 2);
            const y = Math.round(workArea.y + workArea.height - windowHeightFor(state.config) - WINDOW_MARGIN);
            widgetWindow.setPosition(x, y);
        } catch (error) {
            api.log.warn(LOG_PREFIX + ' 读取屏幕尺寸失败，窗口使用默认位置', error);
        }
    };

    /**
     * 悬停检测：页面整窗是 -webkit-app-region: drag 区域，Windows 下拖拽区不会把鼠标事件
     * 交给渲染进程（所以页面里的 :hover / mouseenter 在这块区域收不到）。这里由主进程
     * 轮询「光标是否落在窗口矩形内」，变化时通过 IPC_HOVER 推给页面。
     * 返回停止函数，窗口关闭时自动调用。
     */
    const startHoverWatch = (widgetWindow) => {
        let lastHover = null;
        // 当前是否让整窗忽略鼠标（只在固定状态为 true）。null = 还没设置过。
        let lastIgnore = null;
        // 连续失败次数：单次异常只做 fail-open，不停止轮询（否则窗口可能永远卡在穿透状态）。
        let failCount = 0;
        let timer = null;
        const stop = () => {
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
            if (state.hoverTick === tick) state.hoverTick = null;
        };
        /**
         * ignore 传 true/false 表示「希望窗口处于这个鼠标穿透状态」，传 null 表示「这一帧不管」
         * （1.5.2：页面在显示握手期间已经自己设成穿透了，主进程没必要再设一遍）。
         * lastIgnore 是「我们最近一次设置过的值」的实际值，state.ignoreHint 是页面改道的值。
         */
        const setIgnore = (ignore) => {
            if (ignore === null) return;
            if (ignore === lastIgnore && state.ignoreHint === null) return;
            try {
                // forward：忽略鼠标时仍把移动事件转发给页面，让页面里的 mouseleave / hover 不卡在旧状态。
                widgetWindow.setIgnoreMouseEvents(ignore, { forward: true });
                // 只有调用成功才算数：失败时把 lastIgnore 置空，下一次 tick 才会真的重试。
                // （如果先赋值再调用，失败后下一轮会因为这个相等判断直接早退，窗口可能永远解不开。）
                lastIgnore = ignore;
                // 页面自己设过的那笔账已经被这次设置覆盖掉了。
                state.ignoreHint = null;
            } catch (error) {
                lastIgnore = null;
            }
        };
        const tick = () => {
            if (state.disposed || widgetWindow.isDestroyed()) {
                stop();
                return;
            }
            let hover = false;
            let overPin = false;
            try {
                const point = screen.getCursorScreenPoint();
                // 用内容区矩形算命中：页面报上来的按钮坐标是相对内容区的 CSS 像素，两者同源。
                const bounds = widgetWindow.getContentBounds();
                hover = widgetWindow.isVisible()
                    && point.x >= bounds.x && point.x < bounds.x + bounds.width
                    && point.y >= bounds.y && point.y < bounds.y + bounds.height;
                // 部分点击穿透：固定状态整窗不吃鼠标，只有解锁按钮那块恢复可点。
                // 固定但还没收到按钮矩形时保持可点（宁可挡一下，也别把人锁在外面解不开）。
                const rect = state.pinRect;
                if (hover && rect) {
                    const left = bounds.x + rect.x - PIN_HIT_PADDING;
                    const top = bounds.y + rect.y - PIN_HIT_PADDING;
                    overPin = point.x >= left && point.x < left + rect.width + PIN_HIT_PADDING * 2
                        && point.y >= top && point.y < top + rect.height + PIN_HIT_PADDING * 2;
                }
                // 1.5.2：窗口没上屏时（显示握手中）整窗忽略鼠标——它随时可能露出来，露出来也不能吃点击。
                // 页面已经自己设过穿透（ignore-hint）时这一帧跳过，不用多等一次轮询。
                const wantIgnore = !widgetWindow.isVisible() || (state.pinned && !!rect && !overPin);
                const pageAlreadySet = !widgetWindow.isVisible() && state.ignoreHint === true;
                setIgnore(pageAlreadySet ? null : wantIgnore);
                failCount = 0;
            } catch (error) {
                // 单次异常（显示器热插拔、会话切换、销毁竞态）不能让窗口卡在「整窗穿透」里出不来：
                // 先 fail-open 把窗口恢复成可点、并让页面把解锁按钮显出来，再继续轮询。
                failCount += 1;
                try {
                    widgetWindow.setIgnoreMouseEvents(false);
                    lastIgnore = false;
                } catch (openError) {
                    lastIgnore = null;
                }
                try {
                    widgetWindow.webContents.send(IPC_HOVER, true);
                } catch (sendError) {
                    // 页面不在了，等它加载完下一轮自然恢复。
                }
                if (failCount === 1) {
                    api.log.warn(LOG_PREFIX + ' 悬停轮询出错，已临时恢复窗口可点', error);
                }
                // 连续失败太多说明这个窗口已经不可用（阈值约 8 秒），停掉轮询等窗口销毁/重建。
                if (failCount >= MAX_HOVER_FAILURES) stop();
                return;
            }
            if (hover === lastHover) return;
            lastHover = hover;
            try {
                widgetWindow.webContents.send(IPC_HOVER, hover);
            } catch (error) {
                // 页面还在加载 / webContents 已销毁时 send 会抛，忽略后下一次轮询会重试。
            }
        };
        timer = setInterval(tick, HOVER_POLL_MS);
        state.hoverTick = tick;
        widgetWindow.on('closed', stop);
        return stop;
    };

    /**
     * 任务栏守卫：Windows 里任务栏本身也是置顶窗口，而置顶层只有一层——用户一点任务栏，
     * 它就排到悬浮窗前面，把压在任务栏上的歌词切掉一块；拖动、切换窗口后同样会被盖住。
     * 这里只在「窗口矩形确实压到任务栏」时把窗口重新提到置顶层顶部
     * （moveTop 在 Windows 上是 SetWindowPos(HWND_TOP)，不抢焦点、不改大小）；
     * 没压到任务栏时什么都不做。返回 { stop, tick }：stop 由窗口关闭/卸载时调用，
     * tick 供「窗口刚显示、而恢复的坐标正好压着任务栏」时立刻提升一次。
     */
    const startTaskbarGuard = (widgetWindow) => {
        // 只在 Windows 上开：那里任务栏和悬浮窗同在置顶层，才会互相压。
        // macOS / Linux 的「bounds 减去 workArea」是菜单栏 / Dock / 面板，不是同类问题，保持原行为。
        if (process.platform !== 'win32') return { stop: () => {}, tick: () => {} };
        let timer = null;
        let engaged = false;
        const stop = () => {
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
        };
        const tick = () => {
            if (state.disposed || widgetWindow.isDestroyed()) {
                stop();
                return;
            }
            try {
                if (!widgetWindow.isVisible() || !overlapsTaskbar(widgetWindow.getBounds())) {
                    engaged = false;
                    return;
                }
                // 宿主/系统把置顶状态改掉时先补回来，再提到置顶层顶部。
                if (!widgetWindow.isAlwaysOnTop()) {
                    widgetWindow.setAlwaysOnTop(true, 'screen-saver');
                }
                widgetWindow.moveTop();
                if (!engaged) {
                    engaged = true;
                    api.log.info(LOG_PREFIX + ' 悬浮窗压在任务栏上，已把窗口提到任务栏之上');
                }
            } catch (error) {
                stop();
                api.log.warn(LOG_PREFIX + ' 任务栏守卫停止（继续轮询会一直报错，重新创建窗口可恢复）', error);
            }
        };
        timer = setInterval(tick, TASKBAR_GUARD_MS);
        widgetWindow.on('closed', stop);
        return { stop, tick };
    };

    /** 创建悬浮窗；页面用 data URL 加载，不依赖任何外部文件。 */
    const createWidgetWindow = () => {
        // 构造期间会同步触发 app 的 'browser-window-created'，用这个标记把悬浮窗自己排除掉；
        // 构造抛错时也要复位，否则之后宿主的窗口事件会被一直忽略。
        state.creatingWidget = true;
        let widgetWindow;
        try {
            // 1.5.0：上次的实际高度存在状态文件里（见 savePersistedState），这里优先用它建窗。
            // 只按默认 38px 建窗的话，大字号用户启动时会「先 180、再变高」，而变高又动顶边 → 位置每次上漂。
            // 1.5.1：同一份高度已经放进 state.config.window.height（见 prepareConfig），这里直接复用。
            const startHeight = (state.config.window && state.config.window.height) || windowHeightFor(state.config);
            widgetWindow = new BrowserWindow({
                width: WINDOW_WIDTH,
                // 1.5.0：高度跟着字号走（默认 38px 时仍是 180），见 windowHeightFor。
                height: startHeight,
                useContentSize: true,
                frame: false,
                transparent: true,
                backgroundColor: '#00000000',
                alwaysOnTop: true,
                resizable: false,
                minimizable: false,
                maximizable: false,
                fullscreenable: false,
                skipTaskbar: true,
                hasShadow: false,
                // Windows 11 会给无边框窗口画一圈系统阴影 / 圆角描边（页面本身是全透明的，这圈灰边是
                // DWM 画的）：关掉圆角 + 关掉 thickFrame 才能连那圈描边一起去掉。
                roundedCorners: false,
                thickFrame: false,
                show: false,
                webPreferences: {
                    // 页面里的脚本要用 require('electron').ipcRenderer；页面内容全部由本文件生成。
                    nodeIntegration: true,
                    contextIsolation: false,
                    sandbox: false,
                    webviewTag: false,
                    // 窗口很少获得焦点，别让后台节流拖慢歌词刷新。
                    backgroundThrottling: false,
                    spellcheck: false,
                },
            });
        } finally {
            state.creatingWidget = false;
        }

        widgetWindow.setMenuBarVisibility(false);
        placeWindow(widgetWindow);
        // 悬停状态由主进程轮询光标后推给页面（拖拽区里渲染进程收不到鼠标事件）。
        startHoverWatch(widgetWindow);
        // 压到任务栏上时由守卫把窗口重新提到任务栏之上（见 startTaskbarGuard）。
        const taskbarGuard = startTaskbarGuard(widgetWindow);
        // 拖动时记下位置：'move' 会连续触发，用 scheduleSave 合并成一次写盘。
        widgetWindow.on('move', () => {
            rememberWindowPosition(widgetWindow);
            scheduleSave();
        });

        // 页面只该是这一份 data URL：禁止页面自己导航、禁止开新窗口。
        widgetWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        widgetWindow.webContents.on('will-navigate', (event) => {
            event.preventDefault();
        });

        // macOS：切到别的桌面 / 全屏应用时也留在最上层。
        if (process.platform === 'darwin') {
            widgetWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        }

        widgetWindow.once('ready-to-show', () => {
            // showInactive：悬浮歌词不该把键盘焦点从主窗口/别的应用抢走。
            // 1.4.0：上次退出时是「关掉」状态就别显示，窗口建好先留着（播放条「词」按钮随时叫醒）。
            if (!widgetWindow.isDestroyed() && state.widgetOpen) widgetWindow.showInactive();
            // 恢复的坐标可能正好压在任务栏上：立刻提升一次，别等 500ms 后的第一次轮询。
            if (taskbarGuard && !widgetWindow.isDestroyed()) taskbarGuard.tick();
        });

        // 用 on 而不是 once：页面崩溃后 reload 也会重新走到这里，重新补快照。
        widgetWindow.webContents.on('did-finish-load', () => {
            api.log.info(LOG_PREFIX + ' 悬浮窗页面 did-finish-load', JSON.stringify({
                hasLastPayload: !!state.lastPayload,
            }));
            // 1.5.0：字号 / 字体 / 外观配置。必须在第一帧快照之前下发，否则页面会按默认 38px
            // 先渲染一次、再跳成用户设的字号（一帧闪烁）。
            widgetWindow.webContents.send(IPC_CONFIG, state.config);
            if (state.lastPayload) sendPayloadToWindow(state.lastPayload);
            sendActionToClient({ action: 'request-sync' });
            // 1.5.1：页面准备好之后再要一次配置——reconcile 时页面与 client 的加载顺序无保证，
            // 只要要晚了、RPC 已经登记，这一趟就能把 main 从默认配置拉回用户的真实设置。
            requestConfigFromClient();
            // 恢复上次的固定状态。放在页面加载完之后推，页面收到才切 body.pinned（改拖拽区）。
            // 主进程这边也记一份：固定态整窗忽略鼠标（部分点击穿透）要靠它判断。
            state.pinned = !!(state.persisted && state.persisted.pinned);
            state.pinRect = null;
            widgetWindow.webContents.send(IPC_PINNED, state.pinned);
            // 恢复上次的排版选择（不存在或不合法时页面保持默认的 text）。
            // 老存档里的 full（三行排版）映射成 roman，不然升级后排版会静默退回「只原文」。
            const savedLayout = state.persisted
                ? (LEGACY_LAYOUT_IDS[state.persisted.layout] || state.persisted.layout)
                : null;
            if (LAYOUT_MODE_IDS.includes(savedLayout)) {
                widgetWindow.webContents.send(IPC_LAYOUT, savedLayout);
            }
            // 形态在 1.3.0 只有 desktop 一种，页面收到后无处可去；1.7.0 的悬浮窗视图直接消费这条消息。
            widgetWindow.webContents.send(IPC_SURFACE, state.surface);
        });

        widgetWindow.webContents.on('render-process-gone', (event, details) => {
            api.log.warn(LOG_PREFIX + ' 悬浮窗页面进程退出', describeForLog(details));
            if (state.disposed || widgetWindow.isDestroyed()) return;
            if (details && details.reason === 'clean-exit') return;
            const now = Date.now();
            state.crashTimes = state.crashTimes.filter((time) => now - time < CRASH_RELOAD_WINDOW_MS);
            state.crashTimes.push(now);
            if (state.crashTimes.length > MAX_CRASH_RELOADS) {
                api.log.error(LOG_PREFIX + ' 悬浮窗页面一分钟内连续退出，已停止自动重载；停用再启用模组可恢复');
                return;
            }
            try {
                widgetWindow.webContents.reload();
            } catch (error) {
                api.log.warn(LOG_PREFIX + ' 重新加载悬浮窗页面失败', error);
            }
        });

        widgetWindow.on('closed', () => {
            cleanupWidgetWindow(widgetWindow);
            if (!state.disposed) {
                api.log.warn(LOG_PREFIX + ' 悬浮窗被关闭；收到下一份数据或宿主出现新窗口时会重新创建');
            }
        });

        const url = 'data:text/html;charset=utf-8,' + encodeURIComponent(WIDGET_HTML);
        widgetWindow.loadURL(url).catch((error) => {
            api.log.error(LOG_PREFIX + ' 悬浮窗页面加载失败，销毁窗口以便下一条数据到达时重建', error);
            if (state.disposed || widgetWindow.isDestroyed()) return;
            // 走和「正常关闭」同一套清理：清按钮矩形、落盘位置/固定状态、把 state.win 置空。
            cleanupWidgetWindow(widgetWindow);
            try {
                widgetWindow.destroy();
            } catch (destroyError) {
                api.log.warn(LOG_PREFIX + ' 销毁加载失败的悬浮窗时出错', destroyError);
            }
        });

        return widgetWindow;
    };

    // ---- 宿主窗口跟踪 ----------------------------------------------------
    // 悬浮窗是独立窗口：宿主窗口全关掉后如果它还在，electron 的 window-all-closed 就不会触发，
    // 应用退不出、Windows 壁纸模式也不会重建。所以跟踪宿主窗口，最后一个关掉时把悬浮窗一起关掉；
    // 反过来宿主出现新窗口而悬浮窗已被关掉时，把它重新创建出来。

    /** 把一个宿主窗口记进集合（悬浮窗自己不算），关闭时移出并检查要不要收掉悬浮窗。 */
    const trackHostWindow = (hostWindow) => {
        if (!hostWindow || hostWindow === state.win) return;
        if (state.hostWindows.has(hostWindow)) return;
        state.hostWindows.add(hostWindow);
        state.recreateAttempts = 0;
        hostWindow.once('closed', () => {
            state.hostWindows.delete(hostWindow);
            scheduleHostEmptyCheck();
        });
    };

    const collectHostWindows = () => {
        let allWindows = [];
        try {
            allWindows = BrowserWindow.getAllWindows();
        } catch (error) {
            api.log.warn(LOG_PREFIX + ' 读取宿主窗口列表失败', error);
            return;
        }
        for (const hostWindow of allWindows) trackHostWindow(hostWindow);
    };

    /**
     * 宿主可能正在换主窗口（壁纸模式先销毁再新建），等一小会儿仍然为空才收掉悬浮窗。
     * macOS 也照此收窗：宿主 app.on('activate') 只在 getAllWindows().length === 0 时重建主窗口，
     * 留着悬浮窗会让点 Dock 无法恢复主窗口（focusMainWindow 对已销毁的主窗口直接 return）。
     * 宿主重新出现窗口时由 browser-window-created 重建悬浮窗，所以只多一次短暂消失。
     */
    const scheduleHostEmptyCheck = () => {
        if (state.disposed) return;
        if (state.hostCloseTimer) clearTimeout(state.hostCloseTimer);
        state.hostCloseTimer = setTimeout(() => {
            state.hostCloseTimer = null;
            if (state.disposed || state.hostWindows.size > 0) return;
            closeWidgetWindow();
        }, HOST_EMPTY_GRACE_MS);
    };

    /**
     * 悬浮窗的收尾：清掉按钮矩形（否则重建后的新窗口会拿旧坐标做命中）、把还没落盘的位置 /
     * 固定状态立刻写上、把 state.win 置空。幂等：同一次关闭可能被多条路径调用
     * （normal close / 页面加载失败 / 用户手动关窗），重复调用不会再落一次盘。
     */
    const cleanedWindows = new WeakSet();
    const cleanupWidgetWindow = (widgetWindow) => {
        if (cleanedWindows.has(widgetWindow)) return;
        cleanedWindows.add(widgetWindow);
        if (state.win === widgetWindow) state.win = null;
        state.pinRect = null;
        if (state.persistTimer) {
            clearTimeout(state.persistTimer);
            state.persistTimer = null;
        }
        savePersistedState();
    };

    const closeWidgetWindow = () => {
        const widgetWindow = state.win;
        if (!widgetWindow) return;
        // 先按「正常关闭」同一套清理，再真的关：这样 state.win / pinRect / 位置落盘都不依赖 closed 事件。
        cleanupWidgetWindow(widgetWindow);
        if (widgetWindow.isDestroyed()) return;
        try {
            widgetWindow.close();
        } catch (error) {
            api.log.warn(LOG_PREFIX + ' 关闭悬浮窗失败', error);
        }
    };

    /** 悬浮窗被用户关掉、或宿主换过窗口之后，需要时把它重新创建出来。 */
    const ensureWidgetWindow = () => {
        if (state.disposed || state.win) return;
        // 1.4.0：被 × 隐藏着的时候不重建 —— 隐藏是「不显示」，不是「不存在」；
        // 否则下一条快照到达就会把用户刚关掉的窗口又拉回来。
        if (!state.widgetOpen) return;
        if (state.hostWindows.size === 0) return;
        if (state.recreateAttempts >= MAX_WIDGET_RECREATES) {
            if (!state.warnedRecreateLimit) {
                state.warnedRecreateLimit = true;
                api.log.warn(LOG_PREFIX + ' 悬浮窗重新创建次数已达上限，停用再启用模组可恢复');
            }
            return;
        }
        try {
            state.win = createWidgetWindow();
        } catch (error) {
            state.recreateAttempts += 1;
            api.log.error(LOG_PREFIX + ' 重新创建悬浮窗失败', error);
        }
    };

    /** 宿主新建窗口（macOS 点 Dock 重开主窗口、壁纸模式重建等）：恢复跟踪，必要时找回悬浮窗。 */
    const onBrowserWindowCreated = (event, hostWindow) => {
        if (state.disposed || state.creatingWidget) return;
        trackHostWindow(hostWindow);
        if (state.hostCloseTimer) {
            clearTimeout(state.hostCloseTimer);
            state.hostCloseTimer = null;
        }
        ensureWidgetWindow();
    };

    // 先把 RPC 处理函数登记好：client.mjs 随时可能开始发快照。
    api.rpc.handle(RPC_UPDATE, (payload) => {
        // ---- 排查日志（真机 IPC 链路定位用，定位完删掉） ----
        api.log.info(LOG_PREFIX + ' 收到 update-data', JSON.stringify({
            state: payload && payload.state,
            line: payload && payload.line && payload.line.text,
            title: payload && payload.song && payload.song.title,
            session: payload && payload.playSessionId,
            hasWindow: !!state.win && !state.win.isDestroyed(),
        }));
        if (!payload || typeof payload !== 'object') {
            api.log.warn(LOG_PREFIX + ' update-data 收到非对象载荷，已忽略', describeForLog(payload));
            return;
        }
        // 迟到帧在进 state 之前就丢掉：lastPayload 只记真正更新的那一帧，页面重载补发也不会补到旧句。
        if (isStaleFrame(frameGate, payload)) {
            api.log.info(LOG_PREFIX + ' 丢弃迟到的旧帧', JSON.stringify({
                session: payload.playSessionId,
                position: payload.position,
                lineIndex: payload.line && payload.line.index,
                text: payload.line && payload.line.text,
            }));
            return;
        }
        state.lastPayload = payload;
        if (LOOP_MODES.includes(payload.loopMode)) {
            state.lastLoopMode = payload.loopMode;
        }
        // 用户手动关掉悬浮窗后，下一条数据到达时把它找回来（宿主还有窗口时才建）。
        ensureWidgetWindow();
        sendPayloadToWindow(payload);
    });

    // ---- 排查日志（真机 IPC 链路定位用，定位完连这两个监听一起删） ----
    const onActionFromWindowDebug = (event, raw) => {
        api.log.info(LOG_PREFIX + ' 收到悬浮窗指令', JSON.stringify({
            raw,
            fromWidget: !!state.win && event.sender === state.win.webContents,
        }));
        onActionFromWindow(event, raw);
    };
    const onDebugFromWindow = (event, message) => {
        api.log.info(LOG_PREFIX + ' [page] ' + String(message));
    };
    // 页面点图钉 / 解锁时把状态记下来，下次启动恢复（只认悬浮窗自己发来的消息）。
    const onPinnedFromWindow = (event, value) => {
        if (!state.win || event.sender !== state.win.webContents) return;
        // 固定状态决定整窗是否忽略鼠标，改了要立刻重算一次，别等下一次轮询（最多 80ms）。
        state.pinned = value === true;
        if (state.hoverTick) state.hoverTick();
        if (!state.persisted) return;
        state.persisted.pinned = state.pinned;
        savePersistedState();
    };
    // 页面把解锁按钮矩形报上来（固定态下整窗唯一可点的区域），存起来给命中判定用。
    const onPinRectFromWindow = (event, raw) => {
        if (!state.win || event.sender !== state.win.webContents) return;
        // 收到畸形矩形时按「没有矩形」处理（fail-open）：捏着旧坐标不放可能让命中区落在错的位置。
        const forget = () => {
            if (state.pinRect) {
                state.pinRect = null;
                if (state.hoverTick) state.hoverTick();
            }
        };
        if (!raw || typeof raw !== 'object') {
            forget();
            return;
        }
        const x = Number(raw.x);
        const y = Number(raw.y);
        const width = Number(raw.width);
        const height = Number(raw.height);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            forget();
            return;
        }
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
            forget();
            return;
        }
        state.pinRect = { x, y, width, height };
        if (state.hoverTick) state.hoverTick();
    };
    // 页面切换排版时记下模式，下次启动恢复。
    const onLayoutFromWindow = (event, value) => {
        if (!state.persisted) return;
        if (!state.win || event.sender !== state.win.webContents) return;
        if (!LAYOUT_MODE_IDS.includes(value)) return;
        state.persisted.layout = value;
        savePersistedState();
    };

    /**
     * 形态切换的落点（1.7.0 的「桌面歌词 / 悬浮窗歌词」从这里接）。
     * 调用方是 client.mjs 的 `folium.rpc.call(RPC_SURFACE, 'desktop' | 'window')`；
     * 1.3.0 只有桌面歌词：请求 'window' 时状态不动，返回 { ok: false, code: 'unsupported' }。
     * 1.7.0 在这里加：切 window 时隐藏桌面窗口并打开悬浮窗视图，切回 desktop 反过来，
     * 两边都要重新上报可见性并落盘，然后返回 { ok: true, surface }。
     */
    const applySurface = (next) => {
        if (!SURFACE_IDS.includes(next)) return { ok: false, code: SURFACE_INVALID, surface: state.surface };
        if (next === state.surface) return { ok: false, code: SURFACE_UNCHANGED, surface: state.surface };
        if (next === 'window') {
            api.log.info(LOG_PREFIX + ' 请求切到悬浮窗歌词：1.3.0 只有桌面歌词，已忽略');
            return { ok: false, code: SURFACE_UNSUPPORTED, surface: state.surface };
        }
        state.surface = next;
        if (state.win && !state.win.isDestroyed()) {
            state.win.webContents.send(IPC_SURFACE, next);
        }
        return { ok: true, surface: state.surface };
    };
    // 形态切换的 RPC 入口：1.7.0 的窗口按钮 / 设置项 / 命令面板都经 client.mjs 调到这里。
    api.rpc.handle(RPC_SURFACE, (next) => applySurface(next));

    // 1.4.0：播放条「词」按钮。client 每点一次问一次显隐，主进程按当前状态取反，
    // 返回切换后的真值让按钮对齐（不信任 client 的本地翻转，避免两边跑偏）。
    api.rpc.handle(RPC_TOGGLE_WIDGET, () => ({ visible: setWidgetOpen(!state.widgetOpen) }));
    // 首帧对齐：client 激活时问一次。因为 widget-visibility 是 fire-and-forget，
    // main 先发、client 后监听的那一帧会丢，只靠推送按钮高亮会错。
    api.rpc.handle(RPC_WIDGET_STATE, () => ({ visible: state.widgetOpen }));
    // 1.5.0：配置真源在宿主的模组设置里，client 每次变化后整份推过来。
    // 这里只做校验与生效：改窗口高度、把整份配置转给页面；没变化就不动，免得每帧都重设尺寸。
    api.rpc.handle(RPC_CONFIG, (raw) => {
        const next = normalizeConfig(raw);
        // 启动占位高度（prepareConfig）只影响建窗那一刻，真配置一到就丢掉，之后一律按字号算。
        next.window = {};
        if (JSON.stringify(next) === JSON.stringify(state.config)) return { changed: false };
        state.config = next;
        applyWindowSize();
        sendConfigToWindow();
        api.log.info(LOG_PREFIX + ' 配置已更新', JSON.stringify(next.shared));
        return { changed: true, height: windowHeightFor(next) };
    });
    // 1.5.0：命令面板的「锁定 / 解锁」。和页面上那个固定键走同一套状态，命令回来的结果自带新值。
    api.rpc.handle(RPC_TOGGLE_PIN, () => {
        state.pinned = !state.pinned;
        if (state.hoverTick) state.hoverTick();
        if (state.persisted) {
            state.persisted.pinned = state.pinned;
            savePersistedState();
        }
        if (state.win && !state.win.isDestroyed()) {
            state.win.webContents.send(IPC_PINNED, state.pinned);
        }
        return { pinned: state.pinned };
    });

    ipcMain.on(IPC_ACTION, onActionFromWindowDebug);
    ipcMain.on(IPC_DEBUG, onDebugFromWindow);
    ipcMain.on(IPC_PINNED, onPinnedFromWindow);
    ipcMain.on(IPC_PIN_RECT, onPinRectFromWindow);
    ipcMain.on(IPC_LAYOUT, onLayoutFromWindow);
    ipcMain.on(IPC_CLOSE, onCloseFromWindow);
    ipcMain.on(IPC_SHOWN, onShownFromWindow);
    ipcMain.on(IPC_IGNORE_HINT, onIgnoreHintFromWindow);
    app.on('browser-window-created', onBrowserWindowCreated);

    const dispose = () => {
        if (state.disposed) return;
        state.disposed = true;
        if (state.hostCloseTimer) {
            clearTimeout(state.hostCloseTimer);
            state.hostCloseTimer = null;
        }
        if (state.persistTimer) {
            clearTimeout(state.persistTimer);
            state.persistTimer = null;
        }
        // 1.5.1：停用时不留下「等握手」的计时器，否则 300ms 后会去 show 一个已销毁的窗口。
        cancelShownWait();
        // 停用模组时窗口可能还活着：把当前位置落盘再关。
        if (state.win && !state.win.isDestroyed()) rememberWindowPosition(state.win);
        savePersistedState();
        app.removeListener('browser-window-created', onBrowserWindowCreated);
        try {
            ipcMain.removeListener(IPC_ACTION, onActionFromWindowDebug);
            ipcMain.removeListener(IPC_DEBUG, onDebugFromWindow);
            ipcMain.removeListener(IPC_PINNED, onPinnedFromWindow);
            ipcMain.removeListener(IPC_PIN_RECT, onPinRectFromWindow);
            ipcMain.removeListener(IPC_LAYOUT, onLayoutFromWindow);
            ipcMain.removeListener(IPC_CLOSE, onCloseFromWindow);
            ipcMain.removeListener(IPC_SHOWN, onShownFromWindow);
            ipcMain.removeListener(IPC_IGNORE_HINT, onIgnoreHintFromWindow);
        } catch (error) {
            api.log.warn(LOG_PREFIX + ' 移除窗口指令监听失败', error);
        }
        closeWidgetWindow();
    };

    // 先登记清理，再建窗口。注意：activate 同步抛错时宿主不会调用 disposer（只把模组置为
    // error），所以下面 catch 里要手动 dispose 一次，把已登记的监听收干净再抛。
    api.onDispose(dispose);

    try {
        state.win = createWidgetWindow();
        // 悬浮窗之外、此刻已存在的窗口都算宿主窗口（宿主主窗口在模组启动前就已建好）。
        collectHostWindows();
        // 首帧无条件推一次显隐真值：client 可能已经挂载完毕在等状态，也可能稍后用 widget-state 拉。
        reportWidgetVisibility(true);
        // 1.5.1：入口（重新）建起来就要配置。这条覆盖「主进程重载、client 没重跑」和
        // 「页面比 client 先加载完所以那次要早了」两种情况；client 侧做了合并，重复要不会抖动。
        requestConfigFromClient();
    } catch (error) {
        dispose();
        api.log.error(LOG_PREFIX + ' 创建悬浮窗失败，模组已停止', error);
        throw error;
    }
};
