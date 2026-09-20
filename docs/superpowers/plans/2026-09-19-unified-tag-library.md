# 统一标签系统详细实施计划

> **For agentic workers:** 使用 `superpowers:executing-plans` 逐任务执行；若本轮明确选择子代理方式，使用 `superpowers:subagent-driven-development`，每个实现任务完成后再审查。复选框用于记录实际完成情况，不以代理口头报告代替验证。

**Goal:** 让主页、收藏、角色特征共用稳定标签 ID、一份内容和一个编辑弹窗，统一收藏归属、搜索资格、迁移与保存行为。

**Architecture:** 新增唯一 TagLibrary 命令/查询服务，内置基础种子只读，用户覆盖与引用关系集中保存为 v2 文档。现有 tags/favorites/characters 对外入口改成适配器；UI 和 AI 工具都消费同一份实时投影。所有数据写入走一次校验、原子落盘、发布事件的事务。

**Tech Stack:** Electron 31.7.7、CommonJS、原生 DOM/CSS、现有 storage 与 JSON 文件、Node 内置测试、JSDOM、现有 ESLint/acorn。保留当前依赖，不引入 React/Vue/数据库服务器。

**Spec:** [统一标签设计规范](../specs/2026-09-19-unified-tag-library-design.md)。发生冲突先按此规范裁定，再记录证据和改动原因。

**Status:** Task 0–9 已完成并通过审查；Task 10 迁移报告、导入导出与批量整理进行中。按用户 2026-09-20 的新指令，已合入 V1.4.320 的 ComfyUI 分支（28ac24d → merge be73b2b），整合检查 511 项通过。后续基于 V1.4.320 实施，最终候选版改为 V1.4.321；统一库尚未切换生产界面，真实用户数据未迁移。详见 docs/qa/unified-tag-library/execution-ledger.md。

## Global Constraints

- 只在 `F:\codex\AI绘画Tag工具箱\ai-tag-release-v143` 实施，不改本会话旧的“演示模拟”项目。
- 一个 tagId 对应一份内容；收藏归属和角色关系不得再次持有可编辑文本副本。
- Tag 内容允许修改，稳定 ID 不变；别名/名称/备注可清空且立即同步。
- 统一编辑器保存前不写库；取消不留下标签、页、组或分类。
- `searchable=false` 过滤所有发现式搜索；浏览和明确 ID 读取仍可用；成人过滤另行生效。
- 组合原文字节保留，不按逗号/空格擅自拆分，不改历史 Prompt。
- 旧数据先备份，冲突记录保留，不以同名推断同一标签，不向旧存储继续双写。
- 保留 `%SystemDrive%/` 等无关未跟踪文件，不 reset/clean，不批量提交整个工作区。
- 每个工程任务必跑 `npm run check`；默认不运行启动 Electron 的慢测，用户人工验收状态如实记录。
- 不调用真实付费 API，不 push，不发布 Release，不把用户数据、配置、密钥打包。
- 同一问题 2–3 轮仍未解决，报告具体阻塞与可恢复点；禁止无代理活动时反复空等。
- 只在完整候选版验证后同步桌面；正在运行的旧版不强杀、不删占用目录。

## 1. 阶段、依赖与交付门

| 阶段 | 任务 | 可检查成果 | 是否切换用户界面 |
| --- | --- | --- | --- |
| P0 | 0 | 当前源码、数据格式、恢复点与检查日志 | 否 |
| P1 | 1–4 | 统一种子、原子存储、命令服务、迁移演练 | 否 |
| P2 | 5–7 | 标签/收藏适配、角色关联、统一搜索与 AI 输出 | 否 |
| P3 | 8–9 | 统一弹窗、收藏位置选择器、页面全部接入 | 仅开发版 |
| P4 | 10–11 | 导入导出、回归、清理旧写路径、桌面候选版 | 验证后 |

顺序：`0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11`。

临时兼容策略：在任务 5–8 中，旧工厂可通过 `options.library` 选择新适配器，让当前入口仍能运行，便于每次小提交通过检查。任务 9 才在 preload 注入唯一 library；任务 11 删除旧独立内容写实现。最终不保留“两个生产系统择一”的长期分支。

## 2. 文件归属与改动面

新增目录 `src/modules/tag-library/`，每个文件职责如下。必要时函数可拆小，不能重新建立另一套库、编辑器或事件管理器。

| 文件 | 职责 |
| --- | --- |
| `schema.js` | 规范中的记录、文档、命令、引用和大小校验；导出错误码与版本 |
| `seed.js` | 将可信随包旧 Tag/角色/专属词构成统一基础种子与映射，不读取用户数据 |
| `repository.js` | 读取/备份/同目录临时文件/原子替换；只有此模块接触新库磁盘 |
| `library.js` | 唯一实例、ready、提交队列、operationId 去重、查询投影、事件 |
| `commands.js` | 纯候选变换：标签增改、恢复、归属、分类、角色关系、批量与撤销差量 |
| `migration.js` | 旧键解析、差异保留、ID 映射、预览与迁移报告 |
| `search.js` | 统一搜索资格、索引、命中高亮区间、范围/精度/去重 |
| `selection.js` | 结构化选择引用、角色/组合输出及旧快照兼容，不保存另一份内容 |
| `tag-adapter.js` | 现有 tags 读接口映射到共享记录，写接口调用 execute |
| `favorite-adapter.js` | 现有 favorites 页/组/归属投影，保留布局需要的查询形状 |
| `transfer.js` | v2 全库/收藏导出与 v1/粘贴导入预览、校验、原子应用 |
| `index.js` | 精简公开导出，不包含额外状态 |
| `src/views/tag-editor-view.js` | 唯一新增/编辑 Tag 弹窗、草稿与保存状态、关闭保护 |
| `src/views/tag-location-view.js` | 收藏/移动的位置选择器，已有对象和本地新建草稿 |
| `src/tag-editor.css` | 统一弹窗与位置选择器样式、焦点和响应式 |
| `scripts/build-unified-tags.mjs` | 重现内置种子/manifest，固定顺序和源 hash |
| `scripts/package-unified-tags.cjs` | 从已验证源码组装桌面包，校验 sourceCommit/asar/副本；不发布 |
| `tests/fixtures/tag-library.cjs` | 小型完整种子、内存/失败 repository、真实 library 测试组合 |
| `tests/tag-library-*.test.cjs` | 各任务下文指定的行为测试 |
| `docs/qa/unified-tag-library/` | baseline、migration、acceptance、verification、恢复说明 |

必须修改的现有消费处：

- `src/modules/tags.js`、`favorites.js`、`characters.js`、`favorites-transfer.js`、`index.js`。
- `src/modules/primary-tools.js`、`primary-agent.js`、`translation.js`。
- `preload.js`、`main.js`、`src/app.js`、`src/app-view.js`。
- `src/views/favorites-view.js`、`characters-view.js`、`src/favorites.css`、`src/characters.css`、`src/index.html`。
- `locales/zh-CN.json`、`locales/en-US.json`。
- 相关既有测试、`scripts/check.mjs`、版本/说明文件（任务 11）。

不要改 `ai-client.js`、`comfy*.js`、模型运行器等无关算法；如查询输出影响其输入，先用现有接口测试确认，不借此做通用重构。

## 3. 下游共享接口合同

### 3.1 查询、命令和错误

类型来自规范第 5–6 节；实际用 JSDoc 和运行时校验，不新建 TypeScript 构建链。

