'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSettings } = require('../src/modules/settings');
const { createStorage } = require('../src/modules/storage');

test('unknown settings groups do not reset persisted configuration', () => {
  const storage = createStorage();
  const settings = createSettings({ storage });
  settings.setForm({ model: 'saved-model', comfyCfg: 0, comfySeed: 0 });
  const before = settings.snapshot();
  for (const group of ['typo', '', null]) {
    settings.reset(group);
    assert.deepEqual(settings.snapshot(), before);
    assert.deepEqual(storage.get('settings'), before);
  }
});

test('known API reset and explicit whole reset retain their existing behavior', () => {
  const settings = createSettings();
  settings.setForm({ model: 'custom', comfyCfg: 0 });
  settings.reset('primaryApi');
  assert.equal(settings.getForm().model, 'gpt-4o-mini');
  assert.equal(settings.getForm().comfyCfg, 0);
  settings.reset();
  assert.equal(settings.getForm().comfyCfg, 7);
});
