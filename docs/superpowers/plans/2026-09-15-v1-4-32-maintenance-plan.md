# V1.4.32 维护与修复计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans (recommended). Steps use checkbox (`- [ ]`) syntax.

**Goal:** 在保持 V1.4.32 用户功能和数据格式不变的前提下，修复资源泄漏、验证不可移植、重复 UI 事件和持久化风险，并逐步收敛重复模块边界。

**Architecture:** 保留 Electron + CommonJS + 原生 DOM + Assistant/Images/ImageRepository/Comfy 分层。先修局部正确性和资源生命周期，再以单一 owner 收敛 Settings、Gallery、Conversation；不引入 React、数据库、远程服务或新权限体系。

**Tech Stack:** Electron、Node.js CommonJS、原生 DOM、node:test、jsdom、现有本地图片/模型运行时。

## Global Constraints

- 基线固定为 V1.4.32；实现阶段不升版、不 push、不发布。
- 每个任务只处理一个行为路径，完成后立即运行检查并用中文提交信息 `V1.4.32：说明`。
- `npm run check` 是必跑门槛；布局、键盘和 Electron 行为仍需人工验收。
- 保持设置、会话、图片引用、提示词组、Comfy 工作流和角色数据格式。
- 不删除动态加载、迁移、公开 API 或兼容字段，除非完成删除安全审查并有回归测试。
- 不扩大安全边界；保留现有图片会话作用域和引用计数保护。

## 基线证据

### 执行进度（2026-09-17 续接）

- Task 1 已提交 `6015cee`，本地依赖检查 184 项通过。
- Task 2 已提交 `afbc9c3`；补充无 IndexedDB 环境的立即删除竞态测试与修复，常规/立即删除和清空均有覆盖。
- Task 3 已提交 `492dc1b` 与 `b55ec47`；错误终态、取消等待落盘、完成后拒绝取消、普通关窗和退出事件测试通过。真实 Electron 关窗待人工验收。
- Task 4 已完成温度零值、Comfy 空数值与未知 reset 的局部修复；CFG/Seed 正常零值已有支持，未改参数 schema。
- Task 5 已提交 `74bf634`，仅删除不可达旧弹窗，提示词组/扩展功能保持。
- Task 6 已收敛字段写入：API 由 composer 原有流程管理，Settings view 只绑定生图三字段，Comfy 保留独立 view。完整表单搬迁暂缓；重复测试请求、重复保存、跨页草稿误存已用 DOM 用例验证。
- Task 7 已完成：删除重复简化 Gallery factory，保留 composer 中完整图库功能作为唯一所有者；批量下载/发送与鼠标/键盘选择有 DOM 覆盖。未将缺失业务能力的旧 factory 升级为新抽象。
- Task 8 已提交清空确认 `cabdc2f`，覆盖聊天区/管理页两入口；删除没有实际渲染调用的 Conversation factory，保留含完整候选图/编辑/重试行为的 composer。原“重复发送”未复现，未作为 Bug 声称。
- Task 9 已分项完成：活动能力刷新请求序号、文件写入状态/通知/显式重试、Tag/本地翻译 256 项与单图分析 4 变体缓存上限。未修无调用的旧 `calls/index.js`。
- Task 10 待执行：接入已安装的 ESLint/Acorn、更新实际架构说明、核对桌面源码/asar 后交给用户人工验收。
- 版本保持 V1.4.32；未推送、未发布、未同步桌面。
- A0 receipt: route `code-quality-workflow`, snapshot `2026-08-18`, loaded `ST-A0`；目标为已批准维护计划，红线为持久格式/核心协议/新框架，门槛为聚焦行为测试、`npm run check` 与用户人工验收。

