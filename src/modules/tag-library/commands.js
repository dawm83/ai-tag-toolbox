'use strict';
const { validateCommand } = require('./schema');
const { clone, equal, baseIndex, createProjection } = require('./projection');
const { selectionKey } = require('./selection');
const { diffDocuments, changeFor } = require('./history');

class CommandError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; this.extra = extra; }
}
function reject(code, message, extra) { throw new CommandError(code, message, extra); }
function failure(code, message, extra = {}) { return { ok: false, error: { code, message, ...extra } }; }
const nextOrder = rows => rows.reduce((max, row) => Math.max(max, row.order + 1), 0);
const normalizedContent = content => content.trim().toLocaleLowerCase('en-US').replace(/[\s_]+/g, ' ');
const normalizedName = name => name.trim().toLocaleLowerCase('en-US');

/** Pure candidate construction. All dependencies, including identity and time, are injected. */
function applyLibraryCommand(document, base, command, { ids, now } = {}) {
  const checked = validateCommand(command); if (!checked.ok) return checked;
  if (['undo', 'redo', 'applyImport'].includes(command.type)) return failure('UNSUPPORTED_COMMAND', '此命令需要词库服务上下文');
  const draft = clone(document); const baseMaps = baseIndex(base); let cached = null;
  const projection = () => cached || (cached = createProjection(draft, base));
  const invalidate = () => { cached = null; };
  const allocate = prefix => {
    if (typeof ids !== 'function') reject('INVALID_FIELD', '缺少宿主身份生成器');
    return ids(prefix);
  };
  const timestamp = () => typeof now === 'function' ? now() : 0;
  const findTag = id => { const row = projection().tag(id); if (!row) reject('TAG_NOT_FOUND', '标签不存在'); return row; };
  function uniqueName(rows, name, id) {
    if (rows.some(row => row.id !== id && normalizedName(row.name) === normalizedName(name))) reject('DUPLICATE_NAME', '同一位置已有同名项目');
  }
  function put(field, row, key = 'id') {
    const index = draft[field].findIndex(value => value[key] === row[key]);
    if (index < 0) draft[field].push(row); else draft[field][index] = row;
    invalidate(); return row;
  }
  function remove(field, predicate) { draft[field] = draft[field].filter(row => !predicate(row)); invalidate(); }
  function saveStructure(type, c) {
    const config = {
      category: { field: 'customCategories', overrides: 'categoryOverrides', map: 'categories', prefix: 'category' },
      subcategory: { field: 'customSubcategories', overrides: 'subcategoryOverrides', map: 'subcategories', prefix: 'subcategory', parent: 'categoryId', parentMap: 'categories' },
      page: { field: 'favoritePages', map: 'pages', prefix: 'page' },
      group: { field: 'favoriteGroups', map: 'groups', prefix: 'group', parent: 'pageId', parentMap: 'pages' }
    }[type];
    const existing = c.id ? projection()[config.map].get(c.id) : null;
    if (c.id && !existing) reject('INVALID_PARENT', '目标位置不存在');
    if (config.parent && !projection()[config.parentMap].has(c[config.parent])) reject('INVALID_PARENT', '父级位置不存在');
    if (existing && config.parent && existing[config.parent] !== c[config.parent]) reject('INVALID_PARENT', '不能通过名称编辑更换父级');
    const siblings = [...projection()[config.map].values()].filter(row => !config.parent || row[config.parent] === c[config.parent]);
    uniqueName(siblings, c.name, c.id);
    const id = existing?.id || allocate(config.prefix);
    if (existing?.source === 'bundled') {
      if (existing.name !== c.name) put(config.overrides, { ...draft[config.overrides].find(row => row.id === id), id, name: c.name });
    } else {
      const row = existing ? { ...existing } : { id, order: nextOrder(siblings) };
      row.name = c.name;
      if (config.parent) row[config.parent] = c[config.parent];
      if (config.overrides) row.source = 'custom';
      else {
        row.color = c.color ?? row.color ?? '#64748b';
        if (type === 'page') row.colorMode = c.colorMode ?? row.colorMode ?? 'auto';
      }
      put(config.field, row);
    }
    return id;
  }
  function resolvePlacement(p) {
    const isTaxonomy = p.kind === 'taxonomy';
    const parentChoice = isTaxonomy ? p.category : p.page, childChoice = isTaxonomy ? p.subcategory : p.group;
    const parentType = isTaxonomy ? 'category' : 'page', childType = isTaxonomy ? 'subcategory' : 'group';
    const parentMap = isTaxonomy ? 'categories' : 'pages', childMap = isTaxonomy ? 'subcategories' : 'groups';
    const parentKey = isTaxonomy ? 'categoryId' : 'pageId';
    const parentId = parentChoice.id || saveStructure(parentType, parentChoice.create);
    if (!projection()[parentMap].has(parentId)) reject('INVALID_PARENT', '父级位置不存在');
    const childId = childChoice.id || saveStructure(childType, { ...childChoice.create, [parentKey]: parentId });
    if (projection()[childMap].get(childId)?.[parentKey] !== parentId) reject('INVALID_PARENT', '子级不属于指定父级');
    return isTaxonomy ? { categoryId: parentId, subcategoryId: childId } : { pageId: parentId, groupId: childId };
  }
  function defaultTaxonomy() {
    let category = [...projection().categories.values()].find(row => row.name === '未分类');
    if (!category) category = { id: saveStructure('category', { name: '未分类' }) };
    let child = [...projection().subcategories.values()].find(row => row.categoryId === category.id && row.name === '未分类');
    if (!child) child = { id: saveStructure('subcategory', { categoryId: category.id, name: '未分类' }) };
    return { categoryId: category.id, subcategoryId: child.id };
  }
  function patchTag(id, patch) {
    const existing = findTag(id);
    const changed = Object.fromEntries(Object.entries(patch).filter(([key, value]) => !equal(existing[key], value)));
    if (!Object.keys(changed).length) return;
    if (changed.kind === 'bundle') {
      const references = projection().references(id).filter(ref => ref.kind === 'character');
      if (references.length) reject('TAG_IN_USE', '角色引用的标签不能改为组合', { references });
    }
    if (baseMaps.tags.has(id)) {
      const old = draft.tagOverrides.find(row => row.tagId === id);
      put('tagOverrides', { tagId: id, patch: { ...old?.patch, ...clone(changed) }, revision: existing.revision + 1, updatedAt: Math.max(timestamp(), existing.updatedAt) }, 'tagId');
    } else put('customTags', { ...existing, ...clone(changed), revision: existing.revision + 1, updatedAt: Math.max(timestamp(), existing.updatedAt) });
  }
  function duplicateCheck(content, kind, id, independent) {
    if (kind !== 'tag' || independent) return;
    for (const row of projection().tags()) if (row.id !== id && row.kind === 'tag' && normalizedContent(row.content) === normalizedContent(content)) {
      reject('DUPLICATE_CONTENT', '已有相同内容的标签，请引用现有条目或明确另存为独立标签', { references: [{ kind: 'selection', id: row.id, label: row.displayName }] });
    }
  }
  function favorite(tagId, p, moving) {
    findTag(tagId);
    let membership = null;
    if (moving && !p.membershipId) reject('INVALID_FIELD', '移动收藏必须指定归属 ID');
    if (p.membershipId) {
      membership = draft.memberships.find(row => row.id === p.membershipId);
      if (!membership || membership.tagId !== tagId) reject('INVALID_PARENT', '归属不属于指定标签');
    }
    const location = resolvePlacement(p);
    const existing = draft.memberships.find(row => row.tagId === tagId && row.groupId === location.groupId);
    if (existing) {
      if (membership && membership.id !== existing.id) {
        reject('DUPLICATE_MEMBERSHIP', '目标组已收藏此标签，请先解除指定归属');
      }
      return { ...location, membershipId: existing.id };
    }
    membership = membership ? { ...membership, groupId: location.groupId } : { id: allocate('membership'), tagId, groupId: location.groupId, pinned: false };
    membership.order = nextOrder(draft.memberships.filter(row => row.groupId === location.groupId));
    put('memberships', membership);
    return { ...location, membershipId: membership.id };
  }
  function saveTag(c) {
    const existing = c.tagId ? findTag(c.tagId) : null;
    const resolved = c.placement?.kind === 'taxonomy' ? resolvePlacement(c.placement) : null;
    const patch = { ...clone(c.patch), ...resolved };
    if (!existing || (Object.hasOwn(patch, 'content') && patch.content !== existing.content) || (Object.hasOwn(patch, 'kind') && patch.kind !== existing.kind)) {
      duplicateCheck(patch.content ?? existing?.content ?? '', patch.kind ?? existing?.kind ?? 'tag', existing?.id, c.allowIndependent);
    }
    const tagId = existing?.id || allocate('tag');
    if (existing) patchTag(tagId, patch);
    else {
      const location = patch.categoryId && patch.subcategoryId ? {} : defaultTaxonomy();
      const time = timestamp();
      put('customTags', { id: tagId, kind: 'tag', content: '', displayName: '', aliases: [], note: '', adult: false, searchable: true, ...location, ...patch, usages: ['general'], source: { kind: 'custom', key: null }, revision: 0, createdAt: time, updatedAt: time });
    }
    return { tagId, ...(c.placement?.kind === 'favorite' ? favorite(tagId, c.placement, false) : {}) };
  }
  function ensureRelocationGroup() {
    // Deleted structures have already left the candidate, including a deleted
    // uncategorized destination. Never fall back to another user-owned location.
    let page = draft.favoritePages.find(row => normalizedName(row.name) === '未分类');
    if (!page) page = { id: saveStructure('page', { name: '未分类' }) };
    let group = draft.favoriteGroups.find(row => row.pageId === page.id && normalizedName(row.name) === '未分类');
    if (!group) group = { id: saveStructure('group', { pageId: page.id, name: '未分类' }) };
    return group.id;
  }
  function deleteStructure(c) {
    const isPage = c.type === 'deletePage';
    const target = projection()[isPage ? 'pages' : 'groups'].get(isPage ? c.pageId : c.groupId);
    if (!target) reject('INVALID_PARENT', '位置不存在');
    const groupIds = new Set(isPage ? draft.favoriteGroups.filter(row => row.pageId === c.pageId).map(row => row.id) : [c.groupId]);
    const groupOrders = new Map(draft.favoriteGroups.map(row => [row.id, row.order]));
    const affected = draft.memberships.filter(row => groupIds.has(row.groupId))
      .sort((a, b) => groupOrders.get(a.groupId) - groupOrders.get(b.groupId) || a.order - b.order);
    if (isPage) remove('favoritePages', row => row.id === c.pageId);
    remove('favoriteGroups', row => groupIds.has(row.id));
    remove('memberships', row => groupIds.has(row.groupId));
    if (c.mode === 'relocate' && affected.length) {
      const groupId = ensureRelocationGroup();
      for (const row of affected) {
        const existing = draft.memberships.find(value => value.tagId === row.tagId && value.groupId === groupId);
        if (existing) { if (row.pinned && !existing.pinned) put('memberships', { ...existing, pinned: true }); }
        else put('memberships', { ...row, groupId, order: nextOrder(draft.memberships.filter(value => value.groupId === groupId)) });
      }
    }
  }
  function saveLinks(links) {
    if (!projection().characters.has(links.characterId)) reject('UNRESOLVED_REFERENCE', '角色不存在');
    if (!equal(projection().characters.get(links.characterId), links)) put('characterOverrides', clone(links), 'characterId');
  }
  function perform(c) {
    switch (c.type) {
      case 'saveTag': return saveTag(c);
      case 'favoriteTag':
        if (Object.hasOwn(c.placement, 'membershipId')) reject('INVALID_FIELD', '添加收藏不能指定已有归属 ID，请使用移动命令');
        return { tagId: c.tagId, ...favorite(c.tagId, c.placement, false) };
      case 'unfavorite': remove('memberships', row => c.membershipIds.includes(row.id)); return {};
      case 'move': {
        findTag(c.tagId);
        if (c.placement.kind === 'taxonomy') { patchTag(c.tagId, resolvePlacement(c.placement)); return { tagId: c.tagId }; }
        return { tagId: c.tagId, ...favorite(c.tagId, c.placement, true) };
      }
      case 'restoreTag':
        findTag(c.tagId); if (!baseMaps.tags.has(c.tagId)) reject('NO_BUNDLED_DEFAULT', '自定义标签没有内置默认值');
        remove('tagOverrides', row => row.tagId === c.tagId); return { tagId: c.tagId };
      case 'deleteTag': {
        findTag(c.tagId); if (baseMaps.tags.has(c.tagId)) reject('BUNDLED_TAG_NOT_DELETABLE', '内置标签不能删除');
        const references = projection().references(c.tagId); if (references.length) reject('TAG_IN_USE', '标签仍有引用', { references });
        remove('customTags', row => row.id === c.tagId); remove('tagOverrides', row => row.tagId === c.tagId);
        draft.recentTagIds = draft.recentTagIds.filter(id => id !== c.tagId); return { tagId: c.tagId };
      }
      case 'saveCategory': return { categoryId: saveStructure('category', c) };
      case 'saveSubcategory': return { subcategoryId: saveStructure('subcategory', c) };
      case 'savePage': return { pageId: saveStructure('page', c) };
      case 'saveGroup': return { groupId: saveStructure('group', c) };
      case 'deleteGroup': case 'deletePage': deleteStructure(c); return {};
      case 'saveCharacterLinks': saveLinks(c.links); return {};
      case 'restoreCharacter': {
        const original = baseMaps.characters.get(c.characterId);
        if (!original) reject('UNRESOLVED_REFERENCE', '角色不存在');
        // Restore the original identity, even after an explicit relation change.
        // Candidate validation rejects incompatible live selections atomically.
        remove('characterOverrides', row => row.characterId === c.characterId);
        remove('tagOverrides', row => row.tagId === original.identityTagId);
        return {};
      }
      case 'editCharacter': {
        const links = projection().characters.get(c.characterId); if (!links) reject('UNRESOLVED_REFERENCE', '角色不存在');
        if (c.identityPatch) {
          const identity = findTag(links.identityTagId);
          if (Object.hasOwn(c.identityPatch, 'content') && c.identityPatch.content !== identity.content) duplicateCheck(c.identityPatch.content, identity.kind, identity.id, false);
          patchTag(identity.id, c.identityPatch);
        }
        if (c.links) saveLinks(c.links); return {};
      }
      case 'select': {
        const key = selectionKey(c.value), index = draft.selection.findIndex(row => selectionKey(row) === key);
        if (c.selected) { if (index < 0) draft.selection.push(clone(c.value)); else draft.selection[index] = clone(c.value); }
        else if (index >= 0) draft.selection.splice(index, 1);
        return {};
      }
      case 'clearSelection': draft.selection = c.kind ? draft.selection.filter(row => row.kind !== c.kind) : []; return {};
      case 'markCopied':
        c.tagIds.forEach(findTag); draft.recentTagIds = [...c.tagIds, ...draft.recentTagIds.filter(id => !c.tagIds.includes(id))].slice(0, 200); return {};
      case 'batch': return { results: c.operations.map(operation => perform(operation)) };
      case 'setFlags':
        for (const id of c.tagIds) patchTag(id, Object.fromEntries(['adult', 'searchable'].filter(key => Object.hasOwn(c, key)).map(key => [key, c[key]]))); return {};
      case 'pin':
        for (const id of c.membershipIds) {
          const row = draft.memberships.find(value => value.id === id); if (!row) reject('UNRESOLVED_REFERENCE', '收藏归属不存在');
          put('memberships', { ...row, pinned: c.pinned });
        }
        return {};
      case 'colorPages':
        for (const id of c.pageIds) {
          const page = draft.favoritePages.find(value => value.id === id); if (!page) reject('INVALID_PARENT', '收藏页不存在');
          put('favoritePages', { ...page, colorMode: c.colorMode, ...(c.color !== undefined ? { color: c.color } : {}) });
        }
        return {};
      case 'reorder': {
        const field = { page: 'favoritePages', group: 'favoriteGroups', membership: 'memberships' }[c.kind];
        const parent = { group: 'pageId', membership: 'groupId' }[c.kind];
        if (parent && !projection()[c.kind === 'group' ? 'pages' : 'groups'].has(c.parentId)) reject('INVALID_PARENT', '父级位置不存在');
        const rows = draft[field].filter(row => !parent || row[parent] === c.parentId);
        if (rows.length !== c.ids.length || rows.some(row => !c.ids.includes(row.id))) reject('INVALID_FIELD', '排序必须包含当前父级的完整集合');
        const order = new Map(c.ids.map((id, i) => [id, i]));
        draft[field] = draft[field].map(row => order.has(row.id) ? { ...row, order: order.get(row.id) } : row); invalidate(); return {};
      }
      case 'duplicateTag': {
        const row = findTag(c.tagId);
        const patch = Object.fromEntries(['kind', 'content', 'displayName', 'aliases', 'note', 'adult', 'searchable', 'categoryId', 'subcategoryId'].map(key => [key, clone(row[key])]));
        return saveTag({ type: 'saveTag', patch, placement: c.placement, allowIndependent: true });
      }
      default: reject('UNSUPPORTED_COMMAND', '不支持的标签库命令');
    }
  }
  try {
    const result = perform(command);
    const changed = !equal(document, draft);
    if (changed) draft.revision = document.revision + 1;
    const historyDelta = diffDocuments(document, draft);
    return { ok: true, data: { document: draft, change: changeFor(document, draft, base, historyDelta), result: { ...result, changed }, historyDelta } };
  } catch (error) {
    if (error instanceof CommandError) return failure(error.code, error.message, error.extra);
    throw error;
  }
}
module.exports = { applyLibraryCommand };
