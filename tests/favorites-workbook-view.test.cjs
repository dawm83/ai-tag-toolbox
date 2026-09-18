'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createFavoritesView } = require('../src/views/favorites-view');
const { createFavorites } = require('../src/modules/favorites');
const { createStorage } = require('../src/modules/storage');

const settle = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

function workbookFixture(t) {
  const dom = new JSDOM('<!doctype html><body><section id="favoritesView"></section></body>', { pretendToBeVisual: true });
  const storage = createStorage();
  const favorites = createFavorites({ storage });
  const view = createFavoritesView({ document: dom.window.document, favorites, preferences: storage.namespace('favorites-view') });
  view.enter();
  t.after(() => { view.destroy(); dom.window.close(); });
  const $ = selector => dom.window.document.querySelector(selector);
  const click = async selector => { assert.ok($(selector), selector); $(selector).click(); await settle(); };
  return { dom, storage, favorites, view, $, click };
}

test('empty favorites opens a workbook with one page, one category column, and a blank tag card', t => {
  const app = workbookFixture(t);
  assert.equal(app.favorites.series().length, 1);
  assert.equal(app.favorites.sections(app.favorites.series()[0].id).length, 1);
  assert.equal(app.favorites.series()[0].name, '新建收藏页');
  assert.equal(app.favorites.sections(app.favorites.series()[0].id)[0].name, '新建标签栏');
  assert.equal(app.$('[data-favorite-series-tab]')?.textContent.includes('新建收藏页'), true);
  assert.equal(app.$('[data-favorite-section-tab]')?.textContent.includes('新建标签栏'), true);
  assert.ok(app.$('[data-favorite-quick-new]'));
});

test('page plus creates and switches a complete collection page, while page context actions rename and delete it', async t => {
  const app = workbookFixture(t);
  await app.click('[data-favorite-action="new-series-tab"]');
  assert.equal(app.favorites.series().length, 2);
  assert.equal(app.favorites.series()[1].name, '新建收藏页 2');
  assert.equal(app.$('[data-favorite-series-tab].is-active').textContent.includes('新建收藏页 2'), true);
  let tab = app.$('[data-favorite-series-tab].is-active');
  tab.dispatchEvent(new app.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  assert.ok(app.$('[data-favorite-context-menu]'));
  await app.click('[data-favorite-action="context-rename"]');
  app.$('[data-favorite-dialog-input]').value = '人物素材';
  await app.click('[data-favorite-action="dialog-confirm"]');
  assert.equal(app.favorites.series()[1].name, '人物素材');
  app.dom.window.confirm = () => true;
  tab = app.$('[data-favorite-series-tab].is-active');
  tab.dispatchEvent(new app.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await app.click('[data-favorite-action="context-delete"]');
  assert.equal(app.favorites.series().length, 1);
});

test('category plus adds a colored column and quick blank card saves a tag with optional note', async t => {
  const app = workbookFixture(t);
  await app.click('[data-favorite-action="new-section-tab"]');
  assert.equal(app.favorites.sections(app.favorites.series()[0].id).length, 2);
  const sections = app.favorites.sections(app.favorites.series()[0].id);
  assert.notEqual(sections[0].color, sections[1].color);
  const blank = app.$(`[data-favorite-quick-new][data-section-id="${sections[1].id}"]`);
  blank.click(); await settle();
  app.$('[data-favorite-quick-raw]').value = 'blue hair';
  app.$('[data-favorite-quick-title]').value = '蓝发';
  app.$('[data-favorite-quick-note]').value = '常用人物外观';
  await app.click('[data-favorite-action="quick-save"]');
  const entry = app.favorites.list({ seriesId: app.favorites.series()[0].id, sectionId: sections[1].id }).items[0];
  assert.equal(entry.rawText, 'blue hair');
  assert.equal(entry.title, '蓝发');
  assert.equal(entry.note, '常用人物外观');
  assert.ok(app.$(`[data-favorite-quick-new][data-section-id="${sections[1].id}"]`));
});

test('entry note is exposed as a hover popover and the editor close button actually closes', async t => {
  const app = workbookFixture(t);
  const section = app.favorites.sections(app.favorites.series()[0].id)[0];
  const entry = app.favorites.saveEntry({ seriesId: app.favorites.series()[0].id, sectionId: section.id, rawText: 'soft lighting', title: '柔光', note: '悬停提示' }).data;
  app.view.render();
  const card = app.$(`[data-favorite-entry="${entry.id}"]`);
  assert.equal(card.querySelector('.favorite-note-popover').textContent, '悬停提示');
  await app.view.openEditor(entry.id);
  assert.equal(app.$('[data-favorite-editor]').hidden, false);
  await app.click('[data-favorite-action="editor-close"]');
  assert.equal(app.$('[data-favorite-editor]').hidden, true);
});

test('category headers can be dragged to exchange their order', async t => {
  const app = workbookFixture(t);
  await app.click('[data-favorite-action="new-section-tab"]');
  const sections = app.favorites.sections(app.favorites.series()[0].id);
  const source = app.$(`[data-favorite-section-tab][data-section-id="${sections[0].id}"]`);
  const target = app.$(`[data-favorite-section-tab][data-section-id="${sections[1].id}"]`);
  source.dispatchEvent(new app.dom.window.Event('dragstart', { bubbles: true }));
  target.dispatchEvent(new app.dom.window.Event('drop', { bubbles: true, cancelable: true }));
  await settle();
  assert.deepEqual(app.favorites.sections(app.favorites.series()[0].id).map(row => row.id), [sections[1].id, sections[0].id]);
});
