'use strict';

// Build-time adapter only. Runtime imports index.js and the generated JSON, never this module.
const { createHash } = require('node:crypto');
const { normaliseTag, normaliseKeywords, searchKey, DEFAULT_CATEGORIES } = require('../tags');
const { validateBase } = require('./schema');
const hash = value => createHash('sha256').update(value).digest('hex');
const list = value => Array.isArray(value) ? value : [];
const terms = value => Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,，、;；]+/).filter(Boolean) : [];
const unique = values => [...new Set(values)];
const label = value => String(value || '').replace(/_/g, ' ');
const dictionary = () => Object.create(null);
function invalid(field) { throw Object.assign(new Error('内置标签源数据不合法'), { code: 'INVALID_DOCUMENT', field }); }

/** Adapt loadTagFiles output without constructing the old mutable tag store. */
function ordinaryRows(sources) {
  if (Array.isArray(sources)) sources = { base: sources };
  if (!sources || typeof sources !== 'object') invalid('tags');
  const rows = new Map();
  const model = sources.model || sources.modelTags || sources.wdTags;
  const modelRows = Array.isArray(model) ? model : Object.values(model || {}).map(row => Array.isArray(row) ? { en: row[0], categoryCode: row[1], count: row[2] } : row);
  for (const [source, input] of [['base', sources.base || sources.builtin || sources.tags], ['extra', sources.extra || sources.extensions], ['model', modelRows]]) {
    for (const row of list(input)) {
      const tag = normaliseTag(row, source);
      if (!tag) {
        // The legacy curated extra file contains one empty row, never a runtime tag.
        if (Array.isArray(row) && row[0] === '') continue;
        invalid(`tags.${source}`);
      }
      // Identity normalization matches the legacy loader; content keeps original bytes.
      const raw = typeof row === 'string' ? row : Array.isArray(row) ? row[0] : row.en ?? row.tag ?? row.name ?? row.id;
      if (typeof raw !== 'string') invalid(`tags.${source}.content`);
      tag.en = raw;
      const old = rows.get(tag.id);
      if (!old) rows.set(tag.id, tag);
      else rows.set(tag.id, { ...old, zh: old.zh || tag.zh, aliases: unique([...old.aliases, ...tag.aliases]), category: old.category === 'other' ? tag.category : old.category, subcategory: old.subcategory === '默认' ? tag.subcategory : old.subcategory, nsfw: old.nsfw || tag.nsfw, categoryCode: old.categoryCode ?? tag.categoryCode, count: old.count ?? tag.count });
    }
  }
  const synonyms = sources.synonyms || {};
  const byEn = synonyms.byEn || (!synonyms.aliases && !synonyms.reverse ? synonyms : {});
  for (const row of rows.values()) row.aliases = unique([...row.aliases, ...terms(byEn[row.en] || byEn[row.id]), ...terms(synonyms.aliases?.[row.en] || synonyms.aliases?.[row.id])]);
  return { rows, categories: sources.categories || sources.categoryDefinitions || sources.baseCategories || DEFAULT_CATEGORIES, keywords: normaliseKeywords(sources.keywords || sources.searchKeywords || {}) };
}

