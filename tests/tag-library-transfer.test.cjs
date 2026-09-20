'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, makeBase, emptyUserDocument, makeRecord } = require('./fixtures/tag-library.cjs');
const command = (library, value, operationId) => library.execute(value, { operationId });
async function source() {
  const h = createHarness(); await h.ready;
  const a = await command(h.library, { type: 'saveTag', patch: { kind: 'bundle', content: ' 蓝发, (light:1.25)\r\n\\raw ', searchable: false, adult: true }, placement: { kind: 'favorite', page: { id: 'home' }, group: { id: 'daily' } } }, 'create');
  await command(h.library, { type: 'favoriteTag', tagId: a.data.tagId, placement: { kind: 'favorite', page: { id: 'home' }, group: { create: { name: 'Second' } } } }, 'second');
  return h;
}
test('v2 favorite file roundtrip retains one opaque Tag and two shared memberships', async () => {
  const from = await source(), target = createHarness(); await target.ready;
  const bundle = from.library.exportBundle({ scope: 'favorites' });
  assert.equal(bundle.format, 'ai-tag-library');
  assert.equal(bundle.tags.length, 1); assert.equal(bundle.memberships.length, 2); assert.deepEqual(bundle.characters, []);
  const file = from.library.exportFile({ scope: 'favorites' }); assert.equal(file.ok, true); assert.equal(file.data.filename, 'ai-tag-library.json'); assert.equal(Buffer.from(file.data.bytes).toString('utf8'), JSON.stringify(bundle));
  const preview = target.library.previewImportFile(file.data.bytes); assert.equal(preview.ok, true);
  assert.equal(target.library.revision(), 0); assert.equal(target.library.historyState().canUndo, false);
  assert.equal((await command(target.library, { type: 'applyImport', previewId: preview.data.id }, 'import')).ok, true);
  const output = target.library.exportBundle({ scope: 'favorites' });
  assert.equal(output.tags.length, 1); assert.equal(output.memberships.length, 2); assert.equal(output.tags[0].content, bundle.tags[0].content);
  assert.equal(new Set(output.memberships.map(row => row.tagId)).size, 1);
});
test('same external Tag ID with different metadata imports independently without overwriting local', async () => {
  const h = createHarness(); await h.ready;
  const bundle = h.library.exportBundle({ scope: 'all' });
  assert.equal(bundle.format, 'ai-tag-library');
  bundle.tags.find(row => row.id === 'blue_hair').note = 'foreign note';
  const preview = h.library.previewImport(bundle); assert.equal(preview.ok, true); assert.equal(preview.data.counts.conflicts, 1);
  assert.equal((await command(h.library, { type: 'applyImport', previewId: preview.data.id }, 'import')).ok, true);
  assert.equal(h.library.getTag('blue_hair').note, '');
  assert.equal(h.library.exportBundle({ scope: 'all' }).tags.filter(row => row.content === 'blue hair').length, 2);
});
test('preview is host owned, cancellable, stale without caller revision, and durable retry is idempotent', async () => {
  const from = await source(), h = createHarness(); await h.ready; let events = 0; h.library.subscribe(() => events++);
  const bundle = from.library.exportBundle({ scope: 'favorites' });
  const first = h.library.previewImport(bundle); assert.equal(first.ok, true); assert.equal(events, 0);
  assert.equal(h.library.previewImport({ ...bundle, version: 99 }).ok, false);
  h.controls.failNextSave(); const apply = { type: 'applyImport', previewId: first.data.id };
  assert.equal((await command(h.library, apply, 'retry')).error.code, 'STORAGE_WRITE_FAILED');
  assert.equal(events, 0); assert.equal(h.library.getMemberships().length, 0);
  const saved = await command(h.library, apply, 'retry'); assert.equal(saved.ok, true); assert.equal(events, 1);
  assert.deepEqual(await command(h.library, apply, 'retry'), saved); assert.equal(events, 1);
  const second = h.library.previewImport(bundle); h.library.cancelImportPreview(second.data.id);
  assert.equal((await command(h.library, { type: 'applyImport', previewId: second.data.id }, 'canceled')).error.code, 'IMPORT_PREVIEW_NOT_FOUND');
  const stale = h.library.previewImport(bundle);
  await command(h.library, { type: 'saveTag', tagId: 'blue_hair', patch: { note: 'changed' } }, 'edit');
  assert.equal((await command(h.library, { type: 'applyImport', previewId: stale.data.id }, 'stale')).error.code, 'REVISION_CONFLICT');
});

