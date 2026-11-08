/**
 * Boot loader for persisted sessions that are not live (T1-T28e, plus T23, T24, T25, T26 and T29).
 * The fake resume mirrors the host: it appends an `interrupted` closer to an open turn, runs setup,
 * then publishes the agent with the persisted events and header. Like the host, it publishes after an await.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { makeHost } from './host-fixture.mjs';

/** A real timer, captured before the fake clock replaces the global, so a test can wait for real disk writes. */
const realSetTimeout = setTimeout;
// Polls for the record instead of sleeping a fixed time: on a loaded machine the fs write
// behind the 2 s coalescing timer lands well after any fixed wait that keeps the suite fast.
const diskSettled = async (attempts = 500) => {
  const file = join(process.env.DSH_HOME, 'auto-continue-settled.json');
  for (let i = 0; i < attempts; i += 1) {
    try {
      const record = JSON.parse(readFileSync(file, 'utf8'));
      if (record && record.entries && Object.keys(record.entries).length > 0) return record;
      throw new Error('no entries yet');
    } catch {
      await new Promise((resolve) => { realSetTimeout(resolve, 10); });
    }
  }
  throw new Error('the settled record did not appear');
};

const settle = async (ms = 0) => {
  mock.timers.tick(ms);
  for (let i = 0; i < 100; i += 1) await Promise.resolve();
};
/** One scan pass (3 s poll) plus the default graceMs of 10 ms, so a session loaded or scheduled in that pass is continued. */
const nextPass = async () => {
  await settle(3000);
  await settle(10);
};

/** Stamp a log: sequence numbers follow array order, every event carries one time. */
const log = (items, time = Date.now()) => items.map((item, index) => ({ ...item, seq: index + 1, time }));
const turnStart = (turn) => ({ type: 'turn/start', data: { turn } });
const turnEnd = (turn, reason) => ({ type: 'turn/end', data: { turn, reason } });
const userPrompt = () => ({ type: 'user/message', data: { source: { kind: 'user' } } });
const requestHeader = (provider, model, extra = {}) => ({
  type: 'request/header',
  data: { header: { config: { provider, model, ...extra } }, reason: 'initial' },
});
const presetSelected = (agentPreset) => ({ type: 'agent-preset/selected', data: { agentPreset } });
const failureReason = (status, code, message) => ({ kind: 'error', error: { code, status, message } });
const INTERRUPTED = { kind: 'interrupted' };
/** A crash orphan: a turn started and never ended. */
const OPEN = () => [turnStart(1), userPrompt()];
const record = (id, events, header = {}) => ({
  header: { id, version: 1, createdAt: Date.now(), cwd: '/work', isSeeded: false, ...header },
  events,
  revision: 'r1',
});

/** Turn number of the last turn that was started and never ended, or undefined. */
function openTurn(events) {
  const last = events.filter((event) => event.type === 'turn/start').at(-1);
  if (last === undefined) return undefined;
  return events.some((event) => event.type === 'turn/end' && event.seq > last.seq) ? undefined : last.data.turn;
}

/** Persisted-session service: read-only opens, with counters the tests assert on. */
function persistence(records, { listFailures = 0, listGate, openGate, statDelay = {} } = {}) {
  const state = { lists: 0, opens: [], reads: 0, stats: 0, statted: [], closes: 0, failuresLeft: listFailures };
  return {
    state,
    async list() {
      state.lists += 1;
      if (listGate !== undefined) await listGate;
      if (state.failuresLeft > 0) {
        state.failuresLeft -= 1;
        throw new Error('list unavailable');
      }
      return [...records.values()].map(({ header, revision }) => ({ header, revision }));
    },
    async stat(id) {
      state.stats += 1;
      state.statted.push(id);
      // A slow backend: the wait happens on the fake clock, so the test decides when it ends.
      const delay = statDelay[id];
      if (delay !== undefined) await new Promise((resolve) => setTimeout(resolve, delay));
      const stored = records.get(id);
      return stored === undefined ? undefined : { header: stored.header, revision: stored.revision };
    },
    async open(id, access) {
      state.opens.push({ id, access });
      if (openGate !== undefined) await openGate;
      const stored = records.get(id);
      if (stored === undefined) throw new Error(`no session ${id}`);
      return {
        header: stored.header,
        // The real store's read handle always reports this (a getter over its state, 0 by default); mirror it so a
        // backend-capability gap cannot masquerade as a log fact.
        get inheritedEventCount() { return stored.inheritedEventCount ?? 0; },
        async stat() { return { header: stored.header, revision: stored.revision }; },
        async read() { state.reads += 1; return { eventState: 'owned', events: [...stored.events] }; },
        async close() { state.closes += 1; },
      };
    },
  };
}

const hosts = [];

/** One fake host with a persisted store. Services default to an empty archive and a default model. */
function scenario({
  sessions = [], overrides = {}, services = {}, resumeError, listFailures, listGate, openGate, statDelay = {}, hangResume = [], resumeDelay = {},
} = {}) {
  const records = new Map(sessions.map((item) => [item.header.id, item]));
  const store = persistence(records, { listFailures, listGate, openGate, statDelay });
  const resumes = [];
  const disposals = [];
  const published = [];
  const subagentSends = [];
  const host = makeHost(overrides, {
    services: {
      workspaceRegistry: { archivedSessionIds: [] },
      agentDefaultModel: { currentSelection: () => ({ provider: 'dp', model: 'dm' }) },
      sessionPersistence: store,
      subagents: {
        get active() { return new Set(); },
        freeSlot() {},
        async sendMessage(sender, targetId, content, options) {
          subagentSends.push({ sender: sender?.id, targetId, content, options });
          return `msg-${subagentSends.length}`;
        },
      },
      ...services,
    },
    async resume(options) {
      resumes.push({ ...options, startedAt: Date.now() });
      if (hangResume.includes(options.resumeSessionId)) return new Promise(() => {});
      if (resumeError !== undefined) throw resumeError;
      await Promise.resolve();
      if (resumeDelay[options.resumeSessionId] !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, resumeDelay[options.resumeSessionId]));
      }
      const stored = records.get(options.resumeSessionId);
      const turn = openTurn(stored.events);
      if (turn !== undefined) {
        const tail = stored.events.at(-1);
        stored.events.push({ type: 'turn/end', seq: tail.seq + 1, time: tail.time, data: { turn, reason: INTERRUPTED } });
      }
      if (options.setup !== undefined) await options.setup({ sessionId: stored.header.id }, undefined);
      const agent = host.agent(stored.header.id, stored.events);
      agent.session.header = stored.header;
      published.push(agent);
      return {
        agent,
        async dispose() {
          disposals.push(agent.session.id);
          host.agents.delete(agent.session.id);
        },
      };
    },
  });
  hosts.push(host);
  return { host, resumes, store, records, disposals, published, subagentSends };
}

/** Run one scenario under a fake clock; disposes every host it created. */
async function clocked(run) {
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  try {
    await run();
  } finally {
    for (const host of hosts.splice(0)) host.dispose();
    mock.timers.reset();
  }
}

test('T1 interrupted persisted session is resumed once and continued once after graceMs', () => clocked(async () => {
  const { host, resumes, store, records } = scenario({
    sessions: [record('a', log(OPEN()))],
    overrides: { graceMs: 500 },
  });
  host.start();
  await settle();
  assert.equal(resumes.length, 1, 'resumed once');
  assert.equal(resumes[0].resumeSessionId, 'a');
  assert.equal(host.agents.get('a').followups.length, 0, 'nothing is sent before graceMs');
  await settle(3000);
  assert.equal(host.agents.get('a').followups.length, 0, 'the next scan pass schedules it; still nothing is sent');
  await settle(500);
  assert.equal(host.agents.get('a').followups.length, 1, 'continued once after graceMs');
  await settle(3000);
  assert.equal(resumes.length, 1, 'no second resume');
  assert.equal(host.agents.get('a').followups.length, 1, 'no second continuation');
  const ends = records.get('a').events.filter((event) => event.type === 'turn/end');
  assert.deepEqual(ends.map((event) => event.data.reason.kind), ['interrupted'], 'the host closer is persisted');
  assert.ok(store.state.opens.every((open) => open.access === 'read'), 'the loader never takes write ownership');
}));

