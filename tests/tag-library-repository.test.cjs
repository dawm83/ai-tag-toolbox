'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createLibraryRepository } = require('../src/modules/tag-library/repository');
const { makeBase, emptyUserDocument } = require('./fixtures/tag-library.cjs');

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tag-library-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'tag-library-v2.json');
  const backupDir = path.join(dir, 'backups');
  return { dir, filePath, backupDir, document: emptyUserDocument(makeBase()) };
}

function injected(overrides) {
  return { ...fs, ...overrides };
}

test('read returns null only for a missing file and reopens a committed document', async t => {
  const { filePath, backupDir, document } = await fixture(t);
  const repo = createLibraryRepository({ filePath, backupDir });
  assert.equal(await repo.read(), null);
  await repo.save(document);
  assert.deepEqual(await createLibraryRepository({ filePath, backupDir }).read(), document);
});

test('read distinguishes malformed JSON, unsupported schema, malformed v2 shape, and read failures', async t => {
  const { filePath, backupDir, document } = await fixture(t);
  await fs.writeFile(filePath, '{broken', 'utf8');
  await assert.rejects(createLibraryRepository({ filePath, backupDir }).read(), error => error.code === 'INVALID_DOCUMENT');

  await fs.writeFile(filePath, JSON.stringify({ ...document, schemaVersion: 99 }), 'utf8');
  await assert.rejects(createLibraryRepository({ filePath, backupDir }).read(), error => error.code === 'UNSUPPORTED_VERSION');

  const { memberships, ...missingField } = document;
  await fs.writeFile(filePath, JSON.stringify(missingField), 'utf8');
  await assert.rejects(createLibraryRepository({ filePath, backupDir }).read(), error => error.code === 'INVALID_DOCUMENT');

  const malformedNested = structuredClone(document);
  malformedNested.customTags.push({
    id: 'custom', kind: 'tag', content: 'custom', displayName: '', aliases: ['same', 'same'], note: '', adult: false,
    searchable: true, categoryId: 'hair', subcategoryId: 'color', usages: ['general'], source: { kind: 'custom', key: null },
    revision: 0, createdAt: 0, updatedAt: 0
  });
  await fs.writeFile(filePath, JSON.stringify(malformedNested), 'utf8');
  await assert.rejects(createLibraryRepository({ filePath, backupDir }).read(), error => error.code === 'INVALID_DOCUMENT');

  const denied = Object.assign(new Error('private path and sk-secret-value'), { code: 'EACCES' });
  const unreadable = createLibraryRepository({ filePath, backupDir, fsImpl: injected({ readFile: async () => { throw denied; } }) });
  await assert.rejects(unreadable.read(), error => {
    assert.equal(error.code, 'STORAGE_READ_FAILED');
    assert.equal(error.causeCode, 'EACCES');
    assert.doesNotMatch(error.message, /private path|sk-secret-value/);
    return true;
  });
});

test('failed Windows replace retains the original bytes and removes only its own temp', async t => {
  const { dir, filePath, backupDir, document } = await fixture(t);
  const repo = createLibraryRepository({ filePath, backupDir });
  await repo.save(document);
  const originalBytes = await fs.readFile(filePath);
  const stale = path.join(dir, '.tag-library-v2.json.stale.tmp');
  await fs.writeFile(stale, 'keep me');

  const broken = createLibraryRepository({
    filePath,
    backupDir,
    fsImpl: injected({ rename: async (from, to) => {
      if (path.resolve(to) === path.resolve(filePath)) throw Object.assign(new Error('busy secret'), { code: 'EBUSY' });
      return fs.rename(from, to);
    } })
  });
  await assert.rejects(broken.save({ ...document, revision: 1 }), error => {
    assert.equal(error.code, 'STORAGE_WRITE_FAILED');
    assert.equal(error.causeCode, 'EBUSY');
    assert.equal(error.retryable, true);
    assert.doesNotMatch(error.message, /busy secret/);
    return true;
  });
  assert.deepEqual(await fs.readFile(filePath), originalBytes);
  assert.equal(await fs.readFile(stale, 'utf8'), 'keep me');
  const siblingNames = await fs.readdir(dir);
  assert.equal(siblingNames.filter(name => name.endsWith('.tmp') && name !== path.basename(stale)).length, 0);
});

