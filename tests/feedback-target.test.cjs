'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAssistant } = require('../src/modules/assistant');
const { createStorage } = require('../src/modules/storage');
const { createImages } = require('../src/modules/images');

function setup(t, decide) {
  const storage = createStorage(), images = createImages({ storage }), requests = [], renders = [], tagRequests = [];
  const candidates = ['standing', 'sitting'].map((pose, index) => ({ id: `candidate-${index + 1}`, imageId: `image-${index + 1}`, positiveTags: ['identity', pose, 'garden'], prompt: `identity, ${pose}, garden`, iteration: index + 1, roundIndex: index + 1 }));
  candidates.forEach(c => images.add({ id: c.imageId, dataUrl: 'data:image/png;base64,AQID' }));
  storage.set('conversation_image_refs', candidates.map((c, index) => ({ refId: `ref-${index}`, imageId: c.imageId, sessionId: 's1', slotNo: 19 + index, source: 'comfy' })));
  const job = { jobId: 'job-one', sessionId: 's1', status: 'completed', mode: 'create', outputType: 'images', agentControlled: true, originalRequirements: 'Draw a person in a garden', candidates, positiveTags: candidates[1].positiveTags, selectedCandidateId: 'candidate-1', successfulRounds: 2, renderAttempts: 2, agentRoundLimit: 2, policy: { maxAutoRounds: 2 } };
  storage.set('generation_jobs', [job]);
  storage.set('sessions', { format: 'ai-tag-sessions', version: 1, currentId: 's1', sessions: [{ id: 's1', messages: [{ id: 'a1', role: 'assistant', status: 'done', result: job }] }] });
  const app = createAssistant({ storage, images, primaryApi: { model: 'fixture-vision' },
    settings: { comfy: { enabled: true }, generation: { maxAutoRounds: 2 }, limits: { maxToolRounds: 8 } },
    primaryGateway: { complete: async (messages, config) => { requests.push(structuredClone(messages)); return decide({ messages, config, turn: requests.length, call: (name, args) => ({ toolCalls: [{ id: `call-${requests.length}`, name: name.replace('.', '_'), arguments: args }] }) }); } },
    visionGateway: { complete: async messages => { tagRequests.push(structuredClone(messages)); return { text: '{"add":["waving"],"remove":[],"preserve":[]}' }; } },
    comfy: { status: async () => ({ connected: true, workflowReady: true, render: true }), render: async input => { renders.push(input.prompt); return { artifact: { id: 'image-new', dataUrl: 'data:image/png;base64,BAUG' } }; } }
  });
  t.after(() => app.destroy());
  return { app, storage, images, renders, requests, tagRequests };
}

test('ambiguous feedback lets the primary bind an existing candidate, revise its exact Tags and render once', async t => {
  const note = '继续优化坐着的那张，让角色挥手';
  const f = setup(t, ({ turn, call, messages, config }) => {
    if (turn === 1) {
      assert(config.tools.some(row => row.function.name === 'generation_resolveTarget'));
      assert(!config.tools.some(row => row.function.name === 'generation_resume'));
      return call('generation.resolveTarget', { action: 'select', imageId: 'image-2' });
    }
    const data = JSON.parse(messages.findLast(row => row.role === 'tool').content);
    if (turn === 2) {
      assert.equal(data.baseCandidateId, 'candidate-2');
      assert.equal(data.feedback, note);
      assert.deepEqual(data.positiveTags, ['identity', 'sitting', 'garden']);
      return call('agent.generateTags', { operation: 'revise', requirements: note, positiveTags: data.positiveTags, changes: ['waving'] });
    }
    if (turn === 3) return call('generation.resume', { jobId: 'typo', positiveTags: data.positiveTags });
    return call('generation.select', { jobId: 'typo', candidateId: 'candidate-3' });
  });
  await f.app.refreshCapabilities();
  const result = await f.app.run(note);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.deepEqual(f.renders, ['identity, sitting, garden, waving']);
  assert.equal(f.tagRequests.length, 1);
  assert.deepEqual(f.app.currentSession().messages.at(-1).result.candidates.map(c => c.id), ['candidate-3']);
  assert.equal(result.jobId, 'job-one');
});

