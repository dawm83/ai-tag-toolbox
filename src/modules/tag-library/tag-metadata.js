'use strict';

const { normalize } = require('./search');
const exactKey = value => String(value).normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
const detailed = category => category && category !== 'other' && !category.startsWith('wd_');
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
function inputText(row) { return typeof row === 'string' ? row : String(row?.tag ?? row?.en ?? row?.name ?? row?.content ?? ''); }
function consensus(values) {
  const unique = [...new Set(values)];
  return { value: unique.length === 1 ? unique[0] : '', ambiguous: unique.length > 1 };
}

// Presentation-only matching. Removing all spaces is useful for search, but is
// deliberately not an equivalence rule for names, categories or stored IDs.
function createTagMetadataResolver({ getTags, getOverrides, isReady }) {
  let exact = null, equivalent = null, overrides = null;
  function ensure() {
    if (exact || !isReady()) return;
    exact = new Map(); equivalent = new Map();
    overrides = new Map(getOverrides().map(row => [row.tagId, row.patch]));
    for (const tag of getTags()) {
      if (tag.kind !== 'tag') continue;
      for (const [map, key] of [[exact, exactKey(tag.content)], [equivalent, normalize(tag.content)]]) {
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(tag);
      }
    }
  }
  function describe(inputs, options = {}) {
    ensure();
    return (Array.isArray(inputs) ? inputs : []).map(input => {
      const rawText = inputText(input);
      const rawProbability = typeof input === 'object' && input ? input.prob ?? input.probability ?? input.confidence : null;
      const probability = typeof rawProbability === 'number' && Number.isFinite(rawProbability) ? rawProbability : null;
      const allowed = row => options.includeAdult === true || !row.adult;
      const direct = (exact?.get(exactKey(rawText)) || []).filter(allowed);
      const candidates = (equivalent?.get(normalize(rawText)) || []).filter(allowed);
      const target = direct.length === 1 ? direct[0] : null;
      const independent = target && target.source.kind !== 'bundled';
      const patch = target ? overrides?.get(target.id) : null;
      const name = target && (independent || own(patch, 'displayName') || target.displayName)
        ? { value: target.displayName, ambiguous: false }
        : consensus(candidates.map(row => row.displayName).filter(Boolean));
      const fixedCategory = target && (independent || own(patch, 'categoryId') || own(patch, 'subcategoryId') || detailed(target.categoryId));
      const taxonomy = fixedCategory
        ? { value: JSON.stringify([target.categoryId, target.subcategoryId]), ambiguous: false }
        : consensus(candidates.filter(row => detailed(row.categoryId)).map(row => JSON.stringify([row.categoryId, row.subcategoryId])));
      const [categoryId, subcategoryId] = taxonomy.value ? JSON.parse(taxonomy.value) : ['', ''];
      return {
        rawText, tagId: target?.id || (candidates.length === 1 ? candidates[0].id : ''),
        displayName: name.value, categoryId, subcategoryId, probability,
        match: direct.length ? 'exact' : candidates.length ? 'equivalent' : 'unknown',
        ambiguous: direct.length > 1 || name.ambiguous || taxonomy.ambiguous
      };
    });
  }
  function invalidate(change) {
    if (!change || change.changedTagIds?.length) { exact = null; equivalent = null; overrides = null; }
  }
  return { describe, invalidate };
}

module.exports = { createTagMetadataResolver };
