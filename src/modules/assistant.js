'use strict';

const { randomUUID } = require('node:crypto');
const { createComfy } = require('./comfy');
const { createComfyProfiles } = require('./comfy-profiles');
const { createImageRepository } = require('./image-repository');
const { parsePngMetadata } = require('./images');
const { createVisionTempStore } = require('./vision-temp-store');
const { createAgentRuntime, isNoiseEvent } = require('./agent-runtime');
const { createFixedSubagents } = require('./fixed-subagents');
const { createPrimaryTools } = require('./primary-tools');
const { createVisionService } = require('./vision-service');
const { createPrompts } = require('./prompts');
const { createSettings } = require('./settings');
const { createAiClient, parseReply } = require('./ai-client');
const { createPrimaryAgent, publicRequestConfig } = require('./primary-agent');
const { errorShape, resultError } = require('./error-manager');
const { createCallMonitor } = require('./call-monitor');
const { createGenerationOrchestrator } = require('./generation-orchestrator');
const { routeTask, isGenerationFeedback } = require('./task-router');
const { candidateOptions, resolveFeedbackTarget } = require('./feedback-target');

const SESSION_FORMAT = 'ai-tag-sessions';
const SESSION_VERSION = 1;
const VISION_MODEL_HINT = /vision|[-_]?vl(?:[-_]|$)|gpt-4o|gpt-4\.1|qwen.*vl|llava|moondream|internvl|minicpm[-_]?v|pixtral|gemma.*vision|gemini|claude-3|claude.*sonnet|glm-4v|qvq|deepseek.*(?:vision|vl)|kimi.*vision/i;
const TEXT_ONLY_MODEL_HINT = /deepseek-(?:chat|reasoner|v[23](?:\.\d+)?)(?:$|[-_:])|deepseek-v4-(?:flash|pro)(?![-_]vision)(?:$|[-_:])|gpt-3\.5|text-embedding|(?:^|\/)qwen(?:2(?:\.5)?|3)(?:$|[-_:])|(?:^|\/)llama3(?:$|[-_:])/i;
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value, fallback = '') { const output = value == null ? '' : String(value).trim(); return output || fallback; }
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function id(prefix) { return `${prefix}_${randomUUID()}`; }
function array(value) { return Array.isArray(value) ? value : []; }
function ids(value) { return [...new Set(array(value).filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()))]; }
function candidateIdSet(value) { return new Set(array(value?.candidates).map(candidate => text(candidate?.id || candidate?.candidateId)).filter(Boolean)); }
function generationDelta(value, previousCandidateIds) {
  if (!(previousCandidateIds instanceof Set)) return clone(value);
  const candidates = array(value?.candidates).filter(candidate => !previousCandidateIds.has(text(candidate?.id || candidate?.candidateId)));
  const candidateIds = new Set(candidates.map(candidate => text(candidate?.id || candidate?.candidateId)).filter(Boolean));
  const imageIds = ids(candidates.map(candidate => candidate?.imageId || candidate?.artifact?.imageId || candidate?.artifact?.id));
  const imageIdSet = new Set(imageIds);
  const rounds = array(value?.rounds).flatMap(round => {
    const candidateIdsInRound = ids(round?.candidateIds).filter(candidateId => candidateIds.has(candidateId));
    return candidateIdsInRound.length ? [{ ...clone(round), candidateIds: candidateIdsInRound }] : [];
  });
  const artifacts = array(value?.artifacts).filter(artifact => imageIdSet.has(text(artifact?.imageId || artifact?.id))).map(clone);
  return { ...clone(value), candidates: clone(candidates), rounds, artifacts, imageIds };
}
function observe(callback, ...values) { try { callback?.(...values); } catch { /* UI observers are optional. */ } }
function failure(code, message, requestId, sessionId) { return { ...resultError({ code, message }, requestId), status: code === 'CANCELLED' ? 'cancelled' : 'error', text: message, sessionId }; }
function transcript(value) {
  const result = [];
  for (const row of array(value)) {
    if (!object(row)) continue;
    if (row.role === 'assistant') {
      const item = { role: 'assistant', content: typeof row.content === 'string' ? row.content : '' };
      if (typeof row.reasoning_content === 'string') item.reasoning_content = row.reasoning_content;
      else if (typeof row.reasoning === 'string') item.reasoning_content = row.reasoning;
      const calls = array(row.tool_calls).filter(call => text(call?.id) && text(call?.function?.name) && typeof call?.function?.arguments === 'string');
      if (calls.length) item.tool_calls = calls.map(call => ({ id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments } }));
      if (item.content || item.tool_calls) result.push(item);
    } else if (row.role === 'tool' && text(row.tool_call_id)) result.push({ role: 'tool', tool_call_id: row.tool_call_id, content: typeof row.content === 'string' ? row.content : JSON.stringify(row.content ?? null) });
  }
  return result;
}

// 任务事件只记录关键信息（轮次、工具调用、子代理、候选结果等）；
// 噪音分类统一来自 agent-runtime.isNoiseEvent（单一来源），此处直接复用，避免多份逻辑漂移。

