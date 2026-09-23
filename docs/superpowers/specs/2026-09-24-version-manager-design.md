# AI 绘画 Tag 工具箱版本管理与切换设计

## 目标

从当前内部版本 V1.4.353 开始，为 Windows 便携版增加可选择的版本更新与回退能力。用户点击左上角版本号后可以查看 GitHub Releases 中的版本、下载并安装未安装版本、切换到已安装版本；切换失败时自动恢复上一版本。图库、会话、设置、提示词和用户图片继续由所有运行版本共享。

旧版 Release 不纳入自动切换范围。V1.4.353 是本地迁移时的初始槽位；从 V1.4.354 起，Release 必须遵循新的更新资产契约。

## 非目标

- 不把 Git 仓库复制成按版本排列的源码目录。源码版本由 Git commit/tag 管理，桌面运行包才按版本保存。
- 不在应用运行中替换当前 Electron 可执行文件或 `app.asar`。更新会由外部更新宿主执行，并在替换完成后重新启动应用。
- 不自动删除用户图库、会话、设置、提示词、ComfyUI 配置或调用记录。
- 不允许任意 GitHub URL、任意 Release 资产或第三方脚本参与安装。仓库所有者、仓库名和资产命名规则固定在更新协议中。

## 总体结构

版本管理引入一个稳定的安装根目录。版本目录是不可变运行槽位；更新器只写临时目录和新版本目录，不修改正在运行的槽位。

```text
C:\Users\admin\Desktop\AI绘画Tag工具箱\
├─ AI绘画Tag工具箱.exe             稳定启动器/版本宿主
├─ version-state.json              当前槽位与协议状态
├─ versions\
│  ├─ V1.4.353\                   当前迁移槽位
│  │  ├─ app\
│  │  ├─ resources\
│  │  ├─ locales\
│  │  ├─ models\
│  │  ├─ AI绘画Tag工具箱V1.4.353.exe
│  │  └─ build-info.json
│  └─ V1.4.354\                   下载并校验后的新槽位
├─ .staging\                       下载和解压临时目录
└─ .backup\                        最近一次切换前的槽位备份
```

稳定启动器负责读取 `version-state.json`、启动当前版本和处理启动失败回退。实际业务 UI 与 AI 功能仍运行在 `versions/<version>/` 下的版本包中。启动器和更新宿主使用固定的 `updateProtocol`，不能随业务版本任意覆盖。

用户数据继续位于当前已经使用的 `%APPDATA%\ai-tag-toolbox-rewrite`：

```text
%APPDATA%\ai-tag-toolbox-rewrite\
├─ 标签库、设置、提示词和会话 JSON
├─ rewrite-images\                 图库和对话图片本体
├─ debug\                          调用摘要
└─ backups\                        切换/回退前的数据快照
```

版本包不得把上述目录复制到 `versions` 中。应用继续使用稳定的用户目录；版本切换只改变代码和资源，不改变数据根路径。模型是否移动到共享目录作为后续磁盘优化，第一阶段保留版本包自带的模型路径，避免改变现有加载边界。

## 版本状态文件

`version-state.json` 使用原子写入，结构固定为：

```json
{
  "protocol": 1,
  "activeVersion": "1.4.353",
  "previousVersion": "1.4.353",
  "pendingVersion": "",
  "installed": [
    {
      "version": "1.4.353",
      "directory": "versions/V1.4.353",
      "source": "migration",
      "archiveSha256": "",
      "installedAt": "2026-09-24T00:00:00.000Z",
      "lastLaunch": "ok"
    }
  ],
  "lastError": null
}
```

版本号比较使用项目规则：主版本、次版本和修补/内部迭代号按数字比较；稳定版和测试版保留 Release channel 信息，不能只调用 GitHub 的 `/releases/latest` 判断新版本。当前本地 V1.4.353 即使高于 GitHub 现有 V1.4.32，也要显示为本地版本而不是误报“有更新”。

## GitHub Release 契约

从 V1.4.354 开始，每个可切换 Release 必须提供：

```text
AI.Tag.V1.4.354.zip
AI.Tag.V1.4.354.7z
AI.Tag.V1.4.354.zip.sha256
AI.Tag.V1.4.354.7z.sha256
AI.Tag.V1.4.354.build-info.json
```

更新器优先使用 ZIP，避免依赖用户机器上的 7-Zip；7z 继续用于手动下载。`build-info.json` 至少包含 `version`、`sourceCommit`、`archiveSha256`、`sourceCopiesVerified`、`executableMatchesTemplate`、`updateProtocol`、`dataSchemaMin`、`dataSchemaMax` 和检查结果。更新器只接受固定仓库 `star-abyss/ai-tag-toolbox`、匹配版本的资产名、HTTPS 下载地址和有效 SHA-256。

GitHub API 只负责读取 Release 元数据和下载资产。渲染进程不直接访问任意网络地址；主进程通过受限 IPC 提供版本列表、下载进度、校验结果和安装状态。

## 更新与切换流程

### 检查版本

