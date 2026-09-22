'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAssistant } = require('../src/modules/assistant');
const { createStorage } = require('../src/modules/storage');

function fixture(t, outputType = 'images', candidates = 1, selectedCandidateId = '') {
  const storage = createStorage(), revisions = [], requests = [];
  const rows = Array.from({ length: candidates }, (_, i) => ({ id: `candidate-${i + 1}`, imageId: `image-${i + 1}`, iteration: i + 1, roundIndex: 1, positiveTags: ['identity', 'sitting', 'garden'], negativeTags: [], prompt: 'identity, sitting, garden' }));
  const job = { jobId: 'original-job', sessionId: 's1', status: 'completed', outputType, mode: 'create', originalRequirements: '画角色在花园', positiveTags: ['identity', 'sitting', 'garden'], negativeTags: [], candidates: outputType === 'tags' ? [] : rows, selectedCandidateId };
  storage.set('generation_jobs', [job]);
  const app = createAssistant({
    storage,
    primaryGateway: { complete: async messages => { requests.push(structuredClone(messages)); return { text: '普通对话' }; } },
    visionGateway: { complete: async messages => { revisions.push(structuredClone(messages)); return { text: '{"add":["standing"],"remove":["sitting"],"preserve":[]}' }; } }
  });
  app.importSessions({ format: 'ai-tag-sessions', version: 1, currentId: 's1', sessions: [{ id: 's1', messages: [
    { id: 'u1', role: 'user', text: '画角色在花园', status: 'done' },
    { id: 'a1', role: 'assistant', text: '完成', status: 'done', result: job }
  ] }] }, true);
  t.after(() => app.destroy());
  return { app, revisions, requests, storage };
}

test('ordinary chat feedback resumes the original image job and updates history without a primary call', async t => {
  const f = fixture(t);
  const result = await f.app.run('你这个姿势不对呀，原来的角色是站着的');
  assert.equal(result.data.jobId, 'original-job');
  assert.equal(f.requests.length, 0);
  assert.equal(f.revisions.length, 1);
  assert.match(JSON.stringify(f.revisions[0]), /画角色在花园/);
  assert.deepEqual(result.data.positiveTags, ['identity', 'garden', 'standing']);
  const saved = f.app.currentSession().messages.at(-1);
  assert(saved.transcript.some(row => row.role === 'tool' && row.content.includes('standing')));
  await f.app.run('解释一下刚才的结果');
  assert(f.requests[0].some(row => row.role === 'tool' && row.content.includes('standing')));
});

test('Tags feedback remains Tags-only through the ordinary chat entry', async t => {
  const f = fixture(t, 'tags');
  const result = await f.app.run('把姿势改成站立，只要Tag');
  assert.equal(result.data.jobId, 'original-job');
  assert.equal(result.data.outputType, 'tags');
  assert.equal(result.data.status, 'completed');
  assert.equal(f.requests.length, 0);
  assert.deepEqual(result.data.positiveTags, ['identity', 'garden', 'standing']);
});

test('several unselected candidates require a choice and leave the job untouched', async t => {
  const f = fixture(t, 'images', 2);
  const before = f.storage.get('generation_jobs');
  const result = await f.app.run('姿势不对，改成站立');
  assert.equal(result.data.status, 'needs_input');
  assert.match(result.text, /候选/);
  assert.equal(f.requests.length, 0);
  assert.equal(f.revisions.length, 0);
  assert.deepEqual(f.storage.get('generation_jobs'), before);
});

test('several candidates still require an explicit choice even when one is preselected', async t => {
  const f = fixture(t, 'images', 2, 'candidate-1');
  const before = f.storage.get('generation_jobs');
  const result = await f.app.run('姿势不对，改成站立');
  assert.equal(result.data.status, 'needs_input');
  assert.match(result.text, /候选/);
  assert.equal(f.requests.length, 0);
  assert.equal(f.revisions.length, 0);
  assert.deepEqual(f.storage.get('generation_jobs'), before);
});

test('an explicit candidate image reference resolves the continuation without guessing', async t => {
  const f = fixture(t, 'images', 2);
  const result = await f.app.run('基于 image-2 继续优化，改成站立');
  assert.equal(result.data.jobId, 'original-job');
  assert.equal(f.requests.length, 0);
  assert.equal(f.storage.get('generation_jobs')[0].feedbackHistory[0].baseCandidateId, 'candidate-2');
});

test('new tasks, questions, quoted corrections and explicit inspection stay on the ordinary path', async t => {
  const f = fixture(t);
  for (const text of ['帮我画一个新的角色', '搜索 standing 的Tag', '如何把姿势改成站立？', '解释“姿势不对，改成站立”的意思', '重新识图，检查姿势', '从头重新生成这张图片']) {
    const result = await f.app.run(text);
    assert.equal(result.text, '普通对话', text);
  }
  assert.equal(f.requests.length, 6);
  assert.equal(f.revisions.length, 0);
});

test('an image correction explicitly requesting Tags never checks or renders through ComfyUI', async t => {
  const f = fixture(t);
  const result = await f.app.run('把姿势改成站立，不要出图，只要Tag');
  assert.equal(result.data.status, 'completed');
  assert.equal(result.data.outputType, 'tags');
  assert.equal(f.app.listCallRecords().some(row => row.kind === 'tool:comfy.status'), false);
  assert.equal(f.app.listCallRecords().some(row => row.kind === 'tool:comfy.render'), false);
});
