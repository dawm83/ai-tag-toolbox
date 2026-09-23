'use strict';

const { SCHEMAS, OUTPUT_SCHEMAS } = require('./fixed-subagents');
const { assertValid } = require('./schema');
const { errorShape, resultOk, resultError } = require('./error-manager');
const { compactVisionResult } = require('./vision-payload');
const { fitDimensionsToAspectRatio } = require('./images');
const { hasWritableDimensionBindings } = require('./comfy-workflow');
const { applyPromptPatch } = require('./prompt-patch');
const TOOL_NAMES = Object.freeze(['tags.search', 'characters.search', 'conversation.listImages', 'conversation.viewImages', 'vision.processOne', 'translation.translate', 'agent.generateTags', 'comfy.status', 'comfy.validateWorkflow', 'comfy.render', 'generation.execute', 'generation.resume', 'generation.review', 'generation.select', 'generation.comment', 'generation.resolveTarget']);
const PRIMARY_TOOL_NAMES = Object.freeze(['tags.search', 'characters.search', 'conversation.listImages', 'conversation.viewImages', 'vision.processOne', 'translation.translate', 'agent.generateTags', 'comfy.status', 'generation.execute', 'generation.resume', 'generation.review', 'generation.select', 'generation.comment', 'generation.resolveTarget']);
const NATIVE_NAMES = new Map(TOOL_NAMES.map(name => [name.replace('.', '_'), name]));
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function schema(properties, required = []) { return { type: 'object', additionalProperties: false, properties, required }; }
const string = { type: 'string' };
const nonempty = { type: 'string', minLength: 1, maxLength: 1000 };
const tagArray = { type: 'array', items: nonempty, maxItems: 256 };
const attachedDataSchema = schema({ type: string, characterId: string, series: string, identityTags: tagArray, appearanceTags: tagArray });
const locationSchema = schema({ membershipId: string, pageId: string, pageName: string, groupId: string, groupName: string }, ['membershipId', 'pageId', 'pageName', 'groupId', 'groupName']);
const tagSchema = schema({ id: nonempty, kind: { type: 'string', enum: ['tag', 'bundle'] }, content: string, contentOmitted: { type: 'boolean' }, favoriteLocations: { type: 'array', items: locationSchema }, en: nonempty, zh: string, aliases: { type: 'array', items: string, maxItems: 64 }, category: string, subcategory: string, nsfw: { type: 'boolean' }, confidence: { type: 'number' }, attachedData: attachedDataSchema }, ['id', 'kind', 'contentOmitted', 'favoriteLocations']);
const characterTagSchema = schema({ id: nonempty, en: nonempty, zh: string, category: string, nsfw: { type: 'boolean' }, review: { type: 'boolean' }, edited: { type: 'boolean' } }, ['id', 'en']);
const characterSchema = schema({ id: nonempty, identityTagId: nonempty, contentOmitted: { type: 'boolean' }, name: string, nameZh: string, aliases: { type: 'array', items: string }, seriesId: string, seriesName: string, identityTags: tagArray, generalTags: { type: 'array', items: characterTagSchema }, specificTags: { type: 'array', items: characterTagSchema }, hasFeatures: { type: 'boolean' }, count: { type: 'number' }, trigger: string }, ['id', 'identityTags', 'generalTags', 'specificTags']);
const generateParameters = clone(SCHEMAS.generateTags);
delete generateParameters.properties.characterReferences;
const minimalGenerateParameters = schema(Object.fromEntries(['operation', 'requirements', 'imageId', 'positiveTags', 'negativeTags', 'changes', 'generateNegativeTags'].map(key => [key, clone(SCHEMAS.generateTags.properties[key])])), ['operation', 'requirements']);
const imageSchema = schema({ imageId: nonempty, refId: string, slotNo: { type: 'integer', minimum: 0 }, displayTitle: string, source: string, messageId: string, pending: { type: 'boolean' }, sent: { type: 'boolean' }, final: { type: 'boolean' }, width: { type: 'number', minimum: 0 }, height: { type: 'number', minimum: 0 }, hasBuiltinTags: { type: 'boolean' } }, ['imageId']);
const workflowSchema = schema({ ready: { type: 'boolean' }, error: string }, ['ready', 'error']);
const capabilitiesSchema = schema({ txt2img: { type: 'boolean' }, img2img: { type: 'boolean' }, controlImage: { type: 'boolean' }, mask: { type: 'boolean' } });
const statusSchema = schema({ enabled: { type: 'boolean' }, connected: { type: 'boolean' }, workflowReady: { type: 'boolean' }, render: { type: 'boolean' }, error: string, workflowProfileId: string, workflowRevision: string, capabilities: capabilitiesSchema }, ['enabled', 'connected', 'workflowReady', 'render', 'error']);
const pendingRenderSchema = schema({ promptId: nonempty, base: string, workflowHash: string, changedBindings: { type: 'array', items: string }, parameters: { type: 'object' }, workflowProfileId: string, workflowRevision: string, recreationMode: string, aspectRatioMode: string }, ['promptId', 'base']);
const renderSchema = schema({ artifacts: { type: 'array', minItems: 1, maxItems: 256, items: imageSchema }, imageIds: { type: 'array', minItems: 1, maxItems: 256, items: nonempty }, prompt: string, negative: string, positiveTags: tagArray, negativeTags: tagArray, parameters: { type: 'object' }, workflowProfileId: string, workflowRevision: string, workflowHash: string, changedBindings: { type: 'array', items: string }, recreationMode: { type: 'string', enum: ['', 'reference_image', 'text_approximation'] }, aspectRatioMode: { type: 'string', enum: ['', 'source_matched', 'workflow_fixed'] } }, ['artifacts', 'imageIds']);
const characterSelectionSchema = schema({ query: nonempty, characterId: nonempty, original: { type: 'boolean' } }, ['query']);
const generationExecuteSchema = schema({ outputType: { type: 'string', enum: ['tags', 'images'] }, originalRequirements: { type: 'string', minLength: 1, maxLength: 16000 }, requirements: { type: 'string', minLength: 1, maxLength: 16000 }, referenceTags: { type: 'string', maxLength: 16000 }, mode: { type: 'string', enum: ['create', 'recreate', 'auto'] }, sourceImageId: nonempty, sourceSlot: { type: 'integer', minimum: 1, maximum: 10000 }, characterQueries: { type: 'array', maxItems: 8, items: nonempty }, characterIds: { type: 'array', maxItems: 8, items: nonempty }, strategy: { type: 'string', enum: ['quick', 'auto', 'fixed3'] }, autoSelect: { type: 'boolean' }, autoRun: { type: 'boolean' }, imagesPerRound: { type: 'integer', minimum: 1, maximum: 10 }, maxAutoRounds: { type: 'integer', minimum: 1, maximum: 10 }, workflowProfileId: nonempty });
const generationResumeSchema = schema({ jobId: nonempty, action: { type: 'string', enum: ['continue'] }, baseCandidateId: nonempty, feedback: { type: 'string', minLength: 1, maxLength: 16000 }, sourceImageId: nonempty, characterIds: { type: 'array', maxItems: 8, items: nonempty }, characterSelection: characterSelectionSchema, workflowProfileId: nonempty, strategy: { type: 'string', enum: ['quick', 'auto', 'fixed3'] }, autoSelect: { type: 'boolean' }, autoRun: { type: 'boolean' }, imagesPerRound: { type: 'integer', minimum: 1, maximum: 10 }, maxAutoRounds: { type: 'integer', minimum: 1, maximum: 10 } }, ['jobId']);
generationResumeSchema.properties.outputType = { type: 'string', enum: ['tags'] };
for (const params of [generationExecuteSchema, generationResumeSchema]) {
  params.properties.positiveTags = { ...tagArray, minItems: 1 };
  params.properties.negativeTags = tagArray;
}
const DEFINITIONS = Object.freeze({
  'generation.resolveTarget': {
    description: '确定当前修改请求的目标。能从用户描述和会话证据确定时 action=select、imageId=目标图片；返回该图的原始 Tag 与修改要求，然后继续修改。无法判断时 action=ask、question=简短问题，界面会显示图片选择框并保留用户要求。此工具不绘图、不选择最终结果。',
    parameters: schema({ action: { type: 'string', enum: ['select', 'ask'] }, imageId: nonempty, question: nonempty }, ['action']), outputSchema: { type: 'object' }
  },
  'generation.comment': {
    description: '主 AI 查看候选后，写入给用户看的简短评价、问题/修改建议，以及下一步（revise 继续改图、deliver 暂交付审阅、limit 达到次数上限）。按界面语言填写，不写思维链或 Tag。记录会出现在图片卡并供下轮读取；不调用子代理、不出图。可与本轮的修改或选图工具先后调用。',
    parameters: schema({
      jobId: nonempty, candidateId: nonempty, summary: nonempty,
      issues: { type: 'array', maxItems: 6, items: schema({ expected: string, observed: nonempty, suggestedChange: nonempty }, ['observed', 'suggestedChange']) },
      nextAction: { type: 'string', enum: ['revise', 'deliver', 'limit'] }, nextStep: nonempty
    }, ['jobId', 'candidateId', 'summary', 'issues', 'nextAction', 'nextStep']), outputSchema: { type: 'object' }
  },
  'generation.review': { description: '需要第二视觉意见或主模型不能看图时，评价指定任务的一张候选，返回简短差异。此工具不会修改 Tag 或继续出图。', parameters: schema({ jobId: nonempty, candidateId: nonempty }, ['jobId', 'candidateId']), outputSchema: { type: 'object' } },
  'generation.select': { description: '主 AI 综合用户目标、自己看到的图片和工具意见后选择最终候选。没有评价记录时不伪造评分；选择后结束本轮。', parameters: schema({ jobId: nonempty, candidateId: nonempty }, ['jobId', 'candidateId']), outputSchema: { type: 'object' } },
  'tags.search': { description: '查询本站标签及释义；Tag 含义、拼写或是否属于本站词库不确定时调用。命中角色名时附带角色出处和外貌 Tag。items 按稳定 id 去重，kind 区分 tag 和 bundle，favoriteLocations 汇总收藏位置；content 是完整原文，contentOmitted=true 表示内容未返回，不得用部分文本代替。', parameters: schema({ query: { type: 'string', maxLength: 1000 }, category: string, includeAdult: { type: 'boolean' }, limit: { type: 'integer', minimum: 1,maximum: 200 } }, ['query']), outputSchema: schema({ items: { type: 'array', maxItems: 200, items: tagSchema } }, ['items']) },
  'characters.search': { description: '查询本地角色资料，返回中英文名、作品、身份词和可选特征；已确认角色向 generation.execute 传 characterIds；仍有歧义时传 characterQueries 让用户选择。', parameters: schema({ query: { type: 'string', maxLength: 1000 }, seriesId: string, precision: { type: 'string', enum: ['exact', 'standard', 'broad'] }, includeAdult: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 10 } }, ['query']), outputSchema: schema({ items: { type: 'array', maxItems: 10, items: characterSchema }, total: { type: 'integer', minimum: 0 } }, ['items', 'total']) },
  'conversation.listImages': { description: '读取当前会话的真实 imageId、显示编号和图片元数据。', parameters: schema({ includePending: { type: 'boolean' }, includeDeleted: { type: 'boolean' } }), outputSchema: schema({ items: { type: 'array', items: imageSchema }, pendingIds: { type: 'array', items: string } }, ['items', 'pendingIds']) },
  'conversation.viewImages': { description: '让有视觉能力的主 AI 直接查看当前会话的图片。用于重看原图或对照候选图，一次最多四张；文字模型应使用识图子代理。', parameters: schema({ imageIds: { type: 'array', minItems: 1, maxItems: 4, items: nonempty } }, ['imageIds']), outputSchema: { type: 'object' } },
  'vision.processOne': { description: '对当前会话中的单个 imageId 进行 metadata/local/ai 识图。', parameters: SCHEMAS.vision, outputSchema: OUTPUT_SCHEMAS?.vision },
  'translation.translate': { description: '固定翻译子代理；source 为 ai 或 local。', parameters: SCHEMAS.translation, outputSchema: OUTPUT_SCHEMAS?.translation },
  'agent.generateTags': { description: '使用 Vision AI，根据要求、已有 Tag、参考 Tag、可选 imageId 和 characters.search 返回的 characterIds 生成英文绘图 Tag。', parameters: generateParameters, outputSchema: OUTPUT_SCHEMAS?.generateTags },
  'comfy.status': { description: '读取 ComfyUI 连接、启用和工作流状态。', parameters: schema({}), outputSchema: statusSchema },
  'comfy.validateWorkflow': { description: '检查用户当前 API 工作流是否可用。', parameters: schema({}), outputSchema: workflowSchema },
  'comfy.render': { description: '按正向 Tag 和可选负向 Tag 出图；内部复刻任务可传当前会话的 sourceImageId。', parameters: schema({ pendingRender: pendingRenderSchema, positiveTags: { ...tagArray, minItems: 1 }, negativeTags: tagArray, sourceImageId: nonempty, denoise: { type: 'number', minimum: 0, maximum: 1 }, controlStrength: { type: 'number', minimum: 0, maximum: 2 }, batchCount: { type: 'integer', minimum: 1, maximum: 10 } }, ['positiveTags']), outputSchema: renderSchema },
  'generation.execute': { description: '生成 Tag 或图片：仅 Tag 时传 outputType=tags，普通文生图不传 sourceImageId；复刻/改图时只把明确的目标图传 sourceImageId，衣服或姿势属性参考图只转成 Tag，不作为工作流原图。程序返回候选与实际提示词。用户已提供完整角色 Tag 时放入 referenceTags，不能再把角色名拆成 characterQueries 查询。', parameters: generationExecuteSchema, outputSchema: { type: 'object' } },
  'generation.resume': { description: '恢复暂停任务，或修订 completed/awaiting_feedback 的原任务：系统会绑定当前任务 jobId；修改时传 action=continue、feedback 和明确的 baseCandidateId。候选解析任务由主 AI 根据候选信息选择 baseCandidateId；无法确定时不要猜。仅 Tag 任务可省略候选，用户只要 Tag 时传 outputType=tags。沿用原要求、原图与当前 Tag，不重新调用 generation.execute 或识图。角色确认传原 needsInput.query，已有角色传 characterId，原创人物传 original=true。', parameters: generationResumeSchema, outputSchema: { type: 'object' } }
});

