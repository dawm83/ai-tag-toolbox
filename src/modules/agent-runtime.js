'use strict';

const { createRequestManager, newRequestId } = require('./request-manager');
const { createStatusManager } = require('./status-manager');
const { createUsageLimiter } = require('./usage-limiter');
const { errorShape, resultOk, resultError } = require('./error-manager');
const { assertValid } = require('./schema');
const { createCallMonitor } = require('./call-monitor');
const { createTaskPolicy } = require('./task-policy');

const TOOL_NAMES = Object.freeze(['tags.search', 'characters.search', 'conversation.listImages', 'conversation.viewImages', 'vision.processOne', 'translation.translate', 'agent.generateTags', 'comfy.status', 'comfy.validateWorkflow', 'comfy.render', 'generation.execute', 'generation.resume', 'generation.review', 'generation.select', 'generation.comment', 'generation.resolveTarget']);
const NATIVE_NAMES = new Map(TOOL_NAMES.map(name => [name.replace('.', '_'), name]));
function text(value, fallback = '') { const output = value == null ? '' : String(value).trim(); return output || fallback; }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function clone(value) { if (Array.isArray(value)) return value.map(clone); if (object(value)) return Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v !== 'function').map(([k, v]) => [k, clone(v)])); return value; }
function canonicalName(name) { return NATIVE_NAMES.get(String(name)) || String(name); }
function nativeName(name) { return String(name).replace('.', '_'); }
function reject(code, message) { return Object.assign(new Error(message), { code }); }
function assertSchema(schema, value, code) { try { assertValid(schema || {}, value); } catch (error) { error.code = code; throw error; } }
function unwrap(value) { if (value?.ok === false) throw errorShape(value); return value?.ok === true && Object.prototype.hasOwnProperty.call(value, 'data') ? value.data : value; }
function race(invoke, signal) {
  if (signal.aborted) return Promise.reject(signal.reason || reject('CANCELLED', '请求已取消'));
  return new Promise((resolve, rejectPromise) => {
    let settled = false;
    const finish = (callback, value) => { if (settled) return; settled = true; signal.removeEventListener('abort', abort); callback(value); };
    const abort = () => finish(rejectPromise, signal.reason || reject('CANCELLED', '请求已取消'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { if (signal.aborted) throw signal.reason || reject('CANCELLED', '请求已取消'); return invoke(); }).then(value => finish(resolve, value), error => finish(rejectPromise, error));
  });
}
/**
 * 任务事件噪音分类（单一来源）：
 * - delta：流式增量（正文/推理分片）；
 * - progress：进度轮询（如 ComfyUI 排队）；
 * - provider.event：只有真正包含 非空工具调用/进度/名称/结果 的才保留（注意空数组也是 truthy，必须按长度判断）；
 * 运行时按此丢弃，assistant 持久化时按同一份判断再过滤一道。
 */
function isNoiseEvent(event) {
  const type = typeof event?.type === 'string' ? event.type : '';
  if (type === 'delta') return true;
  if (type === 'progress') return true;
  if (type === 'provider.event') {
    const calls = event?.toolCalls || event?.tool_calls;
    const hasCalls = Array.isArray(calls) ? calls.length > 0 : Boolean(calls);
    return !(hasCalls || event?.progress || event?.name || event?.result);
  }
  return false;
}
function responseCalls(response) { const value = response?.toolCalls || response?.tool_calls || response?.data?.toolCalls || response?.choices?.[0]?.message?.tool_calls || []; if (!Array.isArray(value)) throw reject('OUTPUT_INVALID', '主 AI 工具调用格式无效'); return value; }
function normalizeCall(call, usedIds, allowedNames = TOOL_NAMES) {
  const name = canonicalName(call?.function?.name || call?.name || '');
  if (!TOOL_NAMES.includes(name) || !allowedNames.has(name)) throw reject('TOOL_UNAVAILABLE', `工具不可用：${name}`);
  let args = call?.function?.arguments ?? call?.arguments ?? {};
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { throw reject('INVALID_INPUT', `工具 ${name} 的参数不是有效 JSON`); } }
  if (!object(args)) throw reject('INVALID_INPUT', `工具 ${name} 的参数必须是对象`);
  const id = text(call?.id, newRequestId('call'));
  if (usedIds.has(id)) throw reject('OUTPUT_INVALID', '主 AI 返回了重复的 tool_call_id');
  usedIds.add(id);
  return { id, name, args, native: { id, type: 'function', function: { name: nativeName(name), arguments: JSON.stringify(args) } } };
}
function outputText(response) { const value = response?.data ?? response; if (typeof value === 'string') return value; return typeof value?.text === 'string' ? value.text : typeof value?.choices?.[0]?.message?.content === 'string' ? value.choices[0].message.content : ''; }
function responseReasoning(response) { const value = response?.data ?? response; const reasoning = value?.reasoning_content ?? value?.reasoning ?? value?.choices?.[0]?.message?.reasoning_content ?? value?.choices?.[0]?.message?.reasoning; return typeof reasoning === 'string' ? reasoning : ''; }
function attachResponseReasoning(message, response) { const reasoning = responseReasoning(response); if (response?.reasoningContentPresent === true || reasoning) message.reasoning_content = reasoning; return message; }
function publicConfig(value) {
  if (!object(value)) return {};
  const output = {};
  for (const key of ['base', 'model', 'key', 'temperature', 'timeoutMs', 'maxTokens', 'stream']) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (['base', 'model', 'key'].includes(key) && typeof value[key] === 'string') output[key] = value[key].trim();
    else if (key === 'stream' && typeof value[key] === 'boolean') output[key] = value[key];
    else if (['temperature', 'timeoutMs', 'maxTokens'].includes(key) && value[key] != null && Number.isFinite(Number(value[key]))) output[key] = Number(value[key]);
  }
  return output;
}
function retryLimit(settings) {
  const value = Number(settings?.limits?.maxToolRetries);
  return Number.isFinite(value) ? Math.max(0, Math.min(8, Math.floor(value))) : 2;
}
function retryKey(name, args) {
  let serialized = '';
  try { serialized = JSON.stringify(args); } catch { serialized = String(args); }
  return `${name}:${serialized}`;
}
function historyMessage(item) {
  if (!object(item) || !['user', 'assistant', 'tool'].includes(item.role)) return null;
  const message = { role: item.role };
  if (item.role === 'user' && Array.isArray(item.imageIds)) message.imageIds = item.imageIds.filter(id => typeof id === 'string');
  if (item.role === 'tool') {
    if (!text(item.tool_call_id)) return null;
    message.tool_call_id = text(item.tool_call_id);
    message.content = typeof item.content === 'string' ? item.content : typeof item.text === 'string' ? item.text : JSON.stringify(clone(item.content ?? ''));
    return message;
  }
  message.content = typeof item.content === 'string' || item.content === null ? item.content : typeof item.text === 'string' ? item.text : '';
  if (item.role === 'assistant') {
    if (typeof item.reasoning_content === 'string') message.reasoning_content = item.reasoning_content;
    else if (typeof item.reasoning === 'string') message.reasoning_content = item.reasoning;
  }
  if (item.role === 'assistant' && Array.isArray(item.tool_calls)) {
    const calls = item.tool_calls.filter(call => text(call?.id) && text(call?.function?.name || call?.name)).map(call => ({
      id: text(call.id), type: 'function', function: { name: nativeName(canonicalName(call.function?.name || call.name)), arguments: typeof call.function?.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function?.arguments ?? call.arguments ?? {}) }
    }));
    if (calls.length) message.tool_calls = calls;
  }
  return message;
}

