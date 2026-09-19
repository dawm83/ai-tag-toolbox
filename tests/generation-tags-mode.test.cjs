'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAssistant } = require('../src/modules/assistant');
const { createStorage } = require('../src/modules/storage');
const { createGenerationOrchestrator } = require('../src/modules/generation-orchestrator');

test('the default assistant delivers and persists Tags without contacting ComfyUI', async () => {
  const storage = createStorage();
  let networkCalls = 0;
  let toolReply;
  const assistant = createAssistant({ storage,
    comfy: { status: async () => { networkCalls++; throw new Error('ComfyUI is offline'); }, render: async () => { networkCalls++; throw new Error('Unexpected render'); } },
    primaryGateway: { complete: async messages => {
      if (messages.at(-1).role === 'tool') { toolReply = JSON.parse(messages.at(-1).content); return { text: 'Tag 已生成。' }; }
      return { toolCalls: [{ name: 'generation_execute', arguments: { requirements: '蓝发女孩', outputType: 'images' } }] };
    } },
    visionGateway: { complete: async () => ({ text: '{"positiveTags":["1girl","blue hair"],"negativeTags":[]}' }) }
  });
  assert.equal(assistant.primaryTools.primaryNames().includes('comfy.status'), false);
  const output = await assistant.run({ text: '生成蓝发女孩的 Tag' });
  assert.equal(output.ok, true, JSON.stringify(output.error));
  assert.equal(output.data.status, 'completed');
  assert.equal(output.outputType, 'tags');
  assert.deepEqual(output.positiveTags, ['1girl', 'blue hair']);
  assert.deepEqual(toolReply.positiveTags, ['1girl', 'blue hair']);
  assert.equal(networkCalls, 0);
  const message = assistant.currentSession().messages.at(-1);
  assert.equal(message.result.prompt, '1girl, blue hair');
  assistant.destroy();
  const reloaded = createAssistant({ storage });
  assert.equal(reloaded.currentSession().messages.at(-1).result.prompt, '1girl, blue hair');
  reloaded.destroy();
});

test('explicit Tags output skips preflight and keeps reference-image preparation', async () => {
  const calls = [];
  const generation = createGenerationOrchestrator({
    getSettings: () => ({ comfy: { enabled: true } }),
    runSubAgent: async (name) => { calls.push(name); return name === 'vision' ? { description: 'blue hair' } : { positiveTags: ['blue hair'], negativeTags: [] }; },
    listConversationImages: () => ({ items: [{ imageId: 'source' }] }),
    preflight: async () => { throw new Error('Tags must not check workflows'); },
    renderCandidate: async () => { throw new Error('Tags must not render'); }
  });
  const result = await generation.execute({ requirements: '参考图提取 Tag', sourceImageId: 'source', outputType: 'tags' });
  assert.equal(result.status, 'completed');
  assert.deepEqual(calls, ['vision', 'generateTags']);
  assert.equal(result.renderAttempts, 0);
});

test('a Tags task remains Tags-only after character selection and reload', async () => {
  const storage = createStorage();
  let enabled = false;
  const options = { storage, getSettings: () => ({ comfy: { enabled } }),
    resolveCharacter: () => ({ items: [] }),
    runSubAgent: async () => ({ positiveTags: ['1girl'] }),
    preflight: async () => { throw new Error('Unexpected workflow check'); }
  };
  const original = createGenerationOrchestrator(options);
  const waiting = await original.execute({ requirements: '小星', characterQueries: ['小星'] });
  assert.equal(waiting.needsInput.kind, 'character');
  enabled = true;
  const reloaded = createGenerationOrchestrator(options);
  const result = await reloaded.resume({ jobId: waiting.jobId, characterSelection: { query: '小星', original: true } });
  assert.equal(result.status, 'completed');
  assert.equal(result.outputType, 'tags');
});

test('workflow failures expose compiled Tags to the primary AI', async () => {
  const generation = createGenerationOrchestrator({
    runSubAgent: async () => ({ positiveTags: ['portrait'], negativeTags: ['lowres'] }),
    preflight: async () => ({ ready: false, connected: false, error: 'offline' })
  });
  const result = await generation.execute({ requirements: 'portrait' });
  const publicResult = generation.publicResult(result.jobId);
  assert.equal(publicResult.status, 'needs_input');
  assert.deepEqual(publicResult.positiveTags, ['portrait']);
  assert.deepEqual(publicResult.negativeTags, ['lowres']);
});

test('a confirmed disconnect disables drawing and reconnection does not enable it', async () => {
  let connected = false;
  const assistant = createAssistant({ settings: { comfy: { enabled: true } }, comfy: {
    render: async () => ({}),
    status: async () => ({ connected, workflowReady: true, render: connected, error: connected ? '' : 'offline' })
  } });
  await assistant.refreshCapabilities();
  assert.equal(assistant.getSettings().comfyOn, false);
  connected = true;
  await assistant.refreshCapabilities();
  assert.equal(assistant.getSettings().comfyOn, false);
  assert.equal(assistant.getCapabilities().comfy.render, false);
  assistant.destroy();
});
