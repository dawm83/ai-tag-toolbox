import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import os from 'node:os';

const require = createRequire(import.meta.url);
const { createFavorites, PALETTE } = require('../src/modules/favorites');
const { createStorage } = require('../src/modules/storage');

function documentWith(count) {
  const series = Array.from({ length: 20 }, (_, index) => ({ id: `series-${index}`, name: `Series ${index}`, order: index, colorMode: 'auto', color: PALETTE[index % PALETTE.length] }));
  const sections = series.flatMap(row => Array.from({ length: 5 }, (_, index) => ({ id: `${row.id}-section-${index}`, seriesId: row.id, name: `Section ${index}`, order: index })));
  const entries = Array.from({ length: count }, (_, index) => {
    const section = sections[index % sections.length];
    return {
      id: `entry-${index}`, kind: index % 5 === 0 ? 'bundle' : 'tag', seriesId: section.seriesId, sectionId: section.id,
      title: `Lighting ${index}`, rawText: index % 5 === 0 ? `soft lighting, backlighting, (sample_${index}:1.2)` : `lighting_${index}`,
      zh: `光照 ${index}`, aliases: [`sample ${index}`], note: index % 3 === 0 ? `Portrait reference ${index}` : '',
      globalSearchable: true, pinned: false, nsfw: false, order: Math.floor(index / 100), sourceTagId: null, createdAt: 0, updatedAt: 0
    };
  });
  return { format: 'ai-tag-favorites', version: 1, revision: 0, series, sections, entries };
}

const results = [];
for (const count of [3000, 10000]) {
  const favorites = createFavorites({ storage: createStorage() });
  const importing = performance.now();
  const imported = favorites.importBundle(documentWith(count), { mode: 'replace' });
  if (!imported.ok) throw new Error(imported.error.message);
  const importMs = performance.now() - importing;
  const cold = performance.now();
  const found = favorites.search('lighting', { scope: 'internal', limit: 80 });
  const coldSearchMs = performance.now() - cold;
  const samples = [];
  for (let index = 0; index < 35; index += 1) {
    const started = performance.now();
    favorites.search('lighting', { scope: 'internal', limit: 80 });
    if (index >= 5) samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  const editStart = performance.now();
  favorites.saveEntry({ id: 'entry-0', note: 'changed reference' });
  favorites.search('changed reference', { scope: 'internal', limit: 80 });
  const editAndReindexMs = performance.now() - editStart;
  const shelfStart = performance.now();
  for (const series of favorites.series()) {
    favorites.list({ seriesId: series.id, limit: 120 });
    favorites.list({ seriesId: series.id, sectionId: null, limit: 1 });
    for (const section of favorites.sections(series.id)) favorites.list({ seriesId: series.id, sectionId: section.id, limit: 1 });
  }
  const measured = { entries: count, totalMatches: found.total, importMs, coldSearchMs, p50Ms: samples[15], p95Ms: samples[28], editAndReindexMs, shelfDataReadMs: performance.now() - shelfStart };
  if (process.argv.includes('--view')) {
    const { JSDOM } = require('jsdom');
    const { createFavoritesView } = require('../src/views/favorites-view');
    const dom = new JSDOM('<section id="favoritesView"></section>', { pretendToBeVisual: true });
    const started = performance.now();
    const view = createFavoritesView({ document: dom.window.document, favorites });
    view.enter();
    measured.jsdomInitialRenderMs = performance.now() - started;
    measured.initialRenderedEntries = dom.window.document.querySelectorAll('[data-favorite-entry]').length;
    measured.initialDomNodes = dom.window.document.querySelectorAll('*').length;
    view.destroy(); dom.window.close();
  }
  results.push(measured);
}
console.log(JSON.stringify({ node: process.version, platform: `${os.platform()} ${os.arch()}`, cpu: os.cpus()[0]?.model, results }, null, 2));
