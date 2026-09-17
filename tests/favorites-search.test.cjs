'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createStorage } = require('../src/modules/storage');
const { createFavorites, favoriteMemberCount } = require('../src/modules/favorites');

test('internal search sees private notes while global search uses only discoverable public fields', () => {
  const favorites = createFavorites({ storage: createStorage() });
  const series = favorites.saveSeries({ name: '光照' }).data;
  const section = favorites.saveSection({ seriesId: series.id, name: '人像' }).data;
  const item = favorites.saveEntry({
    kind: 'bundle', seriesId: series.id, sectionId: section.id, title: '柔光',
    rawText: 'soft lighting, backlighting', zh: '柔光说明', aliases: ['逆光'], note: '人像测试',
    globalSearchable: false
  }).data;
  assert.equal(favorites.search('人像', { scope: 'internal' }).total, 1);
  assert.equal(favorites.search('人像', { scope: 'global' }).total, 0);
  assert.equal(favorites.search('柔光', { scope: 'global' }).total, 0);
  const hit = favorites.search('backlighting', { scope: 'internal' }).items[0];
  assert.equal(hit.entryId, item.id);
  assert.equal(hit.seriesName, '光照');
  assert.equal(hit.sectionName, '人像');
  assert.ok(hit.matches.some(match => match.field === 'rawText'));
});

test('normalized matching reports stable UTF-16 offsets in original text', () => {
  const favorites = createFavorites({ storage: createStorage() });
  const series = favorites.saveSeries({ name: 'Style' }).data;
  const entry = favorites.saveEntry({ kind: 'tag', seriesId: series.id, rawText: '前缀 BLUE_hair 后缀' }).data;
  const hit = favorites.search('blue hair', { scope: 'internal' }).items[0];
  const match = hit.matches.find(row => row.field === 'rawText');
  assert.equal(hit.entryId, entry.id);
  assert.equal(hit.rawText.slice(match.start, match.end), 'BLUE_hair');
});

test('highlight offsets include every repeated occurrence in the matched original field', () => {
  const favorites = createFavorites({ storage: createStorage() });
  const series = favorites.saveSeries({ name: 'Style' }).data;
  favorites.saveEntry({ kind: 'bundle', seriesId: series.id, rawText: 'blue_hair, blue hair' });
  const hit = favorites.search('blue hair', { scope: 'internal' }).items[0];
  const rawMatches = hit.matches.filter(row => row.field === 'rawText');
  assert.deepEqual(rawMatches.map(row => hit.rawText.slice(row.start, row.end)), ['blue_hair', 'blue hair']);
});

test('exact name and raw matches rank before prefixes and general contains matches', () => {
  const favorites = createFavorites({ storage: createStorage() });
  const series = favorites.saveSeries({ name: 'Style' }).data;
  const contains = favorites.saveEntry({ kind: 'tag', seriesId: series.id, rawText: 'very blue hair style' }).data;
  const prefix = favorites.saveEntry({ kind: 'tag', seriesId: series.id, rawText: 'blue hair style' }).data;
  const exact = favorites.saveEntry({ kind: 'tag', seriesId: series.id, rawText: 'blue_hair' }).data;
  assert.deepEqual(favorites.search('blue hair', { scope: 'internal' }).items.map(row => row.entryId), [exact.id, prefix.id, contains.id]);
});

test('multi-term queries match across fields and ties retain shelf order', () => {
  const favorites = createFavorites({ storage: createStorage() });
  const series = favorites.saveSeries({ name: 'Style' }).data;
  const first = favorites.saveEntry({ kind: 'tag', seriesId: series.id, title: 'Portrait', rawText: 'blue_hair', aliases: ['hero'] }).data;
  const second = favorites.saveEntry({ kind: 'tag', seriesId: series.id, title: 'Portrait', rawText: 'green_eyes', aliases: ['hero'] }).data;
  assert.equal(favorites.search('portrait blue', { scope: 'internal' }).items[0].entryId, first.id);
  assert.deepEqual(favorites.search('portrait', { scope: 'internal' }).items.map(row => row.entryId), [first.id, second.id]);
});

test('search applies kind, parent, adult and pagination filters with accurate totals', () => {
  const favorites = createFavorites({ storage: createStorage() });
  const a = favorites.saveSeries({ name: 'A' }).data;
  const b = favorites.saveSeries({ name: 'B' }).data;
  const section = favorites.saveSection({ seriesId: a.id, name: 'Section' }).data;
  favorites.saveEntry({ kind: 'tag', seriesId: a.id, sectionId: section.id, rawText: 'common one' });
  favorites.saveEntry({ kind: 'bundle', seriesId: a.id, sectionId: section.id, rawText: 'common two', nsfw: true });
  favorites.saveEntry({ kind: 'tag', seriesId: b.id, rawText: 'common three' });
  assert.equal(favorites.search('common', { scope: 'internal', includeAdult: false }).total, 2);
  assert.equal(favorites.search('common', { scope: 'internal', includeAdult: true, seriesId: a.id, sectionId: section.id, kind: 'bundle' }).total, 1);
  const page = favorites.search('common', { scope: 'internal', includeAdult: true, offset: 1, limit: 1 });
  assert.equal(page.total, 3);
  assert.equal(page.items.length, 1);
  assert.equal(page.hasMore, true);
});

test('mutations, undo and imports invalidate old search results by revision', () => {
  const favorites = createFavorites({ storage: createStorage() });
  const series = favorites.saveSeries({ name: 'Style' }).data;
  const entry = favorites.saveEntry({ kind: 'tag', seriesId: series.id, rawText: 'backlighting' }).data;
  const firstRevision = favorites.search('backlighting', { scope: 'internal' }).revision;
  favorites.saveEntry({ id: entry.id, rawText: 'diffuse light' });
  assert.equal(favorites.search('backlighting', { scope: 'internal' }).total, 0);
  assert.ok(favorites.search('diffuse', { scope: 'internal' }).revision > firstRevision);
  favorites.undo();
  assert.equal(favorites.search('backlighting', { scope: 'internal' }).total, 1);
});

test('member counts are returned only when tag segmentation is reliable', () => {
  assert.equal(favoriteMemberCount({ kind: 'tag', rawText: 'oil painting' }), 1);
  assert.equal(favoriteMemberCount({ kind: 'bundle', rawText: 'soft lighting, (backlighting:1.2)' }), 2);
  assert.equal(favoriteMemberCount({ kind: 'bundle', rawText: 'A complete natural language prompt with no separators.' }), null);
});
