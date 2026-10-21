/**
 * Boot continuation of subagent children (r6). A continuable child that the host persisted with an open or interrupted
 * turn is continued by the boot loader through the host's public subagent service, `sendMessage`. The host then creates
 * the child's activation, so the child can message its parent and the parent's messages reach it. The plugin keeps no
 * handle to the child. A child is continued at most once per host process, and only when its pinned route equals the
 * route its own log shows it ran on. User sessions keep the ctx.agents.resume path.
 *
 * The fake host mirrors the host source, read but not run live: sendMessage (dsh-subagent/lib/index.js:1765-1778) accepts
 * only the exact live sender; deliverFollowup cold-resumes a child with no activation (lines 1823-1827); coldResume
 * (lines 1901-1943) builds the route from the descriptor's pinned fields only. The live-target refusal
 * (SessionAlreadyOwnedError) and the release of an idle child are inferred, not observed. Each is marked where it is used.
 */
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { makeHost } from './host-fixture.mjs';

/** The once-set is process-wide by design (engine.ts bootContinuedIds). Each test starts with it empty. */
const BOOT_CONTINUED = Symbol.for('dsh.auto-continue.bootContinued');

const settle = async (ms = 0) => {
  mock.timers.tick(ms);
  for (let i = 0; i < 100; i += 1) await Promise.resolve();
};
/** One scan pass (3 s poll) plus the 10 ms grace the tests configure. */
const nextPass = async () => {
  await settle(3000);
  await settle(10);
};

/** Stamp a log: sequence numbers follow array order, every event carries one time. */
const log = (items, time = Date.now()) => items.map((item, index) => ({ ...item, seq: index + 1, time }));
const turnStart = (turn) => ({ type: 'turn/start', data: { turn } });
const turnEnd = (turn, reason) => ({ type: 'turn/end', data: { turn, reason } });
const userPrompt = () => ({ type: 'user/message', data: { source: { kind: 'user' } } });
const requestHeader = (provider, model) => ({
  type: 'request/header',
  data: { header: { config: { provider, model } }, reason: 'initial' },
});
const descriptorEvent = (data) => ({ type: 'subagent/descriptor', data });
const CONTINUABLE = {
  version: 3, mode: 'continuable', provider: 'in-process', label: 'worker',
  agentProvider: 'deepseek', agentModel: 'pinned-model', agentReasoningEffort: 'high',
  persona: 'You review code.', toolFilter: { allow: ['read_file', 'grep'], deny: ['shell'] },
};
const UNPINNED = { version: 3, mode: 'continuable', provider: 'in-process', label: 'unpinned' };
const INTERRUPTED = { kind: 'interrupted' };
/** A crash orphan: a turn started and never ended. */
const OPEN = () => [turnStart(1), userPrompt()];
const ROUTE = { provider: 'deepseek', model: 'pinned-model' };
const routeHeader = (route = ROUTE) => requestHeader(route.provider, route.model);
/** The shape r6 continues: pinned, open turn, and an own log whose route equals the pin. */
const CHILD_OPEN = () => [routeHeader(), ...OPEN(), descriptorEvent(CONTINUABLE)];
const assistantMessage = (content) => ({ type: 'assistant/message', data: { message: { content } } });
/** vrpe F-A1: the last committed message of the child's final turn carries only reasoning. */
const REASONING_ONLY = [{ type: 'reasoning', text: 'r'.repeat(9000) }];
/**
 * Round 4: the same shape, but the reasoning text is one sentence repeated, so the live detector's predicate
 * (ReasoningDensity) trips on it. A child has no escalation path, so this is the child shape the boot path refuses.
 */
const SPIRAL_SENTENCE = '我必须再检查一遍这个推理内容的每一个细节。';
const SPIRAL_REASONING = [{ type: 'reasoning', text: SPIRAL_SENTENCE.repeat(400) }];
const VISIBLE = [{ type: 'text', text: 'Here is the partial answer so far.' }];
/** A pinned child whose own last turn ended max-tokens after committing `content`: the shape the boot path must filter. */
const CHILD_MAX_TOKENS = (content) => [
  routeHeader(), turnStart(1), userPrompt(), assistantMessage(content), turnEnd(1, { kind: 'max-tokens' }),
  descriptorEvent(CONTINUABLE),
];
/**
 * fixer2 F-1 (shape R3): turn 1 ended max-tokens with a reasoning-only last committed message, then turn 2 started and
 * never ended. The child is a crash orphan inside turn 2, which the boot path continues; the max-tokens filter judges
 * only the child's last turn and must not fire here.
 */
const CHILD_OPEN_AFTER_MAX_TOKENS = () => [
  routeHeader(), turnStart(1), userPrompt(), assistantMessage(REASONING_ONLY), turnEnd(1, { kind: 'max-tokens' }),
  turnStart(2), userPrompt(), descriptorEvent(CONTINUABLE),
];
const record = (id, events, header = {}, extra = {}) => ({
  header: { id, version: 1, createdAt: Date.now(), cwd: '/work', isSeeded: false, origin: 'subagent', parentSession: 'parent', ...header },
  events,
  ...extra,
});

/** Turn number of the last turn that was started and never ended, or undefined. */
function openTurn(events) {
  const last = events.filter((event) => event.type === 'turn/start').at(-1);
  if (last === undefined) return undefined;
  return events.some((event) => event.type === 'turn/end' && event.seq > last.seq) ? undefined : last.data.turn;
}

/** The first subagent/descriptor among the session's own events (after the inherited prefix). */
function ownDescriptor(stored) {
  const inherited = stored.inheritedEventCount ?? 0;
  return stored.events.slice(inherited).find((event) => event.type === 'subagent/descriptor')?.data;
}

/** Route options the host's coldResume passes, taken from the pinned descriptor fields only (index.js:1923-1935). */
function pinnedOptions(descriptor) {
  return {
    ...(descriptor.agentProvider !== undefined ? { provider: descriptor.agentProvider } : {}),
    ...(descriptor.agentModel !== undefined ? { model: descriptor.agentModel } : {}),
    ...(descriptor.agentReasoningEffort !== undefined ? { reasoningEffort: descriptor.agentReasoningEffort } : {}),
  };
}

/** Read-only persisted store. The handle reports the inherited prefix length the host reports (SessionHandle). */
function persistence(records) {
  return {
    async list() { return [...records.values()].map(({ header }) => ({ header, revision: 'r1' })); },
    async open(id, access) {
      if (access !== 'read') throw new Error('the boot loader must open read-only');
      const stored = records.get(id);
      if (stored === undefined) throw new Error(`no session ${id}`);
      return {
        header: stored.header,
        inheritedEventCount: stored.inheritedEventCount ?? 0,
        async read() { return { events: [...stored.events] }; },
        async close() {},
      };
    },
  };
}

const hosts = [];

/**
 * One fake host with persisted sessions and a live registry. A live top-level parent 'parent' is present unless
 * `parent` is false. `resumes` holds every resume: the plugin's ctx.agents.resume and the subagent service's cold resume.
 * `pluginResumes` holds only the plugin's own calls, so a child must never appear there. `sends` holds each sendMessage
 * the plugin made, recorded before any check. A followup queues into the inbox, as the driver does. `resumeDelay` holds
 * one id-to-milliseconds map, so a boot resume can outlive the caller's 10 s call timeout as a stalled host resume does.
 */
