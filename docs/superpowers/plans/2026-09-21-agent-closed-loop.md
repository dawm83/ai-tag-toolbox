# Agent 绘图闭环与任务可见性 Implementation Plan

> 后续用户已调整优先级。当前实施和进度请读 [意图路由与最短流程计划](2026-09-21-intent-routing.md)。本文件保留原始设计；Task 1 的顺序多调用和失败回传、Task 2 的次数限制/失败文字已提交，但完整失败分类和并行执行仍未实现。下文未勾选项不代表已交付。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保持现有会话、图片仓库和生成状态机兼容的前提下，建立可恢复、可验证、可解释的 Agent 绘图闭环。

**Architecture:** 先扩展 `agent-runtime.js` 的工具回合协议，再由 `primary-tools.js` 提供会话图片和面向任务的子代理入口；`generation-orchestrator.js` 负责参考图真实性、评价状态、visualBrief 和 Tag Diff；最后由 `app-view.js` 和少量 CSS 展示任务过程与最终报告。每个阶段都是独立的局部行为变更，不新增第三方依赖。

**Tech Stack:** Electron、CommonJS、Node Test、现有 `Assistant` / `Agent Runtime` / `Generation Orchestrator` / ComfyUI connector、原生 DOM/CSS。

**Spec:** `docs/superpowers/specs/2026-09-21-agent-closed-loop-design.md`

## Global Constraints

- 版本从 `1.4.332` 逐步推进，内部版本使用 `V1.4.333`、`V1.4.334` 等中文提交信息，不 push。
- 每个行为变更先写失败测试，再写最小生产代码；每个小版本完成后立即运行 `npm run check` 并提交。
- 不引入新的 Agent 框架或依赖，不重写 `agent-runtime.js`、`assistant.js` 或 `generation-orchestrator.js`。
- 主 AI 不接触本地路径、API 密钥、图片字节或完整 ComfyUI 工作流。
- 当前会话授权是图片读取的唯一边界；图库图片必须先建立会话关系。
- 未经过真实视觉评价的候选不得伪装成 AI 验收结果。
- 桌面同步和人工验收在本轮最终内部版本完成后执行；正式发布和 push 仍需用户明确要求。

---

### Task 1: Runtime 多工具调用和失败回传

**Files:**
- Modify: `src/modules/agent-runtime.js:236-273`
- Test: `tests/agent-runtime-protocol.test.cjs`

**Interfaces:**
- Consumes: `responseCalls(response)`, `callTool(name, args, context)`。
- Produces: `runPrimary(request)` 将每个调用的成功/失败结果追加到下一轮 `messages`，并继续模型回合。

- [ ] **Step 1: Write the failing tests**

  在 `tests/agent-runtime-protocol.test.cjs` 添加两个测试：

  ```js
  test('executes every valid tool call returned in one assistant response', async () => {
    let calls = [];
    let rounds = 0;
    const primaryClient = { complete: async () => {
      rounds += 1;
      return rounds === 1
        ? { toolCalls: [
            { id: 'tag-call', name: 'tags_search', arguments: { query: 'blue hair' } },
            { id: 'character-call', name: 'characters_search', arguments: { query: 'Alice' } }
          ] }
        : { text: 'done' };
    } };
    const tools = protocolTools(async name => { calls.push(name); return { ok: true, data: { items: [] } }; });
    const runtime = createAgentRuntime({ primaryClient, tools, getSettings: () => ({ limits: {} }) });
    const result = await runtime.runPrimary({ input: { text: 'find references' } });
    assert.equal(result.ok, true);
    assert.deepEqual(calls, ['tags.search', 'characters.search']);
    assert.equal(result.data.toolCalls.length, 2);
  });

  test('returns a failed tool result to the primary model for recovery', async () => {
    let rounds = 0;
    const received = [];
    const primaryClient = { complete: async messages => {
      received.push(messages);
      rounds += 1;
      return rounds === 1
        ? { toolCalls: [{ id: 'tag-call', name: 'tags_search', arguments: { query: 'blue hair' } }] }
        : { text: 'I recovered after the search failed.' };
    } };
    const tools = protocolTools(async () => ({ ok: false, error: { code: 'TEMP_FAIL', message: 'temporary', retryable: true } }));
    const runtime = createAgentRuntime({ primaryClient, tools, getSettings: () => ({ limits: {} }) });
    const result = await runtime.runPrimary({ input: { text: 'search' } });
    assert.equal(result.ok, true);
    assert.equal(received.length, 2);
    assert.match(received[1].at(-1).content, /TEMP_FAIL/);
  });
  ```

  `protocolTools` 必须复用测试中的真实 `createAgentRuntime` 注册路径，只提供 `tags.search` 和 `characters.search` 两个合法 schema，不测试未注册工具。

