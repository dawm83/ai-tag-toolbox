'use strict';

// Legacy asset readers and pure normalization remain available for seed builds.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { DEFAULT_CATEGORIES } = require('./tag-library/presentation-metadata');

const CHARACTER_NAMES_CATEGORY = 'character_names';

// WD 标签文件中的 category 数字只用于识图结果。给它们一个稳定、
// 易读的分类名即可，详细 UI 分类仍以标签目录中的分类为准。
const MODEL_CATEGORY_NAMES = {
  0: 'wd_general',
  1: 'wd_sensitive',
  2: 'wd_questionable',
  3: 'wd_explicit',
  4: 'character',
  5: 'wd_artist',
  6: 'wd_copyright',
  7: 'wd_character',
  8: 'wd_meta',
  9: 'rating'
};

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value, fallback = '') {
  const result = value == null ? '' : String(value).trim();
  return result || fallback;
}

function asList(value) {
  if (Array.isArray(value)) return value.slice();
  if (value == null || value === '') return [];
  return String(value)
    .split(/[\s,，、;；]+/)
    .map(item => item.trim())
    .filter(Boolean);
}

function bool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return ['1', 'true', 'yes', 'on', 'adult', 'nsfw'].includes(String(value || '').toLowerCase());
}

function tagKey(value) {
  return text(value).toLocaleLowerCase();
}