function scenario({ sessions = [], live = [], overrides = {}, parent = true, archived = [], subagents = true, sendFailure, capacity, occupied = [], hang = false, closerView = false, resumeDelay = {} } = {}) {
  const records = new Map(sessions.map((item) => [item.header.id, item]));
  const resumes = [];
  const pluginResumes = [];
  const sends = [];
  let messageSeq = 0;
  let host;

  /** The host's resume of one persisted session: refuses a live writer, appends an interrupted closer to an open turn. */
  const openSession = (options) => {
    if (host.agents.has(options.resumeSessionId)) {
      throw Object.assign(new Error(`session ${options.resumeSessionId} is owned by a live writer`), { name: 'SessionAlreadyOwnedError' });
    }
    const stored = records.get(options.resumeSessionId);
    const events = [...stored.events];
    const turn = openTurn(events);
    if (turn !== undefined) {
      const tail = events.at(-1);
      events.push({ type: 'turn/end', seq: tail.seq + 1, time: tail.time, data: { turn, reason: INTERRUPTED } });
    }
    const agent = host.agent(stored.header.id, events);
    agent.id = stored.header.id;
    agent.session.header = stored.header;
    agent.ctx = { label: `ctx:${stored.header.id}` };
    agent.followup = (message) => {
      agent.followups.push(message);
      agent.inbox.nextTurn.push(message);
    };
    // The host announces every published agent with agent/created (dsh-agent/lib/index.js:announce), for a create and a resume alike.
    host.emitCreated(agent);
    return { agent, dispose: async () => { host.agents.delete(stored.header.id); } };
  };

  /** Plugin path: ctx.agents.resume, used for user sessions. Runs the setup the plugin passes, as the host does. */
  const pluginResume = async (options) => {
    pluginResumes.push(options);
    resumes.push(options);
    const delay = resumeDelay[options.resumeSessionId];
    if (delay !== undefined) await new Promise((resolve) => setTimeout(resolve, delay));
    if (options.setup !== undefined) await options.setup({ calls: [] }, undefined);
    return openSession(options);
  };

  /**
   * Fake subagent service (inferred from dsh-subagent index.js:1765-1778 and 1823-1831, not run live). Records the call,
   * then accepts only the exact live sender, checks lineage, builds the route from the descriptor's pinned fields, and
   * cold-resumes the child under that sender. The content becomes a followup on the new agent.
   */
  // Active children holding a slot. `capacity` caps them; `occupied` seeds them; freeSlot releases one, as a finished child does.
  const active = new Set(occupied);
  // Per-child lock, as ChildLock.run (dsh-subagent lib/index.js:748-756): each call runs after the previous call for its child.
  const childTails = new Map();
  const runLocked = (childId, operation) => {
    const result = (childTails.get(childId) ?? Promise.resolve()).then(operation, operation);
    childTails.set(childId, result.then(() => undefined, () => undefined));
    return result;
  };
  // Holds the next cold resume after it takes the child lock and before the child is resident (the host's enter window).
  // The returned release() lets it continue; release(error) fails it.
  let coldGate;
  const holdColdResume = () => {
    let open;
    let fail;
    coldGate = new Promise((resolve, reject) => { open = resolve; fail = reject; });
    return (error) => (error === undefined ? open() : fail(error));
  };
  const takeColdGate = () => {
    const gate = coldGate;
    coldGate = undefined;
    return gate;
  };
  const subagentService = {
    get active() { return active; },
    freeSlot(id) { active.delete(id); },
    holdColdResume,
    async sendMessage(sender, targetId, content, options) {
      sends.push({ sender, targetId, content, options });
      if (sendFailure !== undefined) throw sendFailure;
      // `hang` models a delivery that never settles; the plugin's call timeout is the only way out.
      if (hang) return new Promise(() => {});
      // No abort check before the child lock: the host checks the signal under the lock (submitAdmitted, materialize).
      if (sender === undefined || host.agents.get(sender.id) !== sender) {
        throw new Error('message delivery requires the exact live sender agent');
      }
      return runLocked(targetId, async () => {
        const live = host.agents.get(targetId);
        if (live !== undefined) {
          // Resident branch (deliverFollowup, index.js:1826-1841). skipIfResident is the proposed host option: it refuses,
          // delivering nothing, when the child is resident at the moment the lock is taken. Without it the message is delivered.
          if (options.skipIfResident === true) {
            throw Object.assign(new Error(`subagent "${targetId}" is already resident; the message was not delivered`), { name: 'SubagentError', code: 'ALREADY_RESIDENT' });
          }
          // submitAdmitted checks the signal before it delivers (dsh-subagent lib/index.js:997-998): an aborted call delivers nothing.
          options.signal.throwIfAborted();
          const message = { id: `msg-${(messageSeq += 1)}`, content };
          live.followup(message);
          return message.id;
        }
        const stored = records.get(targetId);
        if (stored === undefined) throw new Error(`subagent "${targetId}" is unavailable`);
        if (stored.header.parentSession !== sender.id) throw new Error(`subagent "${targetId}" is not a child of "${sender.id}"`);
        const descriptor = ownDescriptor(stored);
        if (descriptor === undefined || descriptor.mode !== 'continuable') {
          throw Object.assign(new Error(`subagent "${targetId}" has no supported continuation state`), { code: 'NOT_RESUMABLE' });
        }
        // skipIfRunSince (F-3, option B): under the child's lock, refuse when the child started a turn after the caller's listing (turn/start count).
        // P0-1 (option B): the count is the own turn starts the host observes after the inherited prefix. With closerView the host also
        // observes the turn end that closes an open turn; that closer is not a turn start, so it does not count.
        const observedOwn = stored.events.slice(stored.inheritedEventCount ?? 0);
        const observed = closerView && openTurn(stored.events) !== undefined ? [...observedOwn, { type: 'turn/end' }] : observedOwn;
        const ownTurnStarts = observed.filter((event) => event.type === 'turn/start').length;
        if (options.skipIfRunSince !== undefined && ownTurnStarts > options.skipIfRunSince) {
          throw Object.assign(new Error(`subagent "${targetId}" has run since the caller's listing; the message was not delivered`), { name: 'SubagentError', code: 'ALREADY_RAN' });
        }
        // Admission mirrors ActivationPool.reserve (dsh-subagent continuation-activation.js:17-24): at capacity the call is refused, not queued.
        // A reserved slot is released when the call fails before the child is published, as the host releases it (dsh-subagent lib/index.js:985-987).
        const reserved = capacity !== undefined && !active.has(targetId);
        if (reserved) {
          if (active.size >= capacity) {
            throw Object.assign(new Error(`subagent limit reached (active child limit: ${capacity})`), { name: 'SubagentError', code: 'ACTIVATION_LIMIT_REACHED' });
          }
          active.add(targetId);
        }
        try {
          const coldOptions = { resumeSessionId: targetId, parentAgent: sender, agentOptions: pinnedOptions(descriptor) };
          resumes.push(coldOptions);
          const gate = takeColdGate();
          if (gate !== undefined) await gate;
          // materialize checks the signal before the child is published (dsh-subagent lib/index.js materialize): an aborted call delivers nothing.
          options.signal.throwIfAborted();
          const handle = openSession(coldOptions);
          const message = { id: `msg-${(messageSeq += 1)}`, content };
          handle.agent.followup(message);
          return message.id;
        } catch (error) {
          if (reserved) active.delete(targetId);
          throw error;
        }
      });
    },
  };

  const services = {
    workspaceRegistry: { archivedSessionIds: archived },
    agentDefaultModel: { currentSelection: () => ({ provider: 'dp', model: 'dm' }) },
    agentPresets: {
      resolve: async (id) => ({ id: id ?? 'default' }),
      mount: async (agentCtx, id) => { agentCtx.calls.push({ kind: 'mount', id }); },
    },
    sessionPersistence: persistence(records),
  };
  if (subagents) services.subagents = subagentService;
  host = makeHost({ continueText: 'Continue', ...overrides }, { services, resume: pluginResume });
  const liveItems = parent ? [{ header: { id: 'parent', cwd: '/work' }, events: [] }, ...live] : live;
  for (const item of liveItems) {
    const agent = host.agent(item.header.id, item.events);
    agent.id = item.header.id;
    agent.session.header = item.header;
    agent.ctx = { label: `ctx:${item.header.id}` };
  }
  hosts.push(host);
  return { host, resumes, pluginResumes, sends, records, services, subagentService };
}

/** Run one scenario under a fake clock; disposes every host it created. The once-set starts empty for each test. */
async function clocked(run) {
  globalThis[BOOT_CONTINUED]?.clear();
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  try {
    await run();
  } finally {
    for (const host of hosts.splice(0)) host.dispose();
    mock.timers.reset();
  }
}

/** The driver claims the queued followup and the turn runs to `reason` (what the host does when it picks up an inbox message). */
function runTurn(host, agent, turn, reason) {
  agent.inbox.nextTurn.splice(0);
  host.emit(agent, { type: 'turn/start', seq: 900 + turn, time: Date.now(), data: { turn } });
  host.emit(agent, { type: 'turn/end', seq: 910 + turn, time: Date.now(), data: { turn, reason } });
}

const sentTexts = (agent) => agent.followups.map((message) => message.content[0].text);

test('S1 an open pinned child is continued through the subagent service under its live parent, and continued once', () => clocked(async () => {
  const { host, resumes, sends, pluginResumes } = scenario({
    sessions: [record('child', log(CHILD_OPEN()), { agentPreset: 'reviewer' })],
  });
  const parentAgent = host.agents.get('parent');
  host.start();
  await settle();
  await nextPass();
  assert.equal(resumes.length, 1, 'cold-resumed once');
  assert.equal(resumes[0].resumeSessionId, 'child');
  assert.equal(resumes[0].parentAgent, parentAgent, 'resumed under its live parent');
  assert.deepEqual(resumes[0].agentOptions, { provider: 'deepseek', model: 'pinned-model', reasoningEffort: 'high' },
    'the pinned route and the descriptor effort');
  assert.equal(pluginResumes.length, 0, 'the plugin never calls ctx.agents.resume for a child');
  assert.equal(sends.length, 1, 'one message');
  assert.deepEqual(sentTexts(host.agents.get('child')), ['Continue'], 'continued once with the continue text');
  await nextPass();
  assert.equal(sends.length, 1, 'no second continuation');
  assert.equal(host.agents.get('child').followups.length, 1);
}));

test('S2 a continuable child with a completed turn is neither resumed nor continued', () => clocked(async () => {
  const { host, resumes, sends } = scenario({
    sessions: [record('done', log([turnStart(1), turnEnd(1, { kind: 'completed' }), descriptorEvent(CONTINUABLE)]))],
  });
  host.start();
  await settle();
  await nextPass();
  assert.equal(resumes.length, 0);
  assert.equal(sends.length, 0);
}));

test('S3 a child stopped by the user is neither resumed nor continued', () => clocked(async () => {
  const { host, resumes } = scenario({
    sessions: [record('stopped', log([turnStart(1), turnEnd(1, { kind: 'aborted', reason: { kind: 'user' } }), descriptorEvent(CONTINUABLE)]))],
  });
  host.start();
  await settle();
  await nextPass();
  assert.equal(resumes.length, 0);
}));

test('S4 a child with no subagent descriptor is never resumed (fail closed)', () => clocked(async () => {
  const { host, resumes } = scenario({
    sessions: [record('bare', log(OPEN()))],
  });
  host.start();
  await settle();
  await nextPass();
  assert.equal(resumes.length, 0);
}));

test('S5 a one-shot child is never resumed: the host refuses any child that is not continuable', () => clocked(async () => {
  const { host, resumes } = scenario({
    sessions: [record('oneshot', log([...OPEN(), descriptorEvent({ version: 3, mode: 'one-shot', provider: 'p', label: 'l' })]))],
  });
  host.start();
  await settle();
  await nextPass();
  assert.equal(resumes.length, 0);
}));

test('S6 a continuable descriptor with a malformed tool filter is never resumed (fail closed)', () => clocked(async () => {
  const { host, resumes } = scenario({
    sessions: [record('bad', log([...OPEN(), descriptorEvent({ ...CONTINUABLE, toolFilter: { allow: 'read_file' } })]))],
  });
  host.start();
  await settle();
  await nextPass();
  assert.equal(resumes.length, 0);
}));

test('S7 a pinned child with no logged route is not continued: its own log does not confirm the route it ran on', () => clocked(async () => {
  const { host, resumes, sends } = scenario({
    sessions: [record('nolog', log([...OPEN(), descriptorEvent(CONTINUABLE)]))],
  });
  host.start();
  await settle();
  await nextPass();
  assert.equal(resumes.length, 0, 'the pinned route is not used without a logged route to confirm it');
  assert.equal(sends.length, 0);
}));

test('S8 a seeded child takes its descriptor from its own events, not from the inherited prefix', () => clocked(async () => {
  const inherited = [descriptorEvent(CONTINUABLE), userPrompt()];
  const { host, resumes } = scenario({
    sessions: [record('seeded', log([...inherited, ...OPEN()]), { isSeeded: true }, { inheritedEventCount: inherited.length })],
  });
  host.start();
  await settle();
  await nextPass();
  assert.equal(resumes.length, 0, 'the parent descriptor in the prefix does not make the child resumable');
}));

test('S9 a child that was live before the boot window is not resumed or continued by the boot path', () => clocked(async () => {
  const events = log([...CHILD_OPEN(), turnEnd(1, INTERRUPTED)]);
  const { host, resumes, sends } = scenario({
    live: [{ header: { id: 'live', origin: 'subagent', parentSession: 'parent', cwd: '/work' }, events }],
  });
  host.start();
  await settle();
  await nextPass();
  assert.equal(resumes.length, 0);
  assert.equal(sends.length, 0);
  assert.equal(host.agents.get('live').followups.length, 0, 'the parent keeps handling a child it still owns');
}));

test('S11 a child whose persisted failure is permanent is not resumed', () => clocked(async () => {
  const { host, resumes } = scenario({
    sessions: [record('denied', log([...CHILD_OPEN().slice(0, 1), turnStart(1), turnEnd(1, { kind: 'error', error: { code: 'INVALID_API_KEY', status: 401, message: 'unauthorized' } }), descriptorEvent(CONTINUABLE)]))],
  });
  host.start();
  await settle();
  await nextPass();
  assert.equal(resumes.length, 0);
}));

