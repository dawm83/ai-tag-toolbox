'use strict';

const { segmentSourceText } = require('./translation-alignment');
const { PALETTE } = require('./tag-library/presentation-metadata');

function favoriteMemberCount(entry) {
  if (!entry?.rawText?.trim()) return null;
  if (entry.kind === 'tag') return 1;
  if (entry.kind !== 'bundle') return null;
  const segmented = segmentSourceText(entry.rawText);
  return segmented.granularity === 'tag' ? segmented.sourceUnits.length : null;
}

function createFavorites(options = {}) {
  return require('./tag-library/favorite-adapter').createFavoriteAdapter(options);
}

module.exports = { createFavorites, favoriteMemberCount, PALETTE };
