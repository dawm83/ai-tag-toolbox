'use strict';
const { clone, equal, createProjection } = require('./projection');

// Only affected overlay objects live in history, never a document or base snapshot.
const KEYS = Object.freeze({ customTags: 'id', tagOverrides: 'tagId', customCategories: 'id', customSubcategories: 'id', categoryOverrides: 'id', subcategoryOverrides: 'id', favoritePages: 'id', favoriteGroups: 'id', memberships: 'id', characterOverrides: 'characterId', recentTagIds: null });
function diffDocuments(before, after) {
  const changes = [];
  for (const [field, key] of Object.entries(KEYS)) {
    const old = new Map(before[field].map((row, index) => [key ? row[key] : row, { row, index }]));
    const next = new Map(after[field].map((row, index) => [key ? row[key] : row, { row, index }]));
    for (const id of new Set([...old.keys(), ...next.keys()])) {
      const a = old.get(id), b = next.get(id);
      if (equal(a?.row, b?.row)) continue;
      changes.push({ field, id, before: a ? clone(a) : null, after: b ? clone(b) : null });
    }
  }
  return changes;
}
function applyHistory(document, delta, direction) {
  const candidate = clone(document);
  for (const entry of delta) {
    const key = KEYS[entry.field], rows = candidate[entry.field];
    const index = rows.findIndex(row => (key ? row[key] : row) === entry.id);
    if (index >= 0) rows.splice(index, 1);
  }
  // Inserting in original array order restores deterministic display for equal sources.
  for (const entry of [...delta].sort((a, b) => (a[direction]?.index ?? 0) - (b[direction]?.index ?? 0))) {
    const value = entry[direction];
    if (value) candidate[entry.field].splice(Math.min(value.index, candidate[entry.field].length), 0, clone(value.row));
  }
  candidate.revision = document.revision + 1;
  return candidate;
}
function changeFor(before, after, base, delta = diffDocuments(before, after)) {
  const tags = new Set(), characters = new Set(), memberships = new Set(); let structureChanged = false;
  for (const entry of delta) {
    if (['customTags', 'tagOverrides'].includes(entry.field)) tags.add(entry.id);
    if (entry.field === 'characterOverrides') characters.add(entry.id);
    if (entry.field === 'memberships') {
      memberships.add(entry.id);
      for (const value of [entry.before, entry.after]) if (value) tags.add(value.row.tagId);
    }
    if (['customCategories', 'customSubcategories', 'categoryOverrides', 'subcategoryOverrides', 'favoritePages', 'favoriteGroups'].includes(entry.field)) structureChanged = true;
  }
  for (const doc of [before, after]) {
    const projection = createProjection(doc, base);
    for (const id of tags) {
      for (const character of projection.characterUses.get(id) || []) characters.add(character);
      for (const membership of projection.memberships.get(id) || []) memberships.add(membership.id);
    }
    // A renamed/deleted favorite structure changes the location labels shown with tags.
    if (structureChanged) for (const membership of doc.memberships) { memberships.add(membership.id); tags.add(membership.tagId); }
  }
  return { revision: after.revision, changedTagIds: [...tags], changedCharacterIds: [...characters], changedMembershipIds: [...memberships], structureChanged };
}
module.exports = { diffDocuments, applyHistory, changeFor };
