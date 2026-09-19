'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, makeBase } = require('./fixtures/tag-library.cjs');
const { createCharacters } = require('../src/modules/characters');
const { createTags } = require('../src/modules/tags');
const { createFavorites } = require('../src/modules/favorites');
const { formatTagOutput } = require('../src/modules/tag-library/selection');
let op = 0;
const run = (library, command) => library.execute(command, { operationId: `character-test:${++op}` });
async function fixture() {
  const base = makeBase();
  const alice = base.tags.find(row => row.id === 'alice');
  Object.assign(alice, { id: 'identity:alice', content: 'alice (story)', displayName: '爱丽丝', aliases: ['小爱'] });
  base.characterLinks[0].identityTagId = alice.id;
  base.tags.find(row => row.id === 'wonderland').displayName = '仙境';
  const h = createHarness({ base }); assert.equal((await h.ready).ok, true);
  const characterSource = { characters: base.characterLinks.map(row => ({ id: row.characterId, nameZh: '陈旧名称', aliases: ['陈旧别名'], trigger: 'original trigger', seriesId: 'old-series', seriesName: '旧作品', count: row.characterId === 'alice' ? 10 : 1 })), manifest: { source: { kind: 'audit-only' } } };
  const forbidden = new Proxy({}, { get() { throw new Error('legacy store accessed'); } });
  const characters = createCharacters({ library: h.library, characterSource, tags: forbidden, storage: forbidden, dataDir: '/missing' });
  return { ...h, characters, characterSource, base };
}

test('canonical role identity is independent of character ID and source text', async () => {
  const { characters, library } = await fixture();
  const row = characters.get('alice');
  assert.equal(row.id, 'alice'); assert.equal(row.identityTagId, 'identity:alice');
  assert.equal(row.name, 'alice (story)'); assert.equal(row.nameZh, '爱丽丝');
  assert.deepEqual(row.aliases, ['小爱']); assert.equal(row.seriesName, '仙境');
  assert.equal(row.trigger, 'original trigger'); assert.equal(row.count, 10);
  assert.equal((await characters.edit('alice', { name: 'renamed (hero)', nameZh: '', aliases: [] })).ok, true);
  assert.equal(characters.get('alice').nameZh, ''); assert.deepEqual(characters.get('alice').aliases, []);
  assert.equal(characters.get('alice').name, 'renamed (hero)'); assert.equal(library.getTag('alice'), null);
  assert.equal(characters.page({ query: '陈旧' }).total, 0); assert.equal(characters.page({ query: '小爱' }).total, 0);
  assert.equal(characters.page({ query: 'renamed' }).items[0].id, 'alice');
});

test('editing shared traits updates both roles while unlinking affects only one', async () => {
  const { characters, library } = await fixture();
  characters.page({ query: '小爱' }); characters.series({ query: '仙境' });
  await run(library, { type: 'saveTag', tagId: 'blue_hair', patch: { displayName: '蓝色头发' } });
  for (const id of ['alice', 'bob']) assert.equal(characters.get(id).generalTags[0].zh, '蓝色头发');
  assert.equal((await characters.edit('alice', { tagIds: [] })).ok, true);
  assert.deepEqual(characters.get('alice').generalTags, []);
  assert.equal(characters.get('bob').generalTags[0].id, 'blue_hair'); assert.ok(library.getTag('blue_hair'));
  await run(library, { type: 'saveTag', tagId: 'identity:alice', patch: { displayName: '新名字', aliases: ['新别名'] } });
  await run(library, { type: 'saveTag', tagId: 'wonderland', patch: { displayName: '新作品', aliases: ['作品别名'] } });
  assert.equal(characters.page({ query: '小爱' }).total, 0);
  assert.equal(characters.page({ query: '新别名' }).total, 1);
  assert.equal(characters.page({ query: '作品别名' }).total, 2);
  assert.equal(characters.series({ query: '新作品' })[0].name, '新作品');
  await run(library, { type: 'restoreTag', tagId: 'identity:alice' });
  assert.equal(characters.page({ query: '小爱' }).total, 1);
  assert.equal(characters.get('alice').nameZh, '爱丽丝');
});

