/*
 * integration-test.js — 端到端验收：真实 BroadcastChannel + 共享存储（模拟同源 IndexedDB）
 * 模拟 4 个标签页，验证：实时同步延迟、拖拽冲突、离线合并、刷新恢复。
 * 运行：node integration-test.js
 */
'use strict';
const { KanbanCRDT } = require('./crdt.js');
const { SyncEngine } = require('./sync.js');

const COLS = ['todo', 'doing', 'done'];
let passed = 0, failed = 0;
const assert = (cond, name, extra) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* 共享内存存储：模拟同源 IndexedDB（所有标签页读写同一份） */
function makeSharedStore() {
  const map = new Map();
  return {
    put: async (op) => { map.set(op.opId, op); },
    getAll: async () => [...map.values()],
    get size() { return map.size; },
  };
}

/* 一个“标签页” */
class Tab {
  constructor(id, store, latencies) {
    this.crdt = new KanbanCRDT(id);
    this.online = true;
    this.latencies = latencies;
    this.sync = new SyncEngine({
      crdt: this.crdt,
      store,
      channel: new BroadcastChannel('kanban-sync'),
      isOnline: () => this.online,
      onLatency: (ms) => latencies.push(ms),
    });
  }
  commit(op) { return this.sync.commit(op); }
  serialize() { return this.crdt.serialize(COLS); }
}

async function main() {
  const store = makeSharedStore();
  const latencies = [];
  const tabs = [new Tab('tab-1', store, latencies), new Tab('tab-2', store, latencies),
                new Tab('tab-3', store, latencies), new Tab('tab-4', store, latencies)];
  for (const t of tabs) await t.sync.init();

  /* --- 场景 A：4 标签页实时同步 + 延迟 < 200ms --- */
  console.log('\n[A] 4 个标签页实时同步，测量广播延迟');
  const t0 = Date.now();
  await tabs[0].commit(tabs[0].crdt.addCard('c1', '实时同步测试', '', 'todo', null, null));
  await sleep(50); // 等 BroadcastChannel 投递
  const allHave = tabs.every(t => t.serialize() === tabs[0].serialize());
  assert(allHave, '一个标签页新增卡片，其余 3 个 50ms 内一致');
  assert(latencies.length === 3, `3 个对端收到广播（实际 ${latencies.length}）`);
  const maxLat = Math.max(...latencies);
  assert(maxLat < 200, `同步延迟峰值 ${maxLat}ms < 200ms`);

  /* --- 场景 B：两个标签页同时拖同一卡片（拖拽冲突） --- */
  console.log('\n[B] 两个标签页并发拖拽同一卡片');
  await tabs[0].commit(tabs[0].crdt.addCard('c2', '任务2', '', 'todo', null, null));
  await tabs[0].commit(tabs[0].crdt.addCard('c3', '任务3', '', 'todo', null, null));
  await sleep(50);
  // 并发：tab-1 拖 c2 到 done，tab-2 同时拖 c2 到 todo 顶部
  const st = tabs[1].crdt.getState(COLS).todo;
  const op1 = tabs[0].crdt.moveCard('c2', 'done', null, null);
  const op2 = tabs[1].crdt.moveCard('c2', 'todo', null, st[0].key);
  await Promise.all([tabs[0].commit(op1), tabs[1].commit(op2)]);
  await sleep(50);
  const s0 = tabs[0].serialize();
  assert(tabs.every(t => t.serialize() === s0), '并发拖拽后 4 个标签页状态一致');
  const col = COLS.find(c => JSON.parse(s0)[c].some(k => k.id === 'c2'));
  console.log(`    → c2 最终落点：${col}（LWW 确定性裁决）`);

  /* --- 场景 C：离线操作，恢复后自动合并 --- */
  console.log('\n[C] tab-3/tab-4 离线操作，恢复后合并');
  tabs[2].online = false; tabs[3].online = false;
  await tabs[2].commit(tabs[2].crdt.editCard('c1', '实时同步测试(离线改)', 'tab-3 离线编辑'));
  await tabs[3].commit(tabs[3].crdt.addCard('c4', 'tab-4 离线新增', '', 'doing', null, null));
  await tabs[0].commit(tabs[0].crdt.moveCard('c1', 'doing', null, null)); // 在线侧继续动 c1
  await sleep(50);
  assert(tabs[2].serialize() !== tabs[0].serialize(), '离线期间状态确实分叉');
  // 恢复
  tabs[2].online = true; tabs[3].online = true;
  await tabs[2].sync.resync(); await tabs[3].sync.resync();
  await sleep(50);
  // 在线侧也做一次 resync（等价于 visibilitychange 兜底），拉取离线侧落盘的 op
  await tabs[0].sync.resync(); await tabs[1].sync.resync();
  await sleep(50);
  const fs0 = tabs[0].serialize();
  assert(tabs.every(t => t.serialize() === fs0), '恢复后 4 个标签页全部收敛');
  const final = JSON.parse(fs0);
  assert(final.doing.some(c => c.id === 'c4'), '离线新增的 c4 合并成功');
  assert(final.doing.find(c => c.id === 'c1')?.title === '实时同步测试(离线改)',
    'c1 的离线编辑与在线移动都保留（字段级合并）');

  /* --- 场景 D：刷新不丢数据（新标签页从存储重放） --- */
  console.log('\n[D] 模拟刷新：全新副本从持久层重放');
  const revived = new Tab('tab-1', store, []); // 同 clientId 重开
  await revived.sync.init();
  assert(revived.serialize() === fs0, '刷新后状态与刷新前一致，无数据丢失');
  assert(store.size > 0, `op 日志共 ${store.size} 条，全部持久化`);

  /* --- 场景 E：删除冲突（删除 vs 并发编辑） --- */
  console.log('\n[E] 删除冲突：tab-1 删除 c3，tab-2 同时编辑 c3');
  tabs[0].online = false; tabs[1].online = false;
  await tabs[0].commit(tabs[0].crdt.deleteCard('c3'));
  await tabs[1].commit(tabs[1].crdt.editCard('c3', '并发编辑', ''));
  tabs[0].online = true; tabs[1].online = true;
  await tabs[0].sync.resync(); await tabs[1].sync.resync();
  await tabs[2].sync.resync(); await tabs[3].sync.resync();
  await sleep(50);
  const es0 = tabs[0].serialize();
  assert(tabs.every(t => t.serialize() === es0), '删除冲突后 4 个标签页收敛');
  console.log(`    → c3 最终${JSON.parse(es0).todo.some(c => c.id === 'c3') ? '保留（编辑较新）' : '被删除（删除获胜）'}`);

  console.log(`\n结果：${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
