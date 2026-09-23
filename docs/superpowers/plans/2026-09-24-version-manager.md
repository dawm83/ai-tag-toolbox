# Version Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从 V1.4.353 开始，为 Windows 便携版增加 GitHub Release 版本列表、下载校验、版本槽位切换、回退和共享用户数据保护。

**Architecture:** Git 仓库继续使用 commit/tag 管理源码；桌面安装根目录使用稳定启动器、`versions/V<version>` 不可变运行槽位和原子 `version-state.json`。业务版本通过受限主进程 IPC 请求更新，外部 Electron 更新宿主等待业务进程退出后完成槽位切换；图库、会话、设置和图片本体继续使用 `%APPDATA%\ai-tag-toolbox-rewrite`。

**Tech Stack:** Electron 主进程/预加载桥、CommonJS Node.js、原生 `https`/`fs`/`crypto`/`child_process`、Windows `tar.exe` ZIP 解压、现有 jsdom/node:test 检查链。

**Spec:** `docs/superpowers/specs/2026-09-24-version-manager-design.md`

## Global Constraints

- 当前基线版本为 V1.4.353；旧 GitHub Release 不纳入自动切换，V1.4.353 是本地迁移槽位。
- 用户数据固定保留在 `%APPDATA%\ai-tag-toolbox-rewrite`，任何更新、回退和切换都不得删除或复制图库、会话和设置。
- 只接受固定仓库 `star-abyss/ai-tag-toolbox` 的 HTTPS GitHub API/资产地址和匹配版本资产名。
- 更新必须先下载到临时目录、校验 SHA-256 和 build-info，再写入版本槽位；失败不得改变 active 槽位。
- 每个 Release 从 V1.4.354 起提供 ZIP、7z、两份 SHA-256 和 build-info；更新器优先 ZIP。
- 不在运行进程内覆盖 EXE 或 `resources/app.asar`；所有切换由独立更新宿主执行并重启。
- 每个任务先写失败测试，再写最小实现；任务完成后运行该任务定向测试并使用中文 `V版本号：说明` 提交。
- 完成前必须运行 `npm run check`；真实 GitHub 大文件下载、Windows 文件锁定、关闭/重启留给桌面人工验收。

---

### Task 1: 版本与 Release 纯协议模块

**Files:**
- Create: `src/modules/version-manager.js`
- Test: `tests/version-manager.test.cjs`
- Modify: `src/modules/index.js`（导出纯模块）

**Interfaces:**
- `parseVersion(value) -> { raw, major, minor, patch, channel } | null`
- `compareVersions(left, right) -> -1 | 0 | 1`
- `normalizeRelease(record) -> release | null`
- `normalizeState(value, installRoot) -> state`
- `transitionState(state, { type: 'prepare' | 'commit' | 'rollback', targetVersion?: string, error?: object }) -> state`
- `requiredReleaseAssets(version, assets) -> { zip, sevenZip, zipSha256, sevenZipSha256, buildInfo } | error`

- [ ] **Step 1: Write failing tests** for V1.4.353 internal ordering versus V1.4.32, stable/test channels, malformed release assets, fixed repository URLs, state normalization, pending/commit/rollback transitions, and rejection of path traversal in version directory names.
- [ ] **Step 2: Run the focused test**

```powershell
node --test tests/version-manager.test.cjs
```

Expected: FAIL because the pure module does not exist.

- [ ] **Step 3: Implement the pure contracts** without network or filesystem access. Normalize `v1.4.353`, `V1.4.353`, and `1.4.353`; retain `stable`/`prerelease`; accept only `star-abyss/ai-tag-toolbox`; choose exact asset names; use version directory names `V<raw-version>`.
- [ ] **Step 4: Run the focused test** and verify all malformed cases return stable error codes rather than throwing arbitrary errors.
- [ ] **Step 5: Commit**

```powershell
git add src/modules/version-manager.js src/modules/index.js tests/version-manager.test.cjs
git commit -m "V1.4.353：新增版本协议与状态机"
```

### Task 2: Download、校验、解压和槽位更新服务

**Files:**
- Create: `src/modules/update-service.js`
- Create: `src/modules/update-host.js`
- Test: `tests/update-service.test.cjs`
- Modify: `src/modules/index.js`

**Interfaces:**
- `createUpdateService(options) -> { listReleases, getState, downloadAndStage, switchInstalled, prepareSwitch, cancelDownload }`
- `createUpdateHost(options) -> { run }`
- `listReleases()` returns normalized releases plus installed/current flags and cached timestamp.
- `downloadAndStage(version, { signal, onProgress })` returns `{ version, directory, archiveSha256, buildInfo }` or a typed error.
- `prepareSwitch(version, context)` writes pending state and returns the host launch arguments; it never deletes the active slot.

