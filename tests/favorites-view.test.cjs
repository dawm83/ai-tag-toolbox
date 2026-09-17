'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createFavoritesView } = require('../src/views/favorites-view');
const { createStorage } = require('../src/modules/storage');
const { createFavorites } = require('../src/modules/favorites');

const settle = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

function makeDomain(extraCount = 0, { empty = false, legacyInvalid = false, adultEntry = false, snapshotMeta = {} } = {}) {
  let revision = 1;
  let entries = [
    { id: 'e1', kind: 'bundle', seriesId: 's1', sectionId: null, title: '柔光组合', rawText: 'soft lighting, backlighting', zh: '柔光', aliases: ['柔和光'], note: '人像测试', globalSearchable: true, pinned: true, nsfw: false, order: 0 },
    { id: 'e2', kind: 'tag', seriesId: 's1', sectionId: 'sec1', title: '', rawText: 'blue_hair', zh: '蓝发', aliases: [], note: '', globalSearchable: false, pinned: false, nsfw: false, order: 1 },
    { id: 'e3', kind: 'tag', seriesId: 's2', sectionId: null, title: '', rawText: 'green eyes', zh: '绿眼', aliases: [], note: '', globalSearchable: true, pinned: false, nsfw: false, order: 0 }
  ];
  entries.push(...Array.from({ length: extraCount }, (_, index) => ({ id: `large-${index}`, kind: 'tag', seriesId: 's1', sectionId: null, title: '', rawText: `large tag ${index}`, zh: '', aliases: [], note: '', globalSearchable: true, pinned: false, nsfw: false, order: index + 2 })));
  let series = [
    { id: 's1', name: '光照', color: '#287EA4', order: 0 },
    { id: 's2', name: '外貌', color: '#9B5D73', order: 1 }
  ];
  let sections = [{ id: 'sec1', seriesId: 's1', name: '发型', order: 0 }];
  if (legacyInvalid) entries[1] = { ...entries[1], rawText: '', legacyInvalid: true, legacySource: {} };
  if (adultEntry) {
    const index = extraCount ? 3 : 2;
    entries[index] = { ...entries[index], nsfw: true };
  }
  if (empty) { entries = []; series = []; sections = []; }
  let selected = [];
  const listeners = new Set();
  const calls = { saveEntry: [], saveSeries: [], deleteSeries: [], reorder: [], setSelected: [], markCopied: [], batch: [], previewPaste: [], importPaste: [], previewImport: [], importBundle: [], flush: 0 };
  const emit = (changedEntryIds = [], structureChanged = false) => {
    revision += 1;
    listeners.forEach(listener => listener({ revision, changedEntryIds, structureChanged }));
  };
  const ok = data => ({ ok: true, data, revision });
  const api = {
    calls,
    snapshot: () => ({ revision, document: { entries, series, sections }, ...snapshotMeta }),
    series: () => series.map(value => ({ ...value })),
    sections: seriesId => sections.filter(value => value.seriesId === seriesId).map(value => ({ ...value })),
    getEntry: id => entries.find(value => value.id === id) ? { ...entries.find(value => value.id === id) } : null,
    list: ({ seriesId, sectionId, includeAdult = true, offset = 0, limit = 80, view = 'shelf' } = {}) => {
      limit = Math.min(500, limit);
      let rows = view === 'recent' ? [...entries].reverse() : entries.filter(value => (!seriesId || value.seriesId === seriesId) && (sectionId === undefined || value.sectionId === sectionId));
      rows = rows.filter(value => includeAdult || !value.nsfw);
      return { items: rows.slice(offset, offset + limit).map(value => ({ ...value })), total: rows.length, hasMore: offset + limit < rows.length };
    },
    search: (query, { kind = 'all', seriesId, sectionId, scope = 'internal', offset = 0, limit = 80 } = {}) => {
      const needle = String(query).toLowerCase();
      limit = Math.min(500, limit);
      const rows = entries.filter(value => (kind === 'all' || value.kind === kind) && (!seriesId || value.seriesId === seriesId) && (sectionId === undefined || value.sectionId === sectionId) && (scope !== 'global' || value.globalSearchable)).flatMap(value => {
        const fields = ['title', 'rawText', 'zh', 'note'];
        const matches = fields.flatMap(field => {
          const index = String(value[field] || '').toLowerCase().indexOf(needle);
          return index < 0 ? [] : [{ field, start: index, end: index + needle.length }];
        });
        if (!matches.length) return [];
        const parent = series.find(row => row.id === value.seriesId);
        const section = sections.find(row => row.id === value.sectionId);
        return [{ ...value, entryId: value.id, seriesName: parent?.name || '', sectionName: section?.name || '', color: parent?.color, memberCount: value.kind === 'bundle' ? 2 : 1, matches }];
      });
      return { items: rows.slice(offset, offset + limit), total: rows.length, hasMore: offset + limit < rows.length, revision };
    },
    copyText: ids => ids.map(id => entries.find(value => value.id === id)?.rawText || '').filter(Boolean).join(', '),
    markCopied: ids => { calls.markCopied.push([...ids]); return ok({}); },
    setSelected: (id, value) => {
      calls.setSelected.push([id, value]);
      selected = value ? [...new Set([...selected, id])] : selected.filter(item => item !== id);
      return ok(api.selected({ includeAdult: true }));
    },
    selected: () => selected.map(id => ({ entryId: id, rawText: api.getEntry(id).rawText })),
    saveEntry: (patch, options) => {
      calls.saveEntry.push([{ ...patch }, options && { ...options }]);
      if (!String(patch.rawText ?? api.getEntry(patch.id)?.rawText ?? '').trim()) return { ok: false, error: { code: 'RAW_TEXT_REQUIRED', message: '原文不能为空' } };
      if (patch.id) entries = entries.map(value => value.id === patch.id ? { ...value, ...patch } : value);
      else entries.push({ id: `e${entries.length + 1}`, aliases: [], note: '', globalSearchable: true, pinned: false, nsfw: false, order: entries.length, ...patch });
      emit(patch.id ? [patch.id] : [entries.at(-1).id]);
      return ok(api.getEntry(patch.id || entries.at(-1).id));
    },
    saveSeries: patch => { calls.saveSeries.push({ ...patch }); const row = patch.id ? { ...series.find(value => value.id === patch.id), ...patch } : { id: `s${series.length + 1}`, color: '#447755', order: series.length, ...patch }; series = patch.id ? series.map(value => value.id === patch.id ? row : value) : [...series, row]; emit([], true); return ok(row); },
    saveSection: patch => { const row = patch.id ? { ...sections.find(value => value.id === patch.id), ...patch } : { id: `sec${sections.length + 1}`, order: sections.length, ...patch }; sections = patch.id ? sections.map(value => value.id === patch.id ? row : value) : [...sections, row]; emit([], true); return ok(row); },
    deleteEntries: ids => { entries = entries.filter(value => !ids.includes(value.id)); emit(ids, true); return ok({ removed: ids.length }); },
    duplicateEntries: ({ ids, seriesId, sectionId }) => { const made = ids.map(id => ({ ...api.getEntry(id), id: `copy-${id}`, seriesId: seriesId || api.getEntry(id).seriesId, sectionId: sectionId ?? api.getEntry(id).sectionId })); entries.push(...made); emit(made.map(value => value.id), true); return ok({ ids: made.map(value => value.id) }); },
    applyBatch: value => { calls.batch.push(value); entries = entries.map(row => value.ids.includes(row.id) ? { ...row, ...value.patch } : row); emit(value.ids); return ok({ updated: value.ids.length }); },
    reorder: input => {
      calls.reorder.push(structuredClone(input));
      if (input.kind === 'series') series = input.ids.map((id, order) => ({ ...series.find(row => row.id === id), order }));
      if (input.kind === 'section') { const moved = input.ids.map((id, order) => ({ ...sections.find(row => row.id === id), order })); sections = [...sections.filter(row => row.seriesId !== input.parentId), ...moved]; }
      emit([], true); return ok({});
    }, setSeriesColors: () => ok({}), deleteSection: () => ok({}), deleteSeries: (id, options) => {
      calls.deleteSeries.push([id, { ...options }]);
      if (options.mode === 'move') {
        let target = series.find(row => row.name === '未分类' && row.id !== id);
        if (!target) { target = { id: `s${series.length + 1}`, name: '未分类', color: '#447755', order: series.length }; series.push(target); }
        entries = entries.map(row => row.seriesId === id ? { ...row, seriesId: target.id, sectionId: null } : row);
      } else entries = entries.filter(row => row.seriesId !== id);
      sections = sections.filter(row => row.seriesId !== id); series = series.filter(row => row.id !== id); emit([], true); return ok({});
    },
    historyState: () => ({ canUndo: true, canRedo: true }), undo: () => ok({}), redo: () => ok({}),
    exportBundle: () => ({ format: 'ai-tag-favorites', version: 1, series, sections, entries }),
    previewImport: (value, options) => { calls.previewImport.push([value, { ...options }]); return ok({ mode: options.mode, incoming: { series: value.series?.length || 0, sections: value.sections?.length || 0, entries: value.entries?.length || 0 }, replaced: options.mode === 'replace' ? { series: series.length, sections: sections.length, entries: entries.length } : { series: 0, sections: 0, entries: 0 }, conflicts: {} }); },
    importBundle: (value, options) => { calls.importBundle.push([value, { ...options }]); return ok({ imported: 1 }); },
    previewPaste: (value, options) => { calls.previewPaste.push([value, { ...options }]); return ok({ entries: [{ rawText: value }], errors: [] }); },
    importPaste: (value, options) => { calls.importPaste.push([value, { ...options }]); return ok({ ids: ['pasted-1'] }); },
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    flush: async () => { calls.flush += 1; return true; }
  };
  return api;
}

