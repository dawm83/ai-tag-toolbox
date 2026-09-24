'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createInitialState, releaseAssetNames, isSharedUserDataPath } = require('../scripts/package-version-manager.cjs');

test('creates a structured initial state for the current version slot', () => {
  const state = createInitialState('1.4.353', '2026-09-24T00:00:00.000Z');
  assert.equal(state.protocol, 1);
  assert.equal(state.activeVersion, '1.4.353');
  assert.equal(state.installed[0].directory, 'versions/V1.4.353');
  assert.equal(state.installed[0].source, 'migration');
  assert.equal(state.pendingVersion, '');
});

test('declares the five future release assets', () => {
  assert.deepEqual(releaseAssetNames('1.4.354'), [
    'AI.Tag.V1.4.354.zip', 'AI.Tag.V1.4.354.7z', 'AI.Tag.V1.4.354.zip.sha256',
    'AI.Tag.V1.4.354.7z.sha256', 'AI.Tag.V1.4.354.build-info.json'
  ]);
});

test('never treats the shared AppData data root as a version package file', () => {
  assert.equal(isSharedUserDataPath('C:\\Users\\admin\\AppData\\Roaming\\ai-tag-toolbox-rewrite\\rewrite-images\\one.png'), true);
  assert.equal(isSharedUserDataPath('versions/V1.4.353/resources/app.asar'), false);
});
