/**
 * Round 4: the three sites the findings audit still called ABSURD (vrpe F-A2, H14, M1, M1b, O2).
 * Loads ../lib/index.js through host-fixture.mjs, the bundle the host loads.
 *
 * A. the live turn/end:max-tokens branch continues a reasoning-only stop that has no spiral signal;
 * B. the same branch escalates a spiral once with config.loopText and then stops with one notice;
 * C. the boot scan / 3-second poll continues a persisted reasoning-only max-tokens turn with no spiral;
 * D. the same filter escalates a persisted spiral once with config.loopText;
 * E. the same filter stops and notifies when the persisted log already carries that escalation;
 * F1. the persisted boot loader resumes a reasoning-only max-tokens session with no spiral, and it is continued;
 * F2. the boot loader refuses (with a notice) the session whose log already carries the escalation.
 *
 * Every case prints PASS or FAIL, so a run against the pre-round-4 bundle shows exactly which sites were silent.
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { makeHost, turnEnd, turnStart } from './host-fixture.mjs';

mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
const flush = async (ms = 20) => {
  mock.timers.tick(ms);
  for (let i = 0; i < 100; i += 1) await Promise.resolve();
};
/** One 3-second scan pass, then the graceMs window, so a session scheduled in that pass is sent. */
const pass = async () => {
  await flush(3000);
  await flush(10);
};
const LOOP_PROBE = 'LOOP-TEXT-PROBE';
/** Round 5: a real fire() send is the loop text plus the guard suffix, the marker the persisted read keys on. */
const GUARD_SUFFIX = '(The previous tool "read" may not have completed. Check its state before continuing and do not run it again.)';
const MAX_PROBE = 'MAX-TOKENS-PROBE';
const STOP_BODY = 'Reasoning loop again after one forced resume with no visible output; auto-continue stopped, manual intervention required';
const hosts = [];
const host = (options = {}) => {
  // cooldownMs 60s keeps a spiral trip inside the cooldown, so the interrupt is refused and the turn ends.
  const h = makeHost({
    scanOnBoot: false, notify: true, locale: 'en', cooldownMs: 60_000,
    loopText: LOOP_PROBE, continueTextMaxTokens: MAX_PROBE, ...options,
  });
  hosts.push(h);
  return h;
};
const sent = (agent) => agent.followups.map((message) => message.content[0].text);
const stopNotices = (frames) => frames.filter((frame) => frame.type === 'notice' && frame.notice.body.includes(STOP_BODY));
const assistantMessage = (turn, content) => ({
  type: 'assistant/message', seq: turn * 10 - 5, time: Date.now(),
  data: { turn, step: 1, message: { role: 'assistant', content } },
});
const SPIRAL_SENTENCE = '我必须再检查一遍这个推理内容的每一个细节。';
const spiralChunk = (turn) => ({
  type: 'assistant/chunk', seq: turn * 10 - 7, time: Date.now(),
  data: { turn, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: SPIRAL_SENTENCE.repeat(400) } },
});
/** One max-tokens turn whose committed message is reasoning only. `spiralTrip` adds the repeated-sentence deltas. */
const maxTokensTurn = (h, agent, turn, { spiralTrip = false } = {}) => {
  h.emit(agent, turnStart(turn));
  if (spiralTrip) h.emit(agent, spiralChunk(turn));
  h.emit(agent, assistantMessage(turn, [{ type: 'reasoning', text: spiralTrip ? SPIRAL_SENTENCE.repeat(400) : 'x'.repeat(10) }]));
  h.emit(agent, turnEnd(turn, 'max-tokens'));
};

