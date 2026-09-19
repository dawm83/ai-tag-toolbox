'use strict';
const { randomUUID } = require('node:crypto');
const { createLibraryDocumentValidator, validateCommand } = require('./schema');
const { clone, createProjection } = require('./projection');
const { applyLibraryCommand } = require('./commands');
const { applyHistory, changeFor } = require('./history');
const { resolveSelection } = require('./selection');
const { prepareLegacyMigration, fingerprintLegacy, filteredInput } = require('./migration');

const fail = (code, message) => ({ ok: false, error: { code, message } });
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function emptyDocument(base, ids) {
  return { schemaVersion: 2, libraryId: ids('library'), revision: 0, baseFingerprint: base.fingerprint,
    customTags: [], tagOverrides: [], customCategories: [], customSubcategories: [], categoryOverrides: [], subcategoryOverrides: [],
    favoritePages: [], favoriteGroups: [], memberships: [], characterOverrides: [], selection: [], recentTagIds: [], migration: null, unresolved: [] };
}

/** One authoritative, queued, durable user overlay over a private immutable base. */
function createTagLibrary({ base, repository, legacyInput, ids = prefix => `${prefix}:${randomUUID()}`, now = Date.now }) {
  const immutableBase = freeze(clone(base));
  let current = null, projection = null, queue = Promise.resolve(), initialized = false, closing = false, disposed = false, statusError = null;
  let lastWriteSucceeded = true;
  let validateDocument;
  const listeners = new Set(), operations = new Map(), undo = [], redo = [];
  let recoveryPending = false;
  const readLegacy = async () => filteredInput(typeof legacyInput === 'function' ? await legacyInput() : legacyInput);
  async function initialize() {
    const validBase = createLibraryDocumentValidator(immutableBase);
    if (!validBase.ok) { statusError = validBase.error; return validBase; }
    validateDocument = validBase.data;
    try {
      const loaded = await repository.read();
      let candidate = loaded === null ? emptyDocument(immutableBase, ids) : clone(loaded), source = null;
      if (loaded === null && legacyInput !== undefined) {
        source = await readLegacy();
        await repository.backupLegacy(clone(source));
        const prepared = prepareLegacyMigration({ base: immutableBase, legacy: source, ids, now });
        if (!prepared.ok) { statusError = prepared.error; return prepared; }
        candidate = prepared.data.document;
      }
      const checked = validateDocument(candidate);
      if (!checked.ok) { statusError = checked.error; return checked; }
      if (loaded === null) {
        const beforeCommit = source ? async () => {
          if (fingerprintLegacy(await readLegacy()) !== candidate.migration.sourceFingerprint) {
            const error = new Error('迁移期间旧数据发生变化，请关闭旧版后重试'); error.code = 'LEGACY_CHANGED_DURING_MIGRATION'; throw error;
          }
        } : undefined;
        if (beforeCommit) await beforeCommit();
        await repository.save(clone(candidate), { expectMissing: true, beforeCommit });
      }
      current = candidate; projection = createProjection(current, immutableBase); initialized = true;
      statusError = null; lastWriteSucceeded = true;
      return { ok: true, data: { migration: clone(current.migration) }, revision: current.revision };
    } catch (error) {
      const code = ['INVALID_DOCUMENT', 'UNSUPPORTED_VERSION', 'STORAGE_READ_FAILED', 'INVALID_LEGACY_INPUT', 'LEGACY_READ_FAILED', 'LEGACY_CHANGED_DURING_MIGRATION', 'INITIALIZATION_CONFLICT', 'STORAGE_WRITE_FAILED'].includes(error?.code) ? error.code : 'STORAGE_WRITE_FAILED';
      lastWriteSucceeded = false; statusError = fail(code, '标签库初始化未完成，请检查来源或恢复备份').error;
      return { ok: false, error: statusError };
    }
  }
  let initialization = initialize();
  async function recover(mode) {
    if (recoveryPending) return fail('RECOVERY_IN_PROGRESS', '正在恢复标签库');
    if (closing || disposed) return fail('NOT_READY', '标签库已关闭');
    recoveryPending = true;
    try {
      await initialization; await queue;
      if (initialized) return mode === 'retry' ? clone(await initialization) : fail('RECOVERY_NOT_ALLOWED', '有效标签库不能用备份覆盖');
      if (mode === 'backup') {
        if (!validateDocument || typeof repository.recoverBackup !== 'function') return fail('RECOVERY_NOT_AVAILABLE', '此存储不支持备份恢复');
        try { await repository.recoverBackup({ validate: validateDocument }); }
        catch (e) {
          const code = ['INVALID_DOCUMENT', 'UNSUPPORTED_VERSION', 'RECOVERY_NOT_ALLOWED', 'RECOVERY_SOURCE_CHANGED', 'STORAGE_WRITE_FAILED'].includes(e?.code) ? e.code : 'STORAGE_WRITE_FAILED';
          statusError = fail(code, '备份恢复未完成，原文件已保留').error; return { ok: false, error: clone(statusError) };
        }
      }
      initialization = initialize(); return clone(await initialization);
    } finally { recoveryPending = false; }
  }
  function state() { return { ready: initialized && !disposed, writable: initialized && !closing && !disposed, error: clone(statusError) }; }
  const revision = () => current?.revision ?? 0;
  function publish(change) {
    for (const listener of listeners) {
      try { listener(clone(change)); } catch { /* Observers cannot roll back a durable commit or poison the queue. */ }
    }
  }
  async function commit(command, options) {
    await initialization;
    if (!initialized) return fail('NOT_READY', '标签库尚未就绪');
    const fingerprint = canonical(command), previousOperation = operations.get(options.operationId);
    if (previousOperation && previousOperation.fingerprint !== fingerprint) return fail('OPERATION_CONFLICT', '操作 ID 已用于不同内容');
    if (previousOperation?.result) return clone(previousOperation.result);
    operations.set(options.operationId, { fingerprint });
    if (options.expectedRevision !== undefined && options.expectedRevision !== current.revision) return fail('REVISION_CONFLICT', '标签库已有新版本，请重新载入');
    if (command.type === 'applyImport') return fail('FEATURE_UNAVAILABLE', '导入功能尚未接入');
    const historyDirection = command.type === 'undo' ? 'before' : command.type === 'redo' ? 'after' : null;
    let prepared;
    if (historyDirection) {
      const stack = historyDirection === 'before' ? undo : redo, delta = stack.at(-1);
      if (!delta) prepared = { ok: true, data: { document: current, result: { changed: false } } };
      else {
        const document = applyHistory(current, delta, historyDirection);
        prepared = { ok: true, data: { document, result: { changed: true }, historyDelta: delta, change: changeFor(current, document, immutableBase) } };
      }
    } else prepared = applyLibraryCommand(current, immutableBase, command, { ids, now });
    if (!prepared.ok) return prepared;
    const candidate = prepared.data;
    if (!candidate.result.changed) {
      const result = { ok: true, data: candidate.result, revision: current.revision };
      operations.set(options.operationId, { fingerprint, result: clone(result) }); return result;
    }
    const checked = validateDocument(candidate.document);
    if (!checked.ok) return checked;
    try { await repository.save(clone(checked.data)); }
    catch { lastWriteSucceeded = false; return fail('STORAGE_WRITE_FAILED', '标签库保存失败，草稿尚未提交，可重试'); }
    lastWriteSucceeded = true;
    current = checked.data; projection = createProjection(current, immutableBase);
    if (historyDirection) {
      const from = historyDirection === 'before' ? undo : redo, to = historyDirection === 'before' ? redo : undo;
      to.push(from.pop());
    } else if (!['select', 'clearSelection', 'markCopied'].includes(command.type) && candidate.historyDelta.length) {
      undo.push(candidate.historyDelta); if (undo.length > 30) undo.shift(); redo.length = 0;
    }
    const result = { ok: true, data: candidate.result, revision: current.revision };
    operations.set(options.operationId, { fingerprint, result: clone(result) });
    publish(candidate.change);
    return result;
  }
  function execute(command, options) {
    if (closing || disposed) return Promise.resolve(fail('NOT_READY', '标签库已关闭'));
    if (!options || typeof options.operationId !== 'string' || !options.operationId.trim() || options.operationId.length > 1024 ||
      (options.expectedRevision !== undefined && (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0))) return Promise.resolve(fail('INVALID_FIELD', '操作选项无效'));
    const checked = validateCommand(command); if (!checked.ok) return Promise.resolve(checked);
    const input = clone(command), execution = { operationId: options.operationId, expectedRevision: options.expectedRevision };
    const work = queue.then(() => commit(input, execution));
    // Convert unexpected adapter failures without allowing a rejected queue to block later work.
    const safe = work.catch(() => fail('COMMAND_FAILED', '标签库操作未完成'));
    queue = safe.then(() => undefined); return safe;
  }
  function queryPage(options = {}, query = null) {
    const { scope = 'all', includeAdult = false, categoryId, subcategoryId, pageId, groupId, characterId, precision = 'standard' } = options;
    const offset = Number.isSafeInteger(options.offset) && options.offset >= 0 ? options.offset : 0;
    const limit = Number.isSafeInteger(options.limit) && options.limit >= 0 ? Math.min(options.limit, 2000) : 100;
    const matches = []; const identities = new Map(); let allowed = null;
    if (projection) {
      if (scope === 'favorites') {
        const rows = current.memberships.filter(m => (!groupId || m.groupId === groupId) && (!pageId || projection.groups.get(m.groupId)?.pageId === pageId));
        rows.sort((a, b) => projection.pages.get(projection.groups.get(a.groupId).pageId).order - projection.pages.get(projection.groups.get(b.groupId).pageId).order || projection.groups.get(a.groupId).order - projection.groups.get(b.groupId).order || a.order - b.order);
        allowed = new Set(rows.map(row => row.tagId));
      } else if (scope === 'characters') {
        allowed = new Set(); for (const links of projection.characters.values()) if (!characterId || characterId === links.characterId) { allowed.add(links.identityTagId); identities.set(links.identityTagId, links.characterId); }
      } else if (scope === 'characterTraits') {
        allowed = new Set(); for (const links of projection.characters.values()) if (!characterId || characterId === links.characterId) for (const id of [...links.generalTagIds, ...links.specificTagIds]) allowed.add(id);
      } else if (scope !== 'all') allowed = new Set();
      const normalize = value => value.toLocaleLowerCase('en-US').replace(/_/g, ' ').trim();
      const needle = query === null ? null : normalize(String(query));
      const rows = allowed ? [...allowed].map(id => projection.tag(id)).filter(Boolean) : projection.tags();
      for (const row of rows) {
        if ((!includeAdult && row.adult) || (categoryId && row.categoryId !== categoryId) || (subcategoryId && row.subcategoryId !== subcategoryId)) continue;
        if (needle !== null) {
          if (!row.searchable) continue;
          const fields = [row.content, row.displayName, ...row.aliases, ...(precision === 'broad' ? [row.note] : [])].map(normalize);
          if (needle && !fields.some(value => precision === 'exact' ? value === needle : value.includes(needle))) continue;
        }
        matches.push(row.id);
      }
    }
    return { items: matches.slice(offset, offset + limit).map(id => clone({ ...projection.view(id), ...(identities.has(id) ? { characterId: identities.get(id) } : {}) })), total: matches.length, offset, limit, hasMore: offset + limit < matches.length, revision: revision() };
  }
  const sorted = rows => clone([...rows].sort((a, b) => a.order - b.order));
  return Object.freeze({
    ready: async () => clone(await initialization), status: state, revision,
    retryInitialization: () => recover('retry'), recoverBackup: () => recover('backup'),
    getTag: id => projection ? clone(projection.view(id)) : null,
    listTags: options => queryPage(options), search: (query, options) => queryPage(options, query),
    getCategories: () => sorted(projection?.categories.values() || []),
    getSubcategories: categoryId => sorted([...(projection?.subcategories.values() || [])].filter(row => row.categoryId === categoryId)),
    getFavoritePages: () => sorted(current?.favoritePages || []),
    getFavoriteGroups: pageId => sorted((current?.favoriteGroups || []).filter(row => row.pageId === pageId)),
    getMemberships: tagId => clone((current?.memberships || []).filter(row => tagId === undefined || row.tagId === tagId)),
    getCharacterLinks: id => clone(projection?.characters.get(id) || null),
    references: tagId => projection ? clone(projection.references(tagId)) : [],
    selected: options => projection ? resolveSelection(current.selection, projection, options) : [],
    execute,
    exportBundle: () => fail('FEATURE_UNAVAILABLE', '导出功能尚未接入'),
    previewImport: () => fail('FEATURE_UNAVAILABLE', '导入功能尚未接入'),
    subscribe(fn) { if (typeof fn !== 'function') throw new TypeError('订阅者必须是函数'); listeners.add(fn); return () => listeners.delete(fn); },
    historyState: () => ({ canUndo: undo.length > 0, canRedo: redo.length > 0 }),
    async flush() { await initialization; await queue; return initialized && lastWriteSucceeded; },
    async dispose() { closing = true; await initialization; await queue; listeners.clear(); disposed = true; }
  });
}
module.exports = { createTagLibrary };
