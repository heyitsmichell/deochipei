const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const { patchCli } = require('./patch-expo.cjs');

test('CLI patch preserves headers, repairs old installs and is idempotent', () => {
  const original = '#!/usr/bin/env node\nprocess.stdout.write("started");\n';
  const patched = patchCli(original);
  assert.ok(patched.startsWith('#!/usr/bin/env node\n'));
  assert.equal(patchCli(patched), patched);
  const polyfill = patched.slice(original.indexOf('\n') + 1, -'process.stdout.write("started");\n'.length);
  assert.equal(patchCli(polyfill + '\n' + original), patched);
  const result = spawnSync(process.execPath, [], { input: patched, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'started');
});
