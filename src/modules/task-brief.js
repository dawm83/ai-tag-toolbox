'use strict';

const crypto = require('node:crypto');

const VERSION = 1;
const MAX_ITEMS = 256;
const MAX_TEXT = 16000;
const SOURCES = Object.freeze(['system', 'user', 'user_feedback', 'reference_tags', 'vision', 'character_library', 'candidate_evaluation', 'model_inference']);
const DIRECTIVES = Object.freeze(['must_include', 'preserve', 'observation', 'reference_only', 'improve', 'remove', 'ignore']);
const AUTHORITIES = Object.freeze(['hard', 'high', 'medium', 'low']);
const STATUSES = Object.freeze(['active', 'resolved', 'superseded', 'rejected']);
const SOURCE_PRIORITY = Object.freeze({ system: 8, user_feedback: 7, user: 6, reference_tags: 5, candidate_evaluation: 4, vision: 3, character_library: 2, model_inference: 1 });
const AUTHORITY_RANK = Object.freeze({ low: 1, medium: 2, high: 3, hard: 4 });
const SOURCE_DEFAULTS = Object.freeze({
  system: { directive: 'must_include', authority: 'hard' },
  user: { directive: 'must_include', authority: 'hard' },
  user_feedback: { directive: 'improve', authority: 'hard' },
  reference_tags: { directive: 'must_include', authority: 'high' },
  vision: { directive: 'observation', authority: 'medium' },
  character_library: { directive: 'reference_only', authority: 'low' },
  candidate_evaluation: { directive: 'improve', authority: 'high' },
  model_inference: { directive: 'observation', authority: 'low' }
});
const SOURCE_DIRECTIVES = Object.freeze({
  system: DIRECTIVES,
  user: DIRECTIVES,
  user_feedback: DIRECTIVES,
  reference_tags: DIRECTIVES,
  vision: Object.freeze(['observation', 'reference_only', 'ignore']),
  character_library: Object.freeze(['reference_only', 'observation', 'ignore']),
  candidate_evaluation: Object.freeze(['improve', 'remove', 'ignore', 'preserve', 'reference_only']),
  model_inference: Object.freeze(['observation', 'reference_only', 'improve', 'ignore'])
});
const SOURCE_MAX_AUTHORITY = Object.freeze({ system: 'hard', user: 'hard', user_feedback: 'hard', reference_tags: 'high', candidate_evaluation: 'high', vision: 'medium', character_library: 'low', model_inference: 'low' });

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value, fallback = '') {
  const output = value == null ? '' : String(value).trim();
  return output ? output.slice(0, MAX_TEXT) : fallback;
}
function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  return value;
}
function list(value, limit = 256) {
  const values = Array.isArray(value) ? value : String(value == null ? '' : value).split(/[,，、;；|\n]+/);
  return [...new Set(values.map(item => text(item)).filter(Boolean))].slice(0, limit);
}
function fail(message, code = 'TASK_BRIEF_INVALID') { throw Object.assign(new Error(message), { code }); }
function assertChoice(value, choices, label) { if (!choices.includes(value)) fail(`${label} 无效：${value}`); return value; }
function authority(value, source) {
  const requested = AUTHORITIES.includes(value) ? value : SOURCE_DEFAULTS[source].authority;
  const max = AUTHORITY_RANK[SOURCE_MAX_AUTHORITY[source]];
  return AUTHORITY_RANK[requested] <= max ? requested : SOURCE_MAX_AUTHORITY[source];
}
function defaultDirective(source) { return SOURCE_DEFAULTS[source].directive; }
function normalizeDirective(value, source) {
  const requested = text(value, defaultDirective(source));
  const allowed = SOURCE_DIRECTIVES[source];
  if (allowed.includes(requested)) return requested;
  if (source === 'character_library' && ['must_include', 'preserve'].includes(requested)) return 'reference_only';
  fail(`source=${source} 不允许 directive=${requested}`);
}
function stableId(source, scope, value) {
  const digest = crypto.createHash('sha1').update(`${source}\n${scope}\n${value}`).digest('hex').slice(0, 16);
  return `brief-${digest}`;
}
function entryKey(item) { return `${item.source}\u0000${item.scope}\u0000${item.value}`; }
function conflictKey(item) { return `${item.scope}\u0000${item.value.toLocaleLowerCase()}`; }
function normalizeItem(raw, index, forcedSource = '') {
  if (!object(raw)) fail(`items[${index}] 必须是对象`);
  const source = text(forcedSource || raw.source);
  assertChoice(source, SOURCES, 'source');
  const scope = text(raw.scope);
  const value = text(raw.value);
  if (!scope || !value) fail(`items[${index}] 缺少 scope 或 value`);
  const directive = normalizeDirective(raw.directive, source);
  const status = assertChoice(text(raw.status, 'active'), STATUSES, 'status');
  const evidence = object(raw.evidence) ? clone(raw.evidence) : {};
  return {
    id: text(raw.id, stableId(source, scope, value)),
    scope: scope.slice(0, 256),
    value,
    source,
    directive,
    authority: authority(raw.authority, source),
    status,
    ...(Object.keys(evidence).length ? { evidence } : {})
  };
}
function normalizePrompt(value = {}) {
  const source = object(value) ? value : {};
  return {
    positiveTags: list(source.positiveTags),
    negativeTags: list(source.negativeTags),
    iteration: Math.max(0, Number.isInteger(source.iteration) ? source.iteration : 0)
  };
}
function normalizeBrief(value = {}) {
  const source = object(value) ? value : {};
  const goalSource = object(source.goal) ? source.goal : source;
  const items = Array.isArray(source.items) ? source.items.slice(0, MAX_ITEMS).map((item, index) => normalizeItem(item, index)) : [];
  return {
    version: VERSION,
    goal: { mode: text(goalSource.mode, 'create'), userRequest: text(goalSource.userRequest || source.originalRequirements || source.requirements) },
    currentPrompt: normalizePrompt(source.currentPrompt),
    items
  };
}
function createBrief(input = {}) {
  const source = object(input) ? input : {};
  const base = normalizeBrief({
    goal: { mode: text(source.mode, 'create'), userRequest: text(source.userRequest || source.originalRequirements || source.requirements) },
    currentPrompt: source.currentPrompt,
    items: source.items
  });
  return base;
}
function addItems(brief, rows, context = {}) {
  const source = text(context.source);
  assertChoice(source, SOURCES, 'source');
  if (!Array.isArray(rows)) fail('items 必须是数组');
  const next = normalizeBrief(brief);
  for (const [index, raw] of rows.slice(0, MAX_ITEMS).entries()) {
    const item = normalizeItem(raw, index, source);
    const key = entryKey(item);
    const existing = next.items.find(row => row.status === 'active' && entryKey(row) === key);
    if (existing) {
      Object.assign(existing, item, { id: existing.id });
      continue;
    }
    next.items = next.items.map(row => row.status === 'active' && row.source === item.source && row.scope === item.scope && row.value === item.value
      ? { ...row, status: 'superseded' } : row);
    next.items.push(item);
    if (next.items.length > MAX_ITEMS) next.items = next.items.slice(-MAX_ITEMS);
  }
  return next;
}
function uniqueValues(rows) { return [...new Set(rows.map(row => row.value))]; }
function mergeBrief(brief) {
  const source = normalizeBrief(brief);
  const active = source.items.filter(item => item.status === 'active');
  const ordered = active.slice().sort((a, b) => (SOURCE_PRIORITY[b.source] - SOURCE_PRIORITY[a.source]) || (AUTHORITY_RANK[b.authority] - AUTHORITY_RANK[a.authority]));
  const blockers = ordered.filter(item => ['remove', 'ignore'].includes(item.directive));
  const result = { include: [], preserve: [], observe: [], improve: [], excluded: [], conflicts: [] };
  const included = new Map();
  for (const item of ordered) {
    const key = conflictKey(item);
    const blocker = blockers.find(row => conflictKey(row) === key && row.id !== item.id);
    if (['remove', 'ignore'].includes(item.directive)) {
      result.excluded.push(item.value);
      continue;
    }
    if (blocker && (SOURCE_PRIORITY[blocker.source] > SOURCE_PRIORITY[item.source] || (SOURCE_PRIORITY[blocker.source] === SOURCE_PRIORITY[item.source] && AUTHORITY_RANK[blocker.authority] >= AUTHORITY_RANK[item.authority]))) {
      result.excluded.push(item.value);
      continue;
    }
    if (included.has(key)) {
      result.conflicts.push({ key, kept: included.get(key), ignored: item.id });
      continue;
    }
    included.set(key, item.id);
    if (item.directive === 'must_include') result.include.push(item.value);
    else if (item.directive === 'preserve') result.preserve.push(item.value);
    else if (item.directive === 'observation' || item.directive === 'reference_only') result.observe.push(item.value);
    else if (item.directive === 'improve') result.improve.push(item.value);
  }
  for (const key of ['include', 'preserve', 'observe', 'improve', 'excluded']) result[key] = uniqueValues(result[key].map(value => ({ value })));
  return result;
}
function briefForAgent(brief) {
  const source = normalizeBrief(brief);
  return {
    version: VERSION,
    goal: clone(source.goal),
    currentPrompt: clone(source.currentPrompt),
    items: source.items.filter(item => item.status === 'active').slice(-MAX_ITEMS),
    effective: mergeBrief(source)
  };
}
function addLegacyItems(brief, rows, source, directive) {
  const values = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (object(row)) values.push(...list(row.identityTags || row.generalTags || row.specificTags));
    else values.push(...list(row));
  }
  return values.length ? addItems(brief, values.map(value => ({ scope: `${source}.reference`, value, directive })), { source }) : brief;
}
function migrateBrief(source = {}) {
  const root = object(source) ? source : {};
  if (object(root.brief) && Number(root.brief.version) === VERSION) return normalizeBrief(root.brief);
  if (Number(root.version) === VERSION && Array.isArray(root.items)) return normalizeBrief(root);
  let brief = createBrief({ mode: root.mode, userRequest: root.originalRequirements || root.requirements, currentPrompt: { positiveTags: root.positiveTags, negativeTags: root.negativeTags, iteration: root.iteration || 0 } });
  const userRequest = text(root.originalRequirements || root.requirements);
  if (userRequest) brief = addItems(brief, [{ scope: 'goal.request', value: userRequest, directive: 'must_include' }], { source: 'user' });
  const blueprint = object(root.visualBlueprint) ? root.visualBlueprint : {};
  const observations = Object.entries(blueprint).flatMap(([scope, value]) => list(value).map(item => ({ scope: `vision.${scope}`, value: item, directive: 'observation' })));
  if (observations.length) brief = addItems(brief, observations, { source: 'vision' });
  const roles = Array.isArray(root.characterReferences) ? root.characterReferences : [];
  const roleItems = roles.flatMap((role, index) => {
    const values = [...list(role?.identityTags), ...list(role?.generalTags), ...list(role?.specificTags)];
    return values.map(value => ({ scope: `character.${index + 1}.reference`, value, directive: 'reference_only' }));
  });
  if (roleItems.length) brief = addItems(brief, roleItems, { source: 'character_library' });
  const suggestions = list(root.evaluation?.suggestedChanges || root.suggestedChanges);
  if (suggestions.length) brief = addItems(brief, suggestions.map(value => ({ scope: 'candidate.evaluation', value, directive: 'improve' })), { source: 'candidate_evaluation' });
  return brief;
}

module.exports = {
  VERSION,
  SOURCES,
  DIRECTIVES,
  AUTHORITIES,
  STATUSES,
  createBrief,
  addItems,
  mergeBrief,
  briefForAgent,
  migrateBrief
};