function failure(code, message) { return Object.assign(new Error(message), { code }); }
function check(schemaValue, value, code) { try { return assertValid(schemaValue || {}, value); } catch (error) { error.code = code; throw error; } }
function unwrap(value) { if (value?.ok === false) throw errorShape(value); return value?.ok === true && Object.prototype.hasOwnProperty.call(value, 'data') ? value.data : value; }
function publicTag(row, attachedData = {}, budget = { remaining: 16000 }) {
  const value = object(row?.tag) ? row.tag : row;
  const raw = typeof value?.content === 'string' ? value.content : typeof value?.en === 'string' ? value.en : text(value?.tag || value?.name || (typeof value === 'string' ? value : ''));
  const kind = value?.kind === 'bundle' ? 'bundle' : 'tag';
  const item = { id: text(value?.id) || raw, kind, contentOmitted: raw.length > budget.remaining || (kind === 'tag' && raw.length > 1000), favoriteLocations: clone(value?.favoriteLocations || []) };
  if (!item.contentOmitted) { item.content = raw; if (kind === 'tag') item.en = raw; budget.remaining -= raw.length; }
  for (const key of ['zh', 'category', 'subcategory']) if (typeof value?.[key] === 'string') item[key] = value[key];
  if (Array.isArray(value?.aliases)) item.aliases = value.aliases.filter(v => typeof v === 'string').slice(0, 64);
  if (typeof value?.nsfw === 'boolean') item.nsfw = value.nsfw;
  if (typeof value?.confidence === 'number' && Number.isFinite(value.confidence)) item.confidence = value.confidence;
  item.attachedData = object(attachedData) ? clone(attachedData) : {};
  return item;
}
const boundedWords = rows => (Array.isArray(rows) ? rows : []).filter(word => typeof word === 'string' && word.length > 0 && word.length <= 1000).slice(0, 256);
function identityCharacterReference(role) {
  return {
    id: role.id,
    name: role.nameZh || role.name,
    series: role.seriesName,
    identityTags: boundedWords(role.identityTags),
    generalTags: [],
    specificTags: []
  };
}
function publicCharacter(role) {
  const result = { id: role.id, identityTags: boundedWords(role.identityTags), generalTags: [], specificTags: [] };
  for (const key of ['identityTagId', 'name', 'nameZh', 'seriesId', 'seriesName', 'trigger']) if (typeof role[key] === 'string') result[key] = role[key];
  if (Array.isArray(role.aliases)) result.aliases = role.aliases.slice();
  if (typeof role.hasFeatures === 'boolean') result.hasFeatures = role.hasFeatures;
  if (Number.isFinite(role.count)) result.count = role.count;
  for (const field of ['generalTags', 'specificTags']) result[field] = (role[field] || []).filter(tag => typeof tag.en === 'string' && tag.en.length > 0 && tag.en.length <= 1000).slice(0, 256).map(tag => {
    const item = { id: tag.id, en: tag.en };
    for (const key of ['zh', 'category', 'nsfw', 'review', 'edited']) if (tag[key] !== undefined) item[key] = tag[key];
    return item;
  });
  result.contentOmitted = result.identityTags.length !== (role.identityTags || []).length || ['generalTags', 'specificTags'].some(field => result[field].length !== (role[field] || []).length);
  return result;
}
function roleAttachedData(role) {
  if (!role) return {};
  const value = publicCharacter(role);
  return { type: 'character', characterId: role.id, series: text(role.seriesName || role.seriesId), identityTags: value.identityTags,
    appearanceTags: boundedWords([...value.generalTags, ...value.specificTags].map(item => item.en)) };
}
function publicImage(value) {
  const result = { imageId: text(value?.imageId || value?.id) };
  for (const key of ['refId', 'displayTitle', 'source', 'messageId']) if (typeof value?.[key] === 'string') result[key] = value[key];
  for (const key of ['slotNo', 'width', 'height']) if (Number.isFinite(value?.[key])) result[key] = value[key];
  for (const key of ['pending', 'sent', 'final', 'hasBuiltinTags']) if (typeof value?.[key] === 'boolean') result[key] = value[key];
  return result;
}

