# 快捷收藏页更新计划书

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. 独立子任务适合并行时可选 superpowers:subagent-driven-development；默认按下列依赖顺序实施。Steps use checkbox (`- [ ]`) syntax.

**Goal:** 基于 V1.4.32 增加一个以快捷查找、复制和编辑为核心的独立收藏页，完整保存单 Tag、组合和用户原文。

**Architecture:** 复用现有 chip 风格、CommonJS 工厂、原生 DOM 和 JSON Storage。收藏数据由 Favorites 独占，页面由 FavoritesView 独占；只在路由、底部组合和查询工具处增加窄接口，不重构 Tags/Characters/Runtime。

**Tech Stack:** Electron、Node.js CommonJS、HTML/CSS、node:test、jsdom；现有 Acorn/ESLint 检查；TSV 如无可复用解析器，使用 `csv-parse/sync`。

**Spec:** [快捷收藏页设计说明](../specs/2026-09-18-quick-favorites-design.md)。执行者先读设计说明，再读本计划；行为规则以设计说明和本次用户后续指令为准。

## V1.4.33 执行记录

用户在计划归档后已授权开始实施。下文“本轮不执行”指原计划写作轮；任务清单保留原始规划语义。实现说明见 [交付说明](../../../交付说明-V1.4.33.md)，最终桌面构建证据见包内 `build-info.json`。

| 范围 | 实施结果与验证 |
| --- | --- |
| Task 0 | 版本统一为 1.4.33，固定 csv-parse 7.0.2，建立独立功能分支 |
| Tasks 1/4/5/6/8/9 数据接口 | 同一 Favorites 工厂统一管理状态、排序缓存、查询、历史、选择和导入；39 项领域测试通过 |
| Tasks 2/3/4/5/8/9 页面 | 收藏架、编辑、定位、筛选、配色、管理、备份及本地化；32 项聚焦 DOM 测试通过 |
| Tasks 2/6/7/10 集成 | 独立路由、底部快照、全局查询、关闭等待；移除旧抽屉及重复状态；真实模块页面联动已覆盖 |
| Task 11 | 3,000/10,000 条纯数据及 jsdom 基准已运行；首批 240 条；Electron 布局与原生行为留给人工验收 |
| Task 12 | 按最终 Git 提交生成干净目录检查和桌面包，源码镜像、asar、运行时与模型校验记录在 build-info |

实际提交按模块所有权合并紧密耦合任务，避免同一工厂中产生中间不一致的状态实现。采用单个按 revision 失效的排序缓存与可见列分批加载，未引入额外数据库或虚拟列表框架。删除系列默认移入“未分类”由一个领域事务完成；编辑区关闭先保存，明确放弃与 Esc 才取消草稿。

## 1. 范围与执行规则

- 本文只规划收藏页，本轮不执行功能代码、不升版本、不同步可执行程序。
- 基线：`bdde91e`，`F:/codex/AI绘画Tag工具箱/ai-tag-release-v143`，V1.4.32。
- 首个内部交付目标 V1.4.33，开工时核对最新版本；不覆盖已有新版本，不擅自升正式版。
- 每个编号任务单独提交；同轮内部提交可使用同一目标内部版本，但每项行为必须独立可验。
- 必跑 `npm run check`。真实应用 --uitest/--smoke/--i18ntest 默认不跑，交用户人工验收。
- 改同一问题 2–3 次仍未解决就记录原因、停止该项，不反复替换方案。
- 一轮停下时只同步最终可测试的内部版。中间提交不是对用户的多个交付包。
- 不 push、不建 Release、不调用真实付费 AI。
- 只增加已有方案必需的数据校验、存储失败反馈和撤销，不建立权限层、审计平台或通用事件框架。
- 顶部快捷定位、内部搜索、全局查询可发现性是三种不同操作，不用同一个开关混管。
- 文档内容是待实现契约，下面未勾选项不是完成记录。

### 本轮工程依据

已读取 `writing-plans`。A0 收据：route `code-quality-workflow`，snapshot `2026-08-18`，文档 `ST-A0`，无设计目录候选；目标是写出已讨论功能的计划，红线是不改产品代码/基础协议，验收为需求覆盖、接口一致性、文档自查及现有快速检查。

## 2. 实际代码现状

| 位置 | 当前行为 | 实施影响 |
| --- | --- | --- |
| `src/app-view.js:597` 附近 | 旧收藏抽屉读 Assistant 收藏方法 | 换成独立页，不能复制一套抽屉再同时绑定 |
| `preload.js` 的 Assistant 暴露对象 | 未暴露旧 `listFavorites/addFavorite/removeFavorite` | 直接接 `AppModules.favorites`，不先修旧桥再建新桥 |
| `assistant.js` 中 `rewrite_favorites` | 原结构是名称加站内 Tag ID 数组 | 一次性迁移到原文快照，保留旧键供恢复 |
| `tags.select()` | 只接受已存在于词库的 ID | 自由输入不能靠调用它冒充已收录 Tag |
| `#chips` 点击处理 | 主点击既选中又复制；.cp 只复制 | 新收藏页沿用此习惯；复制/编辑用独立按钮 |
| `combinedSelectionValues()` | 合并普通词与角色词并做既有去重 | 收藏快照另加一段，不让组合取消修改手动选择 |
| `primary-tools.js tags.search` | 返回严格 schema 的普通 `items` | 只增加可选 `favorites` 字段；同步测试及说明 |
| `translation-alignment.js` | 可识别部分 Tag 结构，也会退化为单词/句块 | 只能用于可靠的展示计数，不能直接当任意 Prompt 的无损编辑解析器 |
| `main.js/preload.js` 关闭保存 | 窗口关闭前停止任务并等待存储刷新 | 新收藏编辑草稿也必须在同一关闭流程里提交，不能只刷新旧持久值 |

开工前用 `rg` 定位函数，不依赖上表行号永久不变。若实际源码已改动，先合并新的事实并更新任务边界。

## 3. 文件地图

| 操作 | 文件 | 唯一职责 |
| --- | --- | --- |
| 新增 | `src/modules/favorites.js` | 数据、迁移、CRUD、系列颜色、索引搜索、撤销、已选快照 |
| 新增 | `src/modules/favorites-transfer.js` | JSON/TSV/纯文本的纯转换与校验 |
| 新增 | `src/views/favorites-view.js` | 收藏页面状态、事件、草稿、搜索结果、定位 |
| 新增 | `src/favorites.css` | 收藏布局及主题变量；不全量改 app.css |
| 新增 | `assets/icons/favorites.svg`、`assets/icons/LICENSE-lucide.txt` | 本地 Lucide 图标 sprite 与许可证；不加载远程资源 |
| 修改 | `src/modules/index.js` | 导出 Favorites 工厂 |
| 修改 | `preload.js` | 创建单实例、暴露 API、关闭前草稿提交 |
| 修改 | `src/app-view.js`、`src/app.js`、`src/index.html` | 路由、底部汇总、收藏当前组合、必要挂载 |
| 修改 | `src/modules/assistant.js`、`primary-tools.js`、`primary-agent.js` | 只读查询注入、旧收藏状态退役、工具结果说明 |
| 修改 | `locales/zh-CN.json`、`locales/en-US.json` | 收藏控件及状态文案 |
| 修改 | `package.json`、`package-lock.json`、`VERSION.txt`、`main.js`、`scripts/check.mjs` | 目标版本、必要依赖、版本一致性 |
| 新增 | `tests/helpers/favorites-fixture.cjs` | 可复用内存数据/页面 fixture |
| 新增 | `tests/favorites-store.test.cjs`、`tests/favorites-view.test.cjs` | 数据和页面行为 |
| 新增 | `tests/favorites-search.test.cjs`、`tests/favorites-selection.test.cjs` | 内部/全局搜索和底部快照 |
| 新增 | `tests/favorites-transfer.test.cjs`、`tests/favorites-integration.test.cjs` | 导入导出与真实组装边界 |
| 新增 | `scripts/benchmark-favorites.mjs` | 固定规模纯数据基准，仅需要时执行 |
| 修改 | `tests/ui-dom.test.cjs`、`tests/ui-architecture.test.cjs`、`tests/window-close.test.cjs`、`tests/character-tools.test.cjs` | 现有模块回归覆盖 |
| 修改 | `README.md`、`项目当前架构与统一重构规划.md` | 只记录实际完成的接口和边界 |

