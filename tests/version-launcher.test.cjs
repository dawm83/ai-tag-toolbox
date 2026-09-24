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

test('launches a legacy versioned executable when the state file is missing', async () => {
  const started = [];
  const result = await require('../src/modules/version-launcher').launchActiveVersion({
    rootDir: 'C:\\Install',
    readState: async () => { throw new Error('missing state'); },
    listLegacy: async () => ['AI绘画Tag工具箱V1.4.353.exe'],
    exists: async () => true,
    startProcess: async (executable, args) => started.push([executable, args])
  });
  assert.equal(result.legacy, true);
  assert.deepEqual(started, [['C:\\Install\\AI绘画Tag工具箱V1.4.353.exe', ['--legacy-version-host']]]);
});

test('falls back when the active slot executable is missing', async () => {
  const started = [], writes = [];
  const result = await require('../src/modules/version-launcher').launchActiveVersion({
    rootDir: 'C:\\Install',
    readState: async () => ({ activeVersion: '1.4.354', previousVersion: '1.4.353', installed: [{ version: '1.4.353' }, { version: '1.4.354' }] }),
    writeState: async state => writes.push(state),
    exists: async filename => String(filename).includes('1.4.353'),
    startProcess: async executable => started.push(executable),
    waitForReady: async () => true,
    random: () => 'nonce'
  });
  assert.equal(result.version, '1.4.353');
  assert.deepEqual(started, ['C:\\Install\\versions\\V1.4.353\\AI绘画Tag工具箱V1.4.353.exe']);
  assert.equal(writes[0].lastError.code, 'VERSION_MISSING');
});

test('launches the business GUI without the Windows hidden-window flag', async () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const { EventEmitter } = require('node:events');
  const calls = [], module = { exports: {} };
  const filename = path.resolve(__dirname, '../src/modules/version-launcher.js');
  const moduleRequire = require('node:module').createRequire(filename);
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, setTimeout,
    require: name => name === 'node:child_process' ? { spawn(executable, args, options) {
      calls.push({ executable, args, options });
      const child = new EventEmitter(); child.unref = () => {};
      return child;
    } } : moduleRequire(name)
  });
  await module.exports.launchActiveVersion({
    rootDir: 'C:\\Install',
    readState: async () => ({ activeVersion: '1.4.354', previousVersion: '1.4.354', installed: [{ version: '1.4.354' }] }),
    writeState: async () => {}, exists: async () => true, waitForReady: async () => true, random: () => 'nonce'
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, 'C:\\Install\\versions\\V1.4.354\\AI绘画Tag工具箱V1.4.354.exe');
  assert.equal(calls[0].options.windowsHide, false);
  assert.equal(calls[0].options.detached, true);
});
