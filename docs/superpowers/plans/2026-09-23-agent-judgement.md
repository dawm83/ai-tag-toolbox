# 主 AI 视觉判断与自主调度实施计划

> 本轮按用户已确认的对话设计执行，基线为 V1.4.342 / 43cb4f7。沿用现有隔离工作树 codex/drawing-feedback，逐项实现、检查、中文提交；本轮最终桌面版 V1.4.343。

**Goal:** 主 AI 实际看图、综合证据并选择必要模块；本地 Tagger 仅提供初始弱提示；文生图子代理只接收生成或修改的必要内容。

**Architecture:** 复用现有 Agent Runtime 的原生工具循环和生成任务存储。模型管理的新任务按单轮生成返回，主 AI 可选择识图、Tag 编译、出图、评价和选择；旧任务继续可恢复。图片、取消、预算和任务归属仍由程序校验。

**Tech Stack:** Electron / CommonJS / node:test，沿用原有依赖。

**Spec:** 本文件记录对话中已批准的设计。用户本轮授权基于最新代码实施，不再次请求流程审批。

## 行为与边界

- 有视觉能力的主 AI 直接接收当前参考图，并能读取会话中的原图和候选；明确不支持视觉的模型由识图子代理补充观察。未知模型允许真实调用，明确不支持图片的错误降级，普通网络错误不冒充能力错误。
- 主 AI 负责判断，视觉模型意见和本地 Tag 都是有来源的证据。识图子代理可回答具体问题；本地识图缓存第一次成功结果，修改轮次不再次计算。
- 复刻先提取原图 Tag，缺失时本地识图一次。主 AI 可以识别明显错误；正常首轮可直接用初始 Tag 出图，大差异时重写任务描述，小差异时定向修改。
- Tag 子代理输入固定为 operation、requirements、可选 imageId、修改时的 positiveTags/negativeTags 和简短 changes；旧接口在边界转换，完整蓝图/角色库/评价/会话不进入模型。
- 模型管理的任务一轮只出一次图，禁止暗中运行识图、重编 Tag 和自动评价循环。主 AI 选择评价辅助，随后决定修订或交付。保留同一 job、实际每张图对应的 Tag、预算、超时、取消和连接恢复。
- 继续普通反馈和候选卡反馈时，模型管理的任务重新进入主 AI 判断；旧任务格式保留可恢复兼容，不批量改写用户存档。
- 禁止改动角色库数据、收藏、搜索/翻译逻辑、依赖版本、底层 ComfyUI 工作流；不 push、不发布；不调用真实付费 AI 或实际出图来代替用户验收。

## 工程检查收据与 Gate

Route: code-quality-workflow / ST-A0 / snapshot 2026-08-18；无设计目录候选。目标、红线和验收来自本轮及前文授权。

这是分阶段行为修复（Local Fix + Staged Refactor），不是重写。各阶段只改对应接缝及其测试；预算为视觉阶段 350 行，Tag 输入阶段 350 行，调度与恢复阶段 800 行，端到端回归和提示词阶段 400 行。若实际超出，先拆分或重新记录预算与原因。回滚按阶段 revert；保留 V1.4.342 基线。基线 npm run check：671 通过。

## 执行清单

- [ ] 1. 真实视觉输入：修改 assistant.js / primary-agent.js / agent-runtime.js；新增 primary-vision.js 和测试。验证附图以 image_url 到达模型、没有字节落入会话、跨会话拒绝、纯文本模型降级、候选可重看。先运行新增测试观察失败，再最小实现；npm run check 后提交。
- [ ] 2. 子代理输入：fixed-subagents.js 仅构造关键任务消息；增加 changes，旧 description/evaluation 仅按规则提取简短建议，丢弃旧蓝图和角色库外观。生成返回完整 Tag，修改返回 add/remove 补丁；验证实际网关 messages 无多余上下文且补丁真实生效；检查后提交。
- [ ] 3. 主 AI 工具选择：primary-tools.js / task-policy.js / generation-orchestrator.js 增加模型管理的单轮路径及评价/选择工具；保留旧任务内部接口。先验证两轮出图之间确实回到主 AI、评图与识图不被暗调、source/session/budget/cancel 检查仍有效，再实现并提交。
- [ ] 4. 原任务反馈与提示词：assistant.js 将新任务反馈及候选卡操作带回主 AI，指定原 job 和候选；primary-agent.js / task-policy.js 清除相互覆盖的固定流水线指令；更新工具说明及主提示词素材。验证 text-only 主 AI 的视觉辅助、本地一次提示、修改不重新识图、完整 Tag 基线不丢字段。检查后提交。
- [ ] 5. 最终检查与交付：完整 npm run check、最终 diff、版本标识；按现有 package-unified-tags.cjs 复用桌面 1.4.342 运行库。离线核对源码/asar/依赖/模型/可执行文件，替换桌面为唯一 V1.4.343，留待人工测试。

## 核验用例

新测试通过真实 Assistant/Runtime/Tools/Orchestrator，只有外部 AI、Tagger 和 ComfyUI 用受控网关：

```js
assert.equal(primaryRequest.content.some(part => part.type === 'image_url'), true);
assert.equal(localAnalysisCalls, 1); // 同图续轮读缓存
assert.deepEqual(firstRender.positiveTags, initialTags); // 首轮原 Tag
assert.equal(primaryDecisionsBetweenRenders > 0, true);
assert.equal(childUserText.includes('visualBlueprint'), false);
assert.equal(updatedJob.jobId, originalJob.jobId);
```

还需覆盖：不支持图片、失效图片引用、用户只要 Tag、禁用绘图、错误 Tag 纠正、未经评价的图片不标成通过、旧任务恢复、主 AI 无变更时不重复烧图。

## 验收限制

本地测试证明协议、状态和传递，不能证明第三方模型视觉质量。真实岛风例图、外部模型图片支持、实际 ComfyUI 复刻质量由用户在最终桌面版本测试。
