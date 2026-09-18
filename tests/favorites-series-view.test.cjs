'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createFavoritesView } = require('../src/views/favorites-view');
const { createFavorites } = require('../src/modules/favorites');
const { createStorage } = require('../src/modules/storage');
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function shelf(t) {
  const dom = new JSDOM('<section id="favoritesView"></section>', { pretendToBeVisual: true });
  const storage = createStorage();
  const favorites = createFavorites({ storage });
  const first = favorites.saveSeries({ name: '人物' }).data;
  const second = favorites.saveSeries({ name: '风景' }).data;
  const body = favorites.saveSection({ seriesId: first.id, name: '人体' }).data;
  const face = favorites.saveSection({ seriesId: first.id, name: '表情' }).data;
  const scene = favorites.saveSection({ seriesId: second.id, name: '环境' }).data;
  const entry = (series, section, rawText) => favorites.saveEntry({ seriesId: series.id, sectionId: section.id, kind: 'tag', rawText }).data;
  const bodyTag = entry(first, body, 'blue hair');
  entry(first, face, 'smile');
  const sceneTag = entry(second, scene, 'forest');
  const mount = () => { const view = createFavoritesView({ document: dom.window.document, favorites, preferences: storage }); view.enter(); return view; };
  let view = mount();
  const $ = selector => dom.window.document.querySelector(selector);
  const ids = () => [...dom.window.document.querySelectorAll('[data-favorite-section]')].map(node => node.dataset.favoriteSection);
  const click = async selector => { assert.ok($(selector), selector); $(selector).click(); await settle(); };
  const change = (selector, value) => { const node = $(selector); node.value = value; node.dispatchEvent(new dom.window.Event('input', { bubbles: true })); };
  t.after(() => { view.destroy(); dom.window.close(); });
  return { dom, storage, favorites, first, second, body, face, scene, bodyTag, sceneTag, $, ids, click, change,
    get view() { return view; }, remount() { view.destroy(); view = mount(); } };
}

test('series switching renders only that series with sibling category columns and current-series creation', async t => {
  const app = shelf(t);
  assert.equal(app.dom.window.document.querySelectorAll('[data-favorite-series]').length, 1);
  assert.deepEqual(app.ids(), [app.body.id, app.face.id]);
  assert.equal(app.$('[data-favorite-search]'), null);
  assert.equal(app.$('[data-favorite-anchor-search]'), null);
  await app.click(`[data-favorite-action="select-series"][data-series-id="${app.second.id}"]`);
  assert.deepEqual(app.ids(), [app.scene.id]);
  assert.equal(app.$(`[data-favorite-entry="${app.bodyTag.id}"]`), null);
  assert.equal(app.$(`[data-favorite-action="select-series"][data-series-id="${app.second.id}"]`).getAttribute('aria-pressed'), 'true');
  await app.click('[data-favorite-action="new-tag"]');
  app.change('[data-favorite-field="rawText"]', 'clouds');
  await app.click('[data-favorite-action="editor-close"]');
  assert.equal(app.favorites.exportBundle().entries.find(row => row.rawText === 'clouds').seriesId, app.second.id);
  assert.deepEqual(app.ids(), ['root', app.scene.id]);
  await app.click('[data-favorite-action="open-import"]');
  assert.equal(app.$('[data-favorite-import-series]').value, app.second.id);
});

test('category visibility is per series, all-off survives reopening, and new categories start visible', async t => {
  const app = shelf(t);
  const original = app.favorites.exportBundle();
  const toggle = id => `[data-favorite-section-toggle="${id}"]`;
  const all = '[data-favorite-action="toggle-all-sections"]';
  assert.ok(app.$(all), 'category selection bar is present');
  assert.equal(app.$(all).textContent, '取消全选');
  await app.click(toggle(app.body.id));
  assert.deepEqual(app.ids(), [app.face.id]);
  assert.equal(app.$(all).textContent, '全选');
  await app.click(all);
  assert.deepEqual(app.ids(), [app.body.id, app.face.id]);
  await app.click(all);
  assert.deepEqual(app.ids(), []);
  assert.match(app.$('[data-favorite-shelf]').textContent, /子分类.*隐藏/);
  await app.click(`[data-favorite-action="select-series"][data-series-id="${app.second.id}"]`);
  assert.deepEqual(app.ids(), [app.scene.id]);
  await app.click(`[data-favorite-action="select-series"][data-series-id="${app.first.id}"]`);
  app.remount();
  assert.deepEqual(app.ids(), []);
  assert.equal(app.$(all).textContent, '全选');
  assert.deepEqual(app.favorites.exportBundle(), original, 'visibility never edits or removes favorites');
  const extra = app.favorites.saveSection({ seriesId: app.first.id, name: '服装' }).data;
  assert.deepEqual(app.ids(), [extra.id]);
});

