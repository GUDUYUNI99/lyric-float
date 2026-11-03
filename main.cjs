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
 *
 * payload 字段见 client.mjs 文件头（playSessionId / song / state / position / duration / liked /
 * canLike / volume / muted / loopMode / line / theme）；窗口只用到 song、state、volume、loopMode、line。
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
 */
'use strict';

const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('fs');
const path = require('path');

const LOG_PREFIX = '[lyric-widget]';

// 和 client.mjs 约定的 RPC 名字（那边是 RPC_UPDATE / RPC_ACTION）。
const RPC_UPDATE = 'update-data';
const RPC_ACTION = 'action';

// 窗口页面的 IPC 通道。带上模组 id 前缀：ipcMain 的通道是全应用共用的，
// 别的模组若也叫 'action-to-client' 就会收到本窗口的消息。
const IPC_ACTION = 'my-lyric-widget:action-to-client';
const IPC_DATA = 'my-lyric-widget:data-from-client';
// 排查用的页面→主进程调试通道（真机定位完连监听一起删掉）。
const IPC_DEBUG = 'my-lyric-widget:debug';
// 主进程→页面的悬停状态（true/false）。整窗是拖拽区时渲染进程收不到鼠标事件，
// 所以「鼠标是否停在窗口上」由主进程轮询光标位置后从这条通道推给页面。
const IPC_HOVER = 'my-lyric-widget:hover';
// 悬停检测的轮询间隔：40~120ms 都够用；80ms 既跟得上手速，又几乎不占 CPU。
const HOVER_POLL_MS = 80;
// 固定/解锁状态（页面→主进程：用户点了图钉；主进程→页面：启动时恢复上次的固定状态）。
const IPC_PINNED = 'my-lyric-widget:pinned';
// 排版模式（页面→主进程：用户切了排版；主进程→页面：启动时恢复上次的排版）。
const IPC_LAYOUT = 'my-lyric-widget:layout';
// 排版三态（主进程侧只用来校验从页面收到的值，别让坏值写进状态文件）。
const LAYOUT_MODE_IDS = ['text', 'text-trans', 'full'];
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
    // 固定 / 解锁按钮：pin 表示「未固定，可点亮固定」，pin-off 表示「已固定，点亮解锁」。
    pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
    'pin-off': '<path d="M12 17v5"/><path d="M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89"/><path d="m2 2 20 20"/><path d="M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11"/>',
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
};

// ---- 排查日志（真机 IPC 链路定位用，定位完删掉） ----
// 模块级：main.cjs 被 require 就会打印，用来确认模组主进程入口真的被宿主加载了。
console.log(`${LOG_PREFIX} main 模块已求值（main.cjs 被 require）`, {
    electron: process.versions.electron,
    node: process.versions.node,
});