function fixture(extraCount = 0, options = {}) {
  const dom = new JSDOM('<!doctype html><body><section id="favoritesView" hidden></section></body>', { pretendToBeVisual: true });
  dom.window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() { this.dataset.scrolled = 'true'; };
  const favorites = makeDomain(extraCount, options);
  const copied = [];
  const preferences = {
    value: {},
    get(key, fallback) { return key === 'favorites.view' ? { ...fallback, ...this.value } : fallback; },
    set(key, value) { if (key === 'favorites.view') this.value = { ...value }; return value; }
  };
  const selections = [];
  const notices = [];
  const view = createFavoritesView({
    document: dom.window.document,
    favorites,
    preferences,
    copy: async value => { copied.push(value); return true; },
    notify: value => notices.push(value),
    localize: options.localize || ((_key, fallback) => fallback),
    onSelectionChange: value => selections.push(value),
    getIncludeAdult: () => options.includeAdult !== false
  });
  view.bind();
  view.enter();
  return { dom, view, favorites, copied, preferences, selections, notices };
}

test('renders series and section columns while an explicit copy preserves raw text and selection', async t => {
  const app = fixture(); t.after(() => app.dom.window.close());
  app.view.bind();
  assert.equal(app.dom.window.document.querySelectorAll('[data-favorite-series]').length, 2);
  assert.equal(app.dom.window.document.querySelector('[data-favorite-section="sec1"] h4').textContent, '发型');
  app.dom.window.document.querySelector('[data-favorite-copy="e1"]').click();
  await settle();
  assert.deepEqual(app.copied, ['soft lighting, backlighting']);
  assert.deepEqual(app.favorites.calls.setSelected, []);
  assert.deepEqual(app.favorites.calls.markCopied, [['e1']]);
});

