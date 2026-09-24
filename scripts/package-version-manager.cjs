'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const UPDATE_PROTOCOL = 1;
function text(value, fallback = '') { const output = value == null ? '' : String(value).trim(); return output || fallback; }
function version(value) { const raw = text(value).replace(/^v/i, ''); return /^\d+\.\d+\.\d+$/.test(raw) ? raw : ''; }
function releaseAssetNames(value) {
  const parsed = version(value); if (!parsed) throw new Error('invalid version');
  return [`AI.Tag.V${parsed}.zip`, `AI.Tag.V${parsed}.7z`, `AI.Tag.V${parsed}.zip.sha256`, `AI.Tag.V${parsed}.7z.sha256`, `AI.Tag.V${parsed}.build-info.json`];
}
function createInitialState(value, installedAt = new Date().toISOString()) {
  const parsed = version(value); if (!parsed) throw new Error('invalid version');
  return { protocol: UPDATE_PROTOCOL, activeVersion: parsed, previousVersion: parsed, pendingVersion: '', pendingDirectory: '', launchAttempt: null, launchReady: null, installed: [{ version: parsed, directory: `versions/V${parsed}`, source: 'migration', archiveSha256: '', installedAt, lastLaunch: 'ok' }], lastError: null };
}
function isSharedUserDataPath(value) {
  const normalized = path.resolve(String(value || '')).replace(/\\/g, '/').toLowerCase();
  return normalized.includes('/appdata/roaming/ai-tag-toolbox-rewrite/');
}
function hash(filename) { return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex'); }
function copySelected(source, destination, filter = () => true) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (!filter(entry.name, entry)) continue;
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isDirectory()) fs.cpSync(from, to, { recursive: true }); else fs.copyFileSync(from, to);
  }
}
function writeAtomic(filename, value) {
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8'); fs.renameSync(temporary, filename);
}

function packageStructured(templateArg, stagingArg, versionArg, asarModuleArg) {
  const template = path.resolve(templateArg), source = path.resolve(__dirname, '..'), stage = path.resolve(stagingArg), parsed = version(versionArg);
  if (!parsed) throw new Error('Version must be major.minor.patch');
  const workRoot = path.join(source, 'work');
  if (!stage.startsWith(workRoot + path.sep) || fs.existsSync(stage)) throw new Error('Staging must be a new directory inside work');
  execFileSync('git', ['diff', '--exit-code', 'HEAD', '--'], { cwd: source, stdio: 'pipe' });
  if (!fs.existsSync(path.join(template, `AI绘画Tag工具箱V${parsed}.exe`))) throw new Error('Template executable version mismatch');
  const asar = require(path.resolve(asarModuleArg));
  fs.mkdirSync(stage, { recursive: true });
  const root = path.join(stage, 'AI绘画Tag工具箱'), versionRoot = path.join(root, 'versions', `V${parsed}`);
  fs.mkdirSync(root, { recursive: true });
  fs.cpSync(template, versionRoot, { recursive: true });
  const rootFiles = ['.gitignore', 'chrome_100_percent.pak', 'chrome_200_percent.pak', 'd3dcompiler_47.dll', 'ffmpeg.dll', 'icudtl.dat', 'libEGL.dll', 'libGLESv2.dll', 'LICENSES.chromium.html', 'resources.pak', 'snapshot_blob.bin', 'v8_context_snapshot.bin', 'vk_swiftshader_icd.json', 'vk_swiftshader.dll', 'vulkan-1.dll', 'version'];
  for (const name of rootFiles) if (fs.existsSync(path.join(template, name))) fs.copyFileSync(path.join(template, name), path.join(root, name));
  if (fs.existsSync(path.join(template, 'locales'))) fs.cpSync(path.join(template, 'locales'), path.join(root, 'locales'), { recursive: true });
  copySelected(path.join(template, 'resources'), path.join(root, 'resources'), name => name !== 'app.asar' && name !== 'app.asar.unpacked');
  fs.copyFileSync(path.join(template, `AI绘画Tag工具箱V${parsed}.exe`), path.join(root, 'AI绘画Tag工具箱.exe'));
  const assembly = path.join(stage, 'launcher-assembly');
  fs.mkdirSync(path.join(assembly, 'launcher'), { recursive: true }); fs.mkdirSync(path.join(assembly, 'src', 'modules'), { recursive: true });
  fs.copyFileSync(path.join(source, 'launcher', 'package.json'), path.join(assembly, 'package.json'));
  fs.copyFileSync(path.join(source, 'launcher', 'main.js'), path.join(assembly, 'launcher', 'main.js'));
  for (const name of ['version-launcher.js', 'version-manager.js']) fs.copyFileSync(path.join(source, 'src', 'modules', name), path.join(assembly, 'src', 'modules', name));
  const archive = path.join(root, 'resources', 'app.asar');
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  asar.createPackageWithOptions(assembly, archive, { unpackDir: 'node_modules' });
  const state = createInitialState(parsed);
  writeAtomic(path.join(root, 'version-state.json'), state);
  const packageJson = JSON.parse(fs.readFileSync(path.join(versionRoot, 'package.json'), 'utf8'));
  const evidence = { version: parsed, buildKind: 'local-version-manager-test', sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(), runtimeDependenciesReusedFrom: packageJson.version, updateProtocol: UPDATE_PROTOCOL, dataSchemaMin: 1, dataSchemaMax: 1, releaseAssets: releaseAssetNames(parsed), structuredRoot: 'AI绘画Tag工具箱', activeVersion: parsed, sourceCopiesVerified: ['versions/V' + parsed + '/app', 'versions/V' + parsed + '/resources/app', 'versions/V' + parsed + '/resources/app.asar'], launcherExecutable: 'AI绘画Tag工具箱.exe', launcherArchive: 'resources/app.asar', archiveSha256: hash(path.join(versionRoot, 'resources', 'app.asar')), published: false, pushed: false };
  fs.writeFileSync(path.join(root, 'build-info.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  return { root, version: parsed, state, evidence };
}

if (require.main === module) {
  const [template, staging, versionArg, asarModule] = process.argv.slice(2);
  if (!template || !staging || !versionArg || !asarModule) { console.error('Usage: node scripts/package-version-manager.cjs TEMPLATE STAGING VERSION ASAR_MODULE'); process.exitCode = 1; }
  else { try { console.log(JSON.stringify(packageStructured(template, staging, versionArg, asarModule), null, 2)); } catch (error) { console.error(error.message); process.exitCode = 1; } }
}

module.exports = { UPDATE_PROTOCOL, createInitialState, releaseAssetNames, isSharedUserDataPath, packageStructured };
