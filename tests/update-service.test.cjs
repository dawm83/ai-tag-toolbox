'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUpdateService } = require('../src/modules/update-service');

function fixture() {
  const calls = [], state = { protocol: 1, installRoot: 'C:\\Install', activeVersion: '1.4.353', previousVersion: '1.4.353', pendingVersion: '', pendingDirectory: '', installed: [{ version: '1.4.353', source: 'migration' }], lastError: null };
  const digest = 'a'.repeat(64);
  const release = { tag_name: 'v1.4.354', name: 'V1.4.354', prerelease: true, draft: false, published_at: '2026-09-24T00:00:00Z', assets: [
    'AI.Tag.V1.4.354.zip', 'AI.Tag.V1.4.354.7z', 'AI.Tag.V1.4.354.zip.sha256', 'AI.Tag.V1.4.354.7z.sha256', 'AI.Tag.V1.4.354.build-info.json'
  ].map(name => ({ name, size: 12, browser_download_url: `https://github.com/star-abyss/ai-tag-toolbox/releases/download/v1.4.354/${name}` })) };
  const options = {
    rootDir: 'C:\\Install', userDataDir: 'C:\\UpdateTestDataNotPresent', backupRoot: 'C:\\UpdateTestBackups',
    fetchJson: async url => { calls.push(['json', url]); return url.includes('/releases') ? [release] : { version: '1.4.354', archiveSha256: digest }; },
    downloadFile: async (url, destination, options) => { calls.push(['download', url, destination]); options?.onProgress?.({ received: 12, total: 12 }); return destination; },
    readText: async filename => filename.endsWith('.sha256') ? `${digest}  AI.Tag.V1.4.354.zip\n` : JSON.stringify({ version: '1.4.354', updateProtocol: 1 }),
    hashFile: async () => digest,
    extractZip: async (_archive, destination) => { calls.push(['extract', destination]); },
    validateStaged: async directory => { calls.push(['validate', directory]); return { version: '1.4.354', updateProtocol: 1 }; },
    readState: async () => structuredClone(state),
    writeState: async next => Object.assign(state, structuredClone(next)),
    mkdir: async () => {},
    remove: async () => {},
    rename: async (from, to) => calls.push(['rename', from, to]),
    random: () => 'test'
  };
  const service = createUpdateService(options);
  return { service, options, calls, state };
}

test('lists installable future releases and merges current installed state', async () => {
  const f = fixture();
  const rows = await f.service.listReleases();
  assert.equal(rows[0].version, '1.4.354');
  assert.equal(rows[0].installable, true);
  assert.equal(rows[0].installed, false);
  assert.equal(rows[1].current, true);
  assert.equal(rows[1].installed, true);
});

test('downloads, checksums and stages a future release without changing the active slot', async () => {
  const f = fixture(), progress = [];
  const result = await f.service.downloadAndStage('1.4.354', { onProgress: value => progress.push(value) });
  assert.equal(result.version, '1.4.354');
  assert.equal(result.stagedDirectory.replaceAll('\\', '/'), '.staging/V1.4.354-test');
  assert.deepEqual(progress, [{ received: 12, total: 12 }]);
  assert.equal(f.state.activeVersion, '1.4.353');
  assert(f.calls.some(call => call[0] === 'extract'));
  assert(f.calls.some(call => call[0] === 'validate'));
});

test('prepares an installed or staged switch and leaves rollback state available', async () => {
  const f = fixture();
  await f.service.downloadAndStage('1.4.354');
  const pending = await f.service.prepareSwitch('1.4.354', '.staging/V1.4.354-test');
  assert.equal(pending.pendingVersion, '1.4.354');
  assert.equal(pending.pendingDirectory, '.staging/V1.4.354-test');
  assert.equal(pending.previousVersion, '1.4.353');
});

test('stores a non-recursive shared-data snapshot under the user data root', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-tag-update-backup-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, 'user-data');
  await fs.promises.mkdir(path.join(userDataDir, 'backups'), { recursive: true });
  await fs.promises.writeFile(path.join(userDataDir, 'settings.json'), '{"ok":true}');
  const state = { protocol: 1, activeVersion: '1.4.353', previousVersion: '1.4.353', installed: [{ version: '1.4.353', source: 'migration' }] };
  const service = createUpdateService({
    rootDir: path.join(root, 'install'), userDataDir, backupRoot: path.join(userDataDir, 'backups'),
    readState: async () => structuredClone(state), writeState: async () => {}, random: () => 'snapshot'
  });
  await service.switchInstalled('1.4.353');
  const backups = await fs.promises.readdir(path.join(userDataDir, 'backups'));
  assert.equal(backups.length, 1);
  const snapshot = path.join(userDataDir, 'backups', backups[0]);
  assert.equal(await fs.promises.readFile(path.join(snapshot, 'settings.json'), 'utf8'), '{"ok":true}');
  assert.equal(JSON.parse(await fs.promises.readFile(path.join(snapshot, 'version-backup.json'), 'utf8')).fromVersion, '1.4.353');
  assert.equal((await fs.promises.readdir(snapshot)).includes('backups'), false);
});

test('rejects checksum mismatch before extraction', async () => {
  const f = fixture();
  const bad = createUpdateService({ ...f.options, readText: async filename => filename.endsWith('.sha256') ? `${'b'.repeat(64)}  AI.Tag.V1.4.354.zip\n` : '{}' });
  await assert.rejects(bad.downloadAndStage('1.4.354'), error => error.code === 'CHECKSUM_MISMATCH');
  assert.equal(f.calls.some(call => call[0] === 'extract'), false);
});

test('rejects archive traversal and absolute paths before extraction', () => {
  const { assertSafeArchiveEntries } = require('../src/modules/update-service');
  assert.equal(assertSafeArchiveEntries(['AI Tag Tool/versions/V1.4.354/app.asar', './models/tags.json']), true);
  for (const entry of ['../outside.exe', 'AI Tag Tool/../../outside.exe', 'C:/outside.exe', '\\\\server\\share\\file']) {
    assert.throws(() => assertSafeArchiveEntries([entry]), error => error.code === 'ARCHIVE_PATH_REJECTED');
  }
});

test('update host commits a staged slot after the parent exits and launches the stable host', async () => {
  const calls = [], host = require('../src/modules/update-host').createUpdateHost({
    rootDir: 'C:\\Install',
    readState: async () => ({ protocol: 1, installRoot: 'C:\\Install', activeVersion: '1.4.353', previousVersion: '1.4.353', pendingVersion: '1.4.354', pendingDirectory: '.staging/V1.4.354-test', installed: [{ version: '1.4.353', source: 'migration' }], lastError: null }),
    writeState: async state => calls.push(['state', state]),
    waitForExit: async () => calls.push(['wait']),
    exists: async value => String(value).includes('.staging'),
    rename: async (from, to) => calls.push(['rename', from, to]),
    readBuildInfo: async () => ({ version: '1.4.354', updateProtocol: 1 }),
    launch: async value => calls.push(['launch', value])
  });
  await host.run({ parentPid: 123, launcherPath: 'C:\\Install\\AI绘画Tag工具箱.exe' });
  assert.deepEqual(calls.map(call => call[0]), ['wait', 'rename', 'state', 'launch']);
  assert.equal(calls[2][1].activeVersion, '1.4.354');
});
