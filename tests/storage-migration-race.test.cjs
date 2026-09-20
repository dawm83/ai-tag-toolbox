'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStorage } = require('../src/modules/storage');
const { readLegacyInput } = require('../src/modules/tag-library/migration');

test('migration readers still see a complete old store while settings are being written', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-migration-race-'));
  const file = path.join(dir, 'rewrite-storage.json');
  const root = { 'ai-tag-toolbox-rewrite:app:rewrite_selected': '["blue_hair"]' };
  fs.writeFileSync(file, JSON.stringify(root));
  const write = fs.promises.writeFile;
  let release, entered;
  const paused = new Promise(resolve => { entered = resolve; });
  const proceed = new Promise(resolve => { release = resolve; });
  fs.promises.writeFile = async (target, value, options) => {
    await write(target, '', options);
    entered(); await proceed;
    return write(target, value, 'utf8');
  };
  const storage = createStorage({ prefix: 'ai-tag-toolbox-rewrite', filePath: file });
  let pending;
  t.after(async () => { release(); await pending; fs.promises.writeFile = write; fs.rmSync(dir, { recursive: true, force: true }); });
  storage.set('settings', { comfy: { enabled: false } });
  pending = storage.flush();
  await paused;
  assert.deepEqual(await readLegacyInput(file), { version: 1, values: { rewrite_selected: ['blue_hair'] } });
  release(); await pending;
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved['ai-tag-toolbox-rewrite:app:rewrite_selected'], '["blue_hair"]');
  assert.equal(JSON.parse(saved['ai-tag-toolbox-rewrite:app:settings']).comfy.enabled, false);
  assert.deepEqual(fs.readdirSync(dir), ['rewrite-storage.json']);
});

test('failed replacement leaves the old file intact and a subsequent flush can retry', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-replace-failure-'));
  const file = path.join(dir, 'rewrite-storage.json');
  const original = '{"ai-tag-toolbox-rewrite:app:rewrite_selected":"[]"}';
  fs.writeFileSync(file, original);
  const rename = fs.promises.rename;
  fs.promises.rename = async () => { throw Object.assign(new Error('fixture replace failed'), { code: 'EBUSY' }); };
  t.after(() => { fs.promises.rename = rename; fs.rmSync(dir, { recursive: true, force: true }); });
  const storage = createStorage({ prefix: 'ai-tag-toolbox-rewrite', filePath: file });
  storage.set('settings', { model: 'fixture' }); await storage.flush();
  assert.equal(storage.persistenceStatus().ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(dir), ['rewrite-storage.json']);
  fs.promises.rename = rename;
  await storage.flush();
  assert.equal(storage.persistenceStatus().ok, true);
  assert.equal(JSON.parse(JSON.parse(fs.readFileSync(file, 'utf8'))['ai-tag-toolbox-rewrite:app:settings']).model, 'fixture');
});
