'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { LIMITS } = require('./schema');

const DOCUMENT_FIELDS = [
  'schemaVersion', 'libraryId', 'revision', 'baseFingerprint', 'customTags', 'tagOverrides',
  'customCategories', 'customSubcategories', 'categoryOverrides', 'subcategoryOverrides',
  'favoritePages', 'favoriteGroups', 'memberships', 'characterOverrides', 'selection',
  'recentTagIds', 'migration', 'unresolved'
];
const PATCH_FIELDS = ['kind', 'content', 'displayName', 'aliases', 'note', 'adult', 'searchable', 'categoryId', 'subcategoryId'];
const TAG_FIELDS = ['id', ...PATCH_FIELDS, 'usages', 'source', 'revision', 'createdAt', 'updatedAt'];
const LEGACY_KEYS = new Set([
  'favorites_shelf_v1', 'favorites_selection_v1', 'favorites_recent_v1', 'rewrite_favorites',
  'rewrite_character_selection_v1', 'rewrite_character_edits_v1', 'rewrite_character_edit_history_v1',
  'rewrite_tag_edit_history_v1'
]);
const RETRYABLE_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOSPC', 'EMFILE', 'ENFILE']);
const ERROR_MESSAGES = Object.freeze({
  INVALID_FIELD: 'Invalid tag library repository configuration',
  INVALID_DOCUMENT: 'Tag library document is invalid',
  UNSUPPORTED_VERSION: 'Tag library schema version is unsupported',
  STORAGE_READ_FAILED: 'Tag library could not be read',
  STORAGE_WRITE_FAILED: 'Tag library could not be saved'
});

class LibraryRepositoryError extends Error {
  constructor(code, causeCode) {
    super(ERROR_MESSAGES[code] || 'Tag library repository failed');
    this.name = 'LibraryRepositoryError';
    this.code = code;
    const safeCause = typeof causeCode === 'string' && /^[A-Z0-9_]{1,40}$/.test(causeCode) ? causeCode : null;
    if (safeCause) this.causeCode = safeCause;
    if (code === 'STORAGE_WRITE_FAILED') this.retryable = RETRYABLE_CODES.has(safeCause);
  }
}

function failure(code, causeCode) {
  throw new LibraryRepositoryError(code, causeCode);
}

function wrap(error, code) {
  if (error instanceof LibraryRepositoryError) return error;
  return new LibraryRepositoryError(code, error?.code);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function exactObject(value, required, optional = []) {
  if (!plainObject(value)) failure('INVALID_DOCUMENT');
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (required.some(key => !Object.prototype.hasOwnProperty.call(value, key)) || keys.some(key => !allowed.has(key))) failure('INVALID_DOCUMENT');
}

function text(value, max = LIMITS.name, nonempty = true) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || (nonempty && !value.trim())) failure('INVALID_DOCUMENT');
}

function id(value) { text(value, LIMITS.id); }
function integer(value) { if (!Number.isSafeInteger(value) || value < 0) failure('INVALID_DOCUMENT'); }
function bool(value) { if (typeof value !== 'boolean') failure('INVALID_DOCUMENT'); }
function oneOf(value, allowed) { if (!allowed.includes(value)) failure('INVALID_DOCUMENT'); }
function list(value, max = LIMITS.collection) { if (!Array.isArray(value) || value.length > max) failure('INVALID_DOCUMENT'); }
function stringList(value, allowed = null) {
  list(value);
  for (const item of value) { id(item); if (allowed) oneOf(item, allowed); }
}

function assertJsonSafe(value, seen = new Set(), depth = 0) {
  if (depth > 100) failure('INVALID_DOCUMENT');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) failure('INVALID_DOCUMENT'); return; }
  if (typeof value !== 'object' || seen.has(value)) failure('INVALID_DOCUMENT');
  if (!Array.isArray(value) && !plainObject(value)) failure('INVALID_DOCUMENT');
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key === 'symbol')) failure('INVALID_DOCUMENT');
  for (const descriptor of Object.values(descriptors)) {
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) failure('INVALID_DOCUMENT');
    assertJsonSafe(descriptor.value, seen, depth + 1);
  }
  seen.delete(value);
}

