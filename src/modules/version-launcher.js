'use strict';

const path = require('node:path');

function text(value) { return value == null ? '' : String(value).trim(); }
function version(value) { const raw = text(value).replace(/^v/i, ''); return /^\d+\.\d+\.\d+$/.test(raw) ? raw : ''; }
function failure(code, message) { return Object.assign(new Error(message), { code }); }

function resolveActiveExecutable(rootDir, state = {}) {
  const active = version(state.activeVersion);
  if (!active) throw failure('INVALID_VERSION', '当前版本状态无效');
  return path.join(path.resolve(rootDir), 'versions', `V${active}`, `AI绘画Tag工具箱V${active}.exe`);
}

module.exports = { resolveActiveExecutable };
