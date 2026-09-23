'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAssistant } = require('../src/modules/assistant');
const { createStorage } = require('../src/modules/storage');
const { createImages } = require('../src/modules/images');
let callNumber = 0;
const call = (name, args) => ({ toolCalls: [{ id: `call-${++callNumber}`, name: name.replace('.', '_'), arguments: args }] });
const toolResult = messages => { const row = messages.findLast(m => m.role === 'tool'); return row ? JSON.parse(row.content) : null; };

function setup(t, decide, settings = {}, extra = {}) {
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
    settings: { comfy: { enabled: true }, generation: { autoRun: true, maxAutoRounds: 2 }, limits: { maxToolRounds: 16 }, ...settings }, ...extra
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
  assert.equal(result.outcome, 'primary_selected');
  assert.equal(f.primary[4].flatMap(m => Array.isArray(m.content) ? m.content : []).filter(p => p.type === 'image_url').length, 2);
  assert.doesNotMatch(f.children[0][1].content[0].text, /blueprint|feedbackHistory|角色身份资料/);
  assert.doesNotMatch(f.app.exportSessions(), /base64|AQID/);
});

test('the primary tool schema excludes upstream dossiers and rejects side-channel task context', async t => {
  const f = setup(t, ({ turn }) => turn === 1 ? call('agent.generateTags', { operation: 'compile', requirements: 'draw', description: 'UNTRUSTED_EXTRA_CONTEXT' }) : { text: '改用最小输入' });
  const schema = f.app.primaryTools.openAiTools().find(row => row.function.name === 'agent_generateTags');
  assert(schema);
  assert.deepEqual(Object.keys(schema.function.parameters.properties).sort(), ['changes','generateNegativeTags','imageId','operation','positiveTags','requirements'].sort());
  const rejected = await f.app.runtime.runPrimary({ sessionId: f.app.currentSession().id, messages: [{ role: 'user', content: 'draw' }] });
  assert.equal(rejected.ok, true);
  assert.equal(rejected.data.toolCalls[0].error.code, 'INVALID_INPUT');
  assert.equal(f.children.length, 0);
});

test('character searches feed the original request and identity Tags into the first Tag compilation', async t => {
  const tagMessages = [];
  const f = setup(t, ({ turn, result }) => {
    if (turn === 1) return call('characters.search', { query: '阿米娅' });
    if (turn === 2) return call('characters.search', { query: '凯尔希' });
    if (turn === 3) return call('generation.execute', { mode: 'create', characterIds: ['amiya', 'kaltsit'] });
    return { text: '首轮已生成。' };
  }, {}, {
    characters: {
      page: ({ query }) => ({ items: [{ id: query === '阿米娅' ? 'amiya' : 'kaltsit' }], total: 1 }),
      get: id => ({ id, name: id, identityTags: [`${id}_identity`], generalTags: [{ id: `${id}_clothes`, en: `${id}_default_clothes` }], specificTags: [] })
    },
    visionGateway: {
      complete: async messages => {
        tagMessages.push(structuredClone(messages));
        return { text: '{"positiveTags":["1girl","amiya_identity","kaltsit_identity"]}' };
      }
    }
  });
  await f.app.refreshCapabilities();
  const result = await f.app.run('画一张侧面视角的场景：阿米娅戴兔子耳朵，凯尔希白发猫耳，按原始描述生成');
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(f.renders.length, 1);
  const compile = tagMessages.find(messages => JSON.stringify(messages).includes('系统输出协议'));
  assert(compile, 'the generation Tag subagent should receive the compilation request');
  assert.match(compile[1].content[0].text, /侧面视角.*阿米娅.*凯尔希/s);
  assert.match(compile[1].content[0].text, /amiya_identity/);
  assert.match(compile[1].content[0].text, /kaltsit_identity/);
  assert.doesNotMatch(compile[1].content[0].text, /default_clothes/);
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
  const messages = f.app.currentSession().messages;
  assert.deepEqual(messages.find(row => row.id === message.id).result.candidates.map(candidate => candidate.id), ['candidate-1']);
  assert.deepEqual(messages.at(-1).result.candidates.map(candidate => candidate.id), ['candidate-2']);
  assert.deepEqual(messages.at(-1).result.imageIds, [result.candidates.at(-1).imageId]);
});

