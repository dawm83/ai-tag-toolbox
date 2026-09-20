'use strict';

const assert = require('node:assert/strict');
const { buildUnifiedSeed } = require('../../src/modules/tag-library/seed');
const { createTags } = require('../../src/modules/tags');
const { createFavorites } = require('../../src/modules/favorites');
const { createCharacters } = require('../../src/modules/characters');
const { createHarness, emptyUserDocument } = require('./tag-library.cjs');

async function createUnifiedFixture(options = {}) {
  const data = options.data || {};
  const seed = options.base ? { ok: true, data: options.base } : buildUnifiedSeed({ tags: options.sources || { base: [] }, ...data });
  assert.equal(seed.ok, true, JSON.stringify(seed.error));
  const base = seed.data;
  const document = emptyUserDocument(base);
  document.favoritePages = []; document.favoriteGroups = [];
  const h = createHarness({ ...options, base, document: Object.hasOwn(options, 'document') ? options.document : document });
  assert.equal((await h.ready).ok, true);
  const characterSource = { characters: base.characterLinks.map(row => ({ id: row.characterId, ...base.characterInfo?.[row.characterId], trigger: base.characterInfo?.[row.characterId]?.sourceTrigger || '' })), manifest: data.manifest || {} };
  const adapters = library => ({
    tags: createTags({ library, metadataById: base.metadataById }),
    favorites: createFavorites({ library }),
    characters: createCharacters({ library, characterSource })
  });
  return { ...h, base, ...adapters(h.library), async reopen() { return adapters(await h.reload()); } };
}

async function addFavoriteLocation(favorites, name = 'Page', groupName = 'Group') {
  const page = await favorites.saveSeries({ name });
  assert.equal(page.ok, true, JSON.stringify(page.error));
  const group = await favorites.saveSection({ seriesId: page.data.id, name: groupName });
  assert.equal(group.ok, true, JSON.stringify(group.error));
  return { series: page.data, section: group.data, seriesId: page.data.id, sectionId: group.data.id };
}

module.exports = { createUnifiedFixture, addFavoriteLocation };
