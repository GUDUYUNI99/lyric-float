// 歌词浮岛 / Lyric Float —— 窗口页面的桥（preload）。
//
// 2.1.0 转「正式发布」的必改项之一：两个窗口都开 contextIsolation、关 nodeIntegration，
// 页面脚本不再 require('electron')，只能通过这里暴露的最小接口跟主进程说话。
//
// 暴露的东西只有两件：
//   window.lyricFloatBridge.send(channel, ...args)   页面 → 主进程（只允许 lyric-float: 前缀）
//   window.lyricFloatBridge.on(channel, handler)     主进程 → 页面（handler 收到 (event, ...args)）
//
// 页面里原来的写法是 `const { ipcRenderer } = require('electron')` + `ipcRenderer.send/on`，
// 这里刻意保持同名方法、同样的回调参数顺序，页面只需要换一行「从哪儿拿 ipcRenderer」。
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const CHANNEL_PREFIX = 'lyric-float:';

const assertChannel = (channel) => typeof channel === 'string' && channel.startsWith(CHANNEL_PREFIX);

const bridge = {
    send: (channel, ...args) => {
        if (!assertChannel(channel)) return;
        ipcRenderer.send(channel, ...args);
    },
    on: (channel, handler) => {
        if (!assertChannel(channel) || typeof handler !== 'function') return;
        // 页面里的回调签名一直是 (event, payload)；这里给一个只会带 senderId 的空壳事件，
        // 避免把 ipcRenderer 的 event 对象（含 sender）漏给页面。
        ipcRenderer.on(channel, (_event, ...args) => handler({ senderId: 0 }, ...args));
    },
};

contextBridge.exposeInMainWorld('lyricFloatBridge', bridge);
