'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, makeBase, emptyUserDocument } = require('./fixtures/tag-library.cjs');
const { createTags } = require('../src/modules/tags');
const { createFavorites } = require('../src/modules/favorites');
const { createTagAdapter } = require('../src/modules/tag-library/tag-adapter');
const { createFavoriteAdapter } = require('../src/modules/tag-library/favorite-adapter');

async function setup(options) {
  const h = createHarness(options); await h.ready;
  return { ...h, tags: createTagAdapter({ library: h.library }), favorites: createFavoriteAdapter({ library: h.library }) };
}
async function favorite(favorites, sourceTagId = 'blue_hair') {
  const result = await favorites.saveEntry({ sourceTagId, seriesId: 'home', sectionId: 'daily' });
  assert.equal(result.ok, true); return result.data;
}

test('favorite edits share exact content, clearable fields and durable history with tags', async () => {
  const h = await setup(); const entry = await favorite(h.favorites);
  const result = await h.favorites.saveEntry({ id: entry.id, title: '蓝色头发', note: '统一备注', aliases: ['Azure'] });
  assert.equal(result.ok, true);
  assert.equal(h.tags.get('blue_hair').zh, '蓝色头发');
  assert.equal(h.tags.get('blue_hair').note, '统一备注');
  await h.tags.edit('blue_hair', { zh: '', aliases: [], note: '', en: '  Blue HAIR\n' });
  assert.equal(h.favorites.getEntry(entry.id).rawText, '  Blue HAIR\n');
  assert.equal(h.favorites.getEntry(entry.id).title, '');
  assert.deepEqual(h.favorites.getEntry(entry.id).aliases, []);
  await h.favorites.undo(); assert.equal(h.tags.get('blue_hair').note, '统一备注');
  await h.tags.redo(); assert.equal(h.favorites.getEntry(entry.id).note, '');
  assert.equal((await h.reload()).getTag('blue_hair').content, '  Blue HAIR\n');
  const snap = h.favorites.snapshot(); snap.document.entries[0].rawText = 'poison';
  assert.equal(h.favorites.getEntry(entry.id).rawText, '  Blue HAIR\n');
});

test('factory injection shares one live tag selection while existing snapshots retain historical bytes', async () => {
  const base = makeBase(), document = emptyUserDocument(base);
  document.selection.push({ kind: 'legacySnapshot', id: 'old', content: ' (OLD:1.2)\n', displayName: '旧选择', adult: false });
  const h = await setup({ base, document });
  const tags = createTags({ library: h.library }), favorites = createFavorites({ library: h.library });
  const entry = await favorite(favorites);
  await tags.select('blue_hair'); await favorites.setSelected(entry.id, true);
  assert.equal(h.library.selected().filter(row => row.kind === 'tag').length, 1);
  await favorites.saveEntry({ id: entry.id, rawText: 'blue curls' });
  assert.equal(tags.selected()[0].en, 'blue curls');
  assert.equal(favorites.selected()[0].rawText, 'blue curls');
  assert.equal(h.library.selected()[0].content, ' (OLD:1.2)\n');
  await favorites.setSelected(entry.id, false); assert.equal(tags.selected().length, 0);
  assert.equal(h.library.selected()[0].content, ' (OLD:1.2)\n');
});

test('save failures never publish adapter draft and all mutations return Promise<Result>', async () => {
  const h = await setup(); const entry = await favorite(h.favorites);
  const gate = h.controls.delayNextSave(); const events = []; h.tags.subscribe(e => events.push(e));
  const save = h.favorites.saveEntry({ id: entry.id, title: '未持久化' });
  assert.equal(typeof save.then, 'function'); await gate.started;
  assert.equal(h.tags.get('blue_hair').zh, '蓝发'); assert.equal(events.length, 0);
  h.controls.failNextSave(); gate.release(); assert.equal((await save).error.code, 'STORAGE_WRITE_FAILED');
  assert.equal(h.favorites.getEntry(entry.id).title, '蓝发'); assert.equal(events.length, 0);
  const revision = h.library.revision(); await h.tags.edit('blue_hair', { note: 'first' });
  assert.equal((await h.favorites.saveEntry({ id: entry.id, note: 'stale' }, { expectedRevision: revision })).error.code, 'REVISION_CONFLICT');
  assert.equal((await h.favorites.saveEntry({ id: entry.id, title: 'a', zh: 'b' })).error.code, 'INVALID_FIELD');
  assert.equal((await h.favorites.saveEntry({ id: entry.id, pinned: true })).error.code, 'INVALID_FIELD');
});