```ts
type Result<T> =
  | { ok: true; data: T; revision: number }
  | { ok: false; error: { code: string; message: string; fields?: string[]; references?: ReferenceUse[] } };
type ReferenceUse = { kind: 'favorite' | 'character' | 'selection'; id: string; label: string };
type ExecuteOptions = { operationId: string; expectedRevision?: number };
type LibraryChange = {
  revision: number; changedTagIds: string[]; changedCharacterIds: string[];
  changedMembershipIds: string[]; structureChanged: boolean;
};
type Page<T> = { items: T[]; total: number; offset: number; limit: number; hasMore: boolean; revision: number };
type SearchOptions = {
  scope: 'all' | 'favorites' | 'characters' | 'characterTraits';
  characterId?: string; categoryId?: string; subcategoryId?: string;
  pageId?: string; groupId?: string; includeAdult: boolean;
  seriesId?: string; kind?: 'tag' | 'bundle' | 'all'; matchPrivate?: boolean;
  precision?: 'exact' | 'standard' | 'broad'; offset?: number; limit?: number;
};
type TagView = TagRecord & {
  favorite: boolean;
  favoriteLocations: { membershipId: string; pageId: string; pageName: string; groupId: string; groupName: string }[];
  characterId?: string;
  characterIds?: string[]; characterMatches?: { characterId: string; score: number }[];
  score?: number; matches?: { field: string; start: number; end: number }[];
};
interface TagLibrary {
  ready(): Promise<Result<{ migration: MigrationReceipt | null }>>;
  retryInitialization(): Promise<Result<{ migration: MigrationReceipt | null }>>;
  recoverBackup(): Promise<Result<{ migration: MigrationReceipt | null }>>;
  status(): { ready: boolean; writable: boolean; error: null | { code: string; message: string } };
  revision(): number;
  getTag(id: string): TagView | null;
  listTags(options: SearchOptions): Page<TagView>; // 浏览，非发现式查询
  search(query: string, options: SearchOptions): Page<TagView>;
  tagCounts(options: { includeAdult?: boolean }): { categories: Record<string, number>; subcategories: Record<string, number> };
  getTagIds(options: SearchOptions): string[]; // 只读浏览 ID 投影，不是 AI 任意读取工具
  getCategories(): Category[];
  getSubcategories(categoryId: string): Subcategory[];
  getFavoritePages(): FavoritePage[];
  getFavoriteGroups(pageId: string): FavoriteGroup[];
  getMemberships(tagId?: string): FavoriteMembership[];
  getRecentTagIds(): string[]; // copied canonical recent IDs; no adapter-owned history
  getCharacterLinks(id: string): CharacterLinks | null;
  references(tagId: string): ReferenceUse[];
  selected(options: { includeAdult: boolean }): SelectionView[];
  execute(command: LibraryCommand, options: ExecuteOptions): Promise<Result<CommitData>>;
  exportBundle(options: { scope: 'all' | 'favorites' }): LibraryBundle;
  previewImport(bundle: unknown): Result<ImportPreview>;
  subscribe(fn: (event: LibraryChange) => void): () => void;
  historyState(): { canUndo: boolean; canRedo: boolean };
  flush(): Promise<boolean>;
  dispose(): Promise<void>;
}
type SelectionView = { key: string; kind: 'tag' | 'character' | 'legacySnapshot'; displayName: string; content: string; adult: boolean; tagIds: string[] };
type OperationData = { tagId?: string; membershipId?: string; pageId?: string; groupId?: string; categoryId?: string; subcategoryId?: string };
type CommitData = OperationData & { changed: boolean; results?: OperationData[] }; // batch results, in input order
```

`getTag` 是主机端明确 ID 读取；AI 查询不得直接暴露一个“忽略搜索开关读取任意库”的工具。返回对象均复制，不泄露可写引用。

### 3.2 位置草稿与允许命令

```ts
type ParentChoice = { id: string } | { create: { name: string } };
type ChildChoice = { id: string } | { create: { name: string } };
type Placement =
  | { kind: 'taxonomy'; category: ParentChoice; subcategory: ChildChoice }
  | { kind: 'favorite'; page: ParentChoice; group: ChildChoice; membershipId?: string };
type LibraryCommand =
  | { type: 'saveTag'; tagId?: string; patch: TagPatch; placement?: Placement; allowIndependent?: boolean }
  | { type: 'favoriteTag'; tagId: string; placement: Extract<Placement, { kind: 'favorite' }> }
  | { type: 'unfavorite'; membershipIds: string[] }
  | { type: 'move'; tagId: string; placement: Placement }
  | { type: 'restoreTag'; tagId: string }
  | { type: 'deleteTag'; tagId: string }
  | { type: 'saveCategory'; id?: string; name: string }
  | { type: 'saveSubcategory'; id?: string; categoryId: string; name: string }
  | { type: 'savePage'; id?: string; name: string; color?: string; colorMode?: 'auto' | 'custom' }
  | { type: 'saveGroup'; id?: string; pageId: string; name: string; color?: string }
  | { type: 'deleteGroup'; groupId: string; mode: 'relocate' | 'unfavorite' }
  | { type: 'deletePage'; pageId: string; mode: 'relocate' | 'unfavorite' }
  | { type: 'saveCharacterLinks'; links: CharacterLinks }
  | { type: 'editCharacter'; characterId: string; identityPatch?: TagPatch; links?: CharacterLinks }
  | { type: 'restoreCharacter'; characterId: string }
  | { type: 'select'; value: SelectionRef; selected: boolean }
  | { type: 'clearSelection'; kind?: SelectionRef['kind'] }
  | { type: 'markCopied'; tagIds: string[] }
  | { type: 'batch'; operations: BatchOperation[] }
  | { type: 'reorder'; kind: 'page' | 'group' | 'membership'; parentId: string | null; ids: string[] }
  | { type: 'duplicateTag'; tagId: string; placement?: Placement }
  | { type: 'applyImport'; previewId: string }
  | { type: 'undo' | 'redo' };
type BatchOperation =
  | { type: 'favoriteTag'; tagId: string; placement: Extract<Placement, { kind: 'favorite' }> }
  | { type: 'duplicateTag'; tagId: string; placement?: Placement }
  | { type: 'move'; tagId: string; placement: Placement }
  | { type: 'unfavorite'; membershipIds: string[] }
  | { type: 'setFlags'; tagIds: string[]; adult?: boolean; searchable?: boolean }
  | { type: 'pin'; membershipIds: string[]; pinned: boolean }
  | { type: 'colorPages'; pageIds: string[]; colorMode: 'auto' | 'custom'; color?: string };
```

`batch` 的显式白名单新增 `favoriteTag` 与 `duplicateTag`，供收藏跨组引用/另存独立使用；子操作都在同一纯候选中执行，整体校验、一次保存、一次通知、一条撤销。`CommitData.results` 按输入顺序返回子操作的稳定 ID（包括幂等复用的 membershipId），不以适配器快照差推断新归属；不支持嵌套 batch、任意 callback 或通用写对象。`getRecentTagIds()` 返回当前持久化 recentTagIds 的独立副本，ready 前为空。

约束：saveTag 创建时补默认值（kind=tag、其他字符串空、aliases=[]、adult=false、searchable=true、未分类位置），更新时只写出现的字段；未知字段拒绝。不能修改 id/source/usages/revision。`kind=bundle` 的记录不得作为角色身份或单个特征引用；有角色引用时从 tag 改为 bundle 返回 `TAG_IN_USE`。

deleteTag 对内置标签返回 `BUNDLED_TAG_NOT_DELETABLE`；自定义且仍被角色/收藏/选择引用返回 `TAG_IN_USE`，由显式解除流程后删除。取消收藏不调用 deleteTag。editCharacter 的 identityPatch 只允许 content/displayName/aliases/note/adult/searchable 六类字段；links.characterId 必须等于命令的 characterId，不能借编辑资料替换别的角色关系。

`restoreCharacter` 是窄范围原子命令：移除指定内置角色的关系覆盖，以及种子中该角色原始 identityTagId 的内容覆盖。即使当前关系已更换身份词，也恢复原始身份；不修改其他共享特征、替代身份词或收藏。候选仍完整校验引用；当前选择包含恢复后不存在的角色特征时返回 `UNRESOLVED_REFERENCE`，不偷偷重写选择。保存、通知、撤销均为一次操作；不支持任意复合回调或 batch 内嵌该命令。

输出边界：`selection.js` 导出纯函数 `formatTagOutput({kind,content})`，仅 kind=tag 的括号转义为一层，bundle/legacySnapshot 原文逐字节保留。`library.selected().content`、角色 `selected/selectionText/copyText`、Tag `selectedText/copyText` 和收藏 `copyText` 均使用该边界。`getTag().content`、Tag `en`、收藏 `rawText`、角色 `name/identityTags/identity.content` 及特征 `en/content` 仍是原始可编辑内容；Task 9 直接复制注入此 helper，移除旧 UI 的重复括号转换。选中项按 SelectionRef/tagId 身份去重，不按输出文本合并。