- [ ] **Step 1: Write failing tests** with injected HTTP, file, hash, extractor and process dependencies. Cover cached Release listing, wrong repository/asset rejection, byte progress, SHA mismatch, build-info mismatch, missing EXE/app.asar, cancelled downloads, staging cleanup, installed-slot switching, and preserving the active slot on failure.
- [ ] **Step 2: Run `node --test tests/update-service.test.cjs`** and verify it fails for missing service functions.
- [ ] **Step 3: Implement GitHub access** through a fixed API base and an injected transport. Stream downloads to `%LOCALAPPDATA%\AI绘画Tag工具箱\downloads`, compute SHA-256 while writing, parse the checksum file, and cache metadata without storing image/user data.
- [ ] **Step 4: Implement safe ZIP staging** through an injected extractor backed by Windows `tar.exe`; list archive entries first, reject absolute paths/`..`, extract into a random `.staging` directory, then validate `package.json`, `VERSION.txt`, `resources/app.asar`, `app`, `resources/app`, `models`, matching EXE and `build-info.json`.
- [ ] **Step 5: Implement state transitions** using atomic temporary JSON replacement. `prepareSwitch` must set `pendingVersion`, preserve `previousVersion`, and create a user-data backup marker before the host is launched.
- [ ] **Step 6: Implement `update-host.js`** to wait for the parent PID, rename staging into `versions/V<version>`, update state, launch the stable host, and restore `previousVersion` when the target process reports a failed heartbeat or exits before readiness. No host operation may remove `%APPDATA%\ai-tag-toolbox-rewrite`.
- [ ] **Step 7: Run the focused tests** and verify all failure paths leave an executable active slot.
- [ ] **Step 8: Commit**

```powershell
git add src/modules/update-service.js src/modules/update-host.js src/modules/index.js tests/update-service.test.cjs
git commit -m "V1.4.353：实现版本下载校验与槽位切换"
```

### Task 3: Electron 主进程 IPC、启动宿主和共享路径

**Files:**
- Create: `launcher/main.js`
- Create: `launcher/package.json`
- Modify: `main.js`
- Modify: `preload.js`
- Modify: `src/modules/update-service.js`
- Test: `tests/update-ipc.test.cjs`

**Interfaces:**
- Preload `AppModules.updates`: `getState()`, `listReleases()`, `download(version)`, `switchInstalled(version)`, `cancel()`, `onEvent(listener)`, `prepareSwitch(version)`.
- Main IPC channels: `updates:get-state`, `updates:list`, `updates:download`, `updates:switch-installed`, `updates:cancel`, `updates:prepare-switch`.
- Launcher heartbeat: target business process writes `readyVersion` only after preload boot and shared storage initialization succeed.

- [ ] **Step 1: Write failing IPC tests** with mocked `ipcMain`/`ipcRenderer` and a temporary install root. Assert the renderer receives only normalized metadata/progress, never API keys, local paths, image bytes or arbitrary URLs; assert `prepareClose` is required before a switch.
- [ ] **Step 2: Run `node --test tests/update-ipc.test.cjs`** and confirm the bridge is absent/fails.
- [ ] **Step 3: Add the stable launcher mode**. It reads `version-state.json`, validates the active slot, starts `versions/V<version>/AI绘画Tag工具箱V<version>.exe`, records parent/heartbeat state, and invokes `update-host.js` for pending operations. Keep launcher protocol independent from business `AppModules.version`.
- [ ] **Step 4: Register main-process IPC** with fixed repository constants, operation cancellation, close flushing, and typed errors. Never expose raw `fs`, `child_process`, HTTP response objects or paths to the renderer.
- [ ] **Step 5: Expose the thin preload bridge** and add `sharedRoot`/active-slot resolution to model and asset lookup without changing the `%APPDATA%` data root.
- [ ] **Step 6: Run the focused IPC tests** and verify the app still starts without a version-state file by using the current package as a compatibility fallback.
- [ ] **Step 7: Commit**

```powershell
git add launcher main.js preload.js src/modules/update-service.js tests/update-ipc.test.cjs
git commit -m "V1.4.353：接入版本管理主进程桥"
```

### Task 4: 左上角版本面板与更新状态 UI

**Files:**
- Modify: `src/index.html`
- Modify: `src/app-view.js`
- Modify: `src/app.css`
- Modify: `locales/zh-CN.json`
- Modify: `locales/en-US.json`
- Test: `tests/update-ui.test.cjs`

**Interfaces:**
- `#brandSub` remains the visible version control and opens a modal with `data-update-dialog`.
- UI consumes only `AppModules.updates` and renders `idle`, `checking`, `ready`, `downloading`, `staging`, `pending_restart`, `error`.