- [ ] **Step 2: Run the focused tests and verify the expected failure**

  Run: `node --test tests/agent-runtime-protocol.test.cjs`

  Expected: the first test reports only one executed tool because of `slice(0, 1)`; the second test returns `TEMP_FAIL` instead of a recovered assistant response.

- [ ] **Step 3: Implement the smallest protocol change**

  In `runPrimary` replace the single-call truncation with a normalized full call list. For each call, append a tool trace and a tool message. On `outcome.ok === false`, append the serialized error, emit `tool.failed`, and continue the `for` loop; after all calls, let the outer `while` ask the model for the next response. Keep direct root errors for cancellation, timeout and malformed model output.

- [ ] **Step 4: Verify focused and full checks**

  Run: `node --test tests/agent-runtime-protocol.test.cjs` and `npm run check`.

- [ ] **Step 5: Commit the deliverable**

  ```powershell
  git add src/modules/agent-runtime.js tests/agent-runtime-protocol.test.cjs
  git commit -m "V1.4.333：修复Agent多工具调用与失败恢复"
  ```

### Task 2: Runtime 重试边界与可见调用状态

**Files:**
- Modify: `src/modules/agent-runtime.js`
- Modify: `src/modules/call-monitor.js`
- Modify: `src/app-view.js`
- Test: `tests/agent-runtime-protocol.test.cjs`
- Test: `tests/call-monitor.test.cjs`

**Interfaces:**
- Consumes: `error.retryable` 和工具调用 trace。
- Produces: `attempt`、`retryOf`、`recoveryAction` 字段，以及 UI 可识别的失败状态。

- [ ] **Step 1: Add a failing retry-limit test**

  Make a registered retryable tool fail on every call. Assert that the model receives at most the configured retry result, the root request terminates, and the final trace preserves the last error. Add a non-retryable `INVALID_INPUT` case that never auto-retries.

- [ ] **Step 2: Run the focused test and verify it fails**

  Run: `node --test tests/agent-runtime-protocol.test.cjs tests/call-monitor.test.cjs`.

- [ ] **Step 3: Implement bounded retry metadata and events**

  Add a small runtime helper that classifies `TIMEOUT`, `COMFY_HTTP_ERROR` and `retryable === true` as retryable. Preserve the existing root usage limits. Emit `tool.retrying` with the previous request ID and attempt number. Do not retry schema or authorization failures.

- [ ] **Step 4: Fix UI trace status**

  In `app-view.js`, derive failure from `call.ok === false || call.error` and render `失败` with the error message. Keep the debug monitor as the detailed view.

- [ ] **Step 5: Run checks and commit**

  Run: `npm run check`.

  Commit: `git commit -am "V1.4.333：限制工具重试并修正失败状态显示"`.

### Task 3: 面向任务的子代理工具和图片附加

**Files:**
- Modify: `src/modules/primary-tools.js`
- Modify: `src/modules/image-repository.js`
- Modify: `src/modules/assistant.js`
- Modify: `preload.js`
- Modify: `src/index.html`
- Modify: `src/app-view.js`
- Test: `tests/character-tools.test.cjs`
- Test: `tests/image-repository.test.cjs`
- Test: `tests/assistant-flow.test.cjs`

**Interfaces:**
- Adds `conversation.attachImage(args, context)` and `conversation.setReferenceImage(args, context)`.
- Adds high-level `agent.inspectImage`, `agent.compileTags`, and `agent.reviewImage` wrappers that inherit the current session authorization.
- Existing low-level internal handlers remain available to the orchestrator but are not added to `listPrimary`.

- [ ] **Step 1: Write failing authorization tests**

  Assert that a gallery image can be attached to the current session, a different session cannot read it, a reference marker is persisted, and a raw local path is rejected. Assert that the high-level inspect wrapper passes the authorized image ID to the vision subagent.

- [ ] **Step 2: Run focused tests and verify the new tools are unavailable**

  Run: `node --test tests/image-repository.test.cjs tests/character-tools.test.cjs tests/assistant-flow.test.cjs`.

- [ ] **Step 3: Implement relation methods and schemas**

  Reuse `attachToConversation` and `authorizeVisionReference`; add only the smallest metadata fields needed for `purpose` and `reference`. Expose bound methods through preload. Do not expose `images.get` or filesystem paths to the primary model.

- [ ] **Step 4: Add UI controls**

  Add an image-card action to attach a gallery image and another action to mark one current reference. Render a small purpose badge and refresh the conversation repository after mutation.

- [ ] **Step 5: Run checks and commit**

  Run: `npm run check`.

  Commit: `git commit -am "V1.4.334：增加Agent图片附加与子代理委派入口"`.