test('specific tags are shared editable copy sources but hidden from discovery by default', async () => {
  const { characters, library } = await fixture();
  await run(library, { type: 'saveTag', tagId: 'specific:uniform', patch: { content: 'academy (uniform)', displayName: '学院制服' } });
  assert.equal(characters.get('alice').specificTags[0].en, 'academy (uniform)');
  assert.equal(library.search('academy', { includeAdult: true }).total, 0);
  assert.equal((await characters.select('alice', { specificTagIds: ['specific:uniform'] })).ok, true);
  assert.equal(characters.selectionText(), 'alice \\(story\\), wonderland, academy \\(uniform\\)');
  assert.equal(characters.copyText('alice', { includeSeries: false, specificTagIds: ['specific:uniform'] }), 'alice \\(story\\), academy \\(uniform\\)');
  assert.equal(library.selected({ includeAdult: false })[0].content, characters.selectionText());
  await run(library, { type: 'saveTag', tagId: 'specific:uniform', patch: { searchable: true } });
  assert.equal(library.search('academy', { includeAdult: true }).total, 1);
});

test('character discovery obeys identity and series search flags and adult output remains independent', async () => {
  const { characters, library } = await fixture();
  await characters.select('alice', { generalTagIds: ['blue_hair'], specificTagIds: ['specific:uniform'] });
  await run(library, { type: 'saveTag', tagId: 'blue_hair', patch: { adult: true } });
  await run(library, { type: 'saveTag', tagId: 'specific:uniform', patch: { adult: true } });
  await run(library, { type: 'saveTag', tagId: 'wonderland', patch: { adult: true, searchable: false } });
  assert.equal(characters.selectionText(), 'alice \\(story\\)');
  assert.equal(characters.selectionText({ includeAdult: true }), 'alice \\(story\\), wonderland, blue hair, school uniform');
  assert.deepEqual(characters.get('alice').generalTags, []); assert.deepEqual(characters.series(), []);
  assert.equal(characters.page({ query: '仙境', includeAdult: true }).total, 0);
  await run(library, { type: 'saveTag', tagId: 'identity:alice', patch: { searchable: false } });
  assert.equal(characters.page({ query: 'alice' }).total, 0); assert.equal(characters.page().total, 2); assert.ok(characters.get('alice'));
  await run(library, { type: 'saveTag', tagId: 'identity:alice', patch: { adult: true } });
  assert.equal(characters.get('alice'), null); assert.equal(characters.selected().length, 0);
  assert.equal(characters.selected({ includeAdult: true }).length, 1);
});

test('same names in different series remain distinct stable roles', async () => {
  const { characters, library } = await fixture();
  const series = await run(library, { type: 'saveTag', patch: { content: 'other story', displayName: '另一个作品' } });
  await characters.edit('bob', { nameZh: '爱丽丝', seriesTagIds: [series.data.tagId] });
  assert.equal(characters.page({ query: '爱丽丝', precision: 'exact' }).total, 2);
  assert.deepEqual(characters.page({ query: '爱丽丝', seriesId: 'wonderland' }).items.map(row => row.id), ['alice']);
  assert.deepEqual(characters.page({ query: '爱丽丝', seriesId: series.data.tagId }).items.map(row => row.id), ['bob']);
});