test('S12 a seeded child that never ran its own turn is not resumed, even when the inherited prefix ends interrupted', () => clocked(async () => {
  const inherited = [turnStart(1), userPrompt(), turnEnd(1, INTERRUPTED)];
  const { host, resumes } = scenario({
    sessions: [record('unstarted', log([...inherited, descriptorEvent(CONTINUABLE)]), { isSeeded: true }, { inheritedEventCount: inherited.length })],
  });
  host.start();
  await settle();
  await nextPass();
  assert.equal(resumes.length, 0, 'the parent turn in the inherited prefix is not a turn of this child');
}));

test('S13 a seeded child that ran its own turn, was interrupted, and logged the pinned route is continued', () => clocked(async () => {
  const inherited = [turnStart(1), userPrompt(), turnEnd(1, { kind: 'completed' })];
  const { host, sends } = scenario({
    sessions: [record('ran', log([...inherited, turnStart(2), routeHeader(), descriptorEvent(CONTINUABLE)]), { isSeeded: true }, { inheritedEventCount: inherited.length })],
  });
  host.start();
  await settle();
  await nextPass();
  assert.equal(sends.length, 1, 'the child own open turn makes it resumable');
  assert.deepEqual(sentTexts(host.agents.get('ran')), ['Continue']);
}));

test('S15 a child whose parent is not live is not continued while the parent is absent, and it waits for the parent', () => clocked(async () => {
  const { host, resumes, sends } = scenario({
    parent: false,
    sessions: [record('orphan', log(CHILD_OPEN()))],
  });
  host.start();
  await settle();
  await nextPass();
  assert.equal(resumes.length, 0);
  assert.equal(sends.length, 0);
  // Round 6: absent is not final. The child waits for its parent instead of being dropped (the bounded end is PARENT-3).
  assert.equal(host.listenerCount('agent/created'), 1, 'the child waits for its parent to be published');
}));

test('S16 a child of an archived parent is not continued', () => clocked(async () => {
  const { host, resumes, sends } = scenario({
    archived: ['parent'],
    sessions: [record('kin', log(CHILD_OPEN()))],
  });
  host.start();
  await settle();
  await nextPass();
  assert.equal(resumes.length, 0);
  assert.equal(sends.length, 0);
}));

test('S17 a descriptor that pins only one of provider and model is not continued', () => clocked(async () => {
  const { agentModel, ...pinnedProviderOnly } = CONTINUABLE;
  assert.equal(typeof agentModel, 'string');
  const { host, resumes, sends } = scenario({
    sessions: [record('half', log([routeHeader(), ...OPEN(), descriptorEvent(pinnedProviderOnly)]))],
  });
  host.start();
  await settle();
  await nextPass();
  assert.equal(resumes.length, 0);
  assert.equal(sends.length, 0);
}));

test('S18 a child the host disposes and re-creates is not continued again by the plugin', () => clocked(async () => {
  const { host, sends, services } = scenario({
    overrides: { graceMs: 5000 },
    sessions: [record('stale', log(CHILD_OPEN()))],
  });
  host.start();
  await settle();
  await nextPass();
  assert.equal(sends.length, 1, 'the boot child is continued once');
  // The host disposes the child, then re-creates it under its parent through its own message (not the plugin).
  host.agents.delete('stale');
  const beforeRecreate = sends.length;
  await services.subagents.sendMessage(host.agents.get('parent'), 'stale', [{ type: 'text', text: 'hello' }], { signal: new AbortController().signal });
  await settle(5000);
  await nextPass();
  assert.equal(sends.length, beforeRecreate + 1, 'only the host-driven message was sent; the plugin sent nothing more');
  assert.deepEqual(sentTexts(host.agents.get('stale')), ['hello'], 'the re-created child holds only the host message');
}));

test('S20 a child is continued after its parent, under that parent, even when listed first', () => clocked(async () => {
  const { host, resumes } = scenario({
    parent: false,
    sessions: [
      record('kid', log(CHILD_OPEN()), { delegationDepth: 1 }),
      record('parent', log(OPEN()), { origin: undefined, parentSession: undefined }),
    ],
  });
  host.start();
  await settle();
  await nextPass();
  assert.deepEqual(resumes.map((resumeOptions) => resumeOptions.resumeSessionId), ['parent', 'kid']);
  assert.equal(resumes[1].parentAgent, host.agents.get('parent'), 'the child is continued under the parent resumed before it');
}));

test('S21 a descriptor of another version is never resumed (fail closed)', () => clocked(async () => {
  const { host, resumes } = scenario({
    sessions: [
      record('v2', log([routeHeader(), ...OPEN(), descriptorEvent({ ...CONTINUABLE, version: 2 })])),
      record('v4', log([routeHeader(), ...OPEN(), descriptorEvent({ ...CONTINUABLE, version: 4 })])),
    ],
  });
  host.start();
  await settle();
  await nextPass();
  assert.equal(resumes.length, 0);
}));

test('S22 a descriptor with an unknown field is never resumed (fail closed)', () => clocked(async () => {
  const { host, resumes } = scenario({
    sessions: [record('extra', log([routeHeader(), ...OPEN(), descriptorEvent({ ...CONTINUABLE, unknownField: 'x' })]))],
  });
  host.start();
  await settle();
  await nextPass();
  assert.equal(resumes.length, 0);
}));

test('R6-1 a pinned child whose own log shows the pinned route is continued with sendMessage, never ctx.agents.resume', () => clocked(async () => {
  const { host, sends, pluginResumes, resumes } = scenario({ sessions: [record('pinned', log(CHILD_OPEN()))] });
  const parentAgent = host.agents.get('parent');
  host.start();
  await settle();
  await nextPass();
  assert.equal(sends.length, 1, 'one sendMessage');
  assert.equal(sends[0].sender, parentAgent, 'the exact live parent is the sender');
  assert.equal(sends[0].targetId, 'pinned');
  assert.deepEqual(sends[0].content, [{ type: 'text', text: 'Continue' }]);
  assert.ok(sends[0].options.signal instanceof AbortSignal, 'the call carries an AbortSignal');
  assert.equal(pluginResumes.length, 0, 'ctx.agents.resume is not called for the child');
  assert.equal(resumes[0].parentAgent, parentAgent, 'the host resumes the child under the parent');
}));

test('R6-2 an unpinned child with no logged route is not continued (no default route is used)', () => clocked(async () => {
  const { host, resumes, sends } = scenario({
    sessions: [record('bare-unpinned', log([...OPEN(), descriptorEvent(UNPINNED)]))],
  });
  host.start();
  await settle();
  await nextPass();
  assert.equal(sends.length, 0, 'sendMessage is not called');
  assert.equal(resumes.length, 0, 'no resume on the default selection');
}));

test('R6-3 a pinned child whose own log shows a different route is not continued', () => clocked(async () => {
  const { host, resumes, sends } = scenario({
    sessions: [record('drift', log([routeHeader({ provider: 'deepseek', model: 'other-model' }), ...OPEN(), descriptorEvent(CONTINUABLE)]))],
  });
  host.start();
  await settle();
  await nextPass();
  assert.equal(sends.length, 0);
  assert.equal(resumes.length, 0);
}));

test('R6-4 an unpinned child is not continued even with a logged route (the host has no route to use)', () => clocked(async () => {
  const { host, resumes, sends } = scenario({
    sessions: [record('unpinned', log([routeHeader(), ...OPEN(), descriptorEvent(UNPINNED)]))],
  });
  host.start();
  await settle();
  await nextPass();
  assert.equal(sends.length, 0);
  assert.equal(resumes.length, 0);
}));

test('R6-5 a delivered child is continued at most once: later passes and its own turn end send nothing more', () => clocked(async () => {
  const { host, sends } = scenario({ sessions: [record('once', log(CHILD_OPEN()))] });
  host.start();
  await settle();
  await nextPass();
  assert.equal(sends.length, 1);
  const agent = host.agents.get('once');
  runTurn(host, agent, 2, { kind: 'max-tokens' });
  await settle(10);
  await nextPass();
  await nextPass();
  assert.equal(sends.length, 1, 'at most one boot continuation per child per host run');
  assert.deepEqual(sentTexts(agent), ['Continue']);
}));

test('R6-6 a rejected delivery is logged, the child is not retried in this run, and ctx.agents.resume is not called', () => clocked(async () => {
  const errors = [];
  const spy = mock.method(console, 'error', (...args) => { errors.push(args.join(' ')); });
  try {
    const { host, sends, pluginResumes } = scenario({
      sendFailure: new Error('delivery rejected'),
      sessions: [record('rejected', log(CHILD_OPEN()))],
    });
    host.start();
    await settle();
    await nextPass();
    await nextPass();
    await nextPass();
    assert.equal(sends.length, 1, 'sent once and never retried in this run');
    assert.equal(pluginResumes.length, 0);
    assert.equal(host.agents.get('rejected'), undefined);
    assert.ok(errors.some((line) => line.includes('rejected') && line.includes('delivery rejected')), 'the failure is logged');
  } finally {
    spy.mock.restore();
  }
}));

test('R6-7 without the subagent service a child is skipped, and a service added later is not retried in this run', () => clocked(async () => {
  const { host, sends, pluginResumes, resumes, services, subagentService } = scenario({
    subagents: false,
    sessions: [record('nosvc', log(CHILD_OPEN()))],
  });
  host.start();
  await settle();
  await nextPass();
  assert.equal(pluginResumes.length, 0, 'not resumed through ctx.agents.resume');
  assert.equal(resumes.length, 0, 'not resumed without the service');
  services.subagents = subagentService;
  await nextPass();
  await nextPass();
  assert.equal(sends.length, 0, 'not retried after the service appears');
  assert.equal(host.agents.get('nosvc'), undefined);
}));

test('R6-8 a child whose parent is not live waits for it, and a child of an archived parent is skipped', () => clocked(async () => {
  const orphan = scenario({ parent: false, sessions: [record('orphan', log(CHILD_OPEN()))] });
  orphan.host.start();
  await settle();
  await nextPass();
  assert.equal(orphan.sends.length, 0, 'no live parent yet');
  assert.equal(orphan.resumes.length, 0);
  assert.equal(orphan.host.listenerCount('agent/created'), 1, 'round 6: the absent parent is waited for, not skipped');
  orphan.host.dispose();
  const kin = scenario({ archived: ['parent'], sessions: [record('kin', log(CHILD_OPEN()))] });
  kin.host.start();
  await settle();
  await nextPass();
  assert.equal(kin.sends.length, 0, 'archived parent');
  assert.equal(kin.resumes.length, 0);
  assert.equal(kin.host.listenerCount('agent/created'), 0, 'an archived parent is not waited for');
}));

