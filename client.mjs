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
 *       words: { text, startTime, endTime }[] | null,  // 1.5.0：逐字时间，没有词级数据时为 null
 *       next: string | null,   // 1.5.0：下一句原文（歌词板形态用），句间/末句时为 null
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
 * 1.4.0 显示 / 隐藏（播放控制条上的「词」按钮）：
 *   client -> 主进程：folium.rpc.call('toggle-widget')，resolve { visible }；
 *   首帧对齐（1.4.1）：folium.rpc.call('widget-state')，resolve { visible }；
 *   主进程 -> client：api.rpc.send('widget-visibility', { visible })（Folium 1.7+ 的 rpc.on）。
 *   按钮位置与 enhanced-remote-widget 一致（progress.trailing、order 480）。
 *   1.4.2 起：收起态不挂载（hideWhenCollapsed），外观对齐宿主原生按钮（圆形、无描边、
 *   常态 40% 透明、开启态用 currentColor 20% 底色）。
 *
 * 1.5.0 设置与命令（设置 → 高级 → 模组 → 独立悬浮歌词）：
 *   client -> 主进程：folium.rpc.call('config', { shared: {...}, desktop: { marquee }, window: {} })，
 *                     主进程 normalize 后按字号重算窗口高度并转给页面（1.6.0 起是三段结构，
 *                     老宿主 / 老主进程收到扁平结构也会按 shared 读，不会坏）。
 *   设置值由宿主持久化（settingsSections 的 settings.get/set），本模组不另存一份。
 *   命令面板：显示/隐藏、锁定/解锁、字号 ±1（字号那两条直接改设置值）、切换形态。
 *   1.6 兼容：宿主没有 api.rpc.send 时，主进程把消息排进队列，这里 folium.every(150) 轮询
 *            folium.rpc.call('take-commands') 取回 { kind: 'action' | 'widget-visibility', payload }。
 *
 * 1.6.1 两种显示形态（互斥，同一时刻只显示一种）：
 *   形态现在是宿主持久化的设置项（settings 里的 display: 'desktop' | 'window'），
 *   窗口控制条「固定」键左边的切换键、命令面板那条命令，
 *   最终都走 folium.rpc.call('set-surface', { surface: 'desktop' | 'window' })，
 *   resolve { surface }（不带参数则来回切换）。首帧用 widget-state 的 surface 字段对齐。
 *   主进程回推 widget-visibility 时会带上 surface，设置面板的下拉据此保持一致。
 *   1.6.1 只做链路：window 形态暂时什么都不显示，视图在 1.7.0 补。
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
// 1.4.0：播放条上「词」按钮 ↔ 主进程。call 切换显示/隐藏，on 收主进程推回来的可见性。
const RPC_TOGGLE_WIDGET = 'toggle-widget';
const RPC_WIDGET_VISIBILITY = 'widget-visibility';
// 首帧对齐用：主进程可能在本模组 client 还没激活时就把 widget-visibility 推掉了（推给空气），
// 按钮登场后主动问一次当前状态，别一直停在「关」的灰态。
const RPC_WIDGET_STATE = 'widget-state';
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

// ---- 调试日志开关 ----
// 默认关：每 100ms 一次的同步链路会把「运行日志」刷满，真排查时再临时改 true。
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
 * 1.5.0 逐字歌词：把宿主的 words（{text,startTime,endTime,syllables?}）收窄成页面要的最小形状。
 * 没有词级时间的行（整行只有一个词、或老宿主不给 words）返回 null，页面按普通文本渲染。
 */
const projectWords = (words) => {
    if (!Array.isArray(words) || words.length === 0) return null;
    const out = [];
    for (const word of words) {
        if (!word || typeof word.text !== 'string') continue;
        const startTime = Number(word.startTime);
        const endTime = Number(word.endTime);
        if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) continue;
        out.push({ text: word.text, startTime, endTime });
    }
    return out.length > 0 ? out : null;
};

