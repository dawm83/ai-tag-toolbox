'use strict';

function text(value, fallback = '') { const output = value == null ? '' : String(value).trim(); return output || fallback; }
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function names(values) { return [...new Set((Array.isArray(values) ? values : []).map(value => text(value)).filter(Boolean))]; }

const PRIMARY_TOOLS = Object.freeze(['tags.search', 'characters.search', 'conversation.listImages', 'conversation.viewImages', 'vision.processOne', 'translation.translate', 'agent.generateTags', 'comfy.status', 'generation.execute', 'generation.resume', 'generation.review', 'generation.select']);
const ROUTED = Object.freeze({
  search_tags: { allowed: ['tags.search'], completion: ['tags.search'] },
  analyze_image: { allowed: ['conversation.listImages', 'conversation.viewImages', 'vision.processOne'], completion: [] },
  compile_tags: { allowed: PRIMARY_TOOLS.filter(name => !['comfy.status', 'generation.review', 'generation.select', 'translation.translate'].includes(name)), completion: ['generation.execute', 'generation.resume'] },
  translate: { allowed: ['translation.translate'], completion: ['translation.translate'] },
  answer: { allowed: [], completion: [] },
  create_image: { allowed: PRIMARY_TOOLS, completion: ['generation.execute', 'generation.resume', 'generation.select'] },
  recreate_image: { allowed: PRIMARY_TOOLS, completion: ['generation.execute', 'generation.resume', 'generation.select'] },
  auto: { allowed: PRIMARY_TOOLS, completion: [] }
});

