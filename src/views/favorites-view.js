'use strict';

(function installFavoritesView(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.AppViews = root.AppViews || {};
  root.AppViews.favorites = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function createFactory() {
  const SEARCH_DELAY = 100;
  const SAVE_DELAY = 300;
  const PAGE_SIZE = 80;
  const COLUMN_BATCH = 120;
  const INITIAL_COLUMN_BATCH = 60;
  const INITIAL_COLUMNS = 4;
  const DEFAULT_VIEW = Object.freeze({ zoom: 100, columnWidth: 280, primary: 'raw', showSecondary: true, compact: false, collapsedSections: [] });

  const string = (value, fallback = '') => value == null || value === '' ? fallback : String(value);
  const number = (value, fallback, min, max) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
  };
  const unique = values => [...new Set((values || []).filter(Boolean))];

  function createFavoritesView(options = {}) {
    const doc = options.document || (typeof globalThis !== 'undefined' ? globalThis.document : null);
    const win = doc?.defaultView || (typeof window !== 'undefined' ? window : null);
    const favorites = options.favorites;
    const preferences = options.preferences;
    const copy = typeof options.copy === 'function' ? options.copy : async () => false;
    const notify = typeof options.notify === 'function' ? options.notify : () => {};
    const localize = typeof options.localize === 'function' ? options.localize : (_key, fallback) => fallback;
    const onSelectionChange = typeof options.onSelectionChange === 'function' ? options.onSelectionChange : () => {};
    const getIncludeAdult = typeof options.getIncludeAdult === 'function' ? options.getIncludeAdult : () => true;
    const parsePaste = options.parsePaste || favorites?.parseFavoritePaste;
    const host = doc?.querySelector?.('#favoritesView');
    const state = {
      bound: false, active: false, destroyed: false, composing: false,
      query: '', scope: 'internal', kind: 'all', seriesId: '', sectionId: '', anchorQuery: '', searchOffset: PAGE_SIZE,
      searchHits: [], searchTotal: 0, searchHasMore: false, searchContext: null,
      recent: false, expanded: new Set(), bulk: new Set(), bulkSeries: new Set(), columnLimits: new Map(), loadedColumns: new Set(),
      prefs: readPreferences(), editor: null, saveTimer: null, searchTimer: null, transferOpen: false,
      unsubscribe: null, renderToken: 0, draggedId: '', returnFocus: null, dialog: null, editorSession: 0, shelfContext: null, lastShelfFocus: '', pendingRender: false, columnObserver: null, scrollFrame: null
    };

    function label(key, fallback) { return string(localize(key, fallback), fallback); }
    function readPreferences() {
      let saved = {};
      try { saved = preferences?.get?.('favorites.view', {}) || {}; } catch { saved = {}; }
      return {
        zoom: number(saved.zoom, DEFAULT_VIEW.zoom, 75, 150),
        columnWidth: number(saved.columnWidth, DEFAULT_VIEW.columnWidth, 220, 420),
        primary: ['raw', 'zh', 'title'].includes(saved.primary) ? saved.primary : DEFAULT_VIEW.primary,
        showSecondary: saved.showSecondary !== false,
        compact: saved.compact === true,
        collapsedSections: Array.isArray(saved.collapsedSections) ? unique(saved.collapsedSections.map(String)) : []
      };
    }
    function savePreferences(patch) {
      state.prefs = { ...state.prefs, ...patch };
      try { preferences?.set?.('favorites.view', { ...state.prefs }); } catch { /* preferences are optional */ }
      applyPreferences();
      return state.prefs;
    }
    function applyPreferences() {
      if (!host) return;
      host.style.setProperty('--favorite-zoom', String(state.prefs.zoom / 100));
      host.style.setProperty('--favorite-column-width', `${state.prefs.columnWidth}px`);
      host.classList.toggle('is-compact', state.prefs.compact);
      const zoom = host.querySelector('[data-favorite-zoom]');
      const width = host.querySelector('[data-favorite-column-width]');
      const primary = host.querySelector('[data-favorite-primary]');
      const secondary = host.querySelector('[data-favorite-secondary]');
      const compact = host.querySelector('[data-favorite-compact]');
      if (zoom) zoom.value = String(state.prefs.zoom);
      if (width) width.value = String(state.prefs.columnWidth);
      if (primary) primary.value = state.prefs.primary;
      if (secondary) secondary.checked = state.prefs.showSecondary;
      if (compact) compact.checked = state.prefs.compact;
    }

    function el(tag, className, value) {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (value != null) node.textContent = string(value);
      return node;
    }
    function button(iconId, title, action, className = 'favorite-icon-button') {
      const node = el('button', className);
      node.type = 'button';
      node.title = title;
      node.setAttribute('aria-label', title);
      if (action) node.dataset.favoriteAction = action;
      if (iconId) {
        const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('aria-hidden', 'true');
        svg.classList.add('favorite-icon');
        const use = doc.createElementNS('http://www.w3.org/2000/svg', 'use');
        use.setAttribute('href', `../assets/icons/favorites.svg#${iconId}`);
        svg.append(use); node.append(svg);
      }
      return node;
    }
    function control(tag, name, textValue) {
      const node = el(tag, '', textValue);
      if (name) node.dataset[name] = '';
      return node;
    }
    function optionNode(value, textValue) {
      const node = el('option', '', textValue); node.value = value; return node;
    }

    function ensureShell() {
      if (!host || host.dataset.favoritesReady === 'true') return;
      host.dataset.favoritesReady = 'true';
      host.classList.add('favorites-view');
      host.setAttribute('aria-label', label('favorites.title', '快捷收藏'));

      const toolbar = el('div', 'favorites-toolbar');
      const searchWrap = el('div', 'favorites-search-box');
      const search = el('input', 'favorites-search-input');
      search.type = 'search'; search.placeholder = label('favorites.searchPlaceholder', '仅搜索收藏内容'); search.dataset.favoriteSearch = '';
      search.setAttribute('aria-label', label('favorites.search', '搜索收藏'));
      const clear = button('x', label('favorites.clearSearch', '清除搜索'), 'clear-search'); clear.classList.add('favorites-search-clear');
      searchWrap.append(button('search', label('favorites.search', '搜索收藏'), '', 'favorite-static-icon'), search, clear);
      toolbar.append(searchWrap);

      const scope = control('select', 'favoriteScope'); scope.setAttribute('aria-label', label('favorites.searchScope', '搜索范围'));
      scope.append(optionNode('internal', label('favorites.scopeAll', '全部收藏')), optionNode('global', label('favorites.scopeGlobal', '可全局查询')));
      const kind = control('select', 'favoriteKind'); kind.setAttribute('aria-label', label('favorites.kind', '收藏类型'));
      kind.append(optionNode('all', label('favorites.kindAll', '全部类型')), optionNode('tag', label('favorites.kindTag', '单标签')), optionNode('bundle', label('favorites.kindBundle', '标签组')));
      const seriesFilter = control('select', 'favoriteSeriesFilter'); seriesFilter.setAttribute('aria-label', label('favorites.seriesFilter', '筛选系列'));
      const sectionFilter = control('select', 'favoriteSectionFilter'); sectionFilter.setAttribute('aria-label', label('favorites.sectionFilter', '筛选子分类'));
      toolbar.append(scope, kind, seriesFilter, sectionFilter);

      const create = el('div', 'favorites-toolbar-group');
      const newTag = button('plus', label('favorites.newTag', '新增单标签'), 'new-tag'); newTag.classList.add('has-label'); newTag.append(doc.createTextNode(label('favorites.newTagShort', '标签')));
      const newBundle = button('layers', label('favorites.newBundle', '新增标签组'), 'new-bundle'); newBundle.classList.add('has-label'); newBundle.append(doc.createTextNode(label('favorites.newBundleShort', '组合')));
      create.append(newTag, newBundle, button('folder-plus', label('favorites.newSeries', '新增系列'), 'new-series'));
      toolbar.append(create);

      const history = el('div', 'favorites-toolbar-group');
      history.append(button('undo-2', label('favorites.undo', '撤销'), 'undo'), button('redo-2', label('favorites.redo', '重做'), 'redo'));
      const recent = button('pin', label('favorites.recent', '最近复制'), 'recent'); recent.dataset.favoriteRecent = '';
      const bulk = button('check', label('favorites.bulk', '批量管理'), 'bulk'); bulk.dataset.favoriteBulkToggle = '';
      history.append(recent, bulk);
      toolbar.append(history);

      const display = el('div', 'favorites-display-controls');
      const primary = control('select', 'favoritePrimary'); primary.title = label('favorites.primaryText', '主显示文本');
      primary.append(optionNode('raw', label('favorites.rawFirst', '原文优先')), optionNode('zh', label('favorites.zhFirst', '中文优先')), optionNode('title', label('favorites.titleFirst', '名称优先')));
      const secondaryLabel = el('label', 'favorite-check-control');
      const secondary = control('input', 'favoriteSecondary'); secondary.type = 'checkbox'; secondaryLabel.append(secondary, doc.createTextNode(label('favorites.secondary', '次信息')));
      const compactLabel = el('label', 'favorite-check-control');
      const compact = control('input', 'favoriteCompact'); compact.type = 'checkbox'; compactLabel.append(compact, doc.createTextNode(label('favorites.compact', '紧凑')));
      const width = control('input', 'favoriteColumnWidth'); width.type = 'number'; width.min = '220'; width.max = '420'; width.step = '20'; width.title = label('favorites.columnWidth', '列宽'); width.setAttribute('aria-label', width.title);
      const zoomGroup = el('div', 'favorite-zoom-control');
      const zoom = control('input', 'favoriteZoom'); zoom.type = 'number'; zoom.min = '75'; zoom.max = '150'; zoom.step = '10'; zoom.setAttribute('aria-label', label('favorites.zoom', '缩放百分比'));
      zoomGroup.append(button('minus', label('favorites.zoomOut', '缩小'), 'zoom-out'), zoom, el('span', '', '%'), button('plus', label('favorites.zoomIn', '放大'), 'zoom-in'), button('locate-fixed', label('favorites.zoomReset', '重置缩放'), 'zoom-reset'));
      display.append(primary, secondaryLabel, compactLabel, width, zoomGroup);
      toolbar.append(display);

      const transfer = el('div', 'favorites-toolbar-group');
      transfer.append(button('upload', label('favorites.import', '导入收藏'), 'open-import'), button('download', label('favorites.export', '导出收藏'), 'export'));
      toolbar.append(transfer);

      const anchors = el('nav', 'favorites-anchors'); anchors.dataset.favoriteAnchors = ''; anchors.setAttribute('aria-label', label('favorites.anchors', '系列快捷定位'));
      const subanchors = el('nav', 'favorites-subanchors'); subanchors.dataset.favoriteSubanchors = ''; subanchors.hidden = true;

      const bulkbar = el('div', 'favorites-bulkbar'); bulkbar.dataset.favoriteBulkbar = ''; bulkbar.hidden = true;
      const count = el('strong', 'favorites-bulk-count', '0'); count.dataset.favoriteBulkCount = '';
      const move = control('select', 'favoriteBulkMove'); move.setAttribute('aria-label', label('favorites.moveTo', '移动到系列'));
      bulkbar.append(el('span', '', label('favorites.selected', '已选')), count,
        actionTextButton('visible', label('favorites.selectVisible', '选择当前显示')),
        actionTextButton('all-results', label('favorites.selectAllResults', '选择全部搜索结果')),
        actionTextButton('pin-selected', label('favorites.pin', '置顶')),
        actionTextButton('unpin-selected', label('favorites.unpin', '取消置顶')),
        actionTextButton('searchable-on', label('favorites.searchableOn', '允许全局查询')),
        actionTextButton('searchable-off', label('favorites.searchableOff', '关闭全局查询')),
        actionTextButton('copy-selected', label('favorites.copySelected', '复制原文')),
        move,
        actionTextButton('duplicate-selected', label('favorites.duplicate', '复制到目标')),
        actionTextButton('delete-selected', label('favorites.delete', '删除'), 'danger'),
        actionTextButton('clear-bulk', label('favorites.clearSelection', '清除勾选')));

      const health = el('div', 'favorites-health'); health.dataset.favoriteHealth = ''; health.hidden = true;
      const body = el('div', 'favorites-body');
      const scroll = el('div', 'favorites-scroll'); scroll.dataset.favoriteScroll = '';
      const shelf = el('div', 'favorites-shelf'); shelf.dataset.favoriteShelf = '';
      const results = el('div', 'favorites-search-results'); results.dataset.favoriteSearchResults = ''; results.hidden = true;
      scroll.append(shelf, results); body.append(scroll, createEditor(), createTransferPanel());
      host.append(toolbar, anchors, subanchors, bulkbar, health, body, createDialog());
      applyPreferences();
    }

    function actionTextButton(action, textValue, extra = '') {
      const node = el('button', `favorite-action-button ${extra}`.trim(), textValue); node.type = 'button'; node.dataset.favoriteAction = action; return node;
    }
    function createDialog() {
      const dialog = el('div', 'favorite-dialog'); dialog.dataset.favoriteDialog = ''; dialog.hidden = true;
      dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
      const panel = el('form', 'favorite-dialog-panel'); panel.dataset.favoriteDialogForm = '';
      panel.append(el('h3', '', label('favorites.namePrompt', '输入名称')));
      const input = el('input'); input.type = 'text'; input.dataset.favoriteDialogInput = ''; input.autocomplete = 'off';
      const status = el('p', 'favorite-dialog-status'); status.dataset.favoriteDialogStatus = '';
      const actions = el('div', 'favorite-editor-actions');
      const cancel = actionTextButton('dialog-cancel', label('favorites.cancel', '取消')); const confirm = actionTextButton('dialog-confirm', label('favorites.confirm', '确定'), 'primary');
      actions.append(cancel, confirm); panel.append(input, status, actions); dialog.append(panel); return dialog;
    }
    function openNameDialog(title, initial, onSave, returnFocus) {
      const dialog = host.querySelector('[data-favorite-dialog]'); const input = host.querySelector('[data-favorite-dialog-input]');
      if (!dialog || !input) return false;
      const titleText = typeof title === 'function' ? title() : title;
      state.dialog = { returnFocus: returnFocus || doc.activeElement, onSave, title, titleText };
      dialog.querySelector('h3').textContent = titleText; host.querySelector('[data-favorite-dialog-status]').textContent = '';
      input.value = string(initial); dialog.hidden = false; input.focus(); input.select(); return true;
    }
    function closeNameDialog() {
      if (!state.dialog) return;
      const dialogState = state.dialog; state.dialog = null; const dialog = host.querySelector('[data-favorite-dialog]'); if (dialog) dialog.hidden = true;
      restoreDialogFocus(dialogState);
    }
    function restoreDialogFocus(dialogState) {
      const focus = dialogState?.returnFocus;
      if (focus?.isConnected) { focus.focus(); return; }
      const action = focus?.dataset?.favoriteAction; if (!action) return;
      let selector = `[data-favorite-action="${cssEscape(action)}"]`;
      if (focus.dataset.seriesId) selector += `[data-series-id="${cssEscape(focus.dataset.seriesId)}"]`;
      if (focus.dataset.sectionId) selector += `[data-section-id="${cssEscape(focus.dataset.sectionId)}"]`;
      host.querySelector(selector)?.focus();
    }
    function submitNameDialog() {
      if (!state.dialog) return false;
      const input = host.querySelector('[data-favorite-dialog-input]'); const status = host.querySelector('[data-favorite-dialog-status]'); const name = string(input?.value).trim();
      if (!name) { if (status) status.textContent = label('favorites.nameRequired', '名称不能为空'); input?.focus(); return false; }
      const result = state.dialog.onSave(name);
      if (result?.ok === false) { if (status) status.textContent = result.error?.message || label('favorites.operationFailed', '操作失败'); return false; }
      const dialogState = state.dialog; state.dialog = null; const dialog = host.querySelector('[data-favorite-dialog]'); if (dialog) dialog.hidden = true;
      render(); restoreDialogFocus(dialogState); return true;
    }

    function createEditor() {
      const aside = el('aside', 'favorite-editor'); aside.dataset.favoriteEditor = ''; aside.hidden = true;
      aside.setAttribute('aria-label', label('favorites.editor', '收藏编辑器'));
      const header = el('div', 'favorite-editor-head');
      const title = el('h3', '', label('favorites.editor', '编辑收藏')); title.dataset.favoriteEditorTitle = '';
      const previous = button('chevrons-left', label('favorites.previous', '上一条'), 'editor-prev'); previous.dataset.favoriteEditorPrev = '';
      const next = button('chevrons-right', label('favorites.next', '下一条'), 'editor-next'); next.dataset.favoriteEditorNext = '';
      header.append(title, previous, next, button('x', label('favorites.closeEditor', '关闭编辑器'), 'editor-close'));
      const location = el('div', 'favorite-editor-location'); location.dataset.favoriteEditorLocation = '';
      const form = el('form', 'favorite-editor-form'); form.dataset.favoriteEditorForm = '';
      form.append(
        editorSelect('kind', label('favorites.kind', '类型'), [['tag', label('favorites.kindTag', '单标签')], ['bundle', label('favorites.kindBundle', '标签组')]]),
        editorSelect('seriesId', label('favorites.series', '系列'), []),
        editorSelect('sectionId', label('favorites.section', '子分类'), []),
        editorInput('title', label('favorites.entryTitle', '名称')),
        editorTextarea('rawText', label('favorites.rawText', '原文'), true),
        editorInput('zh', label('favorites.zh', '中文说明')),
        editorInput('aliases', label('favorites.aliases', '别名（逗号分隔）')),
        editorTextarea('note', label('favorites.note', '备注')),
        editorCheck('globalSearchable', label('favorites.globalSearchable', '允许参与全局查询')),
        editorCheck('nsfw', label('favorites.adult', '成人内容'))
      );
      const status = el('div', 'favorite-save-status'); status.dataset.favoriteSaveStatus = ''; status.setAttribute('aria-live', 'polite');
      const actions = el('div', 'favorite-editor-actions');
      actions.append(actionTextButton('editor-discard', label('favorites.discard', '放弃修改')), actionTextButton('editor-copy', label('favorites.copyDraft', '保存并复制')), actionTextButton('editor-save', label('favorites.save', '保存'), 'primary'));
      aside.append(header, location, form, status, actions); return aside;
    }
    function editorFieldShell(name, field) {
      const wrapper = el('label', 'favorite-field'); wrapper.append(el('span', '', name), field); return wrapper;
    }
    function editorInput(name, title) {
      const field = el('input'); field.type = 'text'; field.dataset.favoriteField = name; return editorFieldShell(title, field);
    }
    function editorTextarea(name, title, required = false) {
      const field = el('textarea'); field.dataset.favoriteField = name; field.required = required; return editorFieldShell(title, field);
    }
    function editorSelect(name, title, values) {
      const field = el('select'); field.dataset.favoriteField = name; values.forEach(([value, textValue]) => field.append(optionNode(value, textValue))); return editorFieldShell(title, field);
    }
    function editorCheck(name, title) {
      const wrapper = el('label', 'favorite-check-control favorite-editor-check'); const field = el('input'); field.type = 'checkbox'; field.dataset.favoriteField = name; wrapper.append(field, doc.createTextNode(title)); return wrapper;
    }
    function createTransferPanel() {
      const panel = el('aside', 'favorite-transfer'); panel.dataset.favoriteTransfer = ''; panel.hidden = true;
      const head = el('div', 'favorite-editor-head'); head.append(el('h3', '', label('favorites.importExport', '导入收藏')), button('x', label('favorites.close', '关闭'), 'close-import'));
      const controls = el('div', 'favorite-transfer-controls');
      const format = control('select', 'favoriteImportFormat'); format.append(optionNode('lines', label('favorites.lines', '一行一条')), optionNode('tsv', 'TSV'), optionNode('json', 'JSON'));
      const mode = control('select', 'favoriteImportMode'); mode.append(optionNode('append', label('favorites.append', '追加')), optionNode('replace', label('favorites.replace', '替换')));
      const kind = control('select', 'favoriteImportKind'); kind.append(optionNode('tag', label('favorites.kindTag', '单标签')), optionNode('bundle', label('favorites.kindBundle', '标签组')));
      const target = control('select', 'favoriteImportSeries');
      const section = control('select', 'favoriteImportSection');
      controls.append(format, kind, mode, target, section);
      const textarea = el('textarea', 'favorite-transfer-text'); textarea.dataset.favoriteImportText = ''; textarea.placeholder = label('favorites.pasteHere', '粘贴内容');
      const file = el('input'); file.type = 'file'; file.accept = '.json,application/json'; file.hidden = true; file.dataset.favoriteImportFile = '';
      const preview = el('div', 'favorite-transfer-preview'); preview.dataset.favoriteImportPreview = '';
      const actions = el('div', 'favorite-editor-actions'); actions.append(actionTextButton('choose-json-file', label('favorites.chooseJsonFile', '选择 JSON 文件')), actionTextButton('preview-import', label('favorites.preview', '预览')), actionTextButton('confirm-import', label('favorites.confirmImport', '确认导入'), 'primary'));
      panel.append(head, controls, textarea, file, preview, actions); return panel;
    }

    function safeCall(method, ...args) {
      try { return favorites?.[method]?.(...args); } catch (error) { notify(error.message || String(error)); return { ok: false, error: { message: error.message || String(error) } }; }
    }
    function seriesRows() { const rows = safeCall('series'); return Array.isArray(rows) ? rows : []; }
    function sectionRows(seriesId) { const rows = safeCall('sections', seriesId); return Array.isArray(rows) ? rows : []; }
    function includeAdult() { try { return getIncludeAdult() !== false; } catch { return true; } }
    function allSelectedIds() {
      try { return new Set((favorites?.selected?.({ includeAdult: true }) || []).map(row => row.entryId || row.id)); } catch { return new Set(); }
    }

    function render() {
      if (!host || state.destroyed) return;
      ensureShell();
      state.renderToken += 1;
      renderFilters(); renderAnchors(); renderHealth(); renderShelf();
      if (state.query) renderSearch(false);
      updateBulkbar(); updateHistory(); applyPreferences();
    }
    function renderFilters() {
      const rows = seriesRows();
      const controls = [host.querySelector('[data-favorite-series-filter]'), host.querySelector('[data-favorite-bulk-move]'), host.querySelector('[data-favorite-import-series]')];
      controls.forEach((select, index) => {
        if (!select) return;
        const previous = select.value;
        select.replaceChildren();
        if (index === 0) select.append(optionNode('', label('favorites.allSeries', '全部系列')));
        else if (index === 1) select.append(optionNode('', label('favorites.chooseTarget', '目标系列')));
        rows.forEach(row => select.append(optionNode(row.id, string(row.name, row.id))));
        if ([...select.options].some(item => item.value === previous)) select.value = previous;
      });
      const filter = host.querySelector('[data-favorite-series-filter]'); if (filter) filter.value = state.seriesId;
      const section = host.querySelector('[data-favorite-section-filter]');
      if (section) {
        section.replaceChildren(optionNode('', label('favorites.allSections', '全部子分类')));
        rows.filter(row => !state.seriesId || row.id === state.seriesId).forEach(row => {
          sectionRows(row.id).forEach(child => section.append(optionNode(child.id, state.seriesId ? string(child.name, child.id) : `${string(row.name, row.id)} / ${string(child.name, child.id)}`)));
        });
        if ([...section.options].some(item => item.value === state.sectionId)) section.value = state.sectionId;
        else state.sectionId = '';
      }
    }
    function renderAnchors() {
      const anchors = host.querySelector('[data-favorite-anchors]'); if (!anchors) return;
      anchors.replaceChildren();
      const search = el('input', 'favorites-anchor-search'); search.type = 'search'; search.dataset.favoriteAnchorSearch = ''; search.value = state.anchorQuery;
      search.placeholder = label('favorites.findSeries', '查找系列'); search.setAttribute('aria-label', search.placeholder); anchors.append(search);
      const needle = state.anchorQuery.trim().toLocaleLowerCase();
      seriesRows().filter(row => !needle || string(row.name).toLocaleLowerCase().includes(needle)).forEach(row => {
        const item = actionTextButton('anchor-series', string(row.name, row.id)); item.dataset.seriesId = row.id; item.style.setProperty('--favorite-accent', string(row.color, 'var(--pri)')); anchors.append(item);
      });
      if (state.searchContext) anchors.append(actionTextButton('return-search', label('favorites.returnSearch', '返回搜索结果')));
    }
    function renderHealth() {
      const node = host.querySelector('[data-favorite-health]'); if (!node) return;
      const snapshot = safeCall('snapshot') || {}; const messages = [];
      if (snapshot.loadError) messages.push(`${label('favorites.loadError', '收藏数据加载失败，已阻止覆盖')}：${string(snapshot.loadError.message)}`);
      const report = snapshot.migrationReport;
      if (report) {
        const unresolved = Array.isArray(report.unresolved) ? report.unresolved.length : 0;
        const invalid = Array.isArray(report.invalid) ? report.invalid.length : 0;
        messages.push(`${label('favorites.migrationReport', '旧收藏迁移')}：${Number(report.migrated) || 0}；${label('favorites.unresolved', '未解析')} ${unresolved}；${label('favorites.invalid', '待修复')} ${invalid}`);
      }
      node.replaceChildren(...messages.map(message => el('p', '', message))); node.hidden = messages.length === 0;
      node.classList.toggle('has-error', Boolean(snapshot.loadError));
    }

    function renderShelf() {
      const shelf = host.querySelector('[data-favorite-shelf]'); if (!shelf) return;
      state.columnObserver?.disconnect?.(); state.columnObserver = null;
      const selected = allSelectedIds(); shelf.replaceChildren();
      if (state.recent) {
        const recent = safeCall('list', { includeAdult: includeAdult(), offset: 0, limit: 20, view: 'recent' });
        const column = el('section', 'favorite-series favorite-recent-series'); column.dataset.favoriteSeries = 'recent';
        const head = el('div', 'favorite-series-head'); head.append(el('h3', '', label('favorites.recent', '最近复制')), el('span', 'favorite-series-count', recent?.total || 0)); column.append(head);
        const list = el('div', 'favorite-entry-list');
        (recent?.items || []).forEach(entry => {
          const parent = seriesRows().find(row => row.id === entry.seriesId); const section = sectionRows(entry.seriesId).find(row => row.id === entry.sectionId);
          const wrapper = el('div', 'favorite-recent-item'); wrapper.append(el('div', 'favorite-search-path', [parent?.name, section?.name].filter(Boolean).join(' / ')), renderEntry(entry, selected.has(entry.id))); list.append(wrapper);
        });
        if (!recent?.items?.length) list.append(el('p', 'favorites-empty', label('favorites.noRecent', '还没有最近复制记录')));
        column.append(list); shelf.append(column); return;
      }
      const rows = seriesRows().filter(series => !state.seriesId || series.id === state.seriesId);
      if (!rows.length) { shelf.append(el('p', 'favorites-empty', label('favorites.empty', '还没有收藏系列'))); return; }
      rows.forEach((series, index) => shelf.append(renderSeries(series, selected, index >= INITIAL_COLUMNS && !state.loadedColumns.has(series.id))));
      setupColumnLoading();
    }
    function renderSeries(series, selected, lazy = false) {
      const column = el('section', 'favorite-series'); column.dataset.favoriteSeries = series.id; column.id = `favorite-series-${series.id}`;
      column.style.setProperty('--favorite-accent', string(series.color, '#5E6AD2'));
      const visible = lazy ? null : readSeriesEntries(series.id, state.columnLimits.get(series.id) || INITIAL_COLUMN_BATCH);
      const head = el('div', 'favorite-series-head');
      const title = el('h3', '', string(series.name, series.id)); title.title = string(series.name, series.id);
      const count = visible?.total ?? (safeCall('list', { seriesId: series.id, includeAdult: includeAdult(), offset: 0, limit: 1, view: 'shelf' })?.total || 0);
      const manage = el('input', 'favorite-series-manage'); manage.type = 'checkbox'; manage.checked = state.bulkSeries.has(series.id); manage.dataset.favoriteSeriesManage = series.id; manage.setAttribute('aria-label', label('favorites.selectSeries', '选择系列以批量改色'));
      head.append(manage, title, el('span', 'favorite-series-count', count));
      const menu = el('details', 'favorite-series-menu'); const summary = el('summary', '', '⋯'); summary.title = label('favorites.seriesActions', '系列操作'); summary.setAttribute('aria-label', summary.title);
      const menuBody = el('div', 'favorite-series-menu-body');
      const newSection = button('folder-plus', label('favorites.newSection', '新增子分类'), 'new-section'); newSection.dataset.seriesId = series.id;
      const rename = button('pencil', label('favorites.renameSeries', '重命名系列'), 'rename-series'); rename.dataset.seriesId = series.id;
      const color = el('input', 'favorite-color-input'); color.type = 'color'; color.value = /^#[0-9a-f]{6}$/i.test(series.color || '') ? series.color : '#5e6ad2'; color.dataset.favoriteSeriesColor = series.id; color.title = label('favorites.seriesColor', '系列颜色'); color.setAttribute('aria-label', color.title);
      const auto = button('palette', label('favorites.autoColor', '自动配色'), 'auto-color'); auto.dataset.seriesId = series.id;
      const seriesUp = button('arrow-up', label('favorites.moveSeriesUp', '系列左移'), 'move-series-up'); seriesUp.dataset.seriesId = series.id;
      const seriesDown = button('arrow-down', label('favorites.moveSeriesDown', '系列右移'), 'move-series-down'); seriesDown.dataset.seriesId = series.id;
      const remove = button('trash-2', label('favorites.deleteSeries', '删除系列'), 'delete-series'); remove.dataset.seriesId = series.id;
      const removeAll = button('x', label('favorites.deleteSeriesAll', '删除系列及内容'), 'delete-series-all'); removeAll.dataset.seriesId = series.id;
      menuBody.append(newSection, rename, color, auto, seriesUp, seriesDown, remove, removeAll); menu.append(summary, menuBody); head.append(menu); column.append(head);
      if (lazy) {
        column.dataset.favoriteLazySeries = series.id;
        const placeholder = actionTextButton('load-series', `${label('favorites.loadSeries', '加载系列内容')} · ${count}`); placeholder.dataset.seriesId = series.id; placeholder.classList.add('favorite-series-placeholder'); column.append(placeholder); return column;
      }

      const rootItems = visible.items.filter(entry => entry.sectionId == null);
      const rootTotal = visible.sectionTotals ? visible.sectionTotals.get('') || 0 : safeCall('list', { seriesId: series.id, sectionId: null, includeAdult: includeAdult(), offset: 0, limit: 1, view: 'shelf' })?.total || 0;
      const rootRows = { items: rootItems, total: rootTotal, hasMore: false };
      if (!state.sectionId && rootRows.items.length) column.append(renderSection(series, null, rootRows, selected));
      const sections = sectionRows(series.id).filter(section => !state.sectionId || section.id === state.sectionId);
      sections.forEach(section => {
        const items = visible.items.filter(entry => entry.sectionId === section.id);
        const total = visible.sectionTotals ? visible.sectionTotals.get(section.id) || 0 : safeCall('list', { seriesId: series.id, sectionId: section.id, includeAdult: includeAdult(), offset: 0, limit: 1, view: 'shelf' })?.total || 0;
        const rows = { items, total, hasMore: false };
        column.append(renderSection(series, section, rows, selected));
      });
      if ((!rootRows.items.length || state.sectionId) && !sections.some(section => visible.items.some(entry => entry.sectionId === section.id))) column.append(el('p', 'favorites-empty favorites-empty-column', label('favorites.emptySeries', '此系列暂无收藏')));
      if (!includeAdult()) {
        const allTotal = safeCall('list', { seriesId: series.id, includeAdult: true, offset: 0, limit: 1, view: 'shelf' })?.total || 0;
        const visibleTotal = safeCall('list', { seriesId: series.id, includeAdult: false, offset: 0, limit: 1, view: 'shelf' })?.total || 0;
        if (allTotal > visibleTotal) column.append(el('p', 'favorite-adult-hidden', `${label('favorites.adultHidden', '已隐藏成人内容')}：${allTotal - visibleTotal}`));
      }
      if (visible.hasMore) { const more = actionTextButton('load-column', label('favorites.loadMore', '加载更多')); more.dataset.seriesId = series.id; column.append(more); }
      return column;
    }
    function setupColumnLoading() {
      state.columnObserver?.disconnect?.(); state.columnObserver = null;
      const lazy = [...host.querySelectorAll('[data-favorite-lazy-series]')]; if (!lazy.length || !state.active) return;
      if (typeof win?.IntersectionObserver === 'function') {
        const scroll = host.querySelector('[data-favorite-scroll]');
        state.columnObserver = new win.IntersectionObserver(entries => entries.forEach(entry => { if (entry.isIntersecting) hydrateSeries(entry.target.dataset.favoriteLazySeries); }), { root: scroll, rootMargin: '0px 560px' });
        lazy.forEach(node => state.columnObserver.observe(node));
      }
    }
    function hydrateSeries(seriesId) {
      if (!seriesId) return false;
      const node = host.querySelector(`[data-favorite-lazy-series="${cssEscape(seriesId)}"]`); if (!node) return false;
      const series = seriesRows().find(row => row.id === seriesId); if (!series) return false;
      state.loadedColumns.add(seriesId); state.columnObserver?.unobserve?.(node); node.replaceWith(renderSeries(series, allSelectedIds(), false)); return true;
    }
    function handleShelfScroll() {
      if (state.scrollFrame != null) return;
      const request = win?.requestAnimationFrame || (callback => win.setTimeout(callback, 16));
      state.scrollFrame = request(() => {
        state.scrollFrame = null; const scroll = host.querySelector('[data-favorite-scroll]'); if (!scroll) return;
        const viewport = scroll.getBoundingClientRect();
        [...host.querySelectorAll('[data-favorite-lazy-series]')].forEach(node => { const rect = node.getBoundingClientRect(); if (rect.left < viewport.right + 560 && rect.right > viewport.left - 560) hydrateSeries(node.dataset.favoriteLazySeries); });
      });
    }
    function readSeriesEntries(seriesId, limit) {
      const filtered = state.kind !== 'all' || state.scope === 'global' || Boolean(state.sectionId);
      if (filtered) {
        const items = []; const sectionTotals = new Map(); let offset = 0, total = 0, hasMore = true;
        while (hasMore) {
          const result = safeCall('list', { seriesId, includeAdult: includeAdult(), offset, limit: 500, view: 'shelf' });
          if (!result || !Array.isArray(result.items)) break;
          result.items.forEach(entry => {
            if ((state.kind !== 'all' && entry.kind !== state.kind) || (state.scope === 'global' && !entry.globalSearchable) || (state.sectionId && entry.sectionId !== state.sectionId)) return;
            total += 1;
            const sectionKey = entry.sectionId || '';
            sectionTotals.set(sectionKey, (sectionTotals.get(sectionKey) || 0) + 1);
            if (items.length < limit) items.push(entry);
          });
          offset += result.items.length; hasMore = Boolean(result.hasMore) && result.items.length > 0;
        }
        return { items, total, hasMore: items.length < total, sectionTotals };
      }
      const items = []; let offset = 0, total = 0, hasMore = true;
      while (items.length < limit && hasMore) {
        const result = safeCall('list', { seriesId, includeAdult: includeAdult(), offset, limit: Math.min(500, limit - items.length), view: 'shelf' });
        if (!result || !Array.isArray(result.items)) break;
        items.push(...result.items); total = Number(result.total) || items.length; hasMore = Boolean(result.hasMore) && result.items.length > 0; offset += result.items.length;
      }
      return { items, total, hasMore: items.length < total };
    }
    function readEntries(seriesId, sectionId, limit, forceAdult = false) {
      const items = []; let offset = 0, total = 0, hasMore = true;
      while (items.length < limit && hasMore) {
        const result = safeCall('list', { seriesId, sectionId, includeAdult: forceAdult ? true : includeAdult(), offset, limit: Math.min(500, limit - items.length), view: 'shelf' });
        if (!result || !Array.isArray(result.items)) break;
        items.push(...result.items); total = Number(result.total) || items.length; hasMore = Boolean(result.hasMore) && result.items.length > 0; offset += result.items.length;
      }
      return { items, total, hasMore: items.length < total };
    }
    function renderSection(series, section, rows, selected) {
      const group = el('section', 'favorite-section'); group.dataset.favoriteSection = section?.id || 'root'; group.dataset.seriesId = series.id;
      const collapsed = Boolean(section && state.prefs.collapsedSections.includes(section.id));
      if (section) {
        const head = el('div', 'favorite-section-head'); const title = el('h4', '', string(section.name, section.id)); title.tabIndex = -1;
        const toggle = button(collapsed ? 'chevron-right' : 'chevron-down', collapsed ? label('favorites.expandSection', '展开子分类') : label('favorites.collapseSection', '折叠子分类'), 'toggle-section'); toggle.dataset.sectionId = section.id;
        const rename = button('pencil', label('favorites.renameSection', '重命名子分类'), 'rename-section'); rename.dataset.sectionId = section.id; rename.dataset.seriesId = series.id;
        const remove = button('trash-2', label('favorites.deleteSection', '删除子分类'), 'delete-section'); remove.dataset.sectionId = section.id;
        const up = button('arrow-up', label('favorites.moveSectionUp', '子分类上移'), 'move-section-up'); up.dataset.sectionId = section.id; up.dataset.seriesId = series.id;
        const down = button('arrow-down', label('favorites.moveSectionDown', '子分类下移'), 'move-section-down'); down.dataset.sectionId = section.id; down.dataset.seriesId = series.id;
        head.append(toggle, title, el('span', '', rows.total), up, down, rename, remove); group.append(head);
      }
      const list = el('div', 'favorite-entry-list'); rows.items.forEach(entry => list.append(renderEntry(entry, selected.has(entry.id)))); list.hidden = collapsed; group.append(list);
      if (rows.hasMore) { const more = actionTextButton('load-column', label('favorites.loadMore', '加载更多')); more.dataset.seriesId = series.id; more.dataset.sectionId = section?.id || ''; group.append(more); }
      return group;
    }

    function displayText(entry) {
      if (entry.kind === 'bundle') return string(entry.title || entry.zh, label('favorites.untitledBundle', '未命名组合'));
      const choices = state.prefs.primary === 'zh' ? [entry.zh, entry.title, entry.rawText] : state.prefs.primary === 'title' ? [entry.title, entry.zh, entry.rawText] : [entry.rawText, entry.title, entry.zh];
      return string(choices.find(Boolean), label('favorites.untitled', '未命名收藏'));
    }
    function secondaryText(entry) {
      if (!state.prefs.showSecondary) return '';
      if (entry.kind === 'bundle') return string(entry.rawText || entry.zh, '');
      const primary = displayText(entry);
      return string([entry.title, entry.zh, entry.rawText].find(value => value && String(value) !== primary), '');
    }
    function renderEntry(entry, selected = false) {
      const item = el('article', `favorite-entry favorite-entry-${entry.kind || 'tag'}${selected ? ' is-selected' : ''}${entry.pinned ? ' is-pinned' : ''}`);
      item.dataset.favoriteEntry = entry.id; item.draggable = true;
      const invalidLegacy = entry.legacyInvalid === true && !string(entry.rawText).trim();
      if (invalidLegacy) item.classList.add('is-legacy-invalid');
      const manage = el('input', 'favorite-manage-check'); manage.type = 'checkbox'; manage.checked = state.bulk.has(entry.id); manage.dataset.favoriteManage = entry.id; manage.setAttribute('aria-label', label('favorites.manageSelect', '选择用于批量管理'));
      const main = el('button', 'favorite-entry-main'); main.type = 'button'; main.dataset.favoriteSelect = entry.id; main.title = string(entry.rawText);
      main.disabled = invalidLegacy;
      main.setAttribute('aria-pressed', String(selected));
      const top = el('span', 'favorite-entry-title');
      if (entry.kind === 'bundle') top.append(icon('layers'), el('span', '', displayText(entry)));
      else top.textContent = displayText(entry);
      const secondary = secondaryText(entry); main.append(top); if (secondary) main.append(el('span', 'favorite-entry-secondary', secondary));
      const meta = el('span', 'favorite-entry-meta');
      if (entry.pinned) meta.append(icon('pin'));
      if (entry.kind === 'bundle') {
        const count = safeCall('favoriteMemberCount', entry);
        meta.append(el('span', '', Number.isInteger(count) ? `${count} ${label('favorites.members', '项')}` : label('favorites.bundle', '组合')));
      }
      main.append(meta);
      const actions = el('div', 'favorite-entry-actions');
      const copyButton = button('copy', label('favorites.copy', '复制'), 'copy'); copyButton.dataset.favoriteCopy = entry.id;
      copyButton.disabled = invalidLegacy;
      const edit = button('pencil', label('favorites.edit', '编辑'), 'edit'); edit.dataset.favoriteEdit = entry.id;
      const expand = button(state.expanded.has(entry.id) ? 'chevron-up' : 'chevron-down', label('favorites.expand', '展开'), 'expand'); expand.dataset.favoriteExpand = entry.id;
      const up = button('arrow-up', label('favorites.moveUp', '上移'), 'move-up'); up.dataset.entryId = entry.id;
      const down = button('arrow-down', label('favorites.moveDown', '下移'), 'move-down'); down.dataset.entryId = entry.id;
      const grip = button('grip-vertical', label('favorites.drag', '拖动排序'), '', 'favorite-drag-handle'); grip.tabIndex = -1;
      actions.append(copyButton, edit, expand, up, down, grip); item.append(manage, main, actions);
      if (state.expanded.has(entry.id)) {
        const detail = el('div', 'favorite-entry-detail');
        const inlineTitle = el('input'); inlineTitle.type = 'text'; inlineTitle.value = string(entry.title); inlineTitle.placeholder = label('favorites.entryTitle', '名称'); inlineTitle.dataset.favoriteInlineField = 'title'; inlineTitle.dataset.entryId = entry.id;
        const inlineZh = el('input'); inlineZh.type = 'text'; inlineZh.value = string(entry.zh); inlineZh.placeholder = label('favorites.zh', '中文说明'); inlineZh.dataset.favoriteInlineField = 'zh'; inlineZh.dataset.entryId = entry.id;
        detail.append(inlineTitle, inlineZh, el('pre', '', string(entry.rawText)));
        if (entry.note) detail.append(el('p', '', string(entry.note)));
        if (entry.legacyInvalid) detail.append(el('p', 'favorite-legacy-warning', label('favorites.legacyInvalid', '旧收藏内容无效，请补充原文后保存')));
        item.append(detail);
      }
      return item;
    }
    function icon(id) {
      const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.classList.add('favorite-icon'); svg.setAttribute('aria-hidden', 'true');
      const use = doc.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttribute('href', `../assets/icons/favorites.svg#${id}`); svg.append(use); return svg;
    }

    function runSearch(reset = true) {
      if (reset) state.searchOffset = PAGE_SIZE;
      const wasSearching = Boolean(state.query);
      state.query = string(host?.querySelector('[data-favorite-search]')?.value).trim();
      state.scope = host?.querySelector('[data-favorite-scope]')?.value || 'internal';
      state.kind = host?.querySelector('[data-favorite-kind]')?.value || 'all';
      state.seriesId = host?.querySelector('[data-favorite-series-filter]')?.value || '';
      state.sectionId = host?.querySelector('[data-favorite-section-filter]')?.value || '';
      if (!wasSearching && state.query) state.shelfContext = captureShelfContext();
      renderSearch(true);
    }
    function captureShelfContext() {
      const scroll = host.querySelector('[data-favorite-scroll]'); const active = doc.activeElement?.closest?.('[data-favorite-entry]');
      return { scrollTop: scroll?.scrollTop || 0, scrollLeft: scroll?.scrollLeft || 0, entryId: active?.dataset.favoriteEntry || state.lastShelfFocus, collapsedSections: [...state.prefs.collapsedSections] };
    }
    function restoreShelfContext(context = state.shelfContext) {
      if (!context) return;
      savePreferences({ collapsedSections: [...(context.collapsedSections || [])] }); renderShelf();
      const scroll = host.querySelector('[data-favorite-scroll]'); if (scroll) { scroll.scrollTop = context.scrollTop || 0; scroll.scrollLeft = context.scrollLeft || 0; }
      if (context.entryId) host.querySelector(`[data-favorite-entry="${cssEscape(context.entryId)}"] [data-favorite-select]`)?.focus();
    }
    function clearSearch() {
      const input = host.querySelector('[data-favorite-search]'); if (input) input.value = '';
      state.query = ''; state.searchHits = []; state.searchTotal = 0; state.searchHasMore = false;
      const shelf = host.querySelector('[data-favorite-shelf]'); const results = host.querySelector('[data-favorite-search-results]'); if (shelf) shelf.hidden = false; if (results) results.hidden = true;
      restoreShelfContext(); state.shelfContext = null;
    }
    function renderSearch(updateQuery = false) {
      const shelf = host.querySelector('[data-favorite-shelf]'); const results = host.querySelector('[data-favorite-search-results]');
      if (!state.query) { shelf.hidden = false; results.hidden = true; state.searchHits = []; state.searchTotal = 0; renderShelf(); updateBulkbar(); return; }
      const result = collectSearch(state.searchOffset);
      state.searchHits = result.items; state.searchTotal = result.total; state.searchHasMore = result.hasMore;
      shelf.hidden = true; results.hidden = false; results.replaceChildren();
      const summary = el('div', 'favorites-search-summary', `${label('favorites.searchResults', '搜索结果')} · ${state.searchTotal}`); results.append(summary);
      state.searchHits.forEach(hit => results.append(renderSearchHit(hit)));
      if (!state.searchHits.length) results.append(el('p', 'favorites-empty', label('favorites.noResults', '没有匹配的收藏')));
      if (state.searchHasMore) results.append(actionTextButton('load-search', label('favorites.loadMore', '加载更多')));
      if (updateQuery) updateBulkbar();
    }
    function collectSearch(limit) {
      if (state.scope === 'global') {
        const items = []; let offset = 0, total = 0, hasMore = true;
        while (hasMore) {
          const result = safeCall('search', state.query, { scope: 'internal', seriesId: state.seriesId || undefined, ...(state.sectionId ? { sectionId: state.sectionId } : {}), kind: state.kind, includeAdult: includeAdult(), offset, limit: 500 });
          const rows = Array.isArray(result?.items) ? result.items : [];
          rows.forEach(hit => { const entry = safeCall('getEntry', hit.entryId || hit.id); if (entry?.globalSearchable) { total += 1; if (items.length < limit) items.push(hit); } });
          offset += rows.length; hasMore = Boolean(result?.hasMore) && rows.length > 0;
        }
        return { items, total, hasMore: items.length < total };
      }
      const items = []; let offset = 0, total = 0, hasMore = true;
      while (items.length < limit && hasMore) {
        const result = safeCall('search', state.query, { scope: state.scope, seriesId: state.seriesId || undefined, ...(state.sectionId ? { sectionId: state.sectionId } : {}), kind: state.kind, includeAdult: includeAdult(), offset, limit: Math.min(500, limit - items.length) });
        const rows = Array.isArray(result?.items) ? result.items : [];
        items.push(...rows); total = Number(result?.total) || items.length; offset += rows.length; hasMore = Boolean(result?.hasMore) && rows.length > 0;
      }
      return { items, total, hasMore: items.length < total };
    }
    function renderSearchHit(hit) {
      const id = hit.entryId || hit.id; const entry = safeCall('getEntry', id) || hit;
      const invalidLegacy = entry.legacyInvalid === true && !string(entry.rawText).trim();
      const selected = allSelectedIds().has(id); const item = el('article', `favorite-search-hit${selected ? ' is-selected' : ''}`); item.dataset.favoriteSearchResult = id;
      const path = el('div', 'favorite-search-path', [hit.seriesName, hit.sectionName].filter(Boolean).join(' / '));
      const content = el('button', 'favorite-search-content'); content.type = 'button'; content.dataset.favoriteSelect = id;
      content.disabled = invalidLegacy;
      content.setAttribute('aria-pressed', String(selected));
      const title = el('strong'); appendHighlighted(title, displayText(entry), hit.matches, primaryField(entry));
      const raw = el('span'); appendHighlighted(raw, string(entry.rawText), hit.matches, 'rawText');
      content.append(title, raw);
      const shown = new Set([primaryField(entry), 'rawText']);
      for (const field of ['title', 'zh', 'note', 'aliases']) {
        if (shown.has(field) || !hit.matches?.some(match => match.field === field)) continue;
        const value = field === 'aliases' ? (entry.aliases || []).join(' · ') : string(entry[field]); if (!value) continue;
        const snippet = el('span', 'favorite-search-match'); snippet.dataset.favoriteMatchField = field;
        if (field === 'aliases') snippet.append(el('mark', '', value)); else appendHighlighted(snippet, value, hit.matches, field);
        content.append(snippet);
      }
      const actions = el('div', 'favorite-entry-actions');
      const locate = button('locate-fixed', label('favorites.locate', '定位原处'), 'locate'); locate.dataset.favoriteLocate = id;
      const copyButton = button('copy', label('favorites.copy', '复制'), 'copy'); copyButton.dataset.favoriteCopy = id;
      copyButton.disabled = invalidLegacy;
      const edit = button('pencil', label('favorites.edit', '编辑'), 'edit'); edit.dataset.favoriteEdit = id;
      const manage = el('input', 'favorite-manage-check'); manage.type = 'checkbox'; manage.checked = state.bulk.has(id); manage.dataset.favoriteManage = id; manage.setAttribute('aria-label', label('favorites.manageSelect', '选择用于批量管理'));
      actions.append(manage, locate, copyButton, edit); item.append(path, content, actions); return item;
    }
    function primaryField(entry) {
      if (entry.kind === 'bundle' && entry.title) return 'title';
      if (state.prefs.primary === 'zh' && entry.zh) return 'zh';
      if (state.prefs.primary === 'title' && entry.title) return 'title';
      return 'rawText';
    }
    function appendHighlighted(parent, value, matches, field) {
      const textValue = string(value); const ranges = (matches || []).filter(match => match.field === field).map(match => [number(match.start, 0, 0, textValue.length), number(match.end, textValue.length, 0, textValue.length)]).filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0]);
      if (!ranges.length) { parent.textContent = textValue; return; }
      let offset = 0;
      ranges.forEach(([start, end]) => {
        if (start < offset) return;
        parent.append(doc.createTextNode(textValue.slice(offset, start)), el('mark', '', textValue.slice(start, end))); offset = end;
      });
      parent.append(doc.createTextNode(textValue.slice(offset)));
    }

    function updateBulkbar() {
      const bar = host?.querySelector('[data-favorite-bulkbar]'); const count = host?.querySelector('[data-favorite-bulk-count]');
      if (!bar) return; bar.hidden = !state.bulk.size && !host.querySelector('[data-favorite-bulk-toggle]')?.classList.contains('is-active');
      if (count) count.textContent = String(state.bulk.size);
      host.querySelectorAll('[data-favorite-manage]').forEach(node => { node.checked = state.bulk.has(node.dataset.favoriteManage); });
    }
    function syncSelection() {
      if (!host) return;
      const selected = allSelectedIds();
      host.querySelectorAll('[data-favorite-select]').forEach(node => {
        const id = node.dataset.favoriteSelect; const active = selected.has(id); node.setAttribute('aria-pressed', String(active));
        node.closest('[data-favorite-entry], [data-favorite-search-result]')?.classList.toggle('is-selected', active);
      });
    }
    function updateHistory() {
      const value = safeCall('historyState') || {};
      const undo = host?.querySelector('[data-favorite-action="undo"]'); const redo = host?.querySelector('[data-favorite-action="redo"]');
      if (undo) undo.disabled = !value.canUndo; if (redo) redo.disabled = !value.canRedo;
    }

    function editorSeriesOptions(selectedSeriesId, selectedSectionId) {
      const series = host.querySelector('[data-favorite-field="seriesId"]'); const section = host.querySelector('[data-favorite-field="sectionId"]');
      if (!series || !section) return;
      series.replaceChildren(); seriesRows().forEach(row => series.append(optionNode(row.id, string(row.name, row.id))));
      series.value = selectedSeriesId || series.options[0]?.value || '';
      section.replaceChildren(optionNode('', label('favorites.seriesRoot', '系列根部')));
      sectionRows(series.value).forEach(row => section.append(optionNode(row.id, string(row.name, row.id)))); section.value = selectedSectionId || '';
    }
    function currentVisibleIds() {
      if (state.query) return state.searchHits.map(hit => hit.entryId || hit.id);
      return [...host.querySelectorAll('[data-favorite-entry]')].map(node => node.dataset.favoriteEntry);
    }
    async function openCreate(value = {}) {
      ensureShell();
      const order = currentVisibleIds();
      if (state.editor && !await flushEdits()) return false;
      const firstSeries = value.seriesId || seriesRows()[0]?.id || '';
      const rawText = string(value.rawText); const kind = value.kind === 'bundle' ? 'bundle' : 'tag';
      state.returnFocus = doc.activeElement;
      state.editor = { session: ++state.editorSession, version: rawText ? 1 : 0, savePromise: null, id: null, creating: true, dirty: Boolean(rawText), saved: null, order, historyKey: `favorite-create-${Date.now()}`, draft: {
        kind, seriesId: firstSeries, sectionId: value.sectionId || null, title: string(value.title, kind === 'bundle' && rawText ? label('favorites.defaultBundleTitle', '收藏组合') : ''), rawText, zh: string(value.zh), aliases: Array.isArray(value.aliases) ? [...value.aliases] : [], note: string(value.note), globalSearchable: value.globalSearchable !== false, nsfw: value.nsfw === true
      } };
      renderEditor(); return state.editor;
    }
    async function openEditor(entryId, preserveOrder = false) {
      ensureShell();
      if (state.editor?.id === entryId && !state.editor.creating) return true;
      const order = preserveOrder && state.editor?.order?.length ? [...state.editor.order] : currentVisibleIds();
      if (state.editor && !await flushEdits()) return false;
      const entry = safeCall('getEntry', entryId); if (!entry) { notify(label('favorites.notFound', '收藏不存在')); return false; }
      if (!preserveOrder) state.returnFocus = doc.activeElement;
      state.editor = { session: ++state.editorSession, version: 0, savePromise: null, id: entry.id, creating: false, dirty: false, saved: { ...entry, aliases: [...(entry.aliases || [])] }, order: order.includes(entry.id) ? order : [...order, entry.id], historyKey: `favorite-edit-${entry.id}-${Date.now()}`, draft: { ...entry, aliases: [...(entry.aliases || [])] } };
      renderEditor(); return true;
    }
    function renderEditor() {
      const panel = host.querySelector('[data-favorite-editor]'); if (!panel || !state.editor) return;
      panel.hidden = false; panel.dataset.entryId = state.editor.id || '';
      const draft = state.editor.draft; editorSeriesOptions(draft.seriesId, draft.sectionId);
      host.querySelectorAll('[data-favorite-field]').forEach(field => {
        const key = field.dataset.favoriteField; const value = key === 'aliases' ? (draft.aliases || []).join(', ') : draft[key];
        if (field.type === 'checkbox') field.checked = Boolean(value); else field.value = value == null ? '' : String(value);
      });
      const parent = seriesRows().find(row => row.id === draft.seriesId); const section = sectionRows(draft.seriesId).find(row => row.id === draft.sectionId);
      host.querySelector('[data-favorite-editor-location]').textContent = [parent?.name, section?.name].filter(Boolean).join(' / ');
      host.querySelector('[data-favorite-editor-title]').textContent = state.editor.creating ? label('favorites.create', '新增收藏') : label('favorites.edit', '编辑收藏');
      setSaveStatus('editing', label('favorites.editing', '编辑中'));
      host.querySelector('[data-favorite-field="rawText"]')?.focus();
    }
    function readDraftFromFields(changedField = null) {
      if (!state.editor) return;
      const fields = changedField ? [changedField] : host.querySelectorAll('[data-favorite-field]');
      fields.forEach(field => {
        const key = field.dataset.favoriteField;
        if (field.type === 'checkbox') state.editor.draft[key] = field.checked;
        else if (key === 'aliases') state.editor.draft.aliases = field.value.split(/[,，\n]/).map(value => value.trim()).filter(Boolean);
        else if (key === 'sectionId') state.editor.draft[key] = field.value || null;
        else state.editor.draft[key] = field.value;
      });
      state.editor.version += 1; state.editor.dirty = true; setSaveStatus('editing', label('favorites.editing', '编辑中'));
    }
    function setSaveStatus(kind, value) {
      const status = host?.querySelector('[data-favorite-save-status]'); if (!status) return; status.dataset.status = kind; status.textContent = value;
    }
    function scheduleSave() {
      win?.clearTimeout?.(state.saveTimer); state.saveTimer = null;
      if (!state.editor || state.composing) return;
      state.saveTimer = win.setTimeout(() => { state.saveTimer = null; commitDraft(true); }, SAVE_DELAY);
    }
    async function commitDraft(flushStorage = true) {
      win?.clearTimeout?.(state.saveTimer); state.saveTimer = null;
      const editor = state.editor;
      if (!editor) return flushStorage ? Boolean(await safeCall('flush')) : true;
      if (editor.savePromise) return editor.savePromise;
      if (!editor.dirty) return flushStorage ? Boolean(await safeCall('flush')) : true;
      const saving = (async () => {
        while (state.editor === editor && editor.dirty) {
          const version = editor.version;
          const patch = { ...editor.draft, aliases: [...(editor.draft.aliases || [])] };
          if (!string(patch.rawText).trim()) { setSaveStatus('invalid', label('favorites.rawRequired', '原文不能为空')); return false; }
          if (patch.kind === 'bundle' && !string(patch.title).trim()) { setSaveStatus('invalid', label('favorites.bundleTitleRequired', '标签组名称不能为空')); return false; }
          if (!patch.seriesId) { setSaveStatus('invalid', label('favorites.seriesRequired', '请选择系列')); return false; }
          if (editor.id) patch.id = editor.id; else delete patch.id;
          setSaveStatus('saving', label('favorites.saving', '保存中'));
          const result = safeCall('saveEntry', patch, { historyKey: editor.historyKey });
          if (!result?.ok) { setSaveStatus('failed', result?.error?.message || label('favorites.saveFailed', '保存失败')); return false; }
          if (state.editor !== editor) return true;
          editor.id = result.data.id; editor.creating = false;
          const persisted = !flushStorage || Boolean(await safeCall('flush'));
          if (state.editor !== editor) return persisted;
          if (!persisted) { setSaveStatus('failed', label('favorites.saveFailed', '保存失败')); return false; }
          if (editor.version !== version) { editor.dirty = true; setSaveStatus('editing', label('favorites.editing', '编辑中')); continue; }
          editor.draft = { ...result.data, aliases: [...(result.data.aliases || [])] };
          editor.saved = { ...editor.draft, aliases: [...editor.draft.aliases] };
          editor.dirty = false; setSaveStatus('saved', label('favorites.saved', '已保存'));
          if (editor.endTransactionAfterSave) { editor.endTransactionAfterSave = false; editor.historyKey = `favorite-edit-${editor.id}-${Date.now()}`; }
        }
        return true;
      })();
      editor.savePromise = saving;
      try { return await saving; } finally { if (editor.savePromise === saving) editor.savePromise = null; }
    }
    async function flushEdits() { return commitDraft(true); }
    function endEditorTransaction() {
      if (!state.editor) return;
      if (state.editor.dirty) state.editor.endTransactionAfterSave = true;
      else state.editor.historyKey = `favorite-edit-${state.editor.id || 'new'}-${Date.now()}`;
    }
    async function saveEditorTransaction() {
      if (!await flushEdits()) return false;
      endEditorTransaction(); return true;
    }
    async function finishEditorBeforeMutation() {
      if (!state.editor) return true;
      if (!await flushEdits()) return false;
      discardEditor(); return true;
    }
    async function saveInlineField(field) {
      const id = field.dataset.entryId; const key = field.dataset.favoriteInlineField;
      if (!id || !['title', 'zh'].includes(key)) return false;
      if (state.editor && !await finishEditorBeforeMutation()) return false;
      const current = safeCall('getEntry', id);
      if (current?.kind === 'bundle' && key === 'title' && !string(field.value).trim()) { notify(label('favorites.bundleTitleRequired', '标签组名称不能为空')); field.value = string(current.title); return false; }
      const result = safeCall('saveEntry', { id, [key]: field.value }, { historyKey: `favorite-inline-${id}-${key}` });
      if (!result?.ok) { notify(result?.error?.message || label('favorites.saveFailed', '保存失败')); return false; }
      const persisted = Boolean(await safeCall('flush')); if (!persisted) notify(label('favorites.saveFailed', '保存失败')); return persisted;
    }
    async function navigateEditor(direction) {
      if (!state.editor || !await flushEdits()) return false;
      const order = state.editor.order; const index = order.indexOf(state.editor.id); const next = order[index + direction];
      if (!next) return false; return openEditor(next, true);
    }
    function discardEditor() {
      win?.clearTimeout?.(state.saveTimer); state.saveTimer = null;
      const focus = state.returnFocus; state.editor = null; const panel = host.querySelector('[data-favorite-editor]'); if (panel) panel.hidden = true;
      render(); if (focus?.isConnected) focus.focus(); return true;
    }

    function refreshChangedEntries(ids) {
      const selected = allSelectedIds();
      unique(ids).forEach(id => {
        if (state.editor?.id === id) return;
        const entry = safeCall('getEntry', id);
        host.querySelectorAll(`[data-favorite-entry="${cssEscape(id)}"]`).forEach(node => {
          if (!entry) node.remove(); else node.replaceWith(renderEntry(entry, selected.has(id)));
        });
        const hitIndex = state.searchHits.findIndex(hit => (hit.entryId || hit.id) === id);
        host.querySelectorAll(`[data-favorite-search-result="${cssEscape(id)}"]`).forEach(node => {
          if (!entry) node.remove();
          else {
            const hit = hitIndex >= 0 ? { ...state.searchHits[hitIndex], ...entry, entryId: id } : { ...entry, entryId: id, matches: [] };
            if (hitIndex >= 0) state.searchHits[hitIndex] = hit;
            node.replaceWith(renderSearchHit(hit));
          }
        });
      });
    }

    async function copyEntry(id, select = false) {
      if (state.editor?.id === id && state.editor.dirty && !await flushEdits()) return false;
      const entry = safeCall('getEntry', id); if (!entry || !string(entry.rawText).trim()) { notify(label('favorites.invalidFavorite', '收藏原文无效，请先编辑修复')); return false; }
      if (select) {
        const selected = allSelectedIds(); const result = safeCall('setSelected', id, !selected.has(id));
        if (!result?.ok) { notify(result?.error?.message || label('favorites.selectFailed', '选择失败')); return false; }
        onSelectionChange(result.data || favorites.selected?.({ includeAdult: includeAdult() }) || []);
        syncSelection();
      }
      const value = safeCall('copyText', [id]);
      if (!value) return false;
      let copied = false; try { copied = Boolean(await copy(value)); } catch { copied = false; }
      if (copied) safeCall('markCopied', [id]); else notify(label('favorites.copyFailed', '复制失败，请检查剪贴板权限'));
      return copied;
    }
    function cssEscape(value) { return win?.CSS?.escape ? win.CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); }

    function focusEntry(entryId) {
      if (state.query) state.searchContext = { query: state.query, scope: state.scope, kind: state.kind, seriesId: state.seriesId, sectionId: state.sectionId, recent: state.recent, scrollTop: host.querySelector('[data-favorite-scroll]')?.scrollTop || 0, collapsedSections: [...state.prefs.collapsedSections] };
      state.query = ''; state.seriesId = ''; state.sectionId = ''; state.kind = 'all'; state.recent = false;
      const search = host.querySelector('[data-favorite-search]'); const kind = host.querySelector('[data-favorite-kind]'); const series = host.querySelector('[data-favorite-series-filter]'); const recent = host.querySelector('[data-favorite-recent]');
      if (search) search.value = ''; if (kind) kind.value = 'all'; if (series) series.value = ''; if (recent) recent.classList.remove('is-active'); renderFilters();
      const entry = safeCall('getEntry', entryId);
      if (entry?.sectionId && state.prefs.collapsedSections.includes(entry.sectionId)) savePreferences({ collapsedSections: state.prefs.collapsedSections.filter(id => id !== entry.sectionId) });
      renderShelf(); renderAnchors(); const shelf = host.querySelector('[data-favorite-shelf]'); const results = host.querySelector('[data-favorite-search-results]'); shelf.hidden = false; results.hidden = true;
      let target = host.querySelector(`[data-favorite-entry="${cssEscape(entryId)}"]`);
      if (!target) {
        if (entry) { state.loadedColumns.add(entry.seriesId); state.columnLimits.set(entry.seriesId, Number.MAX_SAFE_INTEGER); }
        renderShelf(); target = host.querySelector(`[data-favorite-entry="${cssEscape(entryId)}"]`);
      }
      target?.scrollIntoView?.({ behavior: 'smooth', block: 'center', inline: 'center' }); target?.classList.add('is-located'); target?.querySelector('[data-favorite-select]')?.focus();
      if (target) win?.setTimeout?.(() => target.classList.remove('is-located'), 1200); return Boolean(target);
    }
    function returnSearch() {
      if (!state.searchContext) return;
      Object.assign(state, state.searchContext); state.searchContext = null; const search = host.querySelector('[data-favorite-search]'); if (search) search.value = state.query;
      savePreferences({ collapsedSections: [...(state.collapsedSections || state.prefs.collapsedSections)] }); renderFilters();
      const scope = host.querySelector('[data-favorite-scope]'); const kind = host.querySelector('[data-favorite-kind]'); const series = host.querySelector('[data-favorite-series-filter]'); const section = host.querySelector('[data-favorite-section-filter]');
      if (scope) scope.value = state.scope; if (kind) kind.value = state.kind; if (series) series.value = state.seriesId; if (section) section.value = state.sectionId;
      host.querySelector('[data-favorite-recent]')?.classList.toggle('is-active', state.recent);
      renderSearch(); renderAnchors(); const scroll = host.querySelector('[data-favorite-scroll]'); if (scroll) scroll.scrollTop = state.scrollTop || 0;
    }
    function setZoom(value) { const zoom = Math.round(number(value, state.prefs.zoom, 75, 150)); savePreferences({ zoom }); return zoom; }

    async function applyBulk(action) {
      const ids = [...state.bulk]; if (!ids.length && action !== 'all-results' && action !== 'visible') return;
      let result;
      if (action === 'visible') {
        const visible = state.query ? state.searchHits.map(hit => hit.entryId || hit.id) : [...host.querySelectorAll('[data-favorite-entry]')].map(node => node.dataset.favoriteEntry);
        visible.forEach(id => state.bulk.add(id)); updateBulkbar(); return;
      }
      if (action === 'all-results') { (await collectAllSearchIds()).forEach(id => state.bulk.add(id)); updateBulkbar(); return; }
      if (action === 'clear-bulk') { state.bulk.clear(); updateBulkbar(); return; }
      if (action === 'copy-selected') {
        if (!await flushEdits()) return;
        const ordered = await orderedBulkIds(ids); const value = safeCall('copyText', ordered); if (!value) return;
        let copied = false; try { copied = Boolean(await copy(value)); } catch { copied = false; }
        if (copied) safeCall('markCopied', ordered); else notify(label('favorites.copyFailed', '复制失败，请检查剪贴板权限')); return;
      }
      if (action === 'delete-selected') {
        const message = label('favorites.confirmDeleteEntries', `确定删除 ${ids.length} 条收藏吗？`).replace('{count}', String(ids.length));
        const approved = typeof win?.confirm !== 'function' || win.confirm(message);
        if (!approved || !await finishEditorBeforeMutation()) return;
        result = safeCall('deleteEntries', ids);
      } else {
        if (!await finishEditorBeforeMutation()) return;
      }
      if (action === 'pin-selected') result = safeCall('applyBatch', { ids, patch: { pinned: true } });
      if (action === 'unpin-selected') result = safeCall('applyBatch', { ids, patch: { pinned: false } });
      if (action === 'searchable-on') result = safeCall('applyBatch', { ids, patch: { globalSearchable: true } });
      if (action === 'searchable-off') result = safeCall('applyBatch', { ids, patch: { globalSearchable: false } });
      if (action === 'duplicate-selected') { const seriesId = host.querySelector('[data-favorite-bulk-move]')?.value; result = safeCall('duplicateEntries', { ids, seriesId: seriesId || undefined, sectionId: null }); }
      if (action === 'move-selected') { const seriesId = host.querySelector('[data-favorite-bulk-move]')?.value; if (seriesId) result = safeCall('applyBatch', { ids, patch: { seriesId, sectionId: null } }); }
      if (result?.ok) { state.bulk.clear(); render(); } else if (result) notify(result.error?.message || label('favorites.operationFailed', '操作失败'));
    }
    async function orderedBulkIds(ids) {
      const chosen = new Set(ids); const order = [];
      if (state.query) return (await collectAllSearchIds()).filter(id => chosen.has(id));
      let offset = 0, hasMore = true;
      while (hasMore) {
        const result = safeCall('list', { includeAdult: true, offset, limit: 500, view: 'shelf' }); const rows = Array.isArray(result?.items) ? result.items : [];
        order.push(...rows.map(row => row.id).filter(id => chosen.has(id))); offset += rows.length; hasMore = Boolean(result?.hasMore) && rows.length > 0;
      }
      return order;
    }
    async function collectAllSearchIds() {
      if (!state.query) return [];
      const ids = []; let offset = 0; let hasMore = true;
      while (hasMore) {
        const result = safeCall('search', state.query, { scope: 'internal', seriesId: state.seriesId || undefined, ...(state.sectionId ? { sectionId: state.sectionId } : {}), kind: state.kind, includeAdult: includeAdult(), offset, limit: 500 });
        const rows = Array.isArray(result?.items) ? result.items : [];
        ids.push(...rows.map(hit => hit.entryId || hit.id).filter(id => state.scope !== 'global' || safeCall('getEntry', id)?.globalSearchable)); offset += rows.length; hasMore = Boolean(result?.hasMore) && rows.length > 0;
      }
      return unique(ids);
    }
    async function reorderEntry(id, direction) {
      if (!await finishEditorBeforeMutation()) return false;
      const entry = safeCall('getEntry', id); if (!entry) return;
      const parent = entry.sectionId || entry.seriesId; const rows = readEntries(entry.seriesId, entry.sectionId || null, 10000, true).items; const ids = rows.map(row => row.id); const index = ids.indexOf(id); const next = index + direction;
      if (index < 0 || next < 0 || next >= ids.length) return;
      [ids[index], ids[next]] = [ids[next], ids[index]]; const result = safeCall('reorder', { kind: 'entry', parentId: parent, ids }); if (result?.ok) render();
    }
    async function reorderStructure(kind, id, direction, parentId = null) {
      if (!await finishEditorBeforeMutation()) return false;
      const rows = kind === 'series' ? seriesRows() : sectionRows(parentId); const ids = rows.map(row => row.id); const index = ids.indexOf(id); const next = index + direction;
      if (index < 0 || next < 0 || next >= ids.length) return false;
      [ids[index], ids[next]] = [ids[next], ids[index]]; const result = safeCall('reorder', { kind, parentId, ids }); if (result?.ok) render(); return Boolean(result?.ok);
    }

    async function openImport() {
      if (!await flushEdits()) return false;
      const panel = host.querySelector('[data-favorite-transfer]'); if (panel) panel.hidden = false;
      state.transferOpen = true;
      renderFilters(); renderImportSections();
      const format = host.querySelector('[data-favorite-import-format]'); const mode = host.querySelector('[data-favorite-import-mode]');
      if (mode) mode.disabled = format?.value !== 'json';
      return true;
    }
    function renderImportSections() {
      const seriesId = host.querySelector('[data-favorite-import-series]')?.value; const section = host.querySelector('[data-favorite-import-section]'); if (!section) return;
      const previous = section.value; section.replaceChildren(optionNode('', label('favorites.seriesRoot', '系列根部')));
      sectionRows(seriesId).forEach(row => section.append(optionNode(row.id, string(row.name, row.id)))); if ([...section.options].some(item => item.value === previous)) section.value = previous;
    }
    function importSignature() {
      return JSON.stringify({
        text: host.querySelector('[data-favorite-import-text]')?.value || '', format: host.querySelector('[data-favorite-import-format]')?.value || 'lines',
        mode: host.querySelector('[data-favorite-import-mode]')?.value || 'append', kind: host.querySelector('[data-favorite-import-kind]')?.value || 'tag',
        seriesId: host.querySelector('[data-favorite-import-series]')?.value || '', sectionId: host.querySelector('[data-favorite-import-section]')?.value || ''
      });
    }
    function invalidateImportPreview(clearMessage = true) {
      state.importCandidate = null; const node = host.querySelector('[data-favorite-import-preview]');
      if (node) { node.dataset.valid = 'false'; if (clearMessage) node.textContent = ''; }
    }
    async function previewImport() {
      invalidateImportPreview(false);
      if (!await flushEdits()) return false;
      const textValue = host.querySelector('[data-favorite-import-text]')?.value || ''; const format = host.querySelector('[data-favorite-import-format]')?.value || 'lines'; const mode = host.querySelector('[data-favorite-import-mode]')?.value || 'append'; const seriesId = host.querySelector('[data-favorite-import-series]')?.value || seriesRows()[0]?.id; const sectionId = host.querySelector('[data-favorite-import-section]')?.value || null; const kind = host.querySelector('[data-favorite-import-kind]')?.value || 'tag';
      let preview;
      if (format === 'json') {
        let bundle; try { bundle = JSON.parse(textValue); } catch (error) { return showImportPreview(error.message, null); }
        preview = safeCall('previewImport', bundle, { mode }); state.importCandidate = preview?.ok ? { type: 'json', bundle, options: { mode }, signature: importSignature() } : null;
      } else {
        const pasteOptions = { format, kind, seriesId, sectionId };
        preview = safeCall('previewPaste', textValue, pasteOptions);
        if (preview == null && parsePaste) preview = parsePaste(textValue, pasteOptions);
        state.importCandidate = preview?.ok ? { type: 'paste', text: textValue, options: pasteOptions, signature: importSignature() } : null;
      }
      const count = preview?.data?.entries?.length ?? preview?.data?.ids?.length ?? preview?.data?.valid ?? preview?.data?.incoming?.entries ?? 0;
      let message = `${label('favorites.validEntries', '有效条目')}：${count}`;
      if (preview?.ok && format === 'json' && mode === 'replace') {
        const before = preview.data.replaced || {}; const after = preview.data.incoming || {};
        message = `${label('favorites.replaceExisting', '现有')}：${Number(before.series) || 0}/${Number(before.sections) || 0}/${Number(before.entries) || 0} → ${label('favorites.replaceIncoming', '导入后')}：${Number(after.series) || 0}/${Number(after.sections) || 0}/${Number(after.entries) || 0}`;
      }
      showImportPreview(preview?.ok ? message : preview?.error?.message, preview); return preview;
    }
    function showImportPreview(message, preview) { const node = host.querySelector('[data-favorite-import-preview]'); if (node) { node.textContent = string(message); node.dataset.valid = String(Boolean(preview?.ok)); } }
    async function confirmImport() {
      if (!await flushEdits()) return false;
      const candidate = state.importCandidate;
      if (!candidate || candidate.signature !== importSignature()) { invalidateImportPreview(false); showImportPreview(label('favorites.previewRequired', '内容已变化，请重新预览'), null); return false; }
      if (candidate.type === 'json' && candidate.options.mode === 'replace') {
        const approved = typeof win?.confirm !== 'function' || win.confirm(label('favorites.confirmReplaceImport', '替换会覆盖现有收藏。已查看数量并继续？'));
        if (!approved) return false;
        if (!await finishEditorBeforeMutation()) return false;
        if (!downloadBundle('ai-tag-favorites-backup.json')) { notify(label('favorites.backupFailed', '无法生成备份，已取消替换导入')); return false; }
      }
      const result = candidate.type === 'paste' ? safeCall('importPaste', candidate.text, candidate.options) : safeCall('importBundle', candidate.bundle, candidate.options);
      if (result?.ok) { host.querySelector('[data-favorite-transfer]').hidden = true; state.transferOpen = false; state.importCandidate = null; render(); } else notify(result?.error?.message || label('favorites.importFailed', '导入失败'));
      return Boolean(result?.ok);
    }
    async function exportFavorites() {
      if (!await flushEdits()) return false; return downloadBundle('ai-tag-favorites.json');
    }
    function downloadBundle(filename) {
      const bundle = safeCall('exportBundle'); if (!bundle || !win?.Blob || !win.URL?.createObjectURL) return false;
      const blob = new win.Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }); const url = win.URL.createObjectURL(blob); const link = el('a');
      link.href = url; link.download = filename; link.click(); win.setTimeout(() => win.URL.revokeObjectURL(url), 0); return true;
    }
    async function readImportFile(input) {
      const file = input?.files?.[0]; if (!file) return false;
      let textValue = '';
      try {
        if (typeof file.text === 'function') textValue = await file.text();
        else textValue = await new Promise((resolve, reject) => { const reader = new win.FileReader(); reader.onload = () => resolve(String(reader.result || '')); reader.onerror = () => reject(reader.error || new Error('read failed')); reader.readAsText(file); });
      } catch (error) { notify(error.message || label('favorites.fileReadFailed', '无法读取文件')); return false; }
      const format = host.querySelector('[data-favorite-import-format]'); const textarea = host.querySelector('[data-favorite-import-text]'); const mode = host.querySelector('[data-favorite-import-mode]');
      if (format) format.value = 'json'; if (textarea) textarea.value = textValue; if (mode) mode.disabled = false; invalidateImportPreview(); input.value = ''; return true;
    }

    async function structureAction(action, target) {
      if (action === 'new-series') return openNameDialog(() => label('favorites.seriesName', '系列名称'), '', name => safeCall('saveSeries', { name }), target);
      if (action === 'rename-series') {
        const row = seriesRows().find(item => item.id === target.dataset.seriesId); if (!row) return false;
        return openNameDialog(() => label('favorites.seriesName', '系列名称'), row.name || '', name => safeCall('saveSeries', { id: row.id, name }), target);
      }
      if (action === 'new-section') return openNameDialog(() => label('favorites.sectionName', '子分类名称'), '', name => safeCall('saveSection', { seriesId: target.dataset.seriesId, name }), target);
      if (action === 'rename-section') {
        const row = sectionRows(target.dataset.seriesId).find(item => item.id === target.dataset.sectionId); if (!row) return false;
        return openNameDialog(() => label('favorites.sectionName', '子分类名称'), row.name || '', name => safeCall('saveSection', { id: row.id, seriesId: row.seriesId, name }), target);
      }
      if (action === 'delete-section') {
        const approved = typeof win?.confirm !== 'function' || win.confirm(label('favorites.confirmDeleteSection', '删除子分类并将内容移到系列根部？'));
        if (approved && !await finishEditorBeforeMutation()) return false;
        if (approved) { safeCall('deleteSection', target.dataset.sectionId); render(); } return approved;
      }
      if (action === 'delete-series-all') {
        const approved = typeof win?.confirm !== 'function' || win.confirm(label('favorites.confirmDeleteSeries', '删除系列及其中内容？'));
        if (approved && !await finishEditorBeforeMutation()) return false;
        if (approved) { safeCall('deleteSeries', target.dataset.seriesId, { mode: 'delete' }); render(); } return approved;
      }
      if (action === 'delete-series') {
        const id = target.dataset.seriesId;
        const approved = typeof win?.confirm !== 'function' || win.confirm(label('favorites.confirmMoveSeries', '删除系列并将内容移到“未分类”？'));
        if (!approved) return false;
        if (!await finishEditorBeforeMutation()) return false;
        const result = safeCall('deleteSeries', id, { mode: 'move' });
        if (!result?.ok) notify(result?.error?.message || label('favorites.operationFailed', '操作失败'));
        render(); return Boolean(result?.ok);
      }
      return false;
    }

    async function handleClick(event) {
      const target = event.target.closest?.('[data-favorite-action], [data-favorite-copy], [data-favorite-edit], [data-favorite-expand], [data-favorite-select], [data-favorite-locate]'); if (!target || !host.contains(target)) return;
      if (target.dataset.favoriteCopy) return void copyEntry(target.dataset.favoriteCopy, false);
      if (target.dataset.favoriteEdit) return void openEditor(target.dataset.favoriteEdit);
      if (target.dataset.favoriteExpand) { const id = target.dataset.favoriteExpand; state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id); render(); return; }
      if (target.dataset.favoriteSelect) return void copyEntry(target.dataset.favoriteSelect, true);
      if (target.dataset.favoriteLocate) return void focusEntry(target.dataset.favoriteLocate);
      const action = target.dataset.favoriteAction;
      if (action === 'dialog-cancel') { closeNameDialog(); return; }
      if (action === 'dialog-confirm') { submitNameDialog(); return; }
      if (['new-series', 'rename-series', 'new-section', 'rename-section', 'delete-section', 'delete-series', 'delete-series-all'].includes(action)) return void structureAction(action, target);
      if (action === 'new-tag') return void openCreate({ kind: 'tag', seriesId: state.seriesId || undefined });
      if (action === 'new-bundle') return void openCreate({ kind: 'bundle', seriesId: state.seriesId || undefined });
      if (action === 'clear-search') { clearSearch(); return; }
      if (action === 'undo' || action === 'redo') { if (!await finishEditorBeforeMutation()) return; safeCall(action); render(); return; }
      if (action === 'recent') { state.recent = !state.recent; target.classList.toggle('is-active', state.recent); renderShelf(); return; }
      if (action === 'bulk') { target.classList.toggle('is-active'); updateBulkbar(); return; }
      if (action === 'zoom-out') return void setZoom(state.prefs.zoom - 10);
      if (action === 'zoom-in') return void setZoom(state.prefs.zoom + 10);
      if (action === 'zoom-reset') return void setZoom(100);
      if (action === 'anchor-series') { hydrateSeries(target.dataset.seriesId); const node = host.querySelector(`[data-favorite-series="${cssEscape(target.dataset.seriesId)}"]`); node?.scrollIntoView?.({ behavior: 'smooth', block: 'start', inline: 'start' }); node?.querySelector('h3')?.focus?.(); renderSubanchors(target.dataset.seriesId); return; }
      if (action === 'anchor-section') { const node = host.querySelector(`[data-favorite-section="${cssEscape(target.dataset.sectionId)}"]`); node?.scrollIntoView?.({ behavior: 'smooth', block: 'start', inline: 'center' }); node?.querySelector('h4')?.focus(); return; }
      if (action === 'return-search') return void returnSearch();
      if (action === 'editor-prev') return void navigateEditor(-1);
      if (action === 'editor-next') return void navigateEditor(1);
      if (action === 'editor-close') { if (await flushEdits()) discardEditor(); return; }
      if (action === 'editor-discard') return void discardEditor();
      if (action === 'editor-save') return void saveEditorTransaction();
      if (action === 'editor-copy') { if (await flushEdits()) await copyEntry(state.editor.id, false); return; }
      if (action === 'move-up') return void reorderEntry(target.dataset.entryId, -1);
      if (action === 'move-down') return void reorderEntry(target.dataset.entryId, 1);
      if (action === 'move-series-up') return void reorderStructure('series', target.dataset.seriesId, -1, null);
      if (action === 'move-series-down') return void reorderStructure('series', target.dataset.seriesId, 1, null);
      if (action === 'move-section-up') return void reorderStructure('section', target.dataset.sectionId, -1, target.dataset.seriesId);
      if (action === 'move-section-down') return void reorderStructure('section', target.dataset.sectionId, 1, target.dataset.seriesId);
      if (action === 'toggle-section') {
        const id = target.dataset.sectionId; const collapsed = new Set(state.prefs.collapsedSections); collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id);
        savePreferences({ collapsedSections: [...collapsed] }); renderShelf(); return;
      }
      if (action === 'load-search') { state.searchOffset += PAGE_SIZE; renderSearch(); return; }
      if (action === 'load-series') { hydrateSeries(target.dataset.seriesId); return; }
      if (action === 'load-column') { const key = target.dataset.seriesId; state.columnLimits.set(key, (state.columnLimits.get(key) || INITIAL_COLUMN_BATCH) + COLUMN_BATCH); const node = host.querySelector(`[data-favorite-series="${cssEscape(key)}"]`); const series = seriesRows().find(row => row.id === key); if (node && series) node.replaceWith(renderSeries(series, allSelectedIds(), false)); return; }
      if (action === 'auto-color') { safeCall('setSeriesColors', state.bulkSeries.size ? [...state.bulkSeries] : [target.dataset.seriesId], { mode: 'auto' }); render(); return; }
      if (action === 'open-import') return void openImport();
      if (action === 'close-import') { host.querySelector('[data-favorite-transfer]').hidden = true; state.transferOpen = false; return; }
      if (action === 'choose-json-file') { host.querySelector('[data-favorite-import-file]')?.click(); return; }
      if (action === 'preview-import') return void previewImport();
      if (action === 'confirm-import') return void confirmImport();
      if (action === 'export') return void exportFavorites();
      if (['visible', 'all-results', 'clear-bulk', 'pin-selected', 'unpin-selected', 'searchable-on', 'searchable-off', 'duplicate-selected', 'delete-selected'].includes(action)) return void applyBulk(action);
    }
    function handleSubmit(event) {
      if (!event.target.matches('[data-favorite-dialog-form]')) return;
      event.preventDefault(); submitNameDialog();
    }
    function renderSubanchors(seriesId) {
      const nav = host.querySelector('[data-favorite-subanchors]'); nav.replaceChildren(); const rows = sectionRows(seriesId); nav.hidden = !rows.length;
      rows.forEach(row => { const item = actionTextButton('anchor-section', string(row.name, row.id)); item.dataset.sectionId = row.id; nav.append(item); });
    }
    function handleInput(event) {
      if (event.target.matches('[data-favorite-search]')) { win.clearTimeout(state.searchTimer); state.searchTimer = win.setTimeout(() => { state.searchTimer = null; runSearch(); }, SEARCH_DELAY); return; }
      if (event.target.matches('[data-favorite-anchor-search]')) {
        state.anchorQuery = event.target.value; const needle = state.anchorQuery.trim().toLocaleLowerCase();
        host.querySelectorAll('[data-favorite-anchors] [data-favorite-action="anchor-series"]').forEach(node => { node.hidden = Boolean(needle) && !node.textContent.toLocaleLowerCase().includes(needle); }); return;
      }
      if (event.target.matches('[data-favorite-import-text]')) { invalidateImportPreview(); return; }
      if (event.target.matches('[data-favorite-field]')) { readDraftFromFields(event.target); scheduleSave(); }
    }
    function handleChange(event) {
      const target = event.target;
      if (target.matches('[data-favorite-scope], [data-favorite-kind], [data-favorite-series-filter], [data-favorite-section-filter]')) { if (target.matches('[data-favorite-series-filter]')) { state.sectionId = ''; const section = host.querySelector('[data-favorite-section-filter]'); if (section) section.value = ''; } runSearch(); renderFilters(); return; }
      if (target.matches('[data-favorite-import-file]')) { void readImportFile(target); return; }
      if (target.matches('[data-favorite-inline-field]')) { void saveInlineField(target); return; }
      if (target.matches('[data-favorite-import-series]')) { renderImportSections(); invalidateImportPreview(); return; }
      if (target.matches('[data-favorite-import-format]')) { const json = target.value === 'json'; const mode = host.querySelector('[data-favorite-import-mode]'); const kind = host.querySelector('[data-favorite-import-kind]'); const section = host.querySelector('[data-favorite-import-section]'); if (mode) mode.disabled = !json; if (kind) kind.disabled = json; if (section) section.disabled = json; invalidateImportPreview(); return; }
      if (target.matches('[data-favorite-import-kind], [data-favorite-import-section], [data-favorite-import-mode]')) { invalidateImportPreview(); return; }
      if (target.matches('[data-favorite-manage]')) { target.checked ? state.bulk.add(target.dataset.favoriteManage) : state.bulk.delete(target.dataset.favoriteManage); updateBulkbar(); return; }
      if (target.matches('[data-favorite-series-manage]')) { target.checked ? state.bulkSeries.add(target.dataset.favoriteSeriesManage) : state.bulkSeries.delete(target.dataset.favoriteSeriesManage); return; }
      if (target.matches('[data-favorite-column-width]')) { savePreferences({ columnWidth: number(target.value, DEFAULT_VIEW.columnWidth, 220, 420) }); return; }
      if (target.matches('[data-favorite-zoom]')) { setZoom(target.value); return; }
      if (target.matches('[data-favorite-primary]')) { savePreferences({ primary: target.value }); renderShelf(); if (state.query) renderSearch(); return; }
      if (target.matches('[data-favorite-secondary]')) { savePreferences({ showSecondary: target.checked }); renderShelf(); return; }
      if (target.matches('[data-favorite-compact]')) { savePreferences({ compact: target.checked }); return; }
      if (target.matches('[data-favorite-series-color]')) { safeCall('setSeriesColors', state.bulkSeries.size ? [...state.bulkSeries] : [target.dataset.favoriteSeriesColor], { mode: 'custom', color: target.value }); render(); return; }
      if (target.matches('[data-favorite-bulk-move]') && target.value) { applyBulk('move-selected'); return; }
      if (target.matches('[data-favorite-field="seriesId"]')) { readDraftFromFields(target); editorSeriesOptions(target.value, null); readDraftFromFields(host.querySelector('[data-favorite-field="sectionId"]')); scheduleSave(); }
    }
    function handleCompositionStart(event) { if (event.target.matches('[data-favorite-field]')) { state.composing = true; win.clearTimeout(state.saveTimer); state.saveTimer = null; } }
    function handleCompositionEnd(event) { if (event.target.matches('[data-favorite-field]')) { state.composing = false; readDraftFromFields(event.target); scheduleSave(); } }
    function handleFocusIn(event) { const entry = event.target.closest?.('[data-favorite-entry]'); if (entry) state.lastShelfFocus = entry.dataset.favoriteEntry || ''; }
    function handleFocusOut(event) { if (event.target.matches?.('[data-favorite-field]') && !event.relatedTarget?.matches?.('[data-favorite-field]')) endEditorTransaction(); }
    async function handleKeydown(event) {
      if (!state.active || state.destroyed) return;
      if (state.dialog && event.key === 'Enter' && event.target.matches?.('[data-favorite-dialog-input]')) { event.preventDefault(); submitNameDialog(); return; }
      const editable = event.target.matches?.('input, textarea, select, [contenteditable="true"]');
      if (event.key === 'Escape') { if (state.dialog) { event.preventDefault(); closeNameDialog(); } else if (state.transferOpen) { event.preventDefault(); host.querySelector('[data-favorite-transfer]').hidden = true; state.transferOpen = false; } else if (state.editor) { event.preventDefault(); discardEditor(); } else if (state.query) { event.preventDefault(); host.querySelector('[data-favorite-action="clear-search"]').click(); } return; }
      if (event.key === 'F2') { const entry = event.target.closest?.('[data-favorite-entry], [data-favorite-search-result]'); if (entry) { event.preventDefault(); openEditor(entry.dataset.favoriteEntry || entry.dataset.favoriteSearchResult); } return; }
      if ((event.ctrlKey || event.metaKey) && !editable && event.key.toLowerCase() === 'c' && !win.getSelection?.()?.toString()) { const entry = event.target.closest?.('[data-favorite-entry], [data-favorite-search-result]'); if (entry) { event.preventDefault(); copyEntry(entry.dataset.favoriteEntry || entry.dataset.favoriteSearchResult, false); } }
      if ((event.ctrlKey || event.metaKey) && !editable && event.key.toLowerCase() === 'z') { event.preventDefault(); if (await finishEditorBeforeMutation()) { safeCall(event.shiftKey ? 'redo' : 'undo'); render(); } }
      if ((event.ctrlKey || event.metaKey) && !editable && event.key.toLowerCase() === 'y') { event.preventDefault(); if (await finishEditorBeforeMutation()) { safeCall('redo'); render(); } }
    }
    function handleDragStart(event) { const entry = event.target.closest?.('[data-favorite-entry]'); state.draggedId = entry?.dataset.favoriteEntry || ''; event.dataTransfer?.setData?.('text/plain', state.draggedId); }
    function handleDragOver(event) { if (event.target.closest?.('[data-favorite-entry]')) event.preventDefault(); }
    async function handleDrop(event) {
      const target = event.target.closest?.('[data-favorite-entry]'); const sourceId = state.draggedId || event.dataTransfer?.getData?.('text/plain'); if (!target || !sourceId || target.dataset.favoriteEntry === sourceId) return;
      event.preventDefault(); const source = safeCall('getEntry', sourceId); const destination = safeCall('getEntry', target.dataset.favoriteEntry); if (!source || !destination || source.seriesId !== destination.seriesId || source.sectionId !== destination.sectionId) return;
      if (!await finishEditorBeforeMutation()) return;
      const rows = readEntries(source.seriesId, source.sectionId || null, 10000, true).items.map(row => row.id); const from = rows.indexOf(sourceId); const to = rows.indexOf(destination.id); rows.splice(from, 1); rows.splice(to, 0, sourceId); safeCall('reorder', { kind: 'entry', parentId: source.sectionId || source.seriesId, ids: rows }); state.draggedId = ''; render();
    }

    function bind() {
      if (!host || state.bound || state.destroyed) return;
      ensureShell(); state.bound = true;
      host.addEventListener('click', handleClick); host.addEventListener('input', handleInput); host.addEventListener('change', handleChange); host.addEventListener('submit', handleSubmit); host.addEventListener('focusin', handleFocusIn); host.addEventListener('focusout', handleFocusOut);
      host.addEventListener('compositionstart', handleCompositionStart); host.addEventListener('compositionend', handleCompositionEnd);
      host.addEventListener('keydown', handleKeydown); host.addEventListener('dragstart', handleDragStart); host.addEventListener('dragover', handleDragOver); host.addEventListener('drop', handleDrop); host.addEventListener('scroll', handleShelfScroll, true);
      state.unsubscribe = favorites?.subscribe?.((event = {}) => {
        if (state.destroyed || !state.active) return;
        if (event.structureChanged) {
          if (state.editor) { state.pendingRender = true; updateHistory(); return; }
          render(); return;
        }
        refreshChangedEntries(event.changedEntryIds || []); renderHealth(); updateHistory();
      }) || null;
    }
    function enter() { if (state.destroyed) return; bind(); state.active = true; host.hidden = false; state.prefs = readPreferences(); render(); }
    function refreshLocale() {
      if (!host || state.destroyed) return false;
      const dialogInput = host.querySelector('[data-favorite-dialog-input]'); const dialogStatus = host.querySelector('[data-favorite-dialog-status]');
      const dialogSnapshot = state.dialog ? { value: dialogInput?.value || '', status: dialogStatus?.textContent || '', focused: doc.activeElement === dialogInput } : null;
      const transferSnapshot = state.transferOpen ? {
        format: host.querySelector('[data-favorite-import-format]')?.value || 'lines', mode: host.querySelector('[data-favorite-import-mode]')?.value || 'append',
        kind: host.querySelector('[data-favorite-import-kind]')?.value || 'tag', seriesId: host.querySelector('[data-favorite-import-series]')?.value || '', sectionId: host.querySelector('[data-favorite-import-section]')?.value || '',
        text: host.querySelector('[data-favorite-import-text]')?.value || '', preview: host.querySelector('[data-favorite-import-preview]')?.textContent || ''
      } : null;
      host.replaceChildren(); delete host.dataset.favoritesReady; ensureShell(); render();
      const search = host.querySelector('[data-favorite-search]'); const scope = host.querySelector('[data-favorite-scope]'); const kind = host.querySelector('[data-favorite-kind]');
      if (search) search.value = state.query; if (scope) scope.value = state.scope; if (kind) kind.value = state.kind;
      renderFilters(); if (state.query) renderSearch(); if (state.editor) renderEditor();
      if (transferSnapshot) {
        host.querySelector('[data-favorite-transfer]').hidden = false;
        const format = host.querySelector('[data-favorite-import-format]'); const mode = host.querySelector('[data-favorite-import-mode]'); const kindControl = host.querySelector('[data-favorite-import-kind]'); const series = host.querySelector('[data-favorite-import-series]');
        if (format) format.value = transferSnapshot.format; if (mode) { mode.value = transferSnapshot.mode; mode.disabled = transferSnapshot.format !== 'json'; } if (kindControl) kindControl.value = transferSnapshot.kind; if (series) series.value = transferSnapshot.seriesId;
        renderImportSections(); const section = host.querySelector('[data-favorite-import-section]'); if (section) section.value = transferSnapshot.sectionId;
        host.querySelector('[data-favorite-import-text]').value = transferSnapshot.text; host.querySelector('[data-favorite-import-preview]').textContent = transferSnapshot.preview;
      }
      if (dialogSnapshot && state.dialog) {
        const dialog = host.querySelector('[data-favorite-dialog]'); const input = host.querySelector('[data-favorite-dialog-input]'); const status = host.querySelector('[data-favorite-dialog-status]');
        const title = typeof state.dialog.title === 'function' ? state.dialog.title() : state.dialog.titleText;
        dialog.querySelector('h3').textContent = title; input.value = dialogSnapshot.value; status.textContent = dialogSnapshot.status; dialog.hidden = false; if (dialogSnapshot.focused) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
      }
      return true;
    }
    async function leave() {
      const saved = await flushEdits(); if (!saved) return false;
      state.active = false; win.clearTimeout(state.searchTimer); state.searchTimer = null; state.renderToken += 1; cancelColumnLoading(); return true;
    }
    function cancelColumnLoading() {
      state.columnObserver?.disconnect?.(); state.columnObserver = null;
      if (state.scrollFrame != null) { win?.cancelAnimationFrame?.(state.scrollFrame); win?.clearTimeout?.(state.scrollFrame); state.scrollFrame = null; }
    }
    function destroy() {
      if (!host || state.destroyed) return;
      state.destroyed = true; state.active = false; win.clearTimeout(state.searchTimer); win.clearTimeout(state.saveTimer); state.searchTimer = state.saveTimer = null;
      host.removeEventListener('click', handleClick); host.removeEventListener('input', handleInput); host.removeEventListener('change', handleChange); host.removeEventListener('submit', handleSubmit); host.removeEventListener('focusin', handleFocusIn); host.removeEventListener('focusout', handleFocusOut);
      host.removeEventListener('compositionstart', handleCompositionStart); host.removeEventListener('compositionend', handleCompositionEnd);
      host.removeEventListener('keydown', handleKeydown); host.removeEventListener('dragstart', handleDragStart); host.removeEventListener('dragover', handleDragOver); host.removeEventListener('drop', handleDrop); host.removeEventListener('scroll', handleShelfScroll, true); cancelColumnLoading();
      try { state.unsubscribe?.(); } catch { /* optional subscription */ } state.unsubscribe = null;
    }

    return { bind, enter, leave, render, refreshLocale, syncSelection, openCreate, openEditor, focusEntry, setZoom, flushEdits, destroy };
  }

  return { createFavoritesView };
});
