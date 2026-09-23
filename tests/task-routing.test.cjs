'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAssistant } = require('../src/modules/assistant');
const { createAgentRuntime } = require('../src/modules/agent-runtime');
const { createStorage } = require('../src/modules/storage');
const { createImages } = require('../src/modules/images');

function assistantFixture(t, replies, options = {}) {
  const requests = [];
  const app = createAssistant({
    storage: createStorage(), primaryApi: { model: 'fixture' }, ...options,
    primaryGateway: { complete: async (messages, config) => {
      requests.push({ messages: structuredClone(messages), tools: structuredClone(config.tools), choice: config.tool_choice });
      return replies.shift() || { text: 'done' };
    } }
  });
  t.after(() => app.destroy());
  return { app, requests };
}
const call = (name, args, id = name) => ({ id, name, arguments: args });
const toolNames = request => (request.tools || []).map(row => row.function.name);

test('routes clear requests while keeping quoted, negative and mixed requests out of accidental drawing', () => {
  const { routeTask } = require('../src/modules/task-router');
  for (const [text, intent] of [
    ['帮我找找与蓝发有关的tag。', 'search_tags'],
    ['查一下绘画相关的标签', 'search_tags'],
    ['Find tags about blue hair', 'search_tags'],
    ['帮我分析一下这张图片', 'analyze_image'],
    ['Analyze this image', 'analyze_image'],
    ['帮我生成蓝发女孩的tag', 'compile_tags'],
    ['帮我生成一套绘画提示词', 'compile_tags'],
    ['帮我生成一张图的提示词', 'compile_tags'],
    ['帮我写一组蓝发女孩的Tag', 'compile_tags'],
    ['我只需要蓝发女孩的Tag', 'compile_tags'],
    ['帮我生成蓝发女孩的Tag，不要画图', 'compile_tags'],
    ['不要画图但帮我生成蓝发女孩的tag', 'compile_tags'],
    ['Generate tags for a blue-haired girl', 'compile_tags'],
    ['帮我复刻这张图片', 'recreate_image'],
    ['Recreate this image', 'recreate_image'],
    ['用ComfyUI帮我生成一张图片', 'create_image'],
    ['画蓝发人物', 'create_image'],
    ['帮我生成一张图，用这些tag', 'create_image'],
    ['帮我用这些tag画一个蓝发女孩', 'create_image'],
    ['Draw a blue-haired girl', 'create_image'],
    ['你好', 'answer'],
    ['如何使用ComfyUI生成图片？', 'answer'],
    ['“帮我复刻这张图片”是什么意思？', 'answer'],
    ['不要生成图片，解释一下步骤', 'answer'],
    ['使用ComfyUI有什么要求？', 'answer'],
    ['请解释Tag是什么', 'answer'],
    ['What is in this image?', 'analyze_image'],
    ['帮我把这张图改成蓝发', 'recreate_image'],
    ['帮我分析图片并生成tag', 'auto'],
    ['帮我画一个女孩，顺便解释一下画风', 'create_image'],
    ['请帮我介绍一下ComfyUI的使用步骤', 'answer'],
    ['标签有哪些分类？', 'answer'],
    ['这张图是什么风格？', 'analyze_image'],
    ['用本地词库翻译蓝发', 'translate'],
    ['Translate blue hair into Chinese', 'translate'],
    ['先搜索蓝发的Tag，再帮我生成一张图', 'auto'],
    ['继续', 'auto'],
    ['帮我做一个角色设定', 'auto']
  ]) {
    const result = routeTask({ text, imageIds: [] });
    assert.equal(result.intent, intent, text);
    assert.equal(result.originalRequest, text);
  }
  assert.equal(routeTask({ text: '', imageIds: ['image-1'] }).intent, 'analyze_image');
});

test('a mixed analysis and Tags request still forbids rendering when the user explicitly excludes images', async t => {
  let seen;
  const { app, requests } = assistantFixture(t, [
    { toolCalls: [call('generation_execute', { requirements: 'wrong', outputType: 'images' })] },
    { text: 'Tag 已生成' }
  ], { generation: { execute: async input => { seen = input; return { outputType: input.outputType, status: 'completed' }; } } });
  const result = await app.run('先分析图片再生成Tag，不要生图');
  assert.equal(result.ok, true);
  assert.equal(seen.outputType, 'tags');
  assert.equal(toolNames(requests[0]).includes('generation_resume'), true);
});

