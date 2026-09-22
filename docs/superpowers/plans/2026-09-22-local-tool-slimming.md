# 本地单机工具精简与性能调整 Implementation Plan

> For agentic workers: use superpowers:executing-plans to implement this plan task by task. Each task ends with a focused test and a Chinese versioned commit.

Goal: 在不改变绘图反馈、续轮、Tag、图片、收藏和本机数据恢复行为的前提下，减少重复日志、重复数据副本、过宽接口和不必要的全量扫描，并让界面按需读取和渲染。

Architecture: 继续使用统一标签库、Images、Image Repository、Assistant 和 Generation Orchestrator 作为数据所有者。列表接口只返回列表需要的摘要；缩略图和原图按需读取；调用监视器只保存调度摘要，详细调度继续保存在对话；查询索引只解决已经测到的精确线性扫描。

Tech Stack: Electron、CommonJS、Node test、现有 JSON 文件存储和现有 bridge；不新增依赖、数据库、Worker 或通用虚拟列表框架。

Spec: docs/superpowers/specs/2026-09-22-local-tool-slimming-design.md

## Global Constraints

- 项目是单机本地工具；不新增多用户权限、网络安全治理、隐私平台或成人内容审查系统。
- 关键数据仍写入本机并可在重启后恢复；写入失败、关闭保存和旧数据迁移保持可见。
- adult 是内容分类，searchable 是搜索参与状态，不能互相替代；includeAdult 只表示显示筛选。
- 保留原始用户要求、当前正负 Tag、参考图、候选历史、续轮 jobId 和消息可见结果。
- 保留 Tag-only 禁止出图、续轮锁、反馈范围保护、重复 Comfy 提交保护和候选明确目标规则。
- 默认不改变持久化 JSON 结构；新摘要日志独立于旧 ai-calls.json，旧详细日志不自动删除。
- 每个行为阶段单独提交；提交信息以执行时 package.json 的实际版本号为前缀。
- 每阶段先跑针对性测试，再跑 npm run check；真实 Electron、AI、ComfyUI 和翻译模型由用户人工验收。
- 任何删除接口、字段或兼容代码前，先完成动态调用、测试、配置、迁移和导出路径检查。

## Baseline and Evidence

执行前保存以下基线：

- 当前提交：1c1da941b16c7a971a1029fd3cdc1a868019a100。
- 当前检查：npm run check，660 项通过。
- 隔离启动样本：带 5.2 MB 调用日志约 1.45–1.54 秒；尚未复现用户机器约 3 秒的冷启动。
- 已测热点：标签库准备约 366–389 ms，调用日志恢复约 138–142 ms，角色页首次约 455 ms，40 个未知翻译词引用匹配约 1.29 秒，单次选择约 41–50 ms，Tag 编辑约 82 ms，5 张图库列表逻辑载荷约 64 MB Base64。
- 当前用户样本：索引恢复 6 张图片、约 49.8 MB 原图；1 个空会话；0 个生成任务。

每阶段记录同一机器、同一数据、同样缓存条件下的进程启动、ready-to-show、dom-ready、Tag 可用四个时间点；不把隐藏窗口测试写成用户冷启动结果。

---

### Task 1: 建立可重复基准和数据所有权清单

Files:

- Create scripts/performance/local-probe.cjs
- Create tests/performance-contract.test.cjs
- Use work/performance-audit-v14339 as read-only evidence

Interfaces:

- local-probe.cjs 接受 profile、scenario 参数，输出 times、payloadSizes、calls、memory。
- performance-contract.test.cjs 断言接口字段和调用次数，不断言易抖动的毫秒数。

Steps:

- [ ] 复制当前用户数据到临时目录，记录 storage、图片索引和日志大小；禁止探针写真实用户目录。
- [ ] 记录启动四个时间点、图库列表载荷、翻译首次/重复查询、Tag 选择是否触发完整校验。
- [ ] 写契约测试，锁定图片下载、翻译精确引用、Tag 选择持久化和调用摘要查询。
- [ ] 运行定向测试和 npm run check，保存未改动基线。
- [ ] 提交探针和报告；探针不得进入 Electron 包。

### Task 2: 将调用监视器收敛为关键摘要

Files:

- Modify src/modules/call-monitor.js
- Modify src/modules/agent-runtime.js and src/modules/ai-client.js
- Modify preload.js and src/views/call-monitor-view.js
- Modify tests/call-monitor.test.cjs, tests/agent-runtime-protocol.test.cjs, tests/runtime-integration.test.cjs

Canonical record:

    {
      requestId, rootRequestId, parentRequestId, sessionId, messageId, jobId,
      kind, tool, model, status, startedAt, endedAt, durationMs,
      apiCalls, usage, usageScope, httpStatus, error
    }

Steps:

- [ ] 先写失败测试：摘要文件不能含请求正文、响应正文、headers、图片或事件数组；必须含 requestId、kind、status、duration、usage 和错误。
- [ ] begin 只写关联 ID、类型、模型和开始时间；beginExchange 只递增 apiCalls 并记录模型；endExchange 合并 usage、HTTP 状态和耗时。
- [ ] finish 只写状态、总耗时、总 usage 和错误摘要；停止用递归 sanitize 保存完整对象。
- [ ] 保留 200 条上限，把摘要文件限制为 512 KiB，文件名使用 debug/ai-call-summary.json。
- [ ] 启动只读取摘要；旧 ai-calls.json 保留在原处但不自动恢复。
- [ ] call-monitor-view 只显示摘要字段和关联 messageId/jobId；删除正文、系统提示、原始返回和事件面板。
- [ ] assistant 与 runtime 的 renderer 读取入口合并为一个 canonical 入口。
- [ ] 运行定向测试和 npm run check。

Behavior contract: 对话中的工具调用和结果不减少；调用监视器只减少调试副本；失败、耗时、Token 和父子关系不减少。

Rollback: 摘要写入失败时继续使用内存摘要；旧 ai-calls.json 不动，必要时恢复旧 monitor 的读写实现。

### Task 3: 让图片列表只传元数据和缩略图

Files:

- Modify src/modules/images.js and src/modules/image-repository.js
- Modify preload.js and src/app-view.js
- Modify tests/image-lifecycle.test.cjs, tests/repository-cleanup.test.cjs, tests/ui-dom.test.cjs, tests/runtime-integration.test.cjs

Canonical interfaces:

    images.getMeta(imageId)
    images.getThumbnail(imageId)
    images.getBytes(imageId)
    imageRepository.getOriginalBytes(imageId)
    imageRepository.listGallery({ offset, limit, query, order })

ImageMeta contains only imageId, displayName, width, height, mime, source, status, hasThumbnail and createdAt.

Steps:

- [ ] 写失败测试：listGallery 不含 bytes/dataUrl/analysis；getOriginalBytes 返回原始字节；缺失文件返回不可用状态。
- [ ] 修改 publicImage：普通 get/list 不生成完整 Base64；显式 preview/getThumbnail 才生成显示数据。
- [ ] 让启动恢复只加载索引；原图读取移动到 getBytes/getBlob。
- [ ] 对同一 imageId 的并发原图读取使用单飞 Promise，并在完成后清理；字节缓存上限 64 MiB。
- [ ] 保留 thumbnailDataUrl；缺失缩略图时按需生成并写回索引一次。
- [ ] imageRepository.listGallery 只组装 Meta，保留图库/会话共享引用和删除规则。
- [ ] preload 合并 images/imageStore，页面改用 canonical images。
- [ ] 图库、识图、下载、候选卡和会话图片改走显式原图接口。
- [ ] 运行图片、仓库和 UI 测试，确认启动原图读取次数为 0、列表没有 Base64。

Behavior contract: 现有预览、识图、下载、候选和会话引用保持；列表载荷缩小；不删除用户图片。

### Task 4: 图库和收藏页按需渲染

Files:

- Modify src/app-view.js and src/views/favorites-view.js
- Modify src/modules/tag-library/favorite-adapter.js and preload.js
- Modify tests/ui-dom.test.cjs, tests/favorites-view.test.cjs, tests/favorites-workbook-view.test.cjs, tests/favorites-selection.test.cjs

Steps:

- [ ] 写 UI 回归测试：选择图库卡片后 listGallery/preview 调用为 0，其他卡片 DOM 引用不变。
- [ ] 将图库选择拆成目标卡 class/aria-pressed 更新和工具栏更新；只有排序、搜索、分页、重命名、删除才完整重绘。
- [ ] 保留键盘选择、焦点、批量发送和批量删除。
- [ ] 新增 favorites.health()，renderHealth 不再调用完整 snapshot。
- [ ] 收藏首屏最多渲染 4 个栏目，其余使用已有 lazy placeholder/IntersectionObserver。
- [ ] 保留定位、隐藏/恢复栏目、拖拽和加载更多。
- [ ] 运行 UI 测试和 npm run check；记录 3,000/10,000 收藏 DOM 和首屏数据。

### Task 5: 为翻译和角色库建立窄索引

Files:

- Modify src/modules/translation.js and src/modules/tag-library/character-adapter.js
- Modify tests/translation-matching.test.cjs, tests/cache-limits.test.cjs, tests/characters.test.cjs, tests/tag-library-search.test.cjs, tests/tag-library-performance.test.cjs

Steps:

- [ ] 写翻译索引测试：英文、中文、别名、first-match、成人过滤和 searchable 行为不变。
- [ ] exactIndex 按 catalog revision 和 includeAdult 缓存；references、exactMatches、findTag 共用。
- [ ] 未知词一次查表返回空；模型成功时不提前构造完整 fallback。
- [ ] 保留普通 Tag substring、标准化、排序和 UTF-16 高亮路径。
- [ ] seriesCache 按 library revision、query、includeAdult、seriesId 缓存；关系、名称、撤销变化时失效。
- [ ] 角色详情继续按 ID 取完整资料，不把全量角色详情放进作品下拉。
- [ ] 运行定向测试并记录索引首建、20/40 词查询和角色页首次/热耗时。

### Task 6: 将选择类操作改为局部校验

Files:

- Modify src/modules/tag-library/library.js, commands.js and schema.js
- Modify tests/tag-library-selection.test.cjs, tests/tag-library-commands.test.cjs, tests/tag-library-schema.test.cjs, tests/tag-library-performance.test.cjs

Interfaces:

- 新增内部 validateFastMutation(current, candidate, command)，只接受 select、clearSelection、markCopied。
- fast validator 检查受影响 ID、selection 类型/引用、recentTagIds、revision 和已通过 validateCommand 的字段。
- Tag、分类、角色关系、导入和迁移仍执行完整 validateDocument。

Steps:

- [ ] 写失败测试：不存在 Tag、错误 selection kind、伪造角色特征和非法 recentTagId 必须失败且不写盘。
- [ ] 在 library.commit 按 command type 选择 fast validator；保存失败仍不发布变更。
- [ ] 增加一个回归测试确认结构编辑仍执行完整引用检查。
- [ ] 在合成文档上记录快路径耗时，目标 p95 小于 10 ms；不在普通 npm run check 中加入固定时钟阈值。
- [ ] 若旧存档恢复出现差异，回退本任务，不继续扩大到增量校验。

### Task 7: 收敛成人字段、兼容别名和 renderer bridge

Files:

- Modify src/modules/tag-library/adapter-common.js, tag-adapter.js, character-adapter.js
- Modify src/modules/translation.js, primary-tools.js, tags.js, favorites.js, characters.js
- Modify preload.js, src/app-view.js
- Modify tests/ui-architecture.test.cjs, tests/tag-library-adapters.test.cjs, tests/translation-matching.test.cjs

Steps:

- [ ] 用 rg 记录候选入口的真实动态调用、测试和导出引用；仍有调用方的别名先保留。
- [ ] 增加一个 canonical visible helper；内部只用 adult/searchable，nsfw/isAdult 只在输入/输出投影转换。
- [ ] 写测试确认成人开关只改变展示集合，明确 ID 的详情、翻译、复制和生成不被额外拒绝。
- [ ] 将 primary-tools 的重复成人门槛合并到一次统一查询过滤。
- [ ] 删除无调用方的 imageStore、all/allTags/getAll、低层 schema 和不可用 stub；保留模块内部构建/测试兼容包装。
- [ ] 运行 UI、角色、翻译、标签库测试和 npm run check。

Forbidden: 不删除 adult 字段、成人显示开关、tag-library-v2.json 字段、导入迁移格式或当前生成约束。