/** @returns {{ok:true,data:object}|{ok:false,error:{code:string,message:string,fields:string[]}}} */
function buildUnifiedSeed({ tags: sources, characters = [], specificTags = [], manifest = {} } = {}) {
  try {
    if (!Array.isArray(characters) || !Array.isArray(specificTags)) invalid('characters');
    const ordinary = ordinaryRows(sources);
    const tags = new Map(), categories = new Map(), subs = new Map(), characterLinks = [], metadataById = dictionary(), characterInfo = dictionary();
    const legacyIds = { ordinary: dictionary(), characters: dictionary(), series: dictionary(), specific: dictionary(), subcategories: dictionary() };
    const categoryNames = new Map([['character_names', '角色名'], ['series', '作品系列'], ['character_specific', '角色专属词'], ['other', '其他']]);
    function ensureCategory(categoryId, name) {
      if (!categories.has(categoryId)) categories.set(categoryId, { id: categoryId, name: name || categoryNames.get(categoryId) || categoryId, order: categories.size, source: 'bundled' });
      return categoryId;
    }
    const childCounts = new Map();
    function ensureSub(categoryId, name = '默认') {
      ensureCategory(categoryId); const key = JSON.stringify([categoryId, name]);
      if (!legacyIds.subcategories[key]) {
        const id = `sub:${hash(key)}`; const order = childCounts.get(categoryId) || 0;
        if (subs.has(id)) invalid('subcategory.hashCollision');
        subs.set(id, { id, categoryId, name, order, source: 'bundled' }); childCounts.set(categoryId, order + 1); legacyIds.subcategories[key] = id;
      }
      return legacyIds.subcategories[key];
    }
    for (const c of list(ordinary.categories)) {
      const categoryId = typeof c === 'string' ? c.toLowerCase() : Array.isArray(c) ? c[0] : c.id || c.code;
      const name = typeof c === 'string' ? c : Array.isArray(c) ? c[1] : c.name;
      ensureCategory(categoryId, name);
    }
    function record(id, content, displayName, categoryId, subcategory, usages, sourceKey, aliases = [], adult = false, searchable = true) {
      return { id, kind: 'tag', content, displayName, aliases, note: '', adult, searchable, categoryId: ensureCategory(categoryId), subcategoryId: ensureSub(categoryId, subcategory), usages, source: { kind: 'bundled', key: sourceKey }, revision: 0, createdAt: 0, updatedAt: 0 };
    }
    for (const old of ordinary.rows.values()) {
      tags.set(old.id, record(old.id, old.en, old.zh, old.category, old.subcategory, ['general'], `${old.source}:${old.id}`, old.aliases, old.nsfw));
      legacyIds.ordinary[old.id] = old.id;
      const keys = [old.id, old.en].flatMap(v => [v.trim().toLowerCase(), searchKey(v)]);
      metadataById[old.id] = { count: old.count, categoryCode: old.categoryCode, confidence: old.confidence, keywords: unique(keys.flatMap(k => ordinary.keywords.get(k) || [])) };
    }
    function allocate(preferred, namespace, sourceId) {
      if (!tags.has(preferred)) return preferred;
      const prefix = `${namespace}:${hash(sourceId)}`; let id = prefix, suffix = 0;
      while (tags.has(id)) id = `${prefix}:${++suffix}`;
      return id;
    }
    const specificIds = new Set();
    for (const row of specificTags) {
      if (!row || typeof row.id !== 'string' || specificIds.has(row.id)) invalid('specificTags.id'); specificIds.add(row.id);
      const id = allocate(row.id, 'specific', row.id);
      tags.set(id, record(id, row.en, row.zh || '', 'character_specific', '默认', ['characterSpecific'], `specific:${row.id}`, list(row.aliases), Boolean(row.nsfw), false));
      metadataById[id] = { count: null, categoryCode: null, confidence: null, review: Boolean(row.review) }; legacyIds.specific[row.id] = id;
    }
    function identity(row, fallback) {
      const old = ordinary.rows.get(row.id);
      // Reuse only the explicitly identified legacy character-name row, never a display-name match.
      const reusable = old && old.category === 'character_names';
      const id = reusable ? old.id : allocate(row.id, 'character', row.id);
      if (!reusable) tags.set(id, record(id, label(row.id), row.nameZh || row.name || label(row.id), 'character_names', '角色名', ['characterIdentity'], `character:${row.id}`, list(row.aliases), Boolean(row.nsfw)));
      else { const tag = tags.get(id); tag.usages = unique([...tag.usages, 'characterIdentity']); tag.displayName = tag.displayName || row.nameZh || row.name || label(row.id); tag.aliases = unique([...tag.aliases, ...list(row.aliases)]); tag.adult = tag.adult || Boolean(row.nsfw); }
      legacyIds.characters[row.id] = id;
      characterInfo[row.id] = { count: Number.isFinite(row.count) ? row.count : old?.count || 0, order: characterLinks.length, fallback, sourceKey: fallback ? 'legacy-character-name' : 'characters', sourceTrigger: row.trigger || '' };
      return id;
    }
    function series(sourceId, name) {
      if (Object.prototype.hasOwnProperty.call(legacyIds.series, sourceId)) return legacyIds.series[sourceId];
      const old = ordinary.rows.get(sourceId);
      const reusable = old?.category === 'series';
      const id = reusable ? old.id : allocate(sourceId, 'series', sourceId);
      if (reusable) tags.get(id).usages = unique([...tags.get(id).usages, 'seriesIdentity']);
      else tags.set(id, record(id, label(sourceId), name || label(sourceId), 'series', '默认', ['seriesIdentity'], `series:${sourceId}`));
      legacyIds.series[sourceId] = id; return id;
    }
    const characterIds = new Set();
    function addCharacter(row, fallback) {
      if (!row || typeof row.id !== 'string' || characterIds.has(row.id)) invalid('characters.id'); characterIds.add(row.id);
      const identityTagId = identity(row, fallback);
      const generalTagIds = list(row.tagIds).map(id => { if (!ordinary.rows.has(id)) invalid('characters.tagIds'); return legacyIds.ordinary[id]; });
      const specificTagIds = list(row.specificTagIds).map(id => { if (!specificIds.has(id)) invalid('characters.specificTagIds'); return legacyIds.specific[id]; });
      characterLinks.push({ characterId: row.id, identityTagId, seriesTagIds: row.seriesId ? [series(row.seriesId, row.seriesName)] : [], generalTagIds, specificTagIds });
    }
    for (const row of characters) addCharacter(row, false);
    for (const row of ordinary.rows.values()) if (row.category === 'character_names' && !characterIds.has(row.id)) addCharacter({ id: row.id, count: row.count, trigger: label(row.en) }, true);
    const base = { tags: [...tags.values()], categories: [...categories.values()], subcategories: [...subs.values()], characterLinks, legacyIds, metadataById, characterInfo };
    base.fingerprint = hash(JSON.stringify({ base, manifest }));
    return validateBase(base);
  } catch (error) {
    if (error?.code !== 'INVALID_DOCUMENT') throw error;
    return { ok: false, error: { code: error.code, message: '内置标签源数据校验失败', fields: [error.field] } };
  }
}
module.exports = { buildUnifiedSeed };
