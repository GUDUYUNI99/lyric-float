/**
 * my-lyric-widget 的渲染进程入口：独立常驻的数据搬运模块，不渲染任何界面。
 *
 * 1.0.0 起不再注册为「歌词样式（visualizer）」：只要模组启用，activate 就常驻运行，
 * 不依赖用户在设置里选中某个样式，也不依赖宿主的 mount 上下文。
 *
 * 数据流（与 main.cjs 的协议，0.3.2 起未变）：
 *   渲染进程 -> 主进程：每 100ms 轮询一次播放状态，内容有变化时通过
 *                        folium.rpc.call('update-data', payload) 发一份完整快照；
 *                        main.cjs 侧对应 api.rpc.handle('update-data', (payload) => ...)。
 *   主进程 -> 渲染进程：main.cjs 用 api.rpc.send('action', { action: 'next' }) 发控制指令；
 *                        这里在 folium.rpc.on('action', ...) 里转成 folium.playback 的调用。
 *
 * payload 形状（主进程按这份结构写接收逻辑，不要改字段名）：
 *   {
 *     playSessionId: string,   // 同一次播放内不变；换歌 / 从 stopped 重新开始时换新的
 *     song: { id, title, artist, album, source } | null,
 *     state: 'playing' | 'paused' | 'stopped',
 *     position: number,        // 秒；读取那一刻的值（不是持续推流，进度条要主进程自己推进）
 *     duration: number,        // 秒；未知时为 0
 *     liked: boolean,
 *     canLike: boolean,
 *     volume: number,          // 0–1
 *     muted: boolean,
 *     loopMode: 'off' | 'all' | 'one',
 *     line: {
 *       index,                 // 当前行下标；-1 表示没有当前行（句间保留上一句时同样是 -1）
 *       text,                  // 没有当前行时保留最近一句；连最近一句都没有时是「等待播放...」
 *       translation: string | null,
 *       romanization: string | null,
 *       words: null,           // 逐字 / 卡拉 OK 预留字段，当前恒为 null
 *       startTime: number | null,
 *       endTime: number | null,
 *     },
 *     theme: {                 // 宿主没有全局主题读取接口，只有 theme.changed 之后才有值，
 *       name, isDaylight, backgroundColor, primaryColor, accentColor, secondaryColor,
 *       fontStyle, fontStack,  // 否则为 null，由 main.cjs 用默认样式兜底
 *     } | null,
 *   }
 *
 * action 形状（main.cjs 用 api.rpc.send('action', ...) 发来）：
 *   { action: 'next' } | { action: 'prev' } | { action: 'toggle' }
 *   | { action: 'set-volume', volume: 0–1 }
 *   | { action: 'set-loop', mode: 'off' | 'all' | 'one' }
 *   | { action: 'request-sync' }   // 主进程窗口刚打开、错过之前的快照时，强制重发一次
 *
 * 同步策略（1.0.0：完全自主，不再有 mount 路径）：
 *   - folium.every(100ms) 轮询 + 播放/歌词/主题事件即时触发；
 *   - 行号用 folium.playback.getState().position 与 folium.lyrics.getLines() 的
 *     startTime / endTime 自行比对（findApproximateLineIndex）；
 *   - 宿主没有全局歌词时钟，所以用户手动调过的歌词偏移由这里自己补回来
 *     （见下方 readLyricOffsetSeconds 的说明）：手动把歌词延后 5 秒，悬浮窗也延后 5 秒；
 *   - 已知精度差异：预览片段（preview clip）从歌曲中间开始时，播放位置与歌词时钟之间
 *     还差一个片段起点，这一项宿主没有对外暴露，自主路径拿不到，整首播放则没有问题；
 *   - 宿主播放服务（folium.playback 等）由主窗口 App 挂载后才注册：activate 常常比它早，
 *     此时调用会抛 playback-unavailable-in-main-context。这不是故障，所以这里先探测 + 等待，
 *     任何宿主侧异常都在本模块内吞掉，不会被记成「client activate 出错 / 事件出错」。
 *
 * 约定：
 *   - 快照里不含 song.ref：ref 只在当前渲染会话有效，主进程存下来会失效；跨歌用 source + id。
 *   - 真正的悬浮窗由 main.cjs 在 activate 时创建，这里只负责搬数据。
 *   - 句间（index -1）用 folium.lyrics.getRecentCompletedLine 保留上一句；
 *     连上一句都没有（如歌曲还没开始）时才发「等待播放...」。
 *   - 导出窗口里没有播放页：只注册事件也不轮询，直接返回。
 */