### Task 8: 减少聊天流式复制和启动重复渲染

Files:

- Modify src/modules/assistant.js and src/app-view.js
- Modify src/modules/storage.js only if duplicate copying is measured
- Modify tests/assistant-flow.test.cjs, tests/event-throttle.test.cjs, tests/ui-dom.test.cjs, tests/persistence-lifecycle.test.cjs

Steps:

- [ ] 写测试确认同一流式增量只读取一次当前消息，思考、工具调用、取消、失败和完成仍正确。
- [ ] onDelta 传递当前消息快照；updateStreamingTalk 和 updateActivityTimeline 共用该快照。
- [ ] 新写入不再复制 events 到 activity；旧存档缺失 activity 时从 events 只读投影。
- [ ] 启动默认只渲染 Tags；首次进入 AI 补齐 chat 和 conversation repository；删除 start() 重复 repository render。
- [ ] 保留原 sessions 键、保存节流、关闭 flush 和失败重试。
- [ ] 用 500 条合成历史记录增量调用次数和渲染耗时，运行定向测试和 npm run check。

### Task 9: 生成任务与消息状态收敛评估

Files:

- First modify only tests/generation-integration.test.cjs, tests/generation-continuation.test.cjs, tests/persistence-lifecycle.test.cjs
- Modify src/modules/assistant.js and src/modules/generation-orchestrator.js only after the gate is approved

Gate:

- 只有当实际 history/jobs 数据达到 10 MiB 或单次保存达到 100 ms，且 Task 8 之后仍存在明显重复写入，才实施本任务。

Steps:

- [ ] 先测消息和 jobs 大小、保存耗时和所有读取方；未达到门槛时记录 No Refactor。
- [ ] 达到门槛时增加 generationRef：jobId、roundId、candidateIds、selectedCandidateId；增加不可变 delivery 快照。
- [ ] 保留旧 result/candidates/rounds 字段，先完成旧存档迁移、导出导入、消息删除、任务恢复和旧版本回退测试。
- [ ] 任何旧消息跟随新候选漂移、续轮找不到 baseCandidate 或图片关系丢失时立即停止并保留现状。

### Task 10: 启动阶段最后收敛

Files:

- Modify preload.js, src/app.js and src/app-view.js
- Modify src/modules/tag-library/index.js and scripts/build-unified-tags.mjs only if the gate is met
- Modify tests/tag-library-bootstrap.test.cjs, tests/window-close.test.cjs, tests/ui-dom.test.cjs

Steps:

- [ ] 用同一用户数据重新测 cold/hot 四个时间点，确认日志、图片和隐藏页面已移出首屏。
- [ ] 让应用壳先显示 loading 状态，再等待 catalog.ready；重试、损坏提示和关闭保存保持。
- [ ] 删除默认路由的隐藏页面绘制，覆盖首次进入 AI、收藏、角色、图库和翻译。
- [ ] 只有当 A–I 完成后基础库阶段仍超过 200 ms 且总启动改善小于 20% 时，才生成一次 fingerprint 校验的轻量 runtime index。
- [ ] 不采用 SQLite、通用 Worker、动态模块框架或新存储服务，除非新的测量证据和单独 Gate 批准。
- [ ] 运行启动测试、npm run check 和一次人工 Electron 验收。

## Final Verification Checklist

- [ ] npm run check 通过，回归测试通过。
- [ ] 旧 V1.4.339 会话、Tag 库、收藏、图片索引和生成任务可以打开。
- [ ] 原始要求、工具消息、Tag-only、候选选择和续轮行为不变。
- [ ] 图库列表无原图载荷；识图、下载、预览和会话引用有效。
- [ ] adult 只影响展示筛选，明确指定的 Tag/角色和原始内容不被删除。
- [ ] 调用监视器只显示摘要；对话仍能解释每次 AI 调度。
- [ ] 选择类操作不触发完整基础库校验；结构编辑仍有完整引用检查。
- [ ] 索引和缓存有明确失效条件，没有无界内存增长。
- [ ] 性能报告包含 before/after、缓存状态、数据规模和未测项目。
- [ ] 最终阶段只同步一个新版本到桌面，等待人工测试；不自动 push 或发布。