test('file transport accepts v1 after byte bounds and rejects corrupt/oversized input', async () => {
  const h = createHarness(); await h.ready;
  const legacy = { format: 'ai-tag-favorites', version: 1, revision: 0, series: [{ id: 'foreign-page', name: 'Legacy', order: 0, color: '#123456', colorMode: 'auto' }], sections: [], entries: [{ id: 'e', kind: 'tag', seriesId: 'foreign-page', sectionId: null, title: '', rawText: ' (light:1.2)\r\n  exact ', zh: '', aliases: [], note: '', globalSearchable: false, pinned: true, nsfw: true, order: 0, sourceTagId: null, sourceCharacterId: null, createdAt: 0, updatedAt: 0 }] };
  const p = h.library.previewImportFile(JSON.stringify(legacy)); assert.equal(p.ok, true, JSON.stringify(p));
  assert.equal((await command(h.library, { type: 'applyImport', previewId: p.data.id }, 'legacy')).ok, true);
  const output = h.library.exportBundle({ scope: 'favorites' }); assert.equal(output.tags[0].kind, 'bundle'); assert.equal(output.tags[0].content, legacy.entries[0].rawText); assert.equal(output.tags[0].adult, true); assert.equal(output.tags[0].searchable, false);
  assert.equal(h.library.previewImportFile(new Uint8Array(32 * 1024 * 1024 + 1)).error.code, 'IMPORT_TOO_LARGE');
  assert.equal(h.library.previewImportFile(new Uint8Array([31, 139, 3])).ok, false);
  const gzip = require('node:zlib').gzipSync(Buffer.alloc(128 * 1024 * 1024 + 1, 32));
  assert.equal(h.library.previewImportFile(gzip).error.code, 'IMPORT_TOO_LARGE');
});
test('full import preserves unknown roles and clean-base changed links through durable undo redo', async () => {
  const base = makeBase(), doc = emptyUserDocument(base);
  doc.unresolved.push({ id: 'archive', sourceKey: 'history', sourceId: null, reason: 'HISTORY_ARCHIVE', payload: { exact: 'keep\r\n' } });
  const h = createHarness({ document: doc }); await h.ready;
  const bundle = h.library.exportBundle({ scope: 'all' }); bundle.characters[0].generalTagIds = ['long_hair']; bundle.characters.push({ ...structuredClone(bundle.characters[0]), characterId: 'foreign-role' });
  const p = h.library.previewImport(bundle); assert.equal(p.ok, true); assert.equal(p.data.details.relationsApplied, 1); assert.equal(p.data.details.relationsPreserved, 1);
  h.controls.failNextSave(); assert.equal((await command(h.library, { type: 'applyImport', previewId: p.data.id }, 'roles')).ok, false);
  assert.equal(h.library.exportMigrationReport().unresolved.length, 1);
  assert.equal((await command(h.library, { type: 'applyImport', previewId: p.data.id }, 'roles')).ok, true);
  assert.deepEqual(h.library.getCharacterLinks('alice').generalTagIds, ['long_hair']); assert.equal(h.library.getCharacterLinks('foreign-role'), null);
  assert.equal(h.library.getMigrationReport().counts.archive, 1); assert.equal(h.library.getMigrationReport().counts.actionable, 1);
  assert.equal((await command(h.library, { type: 'undo' }, 'undo')).ok, true); assert.equal(h.library.exportMigrationReport().unresolved.length, 1);
  assert.deepEqual(h.library.getCharacterLinks('alice').generalTagIds, ['blue_hair']);
  assert.equal((await command(h.library, { type: 'redo' }, 'redo')).ok, true); assert.equal(h.library.exportMigrationReport().unresolved.length, 2);
});
test('one preview lifetime retains valid pending on invalid attempt and expires with injected clock', async () => {
  let time = 0; const h = createHarness({ now: () => time }); await h.ready; const from = await source();
  const a = h.library.previewImport(from.library.exportBundle({ scope: 'favorites' }));
  assert.equal(h.library.previewImport({}).ok, false);
  time = 15 * 60 * 1000 + 1;
  assert.equal((await command(h.library, { type: 'applyImport', previewId: a.data.id }, 'expired')).error.code, 'IMPORT_PREVIEW_NOT_FOUND');
  assert.equal(h.library.getMemberships().length, 0);
});
test('paste uses migration semantics and one undo transaction with exact multiline TSV', async () => {
  const h = createHarness(); await h.ready; const raw = ' (light:1.2)\r\n exact ';
  const p = h.library.previewPaste('"' + raw + '"\t名称', { format: 'tsv', kind: 'tag', seriesId: 'home', sectionId: 'daily' });
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.equal((await command(h.library, { type: 'applyImport', previewId: p.data.id }, 'paste')).ok, true);
  const bundle = h.library.exportBundle({ scope: 'favorites' }); assert.equal(bundle.tags[0].content, raw); assert.equal(bundle.tags[0].kind, 'bundle');
  assert.equal((await command(h.library, { type: 'undo' }, 'undo')).ok, true); assert.equal(h.library.getMemberships().length, 0);
});
test('full seed plus 10k user favorites roundtrips through actual gzip file helpers without pagination truncation', async () => {
  const base = require('../assets/数据资产/标签/unified-tag-base.json'), document = emptyUserDocument(base), origin = base.tags[0];
  for (let i = 0; i < 10000; i++) {
    document.customTags.push({ ...structuredClone(origin), id: `roundtrip:user:${i}`, kind: 'bundle', content: ` exact ${i}, (weight:1.25)\r\n 第二行 `, displayName: `Saved ${i}`, usages: ['general'], source: { kind: 'custom', key: null } });
    document.memberships.push({ id: `roundtrip:member:${i}`, tagId: `roundtrip:user:${i}`, groupId: 'daily', order: i, pinned: i % 2 === 0 });
  }
  const from = createHarness({ base, document }), target = createHarness({ base }); await from.ready; await target.ready;
  const file = from.library.exportFile({ scope: 'all' }); assert.equal(file.ok, true, JSON.stringify(file.error)); assert.equal(file.data.filename, 'ai-tag-library.json.gz');
  const p = target.library.previewImportFile(file.data.bytes); assert.equal(p.ok, true, JSON.stringify(p.error)); assert.equal(p.data.counts.added, 10000); assert.equal(p.data.counts.reused, base.tags.length);
  assert.equal(p.data.details.membershipsAdded, 10000); assert.equal(target.library.getMemberships().length, 0);
  assert.equal((await command(target.library, { type: 'applyImport', previewId: p.data.id }, 'full')).ok, true);
  const output = target.library.exportBundle({ scope: 'all' }); assert.equal(output.tags.length, base.tags.length + 10000); assert.equal(output.memberships.length, 10000); assert.deepEqual(output.characters, base.characterLinks);
  assert.equal(output.tags.find(row => row.id === 'roundtrip:user:9999').content, document.customTags[9999].content);
  console.log(`full-seed roundtrip: ${output.tags.length} tags, ${output.memberships.length} memberships, ${output.characters.length} roles; gzip ${file.data.bytes.length} bytes`);
  await from.library.dispose(); await target.library.dispose();
});
test('strict malformed v2 previews retain revision and valid pending candidate', async () => {
  const h = createHarness(); await h.ready; const from = await source(), bundle = from.library.exportBundle({ scope: 'favorites' });
  const valid = h.library.previewImport(bundle);
  const mutations = [value => { value.extra = true; }, value => { value.version = 3; }, value => { value.tags[0].adult = 'true'; }, value => { value.tags.push(structuredClone(value.tags[0])); }, value => { value.memberships[0].tagId = 'missing'; }, value => { value.groups[0].pageId = 'missing'; }, value => { value.tags[0].subcategoryId = 'missing'; }];
  for (const mutate of mutations) { const value = structuredClone(bundle); mutate(value); assert.equal(h.library.previewImport(value).ok, false); assert.equal(h.library.revision(), 0); }
  let getterCalls = 0; const unsafe = { get format() { getterCalls++; return 'ai-tag-library'; } }; assert.equal(h.library.previewImport(unsafe).ok, false); assert.equal(getterCalls, 0);
  assert.equal((await command(h.library, { type: 'applyImport', previewId: valid.data.id }, 'valid')).ok, true);
});
test('identity reuse ignores host metadata and never merges distinct external Tag IDs', async () => {
  const h = createHarness(); await h.ready; const bundle = h.library.exportBundle({ scope: 'all' });
  bundle.tags[0].source = { kind: 'custom', key: 'foreign' }; bundle.tags[0].revision = 42; bundle.tags[0].createdAt = 20; bundle.tags[0].updatedAt = 40;
  bundle.tags.push({ ...structuredClone(bundle.tags[0]), id: 'distinct-same-text' });
  const p = h.library.previewImport(bundle); assert.equal(p.ok, true); assert.equal(p.data.counts.conflicts, 0); assert.equal(p.data.counts.added, 1);
  assert.equal((await command(h.library, { type: 'applyImport', previewId: p.data.id }, 'identity')).ok, true); assert.equal(h.library.getTag('blue_hair').revision, 0); assert.ok(h.library.getTag('distinct-same-text'));
});
test('taxonomy remaps parent conflicts and imported definitions are custom without dropping records', async () => {
  const h = createHarness(); await h.ready; const bundle = h.library.exportBundle({ scope: 'all' }); bundle.categories[0].name = 'Foreign';
  const p = h.library.previewImport(bundle); assert.equal(p.ok, true, JSON.stringify(p)); assert.equal(p.data.counts.conflicts, bundle.tags.length);
  assert.equal((await command(h.library, { type: 'applyImport', previewId: p.data.id }, 'taxonomy')).ok, true);
  const imported = h.library.getCategories().find(row => row.name === 'Foreign'); assert.equal(imported.source, 'custom'); assert.notEqual(imported.id, 'hair');
  assert.equal(h.library.getSubcategories(imported.id).length, 2); assert.ok(h.library.getSubcategories(imported.id).every(row => row.source === 'custom'));
});
test('full export preserves unused structure and report separates archives from actionable data', async () => {
  const base = makeBase(), doc = emptyUserDocument(base); doc.unresolved = ['HISTORY_ARCHIVE', 'OLDER_FAVORITES_ARCHIVE', 'CHARACTER_METADATA_ARCHIVE', 'DUPLICATE_MEMBERSHIP', 'OPAQUE_BUNDLE_CONVERSION', 'INDEPENDENT_FAVORITE_DIFFERENCE', 'AMBIGUOUS_WHOLE_CONTENT', 'UNKNOWN'].map((reason, index) => ({ id: `u:${index}`, sourceKey: 'legacy', sourceId: null, reason, payload: { exact: '秘密\r\n内容' } }));
  const h = createHarness({ document: doc }); await h.ready; const full = h.library.exportBundle({ scope: 'all' }), favorites = h.library.exportBundle({ scope: 'favorites' });
  assert.equal(full.pages.length, 1); assert.equal(full.groups.length, 1); assert.equal(favorites.pages.length, 0); assert.equal(favorites.categories.length, 0);
  const report = h.library.getMigrationReport(); assert.deepEqual([report.counts.archive, report.counts.retained, report.counts.actionable], [3, 3, 2]); assert.equal(JSON.stringify(report).includes('秘密'), false);
  const file = h.library.exportMigrationFile(); assert.equal(file.ok, true); const exported = JSON.parse(Buffer.from(file.data.bytes).toString('utf8')); assert.deepEqual(exported.unresolved, doc.unresolved);
});
test('wrong preview ID cannot evict the real pending import', async () => {
  const h = createHarness(); await h.ready; const from = await source(), p = h.library.previewImport(from.library.exportBundle({ scope: 'favorites' }));
  assert.equal((await command(h.library, { type: 'applyImport', previewId: 'foreign-preview' }, 'wrong')).error.code, 'IMPORT_PREVIEW_NOT_FOUND');
  assert.equal((await command(h.library, { type: 'applyImport', previewId: p.data.id }, 'real')).ok, true);
});
test('locally customized character links conflict without overwrite while mapped payload remains exportable', async () => {
  const h = createHarness(); await h.ready; const incoming = h.library.exportBundle({ scope: 'all' }); incoming.characters[0].generalTagIds = ['long_hair'];
  const local = h.library.getCharacterLinks('alice'); local.generalTagIds = [];
  await command(h.library, { type: 'saveCharacterLinks', links: local }, 'local');
  const p = h.library.previewImport(incoming); assert.equal(p.ok, true); assert.equal(p.data.details.relationsApplied, 0); assert.equal(p.data.details.relationsPreserved, 1);
  await command(h.library, { type: 'applyImport', previewId: p.data.id }, 'foreign'); assert.deepEqual(h.library.getCharacterLinks('alice').generalTagIds, []);
  const row = h.library.exportMigrationReport().unresolved[0]; assert.equal(row.reason, 'IMPORT_CHARACTER_CONFLICT'); assert.deepEqual(row.payload.mapped.generalTagIds, ['long_hair']);
});
test('preview replacement evicts only older valid candidate and new preview has no observable content writes', async () => {
  const h = createHarness(); await h.ready; const from = await source(), bundle = from.library.exportBundle({ scope: 'favorites' }); const a = h.library.previewImport(bundle), b = h.library.previewImport(bundle);
  assert.notEqual(a.data.id, b.data.id); assert.equal(h.library.historyState().canUndo, false); assert.equal(h.repository.saveCount, 0);
  assert.equal((await command(h.library, { type: 'applyImport', previewId: a.data.id }, 'old')).ok, false);
  assert.equal((await command(h.library, { type: 'applyImport', previewId: b.data.id }, 'new')).ok, true);
});
test('legacy import preserves valid empty pages and invalid raw rows without changing the existing receipt', async () => {
  const h = createHarness(); await h.ready;
  const bundle = { format: 'ai-tag-favorites', version: 1, revision: 0, series: [{ id: 'empty', name: 'Empty page', order: 0, color: '#112233', colorMode: 'auto' }], sections: [{ id: 'empty-group', seriesId: 'empty', name: 'Empty group', order: 0, color: '#112233' }], entries: [{ id: 'invalid-old', kind: 'tag', seriesId: 'empty', sectionId: 'empty-group', title: '', rawText: '', legacyInvalid: true, zh: '', aliases: [], note: '', globalSearchable: true, pinned: false, nsfw: false, order: 0, sourceTagId: null, sourceCharacterId: null, createdAt: 0, updatedAt: 0 }] };
  const p = h.library.previewImportFile(JSON.stringify(bundle)); assert.equal(p.ok, true); assert.equal(p.data.counts.invalid, 1);
  assert.equal((await command(h.library, { type: 'applyImport', previewId: p.data.id }, 'legacy-invalid')).ok, true);
  assert.ok(h.library.getFavoritePages().some(row => row.name === 'Empty page')); assert.equal(h.library.exportMigrationReport().receipt, null);
  assert.deepEqual(h.library.exportMigrationReport().unresolved[0].payload, bundle.entries[0]);
});