/**
 * 当前歌词行；两句之间保留上一句，只有上一句也没有（如歌曲还没开始）时才给「等待播放...」。
 * 1.5.0 起额外带两个字段：words（逐字时间）和 next（下一句原文，给歌词板形态用）。
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
            next: null,
            startTime: null,
            endTime: null,
        };
    }
    // 下一句：只有真的拿到行下标时才有意义（句间保留上一句时没有「下一句」可显示）。
    const nextLine = index >= 0 ? safeLines[index + 1] : null;
    return {
        index,
        text: line.fullText,
        translation: line.translation ?? null,
        romanization: line.romanization ?? null,
        // 逐字时间：有词级数据的行才给数组，否则 null（页面走普通文本渲染，和 1.4.2 一致）。
        words: projectWords(line.words),
        next: nextLine && typeof nextLine.fullText === 'string' ? nextLine.fullText : null,
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
        handleActionMessage,
        canReport,
        canReceiveActions,
    };
};

/**
 * 1.4.0：播放控制条上的「词」开关（做法照抄 enhanced-remote-widget：progressButtons + RPC）。
 *
 * 图标直接用一个汉字「词」，不走 SVG：宿主图标库是 lucide 的线性图形，没有「歌词开关」这一款；
 * 汉字在 20×20 的按钮里最直观，而且开/关两态可以只靠颜色区分（开＝高亮、关＝变灰）。
 * 容器由宿主创建（FoliumMountHost 会给它 `all: initial`），所以字体、颜色、背景都得自己显式写。
 * 按钮的高亮不反映在 def 里（宿主只按 mount 渲染一次），靠主进程推的 widget-visibility 事件刷新。
 */
const WIDGET_BUTTON_ID = 'lyric-widget-toggle';
const WIDGET_BUTTON_HTML = [
    '<button type="button" class="lyric-widget-toggle" data-on="false"',
    ' title="显示 / 隐藏悬浮歌词" aria-label="显示 / 隐藏悬浮歌词" aria-pressed="false">',
    '<span aria-hidden="true">词</span>',
    '</button>',
].join('');

const WIDGET_BUTTON_CSS = `
/*
 * 造型对齐宿主原生控制按钮（PlayerControlSlotButton）：圆形、无描边、常态低透明度，
 * 悬停给一层淡淡的自适应底色，开启态用更浓的同色底表示——不画蓝框，免得在播放条上像贴上去的 chip。
 * 底色一律用 color-mix(currentColor …) 而不是写死白色：深色主题下等于白底，
 * 浅色主题下自动变成黑底，和宿主 bg-white/10 与 bg-black/5 的做法一致。
 */
.lyric-widget-toggle {
    all: unset;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    margin: 0 2px;
    border: none;
    border-radius: 50%;
    /* 挂载容器是 all: initial，inherit 会落到系统默认字体；这里写明和悬浮窗页面同一套字体栈。 */
    font-family: 'Microsoft YaHei UI', 'PingFang SC', 'Noto Sans CJK SC', system-ui, sans-serif;
    font-size: 12px;
    /* 500 而不是 600：汉字在这个尺寸上笔画密，压粗会糊成一团，和旁边线性图标的重量也对不上。 */
    font-weight: 500;
    line-height: 1;
    letter-spacing: 0;
    color: inherit;
    cursor: pointer;
    /* 常态压到 40%：和宿主原生按钮的 opacity-40 一致，不抢进度条和时间的注意力。 */
    opacity: 0.4;
    background: transparent;
    transition: opacity 0.15s ease, background-color 0.15s ease, transform 0.15s ease;
}
.lyric-widget-toggle:hover {
    opacity: 1;
    background: color-mix(in srgb, currentColor 10%, transparent);
}
.lyric-widget-toggle:active { transform: scale(0.94); }
.lyric-widget-toggle:focus-visible { outline: 2px solid color-mix(in srgb, currentColor 70%, transparent); outline-offset: 1px; }
/* 开（悬浮窗正在显示）：同色底加浓到 20%，字保持继承色，不用彩色强调。 */
.lyric-widget-toggle[data-on="true"] {
    background: color-mix(in srgb, currentColor 20%, transparent);
    opacity: 1;
}
.lyric-widget-toggle[data-on="true"]:hover {
    background: color-mix(in srgb, currentColor 28%, transparent);
}
`;

