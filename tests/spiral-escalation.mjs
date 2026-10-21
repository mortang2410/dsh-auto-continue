// Loads ../lib/index.js through host-fixture.mjs, the bundle the host loads.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { makeHost, turnEnd, turnStart } from './host-fixture.mjs';

mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
const flush = async (ms = 20) => {
  mock.timers.tick(ms);
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};
const LOOP_PROBE = 'LOOP-TEXT-PROBE';
const SILENT_PROBE = 'SILENT-TEXT-PROBE';
const STOP_BODY = 'Reasoning loop again after one forced resume with no visible output; auto-continue stopped, manual intervention required';
const hosts = [];
const host = () => {
  // cooldownMs 60s keeps a spiral trip inside the cooldown, so the cancel is refused and the turn ends silent.
  const h = makeHost({
    scanOnBoot: false, notify: true, locale: 'en', cooldownMs: 60_000,
    loopText: LOOP_PROBE, continueTextSilent: SILENT_PROBE,
  });
  hosts.push(h);
  h.start();
  return h;
};
const message = (turn, content) => ({
  type: 'assistant/message', seq: turn * 10 - 5, time: Date.now(),
  data: { turn, step: 1, message: { role: 'assistant', content } },
});
const SPIRAL_SENTENCE = '我必须再检查一遍这个推理内容的每一个细节。';
const spiral = (turn) => ({
  type: 'assistant/chunk', seq: turn * 10 - 7, time: Date.now(),
  data: { turn, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: SPIRAL_SENTENCE.repeat(400) } },
});
const userText = () => ({
  type: 'user/message', seq: 1, time: Date.now(),
  data: { id: `user-${Date.now()}`, role: 'user', content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } },
});
/** One turn that ends with reasoning only. `reasoningChars` is the committed reasoning size; `spiralTrip` adds the repeated-sentence chunks. */
const silentTurn = (h, agent, turn, { reasoningChars = 12, spiralTrip = false } = {}) => {
  h.emit(agent, turnStart(turn));
  if (spiralTrip) h.emit(agent, spiral(turn));
  h.emit(agent, message(turn, [{ type: 'reasoning', text: 'x'.repeat(reasoningChars) }]));
  h.emit(agent, turnEnd(turn, 'completed'));
};
const sent = (agent) => agent.followups.map((m) => m.content[0].text);
const stopNotices = (frames) => frames.filter((f) => f.type === 'notice' && f.notice.body === `escalate: ${STOP_BODY}`);
/** Turn 1 is a plain silent resume (it starts the cooldown). Turn 2 is the spiral with silent end: one forced loop send. */
const escalated = async () => {
  const h = host();
  const agent = h.agent('escalate');
  silentTurn(h, agent, 1);
  await flush();
  silentTurn(h, agent, 2, { spiralTrip: true });
  await flush();
  return { h, agent };
};

try {
  // Case A: the size of a long reasoning-only turn does not skip the resume when no spiral was seen.
  const long = host();
  const longAgent = long.agent('long');
  silentTurn(long, longAgent, 1, { reasoningChars: 8000 });
  await flush();
  assert.equal(longAgent.followups.length, 1, 'a long reasoning-only turn without a spiral is resumed, not skipped');
  assert.ok(sent(longAgent)[0].includes(SILENT_PROBE), 'without a spiral the resume is the ordinary silent text');

  // Case B: a spiral trip with silent end sends exactly one forced loop:spiral resume with the loop text.
  const { h, agent } = await escalated();
  assert.equal(agent.followups.length, 2, 'a spiral trip with silent end is escalated with one forced resume');
  assert.ok(sent(agent)[1].includes(LOOP_PROBE), 'the escalation carries the loop text');

  // Case C: a second spiral in the same episode sends nothing more and tells the user once.
  const bridge = h.bridge();
  silentTurn(h, agent, 3, { spiralTrip: true });
  await flush();
  assert.equal(agent.followups.length, 2, 'the second spiral in the same episode is not sent again');
  assert.equal(stopNotices(bridge.frames).length, 1, 'the guard stops for good and sends one stop notice');

  // Case D: a productive completion ends the episode, so the next spiral escalates again.
  const d = await escalated();
  d.h.emit(d.agent, turnStart(3));
  d.h.emit(d.agent, message(3, [{ type: 'text', text: 'Recovered' }]));
  d.h.emit(d.agent, turnEnd(3, 'completed'));
  await flush();
  silentTurn(d.h, d.agent, 4, { spiralTrip: true });
  await flush();
  assert.equal(d.agent.followups.length, 3, 'a visible completion resets the episode');
  assert.ok(sent(d.agent)[2].includes(LOOP_PROBE), 'the next episode escalates with the loop text');

  // Case E: a human message ends the episode, so the next spiral escalates again.
  const e = await escalated();
  e.h.emit(e.agent, userText());
  await flush();
  silentTurn(e.h, e.agent, 3, { spiralTrip: true });
  await flush();
  assert.equal(e.agent.followups.length, 3, 'a user message resets the episode');
  assert.ok(sent(e.agent)[2].includes(LOOP_PROBE), 'the episode after a user message escalates with the loop text');
  bridge.close();
  console.log('Spiral escalation evidence boundaries ✅');
} finally {
  for (const h of hosts) h.dispose();
  mock.timers.reset();
}
