'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const https = require('node:https');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const {
  RELEASE_API,
  UPDATE_PROTOCOL,
  compareVersions,
  normalizeRelease,
  normalizeState,
  transitionState
} = require('./version-manager');

const execFileAsync = promisify(execFile);

function text(value, fallback = '') {
  const output = value == null ? '' : String(value).trim();
  return output || fallback;
}
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function failure(code, message, details = {}) { return Object.assign(new Error(message), { code, ...details }); }
function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  return value;
}
function relativeSlot(version) { return path.join('versions', `V${version}`); }
function stagingSlot(version, token) { return path.join('.staging', `V${version}-${token}`); }
function safeVersion(value) { const match = text(value).replace(/^v/i, '').match(/^\d+\.\d+\.\d+$/); return match ? match[0] : ''; }
function checksum(value) { return text(value).match(/\b[a-f0-9]{64}\b/i)?.[0].toLowerCase() || ''; }
function githubAssetHost(value) {
  try { const parsed = new URL(String(value)); return parsed.protocol === 'https:' && ['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(parsed.hostname.toLowerCase()); }
  catch { return false; }
}

function openHttpsResponse(url, headers, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(String(url)); } catch { reject(failure('URL_INVALID', '下载地址无效')); return; }
    if (parsed.protocol !== 'https:' || !['github.com', 'api.github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(parsed.hostname.toLowerCase())) {
      reject(failure('URL_REJECTED', '更新只允许从固定 GitHub 地址下载')); return;
    }
    const request = https.get(parsed, { headers }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode || 0)) {
        const next = response.headers.location && new URL(response.headers.location, parsed).toString();
        response.resume();
        if (!next || redirectCount >= 5 || !githubAssetHost(next)) { reject(failure('REDIRECT_REJECTED', '更新下载重定向地址不受允许')); return; }
        openHttpsResponse(next, headers, redirectCount + 1).then(resolve, reject); return;
      }
      resolve(response);
    });
    request.setTimeout?.(60_000, () => request.destroy(failure('NETWORK_TIMEOUT', '连接 GitHub 超时')));
    request.on('error', reject);
  });
}

function requestBuffer(url, options = {}) {
  return new Promise((resolve, reject) => {
    openHttpsResponse(url, { 'User-Agent': 'AI-Tag-Toolbox-Updater', Accept: 'application/vnd.github+json' }).then(response => {
      if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300) {
        response.resume(); reject(failure('HTTP_ERROR', `更新服务返回 HTTP ${response.statusCode || 0}`)); return;
      }
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    }, reject);
    options.signal?.addEventListener?.('abort', () => reject(options.signal.reason || failure('CANCELLED', '下载已取消')), { once: true });
  });
}

async function defaultFetchJson(url, options) { return JSON.parse((await requestBuffer(url, options)).toString('utf8')); }
async function defaultReadText(filename) {
  if (/^https:\/\//i.test(String(filename))) return (await requestBuffer(filename)).toString('utf8');
  return fs.promises.readFile(filename, 'utf8');
}
async function defaultDownloadFile(url, destination, options = {}) {
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destination, { flags: 'wx' });
    openHttpsResponse(url, { 'User-Agent': 'AI-Tag-Toolbox-Updater', Accept: 'application/octet-stream' }).then(response => {
      if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300) {
        response.resume(); output.close(); reject(failure('HTTP_ERROR', `下载返回 HTTP ${response.statusCode || 0}`)); return;
      }
      const total = Number(response.headers['content-length']) || 0; let received = 0;
      response.on('data', chunk => { received += chunk.length; options.onProgress?.({ received, total }); });
      response.pipe(output);
      output.on('finish', () => output.close(() => resolve(destination)));
      response.on('error', error => { output.destroy(); reject(error); });
    }, error => { output.destroy(); reject(error); });
    options.signal?.addEventListener?.('abort', () => { output.destroy(); reject(options.signal.reason || failure('CANCELLED', '下载已取消')); }, { once: true });
  });
}

async function defaultHashFile(filename) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256'), stream = fs.createReadStream(filename);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function defaultExtractZip(archive, destination) {
  await fs.promises.mkdir(destination, { recursive: true });
  try { await execFileAsync('tar.exe', ['-xf', archive, '-C', destination], { windowsHide: true }); }
  catch (error) { throw failure('EXTRACTOR_UNAVAILABLE', `无法解压更新包：${error.message}`); }
}

