'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { normalizeState, transitionState } = require('./version-manager');

function text(value, fallback = '') { const output = value == null ? '' : String(value).trim(); return output || fallback; }
function failure(code, message) { return Object.assign(new Error(message), { code }); }
function createDefaultWaitForExit() {
  return async pid => {
    if (!pid) return;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      try { process.kill(Number(pid), 0); } catch { return; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw failure('PARENT_STILL_RUNNING', '旧版本进程未退出');
  };
}

function createUpdateHost(options = {}) {
  const rootDir = path.resolve(text(options.rootDir, path.dirname(process.execPath)));
  const readState = options.readState || (async () => JSON.parse(await fs.promises.readFile(path.join(rootDir, 'version-state.json'), 'utf8')));
  const writeState = options.writeState || (async value => {
    const filename = path.join(rootDir, 'version-state.json');
    const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
    await fs.promises.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
    await fs.promises.rename(temporary, filename);
  });
  const waitForExit = options.waitForExit || createDefaultWaitForExit();
  const exists = options.exists || (async value => fs.existsSync(value));
  const rename = options.rename || ((from, to) => fs.promises.rename(from, to));
  const readBuildInfo = options.readBuildInfo || (async value => JSON.parse(await fs.promises.readFile(path.join(value, 'build-info.json'), 'utf8')));
  const launch = options.launch || (async (executable, args = []) => { const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: true }); child.unref(); });
  async function run(input = {}) {
    const current = normalizeState(await readState(), rootDir), target = current.pendingVersion;
    if (!target) return current;
    try {
      await waitForExit(input.parentPid);
      if (current.pendingDirectory) {
        const source = path.resolve(rootDir, current.pendingDirectory), destination = path.resolve(rootDir, `versions/V${target}`);
        if (!await exists(source)) throw failure('STAGING_NOT_FOUND', '待切换的版本目录不存在');
        if (await exists(destination)) throw failure('VERSION_ALREADY_EXISTS', '目标版本目录已存在');
        await fs.promises.mkdir(path.dirname(destination), { recursive: true });
        await rename(source, destination);
      }
      const directory = path.join(rootDir, `versions/V${target}`), buildInfo = await readBuildInfo(directory);
      if (text(buildInfo?.version) !== target) throw failure('PACKAGE_INVALID', '目标版本 build-info 不匹配');
      const next = transitionState({ ...current, installed: [...current.installed, { version: target, source: 'download', archiveSha256: text(buildInfo.archiveSha256), installedAt: new Date().toISOString(), lastLaunch: 'ok' }] }, { type: 'commit' });
      await writeState(next);
      await launch(input.launcherPath || path.join(rootDir, 'AI绘画Tag工具箱.exe'));
      return next;
    } catch (error) {
      const rollback = transitionState(current, { type: 'rollback', error: { code: text(error?.code, 'UPDATE_HOST_FAILED'), message: text(error?.message, '版本切换失败') } });
      await writeState(rollback).catch(() => {});
      await launch(input.launcherPath || path.join(rootDir, 'AI绘画Tag工具箱.exe')).catch(() => {});
      return rollback;
    }
  }
  return Object.freeze({ run });
}

module.exports = { createUpdateHost };
