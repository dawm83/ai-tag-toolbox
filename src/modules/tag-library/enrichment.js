'use strict';

// Build-time only. The caller computes the seed fingerprint after enrichment.
const bundledCoverage = require('../../../assets/数据资产/标签/tag-enrichment.json');
const hasHan = value => /\p{Script=Han}/u.test(value);
const blank = value => !value.trim();
const hasUsage = (tag, usage) => tag.usages.includes(usage);
const fields = ['displayName', 'categoryId', 'subcategoryId'];
const coarseCategories = new Set(['wd_general', 'other', 'character_specific']);
const coarseSubcategories = new Set(['默认', '其他', '角色专属词']);

function normalizeContent(value) {
  return value.normalize('NFKC').toLowerCase().replace(/[ _]+/g, ' ').replace(/^ +| +$/g, '');
}
function indexBy(rows, keyOf) {
  const index = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(row);
  }
  return index;
}
function uniqueValue(values) {
  const unique = new Set(values);
  return unique.size === 1 ? unique.values().next().value : undefined;
}
// structuredClone drops null prototypes used by the seed's ID dictionaries.
function cloneSeed(value) {
  if (Array.isArray(value)) return value.map(cloneSeed);
  if (value === null || typeof value !== 'object') return value;
  const copy = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneSeed(item)]));
  return Object.setPrototypeOf(copy, Object.getPrototypeOf(value));
}
function fallbackName(tag) {
  return blank(tag.displayName) || (!hasHan(tag.displayName) && normalizeContent(tag.displayName) === normalizeContent(tag.content));
}
function parentheticals(content) {
  const parts = []; let start = -1, depth = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '(') { if (depth === 0) start = i; depth++; }
    if (content[i] === ')') {
      if (!depth) return [];
      depth--;
      if (!depth) parts.push({ start, end: i + 1, value: content.slice(start + 1, i) });
    }
  }
  return depth ? [] : parts;
}
function costumeName(value, qualifiers) {
  if (qualifiers.has(value)) return qualifiers.get(value);
  const match = /^([1-9]\d?)(st|nd|rd|th) costume$/.exec(value);
  if (!match) return undefined;
  const n = Number(match[1]), last = n % 10;
  const ordinal = n % 100 >= 11 && n % 100 <= 13 ? 'th' : last === 1 ? 'st' : last === 2 ? 'nd' : last === 3 ? 'rd' : 'th';
  return match[2] === ordinal ? `第${n}套服装` : undefined;
}

