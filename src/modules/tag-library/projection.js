'use strict';

// Internal views share immutable base records. Public getters clone only their result.
const bases = new WeakMap();
const clone = value => structuredClone(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function baseIndex(base) {
  if (bases.has(base)) return bases.get(base);
  const index = {
    tags: new Map(base.tags.map(row => [row.id, row])),
    characters: new Map(base.characterLinks.map(row => [row.characterId, row])),
    categories: new Map(base.categories.map(row => [row.id, row])),
    subcategories: new Map(base.subcategories.map(row => [row.id, row]))
  };
  index.characterUses = new Map();
  for (const row of index.characters.values()) for (const id of new Set([row.identityTagId, ...row.seriesTagIds, ...row.generalTagIds, ...row.specificTagIds])) {
    if (!index.characterUses.has(id)) index.characterUses.set(id, []); index.characterUses.get(id).push(row.characterId);
  }
  if (Object.isFrozen(base)) bases.set(base, index);
  return index;
}
function merge(base, custom, overrides = [], key = 'id') {
  if (!custom.length && !overrides.length) return base;
  const map = new Map(base);
  for (const row of custom) map.set(row[key], row);
  for (const row of overrides) map.set(row[key], { ...map.get(row[key]), ...row });
  return map;
}
function createProjection(document, base) {
  const index = baseIndex(base);
  const custom = new Map(document.customTags.map(row => [row.id, row]));
  const overrides = new Map(document.tagOverrides.map(row => [row.tagId, row]));
  const characters = merge(index.characters, document.characterOverrides, [], 'characterId');
  const categories = merge(index.categories, document.customCategories, document.categoryOverrides);
  const subcategories = merge(index.subcategories, document.customSubcategories, document.subcategoryOverrides);
  const pages = new Map(document.favoritePages.map(row => [row.id, row]));
  const groups = new Map(document.favoriteGroups.map(row => [row.id, row]));
  const memberships = new Map(); const characterUses = document.characterOverrides.length ? new Map(index.characterUses) : index.characterUses;
  for (const row of document.memberships) { if (!memberships.has(row.tagId)) memberships.set(row.tagId, []); memberships.get(row.tagId).push(row); }
  // Copy only reverse-index buckets touched by an overridden role; immutable
  // base buckets and unchanged relations are shared across every projection.
  for (const row of document.characterOverrides) {
    const old = index.characters.get(row.characterId);
    const beforeIds = old ? [old.identityTagId, ...old.seriesTagIds, ...old.generalTagIds, ...old.specificTagIds] : [];
    const afterIds = [row.identityTagId, ...row.seriesTagIds, ...row.generalTagIds, ...row.specificTagIds];
    for (const id of new Set([...beforeIds, ...afterIds])) {
      const uses = (characterUses.get(id) || []).filter(characterId => characterId !== row.characterId);
      if (afterIds.includes(id)) uses.push(row.characterId);
      characterUses.set(id, uses);
    }
  }
  function tag(id) {
    const record = custom.get(id) || index.tags.get(id); if (!record) return null;
    const override = overrides.get(id);
    return override ? { ...record, ...override.patch, revision: override.revision, updatedAt: override.updatedAt } : record;
  }
  function view(id) {
    const record = tag(id); if (!record) return null;
    const locations = (memberships.get(id) || []).map(m => {
      const group = groups.get(m.groupId), page = pages.get(group.pageId);
      return { membershipId: m.id, pageId: page.id, pageName: page.name, groupId: group.id, groupName: group.name };
    });
    return { ...record, favorite: locations.length > 0, favoriteLocations: locations };
  }
  function references(id) {
    const result = (memberships.get(id) || []).map(m => ({ kind: 'favorite', id: m.id, label: groups.get(m.groupId).name }));
    for (const characterId of characterUses.get(id) || []) result.push({ kind: 'character', id: characterId, label: tag(characters.get(characterId).identityTagId)?.displayName || characterId });
    for (const s of document.selection) {
      const character = s.kind === 'character' ? characters.get(s.characterId) : null;
      const ids = s.kind === 'tag' ? [s.tagId] : character ? [character.identityTagId, ...(s.includeSeries ? character.seriesTagIds : []), ...s.generalTagIds, ...s.specificTagIds] : [];
      if (ids.includes(id)) result.push({ kind: 'selection', id: s.tagId || s.characterId, label: s.kind });
    }
    return result;
  }
  return { tag, view, references, characters, categories, subcategories, pages, groups, memberships, characterUses,
    *tags() { for (const id of index.tags.keys()) yield tag(id); for (const id of custom.keys()) yield tag(id); } };
}
module.exports = { clone, equal, baseIndex, createProjection };