test('R6-9 a child listed before its parent is continued by the parent the loader resumed in the same pass', () => clocked(async () => {
  const { host, sends, pluginResumes } = scenario({
    parent: false,
    sessions: [
      record('kid', log(CHILD_OPEN()), { delegationDepth: 1 }),
      record('parent', log(OPEN()), { origin: undefined, parentSession: undefined }),
    ],
  });
  host.start();
  await settle();
  await nextPass();
  assert.deepEqual(pluginResumes.map((options) => options.resumeSessionId), ['parent'], 'the parent resumes through ctx.agents.resume');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].sender, host.agents.get('parent'), 'the sender is the parent the loader just resumed');
  assert.equal(sends[0].targetId, 'kid');
}));

test('R6-10 a live child is never continued by the boot path, and its own turn end sends nothing', () => clocked(async () => {
  const liveChild = { header: { id: 'live-kid', origin: 'subagent', parentSession: 'parent', cwd: '/work' }, events: log(CHILD_OPEN()) };
  const { host, sends, pluginResumes } = scenario({ live: [liveChild] });
  host.start();
  await settle();
  await nextPass();
  const agent = host.agents.get('live-kid');
  runTurn(host, agent, 2, { kind: 'max-tokens' });
  await settle(10);
  await nextPass();
  assert.equal(sends.length, 0);
  assert.equal(pluginResumes.length, 0);
  assert.equal(agent.followups.length, 0);
}));

test('R6-11 completed, stopped, one-shot, malformed, and other-version children are never continued', () => clocked(async () => {
  const { host, sends, resumes } = scenario({
    sessions: [
      record('completed', log([routeHeader(), turnStart(1), turnEnd(1, { kind: 'completed' }), descriptorEvent(CONTINUABLE)])),
      record('stopped', log([routeHeader(), turnStart(1), turnEnd(1, { kind: 'aborted', reason: { kind: 'user' } }), descriptorEvent(CONTINUABLE)])),
      record('oneshot', log([routeHeader(), ...OPEN(), descriptorEvent({ version: 3, mode: 'one-shot', provider: 'p', label: 'l' })])),
      record('malformed', log([routeHeader(), ...OPEN(), descriptorEvent({ ...CONTINUABLE, toolFilter: { allow: 'read_file' } })])),
      record('v2', log([routeHeader(), ...OPEN(), descriptorEvent({ ...CONTINUABLE, version: 2 })])),
    ],
  });
  host.start();
  await settle();
  await nextPass();
  await nextPass();
  assert.equal(sends.length, 0);
  assert.equal(resumes.length, 0);
}));

test('R6-12 (fake host only) after a delivered child settles and is released, a later parent message is accepted', () => clocked(async () => {
  const { host, sends, services } = scenario({ sessions: [record('again', log(CHILD_OPEN()))] });
  const parentAgent = host.agents.get('parent');
  host.start();
  await settle();
  await nextPass();
  assert.equal(sends.length, 1);
  runTurn(host, host.agents.get('again'), 2, { kind: 'max-tokens' });
  await settle(10);
  // Assumption of the fake host: the host releases an idle child after its turn. Not verified live.
  host.agents.delete('again');
  const accepted = await services.subagents.sendMessage(parentAgent, 'again', [{ type: 'text', text: 'status?' }], { signal: new AbortController().signal });
  assert.equal(typeof accepted, 'string', 'the fake host returns a message id');
  assert.deepEqual(sentTexts(host.agents.get('again')), ['status?'], 'the parent message reaches the re-created child');
  await nextPass();
  assert.equal(sends.length, 2, 'the plugin sent nothing more; the second send is the test call');
}));

test('R6-13 a route that only the inherited prefix carries is not the child route: not continued', () => clocked(async () => {
  const inherited = [routeHeader()];
  const { host, sends, resumes } = scenario({
    sessions: [record('inh', log([...inherited, ...OPEN(), descriptorEvent(CONTINUABLE)]), { isSeeded: true }, { inheritedEventCount: inherited.length })],
  });
  host.start();
  await settle();
  await nextPass();
  assert.equal(sends.length, 0);
  assert.equal(resumes.length, 0);
}));

test('R6-14 the route in force when the child last ran must equal the pinned route, not an earlier one', () => clocked(async () => {
  const { host, sends, resumes } = scenario({
    sessions: [record('moved', log([routeHeader(), ...OPEN(), routeHeader({ provider: 'other', model: 'other-model' }), descriptorEvent(CONTINUABLE)]))],
  });
  host.start();
  await settle();
  await nextPass();
  assert.equal(sends.length, 0);
  assert.equal(resumes.length, 0);
}));

test('R6-15 a second engine in the same process does not continue a child the first engine continued', () => clocked(async () => {
  const sessions = [record('twice', log(CHILD_OPEN()))];
  const first = scenario({ sessions });
  first.host.start();
  await settle();
  await nextPass();
  assert.equal(first.sends.length, 1, 'the first engine continues the child once');
  // Re-applied engine: the first one is torn down and a second one starts in the same process.
  first.host.dispose();
  const second = scenario({ sessions });
  second.host.start();
  await settle();
  await nextPass();
  await nextPass();
  assert.equal(second.sends.length, 0, 'the second engine does not continue the child again');
  assert.equal(second.pluginResumes.length, 0);
}));

/** Eight active children hold every slot: the host refuses a ninth delivery. */
const FULL = { capacity: 8, occupied: ['slot-1', 'slot-2', 'slot-3', 'slot-4', 'slot-5', 'slot-6', 'slot-7', 'slot-8'] };

/** A real macrotask boundary. clocked() fakes only Date and setTimeout, so the engine's setImmediate attempt runs for real. */
const afterImmediate = () => new Promise((resolve) => setImmediate(resolve));

/**
 * A child settles in the host's order: dsh-agent-loop/lib/index.js:1701 emits agent/disposed, then dsh-subagent/lib/index.js
 * releases the slot at :1250 after the awaited disposal (:1242). Only microtasks sit between the emit and the release, so the
 * engine's setImmediate attempt runs after it. Inferred from source, not run live.
 */
async function settleChild(host, subagentService, slotId) {
  host.emitDisposed({ id: slotId });
  await settle();
  subagentService.freeSlot(slotId);
  await afterImmediate();
  await settle();
}

/** A disposal that frees no slot: the listener fires and the slot stays taken. */
async function disposeWithoutSlot(host, id) {
  host.emitDisposed({ id });
  await afterImmediate();
  await settle();
}

const sendsTo = (sends, id) => sends.filter((send) => send.targetId === id).length;

test('T-SLOT-1 a child refused at the active-child limit is delivered once, when a slot frees, before the window closes', () => clocked(async () => {
  const { host, sends, subagentService } = scenario({ ...FULL, sessions: [record('ninth', log(CHILD_OPEN()))] });
  host.start();
  await settle();
  assert.equal(sends.length, 1, 'refused at the limit');
  assert.equal(host.agents.get('ninth'), undefined, 'not delivered while every slot is taken');
  await settleChild(host, subagentService, 'slot-1');
  assert.equal(sends.length, 2, 'retried once a slot frees');
  assert.deepEqual(sentTexts(host.agents.get('ninth')), ['Continue'], 'delivered before the window closes');
  await nextPass();
  assert.equal(sends.length, 2, 'delivered once: no further send');
}));

test('T-SLOT-2 the window closes while a child waits: the drop is logged with its id, and nothing is sent after', () => clocked(async () => {
  const errors = [];
  const spy = mock.method(console, 'error', (...args) => { errors.push(args.join(' ')); });
  try {
    const { host, sends, subagentService } = scenario({ ...FULL, overrides: { freshMs: 2000 }, sessions: [record('late', log(CHILD_OPEN()))] });
    host.start();
    await settle();
    assert.equal(sends.length, 1, 'refused once, inside the window');
    await settle(2000);
    assert.ok(errors.some((line) => line.includes('dropped late: no activation slot before the boot window closed')), 'the drop is logged with the child id');
    await settleChild(host, subagentService, 'slot-1');
    assert.equal(sends.length, 1, 'no send after the window closed');
    assert.equal(host.agents.get('late'), undefined);
  } finally {
    spy.mock.restore();
  }
}));

test('T-SLOT-3 an admitted child is never sent again, however many agent/disposed events follow', () => clocked(async () => {
  const { host, sends, subagentService } = scenario({ ...FULL, sessions: [record('ninth', log(CHILD_OPEN()))] });
  host.start();
  await settle();
  await settleChild(host, subagentService, 'slot-1');
  assert.equal(sendsTo(sends, 'ninth'), 2, 'refused once, then admitted once');
  for (const id of ['slot-2', 'slot-3', 'slot-4']) await settleChild(host, subagentService, id);
  await disposeWithoutSlot(host, 'other');
  await nextPass();
  assert.equal(sendsTo(sends, 'ninth'), 2, 'no send after admission');
  assert.deepEqual(sentTexts(host.agents.get('ninth')), ['Continue'], 'one followup');
}));

test('T-SLOT-4 a refusal with any other code is not retried, and no agent/disposed event sends it again', () => clocked(async () => {
  const { host, sends } = scenario({
    sendFailure: Object.assign(new Error('not resumable'), { code: 'NOT_RESUMABLE' }),
    sessions: [record('refused', log(CHILD_OPEN()))],
  });
  host.start();
  await settle();
  assert.equal(sends.length, 1, 'one attempt');
  for (const id of ['slot-1', 'slot-2']) await disposeWithoutSlot(host, id);
  await nextPass();
  assert.equal(sends.length, 1, 'no retry, even after disposals');
  assert.equal(host.agents.get('refused'), undefined);
}));

test('T-SLOT-5 a disposal that frees no slot keeps the child waiting, and the next freed slot delivers it', () => clocked(async () => {
  const { host, sends, subagentService } = scenario({ ...FULL, sessions: [record('ninth', log(CHILD_OPEN()))] });
  host.start();
  await settle();
  await disposeWithoutSlot(host, 'slot-2');
  assert.equal(sendsTo(sends, 'ninth'), 2, 'retried on the disposal, still refused');
  assert.equal(host.agents.get('ninth'), undefined);
  await settleChild(host, subagentService, 'slot-1');
  assert.equal(sendsTo(sends, 'ninth'), 3, 'delivered when a slot frees');
  assert.deepEqual(sentTexts(host.agents.get('ninth')), ['Continue']);
}));

test('T-SLOT-6 dispose ends the wait: the listener is removed, and a slot freed afterwards sends nothing', () => clocked(async () => {
  const { host, sends, subagentService } = scenario({ ...FULL, sessions: [record('gone', log(CHILD_OPEN()))] });
  host.start();
  await settle();
  assert.equal(sends.length, 1, 'refused once, before dispose');
  assert.equal(host.listenerCount('agent/disposed'), 1, 'a listener waits for a slot');
  host.dispose();
  assert.equal(host.listenerCount('agent/disposed'), 0, 'dispose removes the listener');
  await settleChild(host, subagentService, 'slot-1');
  assert.equal(sends.length, 1, 'no send after dispose');
  assert.equal(host.agents.get('gone'), undefined);
}));

