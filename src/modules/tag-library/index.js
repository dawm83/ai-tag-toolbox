'use strict';

// Runtime-safe entry: build-time seed/legacy loaders are deliberately not imported here.
const schema = require('./schema');
const fs = require('node:fs');
const path = require('node:path');
let bundled;
function loadBundledBase(options = {}) {
  if (!bundled) {
    // This JSON is exclusively owned here, so validation can freeze it directly
    // instead of cloning a second copy of the complete character catalogue.
    const base = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../assets/数据资产/标签/unified-tag-base.json'), 'utf8'));
    bundled = schema.createLibraryDocumentValidator(base, { takeOwnership: true });
  }
  if (!bundled.ok) return bundled;
  // Production shares the validated immutable seed. Build/test callers retain
  // the existing independently editable copy contract by default.
  return { ok: true, data: options.shared === true ? bundled.base : structuredClone(bundled.base), baseUpdates: structuredClone(require('../../../assets/数据资产/标签/unified-tag-updates.json')) };
}
module.exports = { ...schema, createTagSearchIndex: require('./search').createTagSearchIndex, ...require('./library'), ...require('./commands'), ...require('./selection'), ...require('./repository'), ...require('./migration'), ...require('./transfer'), ...require('./tag-adapter'), ...require('./favorite-adapter'), loadBundledBase };
