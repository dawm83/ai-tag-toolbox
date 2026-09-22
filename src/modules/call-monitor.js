'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');

const FORMAT = 'ai-tag-call-monitor';
const VERSION = 2;
const DEFAULT_MAX_RECORDS = 200;
const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_MAX_RECORD_BYTES = 16 * 1024;
const STATUS_VALUES = new Set(['running', 'completed', 'error', 'timeout', 'cancelled', 'interrupted']);
const USAGE_NUMBER_KEYS = new Set([
  'toolRounds', 'toolCalls', 'comfyCalls', 'subAgentCalls', 'prompt_tokens', 'completion_tokens',
  'total_tokens', 'input_tokens', 'output_tokens', 'reasoning_tokens', 'cached_tokens'
]);
function text(value, fallback = '') {
  const result = value == null ? '' : String(value).trim();
  return (result || fallback).slice(0, 256);
}

function number(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function byteSize(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

function status(value, fallback = 'error') {
  const result = text(value).toLowerCase();
  return STATUS_VALUES.has(result) ? result : fallback;
}

function compactError(value) {
  if (!value) return null;
  if (value instanceof Error) return { code: text(value.code, 'ERROR'), message: text(value.message, '未知错误').slice(0, 300) };
  if (typeof value === 'string') return { code: 'ERROR', message: value.slice(0, 300) };
  if (typeof value !== 'object') return { code: 'ERROR', message: String(value).slice(0, 300) };
  const message = text(value.message || value.error || value.detail, '未知错误');
  return { code: text(value.code, 'ERROR').slice(0, 128), message: message.slice(0, 300) };
}

function compactUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const output = {};
  for (const key of USAGE_NUMBER_KEYS) {
    const amount = number(value[key]);
    if (amount != null) output[key] = amount;
  }
  if (value.byKind && typeof value.byKind === 'object' && !Array.isArray(value.byKind)) {
    const byKind = {};
    for (const [key, raw] of Object.entries(value.byKind).slice(0, 64)) {
      const amount = number(raw);
      if (amount != null) byKind[text(key, 'unknown').slice(0, 128)] = amount;
    }
    if (Object.keys(byKind).length) output.byKind = byKind;
  }
  return Object.keys(output).length ? output : null;
}

function mergeUsage(current, next) {
  const left = compactUsage(current) || {};
  const right = compactUsage(next) || {};
  const output = {};
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (key === 'byKind') continue;
    const amount = number(left[key], null);
    const addition = number(right[key], null);
    if (amount != null || addition != null) output[key] = (amount || 0) + (addition || 0);
  }
  const byKind = { ...(left.byKind || {}) };
  for (const [key, value] of Object.entries(right.byKind || {})) byKind[key] = (number(byKind[key], 0) || 0) + (number(value, 0) || 0);
  if (Object.keys(byKind).length) output.byKind = byKind;
  return Object.keys(output).length ? output : null;
}

function deriveTool(kind, value) {
  const explicit = text(value);
  if (explicit) return explicit;
  const source = text(kind);
  return source.startsWith('tool:') ? source.slice(5) : source || null;
}

function summaryFrom(value, defaults = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const row = {
    requestId: text(source.requestId || defaults.requestId),
    rootRequestId: text(source.rootRequestId || defaults.rootRequestId || source.requestId || defaults.requestId),
    parentRequestId: text(source.parentRequestId || defaults.parentRequestId) || null,
    sessionId: text(source.sessionId || defaults.sessionId) || null,
    messageId: text(source.messageId || defaults.messageId) || null,
    jobId: text(source.jobId || defaults.jobId) || null,
    kind: text(source.kind || defaults.kind, 'unknown'),
    tool: deriveTool(source.kind || defaults.kind, source.tool || defaults.tool),
    model: text(source.model || defaults.model) || null,
    status: status(source.status, defaults.status || 'running'),
    startedAt: number(source.startedAt, number(defaults.startedAt, Date.now())),
    endedAt: number(source.endedAt, null),
    durationMs: number(source.durationMs, null),
    apiCalls: Math.max(0, Math.floor(number(source.apiCalls, number(defaults.apiCalls, 0)) || 0)),
    usage: compactUsage(source.usage || defaults.usage),
    usageScope: text(source.usageScope || defaults.usageScope) || null,
    httpStatus: number(source.httpStatus, number(defaults.httpStatus, null)),
    error: compactError(source.error || defaults.error)
  };
  return row;
}

