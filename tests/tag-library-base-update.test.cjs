'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createTagLibrary } = require('../src/modules/tag-library/library');
const { createLibraryRepository } = require('../src/modules/tag-library/repository');
const { makeBase, emptyUserDocument, createMemoryRepository } = require('./fixtures/tag-library.cjs');
const { metadataUpdateRecord, taxonomyUpdateRecord } = require('../src/modules/tag-library/base-update');

function fixture() {
  const oldBase = makeBase(), nextBase = structuredClone(oldBase);
  nextBase.fingerprint = 'metadata-revision-2';
  nextBase.tags.find(row => row.id === 'blue_hair').displayName = '新的内置名称';
  nextBase.tags.find(row => row.id === 'long_hair').displayName = '新内置长发';
  const document = emptyUserDocument(oldBase);
  document.tagOverrides = [{ tagId: 'blue_hair', patch: { displayName: '', note: '我的备注' }, revision: 1, updatedAt: 10 }];
  document.memberships = [{ id: 'favorite', tagId: 'blue_hair', groupId: 'daily', order: 0, pinned: false }];
  const baseUpdates = [{ kind: 'metadata-only', from: oldBase.fingerprint, to: nextBase.fingerprint }];
  return { oldBase, nextBase, document, baseUpdates };
}

test('a known metadata base upgrade preserves explicit user fields and all references in one save', async () => {
  const { nextBase: base, document, baseUpdates } = fixture();
  const repository = createMemoryRepository(document);
  const library = createTagLibrary({ base, repository, baseUpdates });
  assert.equal((await library.ready()).ok, true);
  assert.equal(library.getTag('blue_hair').displayName, '');
  assert.equal(library.getTag('blue_hair').note, '我的备注');
  assert.equal(library.getTag('long_hair').displayName, '新内置长发');
  assert.equal(library.getMemberships('blue_hair')[0].id, 'favorite');
  assert.equal(repository.saveCount, 1);
  const saved = await repository.read();
  assert.equal(saved.baseFingerprint, base.fingerprint);
  assert.deepEqual(saved.tagOverrides, document.tagOverrides);
  const again = createTagLibrary({ base, repository, baseUpdates });
  assert.equal((await again.ready()).ok, true);
  assert.equal(repository.saveCount, 1);
});

test('unknown revisions and failed metadata upgrade writes keep the old document untouched', async () => {
  const { nextBase: base, document, baseUpdates } = fixture();
  let repository = createMemoryRepository(document);
  const unknown = createTagLibrary({ base, repository });
  assert.equal((await unknown.ready()).ok, false);
  assert.equal(repository.saveCount, 0);
  const controls = {}; repository = createMemoryRepository(document, controls); controls.failNextSave();
  const library = createTagLibrary({ base, repository, baseUpdates });
  assert.equal((await library.ready()).ok, false);
  assert.deepEqual(await repository.read(), document);
  assert.equal((await library.retryInitialization()).ok, true);
  assert.equal(library.getTag('blue_hair').displayName, '');
});

test('upgrading a real temporary file keeps an exact pre-upgrade backup', async t => {
  const { nextBase: base, document, baseUpdates } = fixture();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tag-base-update-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'library.json'), backupDir = path.join(dir, 'backups');
  const bytes = Buffer.from(JSON.stringify(document)); await fs.writeFile(filePath, bytes);
  const repository = createLibraryRepository({ filePath, backupDir });
  const library = createTagLibrary({ base, repository, baseUpdates });
  assert.equal((await library.ready()).ok, true);
  assert.deepEqual(await fs.readFile(path.join(backupDir, 'library.json.bak')), bytes);
  await fs.writeFile(filePath, '{broken');
  const restarted = createTagLibrary({ base, repository, baseUpdates });
  assert.equal((await restarted.ready()).ok, false);
  assert.equal((await restarted.recoverBackup()).ok, true);
  assert.equal(restarted.getTag('blue_hair').note, '我的备注');
});

test('metadata compatibility is rejected when Tag identity, original content or relationships change', () => {
  const { oldBase, nextBase } = fixture();
  assert.equal(metadataUpdateRecord(oldBase, nextBase).changedTags, 2);
  for (const change of [base => { base.tags[0].content = 'different'; }, base => { base.tags[0].id = 'different'; }, base => { base.characterLinks[0].generalTagIds = []; }, base => { base.tags[0].searchable = false; }]) {
    const changed = structuredClone(nextBase); change(changed);
    assert.throws(() => metadataUpdateRecord(oldBase, changed));
  }
});

