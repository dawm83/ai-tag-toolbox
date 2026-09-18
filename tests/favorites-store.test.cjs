'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStorage } = require('../src/modules/storage');

const make = options => {
  const { createFavorites } = require('../src/modules/favorites');
  const storage = options?.storage || createStorage();
  return { storage, favorites: createFavorites({ storage, tags: options?.tags }) };
};

test('free input persists and copies rawText byte-for-byte without writing to tags', () => {
  let tagWrites = 0;
  const tags = { get: () => null, addCustom: () => { tagWrites += 1; } };
  const { storage, favorites } = make({ tags });
  const series = favorites.saveSeries({ name: '光照' }).data;
  const rawText = String.raw`  soft lighting, (backlighting:1.2), name \(series\)
second line  `;
  const saved = favorites.saveEntry({ kind: 'bundle', seriesId: series.id, title: '人像', rawText }).data;
  assert.equal(favorites.copyText([saved.id]), rawText);
  assert.equal(saved.globalSearchable, true);
  assert.equal(tagWrites, 0);
  const restored = make({ storage, tags }).favorites;
  assert.equal(restored.getEntry(saved.id).rawText, rawText);
});

test('CRUD validates parents, preserves stable IDs, and commits each batch once', () => {
  const { favorites } = make();
  const events = [];
  favorites.subscribe(event => events.push(event));
  const a = favorites.saveSeries({ name: 'A' }).data;
  const b = favorites.saveSeries({ name: 'B' }).data;
  assert.notEqual(a.color, b.color);
  const section = favorites.saveSection({ seriesId: a.id, name: 'S' }).data;
  const first = favorites.saveEntry({ kind: 'tag', seriesId: a.id, sectionId: section.id, rawText: 'x' }).data;
  const sameName = favorites.saveEntry({ kind: 'tag', seriesId: a.id, sectionId: section.id, rawText: 'x' }).data;
  assert.notEqual(first.id, sameName.id);
  assert.equal(favorites.saveEntry({ id: first.id, title: 'renamed' }).data.id, first.id);
  assert.equal(favorites.saveEntry({ kind: 'tag', seriesId: 'missing', rawText: 'bad' }).error.code, 'SERIES_NOT_FOUND');
  assert.equal(favorites.saveSection({ seriesId: 'missing', name: 'bad' }).error.code, 'SERIES_NOT_FOUND');

  const before = favorites.snapshot().revision;
  const changed = favorites.applyBatch({ ids: [first.id, sameName.id], patch: { seriesId: b.id, sectionId: section.id, pinned: true } });
  assert.equal(changed.ok, true);
  assert.equal(favorites.snapshot().revision, before + 1);
  assert.equal(events.at(-1).changedEntryIds.length, 2);
  assert.equal(favorites.getEntry(first.id).sectionId, null);

  const copies = favorites.duplicateEntries({ ids: [first.id, sameName.id], seriesId: a.id, sectionId: section.id });
  assert.equal(copies.data.ids.length, 2);
  assert.ok(copies.data.ids.every(id => ![first.id, sameName.id].includes(id)));
  assert.equal(favorites.deleteSection(section.id).ok, true);
  assert.equal(favorites.getEntry(copies.data.ids[0]).sectionId, null);
});

test('page name and color save together, reject invalid input atomically, and undo together', () => {
  const { storage, favorites } = make();
  const page = favorites.saveSeries({ name: '原名称' }).data;
  const revision = favorites.snapshot().revision;
  assert.equal(favorites.saveSeries({ id: page.id, name: '新名称', color: 'invalid' }).ok, false);
  assert.deepEqual(favorites.series()[0], page);
  assert.equal(favorites.snapshot().revision, revision);
  assert.equal(favorites.saveSeries({ id: page.id, name: '新名称', color: '#aabbcc' }).ok, true);
  assert.equal(favorites.snapshot().revision, revision + 1);
  assert.equal(make({ storage }).favorites.series()[0].color, '#AABBCC');
  favorites.undo();
  assert.deepEqual(favorites.series()[0], page);
});

