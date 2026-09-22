# 统一任务清单设计

## 目标

把用户要求、角色库资料、识图观察、当前提示词、候选评价和上一轮反馈放入同一份可追踪的任务清单。主 AI、识图子代理、文生图 Tag 子代理和候选评价子代理读取同一份清单，但只有程序负责来源、优先级和冲突合并。

## 设计原则

1. 用户当前要求永远保留原文，结构化条目是补充，不能覆盖原话。
2. 角色库默认特征只能作为参考，不能自动升级为绘制要求。
3. 识图结果记录“原图看到了什么”，不自动代表“本次必须保留什么”。
4. 用户反馈、删除意见和候选评价必须能覆盖低优先级参考条目，同时保留历史。
5. ComfyUI 继续只接收当前正负 Tag；任务清单负责解释这些 Tag 为什么存在。
6. 来源由程序写入，AI 不能伪造来源或提高权限。

## 数据契约

任务清单保存在生成 Job 的 `brief` 字段：

```json
{
  "version": 1,
  "goal": {
    "mode": "recreate",
    "userRequest": "把角色改成穿紧身衣，保留原图构图"
  },
  "currentPrompt": {
    "positiveTags": ["character_tag", "three-quarter view"],
    "negativeTags": [],
    "iteration": 2
  },
  "items": [
    {
      "id": "item-1",
      "scope": "character.1.outfit",
      "value": "tight suit",
      "source": "user",
      "directive": "must_include",
      "authority": "hard",
      "status": "active",
      "evidence": {}
    }
  ]
}
```

允许的 `source`：`system`、`user`、`user_feedback`、`reference_tags`、`vision`、`character_library`、`candidate_evaluation`、`model_inference`。

允许的 `directive`：`must_include`、`preserve`、`observation`、`reference_only`、`improve`、`remove`、`ignore`。

允许的 `authority`：`hard`、`high`、`medium`、`low`。

允许的 `status`：`active`、`resolved`、`superseded`、`rejected`。

条目 `id` 在任务内稳定；相同 `scope` 的新条目不删除旧条目，而是通过合并结果决定旧条目是否 `superseded` 或 `rejected`。

## 优先级与冲突

来源默认优先级为：

```text
system > user > user_feedback > reference_tags > candidate_evaluation > vision > character_library > model_inference
```

合并规则：

1. `remove` 和 `ignore` 先建立屏蔽键，低优先级相同内容不进入提示词。
2. `must_include` 和 `preserve` 进入目标集合，但仍需服从更高优先级的 `remove`。
3. `reference_only`、`observation` 只供模型理解，不直接进入目标 Tag。
4. `improve` 进入下一轮修改清单，不直接改变当前 Tag，除非修订子代理生成合法补丁。
5. 同一来源、同一作用域和同一内容的新条目替代旧条目；不同来源保留并通过优先级解决。
6. 任何 AI 输出缺少来源时由调用边界补齐；来源不在白名单或权限超出调用方时整条拒绝。

## 模块职责

- `task-brief.js`：纯函数，负责 Schema、条目创建、来源权限、合并、提示词上下文和兼容迁移。
- `generation-orchestrator.js`：Job 持有任务清单；用户原话、角色库、识图和评价通过统一 API写入；当前 Tag 镜像到 `currentPrompt`。
- `fixed-subagents.js`：编译和修订时接收清单摘要，不再单独解释角色资料字段。
- `candidate-evaluator.js`：根据候选差异产生 `candidate_evaluation` 条目，不直接改变用户硬约束。
- `primary-agent.js` / `task-policy.js`：要求主 AI 保留用户原话并在续轮提供反馈；不暴露内部低层结构。
- `app-view.js`：后续阶段展示按来源分组的清单摘要和当前 Tag Diff；本阶段先保留现有 UI。

## 兼容迁移

旧 Job 没有 `brief.version` 时按以下方式构造：

- `originalRequirements` -> `source=user`、`directive=must_include` 的原始要求条目。
- 旧 `visualBlueprint` -> `source=vision`、`directive=observation` 条目。
- 旧 `characterReferences` 的身份 -> `source=character_library`、`directive=reference_only`。
- 旧 `positiveTags` / `negativeTags` -> `currentPrompt`，不反推为用户硬约束。
- 旧评价的 `suggestedChanges` -> `source=candidate_evaluation`、`directive=improve`。

迁移必须幂等，不能改变旧 Job 的当前提示词和候选历史。

## 验收标准

1. 用户指定服装时，角色库默认服装仍在清单中，但不会进入目标 Tag。
2. 识图观察不会自动进入目标 Tag，除非用户或修订明确提升它。
3. 用户反馈删除某项后，该项和低优先级同类项都不会进入下一轮目标集合。
4. 当前提示词、来源和迭代号在 Job 恢复后保持一致。
5. 旧 Job 能迁移并通过现有生成、续轮和评价测试。
6. 角色名、服装名和作品名不出现在生产逻辑的特殊分支中。
