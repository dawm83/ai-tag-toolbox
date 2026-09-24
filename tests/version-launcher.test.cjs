'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveActiveExecutable } = require('../src/modules/version-launcher');

test('resolves only the active version slot under the install root', () => {
  assert.equal(resolveActiveExecutable('C:\\Install', { activeVersion: '1.4.354' }), 'C:\\Install\\versions\\V1.4.354\\AI绘画Tag工具箱V1.4.354.exe');
  assert.throws(() => resolveActiveExecutable('C:\\Install', { activeVersion: '../outside' }), error => error.code === 'INVALID_VERSION');
});

test('falls back to the previous slot when the active version never reports readiness', async () => {
  const started = [], writes = [];
  const result = await require('../src/modules/version-launcher').launchActiveVersion({
    rootDir: 'C:\\Install',
    readState: async () => ({ activeVersion: '1.4.354', previousVersion: '1.4.353', installed: [{ version: '1.4.353' }, { version: '1.4.354' }] }),
    writeState: async state => writes.push(state),
    exists: async () => true,
    startProcess: async executable => started.push(executable),
    waitForReady: async () => started.length > 1,
    random: () => 'nonce'
  });
  assert.equal(result.ok, true);
  assert.deepEqual(started, ['C:\\Install\\versions\\V1.4.354\\AI绘画Tag工具箱V1.4.354.exe', 'C:\\Install\\versions\\V1.4.353\\AI绘画Tag工具箱V1.4.353.exe']);
  assert.equal(writes.at(-1).activeVersion, '1.4.353');
  assert.equal(writes.at(-1).lastError.code, 'LAUNCH_TIMEOUT');
});