- [ ] **Step 1: Write failing jsdom tests** for clicking `#brandSub`, current-version rendering, newer-version dot, stable/prerelease rows, installed switch, download progress, cancellation, network error, and blocked switching while `AppModules.assistant.snapshot().busy` or `prepareClose` fails.
- [ ] **Step 2: Run `node --test tests/update-ui.test.cjs`** and confirm the new dialog/handlers do not exist.
- [ ] **Step 3: Add accessible modal markup** with current version, cached-check timestamp, release list, status text, progress bar, switch/download buttons, cancel and restart notice; keep all labels localized.
- [ ] **Step 4: Add renderer event wiring** around `#brandSub`, preserving focus/escape/outside-click behavior and never placing download progress in the AI conversation timeline.
- [ ] **Step 5: Add CSS** for the compact version badge and responsive release list; the badge must remain usable in the existing header at narrow widths.
- [ ] **Step 6: Run focused UI tests and existing UI architecture tests**.
- [ ] **Step 7: Commit**

```powershell
git add src/index.html src/app-view.js src/app.css locales/zh-CN.json locales/en-US.json tests/update-ui.test.cjs
git commit -m "V1.4.353：新增版本切换面板"
```

### Task 5: 版本打包契约与 V1.4.353 首次迁移

**Files:**
- Create: `scripts/package-version-manager.cjs`
- Modify: `scripts/package-unified-tags.cjs`
- Modify: `deployment-verification.json`
- Modify: `README.md`
- Modify: `启动说明.txt`
- Test: `tests/update-packaging.test.cjs`

**Interfaces:**
- `package-version-manager.cjs TEMPLATE SOURCE STAGING VERSION` produces a structured desktop root with one version slot, stable launcher, `version-state.json`, and build evidence.
- `package-unified-tags.cjs` continues to create a normal version package and writes `updateProtocol`, `dataSchemaMin`, `dataSchemaMax`, and the five Release asset names into build evidence.

- [ ] **Step 1: Write failing packaging tests** for structured slot paths, current-slot state, required build-info fields, no user-data copy, asset names, and source/app/asar/executable consistency.
- [ ] **Step 2: Run `node --test tests/update-packaging.test.cjs`** and confirm the manager packager is absent.
- [ ] **Step 3: Implement structured packaging** by moving the current full runtime into `versions/V1.4.353`, placing the stable launcher outside version slots, and writing an atomic initial state. The packager must reject a dirty source tree and a staging path outside the repository work directory.
- [ ] **Step 4: Extend build evidence** with `updateProtocol: 1`, `dataSchemaMin: 1`, `dataSchemaMax: 1`, ZIP/7z asset names, source commit, SHA-256 and the actual latest `npm run check` pass count; no `%APPDATA%` content may enter the package.
- [ ] **Step 5: Run packaging tests and `git diff --check`**.
- [ ] **Step 6: Commit**

```powershell
git add scripts/package-version-manager.cjs scripts/package-unified-tags.cjs deployment-verification.json README.md 启动说明.txt tests/update-packaging.test.cjs
git commit -m "V1.4.353：建立版本槽位与发布契约"
```

### Task 6: 完整验证、版本交付和桌面人工验收包

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `VERSION.txt`
- Modify: `src/index.html`
- Modify: `main.js`
- Modify: `preload.js`
- Modify: `scripts/check.mjs`
- Modify: `README.md`
- Modify: `启动说明.txt`
- Modify: `CHANGELOG.md`
- Modify: `deployment-verification.json`
- Create: `交付说明-V1.4.354.md`

- [ ] **Step 1: 升级内部版本标识到 V1.4.354**，同步 package、lock、窗口标题、preload、VERSION、HTML、README、启动说明和检查护栏。
- [ ] **Step 2: Run `npm run check`** and require every test plus `regressions-v194` to pass.
- [ ] **Step 3: 使用当前 V1.4.353 桌面运行库打包 V1.4.354 结构化目录**，检查版本槽位、稳定启动器、源码镜像、app.asar、原生依赖、模型、EXE 和 build-info。
- [ ] **Step 4: 将桌面旧目录移入工作区备份，桌面只保留 `AI绘画Tag工具箱` 结构化根目录和稳定启动器；不删除 `%APPDATA%` 用户数据。
- [ ] **Step 5: 做静态安装验证**：读取 `version-state.json`、核对 activeVersion、目标 EXE、app.asar、shared data path 和 build-info；不自动运行真实 AI/ComfyUI。
- [ ] **Step 6: Commit**

```powershell
git add package.json package-lock.json VERSION.txt src/index.html main.js preload.js CHANGELOG.md deployment-verification.json 交付说明-V1.4.354.md
git commit -m "V1.4.354：交付版本更新与回退功能"
```

- [ ] **Step 7: 等待用户人工验收**：点击版本号、读取 Release、选择已安装版本、下载测试包、取消下载、切换和回退；真实 GitHub 大包下载和 Windows 文件锁定由用户验收。