test('search exposes only search, blocks drawing in the same response, then answers with no tools', async t => {
  let searches = 0, renders = 0;
  const { app, requests } = assistantFixture(t, [
    { toolCalls: [call('tags_search', { query: 'blue hair' }), call('generation_execute', { requirements: 'draw', outputType: 'images' })] },
    { text: 'blue hair' }
  ], {
    tags: { search: () => { searches++; return [{ id: 'blue', en: 'blue hair' }]; } },
    generation: { execute: async () => { renders++; return {}; } }
  });
  const result = await app.run('帮我找找与蓝发有关的tag');
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.deepEqual(toolNames(requests[0]), ['tags_search']);
  assert.equal(searches, 1);
  assert.equal(renders, 0);
  assert.deepEqual(toolNames(requests[1]), []);
  assert.equal(requests[1].choice, 'none');
  const tools = requests[1].messages.filter(row => row.role === 'tool');
  assert.equal(tools.length, 2);
  assert.equal(JSON.parse(tools[1].content).error.code, 'TOOL_NOT_ALLOWED_FOR_INTENT');
  assert.equal(result.task.intent, 'search_tags');
  assert(result.events.some(row => row.type === 'task.routed' && row.intent === 'search_tags'));
  assert(result.events.some(row => row.type === 'task.answering'));
});

test('a mistaken first tool is returned as an error and the model can still perform the right search', async t => {
  let executed = 0;
  const { app, requests } = assistantFixture(t, [
    { toolCalls: [call('generation_execute', { requirements: 'wrong' })] },
    { toolCalls: [call('tags_search', { query: 'blue hair' })] },
    { text: 'blue hair' }
  ], { tags: { search: () => [{ id: 'blue', en: 'blue hair' }] }, generation: { execute: async () => { executed++; return {}; } } });
  const result = await app.run('搜索蓝发Tag');
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(executed, 0);
  assert.deepEqual(toolNames(requests[1]), ['tags_search']);
  assert.equal(result.toolCalls[0].ok, false);
  assert.equal(result.toolCalls[1].ok, true);
});

test('completed short tasks block another valid tool call even when a provider ignores tool_choice', async t => {
  let searches = 0;
  const { app, requests } = assistantFixture(t, [
    { toolCalls: [call('tags_search', { query: 'blue hair' }, 'first')] },
    { toolCalls: [call('tags_search', { query: 'red eyes' }, 'extra')] },
    { text: 'blue hair' }
  ], { tags: { search: () => { searches++; return [{ id: 'blue', en: 'blue hair' }]; } } });
  assert.equal((await app.run('找找蓝发相关Tag')).ok, true);
  assert.equal(searches, 1);
  assert.equal(JSON.parse(requests[2].messages.at(-1).content).error.code, 'TASK_ALREADY_SATISFIED');
});

test('ordinary answers expose no tools and a stale generation request cannot execute', async t => {
  let generated = 0;
  const { app, requests } = assistantFixture(t, [
    { toolCalls: [call('generation_execute', { requirements: 'stale task' })] },
    { text: '这是使用说明。' }
  ], { generation: { execute: async () => { generated++; return {}; } } });
  const result = await app.run('如何用ComfyUI生成图片？');
  assert.equal(result.ok, true);
  assert.equal(generated, 0);
  assert.deepEqual(toolNames(requests[0]), []);
  assert.equal(requests[0].choice, 'none');
});

test('image analysis forwards the original question, reads the selected image, and cannot generate', async t => {
  const images = createImages();
  const image = images.add({ dataUrl: 'data:image/png;base64,AA==', filename: 'fixture.png' });
  const inspected = [];
  let generated = 0;
  const { app, requests } = assistantFixture(t, [
    { toolCalls: [call('vision_processOne', { imageId: image.id, mode: 'ai', instruction: '请核对人物相对位置' })] },
    { toolCalls: [call('generation_execute', { requirements: 'draw another' })] },
    { text: '人物处于画面中央。' }
  ], {
    images,
    visionService: { available: () => ({ ai: true }), processOne: async input => { inspected.push(input); return { ok: true, data: { text: 'central subject', tags: ['solo'] } }; } },
    generation: { execute: async () => { generated++; return {}; } }
  });
  const question = '帮我分析这张图片，重点看构图，不要生图';
  const result = await app.run({ text: question, imageIds: [image.id] });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.deepEqual(toolNames(requests[0]), ['conversation_listImages', 'conversation_viewImages', 'vision_processOne']);
  assert.equal(inspected.length, 1);
  assert.equal(inspected[0].imageId, image.id);
  assert.equal(inspected[0].instruction, '请核对人物相对位置');
  assert.equal(generated, 0);
  assert(toolNames(requests[1]).includes('vision_processOne'));
});

test('recreate policy chooses local Tags by image role instead of forcing every image through reference flow', () => {
  const { createTaskPolicy } = require('../src/modules/task-policy');
  const policy = createTaskPolicy({ intent: 'recreate_image', originalRequest: '复刻这张图', imageIds: ['source-1'] });
  const text = policy.prompt();
  assert.match(text, /确定唯一目标图/);
  assert.match(text, /属性图/);
  assert.match(text, /local/);
  assert.match(text, /sourceImageId/);
});

