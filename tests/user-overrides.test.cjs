'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCharacters } = require('../src/modules/characters');
const { createUnifiedFixture, addFavoriteLocation } = require('./fixtures/unified-modules.cjs');
const { createHarness } = require('./fixtures/tag-library.cjs');

test('tag edits persist as shared overrides, use shared history, and restore the source value', async () => {
  const h = await createUnifiedFixture({ sources: { base: [{ id: 'blue_hair', en: 'blue hair', zh: '蓝发', category: 'hair', subcategory: '发色' }] } });
  const { tags } = h;
  assert.equal((await tags.edit('blue_hair', { zh: '蓝色头发', aliases: ['蓝发色'] })).ok, true);
  assert.equal(tags.get('blue_hair').zh, '蓝色头发');
  assert.equal(tags.get('blue_hair').edited, true);
  assert.equal(tags.historyState().canUndo, true);
  assert.equal((await h.reopen()).tags.get('blue_hair').zh, '蓝色头发');
  await tags.undo();
  assert.equal(tags.get('blue_hair').zh, '蓝发');
  await tags.redo();
  assert.equal(tags.get('blue_hair').zh, '蓝色头发');
  assert.equal((await tags.restore('blue_hair')).ok, true);
  assert.equal(tags.get('blue_hair').zh, '蓝发');
  assert.equal(tags.get('blue_hair').edited, false);
  assert.equal((await h.reopen()).tags.get('blue_hair').zh, '蓝发');
});

async function characterFixture() {
  return createUnifiedFixture({
    sources: { base: [{ id: 'miku', en: 'miku', zh: '初音未来', category: 'character_names', subcategory: '角色名' },
      { id: 'blue_hair', en: 'blue hair', category: 'hair' }, { id: 'long_hair', en: 'long hair', category: 'hair' }] },
    data: { characters: [{ id: 'miku', seriesId: 'vocaloid', seriesName: 'Vocaloid', tagIds: ['blue_hair'], specificTagIds: [] }], specificTags: [], manifest: {} }
  });
}

test('character edits persist shared names and validated references without changing the bundled source', async () => {
  const h = await characterFixture(), { tags, characters } = h;
  const before = JSON.stringify(h.base);
  assert.equal((await characters.edit('miku', { nameZh: '未来酱', aliases: ['Miku'], tagIds: ['blue_hair', 'long_hair'] })).ok, true);
  assert.equal(characters.get('miku').nameZh, '未来酱');
  assert.equal(tags.get('miku').zh, '未来酱');
  assert.deepEqual(characters.get('miku').generalTags.map(row => row.id), ['blue_hair', 'long_hair']);
  assert.equal(characters.historyState().canUndo, true);
  assert.equal((await h.reopen()).characters.get('miku').nameZh, '未来酱');
  assert.equal((await characters.restore('miku')).ok, true);
  assert.equal(characters.get('miku').nameZh, '初音未来');
  assert.deepEqual(characters.get('miku').generalTags.map(row => row.id), ['blue_hair']);
  assert.equal(JSON.stringify(h.base), before);
});

test('editing a shared character Tag refreshes an already loaded record and allows clearing text fields', async () => {
  const { tags, characters } = await characterFixture();
  assert.equal(characters.get('miku').nameZh, '初音未来');
  await tags.edit('miku', { zh: '未来酱' });
  assert.equal(characters.get('miku').nameZh, '未来酱');
  await tags.edit('miku', { zh: '', aliases: [] });
  assert.equal(characters.get('miku').nameZh, '');
  assert.deepEqual(characters.get('miku').aliases, []);
});

test('role-originated favorites reference the shared identity instead of storing a second character name', async () => {
  const { tags, characters, favorites } = await characterFixture();
  const { seriesId, sectionId } = await addFavoriteLocation(favorites);
  const entry = (await favorites.saveEntry({ seriesId, sectionId, sourceTagId: characters.get('miku').identityTagId })).data;
  assert.equal(entry.sourceTagId, 'miku');
  await tags.edit('miku', { zh: '共享名称' });
  assert.equal(favorites.getEntry(entry.id).title, '共享名称');
  assert.equal(characters.get('miku').nameZh, '共享名称');
});

test('canonical character edits persist only identity Tag fields and relation overrides', async () => {
  const h = createHarness(); await h.ready;
  const characters = createCharacters({ library: h.library, characterSource: { characters: [{ id: 'alice' }, { id: 'bob' }] } });
  assert.equal((await characters.edit('alice', { nameZh: '统一名称', aliases: [], tagIds: [] })).ok, true);
  const document = await h.repository.read();
  assert.deepEqual(document.tagOverrides[0].patch, { displayName: '统一名称' });
  assert.deepEqual(Object.keys(document.characterOverrides[0]).sort(), ['characterId', 'generalTagIds', 'identityTagId', 'seriesTagIds', 'specificTagIds']);
  const reopened = createCharacters({ library: await h.reload(), characterSource: { characters: [{ id: 'alice' }, { id: 'bob' }] } });
  assert.equal(reopened.get('alice').nameZh, '统一名称'); assert.deepEqual(reopened.get('alice').generalTags, []);
  assert.equal((await reopened.restore('alice')).ok, true); assert.equal(reopened.get('alice').nameZh, 'alice');
});