function createCallMonitor(options = {}) {
  const scope = new AsyncLocalStorage();
  const records = new Map();
  const openExchanges = new Map();
  const maxRecords = Math.max(1, Math.min(DEFAULT_MAX_RECORDS, Math.floor(number(options.maxRecords, DEFAULT_MAX_RECORDS) || DEFAULT_MAX_RECORDS)));
  const maxRecordBytes = Math.max(1024, Math.min(DEFAULT_MAX_BYTES, Math.floor(number(options.maxRecordBytes, DEFAULT_MAX_RECORD_BYTES) || DEFAULT_MAX_RECORD_BYTES)));
  const maxBytes = Math.max(maxRecordBytes, Math.min(DEFAULT_MAX_BYTES, Math.floor(number(options.maxBytes, DEFAULT_MAX_BYTES) || DEFAULT_MAX_BYTES)));
  const filePath = options.filePath || '';
  let revision = 0;
  let dropped = 0;
  let timer = null;
  let writing = Promise.resolve();
  let persistenceError = '';

  function list() {
    return [...records.values()].map(row => clone(row));
  }

  function totalBytes() {
    return [...records.values()].reduce((total, row) => total + byteSize(row), 0);
  }

  function enforceLimits(checkBytes = true) {
    let total = checkBytes ? totalBytes() : 0;
    for (const [id, row] of records) {
      if (records.size <= maxRecords && (!checkBytes || total <= maxBytes)) break;
      if (checkBytes) total -= byteSize(row);
      records.delete(id); dropped++;
    }
  }

  function bundle() {
    return {
      format: FORMAT,
      version: VERSION,
      exportedAt: new Date().toISOString(),
      dropped,
      limits: { maxRecords, maxBytes, maxRecordBytes },
      records: list()
    };
  }

  function scheduleFlush() {
    if (!filePath || timer) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, 250);
    timer.unref?.();
  }

  function changed(persist = false) {
    enforceLimits(persist);
    revision++;
    if (persist) scheduleFlush();
  }

  function flush() {
    clearTimeout(timer);
    timer = null;
    if (!filePath) return Promise.resolve();
    const payload = JSON.stringify(bundle());
    writing = writing.then(async () => {
      try {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        const temporary = filePath + '.tmp';
        await fs.promises.writeFile(temporary, payload, 'utf8');
        await fs.promises.rename(temporary, filePath);
        persistenceError = '';
      } catch {
        persistenceError = '本地日志保存失败，仍可复制或导出当前记录';
      }
    });
    return writing;
  }

  function begin(meta = {}) {
    const requestId = text(meta.requestId, 'request_' + randomUUID());
    const row = summaryFrom({
      requestId,
      rootRequestId: meta.rootRequestId || requestId,
      parentRequestId: meta.parentRequestId,
      sessionId: meta.sessionId,
      messageId: meta.messageId,
      jobId: meta.jobId,
      kind: meta.kind,
      tool: meta.tool,
      model: meta.model,
      startedAt: Date.now(),
      status: 'running'
    });
    records.set(requestId, row);
    changed();
    return requestId;
  }

  function update(id, patch = {}) {
    const row = records.get(id);
    if (!row || row.status !== 'running' || !patch || typeof patch !== 'object') return;
    for (const key of ['rootRequestId', 'parentRequestId', 'sessionId', 'messageId', 'jobId', 'kind', 'tool', 'model', 'usageScope']) {
      if (patch[key] !== undefined) row[key] = text(patch[key]) || null;
    }
    if (patch.usage !== undefined) row.usage = compactUsage(patch.usage);
    if (patch.httpStatus !== undefined) row.httpStatus = number(patch.httpStatus, row.httpStatus);
    changed();
  }

  function finish(id, patch = {}) {
    const row = records.get(id);
    if (!row || row.status !== 'running') return;
    const endedAt = Date.now();
    const nextStatus = status(patch.status, 'completed');
    row.status = nextStatus;
    row.endedAt = endedAt;
    row.durationMs = Math.max(0, endedAt - (number(row.startedAt, endedAt) || endedAt));
    const finishedUsage = patch.usage === undefined ? undefined : compactUsage(patch.usage);
    if (finishedUsage && !(patch.usageScope === 'root-total-at-completion' && row.requestId !== row.rootRequestId)) row.usage = finishedUsage;
    if (patch.usageScope !== undefined && !(patch.usageScope === 'root-total-at-completion' && row.requestId !== row.rootRequestId)) row.usageScope = text(patch.usageScope) || null;
    if (patch.httpStatus !== undefined) row.httpStatus = number(patch.httpStatus, row.httpStatus);
    if (patch.error !== undefined) row.error = compactError(patch.error);
    for (const [exchangeId, exchange] of openExchanges) if (exchange.requestId === id) openExchanges.delete(exchangeId);
    changed(true);
    try { options.onCallRecord?.(list().find(item => item.requestId === id)); } catch { /* optional diagnostics hook */ }
  }

  function event(id) {
    // Detailed events remain in the conversation transcript. The monitor stores no event payloads.
    return Boolean(records.has(id));
  }

  function beginExchange(request = {}, credentials = []) {
    void credentials;
    const contextId = scope.getStore();
    const requestId = contextId || begin({ kind: 'api', model: request?.body?.model || request?.model });
    const row = records.get(requestId);
    if (!row || row.status !== 'running') return null;
    const model = text(request?.body?.model || request?.model);
    if (model && !row.model) row.model = model;
    row.apiCalls += 1;
    const id = randomUUID();
    openExchanges.set(id, { requestId, startedAt: Date.now() });
    changed();
    return { requestId, id, standalone: !contextId };
  }

  function endExchange(handle, response = {}, error = null) {
    if (!handle?.id) return;
    const exchange = openExchanges.get(handle.id);
    if (!exchange) return;
    openExchanges.delete(handle.id);
    const row = records.get(exchange.requestId);
    if (!row || row.status !== 'running') return;
    const value = response && typeof response === 'object' ? response : {};
    if (value.usage) { row.usage = mergeUsage(row.usage, value.usage); row.usageScope = 'direct-api'; }
    if (value.httpStatus !== undefined) row.httpStatus = number(value.httpStatus, row.httpStatus);
    if (error) row.error = compactError(error);
    changed(false);
    if (handle.standalone) finish(handle.requestId, {
      status: error || value.ok === false ? 'error' : 'completed',
      error: error || (value.ok === false ? value.error || value : null),
      usage: value.usage,
      httpStatus: value.httpStatus
    });
  }

  if (filePath) {
    try {
      if (fs.statSync(filePath).size <= maxBytes * 2) {
        const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        // Version 1 is the old full diagnostic log and is deliberately not restored.
        if (saved.format === FORMAT && saved.version === VERSION && Array.isArray(saved.records)) {
          for (const item of saved.records.slice(-maxRecords)) {
            if (!item?.requestId) continue;
            const row = summaryFrom(item);
            if (row.status === 'running') {
              row.status = 'interrupted';
              row.endedAt = Date.now();
              row.durationMs = Math.max(0, row.endedAt - (row.startedAt || row.endedAt));
            }
            records.set(row.requestId, row);
          }
          enforceLimits(true);
        }
      }
    } catch { /* missing or invalid summary: start clean */ }
  }

  return {
    begin,
    update,
    finish,
    event,
    beginExchange,
    endExchange,
    list,
    flush,
    bundle,
    run: (id, action) => scope.run(id, action),
    clear() { records.clear(); openExchanges.clear(); dropped = 0; changed(true); return true; },
    info: () => ({ revision, count: records.size, dropped, persistent: Boolean(filePath), persistenceError, maxRecords, maxBytes, maxRecordBytes })
  };
}

module.exports = { createCallMonitor };
