'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPrimaryTools } = require('../src/modules/primary-tools');
const { createPrimaryAgent } = require('../src/modules/primary-agent');
const { createHarness } = require('./fixtures/tag-library.cjs');
const { createTagAdapter } = require('../src/modules/tag-library/tag-adapter');
const { createFavoriteAdapter } = require('../src/modules/tag-library/favorite-adapter');

test('canonical favorite contract augments the prompt without changing user storage', () => {
  const stored = 'My original instructions';
  const agent = createPrimaryAgent({ prompts: { get: () => stored }, favoritesEnabled: true });
  const prompt = agent.getPrompt();
  assert.ok(prompt.startsWith(stored));
  for (const field of ['items', 'kind', 'favoriteLocations', 'contentOmitted']) assert.ok(prompt.includes(field));
  assert.doesNotMatch(prompt, /可选 favorites|rawText/);
  assert.equal(stored, 'My original instructions');
});

test('real unified Tag queries return favorites once, with full content and no private notes', async () => {
  const h = createHarness(); await h.ready;
  const tags = createTagAdapter({ library: h.library }), favorites = createFavoriteAdapter({ library: h.library });
  const raw = ' soft lighting, (blue hair:1.2) ';
  const saved = await favorites.saveEntry({ kind: 'bundle', seriesId: 'home', sectionId: 'daily', title: 'soft portrait', rawText: raw, note: 'private note' });
  assert.equal(saved.ok, true);
  const tools = createPrimaryTools({ tags, favorites }), before = h.repository.saveCount;
  const result = await tools.call('tags.search', { query: 'soft', includeAdult: false });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.items.length, 1);
  assert.equal(result.data.items[0].id, saved.data.tagId);
  assert.equal(result.data.items[0].content, raw);
  assert.equal(result.data.items[0].kind, 'bundle');
  assert.equal(result.data.items[0].favoriteLocations[0].membershipId, saved.data.id);
  assert.equal('note' in result.data.items[0], false);
  assert.equal(result.data.favorites, undefined);
  assert.deepEqual((await tools.call('tags.search', { query: 'private note' })).data.items, []);
  assert.equal(h.repository.saveCount, before);
});

test('bundle budget omits entire values and still includes later values that fit', async () => {
  const h = createHarness(); await h.ready;
  const tags = createTagAdapter({ library: h.library });
  for (const [name, content] of [['huge', 'x'.repeat(16001)], ['medium', 'm'.repeat(15999)], ['overflow', 'zz'], ['small', 's']]) {
    const result = await tags.addCustom({ kind: 'bundle', displayName: `budget ${name}`, content }); assert.equal(result.ok, true);
  }
  const result = await createPrimaryTools({ tags }).call('tags.search', { query: 'budget' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.data.items.map(row => row.contentOmitted), [true, false, true, false]);
  assert.equal(result.data.items[0].content, undefined); assert.equal(result.data.items[2].content, undefined);
  assert.equal(result.data.items[3].content, 's');
  assert.equal(result.data.items.reduce((total, row) => total + (row.content || '').length, 0), 16000);
});