/** Convert user search input to a comparable phrase. */
function searchKey(value) {
  return text(value)
    .normalize('NFKC')
    // A weighted prompt token such as (blue_hair:1.2) is still blue_hair.
    .replace(/:\s*[-+]?\d+(?:\.\d+)?\s*[)]/g, ')')
    .replace(/[()[\]{}]/g, ' ')
    .replace(/[ _-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase();
}

const SEARCH_PRECISIONS = Object.freeze(["exact", "standard", "broad"]);

function normaliseSearchPrecision(value) {
  const raw = text(value, "standard").toLowerCase();
  if (["exact", "strict", "high", "2", "精确", "高"].includes(raw)) return "exact";
  if (["broad", "loose", "fuzzy", "low", "0", "宽松", "低"].includes(raw)) return "broad";
  return "standard";
}

function normaliseTag(row, source = 'base', index = 0) {
  if (typeof row === 'string') row = { en: row };
  if (Array.isArray(row)) {
    row = {
      en: row[0],
      zh: row[1],
      aliases: row[2],
      category: row[3],
      subcategory: row[4],
      nsfw: row[5]
    };
  }
  if (!isObject(row)) return null;

  const en = text(row.en ?? row.tag ?? row.name ?? row.id);
  if (!en) return null;
  const id = tagKey(row.id || en);
  const categoryCode = Number.isInteger(Number(row.categoryCode))
    ? Number(row.categoryCode)
    : Number.isInteger(Number(row.category))
      ? Number(row.category)
      : null;
  const category = text(
    row.categoryId ?? row.categoryName ?? (categoryCode == null ? row.category ?? row.cat : MODEL_CATEGORY_NAMES[categoryCode]),
    source === 'model' && categoryCode != null ? MODEL_CATEGORY_NAMES[categoryCode] || `wd_${categoryCode}` : 'other'
  );
  const subcategory = text(row.subcategory ?? row.sub ?? row.group, '默认');
  const normalizedCategory = category === 'character' && subcategory === '角色名'
    ? CHARACTER_NAMES_CATEGORY
    : category;
  const aliases = asList(row.aliases ?? row.alias ?? row.al);
  const adult = bool(row.nsfw ?? row.adult ?? row.isAdult) || category === 'nsfw' || categoryCode === 3;
  return {
    id,
    en,
    zh: text(row.zh ?? row.cn ?? row.translation),
    aliases: [...new Set(aliases.map(text).filter(Boolean))],
    category: normalizedCategory,
    subcategory,
    nsfw: adult,
    categoryCode,
    count: Number.isFinite(Number(row.count ?? row.hits)) ? Number(row.count ?? row.hits) : null,
    confidence: Number.isFinite(Number(row.confidence ?? row.prob)) ? Number(row.confidence ?? row.prob) : null,
    source,
    custom: source === 'custom',
    edited: row.edited === true ? true : undefined,
    editedAt: Number.isFinite(Number(row.editedAt)) ? Number(row.editedAt) : null
  };
}

/**
 * Evaluate one of the trusted, local data asset files from the material store.
 * The files intentionally remain plain JS so they can still be edited by hand.
 */
function readScriptData(filePath, names = []) {
  const source = fs.readFileSync(path.resolve(filePath), 'utf8');
  const context = {};
  const wanted = names.length ? names : ['TAGS', 'EXTRA_TAGS', 'SYNONYMS', 'SYNONYMS_BY_EN', 'SYNONYM_ALIASES', 'BASE_CATEGORIES'];
  const assignment = `\n;globalThis.__tagAssets = {${wanted.map(name => `${name}: typeof ${name} !== 'undefined' ? ${name} : undefined`).join(',')}};`;
  vm.runInNewContext(`${source}${assignment}`, context, { filename: filePath });
  return context.__tagAssets || {};
}

function readDataSource(source, names) {
  if (source == null) return {};
  if (typeof source === 'string') {
    const resolved = path.resolve(source);
    if (resolved.toLowerCase().endsWith('.json')) return JSON.parse(fs.readFileSync(resolved, 'utf8'));
    return readScriptData(resolved, names);
  }
  return source;
}

/** Load the three tag files (and optional model file) from 素材仓库. */
function loadTagFiles(options = {}) {
  const assetDir = options.assetDir || 'C:/Users/admin/Desktop/素材仓库';
  const tagDir = options.tagDir || path.join(assetDir, '数据资产', '标签');
  const modelFile = options.model || path.join(assetDir, '模型', 'tags-canary.json');
  const base = readDataSource(options.base || options.baseFile || path.join(tagDir, 'data-tags.js'), ['TAGS', 'BASE_CATEGORIES']);
  const extra = readDataSource(options.extra || options.extraFile || path.join(tagDir, 'extra-tags.js'), ['EXTRA_TAGS']);
  const synonyms = readDataSource(options.synonyms || options.synonymsFile || path.join(tagDir, 'synonyms.js'), ['SYNONYMS', 'SYNONYMS_BY_EN', 'SYNONYM_ALIASES']);
  const keywordSource = options.keywords || options.keywordFile;
  const keywordPath = typeof keywordSource === 'string'
    ? keywordSource
    : path.join(tagDir, 'search-keywords.js');
  const keywords = isObject(keywordSource)
    ? keywordSource
    : keywordPath && fs.existsSync(path.resolve(keywordPath))
      ? readDataSource(keywordPath, ['SEARCH_KEYWORDS', 'TAG_KEYWORDS'])
      : {};
  const model = options.includeModel === false || !modelFile ? null : readDataSource(modelFile, []);
  const additionsFile = path.join(tagDir, 'character-general-tags.json');
  const additions = fs.existsSync(additionsFile) ? readDataSource(additionsFile, []) : [];
  return {
    categories: base.BASE_CATEGORIES || base.categories,
    base: base.TAGS || base.tags || base,
    extra: [...(extra.EXTRA_TAGS || extra.tags || extra), ...additions],
    model: model && (model.tags || model),
    synonyms: {
      reverse: synonyms.SYNONYMS || synonyms.reverse,
      byEn: synonyms.SYNONYMS_BY_EN || synonyms.byEn,
      aliases: synonyms.SYNONYM_ALIASES || synonyms.aliases
    },
    keywords: keywords.SEARCH_KEYWORDS || keywords.TAG_KEYWORDS || keywords.keywords || keywords
  };
}

/** Convert the editable keyword asset into a normalized tag -> terms map. */
function normaliseKeywords(value) {
  if (!isObject(value)) return new Map();
  const result = new Map();
  for (const [key, terms] of Object.entries(value)) {
    const ids = [...new Set([tagKey(key), searchKey(key)].filter(Boolean))];
    const list = [...new Set(asList(terms).map(text).filter(Boolean))];
    ids.forEach(id => {
      if (list.length) result.set(id, [...new Set([...(result.get(id) || []), ...list])]);
    });
  }
  return result;
}

function createTags(options = {}) {
  return require('./tag-library/tag-adapter').createTagAdapter(options);
}

module.exports = {
  DEFAULT_CATEGORIES, MODEL_CATEGORY_NAMES, createTags, loadTagFiles, normaliseTag,
  searchKey, SEARCH_PRECISIONS, normaliseSearchPrecision, normaliseKeywords, readScriptData
};
