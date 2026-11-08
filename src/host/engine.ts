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
import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent';
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types';
import { foldRequestHeader, type Session } from '@deepseek-ai/dsh-session';
import {
  DEFAULT_CONFIG,
  RECOVERY_WINDOW_MS,
  ReasoningDensity,
  effectiveCooldown,
  emptyDayStats,
  fillTemplate,
  forgetPendingEcho,
  freshState,
  isNonHumanReason,
  isOurEcho,
  isTransientAgentError,
  isTransientFailure,
  resolveConfig,
  sessionMode,
  sleep,
  todayKey,
  trackPendingEcho,
  TOOL_ARG_GUARD,
  type AutoContinueConfig,
  type AutoContinueLocale,
  type DayStats,
  type RecoveryAttempt,
  type FailureFacts,
  type SessionState,
  type NotifyAction,
  type NotifyOptions,
  type TemplateContext,
  type ToolRepeatSignal,
} from '../shared/core.ts';

const NOTICE_COPY = {
  zh: {
    notContinuedTitle: 'dsh-auto-continue: 未自动继续',
    permanentErrorBody: (sessionId: SessionId, summary: string) =>
      `${sessionId}: 永久性错误 ${summary}，需要人工处理`,
    resumeAction: '立即续跑',
    pauseAction: '暂停该会话 1 小时',
    continuedTitle: 'dsh-auto-continue: 已自动继续',
    continuedBody: (sessionId: SessionId, text: string, count: number) =>
      `${sessionId}: 已发送「${text}」(第 ${count} 次连续)`,
    stoppedTitle: 'dsh-auto-continue: 已停止自动继续',
    stoppedBody: (sessionId: SessionId, count: number) =>
      `${sessionId}: 连续失败 ${count} 次, 需要人工介入`,
    spiralStoppedBody: (sessionId: SessionId) =>
      `${sessionId}: 推理复读: 强制续跑一次后仍无可见输出, 已停止自动继续, 需要人工介入`,
    spiralChildStoppedBody: (sessionId: SessionId) =>
      `${sessionId}: 子代理会话推理复读: 未自动续跑, 需要人工介入`,
  },
  en: {
    notContinuedTitle: 'dsh-auto-continue: Not continued',
    permanentErrorBody: (sessionId: SessionId, summary: string) =>
      `${sessionId}: Permanent error ${summary}; manual intervention required`,
    resumeAction: 'Resume now',
    pauseAction: 'Pause this session for 1 hour',
    continuedTitle: 'dsh-auto-continue: Continued automatically',
    continuedBody: (sessionId: SessionId, text: string, count: number) =>
      `${sessionId}: Sent "${text}" (consecutive attempt ${count})`,
    stoppedTitle: 'dsh-auto-continue: Auto-continue stopped',
    stoppedBody: (sessionId: SessionId, count: number) =>
      `${sessionId}: ${count} consecutive failures; manual intervention required`,
    spiralStoppedBody: (sessionId: SessionId) =>
      `${sessionId}: Reasoning loop again after one forced resume with no visible output; auto-continue stopped, manual intervention required`,
    spiralChildStoppedBody: (sessionId: SessionId) =>
      `${sessionId}: Reasoning loop in a subagent session; not continued automatically, manual intervention required`,
  },
} as const satisfies Record<AutoContinueLocale, Record<string, unknown>>;

/** Durable cancel identity reserved for this plugin's loop guard. */
/** One model stream chunk, as carried by a session `assistant/chunk` event. */
type AssistantChunk = SessionEvent<'assistant/chunk'>['data']['chunk'];

/**
 * The live host's `agent/assistant-stream` frame, narrowed to the fields this plugin reads. The pinned
 * dsh-agent 0.1.2-rc.1 types do not declare it; the live host (dsh-agent 0.2.0-rc.2) does.
 */
type AssistantStreamFrame =
  | { readonly type: 'start' }
  | { readonly type: 'chunk'; readonly chunk: AssistantChunk }
  | { readonly type: 'end' };

declare module '@deepseek-ai/cordis' {
  interface Events {
    'agent/assistant-stream'(payload: { agent: Agent; frame: AssistantStreamFrame }): void;
  }
}

const LOOP_GUARD_CANCEL_CAUSE = {
  kind: 'hook',
  reason: 'dsh-auto-continue:loop-guard',
} as const;

/**
 * Autonomous-loop resume reasons.
 * - `turn/end:completed` is a *successful* visible completion: the loop hands
 *   the thread back and the send is exempt from the failure budget.
 * - `turn/end:loop-silent` is a loop-covered turn with no visible output. The
 *   loop still continues it, but it is a failure: it must consume the retry
 *   budget and obey backoff, or a stuck model retries forever.
 * The silent reason must not end in `:silent` — `fire()` skips those when
 * silent-turn resume is off, which would stall the loop (27j).
 */
const LOOP_COMPLETED_REASON = 'turn/end:completed';
const LOOP_SILENT_REASON = 'turn/end:loop-silent';
/** Spiral escalation: one forced resume with the loop text (templateFor: `loop:` prefix). Not a loop reason, so the loop-mode gate in fire() does not apply. */
const LOOP_SPIRAL_REASON = 'loop:spiral';

/**
 * vrpe F-A3: a completed turn with no visible output whose last committed assistant message is reasoning only and has at
 * least this many reasoning units (characters of the reasoning parts) is logged, not skipped. Size no longer decides the
 * resume; the spiral signal does (state.spiralTripped). Human decision: 8000.
 */
const SILENT_REASONING_SKIP_UNITS = 8000;

/**
 * Round 4: how many committed assistant messages of the last turn the persisted spiral read feeds to the detector.
 * The live detector trips inside one step once that step has 8,000 reasoning characters, and it latches, so this
 * bound only keeps the persisted read finite; it cannot make a turn that the live path would trip stay quiet.
 */
const LOOP_SPIRAL_SCAN_MESSAGES = 32;
const MANUAL_NOTIFICATION_REASON = 'manual:notification';

/** Yield between storage batches without spending a live-scan polling interval. */
const SWEEP_OBSERVE_BATCH = 16;
const STORED_READ_TIMEOUT_MS = 5000;
/** 单个存储会话连续观察/物化失败达此数后放弃, 避免坏日志反复占满每轮观察配额。 */
const SWEEP_MAX_FAILURES = 3;

/**
 * 存储扫描消费的宿主服务结构类型。这些服务(sessionQuery 等)随 dsh
 * 版本整组演进, 直接引类型包会拖动 devDependency 时代; 按消费面声明,
 * 缺服务的宿主在运行时禁用存储扫描即可。
 */
interface StoredObservation {
  readonly events: readonly SessionEvent[];
  readonly header: { readonly id?: SessionId; readonly origin?: string; readonly agentPreset?: string };
  readonly projections?: { readonly values: { readonly agentPreset?: string } };
  [Symbol.dispose]?: () => void;
}

const isLoopReason = (reason: string): boolean =>
  reason === LOOP_COMPLETED_REASON || reason === LOOP_SILENT_REASON;

/** Keep fuzzy matching off the unbounded host event path; exact repeats remain unlimited. */
const STREAM_NEAR_DUPLICATE_MAX_CHARS = 2_048;
/** Bound unfinished text copied between token chunks when a provider emits no paragraph break. */
const STREAM_TAIL_MAX_CHARS = 4_096;

/** Ignore invisible formatting only for detection, never rewrite the stored message. */
const visibleText = (text: string): string => text.replace(/\p{Cf}/gu, '').trim();

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

/** 自动发送后, 在该窗口内出现的回合结束才计入恢复统计。 */

/** SSE 帧外壳: `{ rpcId, payload }`。 */
type FrameEnvelope<T> = { payload: T };

/** Session history APIs across the supported DSH host releases. */
type CompatibleSession = Session & {
  readonly events?: readonly SessionEvent[];
  snapshotEvents?: () => readonly SessionEvent[];
};

/** Read one stable event-log snapshot on both legacy and DSH 0.1.2 hosts. */
function snapshotSessionEvents(session: Session): readonly SessionEvent[] {
  const compatible = session as CompatibleSession;
  const snapshot = compatible.snapshotEvents;
  const events = typeof snapshot === 'function' ? snapshot.call(session) : compatible.events;
  return validateSessionEvents(events);
}

function validateSessionEvents(events: unknown): readonly SessionEvent[] {
  if (!Array.isArray(events)) throw new TypeError('session history is not an event array');
  // Do not filter damaged entries: one could have been a manual stop, newer turn,
  // or tool result. An incomplete history is not safe evidence for a continuation.
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event === null || typeof event !== 'object' || Array.isArray(event) ||
        typeof event.type !== 'string' || event.type === '' ||
        !Number.isSafeInteger(event.seq) || event.seq < 0 ||
        !Number.isFinite(event.time) || event.time < 0) {
      throw new TypeError(`invalid session event envelope at index ${index}`);
    }
  }
  return events;
}

function latestTurnStart(events: readonly SessionEvent[]): SessionEvent<'turn/start'> | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type === 'turn/start') return event;
  }
  return undefined;
}

function isMaintenanceTurnStart(event: SessionEvent<'turn/start'> | undefined): boolean {
  // shortcut: only message-ops defines this marker; extend when another producer has a verified contract.
  return (event?.data as { reason?: unknown } | undefined)?.reason === 'message-ops';
}

/** Interpret host failure payloads without trusting persisted or plugin-provided event shapes. */
function parseFailureFacts(value: unknown): FailureFacts | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const failure = value as { code?: unknown; message?: unknown; status?: unknown };
  const code = typeof failure.code === 'string' && failure.code.trim() !== ''
    ? failure.code
    : undefined;
  const message = typeof failure.message === 'string' && failure.message.trim() !== ''
    ? failure.message
    : undefined;
  const status = typeof failure.status === 'number' && Number.isFinite(failure.status)
    ? failure.status
    : undefined;
  if (code === undefined && message === undefined && status === undefined) return undefined;
  return {
    code: code ?? 'UNKNOWN',
    message: message ?? code ?? `HTTP ${status}`,
    ...(status !== undefined ? { status } : {}),
  };
}

/** Read a reason discriminator defensively because session history can outlive its schema. */
function readReasonKind(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === 'string' && kind.trim() !== '' ? kind : undefined;
}

/**
 * Whether a turn/end reason is an interruption the boot scan and boot loader continue. The shared non-human set applies,
 * plus `aborted` whose cause is `disposed` (a graceful shutdown). A manual stop (`user`), a loop-guard cancel (`hook`)
 * and a parent cancel (`parent`) stay excluded. The live turn/end handler does not use this predicate.
 */
function isInterruptedTurnEnd(reason: unknown): boolean {
  const kind = readReasonKind(reason);
  if (kind === undefined) return false;
  if (isNonHumanReason(kind)) return true;
  return kind === 'aborted' && readReasonKind((reason as { reason?: unknown }).reason) === 'disposed';
}

/**
 * vrpe F-A1: content of the last committed assistant message of the turn that ends at `end`, read from the event list
 * (the boot scan and the poll use it; in-memory step state is empty after a restart). Stops at the turn's start or the previous turn's end; undefined when the turn has none.
 */
function lastTurnMessageContent(events: readonly SessionEvent[], end: SessionEvent): unknown {
  for (let i = events.indexOf(end) - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type === 'turn/start' || event?.type === 'turn/end') return undefined;
    if (event?.type === 'assistant/message') return event.data.message.content;
  }
  return undefined;
}

/** vrpe F-A3: reasoning units of a message content, counted as String.length (UTF-16 code units) of its reasoning parts. */
function reasoningUnits(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let units = 0;
  for (const part of content as { type?: unknown; text?: unknown }[]) {
    if (part?.type === 'reasoning' && typeof part.text === 'string') units += part.text.length;
  }
  return units;
}

/** Concatenated text of the reasoning parts of a message content (the reasoning repeat arm's key, before normalising). */
function reasoningText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const part of content as { type?: unknown; text?: unknown }[]) {
    if (part?.type === 'reasoning' && typeof part.text === 'string') text += part.text;
  }
  return text;
}

/**
 * Round 4 (vrpe F-A2, H14, O2, M1, M1b): the spiral signal of the last turn, read from the persisted events with the
 * live detector's predicate. Live, onAssistantChunk feeds one ReasoningDensity per step with that step's reasoning
 * deltas and the step trips when feed() returns true (src/host/engine.ts:1078-1084 over ReasoningDensity in
 * src/shared/core.ts:882-1007: 8,000 reasoning characters plus the sentence arm or the line arm). Persisted, the same
 * class gets one instance per committed step of the turn, fed with that step's reasoning parts, so there is one
 * definition of "spiral" and not a second one. Only the last turn is read, and only its newest
 * LOOP_SPIRAL_SCAN_MESSAGES committed messages.
 */
function persistedSpiralTripped(
  events: readonly SessionEvent[],
  end: SessionEvent | undefined,
  loopGuard: boolean,
): boolean {
  // Round 5 (reviewer F2): the live detector is gated on config.loopGuard before it is fed (engine.ts:1078), so the
  // persisted read returns no signal when the guard is off. Without this gate a disabled loop guard still forced the
  // hard loop text after a restart.
  if (end === undefined || !loopGuard) return false;
  const density = new ReasoningDensity();
  let messages = 0;
  let step: unknown;
  for (let i = events.indexOf(end) - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event === undefined) continue;
    if (event.type === 'turn/start' || event.type === 'turn/end') return false;
    if (event.type !== 'assistant/message') continue;
    messages += 1;
    if (messages > LOOP_SPIRAL_SCAN_MESSAGES) return false;
    // Round 5 (reviewer note): the live detector keeps one ReasoningDensity per step and resets it at step/start
    // (engine.ts:872-877 on the session-event path, 1061-1064 on the live-stream path), so committed messages of one
    // step share one instance, as they do live. A message
    // without a step number counts as its own step, which is the conservative reading: fewer trips, never more.
    const ownStep = (event.data as { step?: unknown }).step;
    if (ownStep === undefined || ownStep !== step) {
      step = ownStep;
      density.reset();
    }
    const content = event.data.message.content;
    if (!Array.isArray(content)) continue;
    for (const part of content as { type?: unknown; text?: unknown }[]) {
      if (part?.type === 'reasoning' && typeof part.text === 'string' && density.feed(part.text)) return true;
    }
  }
  return false;
}

/** Narrow views of the optional services the boot loader reads (Context.get types them as any). */
interface PersistedHeader {
  readonly id: SessionId;
  readonly cwd?: string;
  readonly origin?: string;
  readonly parentSession?: SessionId;
  readonly delegationDepth?: number;
  readonly agentPreset?: string;
}

interface PersistedStore {
  list(): Promise<readonly { readonly header: PersistedHeader }[]>;
  /**
   * Cheap identity of the stored artifact, without decoding it. Present on the JSONL backend, where the revision is
   * derived from the file's own size and timestamps, so a changed file yields a changed revision.
   */
  stat?(id: SessionId): Promise<{ readonly revision?: unknown } | undefined>;
  open(id: SessionId, access: 'read'): Promise<{
    readonly header: PersistedHeader;
    readonly inheritedEventCount: number;
    read(offset?: number): Promise<{ readonly events: readonly SessionEvent[] }>;
    close(): Promise<void>;
  }>;
}

interface PersistedRegistry {
  readonly archivedSessionIds: readonly SessionId[];
}

/** Shape version of the persisted rejection record. A different version is ignored rather than misread. */
const PERSISTED_REJECTION_VERSION = 1;
/** Upper bound on remembered rejections, so the record cannot grow without limit on a large store. */
const PERSISTED_REJECTION_MAX = 5_000;

/**
 * The record of stored logs a scan already read cleanly at a given revision, so a later boot does not decode them again.
 * Every read parses a whole log, and a settled log cannot need a resume until its bytes change.
 */
const SETTLED_RECORD_VERSION = 1;
const SETTLED_RECORD_MAX = 5_000;

interface PersistedPresets {
  resolve(id?: string): Promise<{ readonly id: string }>;
  mount(agentCtx: Context, id?: string): Promise<unknown>;
}

/** The host's public subagent service. sendMessage delivers through the child's residency and cold resume (dsh-subagent). */
interface PersistedSubagents {
  sendMessage(
    sender: Agent,
    targetId: SessionId,
    content: readonly { readonly type: 'text'; readonly text: string }[],
    /**
     * skipIfResident (host patch r9): refuse with ALREADY_RESIDENT, delivering nothing, when the child is already resident.
     * skipIfRunSince (host patch r10, option B in r11): refuse with ALREADY_RAN, delivering nothing, when the child's own turn starts (turn/start events after its inherited prefix) are above this number.
     */
    options: { readonly signal: AbortSignal; readonly skipIfResident?: boolean; readonly skipIfRunSince?: number },
  ): Promise<unknown>;
}

/** Symbol.for key of the process-wide set of children continued in this host run. */
const BOOT_CONTINUED_KEY = Symbol.for('dsh.auto-continue.bootContinued');

/**
 * Children continued by the boot loader in this host process. Process-wide, not per engine: a re-applied engine
 * enumerates persisted history again, and a child it has already continued must not be delivered a second time.
 */
function bootContinuedIds(): Set<SessionId> {
  const scope = globalThis as unknown as Record<symbol, Set<SessionId> | undefined>;
  const existing = scope[BOOT_CONTINUED_KEY];
  if (existing !== undefined) return existing;
  const created = new Set<SessionId>();
  scope[BOOT_CONTINUED_KEY] = created;
  return created;
}

/** Report a boot-loader failure without letting it escape the scan. */
function reportLoaderError(error: unknown): void {
  console.error(`[auto-continue] 持久化会话加载异常: ${error instanceof Error ? error.message : String(error)}`);
}

interface PersistedRoute {
  readonly provider: string;
  readonly model: string;
}

interface PersistedEntry {
  readonly id: SessionId;
  readonly lastActivityAt: number;
  /** Delegation depth from the header. Parents (lower depth) are resumed before their children. */
  readonly depth: number;
  /** The route in force when the session last ran: the latest request header of its own events (after the inherited prefix). */
  readonly route?: PersistedRoute;
  readonly preset?: string;
  /** Set only for a subagent child the host would resume: its own continuable descriptor and its live parent's id. */
  readonly childDescriptor?: PersistedChildDescriptor;
  readonly parentSession?: SessionId;
  /** Own turn starts (turn/start events after the inherited prefix) read when the boot scan listed the session. A larger count later means a turn started since (F-3). */
  readonly ownTurnStartCount: number;
}

/**
 * Boot-loader eligibility for one persisted session, mirroring the rules scanInterrupted applies to live sessions.
 * Returns the last activity time (orders the queue), or undefined when the session must not be resumed.
 */
function persistedLastActivity(
  events: readonly SessionEvent[],
  now: number,
  config: AutoContinueConfig,
): number | undefined {
  let lastStart: SessionEvent<'turn/start'> | undefined;
  let lastEnd: SessionEvent<'turn/end'> | undefined;
  let lastActivityAt = 0;
  for (const event of events) {
    lastActivityAt = Math.max(lastActivityAt, event.time);
    if (event.type === 'turn/start') lastStart = event;
    else if (event.type === 'turn/end') lastEnd = event;
  }
  // Crash orphan: resume appends an `interrupted` closer stamped with the last event time.
  if (lastStart !== undefined && (lastEnd === undefined || lastStart.seq > lastEnd.seq)) {
    return lastActivityAt >= now - config.freshMs ? lastActivityAt : undefined;
  }
  if (lastEnd === undefined) return undefined;
  const endSeq = lastEnd.seq;
  // A newer user prompt means the user already moved on (the scanner's superseded rule).
  if (events.some((event) => event.seq > endSeq && event.type === 'user/message' && event.data.source.kind === 'user')) {
    return undefined;
  }
  const reasonKind = readReasonKind(lastEnd.data.reason);
  if (reasonKind === undefined || !isInterruptedTurnEnd(lastEnd.data.reason)) return undefined;
  if (reasonKind === 'error') {
    const failure = parseFailureFacts((lastEnd.data.reason as { error?: unknown }).error);
    if (failure === undefined) return undefined;
    if (config.classify && !isTransientFailure(failure, config.retryableErrorPatterns)) return undefined;
  }
  return lastEnd.time >= now - config.freshMs ? lastActivityAt : undefined;
}

