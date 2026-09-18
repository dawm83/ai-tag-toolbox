'use strict';

(function installFavoritesView(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.AppViews = root.AppViews || {};
  root.AppViews.favorites = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function createFactory() {
  const SAVE_DELAY = 300;
  const COLUMN_BATCH = 120;
  const INITIAL_COLUMN_BATCH = 60;
  const INITIAL_COLUMNS = 4;
  const DEFAULT_VIEW = Object.freeze({ zoom: 120, columnWidth: 280, primary: 'raw', showSecondary: true, compact: false });

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
      seriesId: '', sectionId: '',
      recent: false, expanded: new Set(), bulk: new Set(), bulkSeries: new Set(), columnLimits: new Map(), loadedColumns: new Set(),
      prefs: readPreferences(), editor: null, saveTimer: null, transferOpen: false,
      quickEditor: null, contextTarget: null, draggedId: '', draggedStructure: null, returnFocus: null, dialog: null, editorSession: 0, columnObserver: null, scrollFrame: null, initializing: false
    };

    function label(key, fallback) { return string(localize(key, fallback), fallback); }
    function readPreferences() {
      let saved = {};
      try { saved = preferences?.get?.('favorites.view', {}) || {}; } catch { saved = {}; }
      return {
        zoom: saved.favoriteViewVersion ? number(saved.zoom, DEFAULT_VIEW.zoom, 75, 150) : saved.zoom === 100 ? 120 : number(saved.zoom, DEFAULT_VIEW.zoom, 75, 150),
        favoriteViewVersion: 2,
        columnWidth: number(saved.columnWidth, DEFAULT_VIEW.columnWidth, 220, 420),
        primary: ['raw', 'zh', 'title'].includes(saved.primary) ? saved.primary : DEFAULT_VIEW.primary,
        showSecondary: saved.showSecondary !== false,
        compact: saved.compact === true,
        activeSeriesId: typeof saved.activeSeriesId === 'string' ? saved.activeSeriesId : '',
        hiddenSectionsBySeries: Object.fromEntries(Object.entries(saved.hiddenSectionsBySeries || {}).filter(([, ids]) => Array.isArray(ids)).map(([id, ids]) => [id, unique(ids.map(String))]))
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

      const toolbar = el('div', 'favorites-toolbar favorites-toolbar-minimal');
      const zoomGroup = el('div', 'favorite-zoom-control');
      const zoom = control('input', 'favoriteZoom'); zoom.type = 'number'; zoom.min = '75'; zoom.max = '150'; zoom.step = '10'; zoom.setAttribute('aria-label', label('favorites.zoom', '缩放百分比'));
      zoomGroup.append(button('minus', label('favorites.zoomOut', '缩小'), 'zoom-out'), zoom, el('span', '', '%'), button('plus', label('favorites.zoomIn', '放大'), 'zoom-in'), button('locate-fixed', label('favorites.zoomReset', '重置缩放'), 'zoom-reset'));
      toolbar.append(zoomGroup);

      const anchors = el('nav', 'favorites-anchors'); anchors.dataset.favoriteAnchors = ''; anchors.setAttribute('aria-label', label('favorites.switchSeries', '切换收藏系列'));
      const seriesControls = el('div', 'favorites-series-controls'); seriesControls.dataset.favoriteSeriesControls = '';
      const subanchors = el('nav', 'favorites-subanchors'); subanchors.dataset.favoriteSubanchors = ''; subanchors.hidden = true;
      subanchors.setAttribute('aria-label', label('favorites.visibleSections', '显示子分类'));

      const bulkbar = el('div', 'favorites-bulkbar'); bulkbar.dataset.favoriteBulkbar = ''; bulkbar.hidden = true;
      const count = el('strong', 'favorites-bulk-count', '0'); count.dataset.favoriteBulkCount = '';
      const move = control('select', 'favoriteBulkMove'); move.setAttribute('aria-label', label('favorites.moveTo', '移动到系列'));
      bulkbar.append(el('span', '', label('favorites.selected', '已选')), count,
        actionTextButton('visible', label('favorites.selectVisible', '选择当前显示')),
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
      scroll.append(shelf); body.append(scroll, createEditor(), createQuickEditor(), createTransferPanel());
      host.append(anchors, seriesControls, toolbar, subanchors, health, body, createContextMenu(), createDialog());
      applyPreferences();
    }

    function createQuickEditor() {
      const panel = el('aside', 'favorite-quick-editor'); panel.dataset.favoriteQuickEditor = ''; panel.hidden = true;
      const head = el('div', 'favorite-editor-head'); head.append(el('h3', '', label('favorites.quickCreate', '新增标签')), button('x', label('favorites.closeEditor', '关闭'), 'quick-close'));
      const raw = el('input'); raw.type = 'text'; raw.dataset.favoriteQuickRaw = ''; raw.placeholder = label('favorites.rawText', 'Tag 原文');
      const title = el('input'); title.type = 'text'; title.dataset.favoriteQuickTitle = ''; title.placeholder = label('favorites.entryTitle', '名称或中文');
      const note = el('textarea'); note.dataset.favoriteQuickNote = ''; note.placeholder = label('favorites.noteOptional', '备注（可选）');
      const actions = el('div', 'favorite-editor-actions'); actions.append(actionTextButton('quick-cancel', label('favorites.cancel', '取消')), actionTextButton('quick-save', label('favorites.save', '保存'), 'primary'));
      panel.append(head, raw, title, note, actions); return panel;
    }
    function createContextMenu() {
      const menu = el('div', 'favorite-context-menu'); menu.dataset.favoriteContextMenu = ''; menu.hidden = true;
      menu.append(actionTextButton('context-rename', label('favorites.rename', '重命名')), actionTextButton('context-edit', label('favorites.edit', '编辑')), actionTextButton('context-delete', label('favorites.delete', '删除'), 'danger'));
      const color = el('input', 'favorite-context-color'); color.type = 'color'; color.dataset.favoriteContextColor = ''; color.title = label('favorites.seriesColor', '颜色'); color.setAttribute('aria-label', color.title); menu.append(color);
      return menu;
    }
    function openQuickEditor(seriesId, sectionId) {
      state.quickEditor = { seriesId, sectionId };
      const panel = host.querySelector('[data-favorite-quick-editor]'); if (!panel) return false;
      panel.hidden = false; panel.querySelector('[data-favorite-quick-raw]').value = ''; panel.querySelector('[data-favorite-quick-title]').value = ''; panel.querySelector('[data-favorite-quick-note]').value = '';
      panel.querySelector('[data-favorite-quick-raw]').focus(); return true;
    }
    function closeQuickEditor() { state.quickEditor = null; const panel = host.querySelector('[data-favorite-quick-editor]'); if (panel) panel.hidden = true; }
    async function saveQuickEditor() {
      const panel = host.querySelector('[data-favorite-quick-editor]'); const draft = state.quickEditor; if (!panel || !draft) return false;
      const rawText = string(panel.querySelector('[data-favorite-quick-raw]')?.value).trim();
      if (!rawText) { notify(label('favorites.rawRequired', '原文不能为空')); panel.querySelector('[data-favorite-quick-raw]')?.focus(); return false; }
      const result = safeCall('saveEntry', { kind: 'tag', seriesId: draft.seriesId, sectionId: draft.sectionId === 'root' ? null : draft.sectionId, title: string(panel.querySelector('[data-favorite-quick-title]')?.value).trim(), rawText, zh: string(panel.querySelector('[data-favorite-quick-title]')?.value).trim(), note: string(panel.querySelector('[data-favorite-quick-note]')?.value) });
      if (!result?.ok) { notify(result?.error?.message || label('favorites.saveFailed', '保存失败')); return false; }
      await safeCall('flush'); closeQuickEditor(); render(); return true;
    }
    function openContextMenu(kind, id, event) {
      const menu = host.querySelector('[data-favorite-context-menu]'); if (!menu) return;
      state.contextTarget = { kind, id, seriesId: event.currentTarget?.dataset?.seriesId || state.seriesId };
      menu.style.left = `${Math.max(4, event.clientX || 0)}px`; menu.style.top = `${Math.max(4, event.clientY || 0)}px`; menu.hidden = false;
      const color = menu.querySelector('[data-favorite-context-color]');
      const row = kind === 'series' ? seriesRows().find(item => item.id === id) : sectionRows(state.seriesId).find(item => item.id === id);
      if (color) color.value = row?.color || '#287EA4';
    }
    function closeContextMenu() { state.contextTarget = null; host.querySelector('[data-favorite-context-menu]')?.setAttribute('hidden', ''); }
    function contextRename() {
      const target = state.contextTarget; if (!target) return false;
      const row = target.kind === 'series' ? seriesRows().find(item => item.id === target.id) : sectionRows(target.seriesId).find(item => item.id === target.id); if (!row) return false;
      closeContextMenu(); return openNameDialog(() => label('favorites.namePrompt', '输入名称'), row.name, name => safeCall(target.kind === 'series' ? 'saveSeries' : 'saveSection', target.kind === 'series' ? { id: row.id, name } : { id: row.id, seriesId: row.seriesId, name }), doc.activeElement);
    }
    async function contextDelete() {
      const target = state.contextTarget; if (!target) return false; closeContextMenu();
      if (typeof win?.confirm === 'function' && !win.confirm(label(target.kind === 'series' ? 'favorites.confirmDeleteSeries' : 'favorites.confirmDeleteSection', '确定删除吗？'))) return false;
      if (!await finishEditorBeforeMutation()) return false;
      const result = target.kind === 'series' ? safeCall('deleteSeries', target.id, { mode: 'delete' }) : safeCall('deleteSection', target.id);
      if (result?.ok) { if (target.id === state.seriesId) state.seriesId = ''; render(); } else notify(result?.error?.message || label('favorites.operationFailed', '操作失败')); return Boolean(result?.ok);
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
      ensureWorkspace();
      const rows = seriesRows();
      if (!rows.some(row => row.id === state.seriesId)) state.seriesId = rows.find(row => row.id === state.prefs.activeSeriesId)?.id || rows[0]?.id || '';
      const sections = sectionRows(state.seriesId);
      if (!sections.some(row => row.id === state.sectionId)) state.sectionId = sections[0]?.id || '';
      renderFilters(); renderAnchors(); renderSeriesControls(); renderSubanchors(); renderHealth(); renderShelf();
      updateBulkbar(); updateHistory(); applyPreferences();
      host.querySelector('[data-favorite-recent]')?.classList.toggle('is-active', state.recent);
    }
    function ensureWorkspace() {
      if (state.initializing) return;
      const snapshot = safeCall('snapshot'); if (snapshot?.loadError) return;
      let rows = seriesRows();
      if (!rows.length) {
        state.initializing = true;
        const created = safeCall('saveSeries', { name: label('favorites.newPage', '新建收藏页') });
        state.initializing = false; rows = seriesRows();
        if (created?.ok) { state.seriesId = created.data.id; savePreferences({ activeSeriesId: state.seriesId }); }
      }
      const active = rows.find(row => row.id === state.seriesId) || rows.find(row => row.id === state.prefs.activeSeriesId) || rows[0];
      if (!active) return;
      if (!sectionRows(active.id).length) {
        state.initializing = true;
        const created = safeCall('saveSection', { seriesId: active.id, name: label('favorites.newSectionTab', '新建标签栏') });
        state.initializing = false; if (created?.ok) state.sectionId = created.data.id;
      }
    }
    function renderFilters() {
      const rows = seriesRows();
      const controls = [host.querySelector('[data-favorite-bulk-move]'), host.querySelector('[data-favorite-import-series]')];
      controls.forEach((select, index) => {
        if (!select) return;
        const previous = select.value;
        select.replaceChildren();
        if (index === 0) select.append(optionNode('', label('favorites.chooseTarget', '目标系列')));
        rows.forEach(row => select.append(optionNode(row.id, string(row.name, row.id))));
        if ([...select.options].some(item => item.value === previous)) select.value = previous;
      });
    }
    function renderAnchors() {
      const anchors = host.querySelector('[data-favorite-anchors]'); if (!anchors) return;
      anchors.replaceChildren();
      seriesRows().forEach(row => {
        const tab = el('span', 'favorite-series-tab'); tab.style.setProperty('--favorite-accent', string(row.color, 'var(--pri)'));
        tab.dataset.favoriteSeriesTab = row.id; tab.dataset.seriesId = row.id; tab.draggable = true;
        const item = actionTextButton('select-series', string(row.name, row.id)); item.dataset.seriesId = row.id;
        item.classList.toggle('is-active', row.id === state.seriesId); tab.classList.toggle('is-active', row.id === state.seriesId); item.setAttribute('aria-pressed', String(row.id === state.seriesId));
        tab.append(item); anchors.append(tab);
      });
      anchors.append(button('plus', label('favorites.newSeries', '新建收藏页'), 'new-series-tab'));
    }
    function renderSeriesControls() {
      const hostControls = host.querySelector('[data-favorite-series-controls]'); hostControls.replaceChildren();
      const series = seriesRows().find(row => row.id === state.seriesId); hostControls.hidden = !series; if (!series) return;
      hostControls.style.setProperty('--favorite-accent', string(series.color, 'var(--pri)'));
      const title = el('h3', '', string(series.name, series.id));
      const rename = button('pencil', label('favorites.renameSeries', '重命名系列'), 'rename-series'); rename.dataset.seriesId = series.id;
      const color = el('input', 'favorite-color-input'); color.type = 'color'; color.value = series.color || '#5e6ad2'; color.dataset.favoriteSeriesColor = series.id;
      color.title = label('favorites.seriesColor', '系列颜色'); color.setAttribute('aria-label', color.title);
      const menu = el('details', 'favorite-series-menu'); const summary = el('summary', '', '⋯'); summary.title = label('favorites.seriesActions', '系列操作'); summary.setAttribute('aria-label', summary.title);
      const menuBody = el('div', 'favorite-series-menu-body');
      const actions = [
        ['palette', 'favorites.autoColor', '自动配色', 'auto-color'],
        ['arrow-up', 'favorites.moveSeriesUp', '系列左移', 'move-series-up'],
        ['arrow-down', 'favorites.moveSeriesDown', '系列右移', 'move-series-down'],
        ['trash-2', 'favorites.deleteSeries', '删除系列', 'delete-series'],
        ['x', 'favorites.deleteSeriesAll', '删除系列及内容', 'delete-series-all']
      ];
      actions.forEach(([icon, key, fallback, action]) => { const item = button(icon, label(key, fallback), action); item.dataset.seriesId = series.id; menuBody.append(item); });
      menu.append(summary, menuBody); hostControls.append(title, rename, color, menu);
    }
    function columnKey(seriesId, sectionId) { return JSON.stringify([seriesId, sectionId || 'root']); }
    function columnsFor(seriesId) {
      const rows = sectionRows(seriesId);
      const rootCount = safeCall('list', { seriesId, sectionId: null, includeAdult: true, limit: 1, view: 'shelf' })?.total || 0;
      return rootCount || !rows.length ? [{ id: 'root', name: label('favorites.unfiled', '未分类') }, ...rows] : rows;
    }
    function hiddenSections(seriesId = state.seriesId) { return new Set(state.prefs.hiddenSectionsBySeries[seriesId] || []); }
    function saveHiddenSections(ids, seriesId = state.seriesId) {
      savePreferences({ hiddenSectionsBySeries: { ...state.prefs.hiddenSectionsBySeries, [seriesId]: [...ids] } });
    }
    async function selectSeries(id) {
      if (id === state.seriesId) return true;
      if (!seriesRows().some(row => row.id === id) || !await finishEditorBeforeMutation()) return false;
      state.seriesId = id; state.sectionId = ''; state.bulk.clear(); state.recent = false; savePreferences({ activeSeriesId: id }); render();
      const scroll = host.querySelector('[data-favorite-scroll]'); scroll.scrollTop = 0; scroll.scrollLeft = 0;
      host.querySelector('[data-favorite-action="select-series"][data-series-id="' + cssEscape(id) + '"]')?.focus(); return true;
    }
    async function setSectionVisibility(sectionId, visible) {
      if (!await finishEditorBeforeMutation()) { renderSubanchors(); return false; }
      const hidden = hiddenSections(); visible ? hidden.delete(sectionId) : hidden.add(sectionId);
      saveHiddenSections(hidden); state.bulk.clear(); renderSubanchors(); renderShelf(); updateBulkbar(); return true;
    }
    async function toggleAllSections() {
      if (!await finishEditorBeforeMutation()) return false;
      const ids = columnsFor(state.seriesId).map(row => row.id); const hidden = hiddenSections();
      const allVisible = ids.every(id => !hidden.has(id));
      saveHiddenSections(allVisible ? ids : []); state.bulk.clear(); renderSubanchors(); renderShelf(); updateBulkbar(); return true;
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
      state.columnObserver?.disconnect?.(); state.columnObserver = null; shelf.replaceChildren();
      const series = seriesRows().find(row => row.id === state.seriesId);
      if (!series) { shelf.append(el('p', 'favorites-empty', label('favorites.empty', '还没有收藏系列'))); return; }
      const content = el('section', 'favorite-series'); content.dataset.favoriteSeries = series.id;
      content.style.setProperty('--favorite-accent', string(series.color, 'var(--pri)')); content.setAttribute('aria-label', series.name);
      const selected = allSelectedIds(); const columns = columnsFor(series.id);
      columns.forEach(section => content.append(renderColumn(series, section, selected, false)));
      if (!columns.length) content.append(el('p', 'favorites-empty', label('favorites.emptySection', '此收藏页暂无标签栏')));
      shelf.append(content); setupColumnLoading();
    }
    function renderColumn(series, section, selected, lazy = false) {
      const id = section.id === 'root' ? null : section.id;
      const limit = state.columnLimits.get(columnKey(series.id, section.id)) || INITIAL_COLUMN_BATCH;
      const rows = state.recent
        ? safeCall('list', { seriesId: series.id, sectionId: id, includeAdult: includeAdult(), limit: 20, view: 'recent' })
        : readEntries(series.id, id, lazy ? 1 : limit);
      const group = renderSection(series, section, lazy ? { ...rows, items: [], hasMore: false } : rows, selected);
      if (lazy) {
        group.dataset.favoriteLazySection = section.id;
        const placeholder = actionTextButton('load-section', label('favorites.loadSection', '加载子分类内容')); placeholder.dataset.seriesId = series.id; placeholder.dataset.sectionId = section.id; group.append(placeholder);
      }
      if (!includeAdult()) {
        const total = safeCall('list', { seriesId: series.id, sectionId: id, includeAdult: true, limit: 1, view: state.recent ? 'recent' : 'shelf' })?.total || 0;
        if (total > rows.total) group.append(el('p', 'favorite-adult-hidden', label('favorites.adultHidden', '已隐藏成人内容') + '：' + (total - rows.total)));
      }
      return group;
    }
    function renderQuickBlank(series, section) {
      const blank = el('button', 'favorite-quick-new', label('favorites.clickToAdd', '点击新增标签')); blank.type = 'button';
      blank.dataset.favoriteQuickNew = ''; blank.dataset.sectionId = section.id; blank.dataset.seriesId = series.id;
      return blank;
    }
    function setupColumnLoading() {
      state.columnObserver?.disconnect?.(); state.columnObserver = null;
      const lazy = [...host.querySelectorAll('[data-favorite-lazy-section]')]; if (!lazy.length || !state.active) return;
      if (typeof win?.IntersectionObserver === 'function') {
        const scroll = host.querySelector('[data-favorite-scroll]');
        state.columnObserver = new win.IntersectionObserver(entries => entries.forEach(entry => { if (entry.isIntersecting) hydrateSection(entry.target.dataset.seriesId, entry.target.dataset.favoriteLazySection); }), { root: scroll, rootMargin: '0px 560px' });
        lazy.forEach(node => state.columnObserver.observe(node));
      }
    }
    function hydrateSection(seriesId, sectionId) {
      const node = host.querySelector('[data-favorite-lazy-section="' + cssEscape(sectionId) + '"][data-series-id="' + cssEscape(seriesId) + '"]'); if (!node) return false;
      const series = seriesRows().find(row => row.id === seriesId); const section = columnsFor(seriesId).find(row => row.id === sectionId); if (!series || !section) return false;
      state.loadedColumns.add(columnKey(seriesId, sectionId)); state.columnObserver?.unobserve?.(node); node.replaceWith(renderColumn(series, section, allSelectedIds())); return true;
    }
    function handleShelfScroll() {
      if (state.scrollFrame != null) return;
      const request = win?.requestAnimationFrame || (callback => win.setTimeout(callback, 16));
      state.scrollFrame = request(() => {
        state.scrollFrame = null; const scroll = host.querySelector('[data-favorite-scroll]'); if (!scroll) return;
        const viewport = scroll.getBoundingClientRect();
        [...host.querySelectorAll('[data-favorite-lazy-section]')].forEach(node => { const rect = node.getBoundingClientRect(); if (rect.left < viewport.right + 560 && rect.right > viewport.left - 560) hydrateSection(node.dataset.seriesId, node.dataset.favoriteLazySection); });
      });
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
      const group = el('section', 'favorite-section'); group.dataset.favoriteSection = section.id; group.dataset.seriesId = series.id; group.style.setProperty('--favorite-accent', string(section.color, '#287EA4'));
      const head = el('div', 'favorite-section-head'); head.dataset.favoriteSectionHead = section.id; head.dataset.seriesId = series.id; head.draggable = true;
      const title = el('button', 'favorite-section-title', string(section.name, section.id)); title.type = 'button'; title.dataset.favoriteAction = 'select-section'; title.dataset.sectionId = section.id; title.dataset.seriesId = series.id;
      const color = el('input', 'favorite-section-color'); color.type = 'color'; color.value = /^#[0-9a-f]{6}$/i.test(section.color || '') ? section.color : '#287EA4'; color.dataset.favoriteSectionColor = section.id; color.dataset.seriesId = series.id; color.title = label('favorites.sectionColor', '标签栏颜色'); color.setAttribute('aria-label', color.title);
      head.append(title, el('span', 'favorite-section-count', rows.total), color);
      if (section.id !== 'root') {
        const menu = el('details', 'favorite-series-menu'); const summary = el('summary', '', '⋯'); summary.title = label('favorites.sectionActions', '子分类操作'); summary.setAttribute('aria-label', summary.title);
        const menuBody = el('div', 'favorite-series-menu-body');
        const actions = [
          ['arrow-up', 'favorites.moveSectionUp', '子分类左移', 'move-section-up'],
          ['arrow-down', 'favorites.moveSectionDown', '子分类右移', 'move-section-down'],
          ['pencil', 'favorites.renameSection', '重命名子分类', 'rename-section'],
          ['trash-2', 'favorites.deleteSection', '删除子分类', 'delete-section']
        ];
        actions.forEach(([icon, key, fallback, action]) => { const item = button(icon, label(key, fallback), action); item.dataset.seriesId = series.id; item.dataset.sectionId = section.id; menuBody.append(item); });
        menu.append(summary, menuBody); head.append(menu);
      }
      group.append(head);
      const list = el('div', 'favorite-entry-list'); rows.items.forEach(entry => list.append(renderEntry(entry, selected.has(entry.id)))); list.append(renderQuickBlank(series, section)); group.append(list);
      if (rows.hasMore) { const more = actionTextButton('load-column', label('favorites.loadMore', '加载更多')); more.dataset.seriesId = series.id; more.dataset.sectionId = section.id; group.append(more); }
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
      if (entry.note) item.append(el('span', 'favorite-note-popover', entry.note));
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

    function updateBulkbar() {
      const bar = host?.querySelector('[data-favorite-bulkbar]'); const count = host?.querySelector('[data-favorite-bulk-count]');
      if (!bar) return; bar.hidden = !state.bulk.size && !host.querySelector('[data-favorite-bulk-toggle]')?.classList.contains('is-active');
      host.classList.toggle('is-bulk', !bar.hidden);
      if (count) count.textContent = String(state.bulk.size);
      host.querySelectorAll('[data-favorite-manage]').forEach(node => { node.checked = state.bulk.has(node.dataset.favoriteManage); });
    }
    function syncSelection() {
      if (!host) return;
      const selected = allSelectedIds();
      host.querySelectorAll('[data-favorite-select]').forEach(node => {
        const id = node.dataset.favoriteSelect; const active = selected.has(id); node.setAttribute('aria-pressed', String(active));
        node.closest('[data-favorite-entry]')?.classList.toggle('is-selected', active);
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
      return [...host.querySelectorAll('[data-favorite-entry]')].map(node => node.dataset.favoriteEntry);
    }
    async function openCreate(value = {}) {
      ensureShell();
      const order = currentVisibleIds();
      if (state.editor && !await flushEdits()) return false;
      const firstSeries = value.seriesId || state.seriesId || seriesRows()[0]?.id || '';
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
      if (copied) { safeCall('markCopied', [id]); notify(label('favorites.copied', '已复制')); } else notify(label('favorites.copyFailed', '复制失败，请检查剪贴板权限'));
      return copied;
    }
    function cssEscape(value) { return win?.CSS?.escape ? win.CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); }

    async function focusEntry(entryId) {
      const entry = safeCall('getEntry', entryId); if (!entry || (entry.nsfw && !includeAdult())) return false;
      if (!await finishEditorBeforeMutation()) return false;
      state.seriesId = entry.seriesId; state.recent = false; state.bulk.clear(); savePreferences({ activeSeriesId: entry.seriesId });
      const sectionId = entry.sectionId || 'root'; const hidden = hiddenSections(); hidden.delete(sectionId); saveHiddenSections(hidden);
      const key = columnKey(entry.seriesId, sectionId); state.loadedColumns.add(key);
      // Load only as far as the target's page, without expanding unrelated columns.
      const siblings = readEntries(entry.seriesId, entry.sectionId, Number.MAX_SAFE_INTEGER).items;
      const index = siblings.findIndex(row => row.id === entryId);
      state.columnLimits.set(key, Math.max(state.columnLimits.get(key) || INITIAL_COLUMN_BATCH, Math.ceil((index + 1) / COLUMN_BATCH) * COLUMN_BATCH));
      render();
      const target = host.querySelector('[data-favorite-entry="' + cssEscape(entryId) + '"]');
      target?.scrollIntoView?.({ behavior: 'smooth', block: 'center', inline: 'center' }); target?.classList.add('is-located'); target?.querySelector('[data-favorite-select]')?.focus();
      if (target) win?.setTimeout?.(() => target.classList.remove('is-located'), 1200); return Boolean(target);
    }
    function setZoom(value) { const zoom = Math.round(number(value, state.prefs.zoom, 75, 150)); savePreferences({ zoom }); return zoom; }

    async function applyBulk(action) {
      const ids = [...state.bulk]; if (!ids.length && action !== 'visible') return;
      let result;
      if (action === 'visible') {
        const visible = currentVisibleIds();
        visible.forEach(id => state.bulk.add(id)); updateBulkbar(); return;
      }
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
      let offset = 0, hasMore = true;
      while (hasMore) {
        const result = safeCall('list', { includeAdult: true, offset, limit: 500, view: 'shelf' }); const rows = Array.isArray(result?.items) ? result.items : [];
        order.push(...rows.map(row => row.id).filter(id => chosen.has(id))); offset += rows.length; hasMore = Boolean(result?.hasMore) && rows.length > 0;
      }
      return order;
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
      const fresh = !state.transferOpen && !host.querySelector('[data-favorite-import-text]')?.value;
      state.transferOpen = true;
      renderFilters();
      if (fresh) { host.querySelector('[data-favorite-import-series]').value = state.seriesId; invalidateImportPreview(); }
      renderImportSections();
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
      if (action === 'new-series-tab') {
        if (!await finishEditorBeforeMutation()) return false;
        const result = safeCall('saveSeries', { name: `${label('favorites.newPage', '新建收藏页')} ${seriesRows().length + 1}` });
        if (result?.ok) { state.seriesId = result.data.id; state.sectionId = ''; savePreferences({ activeSeriesId: state.seriesId }); render(); }
        return Boolean(result?.ok);
      }
      if (action === 'new-section-tab') {
        if (!await finishEditorBeforeMutation()) return false;
        const seriesId = target.dataset.seriesId || state.seriesId; const result = safeCall('saveSection', { seriesId, name: `${label('favorites.newSectionTab', '新建标签栏')} ${sectionRows(seriesId).length + 1}` });
        if (result?.ok) { state.seriesId = seriesId; state.sectionId = result.data.id; render(); }
        return Boolean(result?.ok);
      }
      if (action === 'new-series') {
        if (state.editor && !await finishEditorBeforeMutation()) return false;
        return openNameDialog(() => label('favorites.seriesName', '系列名称'), '', name => {
          const result = safeCall('saveSeries', { name });
          if (result?.ok) { state.seriesId = result.data.id; state.bulk.clear(); state.recent = false; savePreferences({ activeSeriesId: state.seriesId }); }
          return result;
        }, target);
      }
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
      const target = event.target.closest?.('[data-favorite-action], [data-favorite-copy], [data-favorite-edit], [data-favorite-expand], [data-favorite-select], [data-favorite-locate], [data-favorite-quick-new]'); if (!target || !host.contains(target)) return;
      if (target.dataset.favoriteCopy) return void copyEntry(target.dataset.favoriteCopy, false);
      if (target.dataset.favoriteEdit) return void openEditor(target.dataset.favoriteEdit);
      if (target.dataset.favoriteExpand) { const id = target.dataset.favoriteExpand; state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id); render(); return; }
      if (target.dataset.favoriteSelect) return void copyEntry(target.dataset.favoriteSelect, true);
      if (target.dataset.favoriteLocate) return void focusEntry(target.dataset.favoriteLocate);
      const action = target.dataset.favoriteAction;
      if (Object.prototype.hasOwnProperty.call(target.dataset, 'favoriteQuickNew')) return void openQuickEditor(target.dataset.seriesId, target.dataset.sectionId);
      if (action === 'quick-close' || action === 'quick-cancel') { closeQuickEditor(); return; }
      if (action === 'quick-save') return void saveQuickEditor();
      if (action === 'context-rename') return void contextRename();
      if (action === 'context-delete') return void contextDelete();
      if (action === 'context-edit') { const targetContext = state.contextTarget; closeContextMenu(); if (targetContext?.kind === 'series') return void structureAction('rename-series', { dataset: { seriesId: targetContext.id } }); return; }
      if (action === 'dialog-cancel') { closeNameDialog(); return; }
      if (action === 'dialog-confirm') { submitNameDialog(); return; }
      if (action === 'new-series-tab') return void structureAction('new-series-tab', target);
      if (action === 'new-section-tab') return void structureAction('new-section-tab', target);
      if (action === 'select-section') { state.sectionId = target.dataset.sectionId; renderSubanchors(); renderShelf(); host.querySelector(`[data-favorite-section="${cssEscape(state.sectionId)}"]`)?.scrollIntoView?.({ behavior: 'smooth', inline: 'center' }); return; }
      if (['new-series', 'rename-series', 'new-section', 'rename-section', 'delete-section', 'delete-series', 'delete-series-all'].includes(action)) return void structureAction(action, target);
      if (action === 'new-tag') return void openCreate({ kind: 'tag', seriesId: target.dataset.seriesId || state.seriesId, sectionId: target.dataset.sectionId === 'root' ? null : target.dataset.sectionId });
      if (action === 'new-bundle') return void openCreate({ kind: 'bundle', seriesId: state.seriesId || undefined });
      if (action === 'undo' || action === 'redo') { if (!await finishEditorBeforeMutation()) return; safeCall(action); render(); return; }
      if (action === 'recent') { state.recent = !state.recent; target.classList.toggle('is-active', state.recent); renderShelf(); return; }
      if (action === 'bulk') { target.classList.toggle('is-active'); if (!target.classList.contains('is-active')) { state.bulk.clear(); state.bulkSeries.clear(); renderAnchors(); } updateBulkbar(); return; }
      if (action === 'zoom-out') return void setZoom(state.prefs.zoom - 10);
      if (action === 'zoom-in') return void setZoom(state.prefs.zoom + 10);
      if (action === 'zoom-reset') return void setZoom(100);
      if (action === 'select-series') return void selectSeries(target.dataset.seriesId);
      if (action === 'toggle-all-sections') return void toggleAllSections();
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
      if (action === 'load-section') return void hydrateSection(target.dataset.seriesId, target.dataset.sectionId);
      if (action === 'load-column') {
        const key = columnKey(target.dataset.seriesId, target.dataset.sectionId); state.columnLimits.set(key, (state.columnLimits.get(key) || INITIAL_COLUMN_BATCH) + COLUMN_BATCH);
        const node = target.closest('[data-favorite-section]'); const series = seriesRows().find(row => row.id === target.dataset.seriesId); const section = columnsFor(series.id).find(row => row.id === target.dataset.sectionId);
        if (node && series && section) node.replaceWith(renderColumn(series, section, allSelectedIds())); return;
      }
      if (action === 'auto-color') { safeCall('setSeriesColors', state.bulkSeries.size ? [...state.bulkSeries] : [target.dataset.seriesId], { mode: 'auto' }); render(); return; }
      if (action === 'open-import') return void openImport();
      if (action === 'close-import') { host.querySelector('[data-favorite-transfer]').hidden = true; state.transferOpen = false; return; }
      if (action === 'choose-json-file') { host.querySelector('[data-favorite-import-file]')?.click(); return; }
      if (action === 'preview-import') return void previewImport();
      if (action === 'confirm-import') return void confirmImport();
      if (action === 'export') return void exportFavorites();
      if (['visible', 'copy-selected', 'clear-bulk', 'pin-selected', 'unpin-selected', 'searchable-on', 'searchable-off', 'duplicate-selected', 'delete-selected'].includes(action)) return void applyBulk(action);
    }
    function handleSubmit(event) {
      if (!event.target.matches('[data-favorite-dialog-form]')) return;
      event.preventDefault(); submitNameDialog();
    }
    function renderSubanchors() {
      const nav = host.querySelector('[data-favorite-subanchors]'); nav.replaceChildren(); nav.hidden = !state.seriesId; if (!state.seriesId) return;
      const rows = columnsFor(state.seriesId);
      rows.forEach(row => {
        const item = actionTextButton('select-section', string(row.name, row.id)); item.dataset.sectionId = row.id; item.dataset.seriesId = state.seriesId; item.dataset.favoriteSectionTab = row.id; item.draggable = true; item.classList.toggle('is-active', row.id === state.sectionId); item.style.setProperty('--favorite-accent', string(row.color, '#287EA4')); nav.append(item);
      });
      const plus = button('plus', label('favorites.newSection', '新建标签栏'), 'new-section-tab'); plus.dataset.seriesId = state.seriesId; nav.append(plus);
    }
    function handleInput(event) {
      if (event.target.matches('[data-favorite-import-text]')) { invalidateImportPreview(); return; }
      if (event.target.matches('[data-favorite-field]')) { readDraftFromFields(event.target); scheduleSave(); }
    }
    function handleContextMenu(event) {
      const series = event.target.closest?.('[data-favorite-series-tab]'); const section = event.target.closest?.('[data-favorite-section-tab], [data-favorite-section-head]');
      if (!series && !section) return;
      event.preventDefault(); openContextMenu(series ? 'series' : 'section', series?.dataset.seriesId || section?.dataset.sectionId || section?.dataset.favoriteSectionHead, event);
    }
    function handleChange(event) {
      const target = event.target;
      if (target.matches('[data-favorite-section-color]')) { safeCall('saveSection', { id: target.dataset.favoriteSectionColor, seriesId: target.dataset.seriesId, name: sectionRows(target.dataset.seriesId).find(row => row.id === target.dataset.favoriteSectionColor)?.name || '', color: target.value }); render(); return; }
      if (target.matches('[data-favorite-context-color]')) {
        const context = state.contextTarget; if (!context) return;
        if (context.kind === 'series') safeCall('setSeriesColors', [context.id], { mode: 'custom', color: target.value });
        else { const row = sectionRows(context.seriesId).find(item => item.id === context.id); if (row) safeCall('saveSection', { id: row.id, seriesId: row.seriesId, name: row.name, color: target.value }); }
        closeContextMenu(); render(); return;
      }
      if (target.matches('[data-favorite-import-file]')) { void readImportFile(target); return; }
      if (target.matches('[data-favorite-inline-field]')) { void saveInlineField(target); return; }
      if (target.matches('[data-favorite-import-series]')) { renderImportSections(); invalidateImportPreview(); return; }
      if (target.matches('[data-favorite-import-format]')) { const json = target.value === 'json'; const mode = host.querySelector('[data-favorite-import-mode]'); const kind = host.querySelector('[data-favorite-import-kind]'); const section = host.querySelector('[data-favorite-import-section]'); if (mode) mode.disabled = !json; if (kind) kind.disabled = json; if (section) section.disabled = json; invalidateImportPreview(); return; }
      if (target.matches('[data-favorite-import-kind], [data-favorite-import-section], [data-favorite-import-mode]')) { invalidateImportPreview(); return; }
      if (target.matches('[data-favorite-manage]')) { target.checked ? state.bulk.add(target.dataset.favoriteManage) : state.bulk.delete(target.dataset.favoriteManage); updateBulkbar(); return; }
      if (target.matches('[data-favorite-series-manage]')) { target.checked ? state.bulkSeries.add(target.dataset.favoriteSeriesManage) : state.bulkSeries.delete(target.dataset.favoriteSeriesManage); return; }
      if (target.matches('[data-favorite-column-width]')) { savePreferences({ columnWidth: number(target.value, DEFAULT_VIEW.columnWidth, 220, 420) }); return; }
      if (target.matches('[data-favorite-zoom]')) { setZoom(target.value); return; }
      if (target.matches('[data-favorite-primary]')) { savePreferences({ primary: target.value }); renderShelf(); return; }
      if (target.matches('[data-favorite-secondary]')) { savePreferences({ showSecondary: target.checked }); renderShelf(); return; }
      if (target.matches('[data-favorite-compact]')) { savePreferences({ compact: target.checked }); return; }
      if (target.matches('[data-favorite-series-color]')) { safeCall('setSeriesColors', [target.dataset.favoriteSeriesColor], { mode: 'custom', color: target.value }); render(); return; }
      if (target.matches('[data-favorite-bulk-move]') && target.value) { applyBulk('move-selected'); return; }
      if (target.matches('[data-favorite-field="seriesId"]')) { readDraftFromFields(target); editorSeriesOptions(target.value, null); readDraftFromFields(host.querySelector('[data-favorite-field="sectionId"]')); scheduleSave(); }
    }
    function handleCompositionStart(event) { if (event.target.matches('[data-favorite-field]')) { state.composing = true; win.clearTimeout(state.saveTimer); state.saveTimer = null; } }
    function handleCompositionEnd(event) { if (event.target.matches('[data-favorite-field]')) { state.composing = false; readDraftFromFields(event.target); scheduleSave(); } }
    function handleFocusOut(event) { if (event.target.matches?.('[data-favorite-field]') && !event.relatedTarget?.matches?.('[data-favorite-field]')) endEditorTransaction(); }
    async function handleKeydown(event) {
      if (!state.active || state.destroyed) return;
      if (state.dialog && event.key === 'Enter' && event.target.matches?.('[data-favorite-dialog-input]')) { event.preventDefault(); submitNameDialog(); return; }
      const editable = event.target.matches?.('input, textarea, select, [contenteditable="true"]');
      if (event.key === 'Escape') { if (state.dialog) { event.preventDefault(); closeNameDialog(); } else if (state.transferOpen) { event.preventDefault(); host.querySelector('[data-favorite-transfer]').hidden = true; state.transferOpen = false; } else if (state.editor) { event.preventDefault(); discardEditor(); } return; }
      if (event.key === 'F2') { const entry = event.target.closest?.('[data-favorite-entry]'); if (entry) { event.preventDefault(); openEditor(entry.dataset.favoriteEntry); } return; }
      if ((event.ctrlKey || event.metaKey) && !editable && event.key.toLowerCase() === 'c' && !win.getSelection?.()?.toString()) { const entry = event.target.closest?.('[data-favorite-entry]'); if (entry) { event.preventDefault(); copyEntry(entry.dataset.favoriteEntry, false); } }
      if ((event.ctrlKey || event.metaKey) && !editable && event.key.toLowerCase() === 'z') { event.preventDefault(); if (await finishEditorBeforeMutation()) { safeCall(event.shiftKey ? 'redo' : 'undo'); render(); } }
      if ((event.ctrlKey || event.metaKey) && !editable && event.key.toLowerCase() === 'y') { event.preventDefault(); if (await finishEditorBeforeMutation()) { safeCall('redo'); render(); } }
    }
    function handleDragStart(event) {
      const entry = event.target.closest?.('[data-favorite-entry]');
      const section = event.target.closest?.('[data-favorite-section-head], [data-favorite-section-tab]');
      const series = event.target.closest?.('[data-favorite-series-tab]');
      if (section) state.draggedStructure = { kind: 'section', id: section.dataset.sectionId || section.dataset.favoriteSectionHead, seriesId: section.dataset.seriesId };
      else if (series) state.draggedStructure = { kind: 'series', id: series.dataset.seriesId };
      else state.draggedId = entry?.dataset.favoriteEntry || '';
      event.dataTransfer?.setData?.('text/plain', state.draggedId || state.draggedStructure?.id || '');
    }
    function handleDragOver(event) { if (event.target.closest?.('[data-favorite-entry], [data-favorite-section-head], [data-favorite-section-tab], [data-favorite-series-tab]')) event.preventDefault(); }
    async function handleDrop(event) {
      const structureTarget = event.target.closest?.('[data-favorite-section-head], [data-favorite-section-tab], [data-favorite-series-tab]');
      if (structureTarget && state.draggedStructure) {
        event.preventDefault(); const kind = state.draggedStructure.kind; const targetId = structureTarget.dataset.sectionId || structureTarget.dataset.favoriteSectionHead || structureTarget.dataset.seriesId;
        if (targetId && targetId !== state.draggedStructure.id && (kind === 'series' || structureTarget.dataset.seriesId === state.draggedStructure.seriesId)) {
          const rows = kind === 'series' ? seriesRows() : sectionRows(state.draggedStructure.seriesId); const ids = rows.map(row => row.id); const from = ids.indexOf(state.draggedStructure.id); const to = ids.indexOf(targetId);
          if (from >= 0 && to >= 0) { ids.splice(from, 1); ids.splice(to, 0, state.draggedStructure.id); safeCall('reorder', { kind, parentId: kind === 'series' ? null : state.draggedStructure.seriesId, ids }); render(); }
        }
        state.draggedStructure = null; return;
      }
      const target = event.target.closest?.('[data-favorite-entry]'); const sourceId = state.draggedId || event.dataTransfer?.getData?.('text/plain'); if (!target || !sourceId || target.dataset.favoriteEntry === sourceId) return;
      event.preventDefault(); const source = safeCall('getEntry', sourceId); const destination = safeCall('getEntry', target.dataset.favoriteEntry); if (!source || !destination || source.seriesId !== destination.seriesId || source.sectionId !== destination.sectionId) return;
      if (!await finishEditorBeforeMutation()) return;
      const rows = readEntries(source.seriesId, source.sectionId || null, 10000, true).items.map(row => row.id); const from = rows.indexOf(sourceId); const to = rows.indexOf(destination.id); rows.splice(from, 1); rows.splice(to, 0, sourceId); safeCall('reorder', { kind: 'entry', parentId: source.sectionId || source.seriesId, ids: rows }); state.draggedId = ''; render();
    }

    function bind() {
      if (!host || state.bound || state.destroyed) return;
      ensureShell(); state.bound = true;
      host.addEventListener('click', handleClick); host.addEventListener('contextmenu', handleContextMenu); host.addEventListener('input', handleInput); host.addEventListener('change', handleChange); host.addEventListener('submit', handleSubmit); host.addEventListener('focusout', handleFocusOut);
      host.addEventListener('compositionstart', handleCompositionStart); host.addEventListener('compositionend', handleCompositionEnd);
      host.addEventListener('keydown', handleKeydown); host.addEventListener('dragstart', handleDragStart); host.addEventListener('dragover', handleDragOver); host.addEventListener('drop', handleDrop); host.addEventListener('scroll', handleShelfScroll, true);
      state.unsubscribe = favorites?.subscribe?.((event = {}) => {
        if (state.destroyed || !state.active) return;
        if (event.structureChanged) {
          if (state.editor) { updateHistory(); return; }
          render(); return;
        }
        refreshChangedEntries(event.changedEntryIds || []); renderHealth(); updateHistory();
      }) || null;
    }
    function enter() { if (state.destroyed) return; bind(); state.active = true; host.hidden = false; state.prefs = readPreferences(); savePreferences({ favoriteViewVersion: 2 }); render(); }
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
      renderFilters(); if (state.editor) renderEditor();
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
      state.active = false; cancelColumnLoading(); return true;
    }
    function cancelColumnLoading() {
      state.columnObserver?.disconnect?.(); state.columnObserver = null;
      if (state.scrollFrame != null) { win?.cancelAnimationFrame?.(state.scrollFrame); win?.clearTimeout?.(state.scrollFrame); state.scrollFrame = null; }
    }
    function destroy() {
      if (!host || state.destroyed) return;
      state.destroyed = true; state.active = false; win.clearTimeout(state.saveTimer); state.saveTimer = null;
      host.removeEventListener('click', handleClick); host.removeEventListener('contextmenu', handleContextMenu); host.removeEventListener('input', handleInput); host.removeEventListener('change', handleChange); host.removeEventListener('submit', handleSubmit); host.removeEventListener('focusout', handleFocusOut);
      host.removeEventListener('compositionstart', handleCompositionStart); host.removeEventListener('compositionend', handleCompositionEnd);
      host.removeEventListener('keydown', handleKeydown); host.removeEventListener('dragstart', handleDragStart); host.removeEventListener('dragover', handleDragOver); host.removeEventListener('drop', handleDrop); host.removeEventListener('scroll', handleShelfScroll, true); cancelColumnLoading();
      try { state.unsubscribe?.(); } catch { /* optional subscription */ } state.unsubscribe = null;
    }

    return { bind, enter, leave, render, refreshLocale, syncSelection, openCreate, openEditor, focusEntry, setZoom, flushEdits, destroy };
  }

  return { createFavoritesView };
});
