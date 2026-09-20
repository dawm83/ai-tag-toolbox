'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, makeBase, makeRecord } = require('./fixtures/tag-library.cjs');
const { createTagAdapter } = require('../src/modules/tag-library/tag-adapter');

function baseFixture() {
  const base = makeBase();
  base.categories.push({ id: 'wd_general', name: '模型通用词', order: 1, source: 'bundled' });
  base.subcategories.push({ id: 'model-default', categoryId: 'wd_general', name: '默认', order: 0, source: 'bundled' });
  base.tags.find(row => row.id === 'blue_hair').id = 'blue hair';
  for (const link of base.characterLinks) link.generalTagIds = ['blue hair'];
  base.tags.push(makeRecord({ id: 'blue_hair', content: 'blue_hair', displayName: '', categoryId: 'wd_general', subcategoryId: 'model-default' }));
  return base;
}

test('model Tags borrow unambiguous Chinese and taxonomy without changing content or writing a record', async () => {
  const h = createHarness({ base: baseFixture() }); await h.ready;
  const tags = createTagAdapter({ library: h.library });
  const before = h.repository.saveCount;
  const input = [{ tag: 'blue_hair', category: 0, prob: 0.92 }, { tag: 'long_hair', probability: 0.6 }, '(blue_hair:1.2)', 'unknown_tag'];
  const result = tags.describe(input);
  assert.equal(result[0].rawText, 'blue_hair');
  assert.equal(result[0].tagId, 'blue_hair');
  assert.equal(result[0].displayName, '蓝发');
  assert.equal(result[0].categoryId, 'hair');
  assert.equal(result[0].subcategoryId, 'color');
  assert.equal(result[0].probability, 0.92);
  assert.equal(result[1].displayName, '长发');
  assert.equal(result[2].rawText, '(blue_hair:1.2)');
  assert.equal(result[2].displayName, '');
  assert.equal(result[2].match, 'unknown');
  assert.equal(result[3].categoryId, '');
  assert.equal(h.library.getTag('blue_hair').displayName, '');
  assert.equal(h.library.getTag('blue_hair').categoryId, 'wd_general');
  assert.equal(h.repository.saveCount, before);
});

test('metadata follows source edits, honors explicit target clearing, and refreshes after undo and reload', async () => {
  const base = baseFixture(), h = createHarness({ base }); await h.ready;
  const tags = createTagAdapter({ library: h.library });
  assert.equal(tags.describe(['blue_hair'])[0].displayName, '蓝发');
  await tags.edit('blue hair', { zh: '蓝色头发', subcategoryId: 'shape' });
  let value = tags.describe(['blue_hair'])[0];
  assert.equal(value.displayName, '蓝色头发'); assert.equal(value.subcategoryId, 'shape');
  await tags.edit('blue_hair', { zh: '自定义蓝发' });
  await tags.edit('blue_hair', { zh: '' });
  assert.equal(tags.describe(['blue_hair'])[0].displayName, '');
  await h.library.execute({ type: 'undo' }, { operationId: 'undo' });
  assert.equal(tags.describe(['blue_hair'])[0].displayName, '自定义蓝发');
  const reloaded = createTagAdapter({ library: await h.reload() });
  assert.equal(reloaded.describe(['blue_hair'])[0].displayName, '自定义蓝发');
});

test('ambiguous names are not chosen by order and independent custom content stays independent', async () => {
  const base = baseFixture();
  base.tags.push(makeRecord({ id: 'conflict', content: 'BLUE  HAIR', displayName: '另一含义' }));
  const h = createHarness({ base }); await h.ready;
  const tags = createTagAdapter({ library: h.library });
  const value = tags.describe(['blue_hair'])[0];
  assert.equal(value.displayName, '');
  assert.equal(value.categoryId, 'hair');
  assert.equal(value.ambiguous, true);
  await tags.addCustom({ en: 'own_tag', zh: '', category: 'hair', subcategoryId: 'shape' });
  assert.equal(tags.describe(['own_tag'])[0].displayName, '');
  assert.equal(tags.describe(['own_tag'])[0].categoryId, 'hair');
  assert.equal(tags.describe(['bluehair'])[0].displayName, '', 'search convenience must not become semantic equivalence');
});

test('metadata lookup stays usable before ready and excludes hidden adult metadata until enabled', async () => {
  const base = baseFixture();
  for (const row of base.tags.filter(row => row.content.replace(/_/g, ' ') === 'blue hair')) row.adult = true;
  const h = createHarness({ base }), tags = createTagAdapter({ library: h.library });
  assert.equal(tags.describe(['blue_hair'])[0].displayName, '');
  await h.ready;
  assert.equal(tags.describe(['blue_hair'])[0].displayName, '');
  tags.setAdult(true);
  assert.equal(tags.describe(['blue_hair'])[0].displayName, '蓝发');
});
