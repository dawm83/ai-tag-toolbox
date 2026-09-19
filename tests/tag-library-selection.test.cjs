'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./fixtures/tag-library.cjs');
let op = 0; const run = (l, c) => l.execute(c, { operationId: `s-${++op}` });
test('selection is an id reference, deduplicates entrypoints, and resolves live content', async () => {
  const h = createHarness(); await h.ready;
  const command = { type: 'select', value: { kind: 'tag', tagId: 'blue_hair' }, selected: true };
  await Promise.all([run(h.library, command), run(h.library, command)]);
  assert.equal(h.library.selected({ includeAdult: true }).length, 1); assert.equal(h.repository.saveCount, 1);
  await run(h.library, { type: 'saveTag', tagId: 'blue_hair', patch: { content: 'azure hair', adult: true } });
  assert.equal(h.library.selected({ includeAdult: true })[0].content, 'azure hair'); assert.equal(h.library.selected({ includeAdult: false }).length, 0);
  assert.deepEqual((await h.repository.read()).selection, [command.value]);
  h.controls.failNextSave(); assert.equal((await run(h.library, { ...command, selected: false })).error.code, 'STORAGE_WRITE_FAILED');
  assert.equal(h.library.selected({ includeAdult: true }).length, 1);
});
test('characters compose selected public and specific terms from current tags with adult filtering', async () => {
  const h = createHarness(); await h.ready;
  await run(h.library, { type: 'select', selected: true, value: { kind: 'character', characterId: 'alice', includeSeries: true, generalTagIds: ['blue_hair'], specificTagIds: ['specific:uniform'] } });
  assert.equal(h.library.selected({ includeAdult: true })[0].content, 'alice, wonderland, blue hair, school uniform');
  await run(h.library, { type: 'saveTag', tagId: 'blue_hair', patch: { content: 'azure hair', adult: true } });
  assert.equal(h.library.selected({ includeAdult: true })[0].content, 'alice, wonderland, azure hair, school uniform');
  assert.equal(h.library.selected({ includeAdult: false })[0].content, 'alice, wonderland, school uniform');
  const invalid = await run(h.library, { type: 'select', selected: true, value: { kind: 'character', characterId: 'bob', includeSeries: false, generalTagIds: ['long_hair'], specificTagIds: [] } });
  assert.equal(invalid.ok, false); assert.equal(h.library.selected({ includeAdult: true }).length, 1);
});
test('bundles and legacy snapshots retain byte exact content; kind clear does not remove others', async () => {
  const h = createHarness(); await h.ready; const content = '  (Blue_Hair:1.2),\\(A\\)\n  RED  ';
  const created = await run(h.library, { type: 'saveTag', patch: { kind: 'bundle', content } });
  await run(h.library, { type: 'select', selected: true, value: { kind: 'tag', tagId: created.data.tagId } });
  await run(h.library, { type: 'select', selected: true, value: { kind: 'legacySnapshot', id: 'old', content, displayName: 'old snapshot', adult: false } });
  assert.deepEqual(h.library.selected({ includeAdult: true }).map(x => x.content), [content, content]);
  assert.equal((await run(h.library, { type: 'deleteTag', tagId: created.data.tagId })).error.code, 'TAG_IN_USE');
  await run(h.library, { type: 'clearSelection', kind: 'tag' });
  assert.equal(h.library.selected({ includeAdult: true })[0].kind, 'legacySnapshot');
  await run(h.library, { type: 'markCopied', tagIds: [created.data.tagId, 'blue_hair'] });
  await run(h.library, { type: 'deleteTag', tagId: created.data.tagId });
  assert.deepEqual((await h.repository.read()).recentTagIds, ['blue_hair']);
});
