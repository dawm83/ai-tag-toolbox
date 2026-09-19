'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, makeBase, emptyUserDocument, createMemoryRepository } = require('./fixtures/tag-library.cjs');
const { createTagAdapter } = require('../src/modules/tag-library/tag-adapter');
const { createCharacterAdapter } = require('../src/modules/tag-library/character-adapter');
const { createFavoriteAdapter } = require('../src/modules/tag-library/favorite-adapter');
const { createPrimaryTools } = require('../src/modules/primary-tools');
const { createFixedSubagents } = require('../src/modules/fixed-subagents');
const { createTranslation, buildReference } = require('../src/modules/translation');
function roles(library) { return createCharacterAdapter({ library, characterSource: { characters: [{ id: 'alice' }, { id: 'bob' }] } }); }
async function setupAdult() {
  const h = createHarness(); await h.ready; const tags = createTagAdapter({ library: h.library }), characters = roles(h.library);
  for (const id of ['blue_hair', 'alice', 'specific:uniform', 'wonderland']) assert.equal((await tags.edit(id, { adult: true })).ok, true);
  return { ...h, tags, characters };
}
test('host adult preference bounds AI tag/character discovery and related series/traits', async t => {
  const h = await setupAdult(), tools = createPrimaryTools(h);
  for (const [name, query] of [['tags.search', 'blue hair'], ['characters.search', 'alice'], ['characters.search', 'wonderland']]) await t.test(`${name}: ${query}`, async () => {
    const denied = await tools.call(name, { query, includeAdult: true }); assert.equal(denied.ok, true, JSON.stringify(denied)); assert.equal(denied.data.items.length, 0);
    h.tags.setAdult(true); const allowed = await tools.call(name, { query, includeAdult: true }); assert.equal(allowed.ok, true); assert.ok(allowed.data.items.length);
    assert.equal((await tools.call(name, { query, includeAdult: false })).data.items.length, 0); h.tags.setAdult(false);
  });
  await t.test('safe role filters adult attached relations', async () => {
    const result = await tools.call('characters.search', { query: 'bob', includeAdult: true }); assert.equal(result.ok, true); assert.deepEqual(result.data.items[0].specificTags, []); assert.deepEqual(result.data.items[0].generalTags, []); assert.deepEqual(result.data.items[0].identityTags, ['bob']);
    const tag = await tools.call('tags.search', { query: 'bob', includeAdult: true }); assert.deepEqual(tag.data.items[0].attachedData.appearanceTags, []); assert.deepEqual(tag.data.items[0].attachedData.identityTags, ['bob']);
  });
});
test('host adult preference bounds translation direct paths and actual fixed-subagent tool chain', async () => {
  const h = await setupAdult(); let received;
  const translation = createTranslation({ tags: h.tags, ai: async prompt => { received = prompt; return 'offline output'; } });
  for (const options of [{ includeAdult: true }, { adult: true }, { nsfw: true }]) {
    assert.deepEqual(translation.findReferences('blue hair', options), []);
    assert.deepEqual(translation.exactMatches('blue hair', options), []);
    assert.deepEqual(translation.buildPrompt('blue hair', 'en-zh', options).references, []);
    assert.equal(translation.translateLocal('blue hair', 'en-zh', options).text, 'blue hair');
    assert.deepEqual((await translation.translateWithAI('blue hair', 'en-zh', options)).references, []); assert.deepEqual(received.references, []);
  }
  assert.deepEqual(buildReference('blue hair', { tags: h.tags, catalog: h.tags.list({ includeAdult: true }), includeAdult: true }), []);
  const fixed = createFixedSubagents({ translation });
  const tools = createPrimaryTools({ ...h, runtime: { runSubAgent: (name, { input }) => fixed.resolve(name).run(input) } });
  const denied = await tools.call('translation.translate', { text: 'blue hair', direction: 'en-zh', includeAdult: true, source: 'local' }); assert.equal(denied.ok, true, JSON.stringify(denied)); assert.equal(denied.data.text, 'blue hair'); assert.deepEqual(denied.data.references, []);
  h.tags.setAdult(true); const allowed = await tools.call('translation.translate', { text: 'blue hair', direction: 'en-zh', includeAdult: true, source: 'local' }); assert.equal(allowed.ok, true); assert.equal(allowed.data.text, '蓝发');
  assert.deepEqual(translation.findReferences('blue hair', { includeAdult: false }), []);
  h.tags.setAdult(false); assert.equal(translation.translateLocal('blue hair', 'en-zh', { includeAdult: true }).text, 'blue hair');
});
test('broad alone indexes immutable keywords and current taxonomy, plus compact terms across fields', async () => {
  const base = makeBase(); base.metadataById = { blue_hair: { count: null, categoryCode: null, confidence: null, keywords: ['azure needle'] } };
  const h = createHarness({ base }); assert.equal((await h.ready).ok, true);
  const metadataById = base.metadataById, tags = createTagAdapter({ library: h.library, metadataById });
  metadataById.blue_hair.keywords[0] = 'mutated input';
  assert.equal((await tags.edit('long_hair', { aliases: ['azure'] })).ok, true);
  for (const query of ['azure needle', '头发', '颜色']) {
    assert.ok(tags.search(query, { precision: 'broad' }).some(row => row.id === 'blue_hair'), query);
    for (const precision of ['exact', 'standard']) assert.equal(tags.search(query, { precision }).some(row => row.id === 'blue_hair'), false, `${precision} ${query}`);
  }
  assert.equal(tags.search('mutated input', { precision: 'broad' }).length, 0);
  const alternate = createTagAdapter({ library: h.library, metadataById: { blue_hair: { keywords: ['presentation only'], count: 123 } } });
  assert.equal(alternate.get('blue_hair').count, 123);
  assert.equal(alternate.search('presentation only', { precision: 'broad' }).length, 0);
  assert.equal(alternate.search('azure needle', { precision: 'broad' })[0].id, 'blue_hair'); alternate.dispose();
  await h.library.execute({ type: 'favoriteTag', tagId: 'blue_hair', placement: { kind: 'favorite', page: { id: 'home' }, group: { id: 'daily' } } }, { operationId: 'broad-favorite' });
  const favorites = createFavoriteAdapter({ library: h.library });
  assert.equal(favorites.search('azure needle', { precision: 'broad' }).items[0].tagId, 'blue_hair');
  tags.setSearchPrecision('broad'); const tools = createPrimaryTools({ tags });
  assert.equal((await tools.call('tags.search', { query: 'azure needle' })).data.items[0].id, 'blue_hair');
  const mixed = tags.search('longhair azure', { precision: 'broad' }); assert.equal(mixed.length, 1); assert.equal(mixed[0].id, 'long_hair');
  assert.ok(mixed[0].matches.some(match => match.field === 'content' && mixed[0].content.slice(match.start, match.end) === 'long hair'));
  assert.ok(mixed[0].matches.some(match => match.field === 'aliases.0'));
  assert.equal(tags.search('longhair azure', { precision: 'standard' }).length, 0);
  await h.library.execute({ type: 'saveCategory', id: 'hair', name: '新分类' }, { operationId: 'broad-category' });
  await h.library.execute({ type: 'saveSubcategory', id: 'color', categoryId: 'hair', name: '新子类' }, { operationId: 'broad-subcategory' });
  assert.equal(tags.search('头发', { precision: 'broad' }).length, 0); assert.equal(tags.search('颜色', { precision: 'broad' }).length, 0);
  assert.ok(tags.search('新分类', { precision: 'broad' }).length); assert.ok(tags.search('新子类', { precision: 'broad' }).length);
  await tags.edit('blue_hair', { searchable: false }); assert.equal(tags.search('azure needle', { precision: 'broad', includeAdult: true }).length, 0);
  assert.equal(favorites.search('azure needle', { precision: 'broad' }).total, 0);
  assert.equal((await tools.call('tags.search', { query: 'azure needle' })).data.items.length, 0);
  await tags.edit('long_hair', { adult: true }); assert.equal(tags.search('longhair azure', { precision: 'broad', includeAdult: false }).length, 0);
});
test('pre-ready queries never preserve an empty revision-zero translation or adapter cache', async () => {
  const base = makeBase(), document = emptyUserDocument(base); document.memberships.push({ id: 'fixture-membership', tagId: 'blue_hair', groupId: 'daily', order: 0, pinned: false });
  const memory = createMemoryRepository(document); let release; const gate = new Promise(resolve => { release = resolve; });
  const h = createHarness({ base, repository: { ...memory, read: async () => { await gate; return memory.read(); } } });
  const tags = createTagAdapter({ library: h.library }), characters = roles(h.library), favorites = createFavoriteAdapter({ library: h.library }), translation = createTranslation({ tags });
  assert.equal(tags.page({ query: 'blue' }).total, 0); assert.equal(tags.categoryCounts().all, 0); assert.equal(characters.page({ query: 'alice' }).total, 0); assert.equal(favorites.search('blue').total, 0); assert.equal(favorites.list().total, 0);
  assert.equal(translation.translateLocal('blue hair', 'en-zh').text, 'blue hair'); assert.deepEqual(translation.findReferences('blue hair'), []);
  release(); assert.equal((await h.ready).ok, true); assert.equal(h.library.revision(), 0);
  assert.equal(translation.translateLocal('blue hair', 'en-zh').text, '蓝发');
  assert.equal(translation.translateLocal('blue hair', 'en-zh', { force: true }).text, '蓝发'); assert.equal(translation.findReferences('blue hair').length, 1);
  assert.equal(tags.page({ query: 'blue' }).total, 1); assert.ok(tags.categoryCounts().all); assert.equal(characters.page({ query: 'alice' }).total, 1); assert.equal(favorites.search('blue').total, 1); assert.equal(favorites.list().total, 1);
});

