'use strict';

function text(value) { return value == null ? '' : String(value).trim(); }
function list(value) { return Array.isArray(value) ? [...new Set(value.map(text).filter(Boolean))] : []; }

const TAG_WORD = /tags?|prompts?|标签|提示词/i;
const ANSWER_RE = /^(?:请问|请|帮我|请帮我)?(?:如何|怎么|怎样|为什么|解释|说明|介绍)|是什么意思|是什么原理|有(?:什么|哪些)[^，。；,;\n]*[？?]|^(?:what\s+is|how\s+(?:to|do|does|can)|why|explain)\b/i;
const SEARCH_RE = /搜索|查询|查找|查一下|找找|找一下|(?:帮我|请)找|\b(?:search|find|lookup|look\s+up)\b/i;
const CREATE_RE = /^画|帮我画|请画|画(?:一|个|张|幅|只|出)|绘制|出图|生图|画图|生成[^，。；,;\n]*(?:图片|图像|张[^，。；,;\n]*图)|\b(?:draw|paint|render)\b|\b(?:create|generate)\b[^,;\n]*\b(?:image|picture)\b/i;
const NO_IMAGE_RE = /(?:不要|无需|不需要|不用|别)\s*(?:再|继续|直接)?\s*(?:生成(?:图片|图像|一张图)|画图|生图|出图|绘图|画)|不画|\b(?:no\s+image|without\s+(?:an?\s+)?image|(?:don't|do\s+not)\s+(?:draw|render|generate\s+images?))\b/i;

function routeTask(input = {}) {
  const originalRequest = text(input.text || input.originalRequest);
  const imageIds = list(input.imageIds);
  // Classify the instruction, not example text inside quotes or code blocks.
  const instruction = originalRequest.replace(/```[\s\S]*?```|“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"/g, ' ');
  const noImage = NO_IMAGE_RE.test(instruction);
  const value = instruction.replace(new RegExp(NO_IMAGE_RE.source, 'gi'), ' ').trim();
  const search = SEARCH_RE.test(value) && TAG_WORD.test(originalRequest);
  const usesTagsToDraw = /(?:用|使用|根据)[^，。；,;\n]*tags?[^，。；,;\n]*(?:画|生图|出图)/i.test(value);
  const explicitTags = !usesTagsToDraw && /(?:生成|整理|制作|编写|写一|提取|给我|只要|只需)[^，。；,;\n]*(?:tags?|prompts?|标签|提示词)|\b(?:generate|write|make|compose)\s+(?:some\s+)?(?:tags?|prompts?)\b/i.test(value);
  const recreate = /复刻|重绘|改图|修改这张|把这张图.*改|基于这张.*(?:优化|修改)|\b(?:recreate|reproduce)\b|(?:edit|modify)\s+(?:this|the)\s+image/i.test(value);
  const create = CREATE_RE.test(value);
  const imageQuestion = /(?:这张图|这幅图|图片里|图中).*(?:什么|怎样|如何)|what(?:'s|\s+is)\s+in\s+(?:this|the)\s+(?:image|picture)/i.test(value);
  const analyze = imageQuestion || /分析|识图|看图|描述|查看|\b(?:analy[sz]e|inspect|describe)\b/i.test(value) && (imageIds.length > 0 || /图片|图像|image/i.test(value));
  const mixed = /先.*(?:再|然后)|并|同时|\b(?:then|and)\b/i.test(value) && Number(search) + Number(explicitTags) + Number(analyze) + Number(!explicitTags && (create || recreate)) > 1;
  let intent = 'auto';
  if (!originalRequest && imageIds.length) intent = 'analyze_image';
  else if (mixed) intent = 'auto';
  else if (imageQuestion) intent = 'analyze_image';
  else if (ANSWER_RE.test(value) || /^(?:你好|您好|谢谢|hi|hello|thanks)[!！。.?？\s]*$/i.test(value)) intent = 'answer';
  else if (/翻译|翻成|译成|翻一下|\b(?:translate|translation)\b/i.test(value)) intent = 'translate';
  else if (search) intent = 'search_tags';
  else if (explicitTags) intent = 'compile_tags';
  else if (analyze && !recreate) intent = 'analyze_image';
  else if (recreate && !noImage) intent = 'recreate_image';
  else if (create && !noImage) intent = 'create_image';
  else if (noImage) intent = 'answer';
  const referenceMatch = originalRequest.match(/(?:参考|已有|提供的?)\s*(?:tag|tags|标签|提示词)\s*[:：]\s*([\s\S]+)/i) || originalRequest.match(/(?:reference\s+tags?)\s*[:：]\s*([\s\S]+)/i);
  const referenceTags = referenceMatch ? referenceMatch[1].trim() : '';
  return { intent, originalRequest, imageIds, referenceTags, forbidImages: noImage, source: 'local_router' };
}

function isGenerationFeedback(input = {}) {
  if (list(input.imageIds).length) return false;
  const value = text(input.text).replace(/```[\s\S]*?```|“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"/g, ' ').trim();
  if (ANSWER_RE.test(value) || SEARCH_RE.test(value) || /翻译|重新.*(?:识图|分析|提取)|从头|新(?:的)?(?:任务|图片|角色)|另(?:外)?(?:画|一张)|\b(?:translate|start over|new (?:image|task)|reinspect)\b/i.test(value)) return false;
  if (/识图|分析图片|描述图片/.test(value)) return false;
  return /继续(?:优化|修改|调整)|改成|改为|换成|修正|调整|保留.*(?:改|换)|(?:姿势|动作|人物|角色|服装|背景|构图|视角|颜色|你这|原来)[\s\S]*(?:不对|错|应该|站着)|\b(?:change|adjust|fix|correct|refine|wrong pose)\b/i.test(value);
}

module.exports = { routeTask, isGenerationFeedback };