角色宿主输入：`createCharacters({library, characterSource:{characters:[{id,trigger?,count?,fallback?,sourceKey?,order?}],manifest?}})`。characters 必须覆盖种子的完整 characterLinks；Task 9 仅将 base.characterLinks 与 base.characterInfo 按 characterId 关联，分别取 sourceTrigger/count/fallback/sourceKey/order，禁止再实例化旧 tags/terms 或重新读取原始角色语料。source 文本只保留 trigger 等审计字段，不提供运行时名称、别名或系列名称回退。构造可早于 library.ready；提前查询为空，ready 后同一实例读取正式投影。公开写方法返回 Promise<Result>，调用方必须 await；edit 的 name/nameZh/nsfw/tagIds 兼容映射到 content/displayName/adult/generalTagIds，seriesTagIds 是规范 ID 数组，旧 seriesName/trigger 是只读审计字段。

`exportBundle/previewImport/applyImport` 的完整实现归 Task 10；Task 3 阶段不接入这些 UI 入口，任务 9 的开发版若已展示入口则明确为尚未可用，桌面候选版启用前由 Task 10 完成。临时能力不允许作为已完成功能对用户交付。LibraryBundle/ImportPreview 在 Task 10 定义；transfer 模块负责纯转换，预览候选与 revision 由 library 实例保管，真正导入仍通过 execute，不增加第二个写入口。

错误码至少包括：`NOT_READY`、`INVALID_DOCUMENT`、`UNSUPPORTED_VERSION`、`INVALID_FIELD`、`TAG_NOT_FOUND`、`TAG_IN_USE`、`DUPLICATE_CONTENT`、`INVALID_PARENT`、`DUPLICATE_NAME`、`REVISION_CONFLICT`、`OPERATION_CONFLICT`、`STORAGE_WRITE_FAILED`、`MIGRATION_FAILED`、`IMPORT_TOO_LARGE`、`UNRESOLVED_REFERENCE`。错误文案不得回显密钥或整份用户文档。

### 3.3 repository 和测试夹具

```ts
interface LibraryRepository {
  read(): Promise<LibraryDocument | null>;        // 损坏抛结构化错误；不存在才 null
  save(document: LibraryDocument): Promise<void>; // 完成原子替换才 resolve
  backupLegacy(value: LegacyInput): Promise<{ id: string; sha256: string }>;
}
type LegacyInput = { version: 1; values: Record<string, unknown> };
type MigrationPlan = { document: LibraryDocument; report: MigrationReceipt; sourceFingerprint: string };
```

任务 1/3 建立 `tests/fixtures/tag-library.cjs` 的如下工具并供后续任务复用：

- `makeRecord(patch)`：有效默认 Tag（id=`blue_hair`、content=`blue hair`、displayName=`蓝发`、aliases=`[]`、adult=false、searchable=true、kind=tag、hair/color 分类、revision=0、固定时间戳）；patch 覆盖指定字段。
- `makeBase()`：两条通用标签 `blue_hair`、`long_hair`；hair 分类/color 与shape子类；两名角色 `alice/bob` 的身份词、作品词及共享 blue_hair 关联；一条 `specific:uniform`（searchable=false）。不得将主页最初的两条与角色附加词总数混淆，测试用 getTag 或初始数量差量判断。所有内置关系位于base，收藏结构不放进种子。
- `emptyUserDocument(base)`：规范 v2 完整空覆盖结构、固定 libraryId/baseFingerprint，夹具内预置 home 收藏页、daily 分组但不含收藏归属；生产默认页/组不照抄测试夹具。
- `createMemoryRepository(initial, controls)`：真实读写复制；`controls.failNextSave()` 下一次保存失败，`controls.delayNextSave()` 返回可释放 Promise；记录 saveCount，不能模拟库命令。
- `createHarness(options={})`：创建上面真实 repository 和 library，返回 `{library, repository, controls, ready, reload}`，`ready` 即 library.ready()；reload 用 repository 已持久化文档创建新真实 library。

生产文件禁止导入测试夹具。示例测试省略 node:test 基础导入时，实现文件统一顶部导入 `test` 与 `assert/strict`，不要写“后面再补”的假测试。

## Task 0：建立可恢复基线和变更账本

**Files:** 新建 `docs/qa/unified-tag-library/baseline.md`、`acceptance-matrix.md`、`execution-ledger.md`；只读旧 spec、源码和现有测试；备份放已忽略 `work/unified-tags/P0/`。

**输入/输出:** 输入当前 V1.4.316 工作区；输出基线命令日志、文件/hash 清单、旧行为与被替代规则映射。

- [x] 检查 Git 当前分支/状态、根及子目录 AGENTS；保留 `%SystemDrive%/`。
- [x] 执行 `npm run check`，保存到 `work/unified-tags/P0/check.log`；预期 306 项基线测试通过，以实际输出为准。
- [x] 文件复制保存当前源码、配置、tests、scripts、可信 assets 和三个设计文档；排除 models/node_modules/历史QA/work 嵌套归档，不复制真实用户配置。
- [x] 记录现有运行目录及 V1.4.316 包 hash，明确恢复时复制文件内容到独立目录，不能制造 `src/src` 双重嵌套。
- [x] 建立 U01–U24 矩阵，每项初始 `未实施`；记录旧 favorites-selection 快照规则、收藏 internal 搜索例外和自动保存测试将有意改变。
- [x] 从冻结文件建立语法/构建或 npm check 恢复演练，可复用当前 node_modules；记录依赖复用事实。
- [x] 账本写“当前 Task 0、下一 Task 1、无运行代理”，完成后仅提交本任务文档。

**验收:** 能指向确切恢复文件和检查退出码；不宣称已运行 Electron 人工流程。提交：`V1.4.316：记录统一标签改造基线`。

## Task 1：统一基础种子、稳定 ID 和运行时 schema

**Files:** 新建 `src/modules/tag-library/schema.js`、`seed.js`、`index.js`、`scripts/build-unified-tags.mjs`、`tests/fixtures/tag-library.cjs`、`tests/tag-library-schema.test.cjs`、`tests/tag-library-seed.test.cjs`；生成 `assets/数据资产/标签/unified-tag-base.json` 和 `unified-tag-manifest.json`。

**Interfaces:** `buildUnifiedSeed({tags,characters,specificTags,manifest})`、`validateTag(record)`、`validateLibraryDocument(doc,base)`、`validateCommand(command)`；结果 `{ok:true,data}` 或统一 error。`buildUnifiedSeed` 返回 `{tags,categories,subcategories,characterLinks,legacyIds,fingerprint}`。

- [x] 先写身份与原文测试：

```js
const { makeRecord } = require('./fixtures/tag-library.cjs');
const { validateTag } = require('../src/modules/tag-library/schema');
test('content is editable independently of immutable identity', () => {
  const record = makeRecord({ content: '(blue hair:1.2)\nlong hair', kind: 'bundle' });
  assert.equal(validateTag(record).ok, true);
  assert.equal(record.id, 'blue_hair');
  assert.equal(record.content, '(blue hair:1.2)\nlong hair');
  assert.equal(validateTag({ ...record, apiKey: 'unexpected' }).ok, false);
});
```

