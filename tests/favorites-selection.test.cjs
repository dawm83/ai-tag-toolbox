'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createStorage } = require('../src/modules/storage');
const { createFavorites } = require('../src/modules/favorites');
const { joinFavoriteBlocks } = require('../src/modules/favorites-transfer');

test('selection stores isolated entry snapshots and removing one leaves the others intact', () => {
  const storage = createStorage();
  const favorites = createFavorites({ storage });
  const series = favorites.saveSeries({ name: 'Light' }).data;
  const a = favorites.saveEntry({ kind: 'bundle', seriesId: series.id, title: 'A', rawText: 'soft lighting, blue hair' }).data;
  const b = favorites.saveEntry({ kind: 'bundle', seriesId: series.id, title: 'B', rawText: 'soft lighting, green eyes' }).data;
  favorites.setSelected(a.id, true);
  favorites.setSelected(b.id, true);
  favorites.setSelected(b.id, true);
  favorites.saveEntry({ id: b.id, title: 'Changed', rawText: 'changed' });
  favorites.deleteEntries([b.id]);
  favorites.setSelected(a.id, false);
  const selected = favorites.selected({ includeAdult: true });
  assert.equal(selected.length, 1);
  assert.equal(selected[0].title, 'B');
  assert.equal(selected[0].rawText, 'soft lighting, green eyes');
  assert.equal(createFavorites({ storage }).selected({ includeAdult: true })[0].rawText, 'soft lighting, green eyes');
});

test('adult selection filtering and clearSelected do not change shelf entries', () => {
  const favorites = createFavorites({ storage: createStorage() });
  const series = favorites.saveSeries({ name: 'Mixed' }).data;
  const safe = favorites.saveEntry({ kind: 'tag', seriesId: series.id, rawText: 'safe' }).data;
  const adult = favorites.saveEntry({ kind: 'tag', seriesId: series.id, rawText: 'adult', nsfw: true }).data;
  favorites.setSelected(safe.id, true);
  favorites.setSelected(adult.id, true);
  assert.deepEqual(favorites.selected({ includeAdult: false }).map(row => row.entryId), [safe.id]);
  assert.equal(favorites.clearSelected().ok, true);
  assert.equal(favorites.selected({ includeAdult: true }).length, 0);
  assert.equal(favorites.list({ includeAdult: true }).total, 2);
});

test('joinFavoriteBlocks preserves block bytes and inserts only necessary separators', () => {
  const blocks = ['  first  ', 'second,', 'third; ', 'fourth\n', '', ' fifth'];
  assert.equal(joinFavoriteBlocks(blocks), '  first  , second,third; fourth\n fifth');
  assert.equal(joinFavoriteBlocks(['one']), 'one');
  assert.equal(joinFavoriteBlocks([]), '');
});
