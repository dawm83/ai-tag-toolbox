'use strict';

// Validation is pure: no normalization, filesystem access, mutation, or command execution.
const LIMITS = Object.freeze({ id: 1024, name: 256, structureName: 80, content: 32768, note: 4096, aliases: 64, collection: 200000 });
const PATCH_FIELDS = ['kind', 'content', 'displayName', 'aliases', 'note', 'adult', 'searchable', 'categoryId', 'subcategoryId'];
const TAG_FIELDS = ['id', ...PATCH_FIELDS, 'usages', 'source', 'revision', 'createdAt', 'updatedAt'];
const USAGES = ['general', 'characterIdentity', 'seriesIdentity', 'characterSpecific'];
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const object = o => o !== null && typeof o === 'object' && !Array.isArray(o) && [Object.prototype, null].includes(Object.getPrototypeOf(o));
function fail(path, code = 'INVALID_FIELD') { throw { validation: true, code, path }; }
function shape(o, required, optional, path) {
  if (!object(o)) fail(path);
  const allowed = new Set([...required, ...optional]);
  if (required.some(k => !own(o, k)) || Object.keys(o).some(k => !allowed.has(k))) fail(path);
}
function str(v, path, max = LIMITS.name, nonempty = true) { if (typeof v !== 'string' || v.length > max || (nonempty && !v.trim()) || v.includes('\0')) fail(path); }
function id(v, path) { str(v, path, LIMITS.id); }
function integer(v, path) { if (!Number.isSafeInteger(v) || v < 0) fail(path); }
function boolean(v, path) { if (typeof v !== 'boolean') fail(path); }
function enumeration(v, values, path) { if (!values.includes(v)) fail(path); }
function array(v, path, max = LIMITS.collection) { if (!Array.isArray(v) || v.length > max) fail(path); }
function ids(v, path) { array(v, path); const seen = new Set(); for (const item of v) { id(item, path); if (seen.has(item)) fail(path); seen.add(item); } }
function color(v, path) { if (typeof v !== 'string' || !/^#[0-9a-f]{6}$/i.test(v)) fail(path); }
function result(data, fn) {
  try { fn(); return { ok: true, data }; }
  catch (error) {
    if (!error?.validation) throw error;
    return { ok: false, error: { code: error.code, message: '标签库数据校验失败', fields: [error.path] } };
  }
}
function jsonSafe(value, path, ancestors = new WeakSet(), depth = 0) {
  if (depth > 100) fail(path, 'INVALID_DOCUMENT');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || ancestors.has(value)) fail(path, 'INVALID_DOCUMENT');
  const isArray = Array.isArray(value);
  if (!isArray && !object(value)) fail(path, 'INVALID_DOCUMENT');
  const keys = Reflect.ownKeys(value);
  if (isArray && keys.length !== value.length + 1) fail(path, 'INVALID_DOCUMENT');
  ancestors.add(value);
  for (const key of keys) {
    if (isArray && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor.enumerable || !own(descriptor, 'value')) fail(path, 'INVALID_DOCUMENT');
    if (isArray && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) fail(path, 'INVALID_DOCUMENT');
    jsonSafe(descriptor.value, path, ancestors, depth + 1);
  }
  ancestors.delete(value);
}
function patch(p, path, allowed = PATCH_FIELDS) {
  shape(p, [], allowed, path);
  for (const [k, v] of Object.entries(p)) {
    const field = `${path}.${k}`;
    if (k === 'kind') enumeration(v, ['tag', 'bundle'], field);
    else if (k === 'content') str(v, field, LIMITS.content);
    else if (k === 'displayName') str(v, field, LIMITS.name, false);
    else if (k === 'note') str(v, field, LIMITS.note, false);
    else if (k === 'aliases') { array(v, field, LIMITS.aliases); const seen = new Set(); for (const alias of v) { str(alias, field); if (seen.has(alias)) fail(field); seen.add(alias); } }
    else if (['adult', 'searchable'].includes(k)) boolean(v, field);
    else id(v, field);
  }
}
function tag(t, path) {
  shape(t, TAG_FIELDS, [], path); id(t.id, `${path}.id`);
  patch(Object.fromEntries(PATCH_FIELDS.map(k => [k, t[k]])), path);
  ids(t.usages, `${path}.usages`);
  for (const usage of t.usages) enumeration(usage, USAGES, `${path}.usages`);
  shape(t.source, ['kind', 'key'], [], `${path}.source`);
  enumeration(t.source.kind, ['bundled', 'custom', 'legacyFavorite'], `${path}.source.kind`);
  if (t.source.key !== null) str(t.source.key, `${path}.source.key`, LIMITS.name);
  for (const k of ['revision', 'createdAt', 'updatedAt']) integer(t[k], `${path}.${k}`);
  if (t.updatedAt < t.createdAt) fail(`${path}.updatedAt`);
}
function category(c, path, child = false) {
  shape(c, ['id', 'name', 'order', 'source', ...(child ? ['categoryId'] : [])], [], path);
  id(c.id, path); str(c.name, path, LIMITS.structureName); integer(c.order, path); enumeration(c.source, ['bundled', 'custom'], path);
  if (child) id(c.categoryId, path);
}
function links(l, path) {
  shape(l, ['characterId', 'identityTagId', 'seriesTagIds', 'generalTagIds', 'specificTagIds'], [], path);
  id(l.characterId, path); id(l.identityTagId, path);
  for (const k of ['seriesTagIds', 'generalTagIds', 'specificTagIds']) ids(l[k], `${path}.${k}`);
}
function selection(s, path) {
  if (!object(s)) fail(path);
  if (s.kind === 'tag') { shape(s, ['kind', 'tagId'], [], path); id(s.tagId, path); }
  else if (s.kind === 'character') { shape(s, ['kind', 'characterId', 'includeSeries', 'generalTagIds', 'specificTagIds'], [], path); id(s.characterId, path); boolean(s.includeSeries, path); ids(s.generalTagIds, path); ids(s.specificTagIds, path); }
  else if (s.kind === 'legacySnapshot') { shape(s, ['kind', 'id', 'content', 'displayName', 'adult'], [], path); id(s.id, path); str(s.content, path, LIMITS.content); str(s.displayName, path, LIMITS.name, false); boolean(s.adult, path); }
  else fail(path);
}
function indexed(rows, validate, path, key = 'id') {
  array(rows, path); const map = new Map();
  rows.forEach((row, i) => { validate(row, `${path}[${i}]`); if (map.has(row[key])) fail(path); map.set(row[key], row); });
  return map;
}
function ref(map, key, path) { if (!map.has(key)) fail(path, 'UNRESOLVED_REFERENCE'); return map.get(key); }
function orders(map, parent, path) {
  const seen = new Map();
  for (const row of map.values()) { const key = parent ? row[parent] : ''; if (!seen.has(key)) seen.set(key, new Set()); const used = seen.get(key); if (used.has(row.order)) fail(path); used.add(row.order); }
}
function taxonomy(tags, categories, subs) {
  orders(categories, null, 'categories.order'); orders(subs, 'categoryId', 'subcategories.order');
  for (const s of subs.values()) ref(categories, s.categoryId, 'subcategories.categoryId');
  for (const t of tags.values()) {
    ref(categories, t.categoryId, 'tags.categoryId');
    if (ref(subs, t.subcategoryId, 'tags.subcategoryId').categoryId !== t.categoryId) fail('tags.subcategoryId', 'INVALID_PARENT');
  }
}
function linkReferences(characters, tags) {
  for (const l of characters.values()) for (const tagId of [l.identityTagId, ...l.seriesTagIds, ...l.generalTagIds, ...l.specificTagIds]) {
    if (ref(tags, tagId, 'characterLinks').kind !== 'tag') fail('characterLinks', 'TAG_IN_USE');
  }
}
function idMap(value, path) {
  if (!object(value)) fail(path);
  for (const [key, target] of Object.entries(value)) { id(key, path); id(target, path); }
}
function mapReferences(value, map, path) {
  idMap(value, path);
  for (const target of Object.values(value)) ref(map, target, path);
}
function baseIndexes(base) {
  shape(base, ['tags', 'categories', 'subcategories', 'characterLinks', 'legacyIds', 'fingerprint'], ['metadataById', 'characterInfo'], 'base');
  str(base.fingerprint, 'base.fingerprint');
  const tags = indexed(base.tags, tag, 'base.tags');
  const categories = indexed(base.categories, category, 'base.categories');
  const subs = indexed(base.subcategories, (v, p) => category(v, p, true), 'base.subcategories');
  const characters = indexed(base.characterLinks, links, 'base.characterLinks', 'characterId');
  for (const t of tags.values()) if (t.source.kind !== 'bundled') fail('base.tags.source');
  for (const c of categories.values()) if (c.source !== 'bundled') fail('base.categories.source');
  for (const s of subs.values()) if (s.source !== 'bundled') fail('base.subcategories.source');
  taxonomy(tags, categories, subs); linkReferences(characters, tags);
  shape(base.legacyIds, ['ordinary', 'characters', 'series', 'specific', 'subcategories'], [], 'base.legacyIds');
  for (const k of ['ordinary', 'characters', 'series', 'specific']) mapReferences(base.legacyIds[k], tags, `base.legacyIds.${k}`);
  // Tuple keys deliberately contain full original category/name values, not editable IDs.
  if (!object(base.legacyIds.subcategories)) fail('base.legacyIds.subcategories');
  for (const v of Object.values(base.legacyIds.subcategories)) ref(subs, v, 'base.legacyIds.subcategories');
  if (base.metadataById !== undefined) {
    if (!object(base.metadataById)) fail('base.metadataById');
    for (const [key, m] of Object.entries(base.metadataById)) {
      ref(tags, key, 'base.metadataById'); shape(m, ['count', 'categoryCode', 'confidence'], ['keywords', 'review'], 'base.metadataById');
      for (const k of ['count', 'categoryCode', 'confidence']) if (m[k] !== null && (typeof m[k] !== 'number' || !Number.isFinite(m[k]))) fail('base.metadataById');
      if (m.keywords !== undefined) { array(m.keywords, 'base.metadataById.keywords'); for (const v of m.keywords) str(v, 'base.metadataById.keywords'); }
      if (m.review !== undefined) boolean(m.review, 'base.metadataById.review');
    }
  }
  if (base.characterInfo !== undefined) {
    if (!object(base.characterInfo)) fail('base.characterInfo');
    for (const [key, c] of Object.entries(base.characterInfo)) {
      ref(characters, key, 'base.characterInfo'); shape(c, ['count', 'order', 'fallback', 'sourceKey', 'sourceTrigger'], [], 'base.characterInfo');
      if (typeof c.count !== 'number' || !Number.isFinite(c.count) || c.count < 0) fail('base.characterInfo.count');
      integer(c.order, 'base.characterInfo.order'); boolean(c.fallback, 'base.characterInfo.fallback'); str(c.sourceKey, 'base.characterInfo.sourceKey'); str(c.sourceTrigger, 'base.characterInfo.sourceTrigger', LIMITS.content, false);
    }
  }
  return { tags, categories, subs, characters };
}
const DOCUMENT_FIELDS = ['schemaVersion', 'libraryId', 'revision', 'baseFingerprint', 'customTags', 'tagOverrides', 'customCategories', 'customSubcategories', 'categoryOverrides', 'subcategoryOverrides', 'favoritePages', 'favoriteGroups', 'memberships', 'characterOverrides', 'selection', 'recentTagIds', 'migration', 'unresolved'];
function documentStructure(doc) {
  if (!object(doc)) fail('document', 'INVALID_DOCUMENT');
  jsonSafe(doc, 'document');
  if (doc.schemaVersion !== 2) fail('schemaVersion', 'UNSUPPORTED_VERSION');
  shape(doc, DOCUMENT_FIELDS, [], 'document'); id(doc.libraryId, 'libraryId'); integer(doc.revision, 'revision'); str(doc.baseFingerprint, 'baseFingerprint');
  const customCategories = indexed(doc.customCategories, category, 'customCategories');
  const customSubcategories = indexed(doc.customSubcategories, (v, p) => category(v, p, true), 'customSubcategories');
  for (const c of doc.customCategories) if (c.source !== 'custom') fail('customCategories.source');
  for (const s of doc.customSubcategories) if (s.source !== 'custom') fail('customSubcategories.source');
  const customTags = indexed(doc.customTags, tag, 'customTags');
  for (const t of doc.customTags) if (t.source.kind === 'bundled') fail('customTags.source');
  const structureOverride = (o, p) => { shape(o, ['id'], ['name', 'order'], p); id(o.id, p); if (own(o, 'name')) str(o.name, p, LIMITS.structureName); if (own(o, 'order')) integer(o.order, p); };
  const categoryOverrides = indexed(doc.categoryOverrides, structureOverride, 'categoryOverrides');
  const subcategoryOverrides = indexed(doc.subcategoryOverrides, structureOverride, 'subcategoryOverrides');
  const tagOverrides = indexed(doc.tagOverrides, (o, p) => { shape(o, ['tagId', 'patch', 'revision', 'updatedAt'], [], p); id(o.tagId, p); patch(o.patch, p); integer(o.revision, p); integer(o.updatedAt, p); }, 'tagOverrides', 'tagId');
  const pages = indexed(doc.favoritePages, (p, field) => { shape(p, ['id', 'name', 'order', 'color', 'colorMode'], [], field); id(p.id, field); str(p.name, field, LIMITS.structureName); integer(p.order, field); color(p.color, field); enumeration(p.colorMode, ['auto', 'custom'], field); }, 'favoritePages');
  const groups = indexed(doc.favoriteGroups, (g, field) => { shape(g, ['id', 'pageId', 'name', 'order', 'color'], [], field); id(g.id, field); id(g.pageId, field); str(g.name, field, LIMITS.structureName); integer(g.order, field); color(g.color, field); }, 'favoriteGroups');
  const pairs = new Map();
  const memberships = indexed(doc.memberships, (m, field) => {
    shape(m, ['id', 'tagId', 'groupId', 'order', 'pinned'], [], field); id(m.id, field); id(m.tagId, field); id(m.groupId, field); integer(m.order, field); boolean(m.pinned, field);
    if (!pairs.has(m.groupId)) pairs.set(m.groupId, new Set()); const set = pairs.get(m.groupId); if (set.has(m.tagId)) fail(field); set.add(m.tagId);
  }, 'memberships');
  orders(pages, null, 'favoritePages.order'); orders(groups, 'pageId', 'favoriteGroups.order'); orders(memberships, 'groupId', 'memberships.order');
  const charOverrides = indexed(doc.characterOverrides, links, 'characterOverrides', 'characterId');
  array(doc.selection, 'selection'); const selected = new Set();
  for (const s of doc.selection) {
    selection(s, 'selection'); const key = JSON.stringify([s.kind, s.tagId || s.characterId || s.id]); if (selected.has(key)) fail('selection'); selected.add(key);
  }
  ids(doc.recentTagIds, 'recentTagIds');
  indexed(doc.unresolved, (u, p) => { shape(u, ['id', 'sourceKey', 'sourceId', 'reason', 'payload'], [], p); id(u.id, p); str(u.sourceKey, p); if (u.sourceId !== null) id(u.sourceId, p); str(u.reason, p); }, 'unresolved');
  if (doc.migration !== null) {
    const m = doc.migration; shape(m, ['id', 'sourceFingerprint', 'completedAt', 'tagIdMap', 'favoriteIdMap', 'characterIdMap', 'counts'], [], 'migration');
    id(m.id, 'migration.id'); str(m.sourceFingerprint, 'migration.sourceFingerprint'); integer(m.completedAt, 'migration.completedAt');
    idMap(m.tagIdMap, 'migration.tagIdMap'); idMap(m.favoriteIdMap, 'migration.favoriteIdMap'); idMap(m.characterIdMap, 'migration.characterIdMap');
    const counts = ['sourceTags', 'sourceFavorites', 'linkedFavorites', 'independentFavorites', 'unresolved']; shape(m.counts, counts, [], 'migration.counts'); for (const k of counts) integer(m.counts[k], 'migration.counts');
  }
  return { customCategories, customSubcategories, customTags, categoryOverrides, subcategoryOverrides, tagOverrides, pages, groups, memberships, charOverrides };
}
function document(doc, base) {
  const structure = documentStructure(doc);
  const { tags, categories, subs, characters } = baseIndexes(base);
  if (doc.baseFingerprint !== base.fingerprint) fail('baseFingerprint', 'INVALID_DOCUMENT');
  function append(added, map, field) { for (const [key, row] of added) { if (map.has(key)) fail(field); map.set(key, row); } }
  append(structure.customCategories, categories, 'customCategories');
  append(structure.customSubcategories, subs, 'customSubcategories');
  append(structure.customTags, tags, 'customTags');
  for (const [field, map, overrides] of [['categoryOverrides', categories, structure.categoryOverrides], ['subcategoryOverrides', subs, structure.subcategoryOverrides]]) {
    for (const [key, override] of overrides) map.set(key, { ...ref(map, key, field), ...override });
  }
  for (const [key, override] of structure.tagOverrides) {
    const next = { ...ref(tags, key, 'tagOverrides.tagId'), ...override.patch, revision: override.revision, updatedAt: override.updatedAt };
    tag(next, 'tagOverrides'); tags.set(key, next);
  }
  taxonomy(tags, categories, subs);
  for (const group of structure.groups.values()) ref(structure.pages, group.pageId, 'favoriteGroups');
  for (const membership of structure.memberships.values()) { ref(tags, membership.tagId, 'memberships'); ref(structure.groups, membership.groupId, 'memberships'); }
  for (const [key, linksValue] of structure.charOverrides) { ref(characters, key, 'characterOverrides.characterId'); characters.set(key, linksValue); }
  linkReferences(characters, tags);
  for (const selected of doc.selection) {
    if (selected.kind === 'tag') ref(tags, selected.tagId, 'selection.tagId');
    if (selected.kind === 'character') {
      const character = ref(characters, selected.characterId, 'selection.characterId');
      for (const field of ['generalTagIds', 'specificTagIds']) { const available = new Set(character[field]); for (const value of selected[field]) if (!available.has(value)) fail(`selection.${field}`, 'UNRESOLVED_REFERENCE'); }
    }
  }
  for (const value of doc.recentTagIds) ref(tags, value, 'recentTagIds');
  if (doc.migration !== null) {
    mapReferences(doc.migration.tagIdMap, tags, 'migration.tagIdMap');
    mapReferences(doc.migration.favoriteIdMap, structure.memberships, 'migration.favoriteIdMap');
    mapReferences(doc.migration.characterIdMap, characters, 'migration.characterIdMap');
  }
}
function choice(c, path) {
  if (!object(c)) fail(path);
  if (own(c, 'id')) { shape(c, ['id'], [], path); id(c.id, path); }
  else { shape(c, ['create'], [], path); shape(c.create, ['name'], [], path); str(c.create.name, path, LIMITS.structureName); }
}
function placement(p, path, favoriteOnly = false) {
  if (!object(p)) fail(path);
  if (p.kind === 'taxonomy' && !favoriteOnly) { shape(p, ['kind', 'category', 'subcategory'], [], path); choice(p.category, path); choice(p.subcategory, path); }
  else if (p.kind === 'favorite') { shape(p, ['kind', 'page', 'group'], ['membershipId'], path); choice(p.page, path); choice(p.group, path); if (own(p, 'membershipId')) id(p.membershipId, path); }
  else fail(path);
}
function command(c, path = 'command', batch = false) {
  if (!object(c)) fail(path);
  const fields = {
    saveTag: [['patch'], ['tagId', 'placement', 'allowIndependent']], favoriteTag: [['tagId', 'placement'], []], unfavorite: [['membershipIds'], []], move: [['tagId', 'placement'], []],
    restoreTag: [['tagId'], []], deleteTag: [['tagId'], []], saveCategory: [['name'], ['id']], saveSubcategory: [['categoryId', 'name'], ['id']], savePage: [['name'], ['id', 'color', 'colorMode']], saveGroup: [['pageId', 'name'], ['id', 'color']],
    deleteGroup: [['groupId', 'mode'], []], deletePage: [['pageId', 'mode'], []], saveCharacterLinks: [['links'], []], editCharacter: [['characterId'], ['identityPatch', 'links']], select: [['value', 'selected'], []], clearSelection: [[], ['kind']], markCopied: [['tagIds'], []],
    batch: [['operations'], []], reorder: [['kind', 'parentId', 'ids'], []], duplicateTag: [['tagId'], ['placement']], applyImport: [['previewId'], []], undo: [[], []], redo: [[], []],
    setFlags: [['tagIds'], ['adult', 'searchable']], pin: [['membershipIds', 'pinned'], []], colorPages: [['pageIds', 'colorMode'], ['color']]
  };
  if (!own(fields, c.type)) fail(path);
  const batchTypes = ['move', 'unfavorite', 'setFlags', 'pin', 'colorPages'];
  if ((batch && !batchTypes.includes(c.type)) || (!batch && ['setFlags', 'pin', 'colorPages'].includes(c.type))) fail(path);
  const [required, optional] = fields[c.type]; shape(c, ['type', ...required], optional, path);
  for (const k of ['id', 'tagId', 'categoryId', 'pageId', 'groupId', 'characterId', 'previewId']) if (own(c, k)) id(c[k], `${path}.${k}`);
  for (const k of ['membershipIds', 'tagIds', 'pageIds', 'ids']) if (own(c, k)) ids(c[k], `${path}.${k}`);
  for (const k of ['allowIndependent', 'selected', 'adult', 'searchable', 'pinned']) if (own(c, k)) boolean(c[k], `${path}.${k}`);
  if (own(c, 'name')) str(c.name, `${path}.name`, LIMITS.structureName);
  if (own(c, 'color')) color(c.color, `${path}.color`);
  if (own(c, 'colorMode')) enumeration(c.colorMode, ['auto', 'custom'], `${path}.colorMode`);
  if (own(c, 'mode')) enumeration(c.mode, ['relocate', 'unfavorite'], `${path}.mode`);
  if (own(c, 'placement')) placement(c.placement, `${path}.placement`, c.type === 'favoriteTag');
  if (c.type === 'saveTag') patch(c.patch, `${path}.patch`);
  if (own(c, 'identityPatch')) patch(c.identityPatch, `${path}.identityPatch`, ['content', 'displayName', 'aliases', 'note', 'adult', 'searchable']);
  if (own(c, 'links')) { links(c.links, `${path}.links`); if (c.type === 'editCharacter' && c.links.characterId !== c.characterId) fail(`${path}.links.characterId`); }
  if (c.type === 'editCharacter' && !own(c, 'identityPatch') && !own(c, 'links')) fail(path);
  if (c.type === 'select') selection(c.value, `${path}.value`);
  if (c.type === 'clearSelection' && own(c, 'kind')) enumeration(c.kind, ['tag', 'character', 'legacySnapshot'], `${path}.kind`);
  if (c.type === 'batch') { array(c.operations, `${path}.operations`, 10000); if (!c.operations.length) fail(path); c.operations.forEach((o, i) => command(o, `${path}.operations[${i}]`, true)); }
  if (c.type === 'setFlags' && !own(c, 'adult') && !own(c, 'searchable')) fail(path);
  if (c.type === 'colorPages' && c.colorMode === 'custom' && !own(c, 'color')) fail(path);
  if (c.type === 'reorder') { enumeration(c.kind, ['page', 'group', 'membership'], `${path}.kind`); if (c.kind === 'page') { if (c.parentId !== null) fail(path); } else id(c.parentId, `${path}.parentId`); }
}

module.exports = {
  LIMITS,
  validateTag: value => result(value, () => tag(value, 'tag')),
  validateBase: value => result(value, () => baseIndexes(value)),
  validateLibraryDocumentStructure: value => result(value, () => documentStructure(value)),
  validateLibraryDocument: (value, base) => result(value, () => document(value, base)),
  validateCommand: value => result(value, () => command(value))
};
