'use strict';
const { randomUUID } = require('node:crypto');
const fail = (code, message) => ({ ok: false, error: { code, message } });
const own = (value, key) => Object.hasOwn(value, key);
const clone = value => structuredClone(value);
const idOf = value => typeof value === 'string' ? value : value?.id;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function context(library) {
  if (!library || typeof library.execute !== 'function') throw new TypeError('需要统一标签库');
  return {
    run: (command, options = {}) => library.execute(command, { operationId: options.operationId ?? `adapter:${randomUUID()}`, ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }) }),
    success: data => ({ ok: true, data, revision: library.revision() }),
    unavailable: () => fail('FEATURE_UNAVAILABLE', '请通过统一词库导入流程操作')
  };
}

// Compatibility aliases are translated once. Reject conflicting aliases instead
// of choosing a hidden winner, including intentional empty strings/arrays.
function tagPatch(input, aliases = {}) {
  if (!object(input)) return fail('INVALID_FIELD', '编辑字段必须为对象');
  const fields = new Set(['kind', 'content', 'displayName', 'aliases', 'note', 'adult', 'searchable', 'categoryId', 'subcategoryId']);
  const patch = {};
  for (const [key, value] of Object.entries(input)) {
    const target = aliases[key] || key;
    if (!fields.has(target)) return fail('INVALID_FIELD', `不支持字段 ${key}，置顶请使用 applyBatch，排序请使用 reorder`);
    if (own(patch, target) && JSON.stringify(patch[target]) !== JSON.stringify(value)) return fail('INVALID_FIELD', `字段 ${target} 的别名值冲突`);
    patch[target] = clone(value);
  }
  return { ok: true, data: patch };
}

// Library queries intentionally cap a page at 2000. Legacy list APIs return all
// matching rows, so walk real query pages instead of silently truncating a seed.
function collect(query, options = {}) {
  const items = []; let page;
  do { page = query({ ...options, offset: items.length, limit: 2000 }); items.push(...page.items); } while (page.hasMore && page.items.length);
  return items;
}
module.exports = { fail, own, clone, idOf, object, context, tagPatch, collect };
