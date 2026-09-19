'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { validateLibraryDocumentStructure } = require('./schema');

const LEGACY_KEYS = new Set([
  'favorites_shelf_v1', 'favorites_selection_v1', 'favorites_recent_v1', 'rewrite_favorites',
  'rewrite_character_selection_v1', 'rewrite_character_edits_v1', 'rewrite_character_edit_history_v1',
  'rewrite_tag_edit_history_v1', 'rewrite_custom_tags', 'rewrite_selected'
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
  if (['LEGACY_CHANGED_DURING_MIGRATION', 'INVALID_LEGACY_INPUT', 'LEGACY_READ_FAILED'].includes(error?.code)) return new LibraryRepositoryError(error.code);
  return new LibraryRepositoryError(code, error?.code);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
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

function parseDocument(bytes) {
  let value;
  try { value = JSON.parse(Buffer.from(bytes).toString('utf8')); }
  catch { failure('INVALID_DOCUMENT'); }
  return validatedDocument(value);
}

function serialize(value) {
  validatedDocument(value);
  try { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
  catch { failure('INVALID_DOCUMENT'); }
}

function validatedDocument(value) {
  let checked;
  try { checked = validateLibraryDocumentStructure(value); }
  catch { failure('INVALID_DOCUMENT'); }
  if (!checked.ok) failure(checked.error.code === 'UNSUPPORTED_VERSION' ? 'UNSUPPORTED_VERSION' : 'INVALID_DOCUMENT');
  return checked.data;
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

  async function saveBytes(bytes, options = {}) {
    let staged = uniqueTemp(libraryDir, path.basename(filename));
    let backupTemp = null;
    try {
      await io.mkdir(libraryDir, { recursive: true });
      await writeSynced(io, staged, bytes);
      const previous = await readCurrentBytes();
      if (options.expectMissing && previous) failure('INITIALIZATION_CONFLICT');
      if (previous) {
        await io.mkdir(backups, { recursive: true });
        backupTemp = uniqueTemp(backups, `${path.basename(filename)}.bak`);
        await writeSynced(io, backupTemp, previous);
        await io.rename(backupTemp, backupPath);
        backupTemp = null;
      }
      if (options.beforeCommit) await options.beforeCommit();
      if (options.expectMissing) {
        // Exclusive creation also prevents a concurrently created valid v2 from being replaced.
        try { await io.link(staged, filename); }
        catch (error) { if (error?.code === 'EEXIST') failure('INITIALIZATION_CONFLICT'); throw error; }
        await removeOwnTemp(staged, libraryDir);
      } else await io.rename(staged, filename);
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
    if (Object.keys(input).length !== 2 || !Object.prototype.hasOwnProperty.call(input, 'version') || !Object.prototype.hasOwnProperty.call(input, 'values')) failure('INVALID_DOCUMENT');
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
    save(document, options = {}) {
      let bytes;
      try { bytes = serialize(document); }
      catch (error) { return Promise.reject(wrap(error, 'INVALID_DOCUMENT')); }
      return enqueue(() => saveBytes(bytes, options));
    },
    recoverBackup({ validate } = {}) {
      if (typeof validate !== 'function') return Promise.reject(new LibraryRepositoryError('INVALID_FIELD'));
      return enqueue(async () => {
        let staged = null;
        try {
          const original = Buffer.from(await io.readFile(filename));
          let existing;
          try { existing = parseDocument(original); }
          catch (e) { if (e.code === 'UNSUPPORTED_VERSION') throw e; if (e.code !== 'INVALID_DOCUMENT') throw e; }
          if (existing && validate(existing).ok) failure('RECOVERY_NOT_ALLOWED');
          const bytes = Buffer.from(await io.readFile(backupPath)), candidate = parseDocument(bytes);
          const checked = validate(candidate);
          if (!checked.ok) failure('INVALID_DOCUMENT');
          // Preserve the bad original before replacing it; the last good .bak stays intact.
          const id = `corrupt-v2-${crypto.createHash('sha256').update(original).digest('hex')}.bin`;
          await writeLegacyBackup(original, id);
          staged = uniqueTemp(libraryDir, path.basename(filename));
          await writeSynced(io, staged, bytes);
          if (!Buffer.from(await io.readFile(filename)).equals(original)) failure('RECOVERY_SOURCE_CHANGED');
          await io.rename(staged, filename); staged = null;
          return { document: candidate, preservedOriginalId: id };
        } catch (e) { throw wrap(e, 'STORAGE_WRITE_FAILED'); }
        finally { await removeOwnTemp(staged, libraryDir); }
      });
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

module.exports = { createLibraryRepository, LibraryRepositoryError, LEGACY_KEYS: Object.freeze([...LEGACY_KEYS]) };
