# CRDT 协同看板

支持 4+ 标签页实时同步的看板：卡片拖拽排序、跨列移动、编辑、删除；离线可用，恢复后自动合并。

## 运行

```bash
npm start          # 或任意静态服务器，如 npx serve
# 打开 http://localhost:8000 ，多开几个标签页即可协同
```

> 需要 http(s) 源（BroadcastChannel / IndexedDB 在 file:// 下受限）。

## 测试

```bash
npm test
# test.js             CRDT 核心：7 类冲突/合并场景，16 项断言
# integration-test.js 端到端：真实 BroadcastChannel + 共享存储模拟 4 标签页，11 项断言
```

## 架构

| 文件 | 职责 |
|---|---|
| `crdt.js` | CRDT 核心：op 日志 + Lamport 时钟 + 分数索引，浏览器/Node 通用 |
| `sync.js` | 同步引擎：op 持久化、广播、离线队列、恢复合并（依赖注入，可测） |
| `app.js` | UI、Pointer Events 拖拽、IndexedDB 适配、在线状态 |
| `index.html` | 页面与样式 |

## 冲突处理（CRDT 设计）

- **数据模型**：op-based CRDT。每个操作是一条不可变 op，带 `ts = [lamport, clientId]` 全序时间戳，先写 IndexedDB 再广播——刷新/崩溃不丢数据。
- **拖拽冲突**（两标签页同时拖同一卡片）：卡片位置是 LWW 寄存器，ts 大者胜，所有副本确定性收敛到同一结果。
- **排序冲突**（并发插入同一间隙）：分数索引字符串 key，列内按 `(key, cardId)` 排序，并发插入永不冲突、顺序确定。
- **删除冲突**（删除 vs 并发移动/编辑）：删除是墓碑，与更新做 LWW，ts 并列时删除优先；字段级合并（移动与编辑互不覆盖）。
- **离线合并**：离线期间 op 照常写入 IndexedDB 并进入待广播队列；恢复在线时冲刷队列 + 从 IndexedDB 全量幂等合并（`visibilitychange` 也有兜底合并）。

## 验收标准对照

| 标准 | 验证 |
|---|---|
| 两标签页拖同一卡片最终一致 | `test.js` 场景 1、`integration-test.js` 场景 B |
| 离线操作恢复后合并正确 | `test.js` 场景 4、`integration-test.js` 场景 C |
| 4 标签页同步延迟 < 200ms | `integration-test.js` 场景 A（实测峰值 16ms），UI 顶栏实时显示延迟 |
| 刷新不丢数据 | `test.js` 场景 5、`integration-test.js` 场景 D（op 先落盘后广播） |