/** Route in force when the session last ran: provider and model of the latest request/header. */
function persistedRoute(events: readonly SessionEvent[]): PersistedRoute | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type !== 'request/header') continue;
    const config = (event.data as { header?: { config?: { provider?: unknown; model?: unknown } } }).header?.config;
    const provider = config?.provider;
    const model = config?.model;
    return typeof provider === 'string' && provider !== '' && typeof model === 'string' && model !== ''
      ? { provider, model }
      : undefined;
  }
  return undefined;
}

/** Preset the session runs under: the newest agent-preset/selected value, else the header's creation value. */
function persistedPreset(header: PersistedHeader, events: readonly SessionEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i] as { readonly type: string; readonly data?: unknown } | undefined;
    if (event?.type !== 'agent-preset/selected') continue;
    const selected = (event.data as { agentPreset?: unknown } | undefined)?.agentPreset;
    return typeof selected === 'string' && selected !== '' ? selected : undefined;
  }
  return typeof header.agentPreset === 'string' && header.agentPreset !== '' ? header.agentPreset : undefined;
}

/** Continuation state a continuable subagent child declares in its own `subagent/descriptor` event (dsh-subagent, descriptor v3). */
interface PersistedChildDescriptor {
  readonly agentProvider?: string;
  readonly agentModel?: string;
  readonly agentReasoningEffort?: string;
  readonly persona?: string;
  readonly toolFilter?: { readonly allow?: readonly string[]; readonly deny?: readonly string[] };
}

/** The descriptor version the host writes and resumes. Any other version is not resumable here. */
const CHILD_DESCRIPTOR_VERSION = 3;
const CHILD_DESCRIPTOR_KEYS = new Set([
  'version', 'mode', 'provider', 'label', 'agentProvider', 'agentModel', 'agentReasoningEffort', 'persona', 'toolFilter',
]);
const TOOL_FILTER_KEYS = new Set(['allow', 'deny']);

/** A string array, the only shape the host accepts for toolFilter.allow and toolFilter.deny. */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * The continuable descriptor the host would resume a child from, or undefined. It mirrors the host's fold: the first
 * `subagent/descriptor` among the child's own events (after the inherited prefix) must be version 3, `continuable`, with
 * a well-formed composition. One-shot children and malformed records are undefined, so the loader leaves them alone.
 */
function persistedChildDescriptor(
  events: readonly SessionEvent[],
  inheritedEventCount: number,
): PersistedChildDescriptor | undefined {
  // The subagent/descriptor type is not in the SessionEvent union this plugin is typed against, so compare as a string.
  const record = (events.slice(inheritedEventCount) as readonly { readonly type: string; readonly data?: unknown }[])
    .find((event) => event.type === 'subagent/descriptor');
  const value: unknown = record?.data;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  if (data.version !== CHILD_DESCRIPTOR_VERSION || data.mode !== 'continuable') return undefined;
  if (Object.keys(data).some((key) => !CHILD_DESCRIPTOR_KEYS.has(key))) return undefined;
  if (typeof data.provider !== 'string' || typeof data.label !== 'string') return undefined;
  for (const key of ['agentProvider', 'agentModel', 'agentReasoningEffort', 'persona'] as const) {
    if (data[key] !== undefined && typeof data[key] !== 'string') return undefined;
  }
  let toolFilter: PersistedChildDescriptor['toolFilter'];
  if (data.toolFilter !== undefined) {
    const rules = data.toolFilter;
    if (typeof rules !== 'object' || rules === null || Array.isArray(rules)) return undefined;
    const filter = rules as Record<string, unknown>;
    if (Object.keys(filter).some((key) => !TOOL_FILTER_KEYS.has(key))) return undefined;
    if (filter.allow === undefined && filter.deny === undefined) return undefined;
    if ((filter.allow !== undefined && !isStringArray(filter.allow)) || (filter.deny !== undefined && !isStringArray(filter.deny))) {
      return undefined;
    }
    toolFilter = {
      ...(filter.allow !== undefined ? { allow: filter.allow as string[] } : {}),
      ...(filter.deny !== undefined ? { deny: filter.deny as string[] } : {}),
    };
  }
  // A route pinned by one field only cannot be resumed the way the host resumes it, so it is not resumed here.
  if ((data.agentProvider === undefined) !== (data.agentModel === undefined)) return undefined;
  return {
    ...(typeof data.agentProvider === 'string' ? { agentProvider: data.agentProvider } : {}),
    ...(typeof data.agentModel === 'string' ? { agentModel: data.agentModel } : {}),
    ...(typeof data.agentReasoningEffort === 'string' ? { agentReasoningEffort: data.agentReasoningEffort } : {}),
    ...(typeof data.persona === 'string' ? { persona: data.persona } : {}),
    ...(toolFilter !== undefined ? { toolFilter } : {}),
  };
}

/** Hard limit on one host call the boot loader makes (list, open, read, close, resume). Not configurable. */
const PERSISTED_CALL_TIMEOUT_MS = 10_000;

/** A host call the boot loader stopped waiting for. The call itself may still settle later. */
class PersistedCallTimeout extends Error {}

/** The host's refusal when every active-child slot is taken (dsh-subagent ACTIVATION_LIMIT_REACHED). Nothing was delivered. */
const ADMISSION_LIMIT_CODE = 'ACTIVATION_LIMIT_REACHED';

/** Whether a host call was refused at the active-child limit, so its delivery never started. */
function isAdmissionLimit(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === ADMISSION_LIMIT_CODE;
}

/**
 * The host's refusal when a sendMessage with skipIfResident finds the child already resident under its lock (the host
 * change in patch r9; dsh-subagent SubagentSendMessageOptions.skipIfResident). Nothing was delivered.
 */
const ALREADY_RESIDENT_CODE = 'ALREADY_RESIDENT';

/** Whether a host call was refused because the child was already resident, so a parent message had admitted it. */
function isAlreadyResident(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === ALREADY_RESIDENT_CODE;
}

/**
 * The host's refusal when a sendMessage with skipIfRunSince finds more turn starts in the child's own log than the count the boot scan
 * read, so a turn started after it was listed (the host change in patch r10; dsh-subagent SubagentSendMessageOptions.skipIfRunSince).
 * Nothing was delivered.
 */
const ALREADY_RAN_CODE = 'ALREADY_RAN';

/** Whether a host call was refused because the child ran after the boot listing. */
function isAlreadyRan(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === ALREADY_RAN_CODE;
}

/**
 * A child kept for a later delivery attempt. `slot` was refused at the active-child limit and waits for a slot to free;
 * `parent` was attempted while its own parent was not live yet and waits for the parent this boot pass publishes.
 */
interface WaitingChild {
  readonly entry: PersistedEntry;
  readonly child: PersistedChildDescriptor;
  readonly reason: 'slot' | 'parent';
}

/**
 * The outcome one boot resume shares between its outer 10 s wait (resumePersisted) and its Continue delivery (deliverChild).
 * `retryDue` is set in the first Continue's timeout callback, which runs before the outer wait's timeout callback. That order
 * holds because the first Continue's timer is created first: resumeEntry reaches sendContinue synchronously, and the outer
 * timer is created only after resumeEntry returns. Both timers use PERSISTED_CALL_TIMEOUT_MS, so the first Continue's timer
 * expires no later than the outer one. On a tie Node runs the earlier-created timer first, and it drains microtasks between
 * timer callbacks. An await before the first Continue, or creating the outer timer first, would let the outer wait read
 * retryDue before it is set. Mock timers run both callbacks in one tick, so only the real-timer test in the boot suite checks
 * this order (r11, F-A).
 */
interface ResumeOutcome {
  retryDue: boolean;
}

/** The one error line for a failed persisted resume or Continue. */
function logResumeFailure(entry: PersistedEntry, error: unknown): void {
  console.error(`[auto-continue] 恢复持久化会话失败 ${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
}

/**
 * Await one host call for at most PERSISTED_CALL_TIMEOUT_MS. The timer is cleared as soon as the race settles,
 * so it does not keep the process alive. A late settle of `call` is not observed here. `onTimeout` runs when the wait
 * gives up, so a caller can abort the work behind `call` (a child delivery aborts its signal this way).
 */
async function withPersistedTimeout<T>(call: Promise<T>, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new PersistedCallTimeout(`host call timed out after ${PERSISTED_CALL_TIMEOUT_MS} ms`));
    }, PERSISTED_CALL_TIMEOUT_MS);
  });
  try {
    return await Promise.race([call, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function isLoopGuardCancelReason(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const cause = value as { kind?: unknown; reason?: unknown };
  return cause.kind === LOOP_GUARD_CANCEL_CAUSE.kind && cause.reason === LOOP_GUARD_CANCEL_CAUSE.reason;
}

/**
 * 事件流泵: 带指数退避的 SSE 重连循环。
 * - 从未收到任何帧(宿主未就绪): 退避重试, 不触发扫描
 * - 曾连上后断开: 重连, 并通过 onReconnect 通知外层(宿主可能崩溃重启过)
 */
async function pumpStream<T>(
  open: (signal: AbortSignal) => AsyncIterable<FrameEnvelope<T>>,
  onFrame: (payload: T) => void,
  onReconnect: () => void,
  getBackoff: () => number,
  log: (message: string) => void,
  signal: AbortSignal,
): Promise<void> {
  let backoff = getBackoff();
  while (!signal.aborted) {
    let connected = false;
    try {
      for await (const envelope of open(signal)) {
        connected = true;
        onFrame(envelope.payload);
      }
      if (signal.aborted) return;
    } catch (error) {
      if (signal.aborted) return;
      log(`stream error: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!connected) {
      // 从未连上(宿主未就绪): 指数退避重试
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 15000);
      continue;
    }
    // 曾连上后断开 → 重连并触发外层扫描
    backoff = getBackoff();
    onReconnect();
    await sleep(backoff);
  }
}

/** 插件主体: 一条 mux 流 + 一条 host 流 + 启动/重连扫描。 */
export class AutoContinueRunner {
  private readonly states = new Map<SessionId, SessionState>();
  private readonly pauseUntil = new Map<SessionId, number>();
  private dayStats: DayStats = emptyDayStats();
  private readonly recoveryAttempts: RecoveryAttempt[] = [];
  private readonly notices: HostNotice[] = [];
  private readonly noticeListeners = new Set<() => void>();
  private readonly stateListeners = new Set<() => void>();
  private readonly prioritizedFollowups = new Set<string>();
  private readonly disposeSessionEvents: () => void;
  private readonly disposeInboxEvents: () => void;
  /** Live channel subscription; registered only when liveStreamGuard is on (vrpe X-SUB). */
  private readonly disposeAssistantStream: (() => void) | undefined;
  private disposed = false;
  private readonly bootScannedSessions = new WeakSet<Session>();
  /** Also bound diagnostics when even an agent's session getter is unavailable. */
  private readonly bootScanErrors = new WeakSet<object>();
  /** 存储扫描已裁决的会话 id, 避免每轮重复冷读大日志。 */
  private readonly storedSwept = new Set<SessionId>();
  /**
   * Sessions a boot path (the persisted loader or the stored sweep) has asked the host to resume. The claim is taken in the
   * same tick as the host call, and released only when that call rejects, so a failed resume can be retried by the sweep.
   * A pending, timed-out, or successful resume keeps its claim for this boot.
   */
  private readonly bootResumeClaims = new Set<SessionId>();
  /** 存储会话的连续观察/物化失败次数, 触达 SWEEP_MAX_FAILURES 后不再重试。 */
  private readonly storedSweepFailures = new Map<SessionId, number>();
  private storedSweepAnnounced = false;
  private bootScanTimer: ReturnType<typeof setTimeout> | undefined;
  private wakeBootScan: (() => void) | undefined;
  /** Persisted sessions are enumerated once per boot, after the service is available. */
  private persistedEnumerated = false;
  private readonly persistedDecided = new Set<SessionId>();
  /**
   * Session id to the artifact revision that failed to read, kept across restarts so a boot does not decode a log it
   * has already rejected. A repaired artifact has a new revision and is read again.
   */
  private persistedRejections: Map<string, string> | undefined;
  private persistedRejectionSave: ReturnType<typeof setTimeout> | undefined;
  /** Id to the log revision a scan already settled, plus the config the verdict was reached under. */
  private persistedSettled: Map<string, string> | undefined;
  /** Id to the revision this host settled at, for rows it dropped because the session became live. */
  private persistedSettledDropped: Map<string, string> | undefined;
  /** Ids whose disk revision is still to be checked before the save may remove them. */
  private persistedSettledPending: Map<string, string> | undefined;
  private persistedSettledCheck: Promise<void> | undefined;
  private persistedSettledSave: ReturnType<typeof setTimeout> | undefined;
  /** Eligible persisted sessions not yet resumed, newest activity first. */
  private persistedQueue: PersistedEntry[] = [];
  /** The single in-flight list() call. A stalled call is awaited again on later passes, never repeated. */
  private persistedListing: Promise<readonly { readonly header: PersistedHeader }[]> | undefined;
  /** The single background loader pass in flight. */
  private persistedRun: Promise<void> | undefined;
  /** Boot window end, set when bootScanLoop starts. Zero until then, so the loader starts no host call. */
  private bootDeadline = 0;
  /** Ids the loader asked the host to resume. Their agents take only the scanLimit slots live candidates leave. */
  private readonly persistedLoaded = new Set<SessionId>();
  /** Loader-resumed user sessions by id until the boot scan exits. Released there if the scanner never classified them. */
  private readonly persistedHandles = new Map<SessionId, AgentHandle>();
  /** Children kept for a later attempt, by id: refused at the active-child limit, or waiting for their parent to go live. */
  private readonly waitingChildren = new Map<SessionId, WaitingChild>();
  /** One pending attempt per child, scheduled from an event the plugin observed. */
  private readonly waitAttempts = new Map<SessionId, ReturnType<typeof setImmediate>>();
  /** Slot releases the plugin observed: agent disposals, and settled deliveries that were not admission refusals. */
  private slotReleases = 0;
  /** Deliveries in flight. The wait ends only when no child waits and none is in flight. */
  private slotDeliveries = 0;
  /** Disposer of the agent/disposed listener. Set while a child waits or a delivery is in flight; removed when neither holds. */
  private disposeSlotListener: (() => void) | undefined;
  /** Disposer of the agent/created listener. Set only while a child waits for its parent, removed with the wait. */
  private disposeParentListener: (() => void) | undefined;
  /** Log-only timer at the boot window end. Set while a child waits. It never sends. */
  private slotWindowTimer: ReturnType<typeof setTimeout> | undefined;
  private storedSweep: Promise<void> | undefined;
  private readonly stopStoredSweep = new AbortController();