### Task 4: Reference workflow truthfulness

**Files:**
- Modify: `src/modules/primary-tools.js`
- Modify: `src/modules/assistant.js`
- Modify: `src/modules/generation-orchestrator.js`
- Modify: `src/views/comfy-view.js`
- Modify: `src/app-view.js`
- Test: `tests/comfy-execution.test.cjs`
- Test: `tests/generation-orchestrator.test.cjs`

**Interfaces:**
- `generation.execute` can return `needsInput.kind = 'reference_workflow'`.
- `generation.resume` accepts `allowTextApproximation: true` only after explicit user action.
- Result includes `referenceUsed` and `userConfirmedApproximation`.

- [ ] **Step 1: Add failing tests**

  Create a recreate task with a source image and a profile without `sourceImage` binding. Assert no render call occurs and the result is `needs_input`. Add a resume test with `allowTextApproximation: true` and assert that only then `text_approximation` is returned.

- [ ] **Step 2: Run the focused tests and verify current silent fallback**

  Run: `node --test tests/comfy-execution.test.cjs tests/generation-orchestrator.test.cjs`; the existing approximate-render test demonstrates the old behavior.

- [ ] **Step 3: Implement explicit preflight and resume gate**

  Make preflight return `referenceReady`. In `checkPreflight`, pause when recreate has a source image but `referenceReady` is false. In resume, validate the explicit boolean and persist the confirmation before rendering.

- [ ] **Step 4: Add truthful delivery badges and actions**

  Replace a bare “文本近似复刻” badge with a warning containing the actual reference status and a button that opens the workflow settings path.

- [ ] **Step 5: Run checks and commit**

  Run: `npm run check`.

  Commit: `git commit -am "V1.4.334：阻止未绑定参考图的静默复刻"`.

### Task 5: Evaluation availability and visual brief

**Files:**
- Modify: `src/modules/generation-orchestrator.js`
- Modify: `src/modules/fixed-subagents.js`
- Modify: `src/modules/candidate-evaluator.js`
- Modify: `src/modules/primary-tools.js`
- Test: `tests/generation-orchestrator.test.cjs`
- Test: `tests/candidate-evaluator.test.cjs`

**Interfaces:**
- Job stores `visualBrief` with `mustKeep`, `change`, `avoid`, `qualityGoals`, `sourceRole`.
- Job may enter `needs_input` with `kind = 'evaluation_unavailable'`.
- Explicit resume action `acceptUnreviewedCandidate` is required for unreviewed delivery.

- [ ] **Step 1: Write failing tests for evaluation pause and visual brief propagation**

  Make `evaluateImages` throw. Assert the job pauses without `selectedCandidateId` or `accepted` outcome. Assert a user-approved unreviewed selection records `best_effort_unreviewed`. Pass a visual brief through compile, review and revise calls and assert the same object reaches each input.

- [ ] **Step 2: Run focused tests and verify current best-effort fallback**

  Run: `node --test tests/generation-orchestrator.test.cjs tests/candidate-evaluator.test.cjs`; current behavior marks `evaluation_unavailable` then continues.

- [ ] **Step 3: Implement pause and explicit manual release**

  Change `evaluateOne` to persist a paused job on non-cancel errors. Add `resume({ action: 'acceptUnreviewedCandidate', candidateId })` validation. Keep user selection of an explicitly visible candidate separate from AI recommendation.

- [ ] **Step 4: Add `visualBrief` schema and propagation**

  Normalize bounded string arrays in the job. Include the brief in `generateTags`, `evaluateImages` and revision inputs without removing `originalRequirements`.

- [ ] **Step 5: Run checks and commit**

  Run: `npm run check`.

  Commit: `git commit -am "V1.4.335：让评价失败进入明确暂停状态"`.

### Task 6: Tag Diff and structured task timeline

**Files:**
- Modify: `src/modules/prompt-patch.js`
- Modify: `src/modules/generation-orchestrator.js`
- Modify: `src/modules/assistant.js`
- Modify: `src/app-view.js`
- Modify: `src/app.css`
- Modify: `locales/zh-CN.json`
- Modify: `locales/en-US.json`
- Test: `tests/generation-orchestrator.test.cjs`
- Test: `tests/ui-dom.test.cjs`

**Interfaces:**
- Every `prompt.revised` event includes `added`, `removed`, `preserved`, and `reason`.
- Activity events use `plan.created`, `delegation.started`, `image.inspected`, `generation.paused`, and existing generation events.
- UI renders a collapsible timeline, with task summary open while streaming and closed after completion.

