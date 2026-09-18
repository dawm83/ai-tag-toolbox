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
  const notices = [];
  const view = createFavoritesView({ document: dom.window.document, favorites, preferences: storage.namespace('favorites-view'), copy: async () => true, notify: value => notices.push(value) });
  view.enter();
  t.after(() => { view.destroy(); dom.window.close(); });
  const $ = selector => dom.window.document.querySelector(selector);
  const click = async selector => { assert.ok($(selector), selector); $(selector).click(); await settle(); };
  return { dom, storage, favorites, view, $, click, notices };
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
  assert.equal(app.$('[data-favorite-zoom]').value, '120');
  assert.equal(app.$('.favorites-toolbar [data-favorite-action="new-tag"]'), null);
  assert.equal(app.$('.favorites-toolbar [data-favorite-action="bulk"]'), null);
});

test('page and tag navigation are adjacent rows, with zoom inline and no page control band', t => {
  const app = workbookFixture(t);
  assert.equal(app.$('[data-favorite-series-controls]'), null);
  assert.equal(app.$('.favorites-toolbar'), null);
  assert.ok(app.$('[data-favorite-anchors] [data-favorite-zoom]'));
  assert.equal(app.$('[data-favorite-anchors] + [data-favorite-subanchors]') != null, true);
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
  await app.click('[data-favorite-action="context-edit"]');
  app.$('[data-favorite-dialog-input]').value = '人物素材';
  await app.click('[data-favorite-action="dialog-confirm"]');
  assert.equal(app.favorites.series()[1].name, '人物素材');
  let confirmed = false;
  app.dom.window.confirm = () => confirmed;
  tab = app.$('[data-favorite-series-tab].is-active');
  tab.dispatchEvent(new app.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await app.click('[data-favorite-action="context-delete"]');
  assert.equal(app.favorites.series().length, 2, 'cancelling confirmation preserves the page');
  confirmed = true;
  tab.dispatchEvent(new app.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await app.click('[data-favorite-action="context-delete"]');
  assert.equal(app.favorites.series().length, 1);
});

test('page and tag right-click menus share edit/delete actions and edit name plus color in one dialog', async t => {
  const app = workbookFixture(t);
  const pageTab = app.$('[data-favorite-series-tab]');
  pageTab.dispatchEvent(new app.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  assert.ok(app.$('[data-favorite-action="context-edit"]'));
  assert.ok(app.$('[data-favorite-action="context-delete"]'));
  assert.deepEqual([...app.$('[data-favorite-context-menu]').querySelectorAll('button')].map(node => node.textContent), ['编辑', '删除']);
  assert.equal(app.$('[data-favorite-context-color]'), null);
  await app.click('[data-favorite-action="context-edit"]');
  const color = app.$('[data-favorite-dialog-color]');
  assert.equal(color.hidden, false);
  app.$('[data-favorite-dialog-input]').value = '改名后的收藏页'; color.value = '#112233';
  await app.click('[data-favorite-action="dialog-confirm"]');
  assert.equal(app.favorites.series()[0].name, '改名后的收藏页');
  assert.equal(app.favorites.series()[0].color, '#112233');

  const sectionTab = app.$('[data-favorite-section-tab]');
  sectionTab.dispatchEvent(new app.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await app.click('[data-favorite-action="context-edit"]');
  assert.equal(app.$('[data-favorite-dialog-color]').hidden, false);
  app.$('[data-favorite-dialog-input]').value = '改名后的标签栏'; app.$('[data-favorite-dialog-color]').value = '#445566';
  await app.click('[data-favorite-action="dialog-confirm"]');
  assert.equal(app.favorites.sections(app.favorites.series()[0].id)[0].name, '改名后的标签栏');
  assert.equal(app.favorites.sections(app.favorites.series()[0].id)[0].color, '#445566');
  assert.equal(app.$('[data-favorite-section] .favorite-section-title').textContent, '改名后的标签栏');
  assert.equal(app.$('[data-favorite-section-color]'), null);
  assert.equal(app.$('[data-favorite-section] details'), null);
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

test('quick tag creation restores focus to the raw tag input after the clicked blank card takes focus back', async t => {
  const app = workbookFixture(t);
  const blank = app.$('[data-favorite-quick-new]');
  app.dom.window.document.addEventListener('click', () => blank.focus(), { once: true });
  blank.click();
  await settle(25);
  const raw = app.$('[data-favorite-quick-raw]');
  assert.equal(app.$('[data-favorite-quick-editor]').hidden, false);
  assert.equal(app.dom.window.document.activeElement, raw);
  raw.value = 'blue hair';
  raw.dispatchEvent(new app.dom.window.InputEvent('input', { bubbles: true, data: 'blue hair', inputType: 'insertText' }));
  assert.equal(raw.value, 'blue hair');
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

test('clicking a normal tag copies it and reports the copied status', async t => {
  const app = workbookFixture(t);
  const section = app.favorites.sections(app.favorites.series()[0].id)[0];
  const entry = app.favorites.saveEntry({ seriesId: app.favorites.series()[0].id, sectionId: section.id, rawText: 'soft lighting' }).data;
  app.view.render();
  app.$(`[data-favorite-select="${entry.id}"]`).click(); await settle();
  assert.match(app.notices.join(' '), /已复制|Copied/);
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

test('shared context menu closes on Escape and clicking outside, and editing never selects a different page', async t => {
  const app = workbookFixture(t);
  const first = app.favorites.series()[0];
  await app.click('[data-favorite-action="new-series-tab"]');
  const second = app.favorites.series()[1];
  const openFirst = () => app.$(`[data-favorite-series-tab="${first.id}"]`).dispatchEvent(new app.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  openFirst();
  app.$('[data-favorite-context-menu]').dispatchEvent(new app.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(app.$('[data-favorite-context-menu]').hidden, true);
  openFirst();
  app.dom.window.document.body.dispatchEvent(new app.dom.window.Event('pointerdown', { bubbles: true }));
  assert.equal(app.$('[data-favorite-context-menu]').hidden, true);
  openFirst();
  await app.click('[data-favorite-action="context-edit"]');
  app.$('[data-favorite-dialog-input]').value = '第一页';
  app.$('[data-favorite-dialog-color]').value = '#eeaa66';
  await app.click('[data-favorite-action="dialog-confirm"]');
  assert.equal(app.$('[data-favorite-series]').dataset.favoriteSeries, second.id);
  assert.equal(app.favorites.series().find(row => row.id === first.id).color, '#EEAA66');
});

test('shared edit form preserves pending color through locale refresh and cancel does not save changes', async t => {
  const app = workbookFixture(t);
  const original = app.favorites.exportBundle();
  const header = app.$('[data-favorite-section-head]');
  header.dispatchEvent(new app.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await app.click('[data-favorite-action="context-edit"]');
  app.$('[data-favorite-dialog-input]').value = '临时名字';
  app.$('[data-favorite-dialog-color]').value = '#123456';
  app.view.refreshLocale();
  assert.equal(app.$('[data-favorite-dialog-input]').value, '临时名字');
  assert.equal(app.$('[data-favorite-dialog-color]').value, '#123456');
  assert.equal(app.$('[data-favorite-dialog-color]').hidden, false);
  await app.click('[data-favorite-action="dialog-cancel"]');
  assert.deepEqual(app.favorites.exportBundle(), original);

  app.$('[data-favorite-section-tab]').dispatchEvent(new app.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await app.click('[data-favorite-action="context-edit"]');
  app.$('[data-favorite-dialog-input]').value = ' ';
  await app.click('[data-favorite-action="dialog-confirm"]');
  assert.equal(app.$('[data-favorite-dialog]').hidden, false);
  assert.deepEqual(app.favorites.exportBundle(), original);
});