function assertPatch(value, allowed = PATCH_FIELDS) {
  exactObject(value, [], allowed);
  for (const [key, item] of Object.entries(value)) {
    if (key === 'kind') oneOf(item, ['tag', 'bundle']);
    else if (key === 'content') text(item, LIMITS.content);
    else if (key === 'displayName') text(item, LIMITS.name, false);
    else if (key === 'aliases') { list(item, LIMITS.aliases); item.forEach(alias => text(alias)); }
    else if (key === 'note') text(item, LIMITS.note, false);
    else if (key === 'adult' || key === 'searchable') bool(item);
    else id(item);
  }
}

function assertTag(value) {
  exactObject(value, TAG_FIELDS);
  id(value.id);
  assertPatch(Object.fromEntries(PATCH_FIELDS.map(key => [key, value[key]])));
  stringList(value.usages, ['general', 'characterIdentity', 'seriesIdentity', 'characterSpecific']);
  exactObject(value.source, ['kind', 'key']);
  oneOf(value.source.kind, ['bundled', 'custom', 'legacyFavorite']);
  if (value.source.key !== null) text(value.source.key);
  integer(value.revision); integer(value.createdAt); integer(value.updatedAt);
}

function assertCategory(value, child = false) {
  exactObject(value, ['id', 'name', 'order', 'source', ...(child ? ['categoryId'] : [])]);
  id(value.id); text(value.name, LIMITS.structureName); integer(value.order); oneOf(value.source, ['bundled', 'custom']);
  if (child) id(value.categoryId);
}

function assertLinks(value) {
  exactObject(value, ['characterId', 'identityTagId', 'seriesTagIds', 'generalTagIds', 'specificTagIds']);
  id(value.characterId); id(value.identityTagId);
  stringList(value.seriesTagIds); stringList(value.generalTagIds); stringList(value.specificTagIds);
}

function assertSelection(value) {
  if (!plainObject(value)) failure('INVALID_DOCUMENT');
  if (value.kind === 'tag') { exactObject(value, ['kind', 'tagId']); id(value.tagId); return; }
  if (value.kind === 'character') {
    exactObject(value, ['kind', 'characterId', 'includeSeries', 'generalTagIds', 'specificTagIds']);
    id(value.characterId); bool(value.includeSeries); stringList(value.generalTagIds); stringList(value.specificTagIds); return;
  }
  if (value.kind === 'legacySnapshot') {
    exactObject(value, ['kind', 'id', 'content', 'displayName', 'adult']);
    id(value.id); text(value.content, LIMITS.content); text(value.displayName, LIMITS.name, false); bool(value.adult); return;
  }
  failure('INVALID_DOCUMENT');
}

function assertMap(value) {
  if (!plainObject(value)) failure('INVALID_DOCUMENT');
  for (const [key, target] of Object.entries(value)) { id(key); id(target); }
}

