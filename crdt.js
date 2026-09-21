/*
 * crdt.js — 看板 CRDT 核心（纯逻辑，浏览器 / Node 通用）
 *
 * 设计：
 * - 操作日志（op-based CRDT）：所有变更都是一条不可变 op，可持久化、可广播、可重放。
 * - Lamport 时钟 + clientId 构成全序时间戳 ts = [lamport, clientId]，保证所有副本对
 *   同一批 op 收敛到同一状态（确定性合并）。
 * - 卡片位置：分数索引（fractional indexing）字符串 key，列内按 (key, cardId) 排序，
 *   并发插入永不冲突且顺序确定。
 * - 冲突规则：
 *   · 拖拽冲突（两个标签页同时拖同一卡片）：位置是 LWW 寄存器，ts 大者胜 → 收敛。
 *   · 排序冲突（并发插入同一间隙）：key 相同则按 cardId 决胜 → 收敛。
 *   · 删除冲突（删除 vs 移动/编辑）：删除是墓碑，与更新做 LWW，ts 相等时删除优先。
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  else root.KanbanCRDT = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const BASE = DIGITS.length;

  /* ---------- 分数索引：在 a 与 b 之间生成新 key（a < 结果 < b） ---------- */
  function generateKeyBetween(a, b) {
    a = a || '';
    b = b || '';
    let i = 0;
    let prefix = '';
    while (true) {
      const da = i < a.length ? DIGITS.indexOf(a[i]) : 0;
      const db = i < b.length ? DIGITS.indexOf(b[i]) : BASE - 1;
      if (db - da > 1) {
        return prefix + DIGITS[Math.floor((da + db) / 2)];
      }
      prefix += DIGITS[da];
      i++;
    }
  }

  /* ---------- 时间戳比较：先 lamport，后 clientId ---------- */
  function cmpTs(a, b) {
    if (a[0] !== b[0]) return a[0] - b[0];
    return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
  }

  let opSeq = 0; // 进程内唯一后缀，避免同毫秒同客户端 opId 冲突

  class KanbanCRDT {
    constructor(clientId) {
      this.clientId = clientId;
      this.clock = 0;            // Lamport 时钟
      this.cards = new Map();    // cardId -> { id, pos:{column,key,ts}, text:{title,desc,ts}, deleted:ts|null }
      this.seen = new Set();     // 已应用的 opId（幂等）
    }

    _ts() {
      this.clock += 1;
      return [this.clock, this.clientId];
    }

    _opId() {
      return `${this.clientId}:${Date.now().toString(36)}:${(opSeq++).toString(36)}`;
    }

    /* ---------- 本地操作：生成 op（调用方负责持久化 + 广播 + applyOp） ---------- */

    addCard(cardId, title, desc, column, beforeKey, afterKey) {
      const ts = this._ts();
      return {
        opId: this._opId(), lamport: ts[0], clientId: this.clientId,
        type: 'add', cardId,
        title, desc: desc || '', column,
        key: generateKeyBetween(beforeKey, afterKey),
      };
    }

    moveCard(cardId, column, beforeKey, afterKey) {
      const ts = this._ts();
      return {
        opId: this._opId(), lamport: ts[0], clientId: this.clientId,
        type: 'move', cardId, column,
        key: generateKeyBetween(beforeKey, afterKey),
      };
    }

    editCard(cardId, title, desc) {
      const ts = this._ts();
      return {
        opId: this._opId(), lamport: ts[0], clientId: this.clientId,
        type: 'edit', cardId, title, desc: desc || '',
      };
    }

    deleteCard(cardId) {
      const ts = this._ts();
      return {
        opId: this._opId(), lamport: ts[0], clientId: this.clientId,
        type: 'delete', cardId,
      };
    }

    /* ---------- 应用 op（本地与远端同一路径，幂等） ---------- */

    applyOp(op) {
      if (this.seen.has(op.opId)) return false; // 幂等：重复投递直接忽略
      this.seen.add(op.opId);
      this.clock = Math.max(this.clock, op.lamport); // Lamport 合并

      const ts = [op.lamport, op.clientId];
      let card = this.cards.get(op.cardId);

      switch (op.type) {
        case 'add': {
          if (!card) {
            card = {
              id: op.cardId,
              pos: { column: op.column, key: op.key, ts },
              text: { title: op.title, desc: op.desc, ts },
              deleted: null,
            };
            this.cards.set(op.cardId, card);
          } else {
            // 迟到/乱序的 add：按 LWW 合并各字段
            this._mergePos(card, { column: op.column, key: op.key, ts });
            this._mergeText(card, { title: op.title, desc: op.desc, ts });
          }
          break;
        }
        case 'move': {
          if (!card) { // 卡片尚未到达（乱序）：先建占位，等 add 补齐文本
            card = { id: op.cardId, pos: null, text: null, deleted: null };
            this.cards.set(op.cardId, card);
          }
          this._mergePos(card, { column: op.column, key: op.key, ts });
          break;
        }
        case 'edit': {
          if (!card) {
            card = { id: op.cardId, pos: null, text: null, deleted: null };
            this.cards.set(op.cardId, card);
          }
          this._mergeText(card, { title: op.title, desc: op.desc, ts });
          break;
        }
        case 'delete': {
          if (!card) {
            card = { id: op.cardId, pos: null, text: null, deleted: null };
            this.cards.set(op.cardId, card);
          }
          if (!card.deleted || cmpTs(ts, card.deleted) > 0) card.deleted = ts;
          break;
        }
      }
      return true;
    }

    _mergePos(card, reg) {
      if (!card.pos || cmpTs(reg.ts, card.pos.ts) > 0) card.pos = reg;
    }

    _mergeText(card, reg) {
      if (!card.text || cmpTs(reg.ts, card.text.ts) > 0) card.text = reg;
    }

    /* ---------- 物化视图 ---------- */

    // 删除规则：墓碑存在 且 墓碑 ts >= 位置/文本 ts（并列时删除优先）
    _isDeleted(card) {
      if (!card.deleted) return false;
      const posTs = card.pos ? card.pos.ts : null;
      const textTs = card.text ? card.text.ts : null;
      const maxOther = posTs && textTs
        ? (cmpTs(posTs, textTs) > 0 ? posTs : textTs)
        : (posTs || textTs);
      if (!maxOther) return true;
      return cmpTs(card.deleted, maxOther) >= 0;
    }

    // 返回 { column: [card, ...] }，列内按 (key, cardId) 排序
    getState(columns) {
      const state = {};
      for (const col of columns) state[col] = [];
      for (const card of this.cards.values()) {
        if (this._isDeleted(card)) continue;
        if (!card.pos || !card.text) continue; // 占位卡（op 未齐），暂不渲染
        if (!state[card.pos.column]) continue;
        state[card.pos.column].push({
          id: card.id,
          title: card.text.title,
          desc: card.text.desc,
          column: card.pos.column,
          key: card.pos.key,
        });
      }
      for (const col of columns) {
        state[col].sort((a, b) =>
          a.key < b.key ? -1 : a.key > b.key ? 1 : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
        );
      }
      return state;
    }

    // 用于验收测试的确定性序列化：两个副本该值相等即收敛
    serialize(columns) {
      return JSON.stringify(this.getState(columns));
    }
  }

  return { KanbanCRDT, generateKeyBetween, cmpTs };
});
