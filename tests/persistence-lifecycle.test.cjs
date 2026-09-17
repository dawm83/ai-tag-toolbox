'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const modules = require('../src/modules');

function adapterWithCounter() {
  const values = new Map();
  let writes = 0;
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => { writes += 1; values.set(key, String(value)); return true; },
    removeItem: key => { values.delete(key); return true; },
    key: index => [...values.keys()][index] || null,
    get length() { return values.size; },
    writes: () => writes
  };
}

test('storage flush writes the latest value before returning', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tag-storage-'));
  const filename = path.join(dir, 'state.json');
  const storage = modules.createStorage({ filePath: filename, prefix: 'flush-test' });

  storage.set('value', { current: 2 });
  assert.equal(typeof storage.flush, 'function');
  await storage.flush();

  const restored = modules.createStorage({ filePath: filename, prefix: 'flush-test' });
  assert.deepEqual(restored.get('value'), { current: 2 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('assistant coalesces burst events into bounded persistence writes', async () => {
  const adapter = adapterWithCounter();
  const storage = modules.createStorage({ adapter, prefix: `assistant-persist-${Date.now()}` });
  const assistant = modules.createAssistant({
    storage,
    primaryApi: { base: 'https://example.test/v1', model: 'test-model' },
    primaryGateway: {
      complete: async (_messages, options) => {
        for (let index = 0; index < 20; index += 1) options.onEvent?.({ type: 'progress', index });
        return { ok: true, text: '完成' };
      }
    }
  });
  const before = adapter.writes();

  const result = await assistant.run({ text: '写入事件' });
  await new Promise(resolve => setTimeout(resolve, 280));

  assert.equal(result.ok, true);
  assert.ok(adapter.writes() - before <= 4, `persistence writes: ${adapter.writes() - before}`);
  await storage.flush();
});

test('a late provider failure persists the terminal state after the stream timer drains', async () => {
  const storage = modules.createStorage();
  let rejectReply;
  const streamed = new Promise(resolve => storage.subscribe(event => {
    if (event.value?.sessions?.[0]?.messages?.at(-1)?.text === 'partial') resolve();
  }));
  const assistant = modules.createAssistant({
    storage,
    primaryApi: { base: 'https://example.test/v1', model: 'test-model' },
    primaryGateway: { stream: async (_messages, options) => {
      options.onDelta('partial');
      return new Promise((_resolve, reject) => { rejectReply = reject; });
    } }
  });
  const reply = assistant.run({ text: 'failure' });
  await streamed;
  rejectReply(new Error('provider failed'));
  assert.equal((await reply).ok, false);
  assert.equal(storage.get('sessions').sessions[0].messages.at(-1).status, 'error');
  assert.equal(storage.get('sessions').sessions[0].messages.at(-1).result.ok, false);
});

test('completion cannot be cancelled while its terminal snapshot is being flushed', async () => {
  const storage = modules.createStorage();
  let finish;
  let entered;
  const flushing = new Promise(resolve => { entered = resolve; });
  const disk = new Promise(resolve => { finish = resolve; });
  storage.flush = () => { entered(); return disk; };
  const assistant = modules.createAssistant({
    storage, primaryApi: { base: 'https://example.test/v1', model: 'test-model' },
    primaryGateway: { complete: async () => ({ text: 'done' }) }
  });
  const reply = assistant.run({ text: 'save', requestId: 'save-terminal' });
  await flushing;
  assert.equal(assistant.cancel('save-terminal'), false);
  finish();
  const result = await reply;
  assert.equal(result.ok, true);
  assert.equal(result.status, 'done');
  assert.equal(storage.get('sessions').sessions[0].messages.at(-1).status, 'done');
});

test('a cancelled run waits for its cancelled snapshot to reach storage', async () => {
  const storage = modules.createStorage();
  let finish;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  storage.flush = () => new Promise(resolve => { finish = resolve; });
  const assistant = modules.createAssistant({
    storage, primaryApi: { base: 'https://example.test/v1', model: 'test-model' },
    primaryGateway: { complete: () => { started(); return new Promise(() => {}); } }
  });
  let settled = false;
  const reply = assistant.run({ text: 'cancel', requestId: 'cancel-flush' }).then(result => { settled = true; return result; });
  await ready;
  assert.equal(assistant.cancel('cancel-flush'), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(storage.get('sessions').sessions[0].messages.at(-1).status, 'cancelled');
  finish();
  assert.equal((await reply).error.code, 'CANCELLED');
});
