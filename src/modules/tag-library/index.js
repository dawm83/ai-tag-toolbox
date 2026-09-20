'use strict';

// Runtime-safe entry: build-time seed/legacy loaders are deliberately not imported here.
const schema = require('./schema');
let bundled;
function loadBundledBase(options = {}) {
  if (!bundled) bundled = schema.createLibraryDocumentValidator(require('../../../assets/数据资产/标签/unified-tag-base.json'));
  if (!bundled.ok) return bundled;
  // Production shares the validated immutable seed. Build/test callers retain
  // the existing independently editable copy contract by default.
  return { ok: true, data: options.shared === true ? bundled.base : structuredClone(bundled.base), baseUpdates: structuredClone(require('../../../assets/数据资产/标签/unified-tag-updates.json')) };
}
module.exports = { ...schema, createTagSearchIndex: require('./search').createTagSearchIndex, ...require('./library'), ...require('./commands'), ...require('./selection'), ...require('./repository'), ...require('./migration'), ...require('./transfer'), ...require('./tag-adapter'), ...require('./favorite-adapter'), loadBundledBase };
