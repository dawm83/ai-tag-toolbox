'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const UPDATE_PROTOCOL = 1;
function text(value, fallback = '') { const output = value == null ? '' : String(value).trim(); return output || fallback; }
function version(value) { const raw = text(value).replace(/^v/i, ''); return /^\d+\.\d+\.\d+$/.test(raw) ? raw : ''; }
function fileList(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? fileList(path.join(dir, entry.name)) : [path.join(dir, entry.name)]); }
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

async function packageStructured(templateArg, stagingArg, versionArg, asarModuleArg) {
  const template = path.resolve(templateArg), source = path.resolve(__dirname, '..'), stage = path.resolve(stagingArg), parsed = version(versionArg);
  if (!parsed) throw new Error('Version must be major.minor.patch');
  const workRoot = path.join(source, 'work');
  if (!stage.startsWith(workRoot + path.sep) || fs.existsSync(stage)) throw new Error('Staging must be a new directory inside work');
  execFileSync('git', ['diff', '--exit-code', 'HEAD', '--'], { cwd: source, stdio: 'pipe' });
  const templatePackage = JSON.parse(fs.readFileSync(path.join(template, 'package.json'), 'utf8'));
  const templateVersion = version(templatePackage.version);
  const templateExe = path.join(template, `AI绘画Tag工具箱V${templateVersion}.exe`);
  if (!templateVersion || !fs.existsSync(templateExe)) throw new Error('Template executable does not match its package version');
  const currentPackage = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  if (currentPackage.version !== parsed) throw new Error('Requested slot version does not match the committed source version');
  const asar = require(path.resolve(asarModuleArg));
  fs.mkdirSync(stage, { recursive: true });
  const rootName = `AI绘画Tag工具箱V${parsed}`;
  const root = path.join(stage, rootName), versionRoot = path.join(root, 'versions', `V${parsed}`);
  fs.mkdirSync(root, { recursive: true });
  fs.cpSync(template, versionRoot, { recursive: true });
  const rootFiles = ['.gitignore', 'chrome_100_percent.pak', 'chrome_200_percent.pak', 'd3dcompiler_47.dll', 'ffmpeg.dll', 'icudtl.dat', 'libEGL.dll', 'libGLESv2.dll', 'LICENSES.chromium.html', 'resources.pak', 'snapshot_blob.bin', 'v8_context_snapshot.bin', 'vk_swiftshader_icd.json', 'vk_swiftshader.dll', 'vulkan-1.dll', 'version'];
  for (const name of rootFiles) if (fs.existsSync(path.join(template, name))) fs.copyFileSync(path.join(template, name), path.join(root, name));
  if (fs.existsSync(path.join(template, 'locales'))) fs.cpSync(path.join(template, 'locales'), path.join(root, 'locales'), { recursive: true });
  copySelected(path.join(template, 'resources'), path.join(root, 'resources'), name => name !== 'app.asar' && name !== 'app.asar.unpacked');
  fs.copyFileSync(templateExe, path.join(root, 'AI绘画Tag工具箱.exe'));

  const oldArchive = path.join(template, 'resources', 'app.asar');
  const assembly = path.join(stage, 'business-assembly');
  asar.extractAll(oldArchive, assembly);
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: source, encoding: 'utf8' }).split('\0').filter(Boolean);
  const allowed = name => /^(assets|src|locales|docs|scripts|tests)\//.test(name) || (!name.includes('/') && /\.(?:md|txt|js|json)$/.test(name)) || name === '.gitignore';
  const files = tracked.filter(allowed);
  for (const directory of ['app', 'resources/app']) {
    const destination = path.join(versionRoot, directory);
    fs.rmSync(destination, { recursive: true, force: true });
    fs.mkdirSync(destination, { recursive: true });
  }
  for (const relative of files) {
    for (const targetRoot of [assembly, path.join(versionRoot, 'app'), path.join(versionRoot, 'resources', 'app')]) {
      const destination = path.join(targetRoot, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(source, relative), destination);
    }
    if (!relative.includes('/')) fs.copyFileSync(path.join(source, relative), path.join(versionRoot, relative));
  }
  const sourceExecutable = path.join(versionRoot, `AI绘画Tag工具箱V${templateVersion}.exe`);
  const versionedExecutable = path.join(versionRoot, `AI绘画Tag工具箱V${parsed}.exe`);
  if (templateVersion !== parsed) fs.renameSync(sourceExecutable, versionedExecutable);

  const businessArchive = path.join(versionRoot, 'resources', 'app.asar');
  fs.rmSync(`${businessArchive}.unpacked`, { recursive: true, force: true });
  await asar.createPackageWithOptions(assembly, businessArchive, { unpackDir: 'node_modules' });
  for (const relative of files) {
    const expected = hash(path.join(source, relative));
    for (const mirror of [path.join(versionRoot, 'app'), path.join(versionRoot, 'resources', 'app')]) {
      if (hash(path.join(mirror, relative)) !== expected) throw new Error(`Source mirror mismatch: ${relative}`);
    }
    if (crypto.createHash('sha256').update(asar.extractFile(businessArchive, path.normalize(relative))).digest('hex') !== expected) throw new Error(`ASAR source mismatch: ${relative}`);
  }
  const modelFiles = fileList(path.join(template, 'models'));
  for (const filename of modelFiles) {
    if (hash(filename) !== hash(path.join(versionRoot, path.relative(template, filename)))) throw new Error(`Model mismatch: ${path.relative(template, filename)}`);
  }
  if (hash(templateExe) !== hash(versionedExecutable)) throw new Error('Versioned executable differs from the verified Electron template');

  const launcherAssembly = path.join(stage, 'launcher-assembly');
  fs.mkdirSync(path.join(launcherAssembly, 'launcher'), { recursive: true }); fs.mkdirSync(path.join(launcherAssembly, 'src', 'modules'), { recursive: true });
  fs.copyFileSync(path.join(source, 'launcher', 'package.json'), path.join(launcherAssembly, 'package.json'));
  fs.copyFileSync(path.join(source, 'launcher', 'main.js'), path.join(launcherAssembly, 'launcher', 'main.js'));
  for (const name of ['version-launcher.js', 'version-manager.js']) fs.copyFileSync(path.join(source, 'src', 'modules', name), path.join(launcherAssembly, 'src', 'modules', name));
  const archive = path.join(root, 'resources', 'app.asar');
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  await asar.createPackageWithOptions(launcherAssembly, archive, { unpackDir: 'node_modules' });
  const state = createInitialState(parsed);
  writeAtomic(path.join(root, 'version-state.json'), state);
  const launcherExecutable = path.join(root, 'AI绘画Tag工具箱.exe');
  const checks = JSON.parse(fs.readFileSync(path.join(source, 'deployment-verification.json'), 'utf8')).checks;
  const evidence = { version: parsed, buildKind: 'local-version-manager-test', sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(), runtimeDependenciesReusedFrom: templateVersion, updateProtocol: UPDATE_PROTOCOL, dataSchemaMin: 1, dataSchemaMax: 1, releaseAssets: releaseAssetNames(parsed), structuredRoot: rootName, activeVersion: parsed, sourceFiles: files.length, modelFiles: modelFiles.length, sourceCopiesVerified: ['versions/V' + parsed + '/app', 'versions/V' + parsed + '/resources/app', 'versions/V' + parsed + '/resources/app.asar'], launcherExecutable: 'AI绘画Tag工具箱.exe', launcherArchive: 'resources/app.asar', businessArchiveSha256: hash(businessArchive), launcherArchiveSha256: hash(archive), executableMatchesTemplate: hash(launcherExecutable) === hash(templateExe), checks, published: false, pushed: false };
  if (!evidence.executableMatchesTemplate) throw new Error('Stable launcher executable differs from the verified Electron template');
  fs.writeFileSync(path.join(versionRoot, 'build-info.json'), JSON.stringify({ ...evidence, archiveSha256: evidence.businessArchiveSha256 }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(root, 'build-info.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  return { root, version: parsed, state, evidence };
}

if (require.main === module) {
  const [template, staging, versionArg, asarModule] = process.argv.slice(2);
  if (!template || !staging || !versionArg || !asarModule) { console.error('Usage: node scripts/package-version-manager.cjs TEMPLATE STAGING VERSION ASAR_MODULE'); process.exitCode = 1; }
  else packageStructured(template, staging, versionArg, asarModule).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { UPDATE_PROTOCOL, createInitialState, releaseAssetNames, isSharedUserDataPath, packageStructured };
