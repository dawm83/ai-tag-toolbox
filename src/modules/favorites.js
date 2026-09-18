'use strict';

const { segmentSourceText } = require('./translation-alignment');
const { joinFavoriteBlocks, parseFavoritePaste, validateFavoriteBundle } = require('./favorites-transfer');

const SHELF_KEY = 'favorites_shelf_v1';
const SELECTION_KEY = 'favorites_selection_v1';
const RECENT_KEY = 'favorites_recent_v1';
const LEGACY_KEY = 'rewrite_favorites';
const COLLECTIONS = ['series', 'sections', 'entries'];
const PALETTE = Object.freeze(['#287EA4', '#C75450', '#5A8F50', '#B67823', '#7256A8', '#00897B', '#B04A7A', '#65737E', '#8B6F47', '#446CB3']);
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const emptyDocument = () => ({ format: 'ai-tag-favorites', version: 1, revision: 0, series: [], sections: [], entries: [] });
let idCounter = 0;

const errorResult = (code, message) => ({ ok: false, error: { code, message } });
const text = value => typeof value === 'string' ? value : '';
const unique = values => [...new Set((Array.isArray(values) ? values : []).map(String))];
const sectionIdOf = value => value === '' || value === undefined || value === null ? null : value;
const pageLimit = value => {
  const parsed = Math.floor(Number(value));
  return Math.min(500, Number.isFinite(parsed) && parsed > 0 ? parsed : 80);
};

function favoriteMemberCount(entry) {
  if (!entry || !text(entry.rawText).trim()) return null;
  if (entry.kind === 'tag') return 1;
  if (entry.kind !== 'bundle') return null;
  const segmented = segmentSourceText(entry.rawText);
  return segmented.granularity === 'tag' ? segmented.sourceUnits.length : null;
}