- [x] 运行 `node --test tests/tag-library-schema.test.cjs tests/tag-library-seed.test.cjs`，记录预期缺模块/行为失败。
- [x] 实现规范中的字段、类型、长度、唯一 ID、父子引用、集合顺序、HEX 颜色和未知字段校验；有效种子也必须校验。
- [x] 构建器读取现有可信 `loadTagFiles()` 输出及角色 JSON；这是构建时适配，不能读用户目录。保留现有 ordinary IDs，创建身份/作品/专属词缺项；冲突使用显式命名空间和映射。
- [x] 保留 `loadTagFiles`/纯 normalise 工具供构建器使用，不能依赖任务 11 将删除的旧 `createTags({sources})` 可变运行实现；生产只加载生成后的base JSON，seed构建模块不参与运行时循环依赖。
- [x] 将现有字符串子分类变成稳定 subcategoryId，依据 `(categoryId,原子分类名称)` 构建确定性 ID。类别名称仍可修改，ID 不变。
- [x] 角色词不从显示名称反推引用；产出 CharacterLinks。`specific:*` 默认不搜索，普通词可被多个角色引用。
- [x] 构建必须确定性：同输入两次 JSON 内容一致、源 hash 一致；不把 Date.now/随机 UUID 写入内置种子。新增用户记录才用宿主 UUID。
- [x] 全量种子逐项验证角色引用均可解析，数量变化有迁移映射说明；测试同名异作品、不规则下划线/括号、ID碰撞和原文不变。
- [x] 运行 targeted + `npm run check`，提交本任务确切文件，不提交 node_modules。

**验收:** 统一种子可重建、引用闭合、804 专属词有去向；不改变当前生产入口。提交：`V1.4.317：建立统一标签种子与稳定身份`（版本提交前缀为候选里程碑，应用版本暂不切换）。

## Task 2：新库原子存储与提交失败语义

**Files:** 新建 `src/modules/tag-library/repository.js`、`tests/tag-library-repository.test.cjs`；补夹具 repository；不重写原 `storage.js` 的其他数据语义。

**Interfaces:** `createLibraryRepository({filePath,backupDir,fsImpl?}): LibraryRepository`；read/save/backupLegacy 合同见第 3 节。`fsImpl` 是仅测试注入的文件系统接口，不暴露给 renderer。

- [x] 先测试原子替换失败仍读到旧文档，使用真实临时目录和注入失败的 rename：

```js
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createLibraryRepository } = require('../src/modules/tag-library/repository');
const { makeBase, emptyUserDocument } = require('./fixtures/tag-library.cjs');
test('failed replace retains the last committed document', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tag-library-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'tag-library-v2.json');
  const original = emptyUserDocument(makeBase());
  const repo = createLibraryRepository({ filePath, backupDir: path.join(dir, 'backups') });
  await repo.save(original);
  const broken = createLibraryRepository({ filePath, backupDir: path.join(dir, 'backups'),
    fsImpl: { ...fs, rename: async () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } } });
  await assert.rejects(broken.save({ ...original, revision: 1 }));
  assert.equal((await repo.read()).revision, 0);
});
```

- [x] RED 后实现：同目录唯一 temp → 写入完整 JSON → sync → 关闭句柄 → 更新有效 bak → rename temp 到正式文件。不要先删除正式文件。
- [x] 异常清理只删本次生成且已解析到允许目录内的 temp；绝不递归删除用户目录。Windows 锁定时返回可重试错误。
- [x] read 区分不存在/非法 JSON/未知 schema/权限错误，非法文件不能返回空文档。
- [x] backupLegacy 使用独占创建和 SHA-256；备份只包含需迁移键，不拷贝密钥/聊天到源码目录。
- [x] 磁盘成功是 commit 的返回前提；不使用旧 storage.set 的返回值判断落盘成功。
- [x] 测试 read 重新打开文件、ENOSPC/EBUSY、损坏 JSON、已有备份、temp残留、目录限制；不只断言 mock.write 被调用。
- [x] `node --test tests/tag-library-repository.test.cjs`、`npm run check`；提交。

**验收:** 所有失败路径保持旧正式文档可读、错误可见。提交：`V1.4.317：增加统一词库原子保存`。

## Task 3：唯一命令服务、引用关系、事件和撤销

**Files:** 新建 `library.js`、`commands.js`、`selection.js`；扩充 `schema.js/index.js`；新建 `tests/tag-library-commands.test.cjs`、`tests/tag-library-selection.test.cjs`、`tests/tag-library-history.test.cjs`；完成真实 `createHarness`。

**Interfaces:** `createTagLibrary({base,repository,ids?,now?})` 实现第 3 节服务；`applyLibraryCommand(document,base,command,{ids,now})` 是纯函数，返回候选文档和变更差量；ids/now 由宿主注入，测试固定。

- [x] 先写“收藏不复制”和跨入口读取测试：

```js
const { createHarness } = require('./fixtures/tag-library.cjs');
test('favorite membership shares the same mutable tag identity', async () => {
  const h = createHarness(); await h.ready;
  const before = h.library.listTags({ scope: 'all', includeAdult: true }).total;
  const placement = { kind: 'favorite', page: { id: 'home' }, group: { id: 'daily' } };
  const added = await h.library.execute({ type: 'favoriteTag', tagId: 'blue_hair', placement }, { operationId: 'favorite-1' });
  assert.equal(added.ok, true);
  assert.equal(h.library.listTags({ scope: 'all', includeAdult: true }).total, before);
  await h.library.execute({ type: 'saveTag', tagId: 'blue_hair', patch: { content: 'azure hair', note: '共享备注' } },
    { operationId: 'edit-1', expectedRevision: h.library.revision() });
  const row = h.library.listTags({ scope: 'favorites', includeAdult: true }).items.find(x => x.id === 'blue_hair');
  assert.equal(row.content, 'azure hair'); assert.equal(row.note, '共享备注');
  assert.equal(h.library.getMemberships('blue_hair').length, 1);
});
```

- [x] 实现 execute 的提交队列：在队列执行时检查 expectedRevision → 纯变换 → 全文档引用校验 → await repository.save → 更新内存/索引revision → 单条 subscribe 事件。禁止“先通知，再保存”。

关键内部顺序按下列骨架实现；`current/base/repository/publish` 为同一个library闭包成员，`validateLibraryDocument/applyLibraryCommand` 是上文已定义函数：

```js
const previous = current;
const prepared = applyLibraryCommand(previous, base, command, { ids, now });
if (!prepared.ok) return prepared;
const checked = validateLibraryDocument(prepared.data.document, base);
if (!checked.ok) return checked;
await repository.save(checked.data);
current = checked.data;
publish(prepared.data.change);
return { ok: true, data: prepared.data.result, revision: current.revision };
```

`prepared.data` 的合同为 `{document:LibraryDocument,change:LibraryChange,result:CommitData,historyDelta}`；historyDelta只记录本命令影响的前后对象，未涉及数据不复制进撤销历史。保存异常由队列统一转 `STORAGE_WRITE_FAILED`，不能让未处理Promise终止UI。
- [x] operationId 去重比较规范化业务命令；同 ID 不同内容 `OPERATION_CONFLICT`；失败允许相同保存重试，不把失败当成功缓存。
- [x] 基础只读记录+字段覆盖合并；显式空值保留，别名替换而非无条件与基础合并。content可改，ID不能改。
- [x] favoriteTag 同tag/同group幂等；move只改指定membership；saveTag+placement中的新页/组/分类全在候选文档生成，任一无效不落盘。
- [x] 实现引用删除保护、restoreTag、批量操作、排序集合完整性和差量撤销/重做；通过反向引用表生成变更事件。
- [x] 结构化 selection 只存引用，home/favorite按tagId去重；角色组装查实时词；bundle保持原文，legacySnapshot保持原文并标状态。selection失败不改变持久化状态。
- [x] 测试重复收藏/双击保存/延迟写并发/版本冲突/失败无事件/清空字段/保留顺序/跨组共享/批量撤销/有引用删词拒绝/组删除搬迁/角色公共词输出。
- [x] `node --test tests/tag-library-commands.test.cjs tests/tag-library-selection.test.cjs tests/tag-library-history.test.cjs`；`npm run check`；提交。

**验收:** 数据上已实现 U01/U03/U06/U07/U14/U15/U16/U19；没有 UI 也可通过真实状态测试证明。提交：`V1.4.317：统一标签内容与收藏归属命令`。

## Task 4：旧数据迁移、差异保留和启动恢复

**Files:** 新建 `migration.js`、`tests/tag-library-migration.test.cjs`；扩展 library 的 ready；新增 `docs/qa/unified-tag-library/migration-contract.md`。