如果 FavoritesView 超出约 800 行且编辑区有独立状态，再把编辑区拆成 `src/views/favorite-editor.js`；这是明确的复杂度触发点，不在第一步预建。不为每种按钮新建一个模块。

## 4. 接口契约

以下名称在所有任务中一致。实现可分阶段增加方法，不使用临时 API 名称。

### 4.1 结果与基础类型

```js
// Mutation/read failure envelope; business errors do not silently report success.
const success = { ok: true, data: {}, revision: 1 };
const failure = { ok: false, error: { code: 'ENTRY_NOT_FOUND', message: '收藏不存在' } };

// Entry fields:
const entry = {
  id: 'entry-1',
  kind: 'tag', // 'tag' | 'bundle'
  seriesId: 'series-1',
  sectionId: null,
  title: '',
  rawText: 'blue_hair',
  zh: '蓝发',
  aliases: [],
  note: '',
  globalSearchable: true,
  pinned: false,
  nsfw: false,
  order: 0,
  sourceTagId: null,
  createdAt: 0,
  updatedAt: 0
};

// Selected snapshots do not point to mutable Entry objects.
const selection = {
  entryId: 'entry-1', kind: 'tag', title: '',
  rawText: 'blue_hair', nsfw: false, sourceUpdatedAt: 0
};
```

Series/Section/Bundle 数据形状见设计说明第 9 节。允许标题重复；不允许悬空 seriesId/sectionId、重复 ID 或错误版本。保存原文只检查非空等结构条件，不纠正用户的 Prompt 含义。

### 4.2 Favorites 数据接口

```js
createFavorites({ storage, tags });
// returns one frozen API instance:
favorites.snapshot(); // { document, revision, loadError, migrationReport }
favorites.series(); // Series[] in stored order
favorites.sections(seriesId); // Section[]
favorites.getEntry(id); // Entry | null
favorites.list({
  seriesId, sectionId, includeAdult: true,
  offset: 0, limit: 80, view: 'shelf' // 'shelf' | 'recent'
}); // { items: Entry[], total, hasMore }

favorites.saveSeries({ id, name }); // Result<Series>; absent id creates
favorites.saveSection({ id, seriesId, name }); // Result<Section>
favorites.saveEntry(entryPatch); // Result<Entry>; absent id creates
favorites.saveEntry(entryPatch, { historyKey: 'editing-entry-1' }); // coalesced editing history
favorites.applyBatch({ ids, patch }); // Result<{ updated: number }>
// patch accepts only seriesId, sectionId, pinned, globalSearchable.
favorites.duplicateEntries({ ids, seriesId, sectionId }); // Result<{ ids: string[] }>
favorites.deleteEntries(ids); // Result<{ removed: number }>
favorites.deleteSection(id); // Result; children move to series root
favorites.deleteSeries(id, { mode: 'move', targetSeriesId }); // Result
favorites.deleteSeries(id, { mode: 'delete' }); // explicit destructive action
favorites.reorder({ kind: 'series', parentId: null, ids }); // Result
// kind: 'series' | 'section' | 'entry'; root entries use series ID,
// section entries use section ID; IDs are unique across entity types.
favorites.setSeriesColors(ids, { mode: 'custom', color: '#287EA4' }); // Result
favorites.setSeriesColors(ids, { mode: 'auto' }); // Result

favorites.search(query, {
  scope: 'internal', // 'internal' | 'global'
  seriesId, sectionId, kind: 'all', includeAdult: true,
  offset: 0, limit: 80
}); // { items: SearchHit[], total, hasMore, revision }

favorites.copyText(ids); // string; supplied order; no title/note
favorites.markCopied(ids); // successful-copy recency, max 20 IDs
favorites.setSelected(id, selected); // Result<Selection[]>
favorites.selected({ includeAdult: true }); // Selection[]
favorites.clearSelected(); // Result; does not clear shelf
favorites.undo(); // Result; content/structure history only
favorites.redo(); // Result
favorites.historyState(); // { canUndo, canRedo }
favorites.subscribe(callback); // callback({ revision, changedEntryIds, structureChanged }); returns unsubscribe
favorites.flush(); // Promise<boolean>; false means disk save failed

favorites.exportBundle(); // plain ai-tag-favorites/version=1 document
favorites.previewImport(value, { mode: 'append' }); // Result<ImportPreview>
favorites.importBundle(value, { mode: 'append' }); // Result<ImportReport>
// mode: 'append' | 'replace', same validation on preview and apply
```

- `saveEntry` 不修改旧条目的其他字段；创建时 `globalSearchable` 默认为 true。
- `applyBatch` 的操作 ID 在点击时冻结；移动到另一个系列时无效 sectionId 必须归该系列根部或返回明确错误。
- `reorder` 必须给出该父级的完整 ID 排列；不能丢元素、重复元素或把不同父级混进一个数组。
- 每个成功 mutation 只增加一次 revision、持久化一次、发布一次变化事件。
- 编辑合并使用 `saveEntry(patch, {historyKey})` 的可选第二参数，同一编辑会话合并为一项历史；`historyKey` 由视图创建，离开输入字段/条目后更换。
- `markCopied`、搜索条件、缩放和 recency 不污染编辑撤销栈。
- `flush` 只反映 Favorites 已提交状态的存储刷新；提交尚未保存的页面草稿由 View 负责。

SearchHit：

```js
({
  entryId: 'entry-1',
  kind: 'tag',
  title: '', rawText: 'blue_hair', zh: '蓝发',
  seriesId: 'series-1', sectionId: null,
  seriesName: '外貌', sectionName: '',
  color: '#287EA4',
  memberCount: 1, // null when reliable counting is unavailable
  matches: [{ field: 'rawText', start: 0, end: 4 }],
  score: 100
});
```

匹配索引是相应原字段的 UTF-16 offset，不能直接拿归一化字符串的位置截取原文；无法准确映射的命中按整字段强调，不能高亮错误文本。备注命中可附单独 snippet，但不得加入 rawText。

### 4.3 页面接口与关闭流程

```js
createFavoritesView({
  document, favorites, preferences,
  copy, notify, localize,
  onSelectionChange
});
// copy(text): Promise<boolean>
// localize(key, fallback): string
// returns:
view.bind(); // idempotent
view.enter();
view.leave(); // Promise<boolean>; commits valid drafts, retires stale render work
view.render();
view.openCreate({ kind: 'tag', rawText: '', seriesId, sectionId });
view.openEditor(entryId);
view.focusEntry(entryId); // exits search, loads target, restores focus
view.setZoom(100);
view.flushEdits(); // Promise<boolean>
view.destroy();
```

关闭保存继续只有一条链路：

```text
main window.close
  -> 页面 App.flushBeforeClose()
       -> favoritesView.flushEdits()
       -> 若返回 false：保持页面和草稿，结束关闭
       -> 调用新建的 host prepare-close（窄接口）
            -> assistant.cancel()
            -> favorites.flush()
            -> assistant.flushPersistence()
  -> true 才再次 win.close 放行
```

