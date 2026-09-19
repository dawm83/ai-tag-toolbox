'use strict';

function makeRecord(patch = {}) {
  return { id: 'blue_hair', kind: 'tag', content: 'blue hair', displayName: '蓝发', aliases: [], note: '', adult: false, searchable: true, categoryId: 'hair', subcategoryId: 'color', usages: ['general'], source: { kind: 'bundled', key: 'fixture' }, revision: 0, createdAt: 0, updatedAt: 0, ...patch };
}
function makeBase() {
  return {
    tags: [makeRecord(), makeRecord({ id: 'long_hair', content: 'long hair', displayName: '长发', subcategoryId: 'shape' }),
      ...['alice', 'bob'].map(id => makeRecord({ id, content: id, displayName: id, usages: ['characterIdentity'] })),
      makeRecord({ id: 'wonderland', content: 'wonderland', usages: ['seriesIdentity'] }),
      makeRecord({ id: 'specific:uniform', content: 'school uniform', searchable: false, usages: ['characterSpecific'] })],
    categories: [{ id: 'hair', name: '头发', order: 0, source: 'bundled' }],
    subcategories: [{ id: 'color', categoryId: 'hair', name: '颜色', order: 0, source: 'bundled' }, { id: 'shape', categoryId: 'hair', name: '形状', order: 1, source: 'bundled' }],
    characterLinks: ['alice', 'bob'].map(characterId => ({ characterId, identityTagId: characterId, seriesTagIds: ['wonderland'], generalTagIds: ['blue_hair'], specificTagIds: ['specific:uniform'] })),
    legacyIds: { ordinary: {}, characters: {}, series: {}, specific: {}, subcategories: {} }, fingerprint: 'fixture-base'
  };
}
function emptyUserDocument(base = makeBase()) {
  return { schemaVersion: 2, libraryId: 'fixture-library', revision: 0, baseFingerprint: base.fingerprint,
    customTags: [], tagOverrides: [], customCategories: [], customSubcategories: [], categoryOverrides: [], subcategoryOverrides: [],
    favoritePages: [{ id: 'home', name: '主页', order: 0, color: '#336699', colorMode: 'auto' }],
    favoriteGroups: [{ id: 'daily', pageId: 'home', name: '日常', order: 0, color: '#336699' }], memberships: [], characterOverrides: [], selection: [], recentTagIds: [], migration: null, unresolved: [] };
}
module.exports = { makeRecord, makeBase, emptyUserDocument };
