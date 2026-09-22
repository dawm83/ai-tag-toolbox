'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createFavoritesView } = require('../src/views/favorites-view');
const { createStorage } = require('../src/modules/storage');
const { createUnifiedFixture } = require('./fixtures/unified-modules.cjs');

const settle = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t, sectionCount = 1) {
  const dom = new JSDOM('<section id="favoritesView"></section>', { pretendToBeVisual: true });
  const storage = createStorage();
  const { favorites } = await createUnifiedFixture();
  const series = (await favorites.saveSeries({ name: '光照' })).data;
  const sections = [];
  for (let index = 0; index < sectionCount; index++) sections.push((await favorites.saveSection({ seriesId: series.id, name: index === 0 ? '发型' : `栏目${index + 1}` })).data);
  const section = sections[0];
  const entry = (await favorites.saveEntry({ seriesId: series.id, sectionId: section.id, rawText: 'blue_hair', title: '蓝发', note: '常用' })).data;
  const copied = [];
  const opens = []; let closeAllowed = false;
  const tagEditor = { open: async value => { opens.push(value); return true; }, requestClose: async () => closeAllowed };
  const view = createFavoritesView({ document: dom.window.document, favorites, tagEditor, preferences: storage.namespace('favorites-view'), copy: async value => { copied.push(value); return true; } });
  view.enter(); t.after(() => { view.destroy(); dom.window.close(); });
  return { dom, storage, favorites, series, sections, section, entry, view, copied, opens, allowClose: () => { closeAllowed = true; } };
}

test('renders the current workbook page and preserves exact copied text', async t => {
  const app = await fixture(t);
  assert.equal(app.dom.window.document.querySelector('[data-favorite-series]').dataset.favoriteSeries, app.series.id);
  assert.equal(app.dom.window.document.querySelector('[data-favorite-section] .favorite-section-title').textContent, '发型');
  app.dom.window.document.querySelector(`[data-favorite-copy="${app.entry.id}"]`).click(); await settle();
  assert.deepEqual(app.copied, ['blue_hair']);
});

test('pencil delegates exact tag and membership to shared editor; leave honors its guard', async t => {
  const app = await fixture(t);
  const original = app.favorites.getEntry(app.entry.id);
  await app.view.openEditor(app.entry.id);
  assert.deepEqual(app.opens[0], { tagId: original.tagId, membershipId: original.id });
  assert.equal(await app.view.leave(), false); app.allowClose(); assert.equal(await app.view.leave(), true);
  assert.equal(app.dom.window.document.querySelector('[data-favorite-editor]'), null);
});
test('blank card delegates draft favorite placement without writing a tag', async t => {
  const app = await fixture(t); app.dom.window.document.querySelector('[data-favorite-quick-new]').click(); await settle();
  assert.deepEqual(app.opens[0].placement, { kind:'favorite', page:{id:app.series.id}, group:{id:app.section.id} });
  assert.equal(app.favorites.list().total, 1); assert.equal(app.dom.window.document.querySelector('[data-favorite-quick-editor]'), null);
});

test('only the first four favorite columns render immediately and later columns stay lazy', async t => {
  const app = await fixture(t, 6);
  const columns = [...app.dom.window.document.querySelectorAll('[data-favorite-section]')];
  assert.equal(columns.length, 6);
  assert.equal(columns.slice(0, 4).some(node => node.hasAttribute('data-favorite-lazy-section')), false);
  assert.equal(columns.slice(4).every(node => node.getAttribute('data-favorite-lazy-section')), true);
  assert.equal(columns.slice(4).every(node => node.querySelector('[data-favorite-action="load-section"]')), true);
  columns[4].querySelector('[data-favorite-action="load-section"]').click(); await settle();
  const hydrated = app.dom.window.document.querySelector(`[data-favorite-section="${app.sections[4].id}"]`);
  assert.equal(hydrated.hasAttribute('data-favorite-lazy-section'), false);
  assert.equal(hydrated.querySelector('[data-favorite-action="load-section"]'), null);
});

test('health rendering uses the lightweight favorite health summary', async t => {
  const dom = new JSDOM('<section id="favoritesView"></section>', { pretendToBeVisual: true });
  const { favorites: source } = await createUnifiedFixture();
  const series = (await source.saveSeries({ name: '状态' })).data;
  const section = (await source.saveSection({ seriesId: series.id, name: '摘要' })).data;
  await source.saveEntry({ seriesId: series.id, sectionId: section.id, rawText: 'blue_hair' });
  let healthCalls = 0;
  const favorites = { ...source, health: () => { healthCalls++; return source.health(); }, snapshot: () => { throw new Error('renderHealth should not build the full snapshot'); } };
  const view = createFavoritesView({ document: dom.window.document, favorites });
  view.enter(); t.after(() => { view.destroy(); source.dispose(); dom.window.close(); });
  assert.equal(healthCalls, 1);
  assert.equal(dom.window.document.querySelector('[data-favorite-health]').hidden, true);
});
