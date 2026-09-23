'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RELEASE_REPOSITORY,
  parseVersion,
  compareVersions,
  normalizeRelease,
  normalizeState,
  transitionState,
  requiredReleaseAssets
} = require('../src/modules/version-manager');

const asset = name => ({ name, size: 10, browser_download_url: `https://github.com/star-abyss/ai-tag-toolbox/releases/download/v1.4.354/${name}` });
const assetsFor = version => [
  asset(`AI.Tag.V${version}.zip`),
  asset(`AI.Tag.V${version}.7z`),
  asset(`AI.Tag.V${version}.zip.sha256`),
  asset(`AI.Tag.V${version}.7z.sha256`),
  asset(`AI.Tag.V${version}.build-info.json`)
];

test('parses internal versions and compares numeric patch iterations', () => {
  assert.deepEqual(parseVersion('V1.4.353'), { raw: '1.4.353', major: 1, minor: 4, patch: 353 });
  assert.deepEqual(parseVersion('v1.4.32'), { raw: '1.4.32', major: 1, minor: 4, patch: 32 });
  assert.equal(compareVersions('1.4.353', '1.4.32'), 1);
  assert.equal(compareVersions('1.4.3', '1.4.3'), 0);
  assert.equal(parseVersion('1.4'), null);
  assert.equal(parseVersion('../V1.4.353'), null);
});

test('normalizes a release and keeps stable or prerelease channel metadata', () => {
  const result = normalizeRelease({
    tag_name: 'v1.4.354', name: '测试版', prerelease: true, draft: false,
    published_at: '2026-09-24T00:00:00.000Z', html_url: 'https://github.com/star-abyss/ai-tag-toolbox/releases/tag/v1.4.354',
    assets: assetsFor('1.4.354')
  });
  assert.equal(result.version, '1.4.354');
  assert.equal(result.channel, 'prerelease');
  assert.equal(result.installable, true);
  assert.equal(result.assets.zip.name, 'AI.Tag.V1.4.354.zip');
});

test('does not mark old releases installable when the future update contract is incomplete', () => {
  const result = normalizeRelease({ tag_name: 'v1.4.32', prerelease: true, assets: [asset('AI.Tag.V1.4.32.7z')] });
  assert.equal(result.version, '1.4.32');
  assert.equal(result.installable, false);
  assert.equal(result.assets.zip, null);
});

test('requires exact future assets and fixed repository identity', () => {
  assert.deepEqual(RELEASE_REPOSITORY, { owner: 'star-abyss', name: 'ai-tag-toolbox' });
  assert.equal(requiredReleaseAssets('1.4.354', assetsFor('1.4.354')).zip.name, 'AI.Tag.V1.4.354.zip');
  assert.throws(() => requiredReleaseAssets('1.4.354', [asset('AI.Tag.V1.4.354.zip')]), error => error.code === 'RELEASE_ASSET_MISSING');
});

test('normalizes state paths and rejects an unsafe installed directory', () => {
  const state = normalizeState({ protocol: 1, activeVersion: '1.4.353', previousVersion: '1.4.352', installed: [{ version: '1.4.353', directory: '../../outside' }] }, 'C:\\Install');
  assert.equal(state.activeVersion, '1.4.353');
  assert.equal(state.installed[0].directory, 'versions/V1.4.353');
  assert.equal(state.installRoot, 'C:\\Install');
});

test('transitions pending, committed and rollback state without losing installed slots', () => {
  const base = normalizeState({ activeVersion: '1.4.353', installed: [{ version: '1.4.353' }, { version: '1.4.354' }] });
  const pending = transitionState(base, { type: 'prepare', targetVersion: '1.4.354' });
  assert.equal(pending.pendingVersion, '1.4.354');
  assert.equal(pending.previousVersion, '1.4.353');
  const committed = transitionState(pending, { type: 'commit' });
  assert.equal(committed.activeVersion, '1.4.354');
  assert.equal(committed.pendingVersion, '');
  const rolledBack = transitionState(committed, { type: 'rollback', error: { code: 'LAUNCH_FAILED' } });
  assert.equal(rolledBack.activeVersion, '1.4.353');
  assert.equal(rolledBack.lastError.code, 'LAUNCH_FAILED');
  assert.deepEqual(rolledBack.installed.map(item => item.version), ['1.4.353', '1.4.354']);
});
