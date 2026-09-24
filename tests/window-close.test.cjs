'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

async function boot(flush, primary = true) {
  const app = new EventEmitter();
  const windows = [];
  let exited = false;
  const event = () => ({ defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
  app.whenReady = () => Promise.resolve();
  app.requestSingleInstanceLock = () => primary;
  app.quit = () => {
    const attempt = event(); app.emit('before-quit', attempt);
    if (attempt.defaultPrevented) return;
    for (const win of [...windows]) win.close();
    if (!windows.length) exited = true;
  };
  class BrowserWindow extends EventEmitter {
    static getAllWindows() { return [...windows]; }
    constructor() {
      super(); windows.push(this);
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.executeJavaScript = flush;
      this.webContents.isDestroyed = () => !windows.includes(this);
    }
    setMenuBarVisibility() {}
    loadFile() {}
    isMinimized() { return this.minimized === true; }
    isMaximized() { return this.maximized === true; }
    restore() { this.minimized = false; this.restored = true; }
    show() { this.shown = true; }
    focus() { this.focused = true; }
    isDestroyed() { return !windows.includes(this); }
    close() {
      const attempt = event(); this.emit('close', attempt);
      if (attempt.defaultPrevented) return;
      const index = windows.indexOf(this);
      if (index < 0) return;
      windows.splice(index, 1); this.emit('closed');
      if (!windows.length) app.emit('window-all-closed');
    }
  }
  const root = path.resolve(__dirname, '..');
  vm.runInNewContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), {
    require: name => name === 'electron' ? { app, BrowserWindow, shell: {} } : require(name),
    __dirname: root, process: { platform: 'win32' }, URL, console
  });
  await Promise.resolve();
  return { app, windows, win: windows[0], exited: () => exited };
}

for (const action of ['close', 'quit']) test(`${action} waits for persistence before destroying the last window`, async () => {
  let finish;
  let calls = 0;
  const saving = new Promise(resolve => { finish = resolve; });
  const host = await boot(() => { calls += 1; return saving; });
  if (action === 'close') host.win.close(); else host.app.quit();
  assert.equal(host.win.isDestroyed(), false);
  assert.equal(calls, 1);
  host.win.close();
  assert.equal(calls, 1, 'repeated close must share the in-flight save');
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.win.isDestroyed(), true);
  assert.equal(host.exited(), true);
});

test('a failed save keeps the window open and a later close can retry', async () => {
  let success = false;
  const host = await boot(() => Promise.resolve(success));
  host.win.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.win.isDestroyed(), false);
  success = true;
  host.win.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.win.isDestroyed(), true);
});

test('a rejected renderer save keeps the window open until a successful retry', async () => {
  let repaired = false;
  const host = await boot(() => repaired ? Promise.resolve(true) : Promise.reject(new Error('save rejected')));
  host.win.close(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.win.isDestroyed(), false);
  repaired = true; host.win.close(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.win.isDestroyed(), true);
});

test('secondary instance exits without a window and primary activates its existing window', async () => {
  const secondary = await boot(async () => true, false);
  assert.equal(secondary.windows.length, 0); assert.equal(secondary.exited(), true);
  const primary = await boot(async () => true);
  primary.win.minimized = true; primary.app.emit('second-instance');
  assert.equal(primary.windows.length, 1);
  assert.equal(primary.win.restored, true); assert.equal(primary.win.shown, true); assert.equal(primary.win.focused, true);
  primary.win.close(); await new Promise(resolve => setImmediate(resolve));
});

test('shows the business window immediately after starting navigation', async () => {
  const host = await boot(async () => true);
  assert.equal(host.win.shown, true);
  host.win.close(); await new Promise(resolve => setImmediate(resolve));
});

test('maximized layout follows maximize, restore and renderer reload', async () => {
  const classes = new Set(); let resizes = 0;
  const renderer = vm.createContext({
    document: { documentElement: { classList: { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); } } } },
    Event: class Event { constructor(type) { this.type = type; } },
    window: { dispatchEvent(event) { if (event.type === 'resize') resizes++; } }
  });
  const host = await boot(script => { vm.runInContext(script, renderer); return Promise.resolve(); });
  host.win.webContents.emit('dom-ready');
  assert.equal(classes.has('window-maximized'), false);
  host.win.maximized = true; host.win.emit('maximize');
  assert.equal(classes.has('window-maximized'), true);
  classes.clear(); host.win.webContents.emit('dom-ready');
  assert.equal(classes.has('window-maximized'), true, 'reload must restore the current window layout');
  host.win.maximized = false; host.win.emit('unmaximize');
  assert.equal(classes.has('window-maximized'), false);
  assert.equal(resizes, 4, 'AI tab indicator should be measured after each layout switch');
});
