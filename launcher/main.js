'use strict';

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function version(value) { const raw = String(value || '').trim().replace(/^v/i, ''); return /^\d+\.\d+\.\d+$/.test(raw) ? raw : ''; }

function installRoot() { return path.dirname(process.execPath); }
async function main() {
  const root = installRoot();
  const state = JSON.parse(await fs.promises.readFile(path.join(root, 'version-state.json'), 'utf8'));
  const active = version(state.activeVersion);
  if (!active) throw new Error('当前版本状态无效');
  const executable = path.join(root, 'versions', `V${active}`, `AI绘画Tag工具箱V${active}.exe`);
  if (!fs.existsSync(executable)) throw new Error('当前版本槽位不存在');
  const child = spawn(executable, ['--launched-by-version-host', `--update-root=${root}`], { cwd: path.dirname(executable), detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  app.quit();
}

app.whenReady().then(main).catch(() => app.quit());
