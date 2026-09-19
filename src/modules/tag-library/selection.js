'use strict';

function selectionKey(value) { return `${value.kind}:${value.tagId || value.characterId || value.id}`; }
// Raw Tag.content stays editable. Only ordinary single-tag output escapes
// parentheses; bundles and migrated snapshots retain their original bytes.
function formatTagOutput({ kind, content }) {
  return kind === 'tag' ? content.replace(/\\*([()])/g, '\\$1') : content;
}
function resolveSelection(selection, projection, { includeAdult = false } = {}) {
  const views = [];
  for (const ref of selection) {
    const key = selectionKey(ref);
    if (ref.kind === 'legacySnapshot') {
      if (includeAdult || !ref.adult) views.push({ key, kind: ref.kind, displayName: ref.displayName, content: ref.content, adult: ref.adult, tagIds: [] });
      continue;
    }
    const links = ref.kind === 'character' ? projection.characters.get(ref.characterId) : null;
    const identity = projection.tag(ref.kind === 'tag' ? ref.tagId : links?.identityTagId);
    if (!identity || (!includeAdult && identity.adult)) continue;
    const ids = ref.kind === 'tag' ? [ref.tagId] : [links.identityTagId, ...(ref.includeSeries ? links.seriesTagIds : []), ...ref.generalTagIds, ...ref.specificTagIds];
    const records = [...new Set(ids)].map(id => projection.tag(id)).filter(tag => tag && (includeAdult || !tag.adult));
    views.push({ key, kind: ref.kind, displayName: identity.displayName, content: records.map(formatTagOutput).join(', '), adult: records.some(tag => tag.adult), tagIds: records.map(tag => tag.id) });
  }
  return views;
}
module.exports = { selectionKey, resolveSelection, formatTagOutput };
