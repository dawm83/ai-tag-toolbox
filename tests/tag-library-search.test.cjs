'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, makeBase, makeRecord } = require('./fixtures/tag-library.cjs');
const { createTagAdapter } = require('../src/modules/tag-library/tag-adapter');
const { createFavoriteAdapter } = require('../src/modules/tag-library/favorite-adapter');
const { createCharacterAdapter } = require('../src/modules/tag-library/character-adapter');
const { createPrimaryTools } = require('../src/modules/primary-tools');
const { createTranslation } = require('../src/modules/translation');
let sequence = 0;
async function command(h, value) { const result = await h.library.execute(value, { operationId: `search-test:${++sequence}` }); assert.equal(result.ok, true, JSON.stringify(result)); return result.data; }
const favorite = (tagId, group = 'daily') => ({ type: 'favoriteTag', tagId, placement: { kind: 'favorite', page: { id: 'home' }, group: { id: group } } });
function adapters(h) { const tags = createTagAdapter({ library: h.library }); const characters = createCharacterAdapter({ library: h.library, characterSource: { characters: [{ id: 'alice' }, { id: 'bob' }] } }); return { tags, characters, favorites: createFavoriteAdapter({ library: h.library }) }; }

test('discovery respects flags in every scope, while explicit browsing remains available', async () => {
  const h = createHarness(); await h.ready; await command(h, favorite('blue_hair'));
  await command(h, { type: 'saveTag', tagId: 'blue_hair', patch: { searchable: false } });
  for (const scope of ['all', 'favorites', 'characterTraits']) for (const query of ['blue hair', '']) assert.equal(h.library.search(query, { scope, includeAdult: true }).items.some(x => x.id === 'blue_hair'), false);
  assert.ok(h.library.listTags({ scope: 'favorites' }).items.some(x => x.id === 'blue_hair'));
  assert.ok(h.library.getTag('blue_hair'));
  for (const query of [null, undefined]) assert.equal(h.library.search(query).items.some(x => x.id === 'blue_hair'), false);
  await command(h, { type: 'saveTag', tagId: 'alice', patch: { searchable: false } });
  const a = adapters(h), tools = createPrimaryTools(a);
  assert.ok(a.characters.page({ query: '' }).items.some(x => x.id === 'alice'));
  for (const query of ['', '  ', 'alice']) { const result = await tools.call('characters.search', { query }); assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.data.items.some(x => x.id === 'alice'), false); }
  await command(h, { type: 'saveTag', tagId: 'bob', patch: { adult: true } });
  assert.equal(h.library.search('', { scope: 'characters' }).total, 0);
  assert.equal(h.library.search('', { scope: 'characters', includeAdult: true }).total, 1);
});

test('indexed fields, internal notes, Unicode highlights, identity dedup and pagination update atomically', async () => {
  const base = makeBase(); base.tags.push(makeRecord({ id: 'twin', content: 'blue hair', displayName: '蓝发' }));
  const h = createHarness({ base }); await h.ready;
  await command(h, favorite('blue_hair')); const extra = await command(h, { type: 'saveGroup', pageId: 'home', name: '常用收藏' }); await command(h, favorite('blue_hair', extra.groupId));
  await command(h, { type: 'saveTag', tagId: 'blue_hair', patch: { content: '😀ＦＯＯ_bar', displayName: '测试', aliases: ['azure'], note: 'private needle' } });
  const result = h.library.search('foo bar', { scope: 'favorites', precision: 'standard' });
  assert.equal(result.total, 1); assert.equal(result.items[0].favoriteLocations.length, 2);
  assert.ok(result.items[0].matches.some(m => m.field === 'content' && result.items[0].content.slice(m.start, m.end) === 'ＦＯＯ_bar'));
  assert.equal(h.library.search('private needle', { precision: 'broad' }).total, 0);
  assert.equal(h.library.search('private needle', { scope: 'favorites' }).total, 1);
  assert.equal(h.library.search('常用收藏', { scope: 'favorites' }).total, 1);
  assert.equal(h.library.search('azure', { precision: 'exact' }).total, 1);
  await command(h, { type: 'saveTag', tagId: 'blue_hair', allowIndependent: true, patch: { aliases: [], note: '', content: 'blue hair' } });
  assert.equal(h.library.search('azure').total, 0); assert.equal(h.library.search('private needle', { scope: 'favorites' }).total, 0);
  const page = h.library.search('blue hair', { precision: 'exact', offset: 1, limit: 1 }); assert.equal(page.total, 2); assert.equal(page.items.length, 1); assert.equal(page.hasMore, false);
  assert.equal(h.library.search('blue hair', { categoryId: 'missing' }).total, 0);
  const owned = h.library.search('blue hair'); owned.items[0].aliases.push('mutation'); assert.equal(h.library.search('mutation').total, 0);
});

