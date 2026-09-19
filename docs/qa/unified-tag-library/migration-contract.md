# 统一标签库迁移与启动恢复合同（Task 4）

本合同覆盖宿主领域层；Task 9 负责启动错误面板和显式按钮。没有新增 renderer 文件路径入口，也没有第二个写入服务。版本标识保持 1.4.316。

## 宿主接线

```js
const { createTagLibrary, createLibraryRepository, readLegacyInput } = require('./tag-library');
const repository = createLibraryRepository({ filePath: hostV2Path, backupDir: hostMigrationBackupDir });
const library = createTagLibrary({
  base,
  repository,
  legacyInput: () => readLegacyInput(hostLegacyStoragePath)
});
const result = await library.ready();
```

三个路径只由宿主依据固定用户目录构造。生产必须传函数重新读取旧文件，不能传启动时缓存的对象来检测仍运行旧版的写入。直接 `LegacyInput` 仅适合内存来源、转换或测试。未提供 legacyInput 保留纯新库初始化能力；已有合法 v2 时完全不调用 legacyInput。

## 导出与返回值

- `readLegacyInput(storageFilePath): Promise<LegacyInput>`：仅 ENOENT 返回 `{version:1,values:{}}`；读取失败抛 `LEGACY_READ_FAILED`。外层必须是 JSON 对象；十个相关完整前缀键的值必须是可解析 JSON 字符串，否则抛 `INVALID_LEGACY_INPUT`。忽略其他键，不打印其值。输出 values 使用去前缀键，相关字符串内容和 JSON 值不截断。
- `prepareLegacyMigration({base,legacy,ids?,now?}): Result<MigrationPlan>`：纯转换，无文件写入。ids 接收类型前缀并生成唯一 ID；now 返回非负整数时间。成功 data 为 `{document,report,sourceFingerprint}`，revision=0。report 等于新文档 migration 的副本。
- `fingerprintLegacy(input): string`：仅相关十键的规范 JSON SHA-256；忽略对象键顺序及无关设置变化，数组顺序和字符串字节参与计算。
- `filteredInput(input): LegacyInput`：内部及宿主转换辅助，只保留十键，拒绝非 JSON 值/accessor/循环引用；不要把此函数当成导入写入口。
- `library.ready(): Promise<Result<{migration}>>`：本次最新初始化结果。备份/转换/引用校验/首次落盘全部成功后才 ready/writable。
- `library.retryInitialization(): Promise<Result<{migration}>>`：零参数；失败后重新读取文件和旧来源并完成初始化。已 ready 时幂等返回成功。
- `library.recoverBackup(): Promise<Result<{migration}>>`：零参数；仅未 ready 时显式恢复固定 `.bak`，完成后重新初始化。ready 时返回 `RECOVERY_NOT_ALLOWED`。传入多余参数不会变成文件路径或替换数据。
- `library.status()` 沿用 `{ready,writable,error}`；Task 9 用它控制编辑入口。初始化失败、恢复过程中都不能执行成功写库。原 `flush/dispose/execute` API 保留。

两种恢复共用每实例最多 3 次实际尝试，不自动循环。并发恢复返回 `RECOVERY_IN_PROGRESS`；第四次返回 `RECOVERY_RETRY_LIMIT`，修复来源/存储后重建实例或重启。关闭后返回 `NOT_READY`。迁移不产生用户 undo/redo 历史。

Task 9 的 catalog/host adapter 应只转发 `status`、`ready`、`retryInitialization()`、`recoverBackup()` 及返回 Result，不接收路径、候选文档、validator 或任意文件名。本任务未修改 catalog/renderer，也未读取真实 AppData。

## Repository 所有权

`repository.save(document, {expectMissing?,beforeCommit?})` 第二参只供宿主 library 使用；普通 execute 仍只传 document。首次创建先写同目录临时文件并 fsync，再在最终提交前调用 beforeCommit 重读旧键指纹；随后以 exclusive hard link 创建正式文件并移除本次临时名，保证初次读取后突然出现的 v2 不会被覆盖。正常更新仍使用既有原子 rename + 最近有效 .bak。首次创建不支持 hard link 的文件系统会明确写失败，不降级到可能覆盖的 rename。

`repository.recoverBackup({validate}): Promise<{document,preservedOriginalId}>` 仅宿主调用。validator 是 library 私有的完整 base/reference validator；不能向 renderer 暴露。恢复依次：读取当前原字节、拒绝合法当前文件/未知 schema、读取固定 `.bak`、结构+完整引用及 baseFingerprint 校验、独占写入 `corrupt-v2-<sha256>.bin` 并 fsync 保存损坏原字节、写并 fsync 临时新文档、确认当前字节未变化、原子替换。不会把损坏当前文件轮换为 `.bak`。失败保留原文件和有效备份；部分临时文件仅清理本次所有项。