test('series navigation saves valid drafts and refuses to hide an invalid draft', async t => {
  const app = shelf(t);
  await app.view.openEditor(app.bodyTag.id);
  app.change('[data-favorite-field="note"]', '切换时保存');
  await app.click(`[data-favorite-action="select-series"][data-series-id="${app.second.id}"]`);
  assert.equal(app.favorites.getEntry(app.bodyTag.id).note, '切换时保存');
  assert.equal(app.$('[data-favorite-editor]').hidden, true);
  await app.view.openEditor(app.sceneTag.id);
  app.change('[data-favorite-field="rawText"]', '');
  await app.click(`[data-favorite-action="select-series"][data-series-id="${app.first.id}"]`);
  assert.deepEqual(app.ids(), [app.scene.id]);
  await app.click('[data-favorite-action="toggle-all-sections"]');
  assert.deepEqual(app.ids(), [app.scene.id]);
  assert.equal(app.$('[data-favorite-editor]').hidden, false);
  await app.click('[data-favorite-action="new-series"]');
  assert.equal(app.$('[data-favorite-dialog]').hidden, true, 'new-series must not bypass an invalid editor');
});

test('offscreen categories load on demand and batch selection resets when changing visibility', async t => {
  const app = shelf(t);
  let last;
  for (const name of ['服装', '动作', '光照', '视角']) {
    last = app.favorites.saveSection({ seriesId: app.first.id, name }).data;
    app.favorites.saveEntry({ seriesId: app.first.id, sectionId: last.id, rawText: name + ' sample' });
  }
  const column = `[data-favorite-section="${last.id}"]`;
  assert.equal(app.$(column + ' [data-favorite-entry]'), null);
  await app.click(column + ' [data-favorite-action="load-section"]');
  assert.ok(app.$(column + ' [data-favorite-entry]'));
  await app.click('[data-favorite-action="visible"]');
  assert.equal(app.$('[data-favorite-bulk-count]').textContent, '5');
  await app.click(`[data-favorite-section-toggle="${last.id}"]`);
  assert.equal(app.$('[data-favorite-bulk-count]').textContent, '0');
  assert.equal(app.favorites.list().total, 7);
});

test('global locate reveals the target category and series while rename and color remain accessible', async t => {
  const app = shelf(t);
  await app.click('[data-favorite-action="toggle-all-sections"]');
  await app.click(`[data-favorite-action="select-series"][data-series-id="${app.second.id}"]`);
  assert.equal(await app.view.focusEntry(app.bodyTag.id), true);
  assert.deepEqual(app.ids(), [app.body.id]);
  await app.click('[data-favorite-action="rename-series"]');
  app.$('[data-favorite-dialog-input]').value = '人物素材';
  await app.click('[data-favorite-action="dialog-confirm"]');
  assert.equal(app.favorites.series()[0].name, '人物素材');
  const color = app.$('[data-favorite-series-color]');
  color.value = '#112233'; color.dispatchEvent(new app.dom.window.Event('change', { bubbles: true }));
  assert.equal(app.favorites.series()[0].color, '#112233');
  assert.equal(app.$('[data-favorite-series]').style.getPropertyValue('--favorite-accent'), '#112233');
  app.dom.window.confirm = () => true;
  await app.click('[data-favorite-action="delete-series"]');
  assert.ok(app.$('[data-favorite-series]'), 'deleting the active series selects an existing series');
  assert.notEqual(app.$('[data-favorite-series]').dataset.favoriteSeries, app.first.id);
});
