'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, makeBase, emptyUserDocument } = require('./fixtures/tag-library.cjs');
let op = 0; const run = (l, c) => l.execute(c, { operationId: `h-${++op}` });
test('one batch is one reversible operation; selection survives content undo and save failures preserve history', async () => {
  const h = createHarness(); await h.ready;
  await run(h.library, { type: 'batch', operations: [{ type: 'setFlags', tagIds: ['blue_hair', 'long_hair'], adult: true, searchable: false }] });
  await run(h.library, { type: 'select', selected: true, value: { kind: 'tag', tagId: 'blue_hair' } });
  h.controls.failNextSave(); assert.equal((await run(h.library, { type: 'undo' })).error.code, 'STORAGE_WRITE_FAILED');
  assert.deepEqual(h.library.historyState(), { canUndo: true, canRedo: false });
  assert.equal((await run(h.library, { type: 'undo' })).ok, true);
  assert.equal(h.library.getTag('blue_hair').adult, false); assert.equal(h.library.getTag('long_hair').searchable, true);
  assert.equal(h.library.selected({ includeAdult: true }).length, 1);
  assert.equal((await run(h.library, { type: 'redo' })).ok, true); assert.equal(h.library.getTag('blue_hair').adult, true);
});
test('history stores only changed entities and at most thirty user operations', async () => {
  const { applyLibraryCommand } = require('../src/modules/tag-library/commands');
  const base = makeBase(), doc = emptyUserDocument(base);
  const prepared = applyLibraryCommand(doc, base, { type: 'saveTag', tagId: 'blue_hair', patch: { note: 'edit' } }, { ids: x => `${x}:one`, now: () => 10 });
  assert.equal(prepared.ok, true); const serialized = JSON.stringify(prepared.data.historyDelta);
  assert.ok(!serialized.includes('long_hair')); assert.ok(!serialized.includes('wonderland')); assert.ok(serialized.length < 1500);
  const h = createHarness(); await h.ready;
  for (let i = 1; i <= 35; i++) await run(h.library, { type: 'saveTag', tagId: 'blue_hair', patch: { note: `${i}` } });
  for (let i = 0; i < 30; i++) assert.equal((await run(h.library, { type: 'undo' })).ok, true);
  assert.equal(h.library.getTag('blue_hair').note, '5'); assert.equal(h.library.historyState().canUndo, false);
  assert.equal((await run(h.library, { type: 'undo' })).data.changed, false);
  await run(h.library, { type: 'saveTag', tagId: 'long_hair', patch: { note: 'new branch' } });
  assert.equal(h.library.historyState().canRedo, false);
});
test('undo validates newer references and never removes a newly selected tag', async () => {
  const h = createHarness(); await h.ready;
  const created = await run(h.library, { type: 'saveTag', patch: { content: 'created' } });
  await run(h.library, { type: 'select', selected: true, value: { kind: 'tag', tagId: created.data.tagId } });
  assert.equal((await run(h.library, { type: 'undo' })).error.code, 'UNRESOLVED_REFERENCE');
  assert.notEqual(h.library.getTag(created.data.tagId), null); assert.equal(h.library.historyState().canUndo, true);
  await run(h.library, { type: 'clearSelection' }); assert.equal((await run(h.library, { type: 'undo' })).ok, true);
  assert.equal(h.library.getTag(created.data.tagId), null);
});
