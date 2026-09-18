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
  const view = createFavoritesView({ document: dom.window.document, favorites, preferences: storage.namespace('favorites-view'), copy: async value => { copied.push(value); return true; } });
  view.enter(); t.after(() => { view.destroy(); dom.window.close(); });
  return { dom, storage, favorites, series, section, entry, view, copied };
}

test('renders the current workbook page and preserves exact copied text', async t => {
  const app = fixture(t);
  assert.equal(app.dom.window.document.querySelector('[data-favorite-series]').dataset.favoriteSeries, app.series.id);
  assert.equal(app.dom.window.document.querySelector('[data-favorite-section] .favorite-section-title').textContent, '发型');
  app.dom.window.document.querySelector(`[data-favorite-copy="${app.entry.id}"]`).click(); await settle();
  assert.deepEqual(app.copied, ['blue_hair']);
});

test('editor saves a valid draft before closing and rejects an empty raw value', async t => {
  const app = fixture(t);
  await app.view.openEditor(app.entry.id);
  const note = app.dom.window.document.querySelector('[data-favorite-field="note"]'); note.value = '已修改'; note.dispatchEvent(new app.dom.window.Event('input', { bubbles: true }));
  await app.view.flushEdits();
  assert.equal(app.favorites.getEntry(app.entry.id).note, '已修改');
  const raw = app.dom.window.document.querySelector('[data-favorite-field="rawText"]'); raw.value = ''; raw.dispatchEvent(new app.dom.window.Event('input', { bubbles: true }));
  assert.equal(await app.view.flushEdits(), false);
  assert.equal(app.dom.window.document.querySelector('[data-favorite-editor]').hidden, false);
});

test('closing the quick editor removes it without changing the shelf', async t => {
  const app = fixture(t);
  app.dom.window.document.querySelector('[data-favorite-quick-new]').click(); await settle();
  app.dom.window.document.querySelector('[data-favorite-quick-raw]').value = 'discarded';
  app.dom.window.document.querySelector('[data-favorite-action="quick-close"]').click();
  assert.equal(app.dom.window.document.querySelector('[data-favorite-quick-editor]').hidden, true);
  assert.equal(app.favorites.list().total, 1);
});