test('raw bundle creation preserves bytes and projections search canonical flags', async () => {
  const h = await setup(); const raw = '  (Blue_Hair:1.2),\\(x\\)\nLONG hair  ';
  const result = await h.favorites.saveEntry({ rawText: raw, title: '组合', kind: 'bundle', seriesId: 'home', sectionId: 'daily' });
  assert.equal(result.ok, true); const entry = result.data;
  assert.equal(h.tags.get(entry.sourceTagId).en, raw); assert.equal(h.favorites.copyText([entry.id]), raw);
  await h.tags.edit(entry.sourceTagId, { searchable: false });
  assert.equal(h.favorites.search('组合').total, 0); assert.equal(h.tags.search('组合').length, 0);
  assert.equal(h.favorites.list().total, 1); assert.equal(h.favorites.getEntry(entry.id).globalSearchable, false);
  await h.tags.edit(entry.sourceTagId, { nsfw: true });
  assert.equal(h.favorites.list({ includeAdult: false }).total, 0);
  assert.equal(h.tags.list({ includeAdult: false }).some(row => row.id === entry.sourceTagId), false);
});

test('duplicateEntries requires an explicit mode and saves an entire reference or independent batch once', async () => {
  const h = await setup(); const a = await favorite(h.favorites), b = await favorite(h.favorites, 'long_hair');
  const group = await h.favorites.saveSection({ seriesId: 'home', name: '另组' });
  assert.equal((await h.favorites.duplicateEntries({ ids: [a.id] })).error.code, 'INVALID_MODE');
  const before = h.repository.saveCount, events = []; h.library.subscribe(e => events.push(e));
  const copied = await h.favorites.duplicateEntries({ ids: [a.id, b.id], mode: 'reference', seriesId: 'home', sectionId: group.data.id });
  assert.equal(copied.ok, true); assert.equal(copied.data.ids.length, 2);
  assert.equal(h.repository.saveCount, before + 1); assert.equal(events.length, 1);
  assert.deepEqual(copied.data.ids.map(id => h.favorites.getEntry(id).sourceTagId), ['blue_hair', 'long_hair']);
  await h.tags.undo(); assert.equal(h.favorites.list().total, 2);
  const independent = await h.favorites.duplicateEntries({ ids: [a.id, b.id], mode: 'independent', seriesId: 'home', sectionId: group.data.id });
  assert.equal(independent.ok, true);
  const newId = h.favorites.getEntry(independent.data.ids[0]).sourceTagId;
  assert.notEqual(newId, 'blue_hair'); await h.tags.edit(newId, { note: '独立' });
  assert.equal(h.tags.get('blue_hair').note, '');
  await h.tags.undo(); await h.favorites.undo();
  assert.equal(h.favorites.list().total, 2); assert.equal(h.tags.get(newId), null);
});

test('atomic favorite and duplicate batches roll back on later invalid parent or persistence failure', async () => {
  const h = await setup(); const a = await favorite(h.favorites), b = await favorite(h.favorites, 'long_hair');
  const before = await h.repository.read(), saves = h.repository.saveCount;
  const result = await h.library.execute({ type: 'batch', operations: [
    { type: 'duplicateTag', tagId: 'blue_hair', placement: { kind: 'favorite', page: { id: 'home' }, group: { create: { name: '不得残留' } } } },
    { type: 'favoriteTag', tagId: 'long_hair', placement: { kind: 'favorite', page: { id: 'missing' }, group: { id: 'daily' } } }
  ] }, { operationId: 'bad-batch' });
  assert.equal(result.error.code, 'INVALID_PARENT'); assert.deepEqual(await h.repository.read(), before); assert.equal(h.repository.saveCount, saves);
  h.controls.failNextSave();
  assert.equal((await h.favorites.duplicateEntries({ ids: [a.id, b.id], mode: 'independent' })).error.code, 'STORAGE_WRITE_FAILED');
  assert.deepEqual(await h.repository.read(), before); assert.equal(h.favorites.list().total, 2);
});