/**
 * 注册播放条上的「词」按钮：位置与 enhanced-remote-widget 一致（进度条右侧、order 480）。
 * 老宿主没有 progressButtons 注册表时静默跳过，不影响悬浮窗本身。
 */
const registerWidgetToggleButton = (folium) => {
    const registry = folium.registries && folium.registries.progressButtons;
    if (!registry || typeof registry.register !== 'function') {
        debugLog('[lyric-widget] 当前 Folium 没有 progressButtons 注册表，播放条上不放「词」按钮');
        return null;
    }
    const style = document.createElement('style');
    style.textContent = WIDGET_BUTTON_CSS;
    // 不能直接挂 document.head：宿主把按钮挂进 shadow root（progress.tsx 给 FoliumMountHost 传了 shadow），
    // 外层样式表进不去，按钮会退化成浏览器默认的「白底黑字方框」。样式跟着按钮所在的根节点走。
    const mountStyle = (root) => {
        const target = root && typeof root.appendChild === 'function' ? root : document.head;
        if (style.parentNode === target) return;
        if (style.parentNode) style.parentNode.removeChild(style);
        target.appendChild(style);
    };
    let button = null;
    // 先把状态记在模块里：mount 之前收到的主进程事件不会丢，按钮一挂上就按最新状态高亮。
    let visible = false;
    const paint = () => {
        if (!button) return;
        const on = visible === true;
        button.dataset.on = on ? 'true' : 'false';
        button.setAttribute('aria-pressed', on ? 'true' : 'false');
        const label = on ? '隐藏悬浮歌词' : '显示悬浮歌词';
        button.setAttribute('aria-label', label);
        button.setAttribute('title', label);
    };
    const setVisible = (on) => {
        visible = on === true;
        paint();
    };
    const handle = registry.register({
        id: WIDGET_BUTTON_ID,
        slot: 'progress.trailing',
        order: 480,
        // 收起态（鼠标离开控制条后那条窄胶囊）不挂载：那时按钮本来也基本点不到，
        // 留着只会在一片低对比的时间/进度里显得突出。展开态和 Lattice 里照常出现。
        hideWhenCollapsed: true,
        mount: (container) => {
            // 先按容器所在的根节点（shadow root / document）挂样式，再塞按钮，避免首帧白屏方框。
            try {
                mountStyle(container.getRootNode ? container.getRootNode() : null);
            } catch (error) {
                mountStyle(null);
            }
            container.innerHTML = WIDGET_BUTTON_HTML;
            button = container.querySelector('.lyric-widget-toggle');
            if (!button) return;
            paint();
            button.addEventListener('click', (event) => {
                // 宿主会把点击留在按钮容器里（progress.tsx 的 keepClickInside），这里只兜一层。
                event.stopPropagation();
                // 先本地翻转给即时反馈，主进程随后推回的 widget-visibility 再对齐真实状态。
                const before = visible;
                setVisible(!before);
                let pending = null;
                try {
                    pending = folium.rpc.call(RPC_TOGGLE_WIDGET);
                } catch (error) {
                    // rpc.call 同步抛错（宿主没加载、热重载瞬间）：把状态拨回点击前，别停在错的高亮上。
                    folium.log.warn('[lyric-widget] 切换悬浮窗失败', error);
                    setVisible(before);
                    return;
                }
                // 兼容同步返回和 Promise 两种宿主实现（宿主返回 Promise，但同步值也不该被吞）。
                Promise.resolve(pending).then((result) => {
                    if (result && typeof result.visible === 'boolean') setVisible(result.visible);
                }, (error) => {
                    folium.log.warn('[lyric-widget] 切换悬浮窗失败', error);
                    // 失败回到点击前的值（不是再翻一次：翻转后的值可能已经被别处改过）。
                    setVisible(before);
                });
            });
        },
    });
    /**
     * dispose：卸载时把注入的 <style> 和注册项一起收回，免得热重载一轮就在 <head> 里堆一份。
     */
    const dispose = () => {
        try {
            if (handle && typeof handle.unregister === 'function') handle.unregister();
        } catch (error) {
            // 宿主已经整体回收过注册表了，这里失败无所谓。
        }
        if (style.parentNode) style.parentNode.removeChild(style);
        button = null;
    };
    return {
        setVisible,
        dispose,
    };
};

