# 复刻交互与可观察闭环实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让复刻任务以一次本地 Tag 基线出图开始，向用户展示每个判断和修改依据，并提供清晰的候选反馈入口、可配置的主模型视觉能力和可见的原图对照闭环。

**Architecture:** 保留当前 Agent Runtime、`agentControlled` 任务和原任务恢复机制。新增复刻会话视图状态作为 UI 与任务结果的共同契约：基线、对照、差异、修订、下一步均由结构化事件和短摘要表达。主 AI 选择模块，程序只守住本地识图首轮、会话权限、预算、取消和候选归属。

**Tech Stack:** Electron / CommonJS / 原生 DOM/CSS / node:test；不引入 Agent 框架或第三方依赖。

**Spec:** 本文件是本轮五阶段实施规格。

## 全局约束

- 基线为 V1.4.343，旧任务恢复格式继续兼容。
- 复刻且没有可靠内置 Tag 时，`vision.processOne(mode=local)` 是首轮唯一的本地识图入口，一个参考图任务只成功调用一次。
- 本地 Tag 原样作为首轮正向 Tag；首轮前不调用 AI 视觉描述或 `agent.generateTags` 重写。
- 复刻默认每轮一张图；只有用户明确要求多个候选时才提高 batch 数量。
- 主 AI 直接比较时必须拿到参考图和候选图；文字主模型使用 `generation.review` 辅助。
- 主模型图片能力提供 `auto`、`supported`、`unsupported` 三态；模型名称启发式只用于 auto 的建议。
- 过程展示只输出结构化观察、差异、Tag 变化和下一步，不输出思维链、图片字节、API Key 或完整无关上下文。
- 每阶段先写失败测试，再最小实现、完整检查、中文提交；不 push、不发布。

## 交互契约

```text
参考图 + 用户要求
  → 读取内置 Tag（有可靠结果则使用）
  → 没有可靠 Tag：本地识图一次
  → 首轮基线图（原样使用本地 Tag）
  → 主 AI / 视觉辅助对照原图与候选图
  → 显示期望、实际、差异和修改 Tag
  → 下一轮图（默认一轮修订）
  → 显示主 AI 判断或等待用户反馈
```

候选卡顺序固定为：候选图 → 对照摘要 → Tag 展开区 → 可见修改输入框 → 继续优化按钮。Tag 详情不得和修改输入框共用折叠容器。

## 阶段一：反馈入口

**文件：** `src/app-view.js`、`src/app.css`、`src/index.html`、中英文 locale、`tests/ui-dom.test.cjs`。

- [ ] 先写失败 DOM 测试：等待反馈时 Tag 折叠区和 textarea 同时可见；点击按钮传原消息 ID 与正确 candidateId；多候选未选择时显示先选候选。
- [ ] 将反馈框移到 Tag 折叠区外，placeholder 改为“告诉 AI 这一轮要怎么改（可选）”，按钮改为“按这张图继续优化”。
- [ ] 增加当前候选徽标、发送中状态、失败保留文本和键盘焦点恢复。
- [ ] 让 `decisionRequired` 显示“主 AI 正在判断/等待下一步”，不显示成普通用户点评。
- [ ] 运行 `node --test tests/ui-dom.test.cjs`、`npm run check`，提交 `V1.4.343：改进复刻反馈入口`。

## 阶段二：主模型视觉能力

**文件：** `src/modules/settings.js`、`src/views/settings-view.js`、`src/index.html`、`src/app-view.js`、`src/modules/primary-vision.js`、locale、相关测试。

- [ ] 先写失败测试：未知模型名在 `supported` 模式仍发送 image_url；`unsupported` 不发送；`auto` 仅在明确图片能力错误后降级。
- [ ] 增加 `primaryVisionMode: auto | supported | unsupported`，默认 auto，保存并迁移设置。
- [ ] 设置页显示三态选择；模型名只改变 auto 的提示图标，不再强制阻断图片。
- [ ] 明确视觉错误才降级，普通 400/500/网络错误保持真实失败。
- [ ] 运行定向测试和 `npm run check`，提交 `V1.4.343：支持手动确认主模型视觉能力`。

## 阶段三：可观察时间线与对照摘要

