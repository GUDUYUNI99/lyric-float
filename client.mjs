/**
 * my-lyric-widget 的渲染进程入口：只做数据搬运，不渲染任何界面。
 *
 * 数据流（与 main.cjs 的协议）：
 *   渲染进程 -> 主进程：每次状态变化通过 folium.rpc.call('update-data', payload) 发一份完整快照；
 *                        main.cjs 侧对应 api.rpc.handle('update-data', (payload) => ...)。
 *   主进程 -> 渲染进程：main.cjs 用 api.rpc.send('action', { action: 'next' }) 发控制指令；
 *                        这里在 folium.rpc.on('action', ...) 里转成 folium.playback 的调用。
 *
 * payload 形状（主进程按这份结构写接收逻辑）：
 *   {
 *     playSessionId: string,   // 同一次播放内不变（宿主重新挂载也不换）；换歌 / 从 stopped 重新开始时换新的
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
 *       text,                  // 没有当前行时保留最近一句（含最后一句结束后）；连最近一句都没有（第一句开始前 / 无歌词）时是「等待播放...」
 *       translation: string | null,
 *       romanization: string | null,
 *       words: null,           // 逐字 / 卡拉 OK 预留字段，当前恒为 null
 *       startTime: number | null,
 *       endTime: number | null,
 *     },
 *     theme: {                 // 视觉在挂载之前（或从未挂载过）时可能是 null：宿主没有全局主题读取接口，
 *       name, isDaylight, backgroundColor, primaryColor, accentColor, secondaryColor,
 *       fontStyle, fontStack,  // fontStack 是可直接写进 CSS 的 font-family
 *     } | null,
 *   }
 *
 * action 形状（main.cjs 用 api.rpc.send('action', ...) 发来）：
 *   { action: 'next' } | { action: 'prev' } | { action: 'toggle' }
 *   | { action: 'set-volume', volume: 0–1 }
 *   | { action: 'set-loop', mode: 'off' | 'all' | 'one' }
 *   | { action: 'request-sync' }   // 主进程窗口刚打开、错过之前的快照时，强制重发一次
 *
 * 同步策略（0.3.3：不再依赖「本样式被选中」）：
 *   - 主路径 mount：本样式被选中时宿主挂载这里，ctx 给出精确的歌词时钟（含用户歌词偏移），
 *     每个变化都发快照 —— 精度最高。
 *   - 兜底路径 activate：本样式没被选中时没有任何 mount，但 activate 仍然活着，
 *     于是用 folium.playback / folium.lyrics / folium.events 自己驱动同步：
 *       · folium.every 轮询（POLL_MS）驱动句内变化；
 *       · playback.* / lyrics.loaded / theme.changed 事件立即触发；
 *       · 行号用 playback.position 与歌词 startTime/endTime 比对；用户调过的歌词偏移由这里自己
 *         补回来（减法，见下方 readLyricOffsetSeconds 的说明），所以手动把歌词延后 5 秒时，
 *         悬浮窗也跟着延后 5 秒，不再整体偏一句。
 *       · 预览片段（preview clip）从歌曲中间开始时，播放位置与歌词时钟之间还差一个片段起点，
 *         这一项兜底路径拿不到；挂载后立刻切回宿主的精确时钟。
 *   - 宿主播放服务（folium.playback 等）由主窗口 App 挂载后才注册：activate 常常比它早，
 *     此时调用会抛 playback-unavailable-in-main-context。这不是故障，所以这里先探测 + 等待，
 *     任何宿主侧异常都在本模块内吞掉，不会被记成「client activate 出错 / 事件出错」。
 *   - 按键监听（folium.rpc.on('action')）只注册一次，放在 activate 里：不管样式有没有被选中，
 *     悬浮窗底部的按钮都有效。
 *   - 主题只在挂载过之后才有缓存值（theme.changed 也会更新缓存），没挂载过时 payload.theme 为 null。
 *
 * 约定：
 *   - 快照里不含 song.ref：ref 只在当前渲染会话有效，主进程存下来会失效；跨歌用 source + id。
 *   - 真正的悬浮窗由 main.cjs 创建；这个 visualizer 被选中只影响同步精度，不占画面。
 *   - 句间（index -1）用 folium.lyrics.getRecentCompletedLine 保留上一句；
 *     连上一句都没有（如歌曲还没开始）时才发「等待播放...」。
 *   - 宿主会在歌词异步到达、换歌、静态模式每句等时机重新挂载；播放会话跨挂载复用，主进程只在
 *     playSessionId 真正变化时重置进度。静态模式（主题设置）只停背景动画，播放继续，照常同步。
 */

const RPC_UPDATE = 'update-data';
const RPC_ACTION = 'action';
const ACTION_REQUEST_SYNC = 'request-sync';
const WAITING_LINE_TEXT = '等待播放...';
const LOOP_MODES = ['off', 'all', 'one'];

