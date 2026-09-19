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
    const host = doc?.querySelector?.('#favoritesView');
    const state = {
      bound: false, active: false, destroyed: false, composing: false,
      seriesId: '', sectionId: '',
      columnLimits: new Map(), loadedColumns: new Set(),
      prefs: readPreferences(), editor: null, saveTimer: null,
      quickEditor: null, contextTarget: null, pagesOpen: false, deleteTarget: null, draggedId: '', draggedStructure: null, returnFocus: null, dialog: null, editorSession: 0, columnObserver: null, scrollFrame: null, initializing: false
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
        closedPageIds: unique(Array.isArray(saved.closedPageIds) ? saved.closedPageIds.map(String) : []),
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

      const anchors = el('nav', 'favorites-anchors'); anchors.dataset.favoriteAnchors = ''; anchors.setAttribute('aria-label', label('favorites.switchSeries', '切换收藏系列'));
      const subanchors = el('nav', 'favorites-subanchors'); subanchors.dataset.favoriteSubanchors = ''; subanchors.hidden = true;
      subanchors.setAttribute('aria-label', label('favorites.visibleSections', '显示子分类'));

      const health = el('div', 'favorites-health'); health.dataset.favoriteHealth = ''; health.hidden = true;
      const body = el('div', 'favorites-body');
      const scroll = el('div', 'favorites-scroll'); scroll.dataset.favoriteScroll = '';
      const shelf = el('div', 'favorites-shelf'); shelf.dataset.favoriteShelf = '';
      scroll.append(shelf); body.append(scroll, createEditor(), createQuickEditor());
      host.append(anchors, subanchors, health, body, createContextMenu(), createDialog(), createPageManager(), createDeleteDialog());
      applyPreferences();
    }

    function createQuickEditor() {
      const panel = el('aside', 'favorite-quick-editor'); panel.dataset.favoriteQuickEditor = ''; panel.hidden = true;
      const head = el('div', 'favorite-editor-head'); head.append(el('h3', '', label('favorites.quickCreate', '新增标签')), button('x', label('favorites.closeEditor', '关闭'), 'quick-close'));
      const raw = el('input'); raw.type = 'text'; raw.dataset.favoriteQuickRaw = ''; raw.placeholder = 'Tag';
      const title = el('input'); title.type = 'text'; title.dataset.favoriteQuickTitle = ''; title.placeholder = label('favorites.entryTitle', '名称或中文');
      const note = el('textarea'); note.dataset.favoriteQuickNote = ''; note.placeholder = label('favorites.noteOptional', '备注（可选）');
      const actions = el('div', 'favorite-editor-actions'); actions.append(actionTextButton('quick-cancel', label('favorites.cancel', '取消')), actionTextButton('quick-save', label('favorites.save', '保存'), 'primary'));
      panel.append(head, raw, title, note, actions); return panel;
    }
    function createContextMenu() {
      const menu = el('div', 'favorite-context-menu'); menu.dataset.favoriteContextMenu = ''; menu.hidden = true;
      menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', label('favorites.tabActions', '页签操作'));
      menu.append(actionTextButton('context-edit', label('favorites.edit', '编辑')), actionTextButton('context-delete', label('favorites.delete', '删除'), 'danger'));
      menu.querySelectorAll('button').forEach(item => item.setAttribute('role', 'menuitem'));
      return menu;
    }
    async function openQuickEditor(seriesId, sectionId, trigger = doc.activeElement) {
      if ((state.editor || state.quickEditor) && !await finishEditorBeforeMutation()) return false;
      const returnFocus = trigger;
      const draft = state.quickEditor = { seriesId, sectionId };
      const panel = host.querySelector('[data-favorite-quick-editor]'); if (!panel) return false;
      panel.hidden = false;
      const raw = panel.querySelector('[data-favorite-quick-raw]');
      raw.value = ''; panel.querySelector('[data-favorite-quick-title]').value = ''; panel.querySelector('[data-favorite-quick-note]').value = '';
      const focusRaw = () => {
        if (state.quickEditor !== draft || !state.active || panel.hidden || !raw?.isConnected) return;
        if (doc.activeElement === returnFocus || doc.activeElement === doc.body) raw.focus({ preventScroll: true });
      };
      raw.focus({ preventScroll: true });
      win?.setTimeout?.(focusRaw, 0);
      return true;
    }
    function closeQuickEditor() { state.quickEditor = null; const panel = host.querySelector('[data-favorite-quick-editor]'); if (panel) panel.hidden = true; }
    async function saveQuickEditor() {
      const panel = host.querySelector('[data-favorite-quick-editor]'); const draft = state.quickEditor; if (!panel || !draft) return false;
      const rawText = string(panel.querySelector('[data-favorite-quick-raw]')?.value);
      if (!rawText.trim()) { notify(label('favorites.rawRequired', 'Tag 不能为空')); panel.querySelector('[data-favorite-quick-raw]')?.focus(); return false; }
      const result = safeCall('saveEntry', { ...(draft.id ? { id: draft.id } : {}), kind: 'tag', seriesId: draft.seriesId, sectionId: draft.sectionId, title: string(panel.querySelector('[data-favorite-quick-title]')?.value).trim(), rawText, zh: string(panel.querySelector('[data-favorite-quick-title]')?.value).trim(), note: string(panel.querySelector('[data-favorite-quick-note]')?.value) });
      if (!result?.ok) { notify(result?.error?.message || label('favorites.saveFailed', '保存失败')); return false; }
      draft.id = result.data.id;
      if (!await safeCall('flush')) { notify(label('favorites.saveFailed', '保存失败')); return false; }
      closeQuickEditor(); render(); return true;
    }
    function openContextMenu(kind, id, event) {
      const menu = host.querySelector('[data-favorite-context-menu]'); if (!menu) return;
      const row = kind === 'series' ? seriesRows().find(item => item.id === id) : sectionRows(state.seriesId).find(item => item.id === id);
      if (!row) { closeContextMenu(); return; }
      const anchor = event.target.closest('[data-favorite-series-tab], [data-favorite-section-tab], [data-favorite-section-head]');
      const returnFocus = anchor?.matches('button') ? anchor : anchor?.querySelector('button');
      state.contextTarget = { kind, id, seriesId: row.seriesId || id, returnFocus };
      menu.querySelector('[data-favorite-action="context-delete"]').hidden = kind === 'series';
      menu.hidden = false;
      const bounds = menu.getBoundingClientRect();
      menu.style.left = `${number(event.clientX, 4, 4, Math.max(4, win.innerWidth - bounds.width - 4))}px`;
      menu.style.top = `${number(event.clientY, 4, 4, Math.max(4, win.innerHeight - bounds.height - 4))}px`;
      menu.querySelector('button')?.focus();
    }
    function closeContextMenu() {
      const menu = host.querySelector('[data-favorite-context-menu]');
      if (menu?.contains(doc.activeElement)) doc.activeElement.blur();
      state.contextTarget = null; menu?.setAttribute('hidden', '');
    }
    function dismissContextMenu(event) {
      if (state.contextTarget && !event.target.closest?.('[data-favorite-context-menu]')) closeContextMenu();
    }
    function contextEdit() {
      const target = state.contextTarget; if (!target) return false;
      const row = target.kind === 'series' ? seriesRows().find(item => item.id === target.id) : sectionRows(target.seriesId).find(item => item.id === target.id);
      if (!row) return false; closeContextMenu();
      const dialog = host.querySelector('[data-favorite-dialog]'); const input = host.querySelector('[data-favorite-dialog-input]'); const color = host.querySelector('[data-favorite-dialog-color]');
      const title = () => label(target.kind === 'series' ? 'favorites.editPage' : 'favorites.editColumn', target.kind === 'series' ? '编辑收藏页' : '编辑标签栏');
      state.dialog = { returnFocus: target.returnFocus, title, structure: { kind: target.kind, row } };
      host.querySelector('[data-favorite-dialog-status]').textContent = '';
      dialog.querySelector('h3').textContent = title(); input.value = row.name || ''; color.value = row.color || '#287EA4'; color.hidden = false;
      host.querySelector('[data-favorite-dialog-color-label]').hidden = false;
      dialog.hidden = false; input.focus(); input.select(); return true;
    }
    function contextDelete() {
      const target = state.contextTarget; if (!target || target.kind !== 'section') return false;
      return requestDelete('section', target.id, target.returnFocus);
    }
    function createPageManager() {
      const panel = el('aside', 'favorite-page-manager'); panel.dataset.favoritePageManager = ''; panel.hidden = true;
      panel.setAttribute('aria-label', label('favorites.allPages', '全部收藏页')); return panel;
    }
    function renderPageManager() {
      const panel = host.querySelector('[data-favorite-page-manager]'); if (!panel) return;
      panel.hidden = !state.pagesOpen; panel.replaceChildren();
      const closed = new Set(state.prefs.closedPageIds);
      seriesRows().forEach(row => {
        const item = el('div', 'favorite-page-row'); item.dataset.favoritePageRow = row.id; item.style.setProperty('--favorite-accent', row.color);
        const open = actionTextButton('open-page', row.name); open.dataset.seriesId = row.id;
        const status = el('span', 'favorite-page-status', label(closed.has(row.id) ? 'favorites.pageClosed' : 'favorites.pageOpen', closed.has(row.id) ? '已关闭' : '已打开'));
        const remove = button('trash-2', label('favorites.deletePage', '删除收藏页') + '：' + row.name, 'delete-page'); remove.dataset.seriesId = row.id;
        item.append(open, status, remove); panel.append(item);
      });
    }
    function closePageManager() {
      state.pagesOpen = false; host.querySelector('[data-favorite-page-manager]')?.setAttribute('hidden', '');
      host.querySelector('[data-favorite-action="toggle-pages"]')?.setAttribute('aria-expanded', 'false');
    }
    function dismissPageManager(event) {
      if (state.pagesOpen && !state.deleteTarget && !event.target.closest?.('[data-favorite-page-manager], [data-favorite-action="toggle-pages"]')) closePageManager();
    }
    function openPages() { const closed = new Set(state.prefs.closedPageIds); return seriesRows().filter(row => !closed.has(row.id)); }
    async function closePage(id) {
      if (!openPages().some(row => row.id === id)) return false;
      if (id === state.seriesId && !await finishEditorBeforeMutation()) return false;
      const rows = openPages(); const index = rows.findIndex(row => row.id === id);
      if (id === state.seriesId) { state.seriesId = rows[index + 1]?.id || rows[index - 1]?.id || ''; state.sectionId = ''; }
      savePreferences({ closedPageIds: unique([...state.prefs.closedPageIds, id]), activeSeriesId: state.seriesId });
      closeContextMenu(); render();
      host.querySelector('[data-favorite-action="select-series"].is-active')?.focus(); return true;
    }
    function createDeleteDialog() {
      const overlay = el('div', 'favorite-dialog'); overlay.dataset.favoriteDeleteDialog = ''; overlay.hidden = true;
      overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-labelledby', 'favorite-delete-heading');
      const panel = el('div', 'favorite-dialog-panel'); const heading = el('h3', '', label('favorites.delete', '删除')); heading.id = 'favorite-delete-heading';
      const message = el('p'); message.dataset.favoriteDeleteMessage = '';
      const status = el('p', 'favorite-dialog-status'); status.dataset.favoriteDeleteStatus = ''; status.setAttribute('role', 'status');
      const actions = el('div', 'favorite-editor-actions'); actions.append(actionTextButton('cancel-delete', label('favorites.cancel', '取消')), actionTextButton('confirm-delete', label('favorites.delete', '删除'), 'danger'));
      panel.append(heading, message, status, actions); overlay.append(panel); return overlay;
    }
    function requestDelete(kind, id, returnFocus) {
      const row = kind === 'series' ? seriesRows().find(item => item.id === id) : sectionRows(state.seriesId).find(item => item.id === id);
      if (!row) return false;
      closeContextMenu(); state.deleteTarget = { kind, id, row, returnFocus, busy: false };
      const dialog = host.querySelector('[data-favorite-delete-dialog]');
      dialog.querySelector('[data-favorite-delete-message]').textContent = row.name + ' — ' + label(kind === 'series' ? 'favorites.confirmDeleteSeries' : 'favorites.confirmDeleteSection', '确定删除吗？');
      dialog.querySelector('[data-favorite-delete-status]').textContent = ''; dialog.hidden = false;
      dialog.querySelector('[data-favorite-action="cancel-delete"]').focus(); return true;
    }
    function cancelDelete() {
      if (state.deleteTarget?.busy) return;
      const target = state.deleteTarget; state.deleteTarget = null; host.querySelector('[data-favorite-delete-dialog]')?.setAttribute('hidden', '');
      restoreDialogFocus(target);
    }
    async function confirmDelete() {
      const target = state.deleteTarget; if (!target || target.busy) return false;
      const confirm = host.querySelector('[data-favorite-action="confirm-delete"]');
      target.busy = true; confirm.disabled = true;
      try {
        if (!await finishEditorBeforeMutation()) { host.querySelector('[data-favorite-delete-status]').textContent = label('favorites.saveFailed', '保存失败'); return false; }
        const result = target.kind === 'series' ? safeCall('deleteSeries', target.id, { mode: 'delete' }) : safeCall('deleteSection', target.id);
        if (!result?.ok) { host.querySelector('[data-favorite-delete-status]').textContent = result?.error?.message || label('favorites.operationFailed', '操作失败'); return false; }
        if (target.kind === 'series') savePreferences({ closedPageIds: state.prefs.closedPageIds.filter(id => id !== target.id) });
        state.deleteTarget = null; host.querySelector('[data-favorite-delete-dialog]').hidden = true; render();
        host.querySelector('[data-favorite-action="select-series"].is-active')?.focus(); return true;
      } finally { target.busy = false; confirm.disabled = false; }
    }

    function actionTextButton(action, textValue, extra = '') {
      const node = el('button', `favorite-action-button ${extra}`.trim(), textValue); node.type = 'button'; node.dataset.favoriteAction = action; return node;
    }
    function createDialog() {
      const dialog = el('div', 'favorite-dialog'); dialog.dataset.favoriteDialog = ''; dialog.hidden = true;
      dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-labelledby', 'favorite-dialog-heading');
      const panel = el('form', 'favorite-dialog-panel'); panel.dataset.favoriteDialogForm = '';
      const heading = el('h3', '', label('favorites.namePrompt', '输入名称')); heading.id = 'favorite-dialog-heading'; panel.append(heading);
      const input = el('input'); input.type = 'text'; input.dataset.favoriteDialogInput = ''; input.autocomplete = 'off'; input.id = 'favorite-dialog-name';
      const nameLabel = el('label', '', label('favorites.entryTitle', '名称')); nameLabel.htmlFor = input.id;
      const color = el('input', 'favorite-dialog-color'); color.type = 'color'; color.dataset.favoriteDialogColor = ''; color.hidden = true; color.id = 'favorite-dialog-color';
      const colorLabel = el('label', '', label('favorites.borderColor', '边框颜色')); colorLabel.htmlFor = color.id; colorLabel.dataset.favoriteDialogColorLabel = ''; colorLabel.hidden = true;
      const status = el('p', 'favorite-dialog-status'); status.dataset.favoriteDialogStatus = '';
      const actions = el('div', 'favorite-editor-actions');
      const cancel = actionTextButton('dialog-cancel', label('favorites.cancel', '取消')); const confirm = actionTextButton('dialog-confirm', label('favorites.confirm', '确定'), 'primary');
      actions.append(cancel, confirm); panel.append(nameLabel, input, colorLabel, color, status, actions); dialog.append(panel); return dialog;
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
      const structure = state.dialog.structure; const color = host.querySelector('[data-favorite-dialog-color]');
      const patch = structure ? { id: structure.row.id, name, ...(structure.kind === 'section' ? { seriesId: structure.row.seriesId } : {}), ...(color.value.toUpperCase() !== structure.row.color?.toUpperCase() ? { color: color.value } : {}) } : null;
      const result = structure ? safeCall(structure.kind === 'series' ? 'saveSeries' : 'saveSection', patch) : state.dialog.onSave(name);
      if (result?.ok === false) { if (status) status.textContent = result.error?.message || label('favorites.operationFailed', '操作失败'); return false; }
      const dialogState = state.dialog; state.dialog = null; const dialog = host.querySelector('[data-favorite-dialog]'); if (dialog) dialog.hidden = true;
      const dialogColor = host.querySelector('[data-favorite-dialog-color]'); if (dialogColor) dialogColor.hidden = true; render(); restoreDialogFocus(dialogState); return true;
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
        editorSelect('seriesId', label('favorites.page', '收藏页'), []),
        editorSelect('sectionId', label('favorites.column', '标签栏'), []),
        editorTextarea('rawText', 'Tag', true),
        editorInput('title', label('favorites.entryTitle', '名称')),
        editorTextarea('note', label('favorites.note', '备注'))
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
      const rows = openPages();
      if (!rows.some(row => row.id === state.seriesId)) state.seriesId = rows.find(row => row.id === state.prefs.activeSeriesId)?.id || rows[0]?.id || '';
      const sections = sectionRows(state.seriesId);
      if (!sections.some(row => row.id === state.sectionId)) state.sectionId = sections[0]?.id || '';
      renderAnchors(); renderSubanchors(); renderHealth(); renderShelf(); renderPageManager();
      updateHistory(); applyPreferences();
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
      rows = openPages();
      const active = rows.find(row => row.id === state.seriesId) || rows.find(row => row.id === state.prefs.activeSeriesId) || rows[0];
      if (!active) return;
      state.initializing = true;
      try { safeCall('ensureTagColumns', active.id, label('favorites.newSectionTab', '新建标签栏')); }
      finally { state.initializing = false; }
    }
    function renderAnchors() {
      const anchors = host.querySelector('[data-favorite-anchors]'); if (!anchors) return;
      anchors.replaceChildren();
      const tabs = el('div', 'favorite-page-tabs');
      openPages().forEach(row => {
        const tab = el('span', 'favorite-series-tab'); tab.style.setProperty('--favorite-accent', string(row.color, 'var(--pri)'));
        tab.dataset.favoriteSeriesTab = row.id; tab.dataset.seriesId = row.id; tab.draggable = true;
        const item = actionTextButton('select-series', string(row.name, row.id)); item.dataset.seriesId = row.id;
        item.classList.toggle('is-active', row.id === state.seriesId); tab.classList.toggle('is-active', row.id === state.seriesId); item.setAttribute('aria-pressed', String(row.id === state.seriesId));
        const close = button('x', label('favorites.closePage', '关闭收藏页') + '：' + row.name, 'close-page'); close.dataset.seriesId = row.id;
        tab.append(item, close); tabs.append(tab);
      });
      tabs.append(button('plus', label('favorites.newSeries', '新建收藏页'), 'new-series-tab'));
      const zoomGroup = el('div', 'favorite-zoom-control favorites-inline-zoom');
      const zoom = control('input', 'favoriteZoom'); zoom.type = 'number'; zoom.min = '75'; zoom.max = '150'; zoom.step = '10'; zoom.value = String(state.prefs.zoom); zoom.setAttribute('aria-label', label('favorites.zoom', '缩放百分比'));
      zoomGroup.append(button('minus', label('favorites.zoomOut', '缩小'), 'zoom-out'), zoom, el('span', '', '%'), button('plus', label('favorites.zoomIn', '放大'), 'zoom-in'), button('locate-fixed', label('favorites.zoomReset', '重置缩放'), 'zoom-reset'));
      const folder = button('folder', label('favorites.allPages', '全部收藏页'), 'toggle-pages'); folder.setAttribute('aria-expanded', String(state.pagesOpen));
      anchors.append(folder, tabs, zoomGroup);
    }
    function columnKey(seriesId, sectionId) { return JSON.stringify([seriesId, sectionId]); }
    function columnsFor(seriesId) { return sectionRows(seriesId); }
    function hiddenSections(seriesId = state.seriesId) { return new Set(state.prefs.hiddenSectionsBySeries[seriesId] || []); }
    function saveHiddenSections(ids, seriesId = state.seriesId) {
      savePreferences({ hiddenSectionsBySeries: { ...state.prefs.hiddenSectionsBySeries, [seriesId]: [...ids] } });
    }
    async function selectSeries(id) {
      if (id === state.seriesId && !state.prefs.closedPageIds.includes(id)) { closePageManager(); return true; }
      if (!seriesRows().some(row => row.id === id) || !await finishEditorBeforeMutation()) return false;
      state.seriesId = id; state.sectionId = ''; savePreferences({ activeSeriesId: id, closedPageIds: state.prefs.closedPageIds.filter(value => value !== id) }); closePageManager(); render();
      const scroll = host.querySelector('[data-favorite-scroll]'); scroll.scrollTop = 0; scroll.scrollLeft = 0;
      host.querySelector('[data-favorite-action="select-series"][data-series-id="' + cssEscape(id) + '"]')?.focus(); return true;
    }
    async function setSectionVisibility(sectionId, visible) {
      if (!await finishEditorBeforeMutation()) { renderSubanchors(); return false; }
      if (!visible && state.quickEditor?.sectionId === sectionId) closeQuickEditor();
      const hidden = hiddenSections(); visible ? hidden.delete(sectionId) : hidden.add(sectionId);
      saveHiddenSections(hidden); renderSubanchors(); renderShelf(); return true;
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
      if (!series) { shelf.append(el('p', 'favorites-empty', label('favorites.noOpenPages', '点击左上角文件夹打开收藏页，或点击 + 新建'))); return; }
      const content = el('section', 'favorite-series'); content.dataset.favoriteSeries = series.id;
      content.style.setProperty('--favorite-accent', string(series.color, 'var(--pri)')); content.setAttribute('aria-label', series.name);
      const selected = allSelectedIds(); const columns = columnsFor(series.id);
      columns.filter(section => !hiddenSections().has(section.id)).forEach(section => content.append(renderColumn(series, section, selected, false)));
      if (columns.length && !content.childElementCount) content.append(el('p', 'favorites-empty', label('favorites.allColumnsHidden', '标签栏已隐藏，点击上方眼睛按钮恢复显示')));
      if (!columns.length) content.append(el('p', 'favorites-empty', label('favorites.emptySection', '此收藏页暂无标签栏')));
      shelf.append(content); setupColumnLoading();
    }
    function renderColumn(series, section, selected, lazy = false) {
      const id = section.id;
      const limit = state.columnLimits.get(columnKey(series.id, section.id)) || INITIAL_COLUMN_BATCH;
      const rows = readEntries(series.id, id, lazy ? 1 : limit);
      const group = renderSection(series, section, lazy ? { ...rows, items: [], hasMore: false } : rows, selected);
      if (lazy) {
        group.dataset.favoriteLazySection = section.id;
        const placeholder = actionTextButton('load-section', label('favorites.loadSection', '加载子分类内容')); placeholder.dataset.seriesId = series.id; placeholder.dataset.sectionId = section.id; group.append(placeholder);
      }
      if (!includeAdult()) {
        const total = safeCall('list', { seriesId: series.id, sectionId: id, includeAdult: true, limit: 1, view: 'shelf' })?.total || 0;
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
      head.append(title, el('span', 'favorite-section-count', rows.total));
      group.append(head);
      const list = el('div', 'favorite-entry-list'); rows.items.forEach(entry => list.append(renderEntry(entry, selected.has(entry.id)))); list.append(renderQuickBlank(series, section)); group.append(list);
      if (rows.hasMore) { const more = actionTextButton('load-column', label('favorites.loadMore', '加载更多')); more.dataset.seriesId = series.id; more.dataset.sectionId = section.id; group.append(more); }
      return group;
    }

    function displayText(entry) { return string(entry.rawText, label('favorites.untitled', '未命名收藏')); }
    function secondaryText(entry) { return string(entry.title || entry.zh); }
    function renderEntry(entry, selected = false) {
      const item = el('article', `favorite-entry favorite-entry-tag${selected ? ' is-selected' : ''}${entry.pinned ? ' is-pinned' : ''}`);
      item.dataset.favoriteEntry = entry.id; item.draggable = true;
      const invalidLegacy = entry.legacyInvalid === true && !string(entry.rawText).trim();
      if (invalidLegacy) item.classList.add('is-legacy-invalid');
      const main = el('button', 'favorite-entry-main'); main.type = 'button'; main.dataset.favoriteSelect = entry.id; main.title = string(entry.rawText);
      main.disabled = invalidLegacy;
      main.setAttribute('aria-pressed', String(selected));
      const top = el('span', 'favorite-entry-title');
      top.textContent = displayText(entry);
      const secondary = secondaryText(entry); main.append(top); if (secondary) main.append(el('span', 'favorite-entry-secondary', secondary));
      const meta = el('span', 'favorite-entry-meta');
      if (entry.pinned) meta.append(icon('pin'));
      main.append(meta);
      const actions = el('div', 'favorite-entry-actions');
      const copyButton = button('copy', label('favorites.copy', '复制'), 'copy'); copyButton.dataset.favoriteCopy = entry.id;
      copyButton.disabled = invalidLegacy;
      const edit = button('pencil', label('favorites.edit', '编辑'), 'edit'); edit.dataset.favoriteEdit = entry.id;
      const up = button('arrow-up', label('favorites.moveUp', '上移'), 'move-up'); up.dataset.entryId = entry.id;
      const down = button('arrow-down', label('favorites.moveDown', '下移'), 'move-down'); down.dataset.entryId = entry.id;
      const grip = button('grip-vertical', label('favorites.drag', '拖动排序'), '', 'favorite-drag-handle'); grip.tabIndex = -1;
      actions.append(copyButton, edit, up, down, grip); item.append(main, actions);
      if (entry.note) item.append(el('span', 'favorite-note-popover', entry.note));
      return item;
    }
    function icon(id) {
      const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.classList.add('favorite-icon'); svg.setAttribute('aria-hidden', 'true');
      const use = doc.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttribute('href', `../assets/icons/favorites.svg#${id}`); svg.append(use); return svg;
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
      safeCall('ensureTagColumns', series.value, label('favorites.newSectionTab', '新建标签栏'));
      const rows = sectionRows(series.value);
      section.replaceChildren(...rows.map(row => optionNode(row.id, string(row.name, row.id))));
      section.value = rows.some(row => row.id === selectedSectionId) ? selectedSectionId : rows[0]?.id || '';
    }
    function currentVisibleIds() {
      return [...host.querySelectorAll('[data-favorite-entry]')].map(node => node.dataset.favoriteEntry);
    }
    async function openCreate(value = {}) {
      ensureShell();
      const order = currentVisibleIds();
      if (state.quickEditor && !await finishEditorBeforeMutation()) return false;
      if (state.editor && !await flushEdits()) return false;
      const firstSeries = value.seriesId || state.seriesId || seriesRows()[0]?.id || '';
      safeCall('ensureTagColumns', firstSeries, label('favorites.newSectionTab', '新建标签栏'));
      const sectionId = sectionRows(firstSeries).find(row => row.id === (value.sectionId || state.sectionId))?.id || sectionRows(firstSeries)[0]?.id || '';
      const rawText = string(value.rawText); const kind = 'tag';
      state.returnFocus = doc.activeElement;
      state.editor = { session: ++state.editorSession, version: rawText ? 1 : 0, savePromise: null, id: null, creating: true, dirty: Boolean(rawText), saved: null, order, historyKey: `favorite-create-${Date.now()}`, draft: {
        kind, seriesId: firstSeries, sectionId, sourceCharacterId: value.sourceCharacterId || null, title: string(value.title || value.zh), rawText, zh: string(value.zh), aliases: Array.isArray(value.aliases) ? [...value.aliases] : [], note: string(value.note), globalSearchable: value.globalSearchable !== false, nsfw: value.nsfw === true
      } };
      renderEditor(); return state.editor;
    }
    async function openEditor(entryId, preserveOrder = false) {
      ensureShell();
      if (state.editor?.id === entryId && !state.editor.creating) return true;
      const order = preserveOrder && state.editor?.order?.length ? [...state.editor.order] : currentVisibleIds();
      if (state.editor && !await flushEdits()) return false;
      const existing = safeCall('getEntry', entryId); if (existing) safeCall('ensureTagColumns', existing.seriesId, label('favorites.newSectionTab', '新建标签栏'));
      const entry = safeCall('getEntry', entryId); if (!entry) { notify(label('favorites.notFound', '收藏不存在')); return false; }
      if (!preserveOrder) state.returnFocus = doc.activeElement;
      state.editor = { session: ++state.editorSession, version: 0, savePromise: null, id: entry.id, creating: false, dirty: false, saved: { ...entry, aliases: [...(entry.aliases || [])] }, order: order.includes(entry.id) ? order : [...order, entry.id], historyKey: `favorite-edit-${entry.id}-${Date.now()}`, draft: { ...entry, title: string(entry.title || entry.zh), aliases: [...(entry.aliases || [])] } };
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
        else { state.editor.draft[key] = field.value; if (key === 'title') state.editor.draft.zh = field.value; }
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
          if (!sectionRows(patch.seriesId).some(row => row.id === patch.sectionId)) { setSaveStatus('invalid', label('favorites.columnRequired', '请选择标签栏')); return false; }
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
      endEditorTransaction(); discardEditor(); return true;
    }
    async function finishEditorBeforeMutation() {
      if (state.quickEditor) {
        const panel = host.querySelector('[data-favorite-quick-editor]');
        const hasDraft = [...panel.querySelectorAll('input,textarea')].some(field => field.value.trim());
        if (hasDraft && !await saveQuickEditor()) return false;
        closeQuickEditor();
      }
      if (!state.editor) return true;
      if (!await flushEdits()) return false;
      discardEditor(); return true;
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
      let entry = safeCall('getEntry', entryId); if (!entry || (entry.nsfw && !includeAdult())) return false;
      safeCall('ensureTagColumns', entry.seriesId, label('favorites.newSectionTab', '新建标签栏')); entry = safeCall('getEntry', entryId);
      if (!await finishEditorBeforeMutation()) return false;
      state.seriesId = entry.seriesId; savePreferences({ activeSeriesId: entry.seriesId, closedPageIds: state.prefs.closedPageIds.filter(id => id !== entry.seriesId) });
      const sectionId = entry.sectionId; const hidden = hiddenSections(); hidden.delete(sectionId); saveHiddenSections(hidden);
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
      return false;
    }

    async function handleClick(event) {
      dismissContextMenu(event); dismissPageManager(event);
      const target = event.target.closest?.('[data-favorite-action], [data-favorite-copy], [data-favorite-edit], [data-favorite-select], [data-favorite-locate], [data-favorite-quick-new]'); if (!target || !host.contains(target)) return;
      if (target.dataset.favoriteCopy) return void copyEntry(target.dataset.favoriteCopy, false);
      if (target.dataset.favoriteEdit) return void openEditor(target.dataset.favoriteEdit);
      if (target.dataset.favoriteSelect) return void copyEntry(target.dataset.favoriteSelect, true);
      if (target.dataset.favoriteLocate) return void focusEntry(target.dataset.favoriteLocate);
      const action = target.dataset.favoriteAction;
      if (action === 'toggle-pages') { state.pagesOpen = !state.pagesOpen; target.setAttribute('aria-expanded', String(state.pagesOpen)); renderPageManager(); return; }
      if (action === 'close-page') return void closePage(target.dataset.seriesId);
      if (action === 'open-page') return void selectSeries(target.dataset.seriesId);
      if (action === 'delete-page') return void requestDelete('series', target.dataset.seriesId, target);
      if (action === 'cancel-delete') return void cancelDelete();
      if (action === 'confirm-delete') return void confirmDelete();
      if (Object.prototype.hasOwnProperty.call(target.dataset, 'favoriteQuickNew')) return void openQuickEditor(target.dataset.seriesId, target.dataset.sectionId, target);
      if (action === 'quick-close' || action === 'quick-cancel') { closeQuickEditor(); return; }
      if (action === 'quick-save') return void saveQuickEditor();
      if (action === 'context-edit') return void contextEdit();
      if (action === 'context-delete') return void contextDelete();
      if (action === 'dialog-cancel') { closeNameDialog(); return; }
      if (action === 'dialog-confirm') { submitNameDialog(); return; }
      if (action === 'new-series-tab') return void structureAction('new-series-tab', target);
      if (action === 'new-section-tab') return void structureAction('new-section-tab', target);
      if (action === 'toggle-section') return void setSectionVisibility(target.dataset.sectionId, hiddenSections().has(target.dataset.sectionId));
      if (action === 'select-section') { state.sectionId = target.dataset.sectionId; renderSubanchors(); renderShelf(); host.querySelector(`[data-favorite-section="${cssEscape(state.sectionId)}"]`)?.scrollIntoView?.({ behavior: 'smooth', inline: 'center' }); return; }
      if (action === 'undo' || action === 'redo') { if (!await finishEditorBeforeMutation()) return; safeCall(action); render(); return; }
      if (action === 'zoom-out') return void setZoom(state.prefs.zoom - 10);
      if (action === 'zoom-in') return void setZoom(state.prefs.zoom + 10);
      if (action === 'zoom-reset') return void setZoom(100);
      if (action === 'select-series') return void selectSeries(target.dataset.seriesId);
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
    }
    function handleSubmit(event) {
      if (!event.target.matches('[data-favorite-dialog-form]')) return;
      event.preventDefault(); submitNameDialog();
    }
    function renderSubanchors() {
      const nav = host.querySelector('[data-favorite-subanchors]'); nav.replaceChildren(); nav.hidden = !state.seriesId; if (!state.seriesId) return;
      const hidden = hiddenSections();
      columnsFor(state.seriesId).forEach(row => {
        const visible = !hidden.has(row.id);
        const tab = el('span', 'favorite-column-tab'); tab.dataset.favoriteSectionTab = row.id; tab.dataset.sectionId = row.id; tab.dataset.seriesId = state.seriesId; tab.draggable = true;
        tab.style.setProperty('--favorite-accent', string(row.color, '#287EA4')); tab.classList.toggle('is-hidden', !visible);
        const item = actionTextButton('select-section', string(row.name, row.id)); item.dataset.sectionId = row.id; item.dataset.seriesId = state.seriesId; item.classList.toggle('is-active', visible && row.id === state.sectionId);
        const eye = button(visible ? 'eye' : 'eye-off', label(visible ? 'favorites.hideColumn' : 'favorites.showColumn', visible ? '隐藏标签栏' : '显示标签栏') + '：' + row.name, 'toggle-section');
        eye.dataset.sectionId = row.id; eye.setAttribute('aria-pressed', String(visible));
        tab.append(item, eye); nav.append(tab);
      });
      const plus = button('plus', label('favorites.newSectionTab', '新建标签栏'), 'new-section-tab'); plus.dataset.seriesId = state.seriesId; nav.append(plus);
    }
    function handleInput(event) {
      if (event.target.matches('[data-favorite-field]')) { readDraftFromFields(event.target); scheduleSave(); }
    }
    function handleContextMenu(event) {
      const series = event.target.closest?.('[data-favorite-series-tab]'); const section = event.target.closest?.('[data-favorite-section-tab], [data-favorite-section-head]');
      if (!series && !section) return;
      event.preventDefault(); openContextMenu(series ? 'series' : 'section', series?.dataset.seriesId || section?.dataset.sectionId || section?.dataset.favoriteSectionHead, event);
    }
    function handleChange(event) {
      const target = event.target;
      if (target.matches('[data-favorite-column-width]')) { savePreferences({ columnWidth: number(target.value, DEFAULT_VIEW.columnWidth, 220, 420) }); return; }
      if (target.matches('[data-favorite-zoom]')) { setZoom(target.value); return; }
      if (target.matches('[data-favorite-primary]')) { savePreferences({ primary: target.value }); renderShelf(); return; }
      if (target.matches('[data-favorite-secondary]')) { savePreferences({ showSecondary: target.checked }); renderShelf(); return; }
      if (target.matches('[data-favorite-compact]')) { savePreferences({ compact: target.checked }); return; }
      if (target.matches('[data-favorite-field="seriesId"]')) { readDraftFromFields(target); editorSeriesOptions(target.value, null); readDraftFromFields(host.querySelector('[data-favorite-field="sectionId"]')); scheduleSave(); }
    }
    function handleCompositionStart(event) { if (event.target.matches('[data-favorite-field]')) { state.composing = true; win.clearTimeout(state.saveTimer); state.saveTimer = null; } }
    function handleCompositionEnd(event) { if (event.target.matches('[data-favorite-field]')) { state.composing = false; readDraftFromFields(event.target); scheduleSave(); } }
    function handleFocusOut(event) { if (event.target.matches?.('[data-favorite-field]') && !event.relatedTarget?.matches?.('[data-favorite-field]')) endEditorTransaction(); }
    async function handleKeydown(event) {
      if (!state.active || state.destroyed) return;
      if (state.deleteTarget && event.key === 'Escape') { event.preventDefault(); cancelDelete(); return; }
      if (state.pagesOpen && event.key === 'Escape') { event.preventDefault(); closePageManager(); host.querySelector('[data-favorite-action="toggle-pages"]')?.focus(); return; }
      if (state.contextTarget) {
        if (event.key === 'Escape') { event.preventDefault(); const target = state.contextTarget; closeContextMenu(); target.returnFocus?.focus(); return; }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const items = [...host.querySelectorAll('[data-favorite-context-menu] button')].filter(item => !item.hidden);
          const index = items.indexOf(doc.activeElement); items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus(); return;
        }
      }
      if (state.dialog && event.key === 'Enter' && event.target.matches?.('[data-favorite-dialog-input]')) { event.preventDefault(); submitNameDialog(); return; }
      const editable = event.target.matches?.('input, textarea, select, [contenteditable="true"]');
      if (event.key === 'Escape') { if (state.dialog) { event.preventDefault(); closeNameDialog(); } else if (state.editor) { event.preventDefault(); discardEditor(); } return; }
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
      doc.addEventListener('pointerdown', dismissContextMenu); doc.addEventListener('pointerdown', dismissPageManager);
      host.addEventListener('compositionstart', handleCompositionStart); host.addEventListener('compositionend', handleCompositionEnd);
      host.addEventListener('keydown', handleKeydown); host.addEventListener('dragstart', handleDragStart); host.addEventListener('dragover', handleDragOver); host.addEventListener('drop', handleDrop); host.addEventListener('scroll', handleShelfScroll, true);
      state.unsubscribe = favorites?.subscribe?.((event = {}) => {
        if (state.destroyed || !state.active || state.initializing) return;
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
      const dialogSnapshot = state.dialog ? { value: dialogInput?.value || '', color: host.querySelector('[data-favorite-dialog-color]')?.value, status: dialogStatus?.textContent || '', focused: doc.activeElement === dialogInput } : null;
      closeContextMenu(); cancelDelete();
      const quickPanel = host.querySelector('[data-favorite-quick-editor]');
      const quickSnapshot = state.quickEditor ? [...quickPanel.querySelectorAll('input,textarea')].map(field => ({ value: field.value, focused: field === doc.activeElement })) : null;
      host.replaceChildren(); delete host.dataset.favoritesReady; ensureShell(); render();
      if (state.editor) renderEditor();
      if (quickSnapshot) {
        const panel = host.querySelector('[data-favorite-quick-editor]'); panel.hidden = false;
        [...panel.querySelectorAll('input,textarea')].forEach((field, index) => { field.value = quickSnapshot[index].value; if (quickSnapshot[index].focused) field.focus(); });
      }
      if (dialogSnapshot && state.dialog) {
        const dialog = host.querySelector('[data-favorite-dialog]'); const input = host.querySelector('[data-favorite-dialog-input]'); const status = host.querySelector('[data-favorite-dialog-status]');
        const title = typeof state.dialog.title === 'function' ? state.dialog.title() : state.dialog.titleText;
        if (state.dialog.structure) { const color = host.querySelector('[data-favorite-dialog-color]'); color.value = dialogSnapshot.color; color.hidden = false; host.querySelector('[data-favorite-dialog-color-label]').hidden = false; }
        dialog.querySelector('h3').textContent = title; input.value = dialogSnapshot.value; status.textContent = dialogSnapshot.status; dialog.hidden = false; if (dialogSnapshot.focused) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
      }
      return true;
    }
    async function leave() {
      const saved = await finishEditorBeforeMutation(); if (!saved) return false;
      state.active = false; closeContextMenu(); closePageManager(); cancelDelete(); cancelColumnLoading(); return true;
    }
    function cancelColumnLoading() {
      state.columnObserver?.disconnect?.(); state.columnObserver = null;
      if (state.scrollFrame != null) { win?.cancelAnimationFrame?.(state.scrollFrame); win?.clearTimeout?.(state.scrollFrame); state.scrollFrame = null; }
    }
    function destroy() {
      if (!host || state.destroyed) return;
      state.destroyed = true; state.active = false; win.clearTimeout(state.saveTimer); state.saveTimer = null;
      host.removeEventListener('click', handleClick); host.removeEventListener('contextmenu', handleContextMenu); host.removeEventListener('input', handleInput); host.removeEventListener('change', handleChange); host.removeEventListener('submit', handleSubmit); host.removeEventListener('focusout', handleFocusOut);
      doc.removeEventListener('pointerdown', dismissContextMenu); doc.removeEventListener('pointerdown', dismissPageManager);
      host.removeEventListener('compositionstart', handleCompositionStart); host.removeEventListener('compositionend', handleCompositionEnd);
      host.removeEventListener('keydown', handleKeydown); host.removeEventListener('dragstart', handleDragStart); host.removeEventListener('dragover', handleDragOver); host.removeEventListener('drop', handleDrop); host.removeEventListener('scroll', handleShelfScroll, true); cancelColumnLoading();
      try { state.unsubscribe?.(); } catch { /* optional subscription */ } state.unsubscribe = null;
    }

    return { bind, enter, leave, render, refreshLocale, syncSelection, openCreate, openEditor, focusEntry, setZoom, flushEdits, destroy };
  }

  return { createFavoritesView };
});
