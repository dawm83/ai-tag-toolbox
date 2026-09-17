'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStorage } = require('../src/modules/storage');
const { makeMemoryAdapter } = require('../src/modules/storage');
const { createAssistant } = require('../src/modules/assistant');

test('failed writes report an error while preserving the latest in-memory value', () => {
  const errors = [];
  const storage = createStorage({
    adapter: {
      getItem: () => JSON.stringify('old'),
      setItem: () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); }
    }, onError: error => errors.push(error)
  });
  storage.set('value', 'new');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'ENOSPC');
  assert.equal(storage.persistenceStatus().ok, false);
  assert.equal(storage.get('value'), 'new');
});

test('a failed file flush is observable and can retry without another edit', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tag-write-error-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const parent = path.join(dir, 'blocked');
  fs.writeFileSync(parent, 'not a directory');
  const storage = createStorage({ filePath: path.join(parent, 'state.json') });
  const errors = [];
  storage.subscribeErrors?.(error => errors.push(error));
  storage.set('value', { current: 3 });
  assert.equal(await storage.flush(), false);
  assert.equal(storage.persistenceStatus().ok, false);
  assert.equal(errors.length, 1);
  fs.unlinkSync(parent);
  assert.equal(await storage.flush(), true);
  assert.equal(storage.persistenceStatus().ok, true);
  assert.deepEqual(createStorage({ filePath: path.join(parent, 'state.json') }).get('value'), { current: 3 });
});

test('a rejecting custom flush reports failure without leaving the assistant busy', async () => {
  const adapter = makeMemoryAdapter();
  let fail = true;
  adapter.flush = async () => { if (fail) throw new Error('custom flush failed'); return true; };
  const storage = createStorage({ adapter });
  const errors = [];
  storage.subscribeErrors(error => errors.push(error));
  const assistant = createAssistant({ storage, primaryGateway: { complete: async () => ({ text: 'ready' }) } });
  assert.equal((await assistant.run({ text: 'first' })).ok, true);
  assert.equal(assistant.snapshot().busy, false);
  assert.equal(storage.persistenceStatus().ok, false);
  assert.ok(errors.length > 0);
  fail = false;
  assert.equal((await assistant.run({ text: 'second' })).ok, true);
  assert.equal(storage.persistenceStatus().ok, true);
});