test('T-SLOT-7 a child delivered by one live engine is not sent again by another engine waiting for a slot in the same process', () => clocked(async () => {
  const waiting = scenario({ ...FULL, sessions: [record('shared', log(CHILD_OPEN()))] });
  waiting.host.start();
  await settle();
  assert.equal(sendsTo(waiting.sends, 'shared'), 1, 'the first engine is refused and waits');
  const delivering = scenario({ sessions: [record('shared', log(CHILD_OPEN()))] });
  delivering.host.start();
  await settle();
  await nextPass();
  assert.equal(sendsTo(delivering.sends, 'shared'), 1, 'the second engine delivers the child once');
  await disposeWithoutSlot(waiting.host, 'slot-1');
  await nextPass();
  assert.equal(sendsTo(waiting.sends, 'shared'), 1, 'the first engine does not send the admitted child again');
  assert.equal(waiting.host.agents.get('shared'), undefined);
}));

test('T-INHERIT-DESC a continuable descriptor found only in the inherited prefix does not make the child continuable', () => clocked(async () => {
  // The child's own events carry a logged route and an open turn, so only the descriptor decides.
  const inherited = [descriptorEvent(CONTINUABLE)];
  const { host, sends, resumes } = scenario({
    sessions: [record('prefix-only', log([...inherited, routeHeader(), ...OPEN()]), { isSeeded: true }, { inheritedEventCount: inherited.length })],
  });
  host.start();
  await settle();
  await nextPass();
  assert.equal(sends.length, 0, 'the child own events hold no descriptor, so the inherited one is not its own');
  assert.equal(resumes.length, 0);
}));

test('T-TIMEOUT-ABORT a delivery that never settles is aborted at the call timeout, retried once, and not retried again', () => clocked(async () => {
  const { host, sends } = scenario({ hang: true, sessions: [record('stuck', log(CHILD_OPEN()))] });
  host.start();
  await settle();
  assert.equal(sends.length, 1, 'one delivery started');
  const { signal } = sends[0].options;
  await settle(9000);
  assert.equal(signal.aborted, false, 'not aborted before the 10 s call timeout');
  await settle(1000);
  assert.equal(signal.aborted, true, 'the call timeout aborts the delivery signal');
  // F-4: the aborted call delivered nothing, so one retry goes through the normal path.
  await nextPass();
  assert.equal(sends.length, 2, 'one retry after the timed-out call');
  // The retry also times out. A second timeout is not retried.
  await settle(10000);
  await nextPass();
  await nextPass();
  assert.equal(sends.length, 2, 'a second timeout is not retried in this run');
}));

// ===== r8 slot-wait fixes (F-1 to F-5 and the dispose log). Each test awaits the condition it needs, with at most 50 setImmediate flushes. =====
/** Await a condition with at most `max` real setImmediate flushes. The caller asserts the outcome. */
async function until(condition, max = 50) {
  for (let i = 0; i < max && !condition(); i += 1) await afterImmediate();
  return condition();
}
const admissionRefusal = () => Object.assign(new Error('subagent limit reached (active child limit: 8)'), { name: 'SubagentError', code: 'ACTIVATION_LIMIT_REACHED' });
const continueSends = (sends, id) => sends.filter((send) => send.targetId === id && send.content[0].text === 'Continue').length;

test('T-F1 a setup failure that frees its slot with no event still lets the next waiter in, once', () => clocked(async () => {
  const { host, sends, resumes, subagentService } = scenario({
    ...FULL,
    sessions: [record('wa', log(CHILD_OPEN())), record('wb', log(CHILD_OPEN()))],
  });
  host.start();
  await settle();
  assert.equal(sendsTo(sends, 'wa'), 1, 'wa refused at the limit');
  assert.equal(sendsTo(sends, 'wb'), 1, 'wb refused at the limit');
  const realSend = subagentService.sendMessage.bind(subagentService);
  let failedOnce = false;
  subagentService.sendMessage = async (sender, targetId, content, options) => {
    if (targetId === 'wa' && !failedOnce) {
      failedOnce = true;
      sends.push({ sender, targetId, content, options });
      subagentService.active.add('wa');     // the host reserves a slot before it resumes the child
      await afterImmediate();
      subagentService.active.delete('wa');  // setup failed before publication: the slot is released with no event
      throw Object.assign(new Error('setup failed before publication'), { name: 'SubagentError', code: 'SETUP_FAILED' });
    }
    return realSend(sender, targetId, content, options);
  };
  host.emitDisposed({ id: 'slot-1' });      // one slot frees: both waiters get an attempt
  subagentService.freeSlot('slot-1');
  assert.ok(await until(() => host.agents.get('wb') !== undefined), 'wb is admitted after wa failed');
  assert.equal(resumes.filter((resume) => resume.resumeSessionId === 'wb').length, 1, 'wb resumed once');
  assert.deepEqual(sentTexts(host.agents.get('wb')), ['Continue']);
  assert.equal(host.agents.get('wa'), undefined, 'wa failed and is not admitted');
  assert.equal(sendsTo(sends, 'wa'), 2, 'wa is not retried after its setup failure');
  const admittedSends = sendsTo(sends, 'wb');
  await nextPass();
  assert.equal(sendsTo(sends, 'wb'), admittedSends, 'wb is not sent again once admitted');
}));

test('T-F2 a waiting child admitted by a parent message during the wait gets no Continue when a slot frees', () => clocked(async () => {
  const infos = [];
  const spy = mock.method(console, 'info', (...args) => { infos.push(args.join(' ')); });
  try {
    const { host, sends, subagentService } = scenario({ ...FULL, overrides: { verbose: true }, sessions: [record('wc', log(CHILD_OPEN()))] });
    const realSend = subagentService.sendMessage.bind(subagentService);
    subagentService.sendMessage = async (sender, targetId, content, options) => {
      // Mirrors deliverFollowup's resident branch (dsh-subagent index.js:1825-1841): a live child takes the message with no admission check.
      if (host.agents.has(targetId)) {
        sends.push({ sender, targetId, content, options });
        return 'resident';
      }
      return realSend(sender, targetId, content, options);
    };
    host.start();
    await settle();
    assert.equal(sendsTo(sends, 'wc'), 1, 'wc refused and waiting');
    const before = sends.length;
    subagentService.freeSlot('slot-1');
    await subagentService.sendMessage(host.agents.get('parent'), 'wc', [{ type: 'text', text: 'parent message' }], { signal: new AbortController().signal });
    assert.ok(host.agents.has('wc'), 'the parent message admitted wc');
    host.emitDisposed({ id: 'slot-2' });
    subagentService.freeSlot('slot-2');
    assert.ok(await until(() => host.listenerCount('agent/disposed') === 0), 'the waiter is dropped as live and the listener is removed');
    assert.equal(continueSends(sends.slice(before), 'wc'), 0, 'no Continue to a child that is already live');
    assert.deepEqual(sentTexts(host.agents.get('wc')), ['parent message']);
    assert.ok(infos.some((line) => line.includes('skip wc: already live; not continued')), 'the live drop is logged');
  } finally {
    spy.mock.restore();
  }
}));

test('T-F3 a release that lands inside a refused call still admits the waiter, with no drop', () => clocked(async () => {
  const errors = [];
  const spy = mock.method(console, 'error', (...args) => { errors.push(args.join(' ')); });
  try {
    const { host, sends, resumes, subagentService } = scenario({ ...FULL, sessions: [record('wb', log(CHILD_OPEN()))] });
    host.start();
    await settle();
    assert.equal(sendsTo(sends, 'wb'), 1, 'wb refused and waiting');
    const realSend = subagentService.sendMessage.bind(subagentService);
    let gapOnce = true;
    subagentService.sendMessage = async (sender, targetId, content, options) => {
      if (targetId === 'wb' && gapOnce) {
        gapOnce = false;
        sends.push({ sender, targetId, content, options });
        await Promise.resolve();              // the refusal is still travelling back through awaits
        host.emitDisposed({ id: 'slot-1' });  // a disposal and its release land inside that gap
        subagentService.freeSlot('slot-1');
        throw admissionRefusal();
      }
      return realSend(sender, targetId, content, options);
    };
    host.emitDisposed({ id: 'slot-2' });       // an unrelated disposal gives wb one attempt
    assert.ok(await until(() => host.agents.get('wb') !== undefined), 'wb is admitted by a retry after the gap release');
    assert.equal(resumes.filter((resume) => resume.resumeSessionId === 'wb').length, 1, 'wb resumed once');
    assert.deepEqual(sentTexts(host.agents.get('wb')), ['Continue']);
    assert.ok(!errors.some((line) => line.includes('dropped wb')), 'wb is not dropped');
  } finally {
    spy.mock.restore();
  }
}));

test('T-F4 after the last waiter is admitted, the agent/disposed listener and the window timer are released', () => clocked(async () => {
  const setFake = globalThis.setTimeout;
  const clearFake = globalThis.clearTimeout;
  const created = [];
  const cleared = new Set();
  globalThis.setTimeout = (callback, ms, ...rest) => {
    const handle = setFake(callback, ms, ...rest);
    created.push({ handle, ms });
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    cleared.add(handle);
    return clearFake(handle);
  };
  try {
    // freshMs 7000 keeps the window timer's 7000 ms delay distinct from the 3000 ms scan poll and the 10000 ms call timeout.
    const { host, subagentService } = scenario({ ...FULL, overrides: { freshMs: 7000 }, sessions: [record('ninth', log(CHILD_OPEN()))] });
    host.start();
    await settle();
    const windows = created.filter((timer) => timer.ms === 7000);
    assert.equal(windows.length, 1, 'one window timer while a child waits');
    assert.equal(host.listenerCount('agent/disposed'), 1, 'one listener while a child waits');
    await settleChild(host, subagentService, 'slot-1');
    assert.ok(await until(() => host.agents.get('ninth') !== undefined), 'ninth is admitted');
    assert.ok(await until(() => host.listenerCount('agent/disposed') === 0), 'the listener is removed after the last waiter');
    assert.ok(windows.every((timer) => cleared.has(timer.handle)), 'the window timer is cleared');
  } finally {
    globalThis.setTimeout = setFake;
    globalThis.clearTimeout = clearFake;
  }
}));

test('T-F5 dispose logs the drop of each child still waiting, once', () => clocked(async () => {
  const errors = [];
  const spy = mock.method(console, 'error', (...args) => { errors.push(args.join(' ')); });
  try {
    const { host, sends } = scenario({ ...FULL, sessions: [record('parked', log(CHILD_OPEN()))] });
    host.start();
    await settle();
    assert.equal(sendsTo(sends, 'parked'), 1, 'parked refused and waiting');
    host.dispose();
    assert.equal(errors.filter((line) => line.includes('dropped parked:')).length, 1, 'one drop line for the waiter');
    assert.equal(host.listenerCount('agent/disposed'), 0, 'dispose removes the listener');
  } finally {
    spy.mock.restore();
  }
}));