/**
 * 1.5.0：模组设置表单（设置 → 高级 → 模组 → 展开「独立悬浮歌词」）。
 *
 * 设置值由宿主持久化（FoliumSettingAccess 读写宿主的 params 存储），这里只做三件事：
 * 声明表单、读值、把值推给 main.cjs。窗口高度、CSS 变量都在主进程/窗口页面里算，
 * client 不持有第二份真相，避免两边各存一份配置后互相覆盖。
 */
const RPC_CONFIG = 'config';
const RPC_TOGGLE_PIN = 'toggle-pin';
// 1.6.0：形态切换（桌面歌词 / 悬浮窗歌词），带 { surface } 指定，不带就来回复制。
const RPC_SET_SURFACE = 'set-surface';
// Folium 1.6 没有 api.rpc.send：主进程把消息排队，由这里轮询取走。
const RPC_TAKE_COMMANDS = 'take-commands';

const SETTINGS_SECTION_ID = 'lyric-widget';
const FONT_SIZE_MIN = 20;
const FONT_SIZE_MAX = 50;
const FONT_SIZE_DEFAULT = 38;

// 宿主的所有文案都是语言映射（FoliumLabel = Record<language, string>），
// 直接传字符串会被 sanitize 整条丢掉、界面回落到 key 名，所以统一走这个 helper。
const L = (zh, en) => ({ 'zh-CN': zh, en });

// 20–50 逐级下拉：用户要的是「一格一字号」，不用滑块（滑块很难精确停在 38）。
const FONT_SIZE_OPTIONS = Array.from({ length: FONT_SIZE_MAX - FONT_SIZE_MIN + 1 }, (_, offset) => {
    const size = FONT_SIZE_MIN + offset;
    return {
        value: String(size),
        label: size === FONT_SIZE_DEFAULT ? L(size + '（默认）', size + ' (default)') : L(String(size), String(size)),
    };
});