const RPC_UPDATE = 'update-data';
const RPC_ACTION = 'action';
const ACTION_REQUEST_SYNC = 'request-sync';
const WAITING_LINE_TEXT = '等待播放...';
const LOOP_MODES = ['off', 'all', 'one'];

// 轮询周期：驱动「句内换行」这类没有事件的状态变化。100ms 足够让换句看起来是即时的，
// 同时靠内容去重把真正的 IPC 频率压到最低（同一行每秒只发一次）。
const POLL_MS = 100;

// ---- 用户歌词偏移（自主路径自己复算） ----
// 宿主主窗口把「已经算上用户偏移」的歌词时钟交给 mount 的 ctx.lyricTime，但没有对外暴露全局
// 歌词时钟；不挂载时只能自己补回来。键名与算法严格照抄宿主源码：
//   · 单曲手动偏移：localStorage 'lyric_timeline_offsets'，JSON map<歌 id, 毫秒>
//     （src/utils/lyrics/lyricOffsetMemory.ts）
//   · 设备级延迟补偿：localStorage 'global_lyric_timeline_offset_ms'，钳在 ±2000ms
//     （src/stores/useLyricSettingsStore.ts）
//   · 实际偏移 = 单曲 + 设备（src/App.tsx effectiveLyricTimelineOffsetMs）
//   · 歌词时钟 = 媒体位置 - 实际偏移 / 1000
//     （src/utils/lyrics/lyricSeekTime.ts 顶部注释：media time + clip start - manual offset）
// 所以手动把歌词延后 5 秒（偏移 +5000ms）时，这里用 position - 5 去找行，悬浮窗同样延后 5 秒。
const LYRIC_OFFSET_STORAGE_KEY = 'lyric_timeline_offsets';
const GLOBAL_LYRIC_OFFSET_STORAGE_KEY = 'global_lyric_timeline_offset_ms';
const GLOBAL_LYRIC_OFFSET_LIMIT_MS = 2000;

// localStorage 里的偏移表只在用户动手调整时才变；按原始字符串缓存，避免每 100ms 重新解析。
let offsetCacheRaw = null;
let offsetCacheMap = {};

const readPerSongOffsetMs = (songId) => {
    if (songId === null || songId === undefined || songId === '') return 0;
    let raw = null;
    try {
        raw = localStorage.getItem(LYRIC_OFFSET_STORAGE_KEY);
    } catch {
        return 0;
    }
    if (raw !== offsetCacheRaw) {
        offsetCacheRaw = raw;
        offsetCacheMap = {};
        if (raw) {
            try {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object') offsetCacheMap = parsed;
            } catch {
                // 存储损坏就当作没有偏移：读偏移绝不允许打断同步。
            }
        }
    }
    const value = offsetCacheMap[String(songId)];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
};

const readGlobalOffsetMs = () => {
    try {
        const value = Number(localStorage.getItem(GLOBAL_LYRIC_OFFSET_STORAGE_KEY));
        if (!Number.isFinite(value)) return 0;
        return Math.max(-GLOBAL_LYRIC_OFFSET_LIMIT_MS, Math.min(GLOBAL_LYRIC_OFFSET_LIMIT_MS, value));
    } catch {
        return 0;
    }
};

/** 自主路径要从播放位置里减掉的偏移（秒）：单曲手动偏移 + 设备级延迟补偿。 */
const readLyricOffsetSeconds = (song) => {
    if (!song) return 0;
    return (readPerSongOffsetMs(song.id) + readGlobalOffsetMs()) / 1000;
};

// ---- 排查日志开关（往「设置→开发者→运行日志」里打链路日志；定位完改成 false 即可静音，不用删代码） ----
const DEBUG = true;
const debugLog = (...args) => {
    if (DEBUG) console.log(...args);
};

// 模块级日志：只要 client.mjs 被 import 就会打印，用来区分「没加载」和「加载了但没 activate」。
debugLog('[lyric-widget] client 模块已求值（client.mjs 被 import）', {
    href: typeof location !== 'undefined' ? location.href.slice(0, 120) : '(无 location)',
});

