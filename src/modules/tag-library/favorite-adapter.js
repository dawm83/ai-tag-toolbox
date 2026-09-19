'use strict';
const { joinFavoriteBlocks, parseFavoritePaste, validateFavoriteBundle } = require('../favorites-transfer');
const { segmentSourceText } = require('../translation-alignment');
const { PALETTE } = require('./presentation-metadata');
const { fail, own, object, context, tagPatch, collect } = require('./adapter-common');

/** Membership views are derived on every read; TagView owns all editable text. */
function createFavoriteAdapter({ library } = {}) {
  const { run, success, unavailable } = context(library);
  const series = () => library.getFavoritePages();
  const sections = pageId => (pageId ? library.getFavoriteGroups(pageId) : series().flatMap(page => library.getFavoriteGroups(page.id)))
    .map(row => ({ ...row, seriesId: row.pageId }));
  const membership = id => library.getMemberships().find(row => row.id === id);
  function entry(row) {
    if (!row) return null;
    const tag = library.getTag(row.tagId); if (!tag) return null;
    const location = tag.favoriteLocations.find(value => value.membershipId === row.id);
    const selected = library.selected({ includeAdult: true }).some(value => value.kind === 'tag' && value.tagIds[0] === tag.id);
    return { id: row.id, sourceTagId: tag.id, tagId: tag.id, kind: tag.kind, seriesId: location.pageId, sectionId: row.groupId,
      title: tag.displayName, zh: tag.displayName, rawText: tag.content, aliases: tag.aliases, note: tag.note,
      nsfw: tag.adult, globalSearchable: tag.searchable, searchable: tag.searchable, pinned: row.pinned, order: row.order,
      createdAt: tag.createdAt, updatedAt: tag.updatedAt, revision: tag.revision, selected };
  }
  const getEntry = id => entry(membership(id));
  function rows(settings = {}) {
    const pages = new Map(series().map(row => [row.id, row.order])), groups = new Map(sections().map(row => [row.id, row.order]));
    let result = library.getMemberships().map(entry).filter(Boolean).filter(row =>
      (settings.includeAdult !== false || !row.nsfw) && (!settings.seriesId || row.seriesId === settings.seriesId) && (!own(settings, 'sectionId') || row.sectionId === settings.sectionId));
    if (settings.view === 'recent') {
      const recent = new Map(library.getRecentTagIds().map((id, index) => [id, index]));
      result = result.filter(row => recent.has(row.tagId)).sort((a, b) => recent.get(a.tagId) - recent.get(b.tagId));
    } else result.sort((a, b) => pages.get(a.seriesId) - pages.get(b.seriesId) || groups.get(a.sectionId) - groups.get(b.sectionId) || Number(b.pinned) - Number(a.pinned) || a.order - b.order);
    return result;
  }
  function paged(items, settings = {}) {
    const offset = Number.isSafeInteger(settings.offset) && settings.offset >= 0 ? settings.offset : 0;
    const limit = Number.isSafeInteger(settings.limit) && settings.limit > 0 ? Math.min(settings.limit, 2000) : 80;
    return { items: items.slice(offset, offset + limit), total: items.length, offset, limit, hasMore: offset + limit < items.length, revision: library.revision() };
  }
  const list = (settings = {}) => paged(rows(settings), settings);
  function search(query, settings = {}) {
    const hits = new Set(collect(o => library.search(query, o), { scope: 'favorites', includeAdult: settings.includeAdult !== false,
      precision: settings.precision, pageId: settings.seriesId, groupId: settings.sectionId }).map(row => row.id));
    return paged(rows(settings).filter(row => hits.has(row.tagId)), settings);
  }
  const placement = (input, old) => ({ kind: 'favorite', page: { id: input.seriesId ?? old?.seriesId }, group: { id: input.sectionId ?? old?.sectionId } });
  async function saveEntry(input = {}, options) {
    if (!object(input)) return fail('INVALID_FIELD', '收藏编辑字段必须为对象');
    const old = input.id ? getEntry(input.id) : null;
    if (input.id && !old) return fail('ENTRY_NOT_FOUND', '收藏不存在');
    if (old && own(input, 'sourceTagId') && input.sourceTagId !== old.tagId) return fail('INVALID_FIELD', '不能替换收藏的标签身份');
    const fields = Object.fromEntries(Object.entries(input).filter(([key]) => !['id', 'sourceTagId', 'seriesId', 'sectionId'].includes(key)));
    const checked = tagPatch(fields, { rawText: 'content', title: 'displayName', zh: 'displayName', nsfw: 'adult', globalSearchable: 'searchable' });
    if (!checked.ok) return checked;
    const tagId = old?.tagId || input.sourceTagId;
    if (!old && tagId) {
      const source = library.getTag(tagId);
      if (!source) return fail(library.status().ready ? 'TAG_NOT_FOUND' : 'NOT_READY', '来源标签尚不可用');
      if (Object.entries(checked.data).some(([key, value]) => JSON.stringify(source[key]) !== JSON.stringify(value))) return fail('INVALID_FIELD', '添加引用不能覆盖来源标签，请明确编辑共享标签');
    }
    const target = !old || own(input, 'seriesId') || own(input, 'sectionId') ? placement(input, old) : undefined;
    if (old && target) target.membershipId = old.id;
    const command = !old && tagId
      ? { type: 'favoriteTag', tagId, placement: target }
      : { type: 'saveTag', ...(tagId ? { tagId } : {}), patch: checked.data, ...(target ? { placement: target } : {}) };
    const result = await run(command, options);
    return result.ok ? { ...result, data: getEntry(result.data.membershipId || old?.id) } : result;
  }
  function checkedEntries(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string')) return fail('ENTRY_NOT_FOUND', '请选择有效收藏');
    const records = [...new Set(ids)].map(getEntry);
    return records.some(row => !row) ? fail('ENTRY_NOT_FOUND', '收藏不存在') : { ok: true, data: records };
  }
  async function duplicateEntries(input = {}, options) {
    if (!['reference', 'independent'].includes(input.mode)) return fail('INVALID_MODE', '复制必须明确选择 reference 或 independent');
    const checked = checkedEntries(input.ids); if (!checked.ok) return checked;
    const operations = checked.data.map(row => ({ type: input.mode === 'reference' ? 'favoriteTag' : 'duplicateTag', tagId: row.tagId, placement: placement(input, row) }));
    const result = await run({ type: 'batch', operations }, options);
    return result.ok ? { ...result, data: { ids: result.data.results.map(row => row.membershipId), changed: result.data.changed } } : result;
  }
  async function applyBatch(input = {}, options) {
    const checked = checkedEntries(input.ids); if (!checked.ok) return checked;
    const patch = input.patch || {};
    if (Object.keys(patch).some(key => !['seriesId', 'sectionId', 'pinned', 'globalSearchable', 'searchable', 'nsfw', 'adult'].includes(key))) return fail('INVALID_FIELD', '批量字段无效');
    const operations = [];
    if (own(patch, 'seriesId') || own(patch, 'sectionId')) for (const row of checked.data) operations.push({ type: 'move', tagId: row.tagId, placement: { ...placement(patch, row), membershipId: row.id } });
    const flags = tagPatch(Object.fromEntries(Object.entries(patch).filter(([key]) => !['seriesId', 'sectionId', 'pinned'].includes(key))), { globalSearchable: 'searchable', nsfw: 'adult' });
    if (!flags.ok) return flags;
    if (Object.keys(flags.data).length) operations.push({ type: 'setFlags', tagIds: [...new Set(checked.data.map(row => row.tagId))], ...flags.data });
    if (own(patch, 'pinned')) operations.push({ type: 'pin', membershipIds: checked.data.map(row => row.id), pinned: patch.pinned });
    return operations.length ? run({ type: 'batch', operations }, options) : success({ changed: false });
  }
  async function saveSeries(input = {}, options) {
    if (!object(input)) return fail('INVALID_FIELD', '收藏页字段必须为对象');
    if (Object.keys(input).some(key => !['id', 'name', 'color', 'colorMode'].includes(key))) return fail('INVALID_FIELD', '收藏页字段无效');
    const command = { type: 'savePage', ...input };
    if (own(input, 'color') && !own(input, 'colorMode')) command.colorMode = 'custom';
    if (!input.id && !own(input, 'color')) command.color = PALETTE[series().length % PALETTE.length];
    const result = await run(command, options); return result.ok ? { ...result, data: series().find(row => row.id === result.data.pageId) } : result;
  }
  async function saveSection(input = {}, options) {
    if (!object(input)) return fail('INVALID_FIELD', '收藏组字段必须为对象');
    if (Object.keys(input).some(key => !['id', 'name', 'color', 'seriesId'].includes(key))) return fail('INVALID_FIELD', '收藏组字段无效');
    const { seriesId, ...fields } = input;
    const result = await run({ type: 'saveGroup', pageId: seriesId, ...fields }, options);
    return result.ok ? { ...result, data: sections(seriesId).find(row => row.id === result.data.groupId) } : result;
  }
  async function setSeriesColors(ids, settings = {}, options) {
    if (!['auto', 'custom'].includes(settings.mode) || !Array.isArray(ids) || !ids.length) return fail('INVALID_FIELD', '颜色模式或收藏页无效');
    const pages = series(); const colors = new Map(pages.map(row => [row.id, row.color]));
    const operations = [...new Set(ids)].map(id => {
      const index = pages.findIndex(row => row.id === id);
      const usage = new Map(PALETTE.map(color => [color, [...colors].filter(([key, value]) => key !== id && value === color).length]));
      const ranked = [...PALETTE].sort((a, b) => usage.get(a) - usage.get(b));
      const color = settings.mode === 'custom' ? settings.color : ranked.find(value => value !== colors.get(pages[index - 1]?.id) && value !== colors.get(pages[index + 1]?.id)) || ranked[0];
      colors.set(id, color); return { type: 'colorPages', pageIds: [id], colorMode: settings.mode, ...(color === undefined ? {} : { color }) };
    });
    return run({ type: 'batch', operations }, options);
  }
  async function setSelected(id, selected, options) {
    const row = getEntry(id); if (!row) return fail('ENTRY_NOT_FOUND', '收藏不存在');
    return run({ type: 'select', value: { kind: 'tag', tagId: row.tagId }, selected }, options);
  }
  const selected = (settings = {}) => library.selected({ includeAdult: settings.includeAdult !== false }).filter(row => row.kind === 'tag').map(row => {
    const tag = library.getTag(row.tagIds[0]);
    return { key: row.key, tagId: tag.id, sourceTagId: tag.id, entryId: tag.favoriteLocations[0]?.membershipId || null,
      kind: tag.kind, title: tag.displayName, rawText: tag.content, nsfw: tag.adult, sourceUpdatedAt: tag.updatedAt };
  });
  async function markCopied(ids, options) {
    const checked = checkedEntries(ids); if (!checked.ok) return checked;
    return run({ type: 'markCopied', tagIds: [...new Set(checked.data.map(row => row.tagId))] }, options);
  }
  const favoriteMemberCount = row => !row?.rawText?.trim() ? null : row.kind === 'tag' ? 1 : row.kind === 'bundle' ? (() => {
    const segmented = segmentSourceText(row.rawText); return segmented.granularity === 'tag' ? segmented.sourceUnits.length : null;
  })() : null;
  return Object.freeze({
    ready: () => library.ready(), status: () => library.status(), series, sections, getEntry, list, search, saveEntry, saveSeries, saveSection,
    snapshot: () => ({ document: { format: 'ai-tag-favorites', version: 1, revision: library.revision(), series: series(), sections: sections(), entries: rows() },
      revision: library.revision(), status: library.status(), loadError: library.status().error, migrationReport: null }),
    applyBatch, duplicateEntries, setSeriesColors,
    async ensureTagColumns(seriesId, name = '新建标签栏', options) {
      if (!series().some(row => row.id === seriesId)) return fail('INVALID_PARENT', '收藏页不存在');
      const row = sections(seriesId)[0]; return row ? success(row) : saveSection({ seriesId, name }, options);
    },
    deleteEntries: (ids, options) => run({ type: 'unfavorite', membershipIds: ids }, options),
    deleteSection: (id, settings = {}, options) => run({ type: 'deleteGroup', groupId: id, mode: settings.mode ?? 'relocate' }, options),
    deleteSeries: async (id, settings = {}, options) => own(settings, 'targetSeriesId')
      ? fail('INVALID_FIELD', '删除归位固定使用未分类，请先显式移动')
      : run({ type: 'deletePage', pageId: id, mode: ({ move: 'relocate', delete: 'unfavorite' })[settings.mode] || settings.mode || 'relocate' }, options),
    reorder: (input = {}, options) => run({ type: 'reorder', kind: ({ series: 'page', section: 'group', entry: 'membership' })[input.kind] || input.kind, parentId: input.parentId, ids: input.ids }, options),
    copyText: ids => joinFavoriteBlocks([...new Set((ids || []).map(getEntry).filter(Boolean).map(row => row.tagId))].map(id => library.getTag(id).content)),
    markCopied, selected, setSelected, clearSelected: options => run({ type: 'clearSelection', kind: 'tag' }, options),
    undo: options => run({ type: 'undo' }, options), redo: options => run({ type: 'redo' }, options), historyState: () => library.historyState(),
    subscribe: fn => library.subscribe(event => fn({ ...event, changedEntryIds: event.changedMembershipIds })), flush: () => library.flush(),
    exportBundle: () => library.exportBundle({ scope: 'favorites' }), previewImport: value => library.previewImport(value),
    importBundle: async () => unavailable(), previewPaste: unavailable, importPaste: async () => unavailable(),
    parseFavoritePaste, validateFavoriteBundle, favoriteMemberCount
  });
}
module.exports = { createFavoriteAdapter };
