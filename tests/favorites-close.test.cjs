'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('app close commits favorite drafts before the host save and keeps invalid drafts open', async () => {
  const events = [];
  let valid = false;
  const context = vm.createContext({
    AppModules: { prepareClose: async () => { events.push('host'); return true; } },
    AppView: { create: () => ({ start() {}, views: { favorites: { flushEdits: async () => { events.push('draft'); return valid; } } } }) }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src/app.js'), 'utf8'), context);
  assert.equal(typeof context.App.flushBeforeClose, 'function');
  assert.equal(await context.App.flushBeforeClose(), false);
  assert.deepEqual(events, ['draft']);
  valid = true;
  assert.equal(await context.App.flushBeforeClose(), true);
  assert.deepEqual(events, ['draft', 'draft', 'host']);
});

test('preload exposes the real favorite store and waits for all persistence before close', async () => {
  const { createFavorites } = require('../src/modules/favorites');
  const { joinFavoriteBlocks } = require('../src/modules/favorites-transfer');
  const { createStorage } = require('../src/modules/storage');
  const storage = createStorage();
  const calls = [];
  let bridge, injected, diskOk = false;
  storage.flush = async () => { calls.push('storage'); return diskOk; };
  const modules = {
    createStorage: () => storage, createFavorites, joinFavoriteBlocks,
    loadTagFiles: () => [], createTags: () => ({ get: () => null }),
    createCharacters: () => null, createVision: () => ({}), createImages: () => null,
    createTranslation: () => ({}),
    createAssistant: options => {
      injected = options.favorites;
      return { cancel: () => calls.push('cancel'), flushPersistence: async () => { calls.push('assistant'); return true; } };
    }
  };
  const root = path.resolve(__dirname, '..');
  vm.runInNewContext(fs.readFileSync(path.join(root, 'preload.js'), 'utf8'), {
    __dirname: root, process: { env: {}, execPath: path.join(root, 'test.exe'), cwd: () => root },
    console: { warn: message => assert.fail(message) },
    require: id => {
      if (id === 'node:path') return path;
      if (id === 'node:fs') return { mkdirSync() {}, existsSync: () => false, readFileSync: () => '{}' };
      if (id === 'electron') return { contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, 'AppModules'); bridge = value; } } };
      assert.equal(id, path.join(root, 'src', 'modules'));
      return modules;
    }
  });
  const seriesId = bridge.favorites.saveSeries({ name: 'Test' }).data.id;
  const imported = bridge.favorites.importPaste(' blue_hair \tBlue', { format: 'tsv', kind: 'tag', seriesId });
  assert.equal(imported.ok, true);
  assert.equal(injected.getEntry(imported.data.ids[0]).rawText, ' blue_hair ');
  assert.equal(bridge.joinFavoriteBlocks(['one', ' two ']), 'one,  two ');
  assert.equal(await bridge.prepareClose(), false);
  assert.deepEqual(calls, ['cancel', 'storage', 'assistant', 'storage']);
  diskOk = true;
  assert.equal(await bridge.prepareClose(), true);
});