实施时使用现有的 executeJavaScript/contextBridge 机制；只新增 `App.flushBeforeClose()` 与 `AppModules.prepareClose()`，不要从主进程直接访问 renderer 私有对象，也不要再增加第二套退出监听。页面未初始化时回退 `AppModules.prepareClose()`；renderer 已失效仍沿用当前边界并记录未保存风险。

### 4.4 导入转换接口

```js
parseFavoritePaste(text, {
  format: 'tsv', // 'lines' | 'tsv'
  kind: 'tag', seriesId, sectionId
}); // Result<{ entries: EntryDraft[], errors: RowError[] }>
validateFavoriteBundle(value); // Result<FavoriteDocument>
joinFavoriteBlocks(blocks); // string; preserves text inside each block
// RowError: { row: 1, code: 'EMPTY_CONTENT', message: '第 1 行缺少内容' }
```

原文直接输入整组时不走“按行拆条目”转换。TSV 默认两列，内容和中文说明；使用用户选择的条目类型。

## 5. 里程碑与依赖

| 阶段 | 任务 | 可验证结果 |
| --- | --- | --- |
| A：可靠数据 | 0–1 | 基线可重现，原文模型与旧收藏迁移可恢复 |
| B：可用收藏页 | 2–4 | 页面、复制、编辑、保存、配色、布局、定位 |
| C：快速查找与使用 | 5–7 | 内部搜索、底部整体选择、全局查询可发现性 |
| D：整理与迁入 | 8–9 | 批量录入、备份、移动/复制、最近使用 |
| E：清理与交付 | 10–12 | 旧入口退役、性能证据、桌面包和人工验收 |

每阶段可以独立检查代码；只有完整交付范围完成才称第一版完成。若中途暂停，记录哪些功能仍不可用，不把半接线界面同步为完整版本。

## 6. 实施任务

### Task 0：锁定基线和目标版本

**Files:** `package.json`、`package-lock.json`、`VERSION.txt`、`src/index.html`、`preload.js`、`main.js`、`scripts/check.mjs`。

**Contract:** 只确定版本和环境，不修改功能。依赖路径使用项目本地安装。

- [ ] 读取当前 Git 状态、最新提交和 AGENTS，确认仍基于本计划对应功能状态；保留用户现有修改。
- [ ] 先运行基线命令，记录失败和数量，不把历史“215 项”当成本次结果。

```powershell
git status --short
git log -3 --oneline
npm ci
npm run check
```

- [ ] 无其他版本占用时统一为 V1.4.33；package-lock 根包版本也同步。已有更高内部版时更新本计划的执行记录，不覆盖其版本。
- [ ] 实施使用 `feat/quick-favorites-v1433` 开发分支；若宿主已提供隔离工作树则沿用，不叠建目录。本轮写计划不创建该分支。
- [ ] 将 `scripts/check.mjs` 的三处版本断言随目标版本更新，或统一读取 package.version 后验证其他标识，不为方便跳过版本断言。
- [ ] 验证元数据一致后提交。

```powershell
npm run check
git add package.json package-lock.json VERSION.txt src/index.html preload.js main.js scripts/check.mjs
git commit -m "V1.4.33：建立快捷收藏页开发基线"
```

**停止点:** 基线失败与收藏无关时先报告，不借新功能批量改旧模块。此处及后续提交前必须真实读取测试退出码。

### Task 1：收藏数据模型、CRUD 和一次迁移

**Files:** 新 `src/modules/favorites.js`、`src/modules/favorites-transfer.js`（本步只实现原文块拼接）、`tests/favorites-store.test.cjs`、`tests/helpers/favorites-fixture.cjs`；修改 `src/modules/index.js`。

**Consumes:** 当前 Storage get/set/flush 与 Tags get。

**Produces:** 第 4.2 节基础读取、Series/Section/Entry CRUD、revision、subscription、copyText、flush、selected 的只读恢复，以及一次迁移。选择写操作在 Task 6 接入。

- [ ] 先写下列行为测试，确认在旧实现上失败；存储 fixture 使用真实 createStorage，不 mock 收藏内部逻辑。

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStorage } = require('../src/modules/storage');
const { createFavorites } = require('../src/modules/favorites');

test('free input is copied exactly and reloads without joining the base dictionary', () => {
  const storage = createStorage();
  const favorites = createFavorites({ storage, tags: { get: () => null } });
  const series = favorites.saveSeries({ name: '光照' }).data;
  const rawText = String.raw`soft lighting, (backlighting:1.2), name \(series\)`;
  const saved = favorites.saveEntry({
    kind: 'bundle', seriesId: series.id, sectionId: null,
    title: '人像', rawText, note: '仅给自己看的说明'
  }).data;
  assert.equal(favorites.copyText([saved.id]), rawText);
  assert.equal(saved.globalSearchable, true);
  const restored = createFavorites({ storage, tags: { get: () => null } });
  assert.equal(restored.getEntry(saved.id).rawText, rawText);
});