test('reorder, series deletion modes, deterministic colors, and bulk colors are undoable', () => {
  const { favorites } = make();
  const a = favorites.saveSeries({ name: 'A' }).data;
  const b = favorites.saveSeries({ name: 'B' }).data;
  const c = favorites.saveSeries({ name: 'C' }).data;
  const entry = favorites.saveEntry({ kind: 'tag', seriesId: a.id, rawText: 'x' }).data;
  assert.equal(favorites.reorder({ kind: 'series', parentId: null, ids: [c.id, a.id, b.id] }).ok, true);
  assert.deepEqual(favorites.series().map(row => row.id), [c.id, a.id, b.id]);
  assert.equal(favorites.reorder({ kind: 'series', parentId: null, ids: [a.id, b.id] }).error.code, 'INVALID_ORDER');

  favorites.setSeriesColors([a.id, b.id], { mode: 'custom', color: '#287EA4' });
  assert.ok(favorites.series().filter(row => [a.id, b.id].includes(row.id)).every(row => row.color === '#287EA4'));
  favorites.undo();
  assert.equal(favorites.series().find(row => row.id === a.id).color, a.color);
  favorites.redo();
  assert.equal(favorites.series().find(row => row.id === a.id).color, '#287EA4');
  favorites.setSeriesColors([a.id], { mode: 'auto' });
  assert.equal(favorites.series().find(row => row.id === a.id).colorMode, 'auto');

  assert.equal(favorites.deleteSeries(a.id, { mode: 'move', targetSeriesId: b.id }).ok, true);
  assert.equal(favorites.getEntry(entry.id).seriesId, b.id);
  assert.equal(favorites.deleteSeries(c.id, { mode: 'delete' }).ok, true);
});

test('default series move creates or reuses uncategorized and one undo restores the hierarchy', () => {
  const first = make().favorites;
  const source = first.saveSeries({ name: 'Source' }).data;
  const section = first.saveSection({ seriesId: source.id, name: 'Nested' }).data;
  const entry = first.saveEntry({ kind: 'tag', seriesId: source.id, sectionId: section.id, rawText: 'kept' }).data;

  assert.equal(first.deleteSeries(source.id, { mode: 'move' }).ok, true);
  const fallback = first.series().find(row => row.name === '未分类');
  assert.ok(fallback);
  assert.equal(first.getEntry(entry.id).seriesId, fallback.id);
  assert.equal(first.getEntry(entry.id).sectionId, null);
  assert.equal(first.sections(source.id).length, 0);

  assert.equal(first.undo().ok, true);
  assert.deepEqual(first.series().map(row => row.id), [source.id]);
  assert.deepEqual(first.sections(source.id).map(row => row.id), [section.id]);
  assert.equal(first.getEntry(entry.id).seriesId, source.id);
  assert.equal(first.getEntry(entry.id).sectionId, section.id);

  const second = make().favorites;
  const reusable = second.saveSeries({ name: '未分类' }).data;
  const removable = second.saveSeries({ name: 'Remove' }).data;
  const reusedEntry = second.saveEntry({ kind: 'tag', seriesId: removable.id, rawText: 'reuse' }).data;
  assert.equal(second.deleteSeries(removable.id, { mode: 'move' }).ok, true);
  assert.deepEqual(second.series().map(row => row.id), [reusable.id]);
  assert.equal(second.getEntry(reusedEntry.id).seriesId, reusable.id);
});

test('historyKey coalesces edits, redo restores the latest value, and history is bounded to 30', () => {
  const { favorites } = make();
  const series = favorites.saveSeries({ name: 'Drafts' }).data;
  const entry = favorites.saveEntry({ kind: 'tag', seriesId: series.id, rawText: 'blue hair' }).data;
  favorites.saveEntry({ id: entry.id, note: 'a' }, { historyKey: 'note-edit' });
  favorites.saveEntry({ id: entry.id, note: 'ab' }, { historyKey: 'note-edit' });
  favorites.undo();
  assert.equal(favorites.getEntry(entry.id).note, '');
  favorites.redo();
  assert.equal(favorites.getEntry(entry.id).note, 'ab');

  for (let index = 0; index < 35; index += 1) favorites.saveEntry({ id: entry.id, note: `note-${index}` });
  let undoCount = 0;
  while (favorites.historyState().canUndo) { favorites.undo(); undoCount += 1; }
  assert.equal(undoCount, 30);
});