test('canonical character discovery obeys series flags and current names, known relations stay raw', async () => {
  const h = createHarness(); await h.ready; const a = adapters(h), tools = createPrimaryTools(a);
  await command(h, { type: 'saveTag', tagId: 'wonderland', patch: { displayName: '新作品', aliases: ['new series'], searchable: false } });
  for (const query of ['wonderland', '新作品', 'new series']) assert.equal(a.characters.page({ query }).total, 0);
  assert.equal(a.characters.page({ seriesId: 'wonderland' }).total, 2);
  assert.ok(a.characters.get('alice').specificTags.some(t => t.content === 'school uniform'));
  await command(h, { type: 'saveTag', tagId: 'wonderland', patch: { searchable: true, adult: true } });
  assert.equal(a.characters.page({ query: 'new series' }).total, 0); assert.equal(a.characters.page({ query: 'new series', includeAdult: true }).total, 2);
  await command(h, { type: 'saveTag', tagId: 'alice', patch: { content: 'raw (alice)', displayName: '新角色', aliases: [] } });
  const result = await tools.call('characters.search', { query: '新角色' }); assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.data.items[0].identityTags[0], 'raw (alice)');
});

test('AI canonical items own content once, map identity IDs, omit whole over-budget content and never mutate', async () => {
  const base = makeBase(); base.characterLinks[0].identityTagId = 'long_hair';
  const h = createHarness({ base }); await h.ready; await command(h, favorite('long_hair'));
  const a = adapters(h), tools = createPrimaryTools(a), before = h.repository.saveCount;
  const result = await tools.call('tags.search', { query: 'long hair' }); assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.items.length, 1); assert.equal(result.data.items[0].id, 'long_hair'); assert.equal(result.data.items[0].kind, 'tag');
  assert.equal(result.data.items[0].favoriteLocations.length, 1); assert.equal(result.data.items[0].attachedData.characterId, 'alice'); assert.equal(result.data.favorites, undefined); assert.equal(h.repository.saveCount, before);
  const raw = '  (blue hair:1.2),\n'.repeat(1200);
  await command(h, { type: 'saveTag', patch: { kind: 'bundle', content: raw, displayName: 'long bundle' } });
  const bundle = await tools.call('tags.search', { query: 'long bundle' }); assert.equal(bundle.ok, true, JSON.stringify(bundle)); assert.equal(bundle.data.items[0].contentOmitted, true); assert.equal(bundle.data.items[0].content, undefined);
  await command(h, { type: 'saveTag', patch: { content: 'x'.repeat(1100), displayName: 'long single' } });
  const single = await tools.call('tags.search', { query: 'long single' }); assert.equal(single.ok, true, JSON.stringify(single)); assert.equal(single.data.items[0].contentOmitted, true); assert.equal(single.data.items[0].en, undefined);
});

test('translation list/all and result cache respect current single-tag/search/adult eligibility', async () => {
  const base = makeBase(); base.tags.find(tag => tag.id === 'wonderland').displayName = '作品';
  const h = createHarness({ base }); await h.ready; const a = adapters(h), translation = createTranslation({ tags: a.tags });
  assert.equal(translation.translateLocal('blue hair', 'en-zh').text, '蓝发');
  await command(h, { type: 'saveTag', tagId: 'blue_hair', patch: { searchable: false } });
  assert.equal(translation.translateLocal('blue hair', 'en-zh').text, 'blue hair'); assert.deepEqual(translation.findReferences('蓝发'), []);
  await command(h, { type: 'saveTag', tagId: 'blue_hair', patch: { searchable: true, adult: true } });
  assert.deepEqual(translation.findReferences('蓝发'), []); a.tags.setAdult(true); assert.equal(translation.findReferences('蓝发').length, 1);
  a.tags.setAdult(false); assert.deepEqual(translation.findReferences('蓝发'), []);
  await command(h, { type: 'saveTag', patch: { kind: 'bundle', content: 'bundle contents', displayName: '组合名称' } });
  assert.deepEqual(translation.findReferences('组合名称'), []);
  assert.deepEqual(translation.exactMatches('bundle contents'), []);
});

test('precision, ranking, filters and Unicode alias offsets use current metadata', async () => {
  const base = makeBase(); base.tags.push(makeRecord({ id: 'prefix', content: 'blue hair style', displayName: 'prefix' }), makeRecord({ id: 'contains', content: 'very blue hair', displayName: 'contains' }));
  const h = createHarness({ base }); await h.ready;
  assert.deepEqual(h.library.search('blue hair', { precision: 'standard' }).items.map(row => row.id), ['blue_hair', 'prefix', 'contains']);
  assert.deepEqual(h.library.search('blue hair', { precision: 'exact' }).items.map(row => row.id), ['blue_hair']);
  assert.equal(h.library.search('bluehair', { precision: 'standard' }).total, 0);
  assert.equal(h.library.search('bluehair', { precision: 'broad' }).total, 3);
  await command(h, { type: 'saveTag', tagId: 'blue_hair', patch: { aliases: ['😀ＦＯＯ_  BAR foo bar'], displayName: 'unique name' } });
  const tag = h.library.search('foo bar').items[0];
  assert.deepEqual(tag.matches.map(m => tag.aliases[0].slice(m.start, m.end)), ['ＦＯＯ_  BAR', 'foo bar']);
  assert.equal(h.library.search('unique blue').total, 1);
  await command(h, { type: 'saveTag', tagId: 'blue_hair', patch: { subcategoryId: 'shape', displayName: '', aliases: [] } });
  assert.equal(h.library.search('blue hair', { subcategoryId: 'color', precision: 'exact' }).total, 0);
  assert.equal(h.library.search('unique name').total, 0);
  assert.equal(h.library.search('foo bar').total, 0);
  await command(h, { type: 'undo' }); assert.equal(h.library.search('foo bar').total, 1);
  await command(h, { type: 'redo' }); assert.equal(h.library.search('foo bar').total, 0);
  h.controls.failNextSave(); const failed = await h.library.execute({ type: 'saveTag', tagId: 'blue_hair', patch: { aliases: ['failed'] } }, { operationId: 'failed-index' });
  assert.equal(failed.ok, false); assert.equal(h.library.search('failed').total, 0);
});