const clampVolume = (volume) => Math.min(1, Math.max(0, volume));

/** 播放会话 id：同一次播放内不变，主进程可据此判断要不要重置自己的进度。 */
const createPlaySessionId = () =>
    'ps-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

/**
 * 播放会话状态：放在 activate 作用域里复用。
 * 从 stopped 重新开始 / 换歌都算新的播放会话，主进程据此重置进度条。
 */
const createPlaySession = () => ({
    id: createPlaySessionId(),
    songKey: null, // 上次观察到的歌；null 表示还没有基线（首次轮询）
    state: null, // 上次观察到的播放状态
    pendingSongStart: false, // 换歌刚换过 id，接下来那次 stopped -> playing 不再换
});

/** 跨歌标识：source + id；没有 id 时退回 title + artist（ref 不能跨渲染会话）。 */
const getSongKey = (song) => {
    if (!song) return '';
    if (song.id) return (song.source ?? '') + ':' + song.id;
    return 'title:' + song.title + '\n' + song.artist;
};

/** 歌曲信息；ref 不传给主进程（只在当前渲染会话有效）。 */
const readSong = (song) => {
    if (!song) return null;
    return {
        id: song.id,
        title: song.title,
        artist: song.artist,
        album: song.album,
        source: song.source,
    };
};

/**
 * 当前行下标：宿主没有全局歌词时钟，只能用播放位置比对歌词时间。
 * 返回最后一个 startTime <= time 的行下标；已经过了该行 endTime（句间）时返回 -1，
 * 交给 getRecentCompletedLine 保留上一句。歌词按时间递增，但这里不假设顺序，直接全表取最大下标。
 */
const findApproximateLineIndex = (lines, time) => {
    if (!Array.isArray(lines) || lines.length === 0) return -1;
    let index = -1;
    for (let i = 0; i < lines.length; i += 1) {
        const start = lines[i].startTime;
        if (typeof start === 'number' && Number.isFinite(start) && start <= time) index = i;
    }
    if (index < 0) return -1;
    const end = lines[index].endTime;
    if (typeof end === 'number' && Number.isFinite(end) && time >= end) return -1;
    return index;
};

/**
 * 当前歌词行；两句之间保留上一句，只有上一句也没有（如歌曲还没开始）时才给「等待播放...」。
 */
const readLine = (folium, lines, index, time) => {
    const safeLines = Array.isArray(lines) ? lines : [];
    // 句间 index 为 -1：让宿主找出最后一句已结束的歌词，避免主进程窗口每句间隙闪一次等待文案。
    const line = index >= 0
        ? safeLines[index]
        : folium.lyrics.getRecentCompletedLine(safeLines, index, time);
    if (!line) {
        // 没有当前行、也没有最近一句（第一句开始前 / 无歌词）时统一给等待文案；
        // 注意最后一句结束后 getRecentCompletedLine 仍返回最后一句，不会走到这里。
        return {
            index: -1,
            text: WAITING_LINE_TEXT,
            translation: null,
            romanization: null,
            words: null,
            startTime: null,
            endTime: null,
        };
    }
    return {
        index,
        text: line.fullText,
        translation: line.translation ?? null,
        romanization: line.romanization ?? null,
        // 逐字 / 卡拉 OK 预留位置：后续改为 line.words，现在是 null。
        words: null,
        startTime: line.startTime,
        endTime: line.endTime,
    };
};

/**
 * 主题色与字体；fontStack 由宿主解析好，主进程可以直接写进 CSS 的 font-family。
 * theme 为 null（还没收到 theme.changed）时返回 null，由主进程用默认样式兜底。
 */
const readTheme = (folium, theme) => {
    if (!theme) return null;
    return {
        name: theme.name,
        isDaylight: theme.isDaylight,
        backgroundColor: theme.backgroundColor,
        primaryColor: theme.primaryColor,
        accentColor: theme.accentColor,
        secondaryColor: theme.secondaryColor,
        fontStyle: theme.fontStyle,
        fontStack: folium.theme.resolveFontStack(theme),
    };
};

