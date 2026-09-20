'use strict';
const { DEFAULT_CATEGORIES } = require('./presentation-metadata');
const { formatTagOutput } = require('./selection');
const { fail, own, clone, idOf, object, context, tagPatch, collect } = require('./adapter-common');

/** A read projection and command facade; never loads or saves a legacy store. */
function createTagAdapter({ library, metadataById = {}, categoryMetadata = DEFAULT_CATEGORIES, preferences, storage } = {}) {
  const { run, unavailable } = context(library), prefs = preferences || storage;
  const metadata = clone(metadataById);
  const categoryInfo = new Map((Array.isArray(categoryMetadata) ? categoryMetadata : Object.entries(categoryMetadata).map(([id, row]) => ({ id, ...row }))).map(row => [row.id, clone(row)]));
  const readPreference = (key, fallback) => { try { return prefs?.get(key, fallback) ?? fallback; } catch { return fallback; } };
  const savePreference = (key, value) => { try { prefs?.set(key, value); } catch { /* Presentation preferences do not commit catalog content. */ } };
  const precision = value => ['exact', 'broad'].includes(value) ? value : 'standard';
  let includeAdult = Boolean(readPreference('rewrite_adult', false)), searchPrecision = precision(readPreference('app.searchPrecision', 'standard'));
  let query = '', category = '';
  let subcategoryNames = null; const countCache = new Map();
  const unsubscribe = library.subscribe(change => {
    if (change.changedTagIds.length || change.structureChanged) countCache.clear();
    if (change.structureChanged) subcategoryNames = null;
  });
  function names() {
    if (!subcategoryNames) subcategoryNames = new Map(library.getCategories().flatMap(row => library.getSubcategories(row.id)).map(row => [row.id, row.name]));
    return subcategoryNames;
  }
  const selectedIds = () => library.selected({ includeAdult: true }).filter(row => row.kind === 'tag').map(row => row.tagIds[0]);
  function view(tag, selected = new Set(selectedIds())) {
    if (!tag) return null;
    const meta = metadata[tag.id] || {};
    return { ...tag, en: tag.content, zh: tag.displayName, nsfw: tag.adult, category: tag.categoryId,
      subcategory: names().get(tag.subcategoryId) || '',
      count: meta.count ?? null, categoryCode: meta.categoryCode ?? null, confidence: meta.confidence ?? null,
      keywords: clone(meta.keywords || []), custom: tag.source.kind !== 'bundled', edited: tag.revision > 0,
      editedAt: tag.revision > 0 ? tag.updatedAt : null, selected: selected.has(tag.id) };
  }
  function categories() {
    return library.getCategories().map(row => {
      const meta = categoryInfo.get(row.id) || {};
      return { ...row, ...Object.fromEntries(['icon', 'neg', 'nsfw'].filter(key => own(meta, key)).map(key => [key, clone(meta[key])])) };
    });
  }
  function filters(options = {}) {
    const categoryId = options.categoryId ?? options.category;
    const result = { scope: 'all', includeAdult: options.includeAdult ?? options.adult ?? options.nsfw ?? includeAdult,
      precision: options.precision ?? options.searchPrecision ?? searchPrecision };
    if (categoryId && categoryId !== 'all') result.categoryId = categoryId;
    if (options.subcategoryId) result.subcategoryId = options.subcategoryId;
    else if (options.subcategory && options.subcategory !== 'all') {
      const candidates = result.categoryId ? [result.categoryId] : library.getCategories().map(row => row.id);
      result.subcategoryId = candidates.flatMap(id => library.getSubcategories(id)).find(row => row.name === options.subcategory)?.id || 'missing:subcategory';
    }
    return result;
  }
  function projected(rows) { const selected = new Set(selectedIds()); return rows.map(row => view(row, selected)); }
  const list = (options = {}) => projected(collect(o => library.listTags(o), filters(options)));
  const search = (value, options = {}) => {
    return projected(Number.isSafeInteger(options.limit) && options.limit > 0 && options.limit <= 2000
      ? library.search(value, { ...filters(options), limit: options.limit }).items
      : collect(o => library.search(value, o), filters(options)).slice(0, options.limit || Infinity));
  };
  function counts(adult) {
    if (!library.status().ready) return { categories: { all: 0 }, subcategories: {} };
    if (!countCache.has(adult)) countCache.set(adult, library.tagCounts({ includeAdult: adult }));
    return countCache.get(adult);
  }
  function categoryCounts(adult = includeAdult) { return clone(counts(adult).categories); }
  function subcategories(value, options = {}) {
    const count = counts(filters(options).includeAdult).subcategories;
    return library.getSubcategories(value).filter(row => count[row.id]).map(row => ({ id: row.id, name: row.name, count: count[row.id] }));
  }
  const get = value => view(library.getTag(idOf(value)));
  function editablePatch(input, current) {
    if (!object(input) || !own(input, 'subcategory')) return tagPatch(input, { en: 'content', zh: 'displayName', nsfw: 'adult', category: 'categoryId' });
    const { subcategory, ...rest } = input;
    const parent = input.categoryId ?? input.category ?? current?.categoryId;
    const found = library.getSubcategories(parent).find(row => row.name === subcategory);
    if (!found) return fail('INVALID_PARENT', '子分类不存在，请使用统一位置命令创建');
    if (own(rest, 'subcategoryId') && rest.subcategoryId !== found.id) return fail('INVALID_FIELD', '子分类名称和 ID 冲突');
    return tagPatch({ ...rest, subcategoryId: found.id }, { en: 'content', zh: 'displayName', nsfw: 'adult', category: 'categoryId' });
  }
  async function edit(value, input, options) {
    const checked = editablePatch(input, library.getTag(idOf(value)));
    if (!checked.ok) return checked;
    const result = await run({ type: 'saveTag', tagId: idOf(value), patch: checked.data }, options);
    return result.ok ? { ...result, data: get(result.data.tagId) } : result;
  }
  async function addCustom(value, options) {
    const input = typeof value === 'string' ? { en: value } : value;
    const checked = editablePatch(input);
    if (!checked.ok) return checked;
    const result = await run({ type: 'saveTag', patch: checked.data }, options);
    return result.ok ? { ...result, data: get(result.data.tagId) } : result;
  }
  const select = (value, selected = true, options) => run({ type: 'select', value: { kind: 'tag', tagId: idOf(value) }, selected }, options);
  const selected = (options = {}) => library.selected({ includeAdult: options.includeAdult ?? includeAdult }).filter(row => row.kind === 'tag').map(row => get(row.tagIds[0]));
  const stateSnapshot = () => ({ query, category, includeAdult, searchPrecision, revision: library.revision(), selected: selectedIds(), categories: categories(), categoryCounts: categoryCounts(), status: library.status() });
  function page(options = {}) {
    const value = options.query ?? query, filter = filters({ category, ...options });
    if (value) { delete filter.categoryId; delete filter.subcategoryId; }
    const requested = { ...filter, offset: options.offset, limit: options.limit ?? 200 };
    const result = value ? library.search(value, requested) : library.listTags(requested);
    return { ...result, items: projected(result.items), displayTotal: result.total, maxDisplay: Infinity, categoryCounts: categoryCounts(filter.includeAdult), query: value, category: filter.categoryId || '', subcategory: options.subcategory || '', includeAdult: filter.includeAdult };
  }
  return Object.freeze({
    dispose: unsubscribe, revision: () => library.revision(), searchSettings: () => ({ includeAdult, precision: searchPrecision }),
    ready: () => library.ready(), status: () => library.status(), isLoaded: () => library.status().ready,
    get, describe: values => library.describeTags(values, { includeAdult }), has: value => Boolean(library.getTag(idOf(value))), list, all: list, allTags: list, getAll: list, search, page,
    size: () => library.listTags({ includeAdult: true, limit: 0 }).total,
    categories, getCategories: categories, categoryCounts, subcategories, getSubcategories: subcategories,
    characterNameIndex: () => list({ category: 'character_names', includeAdult: true }),
    customTags: () => list({ includeAdult: true }).filter(row => row.custom),
    setQuery(value) { query = String(value ?? '').trim(); return query ? search(query) : list({ category }); },
    setCategory(value) { category = String(value ?? 'all'); return query ? search(query) : list({ category }); },
    setAdult(value) { includeAdult = Boolean(value); savePreference('rewrite_adult', includeAdult); return query ? search(query) : list({ category }); },
    setSearchPrecision(value, options = {}) { searchPrecision = precision(value); if (options.persist !== false) savePreference('app.searchPrecision', searchPrecision); return searchPrecision; },
    searchPrecisions: () => ['exact', 'standard', 'broad'], stateSnapshot,
    snapshot: () => ({ ...stateSnapshot(), size: library.listTags({ includeAdult: true, limit: 0 }).total, allTags: list({ includeAdult: true }), custom: list({ includeAdult: true }).filter(row => row.custom).map(row => row.id) }),
    edit, addCustom, restore: (value, options) => run({ type: 'restoreTag', tagId: idOf(value) }, options),
    removeCustom: (value, options) => run({ type: 'deleteTag', tagId: idOf(value) }, options),
    select, toggleSelected: (value, options) => select(value, !selectedIds().includes(idOf(value)), options), selected,
    selectedText: (separator = ', ') => selected().map(formatTagOutput).join(separator),
    copyText: ids => [...new Set(ids || [])].map(get).filter(Boolean).map(formatTagOutput).join(', '),
    clearSelection: options => run({ type: 'clearSelection', kind: 'tag' }, options),
    markCopied: (tagIds, options) => run({ type: 'markCopied', tagIds }, options),
    undo: options => run({ type: 'undo' }, options), redo: options => run({ type: 'redo' }, options),
    historyState: () => library.historyState(), subscribe: fn => library.subscribe(fn), flush: () => library.flush(),
    load: async () => unavailable(), loadFiles: async () => unavailable(), restoreUserState: () => stateSnapshot(),
    editHistory: () => fail('FEATURE_UNAVAILABLE', '请使用统一撤销重做历史')
  });
}
module.exports = { createTagAdapter };