**文件：** `src/modules/generation-orchestrator.js`、`src/modules/primary-tools.js`、`src/modules/candidate-evaluator.js`、`src/app-view.js`、`src/app.css`、locale、相关测试。

- [ ] 先写失败测试：事件按基线、出图、对照、差异、修订顺序出现；未评分候选显示“未进行辅助评分”，不显示硬错误 0。
- [ ] 统一事件形状 `{ type, stage, summary, details, sourceImageId, candidateId, changes }`，增加 `source.metadata`、`source.local_hint`、`baseline.prompt`、`candidate.comparing`、`candidate.diff`、`prompt.revised`、`candidate.selected`。
- [ ] `generation.review` 只返回 expected/observed/changes/confidence 等短结构，不向主 AI和页面泄漏完整历史评价。
- [ ] UI 显示任务时间线、前三个关键差异、Tag 增删 diff 和每轮候选；不显示思维链和图片载荷。
- [ ] 区分“主 AI 选择”“用户选择”“辅助评分通过”“达到上限后的最佳候选”。
- [ ] 运行 UI、编排器和集成测试，提交 `V1.4.343：显示复刻对照与判断过程`。

## 阶段四：首轮基线与主动对照闭环

**文件：** `src/modules/primary-tools.js`、`src/modules/task-policy.js`、`src/modules/generation-orchestrator.js`、`src/modules/assistant.js`、`src/modules/primary-agent.js`、主提示词素材、相关测试。

**行为契约：**

- [ ] 先写失败测试：没有 local hint 时复刻出图被拒绝并提示调用 local；local Tag 成功后第一轮 positiveTags 逐项相同；首轮前不调用 AI vision 或 `generateTags(compile)`。
- [ ] 首轮生成后把原图和候选交回主 AI；视觉主模型用 `conversation.viewImages`，文字主模型用 `generation.review`。
- [ ] 主 AI 返回 changes 后才能调用 `agent.generateTags(revise)`；修改子代理只收到上一版完整 Tag + changes。
- [ ] 默认只自动执行一轮修订；更多轮必须由主 AI显式选择并受预算限制。
- [ ] 同一 job 的第二次 local 调用返回缓存/拒绝；取消、角色确认、ComfyUI 已提交恢复继续通过 guard。
- [ ] 运行定向测试和 `npm run check`，提交 `V1.4.343：闭合复刻首轮对照修订流程`。

## 阶段五：最终检查与桌面交付

**文件：** 测试、`CHANGELOG.md`、`交付说明-V1.4.343.md`、`deployment-verification.json`；使用 `scripts/package-unified-tags.cjs`。

- [ ] 运行完整 `npm run check`，记录测试数和失败数。
- [ ] 运行 `git diff --check` 和范围检查，确认会话/日志无图片像素、Key、完整模型回复。
- [ ] 复用当前桌面运行库组装源码、`app.asar`、`app/`、`resources/app/` 和同版本 EXE。
- [ ] 关闭旧进程，删除桌面旧目录，替换为唯一 V1.4.343；核对 sourceCommit、asar SHA256、依赖、模型和单个 EXE。
- [ ] 停止等待用户人工验收，不自动 push、发布或扩大范围。

## 验收矩阵

| 场景 | 预期 |
| --- | --- |
| 参考图、无内置 Tag | local 一次 → 原样首轮 → 对照 → 一轮修订 |
| 参考图、有可靠 Tag | 直接使用可靠 Tag 首轮，仍展示对照 |
| 文字主模型 | 不发 image_url，用 generation.review 辅助 |
| 用户确认主模型支持图片 | 直接发图片，不弹名称误报 |
| 用户修改候选 | 输入框可见、候选明确、沿原 job |
| 多候选 | 每张卡有独立 Tag、评分/未评分状态和反馈入口 |
| 连接中断 | 保留 promptId，不重复提交 |
| 本地识图失败 | 明确失败，允许视觉辅助或手动输入 |

## 余留风险

- 第三方模型的视觉质量仍需真实模型验收；计划保证输入、调度、证据和 UI 可见。
- 旧存档保留旧恢复路径；新建任务使用可观察闭环。
- ComfyUI 是否真正加载参考图由工作流绑定决定，界面显示实际 `recreationMode`。
