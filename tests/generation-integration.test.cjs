'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const modules = require('../src/modules');

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

test('assistant create/recreate workflows iterate, compare, upload source and preserve exact prompts', async () => {
  const storage = modules.createStorage({ prefix: `generation-integration-${Date.now()}` });
  const images = modules.createImages({ storage });
  const workflow = {
    '3': { class_type: 'KSampler', inputs: { positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0], denoise: 0.7 } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: 768, height: 1024, batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: '' } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: '' } },
    '10': { class_type: 'LoadImage', inputs: { image: 'old.png', upload: 'image' } },
    '11': { class_type: 'SaveImage', inputs: { images: ['3', 0] } }
  };
  storage.set('comfy_profiles', { version: 2, activeProfileId: 'reference', items: [{
    id: 'reference', name: '参考图工作流', base: 'http://fixture.test:8188', workflow,
    capabilities: { txt2img: true, img2img: true, controlImage: false, mask: false },
    bindings: { positive: [{ nodeId: '6', input: 'text' }], negative: [{ nodeId: '7', input: 'text' }], sourceImage: { nodeId: '10', input: 'image' }, denoise: { nodeId: '3', input: 'denoise' }, controlStrength: null, outputs: ['11'] },
    overrides: { positive: true, negative: true }, updatedAt: 10
  }] });

  const submitted = [];
  const uploads = [];
  let renderSequence = 0;
  let failNextRenders = 0;
  let hangMode = '';
  let hangAfterSubmissions = 0;
  let renderStarted;
  let resolveLateRender;
  let interrupts = 0;
  const primaryRequests = [];
  const visionRequests = [];
  const comfy = {
    setBase: () => {},
    status: async () => ({ connected: true, workflowReady: true, render: true, error: '' }),
    cancel: async () => { interrupts += 1; return { interrupted: true }; },
    uploadImage: async input => { uploads.push({ size: input.bytes.length, filename: input.filename }); return { name: 'source.png', subfolder: 'aitag', type: 'input' }; },
    render: async input => {
      if (failNextRenders > 0) {
        failNextRenders -= 1;
        throw Object.assign(new Error('fixture queue failure'), { code: 'COMFY_FAILED' });
      }
      if (hangMode && submitted.length >= hangAfterSubmissions) {
        renderStarted?.();
        if (hangMode === 'late') return new Promise(resolve => { resolveLateRender = () => resolve({ artifact: { id: 'late-final', filename: 'late-final.png', mime: 'image/png', dataUrl: 'data:image/png;base64,AA==' } }); });
        return new Promise((_resolve, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }));
      }
      const artifacts = [];
      for (let index = 0; index < Number(input.batchCount || 1); index += 1) {
        renderSequence += 1;
        artifacts.push({ id: `generated-${renderSequence}`, filename: `generated-${renderSequence}.png`, mime: 'image/png', dataUrl: `data:image/png;base64,${Buffer.from([renderSequence]).toString('base64')}` });
      }
      submitted.push({ prompt: input.prompt, negative: input.negative, sourceImage: input.sourceImage || null, imageIds: artifacts.map(item => item.id) });
      input.onSubmitted?.({ workflowHash: `hash-${submitted.length}`, changedBindings: input.sourceImage ? ['positive', 'sourceImage'] : ['positive'], parameters: { seed: renderSequence } });
      return { artifacts };
    }
  };

  let currentIntent = 'create';
  const reviewCounts = { create: 0, recreate: 0, cancel: 0 };
  let currentJob;
  let toolSequence = 0;
  const tool = (name, args) => ({ toolCalls: [{ id: 'fixture-' + (++toolSequence), name, arguments: args }], usage: { total_tokens: 10 } });
  const primaryGateway = { complete: async messages => {
    primaryRequests.push(structuredClone(messages));
    const conversation = messages.filter(message => typeof message.content === 'string');
    const last = conversation.at(-1);
    if (last?.role !== 'tool') {
      const request = conversation.findLast(row => row.role === 'user')?.content || '';
      currentIntent = /复刻/.test(request) ? 'recreate' : /取消/.test(request) ? 'cancel' : 'create';
      if (request.includes('当前修改任务（保留原目标与未提及内容）：')) {
        const feedback = JSON.parse(request.split('当前修改任务（保留原目标与未提及内容）：')[1]);
        currentJob = feedback;
        return tool('agent_generateTags', { operation: 'revise', requirements: feedback.originalRequirements, positiveTags: feedback.positiveTags, negativeTags: feedback.negativeTags, changes: [feedback.feedback] });
      }
      currentJob = null;
      return tool('generation_execute', { requirements: request, positiveTags: ['1girl', 'blue hair'], negativeTags: ['lowres'], mode: currentIntent === 'recreate' ? 'recreate' : 'create', ...(currentIntent === 'recreate' ? { sourceImageId: sourceImage.id } : {}) });
    }
    const data = JSON.parse(last.content);
    if (data.ok === false || ['failed', 'needs_input', 'cancelled', 'completed'].includes(data.status)) return { text: '按实际任务状态交付。', usage: { total_tokens: 11 } };
    const lastCall = conversation.findLast(row => row.role === 'assistant' && row.tool_calls)?.tool_calls.at(-1)?.function.name;
    if (lastCall === 'agent_generateTags') return tool('generation_resume', { jobId: currentJob.jobId, action: 'continue', baseCandidateId: currentJob.baseCandidateId || currentJob.candidates.at(-1).candidateId, positiveTags: data.positiveTags, negativeTags: data.negativeTags });
    currentJob = data;
    const unreviewed = data.candidates.find(row => row.score === null);
    if (unreviewed) return tool('generation_review', { jobId: data.jobId, candidateId: unreviewed.candidateId });
    if (!data.autoRun) return { text: '请点评本轮候选。', usage: { total_tokens: 11 } };
    if (data.remainingRounds > 0) return tool('agent_generateTags', { operation: 'revise', requirements: data.originalRequirements, positiveTags: data.positiveTags, negativeTags: data.negativeTags, changes: ['加强侧身视角'] });
    return tool('generation_select', { jobId: data.jobId, candidateId: data.candidates.at(-1).candidateId });
  } };
  const visionGateway = { complete: async messages => {
    visionRequests.push(structuredClone(messages));
    const system = messages[0]?.content || '';
    const content = Array.isArray(messages[1]?.content) ? messages[1].content[0]?.text || '' : '';
    if (/operation="review"/.test(system)) {
      reviewCounts[currentIntent] += 1;
      const candidateId = content.match(/generated-\d+/)?.[0];
      const score = [72, 78, 82, 94][(reviewCounts[currentIntent] - 1) % 4];
      return { text: JSON.stringify({ operation: 'review', evaluations: [{ candidateId, score, verdict: score >= 90 ? 'accept' : 'revise', confidence: 0.92, dimensions: { requirementMatch: score }, hardErrors: [], issues: score >= 90 ? [] : [{ expected: '侧身构图', observed: '视角偏正面', severity: 'major', suggestedChange: '增加 from side' }], strengths: ['主体清晰'], suggestedChanges: score >= 90 ? [] : ['增加 from side'], summary: score >= 90 ? '符合要求' : '需要调整视角' }] }), usage: { total_tokens: 30 } };
    }
    if (/operation="compare"/.test(system)) {
      const ids = [...new Set([...content.matchAll(/generated-\d+/g)].map(match => match[0]))];
      const recommendedCandidateId = ids.slice().sort((a, b) => Number(b.split('-').at(-1)) - Number(a.split('-').at(-1)))[0];
      return { text: JSON.stringify({ operation: 'compare', recommendedCandidateId, ranking: ids.map((candidateId, index) => ({ candidateId, score: 95 - index, reason: 'fixture ranking' })), reason: '高分候选更符合要求', confidence: 0.9 }), usage: { total_tokens: 30 } };
    }
    if (/系统修订协议/.test(system)) return { text: '{"add":["from side"],"remove":[],"preserve":["blue hair"]}', usage: { total_tokens: 20 } };
    if (/系统输出协议/.test(system)) return { text: '{"positiveTags":["1girl","blue hair"],"negativeTags":["lowres"]}', usage: { total_tokens: 20 } };
    return { text: '侧身蓝发女孩，半身构图，冷色光照', usage: { total_tokens: 15 } };
  } };

  const sourceImage = images.add({ id: 'source-image', filename: 'source.png', mime: 'image/png', dataUrl: 'data:image/png;base64,AQID' });
  const assistant = modules.createAssistant({
    storage, images, comfy, primaryGateway, visionGateway,
    primaryApi: { base: 'http://fixture.test/v1', model: 'fixture-vision' },
    settings: {
      comfy: { enabled: true, base: 'http://fixture.test:8188', workflow, width: 768, height: 1024, steps: 20, cfg: 7, batchCount: 2 },
      limits: { maxComfyCalls: 3, maxToolRounds: 24, maxToolCalls: 24, primaryTimeoutMs: 2000 },
      generation: { strategy: 'auto', autoSelect: true, autoRun: true, imagesPerRound: 2, maxAutoRounds: 2, maxRenderAttempts: 5, acceptScore: 90, minImprovement: 3, jobTimeoutMs: 10000 },
      generateNegativeTags: true
    }
  });

  await assistant.refreshCapabilities();
  const created = await assistant.run({ text: '创建蓝发女孩', requestId: 'integration-create' });
  assert.equal(created.ok, true, JSON.stringify(created.error));
  assert.equal(created.candidates.length, 4);
  assert.deepEqual(created.rounds.map(round => round.candidateIds.length), [2, 2]);
  assert.equal(created.selectedImageId, 'generated-4');
  assert.equal(created.candidates[3].prompt, submitted[1].prompt);
  assert.match(created.candidates[3].prompt, /from side/);
  assert.equal(created.usage.comfyCalls, 2);
  const createToolPayload = JSON.parse(primaryRequests[1].find(message => message.role === 'tool').content);
  assert(Buffer.byteLength(JSON.stringify(createToolPayload)) < 5000);
  assert.equal(createToolPayload.artifacts, undefined);
  assert.equal(createToolPayload.candidates[0].evaluation, undefined);
  assert.equal(created.candidates[0].evaluation.status, 'reviewed', 'Assistant UI result keeps the local snapshot');
  assert.equal(created.usage.byKind.generateTags, 20);
  assert.equal(created.usage.byKind.evaluateImages, 120);
  const createSummary = assistant.listCallRecords().find(row => row.rootRequestId === 'integration-create' && row.kind === 'primary');
  assert.equal(createSummary.usage.total_tokens, created.usage.total_tokens);
  assert(created.usage.total_tokens > 140);

  const recreated = await assistant.run({ text: '复刻这张图片', imageIds: [sourceImage.id], requestId: 'integration-recreate' });
  assert.equal(recreated.ok, true, JSON.stringify(recreated.error));
  assert.equal(recreated.mode, 'recreate');
  assert.equal(recreated.recreationMode, 'reference_image');
  assert.equal(recreated.candidates.length, 4);
  assert.equal(uploads.length, 2, 'each successful recreation render uploads the authorized source');
  assert(submitted.slice(2).every(call => call.sourceImage?.name === 'source.png'));
  assert.equal(recreated.candidates[3].prompt, submitted.at(-1).prompt);
  assert.equal(recreated.usage.byKind.vision, undefined);
  assert.equal(recreated.usage.byKind.generateTags, 20);
  assert.equal(recreated.usage.byKind.evaluateImages, 120);
  const recreateSummary = assistant.listCallRecords().find(row => row.rootRequestId === 'integration-recreate' && row.kind === 'primary');
  assert.equal(recreateSummary.usage.total_tokens, recreated.usage.total_tokens);
  assert(recreated.usage.total_tokens > 140);

  const records = assistant.listCallRecords();
  assert(records.some(row => row.kind === 'tool:generation.execute'));
  assert(records.some(row => row.kind === 'subagent:evaluateImages'));
  assert(records.some(row => row.kind === 'tool:comfy.render' && row.tool === 'comfy.render' && row.status === 'completed'));
  assert.doesNotMatch(JSON.stringify(records), /data:image|base64|AQID/);

  assistant.setSettings({ generationAutoRun: false, imagesPerRound: 2, maxAutoRounds: 2 });
  reviewCounts.create = 0;
  const manualPrimaryBefore = primaryRequests.length;
  const manual = await assistant.run({ text: '手动点评测试绘图', requestId: 'integration-manual' });
  assert.equal(manual.ok, true, JSON.stringify(manual.error));
  assert.equal(manual.data.status, 'awaiting_feedback');
  assert.equal(manual.candidates.length, 2);
  const manualMessage = assistant.currentSession().messages.at(-1);
  const primaryAfterManualRound = primaryRequests.length;
  assert.equal(primaryAfterManualRound, manualPrimaryBefore + 4);
  const continued = await assistant.continueGeneration(manualMessage.id, 'candidate-2', '保留人物并加强低视角');
  assert.equal(continued.ok, true, JSON.stringify(continued.error));
  assert.equal(continued.data.status, 'awaiting_feedback');
  assert.equal(continued.successfulRounds, 2);
  assert.equal(continued.candidates.length, 4);
  assert(primaryRequests.length > primaryAfterManualRound, 'manual continuation returns to the primary judgement');
  assert(visionRequests.some(messages => JSON.stringify(messages).includes('保留人物并加强低视角')));

  assistant.setSettings({ generationAutoRun: true, imagesPerRound: 2, maxAutoRounds: 1 });
  reviewCounts.create = 0;
  failNextRenders = 1;
  const retried = await assistant.run({ text: '失败提交预算测试绘图', requestId: 'integration-retry' });
  assert.equal(retried.ok, true, JSON.stringify(retried.error));
  assert.equal(retried.renderAttempts, 1);
  assert.equal(retried.successfulRounds, 0);
  assert.equal(retried.usage.comfyCalls, 0);

  assistant.setSettings({ generationAutoRun: true, imagesPerRound: 2, maxAutoRounds: 2 });
  reviewCounts.create = 0;
  hangMode = 'late';
  hangAfterSubmissions = submitted.length + 1;
  const finalStarted = new Promise(resolve => { renderStarted = resolve; });
  const selecting = assistant.run({ text: '渲染中最终选择测试绘图', requestId: 'integration-final-select' });
  await finalStarted;
  const selectingMessage = assistant.currentSession().messages.at(-1);
  assert.equal(selectingMessage.result.candidates.length, 2);
  const selected = await assistant.selectGenerationFinal(selectingMessage.id, 'candidate-1');
  assert.equal(selected.status, 'completed');
  assert.equal(selected.outcome, 'user_selected');
  assert.equal(interrupts, 1);
  resolveLateRender();
  const selectionResult = await selecting;
  assert.equal(selectionResult.ok, true, JSON.stringify(selectionResult.error));
  assert.equal(selectionResult.selectedCandidateId, 'candidate-1');
  assert.equal(selectionResult.imageIds.includes('late-final'), false);
  assert.equal(assistant.generation.uiSnapshot(selectionResult.jobId).candidates.some(candidate => candidate.imageId === 'late-final'), false);

  hangMode = 'abortable';
  hangAfterSubmissions = submitted.length;
  const started = new Promise(resolve => { renderStarted = resolve; });
  const cancelling = assistant.run({ text: '取消测试绘图', requestId: 'integration-cancel' });
  await started;
  assert.equal(assistant.cancel('integration-cancel'), true);
  const cancelled = await cancelling;
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.error.code, 'CANCELLED');
  await wait(1);
  const cancelledJob = assistant.generation.list().find(job => job.requirements.includes('取消测试'));
  assert.equal(cancelledJob.status, 'cancelled');
  assistant.destroy();
});
