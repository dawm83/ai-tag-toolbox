'use strict';
const fs = require('node:fs/promises');
const { createHash, randomUUID } = require('node:crypto');
const { createLibraryDocumentValidator, validateLibraryRow } = require('./schema');
const { LEGACY_KEYS } = require('./repository');
const clone = value => structuredClone(value);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const failure = code => Object.assign(new Error('旧标签数据迁移未完成，请检查来源或恢复备份'), { code });
function canonical(v) { return Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : object(v) ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v); }
function filteredInput(input) {
  if (!object(input) || input.version !== 1 || !object(input.values)) throw failure('INVALID_LEGACY_INPUT');
  const values = {};
  // Reject accessors/cycles/non-JSON values without reading unrelated settings.
  function safe(v, ancestors = new Set(), depth = 0) {
    if (depth > 100) throw failure('INVALID_LEGACY_INPUT');
    if (v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return;
    if (typeof v !== 'object' || ancestors.has(v) || (!Array.isArray(v) && ![Object.prototype, null].includes(Object.getPrototypeOf(v)))) throw failure('INVALID_LEGACY_INPUT');
    ancestors.add(v);
    for (const key of Reflect.ownKeys(v)) {
      if (Array.isArray(v) && key === 'length') continue;
      const d = Object.getOwnPropertyDescriptor(v, key);
      if (typeof key !== 'string' || !own(d, 'value') || !d.enumerable) throw failure('INVALID_LEGACY_INPUT');
      safe(d.value, ancestors, depth + 1);
    }
    ancestors.delete(v);
  }
  for (const key of LEGACY_KEYS) if (own(input.values, key)) {
    const d = Object.getOwnPropertyDescriptor(input.values, key);
    if (!own(d, 'value')) throw failure('INVALID_LEGACY_INPUT'); safe(d.value); values[key] = clone(d.value);
  }
  return { version: 1, values };
}
function fingerprintLegacy(input) { return createHash('sha256').update(canonical(filteredInput(input))).digest('hex'); }
async function readLegacyInput(storageFilePath) {
  let raw;
  try { raw = await fs.readFile(storageFilePath, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return { version: 1, values: {} }; throw failure('LEGACY_READ_FAILED'); }
  try {
    const root = JSON.parse(raw); if (!object(root)) throw failure('INVALID_LEGACY_INPUT');
    const values = {};
    for (const key of LEGACY_KEYS) {
      const prefixed = `ai-tag-toolbox-rewrite:app:${key}`;
      if (!own(root, prefixed)) continue;
      if (typeof root[prefixed] !== 'string') throw failure('INVALID_LEGACY_INPUT');
      values[key] = JSON.parse(root[prefixed]);
    }
    return filteredInput({ version: 1, values });
  } catch { throw failure('INVALID_LEGACY_INPUT'); }
}
function emptyMigrationDocument(base, ids) {
  return { schemaVersion: 2, libraryId: ids('library'), revision: 0, baseFingerprint: base.fingerprint,
    customTags: [], tagOverrides: [], customCategories: [], customSubcategories: [], categoryOverrides: [], subcategoryOverrides: [], favoritePages: [], favoriteGroups: [], memberships: [], characterOverrides: [], selection: [], recentTagIds: [], migration: null, unresolved: [] };
}
function prepareLegacyMigration({ base, legacy, ids = p => `${p}:${randomUUID()}`, now = Date.now }) {
  try {
    const validated = createLibraryDocumentValidator(base); if (!validated.ok) return validated;
    const input = filteredInput(legacy), values = input.values, time = now(), document = emptyMigrationDocument(base, ids);
    // Base rows remain caller-owned read-only references. Only edited rows are copied.
    const baseTags = new Map(base.tags.map(t => [t.id, t])), tags = new Map(baseTags);
    const roles = new Map(base.characterLinks.map(r => [r.characterId, r]));
    const categories = new Map(base.categories.map(r => [r.id, r])), subs = new Map(base.subcategories.map(r => [r.id, r]));
    const pages = new Map(), groups = new Map(), members = new Map(), membershipPairs = new Map();
    const customTags = new Map(), overrides = new Map(), characterOverrides = new Map();
    const favoriteTags = new Map(), customAliases = new Map(), independentBySource = new Map(), editTimes = new Map();
    const selected = new Map(), recent = new Set(), seenCustom = new Set(), seenEntries = new Set();
    const contentIndex = new Map(), categoryNames = new Map(), subNames = new Map(), groupNames = new Map(), orders = new Map(), nextOrders = new Map();
    const report = { id: ids('migration'), sourceFingerprint: fingerprintLegacy(input), completedAt: time, tagIdMap: Object.create(null), favoriteIdMap: Object.create(null), characterIdMap: Object.create(null), counts: { sourceTags: 0, sourceFavorites: 0, linkedFavorites: 0, independentFavorites: 0, unresolved: 0 } };
    const validId = v => typeof v === 'string' && v.trim() && v.length <= 1024 && !v.includes('\0');
    const tuple = (...parts) => JSON.stringify(parts);
    let journal = null;
    function set(map, key, value) { const exists = map.has(key), old = map.get(key); if (journal) journal.push(() => { if (exists) map.set(key, old); else map.delete(key); }); map.set(key, value); }
    function remove(map, key) { if (!map.has(key)) return; const old = map.get(key); if (journal) journal.push(() => map.set(key, old)); map.delete(key); }
    function add(setValue, key) { if (setValue.has(key)) return; if (journal) journal.push(() => setValue.delete(key)); setValue.add(key); }
    function discard(setValue, key) { if (!setValue.has(key)) return; if (journal) journal.push(() => setValue.add(key)); setValue.delete(key); }
    function append(rows, row) { if (journal) journal.push(() => rows.pop()); rows.push(row); }
    function mapped(target, key, value) { const exists = own(target, key), old = target[key]; if (journal) journal.push(() => { if (exists) target[key] = old; else delete target[key]; }); target[key] = value; }
    function ensureShape(kind, row) { if (!validateLibraryRow(kind, row).ok) throw failure('INVALID_ROW'); }
    function requireTag(id, single = false) { const t = tags.get(id); if (!t || (single && t.kind !== 'tag')) throw failure('INVALID_ROW'); return t; }
    function noteTag(old, id, namespace = 'ordinary') {
      if (!validId(old) || !tags.has(id)) return;
      if (validId(`${namespace}:${old}`)) mapped(report.tagIdMap, `${namespace}:${old}`, id);
      if (namespace === 'ordinary' || namespace === 'favorite') {
        const key = namespace === 'ordinary' ? old : `favorite:${old}`;
        if (validId(key)) mapped(report.tagIdMap, key, id);
      }
    }
    function mapTag(old, namespace = 'ordinary') {
      if (!validId(old)) return null;
      const staticMap = base.legacyIds[namespace];
      const id = (namespace === 'ordinary' ? customAliases.get(old) : null) || (own(staticMap, old) ? staticMap[old] : null) || (tags.has(old) ? old : null);
      if (id) noteTag(old, id, namespace);
      return id;
    }
    function mapRole(id) {
      const r = roles.get(id); if (!r || !validId(id)) return null;
      mapped(report.characterIdMap, id, id); noteTag(id, r.identityTagId, 'characters'); return r;
    }
    function unresolved(key, row, reason, sourceId = row?.id) {
      append(document.unresolved, { id: ids('unresolved'), sourceKey: key, sourceId: validId(sourceId) ? sourceId : null, reason, payload: clone(row) });
    }
    function rows(key) { if (!own(values, key)) return []; if (Array.isArray(values[key])) return values[key]; unresolved(key, values[key], 'INVALID_COLLECTION'); return []; }
    function attempt(key, row, fn, id) {
      journal = [];
      try { fn(); }
      catch { for (let i = journal.length - 1; i >= 0; i--) journal[i](); journal = null; unresolved(key, row, 'INVALID_OR_UNRESOLVED_ROW', id); }
      finally { journal = null; }
    }
    function occupy(type, parent, order) {
      const key = tuple(type, parent, order); if (orders.has(key)) throw failure('INVALID_ROW');
      set(orders, key, true); const bucket = tuple(type, parent); set(nextOrders, bucket, Math.max(nextOrders.get(bucket) || 0, order + 1));
    }
    const nextOrder = (type, parent) => nextOrders.get(tuple(type, parent)) || 0;
    function indexContent(t) { const key = tuple(t.kind, t.content); let bucket = contentIndex.get(key); if (!bucket) { bucket = new Set(); set(contentIndex, key, bucket); } add(bucket, t.id); }
    for (const t of base.tags) indexContent(t);
    for (const c of base.categories) { if (!categoryNames.has(c.name)) categoryNames.set(c.name, c.id); occupy('category', null, c.order); }
    for (const s of base.subcategories) { const key = tuple(s.categoryId, s.name); if (!subNames.has(key)) subNames.set(key, s.id); occupy('subcategory', s.categoryId, s.order); }
    function addCategory(c) {
      ensureShape('category', c); if (categories.has(c.id)) throw failure('INVALID_ROW'); occupy('category', null, c.order);
      set(categories, c.id, c); if (!categoryNames.has(c.name)) set(categoryNames, c.name, c.id); append(document.customCategories, c);
    }
    function addSub(s) {
      ensureShape('subcategory', s); if (subs.has(s.id) || !categories.has(s.categoryId)) throw failure('INVALID_ROW'); occupy('subcategory', s.categoryId, s.order);
      set(subs, s.id, s); const key = tuple(s.categoryId, s.name); if (!subNames.has(key)) set(subNames, key, s.id); append(document.customSubcategories, s);
    }
    function location(category, subcategory, fallback) {
      let c = categories.get(category);
      if (!c && category !== undefined) { c = { id: validId(category) ? category : ids('category'), name: category, order: nextOrder('category', null), source: 'custom' }; addCategory(c); }
      if (!c && fallback) c = categories.get(fallback.categoryId);
      if (!c) {
        c = categories.get(categoryNames.get('未分类'));
        if (!c) { c = { id: ids('category'), name: '未分类', order: nextOrder('category', null), source: 'custom' }; addCategory(c); }
      }
      const name = subcategory === undefined ? (fallback?.categoryId === c.id ? undefined : c.name === '未分类' ? '未分类' : '默认') : subcategory;
      let s = subs.get(subcategory); if (s?.categoryId !== c.id) s = null;
      if (!s && name !== undefined) s = subs.get(subNames.get(tuple(c.id, name)));
      if (!s && subcategory === undefined && fallback?.categoryId === c.id) s = subs.get(fallback.subcategoryId);
      if (!s) { s = { id: ids('subcategory'), categoryId: c.id, name: name ?? '默认', order: nextOrder('subcategory', c.id), source: 'custom' }; addSub(s); }
      return { categoryId: c.id, subcategoryId: s.id };
    }
    function applyTag(t) {
      ensureShape('tag', t);
      if (!categories.has(t.categoryId) || subs.get(t.subcategoryId)?.categoryId !== t.categoryId) throw failure('INVALID_ROW');
      const previous = tags.get(t.id), original = baseTags.get(t.id);
      if (previous) discard(contentIndex.get(tuple(previous.kind, previous.content)), t.id);
      if (original) {
        const patch = Object.fromEntries(['kind', 'content', 'displayName', 'aliases', 'note', 'adult', 'searchable', 'categoryId', 'subcategoryId'].filter(k => !same(original[k], t[k])).map(k => [k, t[k]]));
        if (Object.keys(patch).length) set(overrides, t.id, { tagId: t.id, patch, revision: 1, updatedAt: t.updatedAt }); else remove(overrides, t.id);
      } else set(customTags, t.id, t);
      set(tags, t.id, t); indexContent(t);
    }
    function addPage(row) { ensureShape('page', row); if (pages.has(row.id)) throw failure('INVALID_ROW'); occupy('page', null, row.order); set(pages, row.id, row); }
    function addGroup(row) { ensureShape('group', row); if (groups.has(row.id) || !pages.has(row.pageId)) throw failure('INVALID_ROW'); occupy('group', row.pageId, row.order); set(groups, row.id, row); const key = tuple(row.pageId, row.name); if (!groupNames.has(key)) set(groupNames, key, row.id); }
    function defaultGroup(pageId) {
      const existing = groups.get(groupNames.get(tuple(pageId, '未分类'))); if (existing) return existing.id;
      const g = { id: ids('group'), pageId, name: '未分类', order: nextOrder('group', pageId), color: '#287EA4' }; addGroup(g); return g.id;
    }
    function applyLinks(next) {
      ensureShape('links', next); if (!roles.has(next.characterId)) throw failure('INVALID_ROW');
      for (const id of [next.identityTagId, ...next.seriesTagIds, ...next.generalTagIds, ...next.specificTagIds]) requireTag(id, true);
      set(characterOverrides, next.characterId, next); set(roles, next.characterId, next);
    }
    // Only IDs encountered in user sources enter the receipt. Archived history stays non-executable.
    const histories = new Map();
    for (const key of ['rewrite_tag_edit_history_v1', 'rewrite_character_edit_history_v1']) if (own(values, key)) {
      unresolved(key, values[key], 'HISTORY_ARCHIVE', null); const times = new Map(); histories.set(key, times);
      if (Array.isArray(values[key])) for (const row of values[key]) {
        if (key === 'rewrite_character_edit_history_v1') mapRole(row?.id); else mapTag(row?.id);
        if (validId(row?.id) && Number.isSafeInteger(row.at)) times.set(row.id, Math.max(times.get(row.id) || 0, row.at));
      }
    }
    for (const row of rows('rewrite_custom_tags')) {
      report.counts.sourceTags++;
      attempt('rewrite_custom_tags', row, () => {
        const r = typeof row === 'string' ? { en: row } : row;
        if (!object(r)) throw failure('INVALID_ROW'); const oldId = r.id ?? r.en;
        if (['id', 'en', 'zh', 'aliases', 'note', 'nsfw', 'adult', 'searchable', 'category', 'subcategory'].some(k => own(r, k) && r[k] === null)) throw failure('INVALID_ROW');
        if (!validId(oldId) || seenCustom.has(oldId)) throw failure('INVALID_ROW'); add(seenCustom, oldId);
        const ns = r.category === 'character_names' ? 'characters' : 'ordinary';
        const target = mapTag(oldId, ns), original = tags.get(target), id = target || ids('tag');
        if (!target && tags.has(id)) throw failure('INVALID_ROW');
        const t = { id, kind: 'tag', content: r.en ?? original?.content ?? oldId, displayName: r.zh ?? original?.displayName ?? '', aliases: r.aliases ?? original?.aliases ?? [], note: r.note ?? original?.note ?? '', adult: r.nsfw ?? r.adult ?? original?.adult ?? false, searchable: r.searchable ?? original?.searchable ?? true,
          ...location(r.category, r.subcategory, original), usages: original?.usages || ['general'], source: original?.source || { kind: 'custom', key: null }, revision: 1, createdAt: original?.createdAt || 0, updatedAt: Math.max(time, original?.createdAt || 0) };
        applyTag(t); noteTag(oldId, id, ns); set(customAliases, oldId, id); noteTag(oldId, id);
        if (ns === 'characters') mapRole(oldId); set(editTimes, id, r.editedAt);
      });
    }
    const historyTime = (key, id) => histories.get(key)?.get(id) || 0;
    if (own(values, 'rewrite_character_edits_v1') && !object(values.rewrite_character_edits_v1)) unresolved('rewrite_character_edits_v1', values.rewrite_character_edits_v1, 'INVALID_COLLECTION');
    else for (const [id, row] of Object.entries(values.rewrite_character_edits_v1 || {})) attempt('rewrite_character_edits_v1', row, () => {
      const links = mapRole(id); if (!links || !object(row)) throw failure('INVALID_ROW');
      const t = clone(tags.get(links.identityTagId));
      const tagTime = editTimes.get(t.id) || historyTime('rewrite_tag_edit_history_v1', t.id), roleTime = row.editedAt || historyTime('rewrite_character_edit_history_v1', id);
      const fields = { nameZh: 'displayName', aliases: 'aliases', nsfw: 'adult' };
      if (!own(row, 'nameZh') && own(row, 'name')) fields.name = 'displayName';
      for (const [old, field] of Object.entries(fields)) if (own(row, old) && !same(row[old], t[field])) {
        if (editTimes.has(t.id) && !(Number.isSafeInteger(roleTime) && roleTime > tagTime)) unresolved('rewrite_character_edits_v1', { characterId: id, field: old, value: row[old] }, 'IDENTITY_EDIT_CONFLICT', id);
        else t[field] = clone(row[old]);
      }
      t.updatedAt = Math.max(time, t.createdAt); applyTag(t); const next = clone(links);
      for (const [old, field, ns] of [['tagIds', 'generalTagIds', 'ordinary'], ['specificTagIds', 'specificTagIds', 'specific']]) if (own(row, old)) {
        if (!Array.isArray(row[old])) throw failure('INVALID_ROW'); next[field] = [...new Set(row[old].map(v => { const target = mapTag(v, ns); if (!target) throw failure('INVALID_ROW'); return target; }))];
      }
      if (own(row, 'seriesId')) { const target = row.seriesId === '' ? null : mapTag(row.seriesId, 'series'); if (row.seriesId !== '' && !target) throw failure('INVALID_ROW'); next.seriesTagIds = target ? [target] : []; }
      applyLinks(next);
      if (own(row, 'trigger') || own(row, 'seriesName') || (own(row, 'name') && own(row, 'nameZh'))) unresolved('rewrite_character_edits_v1', row, 'CHARACTER_METADATA_ARCHIVE', id);
    }, id);
    const rawShelf = values.favorites_shelf_v1, entries = [];
    if (rawShelf !== undefined && rawShelf !== null) {
      if (!object(rawShelf) || rawShelf.version !== 1 || rawShelf.format !== 'ai-tag-favorites' || !Array.isArray(rawShelf.series) || !Array.isArray(rawShelf.sections) || !Array.isArray(rawShelf.entries)) unresolved('favorites_shelf_v1', rawShelf, 'INVALID_FAVORITES_DOCUMENT');
      else {
        for (const row of rawShelf.series) attempt('favorites_shelf_v1', row, () => addPage(clone(row)));
        for (const row of rawShelf.sections) attempt('favorites_shelf_v1', row, () => addGroup({ id: row.id, pageId: row.seriesId, name: row.name, order: row.order, color: row.color }));
        for (const row of rawShelf.entries) entries.push({ key: 'favorites_shelf_v1', row });
      }
    }
    const older = rows('rewrite_favorites'); report.counts.sourceFavorites += older.length;
    if (rawShelf !== undefined && rawShelf !== null) { for (const r of older) { unresolved('rewrite_favorites', r, 'OLDER_FAVORITES_ARCHIVE'); if (Array.isArray(r?.tags)) for (const id of r.tags) mapTag(id); } }
    else if (older.length) {
      const pageId = ids('page'); addPage({ id: pageId, name: '未分类', order: 0, color: '#287EA4', colorMode: 'auto' });
      older.forEach((r, i) => {
        if (!object(r)) { unresolved('rewrite_favorites', r, 'INVALID_ROW'); return; }
        const values = Array.isArray(r.tags) ? r.tags : [], mapped = values.map(v => tags.get(mapTag(v)));
        if (values.some((v, j) => typeof v !== 'string' || !mapped[j])) { unresolved('rewrite_favorites', r, 'UNRESOLVED_LEGACY_TAGS'); return; }
        entries.push({ key: 'rewrite_favorites', row: { id: r.id || `legacy-${i}`, kind: values.length > 1 ? 'bundle' : 'tag', rawText: r.rawText ?? mapped.map(t => t.content).join(', '), title: r.name ?? r.title ?? '', zh: '', aliases: [], note: '', nsfw: r.nsfw === true || mapped.some(t => t.adult), globalSearchable: true, seriesId: pageId, sectionId: null, order: i, pinned: false } });
      });
    }
    for (const { key, row } of entries) {
      if (key === 'favorites_shelf_v1') report.counts.sourceFavorites++;
      attempt(key, row, () => {
        if (!object(row) || !validId(row.id) || seenEntries.has(row.id)) throw failure('INVALID_ROW'); add(seenEntries, row.id);
        if (['kind', 'rawText', 'title', 'zh', 'aliases', 'note', 'nsfw', 'globalSearchable', 'order', 'pinned', 'createdAt', 'updatedAt'].some(k => own(row, k) && row[k] === null)) throw failure('INVALID_ROW');
        const groupId = row.sectionId == null || row.sectionId === '' ? defaultGroup(row.seriesId) : row.sectionId;
        if (groups.get(groupId)?.pageId !== row.seriesId) throw failure('INVALID_ROW');
        const complex = typeof row.rawText === 'string' && (/\r|\n/.test(row.rawText) || /\([^\n]*:\s*[-+]?\d+(?:\.\d+)?\)/.test(row.rawText));
        const kind = row.kind === 'bundle' || complex ? 'bundle' : row.kind;
        const aliases = clone(row.aliases ?? []); if (!Array.isArray(aliases)) throw failure('INVALID_ROW');
        if (row.title && row.zh && row.title !== row.zh && !aliases.includes(row.zh)) aliases.push(row.zh);
        const fields = { kind, content: row.rawText, displayName: row.title || row.zh || '', aliases, note: row.note ?? '', adult: row.nsfw ?? false, searchable: row.globalSearchable ?? true };
        const compatible = t => Object.entries(fields).every(([k, v]) => same(t[k], v));
        const signature = row.sourceTagId || row.sourceCharacterId ? canonical([row.sourceTagId || null, row.sourceCharacterId || null, fields]) : null;
        let candidate = null, candidateCount = 0;
        if (row.sourceTagId) { candidate = tags.get(mapTag(row.sourceTagId)); candidateCount = candidate ? 1 : 0; }
        else if (row.sourceCharacterId) { candidate = tags.get(mapRole(row.sourceCharacterId)?.identityTagId); candidateCount = candidate ? 1 : 0; }
        else { const matches = contentIndex.get(tuple(kind, fields.content)); candidateCount = matches?.size || 0; if (candidateCount === 1) candidate = tags.get(matches.values().next().value); }
        let target = candidateCount === 1 && compatible(candidate) ? candidate : null;
        if (!target && signature) target = tags.get(independentBySource.get(signature)) || null;
        if (!target) {
          const id = ids('tag'); if (tags.has(id)) throw failure('INVALID_ROW');
          target = { id, ...fields, ...location(undefined, undefined), usages: ['general'], source: { kind: 'legacyFavorite', key: null }, revision: 0, createdAt: row.createdAt ?? 0, updatedAt: row.updatedAt ?? row.createdAt ?? 0 };
          applyTag(target); if (signature) set(independentBySource, signature, target.id);
          if (candidateCount) unresolved(key, { id: row.id, sourceTagId: row.sourceTagId || null, sourceCharacterId: row.sourceCharacterId || null }, 'INDEPENDENT_FAVORITE_DIFFERENCE', row.id);
          if (complex && row.kind !== 'bundle') unresolved(key, { id: row.id, originalKind: row.kind }, 'OPAQUE_BUNDLE_CONVERSION', row.id);
          else if (kind === 'tag' && typeof fields.content === 'string' && /[,()[\]]/.test(fields.content)) unresolved(key, { id: row.id }, 'AMBIGUOUS_WHOLE_CONTENT', row.id);
        }
        const pair = tuple(groupId, target.id), previous = members.get(membershipPairs.get(pair));
        const next = previous ? { ...previous, pinned: previous.pinned || row.pinned === true } : { id: row.id, tagId: target.id, groupId, order: row.order, pinned: row.pinned ?? false };
        // Validate source order/pinned even when coalescing an existing membership.
        ensureShape('membership', { id: row.id, tagId: target.id, groupId, order: row.order, pinned: row.pinned ?? false });
        if (!previous) { if (members.has(next.id)) throw failure('INVALID_ROW'); occupy('membership', groupId, next.order); set(membershipPairs, pair, next.id); }
        else unresolved(key, { id: row.id, retainedId: previous.id }, 'DUPLICATE_MEMBERSHIP', row.id);
        set(members, next.id, next); set(favoriteTags, row.id, target.id); mapped(report.favoriteIdMap, row.id, next.id); noteTag(row.id, target.id, 'favorite');
      });
    }
    for (const id of favoriteTags.values()) { if (tags.get(id).source.kind === 'legacyFavorite') report.counts.independentFavorites++; else report.counts.linkedFavorites++; }
    function select(value) {
      ensureShape('selection', value);
      if (value.kind === 'tag') requireTag(value.tagId);
      if (value.kind === 'character') {
        const r = roles.get(value.characterId); if (!r) throw failure('INVALID_ROW');
        for (const field of ['generalTagIds', 'specificTagIds']) { const available = new Set(r[field]); if (value[field].some(id => !available.has(id))) throw failure('INVALID_ROW'); }
      }
      const key = tuple(value.kind, value.tagId || value.characterId || value.id);
      if (selected.has(key) && !same(selected.get(key), value)) throw failure('INVALID_ROW'); set(selected, key, value);
    }
    for (const row of rows('rewrite_selected')) attempt('rewrite_selected', row, () => { const id = mapTag(row); if (!id) throw failure('INVALID_ROW'); select({ kind: 'tag', tagId: id }); });
    for (const row of rows('favorites_selection_v1')) attempt('favorites_selection_v1', row, () => {
      const t = tags.get(favoriteTags.get(row?.entryId)); if (t) noteTag(row.entryId, t.id, 'favorite');
      if (t && t.content === row.rawText && t.displayName === row.title && t.adult === row.nsfw && t.kind === row.kind) select({ kind: 'tag', tagId: t.id });
      else select({ kind: 'legacySnapshot', id: ids('snapshot'), content: row?.rawText, displayName: row?.title, adult: row?.nsfw });
    });
    for (const row of rows('rewrite_character_selection_v1')) attempt('rewrite_character_selection_v1', row, () => {
      if (!mapRole(row?.id)) throw failure('INVALID_ROW');
      const mapList = (list, ns) => Array.isArray(list) ? list.map(id => mapTag(id, ns)) : list;
      select({ kind: 'character', characterId: row.id, includeSeries: row.includeSeries, generalTagIds: mapList(row.generalTagIds, 'ordinary'), specificTagIds: mapList(row.specificTagIds, 'specific') });
    });
    for (const row of rows('favorites_recent_v1')) { const id = favoriteTags.get(row); if (id) { recent.add(id); noteTag(row, id, 'favorite'); } else unresolved('favorites_recent_v1', row, 'UNRESOLVED_RECENT'); }
    // Materialize once. All row updates and indexes are transactionally local; this is the only full candidate validation.
    Object.assign(document, { customTags: [...customTags.values()], tagOverrides: [...overrides.values()], favoritePages: [...pages.values()], favoriteGroups: [...groups.values()], memberships: [...members.values()], characterOverrides: [...characterOverrides.values()], selection: [...selected.values()], recentTagIds: [...recent] });
    report.counts.unresolved = document.unresolved.length; document.migration = report;
    const checked = validated.data(document); if (!checked.ok) return checked;
    return { ok: true, data: { document, report: clone(report), sourceFingerprint: report.sourceFingerprint }, revision: 0 };
  } catch (e) { return { ok: false, error: { code: e.code === 'INVALID_LEGACY_INPUT' ? e.code : 'MIGRATION_FAILED', message: '旧标签数据迁移失败，来源已保留' } }; }
}
module.exports = { readLegacyInput, prepareLegacyMigration, fingerprintLegacy, filteredInput };
