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
 *       index,                 // getLineIndex() 的结果；-1 表示没有当前行（句间保留上一句时同样是 -1）
 *       text,                  // 没有当前行时保留最近一句（含最后一句结束后）；连最近一句都没有（第一句开始前 / 无歌词）时是「等待播放...」
 *       translation: string | null,
 *       romanization: string | null,
 *       words: null,           // 逐字 / 卡拉 OK 预留字段，当前恒为 null
 *       startTime: number | null,
 *       endTime: number | null,
 *     },
 *     theme: {
 *       name, isDaylight, backgroundColor, primaryColor, accentColor, secondaryColor,
 *       fontStyle, fontStack,  // fontStack 是可直接写进 CSS 的 font-family
 *     },
 *   }
 *
 * action 形状（main.cjs 用 api.rpc.send('action', ...) 发来）：
 *   { action: 'next' } | { action: 'prev' } | { action: 'toggle' }
 *   | { action: 'set-volume', volume: 0–1 }
 *   | { action: 'set-loop', mode: 'off' | 'all' | 'one' }
 *   | { action: 'request-sync' }   // 主进程窗口刚打开、错过之前的快照时，强制重发一次
 *
 * 约定：
 *   - 快照里不含 song.ref：ref 只在当前渲染会话有效，主进程存下来会失效；跨歌用 source + id。
 *   - 真正的悬浮窗由 main.cjs 创建；这个 visualizer 被选中只是启动同步，不占画面。
 *   - getLineIndex() 在两句之间返回 -1，此时用 folium.lyrics.getRecentCompletedLine 保留上一句；
 *     连上一句都没有（如歌曲还没开始）时才发「等待播放...」。
 *   - 宿主会在歌词异步到达、换歌、静态模式每句等时机重新挂载；播放会话跨挂载复用，主进程只在
 *     playSessionId 真正变化时重置进度。静态模式（主题设置）只停背景动画，播放继续，照常同步。
 */

const RPC_UPDATE = 'update-data';
const RPC_ACTION = 'action';
const ACTION_REQUEST_SYNC = 'request-sync';
const WAITING_LINE_TEXT = '等待播放...';
const LOOP_MODES = ['off', 'all', 'one'];

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