/** 整份快照：主进程每次都收到完整数据，不用自己合并局部更新。view 由 readView 给出。 */
const buildPayload = (folium, view, playSessionId) => {
    const playback = folium.playback.getState();
    const { volume, muted } = folium.playback.getVolume();
    return {
        playSessionId,
        song: readSong(playback.song),
        state: playback.state,
        position: playback.position,
        duration: playback.duration,
        liked: playback.liked,
        canLike: playback.canLike,
        volume,
        muted,
        loopMode: folium.playback.getLoopMode(),
        line: readLine(folium, view.lines, view.lineIndex, view.time),
        theme: readTheme(folium, view.theme),
    };
};

/** 根据当前播放状态决定 playSessionId 要不要换新；每次同步前都会走这里。 */
const refreshPlaySession = (folium, session) => {
    const playback = folium.playback.getState();
    const songKey = getSongKey(playback.song);

    if (session.songKey === null) {
        // 首次观察：只记基线，沿用 activate 里生成的那个 id。
    } else if (songKey !== session.songKey) {
        // 换歌算一次新的播放会话；如果换歌时本来就停着，随后的 playing 不再换第二次。
        session.id = createPlaySessionId();
        session.pendingSongStart = true;
    } else if (playback.state === 'playing' && session.state === 'stopped') {
        // 同一首歌从 stopped 重新开始（单曲循环重播不经过 stopped，不会走到这里）。
        if (session.pendingSongStart) {
            session.pendingSongStart = false;
        } else {
            session.id = createPlaySessionId();
        }
    }

    // 这次播放已经开始，pendingSongStart 只用于抵消换歌边界上的重复换 id。
    if (playback.state === 'playing') session.pendingSongStart = false;

    session.songKey = songKey;
    session.state = playback.state;
};

/** 主进程发来的控制指令；控制后的状态变化会由 playback.* 事件再发一次快照。 */
const handleAction = (folium, message) => {
    if (!message || typeof message !== 'object') {
        folium.log.warn('[lyric-widget] 收到无法识别的 action 载荷，已忽略', message);
        return;
    }
    switch (message.action) {
        case 'next':
            folium.playback.next();
            break;
        case 'prev':
            folium.playback.previous();
            break;
        case 'toggle':
            folium.playback.toggle();
            break;
        case 'set-volume': {
            // 只接受真正的 number：主进程发来 null / 字符串 / 缺字段时忽略，避免把音量误设成 0。
            const volume = message.volume;
            if (typeof volume !== 'number' || !Number.isFinite(volume)) {
                folium.log.warn('[lyric-widget] set-volume 的 volume 必须是有限数字，已忽略', message);
                break;
            }
            folium.playback.setVolume(clampVolume(volume));
            break;
        }
        case 'set-loop':
            if (!LOOP_MODES.includes(message.mode)) {
                folium.log.warn('[lyric-widget] set-loop 收到未知循环模式，已忽略', message.mode);
                break;
            }
            folium.playback.setLoopMode(message.mode);
            break;
        default:
            folium.log.warn('[lyric-widget] 收到未知 action，已忽略', message.action);
    }
};

/**
 * 同步引擎：activate 级创建一次，靠 folium.every 轮询 + 宿主事件驱动。
 * 没有任何 mount 上下文，行号全部由播放位置与歌词 startTime / endTime 自行比对。
 */