test('T2 interrupted, transient error and max-tokens histories each resume once and continue once', () => clocked(async () => {
  const { host, resumes } = scenario({
    sessions: [
      record('interrupted', log([turnStart(1), turnEnd(1, INTERRUPTED)])),
      record('transient', log([turnStart(1), turnEnd(1, failureReason(503, 'UPSTREAM', 'upstream timeout'))])),
      record('max', log([turnStart(1), turnEnd(1, { kind: 'max-tokens' })])),
    ],
  });
  host.start();
  await settle();
  await nextPass();
  assert.deepEqual(resumes.map((resume) => resume.resumeSessionId).sort(), ['interrupted', 'max', 'transient']);
  for (const id of ['interrupted', 'transient', 'max']) {
    assert.equal(host.agents.get(id).followups.length, 1, `${id} is continued once`);
  }
}));

test('T3 completed history is neither resumed nor continued', () => clocked(async () => {
  const { host, resumes } = scenario({
    sessions: [record('done', log([turnStart(1), turnEnd(1, { kind: 'completed' })]))],
  });
  host.start();
  await settle();
  await settle(3000);
  assert.equal(resumes.length, 0);
  assert.equal(host.agents.size, 0);
}));

test('T4 archived interrupted session is neither resumed nor continued', () => clocked(async () => {
  const { host, resumes } = scenario({
    sessions: [record('archived', log(OPEN()))],
    services: { workspaceRegistry: { archivedSessionIds: ['archived'] } },
  });
  host.start();
  await settle();
  await settle(3000);
  assert.equal(resumes.length, 0);
  assert.equal(host.agents.size, 0);
}));

test('T5 manually stopped session (aborted, user) is neither resumed nor continued', () => clocked(async () => {
  const { host, resumes } = scenario({
    sessions: [record('stopped', log([turnStart(1), turnEnd(1, { kind: 'aborted', reason: { kind: 'user' } })]))],
  });
  host.start();
  await settle();
  await settle(3000);
  assert.equal(resumes.length, 0);
  assert.equal(host.agents.size, 0);
}));

test('T6 subagent session is never resumed', () => clocked(async () => {
  const { host, resumes } = scenario({
    sessions: [record('child', log(OPEN()), { origin: 'subagent', parentSession: 'parent' })],
  });
  host.start();
  await settle();
  await settle(3000);
  assert.equal(resumes.length, 0);
  assert.equal(host.agents.size, 0);
}));

test('T7 permanent error (401) is not resumed', () => clocked(async () => {
  const { host, resumes } = scenario({
    sessions: [record('denied', log([turnStart(1), turnEnd(1, failureReason(401, 'AUTH', 'invalid credentials'))]))],
  });
  host.start();
  await settle();
  await settle(3000);
  assert.equal(resumes.length, 0);
  assert.equal(host.agents.size, 0);
}));

test('T8 an id that is already live is never resumed again', () => clocked(async () => {
  const { host, resumes } = scenario({
    sessions: [record('same', log([turnStart(1), turnEnd(1, INTERRUPTED)]))],
  });
  host.agent('same', log([turnStart(1), turnEnd(1, INTERRUPTED)]));
  host.start();
  await settle();
  await settle(3000);
  assert.equal(resumes.length, 0, 'no resume for a live id');
  assert.equal(host.agents.size, 1, 'no second agent');
  assert.equal(host.agents.get('same').followups.length, 1, 'the live agent is continued once by the scanner');
}));

test('T9 several passes produce exactly one resume and one continuation per session', () => clocked(async () => {
  const { host, resumes } = scenario({ sessions: [record('a', log(OPEN()))] });
  host.start();
  await settle();
  for (let pass = 0; pass < 5; pass += 1) await settle(3000);
  assert.equal(resumes.length, 1);
  assert.equal(host.agents.get('a').followups.length, 1);
}));

test('T10 scanLimit 1 resumes at most one session per pass and all three within the window', () => clocked(async () => {
  const now = Date.now();
  const { host, resumes } = scenario({
    sessions: [
      record('a', log(OPEN(), now - 3000)),
      record('b', log(OPEN(), now - 2000)),
      record('c', log(OPEN(), now - 1000)),
    ],
    overrides: { scanLimit: 1 },
  });
  host.start();
  await settle();
  assert.deepEqual(resumes.map((resume) => resume.resumeSessionId), ['c'], 'newest first, one per pass');
  await settle(3000);
  assert.deepEqual(resumes.map((resume) => resume.resumeSessionId), ['c', 'b'], 'one more per pass');
  await settle(3000);
  assert.deepEqual(resumes.map((resume) => resume.resumeSessionId), ['c', 'b', 'a'], 'all three resumed');
  await nextPass();
  for (const id of ['a', 'b', 'c']) assert.equal(host.agents.get(id).followups.length, 1, `${id} is continued once`);
  assert.equal(resumes.length, 3);
}));

test('T11 paused engine resumes nothing and loads after unpause within the window', () => clocked(async () => {
  const { host, resumes } = scenario({
    sessions: [record('a', log(OPEN()))],
    overrides: { paused: true },
  });
  host.start();
  await settle();
  await settle(3000);
  assert.equal(resumes.length, 0, 'nothing is resumed while paused');
  host.config.paused = false;
  await settle(3000);
  await settle(10);
  assert.equal(resumes.length, 1, 'resumed after unpause');
  await nextPass();
  assert.equal(host.agents.get('a').followups.length, 1, 'continued after unpause');
}));

test('T12 history older than freshMs is not resumed', () => clocked(async () => {
  const now = Date.now();
  const { host, resumes } = scenario({
    sessions: [record('stale', log(OPEN(), now - 120_000))],
    overrides: { freshMs: 60_000 },
  });
  host.start();
  await settle();
  await settle(3000);
  await settle(3000);
  assert.equal(resumes.length, 0);
  assert.equal(host.agents.size, 0);
}));

test('T13 writer conflict and other resume failures are attempted once and never retried', () => clocked(async () => {
  const owned = Object.assign(new Error('owned elsewhere'), { name: 'SessionAlreadyOwnedError' });
  const conflict = scenario({ sessions: [record('a', log(OPEN()))], resumeError: owned });
  conflict.host.start();
  await settle();
  for (let pass = 0; pass < 4; pass += 1) await settle(3000);
  assert.equal(conflict.resumes.length, 1, 'SessionAlreadyOwnedError: one attempt');
  assert.equal(conflict.host.agents.size, 0);

  const logged = mock.method(console, 'error', () => {});
  try {
    const broken = scenario({ sessions: [record('b', log(OPEN()))], resumeError: new Error('setup failed') });
    broken.host.start();
    await settle();
    for (let pass = 0; pass < 4; pass += 1) await settle(3000);
    assert.equal(broken.resumes.length, 1, 'other failure: one attempt, no retry loop');
    assert.equal(broken.host.agents.size, 0);
    assert.equal(logged.mock.callCount(), 1, 'the failure is logged once');
  } finally {
    logged.mock.restore();
  }
}));

test('T14a missing sessionPersistence does not throw and the live scan still continues a live agent', () => clocked(async () => {
  const { host, resumes } = scenario({ services: { sessionPersistence: undefined } });
  host.agent('live', log([turnStart(1), turnEnd(1, INTERRUPTED)]));
  host.start();
  await settle();
  await settle(10);
  assert.equal(resumes.length, 0);
  assert.equal(host.agents.get('live').followups.length, 1, 'the live scan runs in the same pass');
  await settle(3000);
  assert.equal(host.agents.get('live').followups.length, 1, 'continued once');
}));

