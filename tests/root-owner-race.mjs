/**
 * Boot race on one root session. The boot loader enumerates before the host's sessionQuery service exists, so it owns the
 * root and starts its resume. The service registers later, and the stored sweep runs while that resume is still pending:
 * the root has no live agent yet, so only the shared boot claim stops the sweep from resuming the same root a second time.
 * The second test covers the other side of the decision: a loader resume that fails releases its claim, so the sweep may
 * resume the root once.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeHost } from './host-fixture.mjs';

/** Stamp a log: sequence numbers follow array order, every event carries a time. */
const stamp = (items) => items.map((item, index) => ({ ...item, seq: index + 1, time: Date.now() }));

/**
 * One root whose last turn was cut off by a restart. `firstResume` answers the loader's resume (the first host call);
 * every later call, the sweep's, is answered at once.
 */
function scenario(t, firstResume) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const events = stamp([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'interrupted' } } },
  ]);
  const header = { id: 'root', version: 1, createdAt: Date.now(), cwd: '/work', isSeeded: false };
  let observed = 0;
  // Held back by the test and registered later with host.provide, so the loader's enumeration sees no sessionQuery.
  const sessionQuery = {
    async listSessions() {
      return [{ header: { id: 'root', cwd: '/work' }, live: false, persisted: true }];
    },
    async observeSession() {
      observed += 1;
      return { events: [...events], header, [Symbol.dispose]() {} };
    },
  };
  let host;
  let calls = 0;
  const resume = async (options) => {
    calls += 1;
    if (calls === 1) await firstResume();
    const agent = host.agent(options.resumeSessionId, events);
    agent.session.header = { id: options.resumeSessionId };
    host.emitCreated(agent);
    return { agent, async dispose() {} };
  };

  host = makeHost({ scanOnBoot: true, verbose: false, graceMs: 0, cooldownMs: 0, continueText: 'Continue' }, {
    services: {
      sessionPersistence: {
        async list() { return [{ header, revision: 'r1' }]; },
        async open(id, access) {
          if (access !== 'read') throw new Error('the boot loader must open read-only');
          return {
            header,
            inheritedEventCount: 0,
            async read() { return { events: [...events] }; },
            async close() {},
          };
        },
      },
      workspaceRegistry: { archivedSessionIds: [] },
      agentDefaultModel: { currentSelection: () => ({ provider: 'dp', model: 'dm' }) },
    },
    resume,
  });
  t.after(() => host.dispose());

  const tick = async (ms = 0) => {
    t.mock.timers.tick(ms);
    // Drain the async read chain and the zero-delay yields between storage batches. setImmediate is not faked, so each
    // round also yields to the real event loop.
    for (let round = 0; round < 3; round += 1) {
      for (let i = 0; i < 400; i += 1) {
        t.mock.timers.tick(0);
        await Promise.resolve();
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  return { host, sessionQuery, tick, observed: () => observed };
}

test('a root the loader is resuming is not resumed again when sessionQuery registers late', async (t) => {
  let releaseFirstResume;
  const firstResumeGate = new Promise((resolve) => { releaseFirstResume = resolve; });
  t.after(() => releaseFirstResume());
  const { host, sessionQuery, tick, observed } = scenario(t, () => firstResumeGate);

  host.start();
  await tick(0);
  assert.equal(host.resumes().length, 1, 'the loader asks the host to resume the root once, before sessionQuery exists');

  host.provide('sessionQuery', sessionQuery);
  // The next boot pass starts the stored sweep, which reaches the root while the loader's resume is still pending.
  await tick(3000);
  await tick(10);
  assert.ok(observed() > 0, 'the stored sweep reached the root while the loader resume was pending');
  assert.equal(host.resumes().length, 1, 'the root is resumed once while the loader resume is pending');

  releaseFirstResume();
  await tick(10);
  assert.equal(host.resumes().length, 1, 'the root is resumed once after the loader resume settles');
  assert.ok(host.agents.get('root') !== undefined, 'the loader resume published the root agent');
});

test('a loader resume that fails releases the root, so the stored sweep may resume it once', async (t) => {
  const { host, sessionQuery, tick } = scenario(t, async () => { throw new Error('host refused the resume'); });

  host.start();
  await tick(0);
  assert.equal(host.resumes().length, 1, 'the loader asks the host to resume the root once');
  assert.equal(host.agents.get('root'), undefined, 'the failed loader resume publishes no agent');

  host.provide('sessionQuery', sessionQuery);
  await tick(3000);
  await tick(10);
  assert.equal(host.resumes().length, 2, 'the stored sweep resumes the root after the failed loader resume');
  assert.ok(host.agents.get('root') !== undefined, 'the sweep resume publishes the root agent');

  await tick(3000);
  await tick(10);
  assert.equal(host.resumes().length, 2, 'the root is not resumed a third time');
});
