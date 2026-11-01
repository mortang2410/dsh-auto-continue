/**
 * Boot path with one root and one child, on a host that has the stored-session service. The stored sweep owns the root
 * and the boot loader owns the child, so each is resumed exactly once: the root through the host's resume, the child
 * through the subagent service (never through the host's resume). The root's resume publishes its agent after a short
 * wait, the window in which a second resume of the same root would start, so a loader and a sweep that both resumed it
 * would show up as a second resume.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeHost } from './host-fixture.mjs';

const BOOT_CONTINUED = Symbol.for('dsh.auto-continue.bootContinued');

/** Stamp a log: sequence numbers follow array order, every event carries a time. */
const stamp = (items) => items.map((item, index) => ({ ...item, seq: index + 1, time: Date.now() }));

const CONTINUABLE = {
  version: 3, mode: 'continuable', provider: 'in-process', label: 'worker',
  agentProvider: 'deepseek', agentModel: 'pinned-model', agentReasoningEffort: 'high',
  persona: 'You review code.', toolFilter: { allow: ['read_file', 'grep'], deny: ['shell'] },
};

function scenario(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  globalThis[BOOT_CONTINUED]?.clear();

  // The root's last turn was cut off by a restart.
  const stored = {
    root: stamp([{ type: 'turn/end', data: { turn: 1, reason: { kind: 'interrupted' } } }]),
    // The child's own log: its pinned route, an open turn, and its continuable descriptor.
    child: stamp([
      { type: 'request/header', data: { header: { config: { provider: 'deepseek', model: 'pinned-model' } }, reason: 'initial' } },
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { source: { kind: 'user' } } },
      { type: 'subagent/descriptor', data: CONTINUABLE },
    ]),
  };
  const headers = {
    root: { id: 'root', version: 1, createdAt: Date.now(), cwd: '/work', isSeeded: false },
    child: { id: 'child', version: 1, createdAt: Date.now(), cwd: '/work', isSeeded: false, origin: 'subagent', parentSession: 'root', delegationDepth: 1 },
  };
  const childDeliveries = [];
  let host;

  const services = {
    workspaceRegistry: { archivedSessionIds: [] },
    agentDefaultModel: { currentSelection: () => ({ provider: 'dp', model: 'dm' }) },
    sessionPersistence: {
      async list() { return Object.values(headers).map((header) => ({ header, revision: 'r1' })); },
      async open(id, access) {
        if (access !== 'read') throw new Error('the boot loader must open read-only');
        return {
          header: headers[id],
          inheritedEventCount: 0,
          async read() { return { events: [...stored[id]] }; },
          async close() {},
        };
      },
    },
    sessionQuery: {
      async listSessions() {
        return [
          { header: { id: 'root', cwd: '/work' }, live: false, persisted: true },
          { header: { id: 'child', origin: 'subagent', parentSession: 'root' }, live: false, persisted: true },
        ];
      },
      async observeSession(id) {
        return { events: [...stored[id]], header: headers[id], [Symbol.dispose]() {} };
      },
    },
    // The host's subagent service: a cold resume of the child under its live sender, with the message as its first followup.
    subagents: {
      async sendMessage(sender, targetId, content) {
        if (sender === undefined || host.agents.get(sender.id) !== sender) {
          throw new Error('message delivery requires the exact live sender agent');
        }
        childDeliveries.push({ sender: sender.id, targetId });
        const agent = host.agent(targetId, stored[targetId]);
        agent.id = targetId;
        const message = { id: `msg-${childDeliveries.length}`, content };
        agent.followup(message);
        return message.id;
      },
    },
  };

  // The host's ctx.agents.resume: the agent is published after a short wait, then announced as created (as the host does).
  const resume = async (options) => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const agent = host.agent(options.resumeSessionId, stored[options.resumeSessionId]);
    agent.id = options.resumeSessionId;
    host.emitCreated(agent);
  };

  host = makeHost({ scanOnBoot: true, verbose: false, graceMs: 10, cooldownMs: 0, continueText: 'Continue' }, { services, resume });
  t.after(() => host.dispose());

  const tick = async (ms = 0) => {
    t.mock.timers.tick(ms);
    // Drain the async read chain and the zero-delay yields between storage batches. setImmediate is not faked, so each
    // round also yields to the real event loop: a child waiting for its parent is retried by a setImmediate.
    for (let round = 0; round < 3; round += 1) {
      for (let i = 0; i < 400; i += 1) {
        t.mock.timers.tick(0);
        await Promise.resolve();
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  return { host, childDeliveries, tick };
}

test('one root and one child: the root is resumed once by the sweep, the child is continued once by the loader', async (t) => {
  const { host, childDeliveries, tick } = scenario(t);
  host.start();
  // Three scan passes (3 s poll plus the 10 ms grace each), so a second resume of either session would have fired.
  for (let pass = 0; pass < 3; pass += 1) {
    await tick(3000);
    await tick(10);
  }
  assert.deepEqual(
    host.resumes().map((resume) => resume.resumeSessionId),
    ['root'],
    'the root is resumed exactly once, and the child is never resumed through the host',
  );
  assert.deepEqual(childDeliveries, [{ sender: 'root', targetId: 'child' }], 'the child is continued exactly once, under its live parent');
  assert.deepEqual(
    host.agents.get('child').followups.map((message) => message.content[0].text),
    ['Continue'],
    'the child receives one Continue',
  );
  assert.equal(host.agents.get('root').followups.length, 1, 'the root receives one restart continuation');
});
