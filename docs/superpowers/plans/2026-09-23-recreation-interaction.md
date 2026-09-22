# 复刻交互与可观察闭环实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让复刻任务以一次本地 Tag 基线出图开始，向用户展示每个判断和修改依据，并提供清晰的候选反馈入口、可配置的主模型视觉能力和可见的原图对照闭环。

**Architecture:** 保留当前 Agent Runtime、`agentControlled` 任务和原任务恢复机制。新增“复刻会话视图状态”作为 UI 与任务结果的共同契约：基线、对照、差异、修订、下一步均由结构化事件和短摘要表达。主 AI 选择模块，程序只守住本地识图首轮、会话权限、预算、取消和候选归属。

**Tech Stack:** Electron / CommonJS / 原生 DOM/CSS / node:test；不引入 Agent 框架或第三方依赖。

**Spec:** 本文件就是本次用户确认前的设计规格；实现前需得到用户确认。

## Global Constraints

- 基线是最新 V1.4.343 / `80842f5`，现有旧任务恢复格式继续兼容。
- 复刻且没有可靠内置 Tag 时，`vision.processOne(mode=local)` 是首轮唯一的本地识图入口，并且一个参考图任务只成功调用一次。
- 本地 Tag 原样作为首轮正向 Tag；首轮前不调用 AI 视觉描述或 `agent.generateTags` 重写这些 Tag。
- 复刻默认每轮一张图；只有用户明确要求多个候选时才提高 batch 数量。
- 主 AI 直接比较时必须拿到参考图和候选图；文字主模型使用 `generation.review` 辅助，不伪造视觉判断。
- 用户可设置主模型图片能力为 `auto`、`supported` 或 `unsupported`；模型名称启发式只用于 `auto` 的初始建议。
- 过程展示只输出结构化观察、差异、Tag 变化和下一步，不输出原始思维链、图片字节、API Key 或完整无关上下文。
- 每个阶段按 TDD 先写失败测试、单独运行、最小实现、完整检查、中文提交；不 push、不发布。

## 用户交互契约

```text
参考图 + 用户要求
  → 读取内置 Tag（有可靠结果则使用）
  → 没有可靠 Tag：本地识图一次
  → 首轮基线图（原样使用本地 Tag）
  → 主 AI / 视觉辅助对照原图与候选图
  → 显示期望、实际、差异和修改 Tag
  → 下一轮图（默认只自动执行一轮修订）
  → 显示“主 AI 判断”或“等待用户反馈”
```

结果卡必须按这个顺序显示：候选图、对照摘要、Tag 展开区、可见修改输入框、继续优化按钮。Tag 详情不得和修改输入框共用一个折叠容器。多候选时每张卡锁定自己的 `candidateId`，没有明确目标时不允许猜测。

## Task 1: 让候选卡成为明确的反馈入口

**Files:**

- Modify: `src/app-view.js:2995-3208` 候选卡渲染和继续优化事件
- Modify: `src/app.css:581-660` 候选、反馈框、时间线布局
- Modify: `src/index.html` 仅在现有 AI 区域增加可访问标签/状态容器
- Modify: `locales/zh-CN.json`, `locales/en-US.json`
- Test: `tests/ui-dom.test.cjs`

**Interfaces:**

- Consumes: `message.result.candidates`, `decisionRequired`, `selectedCandidateId`, `viewImageIds`, `residualIssues`, `events`。
- Produces: 每张候选卡始终可见的反馈入口；发送时传原消息 ID、候选 ID、反馈文本；用户看到当前修改对象。

- [ ] 写失败 DOM 测试：`awaiting_feedback` 的候选卡同时显示 Tag 折叠区和可见 textarea；Tag 展开状态不影响 textarea；点击继续优化传入正确 candidateId。
- [ ] 写失败 DOM 测试：多候选没有目标时显示“先选择候选”，不自动聚焦或提交另一张图。
- [ ] 写失败 DOM 测试：`decisionRequired` 显示“主 AI 正在判断/等待下一步”，不显示成普通用户点评。
- [ ] 最小实现候选卡布局：反馈框移到 Tag 折叠区外，placeholder 改为“告诉 AI 这一轮要怎么改（可选）”，按钮文案改为“按这张图继续优化”。
- [ ] 增加目标徽标、发送中状态、失败后保留文本和键盘焦点恢复。
- [ ] 运行 `node --test tests/ui-dom.test.cjs`，确认失败测试转绿。
- [ ] 运行 `npm run check`，提交 `V1.4.343：改进复刻反馈入口`。

