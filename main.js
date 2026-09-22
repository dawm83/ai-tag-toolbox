'use strict';

const { app, BrowserWindow, shell } = require('electron');
const path = require('node:path');
function openExternalUrl(url) {
  try {
    const parsed = new URL(String(url));
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    shell.openExternal(parsed.toString()).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

function isSponsorUrl(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === 'https:'
      && parsed.hostname.toLowerCase() === 'ifdian.net'
      && parsed.pathname.replace(/\/+$/, '').toLowerCase() === '/a/ai-tag-toolbox';
  } catch {
    return false;
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    title: 'AI 绘画 Tag 工具箱 V1.4.344',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.setMenuBarVisibility(false);
  // Window chrome owns maximization state; the renderer only receives a
  // presentation class, including after a reload while already maximized.
  function syncMaximizedLayout() {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return;
    const maximized = win.isMaximized();
    win.webContents.executeJavaScript(`document.documentElement.classList.toggle('window-maximized', ${maximized}); window.dispatchEvent(new Event('resize'));`)
      .catch(() => {});
  }
  win.on('maximize', syncMaximizedLayout);
  win.on('unmaximize', syncMaximizedLayout);
  win.webContents.on('dom-ready', syncMaximizedLayout);
  // The sponsor page opens in the user's default browser. Other target=_blank
  // links (for example generated image previews) keep their existing Electron
  // behavior, while non-http URLs are never forwarded to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSponsorUrl(url)) {
      openExternalUrl(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL() && isSponsorUrl(url) && openExternalUrl(url)) event.preventDefault();
  });
  let closeReady = false;
  let savingBeforeClose = false;
  win.on('close', event => {
    if (closeReady || win.webContents.isDestroyed()) return;
    event.preventDefault();
    if (savingBeforeClose) return;
    savingBeforeClose = true;
    win.webContents.executeJavaScript('window.App?.flushBeforeClose ? window.App.flushBeforeClose() : window.AppModules?.prepareClose?.()')
      .catch(() => false)
      .then(saved => {
        if (saved === false) { savingBeforeClose = false; return; }
        closeReady = true; if (!win.isDestroyed()) win.close();
      });
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  return win;
}

const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
else {
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
});
app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
}


