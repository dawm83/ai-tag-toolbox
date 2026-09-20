'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createFavoritesView } = require('../src/views/favorites-view');
const { createFavorites } = require('../src/modules/favorites');
const { createStorage } = require('../src/modules/storage');

const settle = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

function fixture(t) {
  const dom = new JSDOM('<section id="favoritesView"></section>', { pretendToBeVisual: true });
  const storage = createStorage();
  const favorites = createFavorites({ storage });
  const series = favorites.saveSeries({ name: '光照' }).data;
  const section = favorites.saveSection({ seriesId: series.id, name: '发型' }).data;
  const entry = favorites.saveEntry({ seriesId: series.id, sectionId: section.id, rawText: 'blue_hair', title: '蓝发', note: '常用' }).data;
  const copied = [];
  const opens = []; let closeAllowed = false;
  const tagEditor = { open: async value => { opens.push(value); return true; }, requestClose: async () => closeAllowed };
  const view = createFavoritesView({ document: dom.window.document, favorites, tagEditor, preferences: storage.namespace('favorites-view'), copy: async value => { copied.push(value); return true; } });
  view.enter(); t.after(() => { view.destroy(); dom.window.close(); });
  return { dom, storage, favorites, series, section, entry, view, copied, opens, allowClose: () => { closeAllowed = true; } };
}

test('renders the current workbook page and preserves exact copied text', async t => {
  const app = fixture(t);
  assert.equal(app.dom.window.document.querySelector('[data-favorite-series]').dataset.favoriteSeries, app.series.id);
  assert.equal(app.dom.window.document.querySelector('[data-favorite-section] .favorite-section-title').textContent, '发型');
  app.dom.window.document.querySelector(`[data-favorite-copy="${app.entry.id}"]`).click(); await settle();
  assert.deepEqual(app.copied, ['blue_hair']);
});

test('pencil delegates exact tag and membership to shared editor; leave honors its guard', async t => {
  const app = fixture(t);
  const original = app.favorites.getEntry(app.entry.id);
  await app.view.openEditor(app.entry.id);
  assert.deepEqual(app.opens[0], { tagId: original.tagId, membershipId: original.id });
  assert.equal(await app.view.leave(), false); app.allowClose(); assert.equal(await app.view.leave(), true);
  assert.equal(app.dom.window.document.querySelector('[data-favorite-editor]'), null);
});
test('blank card delegates draft favorite placement without writing a tag', async t => {
  const app = fixture(t); app.dom.window.document.querySelector('[data-favorite-quick-new]').click(); await settle();
  assert.deepEqual(app.opens[0].placement, { kind:'favorite', page:{id:app.series.id}, group:{id:app.section.id} });
  assert.equal(app.favorites.list().total, 1); assert.equal(app.dom.window.document.querySelector('[data-favorite-quick-editor]'), null);
});
