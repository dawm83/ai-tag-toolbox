# 统一搜索与查询边界

当前接口以 TagLibrary 为唯一查询来源，适配器只负责显示形状和兼容调用。真实 Electron 接入仍需按整体计划验收。

V1.4.324：TagAdapter.setQuery/setCategory/setAdult 仅更新状态并返回新查询字符串/分类ID/布尔值，不再查询或返回全量标签。页面通过 page({offset,limit}) 获取显示结果；搜索语义、范围与分页上限不变。

| 入口 | 规则 |
| --- | --- |
| library.listTags / getTagIds / tagCounts | 浏览；可包含不参与搜索的条目，仍执行传入的成人与范围过滤 |
| library.search | 发现式查询；包括空白、null、undefined 查询，均排除 searchable=false |
| TagAdapter.page / CharacterAdapter.page | 空查询用于浏览；非空查询使用统一搜索 |
| CharacterAdapter.search / page({discovery:true}) | 强制发现式查询，空查询也不能绕过搜索开关 |
| FavoriteAdapter.list | 按收藏归属展示，一个标签可以在多个组出现 |
| FavoriteAdapter.search | 每个 Tag ID 只返回一项，列出全部合法 favoriteLocations；代表位置 ID 不是选择身份 |
| AI tags.search / characters.search | 只读；当前用户成人设置是上限，模型参数只能进一步缩小范围 |
| Translation | 仅匹配允许发现的单标签；目录、引用、提示词、本地与 AI 翻译路径执行相同成人上限 |

所有过滤在排序、total 和分页之前执行。标签正文、显示名和显式别名参与正常搜索；broad 还使用内置 metadataById.keywords、分类 ID、当前分类及子分类名称，支持逐词跨字段的紧凑匹配。收藏内部可以检索备注、当前页和分组名称；全局/AI 查询不使用这些私有字段。适配器的展示元数据不能另建搜索规则。

角色身份通过 CharacterLinks.identityTagId 关联。作品查询只使用当前作品 Tag 的字段及自身搜索/成人标记；两个角色共享身份词时，分别在自己的作品关系内匹配，不能把另一角色的作品合并进来。明确角色关系读取与发现式搜索分开，原专属词可随已知角色解析。

查询附带 score、matches 以及可选 characterIds/characterMatches。matches 的 start/end 是原文 UTF-16 坐标；NFKC、组合字符、下划线和空白规范化不改变存储正文。可见字段必须用文本节点生成高亮。

新增只读查询包括 library.tagCounts({includeAdult}) 和 getTagIds(options)，用于统计和分页，避免为了获取 ID/数量克隆完整正文。TagAdapter 提供 revision/searchSettings/dispose；收藏和角色适配器均提供 dispose。选择变化不重建内容索引；内容、关系、分类、收藏结构变化及 undo/redo 按实际依赖清缓存。加载前的空目录不能跨 ready 转换保留，revision 0 也不例外。

AI 标签工具只返回 items，不再返回第二份 favorites 数组。标签最多 200 项，角色最多 10 项；标签项目带稳定 id、kind、favoriteLocations 和 contentOmitted。每次标签查询的正文总预算为 16,000 字符；普通单 Tag 超过 1,000 字符或正文超过剩余预算时整项省略 content/en，禁止输出半个权重 Prompt。组合保持原文。角色工具输出明确的模型字段，排除备注、来源审计和编辑器专用对象。

模型请求的 includeAdult 不能开启已由用户关闭的成人显示；翻译兼容的 adult/nsfw 参数也不能绕过上限。没有携带用户偏好的独立翻译实例以构造时 includeAdult 为上限，请求参数仍只能缩小范围。既有用户提示词、已发送请求和历史结果不被追溯修改。

接口的内部索引 providers 可以提供只读标签、归属、角色关系、收藏结构、base metadata 和当前 taxonomy。它们不构成写入口，也不向 AI 暴露任意 ID/路径读取。导入、备份和编辑继续由统一命令与存储边界负责。
