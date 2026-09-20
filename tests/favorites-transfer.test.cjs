'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFavoritePaste, validateFavoriteBundle } = require('../src/modules/favorites-transfer');
const { createUnifiedFixture, addFavoriteLocation } = require('./fixtures/unified-modules.cjs');

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

test('paste preview validates the existing target and import commits all rows as one undo unit', async () => {
  const { favorites } = await createUnifiedFixture();
  const { seriesId, sectionId } = await addFavoriteLocation(favorites, 'Paste', 'Rows');
  const before = favorites.snapshot().revision;
  let events = 0; favorites.subscribe(() => { events += 1; });
  const options = { format: 'lines', kind: 'tag', seriesId, sectionId };
  const preview = favorites.previewPaste('one\ntwo', options);
  assert.equal(preview.ok, true, JSON.stringify(preview.error));
  assert.equal(favorites.list().total, 0);
  assert.equal(favorites.previewPaste('one', { ...options, sectionId: 'missing' }).ok, false);
  const imported = await favorites.importPaste(preview.data.id);
  assert.equal(imported.ok, true, JSON.stringify(imported.error));
  assert.equal(favorites.snapshot().revision, before + 1);
  assert.equal(events, 1);
  assert.equal(favorites.list({ seriesId, sectionId }).total, 2);
  await favorites.undo();
  assert.equal(favorites.list({ seriesId, sectionId }).total, 0);
});

test('paste row errors are atomic and leave shelf revision unchanged', async () => {
  const { favorites } = await createUnifiedFixture();
  const { seriesId, sectionId } = await addFavoriteLocation(favorites, 'Paste');
  const before = favorites.snapshot().revision;
  const result = favorites.previewPaste('valid\t说明\textra', { format: 'tsv', kind: 'tag', seriesId, sectionId });
  assert.equal(result.ok, false);
  assert.equal(favorites.snapshot().revision, before);
  assert.equal(favorites.list({ seriesId }).total, 0);
});

test('legacy bundle validation rejects newer versions, duplicate IDs and dangling parents', () => {
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

test('legacy bundle validation normalizes an empty section ID to the series root', () => {
  const bundle = {
    format: 'ai-tag-favorites', version: 1, revision: 1,
    series: [{ id: 's', name: 'Root', order: 0, colorMode: 'auto', color: '#112233' }], sections: [],
    entries: [{ id: 'e', kind: 'tag', seriesId: 's', sectionId: '', title: '', rawText: 'root', zh: '', aliases: [], note: '', globalSearchable: true, pinned: false, nsfw: false, order: 0, sourceTagId: null, createdAt: 0, updatedAt: 0 }]
  };
  assert.equal(validateFavoriteBundle(bundle).data.entries[0].sectionId, null);
});

test('export and confirmed import round-trip shared editable fields without selections', async () => {
  const { favorites: source } = await createUnifiedFixture();
  const { seriesId, sectionId } = await addFavoriteLocation(source, 'Light', 'Portrait');
  await source.setSeriesColors([seriesId], { mode: 'custom', color: '#123ABC' });
  const entry = (await source.saveEntry({
    kind: 'bundle', seriesId, sectionId, title: '柔光', rawText: ' soft, (light:1.2) ',
    aliases: ['soft'], note: 'note', globalSearchable: false, nsfw: true
  })).data;
  await source.applyBatch({ ids: [entry.id], patch: { pinned: true } });
  await source.setSelected(entry.id, true);
  const bundle = source.exportBundle();
  assert.equal(bundle.format, 'ai-tag-library');
  assert.equal(Object.hasOwn(bundle, 'selection'), false);

  const { favorites: target } = await createUnifiedFixture();
  const old = (await target.saveSeries({ name: 'Old' })).data;
  const preview = target.previewImport(bundle);
  assert.equal(preview.ok, true);
  assert.equal(target.list().total, 0);
  assert.equal((await target.importBundle(preview.data.id)).ok, true);
  const restored = target.list({ includeAdult: true }).items[0];
  for (const field of ['kind', 'title', 'rawText', 'aliases', 'note', 'globalSearchable', 'nsfw']) assert.deepEqual(restored[field], entry[field], field);
  assert.equal(restored.pinned, true);
  assert.equal(target.series().find(row => row.id === restored.seriesId).color, '#123ABC');
  assert.equal(target.selected({ includeAdult: true }).length, 0);
  assert.equal((await target.undo()).ok, true);
  assert.deepEqual(target.series().map(row => row.id), [old.id]);
});

test('legacy append import remaps conflicting IDs and preserves references atomically', async () => {
  const { favorites: existing } = await createUnifiedFixture();
  const localSeries = (await existing.saveSeries({ name: 'Local' })).data;
  const bundle = {
    format: 'ai-tag-favorites', version: 1, revision: 9,
    series: [{ ...localSeries, name: 'Imported' }],
    sections: [{ id: 'section-1', seriesId: localSeries.id, name: 'Imported section', order: 0 }],
    entries: [{
      id: 'entry-1', kind: 'tag', seriesId: localSeries.id, sectionId: 'section-1', title: '', rawText: 'exact raw', zh: '', aliases: [], note: '',
      globalSearchable: true, pinned: false, nsfw: false, order: 0, sourceTagId: null, createdAt: 1, updatedAt: 1
    }]
  };
  const preview = existing.previewImport(bundle);
  assert.equal(preview.ok, true, JSON.stringify(preview.error));
  const result = await existing.importBundle(preview.data.id);
  assert.equal(result.ok, true);
  const imported = existing.list({ includeAdult: true }).items[0];
  assert.notEqual(imported.seriesId, localSeries.id);
  assert.equal(existing.sections(imported.seriesId)[0].id, imported.sectionId);
  assert.equal(existing.series().find(row => row.id === localSeries.id).name, 'Local');
});

test('invalid imports leave state and revision unchanged', async () => {
  const { favorites } = await createUnifiedFixture();
  const { seriesId, sectionId } = await addFavoriteLocation(favorites, 'Keep');
  await favorites.saveEntry({ kind: 'tag', seriesId, sectionId, rawText: 'keep me' });
  const before = favorites.snapshot();
  const invalid = favorites.exportBundle(); invalid.tags[0].content = '';
  assert.equal(favorites.previewImport(invalid).ok, false);
  assert.equal((await favorites.importBundle('missing-preview')).ok, false);
  assert.deepEqual(favorites.snapshot().document, before.document);
  assert.equal(favorites.snapshot().revision, before.revision);
});