/** Pure adapter for validated bundled JSON. Only names and existing taxonomy assignments change. */
function enrichBundledTags(input, coverage = bundledCoverage) {
  const base = cloneSeed(input), changed = new Map();
  const counts = { displayNameChanged: 0, categoryChanged: 0, subcategoryChanged: 0, exactTranslated: 0, exactClassified: 0, curatedTranslated: 0, curatedClassified: 0, roleVariants: 0, specificTranslated: 0, conflicts: { exactName: 0, exactCategory: 0, curatedName: 0, curatedCategory: 0, characterVariant: 0 } };
  const tagsById = new Map(base.tags.map(tag => [tag.id, tag]));
  const subsById = new Map(base.subcategories.map(sub => [sub.id, sub]));
  const subsByName = indexBy(base.subcategories, sub => JSON.stringify([sub.categoryId, sub.name]));
  const linksByTag = indexBy(base.characterLinks, link => link.identityTagId);
  const seriesFor = tag => [...new Set((linksByTag.get(tag.id) || []).flatMap(link => link.seriesTagIds))].sort();
  const seriesKeyFor = tag => {
    const series = seriesFor(tag);
    return series.length ? JSON.stringify(series) : null;
  };
  const isCoarse = tag => coarseCategories.has(tag.categoryId) && coarseSubcategories.has(subsById.get(tag.subcategoryId)?.name);
  const ordinary = tag => hasUsage(tag, 'general') && !hasUsage(tag, 'characterIdentity') && !hasUsage(tag, 'seriesIdentity');
  function apply(tag, patch, rule, sourceKeys = []) {
    const differences = Object.keys(patch).filter(field => tag[field] !== patch[field]);
    if (!differences.length) return;
    if (!changed.has(tag.id)) changed.set(tag.id, { tagId: tag.id, before: Object.fromEntries(fields.map(field => [field, tag[field]])), after: null, rules: [], sourceKeys: [] });
    const change = changed.get(tag.id);
    change.rules.push(rule); change.sourceKeys.push(...sourceKeys);
    for (const field of differences) tag[field] = patch[field];
    if (differences.includes('displayName')) {
      counts[rule === 'exact-content' ? 'exactTranslated' : rule === 'character-costume' ? 'roleVariants' : 'curatedTranslated']++;
    }
    if (differences.includes('categoryId') || differences.includes('subcategoryId')) counts[rule === 'exact-content' ? 'exactClassified' : 'curatedClassified']++;
  }

  // Snapshot donors before any edits so row order cannot influence exact-content decisions.
  const donorsByContent = indexBy(input.tags.filter(ordinary), tag => normalizeContent(tag.content));
  for (const tag of base.tags.filter(ordinary)) {
    const donors = (donorsByContent.get(normalizeContent(tag.content)) || []).filter(donor => donor.id !== tag.id);
    const patch = {}, sources = [];
    if (blank(tag.displayName)) {
      const named = donors.filter(donor => hasHan(donor.displayName));
      const name = uniqueValue(named.map(donor => donor.displayName));
      if (name !== undefined) { patch.displayName = name; sources.push(...named.map(donor => donor.id)); }
      else if (named.length) counts.conflicts.exactName++;
    }
    if (isCoarse(tag)) {
      const classified = donors.filter(donor => !coarseCategories.has(donor.categoryId) && subsById.get(donor.subcategoryId)?.categoryId === donor.categoryId);
      const placement = uniqueValue(classified.map(donor => JSON.stringify([donor.categoryId, donor.subcategoryId])));
      if (placement !== undefined) { [patch.categoryId, patch.subcategoryId] = JSON.parse(placement); sources.push(...classified.map(donor => donor.id)); }
      else if (classified.length) counts.conflicts.exactCategory++;
    }
    apply(tag, patch, 'exact-content', sources);
  }

  const entriesByContent = indexBy(coverage.entries || [], entry => normalizeContent(entry.content));
  for (const tag of base.tags) {
    const entries = (entriesByContent.get(normalizeContent(tag.content)) || []).filter(entry => {
      if (!hasUsage(tag, entry.usage)) return false;
      if (entry.usage !== 'characterIdentity') return true;
      if (!entry.seriesContent) return false;
      return seriesFor(tag).some(id => tagsById.has(id) && normalizeContent(tagsById.get(id).content) === normalizeContent(entry.seriesContent));
    });
    if (!entries.length) continue;
    const patch = {};
    if (hasUsage(tag, 'characterIdentity') ? fallbackName(tag) : blank(tag.displayName)) {
      const names = entries.filter(entry => hasHan(entry.displayName));
      const name = uniqueValue(names.map(entry => entry.displayName));
      if (name !== undefined) patch.displayName = name;
      else if (names.length) counts.conflicts.curatedName++;
    }
    if (isCoarse(tag)) {
      const placements = entries.filter(entry => entry.categoryId && entry.subcategoryName).map(entry => {
        const subs = subsByName.get(JSON.stringify([entry.categoryId, entry.subcategoryName])) || [];
        return subs.length === 1 ? JSON.stringify([entry.categoryId, subs[0].id]) : null;
      }).filter(Boolean);
      const placement = uniqueValue(placements);
      if (placement !== undefined) [patch.categoryId, patch.subcategoryId] = JSON.parse(placement);
      else if (placements.length) counts.conflicts.curatedCategory++;
    }
    apply(tag, patch, 'curated', entries.map(entry => `${entry.usage}:${entry.content}`));
  }

  const qualifiers = new Map(Object.entries(coverage.qualifiers || {}).map(([en, zh]) => [normalizeContent(en), zh]));
  const identities = base.tags.filter(tag => hasUsage(tag, 'characterIdentity'));
  const namedIdentities = indexBy(identities.filter(tag => hasHan(tag.displayName)), tag => normalizeContent(tag.content));
  for (const tag of identities) {
    if (!fallbackName(tag)) continue;
    const content = normalizeContent(tag.content), series = seriesKeyFor(tag);
    if (!series) continue;
    const parts = parentheticals(content).map(part => ({ ...part, label: costumeName(part.value, qualifiers) })).filter(part => part.label);
    // Multiple costume qualifiers could require recursive inference. Keep those unresolved.
    if (parts.length !== 1) continue;
    const part = parts[0], stem = normalizeContent(content.slice(0, part.start) + content.slice(part.end));
    const donors = (namedIdentities.get(stem) || []).filter(donor => seriesKeyFor(donor) === series);
    const name = uniqueValue(donors.map(donor => donor.displayName));
    if (name !== undefined) apply(tag, { displayName: `${name}（${part.label}）` }, 'character-costume', donors.map(donor => donor.id));
    else if (donors.length) counts.conflicts.characterVariant++;
  }

  const changes = [...changed.values()].map(change => {
    const tag = tagsById.get(change.tagId);
    change.after = Object.fromEntries(fields.map(field => [field, tag[field]]));
    change.rules = [...new Set(change.rules)]; change.sourceKeys = [...new Set(change.sourceKeys)].sort();
    for (const field of fields) if (change.before[field] !== change.after[field]) counts[field === 'categoryId' ? 'categoryChanged' : field === 'subcategoryId' ? 'subcategoryChanged' : 'displayNameChanged']++;
    if (hasUsage(tag, 'characterSpecific') && change.before.displayName !== change.after.displayName) counts.specificTranslated++;
    return change;
  });
  counts.remaining = {
    emptyDisplayNames: base.tags.filter(tag => blank(tag.displayName)).length,
    modelEmptyDisplayNames: base.tags.filter(tag => tag.source.key?.startsWith('model:') && blank(tag.displayName)).length,
    characterEmptyDisplayNames: identities.filter(tag => blank(tag.displayName)).length,
    characterNamesWithoutHan: identities.filter(tag => !hasHan(tag.displayName)).length,
    specificEmptyDisplayNames: base.tags.filter(tag => hasUsage(tag, 'characterSpecific') && blank(tag.displayName)).length
  };
  return { base, changes, counts };
}

module.exports = { enrichBundledTags, normalizeContent };
