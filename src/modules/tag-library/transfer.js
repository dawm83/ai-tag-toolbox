'use strict';
const { validateLibraryRow, LIMITS } = require('./schema');
const { clone, equal, createProjection } = require('./projection');
const { diffDocuments, changeFor } = require('./history');
const { prepareLegacyMigration } = require('./migration');
const { validateFavoriteBundle, parseFavoritePaste } = require('../favorites-transfer');
const zlib = require('node:zlib');
const FILE_LIMIT = 32 * 1024 * 1024, EXPANDED_LIMIT = 128 * 1024 * 1024;
const fail = (code, message = '标签库备份数据无效') => ({ ok: false, error: { code, message } });
const ok = data => ({ ok: true, data });
const fields = ['kind', 'content', 'displayName', 'aliases', 'note', 'adult', 'searchable', 'categoryId', 'subcategoryId'];
const bundleKeys = ['format', 'version', 'scope', 'tags', 'categories', 'subcategories', 'pages', 'groups', 'memberships', 'characters'];
const normalizedName = name => name.trim().toLocaleLowerCase('en-US');
// Reject getters/toJSON/non-JSON data, counting UTF-8 before serialization.
function checkedJson(value, limit = EXPANDED_LIMIT) {
  let size = 0; const ancestors = new Set();
  function add(n) { size += n; if (size > limit) throw 'IMPORT_TOO_LARGE'; }
  function walk(v, depth = 0) {
    if (depth > 100) throw 'INVALID_DOCUMENT';
    if (v === null || typeof v === 'boolean' || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) { add(Buffer.byteLength(JSON.stringify(v), 'utf8')); return; }
    if (!v || typeof v !== 'object' || ancestors.has(v)) throw 'INVALID_DOCUMENT';
    const array = Array.isArray(v);
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(v))) throw 'INVALID_DOCUMENT';
    const keys = Reflect.ownKeys(v); if (array && keys.length !== v.length + 1) throw 'INVALID_DOCUMENT';
    ancestors.add(v); add(2); let count = 0;
    for (const key of keys) {
      if (array && key === 'length') continue;
      const d = Object.getOwnPropertyDescriptor(v, key);
      if (typeof key !== 'string' || !d.enumerable || !Object.hasOwn(d, 'value')) throw 'INVALID_DOCUMENT';
      if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= v.length)) throw 'INVALID_DOCUMENT';
      if (count++) add(1); if (!array) add(Buffer.byteLength(JSON.stringify(key), 'utf8') + 1);
      walk(d.value, depth + 1);
    }
    ancestors.delete(v);
  }
  try { walk(value); return ok({ bytes: size }); } catch (code) { return fail(typeof code === 'string' ? code : 'INVALID_DOCUMENT', code === 'IMPORT_TOO_LARGE' ? '备份超过允许的展开大小' : undefined); }
}
function projectLibraryBundle({ base, document, scope = 'all' }) {
  if (!['all', 'favorites'].includes(scope)) return fail('INVALID_FIELD', '备份范围无效');
  const p = createProjection(document, base), tagIds = new Set(document.memberships.map(row => row.tagId));
  const tags = [...p.tags()].filter(row => scope === 'all' || tagIds.has(row.id));
  const subIds = new Set(tags.map(row => row.subcategoryId)), catIds = new Set(tags.map(row => row.categoryId));
  const groupIds = new Set(document.memberships.map(row => row.groupId));
  const groups = document.favoriteGroups.filter(row => scope === 'all' || groupIds.has(row.id)), pageIds = new Set(groups.map(row => row.pageId));
  return clone({ format: 'ai-tag-library', version: 2, scope, tags,
    categories: [...p.categories.values()].filter(row => scope === 'all' || catIds.has(row.id)),
    subcategories: [...p.subcategories.values()].filter(row => scope === 'all' || subIds.has(row.id)),
    pages: document.favoritePages.filter(row => scope === 'all' || pageIds.has(row.id)), groups,
    memberships: document.memberships, characters: scope === 'all' ? [...p.characters.values()] : [] });
}
function validateBundle(bundle) {
  const safe = checkedJson(bundle); if (!safe.ok) return safe;
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle) || bundle.format !== 'ai-tag-library') return fail('INVALID_DOCUMENT');
  if (bundle.version !== 2) return fail('UNSUPPORTED_VERSION', '不支持此标签库备份版本');
  if (!['all', 'favorites'].includes(bundle.scope) || Object.keys(bundle).length !== bundleKeys.length || Object.keys(bundle).some(key => !bundleKeys.includes(key))) return fail('INVALID_FIELD');
  const maps = {};
  for (const [key, kind] of [['tags', 'tag'], ['categories', 'category'], ['subcategories', 'subcategory'], ['pages', 'page'], ['groups', 'group'], ['memberships', 'membership'], ['characters', 'links']]) {
    const rows = bundle[key]; if (!Array.isArray(rows) || rows.length > LIMITS.collection) return fail('INVALID_FIELD'); maps[key] = new Map();
    for (const row of rows) { const valid = validateLibraryRow(kind, row); if (!valid.ok) return valid; const id = kind === 'links' ? row.characterId : row.id; if (maps[key].has(id)) return fail('DUPLICATE_ID', '备份包含重复 ID'); maps[key].set(id, row); }
  }
  for (const [key, parent] of [['categories', null], ['subcategories', 'categoryId'], ['pages', null], ['groups', 'pageId'], ['memberships', 'groupId']]) {
    const orders = new Set(); for (const row of bundle[key]) { const order = JSON.stringify([parent ? row[parent] : null, row.order]); if (orders.has(order)) return fail('INVALID_FIELD', '备份排序值重复'); orders.add(order); }
  }
  for (const row of bundle.subcategories) if (!maps.categories.has(row.categoryId)) return fail('INVALID_PARENT');
  for (const row of bundle.tags) if (!maps.categories.has(row.categoryId) || maps.subcategories.get(row.subcategoryId)?.categoryId !== row.categoryId) return fail('INVALID_PARENT');
  for (const row of bundle.groups) if (!maps.pages.has(row.pageId)) return fail('INVALID_PARENT');
  const pairs = new Set();
  for (const row of bundle.memberships) { if (!maps.tags.has(row.tagId) || !maps.groups.has(row.groupId)) return fail('UNRESOLVED_REFERENCE'); const pair = JSON.stringify([row.groupId, row.tagId]); if (pairs.has(pair)) return fail('DUPLICATE_ID'); pairs.add(pair); }
  for (const row of bundle.characters) for (const id of [row.identityTagId, ...row.seriesTagIds, ...row.generalTagIds, ...row.specificTagIds]) if (maps.tags.get(id)?.kind !== 'tag') return fail('UNRESOLVED_REFERENCE');
  if (bundle.scope === 'favorites' && bundle.characters.length) return fail('INVALID_FIELD');
  return ok(bundle);
}
function prepareImportCandidate({ base, document, bundle, ids, now = Date.now }) {
  const safe = checkedJson(bundle); if (!safe.ok) return safe;
  let legacyRows = [], legacyInvalid = 0;
  if (bundle?.format === 'ai-tag-favorites') {
    const valid = validateFavoriteBundle(bundle); if (!valid.ok) return valid;
    // Resolve explicit legacy source IDs against current canonical editable values.
    const p = createProjection(document, base);
    const effectiveBase = { ...base, tags: [...p.tags()].map(row => ({ ...row, source: { kind: 'bundled', key: null } })), categories: [...p.categories.values()].map(row => ({ ...row, source: 'bundled' })), subcategories: [...p.subcategories.values()].map(row => ({ ...row, source: 'bundled' })), characterLinks: [...p.characters.values()] };
    const converted = prepareLegacyMigration({ base: effectiveBase, legacy: { version: 1, values: { favorites_shelf_v1: valid.data } }, ids, now });
    if (!converted.ok) return converted;
    legacyRows = converted.data.document.unresolved;
    legacyInvalid = legacyRows.filter(row => classifyPreservedReason(row.reason) === 'actionable').length;
    bundle = projectLibraryBundle({ base: effectiveBase, document: converted.data.document, scope: 'favorites' });
    // Import retains valid legacy structure even when every old row needs repair.
    bundle.pages = clone(converted.data.document.favoritePages);
    bundle.groups = clone(converted.data.document.favoriteGroups);
  }
  const checked = validateBundle(bundle); if (!checked.ok) return checked;
  const projection = createProjection(document, base), candidate = clone(document), warnings = [];
  const counts = { added: 0, reused: 0, conflicts: 0, invalid: legacyInvalid };
  const details = { membershipsAdded: 0, membershipsReused: 0, pagesAdded: 0, groupsAdded: 0, relationsApplied: 0, relationsPreserved: 0 };
  let overflow = 0;
  const warn = text => { if (warnings.length < 40) warnings.push(text); else overflow++; };
  const generate = (kind, occupied) => { for (let i = 0; i < 100; i++) { const id = ids(kind); if (!occupied.has(id)) return id; } throw new Error('ID_ALLOCATION_FAILED'); };
  function structure(incoming, existing, target, kind, parentField, parentMap) {
    const map = new Map(), occupied = new Map(existing.map(row => [row.id, row]));
    const orders = new Map(), names = new Map(), next = new Map();
    const bucket = row => parentField ? row[parentField] : '';
    const register = row => { const parent = bucket(row); if (!orders.has(parent)) { orders.set(parent, new Set()); names.set(parent, new Set()); } orders.get(parent).add(row.order); names.get(parent).add(normalizedName(row.name)); next.set(parent, Math.max(next.get(parent) || 0, row.order + 1)); };
    existing.forEach(register);
    for (const source of incoming) {
      const row = { ...source, ...(parentField ? { [parentField]: parentMap.get(source[parentField]) } : {}) }, old = occupied.get(source.id);
      const keys = ['name', ...(parentField ? [parentField] : []), ...(['page', 'group'].includes(kind) ? ['color'] : []), ...(kind === 'page' ? ['colorMode'] : [])];
      if (old && keys.every(key => equal(old[key], row[key]))) { map.set(source.id, old.id); if (old.order !== row.order) warn('相同位置已复用，保留本地排序'); continue; }
      if (old) { row.id = generate(kind, occupied); warn('位置 ID 冲突，已保留为独立位置'); }
      const parent = bucket(row), used = names.get(parent) || new Set();
      if (used.has(normalizedName(row.name))) { const original = row.name; let suffix = 2; do { const tail = `（导入 ${suffix++}）`; row.name = original.slice(0, LIMITS.structureName - tail.length) + tail; } while (used.has(normalizedName(row.name))); warn('同名位置已重命名，全部内容保留'); }
      if (orders.get(parent)?.has(row.order)) { row.order = next.get(parent) || 0; warn('位置排序冲突，已追加到末尾'); }
      if (kind === 'category' || kind === 'subcategory') row.source = 'custom';
      target.push(row); occupied.set(row.id, row); register(row); map.set(source.id, row.id);
      if (kind === 'page') details.pagesAdded++; if (kind === 'group') details.groupsAdded++;
    }
    return map;
  }
  try {
    const cats = structure(bundle.categories, [...projection.categories.values()], candidate.customCategories, 'category');
    const subs = structure(bundle.subcategories, [...projection.subcategories.values()], candidate.customSubcategories, 'subcategory', 'categoryId', cats);
    const tagMap = new Map(), tags = new Map([...projection.tags()].map(row => [row.id, row])), time = now();
    for (const source of bundle.tags) {
      const row = { ...clone(source), categoryId: cats.get(source.categoryId), subcategoryId: subs.get(source.subcategoryId) }, old = tags.get(source.id);
      if (old && fields.every(key => equal(row[key], old[key]))) { tagMap.set(source.id, old.id); counts.reused++; continue; }
      if (old) { row.id = generate('tag', tags); counts.conflicts++; warn('标签 ID 的内容或元数据冲突，已另存独立标签'); }
      row.source = { kind: 'custom', key: null }; row.revision = 0; row.createdAt = time; row.updatedAt = time;
      candidate.customTags.push(row); tags.set(row.id, row); tagMap.set(source.id, row.id); counts.added++;
    }
    const pages = structure(bundle.pages, document.favoritePages, candidate.favoritePages, 'page');
    const groups = structure(bundle.groups, document.favoriteGroups, candidate.favoriteGroups, 'group', 'pageId', pages);
    const memberIds = new Set(candidate.memberships.map(row => row.id)), pairs = new Map(), orders = new Map(), next = new Map();
    function addMember(row) { memberIds.add(row.id); pairs.set(JSON.stringify([row.groupId, row.tagId]), row); if (!orders.has(row.groupId)) orders.set(row.groupId, new Set()); orders.get(row.groupId).add(row.order); next.set(row.groupId, Math.max(next.get(row.groupId) || 0, row.order + 1)); }
    candidate.memberships.forEach(addMember);
    for (const source of bundle.memberships) {
      const row = { ...source, tagId: tagMap.get(source.tagId), groupId: groups.get(source.groupId) }, pair = JSON.stringify([row.groupId, row.tagId]);
      if (pairs.has(pair)) { details.membershipsReused++; if (pairs.get(pair).pinned !== row.pinned) warn('收藏归属已复用，保留本地置顶设置'); continue; }
      if (memberIds.has(row.id)) { row.id = generate('membership', memberIds); warn('收藏归属 ID 冲突，已重新分配'); }
      if (orders.get(row.groupId)?.has(row.order)) { row.order = next.get(row.groupId) || 0; warn('收藏排序冲突，已追加到末尾'); }
      candidate.memberships.push(row); addMember(row); details.membershipsAdded++;
    }
    const unresolvedIds = new Set(candidate.unresolved.map(row => row.id));
    const preserve = (reason, sourceId, payload) => { const id = generate('unresolved', unresolvedIds); unresolvedIds.add(id); candidate.unresolved.push({ id, sourceKey: 'library-import', sourceId, reason, payload: clone(payload) }); };
    const originals = new Map(base.characterLinks.map(row => [row.characterId, row]));
    for (const source of bundle.characters) {
      const mapped = { characterId: source.characterId, identityTagId: tagMap.get(source.identityTagId), seriesTagIds: source.seriesTagIds.map(id => tagMap.get(id)), generalTagIds: source.generalTagIds.map(id => tagMap.get(id)), specificTagIds: source.specificTagIds.map(id => tagMap.get(id)) }, current = projection.characters.get(source.characterId);
      if (equal(current, mapped)) continue;
      if (current && !document.characterOverrides.some(row => row.characterId === source.characterId) && equal(current, originals.get(source.characterId))) { candidate.characterOverrides.push(mapped); details.relationsApplied++; }
      else { preserve(current ? 'IMPORT_CHARACTER_CONFLICT' : 'IMPORT_UNKNOWN_CHARACTER', source.characterId, { original: source, mapped }); details.relationsPreserved++; warn(current ? '本地角色关系已有修改，外来关系已保留待处理' : '本机没有此角色，外来关系已保留待处理'); }
    }
    for (const row of legacyRows) { const id = generate('unresolved', unresolvedIds); unresolvedIds.add(id); candidate.unresolved.push({ ...clone(row), id }); }
    if (overflow) warnings.push(`另有 ${overflow} 项同类映射提示`);
    const historyDelta = diffDocuments(document, candidate); candidate.revision = document.revision + (historyDelta.length ? 1 : 0);
    return ok({ document: candidate, preview: { id: ids('preview'), basedOnRevision: document.revision, counts, warnings, details }, change: changeFor(document, candidate, base, historyDelta), historyDelta });
  } catch { return fail('INVALID_DOCUMENT', '无法构建导入候选，当前库未改变'); }
}
function preparePasteBundle({ document, text, options = {}, ids, now }) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > FILE_LIMIT) return fail('IMPORT_TOO_LARGE', '粘贴文本超过 32 MiB');
  const page = document.favoritePages.find(row => row.id === options.seriesId), group = document.favoriteGroups.find(row => row.id === options.sectionId && row.pageId === page?.id);
  if (!page || !group) return fail('INVALID_PARENT', '请选择已有收藏页和收藏组');
  const parsed = parseFavoritePaste(text, options); if (!parsed.ok) return fail(parsed.error.code, '粘贴行格式无效，请检查列数及内容');
  const time = now();
  return ok({ format: 'ai-tag-favorites', version: 1, revision: 0, series: [clone(page)], sections: [{ id: group.id, seriesId: page.id, name: group.name, order: group.order, color: group.color }], entries: parsed.data.entries.map((row, order) => ({ ...row, id: ids('paste'), title: '', aliases: [], note: '', globalSearchable: true, pinned: false, nsfw: false, order, sourceTagId: null, sourceCharacterId: null, createdAt: time, updatedAt: time })) });
}
function classifyPreservedReason(reason) {
  if (['HISTORY_ARCHIVE', 'OLDER_FAVORITES_ARCHIVE', 'CHARACTER_METADATA_ARCHIVE'].includes(reason)) return 'archive';
  if (['INDEPENDENT_FAVORITE_DIFFERENCE', 'OPAQUE_BUNDLE_CONVERSION', 'DUPLICATE_MEMBERSHIP'].includes(reason)) return 'retained';
  return 'actionable';
}
function projectMigrationReport(document, { offset = 0, limit = 100 } = {}) {
  const counts = { linked: document.migration?.counts.linkedFavorites || 0, independent: document.migration?.counts.independentFavorites || 0, archive: 0, retained: 0, actionable: 0 }, reasons = Object.create(null);
  for (const row of document.unresolved) { counts[classifyPreservedReason(row.reason)]++; reasons[row.reason] = (reasons[row.reason] || 0) + 1; }
  offset = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0; limit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100;
  return { counts, reasons, total: document.unresolved.length, offset, limit, hasMore: offset + limit < document.unresolved.length, items: document.unresolved.slice(offset, offset + limit).map(({ id, sourceKey, sourceId, reason }) => ({ id, sourceKey, sourceId, reason, classification: classifyPreservedReason(reason) })) };
}
function encodeDataFile(bundle, stem = 'ai-tag-library') {
  const checked = checkedJson(bundle); if (!checked.ok) return checked;
  const text = JSON.stringify(bundle); const plain = Buffer.from(text, 'utf8');
  if (plain.length <= FILE_LIMIT) return ok({ bytes: new Uint8Array(plain), filename: `${stem}.json`, mimeType: 'application/json' });
  if (plain.length > EXPANDED_LIMIT) return fail('IMPORT_TOO_LARGE', '备份展开后超过 128 MiB');
  const compressed = zlib.gzipSync(plain, { level: 9 });
  if (compressed.length > FILE_LIMIT) return fail('IMPORT_TOO_LARGE', '备份超过 32 MiB 文件限制');
  return ok({ bytes: new Uint8Array(compressed), filename: `${stem}.json.gz`, mimeType: 'application/gzip' });
}
function encodeBundle(bundle) { const checked = validateBundle(bundle); return checked.ok ? encodeDataFile(bundle) : checked; }
function decodeBundle(input) {
  if (typeof input === 'string' && Buffer.byteLength(input, 'utf8') > FILE_LIMIT) return fail('IMPORT_TOO_LARGE', '备份超过 32 MiB 文件限制');
  let bytes; if (typeof input === 'string') bytes = Buffer.from(input, 'utf8'); else if (input instanceof ArrayBuffer) bytes = Buffer.from(input); else if (ArrayBuffer.isView(input)) bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength); else return fail('INVALID_FIELD', '导入内容必须是文本或字节');
  if (bytes.length > FILE_LIMIT) return fail('IMPORT_TOO_LARGE', '备份超过 32 MiB 文件限制');
  let expanded = bytes; try { if (bytes[0] === 0x1f && bytes[1] === 0x8b) expanded = zlib.gunzipSync(bytes, { maxOutputLength: EXPANDED_LIMIT }); } catch (error) { return error?.code === 'ERR_BUFFER_TOO_LARGE' ? fail('IMPORT_TOO_LARGE', '备份展开后超过 128 MiB') : fail('INVALID_DOCUMENT', 'gzip 备份损坏'); }
  if (expanded.length > EXPANDED_LIMIT) return fail('IMPORT_TOO_LARGE', '备份展开后超过 128 MiB');
  let value; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(expanded)); } catch { return fail('INVALID_DOCUMENT', '备份 JSON 无效'); }
  return value?.format === 'ai-tag-favorites' ? validateFavoriteBundle(value) : validateBundle(value);
}
module.exports = { FILE_LIMIT, EXPANDED_LIMIT, checkedJson, projectLibraryBundle, validateBundle, prepareImportCandidate, preparePasteBundle, classifyPreservedReason, projectMigrationReport,
  encodeBundle, encodeDataFile, decodeBundle,
  exportLibrary: (library, options) => library.exportBundle(options), previewLibraryImport: (library, bundle) => library.previewImport(bundle), applyLibraryImport: (library, previewId, options) => library.execute({ type: 'applyImport', previewId }, options) };