test('ENOSPC before replacement leaves the committed file byte-for-byte unchanged', async t => {
  const { filePath, backupDir, document } = await fixture(t);
  await createLibraryRepository({ filePath, backupDir }).save(document);
  const originalBytes = await fs.readFile(filePath);
  const diskFull = createLibraryRepository({
    filePath,
    backupDir,
    fsImpl: injected({ open: async (name, flags, mode) => {
      if (path.dirname(path.resolve(name)) === path.dirname(path.resolve(filePath)) && flags === 'wx') {
        throw Object.assign(new Error('contains user secret'), { code: 'ENOSPC' });
      }
      return fs.open(name, flags, mode);
    } })
  });
  await assert.rejects(diskFull.save({ ...document, revision: 1 }), error => {
    assert.equal(error.code, 'STORAGE_WRITE_FAILED');
    assert.equal(error.causeCode, 'ENOSPC');
    assert.doesNotMatch(error.message, /user secret/);
    return true;
  });
  assert.deepEqual(await fs.readFile(filePath), originalBytes);
});

test('a staged file is synced and closed before it can become the committed file', async t => {
  const { filePath, backupDir, document } = await fixture(t);
  const state = new Map();
  const ordered = createLibraryRepository({
    filePath,
    backupDir,
    fsImpl: injected({
      open: async (name, flags, mode) => {
        const handle = await fs.open(name, flags, mode);
        if (flags !== 'wx') return handle;
        const key = path.resolve(name);
        const status = { synced: false, closed: false };
        state.set(key, status);
        return {
          writeFile: (...args) => handle.writeFile(...args),
          sync: async () => { await handle.sync(); status.synced = true; },
          close: async () => { await handle.close(); status.closed = true; }
        };
      },
      rename: async (from, to) => {
        const status = state.get(path.resolve(from));
        assert.ok(status?.synced, 'rename observed an unsynced staged file');
        assert.ok(status?.closed, 'rename observed an open staged file');
        return fs.rename(from, to);
      }
    })
  });
  await ordered.save(document);
  assert.deepEqual(await ordered.read(), document);
});

test('each successful replacement preserves the last valid committed bytes in .bak', async t => {
  const { filePath, backupDir, document } = await fixture(t);
  const repo = createLibraryRepository({ filePath, backupDir });
  await repo.save(document);
  const revision0 = await fs.readFile(filePath);
  await repo.save({ ...document, revision: 1 });
  const backupPath = path.join(backupDir, `${path.basename(filePath)}.bak`);
  assert.deepEqual(await fs.readFile(backupPath), revision0);
  const revision1 = await fs.readFile(filePath);
  await repo.save({ ...document, revision: 2 });
  assert.deepEqual(await fs.readFile(backupPath), revision1);
  assert.equal((await createLibraryRepository({ filePath, backupDir }).read()).revision, 2);
});

test('failure replacing .bak preserves both the target and the previous backup', async t => {
  const { filePath, backupDir, document } = await fixture(t);
  const repo = createLibraryRepository({ filePath, backupDir });
  await repo.save(document);
  await repo.save({ ...document, revision: 1 });
  const backupPath = path.join(backupDir, `${path.basename(filePath)}.bak`);
  const targetBefore = await fs.readFile(filePath);
  const backupBefore = await fs.readFile(backupPath);
  const broken = createLibraryRepository({
    filePath,
    backupDir,
    fsImpl: injected({ rename: async (from, to) => {
      if (path.resolve(to) === path.resolve(backupPath)) throw Object.assign(new Error('locked'), { code: 'EBUSY' });
      return fs.rename(from, to);
    } })
  });
  await assert.rejects(broken.save({ ...document, revision: 2 }), error => error.code === 'STORAGE_WRITE_FAILED' && error.causeCode === 'EBUSY');
  assert.deepEqual(await fs.readFile(filePath), targetBefore);
  assert.deepEqual(await fs.readFile(backupPath), backupBefore);
  assert.equal((await repo.read()).revision, 1);
});

test('concurrent saves serialize and a failed save does not poison a retry', async t => {
  const { filePath, backupDir, document } = await fixture(t);
  let releaseFirst;
  let firstRenameReached;
  const firstReached = new Promise(resolve => { firstRenameReached = resolve; });
  const release = new Promise(resolve => { releaseFirst = resolve; });
  let targetRenames = 0;
  const delayed = createLibraryRepository({
    filePath,
    backupDir,
    fsImpl: injected({ rename: async (from, to) => {
      if (path.resolve(to) === path.resolve(filePath)) {
        targetRenames += 1;
        if (targetRenames === 1) { firstRenameReached(); await release; }
      }
      return fs.rename(from, to);
    } })
  });
  const first = delayed.save(document);
  const second = delayed.save({ ...document, revision: 1 });
  await firstReached;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(targetRenames, 1);
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal((await delayed.read()).revision, 1);

  let failOnce = true;
  const retryable = createLibraryRepository({
    filePath,
    backupDir,
    fsImpl: injected({ rename: async (from, to) => {
      if (failOnce && path.resolve(to) === path.resolve(filePath)) {
        failOnce = false;
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      }
      return fs.rename(from, to);
    } })
  });
  await assert.rejects(retryable.save({ ...document, revision: 2 }), error => error.causeCode === 'EBUSY');
  await retryable.save({ ...document, revision: 3 });
  assert.equal((await retryable.read()).revision, 3);
});