test('selection preserves caches and copied public records cannot mutate cached character data', async () => {
  const h = createHarness(); await h.ready;
  const reads = { counts: 0, role: 0, subcategories: 0 };
  const library = { ...h.library, tagCounts: options => { reads.counts++; return h.library.tagCounts(options); }, getCharacterLinks: id => { reads.role++; return h.library.getCharacterLinks(id); }, getSubcategories: id => { reads.subcategories++; return h.library.getSubcategories(id); } };
  const tags = createTagAdapter({ library }), characters = createCharacterAdapter({ library, characterSource: { characters: [{ id: 'alice' }, { id: 'bob' }] } });
  tags.page({ query: 'blue' }); characters.page({ query: 'alice' }); const before = { ...reads };
  await command(h, { type: 'select', value: { kind: 'tag', tagId: 'blue_hair' }, selected: true });
  assert.equal(tags.page({ query: 'blue' }).items[0].selected, true); assert.equal(characters.page({ query: 'alice' }).total, 1); assert.deepEqual(reads, before);
  const role = characters.get('alice'); role.identity.aliases.push('corruption'); role.generalTags[0].source.kind = 'custom';
  assert.deepEqual(characters.get('alice').identity.aliases, []); assert.equal(characters.get('alice').generalTags[0].source.kind, 'bundled');
  const counts = tags.categoryCounts(); counts.all = -1; assert.ok(tags.categoryCounts().all > 0);
  await command(h, { type: 'saveTag', tagId: 'alice', patch: { displayName: 'renamed' } });
  assert.equal(characters.page({ query: 'renamed' }).total, 1);
  tags.dispose(); characters.dispose();
});

test('standalone index invalidation skips selection and refreshes content', () => {
  const { createTagSearchIndex } = require('../src/modules/tag-library/search');
  const base = makeBase(); let reads = 0;
  const index = createTagSearchIndex({ getTags: () => { reads++; return base.tags; }, getMemberships: () => [], getCharacterLinks: () => base.characterLinks, getStructure: () => ({ pages: [], groups: [] }) });
  assert.equal(index.search('blue').total, 1); const before = reads;
  index.invalidate({ changedTagIds: [], changedCharacterIds: [], changedMembershipIds: [], structureChanged: false }); assert.equal(index.search('blue').total, 1); assert.equal(reads, before);
  base.tags[0] = { ...base.tags[0], content: 'new content' };
  index.invalidate({ changedTagIds: ['blue_hair'], changedCharacterIds: ['alice', 'bob'], changedMembershipIds: [], structureChanged: false }); assert.equal(index.search('blue').total, 0); assert.equal(index.search('new content').total, 1);
});

test('Unicode composed queries highlight decomposed source graphemes without cutting marks', async () => {
  const h = createHarness(); await h.ready;
  await command(h, { type: 'saveTag', tagId: 'blue_hair', patch: { content: 'cafe\u0301' } });
  const row = h.library.search('café').items[0]; assert.ok(row);
  assert.deepEqual(row.matches.map(match => row.content.slice(match.start, match.end)), ['cafe\u0301']);
});

test('characters sharing an identity keep series matching within each character relation', async () => {
  const base = makeBase();
  base.tags.push(makeRecord({ id: 'other-story', content: 'other story', displayName: '其他作品', usages: ['seriesIdentity'] }));
  base.characterLinks[1].identityTagId = 'alice'; base.characterLinks[1].seriesTagIds = ['other-story'];
  const h = createHarness({ base }); await h.ready; const { characters } = adapters(h);
  assert.deepEqual(characters.page({ query: 'other story' }).items.map(row => row.id), ['bob']);
  assert.deepEqual(characters.page({ query: 'wonderland' }).items.map(row => row.id), ['alice']);
  assert.equal(characters.page({ query: 'wonderland other' }).total, 0);
  assert.equal(characters.page({ query: 'alice' }).total, 2);
  assert.equal(h.library.search('alice', { scope: 'characters' }).total, 1);
  characters.dispose();
});