test('read-only metadata and preferences survive adapters without old content writes', async () => {
  const h = await setup(); const stored = new Map([['rewrite_adult', true], ['app.searchPrecision', 'exact']]);
  const tags = createTags({ library: h.library, storage: { get: (k, d) => stored.has(k) ? stored.get(k) : d, set: (k, v) => stored.set(k, v) },
    metadataById: { blue_hair: { count: 42, categoryCode: 3, confidence: 0.7, content: 'poison', adult: true } },
    categoryMetadata: [{ id: 'hair', icon: 'X', neg: true, nsfw: true, name: 'poison' }] });
  assert.equal(tags.get('blue_hair').en, 'blue hair'); assert.equal(tags.get('blue_hair').nsfw, false);
  assert.equal(tags.get('blue_hair').count, 42); assert.equal(tags.get('blue_hair').confidence, 0.7);
  assert.equal(tags.categories()[0].name, '头发'); assert.equal(tags.categories()[0].neg, true);
  assert.equal(tags.stateSnapshot().searchPrecision, 'exact'); assert.equal(tags.snapshot().includeAdult, true);
  tags.setAdult(false); tags.setSearchPrecision('broad'); await tags.select('blue_hair'); await tags.edit('blue_hair', { note: 'new' });
  assert.deepEqual([...stored.keys()].sort(), ['app.searchPrecision', 'rewrite_adult']);
  assert.equal(tags.snapshot().selected[0], 'blue_hair'); assert.equal(tags.get('blue_hair').subcategoryId, 'color');
  assert.equal(tags.get('blue_hair').subcategory, '颜色');
});

test('structure, pin, color, recent and reorder operations project from shared service', async () => {
  const h = await setup(); const a = await favorite(h.favorites), b = await favorite(h.favorites, 'long_hair');
  await h.favorites.reorder({ kind: 'entry', parentId: 'daily', ids: [b.id, a.id] });
  assert.equal(h.favorites.list().items[0].id, b.id);
  await h.favorites.applyBatch({ ids: [a.id], patch: { pinned: true, globalSearchable: false } });
  assert.equal(h.library.getTag('blue_hair').searchable, false); assert.equal(h.favorites.list().items[0].pinned, true);
  await h.favorites.setSeriesColors(['home'], { mode: 'custom', color: '#123456' });
  assert.equal(h.library.getFavoritePages()[0].color, '#123456');
  await h.favorites.markCopied([b.id, a.id]); assert.deepEqual(h.library.getRecentTagIds(), ['long_hair', 'blue_hair']);
  h.library.getRecentTagIds().push('not-real'); assert.deepEqual(h.library.getRecentTagIds(), ['long_hair', 'blue_hair']);
  assert.equal(h.favorites.list({ view: 'recent' }).items[0].id, b.id);
  await h.favorites.deleteEntries([a.id]); assert.ok(h.tags.get('blue_hair')); assert.equal(h.tags.get('blue_hair').favorite, false);
  await h.favorites.deleteSection('daily'); assert.equal(h.favorites.list().total, 1);
  assert.equal(h.favorites.series().find(row => row.name === '未分类') !== undefined, true);
});

test('not-ready adapters expose empty synchronous views and preserve readiness error', async () => {
  let release; const base = makeBase(), document = emptyUserDocument(base);
  const h = createHarness({ repository: { read: () => new Promise(resolve => { release = () => resolve(document); }), async save() {} } });
  const tags = createTagAdapter({ library: h.library }), favorites = createFavoriteAdapter({ library: h.library });
  assert.deepEqual(tags.list(), []); assert.deepEqual(favorites.snapshot().document.entries, []); assert.equal(tags.isLoaded(), false);
  assert.equal((await favorites.saveEntry({ sourceTagId: 'blue_hair', seriesId: 'home', sectionId: 'daily' })).error.code, 'NOT_READY');
  release(); await h.ready; assert.equal(tags.isLoaded(), true); assert.ok(tags.get('blue_hair'));
});

