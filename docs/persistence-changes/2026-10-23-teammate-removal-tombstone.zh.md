---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-23-teammate-removal-tombstone

[English](2026-10-23-teammate-removal-tombstone.md) | 中文

## 概述

team/member 事件的 member.phase 联合类型在保持载荷版本 2 不变的前提下新增 "removed" 变体。Team Lead 现在可以移除一名已定型的队友：先排空其活跃子会话，再向 Lead 日志追加墓碑行；该行继续保留其名称，不再计入成员上限，并从名册与投影视图中消失。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-23-teammate-removal-tombstone
baseline: false
changes:
  - root: "event:team/member"
    previous: "2026-09-11-initial"
    after: "557da760280933209dbef3953b195b89443b5d0c51cc8e0739f62d0f9d587a87"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

新读取方读取旧日志的行为不变：provisioning、active 与 failed 仍然有效，投影转移规则继续接受全部历史序列。旧读取方从未写入过 "removed"；当旧读取方打开带有墓碑的日志时，agent-team 投影会严格校验 phase 枚举，在 failure 字段中报告首个无效记录，并让 members 与 tasks 停留在最后一个有效状态，不会修改、恢复或截断日志，从而在执行前以受控方式拒绝不受支持的必需值。事件版本保持 2，因为该载荷是整体快照备选，唯一变化就是这个加宽的枚举；客户端投影缓存版本的提升只会重新推导缓存的线格式视图，不改变持久事件契约。

<a id="verification"></a>
## 验证

pnpm run gen-persistence-catalog 重新生成了 docs/persistence-schema.json 与清单；pnpm run persistence-changes -- --check 接受已记录的历史。packages/experimental/agent-team 中的 Vitest 覆盖端到端演练了 removed 边：移除以版本 2 的 team/member 事件提交墓碑，投影接受 active/failed 到 removed 并从线视图过滤墓碑，名称保持保留，成员上限名额被释放。无密钥快照回放套件在不含墓碑的已提交代上仍然通过。

<a id="dev-note"></a>
## 开发备注

无。