test('edits are atomic, reject missing trait IDs with a location, and protect custom references', async () => {
  const { characters, library, repository } = await fixture();
  const before = await repository.read();
  const bad = await characters.edit('alice', { nameZh: '不得保存', tagIds: ['missing'] });
  assert.equal(bad.ok, false); assert.equal(bad.error.code, 'UNRESOLVED_REFERENCE'); assert.ok(bad.error.fields.length);
  assert.deepEqual(await repository.read(), before); assert.equal(characters.get('alice').nameZh, '爱丽丝');
  const custom = await run(library, { type: 'saveTag', patch: { content: 'new trait' } });
  assert.equal((await characters.edit('alice', { tagIds: [custom.data.tagId] })).ok, true);
  assert.equal((await run(library, { type: 'deleteTag', tagId: custom.data.tagId })).error.code, 'TAG_IN_USE');
  assert.equal((await characters.select('alice', { generalTagIds: ['missing'] })).ok, false);
  await characters.edit('alice', { tagIds: [] });
  assert.equal((await run(library, { type: 'deleteTag', tagId: custom.data.tagId })).ok, true);
});

test('restore character reverts bundled identity and links in one durable undoable commit', async () => {
  const { characters, library, repository, controls, base } = await fixture();
  await characters.edit('alice', { nameZh: '改名', aliases: [], tagIds: [] });
  await run(library, { type: 'saveTag', tagId: 'blue_hair', patch: { displayName: '共享修改' } });
  await run(library, { type: 'favoriteTag', tagId: 'identity:alice', placement: { kind: 'favorite', page: { id: 'home' }, group: { id: 'daily' } } });
  const before = await repository.read(), events = []; library.subscribe(event => events.push(event));
  controls.failNextSave(); assert.equal((await characters.restore('alice')).error.code, 'STORAGE_WRITE_FAILED');
  assert.deepEqual(await repository.read(), before); assert.equal(events.length, 0);
  const saves = repository.saveCount;
  assert.equal((await characters.restore('alice')).ok, true);
  assert.equal(repository.saveCount, saves + 1); assert.equal(events.length, 1);
  assert.deepEqual(library.getCharacterLinks('alice'), base.characterLinks[0]);
  assert.equal(characters.get('alice').nameZh, '爱丽丝'); assert.deepEqual(characters.get('alice').aliases, ['小爱']);
  assert.equal(library.getTag('blue_hair').displayName, '共享修改'); assert.equal(library.getMemberships().length, 1);
  assert.equal((await run(library, { type: 'undo' })).ok, true);
  assert.equal(characters.get('alice').nameZh, '改名'); assert.deepEqual(characters.get('alice').generalTags, []);
  assert.equal((await run(library, { type: 'redo' })).ok, true); assert.equal(characters.get('alice').nameZh, '爱丽丝');
});

test('restore rejects incompatible current selections without rewriting them', async () => {
  const { characters, library, repository } = await fixture();
  await characters.edit('alice', { nameZh: '改名', tagIds: ['long_hair'] });
  await characters.select('alice', { generalTagIds: ['long_hair'] });
  const before = await repository.read(), saves = repository.saveCount;
  assert.equal((await characters.restore('alice')).error.code, 'UNRESOLVED_REFERENCE');
  assert.deepEqual(await repository.read(), before); assert.equal(repository.saveCount, saves);
  await characters.removeSelection('alice'); assert.equal((await characters.restore('alice')).ok, true);
});

test('formatting escapes ordinary tag parentheses once and preserves blocks exactly across facades', async () => {
  const { library } = await fixture();
  const raw = 'already \\(escaped\\), new (paren)';
  const expected = 'already \\(escaped\\), new \\(paren\\)';
  assert.equal(formatTagOutput({ kind: 'tag', content: raw }), expected);
  assert.equal(formatTagOutput({ kind: 'tag', content: expected }), expected);
  const block = '  (Weight:1.2), \\(ESC\\)\n  Raw  ';
  for (const kind of ['bundle', 'legacySnapshot']) assert.equal(formatTagOutput({ kind, content: block }), block);
  await run(library, { type: 'saveTag', tagId: 'blue_hair', patch: { content: raw } });
  const tags = createTags({ library }), favorites = createFavorites({ library });
  await tags.select('blue_hair');
  const favorite = await run(library, { type: 'favoriteTag', tagId: 'blue_hair', placement: { kind: 'favorite', page: { id: 'home' }, group: { id: 'daily' } } });
  assert.equal(tags.get('blue_hair').en, raw); assert.equal(favorites.getEntry(favorite.data.membershipId).rawText, raw);
  assert.equal(tags.selectedText(), expected); assert.equal(tags.copyText(['blue_hair']), expected);
  assert.equal(favorites.copyText([favorite.data.membershipId]), expected); assert.equal(library.selected({ includeAdult: true })[0].content, expected);
  const bundle = await run(library, { type: 'saveTag', patch: { kind: 'bundle', content: block } });
  const member = await run(library, { type: 'favoriteTag', tagId: bundle.data.tagId, placement: { kind: 'favorite', page: { id: 'home' }, group: { id: 'daily' } } });
  assert.equal(tags.copyText([bundle.data.tagId]), block); assert.equal(favorites.copyText([member.data.membershipId]), block);
});

