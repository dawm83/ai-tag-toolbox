'use strict';

// Build-time exact assignments. Model category 0 describes provenance, not the
// UI taxonomy. This adapter never changes raw prompts or identity/reference IDs.
const bundled = require('../../../assets/数据资产/标签/wd-general-taxonomy.json');
function classifyWdGeneral(input, coverage = bundled) {
  const base = { ...input, tags: input.tags.map(tag => ({ ...tag })) };
  const byId = new Map(base.tags.map(tag => [tag.id, tag]));
  const seen = new Set(), changes = [], counts = {};
  for (const group of coverage.groups) {
    if (group.adult !== undefined && (group.adult !== true || group.categoryId !== 'nsfw')) throw new Error('成人标记只能用于已复核成人分类');
    const targets = group.tagIds.map(id => {
      if (seen.has(id)) throw new Error(`重复分类：${id}`);
      seen.add(id); return byId.get(id);
    }).filter(tag => tag?.categoryId === 'wd_general' && tag.usages.includes('general'));
    if (!targets.length) continue;
    const subcategories = base.subcategories.filter(sub => sub.categoryId === group.categoryId && sub.name === group.subcategoryName);
    if (subcategories.length !== 1) throw new Error(`分类目标不存在或不唯一：${group.categoryId} / ${group.subcategoryName}`);
    for (const tag of targets) {
      const before = { categoryId: tag.categoryId, subcategoryId: tag.subcategoryId, adult: tag.adult };
      tag.categoryId = group.categoryId; tag.subcategoryId = subcategories[0].id;
      if (group.adult === true) tag.adult = true;
      changes.push({ tagId: tag.id, before, after: { categoryId: tag.categoryId, subcategoryId: tag.subcategoryId, adult: tag.adult } });
      counts[group.categoryId] = (counts[group.categoryId] || 0) + 1;
    }
  }
  return { base, changes, counts };
}
module.exports = { classifyWdGeneral };
