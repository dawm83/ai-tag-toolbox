'use strict';
const fs = require('node:fs/promises');
const { createHash, randomUUID } = require('node:crypto');
const { createLibraryDocumentValidator, validateTag } = require('./schema');
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
    const favoriteTags = new Map();
    const tags = new Map(base.tags.map(t => [t.id, clone(t)])), roles = new Map(base.characterLinks.map(r => [r.characterId, clone(r)]));
    const report = { id: ids('migration'), sourceFingerprint: fingerprintLegacy(input), completedAt: time, tagIdMap: Object.create(null), favoriteIdMap: Object.create(null), characterIdMap: Object.create(null), counts: { sourceTags: 0, sourceFavorites: 0, linkedFavorites: 0, independentFavorites: 0, unresolved: 0 } };
    const validId = v => typeof v === 'string' && v.trim() && v.length <= 1024 && !v.includes('\0');
    function unresolved(key, row, reason, sourceId = row?.id) {
      document.unresolved.push({ id: ids('unresolved'), sourceKey: key, sourceId: validId(sourceId) ? sourceId : null, reason, payload: clone(row) });
    }
    function rows(key) { if (!own(values, key)) return []; if (Array.isArray(values[key])) return values[key]; unresolved(key, values[key], 'INVALID_COLLECTION'); return []; }
    const mapTag = (id, namespace = 'ordinary') => validId(id) ? base.legacyIds[namespace]?.[id] || (tags.has(id) ? id : null) : null;
    let mappingUndo = null;
    function mapReceipt(key, id) {
      if (validId(key) && tags.has(id)) {
        if (mappingUndo) mappingUndo.push([key, own(report.tagIdMap, key), report.tagIdMap[key]]);
        report.tagIdMap[key] = id;
      }
    }
    for (const namespace of ['ordinary', 'characters', 'series', 'specific']) for (const [old, id] of Object.entries(base.legacyIds[namespace])) {
      mapReceipt(`${namespace}:${old}`, id); if (namespace === 'ordinary') mapReceipt(old, id);
    }
    for (const id of roles.keys()) report.characterIdMap[id] = id;
    for (const key of ['rewrite_tag_edit_history_v1', 'rewrite_character_edit_history_v1']) if (own(values, key)) unresolved(key, values[key], 'HISTORY_ARCHIVE', null);
    function location(category, subcategory, fallback) {
      let c = [...base.categories, ...document.customCategories].find(r => r.id === category);
      if (!c && category !== undefined) { c = { id: validId(category) ? category : ids('category'), name: category, order: base.categories.length + document.customCategories.length, source: 'custom' }; document.customCategories.push(c); }
      if (!c) c = [...base.categories, ...document.customCategories].find(r => r.id === fallback?.categoryId) || base.categories[0];
      if (!c) throw failure('MIGRATION_FAILED');
      let s = [...base.subcategories, ...document.customSubcategories].find(r => r.categoryId === c.id && (r.id === subcategory || r.name === subcategory));
      if (!s && subcategory === undefined && fallback?.categoryId === c.id) s = base.subcategories.find(r => r.id === fallback.subcategoryId);
      if (!s) { s = { id: ids('subcategory'), categoryId: c.id, name: subcategory ?? '默认', order: [...base.subcategories, ...document.customSubcategories].filter(r => r.categoryId === c.id).length, source: 'custom' }; document.customSubcategories.push(s); }
      return { categoryId: c.id, subcategoryId: s.id };
    }
    function applyTag(t) {
      const checked = validateTag(t); if (!checked.ok) throw failure('INVALID_ROW');
      const original = base.tags.find(r => r.id === t.id);
      if (original) {
        const patch = Object.fromEntries(['kind', 'content', 'displayName', 'aliases', 'note', 'adult', 'searchable', 'categoryId', 'subcategoryId'].filter(k => !same(original[k], t[k])).map(k => [k, t[k]]));
        document.tagOverrides = document.tagOverrides.filter(r => r.tagId !== t.id);
        if (Object.keys(patch).length) document.tagOverrides.push({ tagId: t.id, patch, revision: 1, updatedAt: t.updatedAt });
      } else { document.customTags = document.customTags.filter(r => r.id !== t.id); document.customTags.push(t); }
      tags.set(t.id, t);
    }
    // Per-row rollback retains invalid input without leaving half-created parents.
    function attempt(key, row, fn, id) {
      const before = clone(document), beforeTags = new Map(tags), beforeRoles = new Map(roles), beforeFavorites = new Map(favoriteTags);
      mappingUndo = [];
      try { fn(); const checked = validated.data(document); if (!checked.ok) throw failure('INVALID_ROW'); }
      catch {
        for (const [key, existed, value] of mappingUndo.reverse()) { if (existed) report.tagIdMap[key] = value; else delete report.tagIdMap[key]; }
        Object.assign(document, before); tags.clear(); beforeTags.forEach((v, k) => tags.set(k, v)); roles.clear(); beforeRoles.forEach((v, k) => roles.set(k, v)); favoriteTags.clear(); beforeFavorites.forEach((v, k) => favoriteTags.set(k, v)); unresolved(key, row, 'INVALID_OR_UNRESOLVED_ROW', id);
      } finally { mappingUndo = null; }
    }
    const seenCustom = new Set(), editTimes = new Map();
    for (const row of rows('rewrite_custom_tags')) {
      report.counts.sourceTags++;
      attempt('rewrite_custom_tags', row, () => {
        const r = typeof row === 'string' ? { en: row } : row;
        if (!object(r)) throw failure('INVALID_ROW'); const oldId = r.id ?? r.en;
        if (['id', 'en', 'zh', 'aliases', 'note', 'nsfw', 'adult', 'searchable', 'category', 'subcategory'].some(k => own(r, k) && r[k] === null)) throw failure('INVALID_ROW');
        if (!validId(oldId) || seenCustom.has(oldId)) throw failure('INVALID_ROW'); seenCustom.add(oldId);
        const target = mapTag(oldId, r.category === 'character_names' ? 'characters' : 'ordinary'), original = tags.get(target), id = target || ids('tag');
        const t = { id, kind: 'tag', content: r.en ?? original?.content ?? oldId, displayName: r.zh ?? original?.displayName ?? '', aliases: r.aliases ?? original?.aliases ?? [], note: r.note ?? original?.note ?? '', adult: r.nsfw ?? r.adult ?? original?.adult ?? false, searchable: r.searchable ?? original?.searchable ?? true,
          ...location(r.category, r.subcategory, original), usages: original?.usages || ['general'], source: original?.source || { kind: 'custom', key: null }, revision: 1, createdAt: original?.createdAt || 0, updatedAt: Math.max(time, original?.createdAt || 0) };
        applyTag(t); mapReceipt(oldId, id); editTimes.set(id, r.editedAt);
      });
    }
    function historyTime(key, id) { const items = Array.isArray(values[key]) ? values[key] : []; return Math.max(0, ...items.filter(r => r?.id === id && Number.isSafeInteger(r.at)).map(r => r.at)); }
    if (own(values, 'rewrite_character_edits_v1') && !object(values.rewrite_character_edits_v1)) unresolved('rewrite_character_edits_v1', values.rewrite_character_edits_v1, 'INVALID_COLLECTION');
    else for (const [id, row] of Object.entries(values.rewrite_character_edits_v1 || {})) attempt('rewrite_character_edits_v1', row, () => {
      const links = roles.get(id); if (!links || !object(row)) throw failure('INVALID_ROW');
      const t = clone(tags.get(links.identityTagId));
      const tagTime = editTimes.get(t.id) || historyTime('rewrite_tag_edit_history_v1', t.id), roleTime = row.editedAt || historyTime('rewrite_character_edit_history_v1', id);
      const fields = { nameZh: 'displayName', aliases: 'aliases', nsfw: 'adult' };
      if (!own(row, 'nameZh') && own(row, 'name')) fields.name = 'displayName';
      for (const [old, field] of Object.entries(fields)) if (own(row, old) && !same(row[old], t[field])) {
        if (editTimes.has(t.id) && !(Number.isSafeInteger(roleTime) && roleTime > tagTime)) unresolved('rewrite_character_edits_v1', { characterId: id, field: old, value: row[old] }, 'IDENTITY_EDIT_CONFLICT', id);
        else t[field] = clone(row[old]);
      }
      t.updatedAt = Math.max(time, t.createdAt); applyTag(t);
      const next = clone(links);
      for (const [old, field, ns] of [['tagIds', 'generalTagIds', 'ordinary'], ['specificTagIds', 'specificTagIds', 'specific']]) if (own(row, old)) {
        if (!Array.isArray(row[old])) throw failure('INVALID_ROW'); next[field] = [...new Set(row[old].map(v => { const target = (ns === 'ordinary' ? report.tagIdMap[v] : null) || mapTag(v, ns); if (!target) throw failure('INVALID_ROW'); return target; }))];
      }
      if (own(row, 'seriesId')) { const target = row.seriesId === '' ? null : mapTag(row.seriesId, 'series'); if (row.seriesId !== '' && !target) throw failure('INVALID_ROW'); next.seriesTagIds = target ? [target] : []; }
      document.characterOverrides.push(next); roles.set(id, next);
      if (own(row, 'trigger') || own(row, 'seriesName') || (own(row, 'name') && own(row, 'nameZh'))) unresolved('rewrite_character_edits_v1', row, 'CHARACTER_METADATA_ARCHIVE', id);
    }, id);
    const rawShelf = values.favorites_shelf_v1;
    const entries = [];
    if (rawShelf !== undefined && rawShelf !== null) {
      if (!object(rawShelf) || rawShelf.version !== 1 || rawShelf.format !== 'ai-tag-favorites' || !Array.isArray(rawShelf.series) || !Array.isArray(rawShelf.sections) || !Array.isArray(rawShelf.entries)) unresolved('favorites_shelf_v1', rawShelf, 'INVALID_FAVORITES_DOCUMENT');
      else {
        for (const row of rawShelf.series) attempt('favorites_shelf_v1', row, () => { document.favoritePages.push(clone(row)); });
        for (const row of rawShelf.sections) attempt('favorites_shelf_v1', row, () => { document.favoriteGroups.push({ id: row.id, pageId: row.seriesId, name: row.name, order: row.order, color: row.color }); });
        entries.push(...rawShelf.entries.map(row => ({ key: 'favorites_shelf_v1', row })));
      }
    }
    function defaultGroup(pageId) {
      let g = document.favoriteGroups.find(r => r.pageId === pageId && r.name === '未分类');
      if (!g) { const peers = document.favoriteGroups.filter(r => r.pageId === pageId); g = { id: ids('group'), pageId, name: '未分类', order: Math.max(-1, ...peers.map(r => r.order)) + 1, color: '#287EA4' }; document.favoriteGroups.push(g); }
      return g.id;
    }
    const older = rows('rewrite_favorites'); report.counts.sourceFavorites += older.length;
    if (rawShelf !== undefined && rawShelf !== null) { for (const r of older) unresolved('rewrite_favorites', r, 'OLDER_FAVORITES_ARCHIVE'); }
    else if (older.length) {
      const pageId = ids('page'); document.favoritePages.push({ id: pageId, name: '未分类', order: 0, color: '#287EA4', colorMode: 'auto' });
      older.forEach((r, i) => {
        if (!object(r)) { unresolved('rewrite_favorites', r, 'INVALID_ROW'); return; }
        const members = Array.isArray(r.tags) ? r.tags : [];
        const mapped = members.map(v => tags.get(report.tagIdMap[v] || mapTag(v)));
        if (members.some((v, j) => typeof v !== 'string' || !mapped[j])) { unresolved('rewrite_favorites', r, 'UNRESOLVED_LEGACY_TAGS'); return; }
        entries.push({ key: 'rewrite_favorites', row: { id: r.id || `legacy-${i}`, kind: members.length > 1 ? 'bundle' : 'tag', rawText: r.rawText ?? mapped.map(t => t.content).join(', '), title: r.name ?? r.title ?? '', zh: '', aliases: [], note: '', nsfw: r.nsfw === true || mapped.some(t => t.adult), globalSearchable: true, seriesId: pageId, sectionId: null, order: i, pinned: false } });
      });
    }
    const seenEntries = new Set(), independentBySource = new Map();
    for (const { key, row } of entries) {
      if (key === 'favorites_shelf_v1') report.counts.sourceFavorites++;
      attempt(key, row, () => {
        if (!object(row) || !validId(row.id) || seenEntries.has(row.id)) throw failure('INVALID_ROW'); seenEntries.add(row.id);
        if (['kind', 'rawText', 'title', 'zh', 'aliases', 'note', 'nsfw', 'globalSearchable', 'order', 'pinned', 'createdAt', 'updatedAt'].some(k => own(row, k) && row[k] === null)) throw failure('INVALID_ROW');
        const groupId = row.sectionId == null || row.sectionId === '' ? defaultGroup(row.seriesId) : row.sectionId;
        if (!document.favoriteGroups.some(g => g.id === groupId && g.pageId === row.seriesId)) throw failure('INVALID_ROW');
        const complex = typeof row.rawText === 'string' && (/\r|\n/.test(row.rawText) || /\([^\n]*:\s*[-+]?\d+(?:\.\d+)?\)/.test(row.rawText));
        const kind = row.kind === 'bundle' || complex ? 'bundle' : row.kind;
        const aliases = clone(row.aliases ?? []); if (!Array.isArray(aliases)) throw failure('INVALID_ROW');
        if (row.title && row.zh && row.title !== row.zh && !aliases.includes(row.zh)) aliases.push(row.zh);
        const fields = { kind, content: row.rawText, displayName: row.title || row.zh || '', aliases, note: row.note ?? '', adult: row.nsfw ?? false, searchable: row.globalSearchable ?? true };
        const compatible = t => Object.entries(fields).every(([k, v]) => same(t[k], v));
        const sourceSignature = row.sourceTagId || row.sourceCharacterId
          ? canonical([row.sourceTagId || null, row.sourceCharacterId || null, fields]) : null;
        let candidates;
        if (row.sourceTagId) candidates = [tags.get(report.tagIdMap[row.sourceTagId] || mapTag(row.sourceTagId))].filter(Boolean);
        else if (row.sourceCharacterId) candidates = [tags.get(roles.get(row.sourceCharacterId)?.identityTagId)].filter(Boolean);
        else candidates = [...tags.values()].filter(t => t.content === fields.content && t.kind === kind);
        let target = candidates.length === 1 && compatible(candidates[0]) ? candidates[0] : null;
        if (!target && sourceSignature) target = tags.get(independentBySource.get(sourceSignature)) || null;
        if (!target) {
          target = { id: ids('tag'), ...fields, ...location(undefined, undefined), usages: ['general'], source: { kind: 'legacyFavorite', key: null }, revision: 0, createdAt: row.createdAt ?? 0, updatedAt: row.updatedAt ?? row.createdAt ?? 0 };
          applyTag(target);
          if (sourceSignature) independentBySource.set(sourceSignature, target.id);
          if (candidates.length) unresolved(key, { id: row.id, sourceTagId: row.sourceTagId || null, sourceCharacterId: row.sourceCharacterId || null }, 'INDEPENDENT_FAVORITE_DIFFERENCE', row.id);
          if (complex && row.kind !== 'bundle') unresolved(key, { id: row.id, originalKind: row.kind }, 'OPAQUE_BUNDLE_CONVERSION', row.id);
          else if (kind === 'tag' && typeof fields.content === 'string' && /[,()[\]]/.test(fields.content)) unresolved(key, { id: row.id }, 'AMBIGUOUS_WHOLE_CONTENT', row.id);
        }
        let member = document.memberships.find(m => m.tagId === target.id && m.groupId === groupId);
        if (!member) { member = { id: row.id, tagId: target.id, groupId, order: row.order, pinned: row.pinned ?? false }; document.memberships.push(member); }
        else { member.pinned = member.pinned || row.pinned === true; unresolved(key, { id: row.id, retainedId: member.id }, 'DUPLICATE_MEMBERSHIP', row.id); }
        favoriteTags.set(row.id, target.id); report.favoriteIdMap[row.id] = member.id; mapReceipt(`favorite:${row.id}`, target.id);
      });
    }
    // Count only targets surviving row validation, never speculative conversions.
    for (const id of favoriteTags.values()) { if (tags.get(id)?.source.kind === 'legacyFavorite') report.counts.independentFavorites++; else report.counts.linkedFavorites++; }
    function select(key, row, value) { attempt(key, row, () => { if (!document.selection.some(s => same(s, value))) document.selection.push(value); }); }
    for (const row of rows('rewrite_selected')) { const id = report.tagIdMap[row] || mapTag(row); if (id) select('rewrite_selected', row, { kind: 'tag', tagId: id }); else unresolved('rewrite_selected', row, 'UNRESOLVED_SELECTION'); }
    for (const row of rows('favorites_selection_v1')) {
      const t = tags.get(favoriteTags.get(row?.entryId));
      if (t && t.content === row.rawText && t.displayName === row.title && t.adult === row.nsfw && t.kind === row.kind) select('favorites_selection_v1', row, { kind: 'tag', tagId: t.id });
      else select('favorites_selection_v1', row, { kind: 'legacySnapshot', id: ids('snapshot'), content: row?.rawText, displayName: row?.title, adult: row?.nsfw });
    }
    for (const row of rows('rewrite_character_selection_v1')) {
      const mapList = (list, ns) => Array.isArray(list) ? list.map(id => (ns === 'ordinary' ? report.tagIdMap[id] : null) || mapTag(id, ns)) : list;
      select('rewrite_character_selection_v1', row, { kind: 'character', characterId: row?.id, includeSeries: row?.includeSeries, generalTagIds: mapList(row?.generalTagIds, 'ordinary'), specificTagIds: mapList(row?.specificTagIds, 'specific') });
    }
    for (const row of rows('favorites_recent_v1')) { const id = favoriteTags.get(row); if (id && !document.recentTagIds.includes(id)) document.recentTagIds.push(id); else if (!id) unresolved('favorites_recent_v1', row, 'UNRESOLVED_RECENT'); }
    // Receipt mappings are historical after creation, but must point at live targets now.
    for (const [old, id] of Object.entries(report.tagIdMap)) if (!tags.has(id)) delete report.tagIdMap[old];
    for (const [old, id] of Object.entries(report.favoriteIdMap)) if (!document.memberships.some(m => m.id === id)) delete report.favoriteIdMap[old];
    report.counts.unresolved = document.unresolved.length; document.migration = report;
    const checked = validated.data(document); if (!checked.ok) return checked;
    return { ok: true, data: { document, report: clone(report), sourceFingerprint: report.sourceFingerprint }, revision: 0 };
  } catch (e) { return { ok: false, error: { code: e.code === 'INVALID_LEGACY_INPUT' ? e.code : 'MIGRATION_FAILED', message: '旧标签数据迁移失败，来源已保留' } }; }
}
module.exports = { readLegacyInput, prepareLegacyMigration, fingerprintLegacy, filteredInput };
