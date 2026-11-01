import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeHost, turnEnd, turnStart } from './host-fixture.mjs';

// Reasoning-only turns (no visible text, no tool call) repeated across turns. The text arm resets at each turn start,
// so only the reasoning arm can see this stall. Turn steps: a message is { type, data }, a fresh tool call is a call step.
const message = content => ({ type: 'assistant/message', data: { message: { role: 'assistant', content } } });
const call = n => ({ type: 'tool/call', data: { callId: `c${n}`, name: 'edit', arguments: JSON.stringify({ file: `f${n}` }) } });
const reasoning = text => message([{ type: 'reasoning', text }]);
const visible = text => message([{ type: 'text', text }]);

function session(t, config = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const host = makeHost({ scanOnBoot: false, maxConsecutive: 8, ...config });
  t.after(() => host.dispose());
  const agent = host.agent('working');
  agent.cancels = [];
  agent.cancel = cause => agent.cancels.push(cause);
  host.start();
  let turn = 0;
  // Ends the turn as the host does: aborted with the loop cause when the guard cancelled it during the turn, else completed.
  const runTurn = steps => {
    turn += 1;
    const cancelsBefore = agent.cancels.length;
    host.emit(agent, turnStart(turn));
    steps.forEach((step, k) => {
      const seq = turn * 10 - 8 + k;
      host.emit(agent, { ...step, seq, time: Date.now(), data: { turn, step: k + 1, ...step.data } });
    });
    const cancelled = agent.cancels.length > cancelsBefore;
    host.emit(agent, cancelled ? turnEnd(turn, 'aborted', { reason: agent.cancels.at(-1) }) : turnEnd(turn, 'completed'));
    t.mock.timers.tick(50);
  };
  return { agent, runTurn };
}

test('identical reasoning-only turns trip the guard at loopRepeatText, then count again from zero', t => {
  const { agent, runTurn } = session(t);
  const same = reasoning('Same private plan with no visible output.');
  for (let n = 0; n < 3; n += 1) runTurn([same]);
  assert.equal(agent.cancels.length, 0, 'three identical reasoning turns are below the threshold of 4');
  runTurn([same]);
  assert.equal(agent.cancels.length, 1, 'the fourth identical reasoning turn trips the guard');
  for (let n = 0; n < 3; n += 1) runTurn([same]);
  assert.equal(agent.cancels.length, 1, 'after an interrupt the count restarts, so three more identical turns do not trip it again');
});

test('whitespace and invisible characters do not hide a reasoning repeat', t => {
  const { agent, runTurn } = session(t);
  runTurn([reasoning('Same private plan.')]);
  runTurn([reasoning('Same private plan. \n')]);
  runTurn([reasoning('\u200bSame private plan.')]);
  runTurn([reasoning('Same private plan.\u200d')]);
  assert.equal(agent.cancels.length, 1);
});

test('reasoning that changes every turn is progress and resumes up to the cap', t => {
  const { agent, runTurn } = session(t);
  for (let n = 1; n <= 6; n += 1) runTurn([reasoning(`Plan ${n}: step ${n} of the work.`)]);
  assert.equal(agent.followups.length, 6);
  assert.equal(agent.cancels.length, 0);
});

test('identical visible text across turns is not counted by the reasoning arm (control)', t => {
  const { agent, runTurn } = session(t);
  for (let n = 0; n < 6; n += 1) runTurn([visible('Checking the logs now.')]);
  assert.equal(agent.cancels.length, 0);
  assert.equal(agent.followups.length, 0, 'a completed turn with visible output is not resumed');
});

test('identical visible text within one turn still trips the text arm (control)', t => {
  const { agent, runTurn } = session(t);
  runTurn([0, 1, 2, 3].map(() => visible('Checking the logs now.')));
  assert.equal(agent.cancels.length, 1);
});

test('visible output resets the reasoning count', t => {
  const { agent, runTurn } = session(t);
  const same = reasoning('Same private plan with no visible output.');
  for (let n = 0; n < 3; n += 1) runTurn([same]);
  runTurn([visible('Here is the result.')]);
  for (let n = 0; n < 3; n += 1) runTurn([same]);
  assert.equal(agent.cancels.length, 0);
});

test('streamed visible output resets the reasoning count before its message commits', t => {
  const { agent, runTurn } = session(t);
  const same = reasoning('Same private plan with no visible output.');
  for (let n = 0; n < 3; n += 1) runTurn([same]);
  runTurn([{ type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'Here is the result.' } } }]);
  for (let n = 0; n < 3; n += 1) runTurn([same]);
  assert.equal(agent.cancels.length, 0);
});

test('a fresh tool call resets the reasoning count within one turn', t => {
  const { agent, runTurn } = session(t);
  const same = reasoning('Same private plan with no visible output.');
  runTurn([same, same, same, call(1), same, same, same]);
  assert.equal(agent.cancels.length, 0);
});
