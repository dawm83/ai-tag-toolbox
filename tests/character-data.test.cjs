'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createUnifiedFixture } = require('./fixtures/unified-modules.cjs');

const root = path.resolve(__dirname, '..');
const readJson = (...parts) => JSON.parse(fs.readFileSync(path.join(root, ...parts), 'utf8'));
const normalize = value => String(value).trim().toLowerCase().replaceAll('_', ' ').replace(/\s+/g, ' ');

test('generated character catalogue keeps every featured source row and resolves every derived reference', async () => {
  const characters = readJson('assets', '数据资产', '角色', 'characters.json');
  const general = readJson('assets', '数据资产', '标签', 'character-general-tags.json');
  const specific = readJson('assets', '数据资产', '角色', 'specific-tags.json');
  const manifest = readJson('assets', '数据资产', '角色', 'manifest.json');
  const decisions = readJson('assets', '数据资产', '角色', 'word-decisions.json');

  assert.equal(characters.length, 33599);
  assert.equal(new Set(characters.map(item => item.id)).size, characters.length);
  assert.equal(manifest.counts.characters, characters.length);
  assert.equal(manifest.counts.generalAdditions, general.length);
  assert.equal(manifest.counts.specificTerms, specific.length);
  assert.equal(manifest.counts.series, new Set(characters.map(item => item.seriesId).filter(Boolean)).size);
  assert.match(manifest.sourceSha256, /^[0-9a-f]{64}$/);
  assert.equal(manifest.source.kind, 'upstream-not-live-export');

  const generalIds = new Set(general.map(item => item.en.toLowerCase()));
  const specificIds = new Set(specific.map(item => item.id));
  const base = readJson('assets', '数据资产', '标签', 'unified-tag-base.json');
  const { tags } = await createUnifiedFixture({ base });
  assert.equal(generalIds.size, general.length);
  assert.equal(specificIds.size, specific.length);
  for (const character of characters) {
    assert.equal(Array.isArray(character.tagIds), true);
    assert.equal(Array.isArray(character.specificTagIds), true);
    assert.equal(new Set(character.tagIds).size, character.tagIds.length);
    assert.equal(new Set(character.specificTagIds).size, character.specificTagIds.length);
    assert(character.tagIds.every(id => tags.has(id)), `${character.id} has an unresolved ordinary tag`);
    assert(character.specificTagIds.every(id => specificIds.has(id)), `${character.id} has an unresolved specific tag`);
  }
  assert.equal(decisions.length, 1031);
  assert(decisions.every(item => item.decision === 'general' || item.decision === 'specific'));
  const miku = characters.find(item => item.id === 'hatsune_miku');
  assert(miku.tagIds.includes('long hair'));
  assert.equal(miku.tagIds.includes('long_hair'), false);
});

test('explicit naked suspenders stay adult without blanket-classifying naked armor', () => {
  const characters = readJson('assets', '数据资产', '角色', 'characters.json');
  const specific = readJson('assets', '数据资产', '角色', 'specific-tags.json');
  const suspenders = specific.find(item => item.en === 'naked suspenders');
  const armor = specific.find(item => item.en === 'naked armor');
  assert.equal(suspenders.id, 'specific:c1085f4bcdf5cd81');
  assert.equal(suspenders.nsfw, true);
  assert.equal(armor.nsfw, false);
  assert(characters.find(item => item.id === 'chocolate_misu').specificTagIds.includes(suspenders.id));
});

test('curation promotes common visual terms but keeps named and unsafe alias candidates hidden', () => {
  const general = readJson('assets', '数据资产', '标签', 'character-general-tags.json');
  const specific = readJson('assets', '数据资产', '角色', 'specific-tags.json');
  const decisions = readJson('assets', '数据资产', '角色', 'word-decisions.json');
  const generalByTerm = new Map(general.map(item => [normalize(item.en), item]));
  const specificTerms = new Set(specific.map(item => normalize(item.en)));
  const decisionByTerm = new Map(decisions.map(item => [normalize(item.en), item]));

  assert.equal(generalByTerm.get('light green hair').zh, '浅绿色头发');
  assert.equal(generalByTerm.get('braided sidelock').category, 'hair');
  for (const term of ['kibina high school uniform', 'team galactic', 'shield module', 'hands', 'head', 'oil']) {
    assert.equal(specificTerms.has(term), true, `${term} must stay out of the ordinary tag index`);
    assert.equal(decisionByTerm.get(term).decision, 'specific');
  }
  for (const term of ['hands', 'head', 'oil']) assert.equal(decisionByTerm.get(term).review, true);
});

test('generated files contain no image or browsing URL metadata', () => {
  for (const relative of [
    ['assets', '数据资产', '角色', 'characters.json'],
    ['assets', '数据资产', '角色', 'specific-tags.json'],
    ['assets', '数据资产', '标签', 'character-general-tags.json']
  ]) {
    const text = fs.readFileSync(path.join(root, ...relative), 'utf8');
    assert.doesNotMatch(text, /https?:\/\//i);
    assert.doesNotMatch(text, /"(?:image|thumbnail|url)"\s*:/i);
  }
});

test('unified seed alone supplies every canonical role and read-only audit row for preload', async () => {
  const { createHarness } = require('./fixtures/tag-library.cjs');
  const { createCharacters } = require('../src/modules/characters');
  const base = readJson('assets', '数据资产', '标签', 'unified-tag-base.json');
  const characterSource = { characters: base.characterLinks.map(links => {
    const info = base.characterInfo[links.characterId];
    return { id: links.characterId, trigger: info.sourceTrigger, count: info.count, fallback: info.fallback, sourceKey: info.sourceKey, order: info.order };
  }), manifest: { fingerprint: base.fingerprint } };
  const h = createHarness({ base }); assert.equal((await h.ready).ok, true);
  const characters = createCharacters({ library: h.library, characterSource });
  assert.equal(characters.size(), 34122); assert.equal(characters.count(), 34122);
  assert.equal(characters.manifest().legacyFallbackCharacters, 523);
  assert.equal(characters.page({ includeAdult: true, offset: 34100, limit: 100 }).items.length, 22);
  const miku = characters.get('hatsune_miku', { includeAdult: true });
  assert.equal(miku.identityTagId, base.legacyIds.characters.hatsune_miku);
  assert.equal(miku.trigger, base.characterInfo.hatsune_miku.sourceTrigger);
  assert.ok(miku.generalTags.some(tag => tag.en === 'long hair'));
  const fallback = characterSource.characters.find(row => row.fallback);
  assert.ok(characters.get(fallback.id, { includeAdult: true }));
});
