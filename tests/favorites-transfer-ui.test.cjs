'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createHarness, makeRecord, makeBase, emptyUserDocument } = require('./fixtures/tag-library.cjs');
const { createFavorites } = require('../src/modules/favorites');
const { createFavoritesView } = require('../src/views/favorites-view');
const settle = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, count = 0) {
  const base = makeBase(), document = emptyUserDocument(base);
  for (let i = 0; i < count; i++) { document.customTags.push(makeRecord({ id: `user:${i}`, content: `match ${i}`, source: { kind: 'custom', key: null } })); document.memberships.push({ id: `member:${i}`, tagId: `user:${i}`, groupId: 'daily', order: i, pinned: false }); }
  const h = createHarness({ document }); await h.ready;
  const dom = new JSDOM('<body><section id="favoritesView"></section></body>', { pretendToBeVisual: true }), favorites = createFavorites({ library: h.library });
  const view = createFavoritesView({ document: dom.window.document, favorites }); view.enter();
  t.after(() => { view.destroy(); favorites.dispose(); dom.window.close(); });
  return { ...h, dom, favorites, view, $: value => dom.window.document.querySelector(value), async click(value) { const node = dom.window.document.querySelector(value); assert.ok(node, value); node.click(); await settle(); } };
}
test('favorites search freezes all matching IDs across pages and batch keeps prompt selection separate', async t => {
  const h = await fixture(t, 2050);
  assert.ok(h.$('[data-transfer-search]'));
  h.$('[data-transfer-search]').value = 'match'; h.$('[data-transfer-search]').dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
  await h.click('[data-transfer-action="select-all"]');
  assert.match(h.$('[data-transfer-count]').textContent, /2050/);
  h.$('[data-transfer-search]').value = 'different'; h.$('[data-transfer-search]').dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
  h.$('[data-transfer-batch]').value = 'hide-search'; await h.click('[data-transfer-action="batch"]');
  assert.equal(h.library.search('', { scope: 'favorites', includeAdult: true }).total, 0); assert.equal(h.library.selected().length, 0);
  await h.click('[data-transfer-action="undo"]'); assert.equal(h.library.search('match', { scope: 'favorites', includeAdult: true }).total, 2050);
});
test('paste preview cancel does not write and failed apply retains draft for one durable retry', async t => {
  const h = await fixture(t); const before = h.library.revision();
  await h.click('[data-transfer-action="paste"]'); h.$('[data-transfer-paste-text]').value = 'new exact';
  await h.click('[data-transfer-action="preview-paste"]'); assert.ok(h.$('[data-transfer-preview]').textContent);
  await h.click('[data-transfer-action="cancel"]'); assert.equal(h.library.revision(), before);
  await h.click('[data-transfer-action="paste"]'); h.$('[data-transfer-paste-text]').value = 'new exact'; await h.click('[data-transfer-action="preview-paste"]');
  h.controls.failNextSave(); await h.click('[data-transfer-action="apply"]'); assert.equal(h.library.revision(), before); assert.equal(h.$('[data-transfer-dialog]').hidden, false);
  await h.click('[data-transfer-action="apply"]'); assert.equal(h.library.getMemberships().length, 1); assert.equal(h.$('[data-transfer-dialog]').hidden, true);
});
test('all batch controls use durable canonical operations and failure preserves frozen IDs', async t => {
  const h = await fixture(t, 2); const page = await h.favorites.saveSeries({ name: 'Target' }), group = await h.favorites.saveSection({ seriesId: page.data.id, name: 'Group' }); h.view.render();
  await h.click('[data-transfer-action="manage"]'); await h.click('[data-transfer-action="select-all"]');
  h.$('[data-transfer-destination]').value = JSON.stringify([page.data.id, group.data.id]); h.$('[data-transfer-batch]').value = 'reference';
  h.controls.failNextSave(); await h.click('[data-transfer-action="batch"]'); assert.equal(h.library.getMemberships().length, 2); assert.match(h.$('[data-transfer-count]').textContent, /2/);
  await h.click('[data-transfer-action="batch"]'); assert.equal(h.library.getMemberships().length, 4); assert.equal(h.library.exportBundle({ scope: 'favorites' }).tags.length, 2);
  await h.click('[data-transfer-action="undo"]'); assert.equal(h.library.getMemberships().length, 2);
  for (const mode of ['independent', 'move', 'pin', 'adult', 'color', 'auto-color', 'unfavorite']) {
    await h.click('[data-transfer-action="select-all"]'); h.$('[data-transfer-batch]').value = mode; h.$('[data-transfer-destination]').value = JSON.stringify([page.data.id, group.data.id]); h.$('[data-transfer-color]').value = '#123456';
    await h.click('[data-transfer-action="batch"]');
    if (mode === 'independent') assert.equal(h.library.exportBundle({ scope: 'favorites' }).tags.length, 4);
    if (mode === 'move') assert.ok(h.library.getMemberships().every(row => row.groupId === group.data.id));
    if (mode === 'pin') assert.ok(h.library.getMemberships().every(row => row.pinned));
    if (mode === 'adult') assert.ok(h.library.exportBundle({ scope: 'favorites' }).tags.every(row => row.adult));
    if (mode === 'color') assert.equal(h.library.getFavoritePages().find(row => row.id === 'home').color, '#123456');
    if (mode === 'unfavorite') assert.equal(h.library.getMemberships().length, 0);
    await h.click('[data-transfer-action="undo"]'); assert.equal(h.library.getMemberships().length, 2);
  }
});
test('import preview survives locale refresh and escape cancels without writes', async t => {
  const h = await fixture(t); await h.click('[data-transfer-action="paste"]'); h.$('[data-transfer-paste-text]').value = 'draft after locale'; await h.click('[data-transfer-action="preview-paste"]');
  h.view.refreshLocale(); assert.equal(h.$('[data-transfer-dialog]').hidden, false); assert.equal(h.$('[data-transfer-paste-text]').value, 'draft after locale');
  h.$('[data-transfer-dialog]').dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
  assert.equal(h.$('[data-transfer-dialog]').hidden, true); assert.equal(h.library.revision(), 0);
});
test('file chooser previews bounded JSON and report export uses a safe byte download', async t => {
  const h = await fixture(t, 1); const input = h.$('[data-transfer-file]'); assert.match(input.accept, /\.json\.gz/);
  const file = new h.dom.window.File([JSON.stringify(h.library.exportBundle({ scope: 'all' }))], 'backup.json', { type: 'application/json' });
  Object.defineProperty(input, 'files', { value: [file] }); input.dispatchEvent(new h.dom.window.Event('change', { bubbles: true }));
  for (let i = 0; i < 10 && !h.$('[data-transfer-preview]').textContent; i++) await settle();
  assert.match(h.$('[data-transfer-preview]').textContent, /复用/); assert.equal(h.library.revision(), 0);
  await h.click('[data-transfer-action="cancel"]'); await h.click('[data-transfer-action="report"]');
  let downloaded = null; h.dom.window.URL.createObjectURL = blob => { downloaded = blob; return 'blob:test'; }; h.dom.window.URL.revokeObjectURL = () => {}; h.dom.window.HTMLAnchorElement.prototype.click = function click() { assert.equal(this.download, 'ai-tag-migration-report.json'); };
  await h.click('[data-transfer-action="export-report"]'); assert.equal(downloaded.type, 'application/json'); assert.ok(downloaded.size > 10);
});
test('page scope includes newly created pages and preserves the chosen page through renames', async t => {
  const h = await fixture(t, 1), scope = h.$('[data-transfer-scope]');
  scope.value = 'home'; scope.dispatchEvent(new h.dom.window.Event('change', { bubbles: true }));
  const page = await h.favorites.saveSeries({ name: 'Created page' }), group = await h.favorites.saveSection({ seriesId: page.data.id, name: 'Created group' });
  await h.favorites.saveEntry({ kind: 'tag', rawText: 'created page content', seriesId: page.data.id, sectionId: group.data.id });
  assert.ok([...scope.options].some(row => row.value === page.data.id)); assert.equal(scope.value, 'home');
  scope.value = page.data.id; scope.dispatchEvent(new h.dom.window.Event('change', { bubbles: true }));
  assert.match(h.$('[data-transfer-results]').textContent, /created page content/); assert.equal(h.$('[data-transfer-results]').children.length, 1);
  await h.favorites.saveSeries({ id: page.data.id, name: 'Renamed page' });
  assert.equal(scope.value, page.data.id); assert.equal(scope.selectedOptions[0].textContent, 'Renamed page');
});
test('page scope includes imported pages without replacing the current filter', async t => {
  const h = await fixture(t, 1), scope = h.$('[data-transfer-scope]'), bundle = h.library.exportBundle({ scope: 'favorites' });
  scope.value = 'home'; scope.dispatchEvent(new h.dom.window.Event('change', { bubbles: true }));
  bundle.pages[0].id = 'imported-page'; bundle.pages[0].name = 'Imported page';
  bundle.groups[0].id = 'imported-group'; bundle.groups[0].pageId = 'imported-page'; bundle.memberships[0].groupId = 'imported-group';
  const preview = h.favorites.previewImport(bundle); assert.equal(preview.ok, true);
  assert.equal((await h.favorites.importBundle(preview.data.id)).ok, true);
  assert.ok([...scope.options].some(row => row.value === 'imported-page')); assert.equal(scope.value, 'home');
  scope.value = 'imported-page'; scope.dispatchEvent(new h.dom.window.Event('change', { bubbles: true }));
  assert.equal(h.$('[data-transfer-results]').children.length, 1); assert.match(h.$('[data-transfer-results]').textContent, /Imported page/);
});
test('deleting the filtered page resets scope and displays the relocated entries', async t => {
  const h = await fixture(t, 1), scope = h.$('[data-transfer-scope]');
  scope.value = 'home'; scope.dispatchEvent(new h.dom.window.Event('change', { bubbles: true }));
  assert.equal((await h.favorites.deleteSeries('home')).ok, true);
  assert.equal(scope.value, ''); assert.equal([...scope.options].some(row => row.value === 'home'), false);
  assert.equal(h.$('[data-transfer-results]').children.length, 1); assert.deepEqual(JSON.parse(h.$('[data-transfer-members]').dataset.transferMembers), ['member:0']);
});
