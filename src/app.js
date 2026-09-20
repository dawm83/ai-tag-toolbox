'use strict';

/* App entry point only composes public modules and the route view. */
(function boot(global) {
  const modules = global.AppModules || {};
  const preferences = modules.preferences || null;
  const get = (key, fallback) => { try { return preferences?.get?.(key, fallback) ?? fallback; } catch { return fallback; } };
  const app = {
    route: 'tags',
    theme: get('theme', get('app.theme', 'light')) || 'light',
    locale: get('locale', get('app.locale', 'zh-CN')) || 'zh-CN'
  };
  const view = global.AppView?.create?.(modules, global.document);
  if (!view) return;
  global.App = {
    modules,
    state: app,
    route(value) {
      const result = view.route?.(value);
      if (result?.then) return result.then(accepted => { if (accepted !== false) app.route = value; return accepted; });
      if (result !== false) app.route = value; return result;
    },
    views: view.views || {},
    dispose() { view.dispose?.(); },
    async flushBeforeClose() {
      if (await view.tagEditor?.requestClose?.() === false) return false;
      if (await view.views?.characters?.requestClose?.() === false) return false;
      const ready = await modules.catalog?.ready?.();
      if (ready?.ok && await modules.catalog.flush() === false) return false;
      await view.flushSettings?.();
      return typeof modules.prepareClose === 'function' ? modules.prepareClose() : modules.assistant?.flushPersistence?.();
    }
  };
  if (!modules.catalog) { view.start?.(); return; }
  const doc = global.document, panel = doc.createElement('section');
  panel.dataset.catalogStartup = ''; panel.className = 'catalog-startup'; panel.setAttribute('role', 'status');
  const message = doc.createElement('p'), retry = doc.createElement('button'), recover = doc.createElement('button');
  retry.type = recover.type = 'button'; retry.textContent = '重试 / Retry'; recover.textContent = '恢复备份 / Recover backup';
  retry.dataset.catalogRetry = ''; recover.dataset.catalogRecover = ''; panel.append(message, retry, recover); doc.body.append(panel);
  let pending = false, disposed = false;
  async function initialize(method) {
    if (pending || disposed) return false;
    pending = true; retry.disabled = recover.disabled = true; message.textContent = '正在准备标签库 / Preparing tag library';
    let result;
    try { result = await modules.catalog[method](); } catch { result = { ok: false, error: { code: 'NOT_READY' } }; }
    pending = false; if (disposed) return false;
    if (result?.ok) {
      if (result.data?.reloadRequired) { global.location.reload(); return true; }
      panel.remove(); view.start?.(); return true;
    }
    message.textContent = '标签库初始化未完成，原数据已保留。请修复后重试。 (' + (result?.error?.code || 'NOT_READY') + ')';
    retry.disabled = recover.disabled = false; return false;
  }
  retry.onclick = () => initialize('retryInitialization'); recover.onclick = () => initialize('recoverBackup');
  const originalDispose = global.App.dispose;
  global.App.dispose = () => { disposed = true; panel.remove(); retry.onclick = recover.onclick = null; originalDispose(); };
  global.App.ready = initialize('ready');
})(typeof globalThis !== 'undefined' ? globalThis : window);
