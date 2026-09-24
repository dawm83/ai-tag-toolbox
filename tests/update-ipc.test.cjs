'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerUpdateIpc } = require('../src/modules/update-ipc');

function fixture() {
  const handlers = new Map(), events = [], calls = [];
  const ipcMain = { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) };
  const service = {
    getState: async () => ({ activeVersion: '1.4.353', installed: [] }),
    listReleases: async () => [{ version: '1.4.354', installable: true, assets: { zip: { size: 100 } } }],
    downloadAndStage: async (version, options) => { calls.push(['download', version]); options.onProgress?.({ received: 5, total: 10 }); return { version, stagedDirectory: '.staging/V1.4.354-test', buildInfo: { version } }; },
    switchInstalled: async version => { calls.push(['switch', version]); return { activeVersion: version, pendingVersion: version }; },
    prepareSwitch: async (version, directory) => { calls.push(['prepare', version, directory]); return { pendingVersion: version, pendingDirectory: directory }; },
    cancelDownload: () => { calls.push(['cancel']); return true; }
  };
  const dispose = registerUpdateIpc({ ipcMain, service, getWindow: () => ({ webContents: { send: (...args) => events.push(args) } }), prepareClose: async () => { calls.push(['close']); return true; }, requestHost: async args => { calls.push(['host', args]); } });
  return { handlers, service, events, calls, dispose };
}

test('registers scoped update handlers and forwards only progress metadata', async () => {
  const f = fixture(), event = { sender: { send: (...args) => f.events.push(args) } };
  assert.deepEqual(await f.handlers.get('updates:get-state')(event), { activeVersion: '1.4.353', installed: [] });
  assert.equal((await f.handlers.get('updates:list')(event))[0].version, '1.4.354');
  const result = await f.handlers.get('updates:download')(event, '1.4.354');
  assert.equal(result.version, '1.4.354');
  assert.deepEqual(f.events, [['updates:event', { type: 'progress', received: 5, total: 10 }]]);
  assert.deepEqual(f.calls, [['download', '1.4.354']]);
});

test('switch waits for close flush and starts the external host', async () => {
  const f = fixture();
  const result = await f.handlers.get('updates:switch-installed')({ sender: { send: () => {} } }, '1.4.354');
  assert.equal(result.pendingVersion, '1.4.354');
  assert.deepEqual(f.calls.map(row => row[0]), ['close', 'switch', 'host']);
  assert.equal(f.calls[2][1].state.pendingVersion, '1.4.354');
});

test('failed close blocks switching and does not invoke the service', async () => {
  const handlers = new Map(), calls = [];
  registerUpdateIpc({ ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: () => {} }, service: { switchInstalled: async () => calls.push('switch') }, prepareClose: async () => false, requestHost: async () => calls.push('host') });
  await assert.rejects(handlers.get('updates:switch-installed')({}, '1.4.354'), error => error.code === 'PERSISTENCE_BLOCKED');
  assert.deepEqual(calls, []);
});

test('staged installation prepares the target and invokes the host only after close flush', async () => {
  const f = fixture();
  const result = await f.handlers.get('updates:apply-staged')({ sender: { send: () => {} } }, '1.4.354', '.staging/V1.4.354-test');
  assert.equal(result.pendingDirectory, '.staging/V1.4.354-test');
  assert.deepEqual(f.calls.map(row => row[0]), ['close', 'prepare', 'host']);
});