async function defaultValidateStaged(directory) {
  const locate = async root => {
    if (fs.existsSync(path.join(root, 'package.json'))) return root;
    const children = await fs.promises.readdir(root, { withFileTypes: true });
    const dirs = children.filter(item => item.isDirectory());
    if (dirs.length === 1 && fs.existsSync(path.join(root, dirs[0].name, 'package.json'))) return path.join(root, dirs[0].name);
    throw failure('PACKAGE_INVALID', '更新包根目录缺少 package.json');
  };
  const root = await locate(directory);
  const pkg = JSON.parse(await fs.promises.readFile(path.join(root, 'package.json'), 'utf8'));
  const version = safeVersion(pkg.version);
  const required = ['VERSION.txt', 'resources/app.asar', 'app', 'resources/app', 'models', 'build-info.json'];
  for (const relative of required) if (!fs.existsSync(path.join(root, relative))) throw failure('PACKAGE_INVALID', `更新包缺少 ${relative}`);
  const exe = path.join(root, `AI绘画Tag工具箱V${version}.exe`);
  if (!version || !fs.existsSync(exe)) throw failure('PACKAGE_INVALID', '更新包版本或 EXE 不匹配');
  const buildInfo = JSON.parse(await fs.promises.readFile(path.join(root, 'build-info.json'), 'utf8'));
  if (safeVersion(buildInfo.version) !== version) throw failure('PACKAGE_INVALID', 'build-info 版本不匹配');
  return { root, version, buildInfo };
}