test('T14b a failing list() does not throw, and enumeration succeeds on a later pass', () => clocked(async () => {
  const { host, resumes, store } = scenario({
    sessions: [record('late', log(OPEN()))],
    listFailures: 1,
  });
  host.agent('live', log([turnStart(1), turnEnd(1, INTERRUPTED)]));
  host.start();
  await settle();
  await settle(10);
  assert.equal(resumes.length, 0, 'the first list() failed');
  assert.equal(host.agents.get('live').followups.length, 1, 'the live scan still ran');
  await settle(3000);
  assert.equal(resumes.length, 1, 'enumeration retried and the persisted session was resumed');
  await nextPass();
  assert.equal(host.agents.get('late').followups.length, 1, 'the persisted session is continued once');
  assert.equal(store.state.lists, 2);
}));

test('T14c a list() that never settles does not stop the live scan, and later passes still run', () => clocked(async () => {
  const { host, resumes } = scenario({ listGate: new Promise(() => {}) });
  host.agent('live', log([turnStart(1), turnEnd(1, INTERRUPTED)]));
  host.start();
  await settle();
  await settle(10);
  assert.equal(host.agents.get('live').followups.length, 1, 'the live agent is continued once although list() never settles');
  await settle(12_000);
  host.agent('later', log([turnStart(1), turnEnd(1, INTERRUPTED)]));
  await nextPass();
  assert.equal(host.agents.get('later').followups.length, 1, 'a scan pass after the call timeout still continues a new live agent');
  assert.equal(host.agents.get('live').followups.length, 1, 'the earlier live agent is not continued again');
  assert.equal(resumes.length, 0, 'nothing is resumed');
}));

test('T14d a resume that never settles is not retried, and the other eligible session still resumes once', () => clocked(async () => {
  const now = Date.now();
  const { host, resumes } = scenario({
    sessions: [record('other', log(OPEN(), now - 2000)), record('stuck', log(OPEN(), now - 1000))],
    hangResume: ['stuck'],
  });
  host.start();
  await settle();
  await settle(10_000);
  assert.deepEqual(resumes.map((resume) => resume.resumeSessionId), ['stuck', 'other'], 'other resumes after the stalled call times out');
  await nextPass();
  assert.equal(host.agents.get('other').followups.length, 1, 'other is continued once');
  await settle(20_000);
  assert.equal(resumes.filter((resume) => resume.resumeSessionId === 'stuck').length, 1, 'the stalled session is not resumed again');
  assert.equal(host.agents.has('stuck'), false, 'no agent exists for the stalled session');
  assert.equal(host.agents.size, 1, 'no duplicate agent');
  assert.equal(host.agents.get('other').followups.length, 1, 'other is still continued once');
}));

test('T14e a stalled list() is never repeated while in flight, and its late result is used once', () => clocked(async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { host, resumes, store } = scenario({ sessions: [record('late', log(OPEN()))], listGate: gate });
  host.start();
  await settle();
  for (let pass = 0; pass < 6; pass += 1) await settle(3000);
  assert.equal(store.state.lists, 1, 'one list() call while the first is still in flight');
  assert.equal(resumes.length, 0, 'nothing is resumed before list() settles');
  release();
  await nextPass();
  assert.deepEqual(resumes.map((resume) => resume.resumeSessionId), ['late'], 'the late result resumes its session once');
  await nextPass();
  assert.equal(store.state.lists, 1, 'the late result is used without a second list() call');
  assert.equal(resumes.length, 1, 'no second resume');
  assert.equal(host.agents.get('late').followups.length, 1, 'the resumed session is continued once');
}));

test('T15 resume passes the logged route, mounts the stored preset, and omits reasoningEffort', () => clocked(async () => {
  const mounted = [];
  const resolved = [];
  const presets = {
    async resolve(id) { resolved.push(id); return { id: id ?? 'default' }; },
    async mount(ctx, id) { mounted.push({ ctx, id }); return { id }; },
  };
  const { host, resumes } = scenario({
    sessions: [record('routed', log([
      requestHeader('old', 'old-model'),
      presetSelected('preset-a'),
      requestHeader('p1', 'm1', { reasoningEffort: 'high' }),
      turnStart(1),
      userPrompt(),
    ]), { agentPreset: 'preset-header' })],
    services: { agentPresets: presets },
  });
  host.start();
  await settle();
  assert.equal(resumes.length, 1);
  assert.deepEqual(resumes[0].agentOptions, { provider: 'p1', model: 'm1' }, 'the last request/header route');
  assert.equal('reasoningEffort' in resumes[0].agentOptions, false, 'reasoningEffort is not passed');
  assert.deepEqual(resolved, ['preset-a'], 'the newest agent-preset/selected wins over the header');
  assert.deepEqual(mounted.map((entry) => entry.id), ['preset-a'], 'setup mounts the stored preset');

  const plain = scenario({ sessions: [record('plain', log(OPEN()))] });
  plain.host.start();
  await settle();
  assert.equal(plain.resumes.length, 1);
  assert.equal(plain.resumes[0].setup, undefined, 'no setup without agentPresets');
  assert.deepEqual(plain.resumes[0].agentOptions, { provider: 'dp', model: 'dm' }, 'falls back to the default model');

  const unrouted = scenario({
    sessions: [record('none', log(OPEN()))],
    services: { agentDefaultModel: undefined },
  });
  unrouted.host.start();
  await settle();
  await settle(3000);
  assert.equal(unrouted.resumes.length, 0, 'no route in the log and no default model: skipped');
}));

test('T16 the built lib/index.js contains the boot loader', () => {
  const built = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  assert.match(built, /loadInterruptedPersisted/);
  assert.match(built, /resumePersisted/);
});

test('T18 an ended turn older than freshMs is neither resumed nor continued', () => clocked(async () => {
  const now = Date.now();
  const { host, resumes } = scenario({
    sessions: [
      record('stale-ended', log([turnStart(1), turnEnd(1, INTERRUPTED)], now - 120_000)),
      record('fresh-ended', log([turnStart(1), turnEnd(1, INTERRUPTED)], now - 1000)),
    ],
    overrides: { freshMs: 60_000 },
  });
  host.start();
  await settle();
  await nextPass();
  await nextPass();
  assert.deepEqual(resumes.map((resume) => resume.resumeSessionId), ['fresh-ended'], 'only the fresh ended turn is resumed');
  assert.equal(host.agents.get('fresh-ended').followups.length, 1, 'the fresh one is continued once');
  assert.equal(host.agents.has('stale-ended'), false, 'the stale one has no agent');
}));

test('T19 an interrupted turn the user has already answered is neither resumed nor continued', () => clocked(async () => {
  const { host, resumes } = scenario({
    sessions: [
      record('answered', log([turnStart(1), turnEnd(1, INTERRUPTED), userPrompt()])),
      record('unanswered', log([turnStart(1), turnEnd(1, INTERRUPTED)])),
    ],
  });
  host.start();
  await settle();
  await nextPass();
  await nextPass();
  assert.deepEqual(resumes.map((resume) => resume.resumeSessionId), ['unanswered'], 'only the unanswered turn is resumed');
  assert.equal(host.agents.get('unanswered').followups.length, 1, 'the unanswered one is continued once');
  assert.equal(host.agents.has('answered'), false, 'the answered one has no agent');
}));

