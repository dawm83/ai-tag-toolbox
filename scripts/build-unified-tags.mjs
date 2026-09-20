import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { loadTagFiles } = require('../src/modules/tags');
const { buildUnifiedSeed } = require('../src/modules/tag-library/seed');
const { taxonomyUpdateRecord } = require('../src/modules/tag-library/base-update');
const { enrichBundledTags } = require('../src/modules/tag-library/enrichment');
const { classifyWdGeneral } = require('../src/modules/tag-library/wd-general-taxonomy');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetDir = path.join(root, 'assets');
const read = name => JSON.parse(fs.readFileSync(path.join(assetDir, '数据资产/角色', `${name}.json`), 'utf8'));
const input = { tags: loadTagFiles({ assetDir }), characters: read('characters'), specificTags: read('specific-tags'), manifest: read('manifest') };
const result = buildUnifiedSeed(input);
if (!result.ok) throw new Error(JSON.stringify(result.error));
const base = result.data;
const sourceFiles = ['数据资产/标签/data-tags.js', '数据资产/标签/extra-tags.js', '数据资产/标签/synonyms.js', '数据资产/标签/search-keywords.js', '数据资产/标签/character-general-tags.json', '模型/tags-canary.json', '数据资产/角色/characters.json', '数据资产/角色/specific-tags.json', '数据资产/角色/manifest.json', '数据资产/标签/tag-enrichment.json', '数据资产/标签/wd-general-taxonomy.json'];
const sources = sourceFiles.map(file => ({ file, sha256: createHash('sha256').update(fs.readFileSync(path.join(assetDir, file))).digest('hex') }));
const manifest = { schemaVersion: 2, fingerprint: base.fingerprint, sourceSha256: createHash('sha256').update(JSON.stringify(sources)).digest('hex'), sources,
  counts: { tags: base.tags.length, ordinary: Object.keys(base.legacyIds.ordinary).length, characters: base.characterLinks.length, fallbackCharacters: Object.values(base.characterInfo).filter(c => c.fallback).length, specific: Object.keys(base.legacyIds.specific).length, categories: base.categories.length, subcategories: base.subcategories.length },
  mappingCounts: Object.fromEntries(Object.entries(base.legacyIds).map(([key, map]) => [key, Object.keys(map).length])) };
const output = path.join(assetDir, '数据资产/标签');
const raw = buildUnifiedSeed(input, { enrich: false });
if (!raw.ok) throw new Error(JSON.stringify(raw.error));
const previous = buildUnifiedSeed(input, { classifyModel: false });
if (!previous.ok) throw new Error(JSON.stringify(previous.error));
// Direct upgrade records support both the raw original corpus and V1.4.322–331.
const records = [taxonomyUpdateRecord(previous.data, base), taxonomyUpdateRecord(raw.data, base)].filter(Boolean);
const enriched = enrichBundledTags(raw.data);
const classified = classifyWdGeneral(previous.data);
const artifacts = {
  'unified-tag-base.json': JSON.stringify(base) + '\n',
  'unified-tag-manifest.json': JSON.stringify(manifest, null, 2) + '\n',
  'unified-tag-updates.json': JSON.stringify(records, null, 2) + '\n',
  'tag-enrichment-report.json': JSON.stringify({ fingerprint: base.fingerprint, counts: enriched.counts, changes: enriched.changes }, null, 2) + '\n',
  'wd-general-classification-report.json': JSON.stringify({ fingerprint: base.fingerprint, total: classified.changes.length, remaining: base.tags.filter(tag => tag.categoryId === 'wd_general').length, counts: classified.counts, changes: classified.changes }, null, 2) + '\n'
};
for (const [name, content] of Object.entries(artifacts)) {
  const filename = path.join(output, name);
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(filename) || fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n') !== content) throw new Error(`Generated asset differs: ${name}`);
  } else fs.writeFileSync(filename, content);
}
console.log(JSON.stringify({ fingerprint: base.fingerprint, ...manifest.counts, enrichment: enriched.counts }));