点击 `#brandSub` 后打开版本面板。主进程请求 Release 列表并返回轻量记录：版本、channel、发布时间、是否已安装、是否当前版本、ZIP/7z 大小和可用操作。面板同时显示缓存结果；网络失败时仍能切换已安装槽位。

### 安装未下载版本

1. 用户选择目标版本并确认重启。
2. 主进程把 ZIP 下载到 `%LOCALAPPDATA%\AI绘画Tag工具箱\downloads\`，通过事件报告字节进度。
3. 下载完成后校验 `.sha256`、压缩包大小和 `build-info.json` 版本字段。
4. 解压到安装根目录 `.staging\V<version>-<random>`。
5. 检查目标目录中的版本号、EXE、`resources/app.asar`、`app`/`resources/app` 源码镜像、`models` 和 `build-info.json`。
6. 写入 `pendingVersion`，刷新并关闭业务窗口。
7. 外部更新宿主等待旧进程退出，将 staging 原子改名为 `versions/V<version>`，更新 `previousVersion` 和 `activeVersion`，再启动稳定启动器。

### 切换已安装版本

已安装槽位不重复下载。更新宿主只验证目录清单，写入 `pendingVersion`，关闭业务窗口并启动目标槽位。用户可从 V1.4.353 切换到任意已安装的后续版本，也可切回上一版本。

### 启动失败回退

切换时先把状态写成 pending。目标版本启动后必须在限定时间内写入一次成功心跳；启动器未收到心跳、目标 EXE 不存在或 `build-info` 校验失败时，恢复 `previousVersion` 并记录错误。当前版本的业务数据不因启动失败删除。

### 数据备份与兼容

每次切换前为 `%APPDATA%\ai-tag-toolbox-rewrite` 创建带版本和时间的快照，并在目标版本的 `dataSchemaMin`/`dataSchemaMax` 不兼容时阻止切换，要求用户先导出或确认备份。回退只改变运行槽位；数据恢复必须由用户在版本面板中明确选择，不能自动覆盖最新数据。

## UI 交互

- 左上角版本号点击区域保持现有品牌布局，增加可点击状态和键盘焦点。
- 有比当前版本更新的 Release 时显示小圆点；没有网络时显示缓存时间，不显示虚假的“最新”。
- 版本列表行显示：版本号、稳定/测试、发布时间、安装状态、当前状态、包大小和操作按钮。
- 下载、校验、解压、等待关闭、切换、回退和失败均使用同一个状态区域，不把进度塞进普通 AI 对话。
- 需要关闭应用时明确显示“更新完成后将重启程序”；绘图任务运行、未保存草稿或持久化失败时禁止切换并说明原因。
- 当前版本显示“正在使用”，未安装版本显示“下载并切换”，已安装版本显示“切换”，当前版本显示“回退到上一版本”时必须有备份可用。

## 安全与恢复边界

- 所有下载只允许 GitHub API 和固定仓库的 HTTPS 资产地址。
- 不执行 Release 中的脚本或安装器；只解压经过校验的运行包并启动包内固定名称的 EXE。
- SHA-256 用于完整性校验；后续可增加签名清单，但不能把同一个未验证下载内容作为唯一信任来源。
- 下载、解压和切换均使用随机临时目录；取消或失败只删除临时目录，不触碰 active 槽位和用户数据。
- 磁盘空间不足、文件被锁定、校验不匹配、版本协议不兼容和目标启动失败必须返回明确错误码，并保留当前可启动版本。

## 迁移策略

V1.4.353 首次启用版本管理时由外部宿主完成一次迁移：创建稳定安装根目录和 `versions/V1.4.353`，移动现有完整便携包而不是复制用户数据；生成 `version-state.json` 后启动稳定入口。原 `%APPDATA%\ai-tag-toolbox-rewrite` 保持原路径和内容。迁移失败时保留原目录，不进入半完成状态。

从 V1.4.354 起，桌面交付包必须包含稳定启动器所需的更新宿主、版本清单和 Release 资产契约；业务版本包不直接修改其它槽位。

## 测试要求

- 版本比较覆盖稳定版、测试版、本地内部版和同版本不同 channel。
- Release 解析拒绝错误仓库、错误资产名、缺失校验文件和版本字段不一致。
- 下载测试覆盖进度、取消、断点临时文件清理和网络失败。
- 解压校验覆盖缺失 EXE、缺失 app.asar、镜像不一致、哈希错误和磁盘空间错误。
- 状态机覆盖 pending、成功心跳、启动超时、自动回退和重复启动。
- 版本槽位切换覆盖已安装切换、未安装下载、回退、失败后保留旧槽位。
- 用户数据测试确认图库、会话、设置、提示词和图片本体在版本切换前后使用同一 `%APPDATA%` 根路径。
- UI 测试覆盖版本号点击、更新标志、列表操作、进度、阻止切换和错误恢复。
- 继续运行现有 `npm run check`；真实下载、解压、关闭/重启和 Windows 文件锁定作为人工桌面验收。

