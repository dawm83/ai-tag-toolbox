'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { enrichBundledTags, normalizeContent } = require('../src/modules/tag-library/enrichment');

const emptyCoverage = { qualifiers: { swimsuit: '泳装', maid: '女仆', christmas: '圣诞', pajamas: '睡衣' }, entries: [] };
function tag(id, content, displayName = '', categoryId = 'wd_general', usages = ['general'], subcategoryId = `${categoryId}:default`) {
  return { id, kind: 'tag', content, displayName, categoryId, subcategoryId, usages, aliases: ['unchanged'], note: '', adult: false, searchable: true, source: { kind: 'bundled', key: `fixture:${id}` }, revision: 0, createdAt: 0, updatedAt: 0 };
}
function fixture(tags, characterLinks = []) {
  const categories = ['wd_general', 'hair', 'outfit', 'character_names', 'character_specific', 'series'].map((id, order) => ({ id, name: id, order, source: 'bundled' }));
  const subcategories = categories.map(c => ({ id: `${c.id}:default`, categoryId: c.id, name: '默认', order: 0, source: 'bundled' }));
  subcategories.push({ id: 'hair:color', categoryId: 'hair', name: '颜色', order: 1, source: 'bundled' }, { id: 'outfit:swim', categoryId: 'outfit', name: '泳装', order: 1, source: 'bundled' });
  return { tags, categories, subcategories, characterLinks, legacyIds: { subcategories: { kept: 'wd_general:default' } }, metadataById: {}, characterInfo: {}, fingerprint: 'parent-computes-after-enrichment' };
}
const link = (id, series) => ({ characterId: id, identityTagId: id, seriesTagIds: series, generalTagIds: [], specificTagIds: [] });
const identity = (id, content, displayName = content) => tag(id, content, displayName, 'character_names', ['characterIdentity']);
function frozen(value) { Object.freeze(value); for (const item of Object.values(value)) if (item && typeof item === 'object') frozen(item); return value; }

test('exact content normalization fills only blank fields and preserves the full identity surface', () => {
  const target = tag('bytes__KEPT', '  ＢＬＵＥ__Hair  '); target.adult = true; target.searchable = false;
  const base = fixture([tag('donor', 'blue hair', '蓝发', 'hair', ['general'], 'hair:color'), target]);
  const before = structuredClone(base), result = enrichBundledTags(frozen(base), emptyCoverage);
  assert.equal(result.base.tags[1].displayName, '蓝发');
  assert.equal(result.base.tags[1].categoryId, 'hair');
  assert.equal(result.base.tags[1].subcategoryId, 'hair:color');
  for (const field of Object.keys(target).filter(key => !['displayName', 'categoryId', 'subcategoryId'].includes(key))) assert.deepEqual(result.base.tags[1][field], target[field], field);
  assert.deepEqual(base, before);
  for (const field of Object.keys(base).filter(key => key !== 'tags')) assert.deepEqual(result.base[field], before[field], field);
  assert.notEqual(result.base, base);
  assert.equal(result.counts.displayNameChanged, 1);
  assert.equal(result.counts.categoryChanged, 1);
  assert.equal(result.changes.length, 1);
  assert.equal(normalizeContent('Blue\tHair'), 'blue\thair');
  assert.notEqual(normalizeContent('blue-hair'), normalizeContent('blue_hair'));
});

test('conflicting normalized spellings do not select the first translation or category', () => {
  const a = tag('a', 'blue_hair', '蓝发', 'hair', ['general'], 'hair:color');
  const b = tag('b', 'BLUE HAIR', '另一译名', 'outfit', ['general'], 'outfit:swim');
  const target = tag('target', 'blue__hair');
  for (const donors of [[a, b], [b, a]]) {
    const result = enrichBundledTags(fixture([...donors, target]), emptyCoverage);
    assert.deepEqual(result.base.tags[2], target);
    assert.equal(result.counts.conflicts.exactName, 1);
    assert.equal(result.counts.conflicts.exactCategory, 1);
  }
});

test('identical donor values are safe, aliases are not content identity, and existing Chinese and fine taxonomy survive', () => {
  const a = tag('a', 'blue hair', '蓝发', 'hair', ['general'], 'hair:color');
  const b = tag('b', 'blue_hair', '蓝发', 'hair', ['general'], 'hair:color');
  a.aliases.push('green hair');
  const existing = tag('existing', 'blue__hair', '已有译名', 'outfit', ['general'], 'outfit:swim');
  const result = enrichBundledTags(fixture([a, b, tag('blank', 'BLUE_HAIR'), tag('alias', 'green hair')]), emptyCoverage);
  assert.equal(result.base.tags[2].displayName, '蓝发');
  assert.equal(result.base.tags[3].displayName, '');
  assert.deepEqual(enrichBundledTags(fixture([a, existing]), emptyCoverage).base.tags[1], existing);
});

