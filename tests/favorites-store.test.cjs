'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createFavorites } = require('../src/modules/favorites');
const { createLibraryRepository } = require('../src/modules/tag-library/repository');
const { prepareLegacyMigration } = require('../src/modules/tag-library/migration');
const { createHarness, makeBase, emptyUserDocument } = require('./fixtures/tag-library.cjs');
const { createUnifiedFixture, addFavoriteLocation } = require('./fixtures/unified-modules.cjs');
const make = createUnifiedFixture;
const entry = async (favorites, location, rawText, patch = {}) => {
  const result = await favorites.saveEntry({ seriesId: location.seriesId, sectionId: location.sectionId, rawText, ...patch });
  assert.equal(result.ok, true, JSON.stringify(result.error)); return result.data;
};
async function migrated(values, base = makeBase()) {
  let sequence = 0;
  const prepared = prepareLegacyMigration({ base, legacy: { version: 1, values }, ids: prefix => prefix + ':legacy-' + ++sequence, now: () => 100 });
  assert.equal(prepared.ok, true, JSON.stringify(prepared.error));
  const h = await make({ base, document: prepared.data.document });
  return { ...h, report: prepared.data.report };
}

test('free input persists and copies rawText byte-for-byte from the shared tag', async () => {
  const h = await make(), { favorites, tags } = h;
  const place = await addFavoriteLocation(favorites);
  const rawText = '  (light:1.2), blue_hair\nescaped\\(detail\\)  ';
  const row = await entry(favorites, place, rawText, { kind: 'bundle', title: '组合' });
  assert.equal(favorites.copyText([row.id]), rawText);
  assert.equal(tags.get(row.tagId).content, rawText);
  assert.equal((await h.reopen()).favorites.getEntry(row.id).rawText, rawText);
  assert.equal((await favorites.saveEntry({ id: row.id, rawText: '   ' })).ok, false);
  assert.equal(favorites.getEntry(row.id).rawText, rawText);
});

test('CRUD validates parents, preserves stable IDs, and commits explicit copies and batches once', async () => {
  const { favorites } = await make(), events = [];
  const a = await addFavoriteLocation(favorites, 'A'), b = await addFavoriteLocation(favorites, 'B');
  assert.notEqual(a.series.color, b.series.color);
  favorites.subscribe(value => events.push(value));
  const first = await entry(favorites, a, 'x');
  assert.equal((await favorites.saveEntry({ seriesId: a.seriesId, sectionId: a.sectionId, rawText: 'x' })).ok, false);
  const copied = await favorites.duplicateEntries({ ids: [first.id], mode: 'independent' });
  assert.equal(copied.ok, true);
  const second = favorites.getEntry(copied.data.ids[0]);
  assert.notEqual(second.tagId, first.tagId);
  assert.equal((await favorites.saveEntry({ id: first.id, title: 'renamed' })).data.id, first.id);
  assert.equal((await favorites.saveEntry({ seriesId: 'missing', sectionId: a.sectionId, rawText: 'bad' })).error.code, 'INVALID_PARENT');
  assert.equal((await favorites.saveSection({ seriesId: 'missing', name: 'bad' })).error.code, 'INVALID_PARENT');
  const before = favorites.revision();
  const moved = await favorites.applyBatch({ ids: [first.id, second.id], patch: { seriesId: b.seriesId, sectionId: b.sectionId, pinned: true } });
  assert.equal(moved.ok, true); assert.equal(favorites.revision(), before + 1);
  assert.equal(events.at(-1).changedEntryIds.length, 2);
  assert.equal(favorites.getEntry(first.id).sectionId, b.sectionId);
  const refs = await favorites.duplicateEntries({ ids: [first.id, second.id], seriesId: a.seriesId, sectionId: a.sectionId, mode: 'reference' });
  assert.equal(refs.data.ids.length, 2);
  assert.equal(favorites.getEntry(refs.data.ids[0]).tagId, first.tagId);
});

