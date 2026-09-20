'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createUnifiedFixture, addFavoriteLocation } = require('./fixtures/unified-modules.cjs');
const { favoriteMemberCount } = require('../src/modules/favorites');

test('searchability applies to all discovery while private notes remain scoped to favorites', async () => {
  const { favorites } = await createUnifiedFixture();
  const { series, section } = await addFavoriteLocation(favorites, '光照');
  await favorites.saveSection({ id: section.id, seriesId: series.id, name: '人像' });
  const item = (await favorites.saveEntry({
    kind: 'bundle', seriesId: series.id, sectionId: section.id, title: '柔光',
    rawText: 'soft lighting, backlighting', aliases: ['逆光'], note: '人像测试',
    globalSearchable: false
  })).data;
  assert.equal(favorites.search('人像', { scope: 'internal' }).total, 0);
  assert.equal(favorites.list().total, 1);
  assert.equal(favorites.search('人像', { scope: 'global' }).total, 0);
  assert.equal(favorites.search('柔光', { scope: 'global' }).total, 0);
  await favorites.saveEntry({ id: item.id, globalSearchable: true });
  assert.equal(favorites.search('人像测试', { scope: 'internal' }).total, 1);
  assert.equal(favorites.search('人像测试', { scope: 'global' }).total, 0);
  const hit = favorites.search('backlighting', { scope: 'internal' }).items[0];
  assert.equal(hit.entryId, item.id);
  assert.equal(hit.seriesName, '光照');
  assert.equal(hit.sectionName, '人像');
  assert.ok(hit.matches.some(match => match.field === 'rawText'));
});

test('normalized matching reports stable UTF-16 offsets in original text', async () => {
  const { favorites } = await createUnifiedFixture();
  const { series, section } = await addFavoriteLocation(favorites, 'Style');
  const entry = (await favorites.saveEntry({ kind: 'tag', seriesId: series.id, sectionId: section.id, rawText: '前缀 BLUE_hair 后缀' })).data;
  const hit = favorites.search('blue hair', { scope: 'internal' }).items[0];
  const match = hit.matches.find(row => row.field === 'rawText');
  assert.equal(hit.entryId, entry.id);
  assert.equal(hit.rawText.slice(match.start, match.end), 'BLUE_hair');
});

test('highlight offsets include every repeated occurrence in the matched original field', async () => {
  const { favorites } = await createUnifiedFixture();
  const { series, section } = await addFavoriteLocation(favorites, 'Style');
  await favorites.saveEntry({ kind: 'bundle', seriesId: series.id, sectionId: section.id, rawText: 'blue_hair, blue hair' });
  const hit = favorites.search('blue hair', { scope: 'internal' }).items[0];
  const rawMatches = hit.matches.filter(row => row.field === 'rawText');
  assert.deepEqual(rawMatches.map(row => hit.rawText.slice(row.start, row.end)), ['blue_hair', 'blue hair']);
});

test('exact name and raw matches rank before prefixes and general contains matches', async () => {
  const { favorites } = await createUnifiedFixture();
  const { series, section } = await addFavoriteLocation(favorites, 'Style');
  const contains = (await favorites.saveEntry({ kind: 'tag', seriesId: series.id, sectionId: section.id, rawText: 'very blue hair style' })).data;
  const prefix = (await favorites.saveEntry({ kind: 'tag', seriesId: series.id, sectionId: section.id, rawText: 'blue hair style' })).data;
  const exact = (await favorites.saveEntry({ kind: 'tag', seriesId: series.id, sectionId: section.id, rawText: 'blue_hair' })).data;
  assert.deepEqual(favorites.search('blue hair', { scope: 'internal' }).items.map(row => row.entryId), [exact.id, prefix.id, contains.id]);
});

test('multi-term queries match across fields and ties retain shelf order', async () => {
  const { favorites } = await createUnifiedFixture();
  const { series, section } = await addFavoriteLocation(favorites, 'Style');
  const first = (await favorites.saveEntry({ kind: 'tag', seriesId: series.id, sectionId: section.id, title: 'Portrait', rawText: 'blue_hair', aliases: ['hero'] })).data;
  const second = (await favorites.saveEntry({ kind: 'tag', seriesId: series.id, sectionId: section.id, title: 'Portrait', rawText: 'green_eyes', aliases: ['hero'] })).data;
  assert.equal(favorites.search('portrait blue', { scope: 'internal' }).items[0].entryId, first.id);
  assert.deepEqual(favorites.search('portrait', { scope: 'internal' }).items.map(row => row.entryId), [first.id, second.id]);
});

