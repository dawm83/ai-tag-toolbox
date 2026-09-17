'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAssistant } = require('../src/modules/assistant');

function fixture() {
  const replies = [];
  const assistant = createAssistant({
    comfy: { status: () => new Promise(resolve => replies.push(resolve)), render: async () => ({}) }
  });
  return { assistant, replies };
}

test('late capability probes cannot overwrite a newer response', async () => {
  const { assistant, replies } = fixture();
  const old = assistant.refreshCapabilities();
  const latest = assistant.refreshCapabilities();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(replies.length, 2);
  replies[1]({ connected: true, workflowReady: true, render: true, error: '' });
  await latest;
  replies[0]({ connected: false, error: 'old connection' });
  await old;
  assert.equal(assistant.getCapabilities().comfy.connected, true);
  assert.equal(assistant.getCapabilities().comfy.error, '');
});

test('editing settings invalidates an in-flight capability probe', async () => {
  const { assistant, replies } = fixture();
  const before = assistant.getCapabilities();
  const old = assistant.refreshCapabilities();
  await new Promise(resolve => setImmediate(resolve));
  assistant.setSettings({ comfyBase: 'http://127.0.0.1:9191' });
  replies[0]({ connected: true, workflowReady: true, render: true });
  await old;
  assert.deepEqual(assistant.getCapabilities(), before);
});
