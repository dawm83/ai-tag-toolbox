# Unified tag library acceptance

| ID | Requirement | Evidence/status |
| --- | --- | --- |
| U01 | 收藏已有 Tag 后唯一标签数量不变，只新增归属 | commands/adapters及真实App收藏流程通过；539项整合检查 |
| U02 | 主页、收藏、角色特征、搜索结果调用同一编辑器，七类字段一致 | tag-editor-view与真实App统一入口通过；原生窗口待人工验收 |
| U03 | 改 Tag 内容不改变 ID，所有关联读取新内容 | commands/characters及App跨页同步通过 |
| U04 | 新建普通标签/收藏空白格均走同一创建命令，取消不写任何对象 | tag-editor/workbook取消草稿与零写入通过 |
| U05 | 收藏和移动选择器支持已有页/分组及就地新建，父子关系合法 | tag-location/editor/App位置创建与父子校验通过 |
| U06 | 未收藏/已收藏移动模式正确，多归属不随机移动 | 多归属精确移动、taxonomy保留及真实App跨列移动通过 |
| U07 | 名称/别名/备注可清空，已删除别名不会从基础数据重新出现 | schema/commands/editor显式清空与重新加载通过 |
| U08 | searchable=false 在主页、收藏和 AI 发现式搜索都不可见，浏览仍可见 | search-review/AI/translation及App发现/浏览资格通过 |
| U09 | 成人过滤覆盖浏览、搜索、角色特征和 AI 输出 | search-review/characters/App成人过滤及过期DOM复制拒绝通过 |
| U10 | 同一 Tag 全局搜索不重复，收藏徽标和定位正确 | 统一ID去重；主页收藏位置/备注/搜索标记与跨页第125项定位DOM验证通过 |
| U11 | 角色专属词进入统一存储，可编辑/收藏；默认不作为独立全局搜索结果 | seed/characters/editor验证专属词统一与默认资格；角色特征入口通过 |
| U12 | 从角色移除关联不删公共词；修改共享词更新所有关联角色 | character领域及App关系选择/取消/保存通过 |
| U13 | 角色名称/别名修改立即影响角色列表、搜索和 AI 角色查询 | characters/search/AI及App身份数据读取通过 |
| U14 | 取消收藏不删 Tag；删除有引用的 Tag 明确阻止或按明确解除流程处理 | commands引用保护与App取消收藏/默认移入未分类通过 |
| U15 | 组合原文与权重/转义/换行逐字保留，不自动拆分 | schema/selection/editor/migration/transfer及App复制原文字节通过 |
| U16 | 保存失败/重试/双击/并发修改/关闭窗口不丢数据、不重复新增 | repository/editor/真实preload关闭故障/主进程拒绝/重试通过；原生窗口待验收 |
| U17 | 迁移可重复启动且只执行一次；差异收藏、旧快照、无效记录均保留 | migration/bootstrap真实临时文件首次读取与恢复通过；实际用户迁移未执行 |
| U18 | 新旧格式导入导出、ID 冲突、取消导入、32 MiB 上限均有正确结果 | v2/v1/粘贴/共享关系/ID冲突/取消/32MiB及gzip128MiB/完整库加1万收藏往返通过 |
| U19 | 未发送结构化选择实时更新；历史请求/手改 Prompt 不被追溯改写 | selection/App按ID实时选择/组合字节通过；历史/手改Prompt保持快照 |
| U20 | 右侧旧收藏编辑器和空白快捷编辑器移除；没有残留自动保存定时器 | 旧侧栏/快捷编辑器DOM、自动保存及专用CSS已移除，工作簿与App测试通过 |
| U21 | 分类/收藏布局、分页、顺序、颜色、置顶、复制和撤销/重做继续可用 | 收藏布局/分页/批量/顺序/颜色/置顶/复制/30步撤销及新页筛选刷新回归通过 |
| U22 | UI 没有 Node/磁盘/存储直连；只有一个生产 TagLibrary 写入口 | 生产仅一个TagLibrary写入口；三旧工厂写实现删除，UI与AI护栏通过 |
| U23 | 306 项旧测试的仍有效行为保留，变更预期均注明对应新合同，新增关键行为测试通过 | 旧仍有效行为迁到真实统一库；最终592项通过，行为差异按设计合同记录 |
| U24 | 桌面 exe/源码副本/asar/版本一致，用户数据不打包；实际窗口验收状态如实记录 | 未实施 |

Electron real-window validation remains user-operated per AGENTS.md. DOM tests are not native runtime acceptance.
