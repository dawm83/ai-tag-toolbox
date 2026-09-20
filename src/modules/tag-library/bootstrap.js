'use strict';
const fs = require('node:fs');
const path = require('node:path');
const api = require('./index');
const PREFIX = 'ai-tag-toolbox-rewrite:app:';
// Validate before createStorage or any eager default-writing consumer exists.
function validateLegacyRoot(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return; throw Object.assign(new Error('旧存储读取失败，原文件已保留'), { code: 'LEGACY_READ_FAILED' }); }
  try {
    const root = JSON.parse(raw);
    if (!root || typeof root !== 'object' || Array.isArray(root)) throw new Error();
    for (const key of api.LEGACY_KEYS) if (Object.hasOwn(root, PREFIX + key)) {
      if (typeof root[PREFIX + key] !== 'string') throw new Error();
      JSON.parse(root[PREFIX + key]);
    }
  } catch { throw Object.assign(new Error('旧存储格式无效，原文件已保留'), { code: 'INVALID_LEGACY_INPUT' }); }
}
const READS = ['status', 'revision', 'getTag', 'listTags', 'search', 'getCategories', 'getSubcategories', 'getFavoritePages', 'getFavoriteGroups', 'getMemberships', 'getCharacterLinks', 'references', 'selected', 'historyState', 'exportBundle', 'exportFile', 'previewImport', 'previewImportFile', 'previewPaste', 'cancelImportPreview', 'getMigrationReport', 'exportMigrationReport', 'exportMigrationFile'];
function createCatalogBootstrap({ userDataDir }) {
  const storagePath = path.join(userDataDir, 'rewrite-storage.json');
  let error;
  try { validateLegacyRoot(storagePath); } catch (e) { error = { code: e.code, message: e.message }; }
  if (error) {
    const failed = () => ({ ok: false, error: { ...error } });
    let pending = false;
    const retry = async () => {
      if (pending) return { ok: false, error: { code: 'RECOVERY_IN_PROGRESS' } };
      pending = true;
      try { validateLegacyRoot(storagePath); return { ok: true, data: { reloadRequired: true } }; }
      catch (e) { error = { code: e.code, message: e.message }; return failed(); }
      finally { pending = false; }
    };
    return { storagePath, blocked: true, catalog: Object.freeze({ ready: async () => failed(), status: () => ({ ready: false, writable: false, error: { ...error } }), execute: async () => failed(), flush: async () => false, subscribe: () => () => {}, retryInitialization: retry, recoverBackup: retry }) };
  }
  const loaded = api.loadBundledBase();
  if (!loaded.ok) throw Object.assign(new Error('内置标签库加载失败'), loaded.error);
  const base = loaded.data;
  const library = api.createTagLibrary({ base, baseUpdates: loaded.baseUpdates, repository: api.createLibraryRepository({ filePath: path.join(userDataDir, 'tag-library-v2.json'), backupDir: path.join(userDataDir, 'tag-library-backups') }), legacyInput: () => api.readLegacyInput(storagePath) });
  const catalog = Object.freeze({ ...Object.fromEntries(READS.map(name => [name, (...args) => library[name](...args)])), ready: () => library.ready(), execute: (command, options) => library.execute(command, options), subscribe: listener => library.subscribe(listener), flush: () => library.flush(), retryInitialization: () => library.retryInitialization(), recoverBackup: () => library.recoverBackup() });
  const characterSource = { characters: base.characterLinks.map(row => { const info = base.characterInfo[row.characterId]; return { id: row.characterId, trigger: info.sourceTrigger, count: info.count, fallback: info.fallback, sourceKey: info.sourceKey, order: info.order }; }), manifest: { fingerprint: base.fingerprint } };
  return { storagePath, base, library, catalog, characterSource, formatTagOutput: api.formatTagOutput };
}
module.exports = { createCatalogBootstrap, validateLegacyRoot };