function assertDocumentStructure(document) {
  if (!plainObject(document)) failure('INVALID_DOCUMENT');
  if (document.schemaVersion !== 2) failure('UNSUPPORTED_VERSION');
  assertJsonSafe(document);
  exactObject(document, DOCUMENT_FIELDS);
  id(document.libraryId); integer(document.revision); text(document.baseFingerprint);

  list(document.customTags); document.customTags.forEach(assertTag);
  list(document.tagOverrides); document.tagOverrides.forEach(value => {
    exactObject(value, ['tagId', 'patch', 'revision', 'updatedAt']);
    id(value.tagId); assertPatch(value.patch); integer(value.revision); integer(value.updatedAt);
  });
  list(document.customCategories); document.customCategories.forEach(value => assertCategory(value));
  list(document.customSubcategories); document.customSubcategories.forEach(value => assertCategory(value, true));
  for (const field of ['categoryOverrides', 'subcategoryOverrides']) {
    list(document[field]); document[field].forEach(value => {
      exactObject(value, ['id'], ['name', 'order']); id(value.id);
      if (value.name !== undefined) text(value.name, LIMITS.structureName);
      if (value.order !== undefined) integer(value.order);
    });
  }
  list(document.favoritePages); document.favoritePages.forEach(value => {
    exactObject(value, ['id', 'name', 'order', 'color', 'colorMode']);
    id(value.id); text(value.name, LIMITS.structureName); integer(value.order);
    if (typeof value.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(value.color)) failure('INVALID_DOCUMENT');
    oneOf(value.colorMode, ['auto', 'custom']);
  });
  list(document.favoriteGroups); document.favoriteGroups.forEach(value => {
    exactObject(value, ['id', 'pageId', 'name', 'order', 'color']);
    id(value.id); id(value.pageId); text(value.name, LIMITS.structureName); integer(value.order);
    if (typeof value.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(value.color)) failure('INVALID_DOCUMENT');
  });
  list(document.memberships); document.memberships.forEach(value => {
    exactObject(value, ['id', 'tagId', 'groupId', 'order', 'pinned']);
    id(value.id); id(value.tagId); id(value.groupId); integer(value.order); bool(value.pinned);
  });
  list(document.characterOverrides); document.characterOverrides.forEach(assertLinks);
  list(document.selection); document.selection.forEach(assertSelection);
  stringList(document.recentTagIds);
  list(document.unresolved); document.unresolved.forEach(value => {
    exactObject(value, ['id', 'sourceKey', 'sourceId', 'reason', 'payload']);
    id(value.id); text(value.sourceKey); if (value.sourceId !== null) id(value.sourceId); text(value.reason);
  });
  if (document.migration !== null) {
    const value = document.migration;
    exactObject(value, ['id', 'sourceFingerprint', 'completedAt', 'tagIdMap', 'favoriteIdMap', 'characterIdMap', 'counts']);
    id(value.id); text(value.sourceFingerprint); integer(value.completedAt);
    assertMap(value.tagIdMap); assertMap(value.favoriteIdMap); assertMap(value.characterIdMap);
    const countFields = ['sourceTags', 'sourceFavorites', 'linkedFavorites', 'independentFavorites', 'unresolved'];
    exactObject(value.counts, countFields); countFields.forEach(key => integer(value.counts[key]));
  }
  return document;
}

function parseDocument(bytes) {
  let value;
  try { value = JSON.parse(Buffer.from(bytes).toString('utf8')); }
  catch { failure('INVALID_DOCUMENT'); }
  return assertDocumentStructure(value);
}