test('page name and color save atomically, persist together, and undo together', async () => {
  const h = await make(), { favorites } = h;
  const page = (await favorites.saveSeries({ name: '原名称' })).data, revision = favorites.revision();
  assert.equal((await favorites.saveSeries({ id: page.id, name: '新名称', color: 'invalid' })).ok, false);
  assert.deepEqual(favorites.series()[0], page); assert.equal(favorites.revision(), revision);
  assert.equal((await favorites.saveSeries({ id: page.id, name: '新名称', color: '#AABBCC' })).ok, true);
  assert.equal(favorites.revision(), revision + 1);
  assert.equal((await h.reopen()).favorites.series()[0].color, '#AABBCC');
  await favorites.undo(); assert.deepEqual(favorites.series()[0], page);
});

test('reorder, explicit move, series deletion and bulk colors are undoable', async () => {
  const { favorites } = await make();
  const a = await addFavoriteLocation(favorites, 'A'), b = await addFavoriteLocation(favorites, 'B'), c = await addFavoriteLocation(favorites, 'C');
  const row = await entry(favorites, a, 'x');
  assert.equal((await favorites.reorder({ kind: 'series', parentId: null, ids: [c.seriesId, a.seriesId, b.seriesId] })).ok, true);
  assert.deepEqual(favorites.series().map(row => row.id), [c.seriesId, a.seriesId, b.seriesId]);
  assert.equal((await favorites.reorder({ kind: 'series', parentId: null, ids: [a.seriesId, b.seriesId] })).ok, false);
  await favorites.setSeriesColors([a.seriesId, b.seriesId], { mode: 'custom', color: '#287EA4' });
  assert.ok(favorites.series().filter(row => [a.seriesId, b.seriesId].includes(row.id)).every(row => row.color === '#287EA4'));
  await favorites.undo(); assert.equal(favorites.series().find(row => row.id === a.seriesId).color, a.series.color);
  await favorites.redo(); assert.equal(favorites.series().find(row => row.id === a.seriesId).color, '#287EA4');
  await favorites.setSeriesColors([a.seriesId], { mode: 'auto' });
  assert.equal(favorites.series().find(row => row.id === a.seriesId).colorMode, 'auto');
  assert.equal((await favorites.applyBatch({ ids: [row.id], patch: { seriesId: b.seriesId, sectionId: b.sectionId } })).ok, true);
  assert.equal((await favorites.deleteSeries(a.seriesId)).ok, true);
  assert.equal(favorites.getEntry(row.id).seriesId, b.seriesId);
  assert.equal((await favorites.deleteSeries(c.seriesId, { mode: 'delete' })).ok, true);
});

test('default series deletion reuses uncategorized and one undo restores its hierarchy', async () => {
  const { favorites } = await make();
  const fallback = await addFavoriteLocation(favorites, '未分类', '未分类'), source = await addFavoriteLocation(favorites, 'Source', 'Nested');
  const row = await entry(favorites, source, 'kept');
  assert.equal((await favorites.deleteSeries(source.seriesId, { mode: 'move' })).ok, true);
  assert.equal(favorites.getEntry(row.id).seriesId, fallback.seriesId);
  assert.equal(favorites.getEntry(row.id).sectionId, fallback.sectionId);
  assert.equal(favorites.sections(source.seriesId).length, 0);
  assert.equal((await favorites.undo()).ok, true);
  assert.deepEqual(favorites.sections(source.seriesId).map(row => row.id), [source.sectionId]);
  assert.equal(favorites.getEntry(row.id).sectionId, source.sectionId);
});

test('explicit saves are separate undo units and shared history is bounded to 30', async () => {
  const { favorites } = await make(), place = await addFavoriteLocation(favorites, 'Drafts');
  const row = await entry(favorites, place, 'blue hair');
  await favorites.saveEntry({ id: row.id, note: 'a' });
  await favorites.saveEntry({ id: row.id, note: 'ab' });
  await favorites.undo(); assert.equal(favorites.getEntry(row.id).note, 'a');
  await favorites.redo(); assert.equal(favorites.getEntry(row.id).note, 'ab');
  for (let index = 0; index < 35; index++) await favorites.saveEntry({ id: row.id, note: 'note-' + index });
  let undoCount = 0;
  while (favorites.historyState().canUndo) { assert.equal((await favorites.undo()).ok, true); undoCount++; }
  assert.equal(undoCount, 30);
});

