'use strict';

// Preserve UTF-16 offsets in the original text, including NFKC expansions and
// surrogate pairs. This is the same mapping used by the legacy favorite shelf.
const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });
function normalized(value) {
  value = String(value ?? '');
  let output = ''; const map = [];
  for (const { segment: char, index } of graphemes.segment(value)) {
    const end = index + char.length;
    for (const piece of char.normalize('NFKC').toLowerCase().replace(/_/g, ' ')) {
      const next = /\s/u.test(piece) ? ' ' : piece;
      if (next === ' ' && output.endsWith(' ')) { map[map.length - 1].end = end; continue; }
      output += next;
      for (let unit = 0; unit < next.length; unit++) map.push({ start: index, end });
    }
  }
  const start = output.length - output.trimStart().length, end = output.trimEnd().length;
  return { value: output.slice(start, end), map: map.slice(start, end) };
}
const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/_/g, ' ').replace(/\s+/gu, ' ').trim();
const compact = value => value.replace(/[ .-]/g, '');
const spaceFold = value => value.replace(/ /g, '');
function searchField(field, original) {
  const value = normalize(original);
  return { field, original, value, spaceValue: spaceFold(value) };
}
const fieldsFor = tag => [['content', tag.content], ['displayName', tag.displayName], ...tag.aliases.map((value, index) => [`aliases.${index}`, value])]
  .filter(([, value]) => value).map(([field, original]) => searchField(field, original));
function matchFields(fields, needle, precision) {
  if (!needle) return { score: 1, hits: [] };
  const exact = fields.find(field => field.value === needle);
  if (exact) return { score: exact.related ? 80 : exact.field.startsWith('aliases.') ? 110 : 120, hits: [{ field: exact, term: needle }] };
  if (precision === 'exact') return null;
  const folded = spaceFold(needle);
  const sameSpelling = fields.find(field => field.spaceValue === folded);
  if (sameSpelling) return { score: sameSpelling.related ? 70 : 95, hits: [{ field: sameSpelling, term: folded, compact: 'spaces' }] };
  const whole = fields.find(field => field.value.includes(needle));
  if (whole) return { score: whole.value.startsWith(needle) ? 75 : 60, hits: [{ field: whole, term: needle }] };
  const hits = needle.split(' ').map(term => ({ term, field: fields.find(field => field.value.includes(term)) }));
  if (hits.every(hit => hit.field)) return { score: 40, hits };
  const spellingHits = needle.split(' ').map(term => ({ term, compact: 'spaces', field: fields.find(field => field.spaceValue.includes(term)) }));
  if (spellingHits.every(hit => hit.field)) return { score: 35, hits: spellingHits };
  if (precision === 'broad') {
    const compactHits = needle.split(' ').map(compact).filter(Boolean).map(term => ({ term, compact: true, field: fields.find(field => compact(field.value).includes(term)) }));
    if (compactHits.length && compactHits.every(hit => hit.field)) return { score: 30, hits: compactHits };
  }
  return null;
}
function highlights(hits) {
  const matches = [];
  for (const { field, term, compact: compactMatch } of hits) {
    let mapped = normalized(field.original);
    if (compactMatch) {
      const result = { value: '', map: [] };
      const separator = compactMatch === 'spaces' ? / / : /[ .-]/;
      for (let index = 0; index < mapped.value.length; index++) if (!separator.test(mapped.value[index])) { result.value += mapped.value[index]; result.map.push(mapped.map[index]); }
      mapped = result;
    }
    for (let at = mapped.value.indexOf(term); at >= 0; at = mapped.value.indexOf(term, at + term.length)) {
      const start = mapped.map[at]?.start, end = mapped.map[at + term.length - 1]?.end;
      if (start !== undefined && end !== undefined) matches.push({ field: field.field, start, end });
    }
  }
  return matches;
}

/** Internal immutable read index. Only the library exposes cloned TagViews.
 * null query means browsing; even an empty string is discovery and checks flags.
 */