function createAgentRuntime(options = {}) {
  const client = options.primaryClient || options.ai;
  const getSettings = typeof options.getSettings === 'function' ? options.getSettings : () => ({});
  const getTools = typeof options.tools === 'function' ? options.tools : () => options.tools || {};
  const getSubagents = typeof options.subagents === 'function' ? options.subagents : () => options.subagents || {};
  const statuses = options.statusManager || createStatusManager({ onStatus: options.onStatus, maxRecords: options.maxRecords });
  const requests = options.requestManager || createRequestManager({ maxRecords: options.maxRecords });
  requests.subscribe(event => {
    const row = event.request;
    if (row.status === 'running') statuses.start(row.requestId, row);
    else if (row.status === 'completed') statuses.complete(row.requestId, row);
    else if (row.status === 'timeout') statuses.timeout(row.requestId, row);
    else if (row.status === 'cancelled') statuses.cancel(row.requestId, row);
    else if (row.status === 'error') statuses.fail(row.requestId, row.error, row);
  });
  const limiter = options.usageLimiter || createUsageLimiter();
  const monitor = options.monitor || createCallMonitor({ maxRecords: options.maxCallRecords, filePath: options.callMonitorPath, getSecrets: () => [getSettings()?.primaryApi?.key, getSettings()?.visionApi?.key], onCallRecord: options.onCallRecord });
  const active = new Map();
  function requestLimits(request = {}) {
    const settings = getSettings() || {};
    const limits = object(settings.limits) ? { ...settings.limits } : {};
    const generation = object(settings.generation) ? settings.generation : {};
    const intent = text(request.task?.intent);
    const isGeneration = ['create_image', 'recreate_image', 'resolve_candidate', 'auto'].includes(intent) || Boolean(request.task?.feedbackJobId);
    if (isGeneration && generation.autoRun !== false) {
      const rounds = Math.max(1, Math.min(10, Math.floor(Number(generation.maxAutoRounds) || 3)));
      // One image iteration can take a public review, Tag revision and resume
      // in addition to the render call. Reserve room for character lookup and
      // the final selection instead of coupling this budget to the default 8.
      const roundBudget = rounds * 4 + 8;
      const callBudget = rounds * 6 + 16;
      const comfyBudget = rounds + 2;
      limits.maxToolRounds = Math.max(Number(limits.maxToolRounds) || 8, roundBudget);
      limits.maxToolCalls = Math.max(Number(limits.maxToolCalls) || 32, callBudget);
      limits.maxComfyCalls = Math.max(Number(limits.maxComfyCalls) || 3, comfyBudget);
    }
    return limits;
  }
  function registryTool(name) { const registry = getTools() || {}; return typeof registry.resolve === 'function' ? registry.resolve(name) : registry[name] || null; }
  function listTools() { return TOOL_NAMES.map(name => { const entry = registryTool(name); return entry ? { name, description: entry.description || '', parameters: clone(entry.parameters || entry.inputSchema || { type: 'object', additionalProperties: false }) } : null; }).filter(Boolean); }
  function schemas() {
    const registry = getTools() || {};
    if (typeof registry.openAiTools === 'function') {
      const rows = registry.openAiTools();
      if (Array.isArray(rows)) return rows.map(item => {
        const fn = item?.function || item || {};
        const name = canonicalName(fn.name || item?.name || '');
        return { type: 'function', function: { name: nativeName(name), description: fn.description || item?.description || '', parameters: clone(fn.parameters || item?.parameters || { type: 'object', additionalProperties: false }) } };
      }).filter(item => TOOL_NAMES.includes(canonicalName(item.function.name)));
    }
    return listTools().map(entry => ({ type: 'function', function: { name: nativeName(entry.name), description: entry.description, parameters: entry.parameters } }));
  }
  function emit(context, type, payload = {}) {
    if (context.signal.aborted || !active.has(context.requestId)) return;
    const event = { ...clone(payload), type, requestId: context.requestId, rootRequestId: context.rootRequestId, at: Date.now() };
    context.events.push(event); if (context.events.length > 256) context.events.shift();
    if (context.parentContext && context.parentContext !== context) {
      context.parentContext.events.push(event);
      if (context.parentContext.events.length > 256) context.parentContext.events.shift();
    }
    statuses.update(context.requestId, { event });
    if (!isNoiseEvent(event)) monitor.event(context.requestId, event);
    try { context.onEvent?.(event); } catch { /* observers are optional */ }
  }
  async function execute(kind, request, timeoutMs, work) {
    const parentId = text(request.parentRequestId || (active.has(request.requestId) ? request.requestId : ''));
    const parent = active.get(parentId);
    const handle = requests.begin(parentId ? undefined : request.requestId, { kind, parentRequestId: parentId, rootRequestId: parent?.rootRequestId, timeoutMs: request.timeoutMs || timeoutMs, signal: request.signal || parent?.signal });
    const id = handle.requestId; const rootId = parent?.rootRequestId || id;
    if (!parent) limiter.begin(rootId, requestLimits(request));
    const context = { requestId: id, parentRequestId: parentId, rootRequestId: rootId, signal: handle.signal, sessionId: request.sessionId || parent?.sessionId, messageId: request.messageId || parent?.messageId, locale: request.locale || parent?.locale || 'zh-CN', settings: parent?.settings || clone(getSettings() || {}), events: [], onEvent: request.onEvent, parentContext: parent || null, partial: null, extendRootTimeout: timeoutMs => requests.extend(rootId, timeoutMs) };
    monitor.begin({ requestId: id, rootRequestId: rootId, parentRequestId: parentId, sessionId: context.sessionId, messageId: context.messageId, kind, input: request.input || {} });
    context.captureInput = input => monitor.update(id, { input });
    active.set(id, context);
    try {
      const data = await race(() => monitor.run(id, () => work(context)), handle.signal);
      if (handle.signal.aborted) throw handle.signal.reason;
      requests.complete(id);
      monitor.finish(id, { status: 'completed', output: data, usage: limiter.snapshot(rootId), usageScope: 'root-total-at-completion' });
      return resultOk(data, id, limiter.snapshot(rootId));
    } catch (cause) {
      const state = requests.get(id); const error = errorShape(state?.error || cause, '请求失败');
      if (!state?.endedAt) requests.fail(id, error);
      const result = resultError(error, id); result.data = context.partial || null; result.usage = limiter.snapshot(rootId);
      monitor.finish(id, { status: requests.get(id)?.status || 'error', output: context.partial, error, usage: result.usage, usageScope: 'root-total-at-completion' });
      return result;
    } finally {
      active.delete(id); if (!parent) limiter.end(rootId);
    }
  }
  async function runSubAgent(name, request = {}) {
    const registry = getSubagents() || {}; const entry = typeof registry.resolve === 'function' ? registry.resolve(name) : registry[name];
    return execute(`subagent:${name}`, request, entry?.timeoutMs || 120000, async context => {
      if (!['vision', 'translation', 'generateTags', 'evaluateImages'].includes(name) || !entry) throw reject('SUBAGENT_UNAVAILABLE', `子代理不可用：${name}`);
      const input = request.input !== undefined ? clone(request.input) : Object.fromEntries(Object.entries(request).filter(([key]) => !['requestId', 'parentRequestId', 'signal', 'timeoutMs', 'sessionId', 'messageId', 'onEvent'].includes(key)));
      context.captureInput(input);
      assertSchema(entry.inputSchema || { type: 'object' }, input, 'INVALID_INPUT');
      const run = typeof entry === 'function' ? entry : entry.run || entry.execute;
      if (typeof run !== 'function') throw reject('SUBAGENT_UNAVAILABLE', '子代理执行器不可用');
      limiter.consume(context.rootRequestId, 'subagent');
      emit(context, 'subagent.start', { name });
      let usageReported = false;
      const value = await run(input, { requestId: context.requestId, parentRequestId: context.parentRequestId, rootRequestId: context.rootRequestId, signal: context.signal, sessionId: context.sessionId, messageId: context.messageId, onUsage: usage => { if (usage && typeof usage === 'object') { usageReported = true; limiter.add(context.rootRequestId, usage, name); } }, onEvent: event => emit(context, event?.type || 'event', event || {}) });
      const data = unwrap(value); assertSchema(entry.outputSchema || { type: 'object' }, data, 'OUTPUT_INVALID');
      if (!usageReported) limiter.add(context.rootRequestId, value?.usage, name);
      emit(context, 'subagent.complete', { name }); return data;
    });
  }
  async function callTool(rawName, args = {}, request = {}) {
    const name = canonicalName(rawName);
    const toolTimeoutMs = name === 'comfy.render'
      ? 600000
      : name === 'generation.execute' || name === 'generation.resume'
        ? getSettings()?.generation?.jobTimeoutMs || 1200000
        : 120000;
    return execute(`tool:${name}`, request, toolTimeoutMs, async context => {
      context.captureInput({ args });
      if (!TOOL_NAMES.includes(name)) throw reject('TOOL_UNAVAILABLE', `工具不可用：${name}`);
      const entry = registryTool(name); if (!entry) throw reject('TOOL_UNAVAILABLE', `工具不可用：${name}`);
      assertSchema(entry.parameters || entry.inputSchema || { type: 'object' }, args, 'INVALID_INPUT');
      if (name === 'comfy.render') limiter.check(context.rootRequestId, 'comfy');
      else limiter.consume(context.rootRequestId, 'tool');
      emit(context, 'tool.start', { name, args });
      const registry = getTools();
      // 进度事件（如 ComfyUI 排队轮询）按队列值去重，避免每 1.2 秒刷一条任务事件。
      let lastProgressValue = null;
      const childContext = { ...context, caller: request.caller, afterRender: request.afterRender, feedbackRequest: request.feedbackRequest, onEvent: event => {
        const eventType = event?.type || 'progress';
        if (eventType === 'progress') {
          if (event?.queue !== undefined && event.queue === lastProgressValue) return;
          lastProgressValue = event?.queue ?? lastProgressValue;
        }
        emit(context, eventType, event);
      } };
      const value = typeof registry.call === 'function' ? await registry.call(name, clone(args), childContext) : typeof entry === 'function' ? await entry(clone(args), childContext) : await entry.handler(clone(args), childContext);
      const data = unwrap(value); assertSchema(entry.outputSchema || {}, data, 'OUTPUT_INVALID');
      if (name === 'comfy.render') limiter.complete(context.rootRequestId, 'comfy');
      if (!value?.requestId) limiter.add(context.rootRequestId, value?.usage);
      emit(context, 'tool.complete', { name, result: data }); return data;
    });
  }
  async function runPrimary(request = {}) {
    return execute('primary', request, getSettings()?.limits?.primaryTimeoutMs || options.timeoutMs || 120000, async context => {
      if (typeof client?.complete !== 'function') throw reject('PRIMARY_UNAVAILABLE', '主 AI 服务不可用');
      const policy = object(request.task) ? createTaskPolicy(request.task) : null;
      const taskResult = () => policy ? { task: policy.snapshot() } : {};
      const prompt = typeof options.getPrimaryPrompt === 'function' ? text(await options.getPrimaryPrompt(request)) : text(options.primaryPrompt, '你是 AI 绘画 Tag 工具箱的主 AI，使用固定工具完成用户任务。');
      if (!prompt) throw reject('PROMPT_INVALID', '主 AI 提示词为空');
      const history = (Array.isArray(request.messages) ? request.messages : []).map(historyMessage).filter(Boolean).filter(item => item.role === 'tool' || item.content || item.tool_calls?.length);
      if (!history.length && typeof request.input?.text === 'string') history.push({ role: 'user', content: request.input.text });
      const messages = [{ role: 'system', content: prompt }, ...history]; const transcript = []; const toolCalls = []; const artifacts = []; const usedIds = new Set(); let generationResult = object(request.generationContext) ? clone(request.generationContext) : null; let round = 0;
      context.captureInput({ messages, config: request.config || {} });
      const partial = () => ({ ...(generationResult ? clone(generationResult) : {}), ...taskResult(), text: '', reasoning: '', toolCalls: toolCalls.slice(), events: context.events.slice(), artifacts: artifacts.map(clone), imageIds: [...new Set(artifacts.map(item => item.imageId).filter(Boolean))], transcript: transcript.map(clone) });
      const retryAttempts = new Map();
      const retryTraces = new Map();
      let taskAnnounced = false;
      context.partial = partial();
      if (policy) emit(context, 'task.routed', { intent: request.task.intent, imageIds: request.task.imageIds || [] });
      // 流式增量不逐片写入任务事件：缓冲后节流合并，避免刷满 256 条上限。
      const deltaBuffer = { text: '', reasoning: '', emittedAt: 0 };
      const flushDelta = () => {
        if (!deltaBuffer.text && !deltaBuffer.reasoning) return;
        emit(context, 'delta', { text: deltaBuffer.text, reasoning: deltaBuffer.reasoning });
        deltaBuffer.text = ''; deltaBuffer.reasoning = ''; deltaBuffer.emittedAt = Date.now();
      };
      while (true) {
        limiter.consume(context.rootRequestId, 'round'); round += 1; emit(context, 'round.start', { round });
        const settings = getSettings() || {};
        const registeredSchemas = schemas();
        const primarySchemas = policy ? policy.filterTools(registeredSchemas) : registeredSchemas;
        const allowedPrimaryNames = new Set(registeredSchemas.map(item => canonicalName(item?.function?.name || '')));
        if (policy) messages[0] = { role: 'system', content: prompt + '\n\n' + policy.prompt() };
        const primaryConfig = { ...publicConfig(settings.primaryApi), ...publicConfig(request.config), signal: context.signal, tools: primarySchemas, tool_choice: primarySchemas.length ? 'auto' : 'none', onDelta: (delta, reasoning = '') => { deltaBuffer.text += typeof delta === 'string' ? delta : ''; deltaBuffer.reasoning += typeof reasoning === 'string' ? reasoning : ''; const accumulated = deltaBuffer.text.length + deltaBuffer.reasoning.length; if (accumulated >= 8 && Date.now() - deltaBuffer.emittedAt >= 200) flushDelta(); if (!context.signal.aborted) { try { request.onDelta?.(delta, reasoning); } catch {} } }, onEvent: event => { if (typeof event?.type === 'string' && event.type && !isNoiseEvent(event)) emit(context, event.type, event || {}); } /* 只接受带类型名的有意义事件；无类型名的流式分片（正文/推理/工具参数碎片）一律不产生任务事件，真正的调用由 tool.start/tool.complete 记录。 */ };
        context.captureInput({ messages, config: primaryConfig });
        const response = await race(() => client.complete(messages, { ...primaryConfig, sessionId: context.sessionId }), context.signal);
        unwrap(response); limiter.add(context.rootRequestId, response?.usage, 'primary'); const calls = responseCalls(response).map(call => normalizeCall(call, usedIds, allowedPrimaryNames));
        const responseText = outputText(response);
        const drawingTask = ['create_image', 'recreate_image', 'compile_tags'].includes(request.task?.intent) || Boolean(generationResult) || calls.some(call => call.name.startsWith('generation.'));
        if (drawingTask) {
          let publicText = responseText.trim();
          if (!taskAnnounced && !publicText && calls.length) {
            const recreate = request.task?.intent === 'recreate_image';
            publicText = context.locale === 'en-US'
              ? (recreate ? 'I will recreate the reference image, first checking its Tags and generating a baseline for comparison.' : 'I will work from your request, prepare the Tags, then check the result before deciding the next step.')
              : (recreate ? '我会按你的要求复刻参考图，先读取原图 Tag，生成第一张图后再对照差异。' : '我会根据你的要求准备提示词，再检查结果并说明下一步。');
          }
          if (publicText) {
            emit(context, 'assistant.message', { phase: !taskAnnounced ? 'start' : calls.length ? 'progress' : 'final', round, summary: publicText });
            taskAnnounced = true;
          }
        }
        if (!calls.length) {
          if (!responseText.trim()) throw reject('OUTPUT_INVALID', '主 AI 返回为空');
          const finalMessage = attachResponseReasoning({ role: 'assistant', content: responseText }, response);
          messages.push(finalMessage); transcript.push(clone(finalMessage));
          flushDelta(); emit(context, 'round.complete', { round });
          const data = { ...(generationResult ? clone(generationResult) : {}), ...taskResult(), text: responseText, reasoning: responseReasoning(response), toolCalls, events: context.events.slice(), artifacts, imageIds: [...new Set(artifacts.map(item => item.imageId).filter(Boolean))], transcript };
          context.partial = data; return data;
        }
        const assistantMessage = attachResponseReasoning({ role: 'assistant', content: responseText || null, tool_calls: calls.map(call => call.native) }, response);
        messages.push(assistantMessage); transcript.push(clone(assistantMessage)); context.partial = partial();
        let paused = false;
        let terminalError = null;
        for (const call of calls) {
          const blocked = paused ? { code: 'TASK_WAITING_FOR_INPUT', message: '当前任务需要用户补充信息，已跳过后续调用', retryable: false }
            : terminalError ? { code: 'REQUEST_STOPPED', message: '本轮请求已停止，后续调用未执行', retryable: false }
              : policy && !policy.allows(call.name) ? policy.policyError(call.name) : null;
          const args = !blocked && policy ? policy.prepareCall(call.name, call.args) : call.args;
          const key = retryKey(call.name, call.args);
          const attempt = (retryAttempts.get(key) || 0) + 1;
          const previousTrace = retryTraces.get(key);
          const outcome = blocked ? resultError(blocked, context.requestId) : await callTool(call.name, args, { caller: 'primary', feedbackRequest: request.feedbackRequest, locale: context.locale, afterRender: Boolean(generationResult?.candidates?.length || generationResult?.targetResolved || request.task?.feedbackJobId), parentRequestId: context.requestId, signal: context.signal, sessionId: context.sessionId, messageId: context.messageId, onEvent: event => { try { request.onEvent?.(event); } catch {} } });
          const trace = { id: call.id, name: call.name, arguments: args, requestId: outcome.requestId, ok: outcome.ok, result: outcome.data, error: outcome.error, attempt, ...(blocked ? { blocked: true } : {}), ...(previousTrace ? { retryOf: previousTrace.id } : {}) }; toolCalls.push(trace);
          if (call.name.startsWith('generation.')) generationResult = outcome.ok && object(outcome.data) ? clone(outcome.data) : generationResult;
          if (Array.isArray(outcome.data?.artifacts)) for (const artifact of outcome.data.artifacts) if (!artifacts.some(item => item.imageId === artifact.imageId)) artifacts.push(clone(artifact));
          try { request.onToolCall?.([trace]); } catch {}
          const toolMessage = { role: 'tool', tool_call_id: call.id, content: JSON.stringify(outcome.ok ? outcome.data : { ok: false, error: outcome.error }) };
          messages.push(toolMessage); transcript.push(clone(toolMessage)); context.partial = partial();
          if (!outcome.ok) {
            retryAttempts.set(key, attempt);
            retryTraces.set(key, trace);
            const canRetry = attempt <= retryLimit(getSettings());
            emit(context, blocked ? 'tool.blocked' : 'tool.failed', { name: call.name, error: outcome.error, attempt });
            if (!paused && !terminalError && (!canRetry || context.signal.aborted || ['CANCELLED', 'TOOL_CALL_LIMIT', 'TOOL_ROUND_LIMIT', 'COMFY_CALL_LIMIT'].includes(outcome.error?.code))) terminalError = outcome.error;
            context.partial = partial();
            continue;
          }
          retryAttempts.delete(key);
          retryTraces.delete(key);
          if (policy?.completionFor(call.name, outcome.data)) emit(context, policy.isWaiting() ? 'task.waiting' : 'task.answering', { intent: request.task.intent, status: outcome.data?.status });
          if (['generation.execute', 'generation.resume', 'generation.resolveTarget'].includes(call.name) && generationResult?.status === 'needs_input') {
            paused = true;
          }
        }
        flushDelta(); emit(context, 'round.complete', { round });
        context.partial = partial();
        if (terminalError) throw terminalError;
        if (paused) return context.partial;
        if (policy?.isSelected()) {
          const finalData = { ...context.partial, text: responseText.trim(), reasoning: responseReasoning(response), transcript: transcript.map(clone) };
          context.partial = finalData;
          return finalData;
        }
      }
    });
  }
  return { runPrimary, runSubAgent, callTool, cancel: id => requests.cancel(id), getStatus: id => statuses.get(id) || requests.get(id), getRequest: id => requests.get(id), listTools, listCallRecords: monitor.list, clearCallRecords: monitor.clear, getCallMonitorInfo: monitor.info, flushCallRecords: monitor.flush, status: statuses, requests, usage: limiter };
}

module.exports = { createAgentRuntime, resultOk, resultError, isNoiseEvent };
