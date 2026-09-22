'use strict';
const { randomUUID } = require('node:crypto');
const { createLibraryDocumentValidator, validateCommand } = require('./schema');
const { clone, createProjection } = require('./projection');
const { applyLibraryCommand } = require('./commands');
const { applyHistory, changeFor } = require('./history');
const { createTagSearchIndex } = require('./search');
const { createTagMetadataResolver } = require('./tag-metadata');
const { resolveSelection } = require('./selection');
const { prepareLegacyMigration, fingerprintLegacy, filteredInput } = require('./migration');
const { prepareBaseUpdate } = require('./base-update');
const { projectLibraryBundle, prepareImportCandidate, preparePasteBundle, projectMigrationReport, encodeBundle, encodeDataFile, decodeBundle } = require('./transfer');

const fail = (code, message) => ({ ok: false, error: { code, message } });
const FAST_MUTATION_TYPES = new Set(['select', 'clearSelection', 'markCopied']);

// Selection and "recently copied" updates only touch two small arrays.  The
// command validator has already checked the incoming value, and the current
// document was fully validated when it was loaded or structurally edited.  A
// small reference check here keeps those frequent UI operations from walking
// the complete tag, taxonomy and membership graph on every click.
function validateFastMutation(command, candidate, projection, baseFingerprint, previousRevision) {
  const document = candidate?.document;
  if (!document || document.baseFingerprint !== baseFingerprint || document.revision !== previousRevision + 1 ||
    !Array.isArray(document.selection) || !Array.isArray(document.recentTagIds)) {
    return fail('INVALID_DOCUMENT', '标签库数据校验失败');
  }
  if (command.type === 'select' && command.selected) {
    const value = command.value;
    if (value.kind === 'tag') {
      if (!projection?.tag(value.tagId)) return fail('UNRESOLVED_REFERENCE', '选择的标签不存在');
    } else if (value.kind === 'character') {
      const links = projection?.characters?.get(value.characterId);
      if (!links) return fail('UNRESOLVED_REFERENCE', '选择的角色不存在');
      for (const field of ['generalTagIds', 'specificTagIds']) {
        const available = new Set(links[field]);
        if (value[field].some(id => !available.has(id))) return fail('UNRESOLVED_REFERENCE', '角色选择包含不存在的特征');
      }
    }
  }
  return { ok: true, data: document };
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
function createTagLibrary({ base, repository, legacyInput, baseUpdates = [], ids = prefix => `${prefix}:${randomUUID()}`, now = Date.now }) {
  const preparedBase = createLibraryDocumentValidator(base);
  const immutableBase = preparedBase.base;
  const knownBaseUpdates = clone(baseUpdates);
  let current = null, projection = null, queue = Promise.resolve(), initialized = false, closing = false, disposed = false, statusError = null;
  let lastWriteSucceeded = true;
  let validateDocument;
  const listeners = new Set(), operations = new Map(), undo = [], redo = [];
  let recoveryPending = false;
  let importPreview = null;
  const readLegacy = async () => filteredInput(typeof legacyInput === 'function' ? await legacyInput() : legacyInput);
  async function initialize() {
    const validBase = preparedBase;
    if (!validBase.ok) { statusError = validBase.error; return validBase; }
    validateDocument = validBase.data;
    try {
      const loaded = await repository.read();
      let candidate = loaded === null ? emptyDocument(immutableBase, ids) : clone(loaded), source = null;
      const updated = loaded === null ? null : prepareBaseUpdate(candidate, immutableBase.fingerprint, knownBaseUpdates);
      if (updated) candidate = updated;
      if (loaded === null && legacyInput !== undefined) {
        source = await readLegacy();
        await repository.backupLegacy(clone(source));
        const prepared = prepareLegacyMigration({ base: immutableBase, legacy: source, ids, now });
        if (!prepared.ok) { statusError = prepared.error; return prepared; }
        candidate = prepared.data.document;
      }
      const checked = validateDocument(candidate);
      if (!checked.ok) { statusError = checked.error; return checked; }
      if (updated) await repository.save(clone(candidate));
      if (loaded === null) {
        const beforeCommit = source ? async () => {
          if (fingerprintLegacy(await readLegacy()) !== candidate.migration.sourceFingerprint) {
            const error = new Error('迁移期间旧数据发生变化，请关闭旧版后重试'); error.code = 'LEGACY_CHANGED_DURING_MIGRATION'; throw error;
          }
        } : undefined;
        if (beforeCommit) await beforeCommit();
        await repository.save(clone(candidate), { expectMissing: true, beforeCommit });
      }
      current = candidate; projection = createProjection(current, immutableBase); searchIndex.invalidate(); metadataResolver.invalidate(); initialized = true;
      statusError = null; lastWriteSucceeded = true;
      return { ok: true, data: { migration: clone(current.migration) }, revision: current.revision };
    } catch (error) {
      const code = ['INVALID_DOCUMENT', 'UNSUPPORTED_VERSION', 'STORAGE_READ_FAILED', 'INVALID_LEGACY_INPUT', 'LEGACY_READ_FAILED', 'LEGACY_CHANGED_DURING_MIGRATION', 'INITIALIZATION_CONFLICT', 'STORAGE_WRITE_FAILED'].includes(error?.code) ? error.code : 'STORAGE_WRITE_FAILED';
      lastWriteSucceeded = false; statusError = fail(code, '标签库初始化未完成，请检查来源或恢复备份').error;
      return { ok: false, error: statusError };
    }
  }
  const searchIndex = createTagSearchIndex({ getTags: () => projection?.tags() || [], getMemberships: () => current?.memberships || [], getCharacterLinks: () => projection?.characters.values() || [], getStructure: () => ({ pages: current?.favoritePages || [], groups: current?.favoriteGroups || [] }),
    getMetadata: () => immutableBase.metadataById || {}, getTaxonomy: () => ({ categories: projection?.categories.values() || [], subcategories: projection?.subcategories.values() || [] }) });
  const metadataResolver = createTagMetadataResolver({ getTags: () => projection?.tags() || [], getOverrides: () => current?.tagOverrides || [], isReady: () => initialized });
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
        try { await repository.recoverBackup({ validate: candidate => validateDocument(prepareBaseUpdate(candidate, immutableBase.fingerprint, knownBaseUpdates) || candidate) }); }
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
    if (command.type === 'applyImport') {
      if (importPreview && now() - importPreview.createdAt > 15 * 60 * 1000) importPreview = null;
      if (!importPreview || importPreview.preview.id !== command.previewId) return fail('IMPORT_PREVIEW_NOT_FOUND', '导入预览已取消或过期，请重新预览');
      if (importPreview.preview.basedOnRevision !== current.revision) return fail('REVISION_CONFLICT', '预览后标签库已改变，请重新预览');
    }
    const historyDirection = command.type === 'undo' ? 'before' : command.type === 'redo' ? 'after' : null;
    let prepared;
    if (command.type === 'applyImport') prepared = { ok: true, data: { ...importPreview, result: { changed: importPreview.historyDelta.length > 0 } } };
    else if (historyDirection) {
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
      if (command.type === 'applyImport') importPreview = null;
      operations.set(options.operationId, { fingerprint, result: clone(result) }); return result;
    }
    // Selection/recent-copy commands are high-frequency UI mutations. They
    // only change local arrays and have already passed command/reference
    // checks in applyLibraryCommand, so avoid re-validating the entire library
    // graph for every click. Structural edits still use the full validator.
    const checked = FAST_MUTATION_TYPES.has(command.type)
      ? validateFastMutation(command, candidate, projection, immutableBase.fingerprint, current.revision)
      : validateDocument(candidate.document);
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
    if (command.type === 'applyImport') importPreview = null;
    searchIndex.invalidate(candidate.change);
    metadataResolver.invalidate(candidate.change);
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
    return clone({ ...searchIndex.search(query, options), revision: revision() });
  }
  const sorted = rows => clone([...rows].sort((a, b) => a.order - b.order));
  function previewImport(bundle) {
    if (!state().writable) return fail('NOT_READY', '标签库尚未就绪');
    const prepared = prepareImportCandidate({ base: immutableBase, document: current, bundle, ids, now });
    if (!prepared.ok) return prepared;
    const checked = validateDocument(prepared.data.document); if (!checked.ok) return checked;
    importPreview = { ...prepared.data, createdAt: now() };
    return { ok: true, data: clone(importPreview.preview), revision: current.revision };
  }
  function exportBundle(options = {}) { return initialized && !disposed ? projectLibraryBundle({ base: immutableBase, document: current, scope: options.scope ?? 'all' }) : fail('NOT_READY', '标签库尚未就绪'); }
  return Object.freeze({
    ready: async () => clone(await initialization), status: state, revision,
    retryInitialization: () => recover('retry'), recoverBackup: () => recover('backup'),
    getTag: id => projection ? clone(projection.view(id)) : null,
    describeTags: (values, options) => metadataResolver.describe(values, options),
    listTags: options => queryPage(options), search: (query, options) => queryPage(options, String(query ?? '')),
    getTagIds: options => searchIndex.ids(options),
    tagCounts: options => clone(searchIndex.counts(Boolean(options?.includeAdult))),
    getCategories: () => sorted(projection?.categories.values() || []),
    getSubcategories: categoryId => sorted([...(projection?.subcategories.values() || [])].filter(row => row.categoryId === categoryId)),
    getFavoritePages: () => sorted(current?.favoritePages || []),
    getFavoriteGroups: pageId => sorted((current?.favoriteGroups || []).filter(row => row.pageId === pageId)),
    getMemberships: tagId => clone((current?.memberships || []).filter(row => tagId === undefined || row.tagId === tagId)),
    getRecentTagIds: () => clone(current?.recentTagIds || []),
    getCharacterLinks: id => clone(projection?.characters.get(id) || null),
    references: tagId => projection ? clone(projection.references(tagId)) : [],
    selected: options => projection ? resolveSelection(current.selection, projection, options) : [],
    execute,
    exportBundle, previewImport,
    exportFile(options) { const bundle = exportBundle(options); return bundle.ok === false ? bundle : encodeBundle(bundle); },
    previewImportFile(input) { const decoded = decodeBundle(input); return decoded.ok ? previewImport(decoded.data) : decoded; },
    previewPaste(text, options) { if (!state().writable) return fail('NOT_READY', '标签库尚未就绪'); const prepared = preparePasteBundle({ document: current, text, options, ids, now }); return prepared.ok ? previewImport(prepared.data) : prepared; },
    cancelImportPreview(id) { if (importPreview?.preview.id === id) importPreview = null; return { ok: true, data: { canceled: true }, revision: revision() }; },
    getMigrationReport: options => current ? clone(projectMigrationReport(current, options)) : null,
    exportMigrationReport: () => current ? clone({ format: 'ai-tag-migration-report', version: 1, receipt: current.migration, unresolved: current.unresolved }) : fail('NOT_READY', '标签库尚未就绪'),
    exportMigrationFile: () => current ? encodeDataFile({ format: 'ai-tag-migration-report', version: 1, receipt: current.migration, unresolved: current.unresolved }, 'ai-tag-migration-report') : fail('NOT_READY', '标签库尚未就绪'),
    subscribe(fn) { if (typeof fn !== 'function') throw new TypeError('订阅者必须是函数'); listeners.add(fn); return () => listeners.delete(fn); },
    historyState: () => ({ canUndo: undo.length > 0, canRedo: redo.length > 0 }),
    async flush() { await initialization; await queue; return initialized && lastWriteSucceeded; },
    async dispose() { closing = true; await initialization; await queue; importPreview = null; listeners.clear(); disposed = true; }
  });
}
module.exports = { createTagLibrary };
