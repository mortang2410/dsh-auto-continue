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
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types';
import { type AutoContinueConfig, type DayStats, type RecoveryAttempt, type NotifyAction } from '../shared/core.ts';
/** Durable cancel identity reserved for this plugin's loop guard. */
/** One model stream chunk, as carried by a session `assistant/chunk` event. */
type AssistantChunk = SessionEvent<'assistant/chunk'>['data']['chunk'];
/**
 * The live host's `agent/assistant-stream` frame, narrowed to the fields this plugin reads. The pinned
 * dsh-agent 0.1.2-rc.1 types do not declare it; the live host (dsh-agent 0.2.0-rc.2) does.
 */
type AssistantStreamFrame = {
    readonly type: 'start';
} | {
    readonly type: 'chunk';
    readonly chunk: AssistantChunk;
} | {
    readonly type: 'end';
};
declare module '@deepseek-ai/cordis' {
    interface Events {
        'agent/assistant-stream'(payload: {
            agent: Agent;
            frame: AssistantStreamFrame;
        }): void;
    }
}
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
    private readonly recoveryAttempts;
    private readonly notices;
    private readonly noticeListeners;
    private readonly stateListeners;
    private readonly prioritizedFollowups;
    private readonly disposeSessionEvents;
    private readonly disposeInboxEvents;
    /** Live channel subscription; registered only when liveStreamGuard is on (vrpe X-SUB). */
    private readonly disposeAssistantStream;
    private disposed;
    private readonly bootScannedSessions;
    /** Also bound diagnostics when even an agent's session getter is unavailable. */
    private readonly bootScanErrors;
    /** 存储扫描已裁决的会话 id, 避免每轮重复冷读大日志。 */
    private readonly storedSwept;
    /**
     * Sessions a boot path (the persisted loader or the stored sweep) has asked the host to resume. The claim is taken in the
     * same tick as the host call, and released only when that call rejects, so a failed resume can be retried by the sweep.
     * A pending, timed-out, or successful resume keeps its claim for this boot.
     */
    private readonly bootResumeClaims;
    /** 存储会话的连续观察/物化失败次数, 触达 SWEEP_MAX_FAILURES 后不再重试。 */
    private readonly storedSweepFailures;
    private storedSweepAnnounced;
    private bootScanTimer;
    private wakeBootScan;
    /** Persisted sessions are enumerated once per boot, after the service is available. */
    private persistedEnumerated;
    private readonly persistedDecided;
    /**
     * Session id to the artifact revision that failed to read, kept across restarts so a boot does not decode a log it
     * has already rejected. A repaired artifact has a new revision and is read again.
     */
    private persistedRejections;
    private persistedRejectionSave;
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
    /** Loader-resumed user sessions by id until the boot scan exits. Released there if the scanner never classified them. */
    private readonly persistedHandles;
    /** Children kept for a later attempt, by id: refused at the active-child limit, or waiting for their parent to go live. */
    private readonly waitingChildren;
    /** One pending attempt per child, scheduled from an event the plugin observed. */
    private readonly waitAttempts;
    /** Slot releases the plugin observed: agent disposals, and settled deliveries that were not admission refusals. */
    private slotReleases;
    /** Deliveries in flight. The wait ends only when no child waits and none is in flight. */
    private slotDeliveries;
    /** Disposer of the agent/disposed listener. Set while a child waits or a delivery is in flight; removed when neither holds. */
    private disposeSlotListener;
    /** Disposer of the agent/created listener. Set only while a child waits for its parent, removed with the wait. */
    private disposeParentListener;
    /** Log-only timer at the boot window end. Set while a child waits. It never sends. */
    private slotWindowTimer;
    private storedSweep;
    private readonly stopStoredSweep;
    /**
     * @param ctx - host plugin context (agents registry, session events).
     * @param getConfig - read the current resolved configuration (entry config).
     */
    constructor(ctx: Context, getConfig: () => AutoContinueConfig);
    private log;
    /** 对外(状态桥): 今日统计快照。 */
    todayStats(): DayStats;
    recentRecoveryAttempts(): RecoveryAttempt[];
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
    private sessionConfig;
    configurationChanged(): void;
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
    /** vrpe F-A2: output of one committed assistant message: visible (text or tool call), reasoning only, or none. */
    private messageOutput;
    /** 从 assistant/message 事件提取纯文本。 */
    private assistantText;
    private assistantChunkText;
    /** A chunk the user can see: visible text, a tool call, or a non-reasoning block. */
    private chunkIsVisible;
    private normalizedSegment;
    private isNearDuplicateSegment;
    private withinEditDistance;
    private noteStreamSegment;
    /**
     * Reasoning spiral in this step (vrpe). The trip and the cooldown refusal are each logged once
     * per step. While the cooldown lasts, later deltas stay silent; the first delta after it cuts.
     */
    private onReasoningSpiral;
    /**
     * Live channel (liveStreamGuard, vrpe X-SUB): one agent/assistant-stream frame. The session id is
     * payload.agent.session.id. Turn and step come only on `start` frames. A frame without a session
     * id is ignored. `start` resets the density count and the whitespace run (a retried attempt
     * regenerates the argument stream); chunks do not.
     */
    private onLiveStreamFrame;
    private onAssistantChunk;
    private onAssistantMessage;
    /**
     * Repeated reasoning-only messages, counted across turns. Visible output ends the run; a reasoning-only message
     * extends it when its normalised reasoning equals the previous one, else starts a new run; a message with no
     * content leaves the run unchanged.
     */
    private trackReasoningRepeat;
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
    /**
     * Round 4 (vrpe O2), tightened in round 5 (reviewer F1): the spiral refusal at every site, so no site can end a
     * session with a log line only. One forced resume carrying config.loopText per episode, then the stop and its
     * notice. The bound is state.spiralEscalated, and fire() sets it only when the forced resume was really delivered
     * (round 4 set it here, before any send existed, so a paused schedule or a cancelled grace timer spent the bound and
     * the next stop notice claimed a resume that never happened). While the forced attempt is queued, scheduleAttempt
     * returns on its pending timer, so a second spiral cannot queue a second send. An episode ends at a visible
     * completion or a human message, as in round 3. `site` names the refusing site, so every site keeps its own log line.
     */
    private escalateSpiral;
    /**
     * Round 4, corrected in round 5 (FIX 3, claims A4, A7, A20): whether this spiral episode was already resumed with the
     * loop text before the judged turn ended, read from the persisted events so the bound survives a restart, where
     * state.spiralEscalated does not. Two facts of the real log set the shape:
     * - order: the host writes the judged turn's `turn/start` before the plugin's `user/message` (session seq 1168 at
     *   20:54:22.601, then seq 1171 at 20:54:23.750), so the message is found by recency, not by sitting before the
     *   turn's opener;
     * - text: fire() sends buildContinueText's output, which appends config.guardPendingText or config.guardDoneText to
     *   the loop text (engine.ts:1777-1796; the recorded seq 1171 text is 210 characters for a 100 character loop text),
     *   so the message carries the loop text instead of equalling it.
     * Live, the bound clears on a visible completed turn end (engine.ts:1268-1270) or a human message (engine.ts:1362-1367).
     * The persisted read treats a visible assistant message newer than that user message as the end of the episode, so it
     * can escalate again where live would stop (a visible step inside a reasoning-only max-tokens end); it never emits a
     * stop notice for a resume that did not happen, which is the property the user ordered. See FIX.md "## Round 5".
     */
    private persistedSpiralEscalated;
    /** Round 4: the stop notice every spiral site shares. Silent unless config.notify is on, like the other notices. */
    private notifySpiralStopped;
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
    /** Round 5 (reviewer F1): true when the attempt is queued and will be sent, false when it was refused or merged. */
    private schedule;
    private scheduleAttempt;
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
     * A subagent child is included only when its own continuable descriptor lets the host continue it (persistedChildDescriptor).
     */
    private loadInterruptedPersisted;
    /** One background pass: enumerate once after the services exist, then resume queued sessions within scanLimit. */
    private runPersisted;
    /**
     * Where the rejection record lives: the DSH home this host was started with, else the default one.
     */
    private persistedRejectionPath;
    /**
     * Load the rejection record once per process. Read synchronously so a caller can decide to skip a session inside
     * a loop that must not yield: the file is small and only the first call touches disk.
     */
    private loadPersistedRejections;
    /** Persist the rejection record, coalescing bursts so one boot writes once. */
    private schedulePersistedRejectionSave;
    private savePersistedRejections;
    /** The artifact's own revision, or undefined when the backend cannot report one cheaply. */
    private persistedRevision;
    /**
     * Enumerate once. A rejected or stalled list() leaves enumeration for a later pass. A stalled call stays in
     * flight and is awaited again rather than repeated, so at most one list() is in flight.
     */
    private enumeratePersisted;
    /** Resume at most `scanLimit` queued sessions in this pass, one awaited load at a time. */
    private resumeQueuedPersisted;
    /** Read one persisted session's history (read-only open). Stalled or unreadable histories are skipped, and an
     * unreadable one at a known revision is remembered so the next boot skips it without decoding it again. */
    private readPersistedEntry;
    /** Resume one persisted session through the host. A failure or stall drops it for this boot; only a boot Continue is retried (deliverChild). */
    private resumePersisted;
    /**
     * The resume itself, under the call timeout. A user session is resumed through ctx.agents.resume. A continuable child
     * is never resumed by the plugin: it is continued through the host's subagent service (continueChild).
     */
    private resumeEntry;
    /**
     * Continue one persisted continuable child through the host's subagent service. sendMessage makes the host create the
     * child's activation, so the child reaches its parent and the parent's messages reach the child. The plugin keeps no
     * handle to the child. The child is continued only on the route it pins, and only when its own log shows that route.
     * It is continued at most once per host process. A refusal at the active-child limit delivers nothing, so the child
     * waits for a slot (see waitForSlot). A parent that a boot pass resumes but has not published yet delivers nothing
     * either, so the child waits for that parent (see deferForParent). A refusal because the child became resident
     * meanwhile (skipIfResident) also
     * delivers nothing. A child that started a turn after the listing (skipIfRunSince) is not sent Continue. Any other failure is not retried in this run. A timed-out delivery is retried once (F-4).
     */
    private continueChild;
    /** The body of continueChild. Every return path reaches its finally, so an idle wait ends there. */
    private deliverChild;
    /**
     * One Continue call under the call timeout. Each call has its own abort signal, so a timed-out call is aborted and admits
     * nothing. `onTimeout` runs synchronously when the call times out, before the outer wait can settle.
     */
    private sendContinue;
    /**
     * A Continue the host refused or failed. A refusal because the child was already resident or started a turn after the listing means a
     * parent message admitted it, so no Continue is sent and nothing is retried.
     */
    private refusedContinue;
    /**
     * A retried Continue that was refused or failed. The retry is the last attempt, so its failure is logged here, once, as an
     * error. It is not rethrown: the outer wait may already have given up, and nothing else would log it (r11, F-A).
     */
    private refusedRetry;
    /**
     * Keep a child the host refused at the active-child limit. The listener and the window timer exist while a child waits.
     * The child is not in the once-set (deliverChild removed it), so a later attempt may still deliver it. When a release
     * the plugin observed happened during the refused call (releasedDuringAttempt), the child was not in the waiting set
     * at that moment, so nothing else would wake it: it gets one attempt here. The attempt is not repeated by this path,
     * so a refusal cannot loop.
     */
    private waitForSlot;
    /**
     * Keep a child whose parent this boot pass may still publish. The boot scan resumes a parent through ctx.agents.resume,
     * and the host announces a resumed agent with agent/created (dsh-agent/lib/index.js:announce) on the same scope carrier
     * the agent/disposed listener already uses. The child waits in the same set a child refused at the active-child limit
     * uses, under the same boot-window timer, so a parent that never becomes live holds neither a listener nor a timer past
     * the window. The child is not in the once-set, so the retry may still deliver it.
     */
    private deferForParent;
    /** An agent was published. A child waiting for this exact parent gets one attempt, run after the host's publish call. */
    private onAgentCreated;
    /** The one boot-window timer. Set while any child waits; on close every waiter is dropped and logged. It never sends. */
    private ensureWaitWindow;
    /**
     * An agent was disposed. The host emits agent/disposed (dsh-agent-loop/lib/index.js:1701) before it releases the
     * disposed child's slot (dsh-subagent/lib/index.js:1250). setImmediate runs after that release, so each waiting child
     * gets one attempt then. A burst of events schedules one attempt per child.
     */
    private onAgentDisposed;
    /**
     * A slot may have freed. The count lets a refused call that is in flight notice the release (waitForSlot). Each child
     * waiting for a slot gets one attempt, run after the host's release by setImmediate. A child waiting for its parent is
     * woken by that parent's own agent/created event, not by a slot release.
     */
    private noteSlotRelease;
    /** One pending attempt per child. Called only for a child in the waiting set. */
    private scheduleWaitAttempt;
    /** One wait attempt. A refusal or a parent still absent waits again. Any other failure is logged with the child id. */
    private attemptWaiting;
    /** The boot window ended. Each child still waiting is dropped and logged with its id and the wait it was in. */
    private closeSlotWindow;
    /** The wait ends once no child waits and no delivery is in flight. Only then are the listeners and the timer released. */
    private endSlotWaitIfIdle;
    /** Remove the listeners, the pending attempts and the window timer. The caller clears the waiting set. */
    private stopSlotWait;
    /**
     * Release loader-resumed agents the boot scan never classified, once the scan loop has exited. No later pass can
     * classify them, so they would hold a write handle and never continue. Agents the scanner decided stay with the live
     * path, as do agents that still own work: a running turn, any timer in SessionState, or queued inbox input.
     */
    private releaseUnscannedPersisted;
    /** Inspect newly available sessions; process each settled startup history once. */
    private scanInterrupted;
    /** Bound cold reads even if a backend ignores cancellation; release late leases. */
    private readStored;
    /**
     * 存储扫描: 枚举持久化会话, 把尾部命中恢复谓词的未加载会话物化为
     * live agent。宿主重启后 agent 仅在客户端打开会话时才懒加载, 不物化
     * 则启动扫描永远看不到它们; 谓词与上方扫描一致, 仅失败类原因。
     */
    private sweepStoredSessions;
    /**
     * 按会话记录的 preset 组合把存储会话恢复为 live agent(镜像会话控制
     * 器的 adopt 路径: preset 挂载 + 会话已记录的模型选择回装)。模型选择
     * 以日志记录的 request-header 播种 agentOptions——{{model}}/{{provider}}
     * 提示变量与首次请求路由都读它, 驱动器还会因路由吻合而自行回装日志
     * 记录的 effort; 无落点(从未发过请求的会话)回落宿主默认。恢复时追
     * 加的合成 turn/end(`interrupted`)随后由常规扫描按既有关卡恢复。
     */
    private materializeStored;
    /** Take the boot claim for one session. False when a boot resume already owns it (pending, timed out, or succeeded). */
    private claimBootResume;
    /**
     * Await a claimed host resume. A rejection releases the claim, so the stored sweep may retry the session. A call that is
     * still pending keeps its claim, including one the loader has stopped waiting for, because a late resume may still publish.
     */
    private resumeClaimed;
    /** Captured identity only: even session.id can throw when the header is damaged. */
    private logBootScanFailure;
    /** 从历史事件恢复上一步工具调用状态(扫描路径的幂等护栏)。 */
    private applyGuardFromEvents;
}
export {};