**Interfaces:** `readLegacyInput(storageFilePath): LegacyInput` 严格解析原始文件中 `ai-tag-toolbox-rewrite:app:<key>`；`prepareLegacyMigration({base,legacy,ids,now}): Result<MigrationPlan>`；`createTagLibrary({base,repository,legacyInput?})` 的 ready 在新文件不存在时备份并保存迁移计划。存在合法 v2 时不重新迁移。

- [x] 测试关键冲突：

```js
const { makeBase } = require('./fixtures/tag-library.cjs');
const { prepareLegacyMigration } = require('../src/modules/tag-library/migration');
test('an independently edited favorite never overwrites its source tag', () => {
  const legacy = { version: 1, values: { favorites_shelf_v1: {
    format: 'ai-tag-favorites', version: 1, revision: 1,
    series: [{ id: 'p', name: '旧页', order: 0, color: '#287EA4', colorMode: 'auto' }],
    sections: [{ id: 'g', seriesId: 'p', name: '旧组', order: 0, color: '#287EA4' }],
    entries: [{ id: 'f', kind: 'tag', seriesId: 'p', sectionId: 'g', title: '私人蓝发', zh: '',
      rawText: 'custom blue hair', aliases: [], note: '单独备注', globalSearchable: false,
      pinned: false, nsfw: false, order: 0, sourceTagId: 'blue_hair', sourceCharacterId: null,
      createdAt: 1, updatedAt: 1 }]
  } } };
  let n = 0;
  const result = prepareLegacyMigration({ base: makeBase(), legacy, ids: () => `new-${++n}`, now: () => 1 });
  assert.equal(result.ok, true);
  const custom = result.data.document.customTags.find(x => x.content === 'custom blue hair');
  assert.ok(custom); assert.notEqual(custom.id, 'blue_hair');
  assert.equal(custom.searchable, false); assert.equal(custom.note, '单独备注');
  assert.equal(result.data.document.tagOverrides.some(x => x.tagId === 'blue_hair'), false);
});
```

- [x] 覆盖全部确切旧键，包括 `rewrite_tag_edit_history_v1`。旧历史保留于备份/迁移档案，不伪造成 v2 可执行撤销操作。
- [x] 应用设计规范迁移决策表；冲突收藏保留独立记录，纯相同内容安全引用，损坏/无法解析/超限数据进入 unresolved；不能零条成功但丢弃来源。
- [x] 保留页/组颜色和顺序；旧空section转默认group，已有不同名但同ID冲突拒绝覆盖。
- [x] 专属词/角色身份/旧 fallback角色全部映射；旧选择快照不同于现有记录保留 legacySnapshot；不能把 sourceCharacterId 误当 tagId。
- [x] migrationReceipt记录计数与所有旧ID映射；备份先于保存新文档。迁移报告不输出实际用户原文到普通日志。
- [x] 重启幂等：相同legacy加载两次不重复新增；完成标记只来自合法v2文档，不依赖另一个可能先写成功的布尔键。
- [x] 新文件首次提交前对所需旧键重新计算fingerprint，变化则 `LEGACY_CHANGED_DURING_MIGRATION` 并阻止切换；测试旧版在迁移期间修改收藏的情况。
- [x] 测试迁移中保存失败、备份失败、未知schema、损坏旧root、重复条目、空值、成人状态、不同title/zh、组合换行、旧版本同时存在；新文件存在后不自动覆盖。
- [x] 运行 migration+repository+commands 测试和 `npm run check`；保存 P1 源码检查点；提交。

**验收:** 夹具迁移报告可逐条核对，没有真实用户数据写入。提交：`V1.4.317：迁移旧标签收藏并保留差异`。

## Task 5：主页与收藏门面接入同一库

**Files:** 新建 `tag-adapter.js/favorite-adapter.js`；修改 `tags.js/favorites.js` 工厂支持注入 library；新建 `tests/tag-library-adapters.test.cjs`；更新直接依赖返回形状的夹具。

**Interfaces:** `createTagAdapter({library})`、`createFavoriteAdapter({library})`；最终 `createTags({library})`/`createFavorites({library})` 只返回这些适配器。迁移准备期间旧工厂仅为未切换入口兼容，Task11删除旧写路径。

字段投影：

| 原接口 | 新来源 |
| --- | --- |
| tags.en / tags.zh / tags.nsfw | content / displayName / adult |
| tags.category / tags.subcategory | categoryId / subcategory显示名，增加subcategoryId |
| favorite entry.id / sourceTagId | membershipId / tagId |
| favorite.rawText/title/zh/aliases/note | 同一TagView派生字段，无独立存储 |
| favorite.seriesId/sectionId | group所属pageId / groupId |
| favorite.globalSearchable | searchable，仅兼容字段，不能独立写 |

- [x] 先测试两个入口确实共享：

```js
const { createHarness } = require('./fixtures/tag-library.cjs');
const { createTagAdapter } = require('../src/modules/tag-library/tag-adapter');
const { createFavoriteAdapter } = require('../src/modules/tag-library/favorite-adapter');
test('favorite edit is visible through tags immediately after save', async () => {
  const h = createHarness(); await h.ready;
  const tags = createTagAdapter({ library: h.library });
  const favorites = createFavoriteAdapter({ library: h.library });
  const created = await favorites.saveEntry({ sourceTagId: 'blue_hair', seriesId: 'home', sectionId: 'daily' });
  assert.equal(created.ok, true);
  await favorites.saveEntry({ id: created.data.id, note: '统一备注', title: '蓝色头发' });
  assert.equal(tags.get('blue_hair').note, '统一备注');
  assert.equal(tags.get('blue_hair').zh, '蓝色头发');
});
```

- [x] 明确所有内容/结构写方法改为 Promise<Result>，不能让 UI 把 Promise 当 `{ok:true}`。读接口保持同步，ready前返回明确未就绪或空只读视图。
- [x] saveEntry有sourceTagId时收藏引用；新rawText走统一saveTag；更新entry时定位tagId后编辑共享内容。新UI仅调用统一catalog命令，旧方法留作调用兼容。
- [x] favorites.snapshot.document可保持旧显示投影，但该对象每次从library派生；禁止存在第二个 document/entries 写缓存。
- [x] list/search/copyText/selected/markCopied/historyState/reorder/颜色接口指向同一服务；撤销不是另一份旧favorites文档快照回写。
- [x] 修改selected语义测试：新选择实时引用；另立旧snapshot迁移测试，不能简单删除原本保护用户历史文本的覆盖。
- [x] duplicateEntries使用明确`mode:reference|independent`：新UI默认跨组reference，“另存独立”调用duplicateTag。原同名函数不可悄悄沿用旧复制语义。
- [x] 局部测试 + `npm run check`；此阶段生产preload尚未传library，不需要先改旧UI运行行为；提交。

**验收:** 适配器不能独立保存同一字段，正文同步和同ID选择去重均有测试。提交：`V1.4.317：将主页与收藏适配到统一词库`。

## Task 6：角色身份与专属特征引用统一化

**Files:** 修改 `src/modules/characters.js`、`src/modules/tag-library/selection.js/library.js` 的必要投影；新建 `tests/tag-library-characters.test.cjs`；更新 `tests/characters.test.cjs`、`character-data.test.cjs`、`user-overrides.test.cjs`。

**Interfaces:** `createCharacters({library,characterSource})`；`get/page/select/selected/edit/restore` 保留用途。角色nameZh/aliases从identityTagId读取，通用/专属词均从library.getTag读取；角色edit中的内容字段和关系通过第3节的 `editCharacter {characterId,identityPatch?,links?}` 一次提交，不允许任意执行函数。

- [x] 写公共词跨角色同步测试：