/** 当前歌词行；两句之间保留上一句，只有上一句也没有（如歌曲还没开始）时才给「等待播放...」。 */
const readLine = (folium, ctx) => {
    const index = ctx.getLineIndex();
    // 句间 getLineIndex() 为 -1：让宿主找出最后一句已结束的歌词，避免主进程窗口每句间隙闪一次等待文案。
    const line = index >= 0
        ? ctx.lines[index]
        : folium.lyrics.getRecentCompletedLine(ctx.lines, index, ctx.lyricTime.get());
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

/** 主题色与字体；fontStack 由宿主解析好，主进程可以直接写进 CSS 的 font-family。 */
const readTheme = (folium, ctx) => {
    const theme = ctx.getTheme();
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

/** 整份快照：主进程每次都收到完整数据，不用自己合并局部更新。 */
const buildPayload = (folium, ctx, playSessionId) => {
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
        line: readLine(folium, ctx),
        theme: readTheme(folium, ctx),
    };
};

/** 根据当前播放状态决定 playSessionId 要不要换新；挂载和播放事件都走这里。 */
const refreshPlaySession = (folium, session) => {
    const playback = folium.playback.getState();
    const songKey = getSongKey(playback.song);

    if (session.songKey === null) {
        // 首次挂载：只记基线，沿用 activate 里生成的那个 id。
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
 * 挂载：这个样式不画任何东西，mount 只负责开始同步、卸载时停止。
 * 宿主会在歌曲 / 歌词数据 / staticMode 变化时重新挂载，所以每次挂载都先对齐会话、再发一份完整快照。
 */
const mountLyricWidget = (folium, session, ctx) => {
    // 导出窗口、设置里的预览不是真实播放，不搬数据。导出窗口里的注册仍要照常保留（否则导出会报错停下）。
    // 静态模式只是主题设置里「禁用几何背景」的选项，播放继续，仍需同步；它会让宿主每句重新挂载，
    // 会话状态在 activate 作用域里，id 不会因此变化。
    if (folium.env.context !== 'main' || ctx.isPreview) return;

    let lastSentKey = '';
    let reportedFailure = false;

    // rpc 是 Folium 1.7 才有的：老宿主上别让整个歌词样式因为取不到成员而挂掉。
    const canReport = Boolean(folium.rpc && typeof folium.rpc.call === 'function');
    const canReceiveActions = canReport && typeof folium.rpc.on === 'function';
    if (!canReport) {
        folium.log.warn('[lyric-widget] 当前 Folium 版本没有 folium.rpc.call（需要 1.7+），悬浮窗收不到数据');
    } else if (!canReceiveActions) {
        folium.log.warn('[lyric-widget] 当前 Folium 版本没有 folium.rpc.on（需要 1.7+），悬浮窗的按钮/滑块会无效');
    }

    const syncData = (force = false) => {
        if (!canReport) return;
        const payload = buildPayload(folium, ctx, session.id);
        // 一次变化可能同时触发多个监听，内容相同的快照不必重复发；request-sync 强制重发。
        const key = JSON.stringify(payload);
        if (!force && key === lastSentKey) return;
        lastSentKey = key;
        folium.rpc.call(RPC_UPDATE, payload).catch((error) => {
            // main.cjs 还没注册 update-data 时这里会失败（rpc-not-found）：清掉去重键让下次重试，
            // 并且每个挂载周期只报一次，免得每次状态变化都刷日志。
            lastSentKey = '';
            if (reportedFailure) return;
            reportedFailure = true;
            folium.log.warn(
                '[lyric-widget] 发送 update-data 失败，确认 main.cjs 已注册 api.rpc.handle("update-data", ...)',
                error,
            );
        });
    };

    /** 播放状态 / 歌曲发生变化：先决定是否换播放会话，再发新快照。 */
    const refreshAndSync = () => {
        refreshPlaySession(folium, session);
        syncData();
    };

    /** request-sync 需要绕过内容去重强制重发，其余指令交给 handleAction。 */
    const handleActionMessage = (message) => {
        if (message && typeof message === 'object' && message.action === ACTION_REQUEST_SYNC) {
            syncData(true);
            return;
        }
        handleAction(folium, message);
    };

    const disposers = [
        ctx.onChange(() => syncData()),
        folium.events.on('playback.songChanged', refreshAndSync),
        folium.events.on('playback.stateChanged', refreshAndSync),
        folium.events.on('playback.volumeChanged', () => syncData()),
        folium.events.on('playback.loopModeChanged', () => syncData()),
        folium.events.on('playback.likeChanged', () => syncData()),
        folium.events.on('playback.seeked', () => syncData()),
    ];
    // 先登记 action 监听再发第一份数据，避免主进程刚发出的指令被丢掉。
    if (canReceiveActions) disposers.unshift(folium.rpc.on(RPC_ACTION, handleActionMessage));

    // 挂载即对齐会话并发一次：主进程不用等到下一次播放事件才知道当前状态。
    refreshAndSync();

    // 卸载（切样式、换歌重新挂载、模组停止）时只撤监听，不再发消息：
    // 换歌也会走卸载，发一条「已停用」会让主进程误以为用户关掉了悬浮窗。
    return () => {
        for (const dispose of disposers) {
            try {
                dispose();
            } catch (error) {
                folium.log.warn('[lyric-widget] 卸载监听时出错', error);
            }
        }
    };
};

export default function activate(folium) {
    // 播放会话跨挂载复用：宿主会因歌词异步到达、换歌、静态模式每句等原因重新挂载。
    const session = createPlaySession();

    folium.registries.visualizers.register({
        id: 'lyric-widget',
        label: { 'zh-CN': '悬浮歌词', en: 'Floating Lyrics' },
        // container 不使用：界面在主进程开的窗口里。
        mount: (container, ctx) => mountLyricWidget(folium, session, ctx),
    });
}
