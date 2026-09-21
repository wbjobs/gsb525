/*
 * test.js — 验收测试：模拟多标签页（多副本）并发操作，验证 CRDT 收敛。
 * 运行：node test.js
 */
'use strict';
const { KanbanCRDT, generateKeyBetween } = require('./crdt.js');

const COLS = ['todo', 'doing', 'done'];
let passed = 0, failed = 0;

function assert(cond, name, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

/* 模拟 BroadcastChannel：可断开（离线），支持乱序/重复投递 */
class Bus {
  constructor() { this.subs = []; this.online = true; this.queues = new Map(); }
  attach(replica) {
    const sub = {
      replica,
      send: (op) => {
        if (!this.online) { // 离线：进入各自待发送队列（等价于写入本地 IndexedDB）
          if (!this.queues.has(replica)) this.queues.set(replica, []);
          this.queues.get(replica).push(op);
          return;
        }
        this.deliver(replica, op);
      },
    };
    this.subs.push(sub);
    return sub;
  }
  deliver(fromReplica, op) {
    for (const s of this.subs) {
      if (s.replica === fromReplica) continue;
      s.replica.applyOp(op);
    }
  }
  reconnect() { // 恢复在线：冲刷所有离线队列（等价于恢复后广播 + 从 IndexedDB 合并）
    this.online = true;
    for (const [replica, ops] of this.queues) {
      for (const op of ops) this.deliver(replica, op);
    }
    this.queues.clear();
  }
}

function convergeCheck(replicas, name) {
  const s0 = replicas[0].serialize(COLS);
  const same = replicas.every(r => r.serialize(COLS) === s0);
  assert(same, name, same ? '' : replicas.map(r => r.serialize(COLS)).join('\nvs\n'));
  return s0;
}

/* ---------- 场景 1：两个标签页同时拖拽同一卡片（拖拽冲突） ---------- */
console.log('\n[1] 拖拽冲突：两个标签页同时拖同一卡片到不同位置');
{
  const bus = new Bus();
  const A = new KanbanCRDT('tab-A'), B = new KanbanCRDT('tab-B');
  const sA = bus.attach(A), sB = bus.attach(B);

  // 初始化：三张卡，同步到双方
  for (const [id, t] of [['c1', '任务1'], ['c2', '任务2'], ['c3', '任务3']]) {
    const op = A.addCard(id, t, '', 'todo', null, null);
    A.applyOp(op); sA.send(op);
  }
  // 断网，双方并发拖同一张卡 c2 到不同位置
  bus.online = false;
  const stA = A.getState(COLS).todo, stB = B.getState(COLS).todo;
  const opA = A.moveCard('c2', 'done', null, null);                       // A: 拖到 done 列末尾
  const opB = B.moveCard('c2', 'todo', stB[0].key, stB[1].key);           // B: 拖到 todo 列顶部
  A.applyOp(opA); B.applyOp(opB);
  // 恢复，交换 op
  sA.send(opA); sB.send(opB);
  bus.reconnect();

  const final = convergeCheck([A, B], '两副本收敛到同一状态');
  const parsed = JSON.parse(final);
  // LWW 胜者 = ts=[lamport, clientId] 较大者（与 CRDT 内部裁决规则一致）
  const { cmpTs } = require('./crdt.js');
  const winner = cmpTs([opA.lamport, opA.clientId], [opB.lamport, opB.clientId]) > 0 ? opA : opB;
  const c2col = Object.keys(parsed).find(c => parsed[c].some(k => k.id === 'c2'));
  assert(c2col === winner.column, `c2 最终位置 = LWW 胜者 (${winner.column})，实际 ${c2col}`);
}

/* ---------- 场景 2：排序冲突（并发插入同一间隙） ---------- */
console.log('\n[2] 排序冲突：两个标签页同时往同一间隙插入卡片');
{
  const bus = new Bus();
  const A = new KanbanCRDT('tab-A'), B = new KanbanCRDT('tab-B');
  const sA = bus.attach(A), sB = bus.attach(B);

  const op1 = A.addCard('c1', '任务1', '', 'todo', null, null);
  const op2 = A.addCard('c2', '任务2', '', 'todo', 'U', null);
  A.applyOp(op1); sA.send(op1); A.applyOp(op2); sA.send(op2);

  bus.online = false;
  const gap = [A.getState(COLS).todo[0].key, A.getState(COLS).todo[1].key];
  const opA = A.addCard('x', 'A插入的卡', '', 'todo', gap[0], gap[1]);
  const opB = B.addCard('y', 'B插入的卡', '', 'todo', gap[0], gap[1]);
  A.applyOp(opA); B.applyOp(opB);
  sA.send(opA); sB.send(opB);
  bus.reconnect();

  const final = JSON.parse(convergeCheck([A, B], '两副本收敛到同一状态'));
  const ids = final.todo.map(c => c.id);
  assert(ids.length === 4 && ids.includes('x') && ids.includes('y'), '两张并发插入的卡都保留');
  assert(ids.indexOf('c1') < ids.indexOf('x') && ids.indexOf('c2') > ids.indexOf('y'), '并发卡都落在 c1 与 c2 之间');
}

/* ---------- 场景 3：删除冲突（删除 vs 并发移动/编辑） ---------- */
console.log('\n[3] 删除冲突：一个标签页删除，另一个同时移动/编辑');
{
  const bus = new Bus();
  const A = new KanbanCRDT('tab-A'), B = new KanbanCRDT('tab-B');
  const sA = bus.attach(A), sB = bus.attach(B);
  const op = A.addCard('c1', '任务1', '', 'todo', null, null);
  A.applyOp(op); sA.send(op);

  bus.online = false;
  const opDel = A.deleteCard('c1');
  const opMove = B.moveCard('c1', 'done', null, null);
  const opEdit = B.editCard('c1', '被并发编辑', '');
  A.applyOp(opDel); B.applyOp(opMove); B.applyOp(opEdit);
  sA.send(opDel); sB.send(opMove); sB.send(opEdit);
  bus.reconnect();

  const final = JSON.parse(convergeCheck([A, B], '两副本收敛到同一状态'));
  const visible = Object.values(final).flat().some(c => c.id === 'c1');
  // 规则：删除与更新做 LWW，并列删除优先。此处删除 lamport=2，move/edit lamport=2/3(B端)
  // 无论谁胜，关键是两副本一致；同时验证规则确定性：
  const delTs = [opDel.lamport, opDel.clientId];
  const maxUpd = [Math.max(opMove.lamport, opEdit.lamport), opEdit.clientId];
  const expectDeleted = JSON.stringify(delTs) >= JSON.stringify(maxUpd) ||
    (delTs[0] === maxUpd[0]);
  assert(visible === !expectDeleted, `删除冲突按确定性规则裁决（删除${expectDeleted ? '胜' : '负'}）`);
}

/* ---------- 场景 4：离线合并（离线操作恢复后正确合并） ---------- */
console.log('\n[4] 离线合并：4 个标签页，2 个离线操作，恢复后全部收敛');
{
  const bus = new Bus();
  const tabs = [new KanbanCRDT('tab-1'), new KanbanCRDT('tab-2'),
                new KanbanCRDT('tab-3'), new KanbanCRDT('tab-4')];
  const subs = tabs.map(t => bus.attach(t));

  // 在线阶段：tab-1 建三张卡
  ['c1', 'c2', 'c3'].forEach((id, i) => {
    const op = tabs[0].addCard(id, `任务${i + 1}`, '', 'todo', i ? tabs[0].getState(COLS).todo[i - 1].key : null, null);
    tabs[0].applyOp(op); subs[0].send(op);
  });

  // 全部离线：各标签页独立操作
  bus.online = false;
  const local = (t, op) => { t.applyOp(op); subs[tabs.indexOf(t)].send(op); };
  const st1 = tabs[0].getState(COLS).todo;
  local(tabs[0], tabs[0].moveCard('c1', 'doing', null, null));            // tab1: c1 → doing
  local(tabs[1], tabs[1].editCard('c2', '任务2-改', '离线编辑'));          // tab2: 编辑 c2
  local(tabs[2], tabs[2].deleteCard('c3'));                                // tab3: 删除 c3
  local(tabs[3], tabs[3].addCard('c4', '离线新增', '', 'done', null, null)); // tab4: 新增到 done

  bus.reconnect(); // 恢复：冲刷离线队列

  const final = JSON.parse(convergeCheck(tabs, '4 个标签页全部收敛'));
  assert(final.doing.some(c => c.id === 'c1'), 'c1 在 doing 列');
  assert(final.todo.find(c => c.id === 'c2')?.title === '任务2-改', 'c2 离线编辑生效');
  assert(!Object.values(final).flat().some(c => c.id === 'c3'), 'c3 被删除');
  assert(final.done.some(c => c.id === 'c4'), 'c4 离线新增生效');
}

/* ---------- 场景 5：刷新不丢数据（op 日志重放 = 实时状态） ---------- */
console.log('\n[5] 持久化：从 op 日志重放恢复的状态与实时状态一致（模拟刷新）');
{
  const bus = new Bus();
  const A = new KanbanCRDT('tab-A'), B = new KanbanCRDT('tab-B');
  const sA = bus.attach(A), sB = bus.attach(B);
  const log = []; // 模拟 IndexedDB op 日志
  const run = (t, s, op) => { t.applyOp(op); log.push(op); s.send(op); };

  run(A, sA, A.addCard('c1', '任务1', '描述1', 'todo', null, null));
  run(A, sA, A.addCard('c2', '任务2', '', 'todo', 'U', null));
  run(B, sB, B.moveCard('c1', 'done', null, null));
  run(B, sB, B.editCard('c2', '任务2*', ''));
  run(A, sA, A.deleteCard('c2'));

  const R = new KanbanCRDT('tab-restore'); // 模拟刷新后从 IndexedDB 重放
  for (const op of log) R.applyOp(op);
  assert(R.serialize(COLS) === A.serialize(COLS), '重放恢复状态 == 实时状态');
  assert(R.serialize(COLS) === B.serialize(COLS), '重放恢复状态 == 对端状态');
}

/* ---------- 场景 6：乱序 + 重复投递仍收敛（幂等） ---------- */
console.log('\n[6] 健壮性：op 乱序、重复投递后仍收敛');
{
  const A = new KanbanCRDT('tab-A'), B = new KanbanCRDT('tab-B');
  const ops = [];
  const mk = (t, op) => { t.applyOp(op); ops.push(op); };
  mk(A, A.addCard('c1', '任务1', '', 'todo', null, null));
  mk(A, A.addCard('c2', '任务2', '', 'todo', 'U', null));
  mk(A, A.moveCard('c1', 'doing', null, null));
  mk(A, A.editCard('c1', '任务1+', ''));
  mk(A, A.deleteCard('c2'));
  const shuffled = [...ops].sort(() => Math.random() - 0.5);
  for (const op of [...shuffled, ...shuffled]) B.applyOp(op); // 乱序 + 全部重复一遍
  assert(B.serialize(COLS) === A.serialize(COLS), '乱序+重复投递后收敛');
}

/* ---------- 场景 7：分数索引压测（连续插入 500 次不出错、有序） ---------- */
console.log('\n[7] 分数索引：500 次头部/尾部/中间插入保持全序');
{
  const keys = [];
  for (let i = 0; i < 200; i++) keys.push(generateKeyBetween(keys[keys.length - 1] || '', '')); // 尾部
  const head = [];
  for (let i = 0; i < 200; i++) head.unshift(generateKeyBetween('', head[0] || '')); // 头部
  let ok = true;
  for (let i = 1; i < keys.length; i++) if (keys[i - 1] >= keys[i]) ok = false;
  for (let i = 1; i < head.length; i++) if (head[i - 1] >= head[i]) ok = false;
  let mid = [generateKeyBetween('', '')];
  for (let i = 0; i < 100; i++) {
    const k = generateKeyBetween(mid[0], mid[1] || '');
    mid.splice(1, 0, k);
  }
  for (let i = 1; i < mid.length; i++) if (mid[i - 1] >= mid[i]) ok = false;
  assert(ok, '所有插入保持严格全序');
}

console.log(`\n结果：${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