test('search applies kind, parent, adult and pagination filters with accurate totals', async () => {
  const { favorites } = await createUnifiedFixture();
  const { series: a, section } = await addFavoriteLocation(favorites, 'A', 'Section');
  const { series: b, section: secondGroup } = await addFavoriteLocation(favorites, 'B');
  await favorites.saveEntry({ kind: 'tag', seriesId: a.id, sectionId: section.id, rawText: 'common one' });
  await favorites.saveEntry({ kind: 'bundle', seriesId: a.id, sectionId: section.id, rawText: 'common two', nsfw: true });
  await favorites.saveEntry({ kind: 'tag', seriesId: b.id, sectionId: secondGroup.id, rawText: 'common three' });
  assert.equal(favorites.search('common', { scope: 'internal', includeAdult: false }).total, 2);
  assert.equal(favorites.search('common', { scope: 'internal', includeAdult: true, seriesId: a.id, sectionId: section.id, kind: 'bundle' }).total, 1);
  const page = favorites.search('common', { scope: 'internal', includeAdult: true, offset: 1, limit: 1 });
  assert.equal(page.total, 3);
  assert.equal(page.items.length, 1);
  assert.equal(page.hasMore, true);
});

test('mutations, undo and imports invalidate old search results by revision', async () => {
  const { favorites } = await createUnifiedFixture();
  const { series, section } = await addFavoriteLocation(favorites, 'Style');
  const entry = (await favorites.saveEntry({ kind: 'tag', seriesId: series.id, sectionId: section.id, rawText: 'backlighting' })).data;
  const firstRevision = favorites.search('backlighting', { scope: 'internal' }).revision;
  await favorites.saveEntry({ id: entry.id, rawText: 'diffuse light' });
  assert.equal(favorites.search('backlighting', { scope: 'internal' }).total, 0);
  assert.ok(favorites.search('diffuse', { scope: 'internal' }).revision > firstRevision);
  await favorites.undo();
  assert.equal(favorites.search('backlighting', { scope: 'internal' }).total, 1);
});

test('member counts are returned only when tag segmentation is reliable', async () => {
  assert.equal(favoriteMemberCount({ kind: 'tag', rawText: 'oil painting' }), 1);
  assert.equal(favoriteMemberCount({ kind: 'bundle', rawText: 'soft lighting, (backlighting:1.2)' }), 2);
  assert.equal(favoriteMemberCount({ kind: 'bundle', rawText: 'A complete natural language prompt with no separators.' }), null);
});

test('unified favorites filter locations before pagination and never search another page private labels', async () => {
  const { createHarness } = require('./fixtures/tag-library.cjs');
  const { createFavoriteAdapter } = require('../src/modules/tag-library/favorite-adapter');
  const h = createHarness(); await h.ready; const favorites = createFavoriteAdapter({ library: h.library });
  const first = (await favorites.saveEntry({ sourceTagId: 'blue_hair', seriesId: 'home', sectionId: 'daily' })).data;
  const page = (await favorites.saveSeries({ name: 'Other private page' })).data;
  const section = (await favorites.saveSection({ seriesId: page.id, name: 'Other group' })).data;
  await favorites.saveEntry({ sourceTagId: 'blue_hair', seriesId: page.id, sectionId: section.id });
  assert.equal(favorites.search('Other private page', { seriesId: 'home' }).total, 0);
  assert.equal(favorites.search('Other private page').total, 1);
  assert.equal(favorites.search('Other private page', { scope: 'global' }).total, 0);
  const hit = favorites.search('blue hair', { limit: 1 }); assert.equal(hit.total, 1); assert.equal(hit.items[0].favoriteLocations.length, 2); assert.equal(hit.items[0].entryId, first.id);
  await favorites.saveEntry({ id: first.id, nsfw: true });
  assert.equal(favorites.list({ includeAdult: false }).total, 0); assert.equal(favorites.search('blue', { includeAdult: false }).total, 0);
  favorites.dispose();
});