// 三种排版（原文 / 原文+译文 / 原文+译文+罗马音）叠起来比原来的两行高，窗口相应加高加宽。
const WINDOW_WIDTH = 640;
const WINDOW_HEIGHT = 236;
// 默认停在工作区底部中间，离底边和左右边这么多像素。
const WINDOW_MARGIN = 48;

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
 * 窗口页面。600x200 内分三行：歌曲信息、歌词原文 + 翻译/罗马音、底部控制条。
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
     * 窗口默认完全透明：只留歌词文字。鼠标悬停（body.hover）才淡入半透明黑底和底部控制条。
     * 固定（body.pinned）状态下悬停只给极弱高亮，控制条不出现，只露右上角的解锁按钮。
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
        border-radius: 16px;
        overflow: hidden;
        transition: background-color 0.22s ease, border-color 0.22s ease;
    }
    body.hover:not(.pinned) .widget {
        background: rgba(0, 0, 0, 0.58);
        border-color: rgba(255, 255, 255, 0.08);
    }
    body.hover.pinned .widget {
        background: rgba(0, 0, 0, 0.14);
        border-color: rgba(255, 255, 255, 0.05);
    }
    /* 固定模式下整窗不可拖动；未固定时 body 是 drag 区，按钮/滑块/解锁按钮单独 no-drag。 */
    body.pinned {
        -webkit-app-region: no-drag;
    }
    .song {
        flex: none;
        min-height: 14px;
        font-size: 11px;
        color: rgba(255, 255, 255, 0.45);
        text-align: center;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        /* 歌曲行属于「悬停才出现」的界面元素，和底栏一起淡入淡出。 */
        opacity: 0;
        transition: opacity 0.18s ease;
    }
    body.hover:not(.pinned) .song {
        opacity: 1;
    }
    .lyric {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 4px;
        min-height: 0;
        padding: 2px 0;
    }
    .lyric-text {
        max-width: 100%;
        font-size: 38px;
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
        font-size: 27px;
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
    /* 罗马音行：只在「原文 + 译文 + 罗马音」排版出现，字号与译文一致。 */
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
    .controls {
        -webkit-app-region: no-drag;
        flex: none;
        display: flex;
        align-items: center;
        gap: 8px;
        padding-top: 8px;
        border-top: 1px solid rgba(255, 255, 255, 0.08);
        /* 默认藏起来（但仍然占位，避免歌词在淡入淡出时上下跳）。 */
        opacity: 0;
        pointer-events: none;
        transform: translateY(6px);
        transition: opacity 0.18s ease, transform 0.18s ease;
    }
    body.hover:not(.pinned) .controls {
        opacity: 1;
        pointer-events: auto;
        transform: none;
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
     * 所以去掉 title，用 data-tip + 伪元素自绘一个，固定出现在图标的右上方。
     */
    button::after {
        content: attr(data-tip);
        position: absolute;
        left: 50%;
        bottom: calc(100% + 8px);
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
     *   text-trans  ：只亮「文」（译文），「A」保持默认色
     *   full        ：亮「文」+「A」（译文 + 罗马音）
     * 亮起来的颜色和循环/固定按钮一致，都是 #7dd3fc。
     */
    #layout .icon-zh,
    #layout .icon-a {
        transition: color 0.18s ease;
    }
    #layout[data-mode="text-trans"] .icon-zh {
        color: #7dd3fc;
    }
    #layout[data-mode="full"] .icon-zh,
    #layout[data-mode="full"] .icon-a {
        color: #7dd3fc;
    }
    /* 固定按钮点亮时用和循环/排版一致的蓝色。 */
    #pin[data-mode="pinned"] {
        color: #7dd3fc;
    }
    /*
     * 解锁按钮：固定模式下出现在窗口右上角。固定后底栏整体藏起来，
     * 所以这是唯一能把窗口解锁回「可拖拽 + 完整控制栏」的入口。
     */
    .unlock {
        position: absolute;
        top: 10px;
        right: 12px;
        -webkit-app-region: no-drag;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.18s ease;
    }
    body.pinned.hover .unlock {
        opacity: 1;
        pointer-events: auto;
    }
    /* 解锁按钮在窗口最上沿，提示气泡改为向下弹，否则会被窗口上边缘裁掉。 */
    .unlock::after {
        top: calc(100% + 8px);
        bottom: auto;
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
        min-width: 60px;
        height: 4px;
        margin: 0 2px;
        accent-color: #7dd3fc;
        cursor: pointer;
    }
    .volume-value {
        flex: none;
        width: 34px;
        font-size: 11px;
        color: rgba(255, 255, 255, 0.55);
        text-align: right;
    }
</style>
</head>
<body>
<div class="widget">
    <div class="song" id="song">${WAITING_TEXT}</div>
    <div class="lyric" id="lyric" data-layout="text">
        <div class="lyric-text" id="line" aria-live="polite">${WAITING_TEXT}</div>
        <div class="lyric-trans" id="trans" hidden></div>
        <div class="lyric-sub" id="sub"></div>
    </div>
    <div class="controls">
        <button id="prev" type="button" data-tip="上一首" aria-label="上一首">${ICON_SVG.prev}</button>
        <button id="toggle" type="button" data-tip="播放" aria-label="播放">${ICON_SVG.play}</button>
        <button id="next" type="button" data-tip="下一首" aria-label="下一首">${ICON_SVG.next}</button>
        <button id="loop" type="button" data-tip="循环模式：不循环" aria-label="循环模式：不循环" data-mode="off">${ICON_SVG['loop-off']}</button>
        <button id="layout" type="button" data-tip="排版：只显示原文" aria-label="排版" data-mode="text">${ICON_SVG.layout}</button>
        <span class="volume-icon" id="volume-icon" aria-hidden="true">${ICON_SVG['volume-2']}</span>
        <input id="volume" class="volume" type="range" min="0" max="100" step="1" value="100" title="音量" aria-label="音量">
        <span class="volume-value" id="volume-value">100%</span>
        <button id="pin" type="button" data-tip="固定位置" aria-label="固定位置" data-mode="floating">${ICON_SVG.pin}</button>
    </div>
    <button id="unlock" class="unlock" type="button" data-tip="解锁（恢复拖拽）" aria-label="解锁">${ICON_SVG['pin-off']}</button>