function createTagSearchIndex({ getTags, getMemberships, getCharacterLinks, getStructure, getMetadata = () => ({}), getTaxonomy = () => ({ categories: [], subcategories: [] }) }) {
  let rows = null, relations = null, locations = null, favoriteOrder = [];
  let broadContext = null; const broadFields = new Map();
  const results = new Map();
  const indexedFields = row => row.fields || (row.fields = fieldsFor(row.tag));
  function fieldsForBroad(indexed) {
    if (!broadContext) {
      const taxonomy = getTaxonomy();
      broadContext = { metadata: getMetadata(), categories: new Map([...taxonomy.categories].map(row => [row.id, row.name])), subcategories: new Map([...taxonomy.subcategories].map(row => [row.id, row.name])) };
    }
    if (!broadFields.has(indexed.tag.id)) {
      const tag = indexed.tag, keywords = broadContext.metadata[tag.id]?.keywords || [];
      const fields = [...keywords.map((value, index) => [`keywords.${index}`, value]), ['categoryId', tag.categoryId], ['categoryName', broadContext.categories.get(tag.categoryId)], ['subcategoryName', broadContext.subcategories.get(tag.subcategoryId)]];
      broadFields.set(tag.id, [...indexedFields(indexed), ...fields.filter(([, value]) => typeof value === 'string' && value).map(([field, original]) => searchField(field, original))]);
    }
    return broadFields.get(indexed.tag.id);
  }
  function ensure() {
    if (!rows) rows = new Map([...getTags()].map(tag => [tag.id, { tag, fields: null }]));
    if (!relations) {
      relations = { identity: new Map(), traits: new Map(), byId: new Map() };
      for (const link of getCharacterLinks()) {
        relations.byId.set(link.characterId, link);
        if (!relations.identity.has(link.identityTagId)) relations.identity.set(link.identityTagId, []);
        relations.identity.get(link.identityTagId).push(link);
        for (const id of [...link.generalTagIds, ...link.specificTagIds]) {
          if (!relations.traits.has(id)) relations.traits.set(id, new Set());
          relations.traits.get(id).add(link.characterId);
        }
      }
    }
    if (!locations) {
      const structure = getStructure(), pages = new Map([...structure.pages].map(row => [row.id, row])), groups = new Map([...structure.groups].map(row => [row.id, row]));
      locations = new Map(); favoriteOrder = [];
      const memberships = [...getMemberships()].sort((a, b) => (pages.get(groups.get(a.groupId)?.pageId)?.order || 0) - (pages.get(groups.get(b.groupId)?.pageId)?.order || 0) || (groups.get(a.groupId)?.order || 0) - (groups.get(b.groupId)?.order || 0) || a.order - b.order);
      for (const membership of memberships) {
        const group = groups.get(membership.groupId), page = pages.get(group?.pageId); if (!group || !page || !rows.has(membership.tagId)) continue;
        if (!locations.has(membership.tagId)) locations.set(membership.tagId, []);
        favoriteOrder.push({ tagId: membership.tagId, pageId: page.id, groupId: group.id, pageOrder: page.order, groupOrder: group.order, pinned: membership.pinned, order: membership.order });
        locations.get(membership.tagId).push({ membershipId: membership.id, pageId: page.id, pageName: page.name, groupId: group.id, groupName: group.name });
      }
    }
  }
  function search(query, options = {}, idsOnly = false) {
    ensure();
    const { scope = 'all', includeAdult = false, categoryId, subcategoryId, pageId, groupId, characterId, seriesId, kind, matchPrivate = true, precision = 'standard' } = options;
    const needle = query === null ? null : normalize(query);
    const key = JSON.stringify([needle, scope, includeAdult, categoryId, subcategoryId, pageId, groupId, characterId, seriesId, kind, precision, matchPrivate]);
    let matched = results.get(key);
    if (!matched) {
      matched = [];
      const scopedFavorites = scope === 'favorites' ? favoriteOrder.filter(place => (!pageId || place.pageId === pageId) && (!groupId || place.groupId === groupId)) : [];
      if (needle !== null) scopedFavorites.sort((a, b) => a.pageOrder - b.pageOrder || a.groupOrder - b.groupOrder || Number(b.pinned) - Number(a.pinned) || a.order - b.order);
      const candidates = scope === 'favorites' ? [...new Set(scopedFavorites.map(place => place.tagId))].map(id => rows.get(id)) : scope === 'characters' ? [...relations.identity.keys()].map(id => rows.get(id)) : scope === 'characterTraits' ? [...relations.traits.keys()].map(id => rows.get(id)) : scope === 'all' ? rows.values() : [];
      for (const indexed of candidates) {
        if (!indexed) continue;
        const { tag } = indexed;
        if ((!includeAdult && tag.adult) || (needle !== null && !tag.searchable) || (kind && kind !== 'all' && tag.kind !== kind) || (categoryId && tag.categoryId !== categoryId) || (subcategoryId && tag.subcategoryId !== subcategoryId)) continue;
        const places = locations.get(tag.id) || [], links = relations.identity.get(tag.id) || [];
        if (scope === 'favorites' && !places.some(place => (!pageId || place.pageId === pageId) && (!groupId || place.groupId === groupId))) continue;
        if (scope === 'characterTraits' && characterId && !relations.traits.get(tag.id)?.has(characterId)) continue;
        const roleLinks = links.filter(link => (!characterId || link.characterId === characterId) && (!seriesId || link.seriesTagIds.some(id => id === seriesId && (includeAdult || !rows.get(id)?.tag.adult))));
        if (scope === 'characters' && !roleLinks.length) continue;
        let fields = !needle ? [] : precision === 'broad' ? fieldsForBroad(indexed) : indexedFields(indexed);
        if (scope === 'favorites' && matchPrivate) fields = [...fields, ...[['note', tag.note], ...places.filter(place => (!pageId || place.pageId === pageId) && (!groupId || place.groupId === groupId)).flatMap(place => [['pageName', place.pageName], ['groupName', place.groupName]])].filter(([, value]) => value).map(([field, original]) => searchField(field, original))];
        let match, characterMatches;
        if (scope === 'characters') {
          // A shared identity is still one Tag, but each character's series
          // fields belong only to that character, never a union across roles.
          characterMatches = [];
          for (const link of roleLinks) {
            const related = link.seriesTagIds.flatMap(id => {
              const series = rows.get(id); return needle && series && series.tag.searchable && (includeAdult || !series.tag.adult) ? indexedFields(series).map(field => ({ ...field, field: `series.${id}.${field.field}`, related: true })) : [];
            });
            const candidate = needle === null ? { score: 1, hits: [] } : matchFields([...fields, ...related], needle, precision);
            if (candidate) { characterMatches.push({ characterId: link.characterId, score: candidate.score }); if (!match || candidate.score > match.score) match = candidate; }
          }
        } else match = needle === null ? { score: 1, hits: [] } : matchFields(fields, needle, precision);
        if (match) matched.push({ id: tag.id, ...match, characterIds: characterMatches ? characterMatches.map(row => row.characterId) : roleLinks.map(link => link.characterId), characterMatches });
      }
      if (needle) matched.sort((a, b) => b.score - a.score);
      results.set(key, matched); if (results.size > 32) results.delete(results.keys().next().value);
    }
    if (idsOnly) return matched.map(match => match.id);
    const offset = Number.isSafeInteger(options.offset) && options.offset >= 0 ? options.offset : 0;
    const limit = Number.isSafeInteger(options.limit) && options.limit >= 0 ? Math.min(options.limit, 2000) : 100;
    return { items: matched.slice(offset, offset + limit).map(match => {
      const favoriteLocations = locations.get(match.id) || [];
      return { ...rows.get(match.id).tag, favorite: favoriteLocations.length > 0, favoriteLocations,
        ...(match.characterIds.length ? { characterId: match.characterIds[0], characterIds: match.characterIds } : {}), ...(match.characterMatches ? { characterMatches: match.characterMatches } : {}), score: match.score, matches: highlights(match.hits) };
    }), total: matched.length, offset, limit, hasMore: offset + limit < matched.length };
  }
  function invalidate(change) {
    if (!change || change.changedTagIds?.length) rows = null;
    if (!change || change.changedTagIds?.length || change.structureChanged) { broadContext = null; broadFields.clear(); }
    if (!change || change.changedCharacterIds?.length) relations = null;
    if (!change || change.structureChanged || change.changedMembershipIds?.length) locations = null;
    if (!change || change.structureChanged || change.changedTagIds?.length || change.changedCharacterIds?.length || change.changedMembershipIds?.length) results.clear();
  }
  function counts(includeAdult = false) {
    ensure(); const categories = { all: 0 }, subcategories = {};
    for (const { tag } of rows.values()) if (includeAdult || !tag.adult) {
      categories.all++; categories[tag.categoryId] = (categories[tag.categoryId] || 0) + 1;
      subcategories[tag.subcategoryId] = (subcategories[tag.subcategoryId] || 0) + 1;
    }
    return { categories, subcategories };
  }
  return { search, invalidate, counts, ids: options => search(null, options, true) };
}
module.exports = { createTagSearchIndex, normalized, normalize };
