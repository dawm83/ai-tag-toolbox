'use strict';
const { isDeepStrictEqual } = require('node:util');
const { context, fail, own, object, clone, collect } = require('./adapter-common');
const { validateCommand } = require('./schema');
const { formatTagOutput } = require('./selection');
const { normalize } = require('./search');
const precisionOf = value => ['exact', 'broad'].includes(value) ? value : 'standard';

/** Canonical IDs plus read-only source audit metadata; never a second tag store.
 * characterSource = { characters: [{id, trigger?, count?, fallback?, sourceKey?, order?}], manifest?: object }
 * The host joins base.characterLinks with base.characterInfo to include fallback roles.
 */
function createCharacterAdapter({ library, characterSource } = {}) {
  const { run } = context(library);
  if (!object(characterSource) || !Array.isArray(characterSource.characters)) throw Object.assign(new Error('角色审计来源必须包含 characters 数组'), { code: 'CHARACTER_DATA_INVALID' });
  const audit = new Map();
  for (const row of characterSource.characters) {
    if (!object(row) || typeof row.id !== 'string' || !row.id.trim() || audit.has(row.id)) throw Object.assign(new Error('角色审计来源 ID 无效或重复'), { code: 'CHARACTER_DATA_INVALID' });
    audit.set(row.id, { trigger: typeof row.trigger === 'string' ? row.trigger : '', count: Number(row.count) || 0,
      fallback: Boolean(row.fallback), ...(typeof row.sourceKey === 'string' ? { sourceKey: row.sourceKey } : {}), ...(Number.isFinite(row.order) ? { order: row.order } : {}) });
  }
  const metadata = object(characterSource.manifest) ? clone(characterSource.manifest) : {};
  let index = null; const recordCache = new Map(), pageCache = new Map();
  const unsubscribe = library.subscribe(change => {
    if (change.changedCharacterIds.length) {
      for (const id of change.changedCharacterIds) recordCache.delete(id);
      index = null;
    }
    if (change.changedCharacterIds.length || change.structureChanged) pageCache.clear();
  });
  function unresolved(characterId, tagId, field) {
    throw Object.assign(new Error(`角色引用未解析：${characterId} / ${field}`), { code: 'UNRESOLVED_REFERENCE', fields: [`character.${characterId}.${field}`], characterId, tagId });
  }
  function requiredTag(characterId, tagId, field) {
    const tag = library.getTag(tagId);
    if (!tag || tag.kind !== 'tag') unresolved(characterId, tagId, field);
    return tag;
  }
  const visible = (tag, settings) => settings.includeAdult || !tag.adult;
  function record(id) {
    if (recordCache.has(id)) return recordCache.get(id);
    const links = library.getCharacterLinks(id);
    if (!links) return null;
    const identity = requiredTag(id, links.identityTagId, 'identityTagId');
    const series = links.seriesTagIds.map(tagId => requiredTag(id, tagId, 'seriesTagIds'));
    const result = { links, identity, series, audit: audit.get(id) || { trigger: '', count: 0, fallback: false } };
    recordCache.set(id, result); return result;
  }
  function summary(row, settings = {}) {
    const series = row.series.filter(tag => visible(tag, settings));
    return { id: row.links.characterId, identityTagId: row.links.identityTagId, name: row.identity.content, nameZh: row.identity.displayName,
      aliases: clone(row.identity.aliases), nsfw: row.identity.adult, searchable: row.identity.searchable,
      seriesId: series[0]?.id || '', seriesName: series[0]?.displayName || '', seriesTagIds: series.map(tag => tag.id),
      count: row.audit.count, fallback: row.audit.fallback, hasFeatures: Boolean(row.links.generalTagIds.length || row.links.specificTagIds.length) };
  }
  const termView = tag => clone({ ...tag, en: tag.content, zh: tag.displayName, category: tag.categoryId, nsfw: tag.adult, edited: tag.revision > 0 });
  function get(id, settings = {}) {
    const row = record(id); if (!row || !visible(row.identity, settings)) return null;
    const terms = field => row.links[field].map(tagId => requiredTag(id, tagId, field)).filter(tag => visible(tag, settings)).map(termView);
    const series = row.series.filter(tag => visible(tag, settings));
    return { ...summary(row, settings), identity: termView(row.identity), seriesTags: series.map(termView),
      // identityTags and en/content are raw editor fields. copyText/selected are output APIs.
      identityTags: [row.identity.content, ...series.map(tag => tag.content)], generalTags: terms('generalTagIds'), specificTags: terms('specificTagIds'),
      trigger: row.audit.trigger, audit: clone(row.audit) };
  }
  function indexed() {
    if (!library.status().ready) return [];
    if (!index) index = [...audit.keys()].map(id => { const row = record(id); if (!row) unresolved(id, null, 'characterId'); return row; });
    return index;
  }
  function page(settings = {}) {
    const query = normalize(settings.query), precision = precisionOf(settings.precision);
    const key = JSON.stringify([query, precision, Boolean(settings.includeAdult), settings.seriesId, Boolean(settings.discovery)]);
    let rows = pageCache.get(key);
    if (!rows) {
      if (query || settings.discovery) {
        rows = collect(o => library.search(query, o), { scope: 'characters', includeAdult: Boolean(settings.includeAdult), seriesId: settings.seriesId, precision })
          .flatMap(tag => (tag.characterMatches || [{ characterId: tag.characterId, score: tag.score }]).map(match => ({ row: record(match.characterId), score: match.score }))).filter(entry => entry.row);
      } else rows = indexed().filter(row => visible(row.identity, settings) && (!settings.seriesId || row.series.some(tag => tag.id === settings.seriesId && visible(tag, settings)))).map(row => ({ row, score: 1 }));
      rows.sort((a, b) => b.score - a.score || b.row.audit.count - a.row.audit.count || a.row.links.characterId.localeCompare(b.row.links.characterId));
      if (library.status().ready) { pageCache.set(key, rows); if (pageCache.size > 32) pageCache.delete(pageCache.keys().next().value); }
    }
    const offset = Math.max(0, Math.floor(Number(settings.offset) || 0)), limit = Math.min(100, Math.max(1, Math.floor(Number(settings.limit) || 50)));
    return { items: rows.slice(offset, offset + limit).map(entry => summary(entry.row, settings)), total: rows.length, offset, limit, hasMore: offset + limit < rows.length, revision: library.revision() };
  }
  function series(settings = {}) {
    const query = normalize(settings.query), rows = new Map();
    for (const row of indexed()) {
      if (!visible(row.identity, settings) || (query && !row.identity.searchable)) continue;
      for (const tag of row.series) {
        if (!visible(tag, settings) || (query && (!tag.searchable || ![tag.content, tag.displayName, ...tag.aliases].some(value => normalize(value).includes(query))))) continue;
        const item = rows.get(tag.id) || { id: tag.id, name: tag.displayName, content: tag.content, count: 0 };
        item.count++; rows.set(tag.id, item);
      }
    }
    return [...rows.values()].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)).slice(0, Math.min(500, Math.max(1, Number(settings.limit) || 100)));
  }
  async function edit(id, input, options) {
    if (!object(input)) return fail('INVALID_FIELD', '角色编辑字段必须为对象');
    const checkedId = validateCommand({ type: 'editCharacter', characterId: id, identityPatch: {} });
    if (!checkedId.ok) return checkedId;
    if (!library.status().ready) return fail('NOT_READY', '标签库尚未就绪');
    const links = library.getCharacterLinks(id);
    if (!links) return fail('UNRESOLVED_REFERENCE', '角色不存在');
    const fields = {}, relationPatch = {};
    const aliases = { name: 'content', nameZh: 'displayName', nsfw: 'adult', tagIds: 'generalTagIds' };
    for (const [key, value] of Object.entries(input)) {
      if (['identityPatch', 'links'].includes(key)) continue;
      const field = aliases[key] || key;
      const target = ['seriesTagIds', 'generalTagIds', 'specificTagIds'].includes(field) ? relationPatch : fields;
      if (own(target, field) && !isDeepStrictEqual(target[field], value)) return fail('INVALID_FIELD', '角色字段别名值冲突');
      target[field] = value;
    }
    if ((own(input, 'identityPatch') && Object.keys(fields).length) || (own(input, 'links') && Object.keys(relationPatch).length)) return fail('INVALID_FIELD', '不能混用完整补丁和兼容字段');
    const command = { type: 'editCharacter', characterId: id };
    if (own(input, 'identityPatch') || Object.keys(fields).length) command.identityPatch = own(input, 'identityPatch') ? input.identityPatch : fields;
    if (own(input, 'links')) command.links = input.links;
    else if (Object.keys(relationPatch).length) command.links = { ...links, ...relationPatch };
    const result = await run(command, options);
    return result.ok ? { ...result, data: get(id, { includeAdult: true }) } : result;
  }
  async function restore(id, options) {
    const result = await run({ type: 'restoreCharacter', characterId: id }, options);
    return result.ok ? { ...result, data: get(id, { includeAdult: true }) } : result;
  }
  async function select(id, settings = {}, options) {
    if (!object(settings)) return fail('INVALID_FIELD', '角色选择选项必须为对象');
    if (Object.keys(settings).some(key => !['generalTagIds', 'specificTagIds', 'includeSeries', 'includeAdult'].includes(key)) || (own(settings, 'includeAdult') && typeof settings.includeAdult !== 'boolean')) return fail('INVALID_FIELD', '角色选择字段无效');
    return run({ type: 'select', selected: true, value: { kind: 'character', characterId: id, includeSeries: own(settings, 'includeSeries') ? settings.includeSeries : true,
      generalTagIds: own(settings, 'generalTagIds') ? settings.generalTagIds : [], specificTagIds: own(settings, 'specificTagIds') ? settings.specificTagIds : [] } }, options);
  }
  function selected(settings = {}) {
    return library.selected({ includeAdult: Boolean(settings.includeAdult) }).filter(row => row.kind === 'character').map(row => {
      const id = row.key.slice('character:'.length), identity = library.getTag(library.getCharacterLinks(id).identityTagId);
      return { ...row, id, name: identity.displayName || identity.content, tags: row.tagIds.map(tagId => formatTagOutput(requiredTag(id, tagId, 'selection'))) };
    });
  }
  function copyText(id, settings = {}) {
    const row = get(id, settings); if (!row) return '';
    const general = settings.generalTagIds || [], specific = settings.specificTagIds || [];
    const ids = [...new Set([row.identityTagId, ...(settings.includeSeries !== false ? row.seriesTagIds : []), ...general, ...specific])];
    const links = library.getCharacterLinks(id);
    for (const [field, values] of [['generalTagIds', general], ['specificTagIds', specific]]) for (const tagId of values) if (!links[field].includes(tagId)) unresolved(id, tagId, field);
    return ids.map(tagId => requiredTag(id, tagId, 'copy')).filter(tag => visible(tag, settings)).map(formatTagOutput).join(', ');
  }
  return Object.freeze({
    dispose: unsubscribe, search: settings => page({ ...settings, discovery: true }),
    ready: () => library.ready(), status: () => library.status(), get, page, series, edit, restore, select, selected, copyText,
    size: () => indexed().length, count: () => audit.size,
    manifest: () => ({ ...clone(metadata), loadedCharacters: library.status().ready ? indexed().length : undefined, legacyFallbackCharacters: [...audit.values()].filter(row => row.fallback).length }),
    selectionText: settings => [...new Set(selected(settings).flatMap(row => row.tagIds))].map(id => formatTagOutput(library.getTag(id))).join(', '),
    removeSelection: (id, options) => run({ type: 'select', selected: false, value: { kind: 'character', characterId: id, includeSeries: false, generalTagIds: [], specificTagIds: [] } }, options),
    clearSelection: options => run({ type: 'clearSelection', kind: 'character' }, options),
    subscribe: fn => library.subscribe(fn), historyState: () => library.historyState(),
    editHistory: () => fail('FEATURE_UNAVAILABLE', '请使用统一撤销重做历史'),
    undo: options => run({ type: 'undo' }, options), redo: options => run({ type: 'redo' }, options), flush: () => library.flush()
  });
}
module.exports = { createCharacterAdapter };
