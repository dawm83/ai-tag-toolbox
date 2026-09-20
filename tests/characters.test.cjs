'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCharacters } = require('../src/modules/characters');
const { createUnifiedFixture } = require('./fixtures/unified-modules.cjs');
const { createHarness } = require('./fixtures/tag-library.cjs');

async function fixture() {
  return createUnifiedFixture({
    sources: { base: [
      ['blue hair', '蓝发', '', 'hair', '颜色', 0],
      ['adult_test', '分级测试', '', 'nsfw', '其他', 1],
      ['alice_(story)', '爱丽丝', '小爱', 'character', '角色名', 0],
      ['legacy_hero', '旧角色', '', 'character', '角色名', 0]
    ] },
    data: {
      manifest: { source: { kind: 'upstream-not-live-export' } },
      characters: [{ id: 'alice_(story)', seriesId: 'story', trigger: 'alice (story), story', count: 9, tagIds: ['blue hair', 'adult_test'], specificTagIds: ['specific:academy', 'specific:adult'] },
        { id: 'alice_(other)', seriesId: 'other', tagIds: [], specificTagIds: [], count: 1 }],
      specificTags: [{ id: 'specific:academy', en: 'story academy uniform', nsfw: false }, { id: 'specific:adult', en: 'adult reference', nsfw: true }]
    }
  });
}

test('character query resolves shared names and hidden references without exposing specific tags to discovery', async () => {
  const { characters: chars, tags } = await fixture();
  assert.equal(chars.page({ query: '爱丽丝', precision: 'exact' }).items[0].id, 'alice_(story)');
  assert.equal(chars.page({ query: '小爱' }).total, 1);
  assert.equal(chars.page({ query: 'alice' }).total, 2);
  assert.equal(chars.page({ query: 'alice', seriesId: 'story' }).total, 1);
  assert.equal(chars.page({ query: 'story academy uniform' }).total, 0);
  assert.deepEqual(chars.get('alice_(story)').generalTags.map(t => t.en), ['blue hair']);
  assert.deepEqual(chars.get('alice_(story)').specificTags.map(t => t.en), ['story academy uniform']);
  assert.equal(chars.get('alice_(story)', { includeAdult: true }).generalTags.length, 2);
  assert.equal(tags.search('story academy uniform', { includeAdult: true }).length, 0);
  assert.equal(tags.get('specific:academy').en, 'story academy uniform');
  assert.equal(chars.get('legacy_hero').hasFeatures, false);
  assert.equal(chars.get('unknown'), null);
});

test('character selections restore by reference and obey adult visibility without changing manual tags', async () => {
  const h = await fixture(), { characters: chars, tags } = h;
  await tags.select('blue hair');
  assert.equal((await chars.select('alice_(story)', { generalTagIds: ['not real'] })).ok, false);
  assert.equal((await chars.select('alice_(story)', { generalTagIds: ['blue hair', 'adult_test'], specificTagIds: ['specific:academy', 'specific:adult'], includeSeries: true })).ok, true);
  assert.deepEqual(chars.selected()[0].tags, ['alice_\\(story\\)', 'story', 'blue hair', 'story academy uniform']);
  const restored = (await h.reopen()).characters;
  assert.deepEqual(restored.selected(), chars.selected());
  await chars.removeSelection('alice_(story)');
  assert.deepEqual(tags.selected().map(t => t.id), ['blue hair']);
  await chars.select('alice_(story)', { generalTagIds: ['adult_test'], includeAdult: true, includeSeries: false });
  assert.equal(chars.selectionText().includes('adult_test'), false);
  assert.equal(chars.selectionText({ includeAdult: true }).includes('adult_test'), true);
  await chars.clearSelection();
  assert.equal(chars.selected().length, 0);
});

test('all role pages are reachable and scoped searches keep the series filter', async () => {
  const characters = Array.from({ length: 1203 }, (_, i) => ({ id: 'hero_' + i, seriesId: 'a', tagIds: [], specificTagIds: [] }));
  const { characters: chars } = await createUnifiedFixture({ data: { characters, specificTags: [], manifest: {} } });
  const page = chars.page({ query: 'hero', seriesId: 'a', offset: 1200, limit: 50 });
  assert.equal(page.total, 1203);
  assert.equal(page.items.length, 3);
  assert.equal(page.hasMore, false);
  assert.equal(chars.page({ query: 'hero', seriesId: 'absent' }).total, 0);
  assert.equal(chars.series({ query: 'a' }).find(s => s.id === 'a').count, 1203);
});

test('invalid character source fails explicitly instead of silently returning an empty library', async () => {
  const h = createHarness(); await h.ready;
  assert.throws(() => createCharacters({ library: h.library, characterSource: {} }), /角色/);
  assert.throws(() => createCharacters({ library: h.library, characterSource: { characters: [{ id: 'alice' }, { id: 'alice' }] } }), /角色/);
});

test('character audit count is available before the shared library becomes ready', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const h = createHarness({ repository: { read: async () => { await pending; return null; }, save: async () => {} } });
  const chars = createCharacters({ library: h.library, characterSource: { characters: [{ id: 'alice' }, { id: 'bob' }] } });
  assert.equal(chars.count(), 2);
  assert.equal(chars.manifest().loadedCharacters, undefined);
  release(); await h.ready;
  assert.equal(chars.manifest().loadedCharacters, 2);
});

test('character name index derives identities from all shared source and fallback records', async () => {
  const { tags } = await fixture();
  const index = tags.characterNameIndex();
  assert.equal(index.length, 3);
  assert.equal(index.find(row => row.id === 'alice_(story)').zh, '爱丽丝');
  assert.deepEqual(index.find(row => row.id === 'alice_(story)').aliases, ['小爱']);
  assert.ok(index.every(row => row.usages.includes('characterIdentity')));
});

test('canonical factory accepts complete seed audit rows without accessing legacy tags, terms, or storage', async () => {
  const h = createHarness(); await h.ready;
  const source = { characters: [{ id: 'alice', trigger: 'audit trigger', count: 9 }, { id: 'bob', fallback: true }], manifest: { source: 'unified' } };
  const options = { library: h.library, characterSource: source };
  for (const key of ['tags', 'storage', 'data', 'dataDir']) Object.defineProperty(options, key, { get() { throw new Error('legacy source accessed'); } });
  const characters = createCharacters(options);
  source.characters[0].trigger = 'external mutation'; source.characters[0].count = 0;
  assert.equal(characters.count(), 2); assert.equal(characters.size(), 2);
  assert.equal(characters.get('alice').trigger, 'audit trigger'); assert.equal(characters.get('alice').count, 9);
  assert.equal(characters.manifest().legacyFallbackCharacters, 1);
  assert.equal(characters.page({ offset: 1, limit: 1 }).items[0].id, 'bob');
  assert.equal(characters.get('missing'), null);
  assert.equal(characters.editHistory().error.code, 'FEATURE_UNAVAILABLE');
});