function createPrimaryTools(options = {}) {
  const getSettings = typeof options.getSettings === 'function' ? options.getSettings : () => ({});
  const getRuntime = typeof options.runtime === 'function' ? options.runtime : () => options.runtime;
  const getGeneration = typeof options.generation === 'function' ? options.generation : () => options.generation;
  const repository = options.imageRepository || options.imagesRepository;
  const images = options.images;
  const comfy = options.comfy;
  const profiles = options.comfyProfiles || comfy?.profiles;
  const initialHints = new Map(options.storage?.get?.('initial_vision_hints', []) || []);
  async function scopedJob(jobId, context) {
    const generation = getGeneration(), job = generation?.get?.(jobId);
    if (!job) throw failure('JOB_NOT_FOUND', '没有找到任务');
    if (!context.sessionId || job.sessionId !== context.sessionId) throw failure('SESSION_UNAVAILABLE', '当前会话无权读取该任务');
    return { generation, job };
  }
  function currentComfy() {
    const settings = getSettings()?.comfy || {};
    const profile = profiles?.active?.();
    return profile ? { ...settings, base: profile.base || settings.base, workflow: profile.workflow || settings.workflow } : settings;
  }
  function guardSignal(context) { if (context.signal?.aborted) throw context.signal.reason || failure('CANCELLED', '请求已取消'); }
  function syncComfy(settings) { if (settings.base && typeof comfy?.setBase === 'function') comfy.setBase(settings.base); }
  async function subagent(name, args, context) {
    const runtime = getRuntime(); if (typeof runtime?.runSubAgent !== 'function') throw failure('SUBAGENT_UNAVAILABLE', '子代理运行器不可用');
    return runtime.runSubAgent(name, { input: args, parentRequestId: context.requestId, signal: context.signal, sessionId: context.sessionId, messageId: context.messageId, onEvent: context.onEvent });
  }
  async function renderedImages(raw, context, details = {}) {
    const value = unwrap(raw);
    let rows = Array.isArray(value) ? value.slice() : Array.isArray(value?.artifacts) ? value.artifacts.slice() : Array.isArray(value?.images) ? value.images.slice() : value?.artifact ? [value.artifact] : value ? [value] : [];
    const promptId = text(value?.promptId || rows[0]?.promptId);
    if (promptId && typeof comfy.result === 'function' && typeof comfy.fetchImage === 'function') {
      const result = await comfy.result(promptId, { signal: context.signal }); guardSignal(context);
      if (result?.status === 'error') throw failure('COMFY_FAILED', text(result.error) || 'ComfyUI 出图失败');
      const known = new Set(rows.filter(item => item?.dataUrl || item?.bytes).map(item => [item.filename, item.subfolder || '', item.type || 'output'].join('|')));
      const configuredOutputs = profiles?.active?.()?.bindings?.outputs;
      const outputRows = Array.isArray(configuredOutputs) && configuredOutputs.length
        ? (result?.outputs || []).filter(output => configuredOutputs.includes(String(output.nodeId)))
        : (result?.outputs || []);
      for (const output of outputRows) for (const file of output.files || []) {
        const key = [file.filename, file.subfolder || '', file.type || 'output'].join('|');
        if (known.has(key)) continue;
        known.add(key); rows.push(await comfy.fetchImage(file, context.signal)); guardSignal(context);
      }
    }
    rows = rows.filter(item => item && (item.dataUrl || item.bytes || item.imageId || item.id));
    if (!rows.length) throw failure('OUTPUT_INVALID', 'ComfyUI 未返回图片');
    if (typeof images?.add !== 'function' || typeof repository?.attachToConversation !== 'function') throw failure('IMAGE_STORE_UNAVAILABLE', '图片仓库不可用');
    const artifacts = [];
    for (const row of rows) {
      guardSignal(context);
      const known = text(row.imageId || row.id); let stored = known && images.get?.(known);
      if (!stored) stored = await images.add({ ...row, source: 'comfy' }, { source: 'comfy' });
      guardSignal(context);
      const imageId = text(stored?.imageId || stored?.id); if (!imageId) throw failure('OUTPUT_INVALID', '无法登记 ComfyUI 图片');
      const reference = await repository.attachToConversation(context.sessionId, imageId, { source: 'comfy', messageId: context.messageId, pending: false, sent: true });
      if (!reference) throw failure('IMAGE_ATTACH_FAILED', '无法将图片关联到当前会话');
      const artifact = publicImage({ ...stored, ...reference, imageId });
      if (!artifacts.some(item => item.imageId === imageId)) artifacts.push(artifact);
    }
    return { artifacts, imageIds: artifacts.map(item => item.imageId), ...clone(details) };
  }
  const handlers = {
    'generation.resolveTarget': (args, context) => {
      guardSignal(context);
      if (!context.feedbackRequest || typeof options.resolveFeedbackTarget !== 'function') throw failure('INPUT_EXPIRED', '没有待确认的修改目标');
      return options.resolveFeedbackTarget(args, context);
    },
    'tags.search': async args => {
      if (typeof options.tags?.search !== 'function') throw failure('TOOL_UNAVAILABLE', 'Tag 模块不可用');
      const includeAdult = (options.tags?.searchSettings?.().includeAdult ?? options.tags?.stateSnapshot?.().includeAdult ?? false) === true && args.includeAdult === true;
      const rows = await options.tags.search(args.query, { category: args.category, includeAdult, limit: args.limit || 50 });
      if (!Array.isArray(rows)) throw failure('OUTPUT_INVALID', '标签查询返回格式无效');
      const attached = new Map();
      if (typeof options.characters?.get === 'function') for (const row of rows) {
        if (!row.characterId && row?.category !== 'character_names' && row?.categoryCode !== 4) continue;
        const role = options.characters.get(row.characterId || row.id, { includeAdult });
        if (role) attached.set(row.id, roleAttachedData(role));
      }
      const budget = { remaining: 16000 }, seen = new Set();
      return { items: rows.filter(row => { const id = row.id || row.en; if (seen.has(id)) return false; seen.add(id); return row.searchable !== false && (includeAdult || !(row.adult || row.nsfw)); }).slice(0, args.limit || 50).map(row => publicTag(row, attached.get(row.id), budget)) };
    },
    'characters.search': args => {
      if (!options.characters?.page) throw failure('TOOL_UNAVAILABLE', '角色模块不可用');
      const includeAdult = (options.tags?.searchSettings?.().includeAdult ?? options.tags?.stateSnapshot?.().includeAdult ?? false) === true && args.includeAdult === true;
      const page = options.characters.page({ ...args, discovery: true, includeAdult, limit: args.limit || 5 });
      return { items: page.items.map(row => options.characters.get(row.id, { includeAdult })).filter(role => role && role.searchable !== false).map(publicCharacter), total: page.total };
    },
    'conversation.listImages': async (args, context) => {
      if (!context.sessionId) throw failure('SESSION_REQUIRED', '当前会话不可用');
      if (typeof repository?.listConversation !== 'function') throw failure('TOOL_UNAVAILABLE', '图片仓库不可用');
      const value = await repository.listConversation(context.sessionId, { includePending: args.includePending !== false, includeDeleted: args.includeDeleted === true });
      if (!Array.isArray(value?.items)) throw failure('OUTPUT_INVALID', '会话图片返回格式无效');
      return { items: value.items.map(publicImage), pendingIds: Array.isArray(value.pendingIds) ? value.pendingIds.filter(id => typeof id === 'string') : [] };
    },
    'conversation.viewImages': async (args, context) => {
      if (!context.sessionId || !repository?.listConversation) throw failure('SESSION_REQUIRED', '当前会话不可用');
      const rows = await repository.listConversation(context.sessionId, { includeDeleted: false });
      if (args.imageIds.some(id => !rows.items?.some(row => row.imageId === id))) throw failure('IMAGE_NOT_FOUND', '图片不在当前会话中');
      return { viewImageIds: args.imageIds };
    },
    'vision.processOne': async (args, context) => {
      const initial = context.caller === 'primary' && args.mode === 'local';
      const cacheKey = `${context.sessionId}:${args.imageId}:${args.model || ''}`;
      if (initial) {
        const rows = await repository?.listConversation?.(context.sessionId, { includeDeleted: false });
        const image = rows?.items?.find(row => row.imageId === args.imageId);
        if (!image) throw failure('IMAGE_NOT_FOUND', '图片不在当前会话中');
        if (initialHints.has(cacheKey)) return { ...clone(initialHints.get(cacheKey)), cached: true };
        if (context.afterRender || image.source === 'comfy') throw failure('INITIAL_HINT_ONLY', '本地识图只在参考图初始阶段使用；本轮请直接看图或询问视觉子代理');
      }
      const data = compactVisionResult({ ...unwrap(await subagent('vision', context.caller === 'primary' ? { ...args, includeLocalTags: false } : args, context)), imageId: args.imageId, mode: args.mode });
      if (initial) {
        data.evidenceRole = 'initial_hint'; data.reliability = 'weak';
        initialHints.set(cacheKey, clone(data));
        while (initialHints.size > 64) initialHints.delete(initialHints.keys().next().value);
        options.storage?.set?.('initial_vision_hints', [...initialHints]);
      }
      if (args.mode === 'metadata') context.onEvent?.({ type: 'source.metadata', stage: 'source', summary: data.hasBuiltinTags ? `读取到 ${data.builtinTags.length} 个内置 Tag` : '未读取到内置 Tag', details: { tagCount: data.builtinTags.length, source: 'metadata' } });
      if (args.mode === 'local') context.onEvent?.({ type: 'source.local_hint', stage: 'source', summary: `本地识图返回 ${data.tags.length} 个初始 Tag`, details: { tagCount: data.tags.length, tags: data.tags.slice(0, 12), reliability: data.reliability || 'weak' } });
      return data;
    },
    'translation.translate': (args, context) => subagent('translation', args, context),
    'agent.generateTags': async (args, context) => {
      if (context.caller === 'primary') {
        check(minimalGenerateParameters, args, 'INVALID_INPUT');
        if (getSettings()?.generateNegativeTags !== true) args = { ...args, negativeTags: [], generateNegativeTags: false };
        const value = unwrap(await subagent('generateTags', args, context));
        if (args.operation !== 'revise') return value;
        const next = applyPromptPatch(args, value, { negativeEnabled: getSettings()?.generateNegativeTags === true });
        if (!next.ok) throw failure('INVALID_PATCH', next.rejected.map(row => row.message).join('；'));
        context.onEvent?.({ type: 'prompt.revised', stage: 'prompt', summary: `Tag 已修改，增加 ${value.add?.length || 0} 项，删除 ${value.remove?.length || 0} 项`, details: { add: value.add || [], remove: value.remove || [] } });
        return { positiveTags: next.positiveTags, negativeTags: next.negativeTags, changes: { add: value.add, remove: value.remove } };
      }
      if (args.characterIds?.length) {
        if (!options.characters?.get) throw failure('TOOL_UNAVAILABLE', '角色模块不可用');
        const includeAdult = options.tags?.stateSnapshot?.().includeAdult === true;
        const characterReferences = [...new Set(args.characterIds)].map(id => {
          const role = options.characters.get(id, { includeAdult });
          if (!role) throw failure('CHARACTER_NOT_FOUND', '角色不存在或当前不可用：' + id);
          return identityCharacterReference(role);
        });
        return subagent('generateTags', { ...args, characterReferences }, context);
      }
      return subagent('generateTags', args, context);
    },
    'comfy.status': async (_args, context) => {
      if (typeof comfy?.status !== 'function') throw failure('TOOL_UNAVAILABLE', 'ComfyUI 连接器不可用');
      const settings = currentComfy(); syncComfy(settings);
      const value = unwrap(await comfy.status({ enabled: settings.enabled === true, workflow: settings.workflow, signal: context.signal }));
      const profile = profiles?.active?.();
      return { enabled: settings.enabled === true, connected: value?.connected === true, workflowReady: value?.workflowReady === true, render: value?.render === true, error: text(value?.error), workflowProfileId: text(profile?.id), workflowRevision: profile?.updatedAt ? String(profile.updatedAt) : '', capabilities: object(profile?.capabilities) ? clone(profile.capabilities) : { txt2img: true, img2img: false, controlImage: false, mask: false } };
    },
    'comfy.validateWorkflow': async (_args, context) => {
      const settings = currentComfy(); const method = comfy?.workflowStatus || comfy?.validateWorkflow;
      if (typeof method !== 'function') throw failure('TOOL_UNAVAILABLE', 'ComfyUI 工作流检查不可用');
      guardSignal(context); const value = unwrap(await method.call(comfy, settings.workflow));
      if (typeof value?.ready !== 'boolean') throw failure('OUTPUT_INVALID', '工作流检查返回格式无效');
      return { ready: value.ready, error: text(value.error) };
    },
    'comfy.render': async (args, context) => {
      if (!context.sessionId) throw failure('SESSION_REQUIRED', '当前会话不可用');
      if (typeof comfy?.render !== 'function') throw failure('TOOL_UNAVAILABLE', 'ComfyUI 连接器不可用');
      const settings = currentComfy(); if (settings.enabled !== true) throw failure('COMFY_DISABLED', 'ComfyUI 未启用'); syncComfy(settings);
      const profile = profiles?.active?.();
      const negative = args.negativeTags === undefined ? (Array.isArray(settings.negativeTags) ? settings.negativeTags : text(settings.negativeTags).split(/[,，\n]+/).filter(Boolean)) : args.negativeTags;
      if (args.pendingRender) {
        const pending = args.pendingRender;
        if (pending.base !== settings.base) throw failure('COMFY_PENDING_ADDRESS', '请切回提交任务时的 ComfyUI 地址，再查询原任务。');
        if (typeof comfy.wait !== 'function') throw failure('COMFY_WAIT_UNAVAILABLE', '当前连接器不支持恢复结果查询');
        const raw = await comfy.wait(pending.promptId, { signal: context.signal });
        return renderedImages(raw, context, {
          prompt: args.positiveTags.join(', '), negative: negative.join(', '), positiveTags: args.positiveTags, negativeTags: negative,
          parameters: pending.parameters || {}, workflowHash: pending.workflowHash || '', changedBindings: pending.changedBindings || [],
          workflowProfileId: pending.workflowProfileId || '', workflowRevision: pending.workflowRevision || '',
          recreationMode: pending.recreationMode || '', aspectRatioMode: pending.aspectRatioMode || ''
        });
      }
      let uploaded = null;
      let recreationMode = '';
      let aspectRatioMode = '';
      let sourceAsset = null;
      if (args.sourceImageId) {
        if (!context.sessionId) throw failure('SESSION_REQUIRED', '复刻任务缺少当前会话');
        const listed = await repository?.listConversation?.(context.sessionId, { includePending: true, includeDeleted: false });
        const references = Array.isArray(listed) ? listed : listed?.items;
        const sourceReference = Array.isArray(references) ? references.find(item => text(item?.imageId || item?.id) === args.sourceImageId && !item?.deleted) : null;
        if (!sourceReference) throw failure('IMAGE_SCOPE', '参考原图不在当前会话中');
        sourceAsset = images?.get?.(args.sourceImageId) || {};
        const canUseReference = Boolean(profile?.bindings?.sourceImage && (!profile.capabilities || profile.capabilities.img2img === true || profile.capabilities.controlImage === true));
        if (canUseReference) {
          if (typeof repository?.getOriginalBytes !== 'function' || typeof comfy?.uploadImage !== 'function') throw failure('IMAGE_UPLOAD_UNAVAILABLE', '当前环境无法向 ComfyUI 上传参考原图');
          const bytes = await repository.getOriginalBytes(args.sourceImageId);
          guardSignal(context);
          if (!bytes?.length) throw failure('IMAGE_DATA_UNAVAILABLE', '无法读取参考原图内容');
          uploaded = await comfy.uploadImage({ bytes, filename: text(sourceAsset.filename || sourceAsset.displayName, `${args.sourceImageId}.png`), type: text(sourceAsset.mime, 'image/png') }, context.signal);
          guardSignal(context);
          recreationMode = 'reference_image';
        } else recreationMode = 'text_approximation';
      }
      let submitted = null;
      const parameters = { width: settings.width, height: settings.height, steps: settings.steps, cfg: settings.cfg, seed: settings.seed, sampler: settings.sampler, scheduler: settings.scheduler, batchCount: args.batchCount || settings.batchCount };
      if (args.sourceImageId) {
        const followSource = getSettings()?.generation?.followSourceAspectRatio !== false;
        const writable = followSource && hasWritableDimensionBindings(settings.workflow, profile?.bindings, profile?.overrides);
        const fitted = writable ? fitDimensionsToAspectRatio({ sourceWidth: sourceAsset?.width, sourceHeight: sourceAsset?.height, baseWidth: settings.width, baseHeight: settings.height, step: 64 }) : null;
        if (fitted) {
          parameters.width = fitted.width;
          parameters.height = fitted.height;
          aspectRatioMode = 'source_matched';
        } else aspectRatioMode = 'workflow_fixed';
      }
      if (uploaded && profile?.bindings?.denoise && args.denoise !== undefined) parameters.denoise = args.denoise;
      if (uploaded && profile?.bindings?.controlStrength && args.controlStrength !== undefined) parameters.controlStrength = args.controlStrength;
      const raw = await comfy.render({ prompt: args.positiveTags.join(', '), negative: negative.join(', '), ...parameters, ...(uploaded ? { sourceImage: uploaded } : {}), workflow: settings.workflow, signal: context.signal, onSubmitted: value => { submitted = clone(value || {}); if (!context.signal?.aborted) context.onEvent?.({ type: 'comfy.submitted', promptId: text(value?.promptId), base: settings.base, workflowProfileId: text(profile?.id), workflowRevision: profile?.updatedAt ? String(profile.updatedAt) : '', recreationMode, aspectRatioMode, workflowHash: text(value?.workflowHash), changedBindings: Array.isArray(value?.changedBindings) ? value.changedBindings.slice() : [], parameters: object(value?.parameters) ? clone(value.parameters) : {} }); }, onProgress: value => { if (!context.signal?.aborted) context.onEvent?.({ type: 'progress', tool: 'comfy.render', queue: typeof value === 'number' ? value : undefined }); } });
      guardSignal(context);
      return renderedImages(raw, context, {
        prompt: args.positiveTags.join(', '), negative: negative.join(', '), positiveTags: args.positiveTags.slice(), negativeTags: negative.slice(),
        parameters: { ...parameters, ...(object(submitted?.parameters) ? submitted.parameters : {}) },
        workflowProfileId: text(profile?.id), workflowRevision: profile?.updatedAt ? String(profile.updatedAt) : '',
        workflowHash: text(submitted?.workflowHash || raw?.workflowHash),
        changedBindings: Array.isArray(submitted?.changedBindings || raw?.changedBindings) ? (submitted?.changedBindings || raw.changedBindings).slice() : [],
        recreationMode,
        aspectRatioMode
      });
    },
    'generation.execute': async (args, context) => {
      const generation = getGeneration();
      if (typeof generation?.execute !== 'function') throw failure('GENERATION_UNAVAILABLE', '自动生成任务模块不可用');
      context.extendRootTimeout?.(getSettings()?.generation?.jobTimeoutMs || 1200000);
      const value = await generation.execute(context.caller === 'primary' ? { ...args, agentControlled: true } : args, context);
      return typeof generation.publicResult === 'function' ? generation.publicResult(value?.jobId) : value;
    },
    'generation.review': async (args, context) => {
      const { generation } = await scopedJob(args.jobId, context);
      context.onEvent?.({ type: 'candidate.comparing', stage: 'compare', candidateId: args.candidateId, summary: '正在对照原图和候选图' });
      await generation.review(args, context);
      const value = generation.publicResult(args.jobId);
      const candidate = value?.candidates?.find(row => row.candidateId === args.candidateId);
      context.onEvent?.({ type: 'candidate.diff', stage: 'compare', candidateId: args.candidateId, summary: candidate?.summary || '对照完成', details: { issues: candidate?.issues || [], score: candidate?.score ?? null } });
      return value;
    },
    'generation.comment': async (args, context) => {
      const { generation } = await scopedJob(args.jobId, context);
      generation.comment(args, context);
      return generation.publicResult(args.jobId);
    },
    'generation.select': async (args, context) => {
      const { generation, job } = await scopedJob(args.jobId, context);
      if (!job.candidates.some(row => row.id === args.candidateId || row.imageId === args.candidateId)) throw failure('CANDIDATE_NOT_FOUND', '没有找到候选图');
      await generation.selectAndFinish(args.jobId, args.candidateId, 'primary');
      return generation.publicResult(args.jobId);
    },
    'generation.resume': async (args, context) => {
      const generation = getGeneration();
      if (typeof generation?.resume !== 'function') throw failure('GENERATION_UNAVAILABLE', '自动生成任务模块不可用');
      context.extendRootTimeout?.(getSettings()?.generation?.jobTimeoutMs || 1200000);
      const value = await generation.resume(args, context);
      return typeof generation.publicResult === 'function' ? generation.publicResult(value?.jobId) : value;
    }
  };
  const resolve = value => { const name = NATIVE_NAMES.get(value) || value; return TOOL_NAMES.includes(name) ? { name, ...clone(DEFINITIONS[name]), handler: handlers[name] } : null; };
  const list = () => TOOL_NAMES.map(name => ({ name, ...clone(DEFINITIONS[name]) }));
  const listPrimary = () => PRIMARY_TOOL_NAMES.filter(name => name !== 'comfy.status' || getSettings()?.comfy?.enabled !== false).map(name => {
    const entry = { name, ...clone(DEFINITIONS[name]) };
    if (name === 'agent.generateTags') { entry.parameters = clone(minimalGenerateParameters); entry.description = '文生图：传关键要求和可选参考图。修改：传上一版完整 Tag 和本轮 changes，工具返回合并后的 Tag。不要传蓝图、历史评价或完整角色资料。'; }
    if (name === 'generation.execute') { entry.parameters.required = []; entry.description = '创建任务：普通文生图传已准备好的 positiveTags；如果已通过 characters.search 确认 characterIds，也可以省略 positiveTags，让程序把原始要求与角色身份 Tag 交给文生图子代理后再首轮出图。复刻任务可传目标 sourceImageId。outputType=tags 时只保存并交付 Tag。'; }
    if (name === 'generation.resume') entry.description = '沿用原 jobId、原图和候选。继续修改时传 action=continue、baseCandidateId 和新 positiveTags；候选解析任务先根据候选信息选择 baseCandidateId；暂停的连接或角色选择仍用原任务恢复。不会自动重新识图。';
    if (getSettings()?.generateNegativeTags !== true && ['agent.generateTags', 'generation.execute', 'generation.resume'].includes(name)) delete entry.parameters.properties.negativeTags;
    if (getSettings()?.comfy?.enabled === false && name === 'generation.execute') {
      entry.parameters.properties.outputType.enum = ['tags'];
      entry.description = '生成 Tag 与提示词，outputType 必须为 tags。支持角色与参考图；当前绘图关闭，生成 Tag 后直接完成，不需要 ComfyUI 或工作流。';
    }
    return entry;
  });
  async function call(name, args = {}, context = {}) {
    const entry = resolve(name); if (!entry) return resultError({ code: 'TOOL_UNAVAILABLE', message: `工具不可用：${name}` }, context.requestId);
    try {
      check(entry.parameters, args, 'INVALID_INPUT'); guardSignal(context);
      const value = await entry.handler(clone(args), context); const data = unwrap(value); check(entry.outputSchema, data, 'OUTPUT_INVALID');
      return resultOk(data, value?.requestId || context.requestId, value?.usage);
    } catch (error) { return resultError(error, context.requestId); }
  }
  return Object.freeze({ names: () => TOOL_NAMES.slice(), primaryNames: () => listPrimary().map(item => item.name), list, listPrimary, schemas: list, openAiTools: () => listPrimary().map(item => ({ type: 'function', function: { name: item.name.replace('.', '_'), description: item.description, parameters: item.parameters } })), resolve, call, has: name => Boolean(resolve(name)) });
}

module.exports = { TOOL_NAMES, PRIMARY_TOOL_NAMES, DEFINITIONS, createPrimaryTools };