test('no-op edits and batches do not write a revision or publish an event', async () => {
  const h = await make(), { favorites } = h, place = await addFavoriteLocation(favorites);
  const row = await entry(favorites, place, 'same'), revision = favorites.revision(), saves = h.repository.saveCount;
  let events = 0; favorites.subscribe(() => events++);
  await favorites.saveEntry({ id: row.id, note: '' });
  await favorites.applyBatch({ ids: [row.id], patch: { pinned: false, globalSearchable: true } });
  assert.equal(favorites.revision(), revision); assert.equal(events, 0); assert.equal(h.repository.saveCount, saves);
});

test('section and entry reorder require complete siblings and retain their parent', async () => {
  const { favorites } = await make(), a = await addFavoriteLocation(favorites, 'Ordered', 'A');
  const b = (await favorites.saveSection({ seriesId: a.seriesId, name: 'B' })).data;
  assert.equal((await favorites.reorder({ kind: 'section', parentId: a.seriesId, ids: [b.id, a.sectionId] })).ok, true);
  assert.deepEqual(favorites.sections(a.seriesId).map(row => row.id), [b.id, a.sectionId]);
  const first = await entry(favorites, a, 'first'), second = await entry(favorites, a, 'second');
  assert.equal((await favorites.reorder({ kind: 'entry', parentId: a.sectionId, ids: [first.id] })).ok, false);
  assert.equal((await favorites.reorder({ kind: 'entry', parentId: a.sectionId, ids: [second.id, first.id] })).ok, true);
  assert.deepEqual(favorites.list({ sectionId: a.sectionId }).items.map(row => row.id), [second.id, first.id]);
});

test('ordered shelf cache invalidates after edits, moves, reorders and undo', async () => {
  const { favorites } = await make(), a = await addFavoriteLocation(favorites, 'A'), b = await addFavoriteLocation(favorites, 'B');
  const a1 = await entry(favorites, a, 'a1'), a2 = await entry(favorites, a, 'a2'), b1 = await entry(favorites, b, 'b1');
  assert.deepEqual(favorites.list().items.map(row => row.id), [a1.id, a2.id, b1.id]);
  await favorites.saveEntry({ id: a1.id, rawText: 'renamed' });
  assert.equal(favorites.list({ seriesId: a.seriesId }).items[0].rawText, 'renamed');
  await favorites.saveEntry({ id: a1.id, seriesId: b.seriesId, sectionId: b.sectionId });
  assert.deepEqual(favorites.list({ seriesId: a.seriesId }).items.map(row => row.id), [a2.id]);
  assert.deepEqual(favorites.list({ seriesId: b.seriesId }).items.map(row => row.id), [b1.id, a1.id]);
  await favorites.reorder({ kind: 'entry', parentId: b.sectionId, ids: [a1.id, b1.id] });
  assert.deepEqual(favorites.list({ seriesId: b.seriesId }).items.map(row => row.id), [a1.id, b1.id]);
  await favorites.undo(); assert.deepEqual(favorites.list({ seriesId: b.seriesId }).items.map(row => row.id), [b1.id, a1.id]);
  await favorites.reorder({ kind: 'series', parentId: null, ids: [b.seriesId, a.seriesId] });
  assert.equal(favorites.list({ limit: 1 }).items[0].seriesId, b.seriesId);
  await favorites.undo(); assert.equal(favorites.list({ limit: 1 }).items[0].seriesId, a.seriesId);
});

test('legacy migration preserves unresolved and invalid raw rows and the original input', async () => {
  const old = [{ id: 'old-1', name: '旧组合', tags: ['blue_hair', 'unknown_tag'] }, { id: 'old-bad', name: '待修复', tags: [null, ''] }];
  const before = structuredClone(old);
  const h = await migrated({ rewrite_favorites: old });
  const unresolved = (await h.repository.read()).unresolved;
  assert.deepEqual(unresolved.find(row => row.sourceId === 'old-1').payload, old[0]);
  assert.ok(unresolved.some(row => row.sourceId === 'old-bad'));
  assert.deepEqual(old, before);
  assert.equal((await h.reopen()).favorites.list().total, h.favorites.list().total);
});