test('backup and temporary paths cannot escape the host-supplied library directory', async t => {
  const { dir, filePath } = await fixture(t);
  assert.throws(
    () => createLibraryRepository({ filePath, backupDir: path.resolve(dir, '..', 'outside') }),
    error => error.code === 'INVALID_FIELD'
  );
});

test('backupLegacy uses an exclusive content-addressed backup and excludes unrelated secrets', async t => {
  const { backupDir, filePath } = await fixture(t);
  const repo = createLibraryRepository({ filePath, backupDir });
  const keys = [
    'favorites_shelf_v1', 'favorites_selection_v1', 'favorites_recent_v1', 'rewrite_favorites',
    'rewrite_character_selection_v1', 'rewrite_character_edits_v1', 'rewrite_character_edit_history_v1',
    'rewrite_tag_edit_history_v1', 'rewrite_custom_tags', 'rewrite_selected'
  ];
  const storedKeys = keys.map((key, index) => index % 2 ? `ai-tag-toolbox-rewrite:app:${key}` : key);
  const legacy = {
    version: 1,
    values: {
      ...Object.fromEntries(storedKeys.map((key, index) => [key, { revision: index }])),
      settings: { apiKey: 'sk-do-not-copy' },
      api_key: 'sk-also-do-not-copy',
      sessions: [{ private: 'do-not-copy' }],
      debug_log: 'private log'
    }
  };
  const [first, second] = await Promise.all([repo.backupLegacy(legacy), repo.backupLegacy(legacy)]);
  assert.deepEqual(second, first);
  assert.match(first.id, /^legacy-v1-[0-9a-f]{64}\.json$/);
  const bytes = await fs.readFile(path.join(backupDir, first.id));
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), first.sha256);
  const saved = JSON.parse(bytes);
  assert.deepEqual(Object.keys(saved.values).sort(), storedKeys.sort());
  assert.doesNotMatch(bytes.toString('utf8'), /sk-do-not-copy|sk-also-do-not-copy|do-not-copy|private log/);

  const customChanged = structuredClone(legacy);
  customChanged.values.rewrite_custom_tags = { revision: 999 };
  const selectedKey = 'ai-tag-toolbox-rewrite:app:rewrite_selected';
  const selectedChanged = structuredClone(legacy);
  selectedChanged.values[selectedKey] = { revision: 999 };
  const customBackup = await repo.backupLegacy(customChanged);
  const selectedBackup = await repo.backupLegacy(selectedChanged);
  assert.notEqual(customBackup.sha256, first.sha256);
  assert.notEqual(selectedBackup.sha256, first.sha256);
  assert.notEqual(customBackup.sha256, selectedBackup.sha256);
  assert.equal((await fs.readdir(backupDir)).filter(name => name.startsWith('legacy-v1-')).length, 3);
});

test('a partial exclusive legacy backup is removed so the same backup can be retried', async t => {
  const { backupDir, filePath } = await fixture(t);
  const legacy = { version: 1, values: { favorites_selection_v1: [{ id: 'legacy' }] } };
  let failWrite = true;
  const failing = createLibraryRepository({
    filePath,
    backupDir,
    fsImpl: injected({ open: async (name, flags, mode) => {
      const handle = await fs.open(name, flags, mode);
      if (!failWrite || flags !== 'wx' || !path.basename(name).startsWith('legacy-v1-')) return handle;
      return {
        writeFile: async bytes => {
          await handle.writeFile(Buffer.from(bytes).subarray(0, 8));
          failWrite = false;
          throw Object.assign(new Error('disk full with secret'), { code: 'ENOSPC' });
        },
        sync: () => handle.sync(),
        close: () => handle.close()
      };
    } })
  });
  await assert.rejects(failing.backupLegacy(legacy), error => error.code === 'STORAGE_WRITE_FAILED' && error.causeCode === 'ENOSPC');
  assert.deepEqual(await fs.readdir(backupDir), []);
  const completed = await failing.backupLegacy(legacy);
  assert.equal(crypto.createHash('sha256').update(await fs.readFile(path.join(backupDir, completed.id))).digest('hex'), completed.sha256);
});