- 目录：`F:/codex/AI绘画Tag工具箱/ai-tag-release-v143`。
- 当前提交：`2186c68`，版本 V1.4.32。
- 当前 `npm run check)：业务测试通过；`tests/characters-view.test.cjs`、`tests/ui-dom.test.cjs` 因硬编码绝对 jsdom 路径失败。
- 已确认：Blob 删除不回收、依赖不可移植、流式持久化开销、世界书死控件、Settings 重复监听、Gallery/Conversation 多 owner、数值 0 被默认值覆盖、写入失败和退出丢写无提示、缓存无上限。

---

### Task 1：修复验证环境与依赖声明

**Files:** `package.json`、新生成 `package-lock.json`、`tests/ui-dom.test.cjs`、`tests/characters-view.test.cjs`、`README.md`。

**Contract:** 两个 UI 测试使用项目本地 `require('jsdom')`；`npm ci && npm run check` 可从干净 checkout 执行；不升级生产运行时。

- [ ] 先在临时干净目录执行当前 UI 测试，记录绝对路径失败。
- [ ] 在 `package.json` 声明当前测试实际需要的 `jsdom`、`eslint`、`acorn`，保持现有版本约束策略。
- [ ] 将两个测试的绝对路径改为 `require('jsdom')`。
- [ ] 运行 `npm install --package-lock-only`，检查 lockfile 不含开发机路径。
- [ ] README 写明 `npm ci`、`npm run check` 和可选本地模型依赖。
- [ ] 运行 `npm ci`、`npm run check`；将真实断言失败与环境失败分开记录。
- [ ] 提交：`V1.4.32：修复检查依赖与路径可移植性`。

**Stop:** 若必须升级 Electron、模型或生产依赖，停止并另行 Gate。

### Task 2：修复图片 Blob 生命周期

**Files:** `src/modules/images.js`、`tests/repository-cleanup.test.cjs` 或新建 `tests/image-lifecycle.test.cjs`。

**Contract:** `remove(id)` 和 `clear()` 删除内存、索引、文件以及对应 Blob；公开图片 API 和 ImageRepository 引用规则不变。

- [ ] 写失败测试：新增图片后等待 `storage.getBlob('image:' + id)` 可见，删除后不可见。
- [ ] 写失败测试：`clear()` 后所有图片 Blob 和索引均为空。
- [ ] 增加局部 `removePersistedBytes(item)`，调用已有 `blobStore.removeBlob` 并清理 `imageDir` 文件；异步删除失败不得阻断其他清理。
- [ ] 保留当前 imageDir 恢复路径，不新增第二套读取后端。
- [ ] 运行专项测试与 `npm run check`。
- [ ] 提交：`V1.4.32：修复图片 Blob 生命周期`。

**Forbidden:** 不改 preload 图片授权、ImageRepository 引用计数或 Vision 临时引用。

### Task 3：统一会话持久化节流并补退出 flush

**Files:** `src/modules/assistant.js`、`src/modules/storage.js`、`main.js`、`tests/assistant-flow.test.cjs` 或新建 `tests/persistence-lifecycle.test.cjs`。

**Contract:** 高频 delta/event 合并持久化；完成、失败、取消、超时前强制保存；Storage 新增可选 `flush()`，旧 API 不变。

- [ ] 注入计数 storage，模拟高频 delta/event，先证明当前会产生过多完整保存。
- [ ] 写立即 `set()` 后调用 `flush()` 的文件恢复测试。
- [ ] 让 file adapter 暴露 `flush()`，清理 timer 并返回等待写入完成的 Promise。
- [ ] 在 Assistant 增加私有 `schedulePersist()`/`flushPersist()`；事件和 delta 只调度一次写入，终态强制 flush。
- [ ] 在 Electron 退出路径调用 flush；不改窗口关闭行为。
- [ ] 运行流式、取消、超时和持久化测试，记录写入次数。
- [ ] 提交：`V1.4.32：节流会话持久化并补退出保存`。

**Stop:** 若需改变 preload 桥接协议，单独建契约任务，不在此任务顺手重构。

### Task 4：修复设置数值语义和未知 reset

**Files:** `src/app-view.js`、`src/modules/settings.js`、`tests/assistant-flow.test.cjs`、`tests/regressions-v194.cjs`。

**Contract:** CFG=0、Seed=0 等合法零值保持为 0；未知 reset key 不改变任何配置。

- [ ] 增加 CFG/Seed 0 值和空字符串区别的失败测试。
- [ ] 增加未知 reset key 的失败测试。
- [ ] 将设置读取路径中的 `Number(x) || fallback` 改为有限数判断，空字符串仍走默认值。
- [ ] 只接受 `primaryApi`、`visionApi`、`comfy`、`limits` 等已知分组；未知分组返回稳定错误或 no-op。
- [ ] 运行设置回归与完整检查。
- [ ] 提交：`V1.4.32：修复设置零值与重置边界`。

### Task 5：清理或接通世界书无效控件

**Files:** `src/index.html`、`src/app-view.js` 或 `src/views/prompt-view.js`、`tests/ui-dom.test.cjs` 或新建 `tests/prompt-controls.test.cjs`。

**Contract:** 可见的世界书按钮必须有实际 handler；若 V1.4.32 没有可用 API，则整组控件隐藏/删除；提示词组和扩展提示词功能保持不变。

- [ ] 搜索 `wbModal`、`wbSelAll`、`wbSelNone`、`wbImportGo`、`worldBook` 的动态引用、导出和配置。
- [ ] 无 API 时删除整组死控件；有 API 时只让 prompt view 负责打开、全选、取消、导入和关闭。
- [ ] 增加点击调用测试或 DOM 不暴露测试。
- [ ] 运行 UI 测试与完整检查。
- [ ] 提交：`V1.4.32：清理无效世界书控件`。

**Forbidden:** 不删除当前可用提示词组和扩展提示词导入导出。

### Task 6：Settings 事件单一所有者

**Files:** `src/views/settings-view.js`、`src/app-view.js`、`tests/ui-dom.test.cjs` 或新建 `tests/settings-events.test.cjs`。

**Contract:** Settings view 唯一负责字段收集、保存、AI 测试、Comfy 测试；一次点击只产生一次请求和一次通知。

- [ ] 在 jsdom 中计数 `#aiTest`、`#comfyTest` 调用，记录当前重复触发。
- [ ] 删除 app-view 中与 settings view 重复的 test listeners。
- [ ] 逐项核对字段 change/input 监听，保留一个写入路径；模型刷新改为显式 callback。
- [ ] 运行事件计数、UI 和完整检查。
- [ ] 提交：`V1.4.32：收敛设置页事件所有权`。