const createSyncEngine = (folium) => {
    const session = createPlaySession();
    let cachedTheme = null; // 宿主没有全局主题接口：最近一次从 theme.changed 拿到的主题
    let lastSentKey = '';
    let reportedFailure = false;
    // 宿主播放服务由主窗口 App 挂载后才注册（src/mods/runtime/hostActions.ts），激活时往往还没有；
    // 那时调用 folium.playback.* 会抛 playback-unavailable-in-main-context。这不是故障，
    // 所以要探测+等待，且绝不把宿主侧异常抛回激活流程或事件派发。
    let hostReady = false;
    let hostNotReadyLogged = false;
    let reportedSyncError = false;

    // rpc 是 Folium 1.7 才有的：老宿主上别让整个模组因为取不到成员而挂掉。
    const canReport = Boolean(folium.rpc && typeof folium.rpc.call === 'function');
    const canReceiveActions = canReport && typeof folium.rpc.on === 'function';

    /** 宿主播放服务是否已经注册；抛错只代表「还没就绪」，不是故障。 */
    const probeHostReady = () => {
        try {
            folium.playback.getState();
            return true;
        } catch {
            return false;
        }
    };

    /**
     * 当前视图：全部来自全局 API。
     * 行号 = 播放位置 - 用户歌词偏移，再与歌词 startTime / endTime 比对。
     */
    const readView = () => {
        const playback = folium.playback.getState();
        const lines = (folium.lyrics && typeof folium.lyrics.getLines === 'function')
            ? (folium.lyrics.getLines() || [])
            : [];
        const offsetSec = readLyricOffsetSeconds(playback.song);
        const lyricTime = playback.position - offsetSec;
        return {
            lines,
            lineIndex: findApproximateLineIndex(lines, lyricTime),
            time: lyricTime,
            offsetSec,
            theme: cachedTheme,
        };
    };

    const syncData = (force = false) => {
        if (!canReport) return;
        try {
            if (!hostReady) {
                hostReady = probeHostReady();
                if (!hostReady) {
                    if (!hostNotReadyLogged) {
                        hostNotReadyLogged = true;
                        debugLog('[lyric-widget] 宿主播放服务还没注册，先跳过这一帧（轮询会自动重试）');
                    }
                    return;
                }
                hostNotReadyLogged = false;
                // 补发激活时被跳过的那一帧，并让主进程拿到当前状态。
                force = true;
                debugLog('[lyric-widget] 宿主播放服务已就绪');
            }

            refreshPlaySession(folium, session);
            const view = readView();
            const payload = buildPayload(folium, view, session.id);

            // 一次变化可能同时触发多个监听；内容相同的快照不必重复发（request-sync 强制重发）。
            // position 每 100ms 都在变但不值得持续推流（主进程自己推进进度条），所以去重时把它固定掉。
            const key = JSON.stringify(payload, (name, value) => (name === 'position' ? 0 : value));
            if (!force && key === lastSentKey) return;
            lastSentKey = key;

            debugLog('[lyric-widget] syncData 发送', {
                force,
                state: payload.state,
                title: payload.song && payload.song.title,
                line: payload.line.text,
                // 自己减掉的用户偏移（秒）。
                offset: view.offsetSec,
                session: payload.playSessionId,
            });

            folium.rpc
                .call(RPC_UPDATE, payload)
                .then(() => {
                    reportedFailure = false;
                    reportedSyncError = false;
                })
                .catch((error) => {
                    // main.cjs 还没注册 update-data（rpc-not-found）或窗口还没就绪时这里会失败：
                    // 清掉去重键，让下一次轮询/事件自动重试；失败提示只报一次，免得刷日志。
                    lastSentKey = '';
                    if (reportedFailure) return;
                    reportedFailure = true;
                    console.error('[lyric-widget] update-data 发送失败', error);
                    folium.log.warn(
                        '[lyric-widget] 发送 update-data 失败，确认 main.cjs 已注册 api.rpc.handle("update-data", ...)；下一次轮询会自动重试',
                        error,
                    );
                });
        } catch (error) {
            // 宿主服务在运行中也可能临时不可用（窗口切换、导出上下文等）：吞掉异常、退回「未就绪」，
            // 下一轮轮询重新探测。抛出去会被宿主记成一次模组故障，而这里其实只是时序问题。
            hostReady = false;
            lastSentKey = '';
            if (reportedSyncError) return;
            reportedSyncError = true;
            debugLog('[lyric-widget] 本次快照读取失败，稍后自动重试', error && error.message);
            folium.log.warn('[lyric-widget] 读取播放状态失败（会自动重试）', error);
        }
    };

    /** request-sync 需要绕过内容去重强制重发，其余指令交给 handleAction。 */
    const handleActionMessage = (message) => {
        debugLog('[lyric-widget] 收到 action', message);
        try {
            if (message && typeof message === 'object' && message.action === ACTION_REQUEST_SYNC) {
                syncData(true);
                return;
            }
            handleAction(folium, message);
        } catch (error) {
            // 按钮可能在宿主播放服务注册之前就被点下来：记一条警告即可，不能把异常抛回 rpc 派发。
            folium.log.warn('[lyric-widget] 执行 action 失败（宿主可能还没就绪）', message, error);
        }
    };

    /** 订阅播放 / 歌词 / 主题事件；返回统一可退订的数组。 */
    const attachListeners = () => {
        const disposers = [
            folium.events.on('playback.songChanged', () => syncData()),
            folium.events.on('playback.stateChanged', () => syncData()),
            folium.events.on('playback.volumeChanged', () => syncData()),
            folium.events.on('playback.loopModeChanged', () => syncData()),
            folium.events.on('playback.likeChanged', () => syncData()),
            folium.events.on('playback.seeked', () => syncData()),
            // 歌词异步到达 / 重新解析：没有 mount 上下文，必须靠这个事件刷新当前行。
            folium.events.on('lyrics.loaded', () => syncData()),
            folium.events.on('theme.changed', (event) => {
                const theme = event && event.theme;
                if (theme) cachedTheme = theme;
                syncData();
            }),
        ];
        // 按键监听只在这里注册一次：不管播放器用哪种歌词样式，悬浮窗的按钮都有效。
        if (canReceiveActions) disposers.push(folium.rpc.on(RPC_ACTION, handleActionMessage));
        return disposers;
    };

    return {
        syncData,
        attachListeners,
        canReport,
        canReceiveActions,
    };
};

