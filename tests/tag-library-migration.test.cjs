'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { makeBase, emptyUserDocument } = require('./fixtures/tag-library.cjs');
const { createLibraryRepository } = require('../src/modules/tag-library/repository');
const { createTagLibrary } = require('../src/modules/tag-library/library');
const migration = (() => { try { return require('../src/modules/tag-library/migration'); } catch (e) { if (e.code === 'MODULE_NOT_FOUND') return {}; throw e; } })();
const entry = patch => ({ id: 'f', kind: 'tag', seriesId: 'p', sectionId: 'g', title: '蓝发', zh: '蓝发', rawText: 'blue hair', aliases: [], note: '', globalSearchable: true, pinned: false, nsfw: false, order: 0, sourceTagId: 'blue_hair', sourceCharacterId: null, createdAt: 1, updatedAt: 1, ...patch });
const shelf = entries => ({ format: 'ai-tag-favorites', version: 1, revision: 1, series: [{ id: 'p', name: '旧页', order: 3, color: '#287EA4', colorMode: 'custom' }], sections: [{ id: 'g', seriesId: 'p', name: '旧组', order: 5, color: '#111111' }], entries });
function prepare(values, base = makeBase()) { let n = 0; return migration.prepareLegacyMigration({ base, legacy: { version: 1, values }, ids: p => `${p}-${++n}`, now: () => 100 }); }
async function disk(t, fsImpl) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tag-migration-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'tag-library-v2.json'), backupDir = path.join(dir, 'migration-backups');
  return { dir, filePath, backupDir, repository: createLibraryRepository({ filePath, backupDir, fsImpl }) };
}
test('independent favorite edits preserve content and flags without changing the source', () => {
  assert.equal(typeof migration.prepareLegacyMigration, 'function');
  const r = prepare({ favorites_shelf_v1: shelf([entry({ title: '私人蓝发', zh: '别称', rawText: 'custom blue hair', note: '单独备注', globalSearchable: false, nsfw: true })]) });
  assert.equal(r.ok, true); const d = r.data.document, t = d.customTags[0];
  assert.equal(t.content, 'custom blue hair'); assert.equal(t.note, '单独备注'); assert.equal(t.searchable, false); assert.equal(t.adult, true);
  assert.deepEqual(t.aliases, ['别称']); assert.equal(d.tagOverrides.length, 0); assert.equal(d.favoritePages[0].order, 3); assert.equal(d.favoriteGroups[0].color, '#111111');
});
test('exact compatible favorites link, repeated memberships merge, null sections get a default group', () => {
  const r = prepare({ favorites_shelf_v1: shelf([entry(), entry({ id: 'f2', order: 1 }), entry({ id: 'f3', sectionId: null, order: 2, sourceTagId: null })]) });
  assert.equal(r.ok, true); const d = r.data.document;
  assert.equal(d.customTags.length, 0); assert.equal(d.memberships.length, 2); assert.equal(d.migration.favoriteIdMap.f, d.migration.favoriteIdMap.f2);
  assert.equal(d.memberships[1].tagId, 'blue_hair'); assert.equal(d.favoriteGroups[1].name, '未分类');
});
test('all ten keys retain histories, invalid and oversized rows, selections and both favorite generations', () => {
  const raw = ' (blue hair:1.2),\nlong hair  ';
  const values = { rewrite_custom_tags: [{ id: 'blue_hair', en: 'blue hair', zh: '', aliases: [], category: 'hair', subcategory: '颜色', nsfw: true }, null], rewrite_selected: ['blue_hair', 'missing'],
    rewrite_tag_edit_history_v1: [{ id: 'blue_hair', at: 2 }], rewrite_character_edit_history_v1: [{ id: 'alice', at: 3 }], rewrite_character_edits_v1: { missing: { nameZh: '未知角色' } }, rewrite_character_selection_v1: [{ id: 'bob', includeSeries: false, generalTagIds: ['blue_hair'], specificTagIds: ['specific:uniform'] }],
    favorites_shelf_v1: shelf([entry({ kind: 'bundle', rawText: raw }), entry({ id: 'big', order: 1, rawText: 'a'.repeat(32769) }), entry({ id: 'empty', order: 2, rawText: '' })]),
    favorites_selection_v1: [{ entryId: 'f', kind: 'bundle', rawText: 'old\nbytes', title: '旧快照', nsfw: true, sourceUpdatedAt: 0 }], favorites_recent_v1: ['f', 'missing'], rewrite_favorites: [{ id: 'older', name: '更旧', tags: ['blue_hair', 'long_hair'] }] };
  const r = prepare(values); assert.equal(r.ok, true); const d = r.data.document;
  assert.ok(d.customTags.some(t => t.content === raw && t.kind === 'bundle'));
  assert.ok(d.unresolved.some(u => u.payload?.rawText?.length === 32769)); assert.ok(d.unresolved.some(u => u.reason === 'HISTORY_ARCHIVE'));
  assert.ok(d.unresolved.some(u => u.sourceKey === 'rewrite_favorites')); assert.ok(d.selection.some(s => s.kind === 'legacySnapshot' && s.content === 'old\nbytes' && s.adult));
  assert.ok(d.selection.some(s => s.kind === 'character' && s.characterId === 'bob')); assert.equal(d.tagOverrides[0].patch.displayName, '');
  assert.equal(d.migration.counts.sourceTags, 2); assert.equal(d.migration.counts.sourceFavorites, 4);
});
test('identity, specific and series namespaces map independently and newer explicit character edits win', () => {
  const b = makeBase(); b.tags.find(t => t.id === 'alice').id = 'identity:alice'; b.characterLinks[0].identityTagId = 'identity:alice';
  b.legacyIds.characters.alice = 'identity:alice'; b.legacyIds.specific.uniform = 'specific:uniform'; b.legacyIds.series.story = 'wonderland';
  const r = prepare({ rewrite_custom_tags: [{ id: 'identity:alice', en: 'alice', zh: '较旧', editedAt: 10 }], rewrite_character_edits_v1: { alice: { nameZh: '较新', aliases: [], editedAt: 20, seriesId: 'story', specificTagIds: ['uniform'], tagIds: ['blue_hair'] } }, favorites_shelf_v1: shelf([entry({ sourceTagId: null, sourceCharacterId: 'alice', rawText: 'alice', title: '较新', zh: '较新' })]) }, b);
  assert.equal(r.ok, true); const d = r.data.document;
  assert.equal(d.tagOverrides.find(t => t.tagId === 'identity:alice').patch.displayName, '较新'); assert.equal(d.memberships[0].tagId, 'identity:alice');
  assert.deepEqual(d.characterOverrides[0].specificTagIds, ['specific:uniform']); assert.equal(d.migration.characterIdMap.alice, 'alice');
});
test('strict reader decodes only prefixed keys and rejects malformed relevant JSON/root', async t => {
  assert.equal(typeof migration.readLegacyInput, 'function'); const { dir } = await disk(t), file = path.join(dir, 'rewrite-storage.json');
  await fs.writeFile(file, JSON.stringify({ 'ai-tag-toolbox-rewrite:app:rewrite_selected': '["blue_hair"]', 'ai-tag-toolbox-rewrite:app:apiKey': 'not JSON secret', rewrite_selected: 'wrong namespace' }));
  assert.deepEqual(await migration.readLegacyInput(file), { version: 1, values: { rewrite_selected: ['blue_hair'] } });
  for (const raw of ['[]', '{broken', JSON.stringify({ 'ai-tag-toolbox-rewrite:app:rewrite_selected': '{broken' })]) {
    await fs.writeFile(file, raw); await assert.rejects(async () => migration.readLegacyInput(file), e => e.code === 'INVALID_LEGACY_INPUT');
  }
});
test('ready backs up before save, rechecks source at commit, retries repair, and never remigrates valid v2', async t => {
  const f = await disk(t); let legacy = { version: 1, values: { favorites_shelf_v1: shelf([entry()]) } }, change = true;
  const real = f.repository;
  const repository = { ...real, async backupLegacy(input) { const r = await real.backupLegacy(input); if (change) { change = false; legacy.values.favorites_shelf_v1.entries[0].rawText = 'new bytes'; } return r; } };
  const lib = createTagLibrary({ base: makeBase(), repository, legacyInput: () => structuredClone(legacy) });
  assert.equal((await lib.ready()).error.code, 'LEGACY_CHANGED_DURING_MIGRATION'); assert.equal(await real.read(), null);
  assert.equal((await lib.retryInitialization()).ok, true); assert.equal(lib.getMemberships().length, 1);
  assert.equal(lib.historyState().canUndo, false); assert.ok((await fs.readdir(f.backupDir)).some(n => n.startsWith('legacy-v1-')));
  const again = createTagLibrary({ base: makeBase(), repository: real, legacyInput: () => { throw new Error('must not read legacy'); } });
  assert.equal((await again.ready()).ok, true); assert.equal(again.getMemberships().length, 1);
});
test('backup and save failures never activate an empty library and repaired initialization can retry', async t => {
  for (const mode of ['backup', 'save']) {
    const f = await disk(t); let broken = true; const real = f.repository;
    const repository = { ...real, async backupLegacy(v) { if (broken && mode === 'backup') throw new Error('secret'); return real.backupLegacy(v); }, async save(v, opts) { if (broken && mode === 'save') throw new Error('secret'); return real.save(v, opts); } };
    const lib = createTagLibrary({ base: makeBase(), repository, legacyInput: { version: 1, values: { favorites_shelf_v1: shelf([entry()]) } } });
    assert.equal((await lib.ready()).ok, false); assert.equal(lib.status().writable, false); assert.equal(await real.read(), null);
    broken = false; assert.equal((await lib.retryInitialization()).ok, true); assert.equal(lib.getMemberships().length, 1);
  }
});
test('explicit backup recovery validates references and preserves corrupt bytes, refusing a valid current file', async t => {
  const f = await disk(t), b = makeBase(), doc = emptyUserDocument(b);
  await f.repository.save(doc); await f.repository.save({ ...doc, revision: 1 }); await fs.writeFile(f.filePath, '{corrupt secret bytes');
  const lib = createTagLibrary({ base: b, repository: f.repository }); assert.equal((await lib.ready()).ok, false);
  assert.equal(typeof lib.recoverBackup, 'function'); assert.equal((await lib.recoverBackup()).ok, true);
  const names = await fs.readdir(f.backupDir), archived = names.find(n => n.startsWith('corrupt-v2-'));
  assert.equal(await fs.readFile(path.join(f.backupDir, archived), 'utf8'), '{corrupt secret bytes'); assert.equal(lib.revision(), 0);
  assert.equal((await lib.recoverBackup()).error.code, 'RECOVERY_NOT_ALLOWED');
  await fs.writeFile(f.filePath, '{broken again'); const badBackup = { ...doc, recentTagIds: ['missing'] };
  await fs.writeFile(path.join(f.backupDir, 'tag-library-v2.json.bak'), JSON.stringify(badBackup));
  const bad = createTagLibrary({ base: b, repository: f.repository }); await bad.ready(); assert.equal((await bad.recoverBackup()).ok, false); assert.equal(await fs.readFile(f.filePath, 'utf8'), '{broken again');
});
test('bounded initialization retries do not create a busy recovery loop or overwrite unknown versions', async t => {
  const f = await disk(t); await fs.writeFile(f.filePath, '{"schemaVersion":99}');
  const lib = createTagLibrary({ base: makeBase(), repository: f.repository }); assert.equal((await lib.ready()).error.code, 'UNSUPPORTED_VERSION');
  assert.equal(typeof lib.retryInitialization, 'function');
  for (let i = 0; i < 3; i++) assert.equal((await lib.retryInitialization()).error.code, 'UNSUPPORTED_VERSION');
  assert.equal((await lib.retryInitialization()).error.code, 'RECOVERY_RETRY_LIMIT'); assert.equal(await fs.readFile(f.filePath, 'utf8'), '{"schemaVersion":99}');
});