/** 表单定义；defaultValue 必须与 main.cjs 的 DEFAULT_CONFIG 一致（默认观感 = 1.4.2）。 */
const buildSettingsSection = () => ({
    id: SETTINGS_SECTION_ID,
    label: L('独立悬浮歌词', 'Floating lyric window'),
    description: L(
        '通用外观两种形态共用；「桌面歌词」分组只影响固定在窗口底部的这一种。',
        'Shared look applies to both surfaces; the desktop group only affects the pinned bar.',
    ),
    // 1.6.0 去掉「窗口形态」三态（双行 / 单行 / 歌词板）：单行与歌词板会让长歌词显示不全，
    // 桌面歌词固定显示原文 + 第二行（由窗口里的排版按钮决定第二行是译文还是罗马音）。
    settings: [
        {
            key: 'display',
            type: 'select',
            // 1.6.1：形态切换走原生下拉（和别的设置同一条路），不再自绘面板——
            // 一旦传 settingsPanel，宿主就整块改成自绘，11 项 schema 表单反而不渲染了。
            label: L('显示形态', 'Display mode'),
            description: L(
                '桌面歌词：固定在窗口底部、悬停出控制条；悬浮窗歌词：独立窗口（1.7.0 完成）。',
                'Desktop bar stays pinned at the bottom; the floating window arrives in 1.7.0.',
            ),
            group: L('通用', 'Shared'),
            defaultValue: 'desktop',
            options: [
                { value: 'desktop', label: L('桌面歌词（默认）', 'Desktop bar (default)') },
                { value: 'window', label: L('悬浮窗歌词', 'Floating window') },
            ],
        },
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
            key: 'karaoke',
            type: 'boolean',
            label: L('逐字歌词（已唱染色 / 未唱变淡）', 'Word-by-word karaoke'),
            description: L(
                '需要歌词自带逐字时间；没有逐字时间的行仍按整行显示。',
                'Needs word-level timing; lines without it are still shown as a whole.',
            ),
            group: L('通用', 'Shared'),
            defaultValue: false,
        },
        {
            key: 'fontMode',
            type: 'select',
            // 分组标题叫「通用」，这一项自己说明选的是什么字体，不会出现上下两行同名。
            label: L('字体来源', 'Font source'),
            description: L(
                '「跟随主题字体」用播放器当前主题解析出的字体栈；以后新增字体只在这一个下拉里扩展。',
                '"Theme" follows the player theme font stack; more fonts only need a new option here.',
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
            description: L(
                '仅对深色底色生效，0.2–1.0。',
                'Dark backgrounds only, 0.2-1.0.',
            ),
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
            key: 'sungColor',
            type: 'color',
            label: L('已唱字色', 'Sung word color'),
            description: L(
                '逐字歌词开启时，唱过的字用这个颜色。',
                'Color of words already sung when karaoke is on.',
            ),
            group: L('通用', 'Shared'),
            defaultValue: '#7dd3fc',
        },
        {
            key: 'unsungOpacity',
            type: 'number',
            label: L('未唱字不透明度', 'Unsung word opacity'),
            description: L(
                '逐字歌词开启时，没唱到的字的透明度，0.2–1.0（越小越淡）。',
                'Opacity of words not sung yet, 0.2-1.0 (lower is fainter).',
            ),
            group: L('通用', 'Shared'),
            defaultValue: 1,
            min: 0.2,
            max: 1,
            step: 0.05,
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
            label: L('长句滚动显示', 'Scroll long lines'),
            description: L(
                '一句放不下时保持原字号、向左滚动露出后半段（跟着本句剩余时间调速）；关掉后按原字号裁掉超出部分。',
                'Long lines keep their size and scroll left; when off, the overflow is clipped.',
            ),
            group: L('桌面歌词', 'Desktop bar'),
            defaultValue: true,
        },
    ],
});

/**
 * 读当前设置并收窄成 main.cjs 认识的配置对象（1.6.0 起是三段结构：shared / desktop / window）；
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
            display: values.display === 'window' ? 'window' : 'desktop',
            fontSize: toNumber(values.fontSize, FONT_SIZE_DEFAULT),
            karaoke: values.karaoke === true,
            fontMode: values.fontMode,
            surface: values.surface,
            surfaceOpacity: toNumber(values.surfaceOpacity, 0.58),
            radius: toNumber(values.radius, 16),
            // 布尔项没写过时是 undefined，按「默认开」处理；只有明确 false 才算关。
            border: values.border !== false,
            sungColor: values.sungColor,
            unsungOpacity: toNumber(values.unsungOpacity, 1),
            pausedDim: values.pausedDim === true,
            backdrop: values.backdrop === true,
        },
        desktop: {
            marquee: values.marquee !== false,
        },
        window: {},
    };
};

/**
 * 主进程在别处（窗口里的切换键、命令面板）改了形态时，把设置面板的下拉对齐。
 * 设置项是宿主持久化的，所以这里改它、而不是只在内存里记一份，避免下次打开面板又跳回旧值。
 */
const applySurfaceToSettings = (handle, surface) => {
    if (surface !== 'desktop' && surface !== 'window') return;
    if (!handle || !handle.settings || typeof handle.settings.set !== 'function') return;
    try {
        const values = handle.settings.get() || {};
        if (values.display === surface) return;
        handle.settings.set({ display: surface });
    } catch (error) {
        debugLog('[lyric-widget] 同步显示形态到设置面板失败', error);
    }
};

/**
 * 注册设置表单并在每次改动后把配置推给主进程。
 * 返回值里的 push 同时用于激活时的首帧下发（此时宿主可能还没恢复完设置值）。
 */