test('costume variants require exact residual content, a single known qualifier, and the same franchise', () => {
  const tags = [
    identity('a', 'alice (work a)', '爱丽丝甲'), identity('b', 'alice (work b)', '爱丽丝乙'),
    identity('swim-a', 'alice (swimsuit) (work a)'), identity('swim-b', 'alice (swimsuit) (work b)'),
    identity('wrong-series', 'alice (maid) (work a)'), identity('unknown', 'alice (moon princess) (work a)'),
    identity('class', 'alice (archer) (work a)'), identity('numbered', 'alice (2nd costume) (work a)'),
    identity('stacked', 'alice (swimsuit) (christmas) (work a)'), identity('no-series', 'alice (pajamas) (work a)'),
    identity('malformed', 'alice (swimsuit (work a)'), identity('kept', 'alice (christmas) (work b)', '原有中文')
  ];
  const base = fixture(tags, tags.map(t => link(t.id, t.id === 'no-series' ? [] : ['b', 'swim-b', 'wrong-series', 'kept'].includes(t.id) ? ['work-b'] : ['work-a'])));
  const result = enrichBundledTags(base, emptyCoverage);
  const get = id => result.base.tags.find(t => t.id === id).displayName;
  assert.equal(get('swim-a'), '爱丽丝甲（泳装）');
  assert.equal(get('swim-b'), '爱丽丝乙（泳装）');
  assert.equal(get('numbered'), '爱丽丝甲（第2套服装）');
  for (const id of ['wrong-series', 'unknown', 'class', 'stacked', 'no-series', 'malformed', 'kept']) assert.equal(get(id), tags.find(t => t.id === id).displayName, id);
  assert.equal(result.counts.roleVariants, 3);
  assert.deepEqual(result.base.characterLinks, base.characterLinks);
  assert.deepEqual(enrichBundledTags(result.base, emptyCoverage).base, result.base);
  assert.equal(enrichBundledTags(result.base, emptyCoverage).changes.length, 0);
});

test('ambiguous character donors and differing franchise sets never produce a costume translation', () => {
  const tags = [identity('a', 'alice (work)', '爱丽丝'), identity('b', 'alice_(work)', '阿丽丝'), identity('target', 'alice (swimsuit) (work)')];
  const base = fixture(tags, tags.map(t => link(t.id, ['work'])));
  assert.equal(enrichBundledTags(base, emptyCoverage).base.tags[2].displayName, tags[2].displayName);
  base.tags[1].displayName = '爱丽丝';
  base.characterLinks[2].seriesTagIds = ['work', 'another-work'];
  assert.equal(enrichBundledTags(base, emptyCoverage).base.tags[2].displayName, tags[2].displayName);
});

test('explicit vocabulary preserves character-specific usage, flags, named uniforms and existing subcategories', () => {
  const swimsuit = tag('specific-swim', 'gold one-piece swimsuit', '', 'character_specific', ['characterSpecific']); swimsuit.searchable = false;
  const uniform = tag('specific-school', 'example academy uniform', '', 'character_specific', ['characterSpecific']); uniform.adult = true; uniform.searchable = false;
  const coverage = { ...emptyCoverage, entries: [
    { usage: 'characterSpecific', content: swimsuit.content, displayName: '金色连体泳衣', categoryId: 'outfit', subcategoryName: '泳装' },
    { usage: 'characterSpecific', content: uniform.content, displayName: '示例学院制服' }
  ] };
  const base = fixture([swimsuit, uniform]), result = enrichBundledTags(base, coverage);
  assert.equal(result.base.tags[0].categoryId, 'outfit');
  assert.equal(result.base.tags[1].categoryId, 'character_specific');
  assert.equal(result.base.tags[1].displayName, '示例学院制服');
  for (let i = 0; i < 2; i++) for (const field of ['usages', 'adult', 'searchable', 'content', 'id']) assert.deepEqual(result.base.tags[i][field], base.tags[i][field]);
  assert.deepEqual(result.base.subcategories, base.subcategories);
  assert.equal(result.counts.specificTranslated, 2);
  assert.equal(enrichBundledTags(result.base, coverage).changes.length, 0);
});

