/**
 * Boot loader for persisted sessions that are not live (T1-T28e, plus T23, T24, T25, T26 and T29).
 * The fake resume mirrors the host: it appends an `interrupted` closer to an open turn, runs setup,
 * then publishes the agent with the persisted events and header. Like the host, it publishes after an await.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mock, test } from 'node:test';
import { makeHost } from './host-fixture.mjs';

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
});

/** Turn number of the last turn that was started and never ended, or undefined. */
function openTurn(events) {
  const last = events.filter((event) => event.type === 'turn/start').at(-1);
  if (last === undefined) return undefined;
  return events.some((event) => event.type === 'turn/end' && event.seq > last.seq) ? undefined : last.data.turn;
}

/** Persisted-session service: read-only opens, with counters the tests assert on. */
function persistence(records, { listFailures = 0, listGate, openGate } = {}) {
  const state = { lists: 0, opens: [], reads: 0, closes: 0, failuresLeft: listFailures };
  return {
    state,
    async list() {
      state.lists += 1;
      if (listGate !== undefined) await listGate;
      if (state.failuresLeft > 0) {
        state.failuresLeft -= 1;
        throw new Error('list unavailable');
      }
      return [...records.values()].map(({ header }) => ({ header, revision: 'r1' }));
    },
    async open(id, access) {
      state.opens.push({ id, access });
      if (openGate !== undefined) await openGate;
      const stored = records.get(id);
      if (stored === undefined) throw new Error(`no session ${id}`);
      return {
        header: stored.header,
        async read() { state.reads += 1; return { eventState: 'owned', events: [...stored.events] }; },
        async close() { state.closes += 1; },
      };
    },
  };
}

const hosts = [];

/** One fake host with a persisted store. Services default to an empty archive and a default model. */
function scenario({
  sessions = [], overrides = {}, services = {}, resumeError, listFailures, listGate, openGate, hangResume = [], resumeDelay = {},
} = {}) {
  const records = new Map(sessions.map((item) => [item.header.id, item]));
  const store = persistence(records, { listFailures, listGate, openGate });
  const resumes = [];
  const disposals = [];
  const published = [];
  const host = makeHost(overrides, {
    services: {
      workspaceRegistry: { archivedSessionIds: [] },
      agentDefaultModel: { currentSelection: () => ({ provider: 'dp', model: 'dm' }) },
      sessionPersistence: store,
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
  return { host, resumes, store, records, disposals, published };
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