test('character broad page caches follow category and subcategory renames without rebuilding records', async t => {
  for (const [oldName, newName, command] of [
    ['头发', '新分类', { type: 'saveCategory', id: 'hair', name: '新分类' }],
    ['颜色', '新子类', { type: 'saveSubcategory', id: 'color', categoryId: 'hair', name: '新子类' }]
  ]) await t.test(command.type, async () => {
    const h = createHarness(); await h.ready; let reads = 0, change;
    const library = { ...h.library, getCharacterLinks: id => { reads++; return h.library.getCharacterLinks(id); } };
    const characters = roles(library), tags = createTagAdapter({ library }), tools = createPrimaryTools({ tags, characters });
    const query = value => characters.page({ query: value, precision: 'broad' });
    const ai = async value => { const result = await tools.call('characters.search', { query: value, precision: 'broad' }); assert.equal(result.ok, true, JSON.stringify(result)); return result.data; };
    assert.equal(query(oldName).total, 2); assert.equal(query(newName).total, 0);
    assert.equal((await ai(oldName)).total, 2); assert.equal((await ai(newName)).total, 0);
    const beforeReads = reads; h.library.subscribe(event => { change = event; });
    assert.equal((await h.library.execute(command, { operationId: command.type })).ok, true);
    assert.equal(change.structureChanged, true); assert.deepEqual(change.changedCharacterIds, []);
    assert.equal(h.library.search(oldName, { scope: 'characters', precision: 'broad' }).total, 0);
    assert.equal(query(oldName).total, 0); assert.equal(query(newName).total, 2);
    assert.equal((await ai(oldName)).total, 0); assert.equal((await ai(newName)).total, 2);
    assert.equal(reads, beforeReads); characters.dispose(); tags.dispose();
  });
});