test('T20 a loader-resumed session takes only the scanLimit slots that live candidates leave over', () => clocked(async () => {
  const now = Date.now();
  const interrupted = (time) => log([turnStart(1), turnEnd(1, INTERRUPTED)], time);
  const { host, resumes } = scenario({
    sessions: [record('p-new', log(OPEN(), now - 40)), record('p-old', log(OPEN(), now - 50))],
    overrides: { scanLimit: 2 },
  });
  host.agent('l-old', interrupted(now - 300));
  host.agent('l-mid', interrupted(now - 200));
  host.agent('l-new', interrupted(now - 100));
  host.start();
  await settle();
  await settle(10);
  assert.equal(host.agents.get('l-new').followups.length, 1, 'pass 1 continues the newest live session');
  assert.equal(host.agents.get('l-mid').followups.length, 1, 'pass 1 continues the second newest live session');
  assert.equal(host.agents.get('l-old').followups.length, 0, 'l-old waits for pass 2');
  await nextPass();
  assert.equal(host.agents.get('l-old').followups.length, 1, 'l-old is continued at the pristine time: pass 2 plus graceMs');
  assert.deepEqual(['p-new', 'p-old'].map((id) => host.agents.get(id).followups.length), [1, 0],
    'one loader-resumed session takes the one leftover slot');
  await nextPass();
  assert.deepEqual(['p-new', 'p-old'].map((id) => host.agents.get(id).followups.length), [1, 1],
    'the other loader-resumed session continues one pass later');
  assert.equal(host.agents.get('l-old').followups.length, 1, 'l-old is not continued twice');
  assert.equal(resumes.length, 2, 'each persisted session is resumed once');
}));

test('T21 a resume that settles after the boot window is released once and never continued; nothing starts after the window', () => clocked(async () => {
  const now = Date.now();
  const deadline = now + 1000;
  let resolveCalls = 0;
  const { host, resumes, disposals, published } = scenario({
    sessions: [record('a', log(OPEN(), now - 10)), record('b', log(OPEN(), now - 20))],
    overrides: { freshMs: 1000 },
    resumeDelay: { a: 1500 },
    services: { agentPresets: { async resolve() { resolveCalls += 1; return { id: 'p' }; }, async mount() {} } },
  });
  host.start();
  await settle();
  assert.deepEqual(resumes.map((resume) => resume.resumeSessionId), ['a'], 'a starts before the window closes');
  await settle(1000);
  await settle(600);
  assert.deepEqual(resumes.map((resume) => resume.resumeSessionId), ['a'], 'b never starts a resume');
  assert.equal(resolveCalls, 1, 'only a looks up a preset; b makes no host call after the window closed');
  assert.ok(resumes.every((resume) => resume.startedAt < deadline), 'no resume starts at or after the deadline');
  assert.deepEqual(disposals, ['a'], 'a is disposed exactly once');
  await settle(5000);
  assert.equal(published[0].followups.length, 0, 'a is never continued');
  assert.equal(host.agents.size, 0, 'no agent is left, and none appears for b');
}));

test('T21b a list() that settles after the boot window opens nothing and resumes nothing', () => clocked(async () => {
  const now = Date.now();
  const listGate = new Promise((resolve) => setTimeout(resolve, 1500));
  const { host, resumes, store } = scenario({
    sessions: [record('a', log(OPEN(), now - 10))],
    overrides: { freshMs: 1000 },
    listGate,
  });
  host.start();
  await settle();
  await settle(1000);
  await settle(600);
  assert.equal(store.state.opens.length, 0, 'no session is opened after the window closed');
  assert.equal(resumes.length, 0);
  assert.equal(host.agents.size, 0);
}));

test('T21c an open that settles after the boot window is not read, and its handle is closed', () => clocked(async () => {
  const now = Date.now();
  const openGate = new Promise((resolve) => setTimeout(resolve, 1500));
  const { host, resumes, store } = scenario({
    sessions: [record('a', log(OPEN(), now - 10))],
    overrides: { freshMs: 1000 },
    openGate,
  });
  host.start();
  await settle();
  await settle(1000);
  await settle(600);
  assert.equal(store.state.opens.length, 1, 'the open started inside the window');
  assert.equal(store.state.reads, 0, 'no read starts after the window closed');
  assert.equal(store.state.closes, 1, 'the opened handle is closed');
  assert.equal(resumes.length, 0);
  assert.equal(host.agents.size, 0);
}));

test('T21d a preset lookup that settles after the boot window does not start the resume', () => clocked(async () => {
  const now = Date.now();
  const presetGate = new Promise((resolve) => setTimeout(resolve, 1500));
  let resolveCalls = 0;
  const { host, resumes } = scenario({
    sessions: [record('a', log(OPEN(), now - 10))],
    overrides: { freshMs: 1000 },
    services: { agentPresets: { async resolve() { resolveCalls += 1; await presetGate; return { id: 'p' }; }, async mount() {} } },
  });
  host.start();
  await settle();
  await settle(1000);
  await settle(600);
  assert.equal(resolveCalls, 1, 'the preset lookup started inside the window');
  assert.equal(resumes.length, 0, 'no resume starts after the window closed');
  assert.equal(host.agents.size, 0);
}));

test('T22 a session archived while presets.resolve is pending is not resumed', () => clocked(async () => {
  const registry = { archivedSessionIds: [] };
  const resolved = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { host, resumes } = scenario({
    sessions: [record('a', log(OPEN()))],
    services: {
      workspaceRegistry: registry,
      agentPresets: { async resolve(id) { resolved.push(id); await gate; return { id: 'p' }; }, async mount() {} },
    },
  });
  host.start();
  await settle();
  assert.equal(resolved.length, 1, 'the loader is inside presets.resolve');
  registry.archivedSessionIds.push('a');
  release();
  await settle();
  await nextPass();
  assert.equal(resumes.length, 0, 'the archive re-check after resolve stops the resume');
  assert.equal(host.agents.size, 0, 'no agent exists for the archived session');
}));

test('T27 a resume that settles after the last scan pass and before the deadline is released once and never continued', () => clocked(async () => {
  const now = Date.now();
  const { host, resumes, disposals, published } = scenario({
    sessions: [record('b', log(OPEN(), now - 10))],
    overrides: { freshMs: 10000 },
    resumeDelay: { b: 9500 },
  });
  host.start();
  await settle();
  await settle(3000);
  await settle(3000);
  await settle(3000);
  assert.equal(published.length, 0, 'b has not settled at 9 s, the last scan pass');
  await settle(500);
  assert.equal(published.length, 1, 'b settles at 9.5 s, after the last pass and before the 10 s deadline');
  await settle(500);
  await settle(5000);
  assert.equal(published[0].followups.length, 0, 'no scan pass classifies b, so it is never continued');
  assert.deepEqual(disposals, ['b'], 'b is released exactly once at the deadline');
  assert.equal(host.agents.has('b'), false, 'b is no longer in ctx.agents');
  assert.equal(resumes.length, 1, 'no second resume starts');
  assert.equal(published.length, 1, 'no second agent is published');
}));

test('T27b a loader-resumed session the scanner decides is not released at the deadline and is continued once', () => clocked(async () => {
  const now = Date.now();
  const { host, resumes, disposals, published } = scenario({
    sessions: [record('c', log(OPEN(), now - 10))],
    overrides: { freshMs: 10000 },
  });
  host.start();
  await settle();
  await settle(3000);
  await settle(10);
  assert.equal(published[0].followups.length, 1, 'the pass at 3 s decides c and continues it after graceMs');
  await settle(3000);
  await settle(3000);
  await settle(1000);
  await settle(5000);
  assert.equal(published[0].followups.length, 1, 'c is continued once, and nothing continues it again at the deadline');
  assert.deepEqual(disposals, [], 'the decided c is not released at the deadline');
  assert.equal(host.agents.has('c'), true, 'c stays live');
  assert.equal(resumes.length, 1, 'c is resumed once');
}));

/** Advance the fake clock in 100 ms steps, so a timer started by another timer runs at its own time. */
async function advance(ms) {
  for (let elapsed = 0; elapsed < ms; elapsed += 100) await settle(100);
}