/*
 * F2-RACE (REPORT 6.8, 9.C). The host holds a child's lock through its cold resume, and the child is resident only after
 * the resume enters it. A boot Continue that waits on the lock, behind a parent message's cold resume, is delivered after
 * the child is resident. The host option skipIfResident refuses that call under the lock, so the Continue is not sent.
 * The fake mirrors the lock (runLocked) and the resident branch (subagentService.sendMessage).
 */
test('F2-RACE-BOOT a parent message that cold-resumes a child during the boot Continue gets no second Continue', () => clocked(async () => {
  const infos = [];
  const spy = mock.method(console, 'info', (...args) => { infos.push(args.join(' ')); });
  try {
    const { host, subagentService } = scenario({ overrides: { verbose: true }, sessions: [record('child', log(CHILD_OPEN()))] });
    // The parent message takes the child's lock and holds its cold resume before the child is resident. Armed before
    // host.start(), because the boot scan sends its Continue at start.
    const release = subagentService.holdColdResume();
    const parentSend = subagentService.sendMessage(host.agents.get('parent'), 'child', [{ type: 'text', text: 'parent message' }], { signal: new AbortController().signal });
    await settle();
    // The boot scan sends Continue. Its ctx.agents check passes (the child is not resident yet), so the call waits on the lock.
    host.start();
    await settle();
    await nextPass();
    release();
    await parentSend;
    await settle();
    await nextPass();
    assert.deepEqual(sentTexts(host.agents.get('child')), ['parent message'], 'the child receives the parent message once and no Continue');
    assert.ok(infos.some((line) => line.includes('skip child: already resident')), 'the admitted child is skipped and logged');
  } finally {
    spy.mock.restore();
  }
}));

test('F2-RACE-RETRY a parent message that cold-resumes a child waiting for a slot gets no Continue when the slot frees', () => clocked(async () => {
  const infos = [];
  const spy = mock.method(console, 'info', (...args) => { infos.push(args.join(' ')); });
  try {
    const { host, sends, subagentService } = scenario({ ...FULL, overrides: { verbose: true }, sessions: [record('wc', log(CHILD_OPEN()))] });
    host.start();
    await settle();
    assert.equal(sendsTo(sends, 'wc'), 1, 'wc refused at the limit and waiting');
    // A slot frees. The parent message then takes wc's lock and holds the cold resume before wc is resident.
    subagentService.freeSlot('slot-1');
    const release = subagentService.holdColdResume();
    const parentSend = subagentService.sendMessage(host.agents.get('parent'), 'wc', [{ type: 'text', text: 'parent message' }], { signal: new AbortController().signal });
    await settle();
    // The release schedules the waiter's attempt. Its ctx.agents check passes, so the attempt waits on the lock.
    host.emitDisposed({ id: 'slot-2' });
    await afterImmediate();
    await settle();
    release();
    await parentSend;
    await settle();
    assert.deepEqual(sentTexts(host.agents.get('wc')), ['parent message'], 'wc receives the parent message only');
    assert.ok(infos.some((line) => line.includes('skip wc: already resident')), 'the admitted waiter is skipped and logged');
    // The admitted child later leaves the registry (its turn ended). A later slot release must not send it a Continue.
    host.agents.delete('wc');
    const continuesBefore = continueSends(sends, 'wc');
    host.emitDisposed({ id: 'slot-3' });
    await afterImmediate();
    await settle();
    assert.equal(continueSends(sends, 'wc'), continuesBefore, 'a later slot release sends no Continue: the waiter left the waiting set');
  } finally {
    spy.mock.restore();
  }
}));

test('F2-GUARD-ORDER a parent message queued behind the boot Continue is still delivered, after it', () => clocked(async () => {
  const { host, subagentService } = scenario({ sessions: [record('child', log(CHILD_OPEN()))] });
  // The boot Continue is the first cold resume, so it takes the lock and holds before the child is resident (armed before start).
  const release = subagentService.holdColdResume();
  host.start();
  await settle();
  await nextPass();
  const parentSend = subagentService.sendMessage(host.agents.get('parent'), 'child', [{ type: 'text', text: 'parent message' }], { signal: new AbortController().signal });
  await settle();
  release();
  await parentSend;
  await settle();
  assert.deepEqual(sentTexts(host.agents.get('child')), ['Continue', 'parent message'], 'both messages, in lock order');
}));

test('F2-GUARD-FAILED a parent message whose cold resume fails leaves the boot Continue to deliver exactly once', () => clocked(async () => {
  const { host, subagentService } = scenario({ sessions: [record('child', log(CHILD_OPEN()))] });
  // The parent message holds the lock first (armed before start). The boot Continue then waits behind it.
  const fail = subagentService.holdColdResume();
  const parentSend = subagentService.sendMessage(host.agents.get('parent'), 'child', [{ type: 'text', text: 'parent message' }], { signal: new AbortController().signal });
  const rejected = assert.rejects(parentSend, /cold resume failed/);
  await settle();
  host.start();
  await settle();
  await nextPass();
  fail(new Error('cold resume failed'));
  await rejected;
  await settle();
  assert.ok(host.agents.has('child'), 'the boot Continue cold-resumed the child');
  assert.deepEqual(sentTexts(host.agents.get('child')), ['Continue'], 'exactly one Continue');
}));

/** Append one completed turn to a persisted child's log, as a run does: the child's own events grow after the listing. */
function ranTurn(records, id) {
  const stored = records.get(id);
  const seq = stored.events.length;
  stored.events.push(
    { type: 'turn/start', seq: seq + 1, time: Date.now(), data: { turn: 9 } },
    { type: 'turn/end', seq: seq + 2, time: Date.now(), data: { turn: 9, reason: 'completed' } },
  );
}

/*
 * F-3 (r9 reviewer, pre-existing). The boot scan lists a child. A parent message then runs that child, and the child leaves
 * the registry before its queued boot Continue. The Continue would cold-resume it a second time. The host option
 * skipIfRunSince refuses that call under the child's lock when the child started a turn after the listing (ALREADY_RAN).
 */
test('F-3 a boot Continue is not sent to a listed child that ran after the boot listing', () => clocked(async () => {
  const infos = [];
  const spy = mock.method(console, 'info', (...args) => { infos.push(args.join(' ')); });
  try {
    // scanLimit 1: pass 1 reaches only 'a', so 'b' stays listed and waiting until pass 2.
    const { host, resumes, records, sends, subagentService } = scenario({
      overrides: { verbose: true, scanLimit: 1 },
      sessions: [record('a', log(CHILD_OPEN())), record('b', log(CHILD_OPEN()))],
    });
    host.start();
    // Only the first pass (after the 10 ms grace) runs before the check: scanLimit 1 lets it continue one child.
    await settle(10);
    // Pass 1 continued one child. The other is listed and still waiting: that is the child a parent message will run.
    const waiting = ['a', 'b'].find((id) => continueSends(sends, id) === 0);
    assert.ok(waiting, 'one child is still listed and waiting after pass 1');
    // A parent message runs the waiting child. Its turn is logged, and it leaves the registry before pass 2.
    await subagentService.sendMessage(host.agents.get('parent'), waiting, [{ type: 'text', text: 'parent message' }], { signal: new AbortController().signal });
    ranTurn(records, waiting);
    host.agents.delete(waiting);
    await settle();
    await nextPass();
    assert.equal(resumes.filter((r) => r.resumeSessionId === waiting).length, 1, `${waiting} is cold-resumed once, by the parent message only`);
    assert.ok(infos.some((line) => line.includes(`skip ${waiting}: ran after the boot listing`)), 'the skip is logged with the child id');
  } finally {
    spy.mock.restore();
  }
}));

test('F-3 guard: a listed child that did not run after the listing is still continued by the boot Continue', () => clocked(async () => {
  const { host, resumes, sends } = scenario({ overrides: { scanLimit: 1 }, sessions: [record('a', log(CHILD_OPEN())), record('b', log(CHILD_OPEN()))] });
  host.start();
  await settle();
  await nextPass();
  await nextPass();
  assert.equal(sendsTo(sends, 'b'), 1, 'b is continued by its own boot Continue');
  assert.equal(resumes.filter((r) => r.resumeSessionId === 'b').length, 1, 'b is cold-resumed once');
  assert.deepEqual(sentTexts(host.agents.get('b')), ['Continue']);
}));

/*
 * P0-1 (r11, option B). The count is the child's own turn starts after its inherited prefix. The closer the host derives for an
 * open tail is a turn end, and an unrelated event logged after the listing is not a turn start. Neither refuses the boot Continue.
 * The open-tail test sets closerView, so the fake observes the closer the way the host does.
 */
test('P0-1 an open-tail child whose observation carries the closer for its open turn is continued once', () => clocked(async () => {
  const { host, resumes, sends } = scenario({ closerView: true, sessions: [record('child', log(CHILD_OPEN()))] });
  host.start();
  await settle();
  await nextPass();
  assert.equal(resumes.filter((r) => r.resumeSessionId === 'child').length, 1, 'the child is cold-resumed once, by its boot Continue');
  assert.equal(sendsTo(sends, 'child'), 1, 'one Continue is sent');
  assert.deepEqual(sentTexts(host.agents.get('child')), ['Continue'], 'the open-tail child receives its Continue');
}));

test('P0-1 an unrelated event logged after the boot listing does not refuse the boot Continue', () => clocked(async () => {
  // scanLimit 1: pass 1 reaches only 'a', so the other child stays listed and waiting until pass 2.
  const { host, resumes, records, sends } = scenario({
    overrides: { scanLimit: 1 },
    sessions: [record('a', log(CHILD_OPEN())), record('b', log(CHILD_OPEN()))],
  });
  host.start();
  await settle(10);
  const waiting = ['a', 'b'].find((id) => continueSends(sends, id) === 0);
  assert.ok(waiting, 'one child is still listed and waiting after pass 1');
  const stored = records.get(waiting);
  stored.events.push({ type: 'agent-preset/selected', seq: stored.events.length + 1, time: Date.now(), data: { preset: 'p' } });
  await nextPass();
  await nextPass();
  assert.equal(resumes.filter((r) => r.resumeSessionId === waiting).length, 1, `${waiting} is cold-resumed once, by its boot Continue`);
  assert.deepEqual(sentTexts(host.agents.get(waiting)), ['Continue'], 'the waiting child receives its Continue');
}));

/*
 * F-4 (r9 reviewer, pre-existing). The boot Continue queues behind a parent message's cold resume. The 10 s call timeout
 * aborts the queued call, and the parent's cold resume then fails. The aborted call delivers nothing (the host checks the
 * signal before it admits the child), so the Continue is lost. The fix retries the Continue once through the same path.
 */