test('no-op edits and batches do not write a revision or publish an event', async () => {
  const { favorites } = make();
  const series = favorites.saveSeries({ name: 'Stable' }).data;
  const entry = favorites.saveEntry({ kind: 'tag', seriesId: series.id, rawText: 'same' }).data;
  const before = favorites.snapshot().revision;
  let events = 0;
  favorites.subscribe(() => { events += 1; });
  await new Promise(resolve => setTimeout(resolve, 5));
  favorites.saveEntry({ id: entry.id, note: '' });
  favorites.applyBatch({ ids: [entry.id], patch: { pinned: false, globalSearchable: true } });
  assert.equal(favorites.snapshot().revision, before);
  assert.equal(events, 0);
});

test('section and entry reorder require complete siblings and retain their parent', () => {
  const { favorites } = make();
  const series = favorites.saveSeries({ name: 'Ordered' }).data;
  const a = favorites.saveSection({ seriesId: series.id, name: 'A' }).data;
  const b = favorites.saveSection({ seriesId: series.id, name: 'B' }).data;
  assert.equal(favorites.reorder({ kind: 'section', parentId: series.id, ids: [b.id, a.id] }).ok, true);
  assert.deepEqual(favorites.sections(series.id).map(row => row.id), [b.id, a.id]);
  const first = favorites.saveEntry({ kind: 'tag', seriesId: series.id, sectionId: a.id, rawText: 'first' }).data;
  const second = favorites.saveEntry({ kind: 'tag', seriesId: series.id, sectionId: a.id, rawText: 'second' }).data;
  assert.equal(favorites.reorder({ kind: 'entry', parentId: a.id, ids: [second.id, first.id] }).ok, true);
  assert.deepEqual(favorites.list({ seriesId: series.id, sectionId: a.id }).items.map(row => row.id), [second.id, first.id]);
});

test('ordered shelf cache invalidates after edits, moves, reorders and undo', () => {
  const { favorites } = make();
  const seriesA = favorites.saveSeries({ name: 'A' }).data;
  const seriesB = favorites.saveSeries({ name: 'B' }).data;
  const a1 = favorites.saveEntry({ kind: 'tag', seriesId: seriesA.id, rawText: 'a1' }).data;
  const a2 = favorites.saveEntry({ kind: 'tag', seriesId: seriesA.id, rawText: 'a2' }).data;
  const b1 = favorites.saveEntry({ kind: 'tag', seriesId: seriesB.id, rawText: 'b1' }).data;

  assert.deepEqual(favorites.list({ limit: 80 }).items.map(row => row.id), [a1.id, a2.id, b1.id]);
  favorites.saveEntry({ id: a1.id, rawText: 'renamed' });
  assert.equal(favorites.list({ seriesId: seriesA.id }).items[0].rawText, 'renamed');

  favorites.saveEntry({ id: a1.id, seriesId: seriesB.id, sectionId: null });
  assert.deepEqual(favorites.list({ seriesId: seriesA.id }).items.map(row => row.id), [a2.id]);
  assert.deepEqual(favorites.list({ seriesId: seriesB.id }).items.map(row => row.id), [a1.id, b1.id]);

  favorites.reorder({ kind: 'entry', parentId: seriesB.id, ids: [b1.id, a1.id] });
  assert.deepEqual(favorites.list({ seriesId: seriesB.id }).items.map(row => row.id), [b1.id, a1.id]);
  favorites.undo();
  assert.deepEqual(favorites.list({ seriesId: seriesB.id }).items.map(row => row.id), [a1.id, b1.id]);

  favorites.reorder({ kind: 'series', parentId: null, ids: [seriesB.id, seriesA.id] });
  assert.equal(favorites.list({ limit: 1 }).items[0].seriesId, seriesB.id);
  favorites.undo();
  assert.equal(favorites.list({ limit: 1 }).items[0].seriesId, seriesA.id);
});

