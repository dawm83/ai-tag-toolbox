'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeRecord, makeBase, emptyUserDocument } = require('./fixtures/tag-library.cjs');
const { validateTag, validateLibraryDocument, validateCommand, validateBase } = require('../src/modules/tag-library/schema');

test('content is editable independently of immutable identity and is never normalized', () => {
  const record = makeRecord({ content: ' (blue hair:1.2)\nLong_Hair\\(x\\) ', kind: 'bundle', displayName: '', aliases: [], note: '' });
  assert.equal(validateTag(record).ok, true);
  assert.equal(record.id, 'blue_hair');
  assert.equal(record.content, ' (blue hair:1.2)\nLong_Hair\\(x\\) ');
  for (const patch of [{ apiKey: 'unexpected' }, { content: ' \n ' }, { content: 'x'.repeat(100001) }, { aliases: ['a', 'a'] }, { revision: -1 }, { adult: 1 }, { source: { kind: 'bundled', key: null, token: 'secret' } }, { usages: ['invented'] }]) assert.equal(validateTag({ ...record, ...patch }).ok, false);
});

test('new writes enforce exact content, label, note, alias and structure limits', () => {
  assert.equal(validateTag(makeRecord({ content: 'x'.repeat(32768), displayName: 'n'.repeat(256), note: 'n'.repeat(4096), aliases: Array.from({ length: 64 }, (_, i) => `${i}`) })).ok, true);
  for (const patch of [{ content: 'x'.repeat(32769) }, { displayName: 'n'.repeat(257) }, { note: 'n'.repeat(4097) }, { aliases: ['n'.repeat(257)] }, { aliases: Array.from({ length: 65 }, (_, i) => `${i}`) }]) assert.equal(validateTag(makeRecord(patch)).ok, false);
  for (const type of ['saveCategory', 'savePage']) assert.equal(validateCommand({ type, name: 'n'.repeat(81) }).ok, false);
  const base = makeBase(), doc = emptyUserDocument(base); doc.favoritePages[0].name = 'n'.repeat(81);
  assert.equal(validateLibraryDocument(doc, base).ok, false);
  assert.equal(validateCommand({ type: 'saveTag', patch: {}, placement: { kind: 'taxonomy', category: { create: { name: 'n'.repeat(81) } }, subcategory: { id: 'color' } } }).ok, false);
});

test('v2 validates references, unique identities, sibling order, and taxonomy parents', () => {
  const base = makeBase();
  assert.equal(validateBase(base).ok, true);
  assert.equal(validateLibraryDocument(emptyUserDocument(base), base).ok, true);
  const mutations = [
    d => d.customTags.push(makeRecord()),
    d => d.tagOverrides.push({ tagId: 'missing', patch: { note: '' }, revision: 1, updatedAt: 1 }),
    d => d.tagOverrides.push({ tagId: 'blue_hair', patch: { subcategoryId: 'missing' }, revision: 1, updatedAt: 1 }),
    d => d.favoriteGroups.push({ ...d.favoriteGroups[0], id: 'second' }),
    d => { d.favoriteGroups[0].pageId = 'missing'; },
    d => { d.favoritePages[0].color = 'red'; },
    d => { d.selection = [{ kind: 'tag', tagId: 'missing' }]; },
    d => { d.recentTagIds = ['missing']; },
    d => { d.characterOverrides = [{ ...base.characterLinks[0], identityTagId: 'missing' }]; },
    d => { d.extra = true; },
    d => { d.customCategories = [{ id: 'other', name: '其他', order: 1, source: 'custom' }]; d.tagOverrides = [{ tagId: 'blue_hair', patch: { categoryId: 'other' }, revision: 1, updatedAt: 1 }]; },
    d => { d.tagOverrides = [{ tagId: 'blue_hair', patch: { kind: 'bundle' }, revision: 1, updatedAt: 1 }]; },
    d => { d.memberships = [{ id: 'm', tagId: 'blue_hair', groupId: 'daily', order: 0, pinned: false }, { id: 'n', tagId: 'blue_hair', groupId: 'daily', order: 1, pinned: false }]; }
  ];
  for (const mutate of mutations) { const doc = emptyUserDocument(base); mutate(doc); assert.equal(validateLibraryDocument(doc, base).ok, false, mutate.toString()); }
  const d = emptyUserDocument(base); d.schemaVersion = 1;
  assert.equal(validateLibraryDocument(d, base).error.code, 'UNSUPPORTED_VERSION');
});

test('selection is constrained to the actual character links and legacy snapshots retain raw content', () => {
  const base = makeBase(), doc = emptyUserDocument(base);
  doc.selection = [{ kind: 'character', characterId: 'alice', includeSeries: true, generalTagIds: ['long_hair'], specificTagIds: [] }];
  assert.equal(validateLibraryDocument(doc, base).ok, false);
  doc.selection[0].generalTagIds = ['blue_hair'];
  doc.selection.push({ kind: 'legacySnapshot', id: 'old', content: ' A,\n(B:1.2) ', displayName: '', adult: false });
  assert.equal(validateLibraryDocument(doc, base).ok, true);
  doc.selection.push({ kind: 'character', characterId: 'alice', includeSeries: false, generalTagIds: [], specificTagIds: [] });
  assert.equal(validateLibraryDocument(doc, base).ok, false);
});