## Task 2: 允许用户确认主模型视觉能力

**Files:**

- Modify: `src/modules/settings.js` 增加 `primaryVisionMode: auto | supported | unsupported`
- Modify: `src/views/settings-view.js`, `src/index.html` 在主模型设置旁增加三态选择
- Modify: `src/app-view.js:1038-1175, 3280-3295` 只把名称识别作为 auto 提示，supported 不弹警告
- Modify: `src/modules/primary-vision.js` 使用用户能力模式；明确图片不支持错误时只在 auto 模式降级
- Modify: `locales/zh-CN.json`, `locales/en-US.json`
- Test: `tests/primary-vision.test.cjs`, 新增 settings/DOM 回归

**Interfaces:**

- Consumes: 保存的 `settings.primaryVisionMode` 和当前 primary API profile。
- Produces: `primaryVisionMode` 进入主 AI 请求能力说明；明确 unsupported 时不传图片；supported 时不因未知模型名阻断。

- [ ] 先写失败测试：自定义模型名 + `supported` 仍收到 image_url；`unsupported` 不发送 image_url；`auto` 只在明确能力错误后降级。
- [ ] 写失败 DOM 测试：设置项能读取、保存和重新渲染；模型名称带/不带 vision 只影响 auto 的建议图标。
- [ ] 实现三态设置和迁移默认值 `auto`；保留独立 Vision API 的现有配置。
- [ ] 移除“模型未标记视觉模型就提示切换”的强制路径，改成状态提示和手动切换入口。
- [ ] 运行定向测试和 `npm run check`，提交 `V1.4.343：支持手动确认主模型视觉能力`。

## Task 3: 建立可观察的复刻时间线和对照摘要

**Files:**

- Modify: `src/modules/generation-orchestrator.js` 事件和 agent-controlled 结果
- Modify: `src/modules/primary-tools.js` `generation.review` 输出短差异
- Modify: `src/modules/candidate-evaluator.js` 限定评价输出为 expected/observed/changes/confidence
- Modify: `src/app-view.js:2910-2995, 3008-3130` 时间线、对照摘要、Tag diff
- Modify: `src/app.css`, locale files
- Test: `tests/generation-orchestrator.test.cjs`, `tests/generation-integration.test.cjs`, `tests/ui-dom.test.cjs`

**Interfaces:**

- Consumes: 原图/候选 imageId、主 AI 选择、`generation.review` 评价和 Tag patch。
- Produces: 事件形状 `{ type, stage, summary, details, sourceImageId, candidateId, changes }`；不包含像素、完整模型回复或思维链。

事件最少包含：`source.metadata`、`source.local_hint`、`baseline.prompt`、`candidate.ready`、`candidate.comparing`、`candidate.diff`、`prompt.revised`、`generation.awaiting_feedback`、`candidate.selected`。

- [ ] 写失败测试：基线和第二轮事件按顺序出现，候选 Tag 与事件中的 prompt 一致。
- [ ] 写失败测试：评价结果显示 expected/observed/changes/confidence；未调用评价时 UI 显示“未进行辅助评分”，不显示“硬错误 0”。
- [ ] 写失败测试：主 AI 选择显示“主 AI 选择的候选”，与“达到验收标准”分开。
- [ ] 实现短摘要和 Tag diff；默认显示前三个关键差异，展开后显示最多六项。
- [ ] 实现候选卡“第 N 轮”分组，基线图先显示，下一轮生成期间不隐藏上一轮。
- [ ] 运行 UI、编排器和集成测试，提交 `V1.4.343：显示复刻对照与判断过程`。

## Task 4: 强制复刻首轮基线和主动对照闭环

**Files:**

- Modify: `src/modules/primary-tools.js` 复刻首轮证据门和 `generation.execute` 描述
- Modify: `src/modules/task-policy.js` recreate 路由的 local-first 任务说明
- Modify: `src/modules/generation-orchestrator.js` source evidence、首轮、修订轮预算
- Modify: `src/modules/assistant.js` 在基线结果后把原图/候选交回主 AI
- Modify: `src/modules/primary-agent.js`, `assets/提示词素材/10-主AI固定提示词-PRIMARY_AGENT.txt`
- Test: `tests/agent-judgement.test.cjs`, `tests/generation-orchestrator.test.cjs`, `tests/generation-integration.test.cjs`