test('selection references survive reload, clear only roles, and returned views do not mutate state', async () => {
  const { characters, library, reload, characterSource } = await fixture();
  await characters.select('alice', { generalTagIds: ['blue_hair'] });
  await run(library, { type: 'select', selected: true, value: { kind: 'tag', tagId: 'long_hair' } });
  const next = createCharacters({ library: await reload(), characterSource });
  assert.deepEqual(next.selected(), characters.selected());
  const row = characters.get('alice'); row.aliases.push('bad'); row.generalTags[0].en = 'bad';
  assert.equal(characters.get('alice').generalTags[0].en, 'blue hair'); assert.deepEqual(characters.get('alice').aliases, ['小爱']);
  assert.equal((await characters.clearSelection()).ok, true);
  assert.equal(characters.selected().length, 0); assert.equal(library.selected({ includeAdult: true })[0].kind, 'tag');
});

test('all public character mutation argument failures resolve Result without writes', async t => {
  const { characters, repository, library } = await fixture();
  const before = await repository.read(), saves = repository.saveCount, revision = library.revision();
  for (const invalid of [null, [], 'bad', 4]) {
    for (const [name, call] of [
      ['edit patch', () => characters.edit('alice', invalid)], ['edit options', () => characters.edit('alice', { nameZh: 'x' }, invalid)],
      ['select settings', () => characters.select('alice', invalid)], ['select options', () => characters.select('alice', {}, invalid)],
      ['restore options', () => characters.restore('alice', invalid)], ['remove options', () => characters.removeSelection('alice', invalid)],
      ['clear options', () => characters.clearSelection(invalid)]
    ]) await t.test(`${name}: ${JSON.stringify(invalid)}`, async () => {
      let promise; assert.doesNotThrow(() => { promise = call(); }); assert.ok(promise instanceof Promise);
      const result = await promise; assert.equal(result.ok, false); assert.equal(result.error.code, 'INVALID_FIELD');
    });
  }
  for (const patch of [{ trigger: 'writable?' }, { seriesName: 'writable?' }, { nameZh: '', displayName: 'conflict' }, { links: { characterId: 'bob' } }]) assert.equal((await characters.edit('alice', patch)).ok, false);
  assert.deepEqual(await repository.read(), before); assert.equal(repository.saveCount, saves); assert.equal(library.revision(), revision);
});

test('malformed optional selection fields and uncloneable edits are invalid rather than defaults or rejections', async () => {
  const { characters, repository } = await fixture();
  const before = await repository.read();
  for (const settings of [{ generalTagIds: null }, { specificTagIds: null }, { includeSeries: null }]) {
    const result = await characters.select('alice', settings); assert.equal(result.ok, false); assert.equal(result.error.code, 'INVALID_FIELD');
  }
  for (const patch of [{ nameZh: () => 'bad' }, { aliases: [() => 'bad'] }]) {
    const result = await characters.edit('alice', patch); assert.equal(result.ok, false); assert.equal(result.error.code, 'INVALID_FIELD');
  }
  for (const id of [null, [], {}, 4, '']) {
    const result = await characters.edit(id, { nameZh: 'bad' }); assert.equal(result.error.code, 'INVALID_FIELD');
  }
  assert.deepEqual(await repository.read(), before);
});

