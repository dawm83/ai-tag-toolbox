'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveActiveExecutable } = require('../src/modules/version-launcher');

test('resolves only the active version slot under the install root', () => {
  assert.equal(resolveActiveExecutable('C:\\Install', { activeVersion: '1.4.354' }), 'C:\\Install\\versions\\V1.4.354\\AI绘画Tag工具箱V1.4.354.exe');
  assert.throws(() => resolveActiveExecutable('C:\\Install', { activeVersion: '../outside' }), error => error.code === 'INVALID_VERSION');
});
