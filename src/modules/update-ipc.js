'use strict';

function failure(code, message) { return Object.assign(new Error(message), { code }); }
function publicUpdateError(error) {
  if (error?.code === 'NETWORK_TIMEOUT' || error?.code === 'ECONNRESET' || error?.code === 'ENETUNREACH') return failure('UPDATE_OFFLINE', '暂时无法连接 GitHub，请检查网络后重试。');
  if (error?.code === 'HTTP_ERROR') return failure('UPDATE_SERVICE_ERROR', 'GitHub 版本服务暂时不可用，请稍后重试。');
  return error;
}

function registerUpdateIpc(options = {}) {
  const ipcMain = options.ipcMain;
  const service = options.service;
  if (!ipcMain || typeof ipcMain.handle !== 'function' || !service) throw failure('UPDATE_IPC_INVALID', '版本更新桥接依赖缺失');
  const handlers = new Map();
  const register = (name, handler) => { handlers.set(name, handler); ipcMain.handle(name, handler); };
  register('updates:get-state', async () => service.getState());
  register('updates:list', async () => { try { return await service.listReleases(); } catch (error) { throw publicUpdateError(error); } });
  register('updates:download', async (event, version) => service.downloadAndStage(version, {
    onProgress: value => { try { event?.sender?.send?.('updates:event', { type: 'progress', ...value }); } catch {} }
  }));
  register('updates:cancel', async () => service.cancelDownload?.() !== false);
  register('updates:prepare-switch', async (_event, version, stagedDirectory = '') => service.prepareSwitch(version, stagedDirectory));
  register('updates:apply-staged', async (_event, version, stagedDirectory = '') => {
    const ready = await (options.prepareClose ? options.prepareClose() : true);
    if (ready === false) throw failure('PERSISTENCE_BLOCKED', '当前有未保存内容，暂时不能切换版本');
    const state = await service.prepareSwitch(version, stagedDirectory);
    await options.requestHost?.({ state, version });
    return state;
  });
  register('updates:switch-installed', async (_event, version) => {
    const ready = await (options.prepareClose ? options.prepareClose() : true);
    if (ready === false) throw failure('PERSISTENCE_BLOCKED', '当前有未保存内容，暂时不能切换版本');
    const state = await service.switchInstalled(version);
    await options.requestHost?.({ state, version });
    return state;
  });
  return () => {
    for (const name of handlers.keys()) ipcMain.removeHandler?.(name);
    handlers.clear();
  };
}

module.exports = { registerUpdateIpc };