**Budget:** 1 个 view + 1 个 composer，目标少于 120 行。

### Task 7：Gallery 单一 owner 与键盘交互

**Files:** `src/views/gallery-view.js`、`src/app-view.js`、必要时 `src/index.html`、`src/app.css`、`tests/ui-dom.test.cjs` 或新建 `tests/gallery-interaction.test.cjs`。

**Contract:** Gallery view 唯一拥有卡片渲染、选择、发送、下载、删除和重命名；选择状态只有一个来源；ImageRepository API 不变。

- [ ] 写失败测试：点击一次卡片只切换一次状态、只重绘一次、toolbar 数量一致。
- [ ] 用已有 `onVision`/`onConversation` callback 连接跨页行为。
- [ ] 删除 app-view 的重复 gallery card listener，路由只调用唯一 view 的 render。
- [ ] 卡片补 `tabindex=0`、`role=button`、`aria-pressed` 和 Enter/Space；按钮动作阻止选择冒泡。
- [ ] 运行图库 DOM、键盘和完整测试。
- [ ] 提交：`V1.4.32：统一图库交互并补键盘操作`。

**Stop:** 若缺少公开操作，先补最小 callback 契约，不搬迁整个图片页面。

### Task 8：Conversation owner 与清空确认

**Files:** `src/views/conversation-view.js`、`src/app-view.js`、`src/index.html`、`tests/ui-dom.test.cjs` 或新建 `tests/conversation-actions.test.cjs`。