```js
const { createHarness } = require('./fixtures/tag-library.cjs');
test('editing shared traits updates both roles, unlinking affects only one', async () => {
  const h = createHarness(); await h.ready;
  await h.library.execute({ type: 'saveTag', tagId: 'blue_hair', patch: { displayName: '蓝色头发' } },
    { operationId: 'rename-trait', expectedRevision: h.library.revision() });
  const alice = h.library.getCharacterLinks('alice');
  const bob = h.library.getCharacterLinks('bob');
  assert.ok(alice.generalTagIds.includes('blue_hair')); assert.ok(bob.generalTagIds.includes('blue_hair'));
  await h.library.execute({ type: 'saveCharacterLinks', links: { ...alice, generalTagIds: [] } },
    { operationId: 'unlink-alice', expectedRevision: h.library.revision() });
  assert.ok(h.library.getTag('blue_hair'));
  assert.ok(h.library.getCharacterLinks('bob').generalTagIds.includes('blue_hair'));
});
```

- [x] 移除运行时独立terms的内容权威；保留数据源读取仅用于种子构建和审计。specificTagIds不再调用独立可变表。
- [x] 身份输出读取Tag.content；不再固定用`label(row.id)`生成，避免英文修改后仍输出旧角色词。角色ID稳定。
- [x] shared标签事件清理角色名称/别名/系列及搜索缓存；恢复身份词默认也刷新，避免加载后永久停在旧nameZh。
- [x] 新增角色特征必须选择存在的共享tagId；普通缺词不能返回伪造 `{id,en:id}` 掩盖悬空引用，返回可定位错误。
- [x] 去掉人物对象第二份可写名称/别名；返回旧字段是派生兼容，作品/热度/原始trigger仍是只读审计信息。
- [x] 测试专属词可编辑与复制、默认不全局搜索、身份改词不改角色ID、同名异作品、删除引用保护、成人词在角色输出中过滤、已加载角色名即时刷新。
- [x] 跑角色相关测试 + `npm run check`；提交。

**验收:** U11/U12/U13；角色资料和标签内容职责明确。提交：`V1.4.317：统一角色身份与特征标签引用`。

## Task 7：统一搜索、搜索开关和 AI 查询

**Files:** 新建 `search.js`；修改 library/tag-adapter/favorite-adapter 查询实现、`primary-tools.js`、`primary-agent.js`、`translation.js`；新建 `tests/tag-library-search.test.cjs`；更新 favorites-search/tool、character-tools、translation-matching 测试。

**Interfaces:** `createTagSearchIndex({getTags,getMemberships,getCharacterLinks,getStructure})`，方法 `search(query,options)`、`invalidate(change)`；库的search返回统一Page。AI保留旧工具名，输出schema增加id/kind与收藏位置摘要，组合走有界内容投影。

- [x] 搜索资格测试：

```js
const { createHarness } = require('./fixtures/tag-library.cjs');
test('search disabled is consistent across discovery scopes, not browsing', async () => {
  const h = createHarness(); await h.ready;
  await h.library.execute({ type: 'favoriteTag', tagId: 'blue_hair', placement: { kind: 'favorite', page: { id: 'home' }, group: { id: 'daily' } } }, { operationId: 'f' });
  await h.library.execute({ type: 'saveTag', tagId: 'blue_hair', patch: { searchable: false } },
    { operationId: 'hide-search', expectedRevision: h.library.revision() });
  for (const scope of ['all', 'favorites']) {
    assert.equal(h.library.search('blue hair', { scope, includeAdult: true }).items.some(x => x.id === 'blue_hair'), false);
  }
  assert.ok(h.library.listTags({ scope: 'favorites', includeAdult: true }).items.some(x => x.id === 'blue_hair'));
  assert.ok(h.library.getTag('blue_hair'));
});
```

- [x] 索引更新资格谓词统一：有query时searchable；任何用户/AI可见查询都成人过滤；scope先过滤后排序/分页/total，不能先截页再过滤。
- [x] 名称、内容、显式别名全索引；内部收藏额外notes/页组名匹配保留，但不把备注暴露到AI普通搜索内容。高亮坐标映射Unicode原文，沿用已有normalized map。
- [x] Tag多收藏归属只返回一次，locations列全部合法归属；同名异ID保留独立。
- [x] tags.search不再将同一收藏文本作为第二份favorites结果附加；AI输出新schema清楚标kind。兼容过渡中旧字段若存在不得重复同tagId；最终prompt与schema统一。
- [x] characters.search先过滤身份词搜索/成人资格，再解析角色；不可独立搜索的专属词仍可从明确角色关系读取。原文输出按真实Tag.content。
- [x] 翻译词库索引改为仅单tag且searchable/adult满足当前设置；它可能通过tags.list/all建立词典，不能只改tags.search漏掉此旁路。
- [x] AI限制继续生效：tags最多200项、角色最多10项；单Tag内容过长不冒充完整值；bundle使用16000字符预算和contentOmitted，不裁出可被误用的半个权重Prompt。
- [x] 测试所有精度和scope、别名删除、metadata更新、hidden/成人旁路、重复收藏、分页total、Unicode高亮、角色新名称、工具结构和只读性。
- [x] 跑search/tool/translation目标测试 + `npm run check`；保存P2；提交。

**验收:** U08/U09/U10，AI工具不能绕过统一检索规则。提交：`V1.4.317：统一标签搜索和AI查询投影`。

## Task 8：唯一标签编辑弹窗与位置选择器

**Files:** 新建 `src/views/tag-editor-view.js`、`tag-location-view.js`、`src/tag-editor.css`、`tests/tag-editor-view.test.cjs`、`tests/tag-location-view.test.cjs`；增加中英文locale键。此任务先测试组件，不改生产装配。

**Interfaces:**

```js
createTagEditorView({ document, catalog, notify, getLocale, confirmDiscard })
// => open({ tagId?, membershipId?, placement? }), save(), requestClose(), isDirty(), dispose()
createTagLocationView({ document, catalog, getLocale })
// => choose({ kind:'taxonomy'|'favorite', current?, draft? }): Promise<Placement|null>, dispose()
```

`catalog`仅使用第3节TagLibrary投影接口；renderer拿不到repository。位置选择器返回选择草稿，不直接写库。confirmDiscard返回`save|discard|stay`，不使用同步window.confirm模拟三按钮。

- [x] 测试空白格与取消无写入：

```js
const { JSDOM } = require('jsdom');
const { createHarness } = require('./fixtures/tag-library.cjs');
const { createTagEditorView } = require('../src/views/tag-editor-view');
test('new favorite editor cancellation leaves no tag or placement', async () => {
  const h = createHarness(); await h.ready;
  const dom = new JSDOM('<body><button id="origin">新增</button></body>');
  const editor = createTagEditorView({ document: dom.window.document, catalog: h.library,
    notify() {}, getLocale: () => 'zh-CN', confirmDiscard: async () => 'discard' });
  const count = h.library.listTags({ scope: 'all', includeAdult: true }).total;
  await editor.open({ placement: { kind: 'favorite', page: { id: 'home' }, group: { id: 'daily' } } });
  const input = dom.window.document.querySelector('[data-tag-field="content"]');
  input.value = 'new tag'; input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await editor.requestClose();
  assert.equal(h.library.listTags({ scope: 'all', includeAdult: true }).total, count);
  assert.equal(h.library.getMemberships().length, 0);
  editor.dispose(); dom.window.close();
});
```

- [x] 实现7类字段和kind切换；所有表单字段由同一绑定代码读取。输入法处理、Ctrl/Cmd+Enter、Esc、焦点圈定、aria-labelledby、错误聚焦完整。
- [x] 显式保存快照：打开记录baseRevision，输入只改局部draft；异步保存前冻结本次payload，成功才关闭；重复点击复用operationId。
- [x] 已收藏模式显示分组位置，未收藏显示分类位置；多归属需选membership。分类摘要可切taxonomy模式，收藏不消除分类。
- [x] 选择器父子级新建只返回ParentChoice/ChildChoice；父级变化清子级；重复名称在同父级拒绝并提示已有项。
- [x] 保存失败保留输入且可重试；冲突显示“标签已在其他位置修改，重新加载后再保存”，不能自动覆盖。
- [x] 恢复默认通过明示按钮提交一次restoreTag；若弹窗存在未保存输入先走同一个关闭保护流程，不混合自动保存。
- [x] 未保存弹窗切换到另一标签时，先保存/放弃/留下；位置子弹窗取消仅返回父编辑弹窗，不丢草稿。
- [x] 测试字段清空、别名短语、多行Prompt、创建嵌套结构取消、保存失败/双击/并发、键盘/焦点、重复归属、共享提示以及纯文本备注/XSS。
- [x] `node --test tests/tag-editor-view.test.cjs tests/tag-location-view.test.cjs`，`npm run check`；提交。

