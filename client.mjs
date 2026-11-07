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
 *       startTime: number | null,
 *       endTime: number | null,
 *     },
 *     sentAt: number,          // 1.5.1：这份快照的发送时刻（epoch ms，和主进程 Date.now() 同源）；
 *                              // position 只在这一刻成立，页面推算「现在」必须用它
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
 *   - 句间也带行号（1.5.5）：resolveLineIndex 把「上一句已唱完」解析成那一句的下标，文本仍是上一句；
 *     连上一句都没有（如歌曲还没开始）时才发 index -1 +「等待播放...」。
 *   - 导出窗口里没有播放页：只注册事件也不轮询，直接返回。
 */

const RPC_UPDATE = 'update-data';
const RPC_ACTION = 'action';
const ACTION_REQUEST_SYNC = 'request-sync';
// 1.4.0 悬浮窗显隐（三条都是 main.cjs 那侧登记的同名 RPC / 推送消息）：
//   toggle-widget      点播放条的「词」按钮：主进程取反显隐，返回 {visible}
//   widget-visibility  主进程每次切换后 fire-and-forget 推 {visible}，按钮靠它点亮
//   widget-state       激活时问一次 {visible}，补齐「main 先推、这里后监听」丢掉的首帧
const RPC_TOGGLE_WIDGET = 'toggle-widget';
const RPC_WIDGET_VISIBILITY = 'widget-visibility';
const RPC_WIDGET_STATE = 'widget-state';
// 1.5.0 显示配置：
//   config       把 11 项设置的当前值整份推给 main（main 校验后算窗口高度、再转给页面）
//   toggle-pin   命令面板的「锁定 / 解锁」，和窗口正中那个图钉同一套状态，返回 {pinned}
const RPC_CONFIG = 'config';
// 1.5.1 配置回推：main 的页面每次加载完 / 每次 activate 都发一次这个 action，
// 让 client 立刻把设置整份重推一遍。起因是宿主「重载模组」只重建主进程 entry：
// 文件没变时 clientUrl 不变，client 不会重跑（见 clientLoader 的 reconcile），
// 而配置真源在 client 侧，主进程会一直停在默认值（字号回 38）。
const ACTION_REQUEST_CONFIG = 'request-config';
const RPC_TOGGLE_PIN = 'toggle-pin';
// 设置分区 id：设置 → 高级 → 模组 → 展开「独立悬浮歌词」。
const SETTINGS_SECTION_ID = 'lyric-widget';
const FONT_SIZE_MIN = 20;
const FONT_SIZE_MAX = 50;
const FONT_SIZE_DEFAULT = 38;

// 宿主的所有文案都是语言映射（FoliumLabel = Record<language, string>）：直接传字符串会被
// sanitize 整条丢掉、界面回落到 key 名（1.5.0 踩过），所以统一走这个 helper。
const L = (zh, en) => ({ 'zh-CN': zh, en });

// 20–50 逐级下拉：要的是「一格一字号」，不用滑块（滑块很难精确停在 38）。
const FONT_SIZE_OPTIONS = Array.from({ length: FONT_SIZE_MAX - FONT_SIZE_MIN + 1 }, (_, offset) => {
    const size = FONT_SIZE_MIN + offset;
    return {
        value: String(size),
        label: size === FONT_SIZE_DEFAULT ? L(size + '（默认）', size + ' (default)') : L(String(size), String(size)),
    };
});
const WAITING_LINE_TEXT = '等待播放...';
const LOOP_MODES = ['off', 'all', 'one'];

