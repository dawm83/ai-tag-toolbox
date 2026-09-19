'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { buildUnifiedSeed } = require('../src/modules/tag-library/seed');
const { validateBase, validateLibraryDocument } = require('../src/modules/tag-library/schema');
const { loadTagFiles, createTags } = require('../src/modules/tags');
const { emptyUserDocument } = require('./fixtures/tag-library.cjs');
const root = path.resolve(__dirname, '..');

test('seed keeps ordinary bytes and IDs, distinguishes namesakes, and maps colliding explicit identities', () => {
  const input = { tags: { base: [
    { id: 'raw', en: ' (Blue_Hair:1.2)\nLong\\(x\\) ', zh: '原文', category: 'hair', subcategory: '颜色' },
    { id: 'alice_(a)', en: 'unrelated tag', category: 'other' },
    { id: 'old_character', en: 'old_character', category: 'character_names' },
    { id: 'specific:uniform', en: 'ordinary uniform', category: 'outfit' },
    ['', '', '', 'other', '其他', 0]
  ] }, characters: [
    { id: 'alice_(a)', nameZh: '爱丽丝', seriesId: 'work_a', tagIds: ['raw'], specificTagIds: ['specific:uniform'] },
    { id: 'alice_(b)', nameZh: '爱丽丝', seriesId: 'work_b', tagIds: ['raw'], specificTagIds: ['specific:uniform'] }
  ], specificTags: [{ id: 'specific:uniform', en: ' Odd__Uniform (x) ', nsfw: false }], manifest: {} };
  const before = JSON.stringify(input), result = buildUnifiedSeed(input);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(JSON.stringify(input), before);
  const base = result.data, byId = new Map(base.tags.map(t => [t.id, t]));
  assert.equal(byId.get('raw').content, ' (Blue_Hair:1.2)\nLong\\(x\\) ');
  assert.equal(byId.get('alice_(a)').content, 'unrelated tag');
  assert.notEqual(base.legacyIds.characters['alice_(a)'], 'alice_(a)');
  assert.notEqual(base.legacyIds.characters['alice_(a)'], base.legacyIds.characters['alice_(b)']);
  assert.equal(byId.get(base.legacyIds.specific['specific:uniform']).content, ' Odd__Uniform (x) ');
  assert.equal(byId.get(base.legacyIds.specific['specific:uniform']).searchable, false);
  assert.equal(base.characterLinks.length, 3);
  assert.equal(base.characterInfo.old_character.fallback, true);
  assert.equal(validateBase(base).ok, true);
  assert.equal(JSON.stringify(buildUnifiedSeed(input).data), JSON.stringify(base));
  input.characters[0].tagIds = ['missing'];
  assert.equal(buildUnifiedSeed(input).ok, false);
});

test('full bundled seed is reproducible, retains every ordinary ID, all fallback characters and 804 specific terms', () => {
  const tags = loadTagFiles({ assetDir: path.join(root, 'assets') });
  const read = name => JSON.parse(fs.readFileSync(path.join(root, 'assets/数据资产/角色', name + '.json'), 'utf8'));
  const input = { tags, characters: read('characters'), specificTags: read('specific-tags'), manifest: read('manifest') };
  const result = buildUnifiedSeed(input);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  const base = result.data, byId = new Map(base.tags.map(t => [t.id, t]));
  const ordinary = createTags({ sources: tags }).list({ includeAdult: true });
  for (const old of ordinary) {
    assert.equal(byId.get(old.id)?.content, old.en, old.id);
    for (const alias of old.aliases) assert(byId.get(old.id).aliases.includes(alias), old.id);
    assert.equal(base.metadataById[old.id].count, old.count);
  }
  assert.equal(base.characterLinks.length, 34122);
  assert.equal(Object.values(base.characterInfo).filter(c => c.fallback).length, 523);
  assert.equal(Object.keys(base.legacyIds.specific).length, 804);
  for (const specific of input.specificTags) assert.equal(byId.get(base.legacyIds.specific[specific.id]).content, specific.en);
  assert.equal(validateLibraryDocument(emptyUserDocument(base), base).ok, true);
  assert.equal(JSON.stringify(buildUnifiedSeed(input).data), JSON.stringify(base));
  const committed = JSON.parse(fs.readFileSync(path.join(root, 'assets/数据资产/标签/unified-tag-base.json'), 'utf8'));
  assert.equal(JSON.stringify(committed) === JSON.stringify(base), true, 'committed JSON must match the complete rebuilt seed');
});

test('runtime loads independent copies of the JSON without loading the seed or legacy store', () => {
  const { execFileSync } = require('node:child_process');
  const output = execFileSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const { loadBundledBase } = require('./src/modules/tag-library');
    const a = loadBundledBase(); assert.equal(a.ok, true);
    const original = a.data.tags[0].content; a.data.tags[0].content = 'changed';
    const b = loadBundledBase(); assert.equal(b.data.tags[0].content, original);
    assert.equal(Object.keys(require.cache).some(k => /[\\\\/]seed\\.js$|[\\\\/]tags\\.js$/.test(k)), false);
    console.log('runtime-json-ok');
  `], { cwd: root, encoding: 'utf8' });
  assert.match(output, /runtime-json-ok/);
});
