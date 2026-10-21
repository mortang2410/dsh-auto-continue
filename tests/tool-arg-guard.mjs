// kata ab45: the tool-argument runaway guard.
//
// A degenerate function-call argument stream emits an unending run of whitespace and never closes
// its JSON. The incident (bifrost logs.db row 171891) wrote 109,513 whitespace-only argument deltas
// whose whitespace formed one run of 602,620 characters. The guard trips on a long run of
// pure-whitespace argument deltas and cancels the turn; real argument content resets the run, and a
// step or attempt boundary starts a fresh count. Both feeds are covered: the session event
// (`assistant/chunk`) and the production live feed (`agent/assistant-stream`, liveStreamGuard).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mock } from 'node:test';
import { makeHost, turnStart } from './host-fixture.mjs';

mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
const flush = async (ms = 20) => {
  mock.timers.tick(ms);
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

const hosts = [];
let seq = 100;

/** One running turn whose live agent records cancel calls. */
const started = (overrides = {}) => {
  const h = makeHost({ scanOnBoot: false, cooldownMs: 0, loopText: 'LOOP-TEXT', liveStreamGuard: true, ...overrides });
  hosts.push(h);
  h.start();
  const agent = h.agent('tool-arg');
  const cancels = [];
  agent.cancel = (...args) => cancels.push(args);
  h.emit(agent, turnStart(1));
  return { h, agent, cancels };
};

const argChunk = (argumentsDelta) => ({
  type: 'assistant/chunk',
  seq: seq++,
  time: Date.now(),
  data: { turn: 1, step: 1, chunk: { type: 'tool-call-delta', argumentsDelta } },
});

/** One live agent/assistant-stream frame; `start` opens a model attempt, `chunk` carries a delta. */
const liveStart = () => ({ type: 'start', turn: 1, step: 1 });
const liveChunk = (argumentsDelta) => ({ type: 'chunk', chunk: { type: 'tool-call-delta', argumentsDelta } });

try {
  // A degenerate whitespace run trips the guard and cancels the turn once.
  {
    const { h, agent, cancels } = started();
    for (let i = 0; i < 600; i += 1) h.emit(agent, argChunk(' '.repeat(34))); // 20,400 chars
    await flush();
    assert.equal(cancels.length, 1, 'the runaway argument stream must cancel the turn');
    for (let i = 0; i < 100; i += 1) h.emit(agent, argChunk(' '.repeat(34)));
    await flush();
    assert.equal(cancels.length, 1, 'a fired guard must not cancel repeatedly');
  }

  // A legitimate large argument has no long whitespace run and stays untouched.
  {
    const { h, agent, cancels } = started();
    for (let i = 0; i < 2_000; i += 1) h.emit(agent, argChunk('{"queries":["site:go.dev/doc/go1.24"]}'));
    await flush();
    assert.equal(cancels.length, 0, 'normal argument content must not trip');
  }

  // The threshold boundary: 16,383 characters do not trip, the 16,384th does.
  {
    const { h, agent, cancels } = started();
    h.emit(agent, argChunk(' '.repeat(16_383)));
    await flush();
    assert.equal(cancels.length, 0, '16,383 whitespace characters are under the threshold');
    h.emit(agent, argChunk(' '));
    await flush();
    assert.equal(cancels.length, 1, '16,384 whitespace characters trip');
  }

  // Real content between two whitespace runs resets the counter, even when the total is over 16 KiB.
  {
    const { h, agent, cancels } = started();
    h.emit(agent, argChunk(' '.repeat(10_200)));
    h.emit(agent, argChunk('{"queries":['));
    h.emit(agent, argChunk(' '.repeat(10_200)));
    await flush();
    assert.equal(cancels.length, 0, 'content between whitespace runs resets the counter');
  }

  // An empty delta is neutral: it neither extends nor resets the run.
  {
    const { h, agent, cancels } = started();
    h.emit(agent, argChunk(' '.repeat(8_200)));
    h.emit(agent, argChunk(''));
    h.emit(agent, argChunk(' '.repeat(8_200)));
    await flush();
    assert.equal(cancels.length, 1, 'an empty delta must not reset the run');
  }

  // A step boundary resets the run, so two steps under the threshold do not accumulate.
  {
    const { h, agent, cancels } = started();
    for (let i = 0; i < 480; i += 1) h.emit(agent, argChunk(' '.repeat(34))); // 16,320 chars, just under
    h.emit(agent, { type: 'step/start', seq: seq++, time: Date.now(), data: { turn: 1, step: 2 } });
    for (let i = 0; i < 480; i += 1) h.emit(agent, argChunk(' '.repeat(34)));
    await flush();
    assert.equal(cancels.length, 0, 'a step boundary resets the run');
  }

  // The production feed (agent/assistant-stream) trips too; this fails if the live call is removed.
  {
    const { h, agent, cancels } = started();
    h.emitStream(agent, liveStart());
    for (let i = 0; i < 600; i += 1) h.emitStream(agent, liveChunk(' '.repeat(34))); // 20,400 chars
    await flush();
    assert.equal(cancels.length, 1, 'the live feed must cancel the runaway');
  }

  // A live start frame (new model attempt) resets the run: two 10 KiB attempts do not add up.
  {
    const { h, agent, cancels } = started();
    h.emitStream(agent, liveStart());
    for (let i = 0; i < 300; i += 1) h.emitStream(agent, liveChunk(' '.repeat(34))); // 10,200 chars
    h.emitStream(agent, liveStart());
    for (let i = 0; i < 300; i += 1) h.emitStream(agent, liveChunk(' '.repeat(34)));
    await flush();
    assert.equal(cancels.length, 0, 'a live start frame resets the run');
  }

  // An empty live delta is neutral too.
  {
    const { h, agent, cancels } = started();
    h.emitStream(agent, liveStart());
    h.emitStream(agent, liveChunk(' '.repeat(8_200)));
    h.emitStream(agent, liveChunk(''));
    h.emitStream(agent, liveChunk(' '.repeat(8_200)));
    await flush();
    assert.equal(cancels.length, 1, 'an empty live delta must not reset the run');
  }

  // The real ab45 trace: one 602,620-character whitespace run, replayed as run lengths.
  {
    const { h, agent, cancels } = started();
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/ab45-whitespace-runs.json', import.meta.url), 'utf8'));
    const runs = fixture.whitespaceRuns;
    let crossedAt = -1;
    for (let i = 0; i < runs.length; i += 1) {
      h.emit(agent, argChunk(' '.repeat(runs[i])));
      if (cancels.length > 0 && crossedAt < 0) crossedAt = i;
      if (cancels.length > 0) break;
      if (i < runs.length - 1) h.emit(agent, argChunk('{"a":1}'));
    }
    await flush();
    assert.equal(cancels.length, 1, 'the real ab45 trace must trip the guard');
    assert.equal(crossedAt, runs.findIndex((run) => run >= 16_384), 'the trip happens at the first run past the threshold');
  }

  // During the cooldown the trip and the refusal are each logged once per step, and the cancel
  // becomes eligible again when the cooldown ends.
  {
    const logs = [];
    const original = console.info;
    console.info = (line) => logs.push(String(line));
    try {
      const { h, agent, cancels } = started({ cooldownMs: 20_000, verbose: true });
      h.emit(agent, argChunk(' '.repeat(16_400)));
      await flush();
      assert.equal(cancels.length, 1, 'the first runaway cancels');
      logs.length = 0;
      // A new turn clears loopFired; the next runaway arrives inside the cooldown.
      h.emit(agent, turnStart(2));
      for (let i = 0; i < 100; i += 1) h.emit(agent, argChunk(' '.repeat(400))); // 40,000 chars
      await flush();
      assert.equal(cancels.length, 1, 'the cooldown refuses the second cancel');
      assert.equal(logs.filter((line) => line.includes('检测到工具参数复读')).length, 1, 'the trip is logged once per step');
      assert.equal(logs.filter((line) => line.includes('跳过循环打断')).length, 1, 'the refusal is logged once per step');
      await flush(20_001);
      h.emit(agent, argChunk(' '));
      await flush();
      assert.equal(cancels.length, 2, 'the cancel becomes eligible when the cooldown ends');
    } finally {
      console.info = original;
    }
  }
} finally {
  for (const h of hosts) h.dispose();
}