const registerSettingsSection = (folium) => {
    const registry = folium.registries && folium.registries.settingsSections;
    if (!registry || typeof registry.register !== 'function') {
        debugLog('[lyric-widget] 当前 Folium 没有 settingsSections 注册表，跳过设置表单');
        return null;
    }
    const section = buildSettingsSection();
    // 连续操作（拖不透明度滑块、来回切形态）会一次刷出很多 onChange：
    // 每条都立刻推给主进程的话，主进程会连着 setSize / 重发配置，窗口跟着抖。
    // 这里合并成「最后一次为准」，60ms 后统一推一次。
    let pushTimer = null;
    const pushNow = () => {
        const config = readConfigFromHandle(handle);
        if (!config) return;
        if (!folium.rpc || typeof folium.rpc.call !== 'function') return;
        try {
            // 主进程会做一次 normalizeConfig，坏值在那里回落默认，这里不用重复校验。
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
            id: SETTINGS_SECTION_ID,
            label: section.label,
            description: section.description,
            settings: section.settings,
        });
    } catch (error) {
        folium.log.warn('[lyric-widget] 注册模组设置失败（悬浮窗仍用默认样式）', error);
        return null;
    }
    // 外部（窗口里的切换键 / 命令面板）改了形态时，设置面板的下拉也要跟着走。
    const applySurface = (surface) => applySurfaceToSettings(handle, surface);
    let offChange = null;
    try {
        if (handle && handle.settings && typeof handle.settings.onChange === 'function') {
            offChange = handle.settings.onChange(() => push());
        }
    } catch (error) {
        folium.log.warn('[lyric-widget] 订阅模组设置变化失败', error);
    }
    // 激活即下发一次：宿主的设置可能在模组加载前就有值（重启后恢复），窗口不能停在默认样式。
    // 这一发不走防抖：窗口起来之前就要拿到配置，晚 60ms 会先按默认尺寸闪一下。
    pushNow();
    return {
        handle,
        push,
        applySurface,
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
 * 1.5.0：命令面板入口（模组页同一块 surface 上也能直接运行）。
 * 全局快捷键只有 Folium 1.7+ 的 commands.register 支持，1.6 上只注册命令本身。
 */
const registerWidgetCommands = (folium, settings) => {
    const registry = folium.registries && folium.registries.commands;
    if (!registry || typeof registry.register !== 'function') {
        debugLog('[lyric-widget] 当前 Folium 没有 commands 注册表，跳过命令');
        return [];
    }
    const minor = (folium.host && folium.host.folium && folium.host.folium.minor) || 0;
    const handles = [];
    const callMain = (method) => {
        try {
            Promise.resolve(folium.rpc.call(method)).catch(() => {
                // 主进程可能还没激活完，命令失败不弹错误（面板会显示失败，用户可重试）。
            });
        } catch (error) {
            folium.log.warn('[lyric-widget] 执行命令失败', error);
        }
    };
    // 字号 ±1：直接改宿主里的设置值，onChange 会带着新配置推给主进程并触发窗口重算。
    const stepFontSize = (delta) => {
        if (!settings || !settings.handle || !settings.handle.settings) return;
        const current = readConfigFromHandle(settings.handle);
        if (!current) return;
        const currentSize = Math.round(current.shared.fontSize);
        const next = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, currentSize + delta));
        if (next === currentSize) return;
        try {
            settings.handle.settings.set({ fontSize: String(next) });
        } catch (error) {
            folium.log.warn('[lyric-widget] 调整字号失败', error);
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
        description: L(
            '和播放控制条上的「词」按钮同一个开关。',
            'Same switch as the 词 button on the player bar.',
        ),
        keywords: ['歌词', '桌面歌词', '悬浮窗', 'widget', 'lyric'],
        run: () => callMain(RPC_TOGGLE_WIDGET),
    });
    add({
        id: 'lyric-widget-pin',
        label: L('桌面歌词：锁定 / 解锁位置', 'Floating lyrics: lock / unlock'),
        description: L(
            '和悬浮窗正中的图钉按钮同一套状态。',
            'Same state as the pin button in the middle of the window.',
        ),
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
    // 1.6.0：形态切换。和设置面板顶部的分段控件、窗口控制条上的切换键同一个开关。
    add({
        id: 'lyric-widget-switch-surface',
        label: L('歌词：切换桌面歌词 / 悬浮窗歌词', 'Lyrics: switch desktop / window surface'),
        description: L(
            '两种形态互斥显示；悬浮窗歌词在 1.7.0 才填视图，现在切过去只是把桌面歌词藏起来。',
            'The two surfaces are exclusive; the window view ships in 1.7.0.',
        ),
        keywords: ['歌词', '形态', '悬浮窗歌词', '桌面歌词', 'surface', 'switch'],
        run: () => callMain(RPC_SET_SURFACE),
    });
    return handles;
};

/**
 * Folium 1.6 兼容：没有 folium.rpc.on，主进程的消息只能靠轮询 take-commands 取回。
 * 返回 null 表示不需要轮询（1.7+ 有事件通道，或有更老宿主连 rpc.call 都没有）。
 */
const startCommandPolling = (folium, engine, onMessage) => {
    if (typeof folium.every !== 'function') return null;
    const tick = () => {
        let pending = null;
        try {
            pending = folium.rpc.call(RPC_TAKE_COMMANDS);
        } catch (error) {
            return;
        }
        Promise.resolve(pending).then((list) => {
            if (!Array.isArray(list) || list.length === 0) return;
            for (const item of list) {
                if (!item || typeof item.kind !== 'string') continue;
                try {
                    onMessage(item);
                } catch (error) {
                    folium.log.warn('[lyric-widget] 处理主进程排队消息失败', error);
                }
            }
        }, () => {
            // 老主进程没有这个 handle：静默跳过，不影响数据推送。
        });
    };
    return folium.every(150, tick);
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

    // 1.4.0：播放条上的「词」开关。主进程推可见性时刷新高亮；注册失败（老宿主）不影响悬浮窗。
    // 注意：下面几条 early return 不返回 disposer，注册项与监听靠宿主卸载时统一回收
    // （clientLoader 的 unregisterAll + scope.end 的 onRelease），不会带到下一次激活。
    let widgetButton = null;
    let offWidgetVisibility = null;
    try {
        widgetButton = registerWidgetToggleButton(folium);
    } catch (error) {
        folium.log.warn('[lyric-widget] 注册播放条开关失败（悬浮窗本身不受影响）', error);
    }
    // 设置分区稍后才注册；这里先声明，好让可见性消息顺手把形态同步过去。
    let settingsSection = null;
    if (widgetButton && engine.canReceiveActions && typeof folium.rpc.on === 'function') {
        offWidgetVisibility = folium.rpc.on(RPC_WIDGET_VISIBILITY, (payload) => {
            if (payload && typeof payload.visible === 'boolean') widgetButton.setVisible(payload.visible);
            // 1.6.1：形态可能在窗口里的切换键 / 命令面板被改掉，同步到设置面板的下拉。
            if (payload && typeof payload.surface === 'string' && settingsSection) {
                settingsSection.applySurface(payload.surface);
            }
        });
    }
    // 补一次现状放到下面 main 上下文里做（导出窗口不该去问状态，也不该抽走主进程的队列）。

    // 1.5.0：模组设置表单（字号 / 形态 / 逐字 / 字体 / 外观）。设置值由宿主持久化，
    // 每次改动推给主进程；窗口高度与页面 CSS 变量都由这份配置驱动。
    try {
        settingsSection = registerSettingsSection(folium);
    } catch (error) {
        folium.log.warn('[lyric-widget] 注册模组设置失败（悬浮窗仍用默认样式）', error);
    }
    // 命令面板入口（显示/隐藏、锁定/解锁、字号 ±）。老宿主没有 commands 注册表时返回空数组。
    let commandHandles = [];
    try {
        commandHandles = registerWidgetCommands(folium, settingsSection);
    } catch (error) {
        folium.log.warn('[lyric-widget] 注册命令失败', error);
    }
    // Folium 1.6 兼容的轮询在下面判断完上下文再启动：主进程只在自己的窗口里存在，
    // 导出窗口去轮询会白白取走队列里的消息。
    let stopCommandPolling = null;
    const startPolling = () => {
        if (stopCommandPolling || !engine.canReport) return;
        try {
            stopCommandPolling = startCommandPolling(folium, engine, (item) => {
                if (item.kind === 'action') {
                    engine.handleActionMessage(item.payload);
                    return;
                }
                if (item.kind === 'widget-visibility' && widgetButton && item.payload
                    && typeof item.payload.visible === 'boolean') {
                    widgetButton.setVisible(item.payload.visible);
                }
            });
        } catch (error) {
            folium.log.warn('[lyric-widget] 启动兼容轮询失败', error);
        }
    };

    if (!engine.canReport) {
        folium.log.warn('[lyric-widget] 当前 Folium 版本没有 folium.rpc.call（需要 1.6+），悬浮窗收不到数据');
        return;
    }

    // 导出窗口里没有播放页：不轮询、不搬数据。
    if (folium.env.context !== 'main') {
        debugLog('[lyric-widget] 非 main 上下文，不同步');
        return;
    }

    // 补一次现状：主进程的首次推送可能早于本模组激活（那时没有监听者），不主动问就会一直显示成「关」。
    // 顺带用返回值里的 canSend 决定要不要起 1.6 的队列轮询——这是主进程的真实能力，
    // 比「有没有 rpc.on」更可靠（两者是两条独立的推断）。
    if (engine.canReport && typeof folium.rpc.call === 'function') {
        try {
            Promise.resolve(folium.rpc.call(RPC_WIDGET_STATE)).then((result) => {
                if (result && typeof result.visible === 'boolean' && widgetButton) {
                    widgetButton.setVisible(result.visible);
                }
                // 1.6.0：设置卡片顶部的分段控件也要对齐主进程那边的真实形态。
                if (result && typeof result.surface === 'string' && settingsSection) {
                    settingsSection.applySurface(result.surface);
                }
                if (result && result.canSend === false) startPolling();
            }, () => {
                // 老版本主进程没有这个 handle：退回按 rpc.on 是否存在判断。
                if (typeof folium.rpc.on !== 'function') startPolling();
            });
        } catch (error) {
            if (typeof folium.rpc.on !== 'function') startPolling();
            folium.log.warn('[lyric-widget] 读取悬浮窗开关状态失败', error);
        }
    } else if (typeof folium.rpc.on !== 'function') {
        startPolling();
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
        // 兼容轮询（1.6）先停，免得停用过程中再取到一批指令。
        if (stopCommandPolling) {
            try {
                stopCommandPolling();
            } catch (error) {
                folium.log.warn('[lyric-widget] 停止兼容轮询失败', error);
            }
            stopCommandPolling = null;
        }
        // 命令与设置表：宿主卸载时也会统一回收，这里显式收回一次（热重载时更干净）。
        for (const commandHandle of commandHandles) {
            try {
                if (commandHandle && typeof commandHandle.unregister === 'function') commandHandle.unregister();
            } catch (error) {
                // 宿主已经整体回收过，忽略。
            }
        }
        commandHandles = [];
        if (settingsSection) {
            try {
                settingsSection.dispose();
            } catch (error) {
                folium.log.warn('[lyric-widget] 回收模组设置失败', error);
            }
            settingsSection = null;
        }
        // 「词」按钮的可见性订阅（宿主撤下注册项时容器 DOM 自己也走了，这里只退订阅）。
        if (offWidgetVisibility) {
            try {
                offWidgetVisibility();
            } catch (error) {
                folium.log.warn('[lyric-widget] 退订悬浮窗可见性失败', error);
            }
            offWidgetVisibility = null;
        }
        // 「词」按钮：退订阅之外，注册项和注入的 <style> 也一起收回（别人可能还拿着这个实例）。
        if (widgetButton) {
            try {
                widgetButton.dispose();
            } catch (error) {
                folium.log.warn('[lyric-widget] 回收播放条开关失败', error);
            }
            widgetButton = null;
        }
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
