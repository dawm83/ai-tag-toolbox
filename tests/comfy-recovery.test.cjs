'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const modules = require('../src/modules');

function fixture(options = {}) {
  const storage = modules.createStorage();
  const images = modules.createImages({ storage });
  let submits = 0;
  let offline = true;
  const comfy = modules.createComfy({ fetch: async (url, init) => {
    const path = new URL(url).pathname;
    if (path === '/system_stats') return { ok: true, json: async () => ({ system: {}, devices: [] }) };
    if (path === '/queue') return { ok: true, json: async () => ({ queue_running: [], queue_pending: [] }) };
    if (path === '/prompt') {
      submits++;
      if (options.unknownSubmission === 'http502') return { ok: false, status: 502, text: async () => 'gateway lost response' };
      if (options.unknownSubmission === 'missingId') return { ok: true, json: async () => ({}) };
      if (options.unknownSubmission) throw new Error('socket closed after submission');
      assert.equal(init.method, 'POST');
      return { ok: true, json: async () => ({ prompt_id: 'existing-prompt' }) };
    }
    if (path === '/history/existing-prompt') {
      if (offline) throw new Error('connection lost');
      return { ok: true, json: async () => ({ 'existing-prompt': { status: { completed: true }, outputs: { '1': { images: [{ filename: 'result.png', type: 'output' }] } } } }) };
    }
    if (path === '/view') return { ok: true, headers: { get: () => 'image/png' }, arrayBuffer: async () => Uint8Array.from([137, 80, 78, 71]).buffer };
    throw new Error('Unexpected endpoint ' + path);
  } });
  const assistantOptions = { storage, images, comfy,
    settings: { comfy: { enabled: true, base: 'http://fixture.test:8188', workflow: {
      '1': { class_type: 'SaveImage', inputs: { images: ['8', 0] } },
      '3': { class_type: 'KSampler', inputs: { positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0], model: ['4', 0], steps: 20, cfg: 7, seed: 1, sampler_name: 'euler', scheduler: 'normal' } },
      '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'fixture.safetensors' } },
      '5': { class_type: 'EmptyLatentImage', inputs: { width: 768, height: 1024, batch_size: 1 } },
      '6': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['4', 1] } },
      '7': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['4', 1] } },
      '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } }
    } }, generation: { autoRun: false } },
    primaryGateway: { complete: async messages => messages.at(-1).role === 'tool' ? { text: 'done' } : { toolCalls: [{ name: 'generation_execute', arguments: { requirements: 'portrait', outputType: 'images' } }] } },
    visionGateway: { complete: async () => ({ text: '{"positiveTags":["portrait"],"negativeTags":[]}' }) }
  };
  let assistant = modules.createAssistant(assistantOptions);
  return { get assistant() { return assistant; }, storage, comfy, submits: () => submits,
    restart: () => { assistant.destroy(); assistant = modules.createAssistant(assistantOptions); },
    reconnect: () => { offline = false; assistant.setSettings({ comfyOn: true }); } };
}

test('a lost history connection pauses and resumes the accepted prompt without another POST', async () => {
  const app = fixture();
  await app.assistant.refreshCapabilities();
  const first = await app.assistant.run({ text: 'draw portrait' });
  assert.equal(app.submits(), 1, JSON.stringify(app.storage.get('generation_jobs')[0].errors));
  assert.equal(first.data.status, 'needs_input');
  assert.equal(first.data.pendingRender.promptId, 'existing-prompt');
  assert.deepEqual(first.data.positiveTags, ['portrait']);
  assert.equal(app.storage.get('generation_jobs')[0].pendingRender.promptId, 'existing-prompt');
  const messageId = app.assistant.currentSession().messages.at(-1).id;
  app.restart();
  app.reconnect();
  await app.assistant.refreshCapabilities();
  const result = await app.assistant.continueGeneration(messageId, '', '', { resumeOnly: true });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.data.status, 'awaiting_feedback');
  assert.equal(app.submits(), 1, JSON.stringify(app.storage.get('generation_jobs')[0].errors));
  assert.equal(app.assistant.generation.get(first.data.jobId).pendingRender, null);
  app.assistant.destroy();
});

for (const unknownSubmission of [true, 'http502', 'missingId']) test(`an unknown submission outcome (${unknownSubmission}) is not retried automatically or on resume`, async () => {
  const app = fixture({ unknownSubmission });
  await app.assistant.refreshCapabilities();
  const first = await app.assistant.run({ text: 'draw portrait' });
  assert.equal(app.submits(), 1, JSON.stringify(app.storage.get('generation_jobs')[0].errors));
  assert.equal(first.data.status, 'needs_input');
  assert.match(first.data.needsInput.message, /提交结果未知/);
  await app.assistant.generation.resume({ jobId: first.data.jobId }, { sessionId: app.assistant.currentSession().id });
  assert.equal(app.submits(), 1, JSON.stringify(app.storage.get('generation_jobs')[0].errors));
  app.assistant.destroy();
});