test('F-4 a boot Continue that times out behind a parent cold resume is retried once, and delivered once when that resume fails', () => clocked(async () => {
  const { host, sends, subagentService } = scenario({ sessions: [record('child', log(CHILD_OPEN()))] });
  const fail = subagentService.holdColdResume();
  const parentSend = subagentService.sendMessage(host.agents.get('parent'), 'child', [{ type: 'text', text: 'parent message' }], { signal: new AbortController().signal });
  const rejected = assert.rejects(parentSend, /cold resume failed/);
  await settle();
  host.start();
  await settle();
  await nextPass();
  assert.equal(continueSends(sends, 'child'), 1, 'the boot Continue is sent and waits behind the held lock');
  // 10 s call timeout: the boot Continue is aborted. The parent cold resume is still held.
  await settle(10000);
  fail(new Error('cold resume failed'));
  await rejected;
  await settle();
  await nextPass();
  const child = host.agents.get('child');
  assert.ok(child, 'the retried Continue cold-resumed the child');
  assert.deepEqual(sentTexts(child), ['Continue'], 'exactly one Continue reaches the child');
}));

test('F-4 guard: a timed-out boot Continue and its retry are both refused when the parent cold resume succeeds late: one message', () => clocked(async () => {
  const { host, sends, subagentService } = scenario({ sessions: [record('child', log(CHILD_OPEN()))] });
  const release = subagentService.holdColdResume();
  const parentSend = subagentService.sendMessage(host.agents.get('parent'), 'child', [{ type: 'text', text: 'parent message' }], { signal: new AbortController().signal });
  await settle();
  host.start();
  await settle();
  await nextPass();
  await settle(10000);
  release();
  await parentSend;
  await settle();
  await nextPass();
  await nextPass();
  assert.deepEqual(sentTexts(host.agents.get('child')), ['parent message'], 'the child receives the parent message only');
  assert.ok(sendsTo(sends, 'child') >= 1);
}));

// ===== r11 fixes (A1 retry logging, A2 window guard). Each test asserts the log lines it names. =====
/** Capture the plugin's console lines for one test. Each line is prefixed with its console method. */
function captureLogLines() {
  const lines = [];
  const orig = { info: console.info, error: console.error, warn: console.warn };
  console.info = (...a) => lines.push(`info: ${a.join(' ')}`);
  console.error = (...a) => lines.push(`error: ${a.join(' ')}`);
  console.warn = (...a) => lines.push(`warn: ${a.join(' ')}`);
  return {
    lines,
    restore() {
      console.info = orig.info;
      console.error = orig.error;
      console.warn = orig.warn;
    },
  };
}
const NOT_RETRIED = '不再重试';
const errorLinesFor = (lines, id) => lines.filter((line) => line.startsWith('error:') && line.includes(id));

// A1 (r10 verifier P2-A). A Continue retry that fails after the outer 10 s wait has given up is logged once, as an error.
// The outer wait never prints "not retried" while a retry is due or in flight.
test('A1 a retry that fails 1 s after the outer wait gave up is logged once as an error, with no "not retried" line', () => clocked(async () => {
  const cap = captureLogLines();
  try {
    const { host, sends, subagentService } = scenario({ overrides: { verbose: true }, sessions: [record('gone', log(CHILD_OPEN()))] });
    subagentService.sendMessage = async (sender, targetId, content, options) => {
      sends.push({ sender, targetId, content, options });
      if (sends.length === 1) return new Promise(() => {});
      await new Promise((resolve) => setTimeout(resolve, 1000));
      throw Object.assign(new Error('subagent "gone" is unavailable'), { name: 'SubagentError', code: 'NOT_RESUMABLE' });
    };
    host.start();
    await settle();
    await settle(10000);           // t = 10 s: first call times out; the retry is sent; the outer wait gives up at the same instant
    await settle(1000);            // t = 11 s: the retry fails
    await settle();
    assert.equal(sends.length, 2, 'one retry after the timed-out call');
    assert.ok(cap.lines.some((line) => line.includes('retry gone')), 'the retry is logged');
    assert.equal(errorLinesFor(cap.lines, 'gone').length, 1, `exactly one error line for the failed retry; got ${JSON.stringify(cap.lines)}`);
    assert.equal(cap.lines.filter((line) => line.includes(NOT_RETRIED)).length, 0, 'no "not retried" line while a retry is in flight or after it failed');
  } finally {
    cap.restore();
  }
}));

// A1 (same microtask drain). The retry fails at once after it is sent at 10 s, so it settles with the outer wait.
test('A1 a retry that fails at once after the 10 s timeout is logged once as an error, with no "not retried" line', () => clocked(async () => {
  const cap = captureLogLines();
  try {
    const { host, sends, subagentService } = scenario({ overrides: { verbose: true }, sessions: [record('gone', log(CHILD_OPEN()))] });
    subagentService.sendMessage = async (sender, targetId, content, options) => {
      sends.push({ sender, targetId, content, options });
      if (sends.length === 1) return new Promise(() => {});
      throw Object.assign(new Error('subagent "gone" is unavailable'), { name: 'SubagentError', code: 'NOT_RESUMABLE' });
    };
    host.start();
    await settle();
    await settle(10000);
    await settle();
    assert.equal(sends.length, 2, 'one retry after the timed-out call');
    assert.equal(errorLinesFor(cap.lines, 'gone').length, 1, `exactly one error line; got ${JSON.stringify(cap.lines)}`);
    assert.equal(cap.lines.filter((line) => line.includes(NOT_RETRIED)).length, 0, 'no "not retried" line');
  } finally {
    cap.restore();
  }
}));

// A1 (second timeout). The retry also times out, at 20 s. Its failure is logged once as an error, and nothing else is.
test('A1 a retry that also times out is logged once as an error at 20 s, with no "not retried" line', () => clocked(async () => {
  const cap = captureLogLines();
  try {
    const { host, sends } = scenario({ hang: true, overrides: { verbose: true }, sessions: [record('stuck', log(CHILD_OPEN()))] });
    host.start();
    await settle();
    await settle(10000);           // t = 10 s: first call times out; retry sent
    await settle(10000);           // t = 20 s: retry times out
    await settle();
    assert.equal(sends.length, 2, 'one retry, then no third send');
    const errors = errorLinesFor(cap.lines, 'stuck');
    assert.equal(errors.length, 1, `exactly one error line; got ${JSON.stringify(cap.lines)}`);
    assert.ok(errors[0].includes('timed out'), 'the error line names the timeout');
    assert.equal(cap.lines.filter((line) => line.includes(NOT_RETRIED)).length, 0, 'no "not retried" line');
  } finally {
    cap.restore();
  }
}));

// A1 (real timers). Mock timers run a timer and its callbacks in one synchronous pass, so this is the only test that
// reproduces the production order: the retry fails in the same microtask drain as the 10 s timers, before the outer wait fires.
test('A1 real timers: a retry that fails in the drain of the 10 s timers is logged once, with no "not retried" line', async () => {
  globalThis[BOOT_CONTINUED]?.clear();
  const cap = captureLogLines();
  const { host, sends, subagentService } = scenario({ overrides: { verbose: true }, sessions: [record('gone', log(CHILD_OPEN()))] });
  subagentService.sendMessage = async (sender, targetId, content, options) => {
    sends.push({ sender, targetId, content, options });
    if (sends.length === 1) return new Promise(() => {});
    throw Object.assign(new Error('subagent "gone" is unavailable'), { name: 'SubagentError', code: 'NOT_RESUMABLE' });
  };
  try {
    host.start();
    await new Promise((resolve) => setTimeout(resolve, 11000));
    assert.equal(sends.length, 2, 'one retry after the timed-out call');
    assert.equal(errorLinesFor(cap.lines, 'gone').length, 1, `exactly one error line; got ${JSON.stringify(cap.lines)}`);
    assert.equal(cap.lines.filter((line) => line.includes(NOT_RETRIED)).length, 0, 'no "not retried" line');
  } finally {
    cap.restore();
    host.dispose();
  }
});

// A2 (r10 reviewer F-B, probe P3). The boot window closes before the first call times out: no retry is sent.
// Removing the window guard on the retry makes this test fail.
test('A2 a boot Continue whose first call times out after the boot window closed is not retried', () => clocked(async () => {
  const cap = captureLogLines();
  try {
    const { host, sends } = scenario({ hang: true, overrides: { verbose: true, freshMs: 5000 }, sessions: [record('stuck', log(CHILD_OPEN()))] });
    host.start();
    await settle();
    await settle(20000);
    await settle();
    assert.equal(sends.length, 1, 'no retry after the window closed');
    assert.equal(cap.lines.filter((line) => line.includes(NOT_RETRIED)).length, 1, 'the timeout is logged once as not retried');
  } finally {
    cap.restore();
  }
}));

// ===== r11 fix (F-A1 on the persisted boot path), round 4 (F-A2, H14, O2, M1). The boot loader judges a persisted
// child on the spiral signal, not on the last step being reasoning, and it tells the user when it refuses. =====

// F-A1 (r11 reviewer P2, round 4). A persisted continuable child whose own last turn ended max-tokens with a spiral
// reasoning-only message has no escalation path: the scanner skips subagent sessions and a child Continue never
// carries the loop text. It stays refused, and the refusal is a notice rather than a log line only.
test('F-A1-BOOT a persisted child whose last turn ended max-tokens with a spiral is not continued and the user is told', () => clocked(async () => {
  const cap = captureLogLines();
  try {
    const { host, resumes, sends, pluginResumes } = scenario({
      overrides: { verbose: true, notify: true, locale: 'en' },
      sessions: [record('spiral', log(CHILD_MAX_TOKENS(SPIRAL_REASONING)))],
    });
    host.start();
    const bridge = host.bridge();
    await settle();
    await nextPass();
    assert.equal(sends.length, 0, 'no Continue is sent');
    assert.equal(resumes.length, 0, 'the child is not cold-resumed either');
    assert.equal(pluginResumes.length, 0, 'the plugin never calls ctx.agents.resume for a child');
    assert.equal(host.agents.get('spiral'), undefined, 'the child stays unloaded');
    assert.ok(cap.lines.some((line) => line.includes('spiral') && line.includes('boot:turn/end:max-tokens')),
      `the boot-path stop is logged; got ${JSON.stringify(cap.lines)}`);
    const notices = bridge.frames.filter((frame) => frame.type === 'notice');
    assert.ok(notices.some((frame) => frame.notice.body.includes('subagent session')),
      `the refusal tells the user; got ${JSON.stringify(bridge.frames.map((frame) => frame.type))}`);
    bridge.close();
  } finally {
    cap.restore();
  }
}));

