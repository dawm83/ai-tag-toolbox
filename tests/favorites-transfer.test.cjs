'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createStorage } = require('../src/modules/storage');
const { createFavorites } = require('../src/modules/favorites');
const { parseFavoritePaste, validateFavoriteBundle } = require('../src/modules/favorites-transfer');

test('TSV paste keeps comma groups intact and accepts quoted newlines', () => {
  const result = parseFavoritePaste('"soft lighting, backlighting"\t"柔光\n说明"', {
    format: 'tsv', kind: 'bundle', seriesId: 's1', sectionId: null
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.entries.length, 1);
  assert.equal(result.data.entries[0].rawText, 'soft lighting, backlighting');
  assert.equal(result.data.entries[0].zh, '柔光\n说明');
});

test('paste parsing reports row errors and never silently drops extra TSV columns', () => {
  const lines = parseFavoritePaste('first\n\nthird', { format: 'lines', kind: 'tag', seriesId: 's1', sectionId: null });
  assert.deepEqual(lines.data.entries.map(row => row.rawText), ['first', 'third']);
  const bad = parseFavoritePaste('x\ty\textra', { format: 'tsv', kind: 'tag', seriesId: 's1', sectionId: null });
  assert.equal(bad.ok, false);
  assert.equal(bad.data.errors[0].row, 1);
  assert.equal(bad.data.errors[0].code, 'TOO_MANY_COLUMNS');
  const afterBlank = parseFavoritePaste('ok\t说明\n\nbad\t说明\textra', { format: 'tsv', kind: 'tag', seriesId: 's1', sectionId: null });
  assert.equal(afterBlank.data.errors[0].row, 3);
  const afterCrLfBlank = parseFavoritePaste('ok\tx\r\n\r\nbad\tx\textra', { format: 'tsv', kind: 'tag' });
  assert.equal(afterCrLfBlank.data.errors[0].row, 3);
  const leadingCrLfBlanks = parseFavoritePaste('\r\n\r\nbad\tx\textra', { format: 'tsv', kind: 'tag' });
  assert.equal(leadingCrLfBlanks.data.errors[0].row, 3);
  const quotedCrLf = parseFavoritePaste('"a\r\nb"\tx\r\nbad\tx\textra', { format: 'tsv', kind: 'tag' });
  assert.equal(quotedCrLf.data.errors[0].row, 3);
  const emptyFirstField = parseFavoritePaste('\t\n', { format: 'tsv', kind: 'tag' });
  assert.equal(emptyFirstField.data.errors[0].row, 1);
});

test('paste preview validates the existing target and import commits all rows as one undo unit', () => {
  const favorites = createFavorites({ storage: createStorage() });
  const series = favorites.saveSeries({ name: 'Paste' }).data;
  const section = favorites.saveSection({ seriesId: series.id, name: 'Rows' }).data;
  const before = favorites.snapshot().revision;
  let events = 0;
  favorites.subscribe(() => { events += 1; });
  const options = { format: 'lines', kind: 'tag', seriesId: series.id, sectionId: section.id };
  assert.equal(favorites.previewPaste('one\ntwo', options).data.entries.length, 2);
  assert.equal(favorites.previewPaste('one', { ...options, sectionId: 'missing' }).error.code, 'SECTION_NOT_FOUND');
  const imported = favorites.importPaste('one\ntwo', options);
  assert.equal(imported.ok, true);
  assert.equal(imported.data.ids.length, 2);
  assert.equal(favorites.snapshot().revision, before + 1);
  assert.equal(events, 1);
  assert.equal(favorites.list({ seriesId: series.id, sectionId: section.id }).total, 2);
  favorites.undo();
  assert.equal(favorites.list({ seriesId: series.id, sectionId: section.id }).total, 0);
});

test('paste row errors are atomic and leave shelf revision unchanged', () => {
  const favorites = createFavorites({ storage: createStorage() });
  const series = favorites.saveSeries({ name: 'Paste' }).data;
  const before = favorites.snapshot().revision;
  const result = favorites.importPaste('valid\t说明\textra', { format: 'tsv', kind: 'tag', seriesId: series.id, sectionId: null });
  assert.equal(result.ok, false);
  assert.equal(favorites.snapshot().revision, before);
  assert.equal(favorites.list({ seriesId: series.id }).total, 0);
});

test('bundle validation rejects newer versions, duplicate IDs and dangling parents', () => {
  const base = { format: 'ai-tag-favorites', version: 1, revision: 1, series: [], sections: [], entries: [] };
  assert.equal(validateFavoriteBundle({ ...base, version: 2 }).error.code, 'UNSUPPORTED_VERSION');
  const duplicate = { ...base, series: [
    { id: 's', name: 'A', order: 0, colorMode: 'auto', color: '#112233' },
    { id: 's', name: 'B', order: 1, colorMode: 'auto', color: '#223344' }
  ] };
  assert.equal(validateFavoriteBundle(duplicate).error.code, 'DUPLICATE_ID');
  const dangling = { ...base, entries: [{
    id: 'e', kind: 'tag', seriesId: 'missing', sectionId: null, title: '', rawText: 'x', zh: '', aliases: [], note: '',
    globalSearchable: true, pinned: false, nsfw: false, order: 0, sourceTagId: null, createdAt: 0, updatedAt: 0
  }] };
  assert.equal(validateFavoriteBundle(dangling).error.code, 'SERIES_NOT_FOUND');
});

test('bundle validation normalizes an empty section ID to the series root', () => {
  const bundle = {
    format: 'ai-tag-favorites', version: 1, revision: 1,
    series: [{ id: 's', name: 'Root', order: 0, colorMode: 'auto', color: '#112233' }], sections: [],
    entries: [{ id: 'e', kind: 'tag', seriesId: 's', sectionId: '', title: '', rawText: 'root', zh: '', aliases: [], note: '', globalSearchable: true, pinned: false, nsfw: false, order: 0, sourceTagId: null, createdAt: 0, updatedAt: 0 }]
  };
  assert.equal(validateFavoriteBundle(bundle).data.entries[0].sectionId, null);
});

test('export and replace import round-trip all editable shelf fields without selections', () => {
  const source = createFavorites({ storage: createStorage() });
  const series = source.saveSeries({ name: 'Light' }).data;
  source.setSeriesColors([series.id], { mode: 'custom', color: '#123ABC' });
  const section = source.saveSection({ seriesId: series.id, name: 'Portrait' }).data;
  const entry = source.saveEntry({
    kind: 'bundle', seriesId: series.id, sectionId: section.id, title: 'Soft', rawText: ' soft, (light:1.2) ',
    zh: '柔光', aliases: ['soft'], note: 'note', globalSearchable: false, pinned: true, nsfw: true
  }).data;
  source.setSelected(entry.id, true);
  const bundle = source.exportBundle();

  const target = createFavorites({ storage: createStorage() });
  target.saveSeries({ name: 'Old' });
  const preview = target.previewImport(bundle, { mode: 'replace' });
  assert.equal(preview.ok, true);
  assert.equal(preview.data.incoming.entries, 1);
  assert.equal(preview.data.replaced.series, 1);
  assert.equal(target.importBundle(bundle, { mode: 'replace' }).ok, true);
  const restored = target.exportBundle();
  assert.deepEqual({ ...restored, revision: bundle.revision }, bundle);
  assert.equal(target.selected({ includeAdult: true }).length, 0);
  assert.equal(target.undo().ok, true);
  assert.equal(target.series()[0].name, 'Old');
});

test('append import remaps conflicting IDs and preserves references atomically', () => {
  const existing = createFavorites({ storage: createStorage() });
  const localSeries = existing.saveSeries({ name: 'Local' }).data;
  const bundle = {
    format: 'ai-tag-favorites', version: 1, revision: 9,
    series: [{ ...localSeries, name: 'Imported' }],
    sections: [{ id: 'section-1', seriesId: localSeries.id, name: 'Imported section', order: 0 }],
    entries: [{
      id: 'entry-1', kind: 'tag', seriesId: localSeries.id, sectionId: 'section-1', title: '', rawText: 'exact raw', zh: '', aliases: [], note: '',
      globalSearchable: true, pinned: false, nsfw: false, order: 0, sourceTagId: null, createdAt: 1, updatedAt: 1
    }]
  };
  const preview = existing.previewImport(bundle, { mode: 'append' });
  assert.equal(preview.data.conflicts.series, 1);
  const result = existing.importBundle(bundle, { mode: 'append' });
  assert.equal(result.ok, true);
  const imported = existing.list({ includeAdult: true, limit: 80 }).items[0];
  assert.notEqual(imported.seriesId, localSeries.id);
  assert.equal(existing.sections(imported.seriesId)[0].id, imported.sectionId);
});

test('invalid imports leave state and revision unchanged', () => {
  const favorites = createFavorites({ storage: createStorage() });
  const series = favorites.saveSeries({ name: 'Keep' }).data;
  favorites.saveEntry({ kind: 'tag', seriesId: series.id, rawText: 'keep me' });
  const before = favorites.snapshot();
  const invalid = { ...favorites.exportBundle(), entries: [{ ...favorites.exportBundle().entries[0], rawText: '' }] };
  assert.equal(favorites.previewImport(invalid, { mode: 'append' }).ok, false);
  assert.equal(favorites.importBundle(invalid, { mode: 'replace' }).ok, false);
  assert.deepEqual(favorites.snapshot().document, before.document);
  assert.equal(favorites.snapshot().revision, before.revision);
});