**Contract:** 清空当前会话必须先确认；取消不改变消息；确认后刷新消息和图片仓库；删除会话继续使用图片保留选项。

- [ ] 写带消息和图片引用的清空确认失败测试。
- [ ] 复用现有 `confirm()`，显示消息数和图片影响，不新增弹窗体系。
- [ ] Conversation view 接管后删除 app-view 重复 binding；若不能一次搬完，先关闭 factory 的重复 bind，保持旧行为并记录下一阶段。
- [ ] 运行会话 DOM 和完整检查。
- [ ] 提交：`V1.4.32：统一会话操作并增加清空确认`。

**Budget:** 先完成清空确认和重复绑定隔离；完整会话搬迁另开 staged refactor。

### Task 9：能力探测竞态、存储错误和缓存上限

**Files:** `src/modules/calls/index.js`、`src/modules/storage.js`、`src/modules/tags.js`、`src/modules/translation.js`、`src/modules/images.js`、专项测试文件。

**Contract:** 只有最新 capability token 能更新状态；存储写失败可观察；Tag/翻译/图片分析缓存有固定上限且命中结果不变。

- [ ] 写延迟第一次请求、快速强制第二次请求的竞态测试。
- [ ] 写拒绝 adapter 的 storage 错误状态测试。
- [ ] 写超过上限的 Tag、翻译和图片分析缓存淘汰测试。
- [ ] 在 calls 增加递增 token，只有最新 token 提交 capabilityState。
- [ ] 使用小型 Map LRU：Tag/翻译默认 256 条，每图分析最多 4 个变体；命中更新顺序。
- [ ] 运行专项测试与完整检查。
- [ ] 提交：`V1.4.32：收敛状态探测与缓存边界`。

**Stop:** 若错误反馈需要改变全站通知协议，只先提供内部 status/callback，不扩散 UI 改造。

### Task 10：架构护栏与全量验证

**Files:** `scripts/check.mjs`、`package.json`、`README.md`、新建/修改 `tests/architecture-boundaries.test.cjs`。

**Contract:** `npm run check` 覆盖依赖可用性、全部维护源码语法、架构边界和现有单元测试，不依赖外部绝对路径。

- [ ] 在 check script 遍历 `main.js`、`preload.js`、`src/**/*.js` 并运行 `node --check`，失败时打印相对路径。
- [ ] 增加 ownership guard：Settings/Gallery/Conversation 的关键 DOM listener 由指定 owner 注册；死世界书控件不回归。
- [ ] 执行 `npm ci && npm run check`。
- [ ] 运行 Electron 人工验收：启动、设置保存/重启、AI 流式回复、取消、图片上传/删除、图库批量操作、Comfy 失败提示、提示词导入导出、清空确认、版本显示。
- [ ] 审查最终 diff、确认 `git status` 干净，记录剩余布局/屏幕阅读器风险。
- [ ] 提交：`V1.4.32：补全架构护栏与维护检查`。

## Gate 与回滚规则

- 局部修复目标为 1–2 个核心文件、少于 80 行；owner 收敛目标少于 200 行。
- 若需改持久化格式、公开 preload API、Comfy schema 或全量重写 app-view.js，立即停止并重新 Gate。
- 若测试失败原因与审查证据不同，回到 AUDIT。
- 若检查仍被环境阻断，必须区分代码失败和依赖失败，不能声称全部通过。
- 若补丁超出预算，拆阶段或重新 Gate，不顺手扩大范围。

## 暂缓项目

- 全量拆分 app-view.js。
- 完整声明式工具注册表迁移。
- 会话历史分页或数据库索引。
- React/Svelte 或新的状态管理框架。
- Comfy 工作流解析器重写。
- 新的安全、权限或远程服务层。
