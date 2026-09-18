'use strict';

const { parse } = require('csv-parse/sync');

const clone = value => JSON.parse(JSON.stringify(value));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, data) => ({ ok: false, error: { code, message }, ...(data ? { data } : {}) });
const ok = data => ({ ok: true, data });
const hex = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
const SECTION_PALETTE = Object.freeze(['#287EA4', '#C75450', '#5A8F50', '#B67823', '#7256A8', '#00897B', '#B04A7A', '#65737E', '#8B6F47', '#446CB3']);
const integer = value => Number.isInteger(value) && value >= 0;
const lineBreakCount = value => (String(value).match(/\r\n|\r|\n/g) || []).length;
const leadingLineBreakCount = value => {
  const source = String(value);
  let index = 0;
  let count = 0;
  while (index < source.length) {
    if (source.startsWith('\r\n', index)) index += 2;
    else if (source[index] === '\r' || source[index] === '\n') index += 1;
    else break;
    count += 1;
  }
  return count;
};

function joinFavoriteBlocks(blocks) {
  const values = (Array.isArray(blocks) ? blocks : []).filter(value => typeof value === 'string' && value.length);
  if (!values.length) return '';
  return values.slice(1).reduce((text, block) => text + (/[,，、;；|\r\n]\s*$/u.test(text) ? '' : ', ') + block, values[0]);
}

function validateFavoriteBundle(input) {
  let value = input;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch (error) { return fail('INVALID_JSON', error.message); }
  }
  if (!object(value) || value.format !== 'ai-tag-favorites') return fail('INVALID_FORMAT', '收藏备份格式无效');
  if (value.version !== 1) return fail('UNSUPPORTED_VERSION', '不支持此收藏备份版本');
  if (!integer(value.revision) || !Array.isArray(value.series) || !Array.isArray(value.sections) || !Array.isArray(value.entries)) return fail('INVALID_DOCUMENT', '收藏备份结构无效');
  value = clone(value);
  value.entries.forEach(row => { if (object(row) && row.sectionId === '') row.sectionId = null; });
  const seen = new Set();
  for (const row of value.series) {
    if (!object(row) || typeof row.id !== 'string' || !row.id || typeof row.name !== 'string' || !row.name.trim() || !integer(row.order) || !['auto', 'custom'].includes(row.colorMode) || !hex(row.color)) return fail('INVALID_SERIES', '系列记录无效');
    if (seen.has(row.id)) return fail('DUPLICATE_ID', `重复 ID: ${row.id}`);
    seen.add(row.id);
  }
  const seriesIds = new Set(value.series.map(row => row.id));
  for (const [index, row] of value.sections.entries()) {
    if (!object(row) || typeof row.id !== 'string' || !row.id || typeof row.seriesId !== 'string' || typeof row.name !== 'string' || !row.name.trim() || !integer(row.order)) return fail('INVALID_SECTION', '子分类记录无效');
    if (row.color === undefined) row.color = SECTION_PALETTE[index % SECTION_PALETTE.length];
    if (!hex(row.color)) return fail('INVALID_SECTION', '子分类颜色无效');
    if (seen.has(row.id)) return fail('DUPLICATE_ID', `重复 ID: ${row.id}`);
    if (!seriesIds.has(row.seriesId)) return fail('SERIES_NOT_FOUND', `系列不存在: ${row.seriesId}`);
    seen.add(row.id);
  }
  const sections = new Map(value.sections.map(row => [row.id, row]));
  for (const row of value.entries) {
    const validText = typeof row?.rawText === 'string' && (row.rawText.trim() || row.legacyInvalid === true);
    if (!object(row) || typeof row.id !== 'string' || !row.id || !['tag', 'bundle'].includes(row.kind) || typeof row.seriesId !== 'string' || !(row.sectionId === null || typeof row.sectionId === 'string') || typeof row.title !== 'string' || !validText || typeof row.zh !== 'string' || !Array.isArray(row.aliases) || row.aliases.some(alias => typeof alias !== 'string') || typeof row.note !== 'string' || typeof row.globalSearchable !== 'boolean' || typeof row.pinned !== 'boolean' || typeof row.nsfw !== 'boolean' || !integer(row.order) || !(row.sourceTagId === null || typeof row.sourceTagId === 'string') || !Number.isFinite(row.createdAt) || !Number.isFinite(row.updatedAt)) return fail('INVALID_ENTRY', '收藏条目无效');
    if (seen.has(row.id)) return fail('DUPLICATE_ID', `重复 ID: ${row.id}`);
    if (!seriesIds.has(row.seriesId)) return fail('SERIES_NOT_FOUND', `系列不存在: ${row.seriesId}`);
    if (row.sectionId && (!sections.has(row.sectionId) || sections.get(row.sectionId).seriesId !== row.seriesId)) return fail('SECTION_NOT_FOUND', `子分类不存在或不属于系列: ${row.sectionId}`);
    seen.add(row.id);
  }
  return ok(clone(value));
}

function parseFavoritePaste(text, options = {}) {
  const format = options.format || 'lines';
  const kind = options.kind || 'tag';
  if (!['lines', 'tsv'].includes(format)) return fail('INVALID_FORMAT', '仅支持逐行或 TSV');
  if (!['tag', 'bundle'].includes(kind)) return fail('INVALID_KIND', '收藏类型无效');
  const entries = [], errors = [];
  const add = (rawText, zh, row) => {
    if (typeof rawText !== 'string' || !rawText.trim()) { errors.push({ row, code: 'EMPTY_CONTENT', message: `第 ${row} 行缺少内容` }); return; }
    entries.push({ kind, seriesId: options.seriesId, sectionId: options.sectionId ?? null, rawText, zh: typeof zh === 'string' ? zh : '' });
  };
  if (format === 'lines') {
    String(text ?? '').split(/\r?\n/).forEach((value, index) => { if (value.trim()) add(value, '', index + 1); });
  } else {
    let rows;
    try { rows = parse(String(text ?? ''), { delimiter: '\t', bom: true, info: true, raw: true, skip_empty_lines: true, relax_column_count: true }); }
    catch (error) { return fail('INVALID_TSV', error.message, { entries, errors: [{ row: Number(error.lines) || 1, code: 'INVALID_TSV', message: error.message }] }); }
    let startLine = 1;
    for (const item of rows) {
      const record = item.record;
      const raw = String(item.raw || '');
      const leadingLines = leadingLineBreakCount(raw);
      const row = startLine + leadingLines;
      if (record.length > 2) errors.push({ row, code: 'TOO_MANY_COLUMNS', message: `第 ${row} 行列数超过 2` });
      else add(record[0], record[1] ?? '', row);
      startLine += lineBreakCount(raw);
    }
  }
  const data = { entries, errors };
  return errors.length ? fail('INVALID_ROWS', '部分行无法导入', data) : ok(data);
}

module.exports = { joinFavoriteBlocks, parseFavoritePaste, validateFavoriteBundle };