/** Persisted shape: sequence numbers follow array order, every event carries one time. */
const log = (items, time = Date.now()) => items.map((item, index) => ({ ...item, seq: index + 1, time }));
const storedStart = (turn) => ({ type: 'turn/start', data: { turn } });
const storedEnd = (turn, reason) => ({ type: 'turn/end', data: { turn, reason } });
const storedReasoning = (turn, text) => ({
  type: 'assistant/message', data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text }] } },
});
const storedUser = (text) => ({
  type: 'user/message', data: { id: `user-${text.length}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
});
const record = (id, events) => ({
  header: { id, version: 1, createdAt: Date.now(), cwd: '/work', isSeeded: false },
  events,
});

/**
 * One fake host with a persisted store, mirroring tests/persisted-autoload.mjs: the fake resume publishes the agent
 * with the stored events, like the host does. `listFailures` makes that many list() calls fail, which defers the
 * boot pass to a later scan so a notice can be observed while the bridge is attached.
 */
function bootHost(sessions, { listFailures = 0 } = {}) {
  const records = new Map(sessions.map((item) => [item.header.id, item]));
  const resumes = [];
  const published = [];
  let failuresLeft = listFailures;
  const store = {
    async list() {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error('list unavailable');
      }
      return [...records.values()].map(({ header }) => ({ header, revision: 'r1' }));
    },
    async open(id) {
      const stored = records.get(id);
      if (stored === undefined) throw new Error(`no session ${id}`);
      return { inheritedEventCount: 0, async read() { return { events: [...stored.events] }; }, async close() {} };
    },
  };
  const services = {
    sessionPersistence: store,
    workspaceRegistry: { archivedSessionIds: [] },
    agentDefaultModel: { currentSelection: () => ({ provider: 'dp', model: 'dm' }) },
  };
  const h = makeHost({
    scanOnBoot: true, notify: true, locale: 'en', cooldownMs: 60_000, graceMs: 10,
    loopText: LOOP_PROBE, continueTextMaxTokens: MAX_PROBE,
  }, {
    services,
    async resume(options) {
      resumes.push(options.resumeSessionId);
      await Promise.resolve();
      const stored = records.get(options.resumeSessionId);
      if (options.setup !== undefined) await options.setup({ sessionId: stored.header.id }, undefined);
      const agent = h.agent(stored.header.id, stored.events);
      agent.session.header = stored.header;
      published.push(agent);
      return { agent, async dispose() { h.agents.delete(stored.header.id); } };
    },
  });
  hosts.push(h);
  return { host: h, resumes, published };
}

const failures = [];
/** Run one case, print its verdict, and dispose every host the case created. */
async function check(name, run) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    for (const h of hosts.splice(0)) h.dispose();
  }
}

try {
  await check('A live max-tokens stop without a spiral is continued', async () => {
    const a = host();
    const agent = a.agent('short-stop');
    a.start();
    maxTokensTurn(a, agent, 1);
    await flush();
    assert.equal(agent.followups.length, 1, 'a reasoning-only max-tokens stop with no spiral is continued');
    assert.ok(sent(agent)[0].includes(MAX_PROBE), 'the ordinary continue carries the max-tokens text');
  });

  await check('B live max-tokens spiral escalates once, then stops with one notice', async () => {
    const b = host();
    const agent = b.agent('spiral-stop');
    b.start();
    const bridge = b.bridge();
    maxTokensTurn(b, agent, 1, { spiralTrip: true });
    await flush();
    assert.equal(agent.followups.length, 1, 'a spiral max-tokens stop is escalated once');
    assert.ok(sent(agent)[0].includes(LOOP_PROBE), 'the escalation carries the loop text');
    maxTokensTurn(b, agent, 2, { spiralTrip: true });
    await flush();
    assert.equal(agent.followups.length, 1, 'the second spiral in the same episode is not sent again');
    assert.equal(stopNotices(bridge.frames).length, 1, 'the guard stops and sends one stop notice');
    bridge.close();
  });

  await check('C the scan continues a persisted max-tokens stop without a spiral', async () => {
    const c = host({ scanOnBoot: true });
    const agent = c.agent('scan-plain', [
      turnStart(1), assistantMessage(1, [{ type: 'reasoning', text: 'x'.repeat(10) }]), turnEnd(1, 'max-tokens'),
    ]);
    c.start();
    await flush();
    await pass();
    assert.equal(agent.followups.length, 1, 'the scan continues a persisted reasoning-only max-tokens turn with no spiral');
    assert.ok(sent(agent)[0].includes(MAX_PROBE), 'the scan continue carries the max-tokens text');
  });

  await check('D the scan escalates a persisted max-tokens spiral once with the loop text', async () => {
    const d = host({ scanOnBoot: true });
    const agent = d.agent('scan-spiral', [
      turnStart(1), assistantMessage(1, [{ type: 'reasoning', text: SPIRAL_SENTENCE.repeat(400) }]), turnEnd(1, 'max-tokens'),
    ]);
    d.start();
    await flush();
    await pass();
    assert.equal(agent.followups.length, 1, 'the scan escalates a persisted spiral max-tokens turn once');
    assert.ok(sent(agent)[0].includes(LOOP_PROBE), 'the scan escalation carries the loop text');
  });

  await check('E the scan stops and notifies when the log already carries the escalation', async () => {
    // The bridge is connected before the history appears, so the notice is observed while a client is attached.
    const e = host({ scanOnBoot: true });
    const agent = e.agent('scan-escalated');
    e.start();
    const bridge = e.bridge();
    agent.session.events.push(
      turnStart(1), storedUser(`${LOOP_PROBE} ${GUARD_SUFFIX}`),
      assistantMessage(1, [{ type: 'reasoning', text: SPIRAL_SENTENCE.repeat(400) }]),
      turnEnd(1, 'max-tokens'),
    );
    await flush();
    await pass();
    assert.equal(agent.followups.length, 0, 'an episode already escalated before the restart is not sent again');
    assert.equal(stopNotices(bridge.frames).length, 1, 'the scan stop tells the user once');
    bridge.close();
  });

  await check('F1 the boot loader resumes a max-tokens stop without a spiral and it is continued', async () => {
    const f1 = bootHost([record('plain', log([
      storedStart(1), storedReasoning(1, 'x'.repeat(10)), storedEnd(1, { kind: 'max-tokens' }),
    ]))]);
    f1.host.start();
    await flush();
    await pass();
    assert.deepEqual(f1.resumes, ['plain'], 'the boot path resumes a reasoning-only max-tokens session with no spiral');
    assert.equal(f1.published.length, 1, 'the resumed session is published');
    assert.equal(f1.published[0].followups.length, 1, 'the resumed session is continued once');
    assert.ok(f1.published[0].followups[0].content[0].text.includes(MAX_PROBE), 'the continue carries the max-tokens text');
  });

  await check('F2 the boot loader refuses an already escalated spiral and notifies once', async () => {
    // The first list() fails, so the refusal happens on a later boot pass, while the bridge is attached.
    const f2 = bootHost([record('looped', log([
      storedStart(1), storedUser(`${LOOP_PROBE} ${GUARD_SUFFIX}`), storedReasoning(1, SPIRAL_SENTENCE.repeat(400)),
      storedEnd(1, { kind: 'max-tokens' }),
    ]))], { listFailures: 1 });
    f2.host.start();
    const bridge = f2.host.bridge();
    await flush();
    await pass();
    assert.deepEqual(f2.resumes, [], 'the boot path refuses a session whose spiral episode already escalated');
    assert.equal(stopNotices(bridge.frames).length, 1, 'the boot refusal tells the user once');
    bridge.close();
  });

  if (failures.length > 0) {
    console.error(`${failures.length} of 7 checks failed: ${failures.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log('Spiral site evidence boundaries ✅');
  }
} finally {
  for (const h of hosts.splice(0)) h.dispose();
  mock.timers.reset();
}