test('confirming an ambiguous character returns its identity to the primary before first rendering', async t => {
  let jobId;
  const f = setup(t, ({ turn, messages }) => {
    if (turn === 1) return call('generation.execute', { requirements: 'draw Alice', positiveTags: ['1girl'], characterQueries: ['Alice'] });
    if (turn === 2) { assert.match(JSON.stringify(messages), /alice_b/); return call('generation.resume', { jobId, action: 'continue', positiveTags: ['1girl', 'alice_b'] }); }
    return { text: '按确认的角色生成。' };
  }, {}, { characters: { page: () => ({ items: [{ id: 'alice-a' }, { id: 'alice-b' }] }), get: id => ({ id, name: id, identityTags: [id === 'alice-b' ? 'alice_b' : 'alice_a'], generalTags: [], specificTags: [] }) } });
  await f.app.refreshCapabilities();
  const paused = await f.app.run('draw Alice');
  jobId = paused.jobId;
  assert.equal(paused.data.status, 'needs_input');
  assert.equal(f.renders.length, 0);
  const message = f.app.currentSession().messages.at(-1);
  const result = await f.app.selectGenerationCharacter(message.id, 'alice-b');
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(f.renders[0]?.prompt, '1girl, alice_b');
  assert.equal(f.children.length, 0);
  assert.equal(f.primary.length, 3);
});

test('primary publishes its task before rendering and saves candidate feedback for both the UI and following decisions', async t => {
  const publicEvents = [];
  let jobId;
  const review = { summary: '人物清楚，但姿势需要调整。', issues: [{ expected: '站立', observed: '坐姿', suggestedChange: '改为站立，保留背景' }], nextAction: 'revise', nextStep: '我会再画一张，修正人物姿势。' };
  const f = setup(t, ({ turn, result }) => {
    if (turn === 1) return { ...call('generation.execute', { requirements: '画一个花园中的角色', positiveTags: ['1girl', 'garden'] }), text: '我会画一个花园中的角色，先准备提示词并生成第一张图。', reasoning: 'PRIVATE_REASONING' };
    if (turn === 2) { jobId = result.jobId; return call('generation.comment', { jobId: 'job-typo-from-model', candidateId: 'candidate-1', ...review }); }
    if (turn === 3) {
      assert.equal(result.candidates[0].primaryReview.summary, review.summary);
      return call('generation.select', { jobId: 'job-typo-from-model', candidateId: 'candidate-1' });
    }
    return { text: '先交付这张图供你审阅。' };
  });
  await f.app.refreshCapabilities();
  const result = await f.app.run({ text: '画一个花园中的角色', onEvent: event => publicEvents.push(event) });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.candidates[0].primaryReview.nextStep, review.nextStep);
  const firstPublic = publicEvents.findIndex(e => e.type === 'assistant.message');
  assert(firstPublic >= 0);
  assert(firstPublic < publicEvents.findIndex(e => e.type === 'candidate.rendering'));
  assert.match(publicEvents[firstPublic].summary, /花园.*先准备/);
  assert.doesNotMatch(JSON.stringify(publicEvents.filter(e => e.type === 'assistant.message')), /PRIVATE_REASONING/);
  assert.equal(f.children.length, 0, 'a primary comment does not launch an auxiliary evaluator');
  const restored = createAssistant({ storage: f.storage, images: f.images });
  t.after(() => restored.destroy());
  assert.equal(restored.generation.get(jobId).candidates[0].primaryReview.summary, review.summary);
  assert.equal(restored.currentSession().messages.at(-1).result.candidates[0].primaryReview.issues[0].observed, '坐姿');
  const denied = await restored.primaryTools.call('generation.comment', { jobId, candidateId: 'candidate-1', ...review }, { sessionId: 'foreign-session' });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'SESSION_UNAVAILABLE');
});

test('English task announcements and exhausted-budget feedback follow the UI locale', async t => {
  let jobId;
  const f = setup(t, ({ turn, config, result, messages }) => {
    assert.match(messages[0].content, /English \(en-US\)/);
    if (turn === 1) return call('generation.execute', { requirements: 'Draw a portrait', positiveTags: ['portrait'] });
    if (turn === 2) { jobId = result.jobId; return call('generation.comment', { jobId, candidateId: 'candidate-1', summary: 'The pose still differs.', issues: [{ observed: 'Seated pose', suggestedChange: 'Use a standing pose' }], nextAction: 'revise', nextStep: 'I will render again now.' }); }
    return { text: 'Please review this candidate.' };
  }, { generation: { autoRun: true, maxAutoRounds: 1 } });
  f.storage.set('app.locale', 'en-US');
  await f.app.refreshCapabilities();
  const result = await f.app.run('Draw a portrait');
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.match(result.events.find(e => e.type === 'assistant.message').summary, /^I will/);
  const review = result.candidates[0].primaryReview;
  assert.equal(review.nextAction, 'limit');
  assert.match(review.nextStep, /image limit.*Refine this image/);
  assert.doesNotMatch(review.nextStep, /render again now/);
  assert.equal(f.renders.length, 1);
  const before = JSON.stringify(f.app.generation.get(jobId));
  const rejected = await f.app.primaryTools.call('generation.comment', { jobId, candidateId: 'missing', summary: 'wrong candidate', issues: [], nextAction: 'deliver', nextStep: 'done' }, { sessionId: f.app.currentSession().id });
  assert.equal(rejected.error.code, 'CANDIDATE_NOT_FOUND');
  assert.equal(JSON.stringify(f.app.generation.get(jobId)), before);
});