test('primary question stops before generation and keeps the original feedback for a one-click answer', async t => {
  let stage = 'ask';
  const note = '进一步优化，让角色挥手';
  const f = setup(t, ({ call, messages }) => {
    if (stage === 'ask') return call('generation.resolveTarget', { action: 'ask', question: '要修改哪张图？' });
    if (stage === 'answer') {
      assert.match(JSON.stringify(messages), /进一步优化，让角色挥手/);
      const content = messages.findLast(row => row.role === 'user' && typeof row.content === 'string').content;
      const feedback = JSON.parse(content.split('当前修改任务（保留原目标与未提及内容）：')[1]);
      assert.equal(feedback.baseCandidateId, 'candidate-2');
      assert.deepEqual(feedback.positiveTags, ['identity', 'sitting', 'garden']);
      stage = 'deliver'; return call('generation.resume', { jobId: 'job-one', positiveTags: [...feedback.positiveTags, 'waving'] });
    }
    return call('generation.select', { jobId: 'job-one', candidateId: 'candidate-3' });
  });
  const before = f.storage.get('generation_jobs');
  const result = await f.app.run(note);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(f.requests.length, 1);
  assert.equal(f.renders.length, 0);
  assert.deepEqual(f.storage.get('generation_jobs'), before);
  assert.equal(result.data.needsInput.feedback, note);
  assert.deepEqual(result.data.needsInput.options.map(o => o.slotNo), [19, 20]);
  assert.equal(result.data.prompt, undefined);
  const questionId = f.app.currentSession().messages.at(-1).id;
  assert.equal((await f.app.selectFeedbackCandidate(questionId, 'foreign-image')).error.code, 'CANDIDATE_NOT_FOUND');
  stage = 'answer'; await f.app.refreshCapabilities();
  const answer = await f.app.selectFeedbackCandidate(questionId, 'image-2');
  assert.equal(answer.ok, true, JSON.stringify(answer.error));
  assert.deepEqual(f.renders, ['identity, sitting, garden, waving']);
  assert.equal(f.app.currentSession().messages.find(m => m.id === questionId).result.status, 'resolved');
  assert.equal((await f.app.selectFeedbackCandidate(questionId, 'image-2')).error.code, 'INPUT_EXPIRED');
});

for (const instruction of ['图20改成挥手', '把第20张改成挥手', 'candidate-2改成挥手', '上一张改成挥手', '最后一张改成挥手']) test(`explicit target proceeds directly: ${instruction}`, async t => {
  const f = setup(t, ({ turn, call, messages }) => {
    if (turn === 1) {
      const content = messages.findLast(row => row.role === 'user' && typeof row.content === 'string').content;
      const feedback = JSON.parse(content.split('当前修改任务（保留原目标与未提及内容）：')[1]);
      assert.equal(feedback.baseCandidateId, 'candidate-2');
      return call('generation.resume', { jobId: 'wrong', positiveTags: [...feedback.positiveTags, 'waving'] });
    }
    return call('generation.select', { jobId: 'wrong', candidateId: 'candidate-3' });
  });
  await f.app.refreshCapabilities();
  const result = await f.app.run(instruction);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.deepEqual(f.renders, ['identity, sitting, garden, waving']);
});

test('a made-up primary target becomes a choice without modifying the job', async t => {
  const f = setup(t, ({ call }) => call('generation.resolveTarget', { action: 'select', imageId: 'not-in-session' }));
  const before = f.storage.get('generation_jobs');
  const result = await f.app.run('继续优化');
  assert.equal(result.data.needsInput.kind, 'candidate');
  assert.equal(f.renders.length, 0);
  assert.deepEqual(f.storage.get('generation_jobs'), before);
});