test('legacy migration retains unresolved tags and does not duplicate after reload', () => {
  const storage = createStorage();
  const old = [{ id: 'old-1', name: '旧组合', tags: ['blue_hair', 'unknown_tag'] }];
  storage.set('rewrite_favorites', old);
  const options = { storage, tags: { get: id => id === 'blue_hair' ? { en: 'blue hair' } : null } };
  const first = createFavorites(options);
  assert.equal(first.list({ limit: 80 }).total, 1);
  assert.match(first.list({ limit: 80 }).items[0].rawText, /unknown_tag/);
  assert.equal(createFavorites(options).list({ limit: 80 }).total, 1);
  assert.deepEqual(storage.get('rewrite_favorites'), old);
});
```

- [ ] 创建 `favorites_shelf_v1`；构造函数只在新键缺失时迁移。新键解析失败时保留 loadError 并阻止覆盖，不把异常当空库。
- [ ] 所有 mutation 先构造并验证候选状态，再一次替换 state；返回 Result，不在半途写入系列或条目。
- [ ] `copyText` 调用纯函数 `joinFavoriteBlocks`，单条直接返回原文，多条只处理块间分隔；不引入 JSON/TSV 依赖直到 Task 8。
- [ ] 迁移时 `tags.get(id)?.en || id` 保留非空旧内容，原始旧键不删除；异常旧记录放入迁移报告。
- [ ] fixture 固定创建两系列、两子分类、单标签和组合；同时提供 Memory Storage 供重建实例测试。
- [ ] 补测同名条目、重命名稳定 ID、跨系列移动、无效父级、删除子分类保留条目、损坏键不覆盖和 flush=false。
- [ ] 运行并提交。

```powershell
node --test tests/favorites-store.test.cjs
npm run check
git add src/modules/favorites.js src/modules/favorites-transfer.js src/modules/index.js tests/favorites-store.test.cjs tests/helpers/favorites-fixture.cjs
git commit -m "V1.4.33：建立收藏数据与旧收藏迁移"
```

**预算:** 一个领域模块和测试。禁止把自由输入反写 tags.custom，禁止清理旧键或迁移现有聊天。

### Task 2：独立收藏页、单标签/组合展示与复制

**Files:** 新 `src/views/favorites-view.js`、`src/favorites.css`、`assets/icons/favorites.svg`、`assets/icons/LICENSE-lucide.txt`、`tests/favorites-view.test.cjs`；修改 `preload.js`、`src/app-view.js`、`src/index.html`、`locales/*.json`、`tests/helpers/favorites-fixture.cjs`。

**Consumes:** Favorites list/series/sections/getEntry/copyText。

**Produces:** 唯一 Favorites 实例和页面 factory；路由 `favorites`；单条复制、新增入口和明确类型。

- [ ] 新建页面 fixture，使用真实 index.html、真实 Favorites 和浏览器脚本；注入 copy 记录实际字符串。

```js
function viewFixture() {
  const fs = require('node:fs');
  const path = require('node:path');
  const { JSDOM } = require('jsdom');
  const { createStorage } = require('../../src/modules/storage');
  const { createFavorites } = require('../../src/modules/favorites');
  const root = path.resolve(__dirname, '../..');
  const storage = createStorage();
  const favorites = createFavorites({ storage, tags: { get: () => null } });
  const series = favorites.saveSeries({ name: '光照' }).data;
  const item = favorites.saveEntry({
    kind: 'bundle', seriesId: series.id, sectionId: null,
    title: '柔光', rawText: 'soft lighting, backlighting', note: '备注'
  }).data;
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'src/index.html'), 'utf8'), {
    runScripts: 'outside-only', pretendToBeVisual: true
  });
  const copied = [];
  dom.window.eval(fs.readFileSync(path.join(root, 'src/views/favorites-view.js'), 'utf8'));
  const view = dom.window.AppViews.favorites.createFavoritesView({
    document: dom.window.document, favorites,
    preferences: storage.namespace('view-test'),
    copy: async value => { copied.push(value); return true; },
    notify: () => {}, localize: (_key, fallback) => fallback,
    onSelectionChange: () => {}
  });
  view.bind(); view.enter();
  return { dom, view, favorites, series, item, copied };
}
module.exports = { viewFixture };
```

- [ ] 写“路由可达、混排、复制不含注释/不选中、长文本安全展示、绑定两次只触发一次”的测试：

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { viewFixture } = require('./helpers/favorites-fixture.cjs');

test('copy is one explicit action and does not add annotations or selection', async t => {
  const app = viewFixture(); t.after(() => app.dom.window.close());
  app.view.bind();
  app.dom.window.document.querySelector('[data-favorite-copy]').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(app.copied, ['soft lighting, backlighting']);
  assert.equal(app.favorites.selected({ includeAdult: true }).length, 0);
});
```

- [ ] preload 在 Tags 之后创建唯一 Favorites。暴露 `AppModules.favorites` 的方法列表，不暴露 storage、内部可变数组。
- [ ] `#favBtn` 从抽屉入口变页面入口；`#saveFav` 改为打开收藏新增面板，选择当前目标系列。
- [ ] 新 UI 使用 DOM textContent 创建用户内容。主体与 copy/edit/expand/checkbox 是兄弟控件，避免按钮嵌套。
- [ ] 复用 chip 基础 token，系列列不添加外层浮动卡片。图标采用本地打包的 Lucide Copy/Pencil/ChevronDown/Layers/Plus/Undo2/Redo2，并提供 tooltip/aria-label；不使用运行时 CDN。
- [ ] 将实际用到的官方 Lucide 图标导出为 `assets/icons/favorites.svg` 的命名 symbol，保留许可证到 `assets/icons/LICENSE-lucide.txt`。使用 sprite 的标准 use 引用，不手绘替代图标、不新增图标运行时或迁移构建框架。
- [ ] 旧抽屉可以暂留未挂入口但不能仍绑定数据写入；最终删除在 Task 10。
- [ ] 运行并提交。

```powershell
node --test tests/favorites-view.test.cjs tests/ui-dom.test.cjs tests/characters-view.test.cjs
npm run check
git add src/views/favorites-view.js src/favorites.css assets/icons/favorites.svg assets/icons/LICENSE-lucide.txt src/index.html src/app-view.js preload.js locales tests/helpers/favorites-fixture.cjs tests/favorites-view.test.cjs
git commit -m "V1.4.33：接入独立快捷收藏页"
```

**验收:** 打开收藏页不重置 Tag/角色搜索；返回原页面保留原条件；复制不触发两次事件。完整底部选择接线在 Task 6，不宣称此步已完成整个收藏流程。

### Task 3：快捷编辑、自动保存与撤销

**Files:** `favorites.js`、`favorites-view.js`、`src/app.js`、`main.js`、`preload.js`；`tests/favorites-store.test.cjs`、`tests/favorites-view.test.cjs`、`tests/window-close.test.cjs`。

**Consumes:** saveEntry/flush/subscription 与原有关闭保存流程。

**Produces:** 草稿、300ms 合并提交、上一条/下一条、undo/redo、App.flushBeforeClose。

- [ ] 写草稿隔离和撤销行为测试：

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStorage } = require('../src/modules/storage');
const { createFavorites } = require('../src/modules/favorites');

test('consecutive edits form one undo unit without changing raw content on copy', () => {
  const storage = createStorage();
  const favorites = createFavorites({ storage });
  const series = favorites.saveSeries({ name: '草稿' }).data;
  const item = favorites.saveEntry({ kind: 'tag', seriesId: series.id, rawText: 'blue hair' }).data;
  favorites.saveEntry({ id: item.id, note: 'a' }, { historyKey: 'edit-note-1' });
  favorites.saveEntry({ id: item.id, note: 'ab' }, { historyKey: 'edit-note-1' });
  favorites.undo();
  assert.equal(favorites.getEntry(item.id).note, '');
  favorites.redo();
  assert.equal(favorites.getEntry(item.id).note, 'ab');
  assert.equal(favorites.copyText([item.id]), 'blue hair');
});
```

- [ ] 写 view 测试：输入法组合期间不调用 saveEntry；空原文保留之前数据；上一条/下一条先提交有效草稿；保存错误不显示“已保存”。
- [ ] change history 只记录变动项 before/after 和排序数组，限制最近 30 个操作；编辑 historyKey 在 blur/切换时更新。
- [ ] 草稿不直接绑定 state。`flushEdits()` 校验、提交、await favorites.flush，全部成功才返回 true。
- [ ] App 注册 `flushBeforeClose`，按照第 4.3 节串联草稿与 host 保存。main 只调用该统一入口，保留 renderer 未初始化的回退。
- [ ] 在 window-close fixture 注入 `flushEdits=false` 和 `flush=false`，断言窗口保留；修正后再次关闭可成功。
- [ ] 保存失败通知复用现有 Storage status；短时间多次失败合并同一状态，不新增弹窗循环。
- [ ] 运行并提交。

```powershell
node --test tests/favorites-store.test.cjs tests/favorites-view.test.cjs tests/window-close.test.cjs tests/storage-errors.test.cjs
npm run check
git add src/modules/favorites.js src/views/favorites-view.js src/app.js main.js preload.js tests/favorites-store.test.cjs tests/favorites-view.test.cjs tests/window-close.test.cjs
git commit -m "V1.4.33：完善收藏草稿保存与撤销"
```

**验收:** 复制已修改有效内容时提交草稿并复制新值；关闭窗口不会跳过尚未触发 debounce 的输入。禁止再创建平行的 before-quit 保存系统。

### Task 4：系列配色、显示方式、缩放与快捷定位

**Files:** `favorites.js`、`favorites-view.js`、`src/favorites.css`、`locales/*.json`；`tests/favorites-store.test.cjs`、`tests/favorites-view.test.cjs`。

**Consumes:** 系列/子分类有序数据、reorder、preferences。

**Produces:** setSeriesColors、稳定列顺序、顶部系列/子分类定位、列宽和内容缩放。

- [ ] 先写自动颜色和批量变更测试：

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStorage } = require('../src/modules/storage');
const { createFavorites } = require('../src/modules/favorites');

test('new series uses a different adjacent color and bulk recolor is undoable', () => {
  const favorites = createFavorites({ storage: createStorage() });
  const a = favorites.saveSeries({ name: '构图' }).data;
  const b = favorites.saveSeries({ name: '光照' }).data;
  assert.notEqual(a.color, b.color);
  favorites.setSeriesColors([a.id, b.id], { mode: 'custom', color: '#287EA4' });
  assert.ok(favorites.series().filter(row => [a.id, b.id].includes(row.id))
    .every(row => row.color === '#287EA4'));
  favorites.undo();
  assert.equal(favorites.series().find(row => row.id === a.id).color, a.color);
  assert.equal(favorites.series().find(row => row.id === b.id).color, b.color);
});
```

- [ ] 颜色分配只读取当前 series 的 stored color，按使用数量排序并避开相邻。预设采用现有类别色中可用的 10 色，不调用随机函数，每次创建/恢复自动色结果可重复验证。
- [ ] 视图以 CSS 变量 `--favorite-accent` 控制标题/侧边条；组合底色强度不同，正文始终使用现有主题文字 token。
- [ ] 默认一系列一列、子分类纵向排列；快捷栏按钮带颜色标记、名称和数量，点击只定位，不改变全局搜索。
- [ ] Zoom 控件为图标减/加、数值输入和重置，存于 `favorites.view`。列宽采用有限最小宽度，改变后记忆。
- [ ] 写 DOM 测试：定位正确 ID、子分类自动展开、缩放边界 75/150、重新 enter 偏好不丢、中文优先切换不改 rawText。
- [ ] 控件状态不造成 hover 重排；长中英文名称换行，保留完整 tooltip；75% 缩放下操作区域仍可点击。
- [ ] 运行并提交。

```powershell
node --test tests/favorites-store.test.cjs tests/favorites-view.test.cjs
npm run check
git add src/modules/favorites.js src/views/favorites-view.js src/favorites.css locales tests/favorites-store.test.cjs tests/favorites-view.test.cjs
git commit -m "V1.4.33：增加系列配色与收藏快捷定位"
```

**验收:** 11 个以上系列配色可重复但相邻优先不同；自定义色不引起浅底浅字；创建第 N 个系列不改变前 N-1 个的颜色。真实布局交人工验收，jsdom 不证明几何位置。

### Task 5：内部搜索、高亮和定位返回

**Files:** `favorites.js`、`favorites-view.js`；新 `tests/favorites-search.test.cjs`；修改 `tests/favorites-view.test.cjs`。

**Consumes:** 当前 document revision、Entry 原文、系列/子分类名称。

**Produces:** search + 命中位置；内部条件与主 Tag 页完全分开。

- [ ] 先写 scope、命中和失效测试：

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStorage } = require('../src/modules/storage');
const { createFavorites } = require('../src/modules/favorites');

test('internal search includes entries hidden from global search and notes stay out of copied text', () => {
  const favorites = createFavorites({ storage: createStorage() });
  const series = favorites.saveSeries({ name: '光照' }).data;
  const item = favorites.saveEntry({
    kind: 'bundle', seriesId: series.id, title: '柔光',
    rawText: 'soft lighting, backlighting', note: '人像测试',
    globalSearchable: false
  }).data;
  assert.equal(favorites.search('人像', { scope: 'internal' }).total, 1);
  assert.equal(favorites.search('柔光', { scope: 'global' }).total, 0);
  const hit = favorites.search('backlighting', { scope: 'internal' }).items[0];
  assert.equal(hit.entryId, item.id);
  assert.ok(hit.matches.some(match => match.field === 'rawText'));
  assert.equal(favorites.copyText([item.id]), item.rawText);
  favorites.saveEntry({ id: item.id, rawText: 'diffuse light' });
  assert.equal(favorites.search('backlighting', { scope: 'internal' }).total, 0);
});
```

- [ ] 新增轻量派生索引。只索引搜索需要的字符串和 ID；revision 变化时重建或更新受影响项，不存第二套可编辑内容。
- [ ] 确定稳定评分和位置映射，不使用模型或正则直接执行用户搜索词。
- [ ] 100ms 左右输入防抖；保存 query、scope 和结果 scroll。离开页面时清 timer，返回时恢复。
- [ ] 结果只渲染对应命中项和路径，不把整张收藏架反复过滤重排；命中组合内容在组名下面显示片段。
- [ ] `focusEntry(id)` 保存 query/结果位置，切回收藏架、加载对应条目、展开分类并定位。返回搜索恢复此前状态。
- [ ] 批量“选中全部结果”取完整命中 ID，不能用当前 DOM 个数代替 total。
- [ ] 测试权重/转义原文不改、重复词定位、备注命中、中文别名、200+ 搜索结果分页与成人过滤。
- [ ] 运行并提交。

```powershell
node --test tests/favorites-search.test.cjs tests/favorites-view.test.cjs
npm run check
git add src/modules/favorites.js src/views/favorites-view.js tests/favorites-search.test.cjs tests/favorites-view.test.cjs
git commit -m "V1.4.33：实现收藏内部搜索与命中定位"
```

**验收:** 输入收藏查询不调用 `tags.setQuery`，不改角色查询；关闭全局搜索的条目内部仍可找到；编辑后旧词不再被查出。

### Task 6：组合整体选择与底部输出

**Files:** `favorites.js`、`favorites-transfer.js`、`favorites-view.js`、`src/app-view.js`、`preload.js`；新 `tests/favorites-selection.test.cjs`；修改 `tests/ui-dom.test.cjs`。

**Consumes:** 现有 Tags/Characters selected 和 Favorites 原文。

**Produces:** 独立 favorites_selection_v1 快照及统一底部汇总，不修改词库选择状态。

- [ ] 先写不误删手动词与编辑不污染已选内容的测试：

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStorage } = require('../src/modules/storage');
const { createTags } = require('../src/modules/tags');
const { createFavorites } = require('../src/modules/favorites');

test('removing a favorite leaves manual selections and other favorite snapshots intact', () => {
  const storage = createStorage();
  const tags = createTags({ sources: { tags: [{ en: 'soft lighting', category: 'style' }] } });
  tags.select('soft lighting', true);
  const favorites = createFavorites({ storage, tags });
  const series = favorites.saveSeries({ name: '光照' }).data;
  const a = favorites.saveEntry({ kind: 'bundle', seriesId: series.id, title: 'A', rawText: 'soft lighting, blue hair' }).data;
  const b = favorites.saveEntry({ kind: 'bundle', seriesId: series.id, title: 'B', rawText: 'soft lighting, green eyes' }).data;
  favorites.setSelected(a.id, true); favorites.setSelected(b.id, true);
  favorites.saveEntry({ id: b.id, rawText: 'changed' });
  favorites.setSelected(a.id, false);
  assert.equal(tags.selectedText(), 'soft lighting');
  assert.equal(favorites.selected({ includeAdult: true })[0].rawText, 'soft lighting, green eyes');
});
```

- [ ] `setSelected` 克隆加入时的原文/名称，不复用 Entry 引用；重复选中同一 ID 不产生两份快照。
- [ ] `renderSelection` 增加独立收藏 chip、组图标和移除按钮，data 属性区分手动词/角色/收藏。
- [ ] `combinedSelectionValues` 保持旧普通词/角色去重逻辑，再追加收藏原文块；不要把整个组传给旧 tag normalize 或 applyPromptPatch。
- [ ] 把 Task 1 的纯 `joinFavoriteBlocks(blocks)` 接入底部汇总：块内原文不变，块间必要时补 `, `，最后已有逗号/分号/换行时不重复添加分隔符。底部复制和批量复制必须使用同一函数，不各写一套拼接。
- [ ] “清空底部组合”同时清空 Favorites selected；只删除收藏记录不改变已选快照，避免误伤正在构造的 Prompt。
- [ ] “收藏当前组合”读取最终输出，包含角色已选文本。创建为独立 bundle，既有角色选择不清空。
- [ ] 主体点击同时 toggle + copy；编辑和批量勾选不经过主体处理。复制成功才 markCopied。
- [ ] 对接现有 copy/notify 时不复用会 trim 全文的通用 helper 来破坏原始收藏文字；收藏复制直接传递原字符串。
- [ ] 运行并提交。

```powershell
node --test tests/favorites-selection.test.cjs tests/favorites-view.test.cjs tests/ui-dom.test.cjs tests/characters-view.test.cjs
npm run check
git add src/modules/favorites.js src/modules/favorites-transfer.js src/views/favorites-view.js src/app-view.js preload.js tests/favorites-selection.test.cjs tests/ui-dom.test.cjs
git commit -m "V1.4.33：接入收藏组合整体选择与原文复制"
```

**验收:** 原生词库外文本能加入和复制；从 A 组取消共同 Tag 不影响 B 组和手动词；`(tag:1.2)`、`(tag:0.8)` 不被错误合并。

### Task 7：全局可发现性与 AI 查询接入

**Files:** `favorites.js`、`preload.js`、`src/app-view.js`、`src/modules/assistant.js`、`src/modules/primary-tools.js`、`src/modules/primary-agent.js`；`tests/favorites-search.test.cjs`、新 `tests/favorites-integration.test.cjs`、`tests/character-tools.test.cjs`。

**Consumes:** 同一个 Favorites.search(scope=global)。

**Produces:** 主 Tag 页独立收藏结果区；tags.search 可选 favorites 返回。

- [ ] 在 Favorites editor 增加一个默认开启的 checkbox；精确名称说明它作用于站内全局和 AI 查询。
- [ ] 主 Tag 页只有用户搜索时才展示收藏结果区域；普通分类浏览不混入收藏组，不改变 categoryCounts。
- [ ] assistant 构造接收 `options.favorites`，仅把其只读 search 方法传给 primary-tools。preload 注入同一个 Favorites 实例。
- [ ] 在已有输出 schema 中增加可选字段，不替换 `items`：

```js
// Added to the existing tags.search output schema:
const favoriteResultSchema = {
  type: 'object', additionalProperties: false,
  required: ['entryId', 'kind', 'title', 'contentOmitted'],
  properties: {
    entryId: { type: 'string' },
    kind: { type: 'string', enum: ['tag', 'bundle'] },
    title: { type: 'string' },
    rawText: { type: 'string' },
    zh: { type: 'string' },
    seriesName: { type: 'string' },
    sectionName: { type: 'string' },
    memberCount: { type: 'integer', minimum: 1 },
    contentOmitted: { type: 'boolean' }
  }
};
// favorites: { type:'array', maxItems:8, items:favoriteResultSchema }
```

- [ ] 当前 `schema.js` 不处理 type 数组，使用上面的可选整数 memberCount；无法可靠计数时省略，禁止为此重写 schema 引擎。内部 SearchHit 可以为 null，外部映射时转换。
- [ ] 注入 fixture 验证关闭开关后的 UI/AI 立即失效：

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStorage } = require('../src/modules/storage');
const { createFavorites } = require('../src/modules/favorites');
const { createPrimaryTools } = require('../src/modules/primary-tools');

test('AI search retains normal items and discovers only enabled favorites', async () => {
  const favorites = createFavorites({ storage: createStorage() });
  const series = favorites.saveSeries({ name: '光照' }).data;
  const entry = favorites.saveEntry({ kind: 'bundle', seriesId: series.id, title: 'portrait', rawText: 'soft lighting, backlighting' }).data;
  const tools = createPrimaryTools({
    tags: { search: () => [{ en: 'soft lighting', zh: '柔光' }] },
    favorites
  });
  const first = await tools.call('tags.search', { query: 'soft lighting' });
  assert.equal(first.data.items[0].en, 'soft lighting');
  assert.equal(first.data.favorites[0].kind, 'bundle');
  favorites.saveEntry({ id: entry.id, globalSearchable: false });
  const second = await tools.call('tags.search', { query: 'soft lighting' });
  assert.equal(second.data.items.length, 1);
  assert.equal((second.data.favorites || []).length, 0);
});
```

- [ ] 只返回名称/原文/说明/路径，不把 note 附给模型；预算不足的长组 contentOmitted=true。
- [ ] 当前主提示词的程序性工具说明补充 favorites 字段含义，不覆盖用户自定义提示词，也不更改主 AI 可调用的工具数量。
- [ ] 单独测试角色 attachedData、原 items 空时仍可命中收藏、adult=false、同名基础 Tag 不消失。
- [ ] 运行并提交。

```powershell
node --test tests/favorites-search.test.cjs tests/favorites-integration.test.cjs tests/character-tools.test.cjs tests/runtime-integration.test.cjs tests/prompts-composition.test.cjs
npm run check
git add src/modules/favorites.js preload.js src/app-view.js src/modules/assistant.js src/modules/primary-tools.js src/modules/primary-agent.js tests/favorites-search.test.cjs tests/favorites-integration.test.cjs tests/character-tools.test.cjs
git commit -m "V1.4.33：接入收藏查询开关与全局搜索"
```

**停止点:** 如果要新增工具、重写 Runtime、让模型修改收藏，已超出本任务。不要把复杂自由文本通过普通 tagSchema 强行塞入 `en`。

### Task 8：批量粘贴、JSON 备份与恢复

**Files:** `favorites-transfer.js`、`favorites.js`、`favorites-view.js`；`tests/favorites-transfer.test.cjs`；按需 `package.json`、`package-lock.json`。

**Consumes:** 成熟 TSV 解析器和同一 Favorites CRUD/候选状态校验。

**Produces:** parseFavoritePaste/validateFavoriteBundle/previewImport/importBundle/exportBundle。

- [ ] 为一行一条、两列 TSV、引号中换行和内容中的逗号写测试：

```js
const test = require('node:test');
const assert = require('node:assert/strict');

test('TSV paste keeps a comma-separated group as one record and handles quoted newlines', () => {
  const { parseFavoritePaste } = require('../src/modules/favorites-transfer');
  const result = parseFavoritePaste(
    '"soft lighting, backlighting"\t"柔光\n说明"',
    { format: 'tsv', kind: 'bundle', seriesId: 's1', sectionId: null }
  );
  assert.equal(result.ok, true);
  assert.equal(result.data.entries.length, 1);
  assert.equal(result.data.entries[0].rawText, 'soft lighting, backlighting');
  assert.equal(result.data.entries[0].zh, '柔光\n说明');
});
```

- [ ] 无现成兼容解析器时增加唯一的小型运行依赖，不依赖 Excel COM 或电子表格 UI：

```powershell
npm install --save-exact csv-parse
```

```js
const { parse } = require('csv-parse/sync');
const rows = parse(input, {
  delimiter: '\t',
  bom: true,
  info: true,
  skip_empty_lines: true,
  relax_column_count: true
});
// rows contain { record, info }; info.lines supports error locations.
// Validate each record has exactly content + optional Chinese explanation.
// Return errors with original row numbers; never silently discard extra columns.
```

- [ ] JSON 采用原生 JSON.parse 和结构校验。校验 format/version、稳定 ID 唯一性、引用归属、kind、rawText、布尔字段和颜色；不执行文件中的内容。
- [ ] 预览展示有效条目、重复 ID 和错误行，目标分类可切换；确认后一次提交。
- [ ] append 模式重建冲突 ID 的 series/section/entry 映射，不改变原数据；replace 模式先显示影响与现有备份入口。
- [ ] round-trip 测试导出后导入保持原文、注释、颜色、排序和可发现性。历史选择快照不包含在收藏备份里。
- [ ] 测试无效记录导致整批失败且 state/revision 不变；大版本不支持时明确返回错误。
- [ ] 将新依赖写入桌面打包依赖清单，禁止只在开发机安装后交付一个缺 parser 的包。
- [ ] 运行并提交。

```powershell
node --test tests/favorites-transfer.test.cjs tests/favorites-store.test.cjs tests/favorites-view.test.cjs
npm run check
git add src/modules/favorites-transfer.js src/modules/favorites.js src/views/favorites-view.js tests/favorites-transfer.test.cjs package.json package-lock.json
git commit -m "V1.4.33：支持收藏批量粘贴与完整备份"
```

**验收:** 空注释合法；多行单元格不拆成多收藏；逗号组合不自动拆；JSON 文件不包含 API Key、聊天或图片。

### Task 9：批量整理、置顶与最近复制

**Files:** `favorites.js`、`favorites-view.js`、`favorites.css`；`tests/favorites-store.test.cjs`、`tests/favorites-view.test.cjs`。

**Consumes:** applyBatch/duplicateEntries/delete/reorder/markCopied 与有界 undo。

**Produces:** 可预期的多选管理，不与 Prompt 选择共用状态。

- [ ] 增加“批量勾选不加入底部、跨页搜索全选、一次撤销恢复整批”的测试：

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStorage } = require('../src/modules/storage');
const { createFavorites } = require('../src/modules/favorites');

test('bulk changes commit once and undo restores all affected entries', () => {
  const favorites = createFavorites({ storage: createStorage() });
  const series = favorites.saveSeries({ name: '常用' }).data;
  const entries = ['blue hair', 'green eyes'].map(rawText =>
    favorites.saveEntry({ kind: 'tag', seriesId: series.id, rawText }).data);
  const before = favorites.snapshot().revision;
  favorites.applyBatch({ ids: entries.map(row => row.id), patch: { globalSearchable: false } });
  assert.equal(favorites.snapshot().revision, before + 1);
  assert.equal(favorites.search('hair', { scope: 'global' }).total, 0);
  favorites.undo();
  assert.ok(entries.every(row => favorites.getEntry(row.id).globalSearchable));
});
```

- [ ] 批量工具条显示选中数量与作用范围；选择“全部结果”时从 domain 分页遍历固定 revision 的命中 ID，而不是扫描 DOM。
- [ ] 行/列重排支持拖动把手以及“上移/下移/移到分类”菜单作为键盘替代。重排不触发复制。
- [ ] 同名副本后缀用于显示可读性，但新 ID 才是身份；不让重命名影响关联。
- [ ] 成功 copy 后 markCopied，失败不记录；最近 20 个 ID 去重，删除的条目自动从 recency 移除。
- [ ] “最近复制”是虚拟列表，提供路径和定位原处；返回收藏架保持顺序。
- [ ] pinned 是条目属性，列表排序为置顶在前再手动 order；同一条目不复制两份 DOM。
- [ ] 删除系列的“移动内容到未分类”和“连同内容删除”明确分开，批量改色只对选择的系列生效。
- [ ] 运行并提交。

```powershell
node --test tests/favorites-store.test.cjs tests/favorites-view.test.cjs tests/favorites-search.test.cjs
npm run check
git add src/modules/favorites.js src/views/favorites-view.js src/favorites.css tests/favorites-store.test.cjs tests/favorites-view.test.cjs
git commit -m "V1.4.33：完善收藏批量整理和最近复制"
```

### Task 10：退役旧收藏入口并锁定模块归属

**Files:** `assistant.js`、`src/app-view.js`、`src/index.html`、`src/app.css`、`preload.js`；`tests/ui-dom.test.cjs`、`tests/ui-architecture.test.cjs`、`tests/favorites-integration.test.cjs`。

**Consumes:** 完成的新收藏页、迁移和选择链路。

**Produces:** 一个收藏数据所有者、一个收藏视图、没有并行旧写入入口。

- [ ] 全仓搜索确认旧方法、旧 DOM ID、动态事件和旧 snapshot.favorites 没有必须保留的调用者：

```powershell
rg -n "listFavorites|addFavorite|removeFavorite|setFavorites|rewrite_favorites|favoritesOpen|favSave|drawerClose|toggleFavoriteDrawer|renderFavorites" src preload.js main.js tests scripts
```

- [ ] 保留 `rewrite_favorites` 的迁移读取与原数据，不再有业务写入。
- [ ] 删除 Assistant 内部收藏数组和旧增删方法，去掉 snapshot 中过时收藏字段；Favorites 的实例不再有第二份 state。
- [ ] 删除旧收藏抽屉 DOM、事件和仅旧抽屉使用的样式。`scrim` 同时服务 Vision，不能一并删除。
- [ ] 保留顶部 `favBtn` 和底部 `saveFav`，但都只接新收藏页。
- [ ] 添加真实集成测试：用实际模块构造 AppModules-shaped API，验证旧收藏迁移、点击保存/复制、自输入未入词库、完整搜索开关。
- [ ] 架构护栏只检查新 view 被加载一次、preload 暴露的是方法、不恢复旧写入方法；不锁死每个 CSS 类名。
- [ ] 一次导航只调用一次 enter/leave，100 次开关页面后点击 copy 仍只有一次 clipboard write。
- [ ] 运行并提交。

```powershell
node --test tests/favorites-integration.test.cjs tests/ui-dom.test.cjs tests/ui-architecture.test.cjs tests/characters-view.test.cjs
npm run check
git add src/modules/assistant.js src/app-view.js src/index.html src/app.css preload.js tests/ui-dom.test.cjs tests/ui-architecture.test.cjs tests/favorites-integration.test.cjs
git commit -m "V1.4.33：移除旧收藏抽屉与重复状态"
```

**停止点:** 不确定的共享样式先保留，不借此整理整份 app.css。迁移读取的旧键不是无效内容，不删除。

### Task 11：性能、输入和页面稳定性验收

**Files:** `scripts/benchmark-favorites.mjs`、`tests/favorites-view.test.cjs`、`tests/favorites-search.test.cjs`；仅在实测发现热点时修改 Favorites 模块/视图。

**Consumes:** 完整实现。

**Produces:** 固定数据规模的测量结果、焦点/滚动/输入稳定性用例。

- [ ] 固定生成 20 系列、每系列 5 子分类、每类 30 条的 3,000 条 fixture；每 5 条一个组合，每 3 条一个备注。文本使用确定序号，测试可重复。
- [ ] 批量构造候选文档后一次 import；不要用每条 save 的持久化耗时混充纯查询性能。
- [ ] benchmark 使用 performance.now，5 次预热、30 次测量，输出 p50/p95：

```js
const samples = [];
for (let index = 0; index < 35; index += 1) {
  const started = performance.now();
  favorites.search('lighting', { scope: 'internal', limit: 80 });
  const elapsed = performance.now() - started;
  if (index >= 5) samples.push(elapsed);
}
samples.sort((a, b) => a - b);
console.log({
  entries: 3000,
  p50: samples[Math.floor(samples.length * 0.50)],
  p95: samples[Math.floor(samples.length * 0.95)]
});
```

- [ ] 基准另测 10,000 条、备注更新后查询和批量改色；输出 Node 版本、平台、机器 CPU，性能阈值不写成不稳定的 CI 时间断言。
- [ ] 视图先批量渲染；若 DOM 才是瓶颈，只改收藏列表的增量加载，保留目标定位可达性。
- [ ] DOM 测试验证长标题/超长原文没有截断数据，输入法 composition 不误存，编辑上下条不丢焦点，搜索前后滚动记录正确，重复 bind 无重复操作。
- [ ] 快捷键只在收藏页且输入焦点允许时响应，其他页面 Ctrl+C/Ctrl+Z 不受影响。
- [ ] 用户人工核对：980×680、1360×900、1920×1080，75/100/150% 和浅/深主题。jsdom 不承担截图/几何证明。
- [ ] 运行并记录实测，不为未测结果写“显著提速”。

```powershell
node scripts/benchmark-favorites.mjs
node --test tests/favorites-view.test.cjs tests/favorites-search.test.cjs tests/favorites-selection.test.cjs
npm run check
git add scripts/benchmark-favorites.mjs tests/favorites-view.test.cjs tests/favorites-search.test.cjs
git commit -m "V1.4.33：验证大收藏库与编辑交互稳定性"
```

**验收目标:** 3,000 条纯搜索预热后 p95 ≤50ms、首批内容目标 ≤200ms；超标时写下测量和定位结果。没有数据损失或明显阻塞时不以分数为由重写整个应用。

### Task 12：文档、最终版本与桌面交付

**Files:** `README.md`、`项目当前架构与统一重构规划.md`、版本文件、对应交付说明；本计划的执行记录。

**Consumes:** 全部实际完成的功能与测试证据。

**Produces:** 最终内部包、文件一致性证明和人工验收清单。

- [ ] 对照本计划末尾需求矩阵逐项标记完成、未验证或暂缓，不能只勾“一切通过”。
- [ ] 更新架构说明：Favorites 独立 state/view、搜索范围、选择快照、旧键迁移、关闭草稿保存。
- [ ] 导出当前 Git 源码到新临时目录，执行 `npm ci` 与 `npm run check`，证明测试不依赖开发机绝对路径。
- [ ] 核对 package.json / package-lock.json / VERSION.txt / index.html / main 标题 / preload 的最终版本一致。
- [ ] 最终提交使用实际内部版本号，本计划默认 V1.4.33：

```powershell
npm run check
git diff --check
git add README.md "项目当前架构与统一重构规划.md" "交付说明-V1.4.33.md" docs/superpowers/plans/2026-09-18-quick-favorites-plan.md
git commit -m "V1.4.33：完成快捷收藏页文档与交付记录"
git status --short
```

- [ ] 以现有桌面包为模板，在工作区暂存完整新包；保留模型、Electron 和原生依赖，加入新 parser/图标资源。
- [ ] 原生模块仍 unpack；清理旧源码镜像中已删除的抽屉专用文件，不仅增量覆盖新增文件。
- [ ] 逐文件验证 app/、resources/app/ 和 app.asar 与 Git 跟踪源码一致；检查新增依赖可解析，exe 与版本匹配。
- [ ] 桌面旧测试包先移出桌面到工作区备份，桌面只留最终 `AI绘画Tag工具箱V1.4.33`；若仍有运行进程先提醒用户保存并关闭，不强杀。
- [ ] build-info.json 记录 sourceCommit、asar SHA256、源码/依赖校验、测试结果、未运行的真实验收。
- [ ] 最终只报告版本、核心变化、检查、已知风险和 exe 链接，等待用户人工测试；不推送、不创建 Release。

## 7. 验收矩阵

| 要求 | 自动验证 | 人工验证 |
| --- | --- | --- |
| R01 单标签/组合/自由输入 | store 原文与 kind、无词库外写 | 新增并复制陌生词 |
| R02 多列纵向 | DOM 分组与稳定顺序 | 多窗口大小浏览与长内容 |
| R03 系列/子分类快捷栏 | ID 定位、展开、滚动记录 | 横向+纵向目标落点 |
| R04 相近样式但清楚区分 | kind/数量/展开结构 | 缩放、深浅主题辨识 |
| R05 说明/别名/备注 | 复制不带备注、修改不丢字段 | 短注释可读，长备注能展开 |
| R06 内部搜索 | scope、排序、分页、高亮 | 凭中文名迅速找到目标 |
| R07 全局开关 | 内部仍可查、UI/AI 外部结果即时失效 | 搜索结果来源明显 |
| R08 系列颜色 | 自动避免相邻、批量撤销、持久化 | 自定义极浅/深色仍可阅读 |
| R09 快捷编辑复制 | 一次操作一次事件、草稿flush | 连续上下条编辑、系统剪贴板 |
| R10 缩放和偏好 | 75–150边界、重入/重启恢复 | 工具可点、文字不重叠 |
| R11 定位和上下文 | 返回原搜索/scroll/focus | 大库里不迷失位置 |
| R12 简洁架构 | 唯一factory、保留旧基线测试 | 不要求用户理解内部模块 |
| 旧收藏 | 一次迁移、缺失ID保留、坏键不覆盖 | 旧组合仍可找到 |
| 批量录入备份 | TSV多行/引号、JSON roundtrip/原子提交 | 粘贴旧表中的实际数据 |
| 底部组合 | 手动/角色/收藏互不误删 | 加组、取消、复制、清空 |
| 退出和错误 | 无效草稿/存储失败阻止关闭，重试成功 | 编辑最后一个字立刻关窗再打开 |

## 8. 风险与停止条件

1. **原文丢失风险：** 任何 searchKey/trim/split 修改原文都应回到内容契约；词库 ID 不可替代用户保存内容。
2. **选择混淆风险：** 批量管理与 Prompt 选择必须独立。取消组误删手动词属于阻止交付的问题。
3. **布局范围风险：** 本轮局限收藏页，不借新页面重做所有导航和主题。
4. **搜索契约风险：** 如果现有工具 schema 不支持新可选字段，局部扩展并补测试；不能放宽所有工具校验。
5. **迁移风险：** 存储异常或坏键不能自动空库覆盖；保留原始数据供用户导出恢复。
6. **草稿风险：** renderer 中尚未提交的输入不会自动被 Storage.flush 保存，必须验证整条关闭链。
7. **性能风险：** 用户缩小到 75% 不等于可以无限创建 DOM；先分批，测量后再决定虚拟化。
8. **重复实现风险：** FavoritesView 负责所有收藏页事件；composer只接路由/底栏/外部查询展示。
9. **范围扩大：** 新增无限层级、云服务、图片附件、复杂权限或改写生成状态机时停止，另立需求。
10. **失败次数：** 同一问题 2–3 次修正未收敛，报告复现、尝试和仍缺证据，等待用户决定。

局部 Bug 修复优先 1–2 个核心文件、约 80 行以内；模块交界调整优先每段约 200 行。新收藏页不是 80 行修补，按本计划分模块实现，但不得把超出预算当作顺便改无关模块的理由。

## 9. 执行记录模板

每完成一项直接更新对应任务的 checkbox，并追加一行证据，未完成项保持未勾选：

| Task | 状态 | 提交 | 聚焦检查 | npm run check | 人工验收缺口 |
| --- | --- | --- | --- | --- | --- |
| 0–12 | 未开始 | 无功能提交 | 未执行 | 文档轮仅核对现有基线 | 新功能尚未实现 |

本计划创建轮不生成假完成记录。实施授权到来后从 Task 0 开始；已完成一项不能自动宣称下个阶段也已通过。

### 文档轮检查（2026-09-18）

- 设计说明与计划的本地链接互相可达，代码围栏完整。
- 19 个 JavaScript/JSON 示例块通过语法解析；未执行尚不存在的新功能测试。
- 12 项需求全部在验收矩阵中有对应项，13 个实施任务（0–12）完整。
- 已校正当前 schema 不支持联合 type、旧复制 helper 会 trim 原文、词库外输入不能直接 tags.select、退出前需提交页面草稿四处接口约束。
- 当前源码基线 `npm run check`：80 文件语法扫描、21 条 ESLint 正确性规则、215 项测试全部通过。
- 本轮变更只有两份 Markdown 文档；功能未实现，运行版本仍为 V1.4.32，无新桌面包、无 push、无 Release。