// 轮询周期：驱动「句内换行」这类没有事件的状态变化。100ms 足够让换句看起来是即时的，
// 同时靠内容去重把真正的 IPC 频率压到最低（同一行每秒只发一次）。
const POLL_MS = 100;
// 1.5.5：位置跳变阈值（秒）。宿主只在拖动 > 1.5s 时发 playback.seeked，小拖动没有任何通知，
// 而拖动后落在同一句里时去重键也和上一帧完全一样——画面就停在拖动前的状态。
// 每轮轮询拿「上一帧位置 + 这段时间」推算该到哪，偏差超过这个值就当作位置跳变，补发一帧。
// 0.75 秒：正常播放的推算误差只有几十毫秒，而宿主自己的拖动判定是 1.5 秒，这里留一半余量。
const POSITION_JUMP_TOLERANCE_SEC = 0.75;
// 1.6.4：拿去重键判断的那两帧之间超过这么久，就不再做「位置跳变」判断，直接当作内容变化发一帧。
// 起因：播放中同一句内容不变时，client 只在换句时才发帧，两帧间隔常常接近一句的长度（3–5 秒），
// 这段时间里「上一帧位置 + 间隔」必然对不上实际位置，于是把正常播放误判成跳变、每秒多发一帧，
// 主进程那边还会跟着把帧顺序保护的基准每秒重置一次。间隔超过这个值说明去重键本来就挡住了很多帧，
// 此时的偏差不代表跳变，交给换句/拖动自身的信号处理。
const POSITION_GUARD_MAX_GAP_SEC = 1.5;
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

// ---- 排查日志开关（往「设置→开发者→运行日志」里打链路日志；默认关闭，排查时临时改 true） ----
const DEBUG = false;
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
 * 返回最后一个 startTime <= time 的行下标。两句之间（该句 endTime 已过）也会返回那一句，
 * 不再返回 -1 —— 见 resolveLineIndex 的说明：句间帧必须带着行号，上下游才知道说的哪一句。
 * 歌词按时间递增，但这里不假设顺序，直接全表取 startTime 最大的那一行。
 */
const findApproximateLineIndex = (lines, time) => {
    if (!Array.isArray(lines) || lines.length === 0) return -1;
    let index = -1;
    let latestStart = -Infinity;
    for (let i = 0; i < lines.length; i += 1) {
        const start = lines[i].startTime;
        if (typeof start === 'number' && Number.isFinite(start) && start <= time && start >= latestStart) {
            latestStart = start;
            index = i;
        }
    }
    if (index < 0) return -1;
    const end = lines[index].endTime;
    if (typeof end === 'number' && Number.isFinite(end) && time >= end) return -1;
    return index;
};

/**
 * 真正要显示的那一行（1.5.5）。
 * 之前句间帧在 payload 里带的是 index -1 + 上一句的文本，主进程与页面都分辨不出「这一帧说的是哪一句」，
 * 于是同一句会在句间、下一句开始时、往回拖时反复顶掉画面（日志里表现为某一句出现频率明显不对）。
 * 现在统一解析成「有行号的那一行」：
 *   - 该句已唱完（句间）时保留上一句，但 index 仍指向它，让上下游能按时间判断新旧；
 *   - 只有什么都没得显示（第一句之前 / 无歌词）时才是 index -1 +「等待播放...」。
 */
const resolveLineIndex = (folium, lines, index, time) => {
    if (index >= 0) return index;
    const previous = folium.lyrics.getRecentCompletedLine(lines, index, time);
    if (!previous) return -1;
    if (typeof previous.index === 'number' && Number.isFinite(previous.index)) return previous.index;
    // 宿主没给下标就自己找一次：取还没唱完、startTime 最大的那一句。
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        const start = lines[i] && lines[i].startTime;
        if (typeof start === 'number' && Number.isFinite(start) && start <= time) return i;
    }
    return -1;
};

/**
 * 当前歌词行；两句之间保留上一句，只有上一句也没有（如歌曲还没开始）时才给「等待播放...」。
 * 调用方传进来的 index 已经是 resolveLineIndex 解析过的行号（句间也指向上一句），
 * 只有「什么都没得显示」时才是 -1。
 */
