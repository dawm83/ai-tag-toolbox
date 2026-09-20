# 标签库备份、迁移与批量整理

收藏页的导出菜单提供两种范围。**导出全库**包含全部当前有效标签、分类、收藏页和组、收藏归属及角色关系；**导出收藏**只包含被收藏的标签及必要的位置定义，不包含无关角色。共享标签在备份中只有一份内容，在两个收藏组出现时保留两个引用。

普通备份下载为紧凑的 `.json`。完整词库加用户收藏可能超过 32 MiB，因此超出普通文件预算时自动使用 `.json.gz`；gzip 只改变传输压缩方式，内部仍为 `ai-tag-library` v2 JSON。不要将完整备份重新格式化为缩进 JSON 后再导入，因为格式化会显著增加体积。导入文件上限为 32 MiB，gzip 展开上限为 128 MiB。超过两项预算的导出会明确失败，不产生不能导回的备份。

导入支持 v2 JSON/gzip、旧 `ai-tag-favorites` v1 JSON/gzip，以及逐行或 TSV 粘贴。TSV 的引号字段可包含换行；权重和多行组合保持原文。旧格式统一采用首次迁移的转换规则。导入始终先显示预览，确认后一次保存。取消不写库；预览后发生其他保存需要重新预览。保存失败可直接重试，同一成功操作不会重复添加。一个库同时只保留一个预览，十五分钟后过期。

相同外部 ID 且所有可编辑内容相同会复用已有标签。内容、名称、别名、备注、成人标记、搜索标记或分类不同，会保留为独立标签并提示，不覆盖本地。不同 ID 不因文字相同而自动合并。位置名称和排序冲突会保留内容并提示映射结果。没有安装的角色不会被备份凭空创建，关系原记录和映射结果会进入迁移报告。已修改的本地角色关系也会保留；在同一基础库的干净目标中，可以恢复备份的角色关系修改。

迁移报告分别显示已关联收藏、独立保留、已保留档案、保留说明和需处理记录。旧编辑历史、旧一代收藏以及旧角色的非权威资料是档案，不等于损坏数据。独立收藏转换、组合转换和重复归属合并属于保留说明。模糊原文和未知原因属于需处理。报告导出为独立 `ai-tag-migration-report` v1 JSON/gzip，包含原始收据和全部保留记录；这份报告不作为可执行库备份导入。

批量整理的复选框独立于 Prompt 选择。选择全部匹配结果会冻结所有结果页的收藏归属 ID；之后改变搜索词不会偷偷更换该批目标。可复制引用、另存独立、移动、取消收藏、切换搜索与成人标记、置顶、修改所在页颜色，并使用统一撤销/重做。发生库版本冲突时清空并重新选择。每次批量提交是一项原子操作，失败不保留部分结果；最近最多保留三十项可撤销操作。

## 宿主接口

- `library.exportBundle({scope})` 返回 `LibraryBundle`；纯实现为 `projectLibraryBundle({base,document,scope})`。
- `library.previewImport(bundle)` 返回 `Result<ImportPreview>`；纯实现为 `prepareImportCandidate({base,document,bundle,ids,now})`。`execute({type:'applyImport',previewId},{operationId,expectedRevision?})` 是唯一提交入口。
- `exportLibrary`、`previewLibraryImport`、`applyLibraryImport` 只是上述方法的无状态便捷函数。
- `library.exportFile({scope})` 返回 `Result<{bytes:Uint8Array,filename,mimeType}>`。`previewImportFile(bytesOrText)` 在解析前执行文件预算检查，支持 UTF-8 文本、ArrayBuffer 和字节视图；不接受路径。
- `previewPaste(text,{format:'lines'|'tsv',kind:'tag'|'bundle',seriesId,sectionId})` 需要已有目标收藏页和组。`cancelImportPreview(id)` 丢弃该实例的候选，无通知或历史操作。
- `ImportPreview` 为 `{id,basedOnRevision,counts:{added,reused,conflicts,invalid},warnings,details}`。前三项计数按标签，invalid 为旧格式中保留的需处理记录；档案不算无效。`details` 包含 `membershipsAdded/membershipsReused/pagesAdded/groupsAdded/relationsApplied/relationsPreserved`。警告最多四十条，额外警告合并计数。
- `getMigrationReport({offset?,limit?})` 返回分类计数、原因数量和分页记录描述，不返回原 payload；`exportMigrationReport()` 返回完整报告对象，`exportMigrationFile()` 返回受限文件字节。
- 收藏适配器 `importBundle(previewId,executeOptions)` 和 `importPaste(previewId,executeOptions)` 只提交预览 ID，不重新解析或逐行写入。文件、报告、取消接口通过显式 catalog/preload 白名单提供。

备份输入不会执行脚本；导入和报告接口不接受磁盘路径。上述自动测试只证明领域层和 DOM 流程，实际桌面窗口下载、输入法和读屏体验仍需候选版人工验收。
