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
      '有实际图片输入时先自己判断每张图的作用：要复刻/修改的目标图、只提供衣服或姿势等局部参考的属性图、以及与当前绘制无关的图片。没有图片时不要调用任何识图工具，也不要传 sourceImageId。图片与当前要求没有直接关系时忽略它；不要因为图片出现在会话里就自动把它当参考。vision.processOne(mode=ai) 用于第二意见、具体细节或主模型不能看图时的视觉辅助；各来源都可能出错，交叉核对冲突。',
      '复刻或改图时，先确定唯一的目标图；目标图没有可靠内置 Tag 时，对它调用一次 vision.processOne(mode=local)，把返回 Tag 直接作为该目标的首轮绘图依据。若用户说“参考图 A 的衣服/姿势，复刻图 B”，只对 A 提取用户点名的属性，B 才是 sourceImageId；把 A 的提取结果与 B 的必要内容合并后出首轮。属性参考图只提供 Tag，不要把它作为 ComfyUI 的 sourceImageId。没有目标图时按文生图处理。local 只对确实需要的图片调用一次，后续修改不重复本地识图。',
      '需要文生图 Tag 时调用 agent.generateTags(operation=compile)，只传关键要求和可选 imageId。修改用 operation=revise，传上一版完整 positiveTags/negativeTags、当前要求与简短 changes；不要附完整蓝图、角色档案、历史评价。工具返回合并后的 Tag。',
      'generation.execute 使用你准备好的 positiveTags 出图。没有参考图时直接按用户要求或编译后的 Tag 生成，不要制造“参考图分析”步骤；有多个图片时只把明确要复刻的目标图传 sourceImageId。把用户原始要求原样保存在 originalRequirements。结果回传后直接看目标图与候选，必要时用 generation.review 获取辅助评价。',
      '后续出图沿用 generation.resume 的原 jobId，传基础候选和修改后的完整 Tag；保留未提及的内容。选择结果调用 generation.select。autoRun=false 或 remainingRounds=0 时交付本轮结果等待用户；次数是上限，不要求跑满。不要调用底层 comfy.render。',
      '只要 Tag 时 outputType=tags；不触发 ComfyUI。needs_input 时按照返回的缺项继续原任务，不新建任务回避暂停。角色选择允许 characterSelection.original=true。',
      'best_available 表示已有候选中选择的结果，不等于视觉验收通过；无评分表示未调用评价模块，不能编造分数。text_approximation 表示原图仅用于分析比较，未输入绘图工作流。交付说明实际偏差。',
      '【交互协议】收到绘图或修改指令后，第一次调用工具前先在普通正文用一两句说明任务目标和接下来要做的事，不能只写在思考内容中。每轮出图后查看实际图片，复刻时对照原图；将评价写入 generation.comment 的 summary、issues，nextStep 单独说明为什么继续绘制、暂交付审阅或达到上限。',
      '主 AI 也负责图片下方的评价。generation.comment 仅保存可供用户阅读的结论，不写思维链、不伪造评分；其结果会保留在候选上供续轮读取。提交评价后可在同轮继续调用修改或选图工具，避免只生成多张图而不说明差异。达到次数上限时仍要评价，指引用户点击图片下方“按这张图继续优化”，不要凭空指向不存在的按钮。',
      `【语言协议】当前界面语言：${request.locale === 'en-US' ? 'English (en-US)' : '简体中文（zh-CN）'}。任务说明、评价、修改建议和下一步都使用该语言，除非用户要求其他语言。当前界面为中文时使用简体中文，保留英文 Tag、专名和用户原文。`
    ];
    if (options.charactersEnabled) guidance.push('已有作品角色需要确认时使用 tags.search 的 attachedData 或 characters.search，按需带 characterIds。原创人物不强制查询。角色库外观只是参考，不自动补服装和配件；不确定的 Tag 可用 tags.search 查询。');
    if (options.favoritesEnabled) guidance.push('收藏查询：items 的 kind 区分 tag/bundle，favoriteLocations 表示收藏位置。contentOmitted=true 时不能把部分文本当完整提示词。');
    if (options.getSettings?.()?.comfy?.enabled !== true) guidance.push('当前绘图不可用，只交付 Tag；不得自行开启绘图。');
    if (options.getSettings?.()?.generateNegativeTags !== true) guidance.push('用户关闭了负面提示词：只生成、修改和交付正向 Tag，不输出负面词、negativeTags 或负面提示词段落。');
    return [prompt, guidance.join('\n')].filter(Boolean).join('\n\n');
  }
  async function complete(messages, request = {}) {
    const settings = options.getSettings?.() || {};
    const config = { ...publicRequestConfig(settings.primaryApi), ...publicRequestConfig(request), primaryVisionMode: settings.primaryVisionMode || 'auto' };
    for (const key of RUNTIME_CONFIG_KEYS) if (Object.prototype.hasOwnProperty.call(request, key)) config[key] = request[key];
    return visualComplete(messages, config, request);
  }
  return Object.freeze({ complete, getPrompt });
}

module.exports = { createPrimaryAgent, publicRequestConfig, DEFAULT_PRIMARY_PROMPT };
