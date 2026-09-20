'use strict';

const { isDeepStrictEqual } = require('node:util');
const mutable = new Set(['displayName', 'categoryId', 'subcategoryId']);
const without = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.has(key)));

// Build-time proof: identities, prompts, structure and references stay identical.
// The taxonomy variant additionally permits adult:false -> true only for a
// model-general Tag explicitly moved into nsfw. User overrides remain separate.
function updateRecord(previous, next, taxonomyOnly) {
  if (previous.fingerprint === next.fingerprint) return null;
  const unchangedFields = new Set(['tags', 'fingerprint']);
  if (!isDeepStrictEqual(without(previous, unchangedFields), without(next, unchangedFields))) throw new Error('内置元数据更新不能修改分类定义、关系或来源映射');
  if (previous.tags.length !== next.tags.length) throw new Error('内置元数据更新不能增删标签');
  let count = 0; const previousTaxonomy = [];
  for (let index = 0; index < previous.tags.length; index++) {
    const before = previous.tags[index], after = next.tags[index];
    const adultClassification = taxonomyOnly && before.categoryId === 'wd_general' && before.usages.includes('general') && before.adult === false && after.adult === true && after.categoryId === 'nsfw';
    const fields = adultClassification ? new Set([...mutable, 'adult']) : mutable;
    if (!isDeepStrictEqual(without(before, fields), without(after, fields))) throw new Error(`内置元数据更新不能改写原文或标签身份：${before.id}`);
    if (!isDeepStrictEqual(before, after)) count++;
    if (before.categoryId !== after.categoryId || before.subcategoryId !== after.subcategoryId) previousTaxonomy.push({ tagId: before.id, categoryId: before.categoryId, subcategoryId: before.subcategoryId });
  }
  return { kind: taxonomyOnly ? 'taxonomy-only' : 'metadata-only', from: previous.fingerprint, to: next.fingerprint, changedTags: count, previousTaxonomy };
}
const metadataUpdateRecord = (previous, next) => updateRecord(previous, next, false);
const taxonomyUpdateRecord = (previous, next) => updateRecord(previous, next, true);

function prepareBaseUpdate(document, fingerprint, updates) {
  if (document.baseFingerprint === fingerprint) return null;
  const known = updates.find(row => ['metadata-only', 'taxonomy-only'].includes(row.kind) && row.from === document.baseFingerprint && row.to === fingerprint);
  if (!known) return null;
  const candidate = { ...structuredClone(document), baseFingerprint: fingerprint, revision: document.revision + 1 };
  const previousTaxonomy = new Map((known.previousTaxonomy || []).map(row => [row.tagId, row]));
  for (const override of candidate.tagOverrides) {
    const previous = previousTaxonomy.get(override.tagId);
    if (previous && (Object.hasOwn(override.patch, 'categoryId') || Object.hasOwn(override.patch, 'subcategoryId'))) {
      override.patch = { categoryId: previous.categoryId, subcategoryId: previous.subcategoryId, ...override.patch };
    }
  }
  return candidate;
}

module.exports = { metadataUpdateRecord, taxonomyUpdateRecord, prepareBaseUpdate };
