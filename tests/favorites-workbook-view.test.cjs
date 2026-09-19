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

test('page plus creates and switches a complete collection page, while pages are renamed through the context menu and deleted from the folder', async t => {
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
  const pageId = app.favorites.series()[1].id;
  await app.click('[data-favorite-action="toggle-pages"]');
  await app.click('[data-favorite-action="delete-page"][data-series-id="' + pageId + '"]');
  await app.click('[data-favorite-action="cancel-delete"]');
  assert.equal(app.favorites.series().length, 2, 'cancelling confirmation preserves the page');
  await app.click('[data-favorite-action="delete-page"][data-series-id="' + pageId + '"]');
  await app.click('[data-favorite-action="confirm-delete"]');
  assert.equal(app.favorites.series().length, 1);
});

test('page and column menus share editing while only columns offer context deletion', async t => {
  const app = workbookFixture(t);
  const pageTab = app.$('[data-favorite-series-tab]');
  pageTab.dispatchEvent(new app.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  assert.ok(app.$('[data-favorite-action="context-edit"]'));
  assert.ok(app.$('[data-favorite-action="context-delete"]'));
  assert.deepEqual([...app.$('[data-favorite-context-menu]').querySelectorAll('button')].filter(node => !node.hidden).map(node => node.textContent), ['编辑']);
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

test('deleting the current collection page closes its stale quick editor before the replacement page accepts input', async t => {
  const app = workbookFixture(t);
  const page = app.favorites.series()[0];
  const originalBlank = app.$('[data-favorite-quick-new]');
  originalBlank.click();
  await settle();
  assert.equal(app.$('[data-favorite-quick-editor]').hidden, false);

  await app.click('[data-favorite-action="toggle-pages"]');
  await app.click('[data-favorite-action="delete-page"][data-series-id="' + page.id + '"]');
  await app.click('[data-favorite-action="confirm-delete"]');

  assert.equal(app.favorites.series().some(row => row.id === page.id), false);
  assert.equal(app.$('[data-favorite-quick-editor]').hidden, true);
  const replacementBlank = app.$('[data-favorite-quick-new]');
  replacementBlank.click();
  await settle(25);
  const raw = app.$('[data-favorite-quick-raw]');
  assert.equal(app.dom.window.document.activeElement, raw);
  raw.value = 'after page delete';
  raw.dispatchEvent(new app.dom.window.InputEvent('input', { bubbles: true, data: 'after page delete', inputType: 'insertText' }));
  assert.equal(raw.value, 'after page delete');
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


test('one editor accepts both a Tag and a comma collection with only Tag, name and note content fields', async t => {
  const app = workbookFixture(t);
  const page = app.favorites.series()[0];
  const section = app.favorites.sections(page.id)[0];
  const entry = app.favorites.saveEntry({ kind: 'bundle', seriesId: page.id, sectionId: section.id, rawText: 'blue hair, soft light', title: '', zh: '旧名称', note: '原备注' }).data;
  await app.view.openEditor(entry.id);
  const form = app.$('[data-favorite-editor-form]');
  assert.deepEqual([...form.querySelectorAll('input,textarea')].map(field => field.dataset.favoriteField), ['rawText', 'title', 'note']);
  assert.equal(app.$('[data-favorite-field="title"]').value, '旧名称');
  assert.equal(form.querySelector('[data-favorite-field="kind"]'), null);
  assert.equal(app.$('[data-favorite-expand]'), null);
  const raw = app.$('[data-favorite-field="rawText"]');
  raw.value = '  blue hair, (soft light:1.2)\n';
  raw.dispatchEvent(new app.dom.window.Event('input', { bubbles: true }));
  const title = app.$('[data-favorite-field="title"]'); title.value = '';
  title.dispatchEvent(new app.dom.window.Event('input', { bubbles: true }));
  await app.click('[data-favorite-action="editor-save"]');
  assert.equal(app.$('[data-favorite-editor]').hidden, true);
  assert.equal(app.favorites.getEntry(entry.id).rawText, '  blue hair, (soft light:1.2)\n');
  assert.equal(app.favorites.getEntry(entry.id).note, '原备注');
});

test('save closes the editor only after storage succeeds and retains an invalid draft', async t => {
  const app = workbookFixture(t);
  const page = app.favorites.series()[0];
  const section = app.favorites.sections(page.id)[0];
  const entry = app.favorites.saveEntry({ seriesId: page.id, sectionId: section.id, rawText: 'before' }).data;
  await app.view.openEditor(entry.id);
  const raw = app.$('[data-favorite-field="rawText"]'); raw.value = ' ';
  raw.dispatchEvent(new app.dom.window.Event('input', { bubbles: true }));
  await app.click('[data-favorite-action="editor-save"]');
  assert.equal(app.$('[data-favorite-editor]').hidden, false);
  assert.equal(app.favorites.getEntry(entry.id).rawText, 'before');
  raw.value = 'after'; raw.dispatchEvent(new app.dom.window.Event('input', { bubbles: true }));
  await app.click('[data-favorite-action="editor-save"]');
  assert.equal(app.$('[data-favorite-editor]').hidden, true);
  assert.equal(app.favorites.getEntry(entry.id).rawText, 'after');
});


test('editor destinations match the current page columns without an unfiled option', async t => {
  const app = workbookFixture(t);
  const page = app.favorites.series()[0];
  const section = app.favorites.sections(page.id)[0];
  const root = app.favorites.saveEntry({ seriesId: page.id, rawText: 'legacy' }).data;
  app.view.render();
  assert.equal(app.favorites.getEntry(root.id).sectionId, section.id);
  await app.view.openEditor(root.id);
  assert.deepEqual([...app.$('[data-favorite-field="sectionId"]').options].map(option => option.value), [section.id]);
  await app.click('[data-favorite-action="editor-close"]');
  await app.click('[data-favorite-action="new-series-tab"]');
  const second = app.favorites.series().at(-1);
  await app.view.openCreate({ seriesId: second.id, rawText: 'new tag' });
  await app.click('[data-favorite-action="editor-save"]');
  assert.equal(app.favorites.list({ seriesId: second.id }).items[0].sectionId, app.favorites.sections(second.id)[0].id);
});


test('column eye buttons hide and restore columns without removing Tags and survive reopening', async t => {
  const app = workbookFixture(t);
  const page = app.favorites.series()[0];
  const first = app.favorites.sections(page.id)[0];
  const entry = app.favorites.saveEntry({ seriesId: page.id, sectionId: first.id, rawText: 'kept' }).data;
  await app.click('[data-favorite-action="new-section-tab"]');
  const second = app.favorites.sections(page.id)[1];
  const eye = id => '[data-favorite-action="toggle-section"][data-section-id="' + id + '"]';
  const original = app.favorites.exportBundle();
  assert.ok(app.$(eye(first.id)), 'each column has a visibility control');
  await app.click(eye(first.id));
  assert.equal(app.$('[data-favorite-section="' + first.id + '"]'), null);
  assert.ok(app.$('[data-favorite-section-tab="' + first.id + '"]'));
  assert.ok(app.$('[data-favorite-section="' + second.id + '"]'));
  assert.deepEqual(app.favorites.exportBundle(), original);
  await app.view.leave(); app.view.enter();
  assert.equal(app.$('[data-favorite-section="' + first.id + '"]'), null);
  await app.click(eye(second.id));
  assert.equal(app.$('[data-favorite-section]'), null);
  await app.click(eye(first.id));
  assert.ok(app.$('[data-favorite-entry="' + entry.id + '"]'));
  assert.equal(app.$(eye(first.id)).getAttribute('aria-pressed'), 'true');
});


test('closing pages retains data, persists after reopening and restores through the folder list', async t => {
  const app = workbookFixture(t);
  const first = app.favorites.series()[0];
  const firstColumn = app.favorites.sections(first.id)[0];
  app.favorites.saveEntry({ seriesId: first.id, sectionId: firstColumn.id, rawText: 'keep me' });
  await app.click('[data-favorite-action="new-series-tab"]');
  const second = app.favorites.series()[1];
  const original = app.favorites.exportBundle();
  await app.click('[data-favorite-action="close-page"][data-series-id="' + second.id + '"]');
  assert.equal(app.$('[data-favorite-series-tab="' + second.id + '"]'), null);
  assert.equal(app.$('[data-favorite-series]').dataset.favoriteSeries, first.id);
  await app.click('[data-favorite-action="close-page"][data-series-id="' + first.id + '"]');
  assert.equal(app.$('[data-favorite-series-tab]'), null);
  assert.equal(app.$('[data-favorite-section]'), null);
  assert.deepEqual(app.favorites.exportBundle(), original);
  await app.view.leave(); app.view.enter();
  assert.equal(app.$('[data-favorite-series-tab]'), null);
  await app.click('[data-favorite-action="toggle-pages"]');
  assert.equal(app.$('[data-favorite-page-manager]').hidden, false);
  assert.equal(app.dom.window.document.querySelectorAll('[data-favorite-page-row]').length, 2);
  await app.click('[data-favorite-action="open-page"][data-series-id="' + first.id + '"]');
  assert.equal(app.$('[data-favorite-series]').dataset.favoriteSeries, first.id);
  assert.equal(app.$('[data-favorite-entry] .favorite-entry-title').textContent, 'keep me');
  assert.equal(app.$('[data-favorite-series-tab="' + second.id + '"]'), null);
});

test('page deletion lives in the folder list and waits for in-page confirmation', async t => {
  const app = workbookFixture(t);
  app.dom.window.confirm = () => { throw new Error('Native confirm must not be used'); };
  const first = app.favorites.series()[0];
  await app.click('[data-favorite-action="new-series-tab"]');
  const second = app.favorites.series()[1];
  const tab = app.$('[data-favorite-series-tab="' + first.id + '"]');
  tab.dispatchEvent(new app.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  assert.equal([...app.$('[data-favorite-context-menu]').querySelectorAll('button')].filter(node => !node.hidden).some(node => node.dataset.favoriteAction === 'context-delete'), false);
  await app.click('[data-favorite-action="toggle-pages"]');
  await app.click('[data-favorite-action="delete-page"][data-series-id="' + first.id + '"]');
  assert.equal(app.$('[data-favorite-delete-dialog]').hidden, false);
  assert.equal(app.favorites.series().length, 2);
  await app.click('[data-favorite-action="cancel-delete"]');
  assert.equal(app.favorites.series().length, 2);
  await app.click('[data-favorite-action="delete-page"][data-series-id="' + first.id + '"]');
  await app.click('[data-favorite-action="confirm-delete"]');
  assert.deepEqual(app.favorites.series().map(row => row.id), [second.id]);
  assert.equal(app.$('[data-favorite-delete-dialog]').hidden, true);
  assert.equal(app.$('[data-favorite-page-row="' + first.id + '"]'), null);
  await app.click('[data-favorite-quick-new]');
  assert.equal(app.dom.window.document.activeElement, app.$('[data-favorite-quick-raw]'));
});

test('closing a page saves its pending Tag to that page before switching', async t => {
  const app = workbookFixture(t);
  const first = app.favorites.series()[0];
  await app.click('[data-favorite-action="new-series-tab"]');
  const second = app.favorites.series()[1];
  await app.click('[data-favorite-quick-new]');
  app.$('[data-favorite-quick-raw]').value = 'draft preserved';
  await app.click('[data-favorite-action="close-page"][data-series-id="' + second.id + '"]');
  assert.equal(app.$('[data-favorite-series]').dataset.favoriteSeries, first.id);
  assert.equal(app.favorites.list({ seriesId: second.id }).items[0].rawText, 'draft preserved');
  assert.equal(app.$('[data-favorite-quick-editor]').hidden, true);
});


test('locating a Tag reopens its closed page and hidden column', async t => {
  const app = workbookFixture(t); const page = app.favorites.series()[0]; const column = app.favorites.sections(page.id)[0];
  const entry = app.favorites.saveEntry({ seriesId: page.id, sectionId: column.id, rawText: 'locatable' }).data;
  await app.click('[data-favorite-action="toggle-section"][data-section-id="' + column.id + '"]');
  await app.click('[data-favorite-action="close-page"][data-series-id="' + page.id + '"]');
  assert.equal(await app.view.focusEntry(entry.id), true);
  assert.ok(app.$('[data-favorite-series-tab="' + page.id + '"]'));
  assert.ok(app.$('[data-favorite-entry="' + entry.id + '"]'));
});

test('column deletion requires page confirmation, preserves Tags and restores input afterwards', async t => {
  const app = workbookFixture(t); const page = app.favorites.series()[0]; const column = app.favorites.sections(page.id)[0];
  const entry = app.favorites.saveEntry({ seriesId: page.id, sectionId: column.id, rawText: 'move me' }).data;
  app.dom.window.confirm = () => { throw new Error('No native dialog'); };
  app.$('[data-favorite-section-tab]').dispatchEvent(new app.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await app.click('[data-favorite-action="context-delete"]');
  app.$('[data-favorite-delete-dialog]').dispatchEvent(new app.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(app.favorites.sections(page.id)[0].id, column.id);
  app.$('[data-favorite-section-tab]').dispatchEvent(new app.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await app.click('[data-favorite-action="context-delete"]');
  await app.click('[data-favorite-action="confirm-delete"]');
  assert.notEqual(app.favorites.getEntry(entry.id).sectionId, column.id);
  assert.ok(app.$('[data-favorite-entry="' + entry.id + '"]'));
  await app.click('[data-favorite-quick-new]');
  assert.equal(app.dom.window.document.activeElement, app.$('[data-favorite-quick-raw]'));
});

test('invalid pending content blocks page closing without losing the draft', async t => {
  const app = workbookFixture(t); const page = app.favorites.series()[0];
  await app.click('[data-favorite-quick-new]');
  app.$('[data-favorite-quick-title]').value = 'missing Tag';
  await app.click('[data-favorite-action="close-page"][data-series-id="' + page.id + '"]');
  assert.ok(app.$('[data-favorite-series-tab="' + page.id + '"]'));
  assert.equal(app.$('[data-favorite-quick-editor]').hidden, false);
  assert.equal(app.$('[data-favorite-quick-title]').value, 'missing Tag');
  assert.equal(app.favorites.list().total, 0);
});


test('closed pages and hidden columns restore from stored preferences in a fresh view', async t => {
  const app = workbookFixture(t); const page = app.favorites.series()[0]; const column = app.favorites.sections(page.id)[0];
  await app.click('[data-favorite-action="toggle-section"][data-section-id="' + column.id + '"]');
  await app.click('[data-favorite-action="close-page"][data-series-id="' + page.id + '"]');
  app.view.destroy();
  const dom = new JSDOM('<section id="favoritesView"></section>', { pretendToBeVisual: true });
  const view = createFavoritesView({ document: dom.window.document, favorites: createFavorites({ storage: app.storage }), preferences: app.storage.namespace('favorites-view') });
  t.after(() => { view.destroy(); dom.window.close(); }); view.enter();
  const $ = selector => dom.window.document.querySelector(selector);
  assert.equal($('[data-favorite-series-tab]'), null);
  $('[data-favorite-action="toggle-pages"]').click();
  $('[data-favorite-action="open-page"]').click(); await settle();
  assert.ok($('[data-favorite-series-tab]'));
  assert.equal($('[data-favorite-section]'), null);
  $('[data-favorite-action="toggle-section"]').click(); await settle();
  assert.ok($('[data-favorite-section]'));
});

test('quick Tag persistence failure retains input and retry does not duplicate the entry', async t => {
  const dom = new JSDOM('<section id="favoritesView"></section>', { pretendToBeVisual: true });
  const storage = createStorage(); let persisted = false;
  const favorites = createFavorites({ storage: { get: storage.get, set: storage.set, flush: async () => persisted } });
  const view = createFavoritesView({ document: dom.window.document, favorites });
  t.after(() => { view.destroy(); dom.window.close(); }); view.enter();
  const $ = selector => dom.window.document.querySelector(selector);
  $('[data-favorite-quick-new]').click();
  $('[data-favorite-quick-raw]').value = 'keep exact,  ';
  $('[data-favorite-action="quick-save"]').click(); await settle();
  assert.equal($('[data-favorite-quick-editor]').hidden, false);
  assert.equal($('[data-favorite-quick-raw]').value, 'keep exact,  ');
  assert.equal(favorites.list().total, 1);
  persisted = true; $('[data-favorite-action="quick-save"]').click(); await settle();
  assert.equal($('[data-favorite-quick-editor]').hidden, true);
  assert.equal(favorites.list().total, 1);
  assert.equal(favorites.list().items[0].rawText, 'keep exact,  ');
});


test('editor save failure keeps the panel open until storage accepts the saved Tag', async t => {
  const dom = new JSDOM('<section id="favoritesView"></section>', { pretendToBeVisual: true });
  const storage = createStorage(); let persisted = false;
  const favorites = createFavorites({ storage: { get: storage.get, set: storage.set, flush: async () => persisted } });
  const view = createFavoritesView({ document: dom.window.document, favorites });
  t.after(() => { view.destroy(); dom.window.close(); }); view.enter();
  const page = favorites.series()[0]; const column = favorites.sections(page.id)[0];
  const entry = favorites.saveEntry({ seriesId: page.id, sectionId: column.id, rawText: 'before' }).data;
  await view.openEditor(entry.id);
  const $ = selector => dom.window.document.querySelector(selector);
  const raw = $('[data-favorite-field="rawText"]'); raw.value = 'after';
  raw.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  $('[data-favorite-action="editor-save"]').click(); await settle();
  assert.equal($('[data-favorite-editor]').hidden, false);
  assert.equal(raw.value, 'after');
  persisted = true; $('[data-favorite-action="editor-save"]').click(); await settle();
  assert.equal($('[data-favorite-editor]').hidden, true);
  assert.equal(favorites.getEntry(entry.id).rawText, 'after');
});

test('entry deletion confirms the target, cancels without losing edits and deletes only that saved favorite', async t => {
  const app = workbookFixture(t);
  app.dom.window.confirm = () => { throw new Error('Use the page confirmation dialog'); };
  const page = app.favorites.series()[0]; const column = app.favorites.sections(page.id)[0];
  const entry = app.favorites.saveEntry({ seriesId: page.id, sectionId: column.id, rawText: 'remove me', title: '待删除收藏' }).data;
  const sibling = app.favorites.saveEntry({ seriesId: page.id, sectionId: column.id, rawText: 'keep me' }).data;
  app.favorites.setSelected(entry.id, true);
  await app.click('[data-favorite-edit="' + entry.id + '"]');
  const raw = app.$('[data-favorite-field="rawText"]');
  raw.value = ''; raw.dispatchEvent(new app.dom.window.Event('input', { bubbles: true }));
  await app.click('[data-favorite-action="editor-delete"]');
  assert.equal(app.$('[data-favorite-delete-dialog]').hidden, false);
  assert.match(app.$('[data-favorite-delete-message]').textContent, /待删除收藏/);
  assert.ok(app.favorites.getEntry(entry.id));
  await app.click('[data-favorite-action="cancel-delete"]');
  assert.equal(app.$('[data-favorite-editor]').hidden, false);
  assert.equal(raw.value, '');
  assert.ok(app.favorites.getEntry(entry.id));
  await app.click('[data-favorite-action="editor-delete"]');
  await app.click('[data-favorite-action="confirm-delete"]');
  await settle(350);
  assert.equal(app.favorites.getEntry(entry.id), null);
  assert.equal(createFavorites({ storage: app.storage }).getEntry(entry.id), null);
  assert.equal(app.$('[data-favorite-entry="' + entry.id + '"]'), null);
  assert.equal(app.$('[data-favorite-editor]').hidden, true);
  assert.equal(app.$('[data-favorite-delete-dialog]').hidden, true);
  assert.deepEqual(app.favorites.getEntry(sibling.id), sibling);
  assert.deepEqual(app.favorites.series(), [page]);
  assert.deepEqual(app.favorites.sections(page.id), [column]);
  assert.equal(app.favorites.selected()[0].rawText, 'remove me', 'the existing composed Prompt remains an independent snapshot');
  assert.equal(app.favorites.undo().ok, true);
  assert.equal(app.favorites.getEntry(entry.id).rawText, 'remove me');
  await app.click('[data-favorite-quick-new]');
  assert.equal(app.dom.window.document.activeElement, app.$('[data-favorite-quick-raw]'));
});

test('entry delete is unavailable for an unsaved draft and becomes available after its first save', async t => {
  const app = workbookFixture(t);
  await app.view.openCreate();
  const remove = app.$('[data-favorite-action="editor-delete"]');
  assert.ok(remove);
  assert.equal(remove.hidden, true);
  const raw = app.$('[data-favorite-field="rawText"]'); raw.value = 'new saved favorite';
  raw.dispatchEvent(new app.dom.window.Event('input', { bubbles: true }));
  assert.equal(await app.view.flushEdits(), true);
  assert.equal(remove.hidden, false);
  await app.click('[data-favorite-action="editor-delete"]');
  await app.click('[data-favorite-action="confirm-delete"]');
  assert.equal(app.favorites.list().total, 0);
});

test('rejected entry deletion keeps the editor and can be retried without deleting a sibling', async t => {
  const dom = new JSDOM('<section id="favoritesView"></section>', { pretendToBeVisual: true });
  const storage = createStorage(); let rejectDeletion = false;
  const favorites = createFavorites({ storage: {
    get: storage.get,
    set(key, value) { if (rejectDeletion && key === 'favorites_shelf_v1') throw new Error('disk unavailable'); return storage.set(key, value); },
    flush: () => storage.flush()
  } });
  const view = createFavoritesView({ document: dom.window.document, favorites });
  t.after(() => { view.destroy(); dom.window.close(); }); view.enter();
  const page = favorites.series()[0]; const column = favorites.sections(page.id)[0];
  const entry = favorites.saveEntry({ seriesId: page.id, sectionId: column.id, rawText: 'delete later' }).data;
  const sibling = favorites.saveEntry({ seriesId: page.id, sectionId: column.id, rawText: 'keep' }).data;
  await view.openEditor(entry.id);
  const $ = selector => dom.window.document.querySelector(selector);
  assert.ok($('[data-favorite-action="editor-delete"]'));
  $('[data-favorite-action="editor-delete"]').click();
  rejectDeletion = true;
  $('[data-favorite-action="confirm-delete"]').click(); await settle();
  assert.ok(favorites.getEntry(entry.id));
  assert.equal($('[data-favorite-editor]').hidden, false);
  assert.equal($('[data-favorite-delete-dialog]').hidden, false);
  assert.match($('[data-favorite-delete-status]').textContent, /disk unavailable/);
  assert.equal($('[data-favorite-action="confirm-delete"]').disabled, false);
  rejectDeletion = false;
  $('[data-favorite-action="confirm-delete"]').click(); await settle();
  assert.equal(favorites.getEntry(entry.id), null);
  assert.deepEqual(favorites.getEntry(sibling.id), sibling);
  assert.equal($('[data-favorite-delete-dialog]').hidden, true);
});

test('entry deletion waits for an in-flight edit save and does not recreate the removed record', async t => {
  const dom = new JSDOM('<section id="favoritesView"></section>', { pretendToBeVisual: true });
  const storage = createStorage(); let finishSave; let pendingSave = true;
  const favorites = createFavorites({ storage: { get: storage.get, set: storage.set, flush: () => pendingSave ? new Promise(resolve => { finishSave = resolve; }) : Promise.resolve(true) } });
  const view = createFavoritesView({ document: dom.window.document, favorites });
  t.after(() => { view.destroy(); dom.window.close(); }); view.enter();
  const page = favorites.series()[0]; const column = favorites.sections(page.id)[0];
  const entry = favorites.saveEntry({ seriesId: page.id, sectionId: column.id, rawText: 'original' }).data;
  await view.openEditor(entry.id);
  const $ = selector => dom.window.document.querySelector(selector);
  const raw = $('[data-favorite-field="rawText"]'); raw.value = 'first edit';
  raw.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  const saving = view.flushEdits();
  raw.value = 'later edit'; raw.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  $('[data-favorite-action="editor-delete"]').click();
  $('[data-favorite-action="confirm-delete"]').click(); await settle();
  assert.ok(favorites.getEntry(entry.id));
  assert.equal($('[data-favorite-action="confirm-delete"]').disabled, true);
  pendingSave = false; finishSave(true); await saving; await settle(350);
  assert.equal(favorites.getEntry(entry.id), null);
  assert.equal($('[data-favorite-editor]').hidden, true);
  assert.equal($('[data-favorite-delete-dialog]').hidden, true);
  assert.equal(createFavorites({ storage }).getEntry(entry.id), null);
});

test('entry deletion leaves a failed disk flush visible and retry completes persistence', async t => {
  const dom = new JSDOM('<section id="favoritesView"></section>', { pretendToBeVisual: true });
  const storage = createStorage(); let persisted = false;
  const favorites = createFavorites({ storage: { get: storage.get, set: storage.set, flush: async () => persisted } });
  const view = createFavoritesView({ document: dom.window.document, favorites });
  t.after(() => { view.destroy(); dom.window.close(); }); view.enter();
  const page = favorites.series()[0]; const column = favorites.sections(page.id)[0];
  const entry = favorites.saveEntry({ seriesId: page.id, sectionId: column.id, rawText: 'remove' }).data;
  await view.openEditor(entry.id);
  const $ = selector => dom.window.document.querySelector(selector);
  $('[data-favorite-action="editor-delete"]').click();
  $('[data-favorite-action="confirm-delete"]').click(); await settle();
  assert.equal($('[data-favorite-delete-dialog]').hidden, false);
  assert.match($('[data-favorite-delete-status]').textContent, /删除未能保存/);
  assert.equal($('[data-favorite-action="confirm-delete"]').disabled, false);
  const revision = favorites.snapshot().revision;
  persisted = true;
  $('[data-favorite-action="confirm-delete"]').click(); await settle();
  assert.equal(favorites.snapshot().revision, revision, 'retrying persistence does not add another deletion to history');
  assert.equal($('[data-favorite-delete-dialog]').hidden, true);
  assert.equal(createFavorites({ storage }).getEntry(entry.id), null);
});