test('named character coverage requires content and franchise and never replaces an existing Chinese name', () => {
  const tags = [identity('a', 'fu hua (azure empyrea)'), identity('b', 'fu hua (azure empyrea)'), identity('c', 'fu hua (azure empyrea)', '已有中文'), tag('series-honkai', 'honkai (series)', '崩坏系列', 'series', ['seriesIdentity']), tag('series-other', 'other work', '其他作品', 'series', ['seriesIdentity'])];
  const base = fixture(tags, [link('a', ['series-honkai']), link('b', ['series-other']), link('c', ['series-honkai'])]);
  const coverage = { ...emptyCoverage, entries: [{ usage: 'characterIdentity', content: 'fu hua (azure empyrea)', seriesContent: 'honkai (series)', displayName: '符华（云墨丹心）' }] };
  const result = enrichBundledTags(base, coverage);
  assert.equal(result.base.tags[0].displayName, '符华（云墨丹心）');
  assert.equal(result.base.tags[1].displayName, tags[1].displayName);
  assert.equal(result.base.tags[2].displayName, '已有中文');
});

test('the bundled coverage changes only approved fields and remains deterministic and idempotent on the full base', () => {
  const seeded = require('../src/modules/tag-library/seed').buildUnifiedSeed({
    tags: require('../src/modules/tags').loadTagFiles({ assetDir: require('node:path').resolve(__dirname, '../assets') }),
    characters: require('../assets/数据资产/角色/characters.json'),
    specificTags: require('../assets/数据资产/角色/specific-tags.json'),
    manifest: require('../assets/数据资产/角色/manifest.json')
  }, { enrich: false });
  assert.equal(seeded.ok, true, JSON.stringify(seeded.error));
  const base = seeded.data;
  assert.doesNotMatch(base.tags.find(t => t.id === 'fu_hua_(azure_empyrea)').displayName, /\p{Script=Han}/u, 'this test must exercise the raw seed');
  const before = JSON.stringify(base), result = enrichBundledTags(base);
  assert.equal(JSON.stringify(base), before);
  assert.equal(result.base.tags.length, base.tags.length);
  for (let i = 0; i < base.tags.length; i++) {
    const original = base.tags[i], next = result.base.tags[i];
    for (const field of Object.keys(original).filter(key => !['displayName', 'categoryId', 'subcategoryId'].includes(key))) assert.deepEqual(next[field], original[field], `${original.id}.${field}`);
    if (/\p{Script=Han}/u.test(original.displayName)) assert.equal(next.displayName, original.displayName, original.id);
  }
  for (const field of Object.keys(base).filter(key => key !== 'tags')) assert.deepEqual(result.base[field], base[field], field);
  assert.equal(result.base.tags.find(t => t.id === 'fu_hua_(azure_empyrea)').displayName, '符华（云墨丹心）');
  assert.equal(result.base.tags.find(t => t.id === 'fu_hua_(phoenix)').displayName, '符华（炽翎）');
  const again = enrichBundledTags(result.base);
  assert.deepEqual(again.base, result.base);
  assert.equal(again.changes.length, 0);
  assert.deepEqual(enrichBundledTags(base), result);
});

test('every curated entry has a real bundled target and every classification points to an existing subcategory', () => {
  const base = require('../assets/数据资产/标签/unified-tag-base.json');
  const coverage = require('../assets/数据资产/标签/tag-enrichment.json');
  const seen = new Set();
  for (const entry of coverage.entries) {
    const key = JSON.stringify([entry.usage, normalizeContent(entry.content), entry.seriesContent || '']);
    assert.equal(seen.has(key), false, `duplicate coverage: ${entry.content}`); seen.add(key);
    const target = base.tags.find(tag => tag.usages.includes(entry.usage) && normalizeContent(tag.content) === normalizeContent(entry.content));
    assert.ok(target, entry.content);
    assert.match(entry.displayName, /\p{Script=Han}/u, entry.content);
    if (entry.categoryId) assert.equal(base.subcategories.filter(sub => sub.categoryId === entry.categoryId && sub.name === entry.subcategoryName).length, 1, entry.content);
    if (entry.usage === 'characterIdentity') {
      assert.ok(entry.seriesContent, entry.content);
      const linkedSeries = base.characterLinks.filter(link => link.identityTagId === target.id).flatMap(link => link.seriesTagIds);
      assert.ok(base.tags.some(tag => linkedSeries.includes(tag.id) && normalizeContent(tag.content) === normalizeContent(entry.seriesContent)), entry.content);
    }
  }
  assert.equal(require('../src/modules/tag-library/schema').validateBase(enrichBundledTags(base).base).ok, true);
});
