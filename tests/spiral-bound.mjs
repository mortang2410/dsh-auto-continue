/**
 * Round 5: the escalation bound tells the truth, the persisted read honours config.loopGuard, and the persisted
 * escalation read matches the real log shape. Loads ../lib/index.js through host-fixture.mjs, the bundle the host loads.
 *
 * A. a paused host refuses the escalation, so no bound is spent: the next spiral escalates for real, and no stop
 *    notice ever claims a forced resume that did not happen;
 * B. a host turn/start cancels the queued escalation, so no bound is spent: the next spiral is sent, and the stop
 *    after it is the first truthful "after one forced resume" notice;
 * C. the persisted read honours config.loopGuard exactly as the live detector does: guard off, no hard loop text;
 * D. the scan reads the escalation from the real log order (turn/start, then the plugin's user/message) and the real
 *    sent text (the loop text plus the guard suffix), so an escalated episode is not sent again;
 * E. the same shape on the boot path: the session is not resumed and the user is told once;
 * F. two committed reasoning messages of one step trip the detector like two chunks of one live step, and two
 *    messages of different steps do not, which is the live per-step feed.
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
const MAX_PROBE = 'MAX-TOKENS-PROBE';
const SPIRAL_SENTENCE = '我必须再检查一遍这个推理内容的每一个细节。';
/** The real fire() send is buildContinueText's output: the loop text plus the en guardPendingText with {tool} filled. */
const GUARD_SUFFIX = '(The previous tool "read" may not have completed. Check its state before continuing and do not run it again.)';
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
const notices = (frames) => frames.filter((frame) => frame.type === 'notice').map((frame) => frame.notice.body);
const stopNotices = (frames) => notices(frames).filter((body) => body.includes(STOP_BODY));
const assistantMessage = (turn, content, step = 1) => ({
  type: 'assistant/message', seq: turn * 10 - 5, time: Date.now(),
  data: { turn, step, message: { role: 'assistant', content } },
});
const spiralChunk = (turn) => ({
  type: 'assistant/chunk', seq: turn * 10 - 7, time: Date.now(),
  data: { turn, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: SPIRAL_SENTENCE.repeat(400) } },
});
/** One spiral turn that ends with no visible output, the shape the round 3 escalation handles. */
const silentSpiralTurn = (h, agent, turn) => {
  h.emit(agent, turnStart(turn));
  h.emit(agent, spiralChunk(turn));
  h.emit(agent, assistantMessage(turn, [{ type: 'reasoning', text: SPIRAL_SENTENCE.repeat(400) }]));
  h.emit(agent, turnEnd(turn, 'completed'));
};

/** Persisted shape: sequence numbers follow array order, every event carries one time. */
const log = (items, time = Date.now()) => items.map((item, index) => ({ ...item, seq: index + 1, time }));
const storedStart = (turn) => ({ type: 'turn/start', data: { turn } });
const storedEnd = (turn, reason) => ({ type: 'turn/end', data: { turn, reason } });
const storedReasoning = (turn, text, step = 1) => ({
  type: 'assistant/message', data: { turn, step, message: { role: 'assistant', content: [{ type: 'reasoning', text }] } },
});
const storedUser = (text) => storedUserKind(text, 'user');
const storedUserKind = (text, kind) => ({
  type: 'user/message', data: { id: `user-${text.length}-${kind}`, role: 'user', content: [{ type: 'text', text }], source: { kind } },
});
const storedVisible = (turn, text, step = 1) => ({
  type: 'assistant/message', data: { turn, step, message: { role: 'assistant', content: [{ type: 'text', text }] } },
});
const record = (id, events) => ({
  header: { id, version: 1, createdAt: Date.now(), cwd: '/work', isSeeded: false },
  events,
});