test('three images with a public review each finish within the default tool budget', async t => {
  let jobId;
  const f = setup(t, ({ turn, source, result }) => {
    if (turn === 1) return call('vision.processOne', { imageId: source.id, mode: 'local' });
    if (turn === 2) return call('generation.execute', { sourceImageId: source.id, positiveTags: result.tags });
    if (!jobId && result?.jobId) jobId = result.jobId;
    if ([3, 5, 7].includes(turn)) return call('generation.comment', { jobId, candidateId: `candidate-${(turn - 1) / 2}`, summary: '构图清楚，检查姿势差异。', issues: [], nextAction: turn === 7 ? 'deliver' : 'revise', nextStep: turn === 7 ? '这张图的构图已符合要求，先交付给你审阅。' : '我会调整姿势再绘制一张。' });
    if (turn === 4) return call('generation.resume', { jobId, action: 'continue', baseCandidateId: 'candidate-1', positiveTags: ['3girls', 'standing', 'garden'] });
    if (turn === 6) return call('generation.resume', { jobId, action: 'continue', baseCandidateId: 'candidate-2', positiveTags: ['4girls', 'standing', 'garden'] });
    if (turn === 8) return call('generation.select', { jobId, candidateId: 'candidate-3' });
    throw new Error('The saved delivery sentence is already sufficient; no extra model request is needed.');
  }, { limits: {}, generation: { autoRun: true, maxAutoRounds: 3 } });
  await f.app.refreshCapabilities();
  const result = await f.app.run({ text: '复刻这张图', imageIds: [f.source.id] });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.selectedCandidateId, 'candidate-3');
  assert.equal(result.usage.toolRounds, 8);
  assert.equal(f.renders.length, 3);
  assert.equal(f.primary.length, 8);
  assert.equal(result.candidates.filter(c => c.primaryReview).length, 3);
  assert.match(result.candidates.at(-1).primaryReview.nextStep, /交付给你审阅/);
});

test('the primary can save a public review after selecting in the same response', async t => {
  const f = setup(t, ({ turn, result }) => {
    if (turn === 1) return call('generation.execute', { positiveTags: ['portrait'] });
    if (turn === 2) return { toolCalls: [
      ...call('generation.select', { jobId: result.jobId, candidateId: 'candidate-1' }).toolCalls,
      ...call('generation.comment', { jobId: result.jobId, candidateId: 'candidate-1', summary: '主体已符合要求。', issues: [], nextAction: 'deliver', nextStep: '先交付这张图供你审阅。' }).toolCalls
    ] };
    return { text: '先交付这张图供你审阅。' };
  });
  await f.app.refreshCapabilities();
  const result = await f.app.run('画一个人像');
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.toolCalls.find(c => c.name === 'generation.comment').ok, true);
  assert.equal(result.candidates[0].primaryReview.summary, '主体已符合要求。');
  assert.equal(result.task.complete, true);
  assert.deepEqual(result.task.allowedTools, ['generation.comment']);
});

test('ten configured image rounds receive enough primary tool budget for review and resume calls', async t => {
  let jobId;
  const f = setup(t, ({ turn, result }) => {
    if (turn === 1) return call('generation.execute', { requirements: 'ten-round portrait', positiveTags: ['1girl'] });
    if (!jobId && result?.jobId) jobId = result.jobId;
    if (turn >= 2 && turn <= 19 && turn % 2 === 0) {
      const candidateNumber = turn / 2;
      return call('generation.comment', { jobId: 'model-typed-wrong-job', candidateId: `candidate-${candidateNumber}`, summary: `第 ${candidateNumber} 张需要继续检查。`, issues: [], nextAction: 'revise', nextStep: '继续调整后再画一张。' });
    }
    if (turn >= 3 && turn <= 19 && turn % 2 === 1) {
      const baseNumber = (turn - 1) / 2;
      return call('generation.resume', { jobId: 'model-typed-wrong-job', action: 'continue', baseCandidateId: `candidate-${baseNumber}`, positiveTags: [`round-${baseNumber + 1}`] });
    }
    if (turn === 20) return call('generation.select', { jobId: 'model-typed-wrong-job', candidateId: 'candidate-10' });
    return { text: '已完成十轮测试。' };
  }, { limits: { maxToolRounds: 8, maxToolCalls: 32, maxComfyCalls: 3 }, generation: { autoRun: true, maxAutoRounds: 10 } });
  await f.app.refreshCapabilities();
  const result = await f.app.run('画一个十轮测试肖像');
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(f.renders.length, 10);
  assert.equal(result.candidates.length, 10);
  assert.equal(result.usage.toolRounds, 20);
});