test('failed favorite rows do not leak mappings or counts and same-ID structures never overwrite', () => {
  const s = shelf([entry(), entry({ id: 'bad', rawText: 'long hair', title: '长发', zh: '长发', sourceTagId: 'long_hair', order: 0 })]);
  s.series.push({ ...s.series[0], name: '不应覆盖' });
  const r = prepare({ favorites_shelf_v1: s }); assert.equal(r.ok, true); const d = r.data.document;
  assert.equal(d.favoritePages[0].name, '旧页'); assert.equal(d.memberships.length, 1);
  assert.equal(d.migration.counts.linkedFavorites, 1); assert.equal(d.migration.favoriteIdMap.bad, undefined);
  assert.ok(d.unresolved.some(u => u.payload?.name === '不应覆盖')); assert.ok(d.unresolved.some(u => u.payload?.id === 'bad'));
});
test('namespace collision never routes specific selections to the ordinary tag with the same legacy ID', () => {
  const b = makeBase(); b.legacyIds.ordinary.blue_hair = 'blue_hair'; b.legacyIds.specific.blue_hair = 'specific:uniform';
  const r = prepare({ rewrite_character_selection_v1: [{ id: 'alice', includeSeries: true, generalTagIds: ['blue_hair'], specificTagIds: ['blue_hair'] }] }, b);
  assert.equal(r.ok, true); assert.equal(r.data.document.selection.length, 1); assert.deepEqual(r.data.document.selection[0].specificTagIds, ['specific:uniform']);
});
test('legacy character-name custom edits use the identity map and ambiguous edit precedence retains both versions', () => {
  const b = makeBase(); b.tags.find(t => t.id === 'alice').id = 'identity:alice'; b.characterLinks[0].identityTagId = 'identity:alice'; b.legacyIds.characters.alice = 'identity:alice';
  const r = prepare({ rewrite_custom_tags: [{ id: 'alice', en: 'alice', zh: '共享名', category: 'character_names', editedAt: 10 }], rewrite_character_edits_v1: { alice: { nameZh: '角色名', aliases: [], editedAt: 10 } } }, b);
  assert.equal(r.ok, true); const d = r.data.document;
  assert.equal(d.customTags.length, 0); assert.equal(d.tagOverrides[0].tagId, 'identity:alice'); assert.equal(d.tagOverrides[0].patch.displayName, '共享名');
  assert.ok(d.unresolved.some(u => u.reason === 'IDENTITY_EDIT_CONFLICT'));
});
test('multi-line and weighted old tag favorites become opaque bundles while punctuation alone remains whole', () => {
  const r = prepare({ favorites_shelf_v1: shelf([entry({ rawText: '(blue hair:1.2), long hair', sourceTagId: null }), entry({ id: 'f2', order: 1, rawText: 'line1\nline2' }), entry({ id: 'f3', order: 2, rawText: 'character (qualifier)', sourceTagId: null })]) });
  assert.equal(r.ok, true); assert.deepEqual(r.data.document.customTags.map(t => [t.kind, t.content]), [['bundle', '(blue hair:1.2), long hair'], ['bundle', 'line1\nline2'], ['tag', 'character (qualifier)']]);
});
test('fingerprint guard runs after staging and rejects a late legacy write with its specific error', async t => {
  let legacy = { version: 1, values: { favorites_shelf_v1: shelf([entry()]) } }, changed = false;
  const f = await disk(t, { open: async (name, flags, mode) => {
    const handle = await fs.open(name, flags, mode);
    if (path.basename(name).startsWith('.tag-library-v2.json.') && !changed) { changed = true; legacy.values.favorites_shelf_v1.entries[0].note = 'late write'; }
    return handle;
  } });
  const lib = createTagLibrary({ base: makeBase(), repository: f.repository, legacyInput: () => structuredClone(legacy) });
  const r = await lib.ready(); assert.equal(r.ok, false); assert.equal(r.error.code, 'LEGACY_CHANGED_DURING_MIGRATION'); assert.equal(await f.repository.read(), null);
});
test('first save cannot replace a valid v2 that appears after initial read', async t => {
  const f = await disk(t), original = emptyUserDocument(); let appeared = false;
  const repository = { ...f.repository, async read() { if (!appeared) { appeared = true; await f.repository.save(original); return null; } return f.repository.read(); } };
  const lib = createTagLibrary({ base: makeBase(), repository }); assert.equal((await lib.ready()).error.code, 'INITIALIZATION_CONFLICT');
  assert.deepEqual(await f.repository.read(), original);
});
test('recovery refuses a repaired valid file and leaves wrong-base backup and unknown versions intact', async t => {
  const f = await disk(t), b = makeBase(), doc = emptyUserDocument(b);
  await f.repository.save(doc); await f.repository.save({ ...doc, revision: 1 }); await fs.writeFile(f.filePath, '{bad');
  const lib = createTagLibrary({ base: b, repository: f.repository }); await lib.ready(); await fs.writeFile(f.filePath, JSON.stringify(doc));
  assert.equal((await lib.recoverBackup()).error.code, 'RECOVERY_NOT_ALLOWED');
  await fs.writeFile(f.filePath, '{bad'); await fs.writeFile(path.join(f.backupDir, 'tag-library-v2.json.bak'), JSON.stringify({ ...doc, baseFingerprint: 'wrong' }));
  assert.equal((await lib.recoverBackup()).ok, false); assert.equal(await fs.readFile(f.filePath, 'utf8'), '{bad');
});
test('old-only structured favorites retain composite output and map selections, nulls remain archived', () => {
  const r = prepare({ rewrite_favorites: [{ id: 'old', name: '组合', tags: ['blue_hair', 'long_hair'] }, null], rewrite_selected: null, rewrite_custom_tags: [{ id: 'bad', en: '', zh: '' }] });
  assert.equal(r.ok, true); const d = r.data.document;
  assert.equal(d.customTags[0].content, 'blue hair, long hair'); assert.equal(d.customTags[0].kind, 'bundle');
  assert.equal(d.migration.counts.sourceFavorites, 2); assert.ok(d.unresolved.some(u => u.payload === null));
});