test('legacy migration preserves unresolved and invalid rows, leaves the old key, and runs once', () => {
  const storage = createStorage();
  const old = [
    { id: 'old-1', name: '旧组合', tags: ['blue_hair', 'unknown_tag'] },
    { id: 'old-bad', name: '待修复', tags: [null, ''] }
  ];
  storage.set('rewrite_favorites', old);
  const tags = { get: id => id === 'blue_hair' ? { en: 'blue hair' } : null };
  const first = make({ storage, tags }).favorites;
  assert.equal(first.list({ limit: 80 }).total, 2);
  assert.match(first.getEntry(first.list({ limit: 80 }).items[0].id).rawText, /unknown_tag/);
  assert.equal(first.snapshot().migrationReport.invalid.length, 1);
  assert.equal(first.snapshot().migrationReport.unresolved.includes('unknown_tag'), true);
  assert.deepEqual(storage.get('rewrite_favorites'), old);
  assert.equal(make({ storage, tags }).favorites.list({ limit: 80 }).total, 2);
});

test('legacy migration preserves a row when base tag lookup fails', () => {
  const storage = createStorage();
  storage.set('rewrite_favorites', [{ id: 'old-1', name: 'Fallback', tags: ['kept_tag'] }]);
  const favorites = make({ storage, tags: { get: () => { throw new Error('dictionary unavailable'); } } }).favorites;
  assert.equal(favorites.list({ limit: 80 }).items[0].rawText, 'kept_tag');
  assert.deepEqual(favorites.snapshot().migrationReport.unresolved, ['kept_tag']);
});

test('legacy migration inherits adult flags from resolved tags and old rows', () => {
  const storage = createStorage();
  storage.set('rewrite_favorites', [
    { name: 'Known adult', tags: ['adult_tag'] },
    { name: 'Old adult', tags: ['unknown_tag'], nsfw: true }
  ]);
  const favorites = make({ storage, tags: { get: id => id === 'adult_tag' ? { en: 'adult tag', nsfw: true } : null } }).favorites;
  assert.deepEqual(favorites.list({ includeAdult: true }).items.map(row => row.nsfw), [true, true]);
  assert.equal(favorites.list({ includeAdult: false }).total, 0);
});

test('repairing a legacy invalid row removes its empty-text exemption', () => {
  const storage = createStorage();
  storage.set('rewrite_favorites', [{ id: 'broken', name: 'Broken', tags: [] }]);
  const favorites = make({ storage }).favorites;
  const entry = favorites.list({ includeAdult: true }).items[0];
  assert.equal(entry.legacyInvalid, true);
  assert.equal(favorites.saveEntry({ id: entry.id, rawText: 'repaired' }).ok, true);
  assert.equal(favorites.getEntry(entry.id).legacyInvalid, undefined);
  const rejected = favorites.saveEntry({ id: entry.id, rawText: '' });
  assert.equal(rejected.ok, false);
  assert.equal(favorites.getEntry(entry.id).rawText, 'repaired');
});

test('empty section IDs normalize to the series root', () => {
  const { favorites } = make();
  const series = favorites.saveSeries({ name: 'Root' }).data;
  const entry = favorites.saveEntry({ kind: 'tag', seriesId: series.id, sectionId: '', rawText: 'root tag' }).data;
  assert.equal(entry.sectionId, null);
  assert.equal(favorites.list({ seriesId: series.id, sectionId: null }).total, 1);
});

test('corrupt shelf reports loadError and refuses to overwrite stored data', () => {
  const storage = createStorage();
  const corrupt = { format: 'wrong', version: 1, revision: 7, series: [], sections: [], entries: [] };
  storage.set('favorites_shelf_v1', corrupt);
  const favorites = make({ storage }).favorites;
  assert.equal(favorites.snapshot().loadError.code, 'INVALID_FAVORITES_DOCUMENT');
  assert.equal(favorites.saveSeries({ name: 'blocked' }).error.code, 'LOAD_ERROR');
  assert.deepEqual(storage.get('favorites_shelf_v1'), corrupt);
});