test('legacy migration preserves the original unresolved row when no dictionary entry matches', async () => {
  const h = await migrated({ rewrite_favorites: [{ id: 'old-1', name: 'Fallback', tags: ['kept_tag'] }] });
  const document = await h.repository.read();
  assert.deepEqual(document.unresolved[0].payload.tags, ['kept_tag']);
  assert.equal(h.favorites.list().total, 0);
});

test('legacy migration inherits adult flags from resolved tags and old rows', async () => {
  const base = makeBase(); base.tags[0].adult = true;
  const { favorites } = await migrated({ rewrite_favorites: [{ name: 'Known adult', tags: ['blue_hair'] }, { name: 'Old adult', tags: ['long_hair'], nsfw: true }] }, base);
  assert.deepEqual(favorites.list({ includeAdult: true }).items.map(row => row.nsfw), [true, true]);
  assert.equal(favorites.list({ includeAdult: false }).total, 0);
});

test('invalid old rows remain recoverable while new entries cannot exploit an empty-text exemption', async () => {
  const h = await migrated({ rewrite_favorites: [{ id: 'broken', name: 'Broken', tags: [] }] });
  const original = (await h.repository.read()).unresolved;
  assert.ok(original.some(row => row.sourceId === 'broken'));
  const place = await addFavoriteLocation(h.favorites, 'Repair');
  const repaired = await entry(h.favorites, place, 'repaired');
  assert.equal((await h.favorites.saveEntry({ id: repaired.id, rawText: '' })).ok, false);
  assert.equal(h.favorites.getEntry(repaired.id).rawText, 'repaired');
  assert.deepEqual((await h.repository.read()).unresolved, original);
});

test('new favorites require an explicit valid group instead of a hidden page-root entry', async () => {
  const { favorites } = await make(), { seriesId } = await addFavoriteLocation(favorites, 'Root');
  const before = favorites.revision();
  assert.equal((await favorites.saveEntry({ seriesId, sectionId: '', rawText: 'root tag' })).ok, false);
  assert.equal((await favorites.saveEntry({ seriesId, sectionId: null, rawText: 'root tag' })).ok, false);
  assert.equal(favorites.revision(), before); assert.equal(favorites.list().total, 0);
});

test('a corrupt library reports initialization failure and cannot overwrite stored data', async () => {
  const corrupt = { format: 'wrong', version: 1, revision: 7 }, h = createHarness({ document: corrupt });
  assert.equal((await h.ready).ok, false);
  const favorites = createFavorites({ library: h.library });
  assert.ok(favorites.snapshot().loadError);
  assert.equal((await favorites.saveSeries({ name: 'blocked' })).ok, false);
  assert.deepEqual(await h.repository.read(), corrupt);
});

test('a rejected save preserves state and failed undo preserves its history', async () => {
  const h = await make(), { favorites } = h;
  h.controls.failNextSave();
  assert.equal((await favorites.saveSeries({ name: 'Not saved' })).error.code, 'STORAGE_WRITE_FAILED');
  assert.equal(favorites.series().length, 0);
  assert.equal((await favorites.saveSeries({ name: 'Saved' })).ok, true);
  h.controls.failNextSave();
  assert.equal((await favorites.undo()).error.code, 'STORAGE_WRITE_FAILED');
  assert.equal(favorites.historyState().canUndo, true);
  assert.equal(favorites.series()[0].name, 'Saved');
  assert.equal((await favorites.undo()).ok, true);
});

test('repository write rejection never publishes a successful mutation', async () => {
  const h = await make(), { favorites } = h; let events = 0;
  favorites.subscribe(() => events++); h.controls.failNextSave();
  assert.equal((await favorites.saveSeries({ name: 'Rejected' })).error.code, 'STORAGE_WRITE_FAILED');
  assert.equal(events, 0); assert.equal(favorites.series().length, 0);
  assert.equal((await h.repository.read()).favoritePages.length, 0);
});

