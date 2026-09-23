'use strict';

const RELEASE_REPOSITORY = Object.freeze({ owner: 'star-abyss', name: 'ai-tag-toolbox' });
const RELEASE_API = `https://api.github.com/repos/${RELEASE_REPOSITORY.owner}/${RELEASE_REPOSITORY.name}`;
const UPDATE_PROTOCOL = 1;

function text(value, fallback = '') {
  const output = value == null ? '' : String(value).trim();
  return output || fallback;
}

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function rows(value) { return Array.isArray(value) ? value : []; }
function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  return value;
}
function failure(code, message) { return Object.assign(new Error(message), { code }); }

function parseVersion(value) {
  const raw = text(value).replace(/^v/i, '');
  const match = raw.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return { raw: `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`, major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  if (!a || !b) throw failure('INVALID_VERSION', '版本号必须是主版本.次版本.修补版本');
  for (const key of ['major', 'minor', 'patch']) if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  return 0;
}

function allowedAssetUrl(value) {
  try {
    const url = new URL(text(value));
    const prefix = `/${RELEASE_REPOSITORY.owner}/${RELEASE_REPOSITORY.name}/releases/download/`;
    return url.protocol === 'https:' && url.hostname.toLowerCase() === 'github.com' && url.pathname.startsWith(prefix);
  } catch { return false; }
}

function assetMap(assets) {
  return new Map(rows(assets).filter(item => text(item?.name)).map(item => [text(item.name), item]));
}

function requiredReleaseAssets(version, assets) {
  const parsed = parseVersion(version);
  if (!parsed) throw failure('INVALID_VERSION', 'Release 版本号无效');
  const map = assetMap(assets);
  const names = {
    zip: `AI.Tag.V${parsed.raw}.zip`,
    sevenZip: `AI.Tag.V${parsed.raw}.7z`,
    zipSha256: `AI.Tag.V${parsed.raw}.zip.sha256`,
    sevenZipSha256: `AI.Tag.V${parsed.raw}.7z.sha256`,
    buildInfo: `AI.Tag.V${parsed.raw}.build-info.json`
  };
  const result = {};
  for (const [key, name] of Object.entries(names)) {
    const item = map.get(name);
    if (!item || !allowedAssetUrl(item.browser_download_url)) throw failure('RELEASE_ASSET_MISSING', `缺少或拒绝 Release 资产：${name}`);
    result[key] = { name, size: Number(item.size) || 0, url: item.browser_download_url, contentType: text(item.content_type) };
  }
  return result;
}

function optionalAssets(version, assets) {
  const map = assetMap(assets), parsed = parseVersion(version);
  if (!parsed) return { zip: null, sevenZip: null, zipSha256: null, sevenZipSha256: null, buildInfo: null };
  const names = {
    zip: `AI.Tag.V${parsed.raw}.zip`,
    sevenZip: `AI.Tag.V${parsed.raw}.7z`,
    zipSha256: `AI.Tag.V${parsed.raw}.zip.sha256`,
    sevenZipSha256: `AI.Tag.V${parsed.raw}.7z.sha256`,
    buildInfo: `AI.Tag.V${parsed.raw}.build-info.json`
  };
  return Object.fromEntries(Object.entries(names).map(([key, name]) => {
    const item = map.get(name);
    return [key, item && allowedAssetUrl(item.browser_download_url) ? { name, size: Number(item.size) || 0, url: item.browser_download_url, contentType: text(item.content_type) } : null];
  }));
}

function normalizeRelease(record) {
  if (!object(record)) return null;
  const parsed = parseVersion(record.tag_name || record.name);
  if (!parsed) return null;
  const assets = optionalAssets(parsed.raw, record.assets);
  const installable = Object.values(assets).every(Boolean);
  return {
    version: parsed.raw,
    tagName: text(record.tag_name, `v${parsed.raw}`),
    name: text(record.name, `V${parsed.raw}`),
    channel: record.prerelease === true ? 'prerelease' : 'stable',
    prerelease: record.prerelease === true,
    draft: record.draft === true,
    publishedAt: text(record.published_at || record.created_at),
    htmlUrl: text(record.html_url),
    body: text(record.body),
    installable,
    assets
  };
}

function safeVersion(value) { return parseVersion(value)?.raw || ''; }
function installedRows(value) {
  const seen = new Set();
  return rows(value).map(item => {
    const version = safeVersion(item?.version);
    if (!version || seen.has(version)) return null;
    seen.add(version);
    return {
      version,
      directory: `versions/V${version}`,
      source: text(item?.source, 'download'),
      archiveSha256: text(item?.archiveSha256),
      installedAt: text(item?.installedAt),
      lastLaunch: item?.lastLaunch === 'failed' ? 'failed' : 'ok'
    };
  }).filter(Boolean);
}

function normalizeState(value = {}, installRoot = '') {
  const source = object(value) ? value : {};
  const installed = installedRows(source.installed);
  const activeVersion = safeVersion(source.activeVersion) || installed[0]?.version || '';
  const previousVersion = safeVersion(source.previousVersion);
  const pendingVersion = safeVersion(source.pendingVersion);
  return {
    protocol: Number(source.protocol) === UPDATE_PROTOCOL ? UPDATE_PROTOCOL : UPDATE_PROTOCOL,
    installRoot: text(source.installRoot, text(installRoot)),
    activeVersion,
    previousVersion,
    pendingVersion,
    installed,
    lastError: object(source.lastError) ? clone(source.lastError) : null
  };
}

function transitionState(value, action = {}) {
  const state = normalizeState(value, value?.installRoot);
  const type = text(action.type);
  if (!['prepare', 'commit', 'rollback'].includes(type)) throw failure('INVALID_STATE_ACTION', '未知版本状态操作');
  if (type === 'prepare') {
    const targetVersion = safeVersion(action.targetVersion);
    if (!targetVersion) throw failure('INVALID_VERSION', '切换目标版本无效');
    return { ...state, previousVersion: state.activeVersion, pendingVersion: targetVersion, lastError: null };
  }
  if (type === 'commit') {
    const targetVersion = safeVersion(action.targetVersion || state.pendingVersion);
    if (!targetVersion) throw failure('INVALID_VERSION', '没有待切换版本');
    return { ...state, activeVersion: targetVersion, previousVersion: state.activeVersion || state.previousVersion, pendingVersion: '', lastError: null };
  }
  const fallback = state.previousVersion || state.activeVersion;
  return { ...state, activeVersion: fallback, pendingVersion: '', lastError: object(action.error) ? clone(action.error) : { code: 'UPDATE_ROLLED_BACK', message: '版本切换已回退' } };
}

module.exports = {
  RELEASE_REPOSITORY,
  RELEASE_API,
  UPDATE_PROTOCOL,
  parseVersion,
  compareVersions,
  normalizeRelease,
  normalizeState,
  transitionState,
  requiredReleaseAssets
};
