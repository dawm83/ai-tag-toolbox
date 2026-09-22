'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAssistant } = require('../src/modules/assistant');
const { createStorage } = require('../src/modules/storage');
const { createImages } = require('../src/modules/images');
let callNumber = 0;
const call = (name, args) => ({ toolCalls: [{ id: `call-${++callNumber}`, name: name.replace('.', '_'), arguments: args }] });
const toolResult = messages => { const row = messages.findLast(m => m.role === 'tool'); return row ? JSON.parse(row.content) : null; };

function setup(t, decide, settings = {}) {
  const storage = createStorage(), images = createImages({ storage }), renders = [], children = [], primary = [], local = [];
  const source = images.add({ filename: 'reference.png', mime: 'image/png', dataUrl: 'data:image/png;base64,AQID' });
  const app = createAssistant({ storage, images,
    primaryApi: { model: 'fixture-vision', base: 'https://fixture.test/v1' },
    primaryGateway: { complete: async (messages, config) => { primary.push(structuredClone(messages)); return decide({ messages, config, result: toolResult(messages), source, app, turn: primary.length }); } },
    localVision: { analyze: async () => { local.push(1); return { ok: true, tags: [{ tag: '2girls', confidence: 0.7 }, { tag: 'standing', confidence: 0.6 }, { tag: 'garden', confidence: 0.5 }] }; } },
    visionGateway: { complete: async messages => {
      children.push(structuredClone(messages));
      if (messages[0].content.includes('系统修订协议')) return { text: '{"add":["3girls"],"remove":["2girls"],"preserve":[]}' };
      throw new Error('Unexpected hidden AI stage');
    } },
    comfy: { status: async () => ({ connected: true, workflowReady: true, render: true }), render: async input => {
      renders.push(structuredClone({ prompt: input.prompt, negative: input.negative }));
      return { artifact: { id: `draw-${renders.length}`, dataUrl: 'data:image/png;base64,BAUG', filename: 'output.png', mime: 'image/png' } };
    } },
    settings: { comfy: { enabled: true }, generation: { autoRun: true, maxAutoRounds: 2 }, limits: { maxToolRounds: 16 }, ...settings }
  });
  t.after(() => app.destroy());
  return { app, images, source, renders, children, primary, local, storage };
}

test('primary selects metadata, one local hint, baseline render and a minimal revision before rendering again', async t => {
  let jobId;
  const f = setup(t, ({ turn, source, result, config }) => {
    assert(config.tools.some(t => t.function.name === 'vision_processOne') || turn === 8);
    if (turn === 1) return call('vision.processOne', { imageId: source.id, mode: 'metadata' });
    if (turn === 2 || turn === 3) return call('vision.processOne', { imageId: source.id, mode: 'local' });
    if (turn === 4) { assert.equal(result.evidenceRole, 'initial_hint'); return call('generation.execute', { originalRequirements: '复刻参考图', sourceImageId: source.id, mode: 'recreate', positiveTags: result.tags }); }
    if (turn === 5) { jobId = result.jobId; assert.equal(result.decisionRequired, true); return call('agent.generateTags', { operation: 'revise', requirements: '修正人数，保留场景姿势', positiveTags: result.positiveTags, changes: ['参考图是三人，改为3girls'] }); }
    if (turn === 6) return call('generation.resume', { jobId, action: 'continue', baseCandidateId: 'candidate-1', positiveTags: result.positiveTags, feedback: '三个人' });
    if (turn === 7) return call('generation.select', { jobId, candidateId: 'candidate-2' });
    return { text: '已完成，按实际结果交付。' };
  });
  await f.app.refreshCapabilities();
  const result = await f.app.run({ text: '复刻参考图', imageIds: [f.source.id] });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.jobId, jobId);
  assert.equal(f.renders.length, 2);
  assert.equal(f.renders[0].prompt, '2girls, standing, garden');
  assert.equal(f.renders[1].prompt, 'standing, garden, 3girls');
  assert.equal(f.local.length, 1);
  assert.equal(f.children.length, 1);
  assert.equal(result.selectedCandidateId, 'candidate-2');
  assert.equal(f.primary[4].flatMap(m => Array.isArray(m.content) ? m.content : []).filter(p => p.type === 'image_url').length, 2);
  assert.doesNotMatch(f.children[0][1].content[0].text, /blueprint|feedbackHistory|角色身份资料/);
  assert.doesNotMatch(f.app.exportSessions(), /base64|AQID/);
});

test('the primary tool schema excludes upstream dossiers and rejects side-channel task context', async t => {
  const f = setup(t, () => ({ text: 'ok' }));
  const schema = f.app.primaryTools.openAiTools().find(row => row.function.name === 'agent_generateTags');
  assert(schema);
  assert.deepEqual(Object.keys(schema.function.parameters.properties).sort(), ['changes','generateNegativeTags','imageId','negativeTags','operation','positiveTags','requirements'].sort());
  const rejected = await f.app.runtime.runPrimary({ sessionId: f.app.currentSession().id, messages: [{ role: 'user', content: '直接回答' }] });
  assert.equal(rejected.ok, true);
});

test('candidate feedback returns to the primary with the original job and selected Tags, without repeating local recognition', async t => {
  let phase = 'create', jobId;
  const f = setup(t, ({ source, result, messages }) => {
    if (phase === 'create') { phase = 'created'; return call('generation.execute', { requirements: '花园里的两个角色', positiveTags: ['2girls', 'standing', 'garden'], sourceImageId: source.id }); }
    if (phase === 'created') { jobId = result.jobId; phase = 'idle'; return { text: '完成首轮' }; }
    if (phase === 'feedback') {
      const note = messages.findLast(row => row.role === 'user' && typeof row.content === 'string').content;
      assert.match(note, new RegExp(jobId)); assert.match(note, /candidate-1/); assert.match(note, /2girls.*standing.*garden/s);
      phase = 'revised'; return call('agent.generateTags', { operation: 'revise', requirements: '只改人数', positiveTags: ['2girls', 'standing', 'garden'], changes: ['改为三人'] });
    }
    if (phase === 'revised') { phase = 'resumed'; return call('generation.resume', { jobId, action: 'continue', baseCandidateId: 'candidate-1', positiveTags: result.positiveTags }); }
    return { text: '已按反馈修改。' };
  }, { generation: { autoRun: false, maxAutoRounds: 1 } });
  await f.app.refreshCapabilities();
  await f.app.run({ text: '复刻参考图', imageIds: [f.source.id] });
  const message = f.app.currentSession().messages.at(-1);
  phase = 'feedback';
  const result = await f.app.continueGeneration(message.id, 'candidate-1', '改为三个人');
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.jobId, jobId);
  assert.equal(f.renders[1].prompt, 'standing, garden, 3girls');
  assert.equal(f.local.length, 0);
  assert.equal(f.children.length, 1);
});