test('a throwing storage write does not mutate state or report a successful flush', async () => {
  const values = new Map();
  let rejectWrites = true;
  const storage = {
    get: (key, fallback) => values.has(key) ? structuredClone(values.get(key)) : fallback,
    set(key, value) { if (rejectWrites) throw new Error('disk full'); values.set(key, structuredClone(value)); return value; },
    flush: async () => true
  };
  const favorites = make({ storage }).favorites;
  assert.equal(favorites.saveSeries({ name: 'Not saved' }).error.code, 'STORAGE_WRITE_FAILED');
  assert.equal(favorites.series().length, 0);
  assert.equal(await favorites.flush(), false);
  rejectWrites = false;
  assert.equal(favorites.saveSeries({ name: 'Saved' }).ok, true);
  assert.equal(await favorites.flush(), true);
  rejectWrites = true;
  assert.equal(favorites.undo().error.code, 'STORAGE_WRITE_FAILED');
  assert.equal(favorites.historyState().canUndo, true);
  assert.equal(favorites.series()[0].name, 'Saved');
});

test('an adapter rejection reported by createStorage prevents a false successful mutation', () => {
  const values = new Map();
  const adapter = {
    getItem: key => values.get(key) ?? null,
    setItem: () => false,
    removeItem: key => values.delete(key),
    key: index => [...values.keys()][index] || null,
    get length() { return values.size; }
  };
  const favorites = make({ storage: createStorage({ adapter }) }).favorites;
  assert.equal(favorites.saveSeries({ name: 'Rejected' }).error.code, 'STORAGE_WRITE_FAILED');
  assert.equal(favorites.series().length, 0);
});

test('file storage recovery accepts the next domain write and clears the failed flush', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favorites-storage-recovery-'));
  const filename = path.join(dir, 'state.json');
  const originalWriteFile = fs.promises.writeFile;
  let diskFull = true;
  fs.promises.writeFile = async (...args) => {
    if (diskFull) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    return originalWriteFile(...args);
  };
  t.after(() => {
    fs.promises.writeFile = originalWriteFile;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const storage = createStorage({ filePath: filename, prefix: 'favorites-recovery' });
  const favorites = make({ storage }).favorites;
  assert.equal(favorites.saveSeries({ name: 'A' }).ok, true);
  assert.equal(await favorites.flush(), false);

  diskFull = false;
  assert.equal(favorites.saveSeries({ name: 'B' }).ok, true);
  assert.deepEqual(favorites.series().map(row => row.name), ['A', 'B']);
  assert.equal(await favorites.flush(), true);

  const restored = make({ storage: createStorage({ filePath: filename, prefix: 'favorites-recovery' }) }).favorites;
  assert.deepEqual(restored.series().map(row => row.name), ['A', 'B']);
});

test('deleting the first row records only that entry as changed', () => {
  const { favorites } = make();
  const series = favorites.saveSeries({ name: 'History' }).data;
  const entries = Array.from({ length: 40 }, (_, index) => favorites.saveEntry({ kind: 'tag', seriesId: series.id, rawText: `tag-${index}` }).data);
  let event;
  favorites.subscribe(value => { event = value; });
  favorites.deleteEntries([entries[0].id]);
  assert.deepEqual(event.changedEntryIds, [entries[0].id]);
  favorites.undo();
  assert.equal(favorites.getEntry(entries[0].id).rawText, 'tag-0');
});

test('recent view keeps 20 unique live IDs and flush reflects storage result', async () => {
  const storage = createStorage();
  const { createFavorites } = require('../src/modules/favorites');
  const favorites = createFavorites({ storage });
  const series = favorites.saveSeries({ name: 'Recent' }).data;
  const ids = Array.from({ length: 22 }, (_, index) => favorites.saveEntry({ kind: 'tag', seriesId: series.id, rawText: `tag ${index}` }).data.id);
  favorites.markCopied(ids);
  favorites.markCopied([ids[5]]);
  const recent = favorites.list({ view: 'recent', limit: 80 });
  assert.equal(recent.total, 20);
  assert.equal(recent.items[0].id, ids[5]);
  favorites.deleteEntries([ids[5]]);
  assert.equal(favorites.list({ view: 'recent', limit: 80 }).items.some(row => row.id === ids[5]), false);
  assert.equal(await favorites.flush(), true);

  const failing = createFavorites({ storage: { get: storage.get, set: storage.set, flush: async () => false } });
  assert.equal(await failing.flush(), false);
});
