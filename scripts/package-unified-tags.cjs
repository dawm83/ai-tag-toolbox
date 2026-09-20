'use strict';

// Local packaging only. Reuse the verified Electron runtime and its native
// dependencies; application source comes exclusively from the committed tree.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const source = path.resolve(__dirname, '..');
const [templateArg, stageArg, asarModule] = process.argv.slice(2);
function assert(value, message) { if (!value) throw new Error(message); }
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fileHash = filename => hash(fs.readFileSync(filename));
function fileList(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? fileList(path.join(dir, entry.name)) : [path.join(dir, entry.name)]); }

async function main() {
  assert(templateArg && stageArg && asarModule, 'Usage: node scripts/package-unified-tags.cjs TEMPLATE STAGING ASAR_MODULE');
  const template = path.resolve(templateArg), stage = path.resolve(stageArg);
  const work = path.join(source, 'work');
  assert(stage.startsWith(work + path.sep) && stage !== template, 'Staging must be inside this repository work directory');
  assert(!fs.existsSync(stage), 'Staging directory must be new');
  execFileSync('git', ['diff', '--exit-code', 'HEAD', '--'], { cwd: source, stdio: 'pipe' });
  const asar = require(path.resolve(asarModule));
  const version = JSON.parse(fs.readFileSync(path.join(source, 'package.json'))).version;
  const oldArchive = path.join(template, 'resources/app.asar');
  const oldPackage = JSON.parse(asar.extractFile(oldArchive, 'package.json').toString());
  const oldExe = path.join(template, `AI绘画Tag工具箱V${oldPackage.version}.exe`);
  assert(fs.existsSync(oldExe), 'Template executable does not match its archive version');
  fs.mkdirSync(stage, { recursive: true });
  const assembled = path.join(stage, 'assembly'), packaged = path.join(stage, `AI绘画Tag工具箱V${version}`);
  fs.cpSync(template, packaged, { recursive: true });
  asar.extractAll(oldArchive, assembled);
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: source, encoding: 'utf8' }).split('\0').filter(Boolean);
  const allowed = name => /^(assets|src|locales|docs|scripts|tests)\//.test(name) || (!name.includes('/') && /\.(?:md|txt|js|json)$/.test(name)) || name === '.gitignore';
  const files = tracked.filter(allowed);
  for (const relative of files) {
    for (const root of [assembled, path.join(packaged, 'app'), path.join(packaged, 'resources/app')]) {
      const destination = path.join(root, relative); fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(source, relative), destination);
    }
    if (!relative.includes('/')) fs.copyFileSync(path.join(source, relative), path.join(packaged, relative));
  }
  const archive = path.join(packaged, 'resources/app.asar');
  await asar.createPackageWithOptions(assembled, archive, { unpackDir: 'node_modules' });
  const exe = path.join(packaged, `AI绘画Tag工具箱V${version}.exe`);
  if (oldPackage.version !== version) fs.renameSync(path.join(packaged, path.basename(oldExe)), exe);
  for (const relative of files) {
    const expected = fileHash(path.join(source, relative));
    for (const root of [path.join(packaged, 'app'), path.join(packaged, 'resources/app')]) assert(fileHash(path.join(root, relative)) === expected, `Source copy mismatch: ${relative}`);
    assert(hash(asar.extractFile(archive, path.normalize(relative))) === expected, `Archive mismatch: ${relative}`);
  }
  let dependencyFilesVerified = 0, unpackedNativeFiles = 0;
  for (const name of asar.listPackage(oldArchive).map(name => name.slice(1))) {
    if (!name.startsWith('node_modules' + path.sep)) continue;
    const previous = asar.statFile(oldArchive, name);
    if (previous.files || previous.link) continue;
    const current = asar.statFile(archive, name);
    assert(current.unpacked === previous.unpacked, `Native dependency layout changed: ${name}`);
    assert(hash(asar.extractFile(oldArchive, name)) === hash(asar.extractFile(archive, name)), `Dependency changed: ${name}`);
    dependencyFilesVerified++; if (name.endsWith('.node') && current.unpacked) unpackedNativeFiles++;
  }
  const modelFiles = fileList(path.join(template, 'models'));
  for (const file of modelFiles) assert(fileHash(file) === fileHash(path.join(packaged, path.relative(template, file))), 'Model mismatch');
  assert(fileHash(exe) === fileHash(oldExe), 'Electron executable changed');
  const seedFile = path.join('assets', '数据资产', '标签', 'unified-tag-base.json');
  const seed = JSON.parse(asar.extractFile(archive, seedFile).toString());
  const evidence = {
    version, buildKind: 'local-unified-tags-test', sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(),
    sourceFiles: files.length, createdAt: new Date().toISOString(), archiveSha256: fileHash(archive),
    sourceCopiesVerified: ['app', 'resources/app', 'resources/app.asar'], dependencyFilesVerified, unpackedNativeFiles,
    runtimeDependenciesReusedFrom: oldPackage.version, modelsPreserved: modelFiles.length, executableMatchesTemplate: true,
    seedFingerprint: seed.fingerprint, tagCount: seed.tags.length, characterCount: seed.characterLinks.length,
    liveProviderVerified: false, realUserDataIncluded: false, published: false, pushed: false
  };
  evidence.checks = JSON.parse(fs.readFileSync(path.join(source, 'deployment-verification.json'), 'utf8')).checks;
  fs.writeFileSync(path.join(packaged, 'build-info.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ packaged, ...evidence }, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