test('all command variants enforce allowed fields and nested shapes without implementing commands', () => {
  const placement = { kind: 'favorite', page: { id: 'home' }, group: { create: { name: 'New' } } };
  const links = makeBase().characterLinks[0];
  const valid = [
    { type: 'saveTag', patch: { content: ' RAW \n', aliases: [], displayName: '' }, placement },
    { type: 'favoriteTag', tagId: 'blue_hair', placement }, { type: 'unfavorite', membershipIds: ['m'] },
    { type: 'move', tagId: 'blue_hair', placement }, { type: 'restoreTag', tagId: 'blue_hair' }, { type: 'deleteTag', tagId: 'blue_hair' },
    { type: 'saveCategory', name: 'New' }, { type: 'saveSubcategory', categoryId: 'hair', name: 'New' },
    { type: 'savePage', name: 'New', color: '#aBc123', colorMode: 'custom' }, { type: 'saveGroup', pageId: 'home', name: 'New' },
    { type: 'deleteGroup', groupId: 'daily', mode: 'relocate' }, { type: 'deletePage', pageId: 'home', mode: 'unfavorite' },
    { type: 'saveCharacterLinks', links }, { type: 'editCharacter', characterId: 'alice', identityPatch: { aliases: [] }, links },
    { type: 'select', value: { kind: 'tag', tagId: 'blue_hair' }, selected: true }, { type: 'clearSelection' }, { type: 'markCopied', tagIds: ['blue_hair'] },
    { type: 'batch', operations: [{ type: 'setFlags', tagIds: ['blue_hair'], searchable: false }, { type: 'pin', membershipIds: ['m'], pinned: true }, { type: 'colorPages', pageIds: ['home'], colorMode: 'auto' }, { type: 'move', tagId: 'blue_hair', placement }, { type: 'unfavorite', membershipIds: ['m'] }] },
    { type: 'reorder', kind: 'page', parentId: null, ids: ['home'] }, { type: 'duplicateTag', tagId: 'blue_hair' }, { type: 'applyImport', previewId: 'preview' }, { type: 'undo' }, { type: 'redo' }
  ];
  for (const command of valid) { assert.equal(validateCommand(command).ok, true, command.type); assert.equal(validateCommand({ ...command, apiKey: 'no' }).ok, false, command.type); }
  for (const command of [
    { type: 'saveTag', patch: { id: 'changed' } }, { type: 'saveTag', patch: { content: ' ' } },
    { type: 'saveTag', patch: {}, placement: { ...placement, page: { id: 'home', create: { name: 'Oops' } } } },
    { type: 'favoriteTag', tagId: 'blue_hair', placement: { kind: 'taxonomy', category: { id: 'hair' }, subcategory: { id: 'color' } } },
    { type: 'editCharacter', characterId: 'bob', links }, { type: 'editCharacter', characterId: 'alice', identityPatch: { kind: 'bundle' } },
    { type: 'batch', operations: [{ type: 'undo' }] }, { type: 'batch', operations: [{ type: 'setFlags', tagIds: ['blue_hair'] }] },
    { type: 'reorder', kind: 'group', parentId: null, ids: ['a', 'a'] }, { type: 'savePage', name: 'p', color: 'url(x)' }, { type: 'unknown' }
  ]) assert.equal(validateCommand(command).ok, false, JSON.stringify(command));
});

test('receipt and preserved conflicts validate structure and maps without leaking payloads in errors', () => {
  const base = makeBase(), doc = emptyUserDocument(base);
  doc.unresolved = [{ id: 'u', sourceKey: 'favorites', sourceId: null, reason: 'conflict', payload: { private: 'secret-token' } }];
  doc.migration = { id: 'receipt', sourceFingerprint: 'hash', completedAt: 0, tagIdMap: { old: 'blue_hair' }, favoriteIdMap: {}, characterIdMap: { oldAlice: 'alice' }, counts: { sourceTags: 1, sourceFavorites: 0, linkedFavorites: 0, independentFavorites: 0, unresolved: 1 } };
  assert.equal(validateLibraryDocument(doc, base).ok, true);
  doc.migration.tagIdMap.old = 'missing';
  const result = validateLibraryDocument(doc, base);
  assert.equal(result.ok, false);
  assert.doesNotMatch(JSON.stringify(result), /secret-token/);
});

test('base and custom taxonomy reject duplicate IDs, invalid references, and forged ownership', () => {
  for (const mutate of [
    b => b.tags.push({ ...b.tags[0] }),
    b => b.categories.push({ ...b.categories[0] }),
    b => { b.subcategories[0].categoryId = 'absent'; },
    b => { b.characterLinks[0].seriesTagIds = ['missing']; },
    b => { b.tags[0].kind = 'bundle'; },
    b => { b.categories[0].source = 'custom'; }
  ]) { const base = makeBase(); mutate(base); assert.equal(validateBase(base).ok, false, mutate.toString()); }
  const base = makeBase(), doc = emptyUserDocument(base);
  doc.customCategories = [{ id: 'other', name: 'Other', order: 1, source: 'bundled' }];
  assert.equal(validateLibraryDocument(doc, base).ok, false);
  doc.customCategories[0].source = 'custom';
  assert.equal(validateLibraryDocument(doc, base).ok, true);
});

test('cleared aliases and names are authoritative overrides and validation does not mutate either input', () => {
  const base = makeBase(), doc = emptyUserDocument(base);
  doc.tagOverrides = [{ tagId: 'blue_hair', patch: { displayName: '', aliases: [], note: '', content: '  BLUE,\n(a:1.3)  ' }, revision: 1, updatedAt: 1 }];
  const before = JSON.stringify({ base, doc });
  assert.equal(validateLibraryDocument(doc, base).ok, true);
  assert.equal(JSON.stringify({ base, doc }), before);
});