// F-A1 round 4 guard: the same child whose reasoning is not a spiral is an ordinary max-tokens turn and is continued
// once with the generic Continue text. Before round 4 this child was refused, so the round 3 filter fails here.
test('F-A1-BOOT guard a persisted max-tokens child without a spiral is continued once', () => clocked(async () => {
  const { host, sends } = scenario({
    sessions: [record('short', log(CHILD_MAX_TOKENS(REASONING_ONLY)))],
  });
  host.start();
  await settle();
  await nextPass();
  assert.equal(sends.length, 1, 'the ordinary max-tokens child is continued once');
  assert.deepEqual(sentTexts(host.agents.get('short')), ['Continue'], 'the child Continue carries the generic text');
}));

// F-A1 guard: the same child with visible text in its last committed message is continued, so the discriminator is
// the reasoning content, not the max-tokens end reason.
test('F-A1-BOOT guard a persisted max-tokens child with visible text is continued', () => clocked(async () => {
  const { host, sends } = scenario({
    sessions: [record('partial', log(CHILD_MAX_TOKENS(VISIBLE)))],
  });
  host.start();
  await settle();
  await nextPass();
  assert.equal(sends.length, 1, 'the control is continued once');
  assert.deepEqual(sentTexts(host.agents.get('partial')), ['Continue']);
}));

// ===== fixer2 F-1 (r11, P2). The boot-path max-tokens filter judges only the child's LAST turn. Shape R3 (an open
// turn after a max-tokens reasoning-only turn) is a crash orphan inside that open turn and is continued; shape R5
// (the max-tokens turn is the child's last turn) is still refused when its reasoning is a spiral. Both run in one pass.

// F-1 (r11 fixer 1 regression, reproduced by the sub-overseer probe). Without the fixer-2 restriction the filter
// matches R3's earlier turn/end and skips the orphan: this test then fails at the orphan assertion, sends.length 1.
test('F-1-BOOT an open turn after a max-tokens reasoning-only turn is continued, and a last-turn spiral is refused', () => clocked(async () => {
  const cap = captureLogLines();
  try {
    const { host, sends, pluginResumes } = scenario({
      overrides: { verbose: true },
      sessions: [
        record('spiral', log(CHILD_MAX_TOKENS(SPIRAL_REASONING))),
        record('orphan', log(CHILD_OPEN_AFTER_MAX_TOKENS())),
      ],
    });
    host.start();
    await settle();
    await nextPass();
    assert.ok(cap.lines.some((line) => line.includes('spiral') && line.includes('boot:turn/end:max-tokens')),
      `the last-turn spiral child is still refused; got ${JSON.stringify(cap.lines)}`);
    assert.equal(host.agents.get('spiral'), undefined, 'the last-turn child stays unloaded');
    assert.ok(!cap.lines.some((line) => line.includes('orphan') && line.includes('boot:turn/end:max-tokens')),
      `the max-tokens filter must not fire for an open turn; got ${JSON.stringify(cap.lines)}`);
    assert.equal(sends.length, 1, 'only the crash orphan is continued');
    assert.equal(sends[0].targetId, 'orphan', 'the Continue goes to the crash orphan');
    assert.deepEqual(sentTexts(host.agents.get('orphan')), ['Continue']);
    assert.equal(pluginResumes.length, 0, 'the plugin never calls ctx.agents.resume for a child');
  } finally {
    cap.restore();
  }
}));

// ===== Round 6: a child whose parent the same boot pass resumes waits for that parent instead of being dropped =====
// The defect, observed 2026-10-20 after a host restart at 01:35:10: the boot path queued a child that carried a valid
// continuable descriptor, then dropped it at delivery with "the parent is not live, so the child is not continued",
// because the parent session was resumed by that same boot pass and was not live yet. One line, no retry, no child.

/** Publish an agent under `id`, as the host does when a boot resume completes: agent/created on the agent's carrier. */
function publishParent(host, id = 'parent') {
  const agent = host.agent(id);
  agent.id = id;
  host.emitCreated(agent);
  return agent;
}

test('PARENT-1 a child whose parent is published after the first attempt is continued exactly once', () => clocked(async () => {
  const { host, sends } = scenario({ parent: false, sessions: [record('kid', log(CHILD_OPEN()))] });
  host.start();
  await settle();
  await nextPass();
  assert.equal(sends.length, 0, 'nothing is sent while the parent is not live');
  assert.equal(host.agents.get('kid'), undefined, 'the child is not resumed without a sender');
  assert.equal(host.listenerCount('agent/created'), 1, 'the child waits for its parent to be published');
  const parentAgent = publishParent(host);
  await afterImmediate();
  await settle();
  assert.equal(sends.length, 1, 'continued once the parent is live');
  assert.equal(sends[0].sender, parentAgent, 'the sender is the parent the host published');
  assert.equal(sends[0].targetId, 'kid');
  assert.deepEqual(sentTexts(host.agents.get('kid')), ['Continue']);
  // A second publication of the same parent, and a later scan pass, send no second Continue.
  host.emitCreated(parentAgent);
  await afterImmediate();
  await nextPass();
  assert.equal(sends.length, 1, 'no duplicate continuation');
  assert.equal(host.agents.get('kid').followups.length, 1);
  assert.equal(host.listenerCount('agent/created'), 0, 'the wait ends once the child is delivered');
}));

test('PARENT-2 the reported shape: the parent resume outlives the 10 s call timeout, and the child is still waited for', () => clocked(async () => {
  const cap = captureLogLines();
  try {
    const { host, sends, pluginResumes } = scenario({
      parent: false,
      overrides: { verbose: true },
      // The boot pass resumes the parent through ctx.agents.resume, and that host call settles only after 12 s.
      resumeDelay: { parent: 12_000 },
      sessions: [
        record('kid', log(CHILD_OPEN()), { delegationDepth: 1 }),
        record('parent', log(OPEN()), { origin: undefined, parentSession: undefined }),
      ],
    });
    host.start();
    await settle();
    await nextPass();
    assert.deepEqual(pluginResumes.map((options) => options.resumeSessionId), ['parent'], 'the parent resume started first');
    await settle(8_000);
    assert.equal(sends.length, 0, 'the parent was not live at the first delivery attempt');
    assert.equal(host.agents.get('parent'), undefined, 'the stalled parent resume published nothing yet');
    assert.ok(cap.lines.some((line) => line.includes('kid') && line.includes('is waiting for the parent session parent')),
      `the child waits for the parent; got ${JSON.stringify(cap.lines)}`);
    await settle(1_500);
    await afterImmediate();
    await settle();
    assert.equal(sends.length, 1, 'continued once the stalled parent resume publishes the parent');
    assert.equal(sends[0].targetId, 'kid');
    assert.equal(sends[0].sender, host.agents.get('parent'), 'the sender is the parent that finally published');
    assert.deepEqual(sentTexts(host.agents.get('kid')), ['Continue']);
  } finally {
    cap.restore();
  }
}));

test('PARENT-3 a parent that never goes live ends the wait at the boot window close, with nothing sent and no listener left', () => clocked(async () => {
  const cap = captureLogLines();
  try {
    const { host, sends } = scenario({
      parent: false,
      // One minute of boot window instead of the 15 minute default, so the bounded end is reached inside the test.
      overrides: { freshMs: 60_000 },
      sessions: [record('unmet', log(CHILD_OPEN()))],
    });
    host.start();
    await settle();
    await nextPass();
    assert.equal(sends.length, 0);
    assert.equal(host.listenerCount('agent/created'), 1, 'a listener waits for the parent');
    await settle(60_000);
    assert.ok(cap.lines.some((line) => line.includes('dropped unmet') && line.includes('its parent was not live before the boot window closed')),
      `the deferred child is dropped with its id; got ${JSON.stringify(cap.lines)}`);
    assert.equal(host.listenerCount('agent/created'), 0, 'the window close removes the parent listener');
    assert.equal(host.listenerCount('agent/disposed'), 0, 'the window close removes the slot listener');
    // A parent published after the window, and a slot release, send nothing: the wait is over and never restarts.
    publishParent(host);
    host.emitDisposed({ id: 'slot-1' });
    await afterImmediate();
    await settle();
    assert.equal(sends.length, 0, 'no delivery after the boot window closed');
    assert.equal(host.agents.get('unmet'), undefined);
  } finally {
    cap.restore();
  }
}));

test('PARENT-4 an archived parent is still skipped at once, with no wait and no listener', () => clocked(async () => {
  const cap = captureLogLines();
  try {
    const { host, sends } = scenario({
      archived: ['parent'],
      overrides: { verbose: true },
      sessions: [record('kin', log(CHILD_OPEN()))],
    });
    host.start();
    await settle();
    await nextPass();
    assert.equal(sends.length, 0, 'nothing is sent to a child of an archived parent');
    assert.equal(host.listenerCount('agent/created'), 0, 'an archived parent is never waited for');
    assert.ok(cap.lines.some((line) => line.includes('skip kin') && line.includes('the parent is archived or unknown')),
      `the archived skip line is unchanged; got ${JSON.stringify(cap.lines)}`);
  } finally {
    cap.restore();
  }
}));

test('PARENT-5 a child that became resident while it waited gets no Continue when the parent publishes', () => clocked(async () => {
  const cap = captureLogLines();
  try {
    const { host, sends } = scenario({
      parent: false,
      overrides: { verbose: true },
      sessions: [record('res', log(CHILD_OPEN()))],
    });
    host.start();
    await settle();
    await nextPass();
    assert.equal(host.listenerCount('agent/created'), 1, 'the child waits for its parent');
    // The child is admitted by another route while it waits, as a parent message cold-resumes a child.
    const resident = host.agent('res');
    resident.id = 'res';
    publishParent(host);
    await afterImmediate();
    await settle();
    assert.equal(sends.length, 0, 'a resident child is never sent Continue');
    assert.equal(host.agents.get('res').followups.length, 0, 'nothing reaches the resident child');
    assert.ok(cap.lines.some((line) => line.includes('skip res') && line.includes('already live; not continued')),
      `the residency skip is unchanged on the retry path; got ${JSON.stringify(cap.lines)}`);
    assert.equal(host.listenerCount('agent/created'), 0, 'the wait ends without a delivery');
  } finally {
    cap.restore();
  }
}));

test('PARENT-6 dispose drops a child still waiting for its parent, and the drop line names that wait', () => clocked(async () => {
  const cap = captureLogLines();
  try {
    const { host, sends } = scenario({ parent: false, sessions: [record('cut', log(CHILD_OPEN()))] });
    host.start();
    await settle();
    await nextPass();
    assert.equal(host.listenerCount('agent/created'), 1, 'the child waits for its parent');
    host.dispose();
    assert.ok(cap.lines.some((line) => line.includes('dropped cut') && line.includes('the runner was disposed before its parent became live')),
      `the dispose drop line names the parent wait; got ${JSON.stringify(cap.lines)}`);
    assert.equal(host.listenerCount('agent/created'), 0, 'dispose removes the parent listener');
    publishParent(host);
    await afterImmediate();
    await settle();
    assert.equal(sends.length, 0, 'no delivery after dispose');
  } finally {
    cap.restore();
  }
}));
