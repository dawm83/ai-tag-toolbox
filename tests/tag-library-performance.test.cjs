'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, makeBase, emptyUserDocument, createMemoryRepository } = require('./fixtures/tag-library.cjs');
const { createTagAdapter } = require('../src/modules/tag-library/tag-adapter');
const { createLibraryDocumentValidator } = require('../src/modules/tag-library/schema');
const { createTagLibrary } = require('../src/modules/tag-library/library');

test('changing query, category or adult preference does not enumerate results across the bridge', async () => {
  const h = createHarness(); await h.ready;
  let reads = 0;
  const library = { ...h.library,
    listTags: (...args) => { reads++; return h.library.listTags(...args); },
    search: (...args) => { reads++; return h.library.search(...args); }
  };
  const tags = createTagAdapter({ library });
  assert.equal(tags.setCategory('hair'), 'hair');
  assert.equal(tags.setQuery('blue'), 'blue');
  assert.equal(tags.setAdult(true), true);
  assert.equal(reads, 0, 'setters update state; page owns the actual query');
  const page = tags.page({ limit: 1 });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].id, 'blue_hair');
  assert.equal(reads, 1);
});

test('a validated immutable base can be shared without copying or trusting mutated callers', async () => {
  const source = makeBase();
  const prepared = createLibraryDocumentValidator(source);
  assert.equal(prepared.ok, true);
  assert(prepared.base, 'the validator owns the one shared immutable snapshot');
  assert(Object.isFrozen(prepared.base.tags[0]));
  assert.equal(createLibraryDocumentValidator(prepared.base), prepared);
  source.tags[0].categoryId = 'missing';
  assert.equal(createLibraryDocumentValidator(source).ok, false);
  assert.equal(prepared.data(emptyUserDocument(prepared.base)).ok, true);
  const a = createTagLibrary({ base: prepared.base, repository: createMemoryRepository(emptyUserDocument(prepared.base)) });
  const b = createTagLibrary({ base: prepared.base, repository: createMemoryRepository(emptyUserDocument(prepared.base)) });
  assert.equal((await a.ready()).ok, true); assert.equal((await b.ready()).ok, true);
  const changed = await a.execute({ type: 'saveTag', tagId: 'blue_hair', patch: { displayName: 'My blue' } }, { operationId: 'a' });
  assert.equal(changed.ok, true);
  assert.equal(b.getTag('blue_hair').displayName, '蓝发');
  assert.equal(prepared.base.tags[0].displayName, '蓝发');
});

test('runtime seed sharing remains immutable while default loader callers receive independent copies', () => {
  const { loadBundledBase } = require('../src/modules/tag-library');
  const a = loadBundledBase({ shared: true });
  const b = loadBundledBase({ shared: true });
  assert.equal(a.data === b.data, true);
  assert(Object.isFrozen(a.data.tags[0]));
  const working = loadBundledBase();
  working.data.tags[0].displayName = 'changed';
  assert.notEqual(a.data.tags[0].displayName, 'changed');
  assert.notEqual(loadBundledBase().data.tags[0].displayName, 'changed');
});

test('an exclusively owned JSON base can be validated in place while ordinary callers retain copy isolation', () => {
  const owned = makeBase();
  const prepared = createLibraryDocumentValidator(owned, { takeOwnership: true });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.base, owned);
  assert(Object.isFrozen(owned.tags[0].aliases));
  assert.equal(prepared.data(emptyUserDocument(owned)).ok, true);
  const invalid = makeBase(); invalid.tags[0].categoryId = 'missing';
  assert.equal(createLibraryDocumentValidator(invalid, { takeOwnership: true }).ok, false);
  assert.equal(Object.isFrozen(invalid), false);
});

test('category counts do not eagerly read all search text fields', () => {
  const { createTagSearchIndex } = require('../src/modules/tag-library/search');
  let textReads = 0;
  const tag = { ...makeBase().tags[0], get content() { textReads++; return 'blue hair'; } };
  const index = createTagSearchIndex({ getTags: () => [tag], getMemberships: () => [], getCharacterLinks: () => [], getStructure: () => ({ pages: [], groups: [] }) });
  assert.equal(index.counts().categories.hair, 1);
  assert.equal(textReads, 0);
  assert.equal(index.search('bluehair').total, 1);
  assert(textReads > 0);
});
