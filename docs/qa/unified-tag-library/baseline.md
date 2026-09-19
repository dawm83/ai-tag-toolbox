# 统一标签改造基线

日期：2026-09-19。基线 V1.4.316，commit ba40769。工作分支 codex/unified-tag-library。

- 原目录 npm run check：exit 0，306 tests passed，regressions-v194 ok。日志 work/unified-tags/P0/check.log。
- 恢复副本 npm run check：exit 0，306 tests passed，regressions-v194 ok。日志 work/unified-tags/P0/restore-check.log。恢复副本从祖先目录复用本地 node_modules，未声称重新安装依赖。
- 文件检查点 work/unified-tags/P0/source/ 共197文件，逐文件SHA-256见同级 manifest.json。src 位于一层项目根，未嵌套。
- 旧桌面 C:/Users/admin/Desktop/AI绘画Tag工具箱V1.4.316/；asar SHA-256：8240ecdfe4d5e41729330b0f802d198a0d42955bf8d6c3baf05188dc6f80b2a8。
- 保留未跟踪 %SystemDrive%/。未读取真实AppData收藏/会话/Key；不运行Electron。

## 有意替代的旧行为

独立收藏正文改为共享Tag引用；收藏内部搜索也遵从searchable；收藏侧栏自动保存改成统一弹窗显式保存；新结构化选择实时引用，旧不一致快照由迁移保留。所有迁移测试用夹具。

## 恢复

复制P0/source内容到新目录并使用本机依赖运行check，不reset当前工作区；必要时按Git明确版本另检出。旧AppData不动，新库失败不覆盖旧键。
