'use strict';

// Runtime-safe entry: build-time seed/legacy loaders are deliberately not imported here.
const schema = require('./schema');
function loadBundledBase() {
  const base = require('../../../assets/数据资产/标签/unified-tag-base.json');
  const result = schema.validateBase(base);
  if (!result.ok) return result;
  // Callers receive their own working copy, never Node's shared JSON module cache.
  return { ok: true, data: structuredClone(base) };
}
module.exports = { ...schema, createTagSearchIndex: require('./search').createTagSearchIndex, ...require('./library'), ...require('./commands'), ...require('./selection'), ...require('./repository'), ...require('./migration'), ...require('./transfer'), ...require('./tag-adapter'), ...require('./favorite-adapter'), loadBundledBase };
