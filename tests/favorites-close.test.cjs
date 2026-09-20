'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { createHarness } = require('./fixtures/tag-library.cjs');
const { createTagEditorView } = require('../src/views/tag-editor-view');
const root = path.resolve(__dirname, '..');

test('app close saves the real shared draft before host flush and retains failed draft for retry', async t => {
  const h = createHarness(); await h.ready;
  const dom = new JSDOM('<body></body>');
  const editor = createTagEditorView({ document: dom.window.document, catalog: h.library, confirmDiscard: async () => 'save' });
  let hostCalls = 0;
  const context = vm.createContext({
    AppModules: { prepareClose: async () => { hostCalls++; assert.equal(h.library.getTag('blue_hair').note, 'pending'); return h.library.flush(); } },
    AppView: { create: () => ({ start() {}, tagEditor: editor, views: {} }) }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), context);
  t.after(async () => { editor.dispose(); dom.window.close(); await h.library.dispose(); });
  await editor.open({ tagId: 'blue_hair' });
  const note = dom.window.document.querySelector('[data-tag-field="note"]');
  note.value = 'pending'; note.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  h.controls.failNextSave();
  assert.equal(await context.App.flushBeforeClose(), false);
  assert.equal(hostCalls, 0); assert.equal(editor.isDirty(), true); assert.equal(note.value, 'pending');
  assert.equal(await context.App.flushBeforeClose(), true);
  assert.equal(hostCalls, 1); assert.equal(editor.isDirty(), false);
  assert.equal((await h.reload()).getTag('blue_hair').note, 'pending');
});

test('relationship close rejection blocks host flushing after the shared editor guard', async () => {
  const events = []; let accepted = false;
  const context = vm.createContext({
    AppModules: { prepareClose: async () => { events.push('host'); return true; } },
    AppView: { create: () => ({ start() {}, tagEditor: { requestClose: async () => { events.push('tag'); return true; } }, views: { characters: { requestClose: async () => { events.push('relations'); return accepted; } } } }) }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), context);
  assert.equal(await context.App.flushBeforeClose(), false); assert.deepEqual(events, ['tag', 'relations']);
  accepted = true; assert.equal(await context.App.flushBeforeClose(), true);
  assert.deepEqual(events, ['tag', 'relations', 'tag', 'relations', 'host']);
});