**Behavior contract:**

- 新复刻且无可靠内置 Tag：未完成一次 local hint 时，`generation.execute` 不能出第一张图，返回明确的下一动作 `vision.processOne(local)`。
- local 成功后，第一张图的 positiveTags 必须逐项等于 local 返回 Tag，不能经过 `generateTags` 或 AI 视觉描述重写。
- 第一张图生成后，主 AI必须收到原图和候选图 ID；视觉主模型调用 `conversation.viewImages`，文字主模型调用 `generation.review`。
- 主 AI 输出结构化 changes 后才能进入 `agent.generateTags(revise)`；修改子代理得到上一版完整 Tag + changes，不得到整份蓝图/历史评价。
- 默认只自动执行一轮修订；第二轮后等待用户。用户要求多个候选或更多轮时，主 AI 显式选择并受预算限制。
- 本地 Tagger 在一个 job 中最多成功执行一次；用户明确重新识图或更换参考图才清除缓存。

- [ ] 写失败测试：recreate 没有 local hint 时 generation.execute 被拒绝并返回 `INITIAL_HINT_REQUIRED`；有 metadata/用户完整 referenceTags 时走相应可靠 Tag 分支。
- [ ] 写失败测试：local 返回 Tag 后第一轮 render 的 Tag 完整相同；`generateTags(compile)` 和 AI vision 不被暗中调用。
- [ ] 写失败测试：基线结束后主 AI 能拿到两张图片；`generation.review` 的 changes 会进入下一轮 revise；未提及 Tag 保留。
- [ ] 写失败测试：同一 job 的第二次 local 调用被拒绝或返回缓存；预算耗尽时不再出图。
- [ ] 实现 evidence 状态和阶段事件；保证取消、角色确认、ComfyUI 已提交恢复仍通过 guard。
- [ ] 运行定向测试和 `npm run check`，提交 `V1.4.343：闭合复刻首轮对照修订流程`。

## Task 5: 端到端验收与桌面交付

**Files:**

- Modify: `tests/agent-judgement.test.cjs`, `tests/ui-dom.test.cjs`, `tests/runtime-integration.test.cjs`
- Modify: `CHANGELOG.md`, `交付说明-V1.4.343.md`, `deployment-verification.json`
- Use: `scripts/package-unified-tags.cjs`

- [ ] 运行完整 `npm run check`，记录测试数和失败数。
- [ ] 运行 `git diff --check` 和最终范围检查；确认没有像素、Key、完整模型回复写入会话或日志。
- [ ] 用 V1.4.343 模板组装最新源码、`app.asar`、`app/`、`resources/app/` 和同版本 EXE；确认桌面目录只含一个 `.exe`。
- [ ] 关闭旧测试进程，删除桌面旧目录后替换新目录；核对 `build-info.json.sourceCommit`、asar SHA256、依赖、模型和 EXE。
- [ ] 停止并等待用户人工测试，不自动 push、发布或继续扩展范围。

## Verification Matrix

| 场景 | 预期行为 |
| --- | --- |
| 参考图，无内置 Tag | local 一次 → 原样首轮 → 对照 → 一轮修订 |
| 参考图，有内置 Tag | 直接使用可靠 Tag 首轮，仍展示对照 |
| 文字主模型 | 不发送 image_url，用 `generation.review` 辅助 |
| 用户确认主模型支持图片 | 直接发送图片，不弹名称误报 |
| 用户反馈修改 | 输入框可见，目标候选明确，沿原 job |
| 多候选 | 每张卡显示独立 Tag、评分/未评分状态和修改入口 |
| 连接中断 | 保留原任务和 promptId，不重复提交 |
| 本地识图失败 | 明确失败原因，允许用户选择视觉辅助或手动要求 |

## Residual Risks

- 第三方视觉模型的理解质量仍需真实模型验收；本计划只保证输入、调度、证据和 UI 可见。
- 旧存档保持旧恢复路径；新建任务使用模型管理的可观察闭环。
- ComfyUI 是否真正加载参考图仍由工作流绑定决定，界面必须显示实际 `recreationMode`。
