# 统一任务清单 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有生成状态机中引入一份可迁移、可验证、按来源和指令合并的统一任务清单。

**Architecture:** 新增纯函数模块 `task-brief.js` 作为唯一清单边界；生成 Job 持有清单并将当前 Tag 镜像到 `currentPrompt`。角色库、识图和候选评价先写入不同来源的条目，Tag 编译/修订只消费清单的有效上下文，ComfyUI 接口保持不变。

**Tech Stack:** CommonJS、Node test、现有 JSON schema helpers、Electron 生成编排器。

**Spec:** `docs/superpowers/specs/2026-09-22-task-brief-design.md`

## Global Constraints

- 每个小步先写失败测试，再写最小生产代码。
- 每个行为改动完成后立即运行相关测试并提交中文提交信息 `V1.4.337：说明`。
- 不引入新依赖，不重写 `agent-runtime.js`、`assistant.js` 或 `generation-orchestrator.js`。
- 保留 `originalRequirements`、`positiveTags`、`negativeTags` 等旧字段作为兼容镜像。
- 不把任何具体角色、作品或服装名称写进生产分支。
- 真实 AI、ComfyUI 和 Electron 慢测试留给用户人工验收。

---

### Task 1: Task brief pure model

**Files:**
- Create: `src/modules/task-brief.js`
- Create: `tests/task-brief.test.cjs`
- Modify: `src/modules/index.js`

**Interfaces:**
- Produces `createBrief(input)`, `addItems(brief, items, context)`, `mergeBrief(brief)`, `briefForAgent(brief)`, `migrateBrief(source)`.
- `mergeBrief` returns `{ include, preserve, observe, improve, excluded, conflicts }` with Tag values grouped by directive.

- [ ] Write failing tests for creation, source permissions, priority conflicts, user removal over library reference, and idempotent migration.
- [ ] Run `node --test tests/task-brief.test.cjs` and confirm failure because the module is missing.
- [ ] Implement the schema-normalizing pure functions with bounded arrays and stable IDs.
- [ ] Run the focused test and confirm all task-brief cases pass.
- [ ] Run `node scripts/check.mjs` and commit `V1.4.337：新增统一任务清单模型`.

### Task 2: Job compatibility and current prompt mirror

**Files:**
- Modify: `src/modules/generation-orchestrator.js`
- Modify: `tests/generation-orchestrator.test.cjs`

**Interfaces:**
- `normalizeJob` migrates old jobs through `migrateBrief`.
- `result(job)` exposes a bounded `brief` snapshot and keeps old prompt fields.

- [ ] Add failing tests for legacy Job migration and current prompt iteration persistence.
- [ ] Run the focused generation tests and verify the new assertions fail.
- [ ] Initialize `brief` at execute time and mirror `positiveTags`/`negativeTags` after compile and revision.
- [ ] Use the brief’s identity and user items to create compilation context without changing Comfy payloads.
- [ ] Run generation tests and commit `V1.4.337：让生成任务持有统一清单`.

### Task 3: Source-aware inputs

**Files:**
- Modify: `src/modules/generation-orchestrator.js`
- Modify: `src/modules/fixed-subagents.js`
- Modify: `src/modules/candidate-evaluator.js`
- Modify: `tests/runtime-integration.test.cjs`
- Modify: `tests/candidate-evaluator.test.cjs`

**Interfaces:**
- Vision observations enter as `source=vision` items.
- Character identity enters as `source=character_library` reference items.
- Evaluation issues enter as `source=candidate_evaluation` improve/remove items.
- Tag agents receive `briefForAgent(brief)` and current prompt.

- [ ] Add failing tests proving reference-only library items are visible but excluded from include Tag output.
- [ ] Add failing tests proving user feedback remove items suppress lower-priority observations.
- [ ] Run the focused tests and verify expected failures.
- [ ] Replace ad hoc role-context text with a bounded brief summary at the subagent boundary.
- [ ] Preserve full evaluation brief for image review while passing only the effective generation context to Tag compilation.
- [ ] Run runtime, evaluator and orchestrator tests; commit `V1.4.337：接入来源感知的子代理清单`.

### Task 4: User feedback and next-round revisions

**Files:**
- Modify: `src/modules/generation-orchestrator.js`
- Modify: `src/modules/assistant.js`
- Modify: `tests/generation-orchestrator.test.cjs`
- Modify: `tests/assistant-flow.test.cjs`

**Interfaces:**
- `continueGeneration` writes user feedback as `source=user_feedback` items.
- `revise` consumes `improve/remove` items and records the next `currentPrompt.iteration`.

- [ ] Add failing tests for feedback removal, improvement history, and fresh prompt iteration after resume.
- [ ] Run focused tests and verify failure.
- [ ] Append feedback items before revision, mark consumed items resolved/superseded, and mirror the revised prompt.
- [ ] Keep old candidate history and manual selection behavior unchanged.
- [ ] Run assistant and generation tests; commit `V1.4.337：让用户反馈进入下一轮清单`.

### Task 5: Full verification and delivery metadata

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `VERSION.txt`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/index.html`
- Modify: `main.js`
- Modify: `preload.js`
- Modify: `scripts/check.mjs`
- Modify: `deployment-verification.json`
- Create: `交付说明-V1.4.337.md`

- [ ] Run `npm run check` and record the exact passing count.
- [ ] Review `git diff --check` and verify no concrete role/garment hard-coding exists in production modules.
- [ ] Update version markers and delivery notes.
- [ ] Commit `V1.4.337：完成统一任务清单第一阶段`.
- [ ] Build and verify the desktop package only after all source checks pass.