test('plain text generation removes an accidental source image and never requires image recognition', () => {
  const { createTaskPolicy } = require('../src/modules/task-policy');
  const policy = createTaskPolicy({ intent: 'create_image', originalRequest: '画一个蓝发女孩', imageIds: [] });
  const prepared = policy.prepareCall('generation.execute', { sourceImageId: 'stale-image', sourceSlot: 2, mode: 'recreate', positiveTags: ['1girl'] });
  assert.equal(prepared.mode, 'create');
  assert.equal(prepared.sourceImageId, undefined);
  assert.equal(prepared.sourceSlot, undefined);
  assert.match(policy.prompt(), /没有参考图时直接按用户要求/);
  assert.equal(policy.allowedNames().includes('vision.processOne'), false);
});

test('generation follow-up tools use the job returned by execute even when the model mistypes it', () => {
  const { createTaskPolicy } = require('../src/modules/task-policy');
  const policy = createTaskPolicy({ intent: 'create_image', originalRequest: '画一个女孩' });
  assert.equal(policy.completionFor('generation.execute', { jobId: 'job-correct-123', status: 'awaiting_feedback', decisionRequired: true }), false);
  assert.equal(policy.prepareCall('generation.comment', { jobId: 'job-wrong-123', candidateId: 'candidate-1' }).jobId, 'job-correct-123');
  assert.equal(policy.prepareCall('generation.review', { jobId: 'job-wrong-123', candidateId: 'candidate-1' }).jobId, 'job-correct-123');
  assert.equal(policy.prepareCall('generation.resume', { jobId: 'job-wrong-123', action: 'continue' }).jobId, 'job-correct-123');
  assert.equal(policy.prepareCall('generation.select', { jobId: 'job-wrong-123', candidateId: 'candidate-1' }).jobId, 'job-correct-123');
});

test('recreate policy keeps Tag compilation and review closed until the baseline job exists', () => {
  const { createTaskPolicy } = require('../src/modules/task-policy');
  const policy = createTaskPolicy({ intent: 'recreate_image', originalRequest: '复刻这张图', imageIds: ['source-1'] });
  assert.equal(policy.allowedNames().includes('agent.generateTags'), false);
  assert.equal(policy.allowedNames().includes('generation.review'), false);
  assert.equal(policy.completionFor('generation.execute', { jobId: 'job-1', status: 'awaiting_feedback', decisionRequired: true }), false);
  assert.equal(policy.allowedNames().includes('agent.generateTags'), true);
  assert.equal(policy.allowedNames().includes('generation.review'), true);
});

test('explicit Tags output stays Tags-only with ComfyUI connected and passes the unmodified request to the Tag agent', async t => {
  const visionRequests = [];
  let renders = 0;
  const { app, requests } = assistantFixture(t, [
    { toolCalls: [call('agent_generateTags', { operation: 'compile', requirements: '帮我生成蓝发女孩的绘画Tag，穿白裙，不要出图' })] },
    { toolCalls: [call('generation_execute', { requirements: 'wrong hair and outfit', originalRequirements: 'rewritten', outputType: 'images', positiveTags: ['1girl', 'blue hair', 'white dress'] })] },
    { text: '```text\n1girl, blue hair, white dress\n```' }
  ], {
    settings: { comfy: { enabled: true } },
    comfy: { render: async () => { renders++; throw new Error('Unexpected render'); }, status: async () => ({ connected: true, workflowReady: true, render: true }) },
    visionGateway: { complete: async messages => { visionRequests.push(messages); return { text: '{"positiveTags":["1girl","blue hair","white dress"]}' }; } }
  });
  await app.refreshCapabilities();
  const original = '帮我生成蓝发女孩的绘画Tag，穿白裙，不要出图';
  const result = await app.run(original);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.outputType, 'tags');
  assert.equal(renders, 0);
  assert.deepEqual(result.positiveTags, ['1girl', 'blue hair', 'white dress']);
  assert(visionRequests[0][1].content[0].text.includes(original));
  assert(!visionRequests[0][1].content[0].text.includes('wrong hair'));
  assert(toolNames(requests[0]).includes('agent_generateTags'));
  assert.deepEqual(toolNames(requests[2]), []);
});

test('failed search keeps the allowed tool available for a corrected query', async t => {
  let attempts = 0;
  const { app, requests } = assistantFixture(t, [
    { toolCalls: [call('tags_search', { query: 'bad' }, 'bad')] },
    { toolCalls: [call('tags_search', { query: 'blue hair' }, 'good')] },
    { text: 'blue hair' }
  ], { tags: { search: query => { attempts++; if (query === 'bad') throw new Error('unavailable'); return [{ id: 'blue', en: query }]; } } });
  assert.equal((await app.run('找找蓝发Tag')).ok, true);
  assert.equal(attempts, 2);
  assert.deepEqual(toolNames(requests[1]), ['tags_search']);
  assert.deepEqual(toolNames(requests[2]), []);
});

