'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createHarness } = require('./fixtures/tag-library.cjs');
const { createFavorites } = require('../src/modules/favorites');
const { createStorage } = require('../src/modules/storage');
const { createFavoritesView } = require('../src/views/favorites-view');
const { createTagEditorView } = require('../src/views/tag-editor-view');
const settle = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, { empty = false } = {}) {
  const h = createHarness(empty ? { document: null } : {}); await h.ready;
  const dom = new JSDOM('<body><section id="favoritesView"></section></body>', { pretendToBeVisual: true });
  const storage = createStorage(), favorites = createFavorites({ library: h.library }), copied = [], notices = [];
  let decision = 'stay';
  const editor = createTagEditorView({ document: dom.window.document, catalog: h.library, confirmDiscard: () => decision });
  const view = createFavoritesView({ document: dom.window.document, favorites, tagEditor: editor, preferences: storage, copy: async value => { copied.push(value); return true; }, notify: value => notices.push(value) });
  view.enter();
  t.after(() => { view.destroy(); editor.dispose(); favorites.dispose(); dom.window.close(); });
  const $ = selector => dom.window.document.querySelector(selector);
  const click = async selector => { assert.ok($(selector), selector); $(selector).click(); await settle(); };
  const input = (name, value) => { const node = $(`[data-tag-field="${name}"]`); node.value = value; node.dispatchEvent(new dom.window.Event('input', { bubbles: true })); };
  const add = async (content = 'test', extra = {}) => { const result = await favorites.saveEntry({ seriesId: 'home', sectionId: 'daily', rawText: content, ...extra }); assert.equal(result.ok, true); view.render(); return result.data; };
  return { ...h, dom, storage, favorites, editor, view, copied, notices, $, click, input, add, decision(value) { decision = value; } };
}
test('empty library remains empty through render and creates page/group only by explicit actions', async t => {
  const h = await fixture(t, { empty: true }); const before = h.repository.saveCount;
  h.view.render(); h.view.enter(); assert.equal(h.repository.saveCount, before); assert.equal(h.favorites.series().length, 0);
  await h.click('[data-favorite-action="new-series-tab"]'); assert.equal(h.favorites.series().length, 1);
  assert.equal(h.favorites.sections().length, 0);
  await h.click('[data-favorite-action="new-section-tab"]'); assert.equal(h.favorites.sections().length, 1); assert.ok(h.$('[data-favorite-quick-new]'));
});
test('workbook navigation keeps inline zoom and no obsolete editor DOM', async t => {
  const h = await fixture(t);
  assert.ok(h.$('[data-favorite-anchors] [data-favorite-zoom]')); assert.ok(h.$('[data-favorite-anchors] + [data-favorite-subanchors]'));
  assert.equal(h.$('[data-favorite-editor], [data-favorite-quick-editor], .favorites-toolbar'), null);
  assert.equal(h.$('[data-favorite-zoom]').value, '120');
});
test('blank card opens the single editor and cancel leaves no tag or structure', async t => {
  const h = await fixture(t); const count = h.repository.saveCount;
  await h.click('[data-favorite-quick-new]'); h.input('content', 'discarded'); h.decision('discard');
  await h.click('[data-tag-close]'); assert.equal(h.repository.saveCount, count); assert.equal(h.favorites.list().total, 0);
  assert.equal(h.$('[data-tag-editor-overlay]').hidden, true);
});
test('explicit save creates exact opaque combination and note, with shared editor focus', async t => {
  const h = await fixture(t); const content = '  red, (blue:1.2)\r\n raw  ';
  await h.view.openCreate({ kind: 'bundle', rawText: content, title: 'Words' });
  assert.equal(h.dom.window.document.activeElement, h.$('[data-tag-field="content"]'));
  h.input('note', '<img src=x onerror=alert(1)>'); await h.click('[data-tag-save]');
  assert.equal(h.favorites.list().items[0].rawText, content); assert.equal(h.$('.favorite-note-popover').textContent, '<img src=x onerror=alert(1)>'); assert.equal(h.$('img'), null);
});
test('slow save freezes controls and dirty route/page protection retains draft until accepted', async t => {
  const h = await fixture(t); await h.click('[data-favorite-quick-new]'); h.input('content', 'pending');
  assert.equal(await h.view.leave(), false);
  const delayed = h.controls.delayNextSave(), saving = h.editor.save(); await delayed.started;
  assert.equal(h.$('[data-tag-save]').disabled, true); assert.equal(await h.view.leave(), false);
  delayed.release(); assert.equal((await saving).ok, true); assert.equal(await h.view.leave(), true);
});
test('failed save retains input and retry uses one tag; invalid save cannot close page', async t => {
  const h = await fixture(t); await h.click('[data-favorite-quick-new]'); h.input('content', 'retry');
  h.controls.failNextSave(); assert.equal((await h.editor.save()).ok, false); assert.equal(h.$('[data-tag-field="content"]').value, 'retry');
  assert.equal((await h.editor.save()).ok, true); assert.equal(h.favorites.list().total, 1);
  await h.view.openCreate(); h.input('displayName', 'missing content'); h.decision('save');
  await h.click('[data-favorite-action="close-page"]'); assert.ok(h.$('[data-favorite-series-tab]')); assert.equal(h.$('[data-tag-editor-overlay]').hidden, false);
});
test('pencil opens canonical membership and copy/selection use current formatted content', async t => {
  const h = await fixture(t), row = await h.add('one (two)');
  await h.click(`[data-favorite-edit="${row.id}"]`); h.input('content', 'changed (two)'); await h.click('[data-tag-save]');
  await h.click(`[data-favorite-select="${row.id}"]`);
  assert.equal(h.copied.at(-1), 'changed \\(two\\)'); assert.equal(h.library.selected()[0].content, 'changed \\(two\\)');
});
test('page rename, color draft and cancellation preserve focus through locale refresh', async t => {
  const h = await fixture(t), tab = h.$('[data-favorite-series-tab]');
  tab.dispatchEvent(new h.dom.window.MouseEvent('contextmenu', { bubbles: true }));
  await h.click('[data-favorite-action="context-edit"]');
  h.$('[data-favorite-dialog-input]').value = '<b>Page</b>'; h.$('[data-favorite-dialog-color]').value = '#123456';
  h.view.refreshLocale(); assert.equal(h.$('[data-favorite-dialog-color]').value, '#123456');
  await h.click('[data-favorite-action="dialog-confirm"]'); assert.equal(h.favorites.series()[0].name, '<b>Page</b>'); assert.equal(h.$('[data-favorite-series-tab] b'), null);
  assert.equal(h.favorites.series()[0].color, '#123456');
});
test('context menu Escape and outside click dismiss without changing active page', async t => {
  const h = await fixture(t); await h.click('[data-favorite-action="new-series-tab"]');
  const active = h.$('[data-favorite-series]').dataset.favoriteSeries;
  const tab = h.$('[data-favorite-series-tab="home"]'); tab.dispatchEvent(new h.dom.window.MouseEvent('contextmenu', { bubbles: true }));
  h.$('[data-favorite-context-menu]').dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(h.$('[data-favorite-context-menu]').hidden, true); assert.equal(h.$('[data-favorite-series]').dataset.favoriteSeries, active);
  tab.dispatchEvent(new h.dom.window.MouseEvent('contextmenu', { bubbles: true })); h.dom.window.document.body.dispatchEvent(new h.dom.window.Event('pointerdown', { bubbles: true }));
  assert.equal(h.$('[data-favorite-context-menu]').hidden, true);
});
test('group reorder and item reorder await canonical commands', async t => {
  const h = await fixture(t); const a = await h.add('a'), b = await h.add('b');
  await h.click(`[data-favorite-action="move-up"][data-entry-id="${b.id}"]`); assert.deepEqual(h.favorites.list().items.map(x => x.id), [b.id, a.id]);
  await h.click('[data-favorite-action="new-section-tab"]');
  const ids = h.favorites.sections('home').map(x => x.id), event = type => new h.dom.window.Event(type, { bubbles: true, cancelable: true });
  h.$(`[data-favorite-section-tab="${ids[1]}"]`).dispatchEvent(event('dragstart')); h.$(`[data-favorite-section-tab="${ids[0]}"]`).dispatchEvent(event('drop')); await settle();
  assert.deepEqual(h.favorites.sections('home').map(x => x.id), ids.reverse());
});
test('hidden columns and closed pages persist presentation without modifying catalog', async t => {
  const h = await fixture(t); await h.add(); const revision = h.library.revision();
  await h.click('[data-favorite-action="toggle-section"]'); await h.click('[data-favorite-action="close-page"]');
  assert.equal(h.$('[data-favorite-series-tab]'), null); assert.equal(h.library.revision(), revision);
  await h.view.leave(); h.view.enter(); assert.equal(h.$('[data-favorite-series-tab]'), null);
  await h.click('[data-favorite-action="toggle-pages"]'); await h.click('[data-favorite-action="open-page"]');
  assert.equal(h.$('[data-favorite-section]'), null); await h.click('[data-favorite-action="toggle-section"]'); assert.ok(h.$('[data-favorite-entry]'));
});
test('locating a tag reopens closed page and hidden column', async t => {
  const h = await fixture(t), row = await h.add();
  await h.click('[data-favorite-action="toggle-section"]'); await h.click('[data-favorite-action="close-page"]');
  assert.equal(await h.view.focusEntry(row.id), true); assert.ok(h.$(`[data-favorite-entry="${row.id}"]`));
});
test('page deletion uses in-page confirmation and removes membership but preserves tag', async t => {
  const h = await fixture(t), row = await h.add();
  await h.click('[data-favorite-action="toggle-pages"]'); await h.click('[data-favorite-action="delete-page"]');
  await h.click('[data-favorite-action="cancel-delete"]'); assert.ok(h.favorites.getEntry(row.id));
  await h.click('[data-favorite-action="delete-page"]'); h.$('[data-favorite-delete-mode]').value = 'unfavorite'; await h.click('[data-favorite-action="confirm-delete"]');
  assert.equal(h.favorites.series().length, 0); assert.ok(h.library.getTag(row.tagId));
});
test('group deletion relocates memberships and confirmation cancellation is read-only', async t => {
  const h = await fixture(t), row = await h.add(); const tab = h.$('[data-favorite-section-tab]');
  tab.dispatchEvent(new h.dom.window.MouseEvent('contextmenu', { bubbles: true })); await h.click('[data-favorite-action="context-delete"]'); await h.click('[data-favorite-action="cancel-delete"]');
  assert.equal(h.favorites.getEntry(row.id).sectionId, 'daily');
  tab.dispatchEvent(new h.dom.window.MouseEvent('contextmenu', { bubbles: true })); await h.click('[data-favorite-action="context-delete"]'); await h.click('[data-favorite-action="confirm-delete"]');
  assert.notEqual(h.favorites.getEntry(row.id).sectionId, 'daily'); await h.view.focusEntry(row.id); assert.ok(h.$('[data-favorite-entry]'));
});
test('entry deletion cancellation, write failure, retry preserve siblings and canonical tag', async t => {
  const h = await fixture(t), a = await h.add('a'), b = await h.add('b');
  const remove = `[data-favorite-action="delete-entry"][data-entry-id="${a.id}"]`;
  await h.click(remove); await h.click('[data-favorite-action="cancel-delete"]'); assert.ok(h.favorites.getEntry(a.id));
  await h.click(remove); h.controls.failNextSave(); await h.click('[data-favorite-action="confirm-delete"]');
  assert.equal(h.$('[data-favorite-delete-dialog]').hidden, false); assert.ok(h.favorites.getEntry(a.id));
  await h.click('[data-favorite-action="confirm-delete"]'); assert.equal(h.favorites.getEntry(a.id), null); assert.ok(h.favorites.getEntry(b.id)); assert.ok(h.library.getTag(a.tagId));
});
test('entry delete cannot race a pending editor save or recreate an unfavorited record', async t => {
  const h = await fixture(t), row = await h.add();
  await h.view.openEditor(row.id); h.input('note', 'pending');
  const delay = h.controls.delayNextSave(), saving = h.editor.save(); await delay.started;
  await h.click(`[data-favorite-action="delete-entry"][data-entry-id="${row.id}"]`); await h.click('[data-favorite-action="confirm-delete"]');
  assert.ok(h.favorites.getEntry(row.id)); delay.release(); await saving;
  await h.click('[data-favorite-action="confirm-delete"]'); assert.equal(h.favorites.getEntry(row.id), null);
});