function createAssistant(options = {}) {
  const storage = options.storage;
  const images = options.images || null;
  const tags = options.tags || null;
  const prompts = options.promptSource || options.prompts || createPrompts({ storage, dir: options.promptDir });
  const initialPrimary = options.primaryApi || options.ai?.config || options.ai || {};
  const settings = createSettings({ storage, initial: { primaryApi: publicRequestConfig(initialPrimary), visionApi: options.visionApi || {}, ...(object(options.settings) ? options.settings : {}) } });
  const comfyProfiles = createComfyProfiles({ storage, initial: settings.snapshot() });
  const state = { sessions: [], currentId: '', busy: false, status: 'idle', jobId: '', lastError: '' };
  let active = null;
  let runtime;
  let primaryTools;
  let generation;
  let imageRepository;
  let destroyed = false;
  function executionSettings() {
    const value = settings.snapshot();
    const ready = capabilities?.comfy;
    value.comfy.enabled = value.comfy.enabled && ready?.connected === true && ready?.workflowReady === true;
    return value;
  }
  function read(key, fallback) { try { return storage?.get ? storage.get(key, fallback) : storage?.load?.(key, fallback) ?? fallback; } catch { return fallback; } }
  function write(key, value) { if (storage?.set) storage.set(key, clone(value)); else storage?.save?.(key, clone(value)); }
  function sessionById(sessionId = state.currentId) { return state.sessions.find(session => session.id === sessionId) || null; }
  function sessionBundle() { return { format: SESSION_FORMAT, version: SESSION_VERSION, currentId: state.currentId, sessions: clone(state.sessions) }; }
  let persistTimer = null;
  function persist() {
    clearTimeout(persistTimer); persistTimer = null;
    write('sessions', sessionBundle());
  }
  function schedulePersist() {
    if (persistTimer) return;
    persistTimer = setTimeout(persist, 250);
  }
  function flushPersist() {
    persist();
    return typeof storage?.flush === 'function' ? storage.flush() : Promise.resolve();
  }
  function normalizeSession(raw, usedSessions, usedMessages) {
    const unique = (value, prefix, used) => { let key = text(value, id(prefix)); while (used.has(key)) key = id(prefix); used.add(key); return key; };
    const sessionId = unique(raw.id, 'session', usedSessions);
    return {
      id: sessionId, title: text(raw.title, '新对话'), createdAt: Number(raw.createdAt) || Date.now(), updatedAt: Number(raw.updatedAt) || Date.now(),
      messages: array(raw.messages).filter(row => object(row) && ['user', 'assistant', 'error'].includes(row.role)).map(row => {
        const events = clone(array(row.events));
        if (!events.length && Array.isArray(row.activity)) events.push(...clone(row.activity));
        return {
          id: unique(row.id, 'message', usedMessages), role: row.role, text: typeof row.text === 'string' ? row.text : '',
          reasoning: typeof row.reasoning === 'string' ? row.reasoning : '', imageIds: ids(row.imageIds),
          toolCalls: clone(array(row.toolCalls)), transcript: transcript(row.transcript), artifacts: clone(array(row.artifacts)), events,
          result: object(row.result) ? clone(row.result) : null, status: row.status === 'streaming' ? 'cancelled' : text(row.status, 'done'), createdAt: Number(row.createdAt) || Date.now()
        };
      })
    };
  }
  function incomingBundle(value) {
    let parsed = value;
    try { if (typeof parsed === 'string') parsed = JSON.parse(parsed); } catch { return null; }
    return object(parsed) && parsed.format === SESSION_FORMAT && parsed.version === SESSION_VERSION && Array.isArray(parsed.sessions) && parsed.sessions.every(object) ? parsed : null;
  }
  const saved = incomingBundle(read('sessions', null));
  if (saved) {
    const usedSessions = new Set(); const usedMessages = new Set();
    state.sessions = saved.sessions.map(row => normalizeSession(row, usedSessions, usedMessages));
    state.currentId = state.sessions.some(row => row.id === saved.currentId) ? saved.currentId : state.sessions[0]?.id || '';
  }
  const visionTempStore = options.visionTempStore || createVisionTempStore({ images, authorizeReference: reference => imageRepository?.authorizeVisionReference?.(reference) || null });
  imageRepository = options.imageRepository || createImageRepository({ images, storage, sessions: () => state.sessions, saveSessions: persist, currentSessionId: () => state.currentId, onReferenceRemoved: reference => visionTempStore.invalidateReference?.(reference) });
  visionTempStore.setAuthorizer?.(reference => imageRepository.authorizeVisionReference?.(reference) || null);
  function newSession(title = '新对话') {
    cancel();
    const session = { id: id('session'), title: text(title, '新对话'), messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    state.sessions.unshift(session); state.currentId = session.id; persist(); return clone(session);
  }
  function currentSession() { if (!sessionById()) newSession(); return sessionById(); }
  if (!state.sessions.length) newSession();

  const callMonitor = createCallMonitor({ filePath: options.callMonitorPath, getSecrets: () => [settings.primaryProfile().key, settings.visionProfile().key] });
  const ai = createAiClient(settings.primaryProfile(), options.primaryGateway || (options.ai?.complete || options.ai?.stream ? options.ai : null), callMonitor);
  const visionAi = createAiClient(settings.visionProfile(), options.visionGateway, callMonitor);
  function visionConfig() {
    const profile = settings.visionProfile();
    const imageCapable = VISION_MODEL_HINT.test(profile.model) || !TEXT_ONLY_MODEL_HINT.test(profile.model);
    return { ...profile, configured: Boolean(profile.base && profile.model && imageCapable), imageCapable, error: !profile.base || !profile.model ? '请先配置识图 API 地址和模型' : !imageCapable ? '当前识图模型不支持图片输入，请选择视觉模型或配置独立识图 API' : '' };
  }
  const visionClient = Object.freeze({
    async complete(messages, config = {}) {
      const profile = visionConfig();
      if (!profile.imageCapable && array(messages).some(message => array(message.content).some(part => part?.type === 'image_url'))) return failure('VISION_MODEL_NOT_SUPPORTED', profile.error);
      return visionAi.complete(messages, { ...profile, ...config });
    },
    getConfig: visionConfig
  });
  async function resolveImage(imageId, context = {}) {
    if (context.sessionId && context.sessionId !== state.currentId) return null;
    const reference = { imageId, sessionId: context.sessionId || state.currentId, ...(context.refId ? { refId: context.refId } : {}) };
    const image = visionTempStore.resolveForVision(reference);
    if (!image) return null;
    const url = [image.dataUrl, image.url].find(value => typeof value === 'string' && /^(?:data:image\/|https?:\/\/)/i.test(value));
    if (url) return { ...image, dataUrl: url };
    const bytes = await visionTempStore.getBytes(reference);
    if (!bytes || context.signal?.aborted) return null;
    const mime = /^image\//i.test(image.mime || '') ? image.mime : 'image/png';
    return { ...image, dataUrl: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}` };
  }
  const comfy = options.comfy && typeof options.comfy.render === 'function' ? options.comfy : createComfy({ ...(options.comfyOptions || {}), profiles: comfyProfiles });
  const visionService = options.visionService || createVisionService({ images, visionTempStore, localVision: options.localVision || options.vision, visionAI: visionClient, parseMetadata: parsePngMetadata, getPrompt: key => prompts.getEffective?.(key) || prompts.get?.(key) || '' });
  const primary = createPrimaryAgent({ client: ai, prompts, resolveImage, getSettings: executionSettings, charactersEnabled: Boolean(options.characters), favoritesEnabled: Boolean(options.favorites) });
  const subagents = createFixedSubagents({ vision: visionService, translation: options.translation, ai, visionAI: visionClient, prompts, resolveImage, getSettings: settings.snapshot });
  runtime = createAgentRuntime({ primaryClient: primary, subagents, tools: () => primaryTools, getSettings: executionSettings, getPrimaryPrompt: primary.getPrompt, monitor: callMonitor });
  primaryTools = createPrimaryTools({ storage, tags, favorites: options.favorites, characters: options.characters, images, imageRepository, runtime, comfy, comfyProfiles, generation: () => generation, getSettings: executionSettings, resolveFeedbackTarget: resolveFeedbackChoice });
  const internalTool = async (name, args, context) => {
    const outcome = await runtime.callTool(name, args, { parentRequestId: context.requestId, signal: context.signal, sessionId: context.sessionId, messageId: context.messageId, onEvent: context.onEvent });
    if (outcome?.ok === false) throw Object.assign(new Error(outcome.error?.message || '内部工具调用失败'), { code: outcome.error?.code || 'TOOL_FAILED', retryable: outcome.error?.retryable === true });
    return outcome.data;
  };
  generation = options.generation || createGenerationOrchestrator({
    storage,
    runSubAgent: runtime.runSubAgent,
    renderCandidate: (input, context) => internalTool('comfy.render', {
      positiveTags: input.positiveTags,
      negativeTags: input.negativeTags,
      batchCount: input.batchCount,
      ...(input.pendingRender ? { pendingRender: input.pendingRender } : {}),
      ...(input.sourceImageId ? { sourceImageId: input.sourceImageId } : {})
    }, context),
    cancelRender: () => comfy?.cancel?.('current'),
    preflight: async (input, context) => {
      const value = await internalTool('comfy.status', {}, context);
      if (!value.connected || (!input.pendingRender && !value.workflowReady)) settings.setForm({ comfyOn: false });
      const profile = comfyProfiles.active();
      const referenceReady = Boolean(profile?.bindings?.sourceImage && (profile?.capabilities?.img2img === true || profile?.capabilities?.controlImage === true));
      return { ready: input.pendingRender ? value.enabled && value.connected : value.render === true, connected: value.connected === true, error: value.error || '', workflowProfileId: profile?.id || '', workflowRevision: profile?.updatedAt ? String(profile.updatedAt) : '', recreationMode: input.mode === 'recreate' ? (referenceReady ? 'reference_image' : 'text_approximation') : '' };
    },
    listConversationImages: sessionId => imageRepository.listConversation(sessionId, { includePending: true, includeDeleted: false }),
    resolveCharacter: (value, context) => {
      if (!options.characters) return null;
      const includeAdult = tags?.stateSnapshot?.().includeAdult === true;
      if (context.mode === 'id') return options.characters.get?.(value, { includeAdult }) || null;
      return options.characters.page?.({ query: value, includeAdult, precision: 'standard', limit: 10 }) || null;
    },
    getSettings: executionSettings,
    getPromptSnapshot: prompts.snapshot
  });

  function append(role, value, extra = {}, sessionId = state.currentId) {
    const session = sessionById(sessionId); if (!session) return null;
    const message = { id: id('message'), role: ['user', 'assistant', 'error'].includes(role) ? role : 'user', text: typeof value === 'string' ? value : '', reasoning: '', imageIds: ids(extra.imageIds), toolCalls: [], transcript: [], artifacts: [], events: [], result: null, status: text(extra.status, 'done'), createdAt: Date.now() };
    session.messages.push(message); session.updatedAt = Date.now(); persist(); return clone(message);
  }
  function writable(job) { return !destroyed && active === job && !job.invalidated && sessionById(job.sessionId) === job.session && job.session.messages.includes(job.live); }
  function cancelledPayload(job) { return { text: job.live.text, reasoning: job.live.reasoning, toolCalls: clone(job.live.toolCalls), transcript: clone(job.live.transcript), artifacts: clone(job.live.artifacts), imageIds: job.live.imageIds.slice(), events: clone(job.live.events) }; }
  function applyPayload(job, payload = {}) {
    const live = job.live;
    if (typeof payload.text === 'string') {
      // 保留各轮之间的进度汇报文本：live.text 已累积本轮全部流式增量，
      // 只有当最终文本未被包含在累积文本中时才追加，避免重复或覆盖掉过程汇报。
      if (!live.text) live.text = payload.text;
      else if (payload.text && live.text.trim() !== payload.text.trim() && !live.text.trim().endsWith(payload.text.trim())) live.text = live.text.trim() + '\n\n' + payload.text.trim();
    }
    if (typeof payload.reasoning === 'string') live.reasoning = payload.reasoning;
    if (Array.isArray(payload.toolCalls)) live.toolCalls = clone(payload.toolCalls);
    if (Array.isArray(payload.transcript)) live.transcript = transcript(payload.transcript);
    if (Array.isArray(payload.artifacts)) live.artifacts = clone(payload.artifacts);
    live.imageIds = ids([...live.imageIds, ...array(payload.imageIds), ...live.artifacts.map(item => item.imageId || item.id)]);
    if (Array.isArray(payload.events)) live.events = clone(payload.events).filter(event => !isNoiseEvent(event));
  }
  function hydrateGenerationPayload(payload = {}) {
    if (payload.needsInput?.kind === 'candidate') return clone(payload);
    const jobId = text(payload?.jobId);
    const local = jobId ? (generation?.uiSnapshot?.(jobId) || generation?.get?.(jobId)) : null;
    return local ? { ...clone(payload), ...clone(local) } : clone(payload);
  }
  function cancel(requestId) {
    if (!active || (requestId && active.id !== requestId)) return false;
    if (active.live.status !== 'streaming') return false;
    const job = active;
    job.live.status = 'cancelled';
    job.live.result = { ok: false, error: { code: 'CANCELLED', message: '请求已取消' }, ...cancelledPayload(job) };
    job.session.updatedAt = Date.now(); persist();
    job.invalidated = true; active = null;
    state.busy = false; state.status = 'cancelled'; state.jobId = '';
    const reason = Object.assign(new Error('请求已取消'), { code: 'CANCELLED' });
    job.controller.abort(reason); runtime?.cancel?.(job.id);
    return true;
  }
  function history(session) {
    const result = [];
    for (const message of session.messages) {
      if (message.role === 'user') result.push({ role: 'user', content: [message.text, message.imageIds.length ? `Attached imageIds: ${message.imageIds.join(', ')}` : ''].filter(Boolean).join('\n\n') });
      else if (message.transcript?.length) result.push(...transcript(message.transcript));
      else if (message.role === 'assistant' && message.text && message.status === 'done') {
        const item = { role: 'assistant', content: message.text };
        if (message.reasoning) item.reasoning_content = message.reasoning;
        result.push(item);
      }
    }
    return result;
  }
  function generationTargets(session) {
    const seen = new Set(), targets = [];
    for (const message of session.messages.slice().reverse()) {
      const jobId = text(message.result?.jobId);
      if (!jobId || seen.has(jobId)) continue;
      seen.add(jobId);
      const job = generation.get?.(jobId);
      if (job && job.sessionId === session.id && ['completed', 'awaiting_feedback'].includes(job.status)) targets.push({ messageId: message.id, job });
    }
    return targets;
  }
  function feedbackTarget(session, input) {
    if (!isGenerationFeedback(input)) return null;
    const targets = generationTargets(session);
    if (!targets.length) return null;
    const refs = imageRepository.listConversation(session.id).items;
    const options = candidateOptions(targets, refs);
    if (input.imageIds.length && !options.some(option => input.imageIds.includes(option.imageId))) return null;
    if (!options.length && targets[0].job.outputType === 'tags') return { ...targets[0], candidateId: '' };
    const resolution = resolveFeedbackTarget(input, options, targets[0].job.jobId);
    return resolution.option ? { ...targets.find(target => target.job.jobId === resolution.option.jobId), candidateId: resolution.option.candidateId }
      : resolution.options.length ? { resolveWithPrimary: true, options: resolution.options } : null;
  }
  function candidateQuestion(request, question, locale) {
    const message = text(question, locale === 'en-US' ? 'Which image should I refine?' : '要继续修改哪张候选图？');
    return { status: 'needs_input', needsInput: { kind: 'candidate', message, feedback: request.feedback, options: clone(request.options) } };
  }
  function checkedFeedbackOption(request, imageId, sessionId) {
    const option = array(request?.options).find(item => item.imageId === imageId);
    const job = option && generation.get(option.jobId);
    if (!option || !job || job.sessionId !== sessionId || !['completed', 'awaiting_feedback'].includes(job.status)) return null;
    const candidate = array(job.candidates).find(item => item.id === option.candidateId && item.imageId === option.imageId);
    if (!candidate || !imageRepository.listConversation(sessionId).items.some(ref => ref.imageId === option.imageId)) return null;
    return { option, job, candidate };
  }
  function resolveFeedbackChoice(input, context) {
    const request = context.feedbackRequest;
    if (!request || context.sessionId !== state.currentId) throw Object.assign(new Error('没有待确认的修改任务'), { code: 'INPUT_EXPIRED' });
    if (context.signal?.aborted) throw context.signal.reason;
    const target = input.action === 'select' && checkedFeedbackOption(request, input.imageId, context.sessionId);
    if (!target) return candidateQuestion(request, input.action === 'ask' ? input.question : '', context.locale);
    const { job, candidate } = target;
    const feedback = job.agentControlled ? generation.beginFeedback(job.jobId, candidate.id, request.feedback, context) : {
      jobId: job.jobId, baseCandidateId: candidate.id, originalRequirements: job.originalRequirements, feedback: request.feedback,
      positiveTags: candidate.positiveTags, negativeTags: candidate.negativeTags, outputType: job.outputType, viewImageIds: [candidate.imageId]
    };
    return { ...feedback, targetResolved: true, status: 'awaiting_feedback', decisionRequired: true, agentControlled: job.agentControlled === true };
  }
  async function runPrimaryWithRuntime(value, config = {}) {
    const input = typeof value === 'string' ? { text: value } : object(value) ? value : {};
    if (destroyed) return failure('ASSISTANT_CLOSED', '会话服务已关闭');
    if (active) return failure('BUSY', '当前请求仍在处理中', active.id, active.sessionId);
    const session = input.sessionId ? sessionById(input.sessionId) : currentSession();
    if (!session || session.id !== state.currentId) return failure('SESSION_UNAVAILABLE', '当前会话不可用', input.requestId, input.sessionId);
    const body = typeof input.text === 'string' ? input.text.trim() : '';
    const imageIds = ids(input.imageIds);
    if (!body && !imageIds.length) return failure('EMPTY_INPUT', '请输入内容或添加图片', input.requestId, session.id);
    if (input.signal?.aborted) return failure('CANCELLED', '请求已取消', input.requestId, session.id);
    const target = input.feedbackJobId
      ? { job: generation.get(input.feedbackJobId), candidateId: input.baseCandidateId }
      : feedbackTarget(session, { text: body, imageIds });
    const targetResolution = target?.resolveWithPrimary === true;
    const feedbackRequest = targetResolution ? { feedback: body, options: clone(target.options) } : null;
    const previousCandidates = new Map((targetResolution ? generationTargets(session) : target?.job ? [target] : []).map(item => [item.job.jobId, candidateIdSet(item.job)]));
    const visibleGeneration = payload => generationDelta(payload, previousCandidates.get(payload?.jobId));
    if (target && !targetResolution && !target.job?.agentControlled) return continueGeneration(target.messageId, target.candidateId, body, { ...input, onEvent: event => { observe(input.onEvent, event); observe(input.onToolEvent, event); } }, session.id);
    let feedbackContext = null;
    if (target?.job?.agentControlled && !targetResolution) {
      try { feedbackContext = generation.beginFeedback(target.job.jobId, target.candidateId, body, { sessionId: session.id }); }
      catch (error) { return failure(error.code, error.message); }
    }
    const requestId = text(input.requestId, id('primary'));
    const userId = id('message');
    const references = [];
    for (const imageId of imageIds) {
      const reference = imageRepository.attachToConversation(session.id, imageId, { source: 'upload', messageId: userId, sent: true, pending: false });
      if (!reference) return failure('IMAGE_NOT_FOUND', `无法读取附图：${imageId}`, requestId, session.id);
      references.push(reference);
    }
    if (references.length) imageRepository.markSent(session.id, references.map(row => row.refId));
    const previous = history(session);
    const user = { id: userId, role: 'user', text: text(input.displayText, body), imageIds, reasoning: '', toolCalls: [], transcript: [], artifacts: [], events: [], result: null, status: 'done', createdAt: Date.now() };
    session.messages.push(user);
    const liveSnapshot = append('assistant', '', { status: 'streaming' }, session.id);
    const live = session.messages.find(message => message.id === liveSnapshot.id);
    const controller = new AbortController();
    const job = { id: requestId, sessionId: session.id, session, live, controller, invalidated: false };
    active = job; state.busy = true; state.status = 'running'; state.jobId = requestId; state.lastError = '';
    const callerAbort = () => cancel(requestId);
    input.signal?.addEventListener?.('abort', callerAbort, { once: true });
    const resolutionContext = targetResolution ? `待确定的修改目标（编号是当前会话图号；仅在证据明确时选择）：${JSON.stringify(feedbackRequest.options)}` : '';
    const current = { role: 'user', imageIds: feedbackContext?.viewImageIds || imageIds, content: [body || '请查看附图。', references.length ? `Attached imageIds: ${references.map(row => row.imageId).join(', ')}` : '', feedbackContext ? '当前修改任务（保留原目标与未提及内容）：' + JSON.stringify(feedbackContext) : '', resolutionContext].filter(Boolean).join('\n\n') };
    observe(input.onStart, { user: clone(user), assistant: clone(live), requestId, sessionId: session.id });
    const onEvent = event => {
      if (!writable(job)) return;
      if (isNoiseEvent(event)) return; // 流式增量不写入任务事件，避免刷满 256 条上限。
      live.events.push(clone(event)); if (live.events.length > 256) live.events.shift();
      if (event?.jobId && (typeof generation?.uiSnapshot === 'function' || typeof generation?.get === 'function')) {
        const generationState = generation.uiSnapshot?.(event.jobId) || generation.get?.(event.jobId);
        if (generationState) {
          const visibleState = visibleGeneration(generationState);
          live.result = { ...(object(live.result) ? live.result : {}), ...visibleState };
          live.artifacts = clone(array(visibleState.artifacts));
          live.imageIds = ids(visibleState.imageIds);
        }
      }
      const output = event?.result?.data || event?.result;
      if (Array.isArray(output?.artifacts)) { for (const artifact of output.artifacts) if (!live.artifacts.some(item => item.imageId === artifact.imageId)) live.artifacts.push(clone(artifact)); live.imageIds = ids([...live.imageIds, ...live.artifacts.map(item => item.imageId)]); }
      schedulePersist(); observe(input.onEvent, clone(event)); observe(input.onToolEvent, clone(event));
    };
    try {
      const task = routeTask({ text: body, imageIds });
      if (feedbackContext) { task.intent = 'auto'; task.feedbackJobId = feedbackContext.jobId; task.baseCandidateId = feedbackContext.baseCandidateId; task.forbidImages ||= feedbackContext.outputType === 'tags'; }
      if (targetResolution) { task.intent = 'resolve_candidate'; task.originalRequest = body; task.forbidImages ||= routeTask({ text: body }).intent === 'compile_tags'; }
      const result = await runtime.runPrimary({ requestId, sessionId: session.id, messageId: live.id, locale: input.locale || read('app.locale', 'zh-CN'), task, feedbackRequest, generationContext: feedbackContext ? generation.publicResult(feedbackContext.jobId) : null, messages: [...previous, current], config: publicRequestConfig(config), signal: controller.signal,
        onDelta: (delta, reasoning = '') => { if (!writable(job)) return; if (typeof delta === 'string') live.text += delta; if (typeof reasoning === 'string') live.reasoning += reasoning; schedulePersist(); observe(input.onDelta, live.text, live.reasoning, clone(live)); },
        onEvent,
        onToolCall: traces => { if (!writable(job)) return; for (const trace of array(traces)) { const index = live.toolCalls.findIndex(row => row.id === trace.id); if (index < 0) live.toolCalls.push(clone(trace)); else live.toolCalls[index] = clone(trace); } schedulePersist(); }
      });
      if (!writable(job)) return { ...failure('CANCELLED', '请求已取消', requestId, session.id), data: cancelledPayload(job) };
      const publicPayload = object(result.data) ? result.data : object(result.partial) ? result.partial : {};
      const targetResolved = targetResolution && array(publicPayload.toolCalls).some(trace => trace?.result?.targetResolved === true && trace.ok);
      let payload = hydrateGenerationPayload(publicPayload);
      if (targetResolution && !targetResolved && result.ok) {
        payload = { ...publicPayload, ...candidateQuestion(feedbackRequest, publicPayload.needsInput?.message, input.locale || read('app.locale', 'zh-CN')) };
        live.text = payload.needsInput.message;
        payload.text = live.text;
      }
      const visiblePayload = visibleGeneration(payload);
      applyPayload(job, visiblePayload);
      const error = result.ok ? null : errorShape(result.error);
      live.status = result.ok ? 'done' : error.code === 'CANCELLED' ? 'cancelled' : error.code === 'TIMEOUT' ? 'timeout' : 'error';
      live.result = { ...clone(visiblePayload), ok: result.ok, error: error || visiblePayload.error || null, usage: clone(result.usage) };
      if (!live.text && error) live.text = error.message;
      session.updatedAt = Date.now(); state.lastError = error?.message || ''; state.status = result.ok ? 'idle' : live.status; await flushPersist(); observe(input.onDelta, live.text, live.reasoning, clone(live));
      return { ...result, ...payload, ok: result.ok, error, data: clone(payload), text: live.text, status: live.status, requestId, sessionId: session.id };
    } catch (cause) {
      if (!writable(job)) return { ...failure('CANCELLED', '请求已取消', requestId, session.id), data: cancelledPayload(job) };
      const error = errorShape(cause); live.status = error.code === 'CANCELLED' ? 'cancelled' : 'error'; if (!live.text) live.text = error.message;
      live.result = { ...cancelledPayload(job), ok: false, error }; state.lastError = error.message; state.status = live.status; await flushPersist();
      return { ...failure(error.code, error.message, requestId, session.id), data: cancelledPayload(job) };
    } finally {
      input.signal?.removeEventListener?.('abort', callerAbort);
      await storage?.flush?.();
      if (active === job) { active = null; state.busy = false; state.jobId = ''; }
    }
  }
  function messageLocation(value, sessionId = state.currentId) { const session = sessionById(sessionId); if (!session) return null; const index = typeof value === 'number' ? value : session.messages.findIndex(row => row.id === value); return index >= 0 && session.messages[index] ? { session, index, message: session.messages[index] } : null; }
  function editMessage(value, nextText, sessionId) { const found = messageLocation(value, sessionId); if (!found) return null; if (active?.sessionId === found.session.id) cancel(); found.message.text = typeof nextText === 'string' ? nextText : ''; found.message.transcript = []; found.session.updatedAt = Date.now(); persist(); return clone(found.message); }
  function deleteMessage(value, sessionId) { const found = messageLocation(value, sessionId); if (!found) return false; if (active?.sessionId === found.session.id) cancel(); found.session.messages.splice(found.index, 1); found.session.updatedAt = Date.now(); persist(); return true; }
  function chooseCandidate(value, candidateId, source = 'user', sessionId = state.currentId) {
    const found = messageLocation(value, sessionId);
    const jobId = text(found?.message?.result?.jobId);
    if (!found || !jobId) return null;
    const selected = generation?.selectCandidate?.(jobId, candidateId, source);
    if (!selected) return null;
    found.message.result = {
      ...found.message.result,
      ...clone(selected),
      finalCandidateId: selected.selectedCandidateId,
      finalImageId: selected.selectedImageId,
      finalPrompt: selected.prompt,
      finalNegative: selected.negative
    };
    found.message.artifacts = clone(array(selected.artifacts));
    found.message.imageIds = ids(selected.imageIds);
    found.session.updatedAt = Date.now();
    persist();
    return clone(found.message.result);
  }
  async function selectGenerationFinal(value, candidateId, sessionId = state.currentId) {
    const found = messageLocation(value, sessionId);
    const jobId = text(found?.message?.result?.jobId);
    if (!found || !jobId || typeof generation?.selectAndFinish !== 'function') return null;
    const selected = await generation.selectAndFinish(jobId, candidateId, 'user');
    if (!selected) return null;
    found.message.result = { ...found.message.result, ...clone(selected), finalCandidateId: selected.selectedCandidateId, finalImageId: selected.selectedImageId, finalPrompt: selected.prompt, finalNegative: selected.negative };
    found.message.artifacts = clone(array(selected.artifacts));
    found.message.imageIds = ids(selected.imageIds);
    found.session.updatedAt = Date.now();
    persist();
    return clone(found.message.result);
  }
  async function resumeWithJudgement(args, job, options, onEvent) {
    const resumed = await runtime.callTool('generation.resume', args, { requestId: job.id, sessionId: job.sessionId, messageId: job.live.id, locale: options.locale || read('app.locale', 'zh-CN'), signal: job.controller.signal, onEvent });
    if (!resumed.ok || !resumed.data?.agentControlled || !resumed.data.decisionRequired || !writable(job)) return { outcome: resumed, resumed };
    const current = resumed.data;
    const decision = await runtime.runPrimary({ requestId: id('primary'), sessionId: job.sessionId, messageId: job.live.id,
      locale: options.locale || read('app.locale', 'zh-CN'),
      task: { intent: 'auto', originalRequest: current.originalRequirements, feedbackJobId: current.jobId, forbidImages: current.outputType === 'tags' },
      generationContext: current,
      messages: [...history(job.session), { role: 'user', imageIds: current.viewImageIds || [], content: '继续原任务。确认信息或连接已恢复，请结合以下实际结果选择下一步；尚未出图时先准备确认后的 Tag：' + JSON.stringify(current) }],
      signal: job.controller.signal, onEvent,
      onDelta: (delta, reasoning = '') => { if (!writable(job)) return; job.live.text += delta || ''; job.live.reasoning += reasoning || ''; schedulePersist(); observe(options.onDelta, job.live.text, job.live.reasoning); }
    });
    const usage = { ...decision.usage, byKind: { ...decision.usage?.byKind } };
    for (const [key, value] of Object.entries(resumed.usage || {})) if (typeof value === 'number') usage[key] = value + (usage[key] || 0);
    for (const [key, value] of Object.entries(resumed.usage?.byKind || {})) usage.byKind[key] = value + (usage.byKind[key] || 0);
    return { outcome: { ...decision, data: { ...current, ...decision.data }, usage }, resumed };
  }
  async function continueGeneration(value, candidateId, feedback, options = {}, sessionId = state.currentId) {
    if (typeof options === 'string') { sessionId = options; options = {}; }
    if (destroyed) return failure('ASSISTANT_CLOSED', '会话服务已关闭');
    if (options.signal?.aborted) return failure('CANCELLED', '请求已取消');
    if (active) return failure('BUSY', '当前请求仍在处理中', active.id, active.sessionId);
    const found = messageLocation(value, sessionId);
    const jobId = text(found?.message?.result?.jobId);
    const resumeOnly = options.resumeOnly === true;
    const previousCandidateIds = jobId ? candidateIdSet(generation?.get?.(jobId)) : null;
    const note = resumeOnly ? '恢复原绘图任务' : text(feedback);
    const feedbackTask = routeTask({ text: note });
    const requestTags = !resumeOnly && (feedbackTask.forbidImages || feedbackTask.intent === 'compile_tags' || /只(?:要|需).*?(?:tags?|提示词|标签)/i.test(note));
    const tagsOnly = found?.message?.result?.outputType === 'tags';
    if (!found || !jobId || (!resumeOnly && ((!tagsOnly && !text(candidateId)) || !note))) return failure('INVALID_INPUT', '继续优化需要候选图和修改意见');
    if (found.session.id !== state.currentId) return failure('SESSION_UNAVAILABLE', '当前会话不可用');
    if (!resumeOnly && generation.get(jobId)?.agentControlled) {
      return runPrimaryWithRuntime({ ...options, sessionId, text: note, feedbackJobId: jobId, baseCandidateId: candidateId });
    }
    if (resumeOnly) {
      const current = generation.get(jobId);
      if (current?.status !== 'needs_input' || !['connection', 'workflow'].includes(current.needsInput?.kind) || current.stopReason === 'COMFY_SUBMISSION_UNKNOWN') return failure('INPUT_EXPIRED', '当前任务无法直接恢复，请按任务提示处理');
      if (!settings.snapshot().comfy.enabled) return failure('COMFY_DISABLED', '请先确认连接并开启绘图，再恢复原任务');
    }
    const session = found.session;
    const requestId = id('generation_resume');
    const user = append('user', text(options.displayText, note), { status: 'done' }, session.id);
    const liveSnapshot = append('assistant', '', { status: 'streaming' }, session.id);
    const live = session.messages.find(message => message.id === liveSnapshot.id);
    const controller = new AbortController();
    const job = { id: requestId, sessionId: session.id, session, live, controller, invalidated: false };
    active = job; state.busy = true; state.status = 'running'; state.jobId = requestId; state.lastError = '';
    const callerAbort = () => cancel(requestId);
    options.signal?.addEventListener?.('abort', callerAbort, { once: true });
    observe(options.onStart, { user: clone(user), assistant: clone(live), requestId, sessionId: session.id });
    const onEvent = event => {
      if (!writable(job) || isNoiseEvent(event)) return;
      live.events.push(clone(event)); if (live.events.length > 256) live.events.shift();
      const generationState = event?.jobId ? (generation?.uiSnapshot?.(event.jobId) || generation?.get?.(event.jobId)) : null;
      if (generationState) {
        const visibleState = generationDelta(generationState, previousCandidateIds);
        live.result = { ...(object(live.result) ? live.result : {}), ...visibleState };
        live.artifacts = clone(array(visibleState.artifacts));
        live.imageIds = ids(visibleState.imageIds);
      }
      schedulePersist(); observe(options.onEvent, clone(event));
    };
    try {
      const args = resumeOnly ? { jobId } : { jobId, action: 'continue', ...(candidateId ? { baseCandidateId: text(candidateId) } : {}), ...(requestTags ? { outputType: 'tags' } : {}), feedback: note, maxAutoRounds: 1, autoRun: false };
      const { outcome, resumed } = await resumeWithJudgement(args, job, options, onEvent);
      if (!writable(job)) return { ...failure('CANCELLED', '请求已取消', requestId, session.id), data: cancelledPayload(job) };
      const publicPayload = object(outcome.data) ? outcome.data : {};
      const payload = hydrateGenerationPayload(publicPayload);
      const visiblePayload = generationDelta(payload, previousCandidateIds);
      applyPayload(job, visiblePayload);
      const error = outcome.ok ? null : errorShape(outcome.error);
      live.status = outcome.ok ? 'done' : error.code === 'CANCELLED' ? 'cancelled' : 'error';
      live.result = { ...clone(visiblePayload), ok: outcome.ok, error: error || visiblePayload.error || null, usage: clone(outcome.usage) };
      live.toolCalls = [{ id: requestId, name: 'generation.resume', arguments: args, ok: outcome.ok, result: clone(resumed.data), error }, ...array(publicPayload.toolCalls)];
      live.transcript = [
        { role: 'assistant', content: '', tool_calls: [{ id: requestId, type: 'function', function: { name: 'generation_resume', arguments: JSON.stringify(args) } }] },
        { role: 'tool', tool_call_id: requestId, content: JSON.stringify(resumed.ok ? resumed.data : resumed.error) }, ...transcript(publicPayload.transcript)
      ];
      if (payload.stopReason === 'revision_failed') live.text = '本轮修改未通过校验，已保留原有 Tag 和候选图，请缩小修改范围后重试。';
      if (payload.stopReason === 'prompt_unchanged') live.text = '本轮没有产生有效的 Tag 改动，已保留原结果。';
      if (!live.text && error) live.text = error.message;
      session.updatedAt = Date.now(); state.status = outcome.ok ? 'idle' : live.status; state.lastError = error?.message || ''; await flushPersist();
      return { ...outcome, ...payload, data: clone(payload), text: live.text, status: live.status, requestId, sessionId: session.id, userMessageId: user?.id };
    } finally {
      options.signal?.removeEventListener?.('abort', callerAbort);
      await storage?.flush?.();
      if (active === job) { active = null; state.busy = false; state.jobId = ''; }
    }
  }
  async function selectGenerationCharacter(value, characterId, options = {}, sessionId = state.currentId) {
    if (typeof options === 'string') { sessionId = options; options = {}; }
    if (destroyed) return failure('ASSISTANT_CLOSED', '会话服务已关闭');
    if (active) return failure('BUSY', '当前请求仍在处理中', active.id, active.sessionId);
    const found = messageLocation(value, sessionId);
    if (!found || sessionId !== state.currentId) return failure('SESSION_UNAVAILABLE', '当前会话不可用');
    const original = found?.message;
    const jobId = text(original?.result?.jobId);
    const pending = object(original?.result?.needsInput) ? original.result.needsInput : null;
    const selectedId = text(characterId);
    const originalCharacter = options.original === true;
    if (!found || !jobId || original?.result?.status !== 'needs_input' || pending?.kind !== 'character') return failure('INPUT_EXPIRED', '角色选择已过期，请按当前提示重新选择');
    if (originalCharacter && selectedId) return failure('INVALID_INPUT', '原创人物不能同时选择角色库角色');
    if (!originalCharacter && !selectedId) return failure('INVALID_INPUT', '请选择一个角色或按原创人物继续');
    const current = generation?.uiSnapshot?.(jobId) || generation?.get?.(jobId);
    if (!current) return failure('JOB_NOT_FOUND', '原生成任务已不存在，请重新发送绘图要求');
    if (current.status !== 'needs_input' || current.needsInput?.kind !== 'character' || current.needsInput.query !== pending.query) return failure('INPUT_EXPIRED', '角色选择已过期，请按当前提示重新选择');
    const option = array(pending.options).find(item => text(item?.id) === selectedId) || (object(options.selectedCharacter) ? options.selectedCharacter : {});
    const name = text(option?.name || option?.nameZh, selectedId);
    const series = text(option?.series || option?.seriesName);
    const characterSelection = { query: text(pending.query), ...(originalCharacter ? { original: true } : { characterId: selectedId }) };
    const session = found.session;
    const requestId = id('generation_character');
    const user = append('user', originalCharacter ? `按原创人物继续：${text(pending.query)}` : `选择角色：${name}${series ? `（${series}）` : ''}`, { status: 'done' }, session.id);
    const liveSnapshot = append('assistant', '', { status: 'streaming' }, session.id);
    const live = session.messages.find(message => message.id === liveSnapshot.id);
    const controller = new AbortController();
    const job = { id: requestId, sessionId: session.id, session, live, controller, invalidated: false };
    active = job; state.busy = true; state.status = 'running'; state.jobId = requestId; state.lastError = '';
    observe(options.onStart, { requestId, sessionId: session.id });
    const onEvent = event => {
      if (!writable(job) || isNoiseEvent(event)) return;
      live.events.push(clone(event)); if (live.events.length > 256) live.events.shift();
      const generationState = event?.jobId ? (generation?.uiSnapshot?.(event.jobId) || generation?.get?.(event.jobId)) : null;
      if (generationState) {
        live.result = { ...(object(live.result) ? live.result : {}), ...clone(generationState) };
        live.artifacts = clone(array(generationState.artifacts));
        live.imageIds = ids(generationState.imageIds);
      }
      schedulePersist(); observe(options.onEvent, clone(event));
    };
    try {
      const args = { jobId, characterSelection };
      const { outcome, resumed } = await resumeWithJudgement(args, job, options, onEvent);
      if (!writable(job)) return { ...failure('CANCELLED', '请求已取消', requestId, session.id), data: cancelledPayload(job) };
      const publicPayload = object(outcome.data) ? outcome.data : {};
      const payload = hydrateGenerationPayload(publicPayload);
      applyPayload(job, payload);
      const error = outcome.ok ? (payload.status === 'failed' ? errorShape(payload.error) : null) : errorShape(outcome.error);
      const ok = outcome.ok && !error;
      live.status = ok ? 'done' : error.code === 'CANCELLED' ? 'cancelled' : 'error';
      live.result = { ...clone(payload), ok, error, usage: clone(outcome.usage) };
      live.toolCalls = [{ id: requestId, name: 'generation.resume', arguments: args, ok, result: clone(resumed.data), error }, ...array(publicPayload.toolCalls)];
      live.transcript = [
        { role: 'assistant', content: '', tool_calls: [{ id: requestId, type: 'function', function: { name: 'generation_resume', arguments: JSON.stringify(args) } }] },
        { role: 'tool', tool_call_id: requestId, content: JSON.stringify(resumed.ok ? resumed.data : resumed.error) }, ...transcript(publicPayload.transcript)
      ];
      if (!live.text && error) live.text = error.message;
      if (outcome.ok) {
        original.result = { ...clone(original.result), status: 'resolved', needsInput: null, characterSelection };
        original.status = 'done';
      }
      session.updatedAt = Date.now(); state.status = ok ? 'idle' : live.status; state.lastError = error?.message || ''; persist();
      return { ...outcome, ...payload, ok, error, data: clone(payload), text: live.text, status: live.status, requestId, sessionId: session.id, userMessageId: user?.id };
    } catch (cause) {
      if (!writable(job)) return failure('CANCELLED', '请求已取消', requestId, session.id);
      const error = errorShape(cause);
      live.status = 'error'; live.text = error.message; live.result = { ok: false, error };
      state.status = 'error'; state.lastError = error.message; persist();
      return failure(error.code, error.message, requestId, session.id);
    } finally {
      await storage?.flush?.();
      if (active === job) { active = null; state.busy = false; state.jobId = ''; }
    }
  }
  async function selectFeedbackCandidate(messageId, imageId, options = {}, sessionId = state.currentId) {
    if (destroyed) return failure('ASSISTANT_CLOSED', '会话服务已关闭');
    if (active) return failure('BUSY', '当前请求仍在处理中');
    if (options.signal?.aborted) return failure('CANCELLED', '请求已取消');
    const found = messageLocation(messageId, sessionId);
    if (!found || sessionId !== state.currentId) return failure('SESSION_UNAVAILABLE', '当前会话不可用');
    const pending = found.message.result?.needsInput;
    if (found.message.result?.status !== 'needs_input' || pending?.kind !== 'candidate' || found.session.messages.slice(found.index + 1).some(row => row.role === 'user')) return failure('INPUT_EXPIRED', '该选图问题已结束，请使用当前修改任务');
    const target = checkedFeedbackOption(pending, text(imageId), sessionId);
    if (!target) return failure('CANDIDATE_NOT_FOUND', '这张图不在当前待选候选中');
    const original = clone(found.message.result);
    found.message.result = { status: 'resolved', selectedImageId: imageId };
    persist();
    const before = found.session.messages.length;
    const displayText = options.locale === 'en-US' ? `Selected image ${target.option.slotNo || imageId}` : `选择图${target.option.slotNo || imageId}继续优化`;
    try {
      const result = target.job.agentControlled
        ? await runPrimaryWithRuntime({ ...options, sessionId, text: pending.feedback, displayText, feedbackJobId: target.job.jobId, baseCandidateId: target.candidate.id })
        : await continueGeneration(target.option.messageId, target.candidate.id, pending.feedback, { ...options, displayText }, sessionId);
      if (!result.ok && before === found.session.messages.length) { found.message.result = original; persist(); }
      return result;
    } catch (error) {
      if (before === found.session.messages.length) { found.message.result = original; persist(); }
      return failure(error.code || 'REQUEST_FAILED', error.message);
    }
  }
  async function rerunFromMessage(value, inputPatch = {}, config = {}, sessionId = state.currentId) {
    if (active) return failure('BUSY', '当前请求仍在处理中', active.id, active.sessionId);
    const found = messageLocation(value, sessionId); if (!found || found.session.id !== state.currentId) return failure('MESSAGE_NOT_FOUND', '没有找到要重新执行的消息');
    let index = found.index; while (index >= 0 && found.session.messages[index].role !== 'user') index -= 1; if (index < 0) return failure('MESSAGE_NOT_FOUND', '没有找到对应的用户消息');
    const user = clone(found.session.messages[index]); const body = inputPatch.text === undefined ? user.text : inputPatch.text; const imageIds = inputPatch.imageIds === undefined ? user.imageIds : ids(inputPatch.imageIds);
    if (!text(body) && !imageIds.length) return failure('EMPTY_INPUT', '请输入内容或添加图片');
    found.session.messages.splice(index); persist(); return runPrimaryWithRuntime({ ...inputPatch, text: body, imageIds, sessionId: found.session.id }, config);
  }
  let capabilities = { tags: Boolean(tags?.search), vision: visionService.available?.() || { metadata: Boolean(images?.get), local: false, ai: false }, comfy: { enabled: false, connected: false, workflowReady: false, render: false, error: '尚未检查 ComfyUI' } };
  let capabilityRevision = 0;
  async function refreshCapabilities() {
    const revision = ++capabilityRevision;
    const result = await primaryTools?.call?.('comfy.status', {}, { caller: 'ui', sessionId: state.currentId });
    if (revision !== capabilityRevision) return clone(capabilities);
    const comfyState = result?.data || {};
    if (result?.ok && (!comfyState.connected || !comfyState.workflowReady)) settings.setForm({ comfyOn: false });
    comfyState.enabled = settings.snapshot().comfy.enabled === true;
    comfyState.render = comfyState.enabled && comfyState.connected === true && comfyState.workflowReady === true;
    capabilities = { tags: Boolean(tags?.search), vision: visionService.available?.() || { metadata: Boolean(images?.get), local: false, ai: false }, comfy: { enabled: comfyState.enabled === true, connected: comfyState.connected === true, workflowReady: comfyState.workflowReady === true, render: comfyState.render === true, error: text(comfyState.error) } };
    return clone(capabilities);
  }
  function setSettings(value = {}) { const result = settings.setForm(value); capabilityRevision += 1; ai.setConfig(settings.primaryProfile()); visionAi.setConfig(settings.visionProfile()); return result; }
  function resetSettings(group) { settings.reset(group); capabilityRevision += 1; return settings.getForm(); }
  const api = {
    run: runPrimaryWithRuntime, runtime, primaryTools, generation, comfy, imageRepository, visionTempStore, visionService, parseReply,
    getSettings: settings.getForm, getCanonicalSettings: settings.snapshot, setSettings, updateSettings: setSettings, resetSettings, comfyProfiles,
    getPrimaryConfig: settings.primaryProfile, getVisionConfig: visionConfig,
    listModels: config => ai.listModels({ ...settings.primaryProfile(), ...publicRequestConfig(config) }), listVisionModels: config => visionAi.listModels({ ...settings.visionProfile(), ...publicRequestConfig(config) }),
    testConnection: config => runtime.runPrimary({ requestId: id('connection'), messages: [{ role: 'user', content: 'Please reply OK.' }], config: { ...publicRequestConfig(config), stream: false } }),
    getCapabilities: () => clone(capabilities), refreshCapabilities,
    newSession, currentSession: () => clone(currentSession()), sessions: () => clone(state.sessions), snapshot: () => ({ ...clone(state), settings: settings.getForm(), config: settings.primaryProfile(), visionConfig: visionConfig() }),
    switchSession(sessionId) { if (!sessionById(sessionId)) return false; if (sessionId !== state.currentId) cancel(); state.currentId = sessionId; persist(); return true; },
    renameSession(sessionId, title) { const session = sessionById(sessionId); if (!session) return false; session.title = text(title, session.title); session.updatedAt = Date.now(); persist(); return clone(session); },
    deleteSession(sessionId = state.currentId, value = {}) { if (!sessionById(sessionId)) return false; if (active?.sessionId === sessionId) cancel(); const result = imageRepository.deleteSession(sessionId, { retainImages: value.retainImages === true }); if (!sessionById()) state.currentId = state.sessions[0]?.id || ''; if (!state.sessions.length) newSession(); else persist(); return result; },
    clearSession(sessionId = state.currentId) { if (!sessionById(sessionId)) return false; if (active?.sessionId === sessionId) cancel(); imageRepository.clearSessionContent(sessionId); persist(); return clone(sessionById(sessionId)); },
    clearConversationImages(sessionId = state.currentId) { if (!sessionById(sessionId)) return false; if (active?.sessionId === sessionId) cancel(); const result = imageRepository.clearConversationImages(sessionId); persist(); return result; },
    append, editMessage, deleteMessage, chooseCandidate, selectCandidate: chooseCandidate, selectGenerationFinal, continueGeneration, selectGenerationCharacter, selectFeedbackCandidate, rerunFromMessage, regenerateMessage: rerunFromMessage,
    exportSessions: () => JSON.stringify(sessionBundle(), null, 2),
    importSessions(value, replace = false) { const incoming = incomingBundle(value); if (!incoming) return false; cancel(); const usedSessions = new Set(replace ? [] : state.sessions.map(row => row.id)); const usedMessages = new Set(replace ? [] : state.sessions.flatMap(row => row.messages.map(message => message.id))); const normalized = incoming.sessions.map(row => normalizeSession(row, usedSessions, usedMessages)); state.sessions = replace ? normalized : [...state.sessions, ...normalized]; if (replace || !sessionById()) state.currentId = state.sessions[0]?.id || ''; for (const session of normalized) imageRepository.reconcileSessionMessages(session.id); imageRepository.reconcileSessions(); if (!state.sessions.length) newSession(); else persist(); return clone(state.sessions); },
    listCallRecords: () => runtime?.listCallRecords?.() || [],
    clearCallRecords: () => runtime?.clearCallRecords?.(),
    getCallMonitorInfo: callMonitor.info,
    flushCallRecords: callMonitor.flush,
    flushPersistence: flushPersist,
    cancel, stop: cancel, destroy() { cancel(); void flushPersist(); destroyed = true; }
  };
  return Object.freeze(api);
}

module.exports = { SESSION_FORMAT, SESSION_VERSION, createAssistant };
