# Task 8 最终交接：统一标签编辑与草稿位置选择器

## 基线与范围

基线 `ce7da90`，已含 V1.4.320 ComfyUI 合并 `be73b2b`；运行版本保持 1.4.320。先前冻结的三个 WIP 文件（picker 与两个测试文件）来自原 Task 8，在新基底按 SHA 恢复后继续实现。`bd06ece` 是首个可恢复提交，后续修复提交完成本报告描述的交互。未装配生产 app/preload/favorites，未启动 Electron、未写真实 AppData、未调用付费 API、未改 Comfy worktree、未同步桌面或 push。

## Factory 与公开 API

浏览器依次加载 `views/tag-location-view.js`、`views/tag-editor-view.js`，再加载 app-view；同时加载 `tag-editor.css`。注册名为 `AppViews.tagLocation.createTagLocationView` 与 `AppViews.tagEditor.createTagEditorView`；CommonJS `require` 对应文件也导出同名 factory。editor 在 CommonJS 下自行 require helper，在浏览器下依赖先加载的 AppViews.tagLocation。

```js
const locationView = AppViews.tagLocation.createTagLocationView({ document, catalog, getLocale, localize });
const editor = AppViews.tagEditor.createTagEditorView({
  document, catalog, notify, getLocale, localize,
  confirmDiscard, // 可省略：组件内建真实三按钮异步对话框
  locationView   // Task 9 推荐注入并复用这个唯一 picker
});
await editor.open({ tagId?, membershipId?, placement?, initialValues? }); // Promise<boolean>
await editor.save();         // Promise<Result<CommitData>>
await editor.requestClose();// Promise<boolean>
editor.isDirty();            // boolean
editor.locationView;         // 同一个注入或内部持有的 picker
editor.dispose();           // 强制 teardown；正常导航必须先 await requestClose
await locationView.choose({ kind:'taxonomy'|'favorite', current?, draft? }); // Placement|null
locationView.dispose();
```

组件没有 onSaved/onClose 回调。成功提交调用 `notify(localizedSavedMessage)`；调用方显式调用 `save` 可 await Result；库的 subscribe 负责驱动其他投影刷新。notify 异常不会将已提交结果变成失败。`confirmDiscard({ reason:'close'|'reload'|'restore', tagId:string|null })` 可返回/resolve `save|discard|stay`，异常视为 stay。打开另一条记录也先经 requestClose；在保存、位置选择或确认待决期间，重复 open/requestClose 返回 false，save 重复调用复用 pending Promise。

`initialValues` 仅用于新建，校验并深复制 TagPatch 允许字段；已有 tagId 忽略 incidental prefill。支持 kind/content/displayName/aliases/note/adult/searchable/categoryId/subcategoryId；不合法 prefill 返回 false 且不写库。组合入口应传 `initialValues:{kind:'bundle',content:exactText,displayName?}`，不要操作 DOM 或创建临时标签。

编辑器表单七类字段 kind/content/displayName/aliases/note/adult/searchable 仅在对应 input/change 时读取，其他字段保存不重读 textarea。因此既有或预填 bundle 的 CRLF/混合换行/首尾空格、未编辑 aliases 短语原样保留。编辑 aliases 使用每行一个短语，空值清为 []。

## 保存、恢复与位置

打开时冻结 library revision；save 对本地 draft 构造快照后禁用控件，唯一 canonical saveTag 提交。相同 payload 失败重试复用 operationId，内容变更或独立/reference 动作分配新 operationId。成功才关闭；返回 Result 失败和 thrown execute 均解除 pending 并保留输入。

revision conflict 显示“标签已在其他位置修改，重新加载后再保存”，并聚焦明确 Reload 按钮。Reload 经同一脏保护；discard 才载入当前 canonical 记录，不自动覆盖。Restore 仅对 bundled 记录显示，dirty 时先三选一：save 只保存并结束，discard 才提交一次 restoreTag，stay 不动；不会保存后又悄悄恢复。

既有单归属自动显示该收藏位置；多归属显示必选 membership 下拉，精确 membershipId 被带入 saveTag placement；重复目的组保持 DUPLICATE_MEMBERSHIP 错误，不合并。分类摘要始终显示，taxonomy 按钮可独立改分类且不取消收藏。位置本身计入 dirty。新建页/组/分类/子类只返回 ParentChoice/ChildChoice 草稿；父级变化清子级，同父级重复名字提示已有项，选择器不调用 execute。

## DuplicateContent 命令窄扩展

Result.error 新增可选 `existingTagIds?: string[]`；commands.js 的 DUPLICATE_CONTENT 返回 `[firstMatchingCanonicalId]`，上限严格 1，保留原有 references。没有搜索旁路或新 query API。真实 library 测试证明返回 known ID 可直接 getTag，existing metadata 不被草稿覆盖。

重复 UI 通过纯文本摘要展示 existing content/name/note。`inspect` 对新建和既有编辑都有效，遵守 dirty 保护；新建 favorite 独立显示“收藏此已有标签（使用它的现有资料）”，提交 favoriteTag + draft placement，绝不传旧 patch。独立动作 allowIndependent 更新时保留原 ID 与全部关系，不重指向任何共享位置。

