'use strict';
const { createPrimaryVision } = require('./primary-vision');

const DEFAULT_PRIMARY_PROMPT = '你是 AI 绘画 Tag 工具箱的主 AI，依据用户目标和实际证据选择必要工具。';
const PUBLIC_CONFIG_KEYS = Object.freeze(['base', 'model', 'key', 'temperature', 'timeoutMs', 'maxTokens', 'stream']);
const RUNTIME_CONFIG_KEYS = Object.freeze(['signal', 'tools', 'tool_choice', 'onDelta', 'onEvent']);
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function publicRequestConfig(value = {}) {
  if (!object(value)) return {};
  const result = {};
  for (const key of PUBLIC_CONFIG_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const item = value[key];
    if (['base', 'model', 'key'].includes(key) && typeof item === 'string') result[key] = item.trim();
    else if (key === 'stream' && typeof item === 'boolean') result[key] = item;
    else if (['temperature', 'timeoutMs', 'maxTokens'].includes(key) && item != null && item !== '' && Number.isFinite(Number(item))) result[key] = Number(item);
  }
  return result;
}
function userText(request = {}) {
  const messages = Array.isArray(request.messages) ? request.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!object(message) || message.role !== 'user') continue;
    if (typeof message.content === 'string' && message.content.trim()) return message.content;
    if (Array.isArray(message.content)) {
      const parts = message.content
        .filter(part => part && (part.type === 'text' || typeof part.text === 'string'))
        .map(part => (typeof part.text === 'string' ? part.text : ''))
        .filter(Boolean);
      const combined = parts.join('\n').trim();
      if (combined) return combined;
    }
  }
  return typeof request.input?.text === 'string' ? request.input.text.trim() : '';
}

function createPrimaryAgent(options = {}) {
  const client = options.client;
  const prompts = options.prompts;
  const visualComplete = createPrimaryVision({ resolveImage: options.resolveImage, client });
  function getPrompt(request = {}) {
    const prompt = typeof prompts?.composePrimary === 'function' ? prompts.composePrimary(userText(request)) : prompts?.getEffective?.('primary') || prompts?.get?.('primary') || DEFAULT_PRIMARY_PROMPT;
    const guidance = [
      '【当前工具协议｜旧提示词中的固定流水线规则已由本协议替代】',
      '你负责理解目标、直接观察和综合判断，自主选择最少的必要模块；不需要按固定顺序调用所有工具。',
      '有实际图片输入时先自己观察。vision.processOne(mode=ai) 用于第二意见、具体细节或主模型不能看图时的视觉辅助；提出简短具体的问题。各来源都可能出错，交叉核对冲突，不盲从自己或子代理的第一次判断。',
      '复刻图片的首轮有硬性顺序：有参考图且没有可靠内置 Tag 时，必须先调用 vision.processOne(mode=local)；本地 Tag 返回后，直接把它们作为 generation.execute 的 positiveTags 首次出图，禁止先让 AI 视觉描述或 generateTags 重写这一轮。即使本地结果可能漏认，也先用它跑出基线；只有本地识图失败或没有可用 Tag 时才改走其他方案。local 每个参考图任务只调用一次，后续修改不再次本地识图。',
      '需要文生图 Tag 时调用 agent.generateTags(operation=compile)，只传关键要求和可选 imageId。修改用 operation=revise，传上一版完整 positiveTags/negativeTags、当前要求与简短 changes；不要附完整蓝图、角色档案、历史评价。工具返回合并后的 Tag。',
      'generation.execute 使用你准备好的 positiveTags 出一轮图。把用户原始要求原样保存在 originalRequirements。结果回传后直接看原图与候选，必要时用 generation.review 获取辅助评价。大差异可重新组织明确画面描述再编译，小差异定向修改。',
      '后续出图沿用 generation.resume 的原 jobId，传基础候选和修改后的完整 Tag；保留未提及的内容。选择结果调用 generation.select。autoRun=false 或 remainingRounds=0 时交付本轮结果等待用户；次数是上限，不要求跑满。不要调用底层 comfy.render。',
      '只要 Tag 时 outputType=tags；不触发 ComfyUI。needs_input 时按照返回的缺项继续原任务，不新建任务回避暂停。角色选择允许 characterSelection.original=true。',
      'best_available 表示已有候选中选择的结果，不等于视觉验收通过；无评分表示未调用评价模块，不能编造分数。text_approximation 表示原图仅用于分析比较，未输入绘图工作流。交付说明实际偏差。',
      '【语言协议】当前界面为中文时默认用简体中文，保留英文 Tag、专名和用户原文。'
    ];
    if (options.charactersEnabled) guidance.push('已有作品角色需要确认时使用 tags.search 的 attachedData 或 characters.search，按需带 characterIds。原创人物不强制查询。角色库外观只是参考，不自动补服装和配件；不确定的 Tag 可用 tags.search 查询。');
    if (options.favoritesEnabled) guidance.push('收藏查询：items 的 kind 区分 tag/bundle，favoriteLocations 表示收藏位置。contentOmitted=true 时不能把部分文本当完整提示词。');
    if (options.getSettings?.()?.comfy?.enabled !== true) guidance.push('当前绘图不可用，只交付 Tag；不得自行开启绘图。');
    return [prompt, guidance.join('\n')].filter(Boolean).join('\n\n');
  }
  async function complete(messages, request = {}) {
    const config = { ...publicRequestConfig(options.getSettings?.()?.primaryApi), ...publicRequestConfig(request) };
    for (const key of RUNTIME_CONFIG_KEYS) if (Object.prototype.hasOwnProperty.call(request, key)) config[key] = request[key];
    return visualComplete(messages, config, request);
  }
  return Object.freeze({ complete, getPrompt });
}

module.exports = { createPrimaryAgent, publicRequestConfig, DEFAULT_PRIMARY_PROMPT };