function createTaskPolicy(task = {}) {
  const snapshot = {
    intent: text(task.intent, 'auto'),
    originalRequest: text(task.originalRequest),
    imageIds: names(task.imageIds),
    referenceTags: text(task.referenceTags),
    forbidImages: task.forbidImages === true,
    source: text(task.source, 'local_router')
  };
  const route = ROUTED[snapshot.intent] || ROUTED.auto;
  let completed = false;
  let waiting = false;
  let activeJobId = text(task.feedbackJobId);
  function allowedNames() { return completed ? [] : route.allowed.filter(name => (!snapshot.forbidImages || name !== 'comfy.status') && (!activeJobId || name !== 'generation.execute')); }
  function allows(name) { return allowedNames().includes(name); }
  function prepareCall(name, args = {}) {
    const next = { ...args };
    if (task.feedbackJobId && name.startsWith('generation.') && name !== 'generation.execute') {
      next.jobId = task.feedbackJobId;
      if (name === 'generation.resume' && task.baseCandidateId) next.baseCandidateId = task.baseCandidateId;
    }
    if ((snapshot.forbidImages || snapshot.intent === 'compile_tags') && ['generation.execute', 'generation.resume'].includes(name)) next.outputType = 'tags';
    if (snapshot.intent === 'compile_tags' && name === 'generation.execute') {
      next.requirements = snapshot.originalRequest;
      next.originalRequirements = snapshot.originalRequest;
      next.referenceTags = snapshot.referenceTags;
      next.outputType = 'tags';
      if (!next.sourceImageId && !next.sourceSlot && snapshot.imageIds.length === 1) next.sourceImageId = snapshot.imageIds[0];
      next.mode = next.sourceImageId || next.sourceSlot ? 'recreate' : 'create';
      delete next.autoRun;
      delete next.imagesPerRound;
      delete next.maxAutoRounds;
    }
    if (snapshot.intent === 'analyze_image' && name === 'vision.processOne') {
      if (!next.imageId && snapshot.imageIds.length === 1) next.imageId = snapshot.imageIds[0];
      next.mode = next.mode || 'ai';
      next.instruction = next.instruction || snapshot.originalRequest;
    }
    if ((snapshot.intent === 'create_image' || snapshot.intent === 'recreate_image') && name === 'generation.execute') {
      next.requirements = snapshot.originalRequest;
      next.originalRequirements = snapshot.originalRequest;
      if (snapshot.intent === 'create_image') next.mode = 'create';
      if (snapshot.intent === 'recreate_image') {
        next.mode = 'recreate';
        if (!next.sourceImageId && !next.sourceSlot && snapshot.imageIds.length === 1) next.sourceImageId = snapshot.imageIds[0];
      }
    }
    return next;
  }
  function completionFor(name, data) {
    if (name === 'generation.execute' && data?.jobId) activeJobId = data.jobId;
    if (data?.decisionRequired) return false;
    if (name === 'generation.select') { completed = true; return true; }
    if (!route.completion.includes(name)) return false;
    if (name === 'generation.execute' || name === 'generation.resume') {
      completed = ['completed', 'awaiting_feedback', 'needs_input', 'failed', 'cancelled'].includes(data?.status);
      waiting = data?.status === 'needs_input' || data?.status === 'awaiting_feedback';
    } else completed = true;
    return completed;
  }
  function policyError(name) {
    const code = !route.allowed.includes(name) ? 'TOOL_NOT_ALLOWED_FOR_INTENT' : completed ? (waiting ? 'TASK_WAITING_FOR_INPUT' : 'TASK_ALREADY_SATISFIED') : 'TOOL_NOT_ALLOWED_FOR_INTENT';
    const message = completed
      ? waiting ? '当前任务正在等待补充信息，不能继续调用其他工具' : '当前任务已得到结果，请直接回答用户'
      : `当前任务（${snapshot.intent}）不能调用 ${name}`;
    return { code, message, retryable: false };
  }
  function prompt() {
    const labels = { search_tags: '搜索 Tag', analyze_image: '分析图片', compile_tags: '生成 Tag', translate: '翻译', answer: '直接回答', create_image: '生成图片', recreate_image: '复刻图片', auto: '综合任务' };
    const workflow = {
      search_tags: '用 tags.search 查询实际词库后直接整理返回，不生成新的 Tag 或图片。',
      analyze_image: '能直接看图时自己判断；需要细节或第二意见时调用 vision.processOne 并提出具体问题。证据足够后回答，不绘图。',
      compile_tags: '只交付 Tag。按需查看参考图或用 agent.generateTags 编译/修改；generation.execute(outputType=tags) 可保存本次 Tag，续改沿用 generation.resume。',
      answer: '直接回答当前问题，工具教程和举例不等于要求执行工具。',
      translate: '使用 translation.translate 完成翻译，然后回答。',
      recreate_image: '有参考图且没有可靠内置 Tag 时，首轮必须先调用 vision.processOne(mode=local)，把返回 Tag 原样交给 generation.execute；不要先用 AI 描述或 generateTags 改写。local 只运行一次，后续轮次根据首轮结果和图片比较决定修改。',
      auto: '结合上下文判断混合或模糊要求；只调用必要工具，连接 ComfyUI 本身不代表要求出图。'
    };
    return ['【本轮目标与可用能力】', `任务类型：${labels[snapshot.intent] || snapshot.intent}。`, `允许工具：${allowedNames().join('、') || '无，直接回答'}。`, workflow[snapshot.intent] || '自己选择必要模块。出图使用准备好的 Tag，结果返回后再判断；不必调用所有工具。', '用户原话定义目标，工具结果是证据。', activeJobId ? `当前任务 ${activeJobId}：后续用 generation.resume 保留同一任务。` : '', completed ? '当前已完成或等待用户输入，请整理实际结果。' : '证据和结果足够后结束。'].filter(Boolean).join('\n');
  }
  return Object.freeze({
    allows, allowedNames, prepareCall, completionFor, policyError, prompt,
    isComplete: () => completed,
    isWaiting: () => waiting,
    filterTools: schemas => schemas.filter(row => allows(String(row.function?.name || row.name).replace('_', '.'))).map(row => {
      const copy = clone(row);
      if ((snapshot.intent === 'compile_tags' || snapshot.forbidImages) && copy.function?.name === 'generation_execute' && copy.function.parameters?.properties?.outputType) {
        copy.function.parameters.properties.outputType.enum = ['tags'];
        copy.function.description = '按用户原始要求生成 Tag。outputType 必须为 tags，完成后直接交付，不调用 ComfyUI。';
      }
      return copy;
    }),
    snapshot: () => ({ ...clone(snapshot), allowedTools: allowedNames(), complete: completed, waiting })
  });
}

module.exports = { PRIMARY_TOOLS, createTaskPolicy };