## 焦点、生命周期和 CSS hooks

父编辑器、默认 discard 和 picker 共用同一 document modal stack；顶层独占 Tab/Esc/focus，子 picker 关闭回到位置按钮。外部注入 picker 即使在 editor 创建之后实例化仍正确；IME composing 时快捷键不保存。每个 dialog 有唯一 aria-labelledby，校验字段 aria-invalid/aria-describedby；一般错误聚焦可 focus 的 role=alert，冲突聚焦 reload。所有显示数据只走 textContent/value。

主要选择器：`[data-tag-editor-overlay]`、`[data-tag-field="content|kind|displayName|aliases|note|adult|searchable"]`、`[data-tag-save]`、`[data-tag-close]`、`[data-tag-error]`、`[data-tag-reload]`、`[data-tag-restore]`、`[data-tag-location]`、`[data-tag-taxonomy]`、`[data-tag-taxonomy-summary]`、`[data-tag-membership]`、`[data-tag-location-summary]`、`[data-tag-shared]`、`[data-tag-inspect="ID"]`、`[data-tag-reference="ID"]`、`[data-tag-independent]`。

Discard：`[data-tag-discard-overlay]` 与 `[data-tag-confirm-save|data-tag-discard|data-tag-stay]`（分别三个独立属性）。位置：`[data-tag-location-overlay]`、`[data-location-parent|data-location-child|data-location-parent-name|data-location-child-name|data-location-confirm|data-location-cancel|data-location-error]`（各独立属性）。

CSS 仅 `.tag-editor-*` / `.tag-location-*`，使用现有 --card/--text/--input-bg/--input-border/--border2/--pri。所有 overlay[hidden] 明确 display:none；子元素 hidden 规则 scoped 在 dialog 内，真实 checkbox、focus-visible、disabled 与小屏滚动均有样式。文本键位于两包 `ui.tagEditor.*`（37 键）与 `ui.tagLocation.*`（13 键），由测试逐键比对组件 fallback；locale 改变后再次 open/choose 使用当前 getLocale，支持 optional localize(key,fallback)。

picker 生命周期：注入时 editor 不 dispose 外部实例，Task 9 总控制器负责；未注入时 editor 创建一个并 dispose 自有实例。不要同时再创建第二个。session/attempt guards 丢弃旧 choose/confirm/save continuation；dispose 也使所有 continuation 失效。dispose 不能撤销已发送 command（正常导航先 requestClose）。

## 证据与边界

初始 14 测试 RED 为缺失组件断言；首实现 14/14 GREEN。自查新增 6 个交互回归先 RED（缺 membership、非 input checkbox、无 inspect、无 prefill 校验、子焦点争夺、restore 串联），修复后 GREEN。随后外部 picker/重复归属/销毁/locale 的验证扩展通过。

- 定向 `node --test tests/tag-editor-view.test.cjs tests/tag-location-view.test.cjs`：24/24 PASS。
- 最终 `npm run check`：131 source files 语法与 21 规则 PASS；535/535 单测 PASS；regressions-v194 PASS。
- 最后 CSS 补充只调整 scoped input/focus/hidden 样式，没有 JS 行为变更。

JSDOM + real memory library/repository 为本任务证据，未声称真实 Electron 桌面视觉/输入法/屏幕阅读器验收。Task 9 接线后仍需生产入口/统一 picker/关闭流程集成验证，Task 11 才统一升 V1.4.321 并候选桌面验收。


## 审查修复 round 1（取代前述层级边界）

两个审查发现已定向修复。已有收藏条目收到显式 favorite destination 时，单归属自动附上当前 membershipId；多归属缺少或无效 membershipId 的 save 在 execute 前拒绝，并聚焦现有归属选择器。此时不创建新页/组，也不增加第三条归属；必须选择精确归属后再保存。显式 taxonomy placement 不会因传入 membershipId 被替换成 favorite placement，分类编辑继续保留收藏关系。新增引用仍由独立 favoriteTag 命令负责。

createDialogTools 按活动 stack 深度将 overlay inline zIndex 设置为 1000 + index；关闭时移除该弹窗的 inline z-index 并重排余下活动弹窗，重新打开重新计算。创建顺序不再影响层级，picker 和 discard 同样适用。

新增三条回归先 RED 后 GREEN：incoming placement 绕过归属选择、单归属绑定且 taxonomy 独立、外部 picker 先创建/嵌套 discard/关闭中间弹窗的 computed z-index。无真实 Electron 视觉验收声明。

- focused：27/27 PASS。
- npm run check：538/538 PASS，source checks 与 regressions-v194 PASS。
- 完整日志：`.superpowers/sdd/2026-09-19-unified-tag-library/task-8-fix-round-1-check.log`。
- 本轮范围仅两个组件、两份测试与本报告；运行版本仍为 1.4.320。
