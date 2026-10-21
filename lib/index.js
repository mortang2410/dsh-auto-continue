// src/index.ts
import z2 from "@deepseek-ai/schemastery";

// node_modules/@deepseek-ai/dsh-llm/lib/index.js
import { createRequire } from "node:module";
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";

// node_modules/@deepseek-ai/dsh-timeout/lib/index.js
var MAX_TIMER_DELAY_MS = 2147483647;

// node_modules/@deepseek-ai/dsh-llm/lib/index.js
function MessageId(id) {
  return id;
}
function deepFreeze(value) {
  const seen = /* @__PURE__ */ new WeakSet();
  const pending = [{
    kind: "visit",
    node: value
  }];
  while (pending.length > 0) {
    const task = pending.pop();
    if (task === void 0) continue;
    if (task.kind === "property") {
      pending.push({
        kind: "visit",
        node: task.source[task.key]
      });
      continue;
    }
    const node = task.node;
    if (node === null || typeof node !== "object") continue;
    if (node instanceof AbortSignal) continue;
    if (seen.has(node)) continue;
    seen.add(node);
    Object.freeze(node);
    const keys = Object.keys(node);
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index];
      if (key === void 0) continue;
      pending.push({
        kind: "property",
        source: node,
        key
      });
    }
  }
  return value;
}
function freezeMessage(message) {
  return deepFreeze(structuredClone(message));
}
function createMessage(input) {
  return freezeMessage({
    ...input,
    id: MessageId(crypto.randomUUID())
  });
}
function createUserMessage(input) {
  return createMessage({
    ...input,
    role: "user"
  });
}
var EMPTY_RESPONSE_CODE = "EMPTY_RESPONSE";
var STRUCTURED_CONTEXT_OVERFLOW = new RegExp(String.raw`(?:^|[^a-z0-9])context[\s_-](?:length|window)[\s_-]` + String.raw`(?:exceed(?:ed|s)?|overflow(?:ed)?|limit[\s_-]exceeded)(?:$|[^a-z0-9])`, "i");
var TOO_LARGE_FOR_CONTEXT = new RegExp(String.raw`\b(?:request|prompt|input|messages?)\s+(?:is\s+|are\s+)?` + String.raw`too\s+(?:large|long)\s+for\s+(?:(?:this|the)\s+)?` + String.raw`(?:model(?:'s)?\s+)?context(?:\s+window)?\b`, "i");
var EXCEEDS_MODEL_CONTEXT = new RegExp(String.raw`\b(?:input|prompt|request|messages?)\b.{0,40}` + String.raw`\b(?:exceed(?:s|ed)?|overflows?|is\s+larger\s+than)\b.{0,40}` + String.raw`\b(?:the\s+)?(?:model(?:'s)?\s+)?context(?:\s+(?:length|window))?\b`, "i");
var DEFAULT_MAX_RETRIES = 5;
var DEFAULT_INITIAL_DELAY_MS = 500;
var DEFAULT_MAX_DELAY_MS = 1e4;
var DEFAULT_JITTER_RATIO = 0.1;
var DEFAULT_RETRYABLE_CODES = Object.freeze([
  EMPTY_RESPONSE_CODE,
  "RATE_LIMIT",
  "SERVER",
  "TIMEOUT",
  "TRANSPORT"
]);
var backoffSchema = z.object({
  initialDelayMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_INITIAL_DELAY_MS),
  maxDelayMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_MAX_DELAY_MS),
  jitterRatio: z.number().min(0).max(1).default(DEFAULT_JITTER_RATIO)
});
var normalPolicySchema = z.object({
  mode: z.const("normal").required(),
  maxRetries: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_RETRIES),
  retryableCodes: z.array(z.string()).default([...DEFAULT_RETRYABLE_CODES]),
  backoff: backoffSchema
});
var alwaysPolicySchema = z.object({
  mode: z.const("always").required(),
  backoff: backoffSchema
});
var RetryPolicySchema = z.union([normalPolicySchema, alwaysPolicySchema]);
var { version } = createRequire(import.meta.url)("../package.json");

// src/shared/core.ts
var LOCALIZED_TEXT_DEFAULTS = {
  zh: {
    continueText: "继续",
    continueTextMaxTokens: "继续",
    continueTextSilent: "继续。你上一轮只输出了内部推理, 既没有回复也没有调用工具, 用户什么都没看到。每一轮都要以工具调用或可见回复结束。",
    continueTextLoop: "继续",
    guardPendingText: "(上一步工具「{tool}」可能未完成, 先确认状态再继续, 不要重复执行)",
    guardDoneText: "(上一步工具「{tool}」已完成, 结果: {result}; 不要重复执行, 直接继续)",
    loopText: "你陷入循环了. 立刻做点什么, 任何事都行, 马上打破这个循环"
  },
  en: {
    continueText: "Continue",
    continueTextMaxTokens: "Continue",
    continueTextSilent: "Continue. Your previous turn ended with internal reasoning only, with no message and no tool call, so nothing reached the user. Always finish a turn with a tool call or a visible answer.",
    continueTextLoop: "Continue",
    guardPendingText: '(The previous tool "{tool}" may not have completed. Check its state before continuing and do not run it again.)',
    guardDoneText: '(The previous tool "{tool}" completed successfully. Result: {result}; do not run it again. Continue from there.)',
    loopText: "You are deadass in a loop. DO something, anything right now to break the loop"
  }
};
var DEFAULT_CONFIG = {
  locale: "zh",
  ...LOCALIZED_TEXT_DEFAULTS.zh,
  resumeSilentTurns: true,
  resumeCompletedTurns: false,
  continueTextLoop: "",
  guardTools: true,
  graceMs: 3e3,
  cooldownMs: 2e4,
  maxConsecutive: 3,
  scanOnBoot: true,
  scanLimit: 8,
  freshMs: 15 * 60 * 1e3,
  verbose: true,
  classify: true,
  retryableErrorPatterns: "",
  backoffFactor: 2,
  backoffMaxMs: 3e5,
  notify: false,
  paused: false,
  showComposerToggle: true,
  loopGuard: true,
  liveStreamGuard: false,
  loopShortChars: 40,
  loopWindowMs: 3e4,
  loopShortCount: 12,
  loopRepeatText: 4,
  loopToolRepeat: 5
};
function numberOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}
function booleanOr(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}
function resolveConfig(section) {
  const value = section ?? {};
  const locale = value.locale === "en" ? "en" : "zh";
  const localized = LOCALIZED_TEXT_DEFAULTS[locale];
  const text = typeof value.continueText === "string" && value.continueText.trim() !== "" ? value.continueText : localized.continueText;
  const maxTokensText = typeof value.continueTextMaxTokens === "string" && value.continueTextMaxTokens.trim() !== "" ? value.continueTextMaxTokens : localized.continueTextMaxTokens;
  const silentText = typeof value.continueTextSilent === "string" && value.continueTextSilent.trim() !== "" ? value.continueTextSilent : localized.continueTextSilent;
  const loopText = typeof value.continueTextLoop === "string" && value.continueTextLoop.trim() !== "" ? value.continueTextLoop : localized.continueTextLoop;
  const guardPendingText = typeof value.guardPendingText === "string" && value.guardPendingText.trim() !== "" ? value.guardPendingText : localized.guardPendingText;
  const guardDoneText = typeof value.guardDoneText === "string" && value.guardDoneText.trim() !== "" ? value.guardDoneText : localized.guardDoneText;
  return {
    locale,
    continueText: text,
    continueTextMaxTokens: maxTokensText,
    resumeSilentTurns: booleanOr(value.resumeSilentTurns, DEFAULT_CONFIG.resumeSilentTurns),
    resumeCompletedTurns: booleanOr(value.resumeCompletedTurns, DEFAULT_CONFIG.resumeCompletedTurns),
    continueTextSilent: silentText,
    continueTextLoop: loopText,
    guardTools: booleanOr(value.guardTools, DEFAULT_CONFIG.guardTools),
    guardPendingText,
    guardDoneText,
    graceMs: numberOr(value.graceMs, DEFAULT_CONFIG.graceMs),
    cooldownMs: numberOr(value.cooldownMs, DEFAULT_CONFIG.cooldownMs),
    maxConsecutive: Math.max(1, numberOr(value.maxConsecutive, DEFAULT_CONFIG.maxConsecutive)),
    scanOnBoot: booleanOr(value.scanOnBoot, DEFAULT_CONFIG.scanOnBoot),
    scanLimit: Math.max(1, numberOr(value.scanLimit, DEFAULT_CONFIG.scanLimit)),
    freshMs: numberOr(value.freshMs, DEFAULT_CONFIG.freshMs),
    verbose: booleanOr(value.verbose, DEFAULT_CONFIG.verbose),
    classify: booleanOr(value.classify, DEFAULT_CONFIG.classify),
    retryableErrorPatterns: typeof value.retryableErrorPatterns === "string" ? value.retryableErrorPatterns.trim() : DEFAULT_CONFIG.retryableErrorPatterns,
    backoffFactor: Math.max(1, numberOr(value.backoffFactor, DEFAULT_CONFIG.backoffFactor)),
    backoffMaxMs: numberOr(value.backoffMaxMs, DEFAULT_CONFIG.backoffMaxMs),
    notify: booleanOr(value.notify, DEFAULT_CONFIG.notify),
    paused: booleanOr(value.paused, DEFAULT_CONFIG.paused),
    showComposerToggle: booleanOr(value.showComposerToggle, DEFAULT_CONFIG.showComposerToggle),
    loopGuard: booleanOr(value.loopGuard, DEFAULT_CONFIG.loopGuard),
    liveStreamGuard: booleanOr(value.liveStreamGuard, DEFAULT_CONFIG.liveStreamGuard),
    loopShortChars: Math.max(1, numberOr(value.loopShortChars, DEFAULT_CONFIG.loopShortChars)),
    loopWindowMs: Math.max(1e3, numberOr(value.loopWindowMs, DEFAULT_CONFIG.loopWindowMs)),
    loopShortCount: Math.max(2, numberOr(value.loopShortCount, DEFAULT_CONFIG.loopShortCount)),
    loopRepeatText: Math.max(2, numberOr(value.loopRepeatText, DEFAULT_CONFIG.loopRepeatText)),
    loopToolRepeat: Math.max(2, numberOr(value.loopToolRepeat, DEFAULT_CONFIG.loopToolRepeat)),
    loopText: typeof value.loopText === "string" && value.loopText.trim() !== "" ? value.loopText : localized.loopText
  };
}
function isNonHumanReason(kind) {
  return kind === "error" || kind === "interrupted" || kind === "max-tokens";
}
function isTransientFailure(failure, retryableErrorPatterns = "") {
  const haystack = `${failure.code} ${failure.status ?? ""} ${failure.message}`.toLowerCase();
  const explicitlyRetryable = retryableErrorPatterns.split(/\r?\n/).map((pattern) => pattern.trim().toLowerCase()).filter((pattern) => pattern !== "").some((pattern) => haystack.includes(pattern));
  if (explicitlyRetryable) return true;
  const status = failure.status;
  if (status !== void 0 && (status === 401 || status === 403)) return false;
  const permanent = /auth|unauthor|forbidden|credential|api[_-]?key|permission/i.test(haystack) || /insufficient.*(balance|quota)|billing|payment|quota.*exceeded.*(?!retry)/i.test(haystack) || /model.*not[_-]?found|unknown[_-]?model|model[_-]?not[_-]?found|not.*support.*model/i.test(haystack) || /context.*(length|limit|overflow|exceed)|token.*limit|max.*context/i.test(haystack) || /invalid[_-]?request|bad[_-]?request/i.test(haystack);
  return !permanent;
}
function formatElapsed(ms) {
  if (ms === void 0 || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1e3) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1e3);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60 > 0 ? `${s % 60}s` : ""}`;
}
function fillTemplate(template, ctx) {
  return template.replace(/\{code\}/g, ctx.facts?.code ?? "").replace(/\{message\}/g, ctx.facts?.message ?? "").replace(/\{status\}/g, ctx.facts?.status !== void 0 ? String(ctx.facts.status) : "").replace(/\{tool\}/g, ctx.tool ?? "").replace(/\{turn\}/g, ctx.turn !== void 0 ? String(ctx.turn) : "").replace(/\{errorCount\}/g, ctx.errorCount !== void 0 ? String(ctx.errorCount) : "").replace(/\{sessionTitle\}/g, ctx.sessionTitle ?? "").replace(/\{elapsed\}/g, formatElapsed(ctx.elapsedMs)).replace(/\{result\}/g, ctx.result ?? "");
}
var TOOL_RESULT_CAP = 160;
function stableFingerprint(value) {
  let first = 2166136261;
  let second = 2654435769;
  let length = 0;
  const feed = (text) => {
    length += text.length;
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      first = Math.imul(first ^ code, 16777619) >>> 0;
      second = Math.imul(second ^ code, 2246822507) >>> 0;
      second = (second ^ second >>> 13) >>> 0;
    }
  };
  const walk = (part) => {
    if (part === null) {
      feed("null");
    } else if (Array.isArray(part)) {
      feed("[");
      for (const item of part) {
        walk(item);
        feed(",");
      }
      feed("]");
    } else if (typeof part === "object") {
      feed("{");
      const record = part;
      for (const key of Object.keys(record).sort()) {
        feed(JSON.stringify(key));
        feed(":");
        walk(record[key]);
        feed(",");
      }
      feed("}");
    } else {
      feed(`${typeof part}:${JSON.stringify(part) ?? String(part)}`);
    }
  };
  walk(value);
  return `${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}:${length}`;
}
function extractText(blocks, cap) {
  let out = "";
  const walk = (value) => {
    if (out.length >= cap) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const record = value;
    if (record["type"] === "text" && typeof record["text"] === "string") {
      out += record["text"];
      return;
    }
    for (const child of Object.values(record)) walk(child);
  };
  walk(blocks);
  return out.slice(0, cap);
}
function toolCorrelationKey(data, callId) {
  if (callId === void 0 || typeof data.turn !== "number" || typeof data.step !== "number") {
    return void 0;
  }
  return JSON.stringify([data.turn, data.step, callId]);
}
function resultBlock(data) {
  return data.message?.content?.find((part) => part.type === "tool-result");
}
function toolResultCallId(data) {
  if (resultBlock(data) === void 0) return void 0;
  const sourceId = data.message?.source?.kind === "tool" ? data.message.source.callId : void 0;
  const blockId = resultBlock(data)?.toolCallId;
  const source = typeof sourceId === "string" && sourceId !== "" ? sourceId : void 0;
  const block = typeof blockId === "string" && blockId !== "" ? blockId : void 0;
  if (source !== void 0 && block !== void 0 && source !== block) return void 0;
  return source ?? block;
}
function toolResultFacts(data) {
  const result = resultBlock(data);
  const failed = data.error !== void 0 || result?.isError === true;
  return {
    ok: !failed,
    excerpt: extractText(result?.content, TOOL_RESULT_CAP),
    identity: stableFingerprint({ content: result?.content ?? [], isError: failed })
  };
}
var MAX_PENDING_TOOL_CALLS = 64;
var MAX_SEEN_TOOL_CALL_IDS = 256;
var ToolInvocationTracker = class {
  constructor() {
    this.pendingById = /* @__PURE__ */ new Map();
    this.pendingInOrder = [];
    this.seenCalls = /* @__PURE__ */ new Map();
    this.seenInOrder = [];
    this.lastEventSeq = -1;
  }
  reset() {
    this.pendingById.clear();
    this.pendingInOrder.length = 0;
    this.seenCalls.clear();
    this.seenInOrder.length = 0;
    this.latest = void 0;
    this.run = void 0;
    this.repeatSignal = void 0;
    this.lastEventSeq = -1;
  }
  /** 新回合边界：清空工具态，同时把重放水位推进到 turn/start。 */
  startTurn(seq) {
    if (!Number.isSafeInteger(seq) || seq < 0 || seq <= this.lastEventSeq) return;
    this.reset();
    this.lastEventSeq = seq;
  }
  /** 回合已结束：保留最后一次调用的护栏，丢弃不再可用的 loop 关联态。 */
  resetRepeat() {
    this.pendingById.clear();
    this.pendingInOrder.length = 0;
    this.seenCalls.clear();
    this.seenInOrder.length = 0;
    this.run = void 0;
    this.repeatSignal = void 0;
  }
  recordCall(event) {
    if (!this.acceptEventSeq(event.seq)) return false;
    this.repeatSignal = void 0;
    const data = event.data;
    if (typeof data.name !== "string") {
      this.breakCorrelation();
      return true;
    }
    const key = `${data.name}