**验收:** 编辑和位置组件可以对真实内存library完成新增/收藏/改内容，不依赖旧侧栏。提交：`V1.4.321：增加统一标签编辑与位置弹窗`。

## Task 9：生产入口切换、全页面同步和关闭保护

**Files:** 修改 `preload.js`、`main.js`、`src/app.js`、`src/app-view.js`、`src/index.html`、`src/views/favorites-view.js`、`characters-view.js`、favorites.css/characters.css；新建 `tests/tag-library-ui-integration.test.cjs`；更新UI/窗口关闭/收藏close/workbook/角色view测试。

**Interfaces:** preload仅构造一个library，再将它注入tags/favorites/characters/AI工具；`AppModules.catalog`暴露白名单query/execute/ready/subscribe/flush，不暴露FS。`App.flushBeforeClose()`先统一editor.requestClose，再catalog.flush，再既有assistant/settings持久化。

- [x] 增加端到端 DOM 测试：使用真实library、tags/favorites/characters适配器，JSDOM加载实际app/view脚本；仅剪贴板和原生窗口关闭回调可替身。
- [x] 初始化流程：UI显示“正在准备标签库” → await catalog.ready → 初始化视图；失败显示可恢复错误、禁止增改。不能因ready失败继续展示一个可写空库。
- [x] `main.js`单实例保护和second-instance激活已有窗口；测试模拟Electron接口，禁止强杀当前用户进程。解释旧版未实现锁的兼容限制，部署时不能同时激活旧版和新版迁移。
- [x] 装配唯一tagEditor/tagLocation；主页star打开位置选择器，不跳收藏页；已有收藏star可显示状态但不重复新增。
- [x] 收藏空白格和编辑铅笔调用同一tagEditor.open；删除旧favorite-editor、favorite-quick-editorDOM、300ms自动保存计时器、旧编辑字段事件和旧侧栏CSS。
- [x] 角色特征铅笔调用统一tagEditor；人物资料编辑仅保留角色关系/作品用途，身份Tag字段通过统一编辑器。保留之前移除列表星标的结果。
- [x] 异步门面全部await：saveEntry/savePage/saveGroup/delete/batch/reorder/select/restore等不能沿用同步safeCall判断。枚举调用点并在报告逐个列出，测试慢Promise。
- [x] 页组浏览不再渲染时隐式ensureTagColumns写数据。默认页组由ready初始化/用户命令创建，render纯读。
- [x] 统一subscribe通知刷新首页cache、收藏投影、角色索引和底部选择；内容更新局部刷新，不能抢滚动和编辑焦点。dispose解除订阅/事件/定时器。
- [x] 备注tooltip、Tag内容、显示名称、别名、页组名称和搜索高亮全部用纯文本节点渲染；替换当前renderTags中把item.en/zh拼进innerHTML的路径，加入恶意字符串DOM测试。统一选中去重，增加共享变更来源提示。
- [x] 关闭窗口/切路由/新建另一条都调用同一保存保护。新输入不会被前一次异步保存完成清掉；Ctrl+Z输入与全库撤销不冲突。
- [x] 集成测试完整流程：主页blue_hair→收藏指定分组→收藏编辑内容/别名/备注→主页和两个角色立即同步→关闭搜索→所有search不命中而分组可浏览→取消收藏→Tag仍在。
- [x] 运行 `npm run check`；记录P3已接入但未人工验收；提交，不立刻把中间版发桌面。

**验收:** U02/U04/U05/U16/U20/U22，真实DOM中旧编辑区域不再存在。提交：`V1.4.321：接入统一标签编辑和跨页同步`。

## Task 10：迁移报告界面、导入导出与批量操作完成

**Files:** 新建 `tag-library/transfer.js`、`tests/tag-library-transfer.test.cjs`；修改 `favorites-transfer.js/favorite-adapter.js`、收藏视图和preload白名单；增加迁移报告只读视图（复用现有dialog框架，可放 `src/views/tag-migration-view.js`）。

**Interfaces:** `exportLibrary(library,{scope:'all'|'favorites'})` → `LibraryBundle`；`previewLibraryImport(library,bundle)` → `Result<ImportPreview>`；`applyLibraryImport(library,previewId,{operationId,expectedRevision})` → Promise<Result>。三者分别是 library.exportBundle/previewImport/execute(applyImport) 的便捷调用名，不拥有状态。transfer导出纯 `projectLibraryBundle({base,document,scope})` 和 `prepareImportCandidate({base,document,bundle,ids,now})`，前者返回LibraryBundle，后者返回Result<{document,preview:ImportPreview,change:LibraryChange}>。预览候选仅在宿主library实例内存保存，输入文件不提供可执行脚本。

```ts
type LibraryBundle = {
  format: 'ai-tag-library'; version: 2; scope: 'all' | 'favorites';
  tags: TagRecord[]; categories: Category[]; subcategories: Subcategory[];
  pages: FavoritePage[]; groups: FavoriteGroup[]; memberships: FavoriteMembership[];
  characters: CharacterLinks[];
};
type ImportPreview = {
  id: string; basedOnRevision: number;
  counts: { added: number; reused: number; conflicts: number; invalid: number };
  warnings: string[];
};
```

- [ ] 先写 round-trip 与ID冲突测试：导出共享Tag在两个组的引用，导入新库后仍是一条Tag/两个归属，原文保持；相同外部ID但不同内容不能覆盖本地。
- [ ] 全库导出只导用户可用字段和所需基础定义；收藏导出只导被引用Tag及必要分类/结构；角色关系必须连同引用闭包导出或明确不包含无关角色。
- [ ] 导出闭包规则固定：全库包含全部有效Tag、分类、收藏关系及CharacterLinks；仅收藏包含memberships指向的Tag和必需分类/页/组，`characters=[]`，其source字段仅作来源说明。导入全库中本机不存在的角色关系时作为外来关系记录进入unresolved，不伪造随包人物资料；标签和收藏仍按预览可导入。
- [ ] 32MiB先检查再parse；只接受JSON/现有粘贴文本，拒绝未知版本/字段类型/悬空ID/不合法parent/重复IDs；错误不改变当前revision。
- [ ] v1收藏与paste接入prepareLegacyMigration共用转换规则，不再saveEntry逐条半提交；UTF-8/换行/权重原文保留。
- [ ] 导入预览和commit绑定revision，预览后其他保存发生则重新预览；取消preview丢弃候选，无写入。
- [ ] 迁移报告展示关联/独立保留/待修复数量，支持导出待处理原记录，敏感源数据不进普通日志。存在 unresolved 项不阻止其他有效数据浏览。
- [ ] 批量移动/复制引用/另存独立/取消收藏/搜索开关/置顶/颜色/撤销调用同一批量服务；搜索结果冻结全部ID而非当前页。
- [ ] 测试v1兼容/标签组合/成人搜索标记/取消导入/过大文件/共享关系/ID冲突/文件损坏/批量失败回滚/跨页多选和30步撤销上限。
- [ ] targeted transfer+favorites regressions，`npm run check`；提交。

**验收:** U17/U18/U21可用，格式变化不会把旧备份变成无法导入。提交：`V1.4.321：完成统一标签备份迁移与批量整理`。

## Task 11：删除旧权威路径、最终验收与桌面候选版

**Files:** 修改旧modules/测试护栏去除临时兼容写实现；新增 `scripts/package-unified-tags.cjs`；更新 package.json/package-lock.json/VERSION.txt/main.js/preload.js/src/index.html/README.md/CHANGELOG.md/deployment-verification.json/启动说明.txt/交付说明；完成QA矩阵。

