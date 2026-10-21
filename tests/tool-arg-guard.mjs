// kata ab45: the tool-argument runaway guard.
//
// A degenerate function-call argument stream emits an unending run of whitespace and never closes
// its JSON. The incident (2026-10-21) wrote 604,399 whitespace characters in 112,064 argument
// deltas over 20 minutes. The guard trips on a long run of pure-whitespace argument deltas and
// cancels the turn; real argument content resets the run, and a step boundary starts a fresh count.
import assert from 'node:assert/strict';
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
const started = () => {
  const h = makeHost({ scanOnBoot: false, cooldownMs: 0, loopText: 'LOOP-TEXT' });
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

  // Real content between two whitespace runs resets the counter.
  {
    const { h, agent, cancels } = started();
    for (let i = 0; i < 220; i += 1) h.emit(agent, argChunk(' '.repeat(34))); // 7,480 chars
    h.emit(agent, argChunk('{"queries":['));
    for (let i = 0; i < 220; i += 1) h.emit(agent, argChunk(' '.repeat(34)));
    await flush();
    assert.equal(cancels.length, 0, 'content between whitespace runs resets the counter');
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
} finally {
  for (const h of hosts) h.dispose();
}