/**
 * 1.0.0 起本模组不再注册 visualizer，旧版本留在 localStorage 里的
 * `visualizer_mode = mod:my-lyric-widget:lyric-widget` 已经指向不存在的样式。
 * 宿主在启动时已经把无效值回退成内置样式，但设置面板会提示「属于某个模组」；
 * 这里只清掉「指向本模组」的那一条，其他值一律不碰。
 */
const clearStaleVisualizerSelection = (folium) => {
    try {
        const saved = localStorage.getItem('visualizer_mode');
        if (!saved || !saved.startsWith('mod:' + folium.modId + ':')) return;
        localStorage.removeItem('visualizer_mode');
        debugLog('[lyric-widget] 已清除旧的歌词样式选择（不再需要选中本模组）', saved);
    } catch {
        // localStorage 不可用时不影响同步。
    }
};

export default function activate(folium) {
    debugLog('[lyric-widget] client activate', {
        modId: folium.modId,
        context: folium.env.context,
        folium: folium.host && folium.host.folium,
        hasCall: !!(folium.rpc && folium.rpc.call),
        hasOn: !!(folium.rpc && folium.rpc.on),
        hasEvery: typeof folium.every === 'function',
        hasLyrics: !!(folium.lyrics && typeof folium.lyrics.getLines === 'function'),
        // 旧版本保存的可视化模式；现在只用于清理，不再影响是否同步。
        savedVisualizerMode: (() => {
            try {
                return localStorage.getItem('visualizer_mode');
            } catch {
                return '(localStorage 不可用)';
            }
        })(),
    });

    const engine = createSyncEngine(folium);

    // 不再注册 visualizer：本模组是常驻功能，和当前播放器用哪种歌词样式无关。
    clearStaleVisualizerSelection(folium);

    if (!engine.canReport) {
        folium.log.warn('[lyric-widget] 当前 Folium 版本没有 folium.rpc.call（需要 1.7+），悬浮窗收不到数据');
        return;
    }
    if (!engine.canReceiveActions) {
        folium.log.warn('[lyric-widget] 当前 Folium 版本没有 folium.rpc.on（需要 1.7+），悬浮窗的按钮/滑块会无效');
    }

    // 导出窗口里没有播放页：不轮询、不搬数据。
    if (folium.env.context !== 'main') {
        debugLog('[lyric-widget] 非 main 上下文，不同步');
        return;
    }

    const disposers = engine.attachListeners();

    // 自主驱动：每 100ms 读一次全局播放状态，自己算当前行；folium.every 由宿主托管
    // （模组停止时自动清理），不自己 setInterval。
    if (typeof folium.every === 'function') {
        disposers.push(folium.every(POLL_MS, () => engine.syncData()));
    } else {
        const timer = setInterval(() => engine.syncData(), POLL_MS);
        disposers.push(() => clearInterval(timer));
    }

    // 激活即发首帧：main.cjs 的窗口在它自己的 activate 里已经先建好（显示「等待播放...」），
    // 这帧即使失败（宿主播放服务还没就绪）也会被轮询自动补上。
    engine.syncData(true);

    return () => {
        for (const dispose of disposers) {
            try {
                dispose();
            } catch (error) {
                folium.log.warn('[lyric-widget] 停止同步时出错', error);
            }
        }
        debugLog('[lyric-widget] client 已停止（监听与轮询已撤）');
    };
}