</div>
<script>
const { ipcRenderer } = require('electron');

// ---- 排查日志：页面里的打印只有它自己的 DevTools 看得见，这里统一转发到主进程日志面板（定位完连监听一起删）。
const debugToMain = (message) => ipcRenderer.send('${IPC_DEBUG}', message);
debugToMain('page boot');
window.addEventListener('error', (event) =>
    debugToMain('page error: ' + event.message + ' @' + event.lineno + ':' + event.colno));

const els = {
    song: document.getElementById('song'),
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
    unlock: document.getElementById('unlock'),
    volume: document.getElementById('volume'),
    volumeIcon: document.getElementById('volume-icon'),
    volumeValue: document.getElementById('volume-value'),
};

// 图标整段字符串由主进程生成后塞进来（形状见 main.cjs 的 ICON_PATHS）。
const ICONS = ${JSON.stringify(ICON_SVG)};
// 只在图标真的换了才写 innerHTML，避免每帧重排。
const setIcon = (el, name) => {
    if (!el || !ICONS[name] || el.dataset.icon === name) return;
    el.dataset.icon = name;
    el.innerHTML = ICONS[name];
};

// 中文提示写到 data-tip（自绘气泡，固定在图标的右上方）+ aria-label（读屏可念）。
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

// 排版三态：text 只有原文 / text-trans 原文 + 译文 / full 原文 + 译文 + 罗马音。
const LAYOUT_MODES = ['text', 'text-trans', 'full'];
const LAYOUT_TIPS = {
    text: '排版：只显示原文',
    'text-trans': '排版：原文 + 译文',
    full: '排版：原文 + 译文 + 罗马音',
};
let layoutMode = 'text';
let lastPayload = null;

/** 排版按钮的三态高亮、提示，以及 lyric 容器上的 data-layout，都跟着当前模式走。 */
const applyLayoutButton = () => {
    if (els.lyric) els.lyric.dataset.layout = layoutMode;
    if (els.layout) {
        els.layout.dataset.mode = layoutMode;
        setButtonLabel(els.layout, LAYOUT_TIPS[layoutMode]);
    }
};