test('atomic file storage can recover after a failed save and reload the next successful write', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'favorites-library-recovery-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let diskFull = false;
  const repository = createLibraryRepository({ filePath: path.join(directory, 'tag-library-v2.json'), backupDir: path.join(directory, 'backups'), fsImpl: {
    open: async (...args) => { if (diskFull) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); return fs.open(...args); }
  } });
  const base = makeBase(); await repository.save(emptyUserDocument(base));
  const h = await make({ base, repository }), { favorites } = h;
  const original = await repository.read(); diskFull = true;
  assert.equal((await favorites.saveSeries({ name: 'Rejected' })).ok, false);
  assert.deepEqual(await repository.read(), original);
  diskFull = false; assert.equal((await favorites.saveSeries({ name: 'Saved' })).ok, true);
  assert.equal(await favorites.flush(), true);
  assert.ok((await h.reopen()).favorites.series().some(row => row.name === 'Saved'));
});

test('deleting the first row records only that membership as changed and undo restores it', async () => {
  const { favorites } = await make(), place = await addFavoriteLocation(favorites, 'History'), entries = [];
  for (let index = 0; index < 40; index++) entries.push(await entry(favorites, place, 'tag-' + index));
  let event; favorites.subscribe(value => { event = value; });
  await favorites.deleteEntries([entries[0].id]); assert.deepEqual(event.changedEntryIds, [entries[0].id]);
  await favorites.undo(); assert.equal(favorites.getEntry(entries[0].id).rawText, 'tag-0');
});

test('shared recent history retains 200 unique live tag references and excludes unfavorited memberships', async () => {
  const { favorites } = await make(), place = await addFavoriteLocation(favorites, 'Recent'), ids = [];
  for (let index = 0; index < 202; index++) ids.push((await entry(favorites, place, 'tag ' + index)).id);
  await favorites.markCopied(ids); await favorites.markCopied([ids[5]]);
  const recent = favorites.list({ view: 'recent', limit: 80 });
  assert.equal(recent.total, 200); assert.equal(recent.items[0].id, ids[5]);
  await favorites.deleteEntries([ids[5]]);
  assert.equal(favorites.list({ view: 'recent' }).items.some(row => row.id === ids[5]), false);
  assert.equal(await favorites.flush(), true);
});

test('legacy unfiled entries migrate to real groups once without changing their text', async () => {
  const rawText = '  preserved,\n text  ';
  const shelf = { format: 'ai-tag-favorites', version: 1, revision: 0,
    series: [{ id: 'p', name: 'Page', color: '#112233', colorMode: 'auto', order: 0 }], sections: [],
    entries: [{ id: 'e', kind: 'bundle', seriesId: 'p', sectionId: null, title: 'old', rawText, zh: '', aliases: [], note: 'note', globalSearchable: true, nsfw: false, pinned: false, order: 0, sourceTagId: null, sourceCharacterId: null, createdAt: 0, updatedAt: 0 }] };
  const h = await migrated({ favorites_shelf_v1: shelf }), { favorites } = h, row = favorites.list().items[0];
  assert.ok(row.sectionId); assert.equal(row.rawText, rawText); assert.equal(row.note, 'note');
  const before = favorites.revision(); await favorites.ensureTagColumns(row.seriesId); assert.equal(favorites.revision(), before);
  assert.equal((await h.reopen()).favorites.getEntry(row.id).rawText, rawText);
});

test('deleting the last group relocates memberships and undo restores the original group', async () => {
  const { favorites } = await make(), place = await addFavoriteLocation(favorites, 'Page', 'Only');
  const row = await entry(favorites, place, 'retained');
  assert.equal((await favorites.deleteSection(place.sectionId)).ok, true);
  const relocated = favorites.getEntry(row.id);
  assert.notEqual(relocated.sectionId, place.sectionId);
  assert.equal(favorites.series().find(page => page.id === relocated.seriesId).name, '未分类');
  assert.ok(favorites.sections(relocated.seriesId).some(group => group.id === relocated.sectionId));
  await favorites.undo(); assert.equal(favorites.getEntry(row.id).sectionId, place.sectionId);
});
