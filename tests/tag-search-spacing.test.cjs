'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, makeBase, makeRecord } = require('./fixtures/tag-library.cjs');
const { createTagAdapter } = require('../src/modules/tag-library/tag-adapter');
const { createCharacterAdapter } = require('../src/modules/tag-library/character-adapter');
const { createFavoriteAdapter } = require('../src/modules/tag-library/favorite-adapter');
const { createPrimaryTools } = require('../src/modules/primary-tools');

async function fixture() {
  const base = makeBase();
  Object.assign(base.tags.find(tag => tag.id === 'alice'), { content: 'fu_hua_(honkai_impact)', displayName: '符华', aliases: ['Fu Hua'] });
  base.tags.push(makeRecord({ id: 'literal', content: 'fuhua', displayName: '字面命中' }));
  const h = createHarness({ base }); await h.ready;
  const tags = createTagAdapter({ library: h.library });
  const characters = createCharacterAdapter({ library: h.library, characterSource: { characters: [{ id: 'alice' }, { id: 'bob' }] } });
  const favorites = createFavoriteAdapter({ library: h.library });
  await h.library.execute({ type: 'favoriteTag', tagId: 'alice', placement: { kind: 'favorite', page: { id: 'home' }, group: { id: 'daily' } } }, { operationId: 'favorite' });
  return { ...h, tags, characters, favorites };
}

test('standard search ignores spaces and underscores across home, roles, favorites and AI tools', async () => {
  const h = await fixture();
  const tools = createPrimaryTools(h);
  for (const query of ['fuhua', 'fu hua', 'fu_hua', 'ＦＵＨＵＡ', 'FU  HUA']) {
    assert(h.tags.search(query).some(row => row.id === 'alice'), query);
    assert(h.characters.page({ query }).items.some(row => row.id === 'alice'), query);
    assert.equal(h.favorites.search(query).total, 1, query);
    const result = await tools.call('tags.search', { query });
    assert.equal(result.ok, true);
    assert(result.data.items.some(row => row.id === 'alice'), query);
  }
  assert.equal(h.tags.search('fuhua')[0].id, 'literal', 'literal equality outranks separator folding');
  assert.deepEqual(h.tags.search('fuhua', { precision: 'exact' }).map(row => row.id), ['literal']);
  assert(h.tags.search('fuhua honkaiimpact').some(row => row.id === 'alice'));
});

test('space-folded highlights map to the original spelling and follow edits and search flags', async () => {
  const h = await fixture();
  const found = h.library.search('fuhua').items.find(row => row.id === 'alice');
  assert(found);
  assert(found.matches.some(hit => hit.field === 'aliases.0' && found.aliases[0].slice(hit.start, hit.end) === 'Fu Hua'));
  await h.library.execute({ type: 'saveTag', tagId: 'alice', patch: { content: 'new_name', aliases: [] } }, { operationId: 'rename' });
  assert.equal(h.characters.page({ query: 'fuhua' }).total, 0);
  assert.equal(h.characters.page({ query: 'newname' }).total, 1);
  await h.library.execute({ type: 'saveTag', tagId: 'alice', patch: { searchable: false } }, { operationId: 'hide' });
  assert.equal(h.tags.search('newname').length, 0);
  assert.equal(h.characters.page({ query: 'newname' }).total, 0);
  assert.equal(h.favorites.search('newname').total, 0);
  await h.library.execute({ type: 'undo' }, { operationId: 'undo' });
  assert.equal(h.characters.page({ query: 'newname' }).total, 1);
});

test('standard separator matching preserves punctuation distinctions and never crosses unrelated fields', async () => {
  const h = createHarness(); await h.ready;
  await h.library.execute({ type: 'saveTag', tagId: 'alice', patch: { content: 'a.b', displayName: 'red', aliases: ['hair'] } }, { operationId: 'setup' });
  assert.equal(h.library.search('ab').total, 0);
  assert.equal(h.library.search('redhair').total, 0);
  assert.equal(h.library.search('ab', { precision: 'broad' }).total, 1);
});