/** Live events of a loader-resumed session. The runner reads each event's sequence number and clock. */
const liveStart = (seq, turn) => ({ type: 'turn/start', seq, time: Date.now(), data: { turn } });
const liveEnd = (seq, turn, reason) => ({ type: 'turn/end', seq, time: Date.now(), data: { turn, reason } });
const MAX_TOKENS = { kind: 'max-tokens' };
/** The reason of a turn/end that this plugin's loop guard cancelled (LOOP_GUARD_CANCEL_CAUSE in src/host/engine.ts). */
const LOOP_GUARD_ABORT = { kind: 'aborted', reason: { kind: 'hook', reason: 'dsh-auto-continue:loop-guard' } };

/** One persisted session b that settles at 9.5 s: after the last scan pass (9 s) and before the 10 s deadline. */
async function startLateResume(overrides = {}) {
  const now = Date.now();
  const scene = scenario({
    sessions: [record('b', log(OPEN(), now - 10))],
    overrides: { freshMs: 10000, ...overrides },
    resumeDelay: { b: 9500 },
  });
  scene.host.start();
  await settle();
  await settle(3000);
  await settle(3000);
  await settle(3000);
  await settle(500);
  assert.equal(scene.published.length, 1, 'b settles at 9.5 s, after the last scan pass and before the deadline');
  return scene;
}

/**
 * Persisted x settles at 0.1 s and is never scanned: its first continuation is sent at 1.6 s, then a second turn
 * ends inside the cooldown at 1.9 s with the given reason, which defers a retry to about 121.6 s.
 */
async function cooldownScene(secondReason) {
  const now = Date.now();
  const scene = scenario({
    sessions: [record('x', log(OPEN(), now - 10))],
    overrides: { freshMs: 10000, graceMs: 1000, cooldownMs: 60000 },
    resumeDelay: { x: 100 },
  });
  scene.host.start();
  await settle(); // flush the loader so its resume timer starts at 0 and publishes x at 0.1 s
  await settle(500);
  const agent = scene.published[0];
  scene.host.emit(agent, liveStart(10, 2));
  await settle(100);
  scene.host.emit(agent, liveEnd(11, 2, MAX_TOKENS));
  await settle(1200);
  assert.equal(agent.followups.length, 1, 'the first continuation is sent at 1.6 s');
  scene.host.emit(agent, liveStart(12, 3));
  await settle(100);
  scene.host.emit(agent, liveEnd(13, 3, secondReason));
  return { ...scene, agent };
}

test('T28a a pending continuation keeps a loader-resumed session past the deadline and is sent exactly once', () => clocked(async () => {
  const { host, resumes, disposals, published } = await startLateResume({ graceMs: 1000 });
  host.emit(published[0], liveStart(10, 2));
  host.emit(published[0], liveEnd(11, 2, MAX_TOKENS)); // one continuation, due after graceMs at 10.5 s
  await settle(600);
  assert.deepEqual(disposals, [], 'b is not released at the 10 s deadline while its continuation is pending');
  assert.equal(host.agents.has('b'), true, 'b stays live');
  assert.equal(published[0].followups.length, 0, 'the continuation waits out its grace period');
  await settle(1000);
  assert.equal(published[0].followups.length, 1, 'the pending continuation is sent exactly once');
  assert.deepEqual(disposals, [], 'b is not released after its continuation is sent');
  assert.equal(resumes.length, 1, 'b is resumed once');
}));

test('T28b a running turn keeps a loader-resumed session past the deadline, so the turn is not cancelled', () => clocked(async () => {
  const { host, resumes, disposals, published } = await startLateResume();
  host.emit(published[0], liveStart(10, 2));
  await settle(5000);
  assert.deepEqual(disposals, [], 'b is not released while its turn runs');
  assert.equal(host.agents.has('b'), true, 'b stays live');
  assert.equal(published[0].followups.length, 0, 'nothing is sent while the turn runs');
  assert.equal(resumes.length, 1, 'b is resumed once');
}));

test('T28c a cooldown retry keeps a loader-resumed session past the deadline and is sent exactly once', () => clocked(async () => {
  const { host, resumes, disposals, agent } = await cooldownScene(MAX_TOKENS);
  await advance(8200); // 10.1 s, past the deadline
  assert.deepEqual(disposals, [], 'x is not released while its cooldown retry is pending');
  assert.equal(host.agents.has('x'), true, 'x stays live');
  assert.equal(agent.followups.length, 1, 'the deferred retry has not fired before the cooldown ends');
  await advance(120000); // 130.1 s: the retry fires at about 121.6 s and is sent 1 s later
  assert.equal(agent.followups.length, 2, 'the deferred retry is sent exactly once, after the cooldown');
  assert.deepEqual(disposals, [], 'x is not released after the retry is sent');
  assert.equal(resumes.length, 1, 'x is resumed once');
}));

test('T28d a loop-guard retry keeps a loader-resumed session past the deadline and is sent exactly once', () => clocked(async () => {
  const { host, resumes, disposals, agent } = await cooldownScene(LOOP_GUARD_ABORT);
  await advance(8200); // 10.1 s, past the deadline
  assert.deepEqual(disposals, [], 'x is not released while its loop retry is pending');
  assert.equal(host.agents.has('x'), true, 'x stays live');
  assert.equal(agent.followups.length, 1, 'the deferred loop retry has not fired before the cooldown ends');
  await advance(120000); // 130.1 s: the loop retry fires at about 121.6 s and is sent 1 s later
  assert.equal(agent.followups.length, 2, 'the deferred loop retry is sent exactly once, after the cooldown');
  assert.deepEqual(disposals, [], 'x is not released after the loop retry is sent');
  assert.equal(resumes.length, 1, 'x is resumed once');
}));

test('T28e queued inbox input keeps a loader-resumed session past the deadline and stays in its inbox', () => clocked(async () => {
  const { host, resumes, disposals, published } = await startLateResume();
  const queued = { id: 'queued-user-message' };
  published[0].inbox.nextTurn.push(queued);
  await settle(600);
  assert.deepEqual(disposals, [], 'b is not released while input is queued for it');
  assert.equal(host.agents.has('b'), true, 'b stays live');
  assert.deepEqual(published[0].inbox.nextTurn, [queued], 'the queued input is still in the inbox');
  assert.equal(resumes.length, 1, 'b is resumed once');
}));

test('T23 a turn shut down by a graceful stop (aborted, disposed) is resumed once and continued once', () => clocked(async () => {
  const { host, resumes } = scenario({
    sessions: [record('d', log([turnStart(1), turnEnd(1, { kind: 'aborted', reason: { kind: 'disposed' } })]))],
  });
  host.start();
  await settle();
  await nextPass();
  assert.deepEqual(resumes.map((resume) => resume.resumeSessionId), ['d'], 'resumed exactly once');
  assert.equal(host.agents.size, 1, 'no second agent');
  assert.equal(host.agents.get('d').followups.length, 1, 'continued exactly once');
  await settle(3000);
  assert.equal(resumes.length, 1, 'no second resume');
  assert.equal(host.agents.get('d').followups.length, 1, 'no second continuation');
}));

test('T25 a manual stop (aborted, user) is neither resumed nor continued, while an interrupted sibling in the same pass is resumed', () => clocked(async () => {
  const { host, resumes } = scenario({
    sessions: [
      record('stopped', log([turnStart(1), turnEnd(1, { kind: 'aborted', reason: { kind: 'user' } })])),
      record('crashed', log(OPEN())),
    ],
  });
  host.start();
  await settle();
  await nextPass();
  await nextPass();
  assert.deepEqual(resumes.map((resume) => resume.resumeSessionId), ['crashed'], 'only the interrupted session is resumed');
  assert.equal(host.agents.has('stopped'), false, 'the manual stop has no agent');
  assert.equal(host.agents.get('crashed').followups.length, 1, 'the interrupted session is continued once');
}));