- [ ] **Step 1: Write failing diff and DOM tests**

  Assert a revision event includes the three Tag arrays and that a rendered assistant message contains a task timeline, a Tag diff section, and a visible evaluation-unavailable state.

- [ ] **Step 2: Run focused tests and verify fields are absent**

  Run: `node --test tests/generation-orchestrator.test.cjs tests/ui-dom.test.cjs`.

- [ ] **Step 3: Emit exact patch data**

  Capture the normalized patch from `applyPromptPatch`, include its arrays in the event, and persist the event in the job history. Add the revision reason from evaluation summary and suggested changes.

- [ ] **Step 4: Render timeline and failure states**

  Extend `activityLabel`, `renderActivityTimeline`, and candidate cards. Fix tool trace status to use `call.ok` or `call.error`. Do not put raw API prompts or image bytes in the visible summary.

- [ ] **Step 5: Run checks and commit**

  Run: `npm run check`.

  Commit: `git commit -am "V1.4.336：展示Agent任务过程与Tag修订差异"`.

### Task 7: Intent controls, recovery center, and final report

**Files:**
- Modify: `src/index.html`
- Modify: `src/app-view.js`
- Modify: `src/app.css`
- Modify: `src/workspace-theme.css`
- Modify: `src/modules/settings.js`
- Modify: `src/modules/assistant.js`
- Modify: `locales/zh-CN.json`
- Modify: `locales/en-US.json`
- Test: `tests/assistant-flow.test.cjs`
- Test: `tests/ui-dom.test.cjs`
- Test: `tests/capability-refresh.test.cjs`

**Interfaces:**
- Default AI actions: answer, generate, modify, continue, tags-only.
- Advanced controls keep the existing settings keys and only change labels/placement.
- Capability state separates user `drawingConfigured` from runtime `drawingAvailable`.

- [ ] **Step 1: Write failing DOM and state tests**

  Assert that a ComfyUI status failure does not set the user drawing preference to false. Assert that an interrupted job renders continue/retry/drop actions. Assert that the final report includes the final image, prompt, evaluation state and stop reason.

- [ ] **Step 2: Run focused tests and verify current preference reset**

  Run: `node --test tests/assistant-flow.test.cjs tests/ui-dom.test.cjs tests/capability-refresh.test.cjs`.

- [ ] **Step 3: Separate configured and available capability state**

  Remove the settings mutation from `refreshCapabilities`; update only the capability snapshot. Keep `settings.comfy.enabled` as the user intent and derive `render` from connection/workflow readiness.

- [ ] **Step 4: Add intent actions and advanced settings disclosure**

  Add buttons near the prompt input. Buttons only fill a structured request mode; natural-language input remains valid. Move the numeric controls into a collapsible advanced group without changing persisted key names.

- [ ] **Step 5: Add recovery cards and final report copy**

  Render explicit actions for `interrupted`, `needs_input`, `awaiting_feedback`, and `evaluation_unavailable`. Add a safe text report builder that excludes secrets, local paths, workflow JSON and image bytes.

- [ ] **Step 6: Run checks and commit**

  Run: `npm run check`.

  Commit: `git commit -am "V1.4.337：增加意图操作任务恢复与最终报告"`.

### Task 8: Runtime and desktop acceptance

**Files:**
- Modify: `tests/assistant-flow.test.cjs`
- Modify: `tests/generation-orchestrator.test.cjs`
- Modify: `tests/call-monitor.test.cjs`
- Modify: `scripts/check.mjs`
- Modify: `package.json`
- Modify: `VERSION.txt`
- Modify: `src/index.html`
- Modify: `main.js`
- Modify: `preload.js`
- Create: `交付说明-V1.4.337.md`

**Interfaces:**
- Version markers use `1.4.337` in package metadata, `VERSION.txt`, HTML title, Electron title and delivery directory.
- No release archive or remote push is created unless separately requested.

- [ ] **Step 1: Add one local end-to-end fixture**

  The fixture drives a question, a create task, a recreate task with a real authorized image ID, one evaluation failure and a manual unreviewed release. Assert the full transcript, task events, final report and absence of secret fields.

- [ ] **Step 2: Run `npm run check` and record the complete output**

- [ ] **Step 3: Run one AI/Comfy smoke test when the local services are available**

  If services are unavailable, record the exact missing endpoint/model as a verification gap; do not claim runtime acceptance.

- [ ] **Step 4: Build/sync the final desktop test version**

  Use the existing project delivery script if present. Remove the previous test directory only after confirming its exact path, copy the source and packaged resources, update the executable name, and verify that the new directory contains the matching `.exe`.

- [ ] **Step 5: Commit delivery evidence**

  Commit: `git commit -m "V1.4.337：完成Agent绘图闭环验收记录"`.