test('restore targets the bundled identity even when current identity was explicitly replaced', async () => {
  const { characters, library } = await fixture();
  await characters.edit('alice', { nameZh: '改名' });
  const replacement = await run(library, { type: 'saveTag', patch: { content: 'replacement', displayName: '替代身份' } });
  const replacementId = replacement.data.tagId;
  await characters.edit('alice', { links: { ...library.getCharacterLinks('alice'), identityTagId: replacementId } });
  assert.equal(characters.get('alice').nameZh, '替代身份');
  assert.equal((await characters.restore('alice')).ok, true);
  assert.equal(characters.get('alice').identityTagId, 'identity:alice'); assert.equal(characters.get('alice').nameZh, '爱丽丝');
  assert.equal(library.getTag(replacementId).displayName, '替代身份');
  assert.equal((await run(library, { type: 'restoreCharacter', characterId: 'missing' })).error.code, 'UNRESOLVED_REFERENCE');
  assert.equal((await run(library, { type: 'restoreCharacter', characterId: 'alice', extra: true })).error.code, 'INVALID_FIELD');
});

test('adapter can be constructed before ready and the same instance sees the completed projection', async () => {
  const { createMemoryRepository, emptyUserDocument } = require('./fixtures/tag-library.cjs');
  const base = makeBase(), memory = createMemoryRepository(emptyUserDocument(base));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const repository = { read: async () => { await gate; return memory.read(); }, save: value => memory.save(value) };
  const h = createHarness({ base, repository });
  const characters = createCharacters({ library: h.library, characterSource: { characters: [{ id: 'alice' }, { id: 'bob' }] } });
  assert.equal(characters.get('alice'), null); assert.equal(characters.page().total, 0); assert.deepEqual(characters.series(), []);
  assert.deepEqual(characters.selected(), []); assert.equal(characters.size(), 0); assert.equal(characters.count(), 2);
  assert.equal((await characters.edit('alice', { nameZh: 'early' })).error.code, 'NOT_READY');
  release(); assert.equal((await characters.ready()).ok, true);
  assert.equal(characters.status().ready, true); assert.equal(characters.get('alice').name, 'alice');
  assert.equal(characters.page().total, 2); assert.equal(characters.size(), 2); assert.equal(characters.series()[0].id, 'wonderland');
});

test('role edit publishes identity and links only after durable save, respects revision, and undoes together', async () => {
  const { characters, library, repository, controls } = await fixture();
  const events = []; library.subscribe(event => events.push(event));
  const gate = controls.delayNextSave(), beforeRevision = library.revision(), beforeSaves = repository.saveCount;
  const pending = characters.edit('alice', { identityPatch: { displayName: '一次修改' }, links: { ...library.getCharacterLinks('alice'), generalTagIds: [] } }, { operationId: 'atomic-edit', expectedRevision: beforeRevision });
  await gate.started;
  assert.equal(characters.get('alice').nameZh, '爱丽丝'); assert.equal(characters.get('alice').generalTags.length, 1); assert.equal(events.length, 0);
  gate.release(); assert.equal((await pending).ok, true);
  assert.equal(repository.saveCount, beforeSaves + 1); assert.equal(events.length, 1);
  assert.ok(events[0].changedTagIds.includes('identity:alice')); assert.ok(events[0].changedCharacterIds.includes('alice'));
  assert.equal(characters.get('alice').nameZh, '一次修改'); assert.deepEqual(characters.get('alice').generalTags, []);
  assert.equal((await characters.edit('alice', { nameZh: 'stale' }, { expectedRevision: beforeRevision })).error.code, 'REVISION_CONFLICT');
  assert.equal((await characters.undo()).ok, true); assert.equal(characters.get('alice').nameZh, '爱丽丝'); assert.equal(characters.get('alice').generalTags.length, 1);
  assert.equal((await characters.redo()).ok, true); assert.equal(characters.get('alice').nameZh, '一次修改');
});