test('T26 a live agent whose last turn ended aborted (disposed) is continued exactly once by the scanner and never resumed', () => clocked(async () => {
  const { host, resumes } = scenario({});
  host.agent('live', log([turnStart(1), turnEnd(1, { kind: 'aborted', reason: { kind: 'disposed' } })]));
  host.start();
  await settle();
  await nextPass();
  await nextPass();
  assert.equal(resumes.length, 0, 'a live id is never resumed');
  assert.equal(host.agents.size, 1, 'no second agent');
  assert.equal(host.agents.get('live').followups.length, 1, 'continued exactly once by the scanner');
}));

test('T24 a graceful stop the user answered afterwards (aborted, disposed, then a user message) is neither resumed nor continued', () => clocked(async () => {
  const { host, resumes } = scenario({
    sessions: [record('answered', log([turnStart(1), turnEnd(1, { kind: 'aborted', reason: { kind: 'disposed' } }), userPrompt()]))],
  });
  host.start();
  await settle();
  await nextPass();
  await nextPass();
  assert.equal(resumes.length, 0, 'not resumed');
  assert.equal(host.agents.size, 0, 'no agent, so nothing is continued');
  assert.equal(host.agents.get('answered')?.followups.length ?? 0, 0, 'no followup is sent');
}));

test('T29 a live agent whose graceful-stop turn (aborted, disposed) the user answered afterwards gets no followup from the scanner', () => clocked(async () => {
  const { host, resumes } = scenario({});
  host.agent('live', log([turnStart(1), turnEnd(1, { kind: 'aborted', reason: { kind: 'disposed' } }), userPrompt()]));
  host.start();
  await settle();
  await nextPass();
  await nextPass();
  assert.equal(resumes.length, 0, 'a live id is never resumed');
  assert.equal(host.agents.size, 1, 'no second agent');
  assert.equal(host.agents.get('live').followups.length, 0, 'the scanner sends no followup');
  assert.equal(host.stats().sent, 0, 'no continuation is counted as sent');
}));

/** A DSH_HOME of its own, so one fixture's settled record never leaks into another. */
async function withHome(run) {
  const home = await mkdtemp(join(tmpdir(), 'ac-settled-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    await run(home);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
}

test('T31 a second boot does not decode a child log the first boot settled', () => withHome(async () => clocked(async () => {
  const child = record('child', log([turnStart(1), turnEnd(1, INTERRUPTED)]), { origin: 'subagent', parentSession: 'parent' });
  const first = scenario({ sessions: [child] });
  first.host.start();
  await settle();
  await nextPass();
  await settle(2000);
  await diskSettled();
  const firstReads = first.store.state.reads;

  const second = scenario({ sessions: [child] });
  second.host.start();
  await settle();
  await nextPass();

  assert.equal(firstReads, 1, 'the first boot decodes the child log once');
  assert.equal(second.store.state.reads, 0, 'the second boot spends no decode on it');
  assert.ok(second.store.state.stats >= 1, 'the skip is decided from the cheap stat');
  assert.equal(second.store.state.opens.length, 0, 'and never opens it for a read');
})));

test('T32 a log whose revision changed is decoded again', () => withHome(async () => clocked(async () => {
  const child = record('child', log([turnStart(1), turnEnd(1, INTERRUPTED)]), { origin: 'subagent', parentSession: 'parent' });
  const first = scenario({ sessions: [child] });
  first.host.start();
  await settle();
  await nextPass();
  await settle(2000);
  await diskSettled();

  child.revision = 'r2';
  const second = scenario({ sessions: [child] });
  second.host.start();
  await settle();
  await nextPass();

  assert.equal(second.store.state.reads, 1, 'a new revision earns a fresh read');
})));

test('T33 a session with something to resume is not settled across boots', () => withHome(async (home) => clocked(async () => {
  const session = record('a', log(OPEN()));
  // A settled sibling makes the record exist, so the assertion below proves the resumable id is absent from it.
  const settledChild = record('child', log([turnStart(1), turnEnd(1, INTERRUPTED)]), { origin: 'subagent', parentSession: 'p' });
  const first = scenario({ sessions: [session, settledChild] });
  first.host.start();
  await settle();
  await nextPass();
  await settle(2000);
  await diskSettled();

  const second = scenario({ sessions: [session, settledChild] });
  second.host.start();
  await settle();
  await nextPass();

  const settledFile = join(home, 'auto-continue-settled.json');
  const recorded = existsSync(settledFile) ? readFileSync(settledFile, 'utf8') : '';
  assert.equal(recorded.includes('"a"'), false, 'a resumable session is never written as settled');
  assert.equal(second.store.state.reads, 1, 'a resumable session is read on every boot');
  assert.equal(second.resumes.length, 1, 'and resumed again');
})));

test('T34 a settings change between boots does not freeze a settled child', () => withHome(async () => clocked(async () => {
  const child = record('child', log([turnStart(1), turnEnd(1, INTERRUPTED)]), { origin: 'subagent', parentSession: 'parent' });
  const first = scenario({ sessions: [child] });
  first.host.start();
  await settle();
  await nextPass();
  await settle(2000);
  await diskSettled();

  // Every setting that could reach a verdict changes here; none of them may revive a decode of an unchanged log.
  const second = scenario({
    sessions: [child],
    overrides: { freshMs: 60_000, classify: false, loopText: 'different loop text', guardTools: false, guardPendingText: '', guardDoneText: '' },
  });
  second.host.start();
  await settle();
  await nextPass();

  assert.equal(second.store.state.reads, 0, 'the settled child is still skipped');
})));

test('T35 a session older than freshMs is decoded on every boot, never settled', () => withHome(async () => clocked(async () => {
  // The age window is a function of the wall clock, not of the log, so the verdict must not be remembered.
  const old = record('old', log([turnStart(1), turnEnd(1, { kind: 'max-tokens' })], Date.now() - 60_000));
  const first = scenario({ sessions: [old], overrides: { freshMs: 1_000 } });
  first.host.start();
  await settle();
  await nextPass();
  await settle(2000);

  const second = scenario({ sessions: [old], overrides: { freshMs: 1_000 } });
  second.host.start();
  await settle();
  await nextPass();

  assert.equal(second.store.state.reads, 1, 'the too-old log is decoded again');
})));

test('T37 a row another host writes after this one loaded survives the save', () => withHome(async (home) => clocked(async () => {
  const childB = record('childB', log([turnStart(1), turnEnd(1, INTERRUPTED)]), { origin: 'subagent', parentSession: 'p' });
  const host = scenario({ sessions: [childB] });
  host.host.start();
  // Let the scan load its (empty) record before the other host writes, then let its own save run.
  await settle();
  const file = join(home, 'auto-continue-settled.json');
  const childA = record('childA', log([turnStart(1), turnEnd(1, INTERRUPTED)]), { origin: 'subagent', parentSession: 'p' });
  writeFileSync(file, `${JSON.stringify({ version: 1, entries: { childA: childA.revision } })}\n`, 'utf8');
  await nextPass();
  await settle(2000);
  for (let i = 0; i < 500; i += 1) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (Object.keys(parsed.entries).length === 2) {
        assert.deepEqual(Object.keys(parsed.entries).sort(), ['childA', 'childB'], 'neither host dropped the other');
        return;
      }
    } catch {}
    await new Promise((resolve) => { realSetTimeout(resolve, 10); });
  }
  assert.fail('the merged record never held both rows');
})));

/**
 * T38: a child with no parent can never be continued, so its own log settles the refusal and the next boot does not
 * decode it again. Two boots share one DSH_HOME on purpose, so the record the first writes is what the second reads.
 */