test('identical independently edited favorites in different groups share one migrated tag', () => {
  const s = shelf([entry({ rawText: 'custom blue', note: '备注' }), entry({ id: 'f2', sectionId: 'g2', rawText: 'custom blue', note: '备注' })]);
  s.sections.push({ id: 'g2', seriesId: 'p', name: '第二组', order: 6, color: '#222222' });
  const r = prepare({ favorites_shelf_v1: s }); assert.equal(r.ok, true);
  assert.equal(r.data.document.customTags.length, 1); assert.equal(r.data.document.memberships.length, 2);
  assert.equal(r.data.document.memberships[0].tagId, r.data.document.memberships[1].tagId);
});
test('recovery write failure leaves corrupt target and valid backup byte-identical and can retry', async t => {
  const f = await disk(t), doc = emptyUserDocument(); await f.repository.save(doc); await f.repository.save({ ...doc, revision: 1 });
  const backupPath = path.join(f.backupDir, 'tag-library-v2.json.bak'), before = await fs.readFile(backupPath); await fs.writeFile(f.filePath, '{bad'); let blocked = true;
  const repository = createLibraryRepository({ filePath: f.filePath, backupDir: f.backupDir, fsImpl: { rename: async (from, to) => { if (blocked && to === f.filePath) throw Object.assign(new Error('busy private'), { code: 'EBUSY' }); return fs.rename(from, to); } } });
  const lib = createTagLibrary({ base: makeBase(), repository }); await lib.ready(); assert.equal((await lib.recoverBackup()).ok, false);
  assert.equal(await fs.readFile(f.filePath, 'utf8'), '{bad'); assert.deepEqual(await fs.readFile(backupPath), before); assert.equal(lib.status().ready, false);
  blocked = false; assert.equal((await lib.recoverBackup()).ok, true);
});
test('recovery serializes requests and no renderer path or replacement document is consumed', async t => {
  const f = await disk(t); let release; const gate = new Promise(r => { release = r; }); let reads = 0;
  const repository = { ...f.repository, async read() { reads++; if (reads === 1) throw Object.assign(new Error('denied'), { code: 'STORAGE_READ_FAILED' }); await gate; return f.repository.read(); } };
  const lib = createTagLibrary({ base: makeBase(), repository }); await lib.ready();
  const retry = lib.retryInitialization({ filePath: 'ignored', document: {} });
  assert.equal((await lib.retryInitialization()).error.code, 'RECOVERY_IN_PROGRESS'); release(); assert.equal((await retry).ok, true);
});

test('failed rows publish neither receipt tag mappings nor aliases after rollback', () => {
  const r = prepare({ favorites_shelf_v1: shelf([entry(), entry({ id: 'bad', rawText: 'long hair', title: '长发', zh: '长发', sourceTagId: 'long_hair', order: 0 })]) });
  assert.equal(r.ok, true); assert.equal(r.data.document.migration.tagIdMap['favorite:bad'], undefined);
});
test('malformed explicit favorite metadata stays unresolved rather than becoming valid defaults', () => {
  const r = prepare({ favorites_shelf_v1: shelf([entry({ aliases: null, note: null, globalSearchable: null })]) });
  assert.equal(r.ok, true); assert.equal(r.data.document.memberships.length, 0);
  assert.ok(r.data.document.unresolved.some(u => u.payload?.aliases === null));
});
