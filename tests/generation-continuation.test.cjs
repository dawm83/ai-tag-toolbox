'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGenerationOrchestrator } = require('../src/modules/generation-orchestrator');
const { createStorage } = require('../src/modules/storage');

function fixture(outputType = 'images', patch = { add: ['standing'], remove: ['sitting'], preserve: [] }) {
  const storage = createStorage();
  const calls = [], renders = [];
  const options = {
    storage,
    getSettings: () => ({ generation: { autoRun: true, maxAutoRounds: 1, maxRenderAttempts: 1 } }),
    listConversationImages: () => ({ items: [{ imageId: 'original' }] }),
    runSubAgent: async (name, { input }) => {
      calls.push({ name, input: structuredClone(input) });
      if (name === 'vision') return { description: 'A character sitting in a garden', tags: ['sitting', 'garden'] };
      if (name === 'generateTags') return input.operation === 'revise' ? patch : { positiveTags: ['character_identity', 'long hair', 'blue dress', 'sitting', 'garden'] };
      return { operation: 'review', evaluations: [{ candidateId: input.candidateImageIds[0], status: 'reviewed', score: 95, verdict: 'accept', hardErrors: [], issues: [], summary: 'ok' }] };
    },
    renderCandidate: async input => { renders.push(structuredClone(input)); return { artifacts: [{ imageId: `image-${renders.length}` }] }; }
  };
  let generation = createGenerationOrchestrator(options);
  const context = { sessionId: 'session' };
  return {
    storage, calls, renders, context, get generation() { return generation; },
    restart() { generation = createGenerationOrchestrator(options); },
    start: () => generation.execute({ requirements: '复刻这张角色图片，保留服装和花园', mode: 'recreate', sourceImageId: 'original', outputType }, context)
  };
}

test('completed recreation continues the selected prompt after reload without inspecting or compiling again', async () => {
  const app = fixture();
  const first = await app.start();
  assert.equal(first.status, 'completed');
  app.restart();
  const next = await app.generation.resume({ jobId: first.jobId, action: 'continue', baseCandidateId: 'candidate-1', feedback: '你这个姿势不对呀，原来的角色是站着的' }, app.context);
  assert.equal(next.jobId, first.jobId);
  assert.equal(next.status, 'awaiting_feedback');
  assert.equal(next.sourceImageId, 'original');
  assert.equal(next.originalRequirements, first.originalRequirements);
  assert.equal(app.renders.length, 2);
  assert.deepEqual(app.renders[1].positiveTags, ['character_identity', 'long hair', 'blue dress', 'garden', 'standing']);
  assert.deepEqual(next.candidates[0], first.candidates[0]);
  assert.equal(app.calls.filter(c => c.name === 'vision').length, 1);
  assert.equal(app.calls.filter(c => c.input.operation === 'compile').length, 1);
  const review = app.calls.filter(c => c.name === 'evaluateImages').at(-1);
  assert.match(JSON.stringify(review.input.brief), /原来的角色是站着的/);
});

test('completed Tags can be revised repeatedly without a candidate or a render', async () => {
  const patch = { add: ['standing'], remove: ['sitting'], preserve: [] };
  const app = fixture('tags', patch);
  const first = await app.start();
  const next = await app.generation.resume({ jobId: first.jobId, action: 'continue', feedback: '改成站立' }, app.context);
  assert.equal(next.status, 'completed');
  assert(next.positiveTags.includes('standing'));
  app.restart();
  patch.add = ['arms up']; patch.remove = [];
  const last = await app.generation.resume({ jobId: first.jobId, action: 'continue', feedback: '再把手举起来' }, app.context);
  assert(last.positiveTags.includes('arms up'));
  assert(last.positiveTags.includes('standing'));
  assert.equal(app.renders.length, 0);
  assert.equal(app.calls.filter(c => c.name === 'vision').length, 1);
  assert.match(JSON.stringify(app.calls.at(-1).input), /改成站立/);
});

test('pose feedback cannot erase identity, appearance or scene even if the model requests it', async () => {
  const app = fixture('images', { add: ['standing'], remove: ['sitting', 'character_identity', 'blue dress', 'garden'], preserve: [] });
  const first = await app.start();
  const next = await app.generation.resume({ jobId: first.jobId, action: 'continue', baseCandidateId: 'candidate-1', feedback: '姿势不对，应该站着' }, app.context);
  assert.equal(next.stopReason, 'revision_failed');
  assert.equal(app.renders.length, 1);
  assert.deepEqual(next.positiveTags, first.positiveTags);
});

test('invalid continuation target cannot mutate or reopen the stored completed job', async () => {
  const app = fixture();
  const first = await app.start();
  await assert.rejects(app.generation.resume({ jobId: first.jobId, action: 'continue', baseCandidateId: 'missing', feedback: '站立' }, app.context), { code: 'CANDIDATE_NOT_FOUND' });
  assert.deepEqual(app.generation.get(first.jobId), first);
  assert.deepEqual(await app.generation.resume({ jobId: first.jobId }, app.context), first);
});