- [ ] 检查最终生产图：只有一个TagLibrary、一个编辑器、一个位置选择器。tags不再写rewrite_custom_tags，favorites不再写favorites_shelf_v1，characters不再写第二份身份名称/专属词。旧键仅迁移和兼容导入读。
- [ ] 删除临时工厂分支；旧测试夹具迁移到真实library实例，保护仍有效行为，不能为了通过删掉成人/复制/历史保护测试。
- [ ] 扩充ui-architecture/check护栏：view不import repository/Node/storage，AI工具无写catalog命令，payload不传任意FS路径。检查所有异步mutation调用处已await。
- [ ] 验证关键场景矩阵（见第4节），每条标明对应测试文件和真实命令输出。任何未验证项不能自动标PASS。
- [ ] 运行完整必需检查：

```powershell
npm run check
node scripts/build-unified-tags.mjs --check
git diff --check
```

`--check`比较生成结果和随包文件，不在验证时静默改数据。真实API和Electron慢测按AGENTS默认跳过，记录为“未执行”。

- [ ] 记录性能：同机baseline与新版本、固定种子全库、10k收藏夹具，加载/首次搜索/重复搜索/编辑一次耗时；发现显著退化先定位读盘、索引重建或全库序列化，不通过减少数据量掩盖。
- [ ] 更新候选版本为V1.4.321（若现版本已前进则取下一内部版本）；`scripts/check.mjs`版本断言和所有用户可见版本一并更新；运行最终npm check。
- [ ] 本地提交后按现有 `work/package-character-list-v14316.cjs` 的已验证做法抽取可重用打包脚本：明确文件白名单、源码commit、asar、app/resources/app副本、解包native依赖和models保留；不复制AppData用户文件。
- [ ] 先在work/staging完整打包和hash验证，再备份桌面当前目录，再复制最终包。所有递归复制/移动目标先验证绝对路径。旧版正在运行时保留旧目录并说明，不强行关闭或删除。
- [ ] 从实际桌面副本核对package/标题/preload/VERSION/exe版本、源码和asar哈希，检查unified种子存在且源映射正确。
- [ ] 交付说明写明：首次打开迁移、共享修改影响范围、搜索开关含义、取消收藏与删除区别、角色关联、组合原文、未发送选择变化、备份/回退、旧版同时运行限制。
- [ ] 用户人工验收清单随包提供；最终回复区分“自动检查已通过”和“实际Electron窗口尚待用户验收”。
- [ ] 更新执行账本与计划复选框，保留未完成/未验证项，停下等待此次用户反馈，不自动加新需求或发布。

**验收:** 已有代码、模块测试、迁移夹具、DOM行为、桌面产物能相互对应；有一项实质必需行为失败就不能宣称“全面统一完成”。提交：`V1.4.321：交付统一标签与收藏角色编辑`。

## 4. 场景验收矩阵（执行时填证据路径）

| 用例 | 操作 | 必须验证的数据/界面结果 | 主任务 |
| --- | --- | --- | --- |
| A01 | 主页收藏蓝发 | Tag总数不变、membership+1、位置正确 | 3/9 |
| A02 | 再次收藏到同组 | 不重复、不重排、提示已存在 | 3/8 |
| A03 | 收藏到第二组后改名 | 两组+主页同时改，仍同tagId | 3/5/9 |
| A04 | 收藏空白格新建 | 用统一弹窗，保存一次出现Tag和归属 | 8/9 |
| A05 | 新建页/组后取消整次编辑 | Tag/页/组数量均不变 | 3/8 |
| A06 | 修改英文内容和清空中文/别名/备注 | ID不变，新词可搜，旧别名不复活 | 3/7 |
| A07 | 已收藏条目移动组，再取消收藏 | 原分类保留，其他归属不误移 | 3/9 |
| A08 | 改searchable=false | 全部发现式搜索不返回，分类/分组仍可编辑 | 7 |
| A09 | 标成人且关闭成人显示 | 主页/收藏/角色特征/AI输出一致过滤 | 6/7/9 |
| A10 | 专属制服Tag编辑/收藏 | 同一存储生效，不再找不到Tag | 6/9 |
| A11 | 公共蓝发关联两角色，移除一角色关系 | 另一个仍有，公共Tag仍在 | 6 |
| A12 | 角色名/别名修改 | 列表、搜索、AI立即更新，角色ID不变 | 6/7 |
| A13 | 复杂组合换行/权重/括号 | 保存、复制、导入导出逐字一致 | 3/10 |
| A14 | 同Tag从主页和收藏选中 | 底部仅一个引用，改内容立即更新 | 5/9 |
| A15 | 旧选择快照与收藏正文不同 | 保留原快照，明确可替换，不静默改历史 | 4 |
| A16 | 保存时模拟磁盘失败/重试/双击 | 无假成功、无重复、草稿保留 | 2/3/8 |
| A17 | 编辑期间其他入口更新同Tag | 版本冲突可见，不覆盖新值 | 3/8 |
| A18 | 连续新增/批量移动/撤销/重做/分页 | 全部对象被操作，顺序和引用完整 | 3/10 |
| A19 | 重启两次/迁移失败重试 | 不重复、不丢差异/损坏原始记录 | 4 |
| A20 | v1/v2导入、冲突ID、超大/损坏文件 | 预览明确、全有或全无、原库不变 | 10 |
| A21 | Esc/切页/关窗口/输入法 | 不自动丢草稿，焦点恢复，无意外提交 | 8/9 |
| A22 | 全库搜索多个收藏归属 | 一Tag一结果，位置可定位 | 7/9 |
| A23 | 静态生产引用扫描 | 旧编辑DOM/timer/第二套内容存储不再使用 | 11 |
| A24 | 桌面包核对与用户点击清单 | 版本和hash一致；人工结果独立记录 | 11 |

人工窗口清单至少包括：普通/最大化窗口、键盘Tab/Shift+Tab/Esc、中文输入法、多行内容、移动选择器新建、长备注悬停、保存失败提示、角色同步、桌面重新打开后的持久化。

## 5. 恢复执行与防止流程失控

执行账本固定位置：`docs/qa/unified-tag-library/execution-ledger.md`，每完成任务记录：

```text
Task N: pending | running | review | complete | blocked
输入基线：commit / 文件检查点
本次范围：具体文件
实现代理：真实ID（没有则写无）
验证：命令、退出码、数量、日志路径
审查：具体问题、修复轮次、证据
当前遗留：只列仍实际存在的缺口
下一步：唯一紧邻任务
```

- 中断后先看实际文件/账本/代理状态，不从Task0重跑，不复用别的项目进度。
- 设计问题依据规范裁定并记录；不能为了重复审查无止境追加新里程碑。
- 一次只允许一个实现者修改共享源文件；独立只读检查可以同时进行。
- 子代理需读任务完整简报、共享合同和输入输出；审查者只评当前任务及明确依赖风险。不得把任务9尚未接UI当任务3数据服务失败，也不得把整体未集成说成产品完成。
- 审查缺口必须通过代码/测试确认；API返回字段、真实await调用和实际文件不可被“已完成”总结替代。
- 未启动review就不能声称“等待review”；空闲且无运行代理时必须立即做下一项已授权工作或明确报告实际阻塞。
- 只在有代码变化、失败或明确新风险时重跑全量检查；只读文档规划不运行应用测试冒充实现进度。

## 6. 计划自检记录

- [x] 对应所有用户字段：内容、显示名称、别名、备注、移动、新建两级位置、成人、搜索开关。
- [x] 主页/收藏/角色/AI均有明确改动任务，不止定义新schema。
- [x] 角色专属词、身份词、作品词、通用特征有迁移与引用方案。
- [x] 旧收藏原文、冲突元数据、组合、快照、空坏记录都有去向。
- [x] 写盘返回、同步/异步接口切换、关闭保护和单实例都有任务。
- [x] 旧设计被替代的行为明确列出，不同时保留互相矛盾的测试预期。
- [x] 桌面包、旧版占用、版本规则和人工验收要求明确。
- [x] 没有把已有306项测试通过当作新实现通过。

执行从 Task 0 开始；本轮规划完成不等于已经授权迁移或已经实现上述功能。用户确认开始后，沿此计划完成一个整体候选版。