function serialize(value) {
  assertDocumentStructure(value);
  try { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
  catch { failure('INVALID_DOCUMENT'); }
}

function inside(candidate, directory) {
  const relative = path.relative(directory, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function uniqueTemp(directory, basename) {
  return path.join(directory, `.${basename}.${process.pid}.${crypto.randomUUID()}.tmp`);
}

async function closeHandle(handle, priorError) {
  if (!handle) return;
  try { await handle.close(); }
  catch (error) { if (!priorError) throw error; }
}

async function writeSynced(io, filename, bytes) {
  let handle = null;
  let failureError = null;
  try {
    handle = await io.open(filename, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    failureError = error;
    throw error;
  } finally {
    await closeHandle(handle, failureError);
  }
}

function createLibraryRepository({ filePath, backupDir, fsImpl } = {}) {
  if (typeof filePath !== 'string' || !filePath.trim() || typeof backupDir !== 'string' || !backupDir.trim()) failure('INVALID_FIELD');
  const filename = path.resolve(filePath);
  const libraryDir = path.dirname(filename);
  const backups = path.resolve(backupDir);
  if (!inside(backups, libraryDir)) failure('INVALID_FIELD');
  const io = { ...fs, ...(fsImpl || {}) };
  const backupPath = path.join(backups, `${path.basename(filename)}.bak`);
  let mutationQueue = Promise.resolve();

  function enqueue(operation) {
    const current = mutationQueue.then(operation);
    mutationQueue = current.catch(() => {});
    return current;
  }

  async function removeOwnTemp(temp, directory) {
    if (!temp || !inside(path.resolve(temp), directory)) return;
    try { await io.unlink(temp); } catch { /* The original failure owns the result. */ }
  }

  async function readCurrentBytes() {
    let bytes;
    try { bytes = await io.readFile(filename); }
    catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
    parseDocument(bytes);
    return Buffer.from(bytes);
  }

  async function saveBytes(bytes) {
    let staged = uniqueTemp(libraryDir, path.basename(filename));
    let backupTemp = null;
    try {
      await io.mkdir(libraryDir, { recursive: true });
      await writeSynced(io, staged, bytes);
      const previous = await readCurrentBytes();
      if (previous) {
        await io.mkdir(backups, { recursive: true });
        backupTemp = uniqueTemp(backups, `${path.basename(filename)}.bak`);
        await writeSynced(io, backupTemp, previous);
        await io.rename(backupTemp, backupPath);
        backupTemp = null;
      }
      await io.rename(staged, filename);
      staged = null;
    } catch (error) {
      throw wrap(error, 'STORAGE_WRITE_FAILED');
    } finally {
      await removeOwnTemp(staged, libraryDir);
      await removeOwnTemp(backupTemp, backups);
    }
  }

  function filteredLegacy(input) {
    if (!plainObject(input)) failure('INVALID_DOCUMENT');
    if (input.version !== 1) failure('UNSUPPORTED_VERSION');
    exactObject(input, ['version', 'values']);
    if (!plainObject(input.values)) failure('INVALID_DOCUMENT');
    const descriptors = Object.getOwnPropertyDescriptors(input.values);
    const values = {};
    for (const key of Object.keys(descriptors).sort()) {
      const legacyKey = key.startsWith('ai-tag-toolbox-rewrite:app:') ? key.slice('ai-tag-toolbox-rewrite:app:'.length) : key;
      if (!LEGACY_KEYS.has(legacyKey)) continue;
      const descriptor = descriptors[key];
      if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) failure('INVALID_DOCUMENT');
      values[key] = descriptor.value;
    }
    const backup = { version: 1, values };
    assertJsonSafe(backup);
    return backup;
  }

  async function writeLegacyBackup(bytes, id) {
    const destination = path.join(backups, id);
    let created = false;
    let handle = null;
    try {
      await io.mkdir(backups, { recursive: true });
      try {
        handle = await io.open(destination, 'wx', 0o600);
        created = true;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const existing = await io.readFile(destination);
        if (!Buffer.from(existing).equals(bytes)) throw Object.assign(new Error('backup collision'), { code: 'EEXIST' });
      }
      if (created) {
        let writeError = null;
        try { await handle.writeFile(bytes); await handle.sync(); }
        catch (error) { writeError = error; throw error; }
        finally { await closeHandle(handle, writeError); }
      }
    } catch (error) {
      if (created) { try { await io.unlink(destination); } catch { /* Preserve the original error. */ } }
      throw wrap(error, 'STORAGE_WRITE_FAILED');
    }
  }

  return Object.freeze({
    async read() {
      let bytes;
      try { bytes = await io.readFile(filename); }
      catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw wrap(error, 'STORAGE_READ_FAILED');
      }
      return parseDocument(bytes);
    },
    save(document) {
      let bytes;
      try { bytes = serialize(document); }
      catch (error) { return Promise.reject(wrap(error, 'INVALID_DOCUMENT')); }
      return enqueue(() => saveBytes(bytes));
    },
    backupLegacy(input) {
      let bytes;
      try { bytes = Buffer.from(`${JSON.stringify(filteredLegacy(input), null, 2)}\n`, 'utf8'); }
      catch (error) { return Promise.reject(wrap(error, 'INVALID_DOCUMENT')); }
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      const id = `legacy-v1-${sha256}.json`;
      return enqueue(async () => { await writeLegacyBackup(bytes, id); return { id, sha256 }; });
    }
  });
}

module.exports = { createLibraryRepository, LibraryRepositoryError };
