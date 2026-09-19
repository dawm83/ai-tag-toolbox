'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createStorage } = require('../src/modules/storage');
const { createTags } = require('../src/modules/tags');
const { createCharacters } = require('../src/modules/characters');

test('tag edits persist as user overrides, expose history, and restore the source value', () => {
  const storage = createStorage();
  const tags = createTags({ storage, sources: { categories: [], base: [{ id: 'blue_hair', en: 'blue hair', zh: '蓝发', category: 'hair', subcategory: '发色' }] } });
  const edited = tags.edit('blue_hair', { zh: '蓝色头发', aliases: ['蓝发色'] });
  assert.equal(edited.ok, true);
  assert.equal(tags.get('blue_hair').zh, '蓝色头发');
  assert.equal(tags.get('blue_hair').edited, true);
  assert.equal(tags.editHistory('blue_hair').length, 1);
  assert.equal(tags.restore('blue_hair').ok, true);
  assert.equal(tags.get('blue_hair').zh, '蓝发');
  assert.equal(tags.get('blue_hair').edited, undefined);
  assert.equal(tags.editHistory('blue_hair').length, 2);
  const restored = createTags({ storage, sources: { categories: [], base: [{ id: 'blue_hair', en: 'blue hair', zh: '蓝发', category: 'hair', subcategory: '发色' }] } });
  assert.equal(restored.get('blue_hair').zh, '蓝发');
});

test('character edits persist names and tag references without changing bundled source records', () => {
  const storage = createStorage();
  const tags = createTags({ storage, sources: { categories: [], base: [{ id: 'miku', en: 'miku', zh: '', category: 'character_names', subcategory: '角色名' }, { id: 'blue_hair', en: 'blue hair', zh: '', category: 'hair' }] } });
  const characters = createCharacters({ storage, tags, data: {
    characters: [{ id: 'miku', name: 'hatsune_miku', nameZh: '', seriesId: 'vocaloid', seriesName: 'Vocaloid', tagIds: ['blue_hair'], specificTagIds: [] }],
    specificTags: [], manifest: { counts: { characters: 1 } }
  } });
  const edited = characters.edit('miku', { nameZh: '初音未来', aliases: ['Miku'], tagIds: ['blue_hair', 'long hair'] });
  assert.equal(edited.ok, true);
  assert.equal(characters.get('miku').nameZh, '初音未来');
  assert.equal(tags.get('miku').zh, '初音未来');
  assert.deepEqual(characters.get('miku').generalTags.map(row => row.id), ['blue_hair', 'long hair']);
  assert.equal(characters.editHistory('miku').length, 1);
  assert.equal(characters.restore('miku').ok, true);
  assert.equal(characters.get('miku').nameZh, '');
  assert.deepEqual(characters.get('miku').generalTags.map(row => row.id), ['blue_hair']);
});

test('editing the shared character Tag is reflected by an already loaded character record', () => {
  const storage = createStorage();
  const tags = createTags({ storage, sources: { categories: [], base: [{ id: 'miku', en: 'miku', zh: '初音未来', category: 'character_names', subcategory: '角色名' }] } });
  const characters = createCharacters({ storage, tags, data: { characters: [{ id: 'miku', name: 'miku', nameZh: '', seriesId: 'vocaloid', seriesName: 'Vocaloid', tagIds: [], specificTagIds: [] }], specificTags: [], manifest: { counts: { characters: 1 } } } });
  assert.equal(characters.get('miku').nameZh, '初音未来');
  tags.edit('miku', { zh: '未来酱' });
  assert.equal(characters.get('miku').nameZh, '未来酱');
});

test('favorite entries retain the character source reference for role-originated favorites', () => {
  const { createFavorites } = require('../src/modules/favorites');
  const favorites = createFavorites({ storage: createStorage() });
  const page = favorites.saveSeries({ name: 'Page' }).data;
  const section = favorites.saveSection({ seriesId: page.id, name: 'Column' }).data;
  const entry = favorites.saveEntry({ seriesId: page.id, sectionId: section.id, rawText: 'hatsune_miku, vocaloid', sourceCharacterId: 'miku' }).data;
  assert.equal(entry.sourceCharacterId, 'miku');
  assert.equal(favorites.getEntry(entry.id).sourceCharacterId, 'miku');
});