test('entry activation selects and copies, while the management checkbox stays independent', async t => {
  const app = fixture(); t.after(() => app.dom.window.close());
  app.dom.window.document.querySelector('[data-favorite-select="e2"]').click();
  await settle();
  assert.deepEqual(app.favorites.calls.setSelected, [['e2', true]]);
  assert.deepEqual(app.copied, ['blue_hair']);

  app.dom.window.document.querySelector('[data-favorite-manage="e1"]').click();
  assert.deepEqual(app.favorites.calls.setSelected, [['e2', true]]);
  assert.match(app.dom.window.document.querySelector('[data-favorite-bulk-count]').textContent, /1/);
});

test('clamps zoom, persists display preferences, and restores them on enter', t => {
  const app = fixture(); t.after(() => app.dom.window.close());
  assert.equal(app.view.setZoom(49), 75);
  assert.equal(app.dom.window.document.querySelector('#favoritesView').style.getPropertyValue('--favorite-zoom'), '0.75');
  assert.equal(app.view.setZoom(188), 150);
  assert.equal(app.preferences.value.zoom, 150);
  app.dom.window.document.querySelector('[data-favorite-column-width]').value = '360';
  app.dom.window.document.querySelector('[data-favorite-column-width]').dispatchEvent(new app.dom.window.Event('change', { bubbles: true }));
  app.view.enter();
  assert.equal(app.dom.window.document.querySelector('#favoritesView').style.getPropertyValue('--favorite-column-width'), '360px');
});

test('IME composition defers autosave and an empty raw draft never overwrites saved content', async t => {
  const app = fixture(); t.after(() => app.dom.window.close());
  await app.view.openEditor('e2');
  const raw = app.dom.window.document.querySelector('[data-favorite-field="rawText"]');
  raw.dispatchEvent(new app.dom.window.CompositionEvent('compositionstart', { bubbles: true }));
  raw.value = '蓝发输入中';
  raw.dispatchEvent(new app.dom.window.Event('input', { bubbles: true }));
  await settle(340);
  assert.equal(app.favorites.calls.saveEntry.length, 0);

  raw.dispatchEvent(new app.dom.window.CompositionEvent('compositionend', { bubbles: true }));
  await settle(340);
  assert.equal(app.favorites.calls.saveEntry.length, 1);
  assert.equal(app.favorites.getEntry('e2').rawText, '蓝发输入中');

  raw.value = '   ';
  raw.dispatchEvent(new app.dom.window.Event('input', { bubbles: true }));
  assert.equal(await app.view.flushEdits(), false);
  assert.equal(app.favorites.getEntry('e2').rawText, '蓝发输入中');
  assert.match(app.dom.window.document.querySelector('[data-favorite-save-status]').textContent, /不能为空/);
});

test('editor navigation flushes a valid draft and uses the opening result order', async t => {
  const app = fixture(); t.after(() => app.dom.window.close());
  await app.view.openEditor('e1');
  const note = app.dom.window.document.querySelector('[data-favorite-field="note"]');
  note.value = '更新备注';
  note.dispatchEvent(new app.dom.window.Event('input', { bubbles: true }));
  app.dom.window.document.querySelector('[data-favorite-editor-next]').click();
  await settle();
  assert.equal(app.favorites.getEntry('e1').note, '更新备注');
  assert.equal(app.dom.window.document.querySelector('[data-favorite-editor]').dataset.entryId, 'e2');
  assert.equal(app.favorites.calls.flush > 0, true);
});

test('search highlights matched text with DOM nodes and locate returns to the shelf entry', async t => {
  const app = fixture(); t.after(() => app.dom.window.close());
  const input = app.dom.window.document.querySelector('[data-favorite-search]');
  input.value = 'backlighting';
  input.dispatchEvent(new app.dom.window.Event('input', { bubbles: true }));
  await settle(130);
  const result = app.dom.window.document.querySelector('[data-favorite-search-result="e1"]');
  assert.equal(result.querySelector('mark').textContent, 'backlighting');
  result.querySelector('[data-favorite-locate="e1"]').click();
  const original = app.dom.window.document.querySelector('[data-favorite-entry="e1"]');
  assert.equal(original.dataset.scrolled, 'true');
  assert.equal(app.dom.window.document.querySelector('[data-favorite-search-results]').hidden, true);
});

test('a private note match shows the matching note without adding it to copied text', async t => {
  const app = fixture(); t.after(() => app.dom.window.close());
  const input = app.dom.window.document.querySelector('[data-favorite-search]');
  input.value = '人像'; input.dispatchEvent(new app.dom.window.Event('input', { bubbles: true }));
  await settle(130);
  const result = app.dom.window.document.querySelector('[data-favorite-search-result="e1"]');
  assert.equal(result.querySelector('[data-favorite-match-field="note"] mark').textContent, '人像');
  result.querySelector('[data-favorite-copy="e1"]').click(); await settle();
  assert.deepEqual(app.copied, ['soft lighting, backlighting']);
});

