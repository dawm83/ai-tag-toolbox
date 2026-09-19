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
function createMemoryRepository(initial, controls = {}) {
  let stored = initial == null ? null : structuredClone(initial);
  let fail = false, gate = null, saveCount = 0;
  controls.failNextSave = () => { fail = true; };
  controls.delayNextSave = () => {
    let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    gate = { promise: new Promise(resolve => { release = resolve; }), entered };
    return { release, started };
  };
  return {
    get saveCount() { return saveCount; },
    async read() { return structuredClone(stored); },
    async save(document) {
      saveCount += 1;
      const waiting = gate; gate = null;
      if (waiting) { waiting.entered(); await waiting.promise; }
      if (fail) { fail = false; throw new Error('simulated write failure'); }
      stored = structuredClone(document);
    }
  };
}
function createHarness(options = {}) {
  const { createTagLibrary } = require('../../src/modules/tag-library/library');
  const base = options.base || makeBase();
  const controls = {};
  const initial = Object.hasOwn(options, 'document') ? options.document : emptyUserDocument(base);
  const repository = options.repository || createMemoryRepository(initial, controls);
  let sequence = 0;
  const config = { base, repository, ids: prefix => `${prefix}:fixture-${++sequence}`, now: () => 1000, ...options, controls: undefined };
  const library = createTagLibrary(config);
  return { library, repository, controls, ready: library.ready(), async reload() { const next = createTagLibrary(config); await next.ready(); return next; } };
}
module.exports = { makeRecord, makeBase, emptyUserDocument, createMemoryRepository, createHarness };