// 兜底轮询周期：只用来驱动「句内换行」这类没有事件的状态变化；事件仍然即时触发。
// 200ms 足以让句与句之间的切换看起来是即时的，同时把 IPC 频率压到最低。
const POLL_MS = 200;

// ---- 用户歌词偏移（兜底路径自己复算） ----
// 宿主主窗口把「已经算上用户偏移」的歌词时钟交给 mount 的 ctx.lyricTime，但没有对外暴露全局
// 歌词时钟；样式没被选中时只能自己补回来。键名与算法严格照抄宿主源码：
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

// localStorage 里的偏移表只在用户动手调整时才变；按原始字符串缓存，避免每 200ms 重新解析。
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

/** 兜底路径要从播放位置里减掉的偏移（秒）：单曲手动偏移 + 设备级延迟补偿。 */
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
 * 播放会话状态：放在 activate 作用域里跨挂载复用。
 * 宿主会在歌词异步到达、换歌、静态模式每句等时机重新挂载 visualizer；
 * 如果每次挂载都换 id，主进程会在同一首歌中途重置进度。
 */
const createPlaySession = () => ({
    id: createPlaySessionId(),
    songKey: null, // 上次观察到的歌；null 表示还没有基线（首次挂载）
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
 * 兜底路径的当前行下标：宿主没有全局歌词时钟，只能用播放位置比对歌词时间。
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
 * lines / index / time 由调用方给出：挂载时是 ctx 的精确值，兜底时是 getLines() + 播放位置的近似值。
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
        // index 也归 -1，保证「index >= 0」与「text 是歌词」两条约定一致。
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
 * theme 为 null（还没挂载过、也没收到 theme.changed）时返回 null，由主进程用默认样式兜底。
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
 * 同步引擎：activate 级创建一次，mount 只是把精确上下文交给它。
 * 这样「有没有被选中」只影响行号精度，不影响数据是否在流动、按钮是否有效。
 */
const createSyncEngine = (folium) => {
    const session = createPlaySession();
    let mountedCtx = null; // 非 null = 本样式正在被宿主渲染，ctx 里有精确歌词时钟
    let cachedTheme = null; // 宿主没有全局主题接口：最近一次从 mount / theme.changed 拿到的主题
    let lastSentKey = '';
    let reportedFailure = false;
    // 宿主播放服务由主窗口 App 挂载后才注册（src/mods/runtime/hostActions.ts），激活时往往还没有；
    // 那时调用 folium.playback.* 会抛 playback-unavailable-in-main-context。这不是故障，
    // 所以要探测+等待，且绝不把宿主侧异常抛回激活流程或事件派发。
    let hostReady = false;
    let hostNotReadyLogged = false;
    let reportedSyncError = false;

    // rpc 是 Folium 1.7 才有的：老宿主上别让整个歌词样式因为取不到成员而挂掉。
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

    /** 当前视图：挂载时用 ctx 的精确值，否则用全局 API 近似。 */
    const readView = () => {
        if (mountedCtx) {
            const theme = mountedCtx.getTheme();
            if (theme) cachedTheme = theme;
            return {
                lines: mountedCtx.lines || [],
                lineIndex: mountedCtx.getLineIndex(),
                time: mountedCtx.lyricTime.get(),
                // 挂载时歌词时钟已经由宿主算上偏移，这里不需要再减。
                offsetSec: null,
                theme,
                source: 'mount',
            };
        }
        const playback = folium.playback.getState();
        const lines = folium.lyrics.getLines() || [];
        // 兜底路径自己把用户偏移补回来：歌词时钟 = 播放位置 - 偏移（秒）。
        const offsetSec = readLyricOffsetSeconds(playback.song);
        const lyricTime = playback.position - offsetSec;
        return {
            lines,
            lineIndex: findApproximateLineIndex(lines, lyricTime),
            time: lyricTime,
            offsetSec,
            theme: cachedTheme,
            source: 'fallback',
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
            // position 每秒都在变但不值得每秒推流（主进程自己推进进度条），所以去重时把它固定掉。
            const key = JSON.stringify(payload, (name, value) => (name === 'position' ? 0 : value));
            if (!force && key === lastSentKey) return;
            lastSentKey = key;

            debugLog('[lyric-widget] syncData 发送', {
                source: view.source,
                force,
                state: payload.state,
                title: payload.song && payload.song.title,
                line: payload.line.text,
                // 兜底路径减掉的用户偏移（秒）；挂载路径是宿主算好的，显示 null。
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
            // 歌词异步到达 / 重新解析：兜底路径没有 ctx.onChange，必须靠这个事件刷新当前行。
            folium.events.on('lyrics.loaded', () => syncData()),
            folium.events.on('theme.changed', (event) => {
                const theme = event && event.theme;
                if (theme) cachedTheme = theme;
                syncData();
            }),
        ];
        // 按键监听只在这里注册一次：不管样式有没有被选中，悬浮窗的按钮都有效。
        if (canReceiveActions) disposers.push(folium.rpc.on(RPC_ACTION, handleActionMessage));
        return disposers;
    };

    /** mount 交出精确上下文；卸载（null）时立刻用兜底视图补一帧，避免窗口停在旧行。 */
    const setMountedContext = (ctx) => {
        mountedCtx = ctx;
        if (!ctx) syncData();
    };

    return {
        syncData,
        attachListeners,
        setMountedContext,
        canReport,
        canReceiveActions,
    };
};

/**
 * 挂载：这个样式不画任何东西，mount 只负责把精确上下文交给同步引擎。
 * 宿主会在歌曲 / 歌词数据 / staticMode 变化时重新挂载，每次挂载都会立刻发一份完整快照。
 */
const mountLyricWidget = (engine, folium, ctx) => {
    debugLog('[lyric-widget] mount 进入', {
        context: folium.env.context,
        isPreview: ctx.isPreview,
        lines: ctx.lines && ctx.lines.length,
        lineIndex: ctx.getLineIndex(),
        canCall: !!(folium.rpc && folium.rpc.call),
        canOn: !!(folium.rpc && folium.rpc.on),
    });
    // 设置面板里的预览、导出窗口都不是真实播放，不搬数据。
    // 静态模式只是主题设置里「禁用几何背景」的选项，播放继续，仍需同步（它会让宿主每句重新挂载）。
    if (ctx.isPreview) {
        debugLog('[lyric-widget] mount 早退（isPreview）');
        return;
    }

    engine.setMountedContext(ctx);
    // ctx.onChange 在歌词时钟推进 / 行变化时触发：这是「有精确时钟」时的高精度路径。
    const disposeChange = typeof ctx.onChange === 'function' ? ctx.onChange(() => engine.syncData()) : null;
    // 挂载即对齐会话并发一次：主进程不用等到下一次播放事件才知道当前状态。
    engine.syncData();

    // 卸载（切样式、换歌重新挂载、模组停止）时只撤监听，不再发消息：
    // 换歌也会走卸载，发一条「已停用」会让主进程误以为用户关掉了悬浮窗。
    return () => {
        try {
            if (disposeChange) disposeChange();
        } catch (error) {
            folium.log.warn('[lyric-widget] 卸载 onChange 时出错', error);
        }
        engine.setMountedContext(null);
    };
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
        // 宿主保存的可视化模式：mod:<id>:<name> 说明用户选的确实是本模组。
        // 不管它是什么，兜底路径都会继续同步（0.3.3 起不再依赖这个值）。
        savedVisualizerMode: (() => {
            try {
                return localStorage.getItem('visualizer_mode');
            } catch {
                return '(localStorage 不可用)';
            }
        })(),
    });

    const engine = createSyncEngine(folium);

    // 注册仍然必须有：被选中时用它拿到精确歌词时钟，导出窗口也要求它存在。
    folium.registries.visualizers.register({
        id: 'lyric-widget',
        label: { 'zh-CN': '悬浮歌词', en: 'Floating Lyrics' },
        // container 不使用：界面在主进程开的窗口里。
        mount: (container, ctx) => mountLyricWidget(engine, folium, ctx),
    });
    debugLog('[lyric-widget] visualizer 已注册 lyric-widget');

    if (!engine.canReport) {
        folium.log.warn('[lyric-widget] 当前 Folium 版本没有 folium.rpc.call（需要 1.7+），悬浮窗收不到数据');
        return;
    }
    if (!engine.canReceiveActions) {
        folium.log.warn('[lyric-widget] 当前 Folium 版本没有 folium.rpc.on（需要 1.7+），悬浮窗的按钮/滑块会无效');
    }

    // 导出窗口只注册、不搬数据（那里没有播放页，也不该往悬浮窗推快照）。
    if (folium.env.context !== 'main') {
        debugLog('[lyric-widget] 非 main 上下文，只注册不同步');
        return;
    }

    const disposers = engine.attachListeners();

    // 兜底驱动：样式没被选中时没有任何 ctx 事件，靠这个轮询发现句内换行。
    // folium.every 由宿主托管（模组停止时自动清理），不自己 setInterval。
    if (typeof folium.every === 'function') {
        disposers.push(folium.every(POLL_MS, () => engine.syncData()));
    } else {
        const timer = setInterval(() => engine.syncData(), POLL_MS);
        disposers.push(() => clearInterval(timer));
    }

    // 激活即发首帧：主进程窗口可能比模组早开一秒左右，早发的这条即使失败也会被轮询自动补上。
    engine.syncData(true);

    return () => {
        for (const dispose of disposers) {
            try {
                dispose();
            } catch (error) {
                folium.log.warn('[lyric-widget] 停止同步时出错', error);
            }
        }
        engine.setMountedContext(null);
        debugLog('[lyric-widget] client 已停止（监听已撤）');
    };
}