主要错误：`INVALID_LEGACY_INPUT`、`LEGACY_READ_FAILED`、`MIGRATION_FAILED`、`LEGACY_CHANGED_DURING_MIGRATION`、`INITIALIZATION_CONFLICT`、`INVALID_DOCUMENT`、`UNSUPPORTED_VERSION`、`STORAGE_READ_FAILED`、`STORAGE_WRITE_FAILED`、`RECOVERY_NOT_ALLOWED`、`RECOVERY_SOURCE_CHANGED`、`RECOVERY_IN_PROGRESS`、`RECOVERY_RETRY_LIMIT`、`RECOVERY_NOT_AVAILABLE`。错误消息不回显用户原文、路径或底层 secret。

## 转换与来源保留

相关键：rewrite_custom_tags、rewrite_selected、rewrite_tag_edit_history_v1、favorites_shelf_v1、favorites_selection_v1、favorites_recent_v1、rewrite_favorites、rewrite_character_edits_v1、rewrite_character_selection_v1、rewrite_character_edit_history_v1。

- 先调用现有 repository.backupLegacy 完整保存提取后的十键，再生成候选。旧键永不删除/回写；新文档是唯一完成标记。迁移前备份为内容寻址的 `legacy-v1-<sha256>.json`。它保存解码后的 JSON 值，不保存旧 root 的无意义缩进/属性排列或无关设置。
- 普通自定义/覆盖保持明确空名称与空别名；source 与 usages 来自 base。新 taxonomy 只在该条完整校验成功时保留。无效、超限、空内容、缺引用及重复 ID 都保留完整 JSON payload 于 unresolved，失败行不发布收据映射。
- ordinary、characters、series、specific 各自使用种子映射；characters 的值是 identityTagId。收据 characterIdMap 的值是已有稳定 characterId；未知角色不创建。旧 fallback 角色已由 base.characterLinks 建立，按同一规则处理。
- 角色编辑的 nameZh/aliases 等写身份 Tag；关系写 characterOverrides。共享覆盖与角色覆盖冲突时，只有明确较新的角色 editedAt/历史时间才能覆盖共享值；时间缺失、相同或较旧时保留共享值，并把角色差异记为 IDENTITY_EDIT_CONFLICT。trigger、seriesName、第二名称等无 v2 权威字段进入 CHARACTER_METADATA_ARCHIVE，完整输入还在备份。
- 收藏页/组保留合法 ID、颜色和顺序；同 ID 冲突拒绝覆盖并归档冲突行。根部条目只在需要时建立该页“未分类”组，排在已有组之后。
- 精确内容且全部元数据兼容才能引用；sourceCharacterId 经角色关系查 identityTagId，绝不直接当 tagId。差异创建 legacyFavorite，记录 INDEPENDENT_FAVORITE_DIFFERENCE。同一明确来源、完全相同独立版本在不同组共享一条记录。同组冗余归属合并并保留旧 ID 到存活 membership 的映射。
- title/zh 都非空且不同：title 为 displayName，zh 追加 aliases。既有 bundle、结构化多成员旧收藏、明确多行/数字权重 Prompt 保持全部原文并标为 bundle；后两种从 tag 转换时记录 OPAQUE_BUNDLE_CONVERSION。只有标点等模糊线索时保留 tag 整段，不拆词，记录 AMBIGUOUS_WHOLE_CONTENT。Task 6 输出层可据此决定最终人工修复提示，不能把模糊内容自动拆开。
- 新旧两代收藏同时存在：shelf 是活跃版，rewrite_favorites 每项存入 OLDER_FAVORITES_ARCHIVE，避免复活旧版已删除收藏。只有旧版存在时按已存 tags 数组解析；未知成员归档，不用模糊名称猜引用。
- 收藏选择内容/名称/成人/类型与现值不同，保留 legacySnapshot；超限快照进入 unresolved。角色选择分别映射 general/specific 命名空间。最近使用 ID 按收藏映射，未知 ID 保留记录。
- 两个编辑历史键完整存入 HISTORY_ARCHIVE，不伪造成 v2 撤销操作。archive 也计入 unresolved，因此该计数不是“损坏行数量”。

收据 sourceTags 是输入 custom 行数；sourceFavorites 包括活跃 shelf 行和旧一代行；linked/independent 是成功转换的收藏来源行数，合并归属也计原行。tagIdMap 包含种子 namespace:oldId 映射、ordinary 原 ID、自定义原 ID、favorite:entryId 到 Tag；favoriteIdMap 是 entryId 到 membershipId；characterIdMap 是旧角色到现有稳定角色。未解决 ID 以 unresolved.sourceId/payload 和原始备份保留，不伪造有效目标。创建时校验目标存在；之后删除引用或自定义标签不会因历史映射失效而被阻止。

## 已知边界

源指纹在最终文件创建前重新计算，但两个不同旧/新进程间没有跨格式事务锁；读后到提交仍存在极短竞争窗口。最终启动仍需既定单实例保护并关闭旧版，不能据此声称允许两版同时编辑。恢复的字节重检同样不替代单实例约束。

转换逐行完整校验及回滚优先保证保留正确性，未做海量用户迁移耗时承诺。真实 Electron 启动/恢复面板、真实用户迁移、桌面候选版和人工验证不属于本次执行证据。未解决内容的修复/导出由后续 UI/transfer 任务消费；此处只建立可审计原档和启动恢复边界。