test('paused generation closes every tool call in the batch without executing subsequent side effects', async () => {
  let generations = 0;
  const runtime = createAgentRuntime({
    primaryClient: { complete: async () => ({ toolCalls: [call('generation_execute', {}, 'one'), call('generation_execute', {}, 'two')] }) },
    tools: { 'generation.execute': { parameters: { type: 'object' }, handler: async () => { generations++; return { jobId: 'job-1', status: 'needs_input', needsInput: { kind: 'character' } }; } } }
  });
  const result = await runtime.runPrimary({ input: { text: 'draw' } });
  assert.equal(result.ok, true);
  assert.equal(generations, 1);
  const replies = result.data.transcript.filter(row => row.role === 'tool');
  assert.deepEqual(replies.map(row => row.tool_call_id), ['one', 'two']);
  assert.equal(JSON.parse(replies[1].content).error.code, 'TASK_WAITING_FOR_INPUT');
});

test('a tool budget failure stops the batch and preserves the original error with all call receipts', async () => {
  let searches = 0;
  const runtime = createAgentRuntime({
    getSettings: () => ({ limits: { maxToolCalls: 1 } }),
    primaryClient: { complete: async () => ({ toolCalls: [call('tags_search', {}, 'one'), call('tags_search', {}, 'two'), call('tags_search', {}, 'three')] }) },
    tools: { 'tags.search': { parameters: { type: 'object' }, handler: async () => { searches++; return { items: [] }; } } }
  });
  const result = await runtime.runPrimary({ input: { text: 'search' } });
  assert.equal(result.error.code, 'TOOL_CALL_LIMIT');
  assert.equal(searches, 1);
  assert.deepEqual(result.data.transcript.filter(row => row.role === 'tool').map(row => row.tool_call_id), ['one', 'two', 'three']);
});

test('a fresh search request does not inherit the preceding drawing task or its completion lock', async t => {
  let generations = 0;
  const { app, requests } = assistantFixture(t, [
    { toolCalls: [call('generation_execute', { requirements: 'portrait', outputType: 'images' })] },
    { text: '生成结束' },
    { toolCalls: [call('tags_search', { query: 'blue hair' })] },
    { text: 'blue hair' }
  ], {
    generation: { execute: async () => { generations++; return { status: 'completed', outputType: 'images' }; } },
    tags: { search: () => [{ id: 'blue', en: 'blue hair' }] }
  });
  assert.equal((await app.run('画一个女孩')).task.intent, 'create_image');
  assert.equal((await app.run('搜索蓝发Tag')).task.intent, 'search_tags');
  assert.equal(generations, 1);
  assert.deepEqual(toolNames(requests[2]), ['tags_search']);
});

test('a completed generation failure is explained without silently starting the entire job again', async t => {
  let generated = 0;
  const { app, requests } = assistantFixture(t, [
    { toolCalls: [call('generation_execute', { requirements: 'portrait' }, 'first')] },
    { toolCalls: [call('generation_execute', { requirements: 'portrait' }, 'again')] },
    { text: '图片生成失败，已有Tag仍可使用。' }
  ], { generation: { execute: async () => { generated++; return { status: 'failed', error: { code: 'NO_CANDIDATE', message: 'no image' } }; } } });
  const result = await app.run('画一个蓝发女孩');
  assert.equal(result.ok, true);
  assert.equal(result.data.status, 'failed');
  assert.equal(generated, 1);
  assert.deepEqual(toolNames(requests[1]), []);
});

test('using an existing Tags image reference retains inspection mode and never invents a source from several attachments', () => {
  const { createTaskPolicy } = require('../src/modules/task-policy');
  const policy = createTaskPolicy({ intent: 'compile_tags', originalRequest: '参考图片生成Tag', imageIds: ['one', 'two'] });
  const selected = policy.prepareCall('generation.execute', { sourceImageId: 'two', mode: 'create' });
  assert.equal(selected.mode, 'recreate');
  assert.equal(selected.sourceImageId, 'two');
  assert.equal(selected.outputType, 'tags');
  const unselected = policy.prepareCall('generation.execute', {});
  assert.equal(unselected.sourceImageId, undefined);
});

test('only an explicit reference-tag section becomes referenceTags; ordinary image requests keep it empty', () => {
  const { routeTask } = require('../src/modules/task-router');
  assert.equal(routeTask({ text: '参考tag：alice_(series), blue hair' }).referenceTags, 'alice_(series), blue hair');
  assert.equal(routeTask({ text: '帮我画一个蓝发女孩' }).referenceTags, '');
});
