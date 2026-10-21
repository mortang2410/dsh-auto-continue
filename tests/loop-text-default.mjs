/**
 * Pin the loop guard's default text. The English default must equal the user's
 * sentence byte for byte. The Chinese default must equal the proposed wording.
 * Checks the runtime bundles, the source, the type declarations, the test
 * suites and the README tables, and fails if an old copy of the text remains.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const EN = 'You are deadass in a loop. DO something, anything right now to break the loop';
const ZH = '你陷入循环了. 立刻做点什么, 任何事都行, 马上打破这个循环';

const read = (rel) => readFileSync(join(root, rel), 'utf8');

// Runtime defaults: the LOCALIZED_TEXT_DEFAULTS object each bundle evaluates.
// It is read as text and evaluated alone, so the test needs no installed dependencies.
function runtimeDefaults(rel) {
  const match = read(rel).match(/var LOCALIZED_TEXT_DEFAULTS = (\{[\s\S]*?\n\});/);
  assert.ok(match, `${rel}: LOCALIZED_TEXT_DEFAULTS block not found`);
  return vm.runInNewContext(`(${match[1]})`);
}

for (const rel of ['lib/index.js', 'lib/client.js']) {
  const defaults = runtimeDefaults(rel);
  assert.equal(defaults.en.loopText, EN, `${rel}: English loopText default`);
  assert.equal(defaults.zh.loopText, ZH, `${rel}: Chinese loopText default`);
}

// Each file must carry the new literal in its own quoting style.
const required = [
  ['src/shared/core.ts', [`'${EN}'`, `'${ZH}'`]],
  ['lib/types/shared/core.d.ts', [`"${EN}"`, `"${ZH}"`]],
  ['lib/types/client/locales.d.ts', [`"${ZH}"`]],
  ['tests/simulate-client-loader.mjs', [`'${EN}'`, `'${ZH}'`]],
  ['tests/simulate-host.mjs', ["'You are deadass in a loop'"]],
  ['README.md', [`\`${EN}\``]],
  ['README.zh.md', [`\`${ZH}\``]],
];
for (const [rel, literals] of required) {
  const text = read(rel);
  for (const literal of literals) {
    assert.ok(text.includes(literal), `${rel}: missing the new literal ${literal}`);
  }
}

// No file may keep an old copy of the text.
const stale = [
  ['src/shared/core.ts', 'You may be stuck in a loop'],
  ['src/shared/core.ts', '检测到你可能陷入循环'],
  ['lib/index.js', 'You may be stuck in a loop'],
  ['lib/index.js', '检测到你可能陷入循环'],
  ['lib/client.js', 'You may be stuck in a loop'],
  ['lib/client.js', '检测到你可能陷入循环'],
  ['lib/types/shared/core.d.ts', 'You may be stuck in a loop'],
  ['lib/types/shared/core.d.ts', '检测到你可能陷入循环'],
  ['lib/types/client/locales.d.ts', '检测到你可能陷入循环'],
  ['tests/simulate-client-loader.mjs', 'You may be stuck in a loop'],
  ['tests/simulate-client-loader.mjs', '检测到你可能陷入循环'],
  ['tests/simulate-host.mjs', 'You may be stuck in a loop'],
  ['README.md', 'You may be stuck in a loop'],
  ['README.md', 'stop repeating, try another way'],
  ['README.zh.md', '检测到你可能陷入循环'],
  ['README.zh.md', '停止重复, 换一种方式'],
];
for (const [rel, old] of stale) {
  assert.ok(!read(rel).includes(old), `${rel}: still contains the old text ${old}`);
}

console.log('loop text default: English and Chinese defaults match the new wording ✅');
