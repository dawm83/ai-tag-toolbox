'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createCatalogBootstrap } = require('../src/modules/tag-library/bootstrap');
const root = path.resolve(__dirname, '..');
const hostRequire = createRequire(path.join(root, 'preload.js'));
const prefix = 'ai-tag-toolbox-rewrite:app:';

function temporary(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tag-bootstrap-test-'));
  const userDataDir = path.join(temp, 'ai-tag-toolbox-rewrite'); fs.mkdirSync(userDataDir);
  t.after(() => {
    const relative = path.relative(os.tmpdir(), temp);
    assert.ok(relative.startsWith('tag-bootstrap-test-') && !relative.includes(path.sep));
    fs.rmSync(temp, { recursive: true, force: true });
  });
  return { temp, userDataDir, storagePath: path.join(userDataDir, 'rewrite-storage.json'), v2: path.join(userDataDir, 'tag-library-v2.json') };
}

// Only Electron's bridge/process environment is substituted. Every catalog,
// adapter, storage and eager assistant constructor below is the real module.
function preload(temp) {
  let bridge; const warnings = [];
  vm.runInNewContext(fs.readFileSync(path.join(root, 'preload.js'), 'utf8'), {
    __dirname: root, process: { env: { APPDATA: temp }, execPath: process.execPath, cwd: () => root },
    console: { warn: (...args) => warnings.push(args) },
    require: name => name === 'electron' ? { contextBridge: { exposeInMainWorld: (key, value) => { assert.equal(key, 'AppModules'); bridge = value; } } } : hostRequire(name)
  });
  assert.ok(bridge); return { bridge, warnings };
}

function legacyRoot() {
  const sessions = { format: 'ai-tag-sessions', version: 1, currentId: 'kept-session', sessions: [{ id: 'kept-session', title: 'Kept', createdAt: 1, updatedAt: 1, messages: [{ id: 'kept-message', role: 'user', text: 'Keep this text', createdAt: 1 }] }] };
  return { [prefix + 'sessions']: JSON.stringify(sessions), [prefix + 'settings']: JSON.stringify({ comfy: { enabled: false }, primaryApi: { model: 'kept-model' } }), [prefix + 'rewrite_custom_tags']: '[]', [prefix + 'rewrite_selected']: '[]' };
}

test('real preload preserves malformed legacy bytes even beside valid v2, then reloads repaired sessions', async t => {
  const dirs = temporary(t);
  const first = createCatalogBootstrap({ userDataDir: dirs.userDataDir });
  assert.equal((await first.catalog.ready()).ok, true); await first.library.dispose();
  const originalV2 = fs.readFileSync(dirs.v2);
  let blocked;
  for (const raw of ['{broken', '[]', JSON.stringify({ [prefix + 'rewrite_custom_tags']: '{bad' })]) {
    fs.writeFileSync(dirs.storagePath, raw);
    const host = preload(dirs.temp); blocked = host.bridge;
    assert.equal((await blocked.catalog.ready()).ok, false);
    assert.equal(blocked.tags, null); assert.equal(blocked.assistant, null);
    assert.equal(await blocked.prepareClose(), true);
    assert.equal((await blocked.catalog.retryInitialization()).ok, false);
    assert.equal((await blocked.catalog.recoverBackup()).ok, false);
    assert.equal(fs.readFileSync(dirs.storagePath, 'utf8'), raw);
    assert.deepEqual(fs.readFileSync(dirs.v2), originalV2);
    assert.ok(host.warnings.every(args => !args.join(' ').includes(raw)));
  }
  const repaired = legacyRoot(); fs.writeFileSync(dirs.storagePath, JSON.stringify(repaired));
  assert.equal((await blocked.catalog.retryInitialization()).data.reloadRequired, true);
  assert.equal(await blocked.prepareClose(), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(dirs.storagePath, 'utf8')), repaired);
  const loaded = preload(dirs.temp);
  assert.equal((await loaded.bridge.catalog.ready()).ok, true); assert.equal(loaded.warnings.length, 0);
  assert.equal(loaded.bridge.assistant.sessions()[0].id, 'kept-session');
  assert.equal(loaded.bridge.assistant.sessions()[0].messages[0].text, 'Keep this text');
  assert.equal(await loaded.bridge.prepareClose(), true);
  const after = JSON.parse(fs.readFileSync(dirs.storagePath, 'utf8'));
  assert.equal(after[prefix + 'settings'], repaired[prefix + 'settings']);
  assert.equal(after[prefix + 'rewrite_custom_tags'], '[]'); assert.equal(after[prefix + 'rewrite_selected'], '[]');
  assert.deepEqual(fs.readFileSync(dirs.v2), originalV2);
  for (const name of ['repository', 'save', 'backupLegacy', 'readLegacyInput', 'filePath']) assert.equal(loaded.bridge.catalog[name], undefined);
});

test('real preload closes an unready corrupt catalog but blocks an accepted failed write until retry', async t => {
  const dirs = temporary(t); fs.writeFileSync(dirs.storagePath, JSON.stringify(legacyRoot()));
  fs.writeFileSync(dirs.v2, '{corrupt');
  const host = preload(dirs.temp); const { bridge } = host;
  assert.equal((await bridge.catalog.ready()).ok, false);
  assert.equal(await bridge.prepareClose(), true);
  assert.equal(fs.readFileSync(dirs.v2, 'utf8'), '{corrupt');
  fs.unlinkSync(dirs.v2);
  assert.equal((await bridge.catalog.retryInitialization()).ok, true);
  const preserved = path.join(dirs.userDataDir, 'held-valid-v2.json');
  fs.renameSync(dirs.v2, preserved); fs.mkdirSync(dirs.v2);
  const command = { type: 'saveTag', tagId: 'blue_hair', patch: { note: 'durable' } }, options = { operationId: 'close-retry' };
  try {
    assert.equal((await bridge.catalog.execute(command, options)).error.code, 'STORAGE_WRITE_FAILED');
    assert.equal(bridge.catalog.getTag('blue_hair').note, '');
    assert.equal(await bridge.prepareClose(), false);
  } finally { fs.rmdirSync(dirs.v2); fs.renameSync(preserved, dirs.v2); }
  assert.equal((await bridge.catalog.execute(command, options)).ok, true);
  assert.equal(await bridge.prepareClose(), true);
  assert.equal(JSON.parse(fs.readFileSync(dirs.v2, 'utf8')).tagOverrides.find(row => row.tagId === 'blue_hair').patch.note, 'durable');
  assert.equal(bridge.assistant.sessions()[0].id, 'kept-session');
});
