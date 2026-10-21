/**
 * Auto-continue engine — host half core (single instance).
 *
 * Runs inside the dsh host process, so there is exactly ONE engine regardless
 * of how many browser tabs are open — the multi-tab duplicate-send class of
 * bugs (issue #13) cannot exist by construction. Listens to the session event
 * firehose (`session/event`), sends through the agent registry
 * (`agent.followup`), cancels through `agent.cancel`, and reads configuration
 * injected by the entry (`apply`'s config argument, merged with schema
 * defaults by `resolveConfig`).
 *
 * All behavior is driven by the `auto-continue` entry config; every knob below
 * is user-configurable there.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import { type AutoContinueConfig, type DayStats, type NotifyAction } from '../shared/core.ts';
/** 通知桥事件: host 引擎产生, browser 侧订阅展示(Notification / 动作按钮)。 */
export interface HostNotice {
    /** 稳定标识(供 browser 去重)。 */
    id: string;
    title: string;
    body: string;
    /** 会话 id(通知按钮「立即续跑 / 暂停该会话」作用于它)。 */
    sessionId: SessionId;
    actions: NotifyAction[];
    /** 产生时间。 */
    at: number;
}
/** 插件主体: 一条 mux 流 + 一条 host 流 + 启动/重连扫描。 */
export declare class AutoContinueRunner {
    private readonly ctx;
    private readonly getConfig;
    private readonly states;
    private readonly pauseUntil;
    private dayStats;
    private readonly notices;
    private readonly noticeListeners;
    private readonly stateListeners;
    private readonly prioritizedFollowups;
    private readonly disposeSessionEvents;
    private readonly disposeInboxEvents;
    private disposed;
    private readonly bootScannedSessions;
    private bootScanTimer;
    private wakeBootScan;
    /** Persisted sessions are enumerated once per boot, after the service is available. */
    private persistedEnumerated;
    private readonly persistedDecided;
    /** Eligible persisted sessions not yet resumed, newest activity first. */
    private persistedQueue;
    /** The single in-flight list() call. A stalled call is awaited again on later passes, never repeated. */
    private persistedListing;
    /** The single background loader pass in flight. */
    private persistedRun;
    /** Boot window end, set when bootScanLoop starts. Zero until then, so the loader starts no host call. */
    private bootDeadline;
    /** Ids the loader asked the host to resume. Their agents take only the scanLimit slots live candidates leave. */
    private readonly persistedLoaded;
    /** Loader-resumed agents by id until the boot scan exits. Released there if the scanner never classified them. */
    private readonly persistedHandles;
    /**
     * @param ctx - host plugin context (agents registry, session events).
     * @param getConfig - read the current resolved configuration (entry config).
     */
    constructor(ctx: Context, getConfig: () => AutoContinueConfig);
    private log;
    /** 对外(状态桥): 今日统计快照。 */
    todayStats(): DayStats;
    /** 对外(状态桥): 当前生效的会话级暂停列表。 */
    activePauses(): {
        sessionId: SessionId;
        until: number;
    }[];
    /** 对外(状态桥): 订阅通知事件(SSE 端点推送)。 */
    subscribeNotices(listener: () => void): () => void;
    /** 对外(状态桥): 订阅运行时状态变化(统计/暂停列表)。 */
    subscribeState(listener: () => void): () => void;
    private emitState;
    /** 对外(状态桥): 消费待展示的通知。 */
    drainNotices(): HostNotice[];
    /** 通知动作(browser 通知按钮回传): 立即续跑 / 暂停该会话 / 解除暂停 / 清零统计。 */
    handleNoticeAction(sessionId: SessionId | undefined, action: string): void;
    dispose(): void;
    private state;
    /** Mark a child session and clear queued grace/cooldown sends. */
    private markSubagent;
    /** Read durable origin from the live agent for direct action paths as well. */
    private isSubagent;
    /**
     * 事件入口(host 单实例): 预处理工具调用/结果/模型消息(护栏与循环信号),
     * 然后交给回合状态机。
     */
    private onHostEvent;
    private tracksOutput;
    /** Treat unknown block kinds conservatively: only reasoning and blank text are silent. */
    private hasVisibleContent;
    /** 从 assistant/message 事件提取纯文本。 */
    private assistantText;
    private assistantChunkText;
    private normalizedSegment;
    private isNearDuplicateSegment;
    private withinEditDistance;
    private noteStreamSegment;
    private onAssistantChunk;
    private onAssistantMessage;
    /** 两个循环信号的公共检查; 命中且本回合未打断过则打断。 */
    private checkLoop;
    /**
     * 打断运行中的回合: cancel(带来源标记)+ 进冷却。
     * 只有随后持久化的 turn/end 精确携带专属 hook cause 时,
     * 才会用 loopText 重启回合——DSH 的 first-cause 语义保证用户 Stop 优先。
     */
    private interruptLoop;
    private onSessionEvent;
    private onTurnFailure;
    /** 通知操作按钮与回调(「立即续跑」/「暂停该会话 1 小时」)。 */
    private notifyOptions;
    private onNotifyAction;
    /** 内存统计(host 单实例): 按今日桶累计。 */
    private bumpStat;
    /** 通知桥: 产生一条通知事件, SSE 端点推给 browser 侧展示。 */
    private notify;
    /** 恢复结果记账: 自动发送后窗口内的回合结束, 判定恢复成功或失败。 */
    private noteRecovery;
    /** 立即为该会话发送一次自动继续(无视冷却与连续上限; 由通知按钮触发)。 */
    resumeNow(sessionId: SessionId): Promise<void>;
    /** 本会话当前生效的冷却间隔(自适应退避)。 */
    private cooldownFor;
    private schedule;
    /**
     * 冷却期内的恢复: 等到冷却结束再重新调度。
     * 直接丢弃会让一次瞬时失败把会话搁置, 直到用户手动发消息才恢复。
     */
    private deferCooldownRetry;
    /** 按调度原因选择续跑模板: loop 重启、无输出回合、max-tokens、自主循环, 其余用通用继续文本。 */
    private templateFor;
    private cancelPending;
    private fire;
    /**
     * 组装本次续跑消息: 模板填充 + 幂等护栏。
     * 护栏依据上一步工具调用的执行状态附加指引, 防止重跑副作用操作:
     * - 结果未确认(可能已部分执行)→ 提示先确认状态、不要重复执行
     * - 已确认成功 → 提示已完成、不要重复执行
     * - 已失败 → 不加护栏(重试工具本来就是目的)
     */
    private buildContinueText;
    /** 上一步工具调用的护栏状态(实时路径, 由 mux 帧维护)。 */
    private currentGuard;
    private bootScanLoop;
    /** Host calls and resumes may start only while the runner is live and the boot window is open. */
    private persistedOpen;
    /**
     * Start one background loader pass unless one is already in flight. The live scan never awaits it, so a stalled
     * host call delays only persisted loads; resumed sessions are scanned on later passes. Eligibility mirrors the
     * scanner (persistedLastActivity). Never throws: a missing service or failing call is logged and retried later.
     * A turn persisted as aborted/disposed on graceful shutdown is continued; a manual stop (aborted/user) is not.
     */
    private loadInterruptedPersisted;
    /** One background pass: enumerate once after the services exist, then resume queued sessions within scanLimit. */
    private runPersisted;
    /**
     * Enumerate once. A rejected or stalled list() leaves enumeration for a later pass. A stalled call stays in
     * flight and is awaited again rather than repeated, so at most one list() is in flight.
     */
    private enumeratePersisted;
    /** Resume at most `scanLimit` queued sessions in this pass, one awaited load at a time. */
    private resumeQueuedPersisted;
    /** Read one persisted session's history (read-only open). Stalled or unreadable histories are skipped. */
    private readPersistedEntry;
    /** Resume one persisted session through the host. A failure or stall drops it for this boot; there is no retry. */
    private resumePersisted;
    /** The resume itself: route, preset, then the host call. Runs under the call timeout. */
    private resumeEntry;
    /**
     * Release loader-resumed agents the boot scan never classified, once the scan loop has exited. No later pass can
     * classify them, so they would hold a write handle and never continue. Agents the scanner decided stay with the live
     * path, as do agents that still own work: a running turn, any timer in SessionState, or queued inbox input.
     */
    private releaseUnscannedPersisted;
    /** Inspect newly available sessions; process each settled startup history once. */
    private scanInterrupted;
    /** 从历史事件恢复上一步工具调用状态(扫描路径的幂等护栏)。 */
    private applyGuardFromEvents;
}
