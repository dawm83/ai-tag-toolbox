# Agent 绘图闭环与任务可见性设计

> 2026-09-21 后续确认：以 [意图路由与最短流程计划](../plans/2026-09-21-intent-routing.md) 为当前实施顺序及进度入口。优先便捷、逻辑清晰和过程透明。下文的参考图强制绑定方案只适用于明确使用 img2img/control image 的任务；用户要求的默认复刻首轮是“本地 Tagger -> Tag -> txt2img”，允许不把原图注入 ComfyUI。图片事务服务与新增工具别名暂缓。

## 目标

把 AI 绘画工作台从“主 AI 调用固定绘图编排”推进为可恢复、可解释、可验证的 Agent 闭环：用户可以提问、生成图片、修改参考图；主 AI 能把要求和授权图片交给合适的子代理；系统能观察候选图、修订 Tag、再次渲染，并在真实评价完成后交付结果。

## 范围

- 修复主 AI Runtime 的多工具调用、工具失败回传、重试和终止语义。
- 增加会话图片选择、图库附加和参考图用途标记，同时保持当前会话图片授权边界。
- 阻止未绑定参考图工作流时的静默文字近似复刻，除非用户明确选择近似模式。
- 评价不可用时暂停或明确标记未评价交付，不伪装成 AI 验收结果。
- 把保留项、修改项和禁止项结构化传给识图、Tag 和评价子代理。
- 展示 Agent 计划、子代理、图片、Tag 修订、评分和停止原因。
- 把内部生成参数收进高级设置，增加任务恢复和最终报告。

不在本轮范围内：替换 AI 提供商、引入新的 Agent 框架、重写 Electron 主进程、重做标签库分类、修改收藏数据格式、发布正式版或推送远端。

## 设计原则

1. 继续使用现有 `agent-runtime.js`、`assistant.js`、`primary-tools.js` 和 `generation-orchestrator.js`，通过局部接口修复行为，不做整体重写。
2. 主 AI 只使用面向任务的高层工具；Tag 编译、评价、ComfyUI 参数和候选选择仍由程序状态机掌握。
3. 所有图片通过当前会话授权的 `imageId` 传递。主 AI 和日志不接触本地路径、原始文件路径或完整工作流。
4. 用户可见的“完成”必须有对应证据：真实参考图是否进入工作流、评价是否成功、候选为何被选择，都要能追溯。
5. 每个内部版本只改变一条行为路径，先写失败测试，再写最小实现，`npm run check` 通过后立即提交。

## 主 AI 与 Runtime 协议

### 多工具调用

`runPrimary` 必须处理模型同一响应中的全部合法工具调用。只读且互不依赖的调用可以并行；带副作用或依赖前一结果的调用按顺序执行。每个调用都追加一个对应的 `tool` 消息，消息内容统一为成功或失败信封。

工具失败不会自动让主 AI 回合结束。Runtime 将结构化错误交回模型，模型可以重试、改变参数、换工具或向用户解释。取消、根请求超时、额度耗尽、重复调用 ID 和协议损坏仍然直接结束请求。单个工具的自动重试次数由 Runtime 控制，避免模型无限循环。

### 面向任务的工具

主 AI 可见工具保持小而稳定：

- `tags.search`
- `characters.search`
- `conversation.listImages`
- `conversation.attachImage`
- `conversation.setReferenceImage`
- `agent.inspectImage`
- `agent.compileTags`
- `agent.reviewImage`
- `generation.execute`
- `generation.resume`

`comfy.render`、Tag 补丁、候选比较和工作流内部绑定继续由生成编排器调用，不直接暴露给主 AI。

### 子代理委派

每次子代理调用必须继承 `parentRequestId`、`rootRequestId`、`sessionId` 和授权图片范围，并记录 `purpose`、输入摘要、开始/完成/失败事件。子代理输入只接受声明过的 schema；图片由 Runtime 解析为受控视觉输入。

