'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { joinFavoriteBlocks } = require('../src/modules/favorites-transfer');
const { createUnifiedFixture, addFavoriteLocation } = require('./fixtures/unified-modules.cjs');

test('selection stores live tag references and unfavoriting does not delete the selected shared content', async () => {
  const h = await createUnifiedFixture(), { favorites } = h;
  const { seriesId, sectionId } = await addFavoriteLocation(favorites, 'Light');
  const a = (await favorites.saveEntry({ kind: 'bundle', seriesId, sectionId, title: 'A', rawText: 'soft lighting, blue hair' })).data;
  const b = (await favorites.saveEntry({ kind: 'bundle', seriesId, sectionId, title: 'B', rawText: 'soft lighting, green eyes' })).data;
  await favorites.setSelected(a.id, true);
  await favorites.setSelected(b.id, true);
  await favorites.setSelected(b.id, true);
  await favorites.saveEntry({ id: b.id, title: 'Changed', rawText: 'changed' });
  await favorites.deleteEntries([b.id]);
  await favorites.setSelected(a.id, false);
  const selected = favorites.selected({ includeAdult: true });
  assert.equal(selected.length, 1);
  assert.equal(selected[0].title, 'Changed');
  assert.equal(selected[0].rawText, 'changed');
  assert.equal(selected[0].entryId, null);
  assert.equal((await h.repository.read()).selection[0].tagId, b.tagId);
  assert.equal((await h.reopen()).favorites.selected({ includeAdult: true })[0].rawText, 'changed');
});

test('adult selection filtering and clearSelected do not change shelf entries', async () => {
  const { favorites } = await createUnifiedFixture();
  const { seriesId, sectionId } = await addFavoriteLocation(favorites, 'Mixed');
  const safe = (await favorites.saveEntry({ kind: 'tag', seriesId, sectionId, rawText: 'safe' })).data;
  const adult = (await favorites.saveEntry({ kind: 'tag', seriesId, sectionId, rawText: 'adult', nsfw: true })).data;
  await favorites.setSelected(safe.id, true);
  await favorites.setSelected(adult.id, true);
  assert.deepEqual(favorites.selected({ includeAdult: false }).map(row => row.entryId), [safe.id]);
  assert.equal((await favorites.clearSelected()).ok, true);
  assert.equal(favorites.selected({ includeAdult: true }).length, 0);
  assert.equal(favorites.list({ includeAdult: true }).total, 2);
});

test('joinFavoriteBlocks preserves block bytes and inserts only necessary separators', () => {
  const blocks = ['  first  ', 'second,', 'third; ', 'fourth\n', '', ' fifth'];
  assert.equal(joinFavoriteBlocks(blocks), '  first  , second,third; fourth\n fifth');
  assert.equal(joinFavoriteBlocks(['one']), 'one');
  assert.equal(joinFavoriteBlocks([]), '');
});
