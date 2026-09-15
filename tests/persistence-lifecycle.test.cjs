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