test('destroy removes delegated handlers and pending autosave work', async t => {
  const app = fixture(); t.after(() => app.dom.window.close());
  await app.view.openEditor('e3');
  const raw = app.dom.window.document.querySelector('[data-favorite-field="rawText"]');
  raw.value = 'discarded after destroy';
  raw.dispatchEvent(new app.dom.window.Event('input', { bubbles: true }));
  app.view.destroy();
  await settle(340);
  assert.equal(app.favorites.calls.saveEntry.length, 0);
  app.dom.window.document.querySelector('[data-favorite-copy="e1"]').click();
  await settle();
  assert.deepEqual(app.copied, []);
});

test('real Favorites domain renders canonical entries and flushes edits before leaving', async t => {
  const dom = new JSDOM('<!doctype html><body><section id="favoritesView" hidden></section></body>', { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const storage = createStorage();
  const favorites = createFavorites({ storage, tags: { get: () => null } });
  const series = favorites.saveSeries({ name: '镜头' }).data;
  const section = favorites.saveSection({ seriesId: series.id, name: '常用' }).data;
  const entry = favorites.saveEntry({ kind: 'bundle', seriesId: series.id, sectionId: section.id, title: '肖像光', rawText: 'soft lighting, backlighting' }).data;
  const copied = [];
  const view = createFavoritesView({
    document: dom.window.document, favorites, preferences: storage.namespace('favorites-view-real'),
    copy: async value => { copied.push(value); return true; }, localize: (_key, fallback) => fallback,
    getIncludeAdult: () => true
  });
  view.enter();
  assert.match(dom.window.document.querySelector(`[data-favorite-entry="${entry.id}"]`).textContent, /2 项/);
  await view.openEditor(entry.id);
  const note = dom.window.document.querySelector('[data-favorite-field="note"]');
  note.value = '保留真实原文'; note.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(await view.leave(), true);
  assert.equal(favorites.getEntry(entry.id).note, '保留真实原文');
  assert.equal(favorites.copyText([entry.id]), 'soft lighting, backlighting');
  assert.deepEqual(copied, []);
  view.destroy();
});

test('paste import previews and commits atomically into the chosen existing series', async t => {
  const app = fixture(); t.after(() => app.dom.window.close());
  app.dom.window.document.querySelector('[data-favorite-action="open-import"]').click();
  app.dom.window.document.querySelector('[data-favorite-import-format]').value = 'tsv';
  app.dom.window.document.querySelector('[data-favorite-import-kind]').value = 'bundle';
  app.dom.window.document.querySelector('[data-favorite-import-series]').value = 's1';
  const source = app.dom.window.document.querySelector('[data-favorite-import-text]');
  source.value = 'soft lighting, backlighting\t柔光';
  app.dom.window.document.querySelector('[data-favorite-action="preview-import"]').click();
  await settle();
  assert.deepEqual(app.favorites.calls.previewPaste, [['soft lighting, backlighting\t柔光', { format: 'tsv', kind: 'bundle', seriesId: 's1', sectionId: null }]]);
  app.dom.window.document.querySelector('[data-favorite-action="confirm-import"]').click();
  await settle();
  assert.deepEqual(app.favorites.calls.importPaste, [['soft lighting, backlighting\t柔光', { format: 'tsv', kind: 'bundle', seriesId: 's1', sectionId: null }]]);
});

test('column load-more reaches entries beyond the domain 500-row page cap', t => {
  const app = fixture(620); t.after(() => app.dom.window.close());
  const root = app.dom.window.document.querySelector('[data-favorite-series="s1"] [data-favorite-section="root"]');
  assert.equal(app.dom.window.document.querySelectorAll('[data-favorite-series="s1"] [data-favorite-entry]').length, 60);
  for (let index = 0; index < 8; index += 1) {
    const more = app.dom.window.document.querySelector('[data-favorite-series="s1"] [data-favorite-action="load-column"]');
    if (!more) break;
    more.click();
  }
  const loaded = app.dom.window.document.querySelector('[data-favorite-series="s1"] [data-favorite-section="root"]');
  assert.equal(loaded.querySelectorAll('[data-favorite-entry]').length, 621);
  assert.equal(loaded.querySelector('[data-favorite-entry="large-619"]') != null, true);
});

test('rapid editor and create switches flush the previous draft and invalid drafts block switching', async t => {
  const app = fixture(); t.after(() => app.dom.window.close());
  await app.view.openEditor('e1');
  const note = app.dom.window.document.querySelector('[data-favorite-field="note"]');
  note.value = '切换前保存'; note.dispatchEvent(new app.dom.window.Event('input', { bubbles: true }));
  assert.equal(await app.view.openCreate({ kind: 'tag', seriesId: 's1' }) != null, true);
  assert.equal(app.favorites.getEntry('e1').note, '切换前保存');

  const raw = app.dom.window.document.querySelector('[data-favorite-field="rawText"]');
  raw.value = ''; raw.dispatchEvent(new app.dom.window.Event('input', { bubbles: true }));
  assert.equal(await app.view.openEditor('e2'), false);
  assert.equal(app.dom.window.document.querySelector('[data-favorite-editor]').dataset.entryId, '');
  assert.match(app.dom.window.document.querySelector('[data-favorite-save-status]').textContent, /不能为空/);
});

test('an old asynchronous flush cannot mark a newer draft saved', async t => {
  const app = fixture(); t.after(() => app.dom.window.close());
  const pending = [];
  app.favorites.flush = () => new Promise(resolve => pending.push(resolve));
  await app.view.openEditor('e1');
  const note = app.dom.window.document.querySelector('[data-favorite-field="note"]');
  note.value = '第一版'; note.dispatchEvent(new app.dom.window.Event('input', { bubbles: true }));
  const saving = app.view.flushEdits(); await settle();
  note.value = '第二版'; note.dispatchEvent(new app.dom.window.Event('input', { bubbles: true }));
  pending.shift()(true); await settle();
  assert.notEqual(app.dom.window.document.querySelector('[data-favorite-save-status]').textContent, '已保存');
  assert.equal(app.favorites.calls.saveEntry.at(-1)[0].note, '第二版');
  pending.shift()(true); assert.equal(await saving, true);
  assert.equal(app.dom.window.document.querySelector('[data-favorite-save-status]').textContent, '已保存');
});

test('default series deletion moves entries to an explicit uncategorized series', async t => {
  const app = fixture(); t.after(() => app.dom.window.close()); app.dom.window.confirm = () => true;
  app.dom.window.document.querySelector('[data-favorite-action="delete-series"][data-series-id="s1"]').click();
  await settle();
  assert.deepEqual(app.favorites.calls.saveSeries, []);
  assert.deepEqual(app.favorites.calls.deleteSeries.at(-1), ['s1', { mode: 'move' }]);
  assert.equal(app.favorites.series().some(row => row.name === '未分类'), true);
});

test('series chrome avoids global header styles and labeled icon controls have stable dimensions', t => {
  const app = fixture(); t.after(() => app.dom.window.close());
  assert.equal(app.dom.window.document.querySelector('.favorite-series-head').tagName, 'DIV');
  assert.equal(app.dom.window.document.querySelector('[data-favorite-action="new-tag"]').classList.contains('has-label'), true);
  assert.equal(app.dom.window.document.querySelector('[data-favorite-zoom]').step, '10');
});

test('empty shelf creates a series through the local dialog and then creates an entry', async t => {
  const app = fixture(0, { empty: true }); t.after(() => app.dom.window.close());
  assert.equal(app.dom.window.document.querySelector('[data-favorite-series]'), null);
  app.dom.window.document.querySelector('[data-favorite-action="new-series"]').click();
  const dialog = app.dom.window.document.querySelector('[data-favorite-dialog]');
  const name = app.dom.window.document.querySelector('[data-favorite-dialog-input]');
  assert.equal(dialog.hidden, false);
  name.value = '构图';
  name.dispatchEvent(new app.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.equal(dialog.hidden, true);
  assert.equal(app.dom.window.document.querySelector('[data-favorite-series] h3').textContent, '构图');
  assert.equal(app.dom.window.document.activeElement.dataset.favoriteAction, 'new-series');

  app.dom.window.document.querySelector('[data-favorite-action="new-tag"]').click(); await settle();
  const raw = app.dom.window.document.querySelector('[data-favorite-field="rawText"]');
  raw.value = 'dynamic pose'; raw.dispatchEvent(new app.dom.window.Event('input', { bubbles: true }));
  app.dom.window.document.querySelector('[data-favorite-action="editor-save"]').click(); await settle();
  assert.equal(app.favorites.getEntry('e1').rawText, 'dynamic pose');
});

test('empty-query filters apply to the shelf and autosave keeps the current columns mounted', async t => {
  const app = fixture(); t.after(() => app.dom.window.close());
  const kind = app.dom.window.document.querySelector('[data-favorite-kind]');
  kind.value = 'tag'; kind.dispatchEvent(new app.dom.window.Event('change', { bubbles: true }));
  assert.equal(app.dom.window.document.querySelector('[data-favorite-entry="e1"]'), null);
  assert.equal(app.dom.window.document.querySelectorAll('[data-favorite-entry]').length, 2);
  const scope = app.dom.window.document.querySelector('[data-favorite-scope]');
  scope.value = 'global'; scope.dispatchEvent(new app.dom.window.Event('change', { bubbles: true }));
  assert.deepEqual([...app.dom.window.document.querySelectorAll('[data-favorite-entry]')].map(node => node.dataset.favoriteEntry), ['e3']);

  await app.view.openEditor('e3');
  const column = app.dom.window.document.querySelector('[data-favorite-series="s2"]');
  const note = app.dom.window.document.querySelector('[data-favorite-field="note"]');
  note.value = '保持列节点'; note.dispatchEvent(new app.dom.window.Event('input', { bubbles: true }));
  await settle(340);
  assert.equal(app.dom.window.document.querySelector('[data-favorite-series="s2"]'), column);
});

test('search paging crosses the domain 500-row cap and loads every matching result', async t => {
  const app = fixture(621); t.after(() => app.dom.window.close());
  const search = app.dom.window.document.querySelector('[data-favorite-search]');
  search.value = 'large tag'; search.dispatchEvent(new app.dom.window.Event('input', { bubbles: true })); await settle(130);
  for (let index = 0; index < 10; index += 1) {
    const more = app.dom.window.document.querySelector('[data-favorite-action="load-search"]'); if (!more) break; more.click();
  }
  assert.equal(app.dom.window.document.querySelectorAll('[data-favorite-search-result]').length, 621);
  assert.equal(app.dom.window.document.querySelector('[data-favorite-action="load-search"]'), null);
});

test('JSON file replace import saves drafts, previews counts, confirms, and downloads a backup first', async t => {
  const app = fixture(); t.after(() => app.dom.window.close());
  const downloads = []; app.dom.window.URL.createObjectURL = blob => { downloads.push(blob); return 'blob:backup'; }; app.dom.window.URL.revokeObjectURL = () => {};
  app.dom.window.HTMLAnchorElement.prototype.click = () => {};
  app.dom.window.confirm = () => true;
  await app.view.openEditor('e1');
  const note = app.dom.window.document.querySelector('[data-favorite-field="note"]'); note.value = '导入前保存'; note.dispatchEvent(new app.dom.window.Event('input', { bubbles: true }));
  app.dom.window.document.querySelector('[data-favorite-action="open-import"]').click(); await settle();
  assert.equal(app.favorites.getEntry('e1').note, '导入前保存');

  const bundle = { format: 'ai-tag-favorites', version: 1, revision: 0, series: [{ id: 'new-series', name: '导入', order: 0 }], sections: [], entries: [] };
  const fileInput = app.dom.window.document.querySelector('[data-favorite-import-file]');
  Object.defineProperty(fileInput, 'files', { configurable: true, value: [new app.dom.window.File([JSON.stringify(bundle)], 'favorites.json', { type: 'application/json' })] });
  fileInput.dispatchEvent(new app.dom.window.Event('change', { bubbles: true })); await settle();
  assert.equal(app.dom.window.document.querySelector('[data-favorite-import-format]').value, 'json');
  app.dom.window.document.querySelector('[data-favorite-import-mode]').value = 'replace';
  app.dom.window.document.querySelector('[data-favorite-action="preview-import"]').click(); await settle();
  assert.match(app.dom.window.document.querySelector('[data-favorite-import-preview]').textContent, /现有.*2\/1\/3.*导入后.*1\/0\/0/);
  app.dom.window.document.querySelector('[data-favorite-action="confirm-import"]').click(); await settle();
  assert.equal(downloads.length, 1);
  assert.deepEqual(app.favorites.calls.importBundle.at(-1), [bundle, { mode: 'replace' }]);
});

test('entry subscription updates only changed rows while preserving the editor and unrelated DOM', async t => {
  const app = fixture(); t.after(() => app.dom.window.close());
  await app.view.openEditor('e1');
  const editorRaw = app.dom.window.document.querySelector('[data-favorite-field="rawText"]'); const unrelated = app.dom.window.document.querySelector('[data-favorite-entry="e3"]'); const changed = app.dom.window.document.querySelector('[data-favorite-entry="e2"]');
  editorRaw.value = '正在编辑'; editorRaw.dispatchEvent(new app.dom.window.Event('input', { bubbles: true }));
  app.favorites.saveEntry({ id: 'e2', title: '外部更新' });
  assert.equal(app.dom.window.document.querySelector('[data-favorite-field="rawText"]'), editorRaw);
  assert.equal(editorRaw.value, '正在编辑');
  assert.equal(app.dom.window.document.querySelector('[data-favorite-entry="e3"]'), unrelated);
  assert.notEqual(app.dom.window.document.querySelector('[data-favorite-entry="e2"]'), changed);
  assert.match(app.dom.window.document.querySelector('[data-favorite-entry="e2"]').textContent, /外部更新|blue_hair/);
});

test('bundles lead with a name and expose raw text as secondary preview', t => {
  const app = fixture(); t.after(() => app.dom.window.close());
  const entry = app.dom.window.document.querySelector('[data-favorite-entry="e1"]');
  assert.match(entry.querySelector('.favorite-entry-title').textContent, /柔光组合/);
  assert.equal(entry.querySelector('.favorite-entry-secondary').textContent, 'soft lighting, backlighting');
});

test('load and migration diagnostics are visible and invalid legacy rows can only be edited', async t => {
  const app = fixture(0, { legacyInvalid: true, snapshotMeta: { loadError: { message: 'broken shelf' }, migrationReport: { migrated: 2, unresolved: ['old'], invalid: [{}] } } }); t.after(() => app.dom.window.close());
  assert.match(app.dom.window.document.querySelector('[data-favorite-health]').textContent, /broken shelf.*2.*1.*1/);
  const invalid = app.dom.window.document.querySelector('[data-favorite-entry="e2"]');
  assert.equal(invalid.querySelector('[data-favorite-select]').disabled, true);
  assert.equal(invalid.querySelector('[data-favorite-copy]').disabled, true);
  invalid.querySelector('[data-favorite-edit]').click(); await settle();
  assert.equal(app.dom.window.document.querySelector('[data-favorite-editor]').dataset.entryId, 'e2');
});

test('adult filtering reports hidden entries and reorder still submits complete sibling ids', t => {
  const app = fixture(1, { adultEntry: true, includeAdult: false }); t.after(() => app.dom.window.close());
  assert.match(app.dom.window.document.querySelector('[data-favorite-series="s1"] .favorite-adult-hidden').textContent, /1/);
  app.dom.window.document.querySelector('[data-favorite-action="move-down"][data-entry-id="e1"]').click();
  assert.deepEqual(app.favorites.calls.reorder.at(-1)?.ids, ['large-0', 'e1']);
});

test('series and sections reorder, collapse persists, section filtering works, and compact mode is remembered', async t => {
  const app = fixture(); t.after(() => app.dom.window.close());
  app.dom.window.document.querySelector('[data-favorite-action="move-series-down"][data-series-id="s1"]').click();
  assert.deepEqual(app.favorites.calls.reorder.at(-1), { kind: 'series', parentId: null, ids: ['s2', 's1'] });
  const toggle = app.dom.window.document.querySelector('[data-favorite-action="toggle-section"][data-section-id="sec1"]'); toggle.click();
  assert.deepEqual(app.preferences.value.collapsedSections, ['sec1']);
  const section = app.dom.window.document.querySelector('[data-favorite-section-filter]'); section.value = 'sec1'; section.dispatchEvent(new app.dom.window.Event('change', { bubbles: true }));
  assert.deepEqual([...app.dom.window.document.querySelectorAll('[data-favorite-entry]')].map(node => node.dataset.favoriteEntry), ['e2']);
  const compact = app.dom.window.document.querySelector('[data-favorite-compact]'); compact.checked = true; compact.dispatchEvent(new app.dom.window.Event('change', { bubbles: true }));
  assert.equal(app.preferences.value.compact, true); assert.equal(app.dom.window.document.querySelector('#favoritesView').classList.contains('is-compact'), true);
});

test('expanded short fields save inline while editor close saves and explicit discard does not', async t => {
  const app = fixture(); t.after(() => app.dom.window.close());
  app.dom.window.document.querySelector('[data-favorite-expand="e1"]').click();
  const title = app.dom.window.document.querySelector('[data-favorite-inline-field="title"][data-entry-id="e1"]'); title.value = '就地名称'; title.dispatchEvent(new app.dom.window.Event('change', { bubbles: true })); await settle();
  assert.equal(app.favorites.getEntry('e1').title, '就地名称');
  await app.view.openCreate({ kind: 'bundle', seriesId: 's1' });
  const bundleTitle = app.dom.window.document.querySelector('[data-favorite-field="title"]'); bundleTitle.value = '新组合'; bundleTitle.dispatchEvent(new app.dom.window.Event('input', { bubbles: true }));
  const raw = app.dom.window.document.querySelector('[data-favorite-field="rawText"]'); raw.value = 'one, two'; raw.dispatchEvent(new app.dom.window.Event('input', { bubbles: true }));
  app.dom.window.document.querySelector('[data-favorite-action="editor-close"]').click(); await settle();
  assert.equal(app.favorites.calls.saveEntry.some(([row]) => row.rawText === 'one, two'), true);
  await app.view.openCreate({ kind: 'tag', seriesId: 's1' });
  const discarded = app.dom.window.document.querySelector('[data-favorite-field="rawText"]'); discarded.value = 'discard me'; discarded.dispatchEvent(new app.dom.window.Event('input', { bubbles: true }));
  app.dom.window.document.querySelector('[data-favorite-action="editor-discard"]').click();
  assert.equal(app.favorites.calls.saveEntry.some(([row]) => row.rawText === 'discard me'), false);
});

test('locale refresh rebuilds labels without losing the active draft', async t => {
  let prefix = '甲'; const app = fixture(0, { localize: (_key, fallback) => `${prefix}${fallback}` }); t.after(() => app.dom.window.close());
  await app.view.openEditor('e1'); const note = app.dom.window.document.querySelector('[data-favorite-field="note"]'); note.value = '保留草稿'; note.dispatchEvent(new app.dom.window.Event('input', { bubbles: true }));
  prefix = '乙'; app.view.refreshLocale();
  assert.equal(app.dom.window.document.querySelector('[data-favorite-field="note"]').value, '保留草稿');
  assert.match(app.dom.window.document.querySelector('[data-favorite-action="new-tag"]').textContent, /乙/);
});

test('locale refresh preserves an open name dialog and uncommitted import controls', async t => {
  let prefix = '甲'; const app = fixture(0, { localize: (_key, fallback) => `${prefix}${fallback}` }); t.after(() => app.dom.window.close());
  app.dom.window.document.querySelector('[data-favorite-action="new-series"]').click();
  const name = app.dom.window.document.querySelector('[data-favorite-dialog-input]'); name.value = 'Draft series'; name.focus(); prefix = '乙'; app.view.refreshLocale();
  assert.equal(app.dom.window.document.querySelector('[data-favorite-dialog]').hidden, false);
  assert.equal(app.dom.window.document.querySelector('[data-favorite-dialog-input]').value, 'Draft series');
  assert.match(app.dom.window.document.querySelector('[data-favorite-dialog] h3').textContent, /^乙/);
  assert.equal(app.dom.window.document.activeElement, app.dom.window.document.querySelector('[data-favorite-dialog-input]'));
  app.dom.window.document.querySelector('[data-favorite-action="dialog-cancel"]').click();

  app.dom.window.document.querySelector('[data-favorite-action="open-import"]').click(); await settle();
  app.dom.window.document.querySelector('[data-favorite-import-format]').value = 'json'; app.dom.window.document.querySelector('[data-favorite-import-format]').dispatchEvent(new app.dom.window.Event('change', { bubbles: true }));
  app.dom.window.document.querySelector('[data-favorite-import-mode]').value = 'replace'; app.dom.window.document.querySelector('[data-favorite-import-text]').value = '{"draft":true}';
  app.dom.window.document.querySelector('[data-favorite-import-preview]').textContent = '尚未提交'; prefix = '丙'; app.view.refreshLocale();
  assert.equal(app.dom.window.document.querySelector('[data-favorite-transfer]').hidden, false);
  assert.equal(app.dom.window.document.querySelector('[data-favorite-import-format]').value, 'json');
  assert.equal(app.dom.window.document.querySelector('[data-favorite-import-mode]').value, 'replace');
  assert.equal(app.dom.window.document.querySelector('[data-favorite-import-text]').value, '{"draft":true}');
  assert.equal(app.dom.window.document.querySelector('[data-favorite-import-preview]').textContent, '尚未提交');
});

test('selection synchronization updates shelf and search without rebuilding either result', async t => {
  const app = fixture(); t.after(() => app.dom.window.close());
  const shelf = app.dom.window.document.querySelector('[data-favorite-entry="e1"]');
  app.favorites.setSelected('e1', true); app.view.syncSelection();
  assert.equal(shelf.classList.contains('is-selected'), true); assert.equal(shelf.querySelector('[data-favorite-select]').getAttribute('aria-pressed'), 'true');
  const search = app.dom.window.document.querySelector('[data-favorite-search]'); search.value = 'backlighting'; search.dispatchEvent(new app.dom.window.Event('input', { bubbles: true })); await settle(130);
  const result = app.dom.window.document.querySelector('[data-favorite-search-result="e1"]'); app.favorites.setSelected('e1', false); app.view.syncSelection();
  assert.equal(app.dom.window.document.querySelector('[data-favorite-search-result="e1"]'), result);
  assert.equal(result.classList.contains('is-selected'), false); assert.equal(result.querySelector('[data-favorite-select]').getAttribute('aria-pressed'), 'false');
});

test('clearing and locating search results restores shelf scroll, focus, and collapsed sections', async t => {
  const app = fixture(); t.after(() => app.dom.window.close());
  app.dom.window.document.querySelector('[data-favorite-action="toggle-section"][data-section-id="sec1"]').click();
  const scroll = app.dom.window.document.querySelector('[data-favorite-scroll]'); scroll.scrollTop = 42; scroll.scrollLeft = 17;
  app.dom.window.document.querySelector('[data-favorite-entry="e2"] [data-favorite-select]').focus();
  const search = app.dom.window.document.querySelector('[data-favorite-search]'); search.focus(); search.value = 'blue_hair'; search.dispatchEvent(new app.dom.window.Event('input', { bubbles: true })); await settle(130);
  app.dom.window.document.querySelector('[data-favorite-locate="e2"]').click();
  assert.equal(app.preferences.value.collapsedSections.includes('sec1'), false);
  app.dom.window.document.querySelector('[data-favorite-action="return-search"]').click();
  app.dom.window.document.querySelector('[data-favorite-action="clear-search"]').click();
  assert.equal(app.preferences.value.collapsedSections.includes('sec1'), true);
  assert.equal(scroll.scrollTop, 42); assert.equal(scroll.scrollLeft, 17);
  assert.equal(app.dom.window.document.activeElement.dataset.favoriteSelect, 'e2');
});

test('series locator filters anchors and invalid drafts block opening import', async t => {
  const app = fixture(); t.after(() => app.dom.window.close());
  const locator = app.dom.window.document.querySelector('[data-favorite-anchor-search]'); locator.value = '外貌'; locator.dispatchEvent(new app.dom.window.Event('input', { bubbles: true }));
  const anchors = [...app.dom.window.document.querySelectorAll('[data-favorite-action="anchor-series"]')];
  assert.deepEqual(anchors.filter(node => !node.hidden).map(node => node.textContent), ['外貌']);
  await app.view.openCreate({ kind: 'tag', seriesId: 's1' });
  const raw = app.dom.window.document.querySelector('[data-favorite-field="rawText"]'); raw.value = ' '; raw.dispatchEvent(new app.dom.window.Event('input', { bubbles: true }));
  app.dom.window.document.querySelector('[data-favorite-action="open-import"]').click(); await settle();
  assert.equal(app.dom.window.document.querySelector('[data-favorite-transfer]').hidden, true);
  assert.match(app.dom.window.document.querySelector('[data-favorite-save-status]').textContent, /不能为空/);
});

test('prefilled create saves without another input event and undo finishes the current editor first', async t => {
  const app = fixture(); t.after(() => app.dom.window.close());
  await app.view.openCreate({ kind: 'bundle', seriesId: 's1', rawText: 'prefilled, bundle' });
  app.dom.window.document.querySelector('[data-favorite-action="editor-save"]').click(); await settle();
  assert.equal(app.favorites.calls.saveEntry.at(-1)[0].rawText, 'prefilled, bundle');
  assert.equal(app.favorites.calls.saveEntry.at(-1)[0].title, '收藏组合');

  const note = app.dom.window.document.querySelector('[data-favorite-field="note"]'); note.value = '撤销前提交'; note.dispatchEvent(new app.dom.window.Event('input', { bubbles: true }));
  app.dom.window.document.querySelector('[data-favorite-action="undo"]').click(); await settle();
  assert.equal(app.favorites.calls.saveEntry.at(-1)[0].note, '撤销前提交');
  assert.equal(app.dom.window.document.querySelector('[data-favorite-editor]').hidden, true);
});

test('discoverable-only shelf search still matches private notes but excludes private entries', async t => {
  const app = fixture(); t.after(() => app.dom.window.close());
  const scope = app.dom.window.document.querySelector('[data-favorite-scope]'); scope.value = 'global'; scope.dispatchEvent(new app.dom.window.Event('change', { bubbles: true }));
  const search = app.dom.window.document.querySelector('[data-favorite-search]'); search.value = '人像'; search.dispatchEvent(new app.dom.window.Event('input', { bubbles: true })); await settle(130);
  assert.equal(app.dom.window.document.querySelector('[data-favorite-search-result="e1"]') != null, true);
  search.value = 'blue_hair'; search.dispatchEvent(new app.dom.window.Event('input', { bubbles: true })); await settle(130);
  assert.equal(app.dom.window.document.querySelector('[data-favorite-search-result="e2"]'), null);
});