test('taxonomy update proof only permits adult promotion from the model bucket into the adult category', () => {
  const {oldBase,nextBase}=fixture();
  oldBase.tags[0].categoryId='wd_general';nextBase.tags[0].categoryId='nsfw';nextBase.tags[0].adult=true;
  assert.equal(taxonomyUpdateRecord(oldBase,nextBase).kind,'taxonomy-only');
  assert.throws(()=>metadataUpdateRecord(oldBase,nextBase));
  for(const change of [b=>{b.tags[0].content='rewritten';},b=>{b.tags[0].searchable=false;},b=>{b.tags[0].categoryId='hair';},b=>{b.tags[1].adult=true;}]){
    const changed=structuredClone(nextBase);change(changed);assert.throws(()=>taxonomyUpdateRecord(oldBase,changed));
  }
});

test('the shipped update upgrades the previous full corpus without changing user overrides or shared IDs', async () => {
  const { loadBundledBase } = require('../src/modules/tag-library');
  const { buildUnifiedSeed } = require('../src/modules/tag-library/seed');
  const { loadTagFiles } = require('../src/modules/tags');
  const old = buildUnifiedSeed({ tags: loadTagFiles({ assetDir: path.resolve(__dirname, '../assets') }), characters: require('../assets/数据资产/角色/characters.json'), specificTags: require('../assets/数据资产/角色/specific-tags.json'), manifest: require('../assets/数据资产/角色/manifest.json') }, { enrich: false });
  assert.equal(old.ok, true);
  const loaded = loadBundledBase(); assert.equal(loaded.ok, true);
  const document = emptyUserDocument(old.data);
  document.tagOverrides = [{ tagId: 'blue_hair', patch: { displayName: '', note: '明确保留空名称' }, revision: 1, updatedAt: 1 }];
  document.memberships = [{ id: 'favorite', tagId: 'blue_hair', groupId: 'daily', order: 0, pinned: false }];
  const repository = createMemoryRepository(document);
  const library = createTagLibrary({ base: loaded.data, baseUpdates: loaded.baseUpdates, repository });
  assert.equal((await library.ready()).ok, true);
  assert.equal(library.getTag('blue_hair').displayName, '');
  assert.equal(library.getTag('blue_hair').categoryId, 'hair');
  assert.equal(library.getTag('blue_hair').content, 'blue_hair');
  assert.equal(library.getTag('fu_hua_(azure_empyrea)').displayName, '符华（云墨丹心）');
  assert.equal(library.getMemberships('blue_hair')[0].id, 'favorite');
  assert.equal(library.listTags({ includeAdult: true, limit: 0 }).total, 53707);
});

test('metadata reclassification preserves a user subcategory override with its original parent', async () => {
  const oldBase = makeBase();
  oldBase.categories.push({ id: 'other', name: 'Other', order: 1, source: 'bundled' });
  oldBase.subcategories.push({ id: 'other-default', categoryId: 'other', name: 'Default', order: 0, source: 'bundled' });
  const nextBase = structuredClone(oldBase); nextBase.fingerprint = 'metadata-reclassified';
  for (const tag of nextBase.tags.slice(0, 2)) { tag.categoryId = 'other'; tag.subcategoryId = 'other-default'; }
  const document = emptyUserDocument(oldBase);
  document.tagOverrides = [{ tagId: 'blue_hair', patch: { subcategoryId: 'shape', displayName: '', note: 'Keep user note', aliases: [] }, revision: 3, updatedAt: 42 }];
  const repository = createMemoryRepository(document), baseUpdates = [metadataUpdateRecord(oldBase, nextBase)];
  const library = createTagLibrary({ base: nextBase, repository, baseUpdates });
  assert.equal((await library.ready()).ok, true);
  assert.equal(library.getTag('blue_hair').categoryId, 'hair'); assert.equal(library.getTag('blue_hair').subcategoryId, 'shape');
  assert.equal(library.getTag('long_hair').categoryId, 'other'); assert.equal(library.getTag('long_hair').subcategoryId, 'other-default');
  assert.deepEqual((await repository.read()).tagOverrides, [{ ...document.tagOverrides[0], patch: { categoryId: 'hair', ...document.tagOverrides[0].patch } }]);
  const again = createTagLibrary({ base: nextBase, repository, baseUpdates });
  assert.equal((await again.ready()).ok, true); assert.equal(repository.saveCount, 1);
  assert.equal(again.getTag('blue_hair').subcategoryId, 'shape');
});