function createUpdateService(options = {}) {
  const rootDir = path.resolve(text(options.rootDir, path.dirname(process.execPath)));
  const statePath = path.resolve(text(options.statePath, path.join(rootDir, 'version-state.json')));
  const downloadDir = path.resolve(text(options.downloadDir, path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'AI绘画Tag工具箱', 'downloads')));
  const userDataDir = path.resolve(text(options.userDataDir, path.join(process.env.APPDATA || path.dirname(process.execPath), 'ai-tag-toolbox-rewrite')));
  const backupRoot = path.resolve(text(options.backupRoot, path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'AI绘画Tag工具箱', 'data-backups')));
  const dataSchema = Number(options.dataSchema) || 1;
  const fetchJson = options.fetchJson || defaultFetchJson;
  const downloadFile = options.downloadFile || defaultDownloadFile;
  const readText = options.readText || defaultReadText;
  const hashFile = options.hashFile || defaultHashFile;
  const extractZip = options.extractZip || defaultExtractZip;
  const validateStaged = options.validateStaged || defaultValidateStaged;
  const readStateFile = options.readState || (async () => {
    try { return JSON.parse(await fs.promises.readFile(statePath, 'utf8')); } catch { return {}; }
  });
  const writeStateFile = options.writeState || (async value => {
    await fs.promises.mkdir(path.dirname(statePath), { recursive: true });
    const temporary = `${statePath}.${crypto.randomUUID()}.tmp`;
    await fs.promises.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
    await fs.promises.rename(temporary, statePath);
  });
  const mkdir = options.mkdir || (directory => fs.promises.mkdir(directory, { recursive: true }));
  const remove = options.remove || (target => fs.promises.rm(target, { recursive: true, force: true }));
  const random = options.random || (() => crypto.randomBytes(4).toString('hex'));
  let releaseCache = null;
  let releaseCacheAt = 0;
  let abortController = null;

  async function getState() { return normalizeState(await readStateFile(), rootDir); }
  async function saveState(value) { const state = normalizeState(value, rootDir); await writeStateFile(state); return state; }
  async function listReleases() {
    const now = Date.now();
    if (!releaseCache || now - releaseCacheAt > 60_000) {
      const raw = await fetchJson(`${RELEASE_API}/releases?per_page=100`);
      releaseCache = Array.isArray(raw) ? raw.map(normalizeRelease).filter(Boolean) : [];
      releaseCacheAt = now;
    }
    const state = await getState();
    const map = new Map(releaseCache.map(item => [item.version, { ...clone(item) }]));
    for (const installed of state.installed) {
      const row = map.get(installed.version) || { version: installed.version, tagName: `v${installed.version}`, name: `V${installed.version}`, channel: 'installed', prerelease: true, draft: false, publishedAt: '', htmlUrl: '', body: '', installable: false, assets: { zip: null, sevenZip: null, zipSha256: null, sevenZipSha256: null, buildInfo: null } };
      map.set(installed.version, { ...row, installed: true, current: installed.version === state.activeVersion, directory: installed.directory });
    }
    return [...map.values()].map(item => ({ ...item, installed: item.installed === true, current: item.version === state.activeVersion })).sort((a, b) => compareVersions(b.version, a.version));
  }
  async function releaseFor(version) {
    const normalized = safeVersion(version); if (!normalized) throw failure('INVALID_VERSION', '目标版本无效');
    const row = (await listReleases()).find(item => item.version === normalized);
    if (!row) throw failure('RELEASE_NOT_FOUND', `没有找到版本 V${normalized}`);
    if (!row.installable) throw failure('RELEASE_NOT_INSTALLABLE', `V${normalized} 缺少新版更新资产`);
    return row;
  }
  async function downloadAndStage(version, downloadOptions = {}) {
    const release = await releaseFor(version), token = text(random(), 'download'), relative = stagingSlot(release.version, token), staging = path.resolve(rootDir, relative), archive = path.join(downloadDir, `${release.assets.zip.name}.${token}.download`);
    abortController?.abort(); abortController = new AbortController();
    const signal = downloadOptions.signal || abortController.signal;
    try {
      await mkdir(downloadDir); await remove(staging); await remove(archive);
      await downloadFile(release.assets.zip.url, archive, { signal, onProgress: downloadOptions.onProgress });
      const expected = checksum(await readText(release.assets.zipSha256.url));
      if (!expected) throw failure('CHECKSUM_INVALID', 'Release 校验文件无有效 SHA-256');
      const actual = text(await hashFile(archive)).toLowerCase();
      if (actual !== expected) throw failure('CHECKSUM_MISMATCH', '更新包 SHA-256 校验失败');
      const buildInfo = JSON.parse(await readText(release.assets.buildInfo.url));
      if (safeVersion(buildInfo.version) !== release.version || Number(buildInfo.updateProtocol || UPDATE_PROTOCOL) > UPDATE_PROTOCOL) throw failure('PACKAGE_INVALID', '更新包协议或版本不兼容');
      const dataMin = Number(buildInfo.dataSchemaMin ?? 1), dataMax = Number(buildInfo.dataSchemaMax ?? dataMin);
      if (!Number.isInteger(dataMin) || !Number.isInteger(dataMax) || dataMin < 1 || dataMax < dataMin || dataSchema < dataMin || dataSchema > dataMax) throw failure('DATA_SCHEMA_INCOMPATIBLE', '当前用户数据版本与目标版本不兼容');
      await extractZip(archive, staging, { signal });
      const validated = await validateStaged(staging);
      if (validated.version !== release.version) throw failure('PACKAGE_INVALID', '解压包版本不匹配');
      return { version: release.version, stagedDirectory: relative, archiveSha256: actual, buildInfo: clone(validated.buildInfo || buildInfo), release: clone(release) };
    } catch (error) {
      await remove(staging).catch(() => {}); throw error?.code ? error : failure('UPDATE_FAILED', error?.message || '更新失败');
    } finally { await remove(archive).catch(() => {}); if (abortController?.signal === signal) abortController = null; }
  }
  async function prepareSwitch(version, stagedDirectory = '') {
    const state = await getState(), target = safeVersion(version);
    if (!target) throw failure('INVALID_VERSION', '目标版本无效');
    const installed = state.installed.some(item => item.version === target);
    const staged = text(stagedDirectory);
    if (!installed && !/^\.staging[\\/]V\d+\.\d+\.\d+(?:-[a-z0-9]+)?$/i.test(staged)) throw failure('VERSION_NOT_READY', '目标版本尚未安装或准备完成');
    const backupDirectory = path.join(backupRoot, `version-switch-${state.activeVersion || 'unknown'}-to-${target}-${new Date().toISOString().replace(/[:.]/g, '-')}-${random()}`);
    if (fs.existsSync(userDataDir)) {
      await mkdir(backupDirectory);
      if (options.backupData) await options.backupData(userDataDir, backupDirectory);
      else await fs.promises.cp(userDataDir, backupDirectory, { recursive: true, errorOnExist: true, force: false, filter: source => path.resolve(source) !== path.resolve(backupRoot) });
      await fs.promises.writeFile(path.join(backupDirectory, 'version-backup.json'), JSON.stringify({ fromVersion: state.activeVersion, toVersion: target, createdAt: new Date().toISOString(), dataSchema }, null, 2) + '\n', 'utf8');
    }
    const next = transitionState(state, { type: 'prepare', targetVersion: target, pendingDirectory: staged });
    return saveState(next);
  }
  async function switchInstalled(version) {
    const state = await getState(), target = safeVersion(version);
    if (!state.installed.some(item => item.version === target)) throw failure('VERSION_NOT_INSTALLED', `V${target} 尚未安装`);
    return prepareSwitch(target);
  }
  function cancelDownload() { abortController?.abort(failure('CANCELLED', '下载已取消')); }
  return Object.freeze({ getState, listReleases, downloadAndStage, prepareSwitch, switchInstalled, cancelDownload, rootDir, statePath });
}

module.exports = { createUpdateService };