const readLine = (folium, lines, index, time) => {
    const safeLines = Array.isArray(lines) ? lines : [];
    const line = index >= 0 ? safeLines[index] : null;
    if (!line) {
        // 没有当前行、也没有最近一句（第一句开始前 / 无歌词）时统一给等待文案；
        // 注意最后一句结束后 getRecentCompletedLine 仍返回最后一句，不会走到这里。
        return {
            index: -1,
            text: WAITING_LINE_TEXT,
            translation: null,
            romanization: null,
            startTime: null,
            endTime: null,
        };
    }
    return {
        index,
        text: line.fullText,
        translation: line.translation ?? null,
        romanization: line.romanization ?? null,
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
        // 这份 position 是「什么时候」的位置。页面在配置变化后要用旧快照重渲染，只有靠它才能
        // 把「上次内容变化那一刻的位置」换算成「现在」（见 main.cjs 页面的 positionNowFrom）。
        sentAt: Date.now(),
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
    // 1.5.1：设置分区注册后挂上来（pushNow 不受 60ms 防抖约束）。request-config 靠它重推配置。
    let settingsPusher = null;
    // 1.5.5：上一份快照里的播放位置与会话号，用来发现「位置突然跳变」——拖进度条时用。
    let lastSentPosition = null;
    let lastSentSession = null;
    let lastSyncAt = 0;

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
            lineIndex: resolveLineIndex(folium, lines, findApproximateLineIndex(lines, lyricTime), lyricTime),
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
            // 1.5.3：sentAt 同理——它是「这份快照是什么时候的」，每次都不一样；不固定的话去重键永远不同，
            // 快照就会每 100ms 全量重发一次（控制台刷屏、页面每帧重渲染）。
            const key = JSON.stringify(payload, (name, value) => (name === 'position' || name === 'sentAt' ? 0 : value));
            // 1.5.5：内容没变也要看一眼位置对不对得上。
            // 宿主只在拖动幅度 > 1.5s 时才发 playback.seeked（src/mods/runtime/hostBridge.ts 的 SEEK_JUMP_SEC），
            // 小拖动完全没通知；而拖动后停在「同一句」里时去重键也完全一样，画面就停在拖动前的状态。
            // 这里按「上一帧位置 + 这段时间本该走过的时间」推算现在该到哪，偏太多了就当作位置跳变补发一帧。
            // 往前拖、往回拖都要补；是否采纳由主进程按播放状态判断。
            // 播放中位置才会自己往前走：暂停/不在播放时前后两帧位置理应相同，任何偏差都是拖动。
            const now = Date.now();
            const gapSec = lastSyncAt ? Math.max(0, (now - lastSyncAt) / 1000) : 0;
            const guardActive = lastSyncAt > 0 && gapSec <= POSITION_GUARD_MAX_GAP_SEC;
            const stepSec = payload.state === 'playing' ? gapSec : 0;
            const expectedPosition = lastSentPosition === null ? null : lastSentPosition + stepSec;
            const drifted = guardActive
                && lastSentSession === payload.playSessionId
                && expectedPosition !== null
                && Math.abs(payload.position - expectedPosition) > POSITION_JUMP_TOLERANCE_SEC;
            lastSyncAt = now;
            if (!force && key === lastSentKey && !drifted) {
                // 1.6.4：被去重挡掉的帧也要更新两条基准：
                //   · lastSyncAt 必须每帧都更新，否则它和 lastSentPosition 不是同一份快照的一对，
                //     间隔被算成 3–5 秒 → 必然误判跳变（之前每秒多发一帧就是这个）；
                //   · lastSentPosition 跟着「内容没变」的那一帧走 —— 位置只是往前挪一点，不影响
                //     「突然跳变」的判断；拖动之后位置不再变时，这里还能把基准拉回真实值，不会一直误报。
                lastSentPosition = payload.position;
                lastSentSession = payload.playSessionId;
                return;
            }
            lastSentKey = key;
            lastSentPosition = payload.position;
            lastSentSession = payload.playSessionId;

            if (DEBUG) {
                debugLog('[lyric-widget] syncData 发送', {
                    force,
                    drifted,
                    state: payload.state,
                    title: payload.song && payload.song.title,
                    line: payload.line.text,
                    // 自己减掉的用户偏移（秒）。
                    offset: view.offsetSec,
                    session: payload.playSessionId,
                });
            }

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
            if (message && typeof message === 'object' && message.action === ACTION_REQUEST_CONFIG) {
                // 主进程入口重建 / 页面重载后要的是配置，不是快照；设置分区还没注册时说明
                // 本次 activate 里接下来会自己 pushNow 一次，这里什么也不用做。
                if (settingsPusher) settingsPusher();
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
        /** 设置分区注册后调用：挂上「立刻重推配置」的入口。 */
        setSettingsPusher: (pusher) => {
            settingsPusher = typeof pusher === 'function' ? pusher : null;
        },
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

// ---- 播放条上的「词」开关（1.4.0）----
// 悬浮窗被 × 关掉后，模组还在跑，得留一个能把它叫回来的入口：播放进度条右侧挂一个 22px 圆形小按钮，
// 造型跟随宿主 currentColor（1.4.2 起不再自绘描边），开启时高亮、关闭时降到 40% 透明度。
const WIDGET_BUTTON_ID = 'lyric-widget-toggle';
const WIDGET_BUTTON_STYLE_ID = 'lyric-widget-toggle-style';
const WIDGET_BUTTON_HTML =
    '<button type="button" class="lyric-widget-toggle" data-on="false" aria-pressed="false" title="显示悬浮歌词">' +
    '<span aria-hidden="true">词</span></button>';
const WIDGET_BUTTON_CSS = `
.lyric-widget-toggle {
    all: unset;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    font-size: 12px;
    font-weight: 600;
    line-height: 1;
    cursor: pointer;
    color: inherit;
    opacity: 0.4;
    transition: opacity 0.15s ease, background-color 0.15s ease;
}
.lyric-widget-toggle:hover {
    opacity: 0.8;
    background-color: color-mix(in srgb, currentColor 12%, transparent);
}
.lyric-widget-toggle[data-on="true"] {
    opacity: 1;
    background-color: color-mix(in srgb, currentColor 18%, transparent);
}
.lyric-widget-toggle:focus-visible {
    opacity: 1;
    outline: 2px solid color-mix(in srgb, currentColor 45%, transparent);
    outline-offset: 1px;
}
`;

/**
 * 注册播放条上的「词」按钮。返回 `{ setVisible, dispose }`；宿主没有 progressButtons 时返回 null。
 * 显隐真源在主进程（它才是真的在 show/hide 窗口），这里只负责画和高亮。
 */
const registerWidgetToggleButton = (folium) => {
    const progressButtons = folium.registries && folium.registries.progressButtons;
    if (!progressButtons || typeof progressButtons.register !== 'function') {
        folium.log.warn('[lyric-widget] 当前 Folium 没有 progressButtons 注册表，播放条按钮不可用（需要 1.4+）');
        return null;
    }
    let button = null;
    let styleNode = null;
    let visible = true;

    const paint = () => {
        if (!button) return;
        button.dataset.on = visible ? 'true' : 'false';
        button.setAttribute('aria-pressed', visible ? 'true' : 'false');
        button.title = visible ? '隐藏悬浮歌词' : '显示悬浮歌词';
    };

    const def = {
        id: WIDGET_BUTTON_ID,
        slot: 'progress.trailing',
        // 480 = 排在宿主内置按钮之后；同一个 order 上再按 id 排序，所以位置稳定。
        order: 480,
        // 进度条收起（迷你 / 歌词页折叠）时跟着消失，别在只剩一条细线的地方挤一个按钮。
        hideWhenCollapsed: true,
        mount(container) {
            // 播放条在宿主自己的 ShadowRoot 里：样式必须注入按钮所在的 root，挂到 document.head 不生效。
            const root = container.getRootNode && container.getRootNode();
            const styleHost = root && root.nodeType === 11 && root.head ? root.head : root;
            if (styleHost && typeof styleHost.querySelector === 'function') {
                styleNode = styleHost.querySelector('#' + WIDGET_BUTTON_STYLE_ID);
            }
            if (!styleNode) {
                styleNode = document.createElement('style');
                styleNode.id = WIDGET_BUTTON_STYLE_ID;
                styleNode.textContent = WIDGET_BUTTON_CSS;
                if (styleHost && typeof styleHost.appendChild === 'function') styleHost.appendChild(styleNode);
            }
            container.innerHTML = WIDGET_BUTTON_HTML;
            button = container.querySelector('.lyric-widget-toggle');
            paint();
            if (!button) return undefined;
            const onClick = () => {
                // 先本地翻转让手感即时；主进程返回后以它的值对齐（失败则回滚）。
                visible = !visible;
                paint();
                Promise.resolve(folium.rpc.call(RPC_TOGGLE_WIDGET))
                    .then((result) => {
                        if (result && typeof result.visible === 'boolean') {
                            visible = result.visible;
                            paint();
                        }
                    })
                    .catch((error) => {
                        visible = !visible;
                        paint();
                        folium.log.warn('[lyric-widget] 切换悬浮歌词失败', error);
                    });
            };
            button.addEventListener('click', onClick);
            // cleanup 用 mount 时这个局部节点：dispose() 会先把 button 置 null 再等 React 卸载，
            // 直接碰外层 button 会读到 null（停用/重载模组时宿主报一次模组故障）。
            const mountedButton = button;
            return () => {
                mountedButton.removeEventListener('click', onClick);
                if (button === mountedButton) button = null;
            };
        },
    };

    let handle = null;
    try {
        handle = progressButtons.register(def);
    } catch (error) {
        // id 重复（模组热重载时旧条目还没被宿主清掉）之类的注册错误：按钮没了不该拖垮数据同步。
        folium.log.warn('[lyric-widget] 注册播放条「词」按钮失败', error);
        return null;
    }

    return {
        setVisible(next) {
            const value = next !== false;
            if (value === visible) return;
            visible = value;
            paint();
        },
        dispose() {
            try {
                if (handle && typeof handle.unregister === 'function') handle.unregister();
            } catch (error) {
                folium.log.warn('[lyric-widget] 注销播放条按钮失败', error);
            }
            if (styleNode && styleNode.parentNode) styleNode.parentNode.removeChild(styleNode);
            styleNode = null;
            button = null;
        },
    };
};

/**
 * 1.5.0：模组设置表单（设置 → 高级 → 模组 → 展开「独立悬浮歌词」）。
 *
 * 设置值由宿主持久化（FoliumSettingAccess 读写宿主参数存储），这里只做三件事：
 * 声明表单、读值、把值推给 main.cjs。窗口高度和 CSS 变量都在主进程/窗口页面里算，
 * client 不持有第二份真相，避免两边各存一份后互相覆盖。
 * defaultValue 必须与 main.cjs 的 DEFAULT_CONFIG 一致（默认观感 = 1.4.2）。
 */
const buildSettingsSection = () => ({
    id: SETTINGS_SECTION_ID,
    label: L('独立悬浮歌词', 'Floating lyric window'),
    description: L(
        '所有设置只影响这个悬浮歌词窗口，不影响播放器本身的歌词样式。',
        'These settings only affect the floating lyric window, not the player itself.',
    ),
    settings: [
        {
            key: 'fontSize',
            type: 'select',
            label: L('字号', 'Font size'),
            description: L(
                '窗口高度会跟着字号一起缩放，歌词始终贴着窗口底部留白。',
                'The window height follows the font size so the lyric keeps its bottom margin.',
            ),
            group: L('通用', 'Shared'),
            defaultValue: String(FONT_SIZE_DEFAULT),
            options: FONT_SIZE_OPTIONS,
        },
        {
            key: 'fontMode',
            type: 'select',
            label: L('字体来源', 'Font source'),
            description: L(
                '「跟随主题字体」用播放器当前主题解析出的字体栈。',
                '"Theme" follows the player theme font stack.',
            ),
            group: L('通用', 'Shared'),
            defaultValue: 'system',
            options: [
                { value: 'system', label: L('系统无衬线（默认）', 'System sans-serif (default)') },
                { value: 'theme', label: L('跟随主题字体', 'Follow theme font') },
            ],
        },
        {
            key: 'surface',
            type: 'select',
            label: L('底色', 'Background'),
            description: L(
                '只在鼠标移到窗口上、且未锁定时出现（锁定穿透时不铺底色）。',
                'Shown only while the pointer is over the window and it is not locked.',
            ),
            group: L('通用', 'Shared'),
            defaultValue: 'auto',
            options: [
                { value: 'auto', label: L('深色（默认，透明度可调）', 'Dark (default)') },
                { value: 'dark', label: L('深色（更实）', 'Dark, more opaque') },
                { value: 'light', label: L('浅色毛玻璃', 'Light frosted') },
                { value: 'transparent', label: L('不显示底色', 'No background') },
            ],
        },
        {
            key: 'surfaceOpacity',
            type: 'number',
            label: L('底色不透明度', 'Background opacity'),
            description: L('仅对深色底色生效，0.2–1.0。', 'Dark backgrounds only, 0.2-1.0.'),
            group: L('通用', 'Shared'),
            defaultValue: 0.58,
            min: 0.2,
            max: 1,
            step: 0.05,
        },
        {
            key: 'radius',
            type: 'number',
            label: L('窗口圆角', 'Window radius'),
            description: L('0–28 像素；0 为直角。', '0-28 px; 0 means square corners.'),
            group: L('通用', 'Shared'),
            defaultValue: 16,
            min: 0,
            max: 28,
            step: 1,
        },
        {
            key: 'border',
            type: 'boolean',
            label: L('显示细描边', 'Show hairline border'),
            group: L('通用', 'Shared'),
            defaultValue: true,
        },
        {
            key: 'backdrop',
            type: 'boolean',
            label: L('歌词底衬', 'Lyric backdrop'),
            description: L(
                '在歌词块后面垫一层半透明黑，壁纸很花时更容易读。',
                'Adds a translucent dark plate behind the lyric for busy wallpapers.',
            ),
            group: L('通用', 'Shared'),
            defaultValue: false,
        },
        {
            key: 'pausedDim',
            type: 'boolean',
            label: L('暂停时整体变淡', 'Dim while paused'),
            group: L('通用', 'Shared'),
            defaultValue: false,
        },
        {
            key: 'marquee',
            type: 'boolean',
            label: L('长句滚动', 'Scroll long lines'),
            description: L(
                '放不下的长句子横向滚过去，速度跟着这一句剩余时间走。关掉时长的句子尾部省略号截断。',
                'Scrolls lines that do not fit; speed follows the remaining time of the line. When off, long lines are truncated with an ellipsis.',
            ),
            group: L('桌面歌词', 'Desktop lyric'),
            defaultValue: true,
        },
    ],
});

/**
 * 读当前设置并收窄成 main.cjs 认识的配置对象（三段结构：shared / desktop / window）。
 * 读不到（注册表没给 handle / 宿主老版本）时返回 null，调用方跳过推送。
 */
const readConfigFromHandle = (handle) => {
    if (!handle || !handle.settings || typeof handle.settings.get !== 'function') return null;
    let values;
    try {
        values = handle.settings.get() || {};
    } catch (error) {
        debugLog('[lyric-widget] 读取模组设置失败', error);
        return null;
    }
    const toNumber = (value, fallback) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    };
    return {
        shared: {
            fontSize: toNumber(values.fontSize, FONT_SIZE_DEFAULT),
            fontMode: values.fontMode,
            surface: values.surface,
            surfaceOpacity: toNumber(values.surfaceOpacity, 0.58),
            radius: toNumber(values.radius, 16),
            // 布尔项没写过时是 undefined，按「默认开」处理；只有明确 false 才算关。
            border: values.border !== false,
            pausedDim: values.pausedDim === true,
            backdrop: values.backdrop === true,
        },
        desktop: {
            marquee: values.marquee === true,
        },
        window: {},
    };
};

/**
 * 注册设置表单，并在每次改动后把配置推给主进程。
 * 返回值里的 push 也用于激活时的首帧下发（此时宿主可能还没恢复完设置值）。
 */
const registerSettingsSection = (folium) => {
    const registry = folium.registries && folium.registries.settingsSections;
    if (!registry || typeof registry.register !== 'function') {
        debugLog('[lyric-widget] 当前 Folium 没有 settingsSections 注册表，跳过设置表单');
        return null;
    }
    const section = buildSettingsSection();
    // 连续操作（拖不透明度输入框、连点字号）会一次刷出很多 onChange：逐条推给主进程的话，
    // 主进程会连着 setSize / 重发配置，窗口跟着抖。这里合并成「最后一次为准」，60ms 后推一次。
    let pushTimer = null;
    const pushNow = () => {
        const config = readConfigFromHandle(handle);
        if (!config) return;
        if (!folium.rpc || typeof folium.rpc.call !== 'function') return;
        try {
            // 主进程会做一次 normalizeConfig，坏值在那里回落默认，这里不重复校验。
            Promise.resolve(folium.rpc.call(RPC_CONFIG, config)).catch((error) => {
                folium.log.warn('[lyric-widget] 下发显示配置失败', error);
            });
        } catch (error) {
            folium.log.warn('[lyric-widget] 下发显示配置失败', error);
        }
    };
    const push = () => {
        if (pushTimer) clearTimeout(pushTimer);
        pushTimer = setTimeout(() => {
            pushTimer = null;
            pushNow();
        }, 60);
    };
    let handle = null;
    try {
        handle = registry.register({
            id: section.id,
            label: section.label,
            description: section.description,
            settings: section.settings,
        });
    } catch (error) {
        // 注册失败不影响悬浮窗本身，只是没有设置界面（样式走默认）。
        folium.log.warn('[lyric-widget] 注册模组设置失败（悬浮窗仍用默认样式）', error);
        return null;
    }
    let offChange = null;
    try {
        if (handle && handle.settings && typeof handle.settings.onChange === 'function') {
            offChange = handle.settings.onChange(() => push());
        }
    } catch (error) {
        folium.log.warn('[lyric-widget] 订阅模组设置变化失败', error);
    }
    // 激活即下发一次（不走防抖）：宿主重启后会恢复设置值，窗口不能停在默认 38px 上。
    pushNow();
    return {
        handle,
        push,
        // 1.5.1：main 的 request-config 走这里——绕开 60ms 防抖立刻推一次。
        pushNow,
        dispose: () => {
            if (pushTimer) {
                clearTimeout(pushTimer);
                pushTimer = null;
            }
            if (offChange) {
                try {
                    offChange();
                } catch (error) {
                    // 宿主已经整体回收过，忽略。
                }
                offChange = null;
            }
            try {
                if (handle && typeof handle.unregister === 'function') handle.unregister();
            } catch (error) {
                // 同上。
            }
            handle = null;
        },
    };
};

/**
 * 1.5.0：命令面板入口（模组页同一块 surface 上也能直接跑）。
 * 全局快捷键是 Folium 1.7+ 才支持的字段，老宿主上只注册命令本身。
 */
const registerWidgetCommands = (folium, settings) => {
    const registry = folium.registries && folium.registries.commands;
    if (!registry || typeof registry.register !== 'function') {
        debugLog('[lyric-widget] 当前 Folium 没有 commands 注册表，跳过命令');
        return [];
    }
    const minor = (folium.host && folium.host.folium && folium.host.folium.minor) || 0;
    const handles = [];
    // 返回 Promise 而不是吞掉失败：命令面板会 await run，失败能显示在卡片上，而不是假装成功。
    const callMain = (method) => {
        try {
            return Promise.resolve(folium.rpc.call(method));
        } catch (error) {
            folium.log.warn('[lyric-widget] 执行命令失败', error);
            return Promise.reject(error);
        }
    };
    // 字号 ±1：直接改宿主里的设置值，onChange 会带着新配置推给主进程并触发窗口重算。
    const stepFontSize = (delta) => {
        if (!settings || !settings.handle || !settings.handle.settings) return undefined;
        const current = readConfigFromHandle(settings.handle);
        if (!current) return undefined;
        const currentSize = Math.round(current.shared.fontSize);
        const next = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, currentSize + delta));
        if (next === currentSize) return undefined;
        try {
            return settings.handle.settings.set({ fontSize: String(next) });
        } catch (error) {
            folium.log.warn('[lyric-widget] 调整字号失败', error);
            return Promise.reject(error);
        }
    };
    const add = (definition) => {
        try {
            const registered = registry.register(minor >= 7 ? { ...definition, globalShortcut: true } : definition);
            if (registered) handles.push(registered);
        } catch (error) {
            folium.log.warn('[lyric-widget] 注册命令失败', error);
        }
    };
    add({
        id: 'lyric-widget-toggle',
        label: L('桌面歌词：显示 / 隐藏', 'Floating lyrics: show / hide'),
        description: L('和播放控制条上的「词」按钮同一个开关。', 'Same switch as the 词 button on the player bar.'),
        keywords: ['歌词', '桌面歌词', '悬浮窗', 'widget', 'lyric'],
        run: () => callMain(RPC_TOGGLE_WIDGET),
    });
    add({
        id: 'lyric-widget-pin',
        label: L('桌面歌词：锁定 / 解锁位置', 'Floating lyrics: lock / unlock'),
        description: L('和悬浮窗正中的图钉按钮同一套状态。', 'Same state as the pin button in the window.'),
        keywords: ['歌词', '锁定', '固定', 'pin', 'lock'],
        run: () => callMain(RPC_TOGGLE_PIN),
    });
    add({
        id: 'lyric-widget-font-up',
        label: L('桌面歌词：字号 +1', 'Floating lyrics: font size +1'),
        keywords: ['歌词', '字号', '字体大小'],
        run: () => stepFontSize(1),
    });
    add({
        id: 'lyric-widget-font-down',
        label: L('桌面歌词：字号 -1', 'Floating lyrics: font size -1'),
        keywords: ['歌词', '字号', '字体大小'],
        run: () => stepFontSize(-1),
    });
    return handles;
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

    // 1.4.0：播放条上的「词」开关。显隐真源在 main（它才真的在 show/hide 窗口），
    // 这里订阅 main 推来的 widget-visibility 点亮按钮，激活时再用 widget-state 对齐一次
    // （main 首帧那边是 fire-and-forget，早于这里注册监听就会丢）。
    const widgetButton = registerWidgetToggleButton(folium);
    if (widgetButton) {
        disposers.push(() => widgetButton.dispose());
        if (typeof folium.rpc.on === 'function') {
            disposers.push(
                folium.rpc.on(RPC_WIDGET_VISIBILITY, (message) => {
                    widgetButton.setVisible(message && message.visible);
                }),
            );
        }
        Promise.resolve(folium.rpc.call(RPC_WIDGET_STATE))
            .then((initial) => widgetButton.setVisible(initial && initial.visible))
            .catch((error) => {
                // 宿主没登记 widget-state（不该发生）时保持默认「显示」，不影响数据同步。
                folium.log.warn('[lyric-widget] 读取悬浮窗显隐状态失败', error);
            });
    }

    // 1.5.0：设置表单。注册成功时 activate 里立刻会把当前配置推一份给 main，
    // 所以窗口在创建后不久就能拿到真实字号 / 外观，而不是等用户去动设置。
    const settings = registerSettingsSection(folium);
    if (settings) {
        disposers.push(() => settings.dispose());
        // 1.5.1：主进程「重载模组」不会重跑 client（clientUrl 没变），配置真源又在这里，
        // 所以留一个口子让它来要：request-config → 立刻重推一次设置。
        if (engine && typeof engine.setSettingsPusher === 'function') engine.setSettingsPusher(settings.pushNow);
    }
    // 1.5.0：命令面板（显隐 / 锁定 / 字号 ±1）。字号走宿主设置，改动会自动流回 main。
    const commandHandles = registerWidgetCommands(folium, settings);
    for (const handle of commandHandles) {
        disposers.push(() => {
            try {
                if (handle && typeof handle.unregister === 'function') handle.unregister();
            } catch (error) {
                // 宿主已经整体回收过注册表，忽略。
            }
        });
    }

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
