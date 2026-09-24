'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { normalizeState } = require('./version-manager');

function text(value) { return value == null ? '' : String(value).trim(); }
function version(value) { const raw = text(value).replace(/^v/i, ''); return /^\d+\.\d+\.\d+$/.test(raw) ? raw : ''; }
function failure(code, message) { return Object.assign(new Error(message), { code }); }

function resolveActiveExecutable(rootDir, state = {}) {
  const active = version(state.activeVersion);
  if (!active) throw failure('INVALID_VERSION', '当前版本状态无效');
  return path.join(path.resolve(rootDir), 'versions', `V${active}`, `AI绘画Tag工具箱V${active}.exe`);
}

async function launchActiveVersion(options = {}) {
  const rootDir = path.resolve(text(options.rootDir));
  const readState = options.readState || (async () => JSON.parse(await fs.promises.readFile(path.join(rootDir, 'version-state.json'), 'utf8')));
  const writeState = options.writeState || (async state => {
    const filename = path.join(rootDir, 'version-state.json'), temporary = `${filename}.${crypto.randomUUID()}.tmp`;
    await fs.promises.writeFile(temporary, JSON.stringify(state, null, 2) + '\n', 'utf8'); await fs.promises.rename(temporary, filename);
  });
  const exists = options.exists || (filename => fs.existsSync(filename));
  const startProcess = options.startProcess || ((executable, args) => { const child = spawn(executable, args, { cwd: path.dirname(executable), detached: true, stdio: 'ignore', windowsHide: true }); child.unref(); return child; });
  const waitForReady = options.waitForReady || (async (nonce, version) => {
    const until = Date.now() + 60_000;
    while (Date.now() < until) {
      const current = normalizeState(await readState(), rootDir);
      if (current.launchReady?.nonce === nonce && current.launchReady?.version === version) return true;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return false;
  });
  const initial = normalizeState(await readState(), rootDir);
  const launch = async (versionValue, fallbackUsed, baseState = initial) => {
    const executable = resolveActiveExecutable(rootDir, { activeVersion: versionValue });
    if (!await exists(executable)) throw failure('VERSION_MISSING', `版本槽位 V${versionValue} 不存在`);
    const nonce = (options.random || (() => crypto.randomUUID()))();
    await writeState({ ...baseState, activeVersion: versionValue, launchAttempt: { nonce, version: versionValue, startedAt: new Date().toISOString() }, launchReady: null });
    await startProcess(executable, ['--launched-by-version-host', `--update-root=${rootDir}`]);
    if (await waitForReady(nonce, versionValue)) return { ok: true, version: versionValue, nonce };
    if (fallbackUsed || !initial.previousVersion || initial.previousVersion === versionValue) throw failure('LAUNCH_TIMEOUT', `V${versionValue} 启动未就绪`);
    const rollback = { ...baseState, activeVersion: baseState.previousVersion || initial.previousVersion, pendingVersion: '', pendingDirectory: '', launchAttempt: null, launchReady: null, lastError: { code: 'LAUNCH_TIMEOUT', message: `V${versionValue} 启动未就绪，已回退` } };
    await writeState(rollback);
    return launch(rollback.activeVersion, true, rollback);
  };
  return launch(initial.activeVersion, false);
}

module.exports = { resolveActiveExecutable, launchActiveVersion };