test('T38 a parentless child is settled by one read, so the second boot spends no decode on it', () => clocked(async () => {
  const home = await mkdtemp(join(tmpdir(), 'ac-settled-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const orphan = { ...record('orphan', log(OPEN()), { origin: 'subagent' }), inheritedEventCount: 0 };
    const file = join(home, 'auto-continue-settled.json');
    const first = scenario({ sessions: [orphan], overrides: { freshMs: 60_000 } });
    first.host.start();
    await settle();
    assert.equal(first.store.state.reads, 1, 'the first boot decodes the log once');
    // The save is coalesced behind a two second timer on the fake clock; step it and poll for the write it starts.
    await settle(2100);
    let saved;
    for (let i = 0; i < 500; i += 1) {
      try {
        saved = JSON.parse(readFileSync(file, 'utf8')).entries;
        break;
      } catch {
        await new Promise((resolve) => { realSetTimeout(resolve, 10); });
      }
    }
    assert.equal(saved?.orphan, orphan.revision, 'the refusal is recorded at the revision it was read at');

    const second = scenario({ sessions: [orphan], overrides: { freshMs: 60_000 } });
    second.host.start();
    await settle();
    assert.equal(second.store.state.reads, 0, 'the second boot skips the decode');
    assert.ok(second.store.state.stats >= 1, 'the skip is decided from the cheap stat');
    assert.equal(second.resumes.length, 0, 'and nothing is resumed');
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    for (const host of hosts.splice(0)) host.dispose();
    await rm(home, { recursive: true, force: true });
  }
}));

/**
 * T39: a row describes a session that could not be continued. Once that same session is live, the row can never be
 * consulted again, so it leaves the record instead of waiting for the 5,000-row cap. A save that only merges rows
 * would put it back, which is exactly what the disk assertion here catches.
 */
test('T39 a settled row leaves the record once its session is live', () => clocked(async () => {
  const home = await mkdtemp(join(tmpdir(), 'ac-settled-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const file = join(home, 'auto-continue-settled.json');
  const readEntries = () => {
    try {
      return JSON.parse(readFileSync(file, 'utf8')).entries;
    } catch {
      return undefined;
    }
  };
  const waitFor = async (predicate) => {
    for (let i = 0; i < 500; i += 1) {
      if (predicate(readEntries())) return readEntries();
      await new Promise((resolve) => { realSetTimeout(resolve, 10); });
    }
    return readEntries();
  };
  try {
    const child = record('child', log([turnStart(1), turnEnd(1, INTERRUPTED)]), { origin: 'subagent', parentSession: 'p' });
    const first = scenario({ sessions: [child] });
    first.host.start();
    await settle();
    assert.equal(readEntries(), undefined, 'nothing is written before a verdict exists');
    // The child has no agent, so nothing settled it; write its row by hand as a settled boot would have.
    writeFileSync(file, `${JSON.stringify({ version: 1, entries: { child: child.revision } })}\n`, 'utf8');
    first.host.dispose();
    hosts.length = 0;

    // The second boot finds that session already live in this host, so its row describes a state that has passed.
    const live = scenario({ sessions: [child] });
    live.host.agents.set('child', live.host.agent('child', child.events));
    live.host.start();
    await settle();
    await settle(2100);
    const afterDelete = await waitFor((entries) => entries !== undefined && entries.child === undefined);
    assert.deepEqual(afterDelete, {}, 'the row for the live session is gone from the file');
    assert.equal(live.store.state.reads, 0, 'and the live session was never decoded');
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    for (const host of hosts.splice(0)) host.dispose();
    await rm(home, { recursive: true, force: true });
  }
}));

/**
 * T40: the marker is the point. A row that another host rewrote at a newer revision belongs to that host's knowledge,
 * so this boot's deletion of an older revision must not remove it.
 */
test('T40 a deleted row another host rewrote at a new revision survives', () => clocked(async () => {
  const home = await mkdtemp(join(tmpdir(), 'ac-settled-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const file = join(home, 'auto-continue-settled.json');
  try {
    const child = record('child', log([turnStart(1), turnEnd(1, INTERRUPTED)]), { origin: 'subagent', parentSession: 'p' });
    writeFileSync(file, `${JSON.stringify({ version: 1, entries: { child: 'r1' } })}\n`, 'utf8');
    const live = scenario({ sessions: [child] });
    live.host.agents.set('child', live.host.agent('child', child.events));
    live.host.start();
    await settle();
    // Another host settles the same id at a newer revision after this one loaded its record.
    writeFileSync(file, `${JSON.stringify({ version: 1, entries: { child: 'r9' } })}\n`, 'utf8');
    await settle(2100);
    for (let i = 0; i < 500; i += 1) {
      const entries = JSON.parse(readFileSync(file, 'utf8')).entries;
      if (entries.child === 'r9') break;
      await new Promise((resolve) => { realSetTimeout(resolve, 10); });
    }
    const entries = JSON.parse(readFileSync(file, 'utf8')).entries;
    assert.equal(entries.child, 'r9', 'the newer revision another host wrote is kept');
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    for (const host of hosts.splice(0)) host.dispose();
    await rm(home, { recursive: true, force: true });
  }
}));

/**
 * T41: dropping a settled row is bookkeeping, so it must never spend the startup window. The disk check that decides
 * whether a row is really this boot's to remove is a host call, and a slow backend can hold it past the deadline. The
 * scan must schedule that check instead of waiting for it, or a healthy session listed after the live one loses its
 * recovery on that boot even though nothing about it is wrong.
 */
test('T41 a slow cleanup of a live row does not cost a later session its resume', () => clocked(async () => {
  const home = await mkdtemp(join(tmpdir(), 'ac-settled-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const file = join(home, 'auto-continue-settled.json');
  try {
    const live = record('live', log([turnStart(1), turnEnd(1, INTERRUPTED)]), { origin: 'subagent', parentSession: 'p' });
    // A child the host can continue: its own continuable descriptor, a pinned route, and an open turn.
    const eligible = record('eligible', log([
      { type: 'subagent/descriptor', data: { version: 3, mode: 'continuable', provider: 'in-process', label: 'worker', agentProvider: 'dp', agentModel: 'dm' } },
      requestHeader('dp', 'dm'),
      turnStart(1),
      userPrompt(),
    ]), { origin: 'subagent', parentSession: 'p' });
    writeFileSync(file, `${JSON.stringify({ version: 1, entries: { live: live.revision } })}\n`, 'utf8');
    const boot = scenario({
      sessions: [live, eligible],
      overrides: { freshMs: 1000, scanLimit: 2 },
      // Longer than the whole window: if the scan waits for this the window is gone before `eligible` is listed.
      statDelay: { live: 1500 },
    });
    boot.host.agents.set('live', boot.host.agent('live', live.events));
    // The child is continued under its parent, which must be live under the same id.
    const parent = boot.host.agent('p', log([turnStart(1), turnEnd(1, { kind: 'completed' })]));
    parent.id = 'p';
    boot.host.agents.set('p', parent);
    boot.host.start();
    // Close the window in slices the scan's own poll can run between: one 3 s step would close a 1 s window before
    // the first pass ever starts, and a later pass must not rescue a resume this boot lost.
    for (let elapsed = 0; elapsed < 2000; elapsed += 25) await settle(25);
    assert.deepEqual(boot.subagentSends.map((send) => send.targetId), ['eligible'], 'the eligible child is continued');
    assert.deepEqual(boot.resumes.map((entry) => entry.resumeSessionId), [], 'and it is never cold-resumed');
    assert.ok(boot.store.state.statted.includes('live'), 'the live row is still statted to learn its revision');
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    for (const host of hosts.splice(0)) host.dispose();
    await rm(home, { recursive: true, force: true });
  }
}));

/**
 * T42: the disk check runs beside the scan, so a shutdown can land while its stat is still out. A save scheduled after
 * dispose is one dispose cannot cancel, and it would write a drop this host no longer runs to justify, so the file must
 * come through the shutdown untouched.
 *
 * This test runs on real timers on purpose. Under the fake clock the same scenario pins nothing: the stat delay and
 * the 10 s call timeout are both suspended when the host is disposed, so a save armed afterwards never fires and the
 * file looks intact either way. With real timers it would fire 2 s later, inside the wait below.
 *
 * Known limit: with the post-stat shutdown guard removed, this test still passes, because the check does not reach
 * its save in this scenario either way. It documents the shutdown case; it does not pin the guard.
 */
test('T42 a shutdown during the disk check writes nothing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ac-settled-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const file = join(home, 'auto-continue-settled.json');
  const realWait = (ms) => new Promise((resolve) => { realSetTimeout(resolve, ms); });
  try {
    const live = record('live', log([turnStart(1), turnEnd(1, INTERRUPTED)]), { origin: 'subagent', parentSession: 'p' });
    writeFileSync(file, `${JSON.stringify({ version: 1, entries: { live: live.revision } })}\n`, 'utf8');
    // The stat waits on a real timer the test controls, so dispose lands while it is still out.
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const boot = scenario({ sessions: [live] });
    const answered = boot.store.stat.bind(boot.store);
    boot.store.stat = async (id) => {
      boot.store.state.stats += 1;
      boot.store.state.statted.push(id);
      await gate;
      return answered(id);
    };
    boot.host.agents.set('live', boot.host.agent('live', live.events));
    boot.host.start();
    for (let i = 0; i < 200 && !boot.store.state.statted.includes('live'); i += 1) await realWait(5);
    assert.deepEqual(boot.store.state.statted, ['live'], 'the check started and is waiting on the stat');
    boot.host.dispose();
    release();
    // A save armed by the late stat fires on the real timer 2 s from now.
    await realWait(2100);
    for (let i = 0; i < 20; i += 1) await realWait(10);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).entries, { live: 'r1' }, 'the row is still on disk');
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    for (const host of hosts.splice(0)) host.dispose();
    await rm(home, { recursive: true, force: true });
  }
});

/**
 * T43: two live sessions can both hold a settled row, and the first one's disk check can still be waiting when the
 * second arrives. A check drains only the ids it saw when it started, so a second batch must follow, or the second row
 * stays on disk for the cap to evict.
 */
test('T43 a row that arrives during a slow check is drained by the next one', () => clocked(async () => {
  const home = await mkdtemp(join(tmpdir(), 'ac-settled-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const file = join(home, 'auto-continue-settled.json');
  try {
    const first = record('first', log([turnStart(1), turnEnd(1, INTERRUPTED)]), { origin: 'subagent', parentSession: 'p' });
    const second = record('second', log([turnStart(1), turnEnd(1, INTERRUPTED)]), { origin: 'subagent', parentSession: 'p' });
    writeFileSync(file, `${JSON.stringify({ version: 1, entries: { first: 'r1', second: 'r1' } })}\n`, 'utf8');
    const boot = scenario({ sessions: [first, second], statDelay: { first: 500 } });
    boot.host.agents.set('first', boot.host.agent('first', first.events));
    boot.host.agents.set('second', boot.host.agent('second', second.events));
    boot.host.start();
    // Long enough for the first stat to return and the next check to finish.
    for (let elapsed = 0; elapsed < 1500; elapsed += 25) await settle(25);
    await settle(2100);
    for (let i = 0; i < 500; i += 1) {
      if (Object.keys(JSON.parse(readFileSync(file, 'utf8')).entries).length === 0) break;
      await new Promise((resolve) => { realSetTimeout(resolve, 10); });
    }
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).entries, {}, 'both live rows leave the file');
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    for (const host of hosts.splice(0)) host.dispose();
    await rm(home, { recursive: true, force: true });
  }
}));

/**
 * T44: the backend cannot report a revision (no stat at all, or one that fails). An unknown revision proves nothing
 * about the disk row, so the row stays: only a revision that equals the one this host settled at makes the removal
 * this host's to make.
 */
test('T44 a row whose revision cannot be read stays on disk', () => clocked(async () => {
  const home = await mkdtemp(join(tmpdir(), 'ac-settled-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const file = join(home, 'auto-continue-settled.json');
  try {
    const live = record('live', log([turnStart(1), turnEnd(1, INTERRUPTED)]), { origin: 'subagent', parentSession: 'p' });
    writeFileSync(file, `${JSON.stringify({ version: 1, entries: { live: 'r1' } })}\n`, 'utf8');
    const boot = scenario({ sessions: [live] });
    // A backend with no stat at all: persistedRevision answers undefined.
    delete boot.store.stat;
    boot.host.agents.set('live', boot.host.agent('live', live.events));
    boot.host.start();
    await settle();
    await settle(2100);
    // Real time for a save to land if one were started; a correct run starts none.
    await new Promise((resolve) => { realSetTimeout(resolve, 50); });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).entries, { live: 'r1' }, 'the row another host may own is kept');
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    for (const host of hosts.splice(0)) host.dispose();
    await rm(home, { recursive: true, force: true });
  }
}));

/**
 * T45: a backend whose stat accessor throws, rather than reporting nothing. The check must treat that as an unknown
 * revision (keep the row) and must not retry without pause: a restart loop on an unchanged pending set spins the host
 * for as long as the fault lasts.
 */
test('T45 a throwing stat accessor neither spins nor removes the row', () => clocked(async () => {
  const home = await mkdtemp(join(tmpdir(), 'ac-settled-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const file = join(home, 'auto-continue-settled.json');
  try {
    const live = record('live', log([turnStart(1), turnEnd(1, INTERRUPTED)]), { origin: 'subagent', parentSession: 'p' });
    writeFileSync(file, `${JSON.stringify({ version: 1, entries: { live: 'r1' } })}\n`, 'utf8');
    const boot = scenario({ sessions: [live] });
    let reads = 0;
    // The accessor itself throws: persistedRevision never gets a stat to call.
    Object.defineProperty(boot.store, 'stat', {
      get() {
        reads += 1;
        throw new Error('backend unavailable');
      },
    });
    boot.host.agents.set('live', boot.host.agent('live', live.events));
    boot.host.start();
    await settle();
    await settle(2100);
    for (let i = 0; i < 500; i += 1) {
      await new Promise((resolve) => { realSetTimeout(resolve, 10); });
    }
    // Both bounds matter: zero reads would mean the cleanup never ran, which is not the behaviour under test.
    assert.ok(reads >= 1, `the cleanup tried the accessor ${reads} times`);
    assert.ok(reads <= 2, `one attempt, not a spin (read the accessor ${reads} times)`);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).entries, { live: 'r1' }, 'an unknown revision keeps the row');
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    for (const host of hosts.splice(0)) host.dispose();
    await rm(home, { recursive: true, force: true });
  }
}));

/**
 * T47: one stalled log must not cost every other session its recovery. A session queued before the stall is resumed
 * in the same pass, or by the next one, instead of waiting for an enumeration that never finishes. The stall is a
 * read that never settles, so the pass has to move past it rather than wait for its 10 s call budget.
 */
test('T47 a stalled log does not stop an already-queued session from resuming', () => clocked(async () => {
  const stalled = record('stalled', log(OPEN()));
  const ready = record('ready', log(OPEN()));
  const boot = scenario({
    sessions: [stalled, ready],
    // Only the stalled log's open never settles; the other session is ordinary.
    openGate: undefined,
    overrides: { freshMs: 60_000 },
  });
  const realOpen = boot.store.open.bind(boot.store);
  boot.store.open = async (id, access) => {
    if (id === 'stalled') return new Promise(() => {});
    return realOpen(id, access);
  };
  boot.host.start();
  await settle();
  await settle(3000);
  assert.deepEqual(boot.resumes.map((entry) => entry.resumeSessionId), ['ready'], 'the healthy session is resumed');
  assert.equal(boot.resumes.length, 1, 'and the stalled one is not resumed');
}));
