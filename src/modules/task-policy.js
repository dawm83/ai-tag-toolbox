'use strict';

function text(value, fallback = '') { const output = value == null ? '' : String(value).trim(); return output || fallback; }
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function names(values) { return [...new Set((Array.isArray(values) ? values : []).map(value => text(value)).filter(Boolean))]; }

const PRIMARY_TOOLS = Object.freeze(['tags.search', 'characters.search', 'conversation.listImages', 'vision.processOne', 'translation.translate', 'comfy.status', 'generation.execute', 'generation.resume']);
const ROUTED = Object.freeze({
  search_tags: { allowed: ['tags.search'], completion: ['tags.search'] },
  analyze_image: { allowed: ['conversation.listImages', 'vision.processOne'], completion: ['vision.processOne'] },
  compile_tags: { allowed: ['conversation.listImages', 'generation.execute'], completion: ['generation.execute'] },
  translate: { allowed: ['translation.translate'], completion: ['translation.translate'] },
  answer: { allowed: [], completion: [] },
  create_image: { allowed: ['tags.search', 'characters.search', 'conversation.listImages', 'comfy.status', 'generation.execute', 'generation.resume'], completion: ['generation.execute', 'generation.resume'] },
  recreate_image: { allowed: ['tags.search', 'characters.search', 'conversation.listImages', 'comfy.status', 'generation.execute', 'generation.resume'], completion: ['generation.execute', 'generation.resume'] },
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
  function allowedNames() { return completed ? [] : route.allowed.filter(name => !snapshot.forbidImages || !['comfy.status', 'generation.resume'].includes(name)); }
  function allows(name) { return allowedNames().includes(name); }
  function prepareCall(name, args = {}) {
    const next = { ...args };
    if (snapshot.forbidImages && name === 'generation.execute') next.outputType = 'tags';
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
      next.instruction = snapshot.originalRequest;
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
      analyze_image: '必要时用 conversation.listImages 定位图片，再用 vision.processOne 识图，按用户问题回答。不得生成 Tag 或绘图；没有成功看到图片时如实说明。',
      compile_tags: '只调用 generation.execute(outputType=tags) 生成 Tag，不查 ComfyUI。直接将用户要求交给子代理，使用代码块交付完整提示词。',
      answer: '直接回答当前问题，工具教程和举例不等于要求执行工具。',
      translate: '使用 translation.translate 完成翻译，然后回答。',
      auto: '结合上下文判断混合或模糊要求；只调用必要工具，连接 ComfyUI 本身不代表要求出图。'
    };
    return ['【本轮任务协议｜优先于上方通用调度规则】', `任务类型：${labels[snapshot.intent] || snapshot.intent}。`, `允许工具：${allowedNames().join('、') || '无，直接回答'}。`, workflow[snapshot.intent] || '绘图交给 generation.execute；需要恢复时使用 generation.resume，内部识图、渲染和评价由编排器负责。', '保留当前用户原话，不把自己猜测的要求替换用户要求。', completed ? '当前已取得工具结果，只整理最终答复；失败或未完成的步骤必须如实说明。' : '取得短任务结果后直接回答；工具出错时可在允许范围内修正参数。'].join('\n');
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