function createFavorites(options = {}) {
  const storage = options.storage;
  const tags = options.tags;
  const listeners = new Set();
  const undoStack = [], redoStack = [];
  let document = emptyDocument();
  let loadError = null;
  let migrationReport = null;
  let writeError = null;
  let selectedRows = [];
  let recentIds = [];
  let shelfRevision = -1;
  let shelfCache = [];
  let searchRevision = -1;
  let searchIndex = [];

  const result = data => ({ ok: true, data: clone(data), revision: document.revision });
  const allIds = doc => new Set(COLLECTIONS.flatMap(name => doc[name].map(row => row.id)));
  const makeId = (prefix, doc = document) => {
    const ids = allIds(doc);
    let id;
    do { id = `${prefix}-${Date.now().toString(36)}-${(++idCounter).toString(36)}`; } while (ids.has(id));
    return id;
  };
  const getStored = (key, fallback) => {
    try { return storage?.get?.(key, fallback) ?? fallback; } catch { return fallback; }
  };
  const setStored = (key, value) => {
    if (typeof storage?.set !== 'function') { writeError = null; return true; }
    let reportedError = null;
    let unsubscribe = null;
    try {
      if (typeof storage.subscribeErrors === 'function') unsubscribe = storage.subscribeErrors(error => { reportedError = error; });
      if (storage.set(key, clone(value)) === false) throw new Error('Storage rejected the write');
      if (reportedError) throw new Error(reportedError.message || 'Storage rejected the write');
      writeError = null;
      return true;
    } catch (cause) {
      writeError = { code: 'STORAGE_WRITE_FAILED', message: cause.message || '收藏保存失败' };
      return false;
    } finally {
      try { unsubscribe?.(); } catch { /* Error observers do not own writes. */ }
    }
  };

  function migrateLegacy(rows) {
    const next = emptyDocument();
    const unresolved = [], invalid = [];
    const series = { id: makeId('series', next), name: '未分类', order: 0, colorMode: 'auto', color: PALETTE[0] };
    next.series.push(series);
    rows.forEach((source, index) => {
      const old = object(source) ? source : {};
      let inheritedNsfw = old.nsfw === true;
      const values = (Array.isArray(old.tags) ? old.tags : []).flatMap(value => {
        if (typeof value !== 'string' || !value.trim()) return [];
        let found = null;
        try { found = tags?.get?.(value); } catch { /* Preserve the legacy ID when the dictionary is unavailable. */ }
        if (found?.nsfw === true) inheritedNsfw = true;
        if (!found?.en) unresolved.push(value);
        return [found?.en || value];
      });
      if (!values.length && typeof old.rawText === 'string' && old.rawText.trim()) values.push(old.rawText);
      const bad = !object(source) || !values.length;
      if (bad) invalid.push({ index, record: clone(source) });
      next.entries.push({
        id: makeId('entry', next), kind: values.length > 1 ? 'bundle' : 'tag', seriesId: series.id, sectionId: null,
        title: text(old.name || old.title), rawText: joinFavoriteBlocks(values), zh: '', aliases: [], note: '',
        globalSearchable: true, pinned: false, nsfw: inheritedNsfw, order: index, sourceTagId: null,
        createdAt: 0, updatedAt: 0,
        ...(bad ? { legacyInvalid: true, legacySource: clone(source) } : {})
      });
    });
    next.revision = rows.length ? 1 : 0;
    return { next, report: { migrated: rows.length, unresolved: [...new Set(unresolved)], invalid } };
  }

  function load() {
    let raw;
    try { raw = storage?.get?.(SHELF_KEY, null); }
    catch (cause) { loadError = { code: 'FAVORITES_LOAD_FAILED', message: cause.message }; return; }
    if (raw !== null && raw !== undefined) {
      const checked = validateFavoriteBundle(raw);
      if (!checked.ok) { loadError = { code: 'INVALID_FAVORITES_DOCUMENT', message: checked.error.message }; return; }
      document = checked.data;
    } else {
      const legacy = getStored(LEGACY_KEY, []);
      if (Array.isArray(legacy) && legacy.length) {
        const migrated = migrateLegacy(legacy);
        const checked = validateFavoriteBundle(migrated.next);
        if (!checked.ok) { loadError = { code: 'LEGACY_MIGRATION_FAILED', message: checked.error.message }; return; }
        document = checked.data;
        migrationReport = migrated.report;
        setStored(SHELF_KEY, document);
      }
    }
    selectedRows = (Array.isArray(getStored(SELECTION_KEY, [])) ? getStored(SELECTION_KEY, []) : []).filter(row => object(row) && typeof row.entryId === 'string' && ['tag', 'bundle'].includes(row.kind) && typeof row.title === 'string' && typeof row.rawText === 'string' && typeof row.nsfw === 'boolean' && Number.isFinite(row.sourceUpdatedAt)).map(clone);
    recentIds = unique(getStored(RECENT_KEY, [])).slice(0, 20);
  }

  function diff(before, after) {
    const changes = [];
    for (const collection of COLLECTIONS) {
      const left = new Map(before[collection].map((row, index) => [row.id, { row, index }]));
      const right = new Map(after[collection].map((row, index) => [row.id, { row, index }]));
      for (const id of new Set([...left.keys(), ...right.keys()])) {
        const a = left.get(id), b = right.get(id);
        if (!a || !b || !same(a.row, b.row)) changes.push({ collection, id, before: clone(a?.row ?? null), after: clone(b?.row ?? null), beforeIndex: a?.index ?? -1, afterIndex: b?.index ?? -1 });
      }
    }
    return changes;
  }

  function mergeHistory(previous, current) {
    const merged = new Map(previous.changes.map(change => [`${change.collection}:${change.id}`, clone(change)]));
    for (const change of current.changes) {
      const key = `${change.collection}:${change.id}`;
      const old = merged.get(key);
      if (old) merged.set(key, { ...old, after: clone(change.after), afterIndex: change.afterIndex });
      else merged.set(key, clone(change));
    }
    return { historyKey: previous.historyKey, changes: [...merged.values()].filter(change => change.beforeIndex !== change.afterIndex || !same(change.before, change.after)) };
  }

  function eventFor(changes) {
    const changedEntryIds = unique(changes.filter(change => change.collection === 'entries').map(change => change.id));
    const structureChanged = changes.some(change => change.collection !== 'entries' || !change.before || !change.after || ['seriesId', 'sectionId', 'order', 'pinned'].some(key => change.before[key] !== change.after[key]));
    return { revision: document.revision, changedEntryIds, structureChanged };
  }

  function publish(changes) {
    const event = eventFor(changes);
    listeners.forEach(listener => { try { listener(clone(event)); } catch { /* Observers do not block storage. */ } });
  }

  function commit(candidate, data, settings = {}) {
    if (loadError) return errorResult('LOAD_ERROR', '收藏数据加载失败，已阻止覆盖');
    candidate.revision = document.revision;
    const checked = validateFavoriteBundle(candidate);
    if (!checked.ok) return checked;
    const changes = diff(document, checked.data);
    if (!changes.length) return result(typeof data === 'function' ? data(document) : data);
    const before = document;
    checked.data.revision = before.revision + 1;
    if (!setStored(SHELF_KEY, checked.data)) return errorResult('STORAGE_WRITE_FAILED', writeError?.message || '收藏保存失败');
    document = checked.data;
    searchRevision = -1;
    if (settings.history !== false) {
      const operation = { historyKey: settings.historyKey || null, changes };
      const last = undoStack.at(-1);
      if (operation.historyKey && last?.historyKey === operation.historyKey) undoStack[undoStack.length - 1] = mergeHistory(last, operation);
      else undoStack.push(operation);
      if (undoStack.length > 30) undoStack.splice(0, undoStack.length - 30);
      redoStack.length = 0;
    }
    publish(changes);
    return result(typeof data === 'function' ? data(document) : data);
  }

  function applyHistory(operation, direction) {
    const candidate = clone(document);
    for (const collection of COLLECTIONS) {
      const changes = operation.changes.filter(change => change.collection === collection);
      if (!changes.length) continue;
      const changed = new Set(changes.map(change => change.id));
      const rows = candidate[collection].filter(row => !changed.has(row.id));
      const inserts = changes.map(change => ({ row: clone(change[direction]), index: change[`${direction}Index`] })).filter(item => item.row).sort((a, b) => a.index - b.index);
      for (const item of inserts) rows.splice(Math.min(item.index, rows.length), 0, item.row);
      candidate[collection] = rows;
    }
    const checked = validateFavoriteBundle({ ...candidate, revision: document.revision });
    if (!checked.ok) return checked;
    const changes = diff(document, checked.data);
    checked.data.revision = document.revision + 1;
    if (!setStored(SHELF_KEY, checked.data)) return errorResult('STORAGE_WRITE_FAILED', writeError?.message || '收藏保存失败');
    document = checked.data;
    searchRevision = -1;
    publish(changes);
    return result({ changed: changes.length });
  }

  function orderedSeries(doc = document) { return clone(doc.series).sort((a, b) => a.order - b.order); }
  function orderedSections(seriesId, doc = document) { return clone(doc.sections).filter(row => !seriesId || row.seriesId === seriesId).sort((a, b) => a.order - b.order); }
  function shelfRows() {
    if (shelfRevision === document.revision) return shelfCache;
    const seriesRank = new Map([...document.series].sort((a, b) => a.order - b.order).map((row, index) => [row.id, index]));
    const sections = new Map();
    for (const row of document.sections) sections.set(row.id, row);
    shelfCache = [...document.entries].sort((a, b) => {
      const seriesOrder = (seriesRank.get(a.seriesId) ?? 0) - (seriesRank.get(b.seriesId) ?? 0);
      if (seriesOrder) return seriesOrder;
      const sectionA = a.sectionId ? (sections.get(a.sectionId)?.order ?? 0) + 1 : 0;
      const sectionB = b.sectionId ? (sections.get(b.sectionId)?.order ?? 0) + 1 : 0;
      return sectionA - sectionB || Number(b.pinned) - Number(a.pinned) || a.order - b.order;
    });
    shelfRevision = document.revision;
    return shelfCache;
  }

  function chooseColor(doc, position, ignored = new Set()) {
    const rows = orderedSeries(doc).filter(row => !ignored.has(row.id));
    const usage = new Map(PALETTE.map(color => [color, 0]));
    rows.forEach(row => usage.set(row.color, (usage.get(row.color) || 0) + 1));
    const current = orderedSeries(doc);
    const left = current[position - 1]?.color, right = current[position + 1]?.color;
    const ranked = [...PALETTE].sort((a, b) => (usage.get(a) || 0) - (usage.get(b) || 0) || PALETTE.indexOf(a) - PALETTE.indexOf(b));
    return ranked.find(color => color !== left && color !== right) || ranked[0];
  }

  function saveSeries(patch = {}) {
    const candidate = clone(document);
    let id = text(patch.id);
    if (id) {
      const row = candidate.series.find(item => item.id === id);
      if (!row) return errorResult('SERIES_NOT_FOUND', '系列不存在');
      if (typeof patch.name !== 'string' || !patch.name.trim()) return errorResult('INVALID_SERIES', '系列名称不能为空');
      row.name = patch.name.trim();
      if (patch.color !== undefined) {
        if (typeof patch.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(patch.color)) return errorResult('INVALID_SERIES', '系列颜色无效');
        row.color = patch.color.toUpperCase(); row.colorMode = 'custom';
      }
    } else {
      if (typeof patch.name !== 'string' || !patch.name.trim()) return errorResult('INVALID_SERIES', '系列名称不能为空');
      id = makeId('series', candidate);
      const order = candidate.series.length ? Math.max(...candidate.series.map(row => row.order)) + 1 : 0;
      candidate.series.push({ id, name: patch.name.trim(), order, colorMode: 'auto', color: chooseColor(candidate, candidate.series.length) });
    }
    return commit(candidate, doc => doc.series.find(row => row.id === id));
  }

  function saveSection(patch = {}) {
    const candidate = clone(document);
    let id = text(patch.id);
    const seriesId = text(patch.seriesId);
    if (!candidate.series.some(row => row.id === seriesId)) return errorResult('SERIES_NOT_FOUND', '系列不存在');
    if (typeof patch.name !== 'string' || !patch.name.trim()) return errorResult('INVALID_SECTION', '子分类名称不能为空');
    if (id) {
      const row = candidate.sections.find(item => item.id === id);
      if (!row) return errorResult('SECTION_NOT_FOUND', '子分类不存在');
      row.seriesId = seriesId; row.name = patch.name.trim();
      if (patch.color !== undefined) {
        if (typeof patch.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(patch.color)) return errorResult('INVALID_SECTION', '子分类颜色无效');
        row.color = patch.color;
      }
      candidate.entries.filter(entry => entry.sectionId === id).forEach(entry => { entry.seriesId = seriesId; });
    } else {
      id = makeId('section', candidate);
      const peers = candidate.sections.filter(row => row.seriesId === seriesId);
      const order = peers.length ? Math.max(...peers.map(row => row.order)) + 1 : 0;
      const color = typeof patch.color === 'string' && /^#[0-9a-f]{6}$/i.test(patch.color) ? patch.color : PALETTE[peers.length % PALETTE.length];
      candidate.sections.push({ id, seriesId, name: patch.name.trim(), order, color });
    }
    return commit(candidate, doc => doc.sections.find(row => row.id === id));
  }

  function saveEntry(patch = {}, settings = {}) {
    const candidate = clone(document);
    const now = Date.now();
    let id = text(patch.id);
    if (Object.prototype.hasOwnProperty.call(patch, 'rawText') && (typeof patch.rawText !== 'string' || !patch.rawText.trim())) return errorResult('RAW_TEXT_REQUIRED', '收藏原文不能为空');
    if (id) {
      const row = candidate.entries.find(item => item.id === id);
      if (!row) return errorResult('ENTRY_NOT_FOUND', '收藏不存在');
      const before = clone(row);
      for (const key of ['kind', 'seriesId', 'sectionId', 'title', 'rawText', 'zh', 'aliases', 'note', 'globalSearchable', 'pinned', 'nsfw', 'order', 'sourceTagId']) if (Object.prototype.hasOwnProperty.call(patch, key)) row[key] = key === 'sectionId' ? sectionIdOf(patch[key]) : clone(patch[key]);
      if (Object.prototype.hasOwnProperty.call(patch, 'rawText')) { delete row.legacyInvalid; delete row.legacySource; }
      if (!same(before, row)) row.updatedAt = now;
    } else {
      id = makeId('entry', candidate);
      const seriesId = text(patch.seriesId);
      const sectionId = sectionIdOf(patch.sectionId);
      const peers = candidate.entries.filter(row => row.seriesId === seriesId && row.sectionId === sectionId);
      const order = peers.length ? Math.max(...peers.map(row => row.order)) + 1 : 0;
      candidate.entries.push({ id, kind: patch.kind || 'tag', seriesId, sectionId, title: text(patch.title), rawText: patch.rawText, zh: text(patch.zh), aliases: Array.isArray(patch.aliases) ? patch.aliases.map(String) : [], note: text(patch.note), globalSearchable: patch.globalSearchable !== false, pinned: Boolean(patch.pinned), nsfw: Boolean(patch.nsfw), order, sourceTagId: patch.sourceTagId ?? null, createdAt: now, updatedAt: now });
    }
    return commit(candidate, doc => doc.entries.find(row => row.id === id), { historyKey: settings.historyKey });
  }

  function applyBatch(input = {}) {
    const ids = unique(input.ids);
    const patch = object(input.patch) ? input.patch : {};
    const allowed = new Set(['seriesId', 'sectionId', 'pinned', 'globalSearchable']);
    if (Object.keys(patch).some(key => !allowed.has(key))) return errorResult('INVALID_PATCH', '批量修改字段无效');
    if (!ids.length || ids.some(id => !document.entries.some(row => row.id === id))) return errorResult('ENTRY_NOT_FOUND', '收藏不存在');
    const candidate = clone(document);
    for (const row of candidate.entries.filter(entry => ids.includes(entry.id))) {
      const before = clone(row);
      const targetSeries = Object.prototype.hasOwnProperty.call(patch, 'seriesId') ? text(patch.seriesId) : row.seriesId;
      if (!candidate.series.some(series => series.id === targetSeries)) return errorResult('SERIES_NOT_FOUND', '系列不存在');
      let targetSection = Object.prototype.hasOwnProperty.call(patch, 'sectionId') ? sectionIdOf(patch.sectionId) : row.sectionId;
      if (targetSection !== null && !candidate.sections.some(section => section.id === targetSection && section.seriesId === targetSeries)) {
        if (Object.prototype.hasOwnProperty.call(patch, 'seriesId')) targetSection = null;
        else return errorResult('SECTION_NOT_FOUND', '子分类不存在或不属于目标系列');
      }
      row.seriesId = targetSeries; row.sectionId = targetSection;
      if (Object.prototype.hasOwnProperty.call(patch, 'pinned')) row.pinned = Boolean(patch.pinned);
      if (Object.prototype.hasOwnProperty.call(patch, 'globalSearchable')) row.globalSearchable = Boolean(patch.globalSearchable);
      if (!same(before, row)) row.updatedAt = Date.now();
    }
    return commit(candidate, { updated: ids.length });
  }

  function duplicateEntries(input = {}) {
    const ids = unique(input.ids);
    if (!ids.length || ids.some(id => !document.entries.some(row => row.id === id))) return errorResult('ENTRY_NOT_FOUND', '收藏不存在');
    const candidate = clone(document), created = [];
    for (const sourceId of ids) {
      const source = document.entries.find(row => row.id === sourceId);
      const seriesId = input.seriesId || source.seriesId;
      const sectionId = Object.prototype.hasOwnProperty.call(input, 'sectionId') ? sectionIdOf(input.sectionId) : source.sectionId;
      if (!candidate.series.some(row => row.id === seriesId)) return errorResult('SERIES_NOT_FOUND', '系列不存在');
      if (sectionId && !candidate.sections.some(row => row.id === sectionId && row.seriesId === seriesId)) return errorResult('SECTION_NOT_FOUND', '子分类不存在或不属于目标系列');
      const peers = candidate.entries.filter(row => row.seriesId === seriesId && row.sectionId === sectionId);
      const id = makeId('entry', candidate), now = Date.now();
      candidate.entries.push({ ...clone(source), id, seriesId, sectionId, title: source.title ? `${source.title} 副本` : '', order: peers.length ? Math.max(...peers.map(row => row.order)) + 1 : 0, createdAt: now, updatedAt: now });
      created.push(id);
    }
    return commit(candidate, { ids: created });
  }

  function deleteEntries(idsValue) {
    const ids = unique(idsValue);
    const found = ids.filter(id => document.entries.some(row => row.id === id));
    const candidate = clone(document);
    candidate.entries = candidate.entries.filter(row => !found.includes(row.id));
    const committed = commit(candidate, { removed: found.length });
    if (committed.ok && found.length) {
      recentIds = recentIds.filter(id => !found.includes(id));
      setStored(RECENT_KEY, recentIds);
    }
    return committed;
  }

  function deleteSection(id) {
    if (!document.sections.some(row => row.id === id)) return errorResult('SECTION_NOT_FOUND', '子分类不存在');
    const candidate = clone(document);
    const section = candidate.sections.find(row => row.id === id);
    let order = Math.max(-1, ...candidate.entries.filter(row => row.seriesId === section.seriesId && row.sectionId === null).map(row => row.order));
    candidate.entries.filter(row => row.sectionId === id).forEach(row => { row.sectionId = null; row.order = ++order; });
    candidate.sections = candidate.sections.filter(row => row.id !== id);
    return commit(candidate, { moved: document.entries.filter(row => row.sectionId === id).length });
  }

  function deleteSeries(id, settings = {}) {
    if (!document.series.some(row => row.id === id)) return errorResult('SERIES_NOT_FOUND', '系列不存在');
    const mode = settings.mode;
    if (!['move', 'delete'].includes(mode)) return errorResult('INVALID_MODE', '请选择移动或删除');
    const candidate = clone(document);
    const affected = candidate.entries.filter(row => row.seriesId === id).length;
    if (mode === 'move') {
      const explicitTarget = Object.prototype.hasOwnProperty.call(settings, 'targetSeriesId');
      let target = settings.targetSeriesId;
      if (explicitTarget) {
        if (target === id || !candidate.series.some(row => row.id === target)) return errorResult('SERIES_NOT_FOUND', '目标系列不存在');
      } else {
        target = candidate.series.find(row => row.id !== id && row.name === '未分类')?.id;
        if (!target) {
          candidate.series = candidate.series.filter(row => row.id !== id);
          target = makeId('series', candidate);
          const order = candidate.series.length ? Math.max(...candidate.series.map(row => row.order)) + 1 : 0;
          candidate.series.push({ id: target, name: '未分类', order, colorMode: 'auto', color: chooseColor(candidate, candidate.series.length) });
        }
      }
      let order = Math.max(-1, ...candidate.entries.filter(row => row.seriesId === target && row.sectionId === null).map(row => row.order));
      candidate.entries.filter(row => row.seriesId === id).forEach(row => { row.seriesId = target; row.sectionId = null; row.order = ++order; });
    } else candidate.entries = candidate.entries.filter(row => row.seriesId !== id);
    candidate.sections = candidate.sections.filter(row => row.seriesId !== id);
    candidate.series = candidate.series.filter(row => row.id !== id);
    return commit(candidate, { affected });
  }

  function reorder(input = {}) {
    const kind = input.kind, ids = unique(input.ids);
    let rows;
    if (kind === 'series' && input.parentId === null) rows = document.series;
    else if (kind === 'section' && document.series.some(row => row.id === input.parentId)) rows = document.sections.filter(row => row.seriesId === input.parentId);
    else if (kind === 'entry') {
      const section = document.sections.find(row => row.id === input.parentId);
      rows = section ? document.entries.filter(row => row.sectionId === section.id) : document.entries.filter(row => row.seriesId === input.parentId && row.sectionId === null);
    } else return errorResult('INVALID_ORDER', '排序父级无效');
    const expected = rows.map(row => row.id);
    if (ids.length !== expected.length || new Set(ids).size !== ids.length || ids.some(id => !expected.includes(id))) return errorResult('INVALID_ORDER', '排序必须包含父级下全部项目');
    const candidate = clone(document), collection = kind === 'series' ? candidate.series : kind === 'section' ? candidate.sections : candidate.entries;
    ids.forEach((id, order) => { collection.find(row => row.id === id).order = order; });
    return commit(candidate, { reordered: ids.length });
  }

  function setSeriesColors(idsValue, settings = {}) {
    const ids = unique(idsValue);
    if (!ids.length || ids.some(id => !document.series.some(row => row.id === id))) return errorResult('SERIES_NOT_FOUND', '系列不存在');
    if (!['auto', 'custom'].includes(settings.mode)) return errorResult('INVALID_COLOR', '颜色模式无效');
    if (settings.mode === 'custom' && !/^#[0-9a-f]{6}$/i.test(text(settings.color))) return errorResult('INVALID_COLOR', '颜色必须为 HEX');
    const candidate = clone(document), ordered = orderedSeries(candidate);
    for (const id of ids) {
      const row = candidate.series.find(series => series.id === id);
      row.colorMode = settings.mode;
      row.color = settings.mode === 'custom' ? settings.color.toUpperCase() : chooseColor(candidate, ordered.findIndex(series => series.id === id), new Set([id]));
    }
    return commit(candidate, { updated: ids.length });
  }

  function normalized(value) {
    let valueOut = '';
    const map = [];
    for (let index = 0; index < value.length;) {
      const char = String.fromCodePoint(value.codePointAt(index));
      const end = index + char.length;
      const piece = char.normalize('NFKC').toLowerCase().replace(/_/g, ' ');
      for (const output of piece) {
        const normalizedChar = /\s/u.test(output) ? ' ' : output;
        if (normalizedChar === ' ' && valueOut.endsWith(' ')) { map[map.length - 1].end = end; continue; }
        valueOut += normalizedChar;
        for (let unit = 0; unit < normalizedChar.length; unit += 1) map.push({ start: index, end });
      }
      index = end;
    }
    let start = 0, finish = valueOut.length;
    while (start < finish && valueOut[start] === ' ') start += 1;
    while (finish > start && valueOut[finish - 1] === ' ') finish -= 1;
    return { value: valueOut.slice(start, finish), map: map.slice(start, finish) };
  }

  function rebuildSearch() {
    if (searchRevision === document.revision) return;
    const series = new Map(document.series.map(row => [row.id, row]));
    const sections = new Map(document.sections.map(row => [row.id, row]));
    searchIndex = shelfRows().map((entry, shelfIndex) => {
      const fields = [
        ['title', entry.title, 'primary'], ['rawText', entry.rawText, 'primary'], ['zh', entry.zh, 'secondary'],
        ...entry.aliases.map(alias => ['aliases', alias, 'secondary']), ['note', entry.note, 'private'],
        ['seriesName', series.get(entry.seriesId)?.name || '', 'private'], ['sectionName', sections.get(entry.sectionId)?.name || '', 'private']
      ].filter(([, value]) => value).map(([field, value, tier]) => ({ field, original: value, tier, ...normalized(value) }));
      return { entry, shelfIndex, fields, seriesName: series.get(entry.seriesId)?.name || '', sectionName: sections.get(entry.sectionId)?.name || '' };
    });
    searchRevision = document.revision;
  }

  function search(query, settings = {}) {
    rebuildSearch();
    const scope = settings.scope || 'internal';
    const needle = normalized(text(query)).value;
    const terms = needle.split(' ').filter(Boolean);
    const includeAdult = settings.includeAdult !== false;
    const scored = [];
    for (const indexed of searchIndex) {
      const entry = indexed.entry;
      if (!needle || (scope === 'global' && !entry.globalSearchable) || (!includeAdult && entry.nsfw) || (settings.seriesId && entry.seriesId !== settings.seriesId) || (Object.prototype.hasOwnProperty.call(settings, 'sectionId') && entry.sectionId !== settings.sectionId) || (settings.kind && settings.kind !== 'all' && entry.kind !== settings.kind)) continue;
      const fields = indexed.fields.filter(field => scope === 'internal' || field.tier !== 'private');
      const chosen = [];
      let score = 0, rejected = false;
      for (const term of terms) {
        let best = null;
        for (const field of fields) {
          const at = field.value.indexOf(term);
          if (at < 0) continue;
          const exact = field.value === term, prefix = at === 0;
          const points = field.tier === 'primary' ? (exact ? 1000 : prefix ? 800 : 500) : field.tier === 'secondary' ? (exact ? 700 : prefix ? 650 : 600) : 300;
          if (!best || points > best.points) best = { field, at, points, term };
        }
        if (!best) { rejected = true; break; }
        chosen.push(best); score += best.points;
      }
      if (rejected) continue;
      const wholeCandidates = fields.map(field => ({ field, at: field.value.indexOf(needle) })).filter(item => item.at >= 0).map(item => {
        const exact = item.field.value === needle, prefix = item.at === 0;
        const bonus = item.field.tier === 'primary' ? (exact ? 2000 : prefix ? 1500 : 1000) : item.field.tier === 'secondary' ? (exact ? 900 : prefix ? 800 : 700) : 400;
        return { ...item, bonus };
      }).sort((a, b) => b.bonus - a.bonus);
      const whole = wholeCandidates[0];
      if (whole) score += whole.bonus;
      const sources = [];
      for (const source of (whole ? [{ field: whole.field, term: needle }] : chosen)) {
        let at = source.field.value.indexOf(source.term);
        while (at >= 0) {
          sources.push({ ...source, at });
          at = source.field.value.indexOf(source.term, at + Math.max(1, source.term.length));
        }
      }
      const matches = sources.map(item => {
        const first = item.field.map[item.at], last = item.field.map[item.at + item.term.length - 1];
        return { field: item.field.field, start: first?.start ?? 0, end: last?.end ?? item.field.original.length };
      }).filter((match, index, all) => all.findIndex(other => other.field === match.field && other.start === match.start && other.end === match.end) === index);
      scored.push({ indexed, score, matches });
    }
    scored.sort((a, b) => b.score - a.score || a.indexed.shelfIndex - b.indexed.shelfIndex);
    const offset = Math.max(0, Math.floor(Number(settings.offset) || 0));
    const limit = pageLimit(settings.limit);
    const items = scored.slice(offset, offset + limit).map(({ indexed, score, matches }) => ({
      entryId: indexed.entry.id, kind: indexed.entry.kind, title: indexed.entry.title, rawText: indexed.entry.rawText, zh: indexed.entry.zh,
      seriesId: indexed.entry.seriesId, sectionId: indexed.entry.sectionId, seriesName: indexed.seriesName, sectionName: indexed.sectionName,
      color: document.series.find(row => row.id === indexed.entry.seriesId)?.color || PALETTE[0], memberCount: favoriteMemberCount(indexed.entry), matches, score
    }));
    return { items, total: scored.length, offset, limit, hasMore: offset + limit < scored.length, revision: document.revision };
  }

  function list(settings = {}) {
    let rows;
    if (settings.view === 'recent') {
      const records = new Map(document.entries.map(row => [row.id, row]));
      rows = recentIds.map(id => records.get(id)).filter(Boolean);
    } else rows = shelfRows();
    rows = rows.filter(row => (settings.includeAdult !== false || !row.nsfw) && (!settings.seriesId || row.seriesId === settings.seriesId) && (!Object.prototype.hasOwnProperty.call(settings, 'sectionId') || row.sectionId === settings.sectionId));
    const offset = Math.max(0, Math.floor(Number(settings.offset) || 0));
    const limit = pageLimit(settings.limit);
    return { items: clone(rows.slice(offset, offset + limit)), total: rows.length, offset, limit, hasMore: offset + limit < rows.length };
  }

  function setSelected(id, selected) {
    const next = clone(selectedRows);
    const index = next.findIndex(row => row.entryId === id);
    if (!selected) {
      if (index >= 0) next.splice(index, 1);
    } else if (index < 0) {
      const entry = document.entries.find(row => row.id === id);
      if (!entry) return errorResult('ENTRY_NOT_FOUND', '收藏不存在');
      next.push({ entryId: entry.id, kind: entry.kind, title: entry.title, rawText: entry.rawText, nsfw: entry.nsfw, sourceUpdatedAt: entry.updatedAt });
    }
    if (!setStored(SELECTION_KEY, next)) return errorResult('STORAGE_WRITE_FAILED', writeError?.message || '收藏选择保存失败');
    selectedRows = next;
    return result(selectedRows);
  }

  function markCopied(idsValue) {
    let next = clone(recentIds);
    const live = new Set(document.entries.map(row => row.id));
    for (const id of unique(idsValue).filter(id => live.has(id)).reverse()) next = [id, ...next.filter(value => value !== id)];
    next = next.filter(id => live.has(id)).slice(0, 20);
    if (!setStored(RECENT_KEY, next)) return false;
    recentIds = next;
    return clone(recentIds);
  }

  function prepareImport(value, settings = {}) {
    if (loadError) return errorResult('LOAD_ERROR', '收藏数据加载失败，已阻止覆盖');
    const checked = validateFavoriteBundle(value);
    if (!checked.ok) return checked;
    const mode = settings.mode || 'append';
    if (!['append', 'replace'].includes(mode)) return errorResult('INVALID_MODE', '导入模式无效');
    const incoming = checked.data;
    const conflicts = { series: 0, sections: 0, entries: 0 };
    if (mode === 'replace') return { ok: true, candidate: incoming, data: { mode, incoming: { series: incoming.series.length, sections: incoming.sections.length, entries: incoming.entries.length }, replaced: { series: document.series.length, sections: document.sections.length, entries: document.entries.length }, conflicts } };
    const candidate = clone(document), reserved = allIds(candidate);
    const assignIds = (rows, prefix, key) => new Map(rows.map(row => {
      let id = row.id;
      if (reserved.has(id)) { conflicts[key] += 1; id = makeId(prefix, { series: [...candidate.series, ...incoming.series], sections: [...candidate.sections, ...incoming.sections], entries: [...candidate.entries, ...incoming.entries] }); while (reserved.has(id)) id = makeId(prefix, candidate); }
      reserved.add(id); return [row.id, id];
    }));
    const seriesMap = assignIds(incoming.series, 'series', 'series');
    const sectionMap = assignIds(incoming.sections, 'section', 'sections');
    const entryMap = assignIds(incoming.entries, 'entry', 'entries');
    const seriesOffset = Math.max(-1, ...candidate.series.map(row => row.order)) + 1;
    candidate.series.push(...incoming.series.map(row => ({ ...clone(row), id: seriesMap.get(row.id), order: seriesOffset + row.order })));
    candidate.sections.push(...incoming.sections.map(row => ({ ...clone(row), id: sectionMap.get(row.id), seriesId: seriesMap.get(row.seriesId) })));
    candidate.entries.push(...incoming.entries.map(row => ({ ...clone(row), id: entryMap.get(row.id), seriesId: seriesMap.get(row.seriesId), sectionId: row.sectionId ? sectionMap.get(row.sectionId) : null })));
    const validated = validateFavoriteBundle(candidate);
    if (!validated.ok) return validated;
    return { ok: true, candidate: validated.data, data: { mode, incoming: { series: incoming.series.length, sections: incoming.sections.length, entries: incoming.entries.length }, replaced: { series: 0, sections: 0, entries: 0 }, conflicts, idMap: { series: Object.fromEntries(seriesMap), sections: Object.fromEntries(sectionMap), entries: Object.fromEntries(entryMap) } } };
  }

  function previewImport(value, settings) {
    const prepared = prepareImport(value, settings);
    return prepared.ok ? result(prepared.data) : prepared;
  }

  function importBundle(value, settings) {
    const prepared = prepareImport(value, settings);
    if (!prepared.ok) return prepared;
    return commit(prepared.candidate, prepared.data);
  }

  function previewPaste(value, settings = {}) {
    if (loadError) return errorResult('LOAD_ERROR', '收藏数据加载失败，已阻止覆盖');
    const parsed = parseFavoritePaste(value, settings);
    if (!parsed.ok) return parsed;
    const seriesId = text(settings.seriesId);
    const sectionId = sectionIdOf(settings.sectionId);
    if (!document.series.some(row => row.id === seriesId)) return errorResult('SERIES_NOT_FOUND', '系列不存在');
    if (sectionId && !document.sections.some(row => row.id === sectionId && row.seriesId === seriesId)) return errorResult('SECTION_NOT_FOUND', '子分类不存在或不属于目标系列');
    return result(parsed.data);
  }

  function importPaste(value, settings = {}) {
    const preview = previewPaste(value, settings);
    if (!preview.ok) return preview;
    const candidate = clone(document), ids = [], now = Date.now();
    const seriesId = text(settings.seriesId), sectionId = sectionIdOf(settings.sectionId);
    let order = Math.max(-1, ...candidate.entries.filter(row => row.seriesId === seriesId && row.sectionId === sectionId).map(row => row.order));
    for (const draft of preview.data.entries) {
      const id = makeId('entry', candidate);
      candidate.entries.push({ id, kind: draft.kind, seriesId, sectionId, title: '', rawText: draft.rawText, zh: draft.zh, aliases: [], note: '', globalSearchable: true, pinned: false, nsfw: false, order: ++order, sourceTagId: null, createdAt: now, updatedAt: now });
      ids.push(id);
    }
    return commit(candidate, { ids });
  }

  load();
  const api = {
    snapshot: () => ({ document: clone(document), revision: document.revision, loadError: clone(loadError), migrationReport: clone(migrationReport) }),
    series: () => orderedSeries(),
    sections: seriesId => orderedSections(seriesId),
    getEntry: id => clone(document.entries.find(row => row.id === id) || null),
    list, saveSeries, saveSection, saveEntry, applyBatch, duplicateEntries, deleteEntries, deleteSection, deleteSeries, reorder, setSeriesColors, search,
    copyText: ids => joinFavoriteBlocks((Array.isArray(ids) ? ids : []).map(id => document.entries.find(row => row.id === id)?.rawText).filter(value => typeof value === 'string' && value.length)),
    markCopied, setSelected,
    selected: settings => clone(selectedRows.filter(row => settings?.includeAdult !== false || !row.nsfw)),
    clearSelected() { if (!setStored(SELECTION_KEY, [])) return errorResult('STORAGE_WRITE_FAILED', writeError?.message || '收藏选择保存失败'); selectedRows = []; return result([]); },
    undo() { if (!undoStack.length) return errorResult('NOTHING_TO_UNDO', '没有可撤销的操作'); const operation = undoStack.at(-1); const value = applyHistory(operation, 'before'); if (value.ok) { undoStack.pop(); redoStack.push(operation); } return value; },
    redo() { if (!redoStack.length) return errorResult('NOTHING_TO_REDO', '没有可重做的操作'); const operation = redoStack.at(-1); const value = applyHistory(operation, 'after'); if (value.ok) { redoStack.pop(); undoStack.push(operation); } return value; },
    historyState: () => ({ canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 }),
    subscribe(callback) { if (typeof callback === 'function') listeners.add(callback); return () => listeners.delete(callback); },
    async flush() { try { const flushed = typeof storage?.flush === 'function' ? await storage.flush() !== false : true; return flushed && !writeError; } catch { return false; } },
    exportBundle: () => clone(document), previewImport, importBundle, previewPaste, importPaste,
    parseFavoritePaste, validateFavoriteBundle, favoriteMemberCount
  };
  return Object.freeze(api);
}

module.exports = { createFavorites, favoriteMemberCount, PALETTE };
