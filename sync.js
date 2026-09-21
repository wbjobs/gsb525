/*
 * sync.js — 同步引擎：op 的持久化、广播、离线队列、恢复合并。
 * 浏览器 / Node 通用（依赖注入 store 与 channel，便于测试）。
 *
 * store 接口（IndexedDB 或内存实现）：put(op) / getAll() -> Promise
 * channel 接口（BroadcastChannel）：postMessage(msg) / onmessage
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  else root.KanbanSync = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class SyncEngine {
    /**
     * @param crdt      KanbanCRDT 实例
     * @param store     持久层（put/getAll）
     * @param channel   BroadcastChannel 实例
     * @param isOnline  () => boolean
     * @param onChange  状态变化回调（重新渲染）
     * @param onLatency (ms) => void 远端 op 延迟回调
     */
    constructor({ crdt, store, channel, isOnline, onChange, onLatency }) {
      this.crdt = crdt;
      this.store = store;
      this.channel = channel;
      this.isOnline = isOnline;
      this.onChange = onChange || (() => {});
      this.onLatency = onLatency || (() => {});
      this.offlineQueue = []; // 离线期间待广播的 op（已落盘）

      this.channel.onmessage = (e) => this._onMessage(e.data);
    }

    /* 启动：从持久层重放 op 日志（刷新恢复） */
    async init() {
      const ops = await this.store.getAll();
      let changed = false;
      for (const op of ops) changed = this.crdt.applyOp(op) || changed;
      if (changed) this.onChange();
      return ops.length;
    }

    /* 本地操作：应用 → 落盘 → 广播（离线入队） */
    async commit(op) {
      this.crdt.applyOp(op);
      await this.store.put(op); // 先落盘：刷新/崩溃不丢
      if (this.isOnline()) {
        this.channel.postMessage({ kind: 'op', op, sentAt: Date.now() });
      } else {
        this.offlineQueue.push(op);
      }
      this.onChange();
    }

    async _onMessage(msg) {
      if (!msg || msg.kind !== 'op') return;
      if (!this.isOnline()) return; // 离线中：忽略广播，恢复时从持久层全量合并
      this.onLatency(Date.now() - msg.sentAt); // 同源同机 wall-clock 可比
      if (this.crdt.applyOp(msg.op)) { // 幂等
        await this.store.put(msg.op);
        this.onChange();
      }
    }

    /* 恢复在线：从持久层全量合并 + 冲刷离线队列 */
    async resync() {
      const ops = await this.store.getAll();
      let changed = false;
      for (const op of ops) changed = this.crdt.applyOp(op) || changed;
      for (const op of this.offlineQueue.splice(0)) {
        this.channel.postMessage({ kind: 'op', op, sentAt: Date.now() });
      }
      if (changed) this.onChange();
    }
  }

  return { SyncEngine };
});