## 图片引用与复刻真实性

会话图片仓库增加“附加到任务”和“设为参考图”的关系操作。图库图片必须先创建当前会话关系，才能被主 AI 或子代理读取。关系记录保存用途、来源、消息 ID、是否待发送和是否为当前参考图。

复刻任务预检必须验证参考图绑定和工作流能力。没有 `sourceImage` 绑定，或工作流不支持 `img2img` / `controlImage` 时，任务进入 `needs_input`，而不是直接使用 `text_approximation`。用户明确选择“按文字近似生成”后才允许继续，并在结果中保存 `referenceUsed: false`、`userConfirmedApproximation: true`。

## 评价与停止条件

评价失败默认进入 `evaluation_unavailable` 暂停状态。系统提供“重试评价”“手动选择并接受未评价结果”“结束任务”三个明确动作。未评价候选不显示为 AI 推荐，也不能生成“已达到验收标准”的结果徽章。只有经过合法评价且满足硬约束与分数条件的候选，才可标记为 `accepted`。

## 视觉任务约束

生成任务新增可持久化的 `visualBrief`：

```json
{
  "mustKeep": ["人物身份", "镜头角度", "服装"],
  "change": ["发色", "背景光影"],
  "avoid": ["额外人物", "文字水印"],
  "qualityGoals": ["手部自然", "脸部清晰"],
  "sourceRole": "reference_observation"
}
```

主 AI 的原始要求保存在 `originalRequirements`，结构化约束作为补充，不覆盖用户原话。识图、Tag 编译、Tag 修订和候选评价都接收同一个 `visualBrief`。

## 可见任务过程与结果

现有 `#talkStatus` 继续显示单行摘要，同时新增结构化任务时间线。事件包括：

- `plan.created`
- `delegation.started`
- `image.attached`
- `image.inspected`
- `prompt.compiled`
- `candidate.rendering`
- `candidate.evaluated`
- `prompt.revised`
- `generation.paused`
- `generation.completed`

每次 Tag 修订保存 `added`、`removed`、`preserved` 和 `reason`。候选卡片展示分项评价、当前 Tag、上一轮到本轮的差异和实际停止原因。完成任务提供最终图片、最终 Tag、参考图是否生效、候选统计、修订记录和剩余问题的可复制报告。

## 设置与恢复

默认工作台只展示“回答问题、生成图片、修改这张图、继续优化、只生成 Tag”等意图操作。候选数量、自动优化轮数和失败重试次数移入高级设置，并使用用户语言说明。

ComfyUI 设置拆分为“用户启用意图”和“当前可用性”。连接失败只更新可用性，不自动清除用户启用意图。`interrupted`、`needs_input`、`awaiting_feedback` 任务统一提供继续、重试评价、更换参考图和放弃入口。

## 分阶段交付

- `V1.4.333`：Runtime 多工具调用、失败回传和受控重试。
- `V1.4.334`：会话/图库图片附加与参考图真实性校验。
- `V1.4.335`：评价不可用暂停、人工放行和可靠停止条件。
- `V1.4.336`：任务时间线、子代理可见性、Tag Diff 和分项评价。
- `V1.4.337`：意图化工作台、高级设置收纳、任务恢复和最终报告。

每个版本必须通过 `npm run check`。涉及 AI 推理、图片传递或 ComfyUI 的版本额外运行一次 smoke 检查，并由用户人工完成真实任务验收。

## 收据与证据边界

- 项目基线：`1.4.332`，提交 `b9a8aca`。
- 基线验证：`npm run check`，617 项通过。
- A0 路由收据：`consult-tavernweave-library`，`ST-A0`，快照 `2026-08-18`。
- 提出的候选仅用于工程检查单参考，没有采用 TavernWeave 专属运行时、依赖或设计资产。
- 当前未完成真实 AI 服务、视觉模型和 ComfyUI 的运行时验收；源码测试通过不等于真实工作流可用。