const render = (payload) => {
    if (!payload || typeof payload !== 'object') return;
    lastPayload = payload;

    const line = payload.line || {};
    debugToMain(
        'render: state=' + payload.state +
        ' line="' + (line.text || '') + '"' +
        ' title="' + ((payload.song && payload.song.title) || '') + '"',
    );
    // 空字符串是合法的行文本（只有翻译、没有原文的行），不要退回「等待播放...」。
    els.line.textContent = typeof line.text === 'string' ? line.text : WAITING_TEXT;

    // 三种排版：只原文 / 原文 + 译文 / 原文 + 译文 + 罗马音。
    const translation = typeof line.translation === 'string' ? line.translation : '';
    const romanization = typeof line.romanization === 'string' ? line.romanization : '';
    const showTrans = layoutMode === 'text-trans' || layoutMode === 'full';
    const showRoman = layoutMode === 'full';
    els.trans.textContent = showTrans ? translation : '';
    els.trans.hidden = !(showTrans && translation !== '');
    els.sub.textContent = showRoman ? romanization : '';

    if (payload.song) {
        const title = typeof payload.song.title === 'string' ? payload.song.title : '';
        const artist = typeof payload.song.artist === 'string' ? payload.song.artist : '';
        // 标题或歌手缺失时不要留下孤零零的「 — 」。
        els.song.textContent = title && artist ? title + ' — ' + artist : title || artist || WAITING_TEXT;
    } else {
        els.song.textContent = WAITING_TEXT;
    }

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
// 主进程在页面加载完后推来上次的排版选择（值不合法就保持默认的 text）。
ipcRenderer.on('${IPC_LAYOUT}', (event, value) => {
    if (!LAYOUT_MODES.includes(value)) return;
    layoutMode = value;
    applyLayoutButton();
    if (lastPayload) render(lastPayload);
});
applyLayoutButton();

// ---- 悬停显示 / 固定位置 ----
// 未固定：整窗可拖拽（body 是 drag 区），鼠标离开后只剩透明歌词，悬停时浮出半透明底 + 完整控制栏。
// 已固定：整窗 no-drag，悬停也不再出控制栏，只在右上角给一个解锁按钮。
// 固定状态由主进程记在 userData 的小 JSON 里，启动时通过 IPC_PINNED 推回来。
let isPinned = false;
const applyPinState = () => {
    document.body.classList.toggle('pinned', isPinned);
    if (els.pin) {
        els.pin.dataset.mode = isPinned ? 'pinned' : 'floating';
        setIcon(els.pin, isPinned ? 'pin-off' : 'pin');
        setButtonLabel(els.pin, isPinned ? '取消固定' : '固定位置');
    }
};
const reportPinState = () => {
    ipcRenderer.send('${IPC_PINNED}', isPinned);
};
ipcRenderer.on('${IPC_PINNED}', (event, value) => {
    isPinned = value === true;
    applyPinState();
});
if (els.pin) {
    els.pin.addEventListener('click', () => {
        isPinned = true;
        applyPinState();
        reportPinState();
    });
}
if (els.unlock) {
    els.unlock.addEventListener('click', () => {
        isPinned = false;
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
window.addEventListener('blur', () => setHovered(false));

els.volume.addEventListener('pointerdown', () => {
    volumeDragging = true;
});
els.volume.addEventListener('input', () => {
    volumeDragging = true;
    els.volumeValue.textContent = els.volume.value + '%';
    setIcon(els.volumeIcon, volumeIconName(Number(els.volume.value)));
    scheduleVolume();
});
els.volume.addEventListener('change', () => {
    volumeDragging = false;
    sendVolume();
});
// 拖动被打断（指针取消、窗口失焦、指针捕获丢失）时也要收尾，否则滑块会一直不再跟随主进程。
const stopVolumeDragging = () => {
    if (!volumeDragging) return;
    volumeDragging = false;
    sendVolume();
};
window.addEventListener('pointerup', stopVolumeDragging);
window.addEventListener('pointercancel', stopVolumeDragging);
window.addEventListener('blur', stopVolumeDragging);
els.volume.addEventListener('lostpointercapture', stopVolumeDragging);

ipcRenderer.on('${IPC_DATA}', (event, payload) => render(payload));
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
    };

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

    /** 保存的位置还算不算「看得见」：至少要有一部分落在某个显示器的工作区里。 */
    const isPositionUsable = (position) => {
        try {
            return screen.getAllDisplays().some(({ workArea }) => (
                position.x + WINDOW_WIDTH > workArea.x + 40
                && position.x < workArea.x + workArea.width - 40
                && position.y + WINDOW_HEIGHT > workArea.y + 20
                && position.y < workArea.y + workArea.height - 20
            ));
        } catch (error) {
            return false;
        }
    };

    state.persisted = readPersistedState();
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

    /** 把最新快照交给窗口页面（窗口不在 / 已销毁时丢弃）。 */
    const sendPayloadToWindow = (payload) => {
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
            const y = Math.round(workArea.y + workArea.height - WINDOW_HEIGHT - WINDOW_MARGIN);
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
        let timer = null;
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
            let hover = false;
            try {
                const point = screen.getCursorScreenPoint();
                const bounds = widgetWindow.getBounds();
                hover = widgetWindow.isVisible()
                    && point.x >= bounds.x && point.x < bounds.x + bounds.width
                    && point.y >= bounds.y && point.y < bounds.y + bounds.height;
            } catch (error) {
                stop();
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
        widgetWindow.on('closed', stop);
        return stop;
    };

    /** 创建悬浮窗；页面用 data URL 加载，不依赖任何外部文件。 */
    const createWidgetWindow = () => {
        // 构造期间会同步触发 app 的 'browser-window-created'，用这个标记把悬浮窗自己排除掉；
        // 构造抛错时也要复位，否则之后宿主的窗口事件会被一直忽略。
        state.creatingWidget = true;
        let widgetWindow;
        try {
            widgetWindow = new BrowserWindow({
                width: WINDOW_WIDTH,
                height: WINDOW_HEIGHT,
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
            if (!widgetWindow.isDestroyed()) widgetWindow.showInactive();
        });

        // 用 on 而不是 once：页面崩溃后 reload 也会重新走到这里，重新补快照。
        widgetWindow.webContents.on('did-finish-load', () => {
            api.log.info(LOG_PREFIX + ' 悬浮窗页面 did-finish-load', JSON.stringify({
                hasLastPayload: !!state.lastPayload,
            }));
            if (state.lastPayload) sendPayloadToWindow(state.lastPayload);
            sendActionToClient({ action: 'request-sync' });
            // 恢复上次的固定状态。放在页面加载完之后推，页面收到才切 body.pinned（改拖拽区）。
            widgetWindow.webContents.send(IPC_PINNED, !!(state.persisted && state.persisted.pinned));
            // 恢复上次的排版选择（不存在或不合法时页面保持默认的 text）。
            if (state.persisted && LAYOUT_MODE_IDS.includes(state.persisted.layout)) {
                widgetWindow.webContents.send(IPC_LAYOUT, state.persisted.layout);
            }
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
            if (state.win === widgetWindow) state.win = null;
            // 关窗时把还没落盘的位置/固定状态立刻写上，避免丢最后一次拖动。
            if (state.persistTimer) {
                clearTimeout(state.persistTimer);
                state.persistTimer = null;
            }
            savePersistedState();
            if (!state.disposed) {
                api.log.warn(LOG_PREFIX + ' 悬浮窗被关闭；收到下一份数据或宿主出现新窗口时会重新创建');
            }
        });

        const url = 'data:text/html;charset=utf-8,' + encodeURIComponent(WIDGET_HTML);
        widgetWindow.loadURL(url).catch((error) => {
            api.log.error(LOG_PREFIX + ' 悬浮窗页面加载失败，销毁窗口以便下一条数据到达时重建', error);
            if (state.disposed || widgetWindow.isDestroyed()) return;
            if (state.win === widgetWindow) state.win = null;
            try {
                widgetWindow.removeAllListeners('closed');
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

    const closeWidgetWindow = () => {
        const widgetWindow = state.win;
        if (!widgetWindow) return;
        state.win = null;
        if (widgetWindow.isDestroyed()) return;
        try {
            widgetWindow.removeAllListeners('closed');
            widgetWindow.close();
        } catch (error) {
            api.log.warn(LOG_PREFIX + ' 关闭悬浮窗失败', error);
        }
    };

    /** 悬浮窗被用户关掉、或宿主换过窗口之后，需要时把它重新创建出来。 */
    const ensureWidgetWindow = () => {
        if (state.disposed || state.win) return;
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
        if (!state.persisted) return;
        if (!state.win || event.sender !== state.win.webContents) return;
        state.persisted.pinned = value === true;
        savePersistedState();
    };
    // 页面切换排版时记下模式，下次启动恢复。
    const onLayoutFromWindow = (event, value) => {
        if (!state.persisted) return;
        if (!state.win || event.sender !== state.win.webContents) return;
        if (!LAYOUT_MODE_IDS.includes(value)) return;
        state.persisted.layout = value;
        savePersistedState();
    };

    ipcMain.on(IPC_ACTION, onActionFromWindowDebug);
    ipcMain.on(IPC_DEBUG, onDebugFromWindow);
    ipcMain.on(IPC_PINNED, onPinnedFromWindow);
    ipcMain.on(IPC_LAYOUT, onLayoutFromWindow);
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
        // 停用模组时窗口可能还活着：把当前位置落盘再关。
        if (state.win && !state.win.isDestroyed()) rememberWindowPosition(state.win);
        savePersistedState();
        app.removeListener('browser-window-created', onBrowserWindowCreated);
        try {
            ipcMain.removeListener(IPC_ACTION, onActionFromWindowDebug);
            ipcMain.removeListener(IPC_DEBUG, onDebugFromWindow);
            ipcMain.removeListener(IPC_PINNED, onPinnedFromWindow);
            ipcMain.removeListener(IPC_LAYOUT, onLayoutFromWindow);
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
    } catch (error) {
        dispose();
        api.log.error(LOG_PREFIX + ' 创建悬浮窗失败，模组已停止', error);
        throw error;
    }
};
