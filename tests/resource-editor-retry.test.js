'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runRceditWithRetry } = require('../build/after-pack');

test('resource editing recovers from transient Windows commit and sharing failures', async t => {
  t.mock.method(console, 'warn', () => {});
  const calls = [], delays = [], args = ['app.exe', '--set-file-version', '1.2.3'];
  const vm = { async exec(...call) {
    calls.push(call);
    if (calls.length === 1) throw new Error('Fatal error: Unable to commit changes');
    if (calls.length === 2) throw Object.assign(new Error('temporary sharing failure'), { code: 'EBUSY' });
    return 'edited';
  } };
  const result = await runRceditWithRetry(vm, 'rcedit.exe', args, async ms => delays.push(ms));
  assert.equal(result, 'edited');
  assert.deepEqual(delays, [500, 1000]);
  assert.deepEqual(calls, Array.from({ length: 3 }, () => ['rcedit.exe', args]));
});

test('resource editing bounds retries and preserves the final failure', async t => {
  t.mock.method(console, 'warn', () => {});
  const delays = [], failures = [];
  const vm = { async exec() {
    const error = new Error('Unable to commit changes attempt ' + failures.length);
    failures.push(error);
    throw error;
  } };
  await assert.rejects(runRceditWithRetry(vm, 'rcedit.exe', [], async ms => delays.push(ms)), error => error === failures.at(-1));
  assert.equal(failures.length, 5);
  assert.deepEqual(delays, [500, 1000, 2000, 4000]);
});

test('invalid resource inputs fail immediately without a retry', async () => {
  const expected = new Error('Fatal error: Unable to read icon file');
  let attempts = 0;
  const vm = { async exec() { attempts += 1; throw expected; } };
  await assert.rejects(runRceditWithRetry(vm, 'rcedit.exe', [], async () => assert.fail('must not retry')), error => error === expected);
  assert.equal(attempts, 1);
});