  /**
   * @param ctx - host plugin context (agents registry, session events).
   * @param getConfig - read the current resolved configuration (entry config).
   */
  constructor(
    private readonly ctx: Context,
    private readonly getConfig: () => AutoContinueConfig,
  ) {
    // 单实例事件源: 宿主进程内的会话事件 firehose, 天然覆盖所有会话。
    this.disposeSessionEvents = ctx.on('session/event', (session, event) => {
      try {
        this.onHostEvent(session, event);
      } catch (error) {
        console.error(
          `[auto-continue] 会话事件处理异常 ${session.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    });
    // followup() appends before it wakes the driver. Move only this plugin's marked
    // message during the synchronous insertion event, while the driver still cannot claim it.
    this.disposeInboxEvents = ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (!this.prioritizedFollowups.delete(message.id)) return;
      let removed = false;
      try {
        const index = agent.inbox.nextTurn.findIndex(pending => pending.id === message.id);
        if (index <= 0) return;
        removed = agent.inbox.remove(message.id);
        if (!removed) return;
        agent.inbox.prepend('next-turn', message);
      } catch (error) {
        // Preserve the continuation even if a host-side queue mutation rejects the move.
        if (removed) {
          try {
            agent.inbox.append('next-turn', message);
          } catch (rollbackError) {
            console.error(
              `[auto-continue] 恢复续跑消息失败 ${agent.id}: ${
                rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
              }`,
            );
          }
        }
        console.error(
          `[auto-continue] 调整续跑消息顺序失败 ${agent.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    });
    const config = this.getConfig();
    if (config.liveStreamGuard) {
      // Live reasoning arrives only as agent/assistant-stream chunk frames (vrpe X-SUB).
      this.disposeAssistantStream = ctx.on('agent/assistant-stream', (payload) => {
        try {
          this.onLiveStreamFrame(payload?.agent?.session?.id, payload?.frame);
        } catch (error) {
          console.error(
            `[auto-continue] 实时流帧处理异常: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
    }
    if (config.scanOnBoot) {
      // When the boot loop exits, release loader-resumed agents it never classified (see releaseUnscannedPersisted).
      void this.bootScanLoop().finally(() => this.releaseUnscannedPersisted());
    }
    this.log(
      `已启动(host 单实例, 文本="${config.continueText}", 宽限 ${config.graceMs}ms, ` +
        `冷却 ${config.cooldownMs}ms, 最多连续 ${config.maxConsecutive} 次)`,
    );
  }

  private log(message: string): void {
    if (this.getConfig().verbose) console.info(`[auto-continue] ${message}`);
  }

  /** 对外(状态桥): 今日统计快照。 */
  todayStats(): DayStats {
    const today = todayKey();
    if (this.dayStats.date !== today) this.dayStats = emptyDayStats();
    return { ...this.dayStats, byCode: { ...this.dayStats.byCode } };
  }

  recentRecoveryAttempts(): RecoveryAttempt[] {
    return this.recoveryAttempts.map(attempt => ({ ...attempt }));
  }

  /** 对外(状态桥): 当前生效的会话级暂停列表。 */
  activePauses(): { sessionId: SessionId; until: number }[] {
    const now = Date.now();
    const out: { sessionId: SessionId; until: number }[] = [];
    for (const [sessionId, until] of this.pauseUntil) {
      if (until > now) out.push({ sessionId, until });
    }
    return out;
  }

  /** 对外(状态桥): 订阅通知事件(SSE 端点推送)。 */
  subscribeNotices(listener: () => void): () => void {
    this.noticeListeners.add(listener);
    return () => {
      this.noticeListeners.delete(listener);
    };
  }

  /** 对外(状态桥): 订阅运行时状态变化(统计/暂停列表)。 */
  subscribeState(listener: () => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  private emitState(): void {
    for (const listener of this.stateListeners) listener();
  }

  private sessionConfig(sessionId: SessionId): AutoContinueConfig {
    const config = this.getConfig();
    const mode = sessionMode(config.sessionModes, sessionId);
    return {
      ...config,
      paused: config.paused || mode === 'off',
      resumeCompletedTurns: mode === 'default' ? config.resumeCompletedTurns : mode === 'loop',
      loopGuard: config.loopGuard && mode !== 'off',
    };
  }

  configurationChanged(): void {
    if (this.disposed) return;
    for (const [sessionId, state] of this.states) {
      const config = this.sessionConfig(sessionId);
      if (config.paused || (isLoopReason(state.pendingReason ?? '') && !config.resumeCompletedTurns)) {
        this.cancelPending(sessionId, '会话模式或全局设置已更改');
      }
    }
    this.emitState();
  }

  /** 对外(状态桥): 消费待展示的通知。 */
  drainNotices(): HostNotice[] {
    return this.notices.splice(0, this.notices.length);
  }

  /** 通知动作(browser 通知按钮回传): 立即续跑 / 暂停该会话 / 解除暂停 / 清零统计。 */
  handleNoticeAction(sessionId: SessionId | undefined, action: string): void {
    if (action === 'unpause') {
      if (sessionId !== undefined) this.pauseUntil.delete(sessionId);
      this.log(`解除暂停 ${sessionId ?? '?'}`);
    } else if (action === 'reset-stats') {
      this.dayStats = emptyDayStats();
      this.log('清零今日统计');
    } else if (sessionId !== undefined) {
      this.onNotifyAction(sessionId, action);
    }
    this.emitState();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopStoredSweep.abort();
    if (this.bootScanTimer !== undefined) clearTimeout(this.bootScanTimer);
    this.bootScanTimer = undefined;
    if (this.persistedSettledSave !== undefined) clearTimeout(this.persistedSettledSave);
    this.persistedSettledSave = undefined;
    if (this.persistedRejectionSave !== undefined) clearTimeout(this.persistedRejectionSave);
    this.persistedRejectionSave = undefined;
    this.wakeBootScan?.();
    this.wakeBootScan = undefined;
    // Each child still waiting is dropped and logged once. Nothing is sent after dispose.
    for (const [id, waiting] of this.waitingChildren) {
      const cause = waiting.reason === 'parent' ? 'its parent became live' : 'an activation slot freed';
      console.error(`[auto-continue] dropped ${id}: the runner was disposed before ${cause}`);
    }
    this.waitingChildren.clear();
    this.stopSlotWait();
    this.disposeSessionEvents();
    this.disposeInboxEvents();
    this.disposeAssistantStream?.();
    this.prioritizedFollowups.clear();
    for (const state of this.states.values()) {
      if (state.pendingTimer !== undefined) clearTimeout(state.pendingTimer);
      if (state.loopRetryTimer !== undefined) clearTimeout(state.loopRetryTimer);
      if (state.cooldownRetryTimer !== undefined) clearTimeout(state.cooldownRetryTimer);
    }
    this.states.clear();
  }

  private state(sessionId: SessionId): SessionState {
    let state = this.states.get(sessionId);
    if (state === undefined) {
      state = freshState();
      this.states.set(sessionId, state);
    }
    return state;
  }

  /** Mark a child session and clear queued grace/cooldown sends. */
  private markSubagent(sessionId: SessionId, state: SessionState): void {
    state.subagent = true;
    this.cancelPending(sessionId, '子代理会话');
  }

  /** Read durable origin from the live agent for direct action paths as well. */
  private isSubagent(sessionId: SessionId, state: SessionState): boolean {
    if (state.subagent) return true;
    const agent = this.ctx.agents.get(sessionId);
    if (agent?.session?.header?.origin !== 'subagent') return false;
    this.markSubagent(sessionId, state);
    return true;
  }

  /**
   * 事件入口(host 单实例): 预处理工具调用/结果/模型消息(护栏与循环信号),
   * 然后交给回合状态机。
   */
  private onHostEvent(session: Session, event: SessionEvent): void {
    const sessionId = session.id;
    const sessionState = this.states.get(sessionId);
    if (session.header?.origin === 'subagent') {
      this.markSubagent(sessionId, sessionState ?? this.state(sessionId));
      return;
    }
    if (sessionState?.subagent) return;
    if (sessionState?.maintenanceTurn !== undefined &&
        sessionState.maintenanceTurn === (event.data as { turn?: number }).turn &&
        event.type !== 'turn/start' && event.type !== 'turn/end') return;
    if (
      (event.type === 'user/message' || event.type === 'assistant/message') &&
      typeof event.surfaceOp === 'object' &&
      event.surfaceOp !== null
    ) {
      // Compaction replacement 不是新消息，也可能 shadow 整段工具结果。
      this.state(sessionId).tools.recordSurfaceReplacement(event.seq);
      return;
    }
    if (event.type === 'tool/call') {
      const state = this.state(sessionId);
      // 任何新鲜调用都代表进展（即使缺关联 id）；旧帧重放不能清短句 streak。
      if (state.tools.recordCall(event)) {
        state.shortRun = 0;
        state.sameTextRun = 0;
        state.lastAssistantText = '';
        state.reasoningRepeatRun = 0;
        if (this.tracksOutput(state, event)) state.turnOutput = 'visible';
      }
    } else if (event.type === 'tool/result') {
      const state = this.state(sessionId);
      state.tools.recordResult(event);
    } else if (event.type === 'step/start') {
      const state = this.state(sessionId);
      if (this.tracksOutput(state, event) && state.turnOutput === 'empty') state.turnOutput = 'silent';
      state.stepOutput = 'none';
      // Per-step reasoning density resets at each model step (vrpe).
      state.reasonDensity.reset();
      state.toolArgWhitespaceRun = 0;
      state.toolArgTripLogged = false;
      state.toolArgCooldownLogged = false;
      const repeat = state.tools.confirmRepeatAtStep(event.seq);
      if (repeat !== undefined) this.checkLoop(sessionId, state, repeat);
    } else if (event.type === 'assistant/chunk') {
      const state = this.state(sessionId);
      if (this.tracksOutput(state, event)) {
        const chunk = event.data.chunk;
        const visible = this.chunkIsVisible(chunk);
        if (visible) {
          state.turnOutput = 'visible';
          state.reasoningRepeatRun = 0;
        }
        else if (state.turnOutput === 'empty' && chunk.type !== 'usage' && chunk.type !== 'finish') state.turnOutput = 'silent';
        if (visible) state.stepOutput = 'visible';
        else if (chunk.type === 'reasoning-delta' && state.stepOutput === 'none') state.stepOutput = 'reasoning';
      }
      this.onAssistantChunk(sessionId, state, event.data.chunk);
    } else if (event.type === 'assistant/message') {
      const state = this.state(sessionId);
      if (this.tracksOutput(state, event)) {
        if (this.hasVisibleContent(event.data.message.content)) state.turnOutput = 'visible';
        else if (state.turnOutput === 'empty') state.turnOutput = 'silent';
        // vrpe F-A2: the committed message sets the step output, so the live max-tokens check does not need chunks.
        state.stepOutput = this.messageOutput(event.data.message.content);
        state.reasoningOnlyUnits = state.stepOutput === 'reasoning' ? reasoningUnits(event.data.message.content) : 0;
      }
      this.onAssistantMessage(sessionId, state, event);
    }
    this.onSessionEvent(sessionId, event);
  }

  private tracksOutput(state: SessionState, event: SessionEvent): boolean {
    return state.running === true && state.outputTurn === (event.data as { turn?: number }).turn &&
      event.seq > state.outputStartSeq;
  }

  /** Treat unknown block kinds conservatively: only reasoning and blank text are silent. */
  private hasVisibleContent(content: unknown): boolean {
    if (!Array.isArray(content)) return false;
    return content.some((part: unknown) => {
      if (part === null || typeof part !== 'object') return true;
      const block = part as { type?: unknown; text?: unknown };
      if (block.type === 'reasoning') return false;
      if (block.type === 'text') return typeof block.text !== 'string' || visibleText(block.text) !== '';
      return true;
    });
  }

  /** vrpe F-A2: output of one committed assistant message: visible (text or tool call), reasoning only, or none. */
  private messageOutput(content: unknown): 'visible' | 'reasoning' | 'none' {
    if (this.hasVisibleContent(content)) return 'visible';
    const parts = Array.isArray(content) ? (content as { type?: unknown }[]) : [];
    return parts.some((part) => part?.type === 'reasoning') ? 'reasoning' : 'none';
  }

  /** 从 assistant/message 事件提取纯文本。 */
  private assistantText(event: SessionEvent<'assistant/message'>): string {
    const content = event.data.message.content;
    if (!Array.isArray(content)) return '';
    return content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('');
  }

  private assistantChunkText(chunk: AssistantChunk): string {
    return chunk.type === 'text-delta' ? chunk.text : '';
  }

  /** A chunk the user can see: visible text, a tool call, or a non-reasoning block. */
  private chunkIsVisible(chunk: AssistantChunk): boolean {
    return (chunk.type === 'text-delta' && visibleText(chunk.text) !== '') ||
      chunk.type === 'tool-call-delta' ||
      (chunk.type === 'block-end' && this.hasVisibleContent([chunk.block])) ||
      (chunk.type === 'block-start' && chunk.blockType !== 'reasoning' && chunk.blockType !== 'text');
  }

  private normalizedSegment(text: string): string {
    return visibleText(text).replace(/\s+/g, ' ');
  }

  private isNearDuplicateSegment(left: string, right: string): boolean {
    if (left === right) return true;
    const leftLen = left.length;
    const rightLen = right.length;
    const longer = Math.max(leftLen, rightLen);
    const shorter = Math.min(leftLen, rightLen);
    if (shorter === 0 || shorter / longer < 0.85) return false;
    if (longer > STREAM_NEAR_DUPLICATE_MAX_CHARS) return false;
    const maxDistance = Math.max(6, Math.floor(longer * 0.08));
    if (Math.abs(leftLen - rightLen) > maxDistance) return false;
    return this.withinEditDistance(left, right, maxDistance);
  }

  private withinEditDistance(left: string, right: string, maxDistance: number): boolean {
    if (left === right) return true;
    if (maxDistance < 0) return false;
    const leftLen = left.length;
    const rightLen = right.length;
    if (Math.abs(leftLen - rightLen) > maxDistance) return false;
    if (leftLen === 0 || rightLen === 0) return Math.max(leftLen, rightLen) <= maxDistance;
    const unreachable = maxDistance + 1;
    let previous = new Int32Array(rightLen + 1);
    let current = new Int32Array(rightLen + 1);
    previous.fill(unreachable);
    for (let col = 0; col <= Math.min(rightLen, maxDistance); col += 1) {
      previous[col] = col;
    }
    for (let row = 1; row <= leftLen; row += 1) {
      current.fill(unreachable);
      if (row <= maxDistance) current[0] = row;
      const firstCol = Math.max(1, row - maxDistance);
      const lastCol = Math.min(rightLen, row + maxDistance);
      let minInRow = unreachable;
      for (let col = firstCol; col <= lastCol; col += 1) {
        const insertion = (current[col - 1] ?? unreachable) + 1;
        const deletion = (previous[col] ?? unreachable) + 1;
        const substitution =
          (previous[col - 1] ?? unreachable) +
          (left.charCodeAt(row - 1) === right.charCodeAt(col - 1) ? 0 : 1);
        const score = Math.min(insertion, deletion, substitution, unreachable);
        current[col] = score;
        if (score < minInRow) minInRow = score;
      }
      if (minInRow > maxDistance) return false;
      [previous, current] = [current, previous];
    }
    return (previous[rightLen] ?? unreachable) <= maxDistance;
  }

  private noteStreamSegment(sessionId: SessionId, state: SessionState, segment: string): void {
    const normalized = this.normalizedSegment(segment);
    const config = this.getConfig();
    if (normalized === '') return;
    if (normalized.length < config.loopShortChars) {
      state.streamLastSegment = '';
      state.streamRepeatRun = 0;
      return;
    }
    if (
      state.streamLastSegment !== '' &&
      this.isNearDuplicateSegment(normalized, state.streamLastSegment)
    ) {
      state.streamRepeatRun += 1;
      state.streamLastSegment = normalized;
    } else {
      state.streamLastSegment = normalized;
      state.streamRepeatRun = 1;
    }
    if (state.streamRepeatRun >= config.loopRepeatText) {
      this.log(
        `检测到流式消息内复读 ${sessionId}: 连续 ${state.streamRepeatRun} 段近似重复文本`,
      );
      this.interruptLoop(sessionId, state);
    }
  }

  /**
   * Reasoning spiral in this step (vrpe). The trip and the cooldown refusal are each logged once
   * per step. While the cooldown lasts, later deltas stay silent; the first delta after it cuts.
   */
  private onReasoningSpiral(sessionId: SessionId, state: SessionState): void {
    state.spiralTripped = true; // before the cooldown check: a refused trip still counts for this turn's end
    const density = state.reasonDensity;
    if (!density.tripLogged) {
      density.tripLogged = true;
      this.log(`检测到推理复读 ${sessionId}: 推理内句子或行高度重复, 且无可见输出`);
    }
    if (Date.now() - state.lastAttemptAt < this.cooldownFor(state)) {
      if (!density.refusalLogged) {
        density.refusalLogged = true;
        this.log(`跳过循环打断 ${sessionId}: 处于冷却期`);
      }
      return;
    }
    this.interruptLoop(sessionId, state);
  }

  /**
   * Live channel (liveStreamGuard, vrpe X-SUB): one agent/assistant-stream frame. The session id is
   * payload.agent.session.id. Turn and step come only on `start` frames. A frame without a session
   * id is ignored. `start` resets the density count and the whitespace run (a retried attempt
   * regenerates the argument stream); chunks do not.
   */
  private onLiveStreamFrame(sessionId: SessionId | undefined, frame: AssistantStreamFrame | undefined): void {
    if (typeof sessionId !== 'string' || frame === undefined) return;
    const state = this.state(sessionId);
    if (this.isSubagent(sessionId, state)) return;
    if (frame.type === 'start') {
      // Mirrors the step/start reset on the session-event path.
      state.stepOutput = 'none';
      state.reasonDensity.reset();
      state.toolArgWhitespaceRun = 0;
      state.toolArgTripLogged = false;
      state.toolArgCooldownLogged = false;
    } else if (frame.type === 'chunk') {
      const chunk = frame.chunk;
      if (this.chunkIsVisible(chunk)) state.stepOutput = 'visible';
      else if (chunk.type === 'reasoning-delta' && state.stepOutput === 'none') state.stepOutput = 'reasoning';
      this.onAssistantChunk(sessionId, state, chunk);
    }
  }

  private onAssistantChunk(
    sessionId: SessionId,
    state: SessionState,
    modelChunk: AssistantChunk,
  ): void {
    if (!this.sessionConfig(sessionId).loopGuard || !state.running || state.loopFired) return;
    // kata ab45: a degenerate function-call argument stream emits an unending run of whitespace and
    // never closes its JSON. Whitespace-only deltas accumulate; any real content resets the run.
    if (modelChunk.type === 'tool-call-delta') {
      const delta = modelChunk.argumentsDelta;
      // An empty delta carries no characters: it neither extends nor breaks the run.
      if (delta !== '') {
        if (/^\s+$/u.test(delta)) {
          state.toolArgWhitespaceRun += delta.length;
          if (state.toolArgWhitespaceRun >= TOOL_ARG_GUARD.whitespaceRunChars) {
            if (!state.toolArgTripLogged) {
              state.toolArgTripLogged = true;
              this.log(`检测到工具参数复读 ${sessionId}: 连续 ${state.toolArgWhitespaceRun} 字符空白`);
            }
            // Pre-check the cooldown so a refused trip logs at most one skip line per step.
            if (Date.now() - state.lastAttemptAt < this.cooldownFor(state)) {
              if (!state.toolArgCooldownLogged) {
                state.toolArgCooldownLogged = true;
                this.log(`跳过循环打断 ${sessionId}: 处于冷却期`);
              }
              return;
            }
            this.interruptLoop(sessionId, state);
            return;
          }
        } else {
          state.toolArgWhitespaceRun = 0;
        }
      }
    }
    // Reasoning-only step whose reasoning is mostly one sentence repeated, or whose lines are
    // mostly one short repeated line (vrpe, both arms of REASON_DENSITY). The gate is unchanged:
    // only a reasoning delta, and only while the step has produced no visible output.
    if (modelChunk.type === 'reasoning-delta' && state.stepOutput !== 'visible' &&
      state.reasonDensity.feed(modelChunk.text)) {
      this.onReasoningSpiral(sessionId, state);
      return;
    }
    const chunk = this.assistantChunkText(modelChunk);
    if (chunk === '') return;
    const merged = `${state.streamTail}${chunk}`.replace(/\r/g, '');
    const pieces = merged.split(/\n(?:[ \t]*\n)+/u);
    const tail = pieces.pop() ?? '';
    for (const piece of pieces) this.noteStreamSegment(sessionId, state, piece);
    if (tail.length <= STREAM_TAIL_MAX_CHARS) {
      state.streamTail = tail;
      return;
    }
    state.streamTail = tail.slice(-STREAM_TAIL_MAX_CHARS);
    if (/\S/u.test(tail)) {
      state.streamLastSegment = '';
      state.streamRepeatRun = 0;
    }
  }

  private onAssistantMessage(
    sessionId: SessionId,
    state: SessionState,
    event: SessionEvent<'assistant/message'>,
  ): void {
    if (!this.sessionConfig(sessionId).loopGuard) return;
    const text = this.assistantText(event);
    const trimmed = visibleText(text);
    // 相同文本重复(不限长度): 模型反复输出完全相同的消息是最强的循环信号,
    // 例如 "Let me test variants of the regex..." 连续 7 遍
    if (trimmed !== '' && trimmed === state.lastAssistantText) {
      state.sameTextRun += 1;
    } else {
      state.lastAssistantText = trimmed;
      state.sameTextRun = trimmed === '' ? 0 : 1;
    }
    // 短句计数(长度 < loopShortChars 且落在时间窗内): 空转信号
    if (trimmed.length < this.getConfig().loopShortChars) {
      const now = Date.now();
      if (now - state.lastShortAt > this.getConfig().loopWindowMs) {
        state.shortRun = 0; // 超过时间窗: 上一次短句太久远, 不算连续
      }
      state.shortRun += 1;
      state.lastShortAt = now;
    } else {
      state.shortRun = 0; // 长句 = 有实际输出, 重置
      state.lastShortAt = 0;
    }
    const streamTail = state.streamTail;
    state.streamTail = '';
    if (streamTail !== '') this.noteStreamSegment(sessionId, state, streamTail);
    state.streamLastSegment = '';
    state.streamRepeatRun = 0;
    this.trackReasoningRepeat(state, event.data.message.content);
    this.checkLoop(sessionId, state);
  }

  /**
   * Repeated reasoning-only messages, counted across turns. Visible output ends the run; a reasoning-only message
   * extends it when its normalised reasoning equals the previous one, else starts a new run; a message with no
   * content leaves the run unchanged.
   */
  private trackReasoningRepeat(state: SessionState, content: unknown): void {
    const output = this.messageOutput(content);
    if (output === 'none') return;
    if (output === 'visible') {
      state.reasoningRepeatRun = 0;
      return;
    }
    const key = visibleText(reasoningText(content));
    if (key !== '' && key === state.reasoningRepeatText) {
      state.reasoningRepeatRun += 1;
    } else {
      state.reasoningRepeatText = key;
      state.reasoningRepeatRun = key === '' ? 0 : 1;
    }
  }

  /** 两个循环信号的公共检查; 命中且本回合未打断过则打断。 */
  private checkLoop(
    sessionId: SessionId,
    state: SessionState,
    toolRepeat?: ToolRepeatSignal,
  ): void {
    if (!this.sessionConfig(sessionId).loopGuard) return;
    if (state.loopFired) return;
    if (!state.running) return; // 只干预运行中的回合
    const config = this.getConfig();
    if (state.sameTextRun >= config.loopRepeatText) {
      this.log(`检测到空转循环 ${sessionId}: 连续 ${state.sameTextRun} 条相同消息`);
      this.interruptLoop(sessionId, state);
    } else if (state.reasoningRepeatRun >= config.loopRepeatText) {
      this.log(`loop guard ${sessionId}: ${state.reasoningRepeatRun} identical reasoning-only messages in a row`);
      this.interruptLoop(sessionId, state);
    } else if (state.shortRun >= config.loopShortCount) {
      this.log(`检测到空转循环 ${sessionId}: 连续 ${state.shortRun} 条短句且无工具调用`);
      this.interruptLoop(sessionId, state);
    } else if (toolRepeat !== undefined && toolRepeat.count >= config.loopToolRepeat) {
      this.log(`检测到工具死循环 ${sessionId}: 「${toolRepeat.tool}」连续 ${toolRepeat.count} 次(同参数同结果)`);
      this.interruptLoop(sessionId, state);
    }
  }

  /**
   * 打断运行中的回合: cancel(带来源标记)+ 进冷却。
   * 只有随后持久化的 turn/end 精确携带专属 hook cause 时,
   * 才会用 loopText 重启回合——DSH 的 first-cause 语义保证用户 Stop 优先。
   */
  private interruptLoop(sessionId: SessionId, state: SessionState): void {
    if (this.isSubagent(sessionId, state)) return;
    if (state.loopFired) return;
    // 打断本身受冷却约束: 距上次打断/发送太近时不再打断, 防止反复打断刷屏
    if (Date.now() - state.lastAttemptAt < this.cooldownFor(state)) {
      this.log(`跳过循环打断 ${sessionId}: 处于冷却期`);
      return;
    }
    state.loopFired = true;
    state.lastAttemptAt = Date.now(); // 打断计入冷却, 防反复打断
    try {
      const agent = this.ctx.agents.get(sessionId);
      if (agent === undefined) {
        this.log(`打断循环失败 ${sessionId}: 无 live agent`);
        state.loopFired = false;
        return;
      }
      agent.cancel(LOOP_GUARD_CANCEL_CAUSE, { keepInbox: true });
      this.log(`已打断循环 ${sessionId}: cancel 已受理`);
    } catch (error) {
      this.log(`打断循环失败 ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      state.loopFired = false;
    }
  }

  private onSessionEvent(sessionId: SessionId, event: SessionEvent): void {
    const state = this.state(sessionId);
    switch (event.type) {
      case 'turn/start':
        state.running = true;
        state.maintenanceTurn = isMaintenanceTurnStart(event) ? event.data.turn : undefined;
        if (state.maintenanceTurn !== undefined) state.pendingRecoveryAt = 0;
        // 新回合开始: 清空上一步工具调用状态, 避免跨回合误用护栏
        state.tools.startTurn(event.seq);
        // loop guard 状态按回合重置
        state.shortRun = 0;
        state.lastShortAt = 0;
        state.lastAssistantText = '';
        state.sameTextRun = 0;
        state.streamTail = '';
        state.streamLastSegment = '';
        state.streamRepeatRun = 0;
        state.loopFired = false;
        state.spiralTripped = false;
        state.turnOutput = 'empty';
        state.stepOutput = 'none';
        state.reasonDensity.reset();
        state.toolArgWhitespaceRun = 0;
        state.toolArgTripLogged = false;
        state.toolArgCooldownLogged = false;
        state.reasoningOnlyUnits = 0;
        state.outputTurn = event.data.turn;
        state.outputStartSeq = event.seq;
        if (state.loopRetryTimer !== undefined) {
          clearTimeout(state.loopRetryTimer);
          state.loopRetryTimer = undefined;
        }
        this.cancelPending(sessionId, '宿主自行开启新回合');
        break;
      case 'turn/end': {
        state.running = false;
        const loopCancelPending = state.loopFired;
        state.loopFired = false;
        const spiralTripped = state.spiralTripped;
        state.spiralTripped = false;
        this.cancelPending(sessionId, '收到新的 turn/end');
        const turnOutput = state.outputTurn === event.data.turn ? state.turnOutput : 'unknown';
        state.turnOutput = 'unknown';
        state.outputTurn = undefined;
        // vrpe NH-1: read this turn's last-step output and reasoning size, then clear them, so a turn/end with no
        // preceding turn/start does not inherit the previous turn's state (turn/start resets both; step/start resets stepOutput).
        const lastStepOutput = state.stepOutput;
        const lastReasoningUnits = state.reasoningOnlyUnits;
        state.stepOutput = 'none';
        state.reasoningOnlyUnits = 0;
        const maintenance = state.maintenanceTurn !== undefined && state.maintenanceTurn === event.data.turn;
        state.maintenanceTurn = undefined;
        if (maintenance) {
          this.log(`跳过维护回合 ${sessionId}(message-ops): 不触发自动继续`);
          break;
        }
        const reason = event.data.reason;
        const reasonKind = readReasonKind(reason);
        if (reasonKind === undefined) {
          console.error(`[auto-continue] 忽略畸形 turn/end ${sessionId}: reason 无法解释`);
          break;
        }
        if (reasonKind === 'no-visible-output' || (reasonKind === 'completed' && turnOutput === 'silent')) {
          // 已观察到模型活动但没有可见输出; 没有模型活动的空回合不属于此类。
          // 不清零 consecutive: 每轮都卡住的模型仍受冷却与连续上限约束。
          // `no-visible-output` 是 DSH 为同一种回合提议的结束原因, 按同样方式处理。
          state.lastFailure = undefined;
          state.lastTurn = event.data.turn;
          state.lastFailureAt = Date.now();
          this.noteRecovery(sessionId, 'error');
          const config = this.sessionConfig(sessionId);
          if ((config.resumeSilentTurns || config.resumeCompletedTurns) && spiralTripped) {
            // 复读信号: 本回合推理内句子高度重复, 且之后没有可见输出。强制续跑一次, 带循环文本。
            // 同一复读事件只升级一次 (spiralEscalated 是防复读上限); 之后仍无可见输出则停止, 并通知用户 (config.notify)。
            this.escalateSpiral(sessionId, `turn/end:${reasonKind}`, config);
          } else if (config.resumeCompletedTurns || config.resumeSilentTurns) {
            // vrpe F-A3: size alone does not skip the resume. A long reasoning-only turn without a spiral signal is resumed as usual.
            if (reasonKind === 'completed' && lastReasoningUnits >= SILENT_REASONING_SKIP_UNITS) {
              this.log(`长推理回合 ${sessionId}: 无推理复读信号, 按普通回合续跑 (${lastReasoningUnits} 字)`);
            }
            // 自主循环覆盖无可见输出的回合, 但这类回合是「失败」而非成功:
            // 不 force, 否则会绕过连续上限与冷却, 让卡住的模型无限重试。
            if (config.resumeCompletedTurns) this.schedule(sessionId, LOOP_SILENT_REASON);
            else this.schedule(sessionId, `turn/end:${reasonKind}:silent`);
          }
          break;
        }
        if (reasonKind === 'completed') {
          // A visible completion ends the spiral episode, so the next spiral may escalate again.
          if (turnOutput === 'visible') state.spiralEscalated = false;
          // Only observed visible output proves recovery; no-op and unknown
          // turns must not erase the retry budget or count as successful.
          // 自主循环的例外只在于「是否续跑」, 不在于「是否清零预算」: 循环对每个
          // completed 回合都强制续跑, 但失败预算依旧只在可见输出时清零, 否则
          // 空回合/未观察到的回合会不断抹掉连续计数, 令连续上限永远无法生效。
          if (this.sessionConfig(sessionId).resumeCompletedTurns) {
            if (turnOutput === 'visible') {
              state.consecutive = 0;
              state.lastFailure = undefined;
              this.noteRecovery(sessionId, 'completed');
            }
            this.schedule(sessionId, LOOP_COMPLETED_REASON, true);
          } else if (turnOutput === 'visible') {
            state.consecutive = 0;
            state.lastFailure = undefined;
            this.noteRecovery(sessionId, 'completed');
          }
        } else if (reasonKind === 'aborted') {
          if (isLoopGuardCancelReason((reason as { reason?: unknown }).reason)) {
            if (this.sessionConfig(sessionId).paused) break;
            // 我们自己的 loop guard 打断: 视为可恢复中断, 用循环提示文本重启回合。
            // 不清 consecutive / lastAttemptAt: 冷却与连续上限在 loop 路径同样生效,
            // 防止无限打断重发(issue #13); 打断本身受冷却约束, 重启也要等冷却。
            if (loopCancelPending) this.bumpStat({ looped: 1 });
            state.pendingRecoveryAt = 0;
            state.shortRun = 0;
            state.lastShortAt = 0;
            state.lastAssistantText = '';
            state.sameTextRun = 0;
            state.reasoningRepeatRun = 0;
            state.streamTail = '';
            state.streamLastSegment = '';
            state.streamRepeatRun = 0;
            state.tools.resetRepeat();
            // 重启受冷却约束(防紧密打断循环): 等剩余冷却结束后再调度
            const cooldown = this.cooldownFor(state);
            const remaining = cooldown - (Date.now() - state.lastAttemptAt);
            if (remaining > 0) {
              if (state.loopRetryTimer !== undefined) clearTimeout(state.loopRetryTimer);
              state.loopRetryTimer = setTimeout(() => {
                state.loopRetryTimer = undefined;
                try {
                  this.schedule(sessionId, 'loop:aborted');
                } catch (error) {
                  console.error(`[auto-continue] loop 重启异常 ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
                }
              }, remaining + 10); // +10ms: the schedule re-check compares Date.now() against the cooldown; a 1ms wall-clock step can otherwise make it read just under, silently dropping the restart
              this.log(`loop 重启延迟 ${remaining}ms(冷却期) ${sessionId}`);
            } else {
              this.schedule(sessionId, 'loop:aborted');
            }
          } else {
            // 用户主动停止: 不自动继续, 视为用户介入
            state.consecutive = 0;
            state.pendingRecoveryAt = 0;
          }
        } else if (reasonKind === 'blocked') {
          // 策略拒绝: 不自动继续
        } else if (reasonKind === 'interrupted') {
          // 实时路径的 interrupted 仅来自崩溃修复重载(loop 从不实时发出);
          // 用户手动停止在 DSH 中标记为 aborted, 不走到这里。实时流里出现
          // interrupted 视为异常中断, 不自动继续——宿主崩溃孤儿回合由扫描恢复。
          state.consecutive = 0;
          state.pendingRecoveryAt = 0;
        } else if (reasonKind === 'error') {
          // 记录失败事实(分类与模板填充用), 然后按类型处理
          const failure = parseFailureFacts((reason as { error?: unknown }).error);
          if (failure === undefined) {
            console.error(`[auto-continue] 忽略畸形 turn/end ${sessionId}: error details 无法解释`);
            break;
          }
          state.lastFailure = failure;
          state.lastTurn = event.data.turn;
          state.lastFailureAt = Date.now();
          this.noteRecovery(sessionId, 'error');
          this.onTurnFailure(sessionId, 'turn/end:error', state.lastFailure);
        } else if (reasonKind === 'max-tokens') {
          state.lastFailureAt = Date.now();
          this.noteRecovery(sessionId, 'error');
          // Round 4 (vrpe F-A2, H14, O2): the spiral signal decides, not the last step being reasoning, and this site
          // has no size floor, so a short reasoning-only stop is no longer dropped. Without a spiral the turn is
          // ordinary and is continued with the max-tokens text, as the base plugin did. With a spiral it gets exactly
          // one forced resume carrying config.loopText, then the stop notice.
          const config = this.getConfig();
          if (spiralTripped && lastStepOutput !== 'visible') {
            this.escalateSpiral(sessionId, 'turn/end:max-tokens', config);
          } else {
            this.schedule(sessionId, 'turn/end:max-tokens');
          }
        }
        break;
      }
      case 'user/message':
        if (isOurEcho(state, event)) break; // 我们自己的回显(跨标签页识别)
        if (event.data.source.kind === 'user') {
          // 用户手动介入: 清零上限与跨标签页发送计数
          state.consecutive = 0;
          state.spiralEscalated = false;
          this.cancelPending(sessionId, '用户手动发送消息');
        }
        break;
      default:
        break;
    }
  }

  // ---------- host 帧 ----------

  private onTurnFailure(sessionId: SessionId, reason: string, failure: FailureFacts): void {
    const config = this.getConfig();
    if (sessionMode(config.sessionModes, sessionId) === 'off') return;
    if (config.classify && !isTransientFailure(failure, config.retryableErrorPatterns)) {
      const copy = NOTICE_COPY[config.locale];
      const summary = `${failure.code}${failure.status !== undefined ? ` (HTTP ${failure.status})` : ''}`;
      this.log(`跳过 ${sessionId}(${reason}): 永久性失败 ${summary} — ${failure.message}`);
      this.bumpStat({ skipped: 1, code: failure.code });
      if (config.notify) {
        this.notify(
          sessionId,
          copy.notContinuedTitle,
          copy.permanentErrorBody(sessionId, summary),
          this.notifyOptions(sessionId, config.locale),
        );
      }
      return;
    }
    this.schedule(sessionId, reason);
  }

  /**
   * Round 4 (vrpe O2), tightened in round 5 (reviewer F1): the spiral refusal at every site, so no site can end a
   * session with a log line only. One forced resume carrying config.loopText per episode, then the stop and its
   * notice. The bound is state.spiralEscalated, and fire() sets it only when the forced resume was really delivered
   * (round 4 set it here, before any send existed, so a paused schedule or a cancelled grace timer spent the bound and
   * the next stop notice claimed a resume that never happened). While the forced attempt is queued, scheduleAttempt
   * returns on its pending timer, so a second spiral cannot queue a second send. An episode ends at a visible
   * completion or a human message, as in round 3. `site` names the refusing site, so every site keeps its own log line.
   */
  private escalateSpiral(sessionId: SessionId, site: string, config: AutoContinueConfig): void {
    const state = this.state(sessionId);
    if (!state.spiralEscalated) {
      if (this.schedule(sessionId, LOOP_SPIRAL_REASON, true)) {
        this.log(`升级 ${sessionId}(${site}): 推理复读, 强制续跑一次 (${LOOP_SPIRAL_REASON})`);
      }
      return;
    }
    this.log(`停止 ${sessionId}(${site}): 推理复读, 强制续跑一次后仍无可见输出, 需要人工介入`);
    this.notifySpiralStopped(sessionId, config);
  }

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
  private persistedSpiralEscalated(
    events: readonly SessionEvent[],
    end: SessionEvent | undefined,
    config: AutoContinueConfig,
  ): boolean {
    if (end === undefined) return false;
    const expected = config.loopText.trim();
    if (expected === '') return false;
    // Round 5 review (V11 finding 1, D6, D7): the loop text alone is a substring a user can type, so it is not evidence
    // of this plugin's send. fire() appends the guard suffix (buildContinueText, engine.ts:1792-1798), and the literal
    // parts of that suffix are what a human is unlikely to reproduce, so a recorded send must contain them in order.
    // A shape is trusted only when its tail after the last placeholder is long enough to be a real fixed closing part:
    // '(note) {tool}' has no tail, and a human can type both its head and the loop text (D7). With a shape that has no
    // trustworthy tail the read never claims an escalation, which can only cause one more forced resume, never a false
    // stop notice. With guardTools off fire() sends the bare loop text, so exact trimmed equality recognises that send.
    const GUARD_TAIL_MIN = 8;
    const guardShapes = config.guardTools === false
      ? []
      : [config.guardPendingText, config.guardDoneText]
        .map((template) => template.split(/\{[^}]*\}/g))
        .filter((segments) => {
          const literals = segments.filter((segment) => segment.trim() !== '');
          const tail = segments[segments.length - 1] ?? '';
          return literals.length > 0 && tail.trim().length >= GUARD_TAIL_MIN;
        });
    const sentShape = (text: string): boolean => {
      if (config.guardTools === false) return text.trim() === expected;
      if (!text.includes(expected)) return false;
      return guardShapes.some((segments) => {
        let at = 0;
        for (const segment of segments) {
          if (segment.trim() === '') continue;
          const found = text.indexOf(segment, at);
          if (found < 0) return false;
          at = found + segment.length;
        }
        return true;
      });
    };
    let visibleAfter = false;
    for (let i = events.indexOf(end) - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event === undefined) continue;
      if (event.type === 'assistant/message') {
        if (this.hasVisibleContent(event.data.message.content)) visibleAfter = true;
        continue;
      }
      if (event.type !== 'user/message') continue;
      // Our sends carry source.kind 'user' (fire(), createUserMessage); anything else is not this plugin's escalation.
      if (event.data.source.kind !== 'user') continue;
      // The newest user message bounds the episode: a visible completion after it means the spiral episode it opened
      // is over, and a message without the loop text means a human intervened or another site continued the session.
      if (visibleAfter) return false;
      const content = event.data.content;
      if (!Array.isArray(content)) return false;
      return (content as { type?: unknown; text?: unknown }[]).some(
        (part) => part?.type === 'text' && typeof part.text === 'string' && sentShape(part.text),
      );
    }
    return false;
  }

  /** Round 4: the stop notice every spiral site shares. Silent unless config.notify is on, like the other notices. */
  private notifySpiralStopped(sessionId: SessionId, config: AutoContinueConfig, child = false): void {
    if (!config.notify) return;
    const copy = NOTICE_COPY[config.locale];
    const body = child ? copy.spiralChildStoppedBody(sessionId) : copy.spiralStoppedBody(sessionId);
    this.notify(sessionId, copy.stoppedTitle, body, this.notifyOptions(sessionId, config.locale));
  }

  /** 通知操作按钮与回调(「立即续跑」/「暂停该会话 1 小时」)。 */
  private notifyOptions(sessionId: SessionId, locale: AutoContinueLocale): NotifyOptions {
    const copy = NOTICE_COPY[locale];
    // 未物化的存储会话没有 live agent, 「立即续跑」只会空转; 只保留暂停。
    const actions: NotifyAction[] = this.ctx.agents.get(sessionId) === undefined
      ? [{ action: 'pause1h', title: copy.pauseAction }]
      : [
        { action: 'resume', title: copy.resumeAction },
        { action: 'pause1h', title: copy.pauseAction },
      ];
    return { actions, onAction: (action) => this.onNotifyAction(sessionId, action) };
  }

  private onNotifyAction(sessionId: SessionId, action: string): void {
    if (action === 'resume') {
      this.log(`通知按钮: 立即续跑 ${sessionId}`);
      void this.resumeNow(sessionId);
    } else if (action === 'pause1h') {
      this.log(`通知按钮: 暂停 ${sessionId} 1 小时`);
      this.pauseUntil.set(sessionId, Date.now() + 60 * 60 * 1000);
      this.cancelPending(sessionId, '通知按钮暂停该会话');
    }
  }


  /** 内存统计(host 单实例): 按今日桶累计。 */
  private bumpStat(delta: {
    sent?: number;
    skipped?: number;
    recovered?: number;
    failed?: number;
    gaveUp?: number;
    looped?: number;
    code?: string;
  }): void {
    const today = todayKey();
    if (this.dayStats.date !== today) this.dayStats = emptyDayStats();
    if (delta.sent !== undefined) this.dayStats.sent += delta.sent;
    if (delta.skipped !== undefined) this.dayStats.skipped += delta.skipped;
    if (delta.recovered !== undefined) this.dayStats.recovered += delta.recovered;
    if (delta.failed !== undefined) this.dayStats.failed += delta.failed;
    if (delta.gaveUp !== undefined) this.dayStats.gaveUp += delta.gaveUp;
    if (delta.looped !== undefined) this.dayStats.looped += delta.looped;
    if (delta.code !== undefined) {
      this.dayStats.byCode[delta.code] = (this.dayStats.byCode[delta.code] ?? 0) + 1;
    }
    // Stats are only observable through the status bridge, so every bump must
    // publish. Previously the panel only moved when a notification happened to
    // fire (notify=false by default), leaving "Auto-continued" frozen at 0.
    this.emitState();
  }

  /** 通知桥: 产生一条通知事件, SSE 端点推给 browser 侧展示。 */
  private notify(
    sessionId: SessionId,
    title: string,
    body: string,
    options?: NotifyOptions,
  ): void {
    const notice: HostNotice = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      title,
      body,
      sessionId,
      ...(options?.actions !== undefined && options.actions.length > 0
        ? { actions: options.actions }
        : { actions: [] }),
      at: Date.now(),
    };
    this.notices.push(notice);
    for (const listener of this.noticeListeners) listener();
    this.emitState();
  }

  /** 恢复结果记账: 自动发送后窗口内的回合结束, 判定恢复成功或失败。 */
  private noteRecovery(sessionId: SessionId, outcome: 'completed' | 'error'): void {
    const state = this.state(sessionId);
    if (state.pendingRecoveryAt === 0) return;
    if (Date.now() - state.pendingRecoveryAt > RECOVERY_WINDOW_MS) {
      state.pendingRecoveryAt = 0; // 窗口过期, 不再归属这次发送
      return;
    }
    state.pendingRecoveryAt = 0;
    this.bumpStat(outcome === 'completed' ? { recovered: 1 } : { failed: 1 });
    this.log(`恢复结果(${sessionId}): ${outcome === 'completed' ? '成功' : '失败'}`);
  }

  /** 立即为该会话发送一次自动继续(无视冷却与连续上限; 由通知按钮触发)。 */
  async resumeNow(sessionId: SessionId): Promise<void> {
    if (this.disposed) return;
    const state = this.state(sessionId);
    if (this.isSubagent(sessionId, state)) return;
    if (state.pendingTimer !== undefined) {
      clearTimeout(state.pendingTimer);
      state.pendingTimer = undefined;
    }
    try {
      await this.fire(sessionId, MANUAL_NOTIFICATION_REASON, true);
    } catch (error) {
      console.error(`[auto-continue] 手动续跑异常 ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 本会话当前生效的冷却间隔(自适应退避)。 */
  private cooldownFor(state: SessionState): number {
    const config = this.getConfig();
    return effectiveCooldown(
      state.consecutive,
      config.cooldownMs,
      config.backoffFactor,
      config.backoffMaxMs,
    );
  }

  /** Round 5 (reviewer F1): true when the attempt is queued and will be sent, false when it was refused or merged. */
  private schedule(sessionId: SessionId, reason: string, force = false): boolean {
    return this.scheduleAttempt(sessionId, reason, force);
  }

  private scheduleAttempt(sessionId: SessionId, reason: string, force = false): boolean {
    const state = this.state(sessionId);
    const config = this.sessionConfig(sessionId);
    if (isLoopReason(reason) && !config.resumeCompletedTurns) return false;
    if (this.isSubagent(sessionId, state)) return false; // 子代理会话由父代理处理, 不抢跑
    if (config.paused) {
      this.log(`跳过 ${sessionId}(${reason}): 自动继续已暂停`);
      return false;
    }
    if (Date.now() < (this.pauseUntil.get(sessionId) ?? 0)) {
      this.log(`跳过 ${sessionId}(${reason}): 会话暂停中`);
      return false;
    }
    if (state.pendingTimer !== undefined) return false; // 已有待发送
    // 连续上限优先于冷却: 已经放弃的会话不该再安排冷却后的重试。
    // 自主循环的完成续跑(force)不受二者约束。
    if (!force && state.consecutive >= config.maxConsecutive) {
      this.log(
        `跳过 ${sessionId}(${reason}): 已连续自动继续 ${state.consecutive} 次, 等待用户介入或成功回合`,
      );
      return false;
    }
    // 冷却(含失败尝试, 自适应退避): 不能直接丢弃这次恢复, 否则一次瞬时失败
    // 会把会话搁置到用户手动介入为止。
    if (!force) {
      const remaining = this.cooldownFor(state) - (Date.now() - state.lastAttemptAt);
      if (remaining > 0) {
        this.deferCooldownRetry(sessionId, reason, remaining);
        return false;
      }
    }
    const timer = setTimeout(() => {
      if (state.pendingTimer !== timer) return;
      state.pendingTimer = undefined;
      state.pendingReason = undefined;
      // 保险丝: 定时器回调内任何异常(含 inactive context)都不得成为未捕获异常炸掉进程。
      try {
        void this.fire(sessionId, reason, force);
      } catch (error) {
        console.error(`[auto-continue] 定时发送异常 ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, config.graceMs);
    state.pendingTimer = timer;
    state.pendingReason = reason;
    const template = this.templateFor(config, reason);
    this.log(
      `检测到非人为中断 ${sessionId}(${reason}), ${config.graceMs}ms 后自动发送「${template}」`,
    );
    return true;
  }

  /**
   * 冷却期内的恢复: 等到冷却结束再重新调度。
   * 直接丢弃会让一次瞬时失败把会话搁置, 直到用户手动发消息才恢复。
   */
  private deferCooldownRetry(sessionId: SessionId, reason: string, remaining: number): void {
    const state = this.state(sessionId);
    if (state.cooldownRetryTimer !== undefined) clearTimeout(state.cooldownRetryTimer);
    state.pendingReason = reason;
    state.cooldownRetryTimer = setTimeout(() => {
      state.cooldownRetryTimer = undefined;
      state.pendingReason = undefined;
      try {
        this.schedule(sessionId, reason);
      } catch (error) {
        console.error(`[auto-continue] 冷却后重试异常 ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, remaining + 10); // +10ms: 同 loop 重启; 否则 1ms 抖动可能让重检仍判为冷却期而再次丢弃
    this.log(`冷却中 ${sessionId}(${reason}), ${remaining}ms 后重试`);
  }

  /** 按调度原因选择续跑模板: loop 重启、无输出回合、max-tokens、自主循环, 其余用通用继续文本。 */
  private templateFor(config: AutoContinueConfig, reason: string): string {
    if (reason.startsWith('loop:')) return config.loopText;
    // 自主循环的两种原因都用循环文本(顺序在 `:silent` 之前: 循环模式决定文本)。
    if (isLoopReason(reason)) return config.continueTextLoop;
    if (reason.endsWith(':silent')) return config.continueTextSilent;
    if (reason.includes('max-tokens')) return config.continueTextMaxTokens;
    if (reason.includes('interrupted')) return config.continueTextInterrupted;
    return config.continueText;
  }

  private cancelPending(sessionId: SessionId, why: string): void {
    const state = this.state(sessionId);
    state.pendingReason = undefined;
    let cancelled = false;
    if (state.pendingTimer !== undefined) {
      clearTimeout(state.pendingTimer);
      state.pendingTimer = undefined;
      cancelled = true;
    }
    // 冷却后的重试同样属于「待发送」: 新回合或用户介入必须让它作废。
    if (state.cooldownRetryTimer !== undefined) {
      clearTimeout(state.cooldownRetryTimer);
      state.cooldownRetryTimer = undefined;
      cancelled = true;
    }
    if (state.loopRetryTimer !== undefined) {
      clearTimeout(state.loopRetryTimer);
      state.loopRetryTimer = undefined;
      cancelled = true;
    }
    if (cancelled) this.log(`取消 ${sessionId} 的自动继续(${why})`);
  }

  private fire(sessionId: SessionId, reason: string, force = false): void {
    if (this.disposed) return;
    const state = this.state(sessionId);
    const config = this.sessionConfig(sessionId);
    const manualResume = force && reason === MANUAL_NOTIFICATION_REASON;
    if (reason.endsWith(':silent') && !config.resumeSilentTurns) return;
    // 宽限期内循环被关闭: 发送前必须重新检查开关, 与 :silent 恢复同样处理。
    // 否则「关掉循环」后仍会多发出一次续跑。
    if (isLoopReason(reason) && !config.resumeCompletedTurns) return;
    if (this.isSubagent(sessionId, state)) return; // 子代理会话由父代理处理, 不抢跑
    if (config.paused && !manualResume) {
      this.log(`跳过 ${sessionId}(${reason}): 自动继续已暂停`);
      return;
    }
    if (!manualResume && Date.now() < (this.pauseUntil.get(sessionId) ?? 0)) {
      this.log(`跳过 ${sessionId}(${reason}): 会话暂停中`);
      return;
    }
    // 冷却(自适应退避)与连续上限; 通知按钮的强制续跑不受约束
    if (!force && Date.now() - state.lastAttemptAt < this.cooldownFor(state)) {
      this.log(`跳过 ${sessionId}(${reason}): 处于冷却期`);
      return;
    }
    if (!force && state.consecutive >= config.maxConsecutive) {
      this.log(`跳过 ${sessionId}(${reason}): 已连续自动继续 ${state.consecutive} 次, 等待用户介入或成功回合`);
      return;
    }
    // 模板填充: continueText 可含 {code}/{message}/{status}/{tool}/{turn}/{errorCount}/{sessionTitle}/{elapsed} 占位符
    const template = this.templateFor(config, reason);
    const text = this.buildContinueText(config, state, template);
    // 发送: followup 负责唤醒; 同步 inbox 插入事件会在唤醒前把本消息移到已有队列之前。
    const agent = this.ctx.agents.get(sessionId);
    if (agent === undefined) {
      this.log(`跳过 ${sessionId}(${reason}): 无 live agent`);
      return;
    }
    state.lastAttemptAt = Date.now(); // 先记账: 无论成败, 本次尝试都进入冷却
    try {
      const message = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      });
      // `followup` may publish the matching session event synchronously.
      trackPendingEcho(state, message.id);
      if (agent.inbox.nextTurn.length > 0) this.prioritizedFollowups.add(message.id);
      try {
        agent.followup(message);
      } catch (error) {
        forgetPendingEcho(state, message.id);
        throw error;
      } finally {
        this.prioritizedFollowups.delete(message.id);
      }
      const now = Date.now();
      // Round 5 (reviewer F1): the anti-replay bound is spent only by a delivered forced resume, so a refused schedule
      // or a cancelled grace timer cannot make the next stop notice claim a resume that never happened.
      if (reason === LOOP_SPIRAL_REASON) state.spiralEscalated = true;
      // 自主循环的成功续跑不计入连续上限: 上限只约束失败(网络中断等)。
      if (reason !== LOOP_COMPLETED_REASON) state.consecutive += 1;
      state.pendingRecoveryAt = now; // 等待窗口内的下一个回合结束来判定恢复结果
      if (reason !== LOOP_COMPLETED_REASON) {
        this.recoveryAttempts.unshift({
          sessionId, at: now, consecutive: state.consecutive,
          reason: manualResume ? 'manual'
            : reason === 'loop:aborted' ? 'loop-guard'
            : reason.endsWith(':silent') || reason === LOOP_SILENT_REASON ? 'silent'
            : reason.endsWith(':interrupted') ? 'interrupted'
            : reason.endsWith(':max-tokens') ? 'max-tokens' : 'error',
        });
        this.recoveryAttempts.length = Math.min(this.recoveryAttempts.length, 20);
      }
      this.bumpStat({ sent: 1, ...(state.lastFailure !== undefined ? { code: state.lastFailure.code } : {}) });
      this.log(`已自动发送「${text}」到 ${sessionId}(${reason}), 第 ${state.consecutive} 次连续`);
      if (config.notify) {
        const copy = NOTICE_COPY[config.locale];
        this.notify(
          sessionId,
          copy.continuedTitle,
          copy.continuedBody(sessionId, text, state.consecutive),
          this.notifyOptions(sessionId, config.locale),
        );
      }
      if (state.consecutive >= config.maxConsecutive) {
        this.bumpStat({ gaveUp: 1 });
        this.log(`达到连续上限 ${config.maxConsecutive} 次, 停止自动继续 ${sessionId}`);
        if (config.notify) {
          const copy = NOTICE_COPY[config.locale];
          this.notify(
            sessionId,
            copy.stoppedTitle,
            copy.stoppedBody(sessionId, state.consecutive),
            this.notifyOptions(sessionId, config.locale),
          );
        }
      }
    } catch (error) {
      this.log(`发送异常 ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 组装本次续跑消息: 模板填充 + 幂等护栏。
   * 护栏依据上一步工具调用的执行状态附加指引, 防止重跑副作用操作:
   * - 结果未确认(可能已部分执行)→ 提示先确认状态、不要重复执行
   * - 已确认成功 → 提示已完成、不要重复执行
   * - 已失败 → 不加护栏(重试工具本来就是目的)
   */
  private buildContinueText(
    config: AutoContinueConfig,
    state: SessionState,
    template: string,
  ): string {
    let text = fillTemplate(template, {
      facts: state.lastFailure,
      tool: state.tools.lastTool(),
      turn: state.lastTurn,
      errorCount: state.consecutive + 1,
      elapsedMs: state.lastFailureAt > 0 ? Date.now() - state.lastFailureAt : undefined,
    });
    if (!config.guardTools) return text;
    const guard = this.currentGuard(state);
    if (guard.kind === 'pending') {
      text += ` ${fillTemplate(config.guardPendingText, { tool: guard.tool, result: guard.result })}`;
    } else if (guard.kind === 'done') {
      text += ` ${fillTemplate(config.guardDoneText, { tool: guard.tool, result: guard.result })}`;
    }
    return text;
  }

  /** 上一步工具调用的护栏状态(实时路径, 由 mux 帧维护)。 */
  private currentGuard(state: SessionState): {
    kind: 'none' | 'pending' | 'done' | 'failed';
    tool?: string;
    result?: string;
  } {
    return state.tools.guard();
  }

  private async bootScanLoop(): Promise<void> {
    // Sessions restored after this window are too old for startup recovery.
    // Keep polling only within that window, including while globally paused.
    const deadline = Date.now() + this.getConfig().freshMs;
    this.bootDeadline = deadline;
    for (let attempt = 0; !this.disposed; attempt += 1) {
      if (attempt > 0 && Date.now() >= deadline) return;
      try {
        if (await this.scanInterrupted()) return;
        const config = this.getConfig();
        if (!config.paused && config.scanOnBoot && this.storedSweep === undefined) {
          this.storedSweep = this.sweepStoredSessions(config, deadline)
            .catch(error => {
              if (!this.disposed) this.ctx.logger.error(`Stored session scan failed: ${String(error)}`);
            })
            .finally(() => { this.storedSweep = undefined; });
        }
      } catch (error) {
        if (this.disposed) return;
        // 宿主未就绪时每 3s 重试; 只节流记录日志, 避免刷屏。
        if (attempt % 10 === 0) {
          this.log(
            `扫描失败(${attempt + 1}): ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      const remaining = deadline - Date.now();
      if (this.disposed || remaining <= 0) return;
      await new Promise<void>((resolve) => {
        this.wakeBootScan = () => {
          if (this.bootScanTimer !== undefined) clearTimeout(this.bootScanTimer);
          this.bootScanTimer = undefined;
          this.wakeBootScan = undefined;
          resolve();
        };
        this.bootScanTimer = setTimeout(this.wakeBootScan, Math.min(3000, remaining));
      });
    }
  }

  /** Host calls and resumes may start only while the runner is live and the boot window is open. */
  private persistedOpen(): boolean {
    return !this.disposed && Date.now() < this.bootDeadline;
  }

  /**
   * Start one background loader pass unless one is already in flight. The live scan never awaits it, so a stalled
   * host call delays only persisted loads; resumed sessions are scanned on later passes. Eligibility mirrors the
   * scanner (persistedLastActivity). Never throws: a missing service or failing call is logged and retried later.
   * A turn persisted as aborted/disposed on graceful shutdown is continued; a manual stop (aborted/user) is not.
   * A subagent child is included only when its own continuable descriptor lets the host continue it (persistedChildDescriptor).
   */
  private loadInterruptedPersisted(config: AutoContinueConfig): void {
    // A host without a service registry (older hosts, minimal contexts) has no persisted store to read.
    if (this.persistedRun !== undefined || typeof this.ctx.get !== 'function') return;
    this.persistedRun = this.runPersisted(config)
      .catch(reportLoaderError)
      .finally(() => {
        this.persistedRun = undefined;
      });
  }

  /** One background pass: enumerate once after the services exist, then resume queued sessions within scanLimit. */
  private async runPersisted(config: AutoContinueConfig): Promise<void> {
    if (!this.persistedEnumerated) {
      const persistence = this.ctx.get('sessionPersistence') as PersistedStore | undefined;
      const registry = this.ctx.get('workspaceRegistry') as PersistedRegistry | undefined;
      if (persistence === undefined || registry === undefined) {
        this.log('持久化会话服务未就绪, 稍后重试');
        return;
      }
      await this.enumeratePersisted(persistence, registry, config);
      if (!this.persistedEnumerated) return;
    }
    await this.resumeQueuedPersisted(config);
  }

  /**
   * Where the rejection record lives: the DSH home this host was started with, else the default one.
   */
  private persistedRejectionPath(): string {
    const configured = process.env.DSH_HOME;
    const home = configured !== undefined && configured !== '' ? configured : join(homedir(), '.dsh');
    return join(home, 'auto-continue-rejections.json');
  }

  /**
   * Load the rejection record once per process. Read synchronously so a caller can decide to skip a session inside
   * a loop that must not yield: the file is small and only the first call touches disk.
   */
  private loadPersistedRejections(): Map<string, string> {
    const cached = this.persistedRejections;
    if (cached !== undefined) return cached;
    const record = new Map<string, string>();
    try {
      const raw = readFileSync(this.persistedRejectionPath(), 'utf8');
      const parsed = JSON.parse(raw) as { readonly version?: unknown; readonly entries?: unknown };
      if (parsed.version === PERSISTED_REJECTION_VERSION && parsed.entries !== null && typeof parsed.entries === 'object') {
        for (const [id, revision] of Object.entries(parsed.entries as Record<string, unknown>)) {
          if (typeof revision === 'string' && revision !== '') record.set(id, revision);
        }
      }
    } catch (error) {
      if ((error as { readonly code?: unknown } | null)?.code !== 'ENOENT') {
        this.log(`读取失败会话记录出错, 本次启动忽略: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.persistedRejections = record;
    return record;
  }

  /**
   * Remember that this session's log cannot be read at its current revision, so the next boot does not decode it
   * again. The sweep owns this for stored roots: the loader never reads a root once a session query service exists.
   */
  private async recordPersistedRejection(
    sessionId: SessionId,
    persistence: PersistedStore | undefined,
    record: Map<string, string>,
  ): Promise<void> {
    try {
      if (persistence === undefined) return;
      const revision = await this.persistedRevision(persistence, sessionId);
      if (revision === undefined) return;
      record.set(sessionId, revision);
      this.schedulePersistedRejectionSave();
    } catch {
      // A memory of a failure must never itself fail the scan.
    }
  }

  /** Persist the rejection record, coalescing bursts so one boot writes once. */
  private schedulePersistedRejectionSave(): void {
    if (this.persistedRejectionSave !== undefined) return;
    this.persistedRejectionSave = setTimeout(() => {
      this.persistedRejectionSave = undefined;
      void this.savePersistedRejections();
    }, 2_000);
  }

  private async savePersistedRejections(): Promise<void> {
    const record = this.persistedRejections;
    if (record === undefined) return;
    const entries: Record<string, string> = {};
    let kept = 0;
    for (const [id, revision] of record) {
      if (kept >= PERSISTED_REJECTION_MAX) break;
      entries[id] = revision;
      kept += 1;
    }
    const path = this.persistedRejectionPath();
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify({ version: PERSISTED_REJECTION_VERSION, entries })}\n`, 'utf8');
    } catch (error) {
      this.log(`写入失败会话记录出错: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Where the settled record lives: beside the rejection record, in the same DSH home this host was started with. */
  private persistedSettledPath(): string {
    const configured = process.env.DSH_HOME;
    const home = configured !== undefined && configured !== '' ? configured : join(homedir(), '.dsh');
    return join(home, 'auto-continue-settled.json');
  }

  /** Load the settled record once per process, synchronously, so the scan can skip a row without yielding. */
  private loadPersistedSettled(): Map<string, string> {
    const cached = this.persistedSettled;
    if (cached !== undefined) return cached;
    const record = this.readPersistedSettledEntries();
    this.persistedSettled = record;
    return record;
  }

  /** The settled entries currently on disk, empty when the file is missing or unusable. */
  private readPersistedSettledEntries(): Map<string, string> {
    const entries = new Map<string, string>();
    try {
      const raw = readFileSync(this.persistedSettledPath(), 'utf8');
      const parsed = JSON.parse(raw) as { readonly version?: unknown; readonly entries?: unknown };
      if (parsed.version === SETTLED_RECORD_VERSION && parsed.entries !== null && typeof parsed.entries === 'object') {
        for (const [id, revision] of Object.entries(parsed.entries as Record<string, unknown>)) {
          if (typeof revision === 'string' && revision !== '') entries.set(id, revision);
        }
      }
    } catch (error) {
      if ((error as { readonly code?: unknown } | null)?.code !== 'ENOENT') {
        this.log(`读取已判定会话记录出错, 本次启动忽略: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return entries;
  }

  /** Persist the settled record, coalescing bursts so one boot writes once. */
  private schedulePersistedSettledSave(): void {
    if (this.persistedSettledSave !== undefined) return;
    this.persistedSettledSave = setTimeout(() => {
      this.persistedSettledSave = undefined;
      void this.savePersistedSettled();
    }, 2_000);
  }

  private async savePersistedSettled(): Promise<void> {
    const record = this.persistedSettled;
    if (record === undefined) return;
    // A row this host dropped is removed from what another host wrote, but only at the revision this host settled at:
    // a different revision there is that host's newer verdict, and this one has no standing to discard it.
    const dropped = this.persistedSettledDropped;
    this.persistedSettledDropped = undefined;
    // Another host on this home may have settled rows since this one loaded; merge them so neither writer wins alone.
    // Moving this process's ids to the end keeps the cap evicting the least recently written rows.
    const merged = this.readPersistedSettledEntries();
    for (const [id, revision] of dropped ?? []) {
      if (merged.get(id) === revision) merged.delete(id);
    }
    for (const [id, revision] of record) {
      merged.delete(id);
      merged.set(id, revision);
    }
    const entries: Record<string, string> = {};
    let kept = 0;
    for (const [id, revision] of merged) {
      if (kept >= SETTLED_RECORD_MAX) break;
      entries[id] = revision;
      kept += 1;
    }
    const path = this.persistedSettledPath();
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(temporary, `${JSON.stringify({ version: SETTLED_RECORD_VERSION, entries })}\n`, 'utf8');
      await rename(temporary, path);
    } catch (error) {
      this.log(`写入已判定会话记录出错: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The artifact's own revision, or undefined when the backend cannot report one cheaply. */
  private async persistedRevision(persistence: PersistedStore, id: SessionId): Promise<string | undefined> {
    try {
      // The accessor itself can throw: a backend whose stat is a getter that faults must read as unknown, not escape.
      const stat = persistence.stat;
      if (stat === undefined) return undefined;
      const observed = await withPersistedTimeout(stat.call(persistence, id));
      const revision = observed?.revision;
      return revision === undefined || revision === null ? undefined : String(revision);
    } catch {
      return undefined;
    }
  }

  /**
   * Enumerate once. A rejected or stalled list() leaves enumeration for a later pass. A stalled call stays in
   * flight and is awaited again rather than repeated, so at most one list() is in flight.
   */
  private async enumeratePersisted(
    persistence: PersistedStore,
    registry: PersistedRegistry,
    config: AutoContinueConfig,
  ): Promise<void> {
    const listing = this.persistedListing ?? (this.persistedListing = persistence.list());
    let snapshots: readonly { readonly header: PersistedHeader }[];
    try {
      snapshots = await withPersistedTimeout(listing);
    } catch (error) {
      if (!(error instanceof PersistedCallTimeout)) this.persistedListing = undefined;
      this.log(`列出持久化会话失败, 稍后重试: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.persistedListing = undefined;
    const archived = new Set(registry.archivedSessionIds);
    const now = Date.now();
    const queue: PersistedEntry[] = [];
    // The stored sweep (sweepStoredSessions) materializes root sessions whenever sessionQuery exists, so the loader
    // resumes roots only on hosts without it. Children are always the loader's (continueChild), so one path per session.
    // If sessionQuery registers after this read, the loader may already own a root; bootResumeClaims keeps the sweep from
    // resuming that root a second time.
    const sweepOwnsRoots = this.ctx.get('sessionQuery') !== undefined;
    const rejections = this.loadPersistedRejections();
    const settled = this.loadPersistedSettled();
    for (const { header } of snapshots) {
      if (!this.persistedOpen()) return;
      if (archived.has(header.id) || this.ctx.agents.get(header.id) !== undefined) {
        // A settled row for a session that is now live can never be consulted again, so it leaves the record here
        // rather than waiting for the cap to evict it. The revision that decides the disk removal is a host call, so
        // the check runs beside the scan: a slow backend must not spend the startup window on bookkeeping.
        const known = settled.get(header.id);
        if (known !== undefined) {
          settled.delete(header.id);
          this.dropPersistedSettled(persistence, header.id, known);
        }
        continue;
      }
      if (header.cwd === undefined) continue;
      if (sweepOwnsRoots && header.origin !== 'subagent') continue;
      // One stat decides whether the log needs decoding at all: a read parses the whole log, which is the expensive part
      // of the pass, and the revision changes as soon as the bytes do.
      const revision = await this.persistedRevision(persistence, header.id);
      // A settled log is one a scan already read cleanly at this revision and found nothing to resume.
      if (revision !== undefined && settled.get(header.id) === revision) continue;
      // A log this scan already rejected is skipped without decoding it, but only while the artifact is unchanged:
      // a repaired file has a new revision and gets a fresh attempt.
      if (rejections.has(header.id) && revision !== undefined && rejections.get(header.id) === revision) continue;
      const verdict = { settled: false };
      const entry = await this.readPersistedEntry(persistence, header, now, config, verdict);
      if (entry !== undefined) {
        queue.push(entry);
        if (settled.delete(header.id)) this.schedulePersistedSettledSave();
        continue;
      }
      // Only a verdict the log itself settles is remembered; a stall or an ended window is this boot's property.
      if (verdict.settled && revision !== undefined && settled.get(header.id) !== revision) {
        settled.set(header.id, revision);
        this.schedulePersistedSettledSave();
      }
    }
    // Shallower sessions first, so a child's live parent is resumed before the child (resumeEntry needs it live).
    queue.sort((left, right) => left.depth - right.depth || right.lastActivityAt - left.lastActivityAt);
    this.persistedQueue = queue;
    this.persistedEnumerated = true;
  }

  /**
   * Read the revision a dropped row is at on disk, then let the save remove it only at the revision this host settled
   * at. Runs beside the scan, never inside it: the host call may be slow, and the scan's deadline is not the save's
   * to spend. One check at a time; a batch drains the ids waiting when it started, and ids that arrived meanwhile get
   * a batch of their own.
   */
  private dropPersistedSettled(persistence: PersistedStore, id: SessionId, known: string): void {
    (this.persistedSettledPending ??= new Map()).set(id, known);
    this.startPersistedSettledCheck(persistence);
  }

  private startPersistedSettledCheck(persistence: PersistedStore): void {
    if (this.persistedSettledCheck !== undefined || this.disposed) return;
    const waiting = this.persistedSettledPending;
    if (waiting === undefined) return;
    // Progress is counted by the batch itself: an id that arrives while it runs leaves the size unchanged, so a size
    // comparison would read that arrival as no progress.
    const progress = { drained: 0 };
    this.persistedSettledCheck = this.checkPersistedSettledDropped(persistence, progress)
      .catch(reportLoaderError)
      .finally(() => {
        this.persistedSettledCheck = undefined;
        // An id that arrived while this batch ran is drained next, never left until some later pass offers it again.
        // The restart needs progress: a batch that threw before draining anything would otherwise rerun without pause.
        if (progress.drained > 0 && this.persistedSettledPending !== undefined) this.startPersistedSettledCheck(persistence);
      });
  }

  private async checkPersistedSettledDropped(persistence: PersistedStore, progress: { drained: number }): Promise<void> {
    // Bound each batch by the ids waiting when it starts: one slow stat must not chain into an unbounded loop.
    // startPersistedSettledCheck's disposed guard sends no new batch after shutdown, and the loop comments below stop on it.
    const batch = [...(this.persistedSettledPending ?? [])] as [SessionId, string][];
    const checked: [SessionId, string][] = [];
    try {
      for (const [id, known] of batch) {
        if (this.disposed) return;
        const droppedAt = await this.persistedRevision(persistence, id);
        // Shutdown may land while the stat is out. A row recorded after it would schedule a save dispose can no longer
        // cancel, so the check stops here and leaves the disk as it is.
        if (this.disposed) return;
        checked.push([id, known]);
        // Only the revision this host settled at makes the removal its own: a newer revision is another host's verdict,
        // and an unreadable one proves nothing about a row that may not be this host's to remove.
        if (droppedAt !== known) continue;
        (this.persistedSettledDropped ??= new Map()).set(id, known);
      }
    } finally {
      // Whatever this batch did check leaves the pending map, even when a stat threw: the restart count stays honest.
      if (checked.length > 0) progress.drained += checked.length;
      const pending = this.persistedSettledPending;
      if (pending !== undefined) {
        // Only the revision this batch checked leaves the queue: a newer one offered while the stat was out is a
        // different drop, and the next batch picks it up.
        for (const [id, known] of checked) if (pending.get(id) === known) pending.delete(id);
        if (pending.size === 0) this.persistedSettledPending = undefined;
      }
    }
    if (this.persistedSettledDropped !== undefined) this.schedulePersistedSettledSave();
  }

  /** Resume at most `scanLimit` queued sessions in this pass, one awaited load at a time. */
  private async resumeQueuedPersisted(config: AutoContinueConfig): Promise<void> {
    let loads = 0;
    while (this.persistedQueue.length > 0 && loads < config.scanLimit && !this.disposed) {
      const entry = this.persistedQueue.shift();
      if (entry === undefined || this.persistedDecided.has(entry.id)) continue;
      this.persistedDecided.add(entry.id);
      if (this.ctx.agents.get(entry.id) !== undefined) continue;
      loads += 1;
      await this.resumePersisted(entry);
    }
  }

  /** Read one persisted session's history (read-only open). Stalled or unreadable histories are skipped, and an
   * unreadable one at a known revision is remembered so the next boot skips it without decoding it again. */
  private async readPersistedEntry(
    persistence: PersistedStore,
    header: PersistedHeader,
    now: number,
    config: AutoContinueConfig,
    verdict: { settled: boolean },
  ): Promise<PersistedEntry | undefined> {
    try {
      const opening = persistence.open(header.id, 'read');
      const handle = await withPersistedTimeout(opening).catch((error: unknown) => {
        // A late open still returns a tracked read handle; close it rather than leave it open.
        void opening.then((late) => late.close()).catch(() => undefined);
        throw error;
      });
      try {
        // Checked after the open settles: an open that straddles the window must not start a read. The handle is closed below.
        if (!this.persistedOpen()) return undefined;
        const { events } = await withPersistedTimeout(handle.read(0));
        let childDescriptor: PersistedChildDescriptor | undefined;
        let ownEvents = events;
        const depth = header.delegationDepth ?? 0;
        if (header.origin === 'subagent') {
          // Resume a child only when the host would: its own continuable descriptor, read past the inherited prefix,
          // and a parent to resume it under (checked again in continueChild, when the parent is known to be live).
          const inherited = handle.inheritedEventCount;
          if (typeof inherited !== 'number' || header.parentSession === undefined) {
            // No boot can ever continue this child: nothing resumes a session with no parent to continue it under. The
            // log alone settles it, so the verdict is remembered instead of decoding the same log on every boot.
            verdict.settled = true;
            return undefined;
          }
          childDescriptor = persistedChildDescriptor(events, inherited);
          if (childDescriptor === undefined) {
            this.log(`跳过 ${header.id}: 子代理没有可续跑的 descriptor`);
            verdict.settled = true;
            return undefined;
          }
          // The child's own turns decide eligibility. An inherited parent turn is not a turn of this child.
          ownEvents = events.slice(inherited);
        }
        const lastActivityAt = persistedLastActivity(ownEvents, now, config);
        if (lastActivityAt === undefined) return undefined;
        let lastEnd: SessionEvent<'turn/end'> | undefined;
        for (let i = ownEvents.length - 1; i >= 0; i -= 1) {
          const event = ownEvents[i];
          if (event?.type === 'turn/end') { lastEnd = event; break; }
        }
        // fixer2 F-1: only the child's LAST turn is judged. A `turn/start` after this end means the child is a crash
        // orphan inside that open turn, which persistedLastActivity resumes; the continue then resumes the open turn,
        // not a fresh Continue after the max-tokens turn, so the filter below does not apply.
        const turnOpenAfterEnd = lastEnd !== undefined &&
          ownEvents.some((event) => event.type === 'turn/start' && event.seq > lastEnd!.seq);
        // Round 4 (vrpe F-A1, F-A2, H14, O2, M1): the boot path keeps the refusal only where a Continue would replay
        // the spiral, and it now reads the persisted spiral signal instead of the last step being reasoning. Without
        // the signal the turn is ordinary, so the session is loaded and continued with the max-tokens text (or, for a
        // child, with the generic Continue text). With the signal a user session is loaded too and the scanner
        // escalates it once with the loop text. A child has no escalation path, because the scanner skips subagent
        // sessions and a child Continue never carries the loop text, so a child with the signal stays refused. An
        // episode already escalated before the restart is left for a human. Every refusal tells the user.
        const maxTokensReason = lastEnd !== undefined && !turnOpenAfterEnd &&
          readReasonKind(lastEnd.data.reason) === 'max-tokens' &&
          this.messageOutput(lastTurnMessageContent(ownEvents, lastEnd)) === 'reasoning';
        if (maxTokensReason && header.origin === 'subagent' &&
            persistedSpiralTripped(ownEvents, lastEnd, config.loopGuard)) {
          this.log(`停止 ${header.id}(boot:turn/end:max-tokens): 子代理推理复读, 未自动续跑, 需要人工介入`);
          this.notifySpiralStopped(header.id, config, true);
          return undefined;
        }
        if (maxTokensReason && header.origin !== 'subagent' &&
            this.persistedSpiralEscalated(ownEvents, lastEnd, config)) {
          this.log(`停止 ${header.id}(boot:turn/end:max-tokens): 推理复读, 强制续跑一次后仍无可见输出, 需要人工介入`);
          this.notifySpiralStopped(header.id, config);
          return undefined;
        }
        if (this.persistedRejections?.has(header.id) === true) {
          // The same artifact now reads cleanly, so any older rejection of it is stale.
          const rejections = this.loadPersistedRejections();
          if (rejections.delete(header.id)) this.schedulePersistedRejectionSave();
        }
        return {
          id: header.id,
          lastActivityAt,
          depth,
          ownTurnStartCount: ownEvents.filter((event) => event.type === 'turn/start').length,
          route: persistedRoute(ownEvents),
          preset: persistedPreset(header, events),
          ...(childDescriptor !== undefined ? { childDescriptor, parentSession: header.parentSession } : {}),
        };
      } finally {
        await withPersistedTimeout(handle.close()).catch(() => undefined);
      }
    } catch (error) {
      // A stall is a property of this boot, not of the log, so only a real read failure is remembered. The revision
      // is read here, once, rather than for every row up front.
      if (!(error instanceof PersistedCallTimeout)) {
        const revision = await this.persistedRevision(persistence, header.id);
        if (revision !== undefined) {
          const rejections = this.loadPersistedRejections();
          rejections.set(header.id, revision);
          this.schedulePersistedRejectionSave();
        }
      }
      console.error(`[auto-continue] 跳过无法读取的持久化会话 ${header.id}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  /** Resume one persisted session through the host. A failure or stall drops it for this boot; only a boot Continue is retried (deliverChild). */
  private async resumePersisted(entry: PersistedEntry): Promise<void> {
    const outcome: ResumeOutcome = { retryDue: false };
    try {
      await withPersistedTimeout(this.resumeEntry(entry, outcome));
    } catch (error) {
      if (error instanceof PersistedCallTimeout) {
        // Not retried. A late resume may still succeed; the live scan then picks up its agent on a later pass.
        // A timed-out boot Continue with a retry due reports through that retry (refusedRetry), so no line is printed here.
        if (!outcome.retryDue) this.log(`恢复 ${entry.id} 超时, 不再重试`);
        return;
      }
      if (error instanceof Error && error.name === 'SessionAlreadyOwnedError') {
        this.log(`跳过 ${entry.id}: 会话正被其他写入者占用`);
        return;
      }
      logResumeFailure(entry, error);
    }
  }

  /**
   * The resume itself, under the call timeout. A user session is resumed through ctx.agents.resume. A continuable child
   * is never resumed by the plugin: it is continued through the host's subagent service (continueChild).
   */
  private async resumeEntry(entry: PersistedEntry, outcome: ResumeOutcome): Promise<void> {
    // Nothing starts after the window closes, and the lookups below are host calls too.
    if (!this.persistedOpen()) {
      this.log(`跳过 ${entry.id}: 启动窗口已结束`);
      return;
    }
    if (entry.childDescriptor !== undefined) {
      await this.continueChild(entry, entry.childDescriptor, outcome);
      return;
    }
    const defaults = this.ctx.get('agentDefaultModel') as { currentSelection(): PersistedRoute } | undefined;
    // A user session resumes on its logged route, else on the default selection.
    const route = entry.route ?? defaults?.currentSelection();
    if (route === undefined) {
      this.log(`跳过 ${entry.id}: 持久化历史没有模型路由, 也没有默认模型`);
      return;
    }
    const presets = this.ctx.get('agentPresets') as PersistedPresets | undefined;
    let setup: ((agentCtx: Context) => Promise<void>) | undefined;
    if (presets !== undefined) {
      const presetId = (await presets.resolve(entry.preset)).id;
      setup = async (agentCtx) => {
        await presets.mount(agentCtx, presetId);
      };
    }
    // Archive and window are re-checked after the last await, right before the host call.
    const registry = this.ctx.get('workspaceRegistry') as PersistedRegistry | undefined;
    if (registry === undefined || registry.archivedSessionIds.includes(entry.id)) return;
    if (!this.persistedOpen()) {
      this.log(`跳过 ${entry.id}: 启动窗口已结束`);
      return;
    }
    // Checked and claimed in the same tick as the host call. A live agent or a claim from the stored sweep means this
    // session is already resumed in this boot, so the loader stops here.
    if (this.ctx.agents.get(entry.id) !== undefined || !this.claimBootResume(entry.id)) {
      this.log(`skip ${entry.id}: already resumed in this boot`);
      return;
    }
    this.persistedLoaded.add(entry.id);
    const handle = await this.resumeClaimed(entry.id, () => this.ctx.agents.resume({
      resumeSessionId: entry.id,
      agentOptions: { provider: route.provider, model: route.model },
      setup,
    }));
    if (Date.now() >= this.bootDeadline) {
      // The host published the agent, but the window closed first. Release it; it is never continued.
      void handle.dispose().catch(reportLoaderError);
      this.log(`恢复 ${entry.id} 在启动窗口结束后才完成, 已释放, 不续跑`);
      return;
    }
    this.persistedHandles.set(entry.id, handle);
    this.log(`已从持久化历史恢复 ${entry.id}, 交给扫描器续跑`);
  }

  /**
   * Continue one persisted continuable child through the host's subagent service. sendMessage makes the host create the
   * child's activation, so the child reaches its parent and the parent's messages reach the child. The plugin keeps no
   * handle to the child. The child is continued only on the route it pins, and only when its own log shows that route.
   * It is continued at most once per host process. A refusal at the active-child limit delivers nothing, so the child
   * waits for a slot (see waitForSlot). A parent that is not live is loaded by the delivery itself (loadParent); when
   * that load fails, is refused, or is still pending, nothing is delivered and the child waits for the parent (see
   * deferForParent). A refusal because the child became resident
   * meanwhile (skipIfResident) also
   * delivers nothing. A child that started a turn after the listing (skipIfRunSince) is not sent Continue. Any other failure is not retried in this run. A timed-out delivery is retried once (F-4).
   */
  private async continueChild(entry: PersistedEntry, child: PersistedChildDescriptor, outcome: ResumeOutcome = { retryDue: false }): Promise<void> {
    this.slotDeliveries += 1;
    try {
      await this.deliverChild(entry, child, outcome);
    } finally {
      this.slotDeliveries -= 1;
      this.endSlotWaitIfIdle();
    }
  }

  /** The body of continueChild. Every return path reaches its finally, so an idle wait ends there. */
  private async deliverChild(entry: PersistedEntry, child: PersistedChildDescriptor, outcome: ResumeOutcome): Promise<void> {
    const registry = this.ctx.get('workspaceRegistry') as PersistedRegistry | undefined;
    if (registry === undefined || registry.archivedSessionIds.includes(entry.id)) return;
    const parentSession = entry.parentSession;
    if (parentSession === undefined || registry.archivedSessionIds.includes(parentSession)) {
      this.log(`skip ${entry.id}: the parent is archived or unknown, so the child is not continued`);
      return;
    }
    // The host sends only from the exact live sender agent, so the parent must be live under the same id. A parent
    // whose own last turn completed is listed by no boot path, so nothing else resumes it: this delivery loads it and
    // the child is continued in the same boot. A load that fails, is refused, or settles after the window keeps today's
    // behavior: the child waits for the parent to become live another way (deferForParent). An archived or unknown
    // parent was skipped above and never reaches the wait.
    const live = this.ctx.agents.get(parentSession);
    const parent = live !== undefined && live.id === parentSession
      ? live
      : await this.loadParent(parentSession, entry.id);
    if (parent === undefined) {
      this.deferForParent(entry, child, parentSession);
      return;
    }
    if (child.agentProvider === undefined || child.agentModel === undefined) {
      this.log(`skip ${entry.id}: the child pins no provider and model, so the child is not continued`);
      return;
    }
    const logged = entry.route;
    if (logged === undefined || logged.provider !== child.agentProvider || logged.model !== child.agentModel) {
      this.log(`skip ${entry.id}: the child's own log does not show its pinned route, so the child is not continued`);
      return;
    }
    const subagents = this.ctx.get('subagents') as PersistedSubagents | undefined;
    if (subagents === undefined) {
      this.log(`skip ${entry.id}: the subagent service is not available; not retried in this run`);
      return;
    }
    const continued = bootContinuedIds();
    if (continued.has(entry.id)) {
      this.log(`skip ${entry.id}: already continued in this host run`);
      return;
    }
    // Last check before the host call: nothing is sent after the window closes.
    if (!this.persistedOpen()) {
      this.log(`skip ${entry.id}: the boot window has ended`);
      return;
    }
    // A child admitted by another route (a parent message cold-resumed it during the wait) is never sent Continue.
    if (this.ctx.agents.get(entry.id) !== undefined) {
      this.waitingChildren.delete(entry.id);
      this.log(`skip ${entry.id}: already live; not continued`);
      return;
    }
    // Marked before the call, so a delivered child is never sent again in this run. A refusal at the active-child limit
    // delivered nothing, so the mark is withdrawn and the child waits for a slot. Any other failure is not retried, except a
    // call timeout, which is retried once (F-4). The host checks the abort signal before it admits the child, so a timed-out
    // call delivered nothing. The mark is not checked again for the retry, and only one retry is made. The retry's failure is
    // logged by refusedRetry, because the outer wait may already have given up (r11, F-A).
    continued.add(entry.id);
    const text = fillTemplate(this.getConfig().continueText, {});
    const releasesBefore = this.slotReleases;
    let messageId: unknown;
    try {
      messageId = await this.sendContinue(subagents, parent, entry, text, () => {
        outcome.retryDue = this.persistedOpen();
      });
    } catch (error) {
      if (!(error instanceof PersistedCallTimeout) || !outcome.retryDue) {
        this.refusedContinue(error, entry, child, releasesBefore);
        return;
      }
      this.log(`retry ${entry.id}: the Continue call timed out before admission; retrying once`);
      try {
        messageId = await this.sendContinue(subagents, parent, entry, text);
      } catch (retryError) {
        this.refusedRetry(retryError, entry, child, releasesBefore);
        return;
      }
    }
    this.log(`continued child ${entry.id} through the subagent service (message ${String(messageId)})`);
    this.noteSlotRelease();
  }

  /**
   * Load a child's parent session that no other boot path loads: the parent's own last turn completed, so the stored
   * scan never lists it, and the delivery above would otherwise wait for a session nothing resumes. The route and preset
   * come from the parent's own log, so it comes back on what it last ran on; the default selection applies only when the
   * log records no route, exactly as for a user session (resumeEntry). The call is the same one resumeEntry makes, so a
   * parent that is itself a subagent is resumed as a session and never through the child path, and its preset is mounted
   * by this plugin's own setup rather than by the host's cold resume. The load is claimed through the boot claim set, so
   * one boot never resumes a session twice, and bounded by the boot deadline: nothing starts after it, and a handle that
   * settles after it is disposed instead of used. Returns the live parent, or undefined after logging why, so the caller
   * keeps today's wait for a parent that may still become live another way.
   */
  private async loadParent(parentSession: SessionId, childSession: SessionId): Promise<Agent | undefined> {
    const failed = (failure: unknown): undefined => {
      console.error(
        `[auto-continue] failed to load parent ${parentSession} for child ${childSession}: ${
          failure instanceof Error ? failure.message : String(failure)
        }`,
      );
      return undefined;
    };
    try {
      // The operator closed this session (mode off) or paused everything: nothing opens it.
      if (this.sessionConfig(parentSession).paused) return failed('the parent session is paused');
      if (!this.persistedOpen()) return failed('the boot window has ended');
      const persistence = this.ctx.get('sessionPersistence') as PersistedStore | undefined;
      if (persistence === undefined) return failed('the persistence service is not available');
      const opening = persistence.open(parentSession, 'read');
      const stored = await withPersistedTimeout(opening).catch((error: unknown) => {
        // A late open still returns a tracked read handle; close it rather than leave it open.
        void opening.then((late) => late.close()).catch(() => undefined);
        throw error;
      });
      let route: PersistedRoute | undefined;
      let preset: string | undefined;
      try {
        const { events } = await withPersistedTimeout(stored.read(0));
        // An inherited prefix is not this parent's own history: its route and its preset are the ones its own turns ran
        // on, and the header's creation preset is the fallback, never a selection the root made for itself.
        const inherited = stored.header.origin === 'subagent' ? stored.inheritedEventCount : 0;
        const own = inherited > 0 ? events.slice(inherited) : events;
        route = persistedRoute(own);
        preset = persistedPreset(stored.header, own);
      } finally {
        await withPersistedTimeout(stored.close()).catch(() => undefined);
      }
      const defaults = this.ctx.get('agentDefaultModel') as { currentSelection(): PersistedRoute } | undefined;
      const chosen = route ?? defaults?.currentSelection();
      if (chosen === undefined) return failed('the parent log records no route, and the host has no default model');
      const presets = this.ctx.get('agentPresets') as PersistedPresets | undefined;
      let setup: ((agentCtx: Context) => Promise<void>) | undefined;
      if (presets !== undefined) {
        const presetId = (await presets.resolve(preset)).id;
        setup = async (agentCtx) => {
          await presets.mount(agentCtx, presetId);
        };
      }
      // Archive, window, and pause are re-checked after the last await, right before the host call.
      const registry = this.ctx.get('workspaceRegistry') as PersistedRegistry | undefined;
      if (registry === undefined || registry.archivedSessionIds.includes(parentSession)) {
        return failed('the parent session is archived');
      }
      if (!this.persistedOpen()) return failed('the boot window has ended');
      // The operator can pause this parent while the load awaits its stored read and its preset. The top check read the
      // state before those awaits, so the pause is read again here, in the same tick as the claim and the host call: a
      // parent paused in that window is never opened.
      if (this.sessionConfig(parentSession).paused) return failed('the parent session is paused');
      // Checked and claimed in the same tick as the host call. A parent that became live during the reads above is used
      // by the wait fallback at once (deferForParent attempts immediately), and a claim from the stored sweep or the
      // loader means this boot already resumes it; either way this path starts nothing.
      if (this.ctx.agents.get(parentSession) !== undefined || !this.claimBootResume(parentSession)) {
        return failed('the parent is already live or resumed in this boot');
      }
      const resumed = await this.resumeClaimed(parentSession, () => this.ctx.agents.resume({
        resumeSessionId: parentSession,
        agentOptions: { provider: chosen.provider, model: chosen.model },
        setup,
      }));
      if (Date.now() >= this.bootDeadline) {
        // The host published the parent, but the window closed first. Release it; it is never used.
        void resumed.dispose().catch(reportLoaderError);
        return failed('the parent load settled after the boot window closed');
      }
      console.info(`[auto-continue] loaded parent ${parentSession} for child ${childSession}`);
      return resumed.agent;
    } catch (error) {
      return failed(error);
    }
  }

  /**
   * One Continue call under the call timeout. Each call has its own abort signal, so a timed-out call is aborted and admits
   * nothing. `onTimeout` runs synchronously when the call times out, before the outer wait can settle.
   */
  private sendContinue(subagents: PersistedSubagents, parent: Agent, entry: PersistedEntry, text: string, onTimeout?: () => void): Promise<unknown> {
    const controller = new AbortController();
    return withPersistedTimeout(
      subagents.sendMessage(parent, entry.id, [{ type: 'text', text }], {
        signal: controller.signal,
        skipIfResident: true,
        skipIfRunSince: entry.ownTurnStartCount,
      }),
      () => {
        controller.abort();
        onTimeout?.();
      },
    );
  }

  /**
   * A Continue the host refused or failed. A refusal because the child was already resident or started a turn after the listing means a
   * parent message admitted it, so no Continue is sent and nothing is retried.
   */
  private refusedContinue(error: unknown, entry: PersistedEntry, child: PersistedChildDescriptor, releasesBefore: number): void {
    if (isAlreadyResident(error)) {
      // The host checked residency under the child's lock: a parent message cold-resumed the child while this call waited.
      // That admission is the child's continuation, so no Continue is sent and nothing is retried.
      this.log(`skip ${entry.id}: already resident (admitted by another route); no Continue sent`);
      return;
    }
    if (isAlreadyRan(error)) {
      // skipIfRunSince (F-3): the child started a turn after the boot listing.
      this.log(`skip ${entry.id}: ran after the boot listing (its own log grew); no Continue sent`);
      return;
    }
    if (!isAdmissionLimit(error)) {
      // A failed delivery can free its slot with no event (a setup failure before publication). Waiters get an attempt.
      this.noteSlotRelease();
      throw error;
    }
    bootContinuedIds().delete(entry.id);
    if (!this.persistedOpen()) {
      console.error(`[auto-continue] dropped ${entry.id}: no activation slot before the boot window closed`);
      return;
    }
    this.waitForSlot(entry, child, this.slotReleases !== releasesBefore);
  }

  /**
   * A retried Continue that was refused or failed. The retry is the last attempt, so its failure is logged here, once, as an
   * error. It is not rethrown: the outer wait may already have given up, and nothing else would log it (r11, F-A).
   */
  private refusedRetry(error: unknown, entry: PersistedEntry, child: PersistedChildDescriptor, releasesBefore: number): void {
    try {
      this.refusedContinue(error, entry, child, releasesBefore);
    } catch (failure) {
      logResumeFailure(entry, failure);
    }
  }

  /**
   * Keep a child the host refused at the active-child limit. The listener and the window timer exist while a child waits.
   * The child is not in the once-set (deliverChild removed it), so a later attempt may still deliver it. When a release
   * the plugin observed happened during the refused call (releasedDuringAttempt), the child was not in the waiting set
   * at that moment, so nothing else would wake it: it gets one attempt here. The attempt is not repeated by this path,
   * so a refusal cannot loop.
   */
  private waitForSlot(entry: PersistedEntry, child: PersistedChildDescriptor, releasedDuringAttempt: boolean): void {
    this.waitingChildren.set(entry.id, { entry, child, reason: 'slot' });
    this.log(`${entry.id} is waiting for an activation slot (active child limit)`);
    this.disposeSlotListener ??= this.ctx.on('agent/disposed', () => this.onAgentDisposed());
    this.ensureWaitWindow();
    if (releasedDuringAttempt) this.scheduleWaitAttempt(entry.id);
  }

  /**
   * Keep a child whose parent this boot pass may still publish: its own load (loadParent) can be pending, refused, or
   * failed, and a parent the stored sweep or another pass resumes is published moments later. The host announces a
   * resumed agent with agent/created (dsh-agent/lib/index.js:announce) on the same scope carrier the agent/disposed
   * listener already uses. The child waits in the same set a child refused at the active-child limit
   * uses, under the same boot-window timer, so a parent that never becomes live holds neither a listener nor a timer past
   * the window. The child is not in the once-set, so the retry may still deliver it.
   */
  private deferForParent(entry: PersistedEntry, child: PersistedChildDescriptor, parentSession: SessionId): void {
    this.waitingChildren.set(entry.id, { entry, child, reason: 'parent' });
    this.log(`${entry.id} is waiting for the parent session ${parentSession} to become live`);
    this.disposeParentListener ??= this.ctx.on('agent/created', ({ agent }) => this.onAgentCreated(agent));
    this.ensureWaitWindow();
    // The parent may have been published between the liveness check in deliverChild and this listener. That event is
    // already behind us, so the child gets one attempt now. The attempt waits again when the parent is still absent.
    if (this.ctx.agents.get(parentSession) !== undefined) this.scheduleWaitAttempt(entry.id);
  }

  /** An agent was published. A child waiting for this exact parent gets one attempt, run after the host's publish call. */
  private onAgentCreated(agent: Agent): void {
    if (!this.persistedOpen()) return;
    for (const [id, waiting] of this.waitingChildren) {
      if (waiting.reason !== 'parent') continue;
      if (waiting.entry.parentSession === agent.id) this.scheduleWaitAttempt(id);
    }
  }

  /** The one boot-window timer. Set while any child waits; on close every waiter is dropped and logged. It never sends. */
  private ensureWaitWindow(): void {
    this.slotWindowTimer ??= setTimeout(() => this.closeSlotWindow(), Math.max(0, this.bootDeadline - Date.now()));
  }

  /**
   * An agent was disposed. The host emits agent/disposed (dsh-agent-loop/lib/index.js:1701) before it releases the
   * disposed child's slot (dsh-subagent/lib/index.js:1250). setImmediate runs after that release, so each waiting child
   * gets one attempt then. A burst of events schedules one attempt per child.
   */
  private onAgentDisposed(): void {
    if (!this.persistedOpen()) return;
    this.noteSlotRelease();
  }

  /**
   * A slot may have freed. The count lets a refused call that is in flight notice the release (waitForSlot). Each child
   * waiting for a slot gets one attempt, run after the host's release by setImmediate. A child waiting for its parent is
   * woken by that parent's own agent/created event, not by a slot release.
   */
  private noteSlotRelease(): void {
    this.slotReleases += 1;
    for (const [id, waiting] of this.waitingChildren) {
      if (waiting.reason === 'slot') this.scheduleWaitAttempt(id);
    }
  }

  /** One pending attempt per child. Called only for a child in the waiting set. */
  private scheduleWaitAttempt(id: SessionId): void {
    if (this.waitAttempts.has(id)) return;
    const attempt = setImmediate(() => {
      this.waitAttempts.delete(id);
      this.attemptWaiting(id);
    });
    this.waitAttempts.set(id, attempt);
  }

  /** One wait attempt. A refusal or a parent still absent waits again. Any other failure is logged with the child id. */
  private attemptWaiting(id: SessionId): void {
    const waiting = this.waitingChildren.get(id);
    if (waiting === undefined || !this.persistedOpen()) return;
    this.waitingChildren.delete(id);
    this.continueChild(waiting.entry, waiting.child).catch((error: unknown) => {
      console.error(
        `[auto-continue] skip ${id}: delivery failed, not retried: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  /** The boot window ended. Each child still waiting is dropped and logged with its id and the wait it was in. */
  private closeSlotWindow(): void {
    this.slotWindowTimer = undefined;
    for (const [id, waiting] of this.waitingChildren) {
      const cause = waiting.reason === 'parent'
        ? 'its parent was not live before the boot window closed'
        : 'no activation slot before the boot window closed';
      console.error(`[auto-continue] dropped ${id}: ${cause}`);
    }
    this.waitingChildren.clear();
    this.stopSlotWait();
  }

  /** The wait ends once no child waits and no delivery is in flight. Only then are the listeners and the timer released. */
  private endSlotWaitIfIdle(): void {
    if (this.waitingChildren.size === 0 && this.slotDeliveries === 0) this.stopSlotWait();
  }

  /** Remove the listeners, the pending attempts and the window timer. The caller clears the waiting set. */
  private stopSlotWait(): void {
    this.disposeSlotListener?.();
    this.disposeSlotListener = undefined;
    this.disposeParentListener?.();
    this.disposeParentListener = undefined;
    for (const attempt of this.waitAttempts.values()) clearImmediate(attempt);
    this.waitAttempts.clear();
    if (this.slotWindowTimer !== undefined) clearTimeout(this.slotWindowTimer);
    this.slotWindowTimer = undefined;
  }

  /**
   * Release loader-resumed agents the boot scan never classified, once the scan loop has exited. No later pass can
   * classify them, so they would hold a write handle and never continue. Agents the scanner decided stay with the live
   * path, as do agents that still own work: a running turn, any timer in SessionState, or queued inbox input.
   */
  private releaseUnscannedPersisted(): void {
    const handles = [...this.persistedHandles];
    this.persistedHandles.clear();
    if (this.disposed) return;
    try {
      for (const [id, handle] of handles) {
        const { agent } = handle;
        const state = this.states.get(id);
        if (this.ctx.agents.get(id) !== agent || this.bootScannedSessions.has(agent.session)) continue;
        // The timers are SessionState's pendingTimer, cooldownRetryTimer and loopRetryTimer (src/shared/core.ts).
        if (state?.running === true || state?.pendingTimer !== undefined || state?.cooldownRetryTimer !== undefined ||
            state?.loopRetryTimer !== undefined || agent.inbox.hasPending) continue;
        this.log(`启动窗口结束时仍未扫描 ${id}, 已释放, 不续跑`);
        handle.dispose().catch(reportLoaderError);
      }
    } catch (error) {
      reportLoaderError(error);
    }
  }

  /** Inspect newly available sessions; process each settled startup history once. */
  private async scanInterrupted(): Promise<boolean> {
    const config = this.getConfig();
    if (config.paused || !config.scanOnBoot) return false;
    // Background loader: the live scan below never waits on persisted host calls.
    this.loadInterruptedPersisted(config);
    const now = Date.now();
    const candidates: {
      session: Session;
      sessionId: SessionId;
      events: readonly SessionEvent[];
      lastEnd: SessionEvent<'turn/end'>;
      reasonKind: string;
      failure?: FailureFacts;
      lastActivityAt: number;
      listIndex: number;
    }[] = [];
    for (const agent of this.ctx.agents.list()) {
      let session: Session | undefined;
      let sessionId: SessionId | undefined;
      try {
        session = agent.session;
        // Check quarantine before reading metadata that may have failed previously. A subagent child is never
        // loader-resumed (continueChild delivers it through the host), so the live scan skips every subagent.
        if (this.bootScannedSessions.has(session) || session.header?.origin === 'subagent') continue;
        sessionId = session.id;
        if (typeof sessionId !== 'string' || sessionId === '') throw new TypeError('session id is unavailable');
        if (this.sessionConfig(sessionId).paused) continue;
        const state = this.state(sessionId);
        if (state.pendingTimer !== undefined || state.consecutive >= config.maxConsecutive) continue;
        if (now - state.lastAttemptAt < this.cooldownFor(state)) continue;
        if (now < (this.pauseUntil.get(sessionId) ?? 0)) continue;
        const events = snapshotSessionEvents(session);
        // An empty, valid snapshot may still be waiting for history hydration.
        if (events.length === 0) continue;
        let lastEnd: SessionEvent<'turn/end'> | undefined;
        for (let i = events.length - 1; i >= 0; i -= 1) {
          const event = events[i];
          if (event?.type === 'turn/end') { lastEnd = event; break; }
        }
        const reasonKind = readReasonKind(lastEnd?.data.reason);
        const lastStart = latestTurnStart(events);
        const maintenance = lastStart?.data.turn === lastEnd?.data.turn && isMaintenanceTurnStart(lastStart);
        const silent = reasonKind === 'no-visible-output' && config.resumeSilentTurns;
        const superseded = lastEnd !== undefined && events.some((event) =>
          event.seq > lastEnd!.seq && (event.type === 'turn/start' ||
            (event.type === 'user/message' && event.data.source.kind === 'user')),
        );
        if (lastEnd === undefined || maintenance || reasonKind === undefined || (!isInterruptedTurnEnd(lastEnd.data.reason) && !silent) ||
            lastEnd.time < now - config.freshMs || superseded) {
          this.bootScannedSessions.add(session);
          continue;
        }
        // Round 4 (vrpe F-A1, M1, M1b, O2): the boot scan and the 3-second poll share this filter, and it reads the
        // persisted spiral signal instead of the last step being reasoning. Without the signal the turn is ordinary: it
        // falls through to the candidate list and is continued with the max-tokens text. With the signal it gets one
        // forced resume carrying config.loopText, or the stop notice when the episode already escalated before the
        // restart (the escalation is read from the log, see this.persistedSpiralEscalated). The persisted read honours
        // config.loopGuard exactly as the live detector does (round 5, reviewer F2), so both are passed to it.
        if (reasonKind === 'max-tokens' && this.messageOutput(lastTurnMessageContent(events, lastEnd)) === 'reasoning' &&
            persistedSpiralTripped(events, lastEnd, config.loopGuard)) {
          this.bootScannedSessions.add(session);
          if (this.persistedSpiralEscalated(events, lastEnd, config)) {
            this.log(`停止 ${sessionId}(scan:turn/end:max-tokens): 推理复读, 强制续跑一次后仍无可见输出, 需要人工介入`);
            this.notifySpiralStopped(sessionId, config);
          } else if (this.schedule(sessionId, LOOP_SPIRAL_REASON, true)) {
            // Round 5 (reviewer F1): the bound is not set here. fire() sets it when the forced resume is delivered, so a
            // refused or cancelled scan escalation leaves the episode free for the next attempt.
            this.log(`升级 ${sessionId}(scan:turn/end:max-tokens): 推理复读, 强制续跑一次 (${LOOP_SPIRAL_REASON})`);
          }
          continue;
        }
        let failure: FailureFacts | undefined;
        if (reasonKind === 'error') {
          failure = parseFailureFacts((lastEnd.data.reason as { error?: unknown }).error);
          if (failure === undefined) {
            this.bootScannedSessions.add(session);
            console.error(`[auto-continue] 忽略畸形扫描 turn/end ${sessionId}: error details 无法解释`);
            continue;
          }
          if (config.classify && !isTransientFailure(failure, config.retryableErrorPatterns)) {
            this.bootScannedSessions.add(session);
            this.onTurnFailure(sessionId, 'scan:turn/end:error', failure);
            continue;
          }
        }
        candidates.push({
          session, sessionId, events, lastEnd, reasonKind, failure,
          lastActivityAt: events.reduce((latest, event) => Math.max(latest, event.time), 0),
          listIndex: candidates.length,
        });
      } catch (error) {
        if (session !== null && typeof session === 'object') this.bootScannedSessions.add(session);
        const identity = session ?? agent;
        if (identity !== null && typeof identity === 'object') {
          if (this.bootScanErrors.has(identity)) continue;
          this.bootScanErrors.add(identity);
        }
        this.logBootScanFailure(sessionId, error);
      }
    }
    // Limit recoveries, not healthy/permanent histories that cannot be resumed.
    candidates.sort((left, right) => right.lastActivityAt - left.lastActivityAt || left.listIndex - right.listIndex);
    // Live candidates are tried first and keep the whole scanLimit budget; loader-resumed sessions get only the slots
    // left over, so one pass still starts at most scanLimit recoveries. A candidate whose preparation throws takes no slot.
    const live = candidates.filter((candidate) => !this.persistedLoaded.has(candidate.session.id));
    const loaded = candidates.filter((candidate) => this.persistedLoaded.has(candidate.session.id));
    let recoveries = 0;
    for (const candidate of [...live, ...loaded]) {
      if (recoveries >= config.scanLimit) break;
      if (this.disposed) return true;
      const { session, sessionId, events, lastEnd, reasonKind, failure } = candidate;
      this.bootScannedSessions.add(session);
      const state = this.state(sessionId);
      try {
        this.applyGuardFromEvents(state, events, lastEnd.seq);
        const scanReason = `scan:turn/end:${reasonKind}${reasonKind === 'no-visible-output' ? ':silent' : ''}`;
        this.log(`扫描发现中断 ${sessionId}(turn/end:${reasonKind}), 交给恢复策略处理`);
        if (failure !== undefined) {
          state.lastFailure = failure;
          state.lastTurn = lastEnd.data.turn;
          state.lastFailureAt = lastEnd.time;
          this.onTurnFailure(sessionId, scanReason, failure);
        } else {
          if (reasonKind === 'no-visible-output') state.lastFailure = undefined;
          // 没有失败事实的恢复(如 interrupted)也要填 {turn}/{elapsed}, README 对所有继续文本承诺这些占位符。
          state.lastTurn = lastEnd.data.turn;
          state.lastFailureAt = lastEnd.time;
          this.schedule(sessionId, scanReason);
        }
        recoveries += 1;
      } catch (error) {
        state.tools.reset();
        this.cancelPending(sessionId, '启动扫描失败');
        this.logBootScanFailure(sessionId, error);
      }
    }
    return false;
  }

  /** Bound cold reads even if a backend ignores cancellation; release late leases. */
  private async readStored<T extends object>(read: (signal: AbortSignal) => Promise<T>, deadline: number): Promise<T> {
    const timeout = new AbortController();
    const signal = AbortSignal.any([this.stopStoredSweep.signal, timeout.signal]);
    const timer = setTimeout(() => timeout.abort(new Error('Stored session read timed out')), Math.max(0, Math.min(STORED_READ_TIMEOUT_MS, deadline - Date.now())));
    let onAbort: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    const pending = Promise.resolve().then(() => { signal.throwIfAborted(); return read(signal); });
    void pending.then(value => {
      if (signal.aborted) (value as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
    }).catch(() => {});
    try {
      return await Promise.race([pending, cancelled]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort!);
    }
  }

  /**
   * 存储扫描: 枚举持久化会话, 把尾部命中恢复谓词的未加载会话物化为
   * live agent。宿主重启后 agent 仅在客户端打开会话时才懒加载, 不物化
   * 则启动扫描永远看不到它们; 谓词与上方扫描一致, 仅失败类原因。
   */
  private async sweepStoredSessions(config: AutoContinueConfig, deadline: number): Promise<void> {
    const query = this.ctx.get('sessionQuery');
    if (query === undefined) return;
    const records = await this.readStored(signal => query.listSessions(signal), deadline);
    if (!Array.isArray(records)) throw new TypeError('stored session listing is not an array');
    if (!this.storedSweepAnnounced) {
      this.storedSweepAnnounced = true;
      this.ctx.logger.info(`存储扫描就绪: ${records.length} 个会话记录`);
    }
    let observed = 0;
    // Every stored root below is decoded in full, so a log this chain already failed to read is skipped here too.
    // The record is read once and synchronously: a session it does not name costs one map lookup, no await.
    const rejections = this.loadPersistedRejections();
    const sweepPersistence = this.ctx.get('sessionPersistence') as PersistedStore | undefined;
    for (const record of records) {
      if (this.disposed || Date.now() >= deadline || this.getConfig().paused || !this.getConfig().scanOnBoot) return;
      if (typeof record?.header?.id !== 'string' || record.header.id === '') {
        this.logBootScanFailure(undefined, new TypeError('stored session record has no id'));
        continue;
      }
      const sessionId = record.header.id;
      if (this.sessionConfig(sessionId).paused || Date.now() < (this.pauseUntil.get(sessionId) ?? 0)) continue;
      if (record.live || this.storedSwept.has(sessionId)) continue;
      this.storedSwept.add(sessionId);
      if (record.header.origin === 'subagent') continue;
      if (rejections.has(sessionId)) {
        const currentRevision = sweepPersistence === undefined ? undefined : await this.persistedRevision(sweepPersistence, sessionId);
        if (currentRevision !== undefined && rejections.get(sessionId) === currentRevision) continue;
      }
      observed += 1;
      let observation: StoredObservation | undefined;
      try {
        let stored: StoredObservation;
        try {
          stored = await this.readStored(signal => query.observeSession(sessionId, { projectionMode: 'all', signal }), deadline);
        } catch (error) {
          // Only a read failure is a property of the log. A stall belongs to this boot, so it is retried next time.
          if (!(error instanceof PersistedCallTimeout)) {
            await this.recordPersistedRejection(sessionId, sweepPersistence, rejections);
          }
          throw error;
        }
        // This artifact reads cleanly now, so the rejection recorded for an older revision of it is stale.
        if (rejections.delete(sessionId)) this.schedulePersistedRejectionSave();
        observation = stored;
        if (this.disposed) return;
        if (this.sessionConfig(sessionId).paused) {
          this.storedSwept.delete(sessionId);
          continue;
        }
        const events = validateSessionEvents(stored.events);
        if (events.length === 0) continue;
        // 快照之后客户端可能已打开该会话: 归还 live 扫描, 避免与 live 路径
        // 重复上报, 也避免物化撞上写归属。
        if (this.ctx.agents.get(sessionId) !== undefined) continue;
        let lastEnd: SessionEvent<'turn/end'> | undefined;
        for (let i = events.length - 1; i >= 0; i -= 1) {
          const event = events[i];
          if (event?.type === 'turn/end') { lastEnd = event; break; }
        }
        const lastStart = latestTurnStart(events);
        // 兜底分支: 真实 sessionQuery 冷读会把内存中的 interruptedTurnClosers
        // 折叠进返回日志(尾部即合成 turn/end), 上方 closed-tail 才是生产主路
        // 径。这里覆盖两种例外——不折叠的宿主实现, 以及 listSessions 快照与
        // observeSession 之间客户端刚打开、切在轮次中间的 live 视图。
        const openTurn = lastStart !== undefined && (lastEnd === undefined || lastStart.seq > lastEnd.seq);
        if (isMaintenanceTurnStart(lastStart) && (openTurn || lastStart?.data.turn === lastEnd?.data.turn)) continue;
        let reasonKind: string | undefined;
        let freshAt: number;
        if (openTurn) {
          reasonKind = 'interrupted';
          freshAt = events[events.length - 1]?.time ?? 0;
        } else {
          reasonKind = readReasonKind(lastEnd?.data.reason);
          freshAt = lastEnd?.time ?? 0;
        }
        // 过期或被取代的永久错误与 live 扫描一致地静默跳过, 不再单独上报。
        if (reasonKind === undefined || freshAt < Date.now() - config.freshMs) continue;
        if (reasonKind !== undefined && !openTurn) {
          const silent = reasonKind === 'no-visible-output' && config.resumeSilentTurns;
          // 尾随 turn/start 已按 openTurn 处理, 这里只剩用户接管一种取代形态。
          const superseded = events.some((event) =>
            lastEnd !== undefined && event.seq > lastEnd.seq && event.type === 'user/message' && event.data.source.kind === 'user',
          );
          // Same predicate as the live scan: a graceful-shutdown abort (aborted with cause disposed) is continued too.
          if ((!isInterruptedTurnEnd(lastEnd?.data.reason) && !silent) || superseded) continue;
          // 镜像 live 扫描的裁决: 畸形/永久错误不值得物化——物化后同样会被拦下。
          if (reasonKind === 'error') {
            const failure = parseFailureFacts((lastEnd!.data.reason as { error?: unknown }).error);
            if (failure === undefined) {
              console.error(`[auto-continue] 忽略畸形存储 turn/end ${sessionId}: error details 无法解释`);
              continue;
            }
            // 永久错误同样走 onTurnFailure, 镜像 live 路径的统计与通知旁效。
            if (config.classify && !isTransientFailure(failure, config.retryableErrorPatterns)) {
              this.onTurnFailure(sessionId, 'sweep:turn/end:error', failure);
              continue;
            }
          }
        }
        const presetId = stored.projections?.values.agentPreset ?? stored.header.agentPreset;
        const loggedConfig = foldRequestHeader(events)?.config;
        const materialized = await this.materializeStored(
          sessionId,
          presetId,
          loggedConfig === undefined ? undefined : { provider: loggedConfig.provider, model: loggedConfig.model },
        );
        if (materialized === 'stopped') {
          this.storedSwept.delete(sessionId);
          return;
        }
        // A boot resume already owns this session (the loader, or a live agent): nothing is materialized here.
        if (materialized === 'claimed') continue;
        this.storedSweepFailures.delete(sessionId);
        this.wakeBootScan?.();
        this.ctx.logger.info(openTurn
          ? `扫描物化存储会话 ${sessionId}(日志止于 turn/start, 视作 interrupted), 交给启动扫描接管`
          : `扫描物化存储会话 ${sessionId}(turn/end:${reasonKind}), 交给启动扫描接管`);
      } catch (error) {
        if (this.disposed) return;
        // 观察或物化失败允许下一轮重试; 连续触达上限后放弃, 并清掉计数——
        // 已永久跳过的会话不再进入该映射, 不给长存活宿主留死重。
        const failures = (this.storedSweepFailures.get(sessionId) ?? 0) + 1;
        if (failures < SWEEP_MAX_FAILURES) {
          this.storedSweepFailures.set(sessionId, failures);
          this.storedSwept.delete(sessionId);
        } else {
          this.storedSweepFailures.delete(sessionId);
        }
        this.ctx.logger.error(`存储会话 ${sessionId} 物化失败: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        observation?.[Symbol.dispose]?.();
        if (observed % SWEEP_OBSERVE_BATCH === 0 && !this.disposed) {
          await new Promise<void>(resolve => setTimeout(resolve, 0));
        }
      }
    }
  }

  /**
   * 按会话记录的 preset 组合把存储会话恢复为 live agent(镜像会话控制
   * 器的 adopt 路径: preset 挂载 + 会话已记录的模型选择回装)。模型选择
   * 以日志记录的 request-header 播种 agentOptions——{{model}}/{{provider}}
   * 提示变量与首次请求路由都读它, 驱动器还会因路由吻合而自行回装日志
   * 记录的 effort; 无落点(从未发过请求的会话)回落宿主默认。恢复时追
   * 加的合成 turn/end(`interrupted`)随后由常规扫描按既有关卡恢复。
   */
  private async materializeStored(
    sessionId: SessionId,
    presetId: string | undefined,
    logged: { provider: string; model: string } | undefined,
  ): Promise<'materialized' | 'claimed' | 'stopped'> {
    if (this.disposed || this.sessionConfig(sessionId).paused || !this.getConfig().scanOnBoot) return 'stopped';
    const presets = this.ctx.get('agentPresets');
    // Mirrors session-controller's adopt: without agent options the agent has no
    // provider/model, so prompt variables like {{model}} have no value and the
    // request carries no route.
    const defaultModel = this.ctx.get('agentDefaultModel');
    const selection = defaultModel?.currentSelection();
    const agentOptions = logged !== undefined
      ? { provider: logged.provider, model: logged.model }
      : selection === undefined ? undefined : { provider: selection.provider, model: selection.model };
    // Checked and claimed in the same tick as the host call: no await sits between the check and the claim. A live agent
    // or an earlier boot claim (the loader's resume, still pending or already settled) means nothing is resumed here.
    if (presets === undefined) {
      if (this.ctx.agents.get(sessionId) !== undefined || !this.claimBootResume(sessionId)) return 'claimed';
      await this.resumeClaimed(sessionId, () => this.ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions,
        signal: this.stopStoredSweep.signal,
      }));
      return 'materialized';
    }
    const resolvedId = (await presets.resolve(presetId)).id;
    if (this.disposed || this.sessionConfig(sessionId).paused || !this.getConfig().scanOnBoot) return 'stopped';
    if (this.ctx.agents.get(sessionId) !== undefined || !this.claimBootResume(sessionId)) return 'claimed';
    await this.resumeClaimed(sessionId, () => this.ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions,
      signal: this.stopStoredSweep.signal,
      setup: async (agentCtx) => {
        await presets.mount(agentCtx, resolvedId);
      },
    }));
    return 'materialized';
  }

  /** Take the boot claim for one session. False when a boot resume already owns it (pending, timed out, or succeeded). */
  private claimBootResume(sessionId: SessionId): boolean {
    if (this.bootResumeClaims.has(sessionId)) return false;
    this.bootResumeClaims.add(sessionId);
    return true;
  }

  /**
   * Await a claimed host resume. A rejection releases the claim, so the stored sweep may retry the session. A call that is
   * still pending keeps its claim, including one the loader has stopped waiting for, because a late resume may still publish.
   */
  private async resumeClaimed<T>(sessionId: SessionId, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      this.bootResumeClaims.delete(sessionId);
      throw error;
    }
  }

  /** Captured identity only: even session.id can throw when the header is damaged. */
  private logBootScanFailure(sessionId: SessionId | undefined, error: unknown): void {
    console.error(`[auto-continue] 启动扫描跳过会话 ${sessionId ?? '(id unavailable)'}: ${
      error instanceof Error ? error.message : String(error)
    }`);
  }

  /** 从历史事件恢复上一步工具调用状态(扫描路径的幂等护栏)。 */
  private applyGuardFromEvents(
    state: SessionState,
    events: readonly SessionEvent[],
    untilSeq: number,
  ): void {
    state.tools.restore(events, untilSeq);
  }
}