${typeof data.arguments === "string" ? data.arguments : ""}`;
    const callId = typeof data.callId === "string" && data.callId !== "" ? data.callId : void 0;
    const id = toolCorrelationKey(data, callId);
    if (id === void 0) {
      this.breakCorrelation({
        id: void 0,
        name: data.name,
        key,
        result: void 0,
        resultSeq: void 0
      });
      return true;
    }
    const seen = this.seenCalls.get(id);
    if (seen !== void 0) {
      this.breakCorrelation({
        id: void 0,
        name: data.name,
        key,
        result: void 0,
        resultSeq: void 0
      });
      return true;
    }
    const call = {
      id,
      name: data.name,
      key,
      result: void 0,
      resultSeq: void 0
    };
    this.latest = call;
    this.pendingById.set(id, call);
    this.pendingInOrder.push(call);
    this.seenCalls.set(id, call);
    this.seenInOrder.push(id);
    this.trim(call);
    return true;
  }
  recordResult(event) {
    if (!this.acceptEventSeq(event.seq)) return void 0;
    const data = event.data;
    const id = toolCorrelationKey(data, toolResultCallId(data));
    if (id === void 0) {
      this.breakCorrelation(this.latest);
      return void 0;
    }
    const surfaceOp = event.surfaceOp;
    if (typeof surfaceOp === "object" && surfaceOp !== null) {
      const call2 = this.seenCalls.get(id);
      if (surfaceOp.start !== surfaceOp.end || call2 === void 0 || call2.result === void 0 || call2.resultSeq !== surfaceOp.start) {
        this.breakCorrelation(this.latest);
        return void 0;
      }
      call2.result = toolResultFacts(data);
      call2.resultSeq = event.seq;
      this.breakCorrelation(this.latest);
      return void 0;
    }
    const call = this.pendingById.get(id);
    if (call === void 0) {
      const seen = this.seenCalls.get(id);
      const duplicate = seen?.result;
      const incoming = toolResultFacts(data);
      if (seen !== void 0 && duplicate !== void 0 && seen.resultSeq === event.seq && duplicate.identity === incoming.identity) {
        return void 0;
      }
      if (seen !== void 0 && duplicate !== void 0) {
        seen.result = void 0;
        seen.resultSeq = void 0;
      }
      this.breakCorrelation(this.latest);
      return void 0;
    }
    if (call.result !== void 0) {
      const incoming = toolResultFacts(data);
      if (call.resultSeq === event.seq && call.result.identity === incoming.identity) {
        return void 0;
      }
      call.result = void 0;
      call.resultSeq = void 0;
      this.breakCorrelation(this.latest);
      return void 0;
    }
    call.result = toolResultFacts(data);
    call.resultSeq = event.seq;
    return this.drainCompleted();
  }
  guard() {
    const latest = this.latest;
    if (latest === void 0) return { kind: "none" };
    if (latest.result === void 0) return { kind: "pending", tool: latest.name };
    if (latest.result.ok) {
      return { kind: "done", tool: latest.name, result: latest.result.excerpt };
    }
    return { kind: "failed", tool: latest.name };
  }
  lastTool() {
    return this.latest?.name;
  }
  /** 下一模型 step 是稳定边界；此前 replacement/新调用会先清除候选。 */
  confirmRepeatAtStep(seq) {
    if (!this.acceptEventSeq(seq)) return void 0;
    const signal = this.pendingInOrder.length === 0 ? this.repeatSignal : void 0;
    this.repeatSignal = void 0;
    return signal;
  }
  /** 非工具 surface range replacement（如 compaction summary）同样终止旧工具证据。 */
  recordSurfaceReplacement(seq) {
    if (!this.acceptEventSeq(seq)) return;
    this.breakCorrelation(this.latest);
  }
  restore(events, untilSeq) {
    this.reset();
    for (const event of events) {
      if (event.seq >= untilSeq) continue;
      if (event.type === "turn/start") this.startTurn(event.seq);
      else if (event.type === "step/start") this.confirmRepeatAtStep(event.seq);
      else if (event.type === "tool/call") this.recordCall(event);
      else if (event.type === "tool/result") this.recordResult(event);
      else if ((event.type === "user/message" || event.type === "assistant/message") && typeof event.surfaceOp === "object" && event.surfaceOp !== null) {
        this.recordSurfaceReplacement(event.seq);
      }
    }
  }
  acceptEventSeq(seq) {
    if (!Number.isSafeInteger(seq) || seq < 0) {
      this.breakCorrelation(this.latest);
      return false;
    }
    if (seq <= this.lastEventSeq) return false;
    this.lastEventSeq = seq;
    return true;
  }
  breakCorrelation(latest, preserve) {
    this.pendingById.clear();
    this.pendingInOrder.length = 0;
    this.invalidateRunHistory();
    this.latest = latest;
    if (preserve?.id !== void 0 && preserve.result === void 0 && this.seenCalls.get(preserve.id) === preserve) {
      this.pendingById.set(preserve.id, preserve);
      this.pendingInOrder.push(preserve);
    }
  }
  invalidateRunHistory() {
    this.run = void 0;
    this.repeatSignal = void 0;
  }
  trim(current) {
    while (this.pendingInOrder.length > MAX_PENDING_TOOL_CALLS) {
      this.breakCorrelation(current, current);
    }
    while (this.seenInOrder.length > MAX_SEEN_TOOL_CALL_IDS) {
      const id = this.seenInOrder.shift();
      if (id !== void 0) {
        this.seenCalls.delete(id);
        this.breakCorrelation(current, current);
      }
    }
  }
  drainCompleted() {
    let advanced = false;
    while (this.pendingInOrder[0]?.result !== void 0) {
      const call = this.pendingInOrder.shift();
      if (call === void 0 || call.result === void 0) break;
      advanced = true;
      if (call.id !== void 0) this.pendingById.delete(call.id);
      this.advanceRun(call);
    }
    if (!advanced) return void 0;
    return this.refreshRepeatSignal();
  }
  advanceRun(call) {
    if (call.result === void 0) return;
    if (this.run?.key === call.key && this.run.identity === call.result.identity) {
      this.run.count += 1;
    } else {
      this.run = { key: call.key, tool: call.name, identity: call.result.identity, count: 1 };
    }
  }
  refreshRepeatSignal() {
    this.repeatSignal = this.pendingInOrder.length === 0 && this.run !== void 0 ? { tool: this.run.tool, count: this.run.count } : void 0;
    return this.repeatSignal;
  }
};
function effectiveCooldown(consecutive, base, factor, max) {
  const multiplier = Math.pow(factor, consecutive);
  return Math.min(Math.max(base, base * multiplier), Math.max(base, max));
}
function todayKey() {
  const d = /* @__PURE__ */ new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}
function emptyDayStats() {
  return { date: todayKey(), sent: 0, skipped: 0, recovered: 0, failed: 0, gaveUp: 0, looped: 0, byCode: {} };
}
var REASON_DENSITY = {
  minChars: 8e3,
  minSentences: 150,
  maxUniqueRatio: 0.35,
  minSentenceChars: 15,
  maxSentenceChars: 1e3,
  /** Line arm: distinct non-blank lines divided by non-blank lines must not exceed this. */
  maxLineRatio: 0.3,
  /** Line arm: the most common non-blank line must occur at least this many times. */
  minLineRepeats: 300,
  /** Line arm: the distinct-line ratio is only defined from this many non-blank lines (replay floor). */
  minRatioLines: 20,
  /**
   * Line arm: the longest unterminated tail kept while waiting for the newline that ends a line.
   * The tail is dropped above this, so a step that never emits a newline cannot retain its whole
   * reasoning text. Set above the corpus maximum non-blank line (35,586 characters, session
   * 0cb0f4f2 step 68) so no line that any measured step counts is lost; the margin is 29,950.
   */
  maxLineChars: 65536
};
var ReasoningDensity = class {
  constructor() {
    this.chars = 0;
    this.sentences = 0;
    this.buffer = "";
    this.counts = /* @__PURE__ */ new Map();
    /**
     * Line arm state: the reasoning text of the step so far. Lines can still be extended by a later
     * delta, so a line is only counted once the newline that ends it has arrived. Only the counters
     * and this tail are kept; the text is dropped on reset.
     */
    this.lineTail = "";
    this.lines = 0;
    this.lineCounts = /* @__PURE__ */ new Map();
    this.lineTop = 0;
    /** Latched on the first trip of the step (vrpe X-M2): later deltas return true without counting. */
    this.latched = false;
    /** The trip log is written once per step (vrpe X-M2). */
    this.tripLogged = false;
    /** The cooldown refusal log is written once per step (vrpe X-M2). */
    this.refusalLogged = false;
  }
  reset() {
    this.chars = 0;
    this.sentences = 0;
    this.buffer = "";
    this.counts.clear();
    this.lineTail = "";
    this.lines = 0;
    this.lineCounts.clear();
    this.lineTop = 0;
    this.latched = false;
    this.tripLogged = false;
    this.refusalLogged = false;
  }
  /** Feed one reasoning delta; true once the step meets the spiral thresholds, and it stays true after. */
  feed(text) {
    if (this.latched) return true;
    this.chars += text.length;
    const parts = `${this.buffer}${text}`.split(/(?<=[.?!])\s+|(?<=[。！？])|\n+/u);
    this.buffer = parts.pop() ?? "";
    if (this.buffer.length > REASON_DENSITY.maxSentenceChars) this.buffer = "";
    for (const part of parts) {
      const sentence = part.trim();
      if (sentence.length <= REASON_DENSITY.minSentenceChars) continue;
      this.sentences += 1;
      this.counts.set(sentence, (this.counts.get(sentence) ?? 0) + 1);
    }
    this.feedLines(text);
    if (this.tripped()) this.latched = true;
    return this.latched;
  }
  /**
   * Count every line completed by this delta. Only `\n` ends a line; a `\r` before it is part of
   * the line and is removed by trim, so CRLF reasoning counts as the replay's LF form. A line
   * that is empty or whitespace only is not counted, which mirrors the replay's non-blank rule.
   *
   * The tail is capped for the same reason the sentence buffer is: a step that never emits a
   * newline would otherwise retain its whole reasoning text here. Measured on the uncapped version,
   * retained state was 9.10 MB for a 10,000,000 character step, against 0.06 MB with the cap.
   *
   * The invariant is `lineTail.length <= maxLineChars`, not "the tail is empty". This method
   * appends before it tests, so the tail grows to the cap, drops to empty, and regrows: a run of
   * deltas with no newline ends with a tail of whatever the last append left, which is at most the
   * cap. A dropped tail is not counted, so no candidate line is invented.
   *
   * Two consequences worth knowing. A completed line is always counted, however long, because it
   * sits before the last newline when the cap is applied. An unterminated line longer than the cap
   * is dropped, and whether that loses a line depends on how the stream was chunked: one delta that
   * contains the newline keeps a line of any length, while the same line streamed in pieces is
   * lost once the tail passes the cap. Only lines longer than `maxLineChars` are affected, which is
   * 1.8 times the longest line in the corpus, and both effects move the ratio toward tripping while
   * leaving the repeat count untouched, so the error is on the safe side.
   */
  feedLines(text) {
    const joined = this.lineTail + text;
    const last = joined.lastIndexOf("\n");
    if (last < 0) {
      this.lineTail = joined.length > REASON_DENSITY.maxLineChars ? "" : joined;
      return;
    }
    for (const piece of joined.slice(0, last).split("\n")) this.countLine(piece);
    const tail = joined.slice(last + 1);
    this.lineTail = tail.length > REASON_DENSITY.maxLineChars ? "" : tail;
  }
  countLine(piece) {
    const line = piece.trim();
    if (line === "") return;
    this.lines += 1;
    const count = (this.lineCounts.get(line) ?? 0) + 1;
    this.lineCounts.set(line, count);
    if (count > this.lineTop) this.lineTop = count;
  }
  /**
   * Sentence arm: enough counted sentences and few enough distinct sentences. Unchanged.
   */
  sentenceTripped() {
    return this.sentences >= REASON_DENSITY.minSentences && this.counts.size <= REASON_DENSITY.maxUniqueRatio * this.sentences;
  }
  /**
   * Line arm: enough non-blank lines, few enough distinct non-blank lines, and one line repeated
   * often enough. The comparisons are the replay's: `distinct <= maxLineRatio * lines` with the
   * distinct count as an integer, and `top >= minLineRepeats`.
   *
   * `minRatioLines` is the replay's `nb >= 20` floor, below which it does not define the ratio at
   * all (measure_v4/spiral_replay_v4.py, the `nb_p >= LN_MIN_NB` guard). The floor cannot change a
   * verdict: `top >= minLineRepeats` already forces at least 300 non-blank lines, so the floor is
   * unreachable whenever the second half of the test holds. It is kept so the implementation and
   * the replay agree by construction rather than by that argument.
   */
  lineTripped() {
    return this.lines >= REASON_DENSITY.minRatioLines && this.lineCounts.size <= REASON_DENSITY.maxLineRatio * this.lines && this.lineTop >= REASON_DENSITY.minLineRepeats;
  }
  tripped() {
    return this.chars >= REASON_DENSITY.minChars && (this.sentenceTripped() || this.lineTripped());
  }
  /** Counts of the line arm, for tests: non-blank lines, distinct lines and top repeat count. */
  lineStats() {
    return { lines: this.lines, distinct: this.lineCounts.size, top: this.lineTop };
  }
};
var freshState = () => ({
  consecutive: 0,
  lastAttemptAt: 0,
  pendingEchoMessageIds: /* @__PURE__ */ new Map(),
  pendingTimer: void 0,
  running: void 0,
  queued: 0,
  subagent: false,
  lastFailure: void 0,
  lastFailureAt: 0,
  tools: new ToolInvocationTracker(),
  lastTurn: void 0,
  pendingRecoveryAt: 0,
  turnOutput: "unknown",
  outputTurn: void 0,
  outputStartSeq: 0,
  stepOutput: "none",
  reasoningOnlyUnits: 0,
  reasonDensity: new ReasoningDensity(),
  shortRun: 0,
  lastShortAt: 0,
  lastAssistantText: "",
  sameTextRun: 0,
  streamTail: "",
  streamLastSegment: "",
  streamRepeatRun: 0,
  loopFired: false,
  spiralTripped: false,
  spiralEscalated: false,
  loopRetryTimer: void 0,
  cooldownRetryTimer: void 0
});
var RECOVERY_WINDOW_MS = 10 * 60 * 1e3;
var ECHO_WINDOW_MS = 10 * 60 * 1e3;
var MAX_PENDING_ECHO_MESSAGE_IDS = 64;
function prunePendingEchoMessageIds(state, now) {
  for (const [messageId, queuedAt] of state.pendingEchoMessageIds) {
    if (now - queuedAt > ECHO_WINDOW_MS) state.pendingEchoMessageIds.delete(messageId);
  }
}
function trackPendingEcho(state, messageId) {
  const now = Date.now();
  prunePendingEchoMessageIds(state, now);
  state.pendingEchoMessageIds.set(messageId, now);
  while (state.pendingEchoMessageIds.size > MAX_PENDING_ECHO_MESSAGE_IDS) {
    const oldest = state.pendingEchoMessageIds.keys().next();
    if (oldest.done) break;
    state.pendingEchoMessageIds.delete(oldest.value);
  }
}
function forgetPendingEcho(state, messageId) {
  state.pendingEchoMessageIds.delete(messageId);
}
function isOurEcho(state, event) {
  if (event.type !== "user/message") return false;
  const message = event.data;
  if (message.source.kind !== "user") return false;
  if (state.pendingEchoMessageIds.size === 0) return false;
  const now = Date.now();
  prunePendingEchoMessageIds(state, now);
  return state.pendingEchoMessageIds.delete(message.id);
}

// src/host/engine.ts
var NOTICE_COPY = {
  zh: {
    notContinuedTitle: "dsh-auto-continue: 未自动继续",
    permanentErrorBody: (sessionId, summary) => `${sessionId}: 永久性错误 ${summary}，需要人工处理`,
    resumeAction: "立即续跑",
    pauseAction: "暂停该会话 1 小时",
    continuedTitle: "dsh-auto-continue: 已自动继续",
    continuedBody: (sessionId, text, count) => `${sessionId}: 已发送「${text}」(第 ${count} 次连续)`,
    stoppedTitle: "dsh-auto-continue: 已停止自动继续",
    stoppedBody: (sessionId, count) => `${sessionId}: 连续失败 ${count} 次, 需要人工介入`,
    spiralStoppedBody: (sessionId) => `${sessionId}: 推理复读: 强制续跑一次后仍无可见输出, 已停止自动继续, 需要人工介入`,
    spiralChildStoppedBody: (sessionId) => `${sessionId}: 子代理会话推理复读: 未自动续跑, 需要人工介入`
  },
  en: {
    notContinuedTitle: "dsh-auto-continue: Not continued",
    permanentErrorBody: (sessionId, summary) => `${sessionId}: Permanent error ${summary}; manual intervention required`,
    resumeAction: "Resume now",
    pauseAction: "Pause this session for 1 hour",
    continuedTitle: "dsh-auto-continue: Continued automatically",
    continuedBody: (sessionId, text, count) => `${sessionId}: Sent "${text}" (consecutive attempt ${count})`,
    stoppedTitle: "dsh-auto-continue: Auto-continue stopped",
    stoppedBody: (sessionId, count) => `${sessionId}: ${count} consecutive failures; manual intervention required`,
    spiralStoppedBody: (sessionId) => `${sessionId}: Reasoning loop again after one forced resume with no visible output; auto-continue stopped, manual intervention required`,
    spiralChildStoppedBody: (sessionId) => `${sessionId}: Reasoning loop in a subagent session; not continued automatically, manual intervention required`
  }
};
var LOOP_GUARD_CANCEL_CAUSE = {
  kind: "hook",
  reason: "dsh-auto-continue:loop-guard"
};
var LOOP_COMPLETED_REASON = "turn/end:completed";
var LOOP_SILENT_REASON = "turn/end:loop-silent";
var LOOP_SPIRAL_REASON = "loop:spiral";
var SILENT_REASONING_SKIP_UNITS = 8e3;
var LOOP_SPIRAL_SCAN_MESSAGES = 32;
var MANUAL_NOTIFICATION_REASON = "manual:notification";
var isLoopReason = (reason) => reason === LOOP_COMPLETED_REASON || reason === LOOP_SILENT_REASON;
var STREAM_NEAR_DUPLICATE_MAX_CHARS = 2048;
var STREAM_TAIL_MAX_CHARS = 4096;
function snapshotSessionEvents(session) {
  const compatible = session;
  if (typeof compatible.snapshotEvents === "function") return compatible.snapshotEvents();
  if (compatible.events !== void 0) return compatible.events;
  throw new TypeError("session exposes neither snapshotEvents() nor events");
}
function parseFailureFacts(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
  const failure = value;
  const code = typeof failure.code === "string" && failure.code.trim() !== "" ? failure.code : void 0;
  const message = typeof failure.message === "string" && failure.message.trim() !== "" ? failure.message : void 0;
  const status = typeof failure.status === "number" && Number.isFinite(failure.status) ? failure.status : void 0;
  if (code === void 0 && message === void 0 && status === void 0) return void 0;
  return {
    code: code ?? "UNKNOWN",
    message: message ?? code ?? `HTTP ${status}`,
    ...status !== void 0 ? { status } : {}
  };
}
function readReasonKind(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
  const kind = value.kind;
  return typeof kind === "string" && kind.trim() !== "" ? kind : void 0;
}
function isInterruptedTurnEnd(reason) {
  const kind = readReasonKind(reason);
  if (kind === void 0) return false;
  if (isNonHumanReason(kind)) return true;
  return kind === "aborted" && readReasonKind(reason.reason) === "disposed";
}
function lastTurnMessageContent(events, end) {
  for (let i = events.indexOf(end) - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type === "turn/start" || event?.type === "turn/end") return void 0;
    if (event?.type === "assistant/message") return event.data.message.content;
  }
  return void 0;
}
function reasoningUnits(content) {
  if (!Array.isArray(content)) return 0;
  let units = 0;
  for (const part of content) {
    if (part?.type === "reasoning" && typeof part.text === "string") units += part.text.length;
  }
  return units;
}
function persistedSpiralTripped(events, end, loopGuard) {
  if (end === void 0 || !loopGuard) return false;
  const density = new ReasoningDensity();
  let messages = 0;
  let step;
  for (let i = events.indexOf(end) - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event === void 0) continue;
    if (event.type === "turn/start" || event.type === "turn/end") return false;
    if (event.type !== "assistant/message") continue;
    messages += 1;
    if (messages > LOOP_SPIRAL_SCAN_MESSAGES) return false;
    const ownStep = event.data.step;
    if (ownStep === void 0 || ownStep !== step) {
      step = ownStep;
      density.reset();
    }
    const content = event.data.message.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type === "reasoning" && typeof part.text === "string" && density.feed(part.text)) return true;
    }
  }
  return false;
}
var BOOT_CONTINUED_KEY = Symbol.for("dsh.auto-continue.bootContinued");
function bootContinuedIds() {
  const scope = globalThis;
  const existing = scope[BOOT_CONTINUED_KEY];
  if (existing !== void 0) return existing;
  const created = /* @__PURE__ */ new Set();
  scope[BOOT_CONTINUED_KEY] = created;
  return created;
}
function reportLoaderError(error) {
  console.error(`[auto-continue] 持久化会话加载异常: ${error instanceof Error ? error.message : String(error)}`);
}
function persistedLastActivity(events, now, config) {
  let lastStart;
  let lastEnd;
  let lastActivityAt = 0;
  for (const event of events) {
    lastActivityAt = Math.max(lastActivityAt, event.time);
    if (event.type === "turn/start") lastStart = event;
    else if (event.type === "turn/end") lastEnd = event;
  }
  if (lastStart !== void 0 && (lastEnd === void 0 || lastStart.seq > lastEnd.seq)) {
    return lastActivityAt >= now - config.freshMs ? lastActivityAt : void 0;
  }
  if (lastEnd === void 0) return void 0;
  const endSeq = lastEnd.seq;
  if (events.some((event) => event.seq > endSeq && event.type === "user/message" && event.data.source.kind === "user")) {
    return void 0;
  }
  const reasonKind = readReasonKind(lastEnd.data.reason);
  if (reasonKind === void 0 || !isInterruptedTurnEnd(lastEnd.data.reason)) return void 0;
  if (reasonKind === "error") {
    const failure = parseFailureFacts(lastEnd.data.reason.error);
    if (failure === void 0) return void 0;
    if (config.classify && !isTransientFailure(failure, config.retryableErrorPatterns)) return void 0;
  }
  return lastEnd.time >= now - config.freshMs ? lastActivityAt : void 0;
}
function persistedRoute(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type !== "request/header") continue;
    const config = event.data.header?.config;
    const provider = config?.provider;
    const model = config?.model;
    return typeof provider === "string" && provider !== "" && typeof model === "string" && model !== "" ? { provider, model } : void 0;
  }
  return void 0;
}
function persistedPreset(header, events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type !== "agent-preset/selected") continue;
    const selected = event.data?.agentPreset;
    return typeof selected === "string" && selected !== "" ? selected : void 0;
  }
  return typeof header.agentPreset === "string" && header.agentPreset !== "" ? header.agentPreset : void 0;
}
var CHILD_DESCRIPTOR_VERSION = 3;
var CHILD_DESCRIPTOR_KEYS = /* @__PURE__ */ new Set([
  "version",
  "mode",
  "provider",
  "label",
  "agentProvider",
  "agentModel",
  "agentReasoningEffort",
  "persona",
  "toolFilter"
]);
var TOOL_FILTER_KEYS = /* @__PURE__ */ new Set(["allow", "deny"]);
function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function persistedChildDescriptor(events, inheritedEventCount) {
  const record = events.slice(inheritedEventCount).find((event) => event.type === "subagent/descriptor");
  const value = record?.data;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
  const data = value;
  if (data.version !== CHILD_DESCRIPTOR_VERSION || data.mode !== "continuable") return void 0;
  if (Object.keys(data).some((key) => !CHILD_DESCRIPTOR_KEYS.has(key))) return void 0;
  if (typeof data.provider !== "string" || typeof data.label !== "string") return void 0;
  for (const key of ["agentProvider", "agentModel", "agentReasoningEffort", "persona"]) {
    if (data[key] !== void 0 && typeof data[key] !== "string") return void 0;
  }
  let toolFilter;
  if (data.toolFilter !== void 0) {
    const rules = data.toolFilter;
    if (typeof rules !== "object" || rules === null || Array.isArray(rules)) return void 0;
    const filter = rules;
    if (Object.keys(filter).some((key) => !TOOL_FILTER_KEYS.has(key))) return void 0;
    if (filter.allow === void 0 && filter.deny === void 0) return void 0;
    if (filter.allow !== void 0 && !isStringArray(filter.allow) || filter.deny !== void 0 && !isStringArray(filter.deny)) {
      return void 0;
    }
    toolFilter = {
      ...filter.allow !== void 0 ? { allow: filter.allow } : {},
      ...filter.deny !== void 0 ? { deny: filter.deny } : {}
    };
  }
  if (data.agentProvider === void 0 !== (data.agentModel === void 0)) return void 0;
  return {
    ...typeof data.agentProvider === "string" ? { agentProvider: data.agentProvider } : {},
    ...typeof data.agentModel === "string" ? { agentModel: data.agentModel } : {},
    ...typeof data.agentReasoningEffort === "string" ? { agentReasoningEffort: data.agentReasoningEffort } : {},
    ...typeof data.persona === "string" ? { persona: data.persona } : {},
    ...toolFilter !== void 0 ? { toolFilter } : {}
  };
}
var PERSISTED_CALL_TIMEOUT_MS = 1e4;
var PersistedCallTimeout = class extends Error {
};
var ADMISSION_LIMIT_CODE = "ACTIVATION_LIMIT_REACHED";
function isAdmissionLimit(error) {
  return typeof error === "object" && error !== null && error.code === ADMISSION_LIMIT_CODE;
}
var ALREADY_RESIDENT_CODE = "ALREADY_RESIDENT";
function isAlreadyResident(error) {
  return typeof error === "object" && error !== null && error.code === ALREADY_RESIDENT_CODE;
}
var ALREADY_RAN_CODE = "ALREADY_RAN";
function isAlreadyRan(error) {
  return typeof error === "object" && error !== null && error.code === ALREADY_RAN_CODE;
}
function logResumeFailure(entry, error) {
  console.error(`[auto-continue] 恢复持久化会话失败 ${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
}
async function withPersistedTimeout(call, onTimeout) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
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
function isLoopGuardCancelReason(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const cause = value;
  return cause.kind === LOOP_GUARD_CANCEL_CAUSE.kind && cause.reason === LOOP_GUARD_CANCEL_CAUSE.reason;
}
var AutoContinueRunner = class {
  /**
   * @param ctx - host plugin context (agents registry, session events).
   * @param getConfig - read the current resolved configuration (entry config).
   */
  constructor(ctx, getConfig) {
    this.ctx = ctx;
    this.getConfig = getConfig;
    this.states = /* @__PURE__ */ new Map();
    this.pauseUntil = /* @__PURE__ */ new Map();
    this.dayStats = emptyDayStats();
    this.notices = [];
    this.noticeListeners = /* @__PURE__ */ new Set();
    this.stateListeners = /* @__PURE__ */ new Set();
    this.prioritizedFollowups = /* @__PURE__ */ new Set();
    this.disposed = false;
    this.bootScannedSessions = /* @__PURE__ */ new WeakSet();
    /** Persisted sessions are enumerated once per boot, after the service is available. */
    this.persistedEnumerated = false;
    this.persistedDecided = /* @__PURE__ */ new Set();
    /** Eligible persisted sessions not yet resumed, newest activity first. */
    this.persistedQueue = [];
    /** Boot window end, set when bootScanLoop starts. Zero until then, so the loader starts no host call. */
    this.bootDeadline = 0;
    /** Ids the loader asked the host to resume. Their agents take only the scanLimit slots live candidates leave. */
    this.persistedLoaded = /* @__PURE__ */ new Set();
    /** Loader-resumed user sessions by id until the boot scan exits. Released there if the scanner never classified them. */
    this.persistedHandles = /* @__PURE__ */ new Map();
    /** Children kept for a later attempt, by id: refused at the active-child limit, or waiting for their parent to go live. */
    this.waitingChildren = /* @__PURE__ */ new Map();
    /** One pending attempt per child, scheduled from an event the plugin observed. */
    this.waitAttempts = /* @__PURE__ */ new Map();
    /** Slot releases the plugin observed: agent disposals, and settled deliveries that were not admission refusals. */
    this.slotReleases = 0;
    /** Deliveries in flight. The wait ends only when no child waits and none is in flight. */
    this.slotDeliveries = 0;
    this.disposeSessionEvents = ctx.on("session/event", (session, event) => {
      try {
        this.onHostEvent(session, event);
      } catch (error) {
        console.error(
          `[auto-continue] 会话事件处理异常 ${session.id}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
    this.disposeInboxEvents = ctx.on("agent/inbox/inserted", ({ agent, message }) => {
      if (!this.prioritizedFollowups.delete(message.id)) return;
      let removed = false;
      try {
        const index = agent.inbox.nextTurn.findIndex((pending) => pending.id === message.id);
        if (index <= 0) return;
        removed = agent.inbox.remove(message.id);
        if (!removed) return;
        agent.inbox.prepend("next-turn", message);
      } catch (error) {
        if (removed) {
          try {
            agent.inbox.append("next-turn", message);
          } catch (rollbackError) {
            console.error(
              `[auto-continue] 恢复续跑消息失败 ${agent.id}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
            );
          }
        }
        console.error(
          `[auto-continue] 调整续跑消息顺序失败 ${agent.id}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
    const config = this.getConfig();
    if (config.liveStreamGuard) {
      this.disposeAssistantStream = ctx.on("agent/assistant-stream", (payload) => {
        try {
          this.onLiveStreamFrame(payload?.agent?.session?.id, payload?.frame);
        } catch (error) {
          console.error(
            `[auto-continue] 实时流帧处理异常: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      });
    }
    if (config.scanOnBoot) {
      void this.bootScanLoop().finally(() => this.releaseUnscannedPersisted());
    }
    this.log(
      `已启动(host 单实例, 文本="${config.continueText}", 宽限 ${config.graceMs}ms, 冷却 ${config.cooldownMs}ms, 最多连续 ${config.maxConsecutive} 次)`
    );
  }
  log(message) {
    if (this.getConfig().verbose) console.info(`[auto-continue] ${message}`);
  }
  /** 对外(状态桥): 今日统计快照。 */
  todayStats() {
    const today = todayKey();
    if (this.dayStats.date !== today) this.dayStats = emptyDayStats();
    return { ...this.dayStats, byCode: { ...this.dayStats.byCode } };
  }
  /** 对外(状态桥): 当前生效的会话级暂停列表。 */
  activePauses() {
    const now = Date.now();
    const out = [];
    for (const [sessionId, until] of this.pauseUntil) {
      if (until > now) out.push({ sessionId, until });
    }
    return out;
  }
  /** 对外(状态桥): 订阅通知事件(SSE 端点推送)。 */
  subscribeNotices(listener) {
    this.noticeListeners.add(listener);
    return () => {
      this.noticeListeners.delete(listener);
    };
  }
  /** 对外(状态桥): 订阅运行时状态变化(统计/暂停列表)。 */
  subscribeState(listener) {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }
  emitState() {
    for (const listener of this.stateListeners) listener();
  }
  /** 对外(状态桥): 消费待展示的通知。 */
  drainNotices() {
    return this.notices.splice(0, this.notices.length);
  }
  /** 通知动作(browser 通知按钮回传): 立即续跑 / 暂停该会话 / 解除暂停 / 清零统计。 */
  handleNoticeAction(sessionId, action) {
    if (action === "unpause") {
      if (sessionId !== void 0) this.pauseUntil.delete(sessionId);
      this.log(`解除暂停 ${sessionId ?? "?"}`);
    } else if (action === "reset-stats") {
      this.dayStats = emptyDayStats();
      this.log("清零今日统计");
    } else if (sessionId !== void 0) {
      this.onNotifyAction(sessionId, action);
    }
    this.emitState();
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.bootScanTimer !== void 0) clearTimeout(this.bootScanTimer);
    this.bootScanTimer = void 0;
    this.wakeBootScan?.();
    this.wakeBootScan = void 0;
    for (const [id, waiting] of this.waitingChildren) {
      const cause = waiting.reason === "parent" ? "its parent became live" : "an activation slot freed";
      console.error(`[auto-continue] dropped ${id}: the runner was disposed before ${cause}`);
    }
    this.waitingChildren.clear();
    this.stopSlotWait();
    this.disposeSessionEvents();
    this.disposeInboxEvents();
    this.disposeAssistantStream?.();
    this.prioritizedFollowups.clear();
    for (const state of this.states.values()) {
      if (state.pendingTimer !== void 0) clearTimeout(state.pendingTimer);
      if (state.loopRetryTimer !== void 0) clearTimeout(state.loopRetryTimer);
      if (state.cooldownRetryTimer !== void 0) clearTimeout(state.cooldownRetryTimer);
    }
    this.states.clear();
  }
  state(sessionId) {
    let state = this.states.get(sessionId);
    if (state === void 0) {
      state = freshState();
      this.states.set(sessionId, state);
    }
    return state;
  }
  /** Mark a child session and clear queued grace/cooldown sends. */
  markSubagent(sessionId, state) {
    state.subagent = true;
    this.cancelPending(sessionId, "子代理会话");
  }
  /** Read durable origin from the live agent for direct action paths as well. */
  isSubagent(sessionId, state) {
    if (state.subagent) return true;
    const agent = this.ctx.agents.get(sessionId);
    if (agent?.session?.header?.origin !== "subagent") return false;
    this.markSubagent(sessionId, state);
    return true;
  }
  /**
   * 事件入口(host 单实例): 预处理工具调用/结果/模型消息(护栏与循环信号),
   * 然后交给回合状态机。
   */
  onHostEvent(session, event) {
    const sessionId = session.id;
    const sessionState = this.states.get(sessionId);
    if (session.header?.origin === "subagent") {
      this.markSubagent(sessionId, sessionState ?? this.state(sessionId));
      return;
    }
    if (sessionState?.subagent) return;
    if ((event.type === "user/message" || event.type === "assistant/message") && typeof event.surfaceOp === "object" && event.surfaceOp !== null) {
      this.state(sessionId).tools.recordSurfaceReplacement(event.seq);
      return;
    }
    if (event.type === "tool/call") {
      const state = this.state(sessionId);
      if (state.tools.recordCall(event)) {
        state.shortRun = 0;
        if (this.tracksOutput(state, event)) state.turnOutput = "visible";
      }
    } else if (event.type === "tool/result") {
      const state = this.state(sessionId);
      state.tools.recordResult(event);
    } else if (event.type === "step/start") {
      const state = this.state(sessionId);
      if (this.tracksOutput(state, event) && state.turnOutput === "empty") state.turnOutput = "silent";
      state.stepOutput = "none";
      state.reasonDensity.reset();
      const repeat = state.tools.confirmRepeatAtStep(event.seq);
      if (repeat !== void 0) this.checkLoop(sessionId, state, repeat);
    } else if (event.type === "assistant/chunk") {
      const state = this.state(sessionId);
      if (this.tracksOutput(state, event)) {
        const chunk = event.data.chunk;
        const visible = this.chunkIsVisible(chunk);
        if (visible) state.turnOutput = "visible";
        else if (state.turnOutput === "empty" && chunk.type !== "usage" && chunk.type !== "finish") state.turnOutput = "silent";
        if (visible) state.stepOutput = "visible";
        else if (chunk.type === "reasoning-delta" && state.stepOutput === "none") state.stepOutput = "reasoning";
      }
      this.onAssistantChunk(sessionId, state, event.data.chunk);
    } else if (event.type === "assistant/message") {
      const state = this.state(sessionId);
      if (this.tracksOutput(state, event)) {
        if (this.hasVisibleContent(event.data.message.content)) state.turnOutput = "visible";
        else if (state.turnOutput === "empty") state.turnOutput = "silent";
        state.stepOutput = this.messageOutput(event.data.message.content);
        state.reasoningOnlyUnits = state.stepOutput === "reasoning" ? reasoningUnits(event.data.message.content) : 0;
      }
      this.onAssistantMessage(sessionId, state, event);
    }
    this.onSessionEvent(sessionId, event);
  }
  tracksOutput(state, event) {
    return state.running === true && state.outputTurn === event.data.turn && event.seq > state.outputStartSeq;
  }
  /** Treat unknown block kinds conservatively: only reasoning and blank text are silent. */
  hasVisibleContent(content) {
    if (!Array.isArray(content)) return false;
    return content.some((part) => {
      if (part === null || typeof part !== "object") return true;
      const block = part;
      if (block.type === "reasoning") return false;
      if (block.type === "text") return typeof block.text !== "string" || block.text.trim() !== "";
      return true;
    });
  }
  /** vrpe F-A2: output of one committed assistant message: visible (text or tool call), reasoning only, or none. */
  messageOutput(content) {
    if (this.hasVisibleContent(content)) return "visible";
    const parts = Array.isArray(content) ? content : [];
    return parts.some((part) => part?.type === "reasoning") ? "reasoning" : "none";
  }
  /** 从 assistant/message 事件提取纯文本。 */
  assistantText(event) {
    const content = event.data.message.content;
    if (!Array.isArray(content)) return "";
    return content.filter((part) => part.type === "text").map((part) => part.text).join("");
  }
  assistantChunkText(chunk) {
    return chunk.type === "text-delta" ? chunk.text : "";
  }
  /** A chunk the user can see: visible text, a tool call, or a non-reasoning block. */
  chunkIsVisible(chunk) {
    return chunk.type === "text-delta" && chunk.text.trim() !== "" || chunk.type === "tool-call-delta" || chunk.type === "block-end" && this.hasVisibleContent([chunk.block]) || chunk.type === "block-start" && chunk.blockType !== "reasoning" && chunk.blockType !== "text";
  }
  normalizedSegment(text) {
    return text.replace(/\s+/g, " ").trim();
  }
  isNearDuplicateSegment(left, right) {
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
  withinEditDistance(left, right, maxDistance) {
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
        const substitution = (previous[col - 1] ?? unreachable) + (left.charCodeAt(row - 1) === right.charCodeAt(col - 1) ? 0 : 1);
        const score = Math.min(insertion, deletion, substitution, unreachable);
        current[col] = score;
        if (score < minInRow) minInRow = score;
      }
      if (minInRow > maxDistance) return false;
      [previous, current] = [current, previous];
    }
    return (previous[rightLen] ?? unreachable) <= maxDistance;
  }
  noteStreamSegment(sessionId, state, segment) {
    const normalized = this.normalizedSegment(segment);
    const config = this.getConfig();
    if (normalized === "") return;
    if (normalized.length < config.loopShortChars) {
      state.streamLastSegment = "";
      state.streamRepeatRun = 0;
      return;
    }
    if (state.streamLastSegment !== "" && this.isNearDuplicateSegment(normalized, state.streamLastSegment)) {
      state.streamRepeatRun += 1;
      state.streamLastSegment = normalized;
    } else {
      state.streamLastSegment = normalized;
      state.streamRepeatRun = 1;
    }
    if (state.streamRepeatRun >= config.loopRepeatText) {
      this.log(
        `检测到流式消息内复读 ${sessionId}: 连续 ${state.streamRepeatRun} 段近似重复文本`
      );
      this.interruptLoop(sessionId, state);
    }
  }
  /**
   * Reasoning spiral in this step (vrpe). The trip and the cooldown refusal are each logged once
   * per step. While the cooldown lasts, later deltas stay silent; the first delta after it cuts.
   */
  onReasoningSpiral(sessionId, state) {
    state.spiralTripped = true;
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
   * id is ignored. `start` resets the density count (a retried attempt starts a new count); chunks do not.
   */
  onLiveStreamFrame(sessionId, frame) {
    if (typeof sessionId !== "string" || frame === void 0) return;
    const state = this.state(sessionId);
    if (this.isSubagent(sessionId, state)) return;
    if (frame.type === "start") {
      state.stepOutput = "none";
      state.reasonDensity.reset();
    } else if (frame.type === "chunk") {
      const chunk = frame.chunk;
      if (this.chunkIsVisible(chunk)) state.stepOutput = "visible";
      else if (chunk.type === "reasoning-delta" && state.stepOutput === "none") state.stepOutput = "reasoning";
      this.onAssistantChunk(sessionId, state, chunk);
    }
  }
  onAssistantChunk(sessionId, state, modelChunk) {
    if (!this.getConfig().loopGuard || !state.running || state.loopFired) return;
    if (modelChunk.type === "reasoning-delta" && state.stepOutput !== "visible" && state.reasonDensity.feed(modelChunk.text)) {
      this.onReasoningSpiral(sessionId, state);
      return;
    }
    const chunk = this.assistantChunkText(modelChunk);
    if (chunk === "") return;
    const merged = `${state.streamTail}${chunk}`.replace(/\r/g, "");
    const pieces = merged.split(/\n(?:[ \t]*\n)+/u);
    const tail = pieces.pop() ?? "";
    for (const piece of pieces) this.noteStreamSegment(sessionId, state, piece);
    if (tail.length <= STREAM_TAIL_MAX_CHARS) {
      state.streamTail = tail;
      return;
    }
    state.streamTail = tail.slice(-STREAM_TAIL_MAX_CHARS);
    if (/\S/u.test(tail)) {
      state.streamLastSegment = "";
      state.streamRepeatRun = 0;
    }
  }
  onAssistantMessage(sessionId, state, event) {
    if (!this.getConfig().loopGuard) return;
    const text = this.assistantText(event);
    const trimmed = text.trim();
    if (trimmed !== "" && trimmed === state.lastAssistantText) {
      state.sameTextRun += 1;
    } else {
      state.lastAssistantText = trimmed;
      state.sameTextRun = 1;
    }
    if (trimmed.length < this.getConfig().loopShortChars) {
      const now = Date.now();
      if (now - state.lastShortAt > this.getConfig().loopWindowMs) {
        state.shortRun = 0;
      }
      state.shortRun += 1;
      state.lastShortAt = now;
    } else {
      state.shortRun = 0;
      state.lastShortAt = 0;
    }
    const streamTail = state.streamTail;
    state.streamTail = "";
    if (streamTail !== "") this.noteStreamSegment(sessionId, state, streamTail);
    state.streamLastSegment = "";
    state.streamRepeatRun = 0;
    this.checkLoop(sessionId, state);
  }
  /** 两个循环信号的公共检查; 命中且本回合未打断过则打断。 */
  checkLoop(sessionId, state, toolRepeat) {
    if (!this.getConfig().loopGuard) return;
    if (state.loopFired) return;
    if (!state.running) return;
    const config = this.getConfig();
    if (state.sameTextRun >= config.loopRepeatText) {
      this.log(`检测到空转循环 ${sessionId}: 连续 ${state.sameTextRun} 条相同消息`);
      this.interruptLoop(sessionId, state);
    } else if (state.shortRun >= config.loopShortCount) {
      this.log(`检测到空转循环 ${sessionId}: 连续 ${state.shortRun} 条短句且无工具调用`);
      this.interruptLoop(sessionId, state);
    } else if (toolRepeat !== void 0 && toolRepeat.count >= config.loopToolRepeat) {
      this.log(`检测到工具死循环 ${sessionId}: 「${toolRepeat.tool}」连续 ${toolRepeat.count} 次(同参数同结果)`);
      this.interruptLoop(sessionId, state);
    }
  }
  /**
   * 打断运行中的回合: cancel(带来源标记)+ 进冷却。
   * 只有随后持久化的 turn/end 精确携带专属 hook cause 时,
   * 才会用 loopText 重启回合——DSH 的 first-cause 语义保证用户 Stop 优先。
   */
  interruptLoop(sessionId, state) {
    if (this.isSubagent(sessionId, state)) return;
    if (state.loopFired) return;
    if (Date.now() - state.lastAttemptAt < this.cooldownFor(state)) {
      this.log(`跳过循环打断 ${sessionId}: 处于冷却期`);
      return;
    }
    state.loopFired = true;
    state.lastAttemptAt = Date.now();
    try {
      const agent = this.ctx.agents.get(sessionId);
      if (agent === void 0) {
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
  onSessionEvent(sessionId, event) {
    const state = this.state(sessionId);
    switch (event.type) {
      case "turn/start":
        state.running = true;
        state.tools.startTurn(event.seq);
        state.shortRun = 0;
        state.lastShortAt = 0;
        state.lastAssistantText = "";
        state.sameTextRun = 0;
        state.streamTail = "";
        state.streamLastSegment = "";
        state.streamRepeatRun = 0;
        state.loopFired = false;
        state.spiralTripped = false;
        state.turnOutput = "empty";
        state.stepOutput = "none";
        state.reasonDensity.reset();
        state.reasoningOnlyUnits = 0;
        state.outputTurn = event.data.turn;
        state.outputStartSeq = event.seq;
        if (state.loopRetryTimer !== void 0) {
          clearTimeout(state.loopRetryTimer);
          state.loopRetryTimer = void 0;
        }
        this.cancelPending(sessionId, "宿主自行开启新回合");
        break;
      case "turn/end": {
        state.running = false;
        const loopCancelPending = state.loopFired;
        state.loopFired = false;
        const spiralTripped = state.spiralTripped;
        state.spiralTripped = false;
        this.cancelPending(sessionId, "收到新的 turn/end");
        const turnOutput = state.outputTurn === event.data.turn ? state.turnOutput : "unknown";
        state.turnOutput = "unknown";
        state.outputTurn = void 0;
        const lastStepOutput = state.stepOutput;
        const lastReasoningUnits = state.reasoningOnlyUnits;
        state.stepOutput = "none";
        state.reasoningOnlyUnits = 0;
        const reason = event.data.reason;
        const reasonKind = readReasonKind(reason);
        if (reasonKind === void 0) {
          console.error(`[auto-continue] 忽略畸形 turn/end ${sessionId}: reason 无法解释`);
          break;
        }
        if (reasonKind === "no-visible-output" || reasonKind === "completed" && turnOutput === "silent") {
          state.lastFailure = void 0;
          state.lastTurn = event.data.turn;
          state.lastFailureAt = Date.now();
          this.noteRecovery(sessionId, "error");
          const config = this.getConfig();
          if ((config.resumeSilentTurns || config.resumeCompletedTurns) && spiralTripped) {
            this.escalateSpiral(sessionId, `turn/end:${reasonKind}`, config);
          } else if (config.resumeCompletedTurns || config.resumeSilentTurns) {
            if (reasonKind === "completed" && lastReasoningUnits >= SILENT_REASONING_SKIP_UNITS) {
              this.log(`长推理回合 ${sessionId}: 无推理复读信号, 按普通回合续跑 (${lastReasoningUnits} 字)`);
            }
            if (config.resumeCompletedTurns) this.schedule(sessionId, LOOP_SILENT_REASON);
            else this.schedule(sessionId, `turn/end:${reasonKind}:silent`);
          }
          break;
        }
        if (reasonKind === "completed") {
          if (turnOutput === "visible") state.spiralEscalated = false;
          if (this.getConfig().resumeCompletedTurns) {
            if (turnOutput === "visible") {
              state.consecutive = 0;
              state.lastFailure = void 0;
              this.noteRecovery(sessionId, "completed");
            }
            this.schedule(sessionId, LOOP_COMPLETED_REASON, true);
          } else if (turnOutput === "visible") {
            state.consecutive = 0;
            state.lastFailure = void 0;
            this.noteRecovery(sessionId, "completed");
          }
        } else if (reasonKind === "aborted") {
          if (isLoopGuardCancelReason(reason.reason)) {
            if (loopCancelPending) this.bumpStat({ looped: 1 });
            state.pendingRecoveryAt = 0;
            state.shortRun = 0;
            state.lastShortAt = 0;
            state.lastAssistantText = "";
            state.sameTextRun = 0;
            state.streamTail = "";
            state.streamLastSegment = "";
            state.streamRepeatRun = 0;
            state.tools.resetRepeat();
            const cooldown = this.cooldownFor(state);
            const remaining = cooldown - (Date.now() - state.lastAttemptAt);
            if (remaining > 0) {
              if (state.loopRetryTimer !== void 0) clearTimeout(state.loopRetryTimer);
              state.loopRetryTimer = setTimeout(() => {
                state.loopRetryTimer = void 0;
                try {
                  this.schedule(sessionId, "loop:aborted");
                } catch (error) {
                  console.error(`[auto-continue] loop 重启异常 ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
                }
              }, remaining + 10);
              this.log(`loop 重启延迟 ${remaining}ms(冷却期) ${sessionId}`);
            } else {
              this.schedule(sessionId, "loop:aborted");
            }
          } else {
            state.consecutive = 0;
            state.pendingRecoveryAt = 0;
          }
        } else if (reasonKind === "blocked") {
        } else if (reasonKind === "interrupted") {
          state.consecutive = 0;
          state.pendingRecoveryAt = 0;
        } else if (reasonKind === "error") {
          const failure = parseFailureFacts(reason.error);
          if (failure === void 0) {
            console.error(`[auto-continue] 忽略畸形 turn/end ${sessionId}: error details 无法解释`);
            break;
          }
          state.lastFailure = failure;
          state.lastTurn = event.data.turn;
          state.lastFailureAt = Date.now();
          this.noteRecovery(sessionId, "error");
          this.onTurnFailure(sessionId, "turn/end:error", state.lastFailure);
        } else if (reasonKind === "max-tokens") {
          state.lastFailureAt = Date.now();
          this.noteRecovery(sessionId, "error");
          const config = this.getConfig();
          if (spiralTripped && lastStepOutput !== "visible") {
            this.escalateSpiral(sessionId, "turn/end:max-tokens", config);
          } else {
            this.schedule(sessionId, "turn/end:max-tokens");
          }
        }
        break;
      }
      case "user/message":
        if (isOurEcho(state, event)) break;
        if (event.data.source.kind === "user") {
          state.consecutive = 0;
          state.spiralEscalated = false;
          this.cancelPending(sessionId, "用户手动发送消息");
        }
        break;
      default:
        break;
    }
  }
  // ---------- host 帧 ----------
  onTurnFailure(sessionId, reason, failure) {
    const config = this.getConfig();
    if (config.classify && !isTransientFailure(failure, config.retryableErrorPatterns)) {
      const copy = NOTICE_COPY[config.locale];
      const summary = `${failure.code}${failure.status !== void 0 ? ` (HTTP ${failure.status})` : ""}`;
      this.log(`跳过 ${sessionId}(${reason}): 永久性失败 ${summary} — ${failure.message}`);
      this.bumpStat({ skipped: 1, code: failure.code });
      if (config.notify) {
        this.notify(
          sessionId,
          copy.notContinuedTitle,
          copy.permanentErrorBody(sessionId, summary),
          this.notifyOptions(sessionId, config.locale)
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
  escalateSpiral(sessionId, site, config) {
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
  persistedSpiralEscalated(events, end, config) {
    if (end === void 0) return false;
    const expected = config.loopText.trim();
    if (expected === "") return false;
    const GUARD_TAIL_MIN = 8;
    const guardShapes = config.guardTools === false ? [] : [config.guardPendingText, config.guardDoneText].map((template) => template.split(/\{[^}]*\}/g)).filter((segments) => {
      const literals = segments.filter((segment) => segment.trim() !== "");
      const tail = segments[segments.length - 1] ?? "";
      return literals.length > 0 && tail.trim().length >= GUARD_TAIL_MIN;
    });
    const sentShape = (text) => {
      if (config.guardTools === false) return text.trim() === expected;
      if (!text.includes(expected)) return false;
      return guardShapes.some((segments) => {
        let at = 0;
        for (const segment of segments) {
          if (segment.trim() === "") continue;
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
      if (event === void 0) continue;
      if (event.type === "assistant/message") {
        if (this.hasVisibleContent(event.data.message.content)) visibleAfter = true;
        continue;
      }
      if (event.type !== "user/message") continue;
      if (event.data.source.kind !== "user") continue;
      if (visibleAfter) return false;
      const content = event.data.content;
      if (!Array.isArray(content)) return false;
      return content.some(
        (part) => part?.type === "text" && typeof part.text === "string" && sentShape(part.text)
      );
    }
    return false;
  }
  /** Round 4: the stop notice every spiral site shares. Silent unless config.notify is on, like the other notices. */
  notifySpiralStopped(sessionId, config, child = false) {
    if (!config.notify) return;
    const copy = NOTICE_COPY[config.locale];
    const body = child ? copy.spiralChildStoppedBody(sessionId) : copy.spiralStoppedBody(sessionId);
    this.notify(sessionId, copy.stoppedTitle, body, this.notifyOptions(sessionId, config.locale));
  }
  /** 通知操作按钮与回调(「立即续跑」/「暂停该会话 1 小时」)。 */
  notifyOptions(sessionId, locale) {
    const copy = NOTICE_COPY[locale];
    return {
      actions: [
        { action: "resume", title: copy.resumeAction },
        { action: "pause1h", title: copy.pauseAction }
      ],
      onAction: (action) => this.onNotifyAction(sessionId, action)
    };
  }
  onNotifyAction(sessionId, action) {
    if (action === "resume") {
      this.log(`通知按钮: 立即续跑 ${sessionId}`);
      void this.resumeNow(sessionId);
    } else if (action === "pause1h") {
      this.log(`通知按钮: 暂停 ${sessionId} 1 小时`);
      this.pauseUntil.set(sessionId, Date.now() + 60 * 60 * 1e3);
      this.cancelPending(sessionId, "通知按钮暂停该会话");
    }
  }
  /** 内存统计(host 单实例): 按今日桶累计。 */
  bumpStat(delta) {
    const today = todayKey();
    if (this.dayStats.date !== today) this.dayStats = emptyDayStats();
    if (delta.sent !== void 0) this.dayStats.sent += delta.sent;
    if (delta.skipped !== void 0) this.dayStats.skipped += delta.skipped;
    if (delta.recovered !== void 0) this.dayStats.recovered += delta.recovered;
    if (delta.failed !== void 0) this.dayStats.failed += delta.failed;
    if (delta.gaveUp !== void 0) this.dayStats.gaveUp += delta.gaveUp;
    if (delta.looped !== void 0) this.dayStats.looped += delta.looped;
    if (delta.code !== void 0) {
      this.dayStats.byCode[delta.code] = (this.dayStats.byCode[delta.code] ?? 0) + 1;
    }
    this.emitState();
  }
  /** 通知桥: 产生一条通知事件, SSE 端点推给 browser 侧展示。 */
  notify(sessionId, title, body, options) {
    const notice = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      title,
      body,
      sessionId,
      ...options?.actions !== void 0 && options.actions.length > 0 ? { actions: options.actions } : { actions: [] },
      at: Date.now()
    };
    this.notices.push(notice);
    for (const listener of this.noticeListeners) listener();
    this.emitState();
  }
  /** 恢复结果记账: 自动发送后窗口内的回合结束, 判定恢复成功或失败。 */
  noteRecovery(sessionId, outcome) {
    const state = this.state(sessionId);
    if (state.pendingRecoveryAt === 0) return;
    if (Date.now() - state.pendingRecoveryAt > RECOVERY_WINDOW_MS) {
      state.pendingRecoveryAt = 0;
      return;
    }
    state.pendingRecoveryAt = 0;
    this.bumpStat(outcome === "completed" ? { recovered: 1 } : { failed: 1 });
    this.log(`恢复结果(${sessionId}): ${outcome === "completed" ? "成功" : "失败"}`);
  }
  /** 立即为该会话发送一次自动继续(无视冷却与连续上限; 由通知按钮触发)。 */
  async resumeNow(sessionId) {
    if (this.disposed) return;
    const state = this.state(sessionId);
    if (this.isSubagent(sessionId, state)) return;
    if (state.pendingTimer !== void 0) {
      clearTimeout(state.pendingTimer);
      state.pendingTimer = void 0;
    }
    try {
      await this.fire(sessionId, MANUAL_NOTIFICATION_REASON, true);
    } catch (error) {
      console.error(`[auto-continue] 手动续跑异常 ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  /** 本会话当前生效的冷却间隔(自适应退避)。 */
  cooldownFor(state) {
    const config = this.getConfig();
    return effectiveCooldown(
      state.consecutive,
      config.cooldownMs,
      config.backoffFactor,
      config.backoffMaxMs
    );
  }
  /** Round 5 (reviewer F1): true when the attempt is queued and will be sent, false when it was refused or merged. */
  schedule(sessionId, reason, force = false) {
    return this.scheduleAttempt(sessionId, reason, force);
  }
  scheduleAttempt(sessionId, reason, force = false) {
    const state = this.state(sessionId);
    const config = this.getConfig();
    if (this.isSubagent(sessionId, state)) return false;
    if (config.paused) {
      this.log(`跳过 ${sessionId}(${reason}): 全局暂停中`);
      return false;
    }
    if (Date.now() < (this.pauseUntil.get(sessionId) ?? 0)) {
      this.log(`跳过 ${sessionId}(${reason}): 会话暂停中`);
      return false;
    }
    if (state.pendingTimer !== void 0) return false;
    if (!force && state.consecutive >= config.maxConsecutive) {
      this.log(
        `跳过 ${sessionId}(${reason}): 已连续自动继续 ${state.consecutive} 次, 等待用户介入或成功回合`
      );
      return false;
    }
    if (!force) {
      const remaining = this.cooldownFor(state) - (Date.now() - state.lastAttemptAt);
      if (remaining > 0) {
        this.deferCooldownRetry(sessionId, reason, remaining);
        return false;
      }
    }
    const timer = setTimeout(() => {
      if (state.pendingTimer !== timer) return;
      state.pendingTimer = void 0;
      try {
        void this.fire(sessionId, reason, force);
      } catch (error) {
        console.error(`[auto-continue] 定时发送异常 ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, config.graceMs);
    state.pendingTimer = timer;
    const template = this.templateFor(config, reason);
    this.log(
      `检测到非人为中断 ${sessionId}(${reason}), ${config.graceMs}ms 后自动发送「${template}」`
    );
    return true;
  }
  /**
   * 冷却期内的恢复: 等到冷却结束再重新调度。
   * 直接丢弃会让一次瞬时失败把会话搁置, 直到用户手动发消息才恢复。
   */
  deferCooldownRetry(sessionId, reason, remaining) {
    const state = this.state(sessionId);
    if (state.cooldownRetryTimer !== void 0) clearTimeout(state.cooldownRetryTimer);
    state.cooldownRetryTimer = setTimeout(() => {
      state.cooldownRetryTimer = void 0;
      try {
        this.schedule(sessionId, reason);
      } catch (error) {
        console.error(`[auto-continue] 冷却后重试异常 ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, remaining + 10);
    this.log(`冷却中 ${sessionId}(${reason}), ${remaining}ms 后重试`);
  }
  /** 按调度原因选择续跑模板: loop 重启、无输出回合、max-tokens、自主循环, 其余用通用继续文本。 */
  templateFor(config, reason) {
    if (reason.startsWith("loop:")) return config.loopText;
    if (isLoopReason(reason)) return config.continueTextLoop;
    if (reason.endsWith(":silent")) return config.continueTextSilent;
    if (reason.includes("max-tokens")) return config.continueTextMaxTokens;
    return config.continueText;
  }
  cancelPending(sessionId, why) {
    const state = this.state(sessionId);
    let cancelled = false;
    if (state.pendingTimer !== void 0) {
      clearTimeout(state.pendingTimer);
      state.pendingTimer = void 0;
      cancelled = true;
    }
    if (state.cooldownRetryTimer !== void 0) {
      clearTimeout(state.cooldownRetryTimer);
      state.cooldownRetryTimer = void 0;
      cancelled = true;
    }
    if (cancelled) this.log(`取消 ${sessionId} 的自动继续(${why})`);
  }
  fire(sessionId, reason, force = false) {
    if (this.disposed) return;
    const state = this.state(sessionId);
    const config = this.getConfig();
    const manualResume = force && reason === MANUAL_NOTIFICATION_REASON;
    if (reason.endsWith(":silent") && !config.resumeSilentTurns) return;
    if (isLoopReason(reason) && !config.resumeCompletedTurns) return;
    if (this.isSubagent(sessionId, state)) return;
    if (config.paused && !manualResume) {
      this.log(`跳过 ${sessionId}(${reason}): 全局暂停中`);
      return;
    }
    if (!manualResume && Date.now() < (this.pauseUntil.get(sessionId) ?? 0)) {
      this.log(`跳过 ${sessionId}(${reason}): 会话暂停中`);
      return;
    }
    if (!force && Date.now() - state.lastAttemptAt < this.cooldownFor(state)) {
      this.log(`跳过 ${sessionId}(${reason}): 处于冷却期`);
      return;
    }
    if (!force && state.consecutive >= config.maxConsecutive) {
      this.log(`跳过 ${sessionId}(${reason}): 已连续自动继续 ${state.consecutive} 次, 等待用户介入或成功回合`);
      return;
    }
    const template = this.templateFor(config, reason);
    const text = this.buildContinueText(config, state, template);
    const agent = this.ctx.agents.get(sessionId);
    if (agent === void 0) {
      this.log(`跳过 ${sessionId}(${reason}): 无 live agent`);
      return;
    }
    state.lastAttemptAt = Date.now();
    try {
      const message = createUserMessage({
        content: [{ type: "text", text }],
        source: { kind: "user" }
      });
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
      if (reason === LOOP_SPIRAL_REASON) state.spiralEscalated = true;
      if (reason !== LOOP_COMPLETED_REASON) state.consecutive += 1;
      state.pendingRecoveryAt = now;
      this.bumpStat({ sent: 1, ...state.lastFailure !== void 0 ? { code: state.lastFailure.code } : {} });
      this.log(`已自动发送「${text}」到 ${sessionId}(${reason}), 第 ${state.consecutive} 次连续`);
      if (config.notify) {
        const copy = NOTICE_COPY[config.locale];
        this.notify(
          sessionId,
          copy.continuedTitle,
          copy.continuedBody(sessionId, text, state.consecutive),
          this.notifyOptions(sessionId, config.locale)
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
            this.notifyOptions(sessionId, config.locale)
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
  buildContinueText(config, state, template) {
    let text = fillTemplate(template, {
      facts: state.lastFailure,
      tool: state.tools.lastTool(),
      turn: state.lastTurn,
      errorCount: state.consecutive + 1,
      elapsedMs: state.lastFailureAt > 0 ? Date.now() - state.lastFailureAt : void 0
    });
    if (!config.guardTools) return text;
    const guard = this.currentGuard(state);
    if (guard.kind === "pending") {
      text += ` ${fillTemplate(config.guardPendingText, { tool: guard.tool, result: guard.result })}`;
    } else if (guard.kind === "done") {
      text += ` ${fillTemplate(config.guardDoneText, { tool: guard.tool, result: guard.result })}`;
    }
    return text;
  }
  /** 上一步工具调用的护栏状态(实时路径, 由 mux 帧维护)。 */
  currentGuard(state) {
    return state.tools.guard();
  }
  async bootScanLoop() {
    const deadline = Date.now() + this.getConfig().freshMs;
    this.bootDeadline = deadline;
    for (let attempt = 0; !this.disposed; attempt += 1) {
      if (attempt > 0 && Date.now() >= deadline) return;
      try {
        if (await this.scanInterrupted()) return;
      } catch (error) {
        if (this.disposed) return;
        if (attempt % 10 === 0) {
          this.log(
            `扫描失败(${attempt + 1}): ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      const remaining = deadline - Date.now();
      if (this.disposed || remaining <= 0) return;
      await new Promise((resolve) => {
        this.wakeBootScan = resolve;
        this.bootScanTimer = setTimeout(() => {
          this.bootScanTimer = void 0;
          this.wakeBootScan = void 0;
          resolve();
        }, Math.min(3e3, remaining));
      });
    }
  }
  /** Host calls and resumes may start only while the runner is live and the boot window is open. */
  persistedOpen() {
    return !this.disposed && Date.now() < this.bootDeadline;
  }
  /**
   * Start one background loader pass unless one is already in flight. The live scan never awaits it, so a stalled
   * host call delays only persisted loads; resumed sessions are scanned on later passes. Eligibility mirrors the
   * scanner (persistedLastActivity). Never throws: a missing service or failing call is logged and retried later.
   * A turn persisted as aborted/disposed on graceful shutdown is continued; a manual stop (aborted/user) is not.
   * A subagent child is included only when its own continuable descriptor lets the host continue it (persistedChildDescriptor).
   */
  loadInterruptedPersisted(config) {
    if (this.persistedRun !== void 0 || typeof this.ctx.get !== "function") return;
    this.persistedRun = this.runPersisted(config).catch(reportLoaderError).finally(() => {
      this.persistedRun = void 0;
    });
  }
  /** One background pass: enumerate once after the services exist, then resume queued sessions within scanLimit. */
  async runPersisted(config) {
    if (!this.persistedEnumerated) {
      const persistence = this.ctx.get("sessionPersistence");
      const registry = this.ctx.get("workspaceRegistry");
      if (persistence === void 0 || registry === void 0) {
        this.log("持久化会话服务未就绪, 稍后重试");
        return;
      }
      await this.enumeratePersisted(persistence, registry, config);
      if (!this.persistedEnumerated) return;
    }
    await this.resumeQueuedPersisted(config);
  }
  /**
   * Enumerate once. A rejected or stalled list() leaves enumeration for a later pass. A stalled call stays in
   * flight and is awaited again rather than repeated, so at most one list() is in flight.
   */
  async enumeratePersisted(persistence, registry, config) {
    const listing = this.persistedListing ?? (this.persistedListing = persistence.list());
    let snapshots;
    try {
      snapshots = await withPersistedTimeout(listing);
    } catch (error) {
      if (!(error instanceof PersistedCallTimeout)) this.persistedListing = void 0;
      this.log(`列出持久化会话失败, 稍后重试: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.persistedListing = void 0;
    const archived = new Set(registry.archivedSessionIds);
    const now = Date.now();
    const queue = [];
    for (const { header } of snapshots) {
      if (!this.persistedOpen()) return;
      if (archived.has(header.id) || this.ctx.agents.get(header.id) !== void 0) continue;
      if (header.cwd === void 0) continue;
      const entry = await this.readPersistedEntry(persistence, header, now, config);
      if (entry !== void 0) queue.push(entry);
    }
    queue.sort((left, right) => left.depth - right.depth || right.lastActivityAt - left.lastActivityAt);
    this.persistedQueue = queue;
    this.persistedEnumerated = true;
  }
  /** Resume at most `scanLimit` queued sessions in this pass, one awaited load at a time. */
  async resumeQueuedPersisted(config) {
    let loads = 0;
    while (this.persistedQueue.length > 0 && loads < config.scanLimit && !this.disposed) {
      const entry = this.persistedQueue.shift();
      if (entry === void 0 || this.persistedDecided.has(entry.id)) continue;
      this.persistedDecided.add(entry.id);
      if (this.ctx.agents.get(entry.id) !== void 0) continue;
      loads += 1;
      await this.resumePersisted(entry);
    }
  }
  /** Read one persisted session's history (read-only open). Stalled or unreadable histories are skipped. */
  async readPersistedEntry(persistence, header, now, config) {
    try {
      const opening = persistence.open(header.id, "read");
      const handle = await withPersistedTimeout(opening).catch((error) => {
        void opening.then((late) => late.close()).catch(() => void 0);
        throw error;
      });
      try {
        if (!this.persistedOpen()) return void 0;
        const { events } = await withPersistedTimeout(handle.read(0));
        let childDescriptor;
        let ownEvents = events;
        const depth = header.delegationDepth ?? 0;
        if (header.origin === "subagent") {
          const inherited = handle.inheritedEventCount;
          if (typeof inherited !== "number" || header.parentSession === void 0) return void 0;
          childDescriptor = persistedChildDescriptor(events, inherited);
          if (childDescriptor === void 0) {
            this.log(`跳过 ${header.id}: 子代理没有可续跑的 descriptor`);
            return void 0;
          }
          ownEvents = events.slice(inherited);
        }
        const lastActivityAt = persistedLastActivity(ownEvents, now, config);
        if (lastActivityAt === void 0) return void 0;
        let lastEnd;
        for (let i = ownEvents.length - 1; i >= 0; i -= 1) {
          const event = ownEvents[i];
          if (event?.type === "turn/end") {
            lastEnd = event;
            break;
          }
        }
        const turnOpenAfterEnd = lastEnd !== void 0 && ownEvents.some((event) => event.type === "turn/start" && event.seq > lastEnd.seq);
        const maxTokensReason = lastEnd !== void 0 && !turnOpenAfterEnd && readReasonKind(lastEnd.data.reason) === "max-tokens" && this.messageOutput(lastTurnMessageContent(ownEvents, lastEnd)) === "reasoning";
        if (maxTokensReason && header.origin === "subagent" && persistedSpiralTripped(ownEvents, lastEnd, config.loopGuard)) {
          this.log(`停止 ${header.id}(boot:turn/end:max-tokens): 子代理推理复读, 未自动续跑, 需要人工介入`);
          this.notifySpiralStopped(header.id, config, true);
          return void 0;
        }
        if (maxTokensReason && header.origin !== "subagent" && this.persistedSpiralEscalated(ownEvents, lastEnd, config)) {
          this.log(`停止 ${header.id}(boot:turn/end:max-tokens): 推理复读, 强制续跑一次后仍无可见输出, 需要人工介入`);
          this.notifySpiralStopped(header.id, config);
          return void 0;
        }
        return {
          id: header.id,
          lastActivityAt,
          depth,
          ownTurnStartCount: ownEvents.filter((event) => event.type === "turn/start").length,
          route: persistedRoute(ownEvents),
          preset: persistedPreset(header, events),
          ...childDescriptor !== void 0 ? { childDescriptor, parentSession: header.parentSession } : {}
        };
      } finally {
        await withPersistedTimeout(handle.close()).catch(() => void 0);
      }
    } catch (error) {
      console.error(`[auto-continue] 跳过无法读取的持久化会话 ${header.id}: ${error instanceof Error ? error.message : String(error)}`);
      return void 0;
    }
  }
  /** Resume one persisted session through the host. A failure or stall drops it for this boot; only a boot Continue is retried (deliverChild). */
  async resumePersisted(entry) {
    const outcome = { retryDue: false };
    try {
      await withPersistedTimeout(this.resumeEntry(entry, outcome));
    } catch (error) {
      if (error instanceof PersistedCallTimeout) {
        if (!outcome.retryDue) this.log(`恢复 ${entry.id} 超时, 不再重试`);
        return;
      }
      if (error instanceof Error && error.name === "SessionAlreadyOwnedError") {
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
  async resumeEntry(entry, outcome) {
    if (!this.persistedOpen()) {
      this.log(`跳过 ${entry.id}: 启动窗口已结束`);
      return;
    }
    if (entry.childDescriptor !== void 0) {
      await this.continueChild(entry, entry.childDescriptor, outcome);
      return;
    }
    const defaults = this.ctx.get("agentDefaultModel");
    const route = entry.route ?? defaults?.currentSelection();
    if (route === void 0) {
      this.log(`跳过 ${entry.id}: 持久化历史没有模型路由, 也没有默认模型`);
      return;
    }
    const presets = this.ctx.get("agentPresets");
    let setup;
    if (presets !== void 0) {
      const presetId = (await presets.resolve(entry.preset)).id;
      setup = async (agentCtx) => {
        await presets.mount(agentCtx, presetId);
      };
    }
    const registry = this.ctx.get("workspaceRegistry");
    if (registry === void 0 || registry.archivedSessionIds.includes(entry.id)) return;
    if (!this.persistedOpen()) {
      this.log(`跳过 ${entry.id}: 启动窗口已结束`);
      return;
    }
    this.persistedLoaded.add(entry.id);
    const handle = await this.ctx.agents.resume({
      resumeSessionId: entry.id,
      agentOptions: { provider: route.provider, model: route.model },
      setup
    });
    if (Date.now() >= this.bootDeadline) {
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
   * waits for a slot (see waitForSlot). A parent that a boot pass resumes but has not published yet delivers nothing
   * either, so the child waits for that parent (see deferForParent). A refusal because the child became resident
   * meanwhile (skipIfResident) also
   * delivers nothing. A child that started a turn after the listing (skipIfRunSince) is not sent Continue. Any other failure is not retried in this run. A timed-out delivery is retried once (F-4).
   */
  async continueChild(entry, child, outcome = { retryDue: false }) {
    this.slotDeliveries += 1;
    try {
      await this.deliverChild(entry, child, outcome);
    } finally {
      this.slotDeliveries -= 1;
      this.endSlotWaitIfIdle();
    }
  }
  /** The body of continueChild. Every return path reaches its finally, so an idle wait ends there. */
  async deliverChild(entry, child, outcome) {
    const registry = this.ctx.get("workspaceRegistry");
    if (registry === void 0 || registry.archivedSessionIds.includes(entry.id)) return;
    const parentSession = entry.parentSession;
    if (parentSession === void 0 || registry.archivedSessionIds.includes(parentSession)) {
      this.log(`skip ${entry.id}: the parent is archived or unknown, so the child is not continued`);
      return;
    }
    const parent = this.ctx.agents.get(parentSession);
    if (parent === void 0 || parent.id !== parentSession) {
      this.deferForParent(entry, child, parentSession);
      return;
    }
    if (child.agentProvider === void 0 || child.agentModel === void 0) {
      this.log(`skip ${entry.id}: the child pins no provider and model, so the child is not continued`);
      return;
    }
    const logged = entry.route;
    if (logged === void 0 || logged.provider !== child.agentProvider || logged.model !== child.agentModel) {
      this.log(`skip ${entry.id}: the child's own log does not show its pinned route, so the child is not continued`);
      return;
    }
    const subagents = this.ctx.get("subagents");
    if (subagents === void 0) {
      this.log(`skip ${entry.id}: the subagent service is not available; not retried in this run`);
      return;
    }
    const continued = bootContinuedIds();
    if (continued.has(entry.id)) {
      this.log(`skip ${entry.id}: already continued in this host run`);
      return;
    }
    if (!this.persistedOpen()) {
      this.log(`skip ${entry.id}: the boot window has ended`);
      return;
    }
    if (this.ctx.agents.get(entry.id) !== void 0) {
      this.waitingChildren.delete(entry.id);
      this.log(`skip ${entry.id}: already live; not continued`);
      return;
    }
    continued.add(entry.id);
    const text = fillTemplate(this.getConfig().continueText, {});
    const releasesBefore = this.slotReleases;
    let messageId;
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
   * One Continue call under the call timeout. Each call has its own abort signal, so a timed-out call is aborted and admits
   * nothing. `onTimeout` runs synchronously when the call times out, before the outer wait can settle.
   */
  sendContinue(subagents, parent, entry, text, onTimeout) {
    const controller = new AbortController();
    return withPersistedTimeout(
      subagents.sendMessage(parent, entry.id, [{ type: "text", text }], {
        signal: controller.signal,
        skipIfResident: true,
        skipIfRunSince: entry.ownTurnStartCount
      }),
      () => {
        controller.abort();
        onTimeout?.();
      }
    );
  }
  /**
   * A Continue the host refused or failed. A refusal because the child was already resident or started a turn after the listing means a
   * parent message admitted it, so no Continue is sent and nothing is retried.
   */
  refusedContinue(error, entry, child, releasesBefore) {
    if (isAlreadyResident(error)) {
      this.log(`skip ${entry.id}: already resident (admitted by another route); no Continue sent`);
      return;
    }
    if (isAlreadyRan(error)) {
      this.log(`skip ${entry.id}: ran after the boot listing (its own log grew); no Continue sent`);
      return;
    }
    if (!isAdmissionLimit(error)) {
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
  refusedRetry(error, entry, child, releasesBefore) {
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
  waitForSlot(entry, child, releasedDuringAttempt) {
    this.waitingChildren.set(entry.id, { entry, child, reason: "slot" });
    this.log(`${entry.id} is waiting for an activation slot (active child limit)`);
    this.disposeSlotListener ?? (this.disposeSlotListener = this.ctx.on("agent/disposed", () => this.onAgentDisposed()));
    this.ensureWaitWindow();
    if (releasedDuringAttempt) this.scheduleWaitAttempt(entry.id);
  }
  /**
   * Keep a child whose parent this boot pass may still publish. The boot scan resumes a parent through ctx.agents.resume,
   * and the host announces a resumed agent with agent/created (dsh-agent/lib/index.js:announce) on the same scope carrier
   * the agent/disposed listener already uses. The child waits in the same set a child refused at the active-child limit
   * uses, under the same boot-window timer, so a parent that never becomes live holds neither a listener nor a timer past
   * the window. The child is not in the once-set, so the retry may still deliver it.
   */
  deferForParent(entry, child, parentSession) {
    this.waitingChildren.set(entry.id, { entry, child, reason: "parent" });
    this.log(`${entry.id} is waiting for the parent session ${parentSession} to become live`);
    this.disposeParentListener ?? (this.disposeParentListener = this.ctx.on("agent/created", ({ agent }) => this.onAgentCreated(agent)));
    this.ensureWaitWindow();
    if (this.ctx.agents.get(parentSession) !== void 0) this.scheduleWaitAttempt(entry.id);
  }
  /** An agent was published. A child waiting for this exact parent gets one attempt, run after the host's publish call. */
  onAgentCreated(agent) {
    if (!this.persistedOpen()) return;
    for (const [id, waiting] of this.waitingChildren) {
      if (waiting.reason !== "parent") continue;
      if (waiting.entry.parentSession === agent.id) this.scheduleWaitAttempt(id);
    }
  }
  /** The one boot-window timer. Set while any child waits; on close every waiter is dropped and logged. It never sends. */
  ensureWaitWindow() {
    this.slotWindowTimer ?? (this.slotWindowTimer = setTimeout(() => this.closeSlotWindow(), Math.max(0, this.bootDeadline - Date.now())));
  }
  /**
   * An agent was disposed. The host emits agent/disposed (dsh-agent-loop/lib/index.js:1701) before it releases the
   * disposed child's slot (dsh-subagent/lib/index.js:1250). setImmediate runs after that release, so each waiting child
   * gets one attempt then. A burst of events schedules one attempt per child.
   */
  onAgentDisposed() {
    if (!this.persistedOpen()) return;
    this.noteSlotRelease();
  }
  /**
   * A slot may have freed. The count lets a refused call that is in flight notice the release (waitForSlot). Each child
   * waiting for a slot gets one attempt, run after the host's release by setImmediate. A child waiting for its parent is
   * woken by that parent's own agent/created event, not by a slot release.
   */
  noteSlotRelease() {
    this.slotReleases += 1;
    for (const [id, waiting] of this.waitingChildren) {
      if (waiting.reason === "slot") this.scheduleWaitAttempt(id);
    }
  }
  /** One pending attempt per child. Called only for a child in the waiting set. */
  scheduleWaitAttempt(id) {
    if (this.waitAttempts.has(id)) return;
    const attempt = setImmediate(() => {
      this.waitAttempts.delete(id);
      this.attemptWaiting(id);
    });
    this.waitAttempts.set(id, attempt);
  }
  /** One wait attempt. A refusal or a parent still absent waits again. Any other failure is logged with the child id. */
  attemptWaiting(id) {
    const waiting = this.waitingChildren.get(id);
    if (waiting === void 0 || !this.persistedOpen()) return;
    this.waitingChildren.delete(id);
    this.continueChild(waiting.entry, waiting.child).catch((error) => {
      console.error(
        `[auto-continue] skip ${id}: delivery failed, not retried: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }
  /** The boot window ended. Each child still waiting is dropped and logged with its id and the wait it was in. */
  closeSlotWindow() {
    this.slotWindowTimer = void 0;
    for (const [id, waiting] of this.waitingChildren) {
      const cause = waiting.reason === "parent" ? "its parent was not live before the boot window closed" : "no activation slot before the boot window closed";
      console.error(`[auto-continue] dropped ${id}: ${cause}`);
    }
    this.waitingChildren.clear();
    this.stopSlotWait();
  }
  /** The wait ends once no child waits and no delivery is in flight. Only then are the listeners and the timer released. */
  endSlotWaitIfIdle() {
    if (this.waitingChildren.size === 0 && this.slotDeliveries === 0) this.stopSlotWait();
  }
  /** Remove the listeners, the pending attempts and the window timer. The caller clears the waiting set. */
  stopSlotWait() {
    this.disposeSlotListener?.();
    this.disposeSlotListener = void 0;
    this.disposeParentListener?.();
    this.disposeParentListener = void 0;
    for (const attempt of this.waitAttempts.values()) clearImmediate(attempt);
    this.waitAttempts.clear();
    if (this.slotWindowTimer !== void 0) clearTimeout(this.slotWindowTimer);
    this.slotWindowTimer = void 0;
  }
  /**
   * Release loader-resumed agents the boot scan never classified, once the scan loop has exited. No later pass can
   * classify them, so they would hold a write handle and never continue. Agents the scanner decided stay with the live
   * path, as do agents that still own work: a running turn, any timer in SessionState, or queued inbox input.
   */
  releaseUnscannedPersisted() {
    const handles = [...this.persistedHandles];
    this.persistedHandles.clear();
    if (this.disposed) return;
    try {
      for (const [id, handle] of handles) {
        const { agent } = handle;
        const state = this.states.get(id);
        if (this.ctx.agents.get(id) !== agent || this.bootScannedSessions.has(agent.session)) continue;
        if (state?.running === true || state?.pendingTimer !== void 0 || state?.cooldownRetryTimer !== void 0 || state?.loopRetryTimer !== void 0 || agent.inbox.hasPending) continue;
        this.log(`启动窗口结束时仍未扫描 ${id}, 已释放, 不续跑`);
        handle.dispose().catch(reportLoaderError);
      }
    } catch (error) {
      reportLoaderError(error);
    }
  }
  /** Inspect newly available sessions; process each settled startup history once. */
  async scanInterrupted() {
    const config = this.getConfig();
    if (config.paused || !config.scanOnBoot) return false;
    this.loadInterruptedPersisted(config);
    const now = Date.now();
    const candidates = [];
    for (const agent of this.ctx.agents.list()) {
      const session = agent.session;
      if (session.header.origin === "subagent" || this.bootScannedSessions.has(session)) {
        continue;
      }
      const state = this.state(session.id);
      if (state.pendingTimer !== void 0 || state.consecutive >= config.maxConsecutive) continue;
      if (now - state.lastAttemptAt < this.cooldownFor(state)) continue;
      if (now < (this.pauseUntil.get(session.id) ?? 0)) continue;
      const events = snapshotSessionEvents(session);
      if (events.length === 0) continue;
      let lastEnd;
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i];
        if (event?.type === "turn/end") {
          lastEnd = event;
          break;
        }
      }
      const reasonKind = readReasonKind(lastEnd?.data.reason);
      const silent = reasonKind === "no-visible-output" && config.resumeSilentTurns;
      const superseded = lastEnd !== void 0 && events.some(
        (event) => event.seq > lastEnd.seq && (event.type === "turn/start" || event.type === "user/message" && event.data.source.kind === "user")
      );
      if (lastEnd === void 0 || reasonKind === void 0 || !isInterruptedTurnEnd(lastEnd.data.reason) && !silent || lastEnd.time < now - config.freshMs || superseded) {
        this.bootScannedSessions.add(session);
        continue;
      }
      if (reasonKind === "max-tokens" && this.messageOutput(lastTurnMessageContent(events, lastEnd)) === "reasoning" && persistedSpiralTripped(events, lastEnd, config.loopGuard)) {
        this.bootScannedSessions.add(session);
        if (this.persistedSpiralEscalated(events, lastEnd, config)) {
          this.log(`停止 ${session.id}(scan:turn/end:max-tokens): 推理复读, 强制续跑一次后仍无可见输出, 需要人工介入`);
          this.notifySpiralStopped(session.id, config);
        } else if (this.schedule(session.id, LOOP_SPIRAL_REASON, true)) {
          this.log(`升级 ${session.id}(scan:turn/end:max-tokens): 推理复读, 强制续跑一次 (${LOOP_SPIRAL_REASON})`);
        }
        continue;
      }
      let failure;
      if (reasonKind === "error") {
        failure = parseFailureFacts(lastEnd.data.reason.error);
        if (failure === void 0) {
          this.bootScannedSessions.add(session);
          console.error(`[auto-continue] 忽略畸形扫描 turn/end ${session.id}: error details 无法解释`);
          continue;
        }
        if (config.classify && !isTransientFailure(failure, config.retryableErrorPatterns)) {
          this.bootScannedSessions.add(session);
          this.onTurnFailure(session.id, "scan:turn/end:error", failure);
          continue;
        }
      }
      candidates.push({
        session,
        events,
        lastEnd,
        reasonKind,
        failure,
        lastActivityAt: events.reduce((latest, event) => Math.max(latest, event.time), 0),
        listIndex: candidates.length
      });
    }
    candidates.sort((left, right) => right.lastActivityAt - left.lastActivityAt || left.listIndex - right.listIndex);
    const live = candidates.filter((candidate) => !this.persistedLoaded.has(candidate.session.id)).slice(0, config.scanLimit);
    const loaded = candidates.filter((candidate) => this.persistedLoaded.has(candidate.session.id));
    for (const candidate of [...live, ...loaded.slice(0, config.scanLimit - live.length)]) {
      if (this.disposed) return true;
      const { session, events, lastEnd, reasonKind, failure } = candidate;
      this.bootScannedSessions.add(session);
      const state = this.state(session.id);
      this.applyGuardFromEvents(state, events, lastEnd.seq);
      const scanReason = `scan:turn/end:${reasonKind}${reasonKind === "no-visible-output" ? ":silent" : ""}`;
      this.log(`扫描发现中断 ${session.id}(turn/end:${reasonKind}), 交给恢复策略处理`);
      if (failure !== void 0) {
        state.lastFailure = failure;
        state.lastTurn = lastEnd.data.turn;
        state.lastFailureAt = lastEnd.time;
        this.onTurnFailure(session.id, scanReason, failure);
      } else {
        if (reasonKind === "no-visible-output") {
          state.lastFailure = void 0;
          state.lastTurn = lastEnd.data.turn;
          state.lastFailureAt = lastEnd.time;
        }
        this.schedule(session.id, scanReason);
      }
    }
    return false;
  }
  /** 从历史事件恢复上一步工具调用状态(扫描路径的幂等护栏)。 */
  applyGuardFromEvents(state, events, untilSeq) {
    state.tools.restore(events, untilSeq);
  }
};

// src/index.ts
var AUTO_CONTINUE_NS = "auto-continue";
var AutoContinueSchema = z2.object({
  /** Active browser/UI locale mirrored by the client. */
  locale: z2.string().default("zh"),
  /** Text automatically sent after an interruption. */
  continueText: z2.string().default(""),
  /** Text sent when the output token ceiling is reached (same placeholders as `continueText`). */
  continueTextMaxTokens: z2.string().default(""),
  /** Resume observed model activity that completes without visible output. */
  resumeSilentTurns: z2.boolean().default(true),
  /** Autonomous mode: hand the thread back to the agent after every completed turn, looping until the user stops it. The consecutive-failure cap only throttles failures, never successful completions. */
  resumeCompletedTurns: z2.boolean().default(false),
  /** Text sent to resume a silent turn (same placeholders as `continueText`). */
  continueTextSilent: z2.string().default(""),
  /** Text sent for each autonomous-loop continuation (same placeholders as `continueText`). */
  continueTextLoop: z2.string().default(""),
  /** Idempotency guard: inspect the last tool call before resuming and steer the model. */
  guardTools: z2.boolean().default(true),
  /** Guard text appended when the last tool call has no confirmed result (it may have partially executed). */
  guardPendingText: z2.string().default(""),
  /** Guard text appended when the last tool call completed successfully (don't rerun it). */
  guardDoneText: z2.string().default(""),
  /** Grace period after an interruption before auto-sending (ms). */
  graceMs: z2.natural().default(3e3),
  /** Minimum interval between two auto-continues per session (ms). */
  cooldownMs: z2.natural().default(2e4),
  /** Max consecutive auto-continues per session before stopping. */
  maxConsecutive: z2.natural().min(1).default(3),
  /** Recover delayed interrupted sessions during the host startup window. */
  scanOnBoot: z2.boolean().default(true),
  /** Max eligible recoveries per scan pass (most recently active first). */
  scanLimit: z2.natural().min(1).default(8),
  /** Interruption freshness and duration of startup polling (ms). */
  freshMs: z2.natural().default(15 * 60 * 1e3),
  /** Log `[auto-continue]` lines to the browser console. */
  verbose: z2.boolean().default(true),
  /** Classify failures: auto-continue transient errors only; permanent ones are skipped and notified. */
  classify: z2.boolean().default(true),
  /** Provider-specific message/code/status fragments that explicitly count as retryable, one literal per line. */
  retryableErrorPatterns: z2.string().default(""),
  /** Cooldown multiplier per consecutive failure (adaptive backoff). */
  backoffFactor: z2.natural().min(1).default(2),
  /** Cap on the effective backoff interval (ms). */
  backoffMaxMs: z2.natural().default(3e5),
  /** Show browser notifications for auto-continue events. */
  notify: z2.boolean().default(false),
  /** Globally pause auto-continue: no live or scan send. */
  paused: z2.boolean().default(false),
  /** Show the global auto-continue switch in the conversation composer. */
  showComposerToggle: z2.boolean().default(true),
  /** Loop guard: detect a running turn spinning in place and restart it. */
  loopGuard: z2.boolean().default(true),
  /** A model message shorter than this many chars counts as a short sentence (loop signal). */
  loopShortChars: z2.natural().min(1).default(40),
  /** Consecutive short sentences within this window (ms) with no tool call in between trip the loop guard. */
  loopWindowMs: z2.natural().min(1e3).default(3e4),
  /** Consecutive short sentences trip the loop guard. */
  loopShortCount: z2.natural().min(2).default(12),
  /** Consecutive identical assistant messages trip the loop guard (strongest signal; also used for streamed intra-message repetition). */
  loopRepeatText: z2.natural().min(2).default(4),
  /** Consecutive identical tool calls with identical arguments AND results trip the loop guard. */
  loopToolRepeat: z2.natural().min(2).default(5),
  /** Text sent after the loop guard cancels and restarts a turn (supports {tool}). */
  loopText: z2.string().default("")
});
var entrySchema = AutoContinueSchema;
var Config = entrySchema.volatile?.() ?? AutoContinueSchema;
function entryConfig(config) {
  return config !== void 0 && "get" in config ? config.get() : config;
}
function apply(ctx, config) {
  let legacyConfig;
  ctx.inject(["settings"], (settingsCtx) => {
    const settings = settingsCtx.settings;
    if (typeof settings.register !== "function" || typeof settings.get !== "function") return;
    settings.register(AUTO_CONTINUE_NS, AutoContinueSchema, { applies: "live" });
    const read = () => settings.get(AUTO_CONTINUE_NS);
    legacyConfig = read;
    settingsCtx.effect(() => () => {
      if (legacyConfig === read) legacyConfig = void 0;
    });
  });
  let disposeEngine;
  ctx.inject(["agents", "webServer"], (engineCtx) => {
    disposeEngine?.();
    const runner = new AutoContinueRunner(engineCtx, () => resolveConfig(legacyConfig?.() ?? entryConfig(config)));
    const sseClients = /* @__PURE__ */ new Set();
    const closeClients = /* @__PURE__ */ new Set();
    const pushToAll = (data) => {
      for (const send of sseClients) {
        try {
          send(data);
        } catch {
          sseClients.delete(send);
        }
      }
    };
    const statePayload = () => JSON.stringify({
      type: "state",
      stats: runner.todayStats(),
      paused: runner.activePauses()
    });
    runner.subscribeNotices(() => {
      for (const notice of runner.drainNotices()) {
        pushToAll(`data: ${JSON.stringify({ type: "notice", notice })}

`);
      }
    });
    runner.subscribeState(() => {
      pushToAll(`data: ${statePayload()}

`);
    });
    const stopBridge = engineCtx.webServer.register({
      kind: "exact",
      path: "/api/auto-continue-bridge",
      handler: (req, res) => {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive"
        });
        res.write(`data: ${statePayload()}

`);
        const send = (data) => {
          res.write(data);
        };
        sseClients.add(send);
        const close = () => {
          res.end();
        };
        closeClients.add(close);
        req.on("close", () => {
          sseClients.delete(send);
          closeClients.delete(close);
        });
      }
    });
    const stopActions = engineCtx.webServer.register({
      kind: "exact",
      path: "/api/auto-continue-action",
      handler: (req, res) => {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk.toString("utf8");
          if (body.length > 4096) req.destroy();
        });
        req.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            if (typeof parsed.action === "string") {
              runner.handleNoticeAction(parsed.sessionId ?? void 0, parsed.action);
              res.writeHead(200, { "content-type": "application/json" });
              res.end(JSON.stringify({ ok: true }));
              return;
            }
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false }));
          } catch {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false }));
          }
        });
      }
    });
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      runner.dispose();
      stopBridge();
      stopActions();
      for (const close of closeClients) close();
      closeClients.clear();
      sseClients.clear();
    };
    disposeEngine = dispose;
    engineCtx.effect(() => dispose);
  });
  ctx.effect(() => () => {
    const dispose = disposeEngine;
    disposeEngine = void 0;
    dispose?.();
  });
}
export {
  AUTO_CONTINUE_NS,
  AutoContinueSchema,
  Config,
  apply
};