/** One fake host with a persisted store; the fake resume publishes the agent with the stored events. */
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
  await check('A a paused host spends no bound, and no notice claims a resume that did not happen', async () => {
    const a = host({ paused: true });
    const agent = a.agent('paused');
    a.start();
    const bridge = a.bridge();
    silentSpiralTurn(a, agent, 1);
    await flush();
    silentSpiralTurn(a, agent, 2);
    await flush();
    assert.equal(agent.followups.length, 0, 'the paused host sends nothing');
    assert.equal(stopNotices(bridge.frames).length, 0, 'no stop notice claims a forced resume that never happened');
    // The episode still has its one escalation: unpausing must deliver it.
    a.config.paused = false;
    silentSpiralTurn(a, agent, 3);
    await flush();
    assert.equal(agent.followups.length, 1, 'the refused escalations left the bound unspent');
    assert.ok(sent(agent)[0].includes(LOOP_PROBE), 'the delivered escalation is the loop text');
    bridge.close();
  });

  await check('B a cancelled escalation spends no bound, and the stop after a real send is truthful', async () => {
    const b = host({ graceMs: 5000 });
    const agent = b.agent('cancelled');
    b.start();
    const bridge = b.bridge();
    silentSpiralTurn(b, agent, 1);
    await flush();
    b.emit(agent, turnStart(2)); // the host opens a turn inside graceMs: cancelPending drops the queued escalation
    await flush();
    b.emit(agent, spiralChunk(2));
    b.emit(agent, assistantMessage(2, [{ type: 'reasoning', text: SPIRAL_SENTENCE.repeat(400) }]));
    b.emit(agent, turnEnd(2, 'completed'));
    await flush();
    assert.equal(agent.followups.length, 0, 'nothing is sent before the grace period of the second escalation ends');
    assert.equal(stopNotices(bridge.frames).length, 0, 'no stop notice while the escalation is still queued');
    await flush(5000);
    assert.equal(agent.followups.length, 1, 'the cancelled attempt left the bound unspent, so the next spiral is sent');
    assert.ok(sent(agent)[0].includes(LOOP_PROBE), 'the delivered escalation is the loop text');
    silentSpiralTurn(b, agent, 3);
    await flush();
    assert.equal(agent.followups.length, 1, 'the spiral after the delivered resume is not sent again');
    assert.equal(stopNotices(bridge.frames).length, 1, 'the stop notice appears only after a real forced resume');
    bridge.close();
  });

  await check('C the persisted read honours loopGuard: guard off sends no hard loop text', async () => {
    const off = host({ scanOnBoot: true, loopGuard: false });
    const agentOff = off.agent('guard-off', [
      turnStart(1), assistantMessage(1, [{ type: 'reasoning', text: SPIRAL_SENTENCE.repeat(400) }]), turnEnd(1, 'max-tokens'),
    ]);
    off.start();
    await flush();
    await pass();
    assert.equal(agentOff.followups.length, 1, 'the session is still continued as an ordinary max-tokens turn');
    assert.ok(sent(agentOff)[0].includes(MAX_PROBE), 'with the loop guard off the continue is the max-tokens text');
    assert.ok(!sent(agentOff).some((text) => text.includes(LOOP_PROBE)), 'no hard loop text is forced');

    const on = host({ scanOnBoot: true, loopGuard: true });
    const agentOn = on.agent('guard-on', [
      turnStart(1), assistantMessage(1, [{ type: 'reasoning', text: SPIRAL_SENTENCE.repeat(400) }]), turnEnd(1, 'max-tokens'),
    ]);
    on.start();
    await flush();
    await pass();
    assert.ok(sent(agentOn)[0].includes(LOOP_PROBE), 'with the loop guard on the same log escalates');
  });

  await check('D the scan reads the real log order and the suffixed send, so it does not escalate again', async () => {
    const d = host({ scanOnBoot: true });
    // Real order: the host writes turn/start first, then the plugin's user/message, inside that turn (session seq 1168
    // then 1171). The sent text carries the guard suffix, as buildContinueText produces it.
    const agent = d.agent('real-order');
    d.start();
    const bridge = d.bridge();
    agent.session.events.push(...log([
      storedStart(1), storedUser(`${LOOP_PROBE} ${GUARD_SUFFIX}`),
      storedReasoning(1, SPIRAL_SENTENCE.repeat(400)), storedEnd(1, { kind: 'max-tokens' }),
    ]));
    await flush();
    await pass();
    assert.equal(agent.followups.length, 0, 'the escalated episode is not sent the loop text a second time');
    assert.equal(stopNotices(bridge.frames).length, 1, 'the scan stops and tells the user once');
    bridge.close();
  });

  await check('E the boot path reads the same real shape and refuses with one notice', async () => {
    const e = bootHost([record('real-order-boot', log([
      storedStart(1), storedUser(`${LOOP_PROBE} ${GUARD_SUFFIX}`),
      storedReasoning(1, SPIRAL_SENTENCE.repeat(400)), storedEnd(1, { kind: 'max-tokens' }),
    ]))], { listFailures: 1 });
    e.host.start();
    const bridge = e.host.bridge();
    await flush();
    await pass();
    assert.deepEqual(e.resumes, [], 'the boot path does not resume a session whose episode already escalated');
    assert.equal(stopNotices(bridge.frames).length, 1, 'the boot refusal tells the user once');
    bridge.close();
  });

  await check('F one step of committed messages trips like one live step, two steps do not', async () => {
    const same = host({ scanOnBoot: true });
    const agentSame = same.agent('same-step', [
      turnStart(1),
      assistantMessage(1, [{ type: 'reasoning', text: SPIRAL_SENTENCE.repeat(200) }], 1),
      assistantMessage(1, [{ type: 'reasoning', text: SPIRAL_SENTENCE.repeat(200) }], 1),
      turnEnd(1, 'max-tokens'),
    ]);
    same.start();
    await flush();
    await pass();
    assert.ok(sent(agentSame)[0].includes(LOOP_PROBE),
      'two committed messages of one step are one step, as in the live per-step feed');

    const split = host({ scanOnBoot: true });
    const agentSplit = split.agent('two-steps', [
      turnStart(1),
      assistantMessage(1, [{ type: 'reasoning', text: SPIRAL_SENTENCE.repeat(200) }], 1),
      assistantMessage(1, [{ type: 'reasoning', text: SPIRAL_SENTENCE.repeat(200) }], 2),
      turnEnd(1, 'max-tokens'),
    ]);
    split.start();
    await flush();
    await pass();
    assert.ok(sent(agentSplit)[0].includes(MAX_PROBE),
      'two steps of 4,200 characters each stay under the threshold, as they do live');
  });

  await check('G the stop and upgrade lines name the site, and the stop line is the round 3 wording plus the site', async () => {
    // Claims A9: round 4 changed `停止 <id>: ...` to `停止 <id>(<site>): ...` because the shared method names the site.
    // FIX.md is corrected in round 5; this check pins the delivered wording so a later edit cannot drift silently.
    const info = [];
    const original = console.info;
    console.info = (line) => { info.push(String(line)); };
    try {
      const g = host({ verbose: true });
      const agent = g.agent('lines');
      g.start();
      const bridge = g.bridge();
      silentSpiralTurn(g, agent, 1);
      await flush();
      await flush(3000);
      silentSpiralTurn(g, agent, 2);
      await flush();
      bridge.close();
    } finally {
      console.info = original;
    }
    const lines = info.filter((line) => line.startsWith('[auto-continue] 升级 ') || line.startsWith('[auto-continue] 停止 '));
    assert.equal(lines.filter((line) => line.startsWith('[auto-continue] 升级 ')).length, 1,
      'one upgrade line for the episode');
    assert.match(lines.find((line) => line.startsWith('[auto-continue] 升级 ')) ?? '',
      /^\[auto-continue\] 升级 lines\(turn\/end:completed\): 推理复读, 强制续跑一次 \(loop:spiral\)$/,
      'the upgrade line carries the live site and the loop reason');
    assert.match(lines.find((line) => line.startsWith('[auto-continue] 停止 ')) ?? '',
      /^\[auto-continue\] 停止 lines\(turn\/end:completed\): 推理复读, 强制续跑一次后仍无可见输出, 需要人工介入$/,
      'the stop line is round 3 wording plus the site');
  });

  await check('H boot resumes a tripped episode that never escalated and does not stop it', async () => {
    // Reviewer V11 finding 2: the boot refusal must key on the persisted escalation, not on the spiral signal. A boot
    // that refuses every tripped episode tells the user "after one forced resume" with zero resumes ever sent.
    const h = bootHost([record('tripped-boot', log([
      storedStart(1), storedReasoning(1, SPIRAL_SENTENCE.repeat(400)), storedEnd(1, { kind: 'max-tokens' }),
    ]))]);
    h.host.start();
    const bridge = h.host.bridge();
    await flush();
    await pass();
    assert.deepEqual(h.resumes, ['tripped-boot'], 'a tripped, never escalated session is resumed');
    assert.equal(stopNotices(bridge.frames).length, 0, 'the boot path emits no stop notice for an episode that never escalated');
    const agent = h.host.agents.get('tripped-boot');
    assert.ok(agent !== undefined, 'the resumed session is published');
    assert.equal(agent.followups.length, 1, 'the scan escalates the resumed episode once');
    assert.ok(sent(agent)[0].includes(LOOP_PROBE), 'the escalation carries the loop text');
    bridge.close();
  });

  await check('I a paused scan spends no bound, so no later stop notice claims a scan resume', async () => {
    // Reviewer V11 finding 3: the scan may spend the bound only through schedule. In the round 4 shape a paused scan
    // set state.spiralEscalated before the refused schedule, so the next live spiral stopped with a false notice.
    const i = host({ scanOnBoot: true });
    const agent = i.agent('scan-refused', [turnStart(1), assistantMessage(1, [{ type: 'reasoning', text: SPIRAL_SENTENCE.repeat(400) }]), turnEnd(1, 'max-tokens')]);
    // A pause that lands while the scan reads the session: the scan enters with paused false and schedule refuses.
    // This is the reachable shape of "the scan may spend the bound only through schedule".
    const original = agent.session.snapshotEvents.bind(agent.session);
    let flipped = false;
    agent.session.snapshotEvents = () => {
      if (!flipped) { flipped = true; i.config.paused = true; }
      return original();
    };
    i.start();
    const bridge = i.bridge();
    await flush();
    assert.equal(agent.followups.length, 0, 'the refused scan sends nothing');
    assert.equal(stopNotices(bridge.frames).length, 0, 'the refused scan adds no stop notice');
    i.config.paused = false;
    silentSpiralTurn(i, agent, 2);
    await flush();
    assert.equal(stopNotices(bridge.frames).length, 0, 'no stop notice claims a scan resume that never happened');
    assert.equal(agent.followups.length, 1, 'the refused scan left the bound unspent');
    assert.ok(sent(agent)[0].includes(LOOP_PROBE), 'the later escalation carries the loop text');
    bridge.close();
  });

  await check('J the upgrade line appears only when the escalation was queued', async () => {
    // Reviewer V11 finding 4: the boolean gate on the 升级 line. A refused schedule must not log an upgrade.
    const info = [];
    const original = console.info;
    console.info = (line) => { info.push(String(line)); };
    try {
      const j = host({ verbose: true, paused: true });
      const agent = j.agent('upgrade-line');
      j.start();
      silentSpiralTurn(j, agent, 1);
      await flush();
      assert.equal(info.filter((line) => line.includes('] 升级 ')).length, 0, 'a refused escalation logs no upgrade line');
      j.config.paused = false;
      silentSpiralTurn(j, agent, 2);
      await flush();
      assert.equal(info.filter((line) => line.includes('] 升级 ')).length, 1, 'the queued escalation logs one upgrade line');
    } finally {
      console.info = original;
      for (const h of hosts.splice(0)) h.dispose();
    }
  });

  await check('K a user-role message from another writer is not this plugin escalation', async () => {
    // Reviewer V11 finding 5a: only source.kind 'user' counts. An injected agent-instructions row that carries the
    // loop text plus the guard suffix must not be read as a send, or the episode would stop with no resume.
    const k = host({ scanOnBoot: true });
    const agent = k.agent('kind-filter');
    k.start();
    const bridge = k.bridge();
    agent.session.events.push(...log([
      storedStart(1), storedUserKind(`${LOOP_PROBE} ${GUARD_SUFFIX}`, 'agent-instructions'),
      storedReasoning(1, SPIRAL_SENTENCE.repeat(400)), storedEnd(1, { kind: 'max-tokens' }),
    ]));
    await flush();
    await pass();
    assert.equal(agent.followups.length, 1, 'the episode is escalated, not mistaken for an earlier send');
    assert.ok(sent(agent)[0].includes(LOOP_PROBE), 'the escalation carries the loop text');
    assert.equal(stopNotices(bridge.frames).length, 0, 'no stop notice for a resume that never happened');
    bridge.close();
  });

  await check('L a visible completion after the escalation opens a new episode', async () => {
    // Reviewer V11 finding 5b: visibleAfter is the episode reset. Without it a spiral that already escalated and then
    // produced visible output would be stopped as if the earlier resume had failed.
    const l = host({ scanOnBoot: true });
    const agent = l.agent('visible-after');
    l.start();
    const bridge = l.bridge();
    agent.session.events.push(...log([
      storedStart(1), storedUser(`${LOOP_PROBE} ${GUARD_SUFFIX}`), storedVisible(1, 'partial answer'),
      storedReasoning(1, SPIRAL_SENTENCE.repeat(400)), storedEnd(1, { kind: 'max-tokens' }),
    ]));
    await flush();
    await pass();
    assert.equal(stopNotices(bridge.frames).length, 0, 'the earlier episode ended at the visible completion');
    assert.equal(agent.followups.length, 1, 'the new episode escalates once');
    assert.ok(sent(agent)[0].includes(LOOP_PROBE), 'the escalation carries the loop text');
    bridge.close();
  });

  await check('M a plain user message containing a short loop text is not an escalation', async () => {
    // Reviewer V11 finding 1: matching the bare loop text false-positives on a user who types it. The guard suffix is
    // the discriminator, so a message without it is not evidence of a send.
    const m = host({ scanOnBoot: true, loopText: '继续' });
    const agent = m.agent('short-loop-text');
    m.start();
    const bridge = m.bridge();
    agent.session.events.push(...log([
      storedStart(1), storedUserKind('please 继续 with the task', 'user'),
      storedReasoning(1, SPIRAL_SENTENCE.repeat(400)), storedEnd(1, { kind: 'max-tokens' }),
    ]));
    await flush();
    await pass();
    assert.equal(stopNotices(bridge.frames).length, 0, 'a user message that merely contains the loop text is not a send');
    assert.equal(agent.followups.length, 1, 'the episode escalates once');
    assert.ok(sent(agent)[0].includes('继续'), 'the escalation carries the loop text');
    bridge.close();
  });

  await check('N a recorded bare send with guardTools off is recognised by exact equality', async () => {
    // V11 delta D6: with guardTools off fire() sends the bare loop text, so the read must fall back to exact trimmed
    // equality. Without that fallback the episode is escalated again after a restart.
    const n = host({ scanOnBoot: true, guardTools: false });
    const agent = n.agent('bare-send');
    n.start();
    const bridge = n.bridge();
    agent.session.events.push(...log([
      storedStart(1), storedUser(LOOP_PROBE),
      storedReasoning(1, SPIRAL_SENTENCE.repeat(400)), storedEnd(1, { kind: 'max-tokens' }),
    ]));
    await flush();
    await pass();
    assert.equal(agent.followups.length, 0, 'the recorded bare send is recognised, so nothing is sent again');
    assert.equal(stopNotices(bridge.frames).length, 1, 'the already escalated episode stops with one notice');
    bridge.close();
  });

  await check('O a degenerate guard text falls back to the conservative branch, not a false stop', async () => {
    // V11 delta D7: guardPendingText '(note) {tool}' has no fixed tail, and a human can type both its head and the loop
    // text. The rule trusts only a shape with a fixed tail, so this conversation escalates once and never claims a
    // forced resume that did not happen.
    const o = host({ scanOnBoot: true, loopText: '继续', guardPendingText: '(note) {tool}', guardDoneText: '(note) {tool}' });
    const agent = o.agent('degenerate-guard');
    o.start();
    const bridge = o.bridge();
    agent.session.events.push(...log([
      storedStart(1), storedUserKind('继续 (note) from a human', 'user'),
      storedReasoning(1, SPIRAL_SENTENCE.repeat(400)), storedEnd(1, { kind: 'max-tokens' }),
    ]));
    await flush();
    await pass();
    assert.equal(stopNotices(bridge.frames).length, 0, 'a human message is not read as a forced resume');
    assert.equal(agent.followups.length, 1, 'the episode escalates once instead');
    assert.ok(sent(agent)[0].includes('继续'), 'the escalation carries the loop text');
    bridge.close();
  });

  await check('P the shipped Chinese guard text is still trusted', async () => {
    // The tail rule must keep the shipped defaults working. The Chinese pending text has a 7 character head but a long
    // fixed tail, so the same shape is recognised and the episode stops instead of escalating again.
    const zhPending = '(上一步工具「{tool}」可能未完成, 先确认状态再继续, 不要重复执行)';
    const zhDone = '(上一步工具「{tool}」已完成, 结果: {result}; 不要重复执行, 直接继续)';
    const p = host({ scanOnBoot: true, loopText: '继续', guardPendingText: zhPending, guardDoneText: zhDone });
    const agent = p.agent('zh-guard');
    p.start();
    const bridge = p.bridge();
    agent.session.events.push(...log([
      storedStart(1), storedUser(`继续 ${zhPending.replace('{tool}', 'read')}`),
      storedReasoning(1, SPIRAL_SENTENCE.repeat(400)), storedEnd(1, { kind: 'max-tokens' }),
    ]));
    await flush();
    await pass();
    assert.equal(agent.followups.length, 0, 'the shipped Chinese suffix is recognised, so nothing is sent again');
    assert.equal(stopNotices(bridge.frames).length, 1, 'the already escalated episode stops with one notice');
    bridge.close();
  });

  if (failures.length > 0) {
    console.error(`${failures.length} of 16 checks failed: ${failures.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log('Spiral bound evidence boundaries ✅');
  }
} finally {
  for (const h of hosts.splice(0)) h.dispose();
  mock.timers.reset();
}