test('legacy taxonomy names resolve to current IDs and missing names fail without writes', async () => {
  const h = await setup();
  const changed = await h.tags.edit('blue_hair', { subcategory: '形状' });
  assert.equal(changed.ok, true); assert.equal(h.library.getTag('blue_hair').subcategoryId, 'shape');
  const before = h.repository.saveCount;
  assert.equal((await h.tags.edit('blue_hair', { subcategory: '不存在' })).error.code, 'INVALID_PARENT');
  assert.equal(h.repository.saveCount, before);
  assert.equal(h.tags.page({ query: 'blue', category: 'missing', subcategory: 'all' }).total, 1);
  assert.equal(h.tags.page({ category: 'hair', subcategory: 'all' }).total, 6);
});

test('malformed editable payloads resolve Result failures rather than rejecting promises', async () => {
  const h = await setup();
  assert.equal((await h.tags.edit('blue_hair', null)).error.code, 'INVALID_FIELD');
  assert.equal((await h.tags.addCustom(null)).error.code, 'INVALID_FIELD');
  assert.equal((await h.favorites.saveEntry(null)).error.code, 'INVALID_FIELD');
  assert.equal((await h.favorites.saveSeries(null)).error.code, 'INVALID_FIELD');
  assert.equal((await h.favorites.saveSection(null)).error.code, 'INVALID_FIELD');
});

test('adding a source reference cannot overwrite shared content from a stale snapshot', async () => {
  const h = await setup(); const before = h.repository.saveCount;
  const result = await h.favorites.saveEntry({ sourceTagId: 'blue_hair', seriesId: 'home', sectionId: 'daily', rawText: 'stale hair', title: '旧名称' });
  assert.equal(result.error.code, 'INVALID_FIELD'); assert.equal(h.repository.saveCount, before);
  assert.equal(h.tags.get('blue_hair').en, 'blue hair'); assert.equal(h.favorites.list().total, 0);
  const accepted = await h.favorites.saveEntry({ sourceTagId: 'blue_hair', seriesId: 'home', sectionId: 'daily', rawText: 'blue hair', title: '蓝发', aliases: [] });
  assert.equal(accepted.ok, true); assert.equal(h.tags.get('blue_hair').revision, 0);
});

test('a migrated old favorite selection preserves its snapshot after canonical favorite edits', async () => {
  const { prepareLegacyMigration } = require('../src/modules/tag-library/migration');
  const base = makeBase(); let sequence = 0;
  const prepared = prepareLegacyMigration({ base, ids: prefix => `${prefix}:migrated-${++sequence}`, now: () => 1,
    legacy: { version: 1, values: { favorites_selection_v1: [{ entryId: 'legacy-entry', kind: 'tag', title: '历史', rawText: ' (BLUE:1.3)\r\n ', nsfw: false, sourceUpdatedAt: 0 }] } } });
  assert.equal(prepared.ok, true);
  const h = await setup({ base, document: prepared.data.document });
  const page = await h.favorites.saveSeries({ name: '页' });
  const group = await h.favorites.saveSection({ seriesId: page.data.id, name: '组' });
  const created = await h.favorites.saveEntry({ sourceTagId: 'blue_hair', seriesId: page.data.id, sectionId: group.data.id });
  await h.favorites.setSelected(created.data.id, true); await h.tags.edit('blue_hair', { en: 'edited hair' });
  const values = h.library.selected(); assert.equal(values[0].kind, 'legacySnapshot'); assert.equal(values[0].content, ' (BLUE:1.3)\r\n ');
  assert.equal(values[1].content, 'edited hair');
});

test('list and search traverse real query pages beyond the library page cap', async () => {
  const base = makeBase();
  for (let i = 0; i < 2002; i++) base.tags.push({ ...base.tags[0], id: `large-${i}`, content: `large ${i}`, displayName: `大型 ${i}` });
  const h = await setup({ base });
  assert.equal(h.tags.list().length, 2008); assert.equal(h.tags.search('large').length, 2002);
  assert.equal(h.tags.page({ query: 'large', offset: 2000, limit: 10 }).items.length, 2);
});
