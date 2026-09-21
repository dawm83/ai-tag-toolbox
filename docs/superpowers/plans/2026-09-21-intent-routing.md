# 意图路由与最短流程实施计划

> 本文是当前进度入口，替代旧计划的版本排期。用户已确认逐步实现；本次交付第一阶段，随后人工试用。
> 使用 executing-plans 与 test-driven-development 执行。主任务保持单会话推进。

## 目标和边界

按用户明确意图区分查 Tag、图片分析、生成 Tag、问答、翻译、生图和复刻，缩小每轮可用工具范围并在执行前再次检查。优先方便、步骤清晰和过程可见，不增加 Agent 框架、数据库或图片事务服务。

基线为 c9ef3d9；应用实际标识仍为 1.4.332，前三次带 1.4.333 的提交没有打包交付。本次最终版本使用 1.4.334，并统一源码及桌面标识。

## 第一阶段行为契约

| 意图 | 当前复用工具 | 收尾规则 |
| --- | --- | --- |
| search_tags | tags.search | 成功检索后只整理回答 |
| analyze_image | conversation.listImages、vision.processOne | 必要时定位图片，识图完成后回答 |
| compile_tags | generation.execute(outputType=tags)、必要的图片定位 | 强制只输出 Tag，完成后回答 |
| answer | 无 | 直接回答 |
| translate | translation.translate | 翻译后回答 |
| create_image / recreate_image | Tag/角色查找、图片定位、ComfyUI 状态、高层生成和恢复 | 沿用生成编排器；暂停时交回用户 |
| auto | 当前已有工具 | 模糊、混合或上下文续接请求由主 AI 按现有协议判断 |

- 只对清晰请求作本地分类，不增加一次模型分类请求。未知表达不强行归为问答；被引用的示例和“如何、是什么”等说明请求不触发生图。
- 否定生图、明确只要 Tag 优先于“画”“生成”等词。混合需求不强行拆成单一短任务。
- 路由按当前用户正文计算，旧消息不会把新搜索请求带回旧绘图流程。
- `task-router.js` 只负责生成意图及用户原话；`task-policy.js` 只负责该意图可见工具、收尾规则和参数固定。
- Assistant 创建任务上下文并传给 Runtime。Runtime 同时过滤工具 Schema 和检查实际调用，禁止调用不会执行 handler，会以结构化错误返回模型。
- 保持原生 assistant/tool 成对记录；同轮被拒绝的工具同样产生 tool 结果，不能静默丢弃。根级取消/额度仍终止。
- 短任务成功后下一轮 `tool_choice=none`，防止继续发起无关工作；失败时仍允许修正调用。
- 生成任务携带服务端保留的用户原话，明确 Tag 请求的 outputType 由程序固定为 tags；已有生成结果继续进入 UI。
- 保留已有直接工具入口和生成编排器的内部工具权限；主 AI 的任务策略不拦截内部 Tag/ComfyUI 步骤。
- 用现有任务过程显示“任务类型”和“开始整理回答”；无新的面板或视觉重构。

## 与旧设计的修订

1. 复刻首轮应为本地识图 Tag 直接送入 txt2img；原图用于视觉比较，不必注入工作流。img2img/control image 是另一条可选路径，只有选择该路径才校验参考图节点。
2. 本地 Tagger 的输出是标签和置信度，不能当作完整视觉描述；需要细节分析时由视觉模型补充。
3. 图片失败时停止相关步骤、丢弃本次临时输入并保留用户原图；暂不实现复杂的 handoff 事务持久化。
4. 先复用 generation.execute 的 tags-only 分支保证第一阶段可用。后续简单 Tag 流程再直接对接现有 generateTags 子代理，不先批量重命名工具。
5. 原方案中的并行工具执行、工具成功/失败统一信封、失败分类尚未全部落地；c9ef3d9 仅实现顺序多调用、错误继续及相同参数失败次数限制。

## 本次执行清单

- [x] 读取代码与已有计划，运行基线 npm run check：621 项通过。
- [x] 明确以上契约与后续边界；工程收据 code-quality-workflow / ST-A0 / 2026-08-18。
- [x] 添加路由和真实 Runtime/Assistant 测试，复现越界工具、只要 Tag 却请求图片、原话被覆盖、短任务成功后重复调用。
- [x] 实现路由与策略，接入 Assistant/Runtime，并在现有事件列表显示任务类型和收尾状态。
- [x] 验证中文/英文、否定、混合任务、带图请求、错误恢复、原生工具成对记录及内部绘图不受影响；npm run check 636 项通过。
- [x] npm run check 636 项通过，功能提交 ac099be；更新应用标识为 1.4.334。
- [ ] 按现有桌面包复用运行库和模型，验证源码、asar、exe、版本及完整性，交付人工验收。

## 定向测试与实现入口

- 新建 `tests/task-routing.test.cjs`：用户原话和预期 intent 使用固定表格；断言实际工具列表与是否执行 handler。
- 新建 `src/modules/task-router.js`：`routeTask({ text, imageIds })` 返回 `{ intent, originalRequest, imageIds }`。
- 新建 `src/modules/task-policy.js`：`createTaskPolicy(task)` 返回 `filterTools(schemas)`、`prepareCall(name,args)`、`complete(name,data)`、`isComplete()`、`prompt()`；无 task 时保持 Runtime 原行为。
- 修改 `src/modules/assistant.js`：在构造当轮运行请求时创建并传入 task。
- 修改 `src/modules/agent-runtime.js`：构造系统提示时附加本轮策略；每次模型调用过滤工具；执行前准备/检查参数；成功后切换收尾；对整组调用完成 tool 消息后再暂停。
- 修改 `src/app-view.js`：现有 activityLabel 显示 task.routed/task.answering。
- 定向命令：`node --test tests/task-routing.test.cjs tests/agent-runtime-protocol.test.cjs tests/runtime-integration.test.cjs tests/ai-reasoning.test.cjs`。
- 全量命令：`npm run check`。按项目规范不启动慢 UI 测试；真实 AI 和 ComfyUI 交由人工验证。

## 后续阶段

- [ ] 图片输入：能力检查、真实图片载荷、失败取消和临时引用释放；准确报告视觉失败。
- [ ] 三个短流程细化：搜索结果交付、带图分析、Tag 子代理直接输出可复制代码块。
- [ ] 复刻第一轮：本地 Tagger -> 保留初始 Tag -> ComfyUI txt2img。
- [ ] 复刻循环：原图/候选差异 -> 原话、原图、初始/当前 Tag -> 子代理定向修订 -> 再生成。
- [ ] 普通生图：Tag -> ComfyUI -> 对照用户要求评价 -> 修订；保持既有结果直到替代图有效。
- [ ] 可见结果：Tag diff、分项问题、实际停止原因、最终图与可复制报告。

未来阶段的版本号按实际提交决定，不提前宣称完成。图片模型不支持、ComfyUI 未连通及真实复刻质量仍是人工验收项目。
