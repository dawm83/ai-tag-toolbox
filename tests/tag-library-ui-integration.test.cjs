'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { createHarness, makeBase, makeRecord, emptyUserDocument } = require('./fixtures/tag-library.cjs');
const modules = require('../src/modules');
const { formatTagOutput } = require('../src/modules/tag-library');
const root = path.resolve(__dirname, '..');
const settle = () => new Promise(resolve => setImmediate(resolve));
async function boot(t, options = {}) {
  const h = createHarness(options); await h.ready;
  const storage = modules.createStorage();
  const tags = modules.createTags({ library: h.library, preferences: storage });
  const favorites = modules.createFavorites({ library: h.library });
  const characters = modules.createCharacters({ library: h.library, characterSource: { characters: (options.base || makeBase()).characterLinks.map(row => ({ id: row.characterId })) } });
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'src/index.html'), 'utf8'), { url: 'http://localhost', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom; let copied = '';
  window.navigator.clipboard = { writeText: async value => { copied = value; } };
  // Electron contextBridge copies arguments between realms; preserve that boundary
  // while every query and command still runs the actual library.
  const catalog = { ...h.library, execute: (command, settings) => h.library.execute(structuredClone(command), structuredClone(settings)) };
  const bridgedCharacters = { ...characters, edit: (...args) => characters.edit(...structuredClone(args)), select: (...args) => characters.select(...structuredClone(args)) };
  const visionTempStore = options.visionImage ? { current: () => ({ tempId: 'vision-fixture' }), get: () => structuredClone(options.visionImage) } : undefined;
  window.AppModules = { catalog, tags, favorites, characters: bridgedCharacters, preferences: storage, formatTagOutput, visionTempStore };
  for (const name of ['tag-location', 'tag-editor', 'favorites', 'characters']) window.eval(fs.readFileSync(path.join(root, `src/views/${name}-view.js`), 'utf8'));
  window.eval(fs.readFileSync(path.join(root, 'src/app-view.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'));
  await window.App.ready; await settle();
  t.after(() => { window.App.dispose(); tags.dispose(); favorites.dispose(); characters.dispose(); dom.window.close(); });
  const $ = selector => window.document.querySelector(selector);
  const click = async selector => { assert.ok($(selector), selector); $(selector).click(); await settle(); };
  const input = (selector, value) => { const node = $(selector); if (typeof value === 'boolean') node.checked = value; else node.value = value; node.dispatchEvent(new window.Event('input', { bubbles: true })); };
  return { ...h, dom, window, $, click, input, tags, favorites, characters, copied: () => copied };
}

test('vision displays shared Chinese and taxonomy while copy keeps raw Tags and model order', async t => {
  const base = makeBase();
  base.tags.find(row => row.id === 'long_hair').displayName = '<script>长发</script>';
  const original = ['long_hair', '(blue_hair:1.2)', 'blue_hair', 'unknown_tag'];
  const h = await boot(t, { base, visionImage: { metadata: { builtinTags: ['blue_hair'] }, analysis: { tags: original.map((tag, index) => ({ tag, prob: 0.9 - index / 10, category: 0 })) } } });
  await h.window.App.route('ai');
  const doc = h.window.document;
  const groups = doc.querySelectorAll('.vision-tag-group[data-category="hair"]');
  assert.equal(groups.length, 2);
  assert.match(groups[1].textContent, /蓝发/);
  assert.match(groups[1].textContent, /<script>长发<\/script>/);
  assert.equal(groups[1].querySelector('script'), null);
  assert.match(doc.querySelector('.vision-tag-group[data-category="unclassified"]').textContent, /unknown_tag/);
  const model = doc.querySelectorAll('#tpModes .tp-mod')[1];
  assert.equal(model.querySelector('[data-tag="long_hair"] .vision-confidence').textContent, '90%');
  model.querySelector('[data-tag="blue_hair"]').click(); await settle();
  assert.equal(h.copied(), 'blue_hair');
  model.querySelector('.tpm-copy').click(); await settle();
  assert.equal(h.copied(), original.join(', '));
  await h.tags.edit('blue_hair', { zh: '新中文' }); await settle();
  assert.equal(doc.querySelector('[data-tag="blue_hair"] .zh').textContent, '新中文');
});
test('actual app shares favorite edits, role traits, private browse and selection with one editor', async t => {
  const h = await boot(t);
  assert.ok(h.$('[data-en="blue_hair"]'));
  await h.click('[data-tag-favorite="blue_hair"]');
  h.$('[data-location-parent]').value = 'home'; h.$('[data-location-parent]').dispatchEvent(new h.window.Event('change'));
  h.$('[data-location-child]').value = 'daily'; await h.click('[data-location-confirm]');
  assert.equal(h.window.App.state.route, 'tags'); assert.equal(h.library.getMemberships('blue_hair').length, 1, h.$('#toast').textContent + ' / ' + h.$('[data-location-error]').textContent);
  await h.window.App.route('favorites');
  const member = h.library.getMemberships('blue_hair')[0]; await h.click(`[data-favorite-edit="${member.id}"]`);
  h.input('[data-tag-field="content"]', 'azure hair'); h.input('[data-tag-field="aliases"]', 'sky hue'); h.input('[data-tag-field="note"]', '<img src=x onerror=alert(1)>');
  await h.click('[data-tag-save]');
  assert.equal(h.characters.get('alice').generalTags[0].content, 'azure hair'); assert.equal(h.characters.get('bob').generalTags[0].note, '<img src=x onerror=alert(1)>');
  assert.equal(h.$('[data-favorite-editor]'), null); assert.equal(h.$('[data-favorite-quick-editor]'), null);
  assert.equal(h.$('[data-favorite-shelf] img'), null);
  await h.click(`[data-favorite-edit="${member.id}"]`); h.input('[data-tag-field="searchable"]', false); await h.click('[data-tag-save]');
  assert.equal(h.library.search('azure hair', { scope: 'all' }).total, 0); assert.equal(h.favorites.list({ sectionId: 'daily' }).items.length, 1);
  await h.click(`[data-favorite-action="delete-entry"][data-entry-id="${member.id}"]`); await h.click('[data-favorite-action="confirm-delete"]');
  assert.ok(h.library.getTag('blue_hair')); assert.equal(h.library.getMemberships('blue_hair').length, 0);
});
test('canonical selection dedupes shared role traits by ID and preserves opaque blocks', async t => {
  const h = await boot(t);
  await h.tags.select('blue_hair');
  await h.characters.select('alice', { generalTagIds: ['blue_hair'], includeSeries: false });
  await h.characters.select('bob', { generalTagIds: ['blue_hair'], includeSeries: false });
  assert.equal(h.$('#selCount').textContent, '3'); assert.equal(h.$('#preview').textContent, 'blue hair, alice, bob');
  const saved = await h.library.execute({ type: 'saveTag', patch: { kind: 'bundle', content: '  A, (b:1.2)\r\nc\n  ' } }, { operationId: 'bundle' });
  assert.equal(saved.ok, true); await h.tags.select(saved.data.tagId); await h.click('#copyAll');
  assert.ok(h.copied().endsWith('  A, (b:1.2)\r\nc\n  '));
});

test('home shows notes, search-disabled state and exact favorite locations without losing multi-group additions', async t => {
  const h = await boot(t);
  await h.tags.edit('blue_hair', { note: '<img src=x> 用户备注', searchable: false });
  const second = (await h.favorites.saveSection({ seriesId: 'home', name: '第二组' })).data;
  await h.favorites.saveEntry({ sourceTagId: 'blue_hair', seriesId: 'home', sectionId: 'daily' });
  assert.equal(h.$('[data-en="blue_hair"] .tag-search-disabled').textContent, '不参与搜索');
  assert.equal(h.$('[data-tag-note="blue_hair"]').textContent, '<img src=x> 用户备注');
  assert.equal(h.$('[data-tag-note="blue_hair"] img'), null);
  assert.equal(h.$('[data-tag-favorite="blue_hair"]').getAttribute('aria-pressed'), 'true');
  await h.click('[data-tag-favorite="blue_hair"]');
  h.$('[data-location-parent]').value = 'home'; h.$('[data-location-parent]').dispatchEvent(new h.window.Event('change'));
  h.$('[data-location-child]').value = second.id; await h.click('[data-location-confirm]');
  const locations = h.window.document.querySelectorAll('[data-tag-locations="blue_hair"] [data-locate-membership]');
  assert.equal(locations.length, 2);
  const target = h.library.getMemberships('blue_hair').find(row => row.groupId === second.id);
  await h.click(`[data-locate-membership="${target.id}"]`);
  assert(h.$(`[data-favorite-entry="${target.id}"]`).classList.contains('is-located'));
});

test('migrated Prompt snapshots remain visibly historical while preserving exact copied content', async t => {
  const document = emptyUserDocument();
  document.selection = [{ kind: 'legacySnapshot', id: 'old', content: '(blue hair:1.3)\nlong hair', displayName: '旧组合', adult: false }];
  const h = await boot(t, { document });
  assert.equal(h.$('.selection-snapshot-label').textContent, '旧快照');
  await h.click('#copyAll');
  assert.equal(h.copied(), '(blue hair:1.3)\nlong hair');
});
test('actual homepage load more crosses the 2000 query cap without duplicate IDs', async t => {
  const base = makeBase(); base.tags.push(...Array.from({ length: 2050 }, (_, i) => makeRecord({ id: 'bulk:' + i, content: 'bulk ' + i })));
  const h = await boot(t, { base });
  for (let i = 0; i < 5; i++) await h.click('.loadmore');
  const ids = [...h.window.document.querySelectorAll('#chips [data-en]')].map(node => node.dataset.en);
  assert.equal(ids.length, base.tags.length); assert.equal(new Set(ids).size, ids.length);
});
test('real startup failure blocks view initialization and repaired retry starts the same catalog', async t => {
  const h = await boot(t, { document: {} });
  assert.ok(h.$('[data-catalog-startup]')); assert.equal(h.$('#chips').childElementCount, 0);
  assert.equal(h.library.status().writable, false); const before = h.repository.saveCount;
  await h.click('#addTagBtn'); assert.equal(h.$('[data-tag-editor-overlay]').hidden, true); assert.equal(h.repository.saveCount, before);
  await h.repository.save(emptyUserDocument()); await h.click('[data-catalog-retry]');
  assert.equal(h.$('[data-catalog-startup]'), null); assert.ok(h.$('[data-en="blue_hair"]'));
});
test('relationship choices use canonical names and IDs; cancel writes nothing and save propagates', async t => {
  const h = await boot(t); await h.window.App.route('characters');
  await h.click('[data-character-id="alice"]'); await h.click('.character-detail-edit');
  assert.equal(h.$('[data-character-edit="nameZh"]'), null);
  const add = '[data-character-relation="generalTagIds"] [data-relation-add="long_hair"]';
  assert.equal(h.$(add).textContent, '长发'); await h.click(add);
  assert.equal(await h.window.App.route('tags'), false);
  const before = h.repository.saveCount;
  h.$('[data-character-relation-cancel]').click(); await settle();
  assert.equal(h.repository.saveCount, before); assert.deepEqual(h.library.getCharacterLinks('alice').generalTagIds, ['blue_hair']);
  await h.click('.character-detail-edit'); await h.click(add);
  h.$('[data-character-edit-panel]').dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true })); await settle();
  assert.deepEqual(h.library.getCharacterLinks('alice').generalTagIds, ['blue_hair', 'long_hair']);
  assert.equal(await h.window.App.route('tags'), true);
});
test('malicious tag content, aliases, category labels and selection are text, not markup', async t => {
  const h = await boot(t), attack = '<img src=x onerror=alert(1)>';
  await h.library.execute({ type: 'saveTag', tagId: 'blue_hair', patch: { content: attack, displayName: '', aliases: ['<svg onload=alert(1)>'], note: attack } }, { operationId: 'xss' });
  assert.equal(h.$('#chips img, #chips svg[onload]'), null); assert.match(h.$('[data-en="blue_hair"]').textContent, /<img/);
  await h.tags.select('blue_hair'); assert.equal(h.$('#selbox img'), null); assert.match(h.$('#selbox').textContent, /<img/);
});
test('same tag selected from either membership marks both locations and editor drafts survive notifications', async t => {
  const h = await boot(t);
  const page = (await h.favorites.saveSeries({ name: 'Second' })).data;
  const group = (await h.favorites.saveSection({ seriesId: page.id, name: 'Other' })).data;
  const first = (await h.favorites.saveEntry({ sourceTagId: 'blue_hair', seriesId: 'home', sectionId: 'daily' })).data;
  const second = (await h.favorites.saveEntry({ sourceTagId: 'blue_hair', seriesId: page.id, sectionId: group.id })).data;
  await h.favorites.setSelected(second.id, true); await h.window.App.route('favorites');
  assert.equal(h.$(`[data-favorite-select="${first.id}"]`).getAttribute('aria-pressed'), 'true');
  await h.click(`[data-favorite-edit="${first.id}"]`); h.input('[data-tag-field="note"]', 'draft');
  const active = h.window.document.activeElement;
  await h.library.execute({ type: 'saveTag', tagId: 'long_hair', patch: { note: 'outside' } }, { operationId: 'outside-draft' });
  assert.equal(h.$('[data-tag-field="note"]').value, 'draft'); assert.equal(h.window.document.activeElement, active);
});
test('favorite subscriptions insert two sequential blank-cell saves and move exact membership through the picker', async t => {
  const h = await boot(t);
  const other = (await h.favorites.saveSection({ seriesId: 'home', name: 'Other' })).data;
  await h.window.App.route('favorites');
  const column = id => h.$(`[data-favorite-section="${id}"]`);
  const count = id => column(id).querySelector('.favorite-section-count').textContent;
  const scroll = h.$('[data-favorite-scroll]'); scroll.scrollLeft = 170; scroll.scrollTop = 23;
  for (const content of ['newone', 'newtwo']) {
    await h.click('[data-favorite-quick-new][data-section-id="daily"]');
    h.input('[data-tag-field="content"]', content); await h.click('[data-tag-save]');
  }
  assert.equal(h.favorites.list({ sectionId: 'daily' }).total, 2);
  assert.equal(column('daily').querySelectorAll('[data-favorite-entry]').length, 2);
  assert.equal(count('daily'), '2'); assert.equal(count(other.id), '0');
  const member = h.favorites.list({ sectionId: 'daily' }).items.find(row => row.rawText === 'newtwo');
  await h.click(`[data-favorite-edit="${member.id}"]`); await h.click('[data-tag-location]');
  h.$('[data-location-child]').value = other.id; await h.click('[data-location-confirm]'); await h.click('[data-tag-save]');
  assert.equal(h.favorites.getEntry(member.id).sectionId, other.id);
  assert.equal(column('daily').querySelectorAll('[data-favorite-entry]').length, 1);
  assert.equal(column(other.id).querySelectorAll('[data-favorite-entry]').length, 1);
  assert.equal(count('daily'), '1'); assert.equal(count(other.id), '1');
  assert.equal(scroll.scrollLeft, 170); assert.equal(scroll.scrollTop, 23);
});
test('favorite subscriptions remove newly adult rows and restore newly safe rows with accurate counts', async t => {
  const h = await boot(t);
  const member = (await h.favorites.saveEntry({ sourceTagId: 'blue_hair', seriesId: 'home', sectionId: 'daily' })).data;
  await h.window.App.route('favorites'); assert.equal(h.tags.stateSnapshot().includeAdult, false);
  await h.click(`[data-favorite-edit="${member.id}"]`); h.input('[data-tag-field="adult"]', true); await h.click('[data-tag-save]');
  assert.equal(h.favorites.list({ sectionId: 'daily', includeAdult: false }).total, 0);
  assert.equal(h.$(`[data-favorite-entry="${member.id}"]`), null);
  assert.equal(h.$('.favorite-section-count').textContent, '0'); assert.match(h.$('.favorite-adult-hidden').textContent, /1/);
  await h.library.execute({ type: 'saveTag', tagId: 'blue_hair', patch: { adult: false } }, { operationId: 'make-safe' });
  assert.ok(h.$(`[data-favorite-entry="${member.id}"]`)); assert.equal(h.$('.favorite-section-count').textContent, '1');
  assert.equal(h.$('.favorite-adult-hidden'), null);
});
test('stale favorite DOM cannot copy or select a now-hidden adult tag', async t => {
  const h = await boot(t);
  const member = (await h.favorites.saveEntry({ sourceTagId: 'blue_hair', seriesId: 'home', sectionId: 'daily' })).data;
  await h.window.App.route('favorites');
  const stale = h.$(`[data-favorite-entry="${member.id}"]`).cloneNode(true);
  await h.library.execute({ type: 'saveTag', tagId: 'blue_hair', patch: { adult: true } }, { operationId: 'adult-stale' });
  h.$('.favorite-entry-list').replaceChildren(stale);
  const revision = h.library.revision();
  await h.click(`[data-favorite-copy="${member.id}"]`); await h.click(`[data-favorite-select="${member.id}"]`);
  assert.equal(h.copied(), ''); assert.equal(h.library.revision(), revision); assert.equal(h.library.selected({ includeAdult: true }).length, 0);
});
test('favorite reconciliation keeps the loaded prefix, untouched focus and active editor while refreshing counts', async t => {
  const base = makeBase(); base.tags.push(...Array.from({ length: 65 }, (_, index) => makeRecord({ id: 'entry:' + index, content: 'entry ' + index })));
  const document = emptyUserDocument(base); document.memberships = Array.from({ length: 65 }, (_, index) => ({ id: 'member:' + index, tagId: 'entry:' + index, groupId: 'daily', order: index, pinned: false }));
  const h = await boot(t, { base, document }); await h.window.App.route('favorites');
  assert.equal(h.window.document.querySelectorAll('[data-favorite-entry]').length, 60);
  const active = h.$('[data-favorite-copy="member:5"]'); active.focus();
  await h.library.execute({ type: 'saveTag', tagId: 'entry:64', patch: { note: 'outside prefix' } }, { operationId: 'outside-prefix' });
  assert.equal(h.window.document.activeElement, active); assert.equal(h.window.document.querySelectorAll('[data-favorite-entry]').length, 60);
  assert.equal(h.$('.favorite-section-count').textContent, '65');
  await h.click('[data-favorite-edit="member:5"]'); h.input('[data-tag-field="note"]', 'retained draft'); h.$('[data-tag-field="note"]').focus();
  const draftFocus = h.window.document.activeElement;
  await h.library.execute({ type: 'saveTag', tagId: 'entry:0', patch: { adult: true } }, { operationId: 'hide-first' });
  assert.equal(h.$('[data-favorite-entry="member:0"]'), null); assert.ok(h.$('[data-favorite-entry="member:60"]'));
  assert.equal(h.window.document.querySelectorAll('[data-favorite-entry]').length, 60); assert.equal(h.$('.favorite-section-count').textContent, '64');
  assert.equal(h.window.document.activeElement, draftFocus); assert.equal(h.$('[data-tag-field="note"]').value, 'retained draft');
});
