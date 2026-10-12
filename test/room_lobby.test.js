/* Lobby features of the online Room authority: bot seats, seat-order shuffle,
 * host identity that survives reordering, server-driven AI turns.
 * run: node test/room_lobby.test.js */
const assert = require('assert');
const { Room } = require('../js/room.js');
const E = require('../js/engine.js');
const AI = require('../js/ai.js');
const DB = require('../data/cards.json');
const MEGA = require('../data/megas.json');
const PM = require('../data/pokemart.json');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + (e.stack || e.message)); }
}
function makeRoom(extra) {
  const inbox = {};
  const room = new Room(Object.assign({ cardDB: DB, megaDB: MEGA, pokemartDB: PM, maxSeats: 4, ai: AI,
    send: (cid, msg) => { (inbox[cid] = inbox[cid] || []).push(msg); } }, extra || {}));
  const last = (cid, t) => { const a = (inbox[cid] || []).filter(m => m.t === t); return a[a.length - 1]; };
  const all = (cid, t) => (inbox[cid] || []).filter(m => m.t === t);
  const clear = () => { for (const k in inbox) inbox[k] = []; };
  return { room, inbox, last, all, clear };
}
const seatOfToken = (room, token) => room.seats.findIndex(s => s.token === token);
const SUPPLY_PER = { 2: 4, 3: 5, 4: 7 };
function assertConserved(g) {
  for (const c of E.COLORS) {
    let tot = g.supply[c]; g.players.forEach(p => { tot += p.tokens[c]; });
    assert.strictEqual(tot, SUPPLY_PER[g.numPlayers], '球守恒失败 ' + c);
  }
}

// ---------------------------------------------------------------- bot seats
test('addAI: 仅房主、仅大厅、最多 4 座；默认难度 normal；名字不重复；在名单里标记为电脑且始终在线', () => {
  const { room, last } = makeRoom();
  room.onMessage('cA', { t: 'join', name: '小明', token: 'tA' });
  room.onMessage('cB', { t: 'join', name: '阿强', token: 'tB' });
  room.onMessage('cB', { t: 'addAI' });
  assert.ok(/只有房主/.test(last('cB', 'reject').reason), '非房主不能加电脑');
  room.onMessage('cA', { t: 'addAI' });
  room.onMessage('cA', { t: 'addAI', level: 'hard' });
  const r = last('cA', 'roster');
  assert.strictEqual(r.players.length, 4);
  assert.strictEqual(r.players[2].ai, 'normal', '未指定难度 → normal');
  assert.strictEqual(r.players[3].ai, 'hard');
  assert.strictEqual(r.players[2].connected, true, '电脑始终在线');
  assert.notStrictEqual(r.players[2].name, r.players[3].name, '电脑名字不重复');
  assert.strictEqual(r.maxSeats, 4);
  room.onMessage('cA', { t: 'addAI' });
  assert.ok(/座位已满/.test(last('cA', 'reject').reason), '满 4 座后不能再加');
  room.onMessage('cA', { t: 'addAI', level: 'godlike' });
  assert.strictEqual(room.seats.length, 4, '非法难度也不会多开座位');
});

test('addAI / removeAI / aiLevel / shuffle：开局后一律拒绝', () => {
  const { room, last } = makeRoom();
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cA', { t: 'addAI' });
  room.onMessage('cA', { t: 'start', opts: {} });
  for (const m of [{ t: 'addAI' }, { t: 'removeAI', seat: 1 }, { t: 'aiLevel', seat: 1, level: 'hard' }, { t: 'shuffle' }]) {
    room.onMessage('cA', m);
    assert.ok(/对局进行中/.test(last('cA', 'reject').reason), m.t + ' 开局后应被拒绝');
  }
  assert.strictEqual(room.seats.length, 2);
});

test('aiLevel: 改电脑难度；不能对真人座位改；非法难度拒绝', () => {
  const { room, last } = makeRoom();
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cA', { t: 'addAI', level: 'easy' });
  room.onMessage('cA', { t: 'aiLevel', seat: 1, level: 'hard' });
  assert.strictEqual(last('cA', 'roster').players[1].ai, 'hard');
  room.onMessage('cA', { t: 'aiLevel', seat: 0, level: 'hard' });
  assert.ok(/不是电脑/.test(last('cA', 'reject').reason), '真人座位不能改难度');
  room.onMessage('cA', { t: 'aiLevel', seat: 1, level: 'ultra' });
  assert.ok(/未知的电脑难度/.test(last('cA', 'reject').reason));
});

test('removeAI: 移除后后面的真人座位前移，且该真人收到新的 welcome 座位号，开局后能正常行动', () => {
  const { room, last, clear } = makeRoom();
  room.onMessage('cA', { t: 'join', token: 'tA' });   // seat 0 host
  room.onMessage('cA', { t: 'addAI' });                // seat 1 bot
  room.onMessage('cB', { t: 'join', token: 'tB' });   // seat 2 human
  assert.strictEqual(last('cB', 'welcome').seat, 2);
  clear();
  room.onMessage('cA', { t: 'removeAI', seat: 0 });
  assert.ok(/不是电脑/.test(last('cA', 'reject').reason), '不能用 removeAI 踢真人');
  room.onMessage('cA', { t: 'removeAI', seat: 1 });
  assert.strictEqual(room.seats.length, 2);
  assert.strictEqual(last('cB', 'welcome').seat, 1, 'B 的座位号变了必须重新告知');
  assert.strictEqual(room.conns.cB, 1);
  room.onMessage('cA', { t: 'start', opts: {} });
  room.onMessage('cA', { t: 'action', action: { type: 'take', colors: ['red', 'blue', 'black'] } });
  room.onMessage('cA', { t: 'action', action: { type: 'endTurn' } });
  room.onMessage('cB', { t: 'action', action: { type: 'take', colors: ['red', 'blue', 'black'] } });
  assert.strictEqual(room.G.players[1].tokens.red, 1, 'B 以新座位号 1 行动成功');
});

test('真人加入已满（含电脑）的房间：顶替最后一个电脑，不会被挡在门外', () => {
  const { room, last } = makeRoom();
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cA', { t: 'addAI', level: 'easy' });
  room.onMessage('cA', { t: 'addAI', level: 'normal' });
  room.onMessage('cA', { t: 'addAI', level: 'hard' });
  room.onMessage('cB', { t: 'join', name: '阿强', token: 'tB' });
  assert.strictEqual(last('cB', 'welcome').seat, 3, '顶替最后一个电脑座位');
  const r = last('cA', 'roster');
  assert.strictEqual(r.players.length, 4, '总人数不变');
  assert.strictEqual(r.players.filter(p => p.ai).length, 2, '只替换了一个电脑');
  assert.strictEqual(r.players[3].name, '阿强');
  assert.strictEqual(r.players[3].ai, null);
  const n = last('cA', 'notice');
  assert.ok(n && /阿强/.test(n.msg) && /电脑3/.test(n.msg), '全房间收到「谁顶替了哪个电脑」的提示：' + (n && n.msg));
  assert.ok(last('cB', 'notice'), '加入者自己也看得到');
});

test('房间满员且全是真人：后来者只能观战（不会误伤）', () => {
  const { room, last } = makeRoom({ maxSeats: 2 });
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cB', { t: 'join', token: 'tB' });
  room.onMessage('cC', { t: 'join', token: 'tC' });
  assert.strictEqual(last('cC', 'welcome').seat, -1);
  assert.strictEqual(last('cA', 'notice'), undefined, '普通加入不发替换提示');
});

// ---------------------------------------------------------------- host identity
test('房主身份跟着 token 走：换座后房主不在 0 号位也还是房主；坐到 0 号位的人不会变房主', () => {
  const { room, last } = makeRoom();
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cB', { t: 'join', token: 'tB' });
  let tries = 0;
  while (seatOfToken(room, 'tA') === 0 && tries++ < 200) room.onMessage('cA', { t: 'shuffle' });
  assert.notStrictEqual(seatOfToken(room, 'tA'), 0, '前提：房主已不在 0 号位');
  assert.strictEqual(last('cA', 'welcome').host, true, '房主收到的 welcome 仍标记 host');
  assert.strictEqual(last('cB', 'welcome').host, false);
  assert.strictEqual(last('cA', 'roster').hostSeat, seatOfToken(room, 'tA'), 'roster.hostSeat 指向房主当前座位');
  room.onMessage('cB', { t: 'start', opts: {} });
  assert.ok(/只有房主/.test(last('cB', 'reject').reason), '坐在 0 号位的非房主不能开局');
  room.onMessage('cA', { t: 'start', opts: {} });
  assert.ok(room.started, '不在 0 号位的房主可以开局');
});

test('房主离线后身份不丢；旧版快照（无 hostToken）恢复时房主=原 0 号位', () => {
  const { room } = makeRoom();
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cB', { t: 'join', token: 'tB' });
  room.leave('cA');
  room.onMessage('cA2', { t: 'join', token: 'tA' });
  assert.ok(room._isHost('cA2'), '重连回来的房主仍是房主');

  const inbox = {};
  const legacy = new Room({ cardDB: DB, send: (c, m) => { (inbox[c] = inbox[c] || []).push(m); } });
  legacy.restore({ seq: 3, started: false, turnStartedAt: 0, g: null,
    seats: [{ token: 'tA', name: 'A' }, { token: 'tB', name: 'B' }] });
  legacy.onMessage('xA', { t: 'join', token: 'tA' });
  legacy.onMessage('xB', { t: 'join', token: 'tB' });
  assert.strictEqual(inbox.xA.filter(m => m.t === 'welcome').pop().host, true);
  assert.strictEqual(inbox.xB.filter(m => m.t === 'welcome').pop().host, false);
});

// ---------------------------------------------------------------- shuffle
test('shuffle: 仅房主；每次向全员广播（含第几次与先手是谁），座位号变化的人都会收到新 welcome', () => {
  const { room, last, all, clear } = makeRoom();
  room.onMessage('cA', { t: 'join', name: '小明', token: 'tA' });
  room.onMessage('cB', { t: 'join', name: '阿强', token: 'tB' });
  room.onMessage('cA', { t: 'addAI' });
  room.onMessage('cB', { t: 'shuffle' });
  assert.ok(/只有房主/.test(last('cB', 'reject').reason));
  let changed = 0;
  for (let k = 1; k <= 5 || (!changed && k <= 60); k++) {
    clear();
    const before = { cA: room.conns.cA, cB: room.conns.cB };
    room.onMessage('cA', { t: 'shuffle' });
    const s = last('cB', 'shuffled');
    assert.ok(s, '非房主也能看到随机结果');
    assert.strictEqual(s.count, k, '重随次数对全员可见');
    assert.strictEqual(s.first, room.seats[0].name, '播报的先手就是当前 0 号位');
    // 每个连接自认为的座位号必须与服务器一致；座位号变了的人必须收到新 welcome
    for (const [cid, tok] of [['cA', 'tA'], ['cB', 'tB']]) {
      assert.strictEqual(room.conns[cid], seatOfToken(room, tok), cid + ' 连接映射正确');
      const w = all(cid, 'welcome').pop();
      if (room.conns[cid] !== before[cid]) { changed++; assert.ok(w, cid + ' 座位号变了却没收到新 welcome'); }
      else assert.strictEqual(w, undefined, cid + ' 座位号没变，不应重发 welcome');
      if (w) assert.strictEqual(w.seat, seatOfToken(room, tok), cid + ' welcome 座位号正确');
    }
  }
  assert.ok(changed > 0, '至少发生过一次座位变化（否则上面的 welcome 检查没被触发）');
  assert.strictEqual(room.seats.length, 3, '随机不增减座位');
});

test('shuffle: 均匀随机（每次都从同一初始顺序做一次随机；3 座 6 种排列各约 1/6，能抓出常见的偏置写法）', () => {
  // 注意：不能在同一个房间里连续随机再统计 —— 任何「双随机」的偏置写法连乘下去，
  // 稳态分布照样是均匀的，测试会形同虚设。必须每次从固定初始顺序出发只随机一次。
  const N = 24000, counts = {};
  for (let i = 0; i < N; i++) {
    const room = new Room({ cardDB: DB, send: () => { } });
    room.onMessage('cA', { t: 'join', token: 'tA' });
    room.onMessage('cB', { t: 'join', token: 'tB' });
    room.onMessage('cC', { t: 'join', token: 'tC' });
    room.onMessage('cA', { t: 'shuffle' });
    const key = room.seats.map(s => s.token).join(',');
    counts[key] = (counts[key] || 0) + 1;
  }
  const keys = Object.keys(counts);
  assert.strictEqual(keys.length, 6, '6 种排列都应出现');
  // 期望 4000、标准差约 58；±300 ≈ 5.2σ，正确实现几乎不会误报。
  // 常见错误写法（每一步都在全范围里选 j）会让部分排列落到约 3556 / 2667，一定超界。
  for (const k of keys) assert.ok(Math.abs(counts[k] - N / 6) < 300, '排列 ' + k + ' 出现 ' + counts[k] + ' 次，偏离 1/6 过多');
});

test('shuffle 后开局：先后手真的按新座位顺序进行（0 号位先走）', () => {
  const { room } = makeRoom();
  room.onMessage('cA', { t: 'join', name: '小明', token: 'tA' });
  room.onMessage('cB', { t: 'join', name: '阿强', token: 'tB' });
  let tries = 0;
  while (seatOfToken(room, 'tB') !== 0 && tries++ < 200) room.onMessage('cA', { t: 'shuffle' });
  assert.strictEqual(seatOfToken(room, 'tB'), 0, '前提：阿强被随机到 0 号位');
  room.onMessage('cA', { t: 'start', opts: {} });
  assert.strictEqual(room.G.turn, 0);
  assert.strictEqual(room.G.players[0].name, '阿强', '游戏内 0 号玩家就是阿强');
  room.onMessage('cA', { t: 'action', action: { type: 'take', colors: ['red', 'blue', 'black'] } });
  assert.ok(!room.G.players.some(p => p.tokens.red), '不是小明的回合，小明不能先走');
  room.onMessage('cB', { t: 'action', action: { type: 'take', colors: ['red', 'blue', 'black'] } });
  assert.strictEqual(room.G.players[0].tokens.red, 1, '阿强先走成功');
});

// ---------------------------------------------------------------- server-driven AI turns
test('开局：电脑座位在游戏里标记为 isAI 且带难度；真人不能替电脑行动；代打不能针对电脑', () => {
  const { room, last } = makeRoom();
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cA', { t: 'addAI', level: 'hard' });
  room.onMessage('cA', { t: 'start', opts: {} });
  assert.strictEqual(room.G.players[0].isAI, false);
  assert.strictEqual(room.G.players[1].isAI, true);
  assert.strictEqual(room.G.players[1].diff, 'hard');
  assert.strictEqual(last('cA', 'state').state.players[1].isAI, true, '客户端能知道谁是电脑');
  room.onMessage('cA', { t: 'action', action: { type: 'take', colors: ['red', 'blue', 'black'] } });
  room.onMessage('cA', { t: 'action', action: { type: 'endTurn' } });
  assert.ok(room.aiPending(), '轮到电脑');
  room.onMessage('cA', { t: 'action', action: { type: 'take', colors: ['red', 'blue', 'pink'] } });
  assert.ok(last('cA', 'reject'), '真人不能替电脑行动');
  room.now = 10 * 60 * 1000;
  room.onMessage('cA', { t: 'takeover', plan: { action: { type: 'take', colors: ['red', 'blue', 'pink'] } } });
  assert.ok(/电脑的回合由服务器执行/.test(last('cA', 'reject').reason), '不能对电脑回合提交代打计划');
  assert.ok(room.aiPending(), '电脑回合未被外部推进');
});

test('stepAI: 只在电脑回合生效；执行完整一回合并广播给所有人', () => {
  const { room, last, clear } = makeRoom();
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cA', { t: 'addAI' });
  room.onMessage('cA', { t: 'start', opts: {} });
  assert.strictEqual(room.stepAI(), false, '真人回合 stepAI 不做任何事');
  room.onMessage('cA', { t: 'action', action: { type: 'take', colors: ['red', 'blue', 'black'] } });
  room.onMessage('cA', { t: 'action', action: { type: 'endTurn' } });
  clear();
  room.now = 5000;
  assert.strictEqual(room.stepAI(), true);
  assert.strictEqual(room.G.turn, 0, '电脑走完交回真人');
  assert.ok(last('cA', 'state'), '真人收到电脑走完后的状态');
  assert.strictEqual(room.turnStartedAt, 5000, '空闲计时从电脑走完那一刻重新开始');
  assertConserved(room.G);
});

test('stepAI: 没注入 AI 模块或 AI 抛错时也绝不卡住（退化为合法走法）', () => {
  for (const ai of [null, { chooseTurn() { throw new Error('boom'); } }, { chooseTurn() { return { action: { type: 'capture', cardId: 'nope' } }; } }]) {
    const { room } = makeRoom({ ai });
    room.onMessage('cA', { t: 'join', token: 'tA' });
    room.onMessage('cA', { t: 'addAI' });
    room.onMessage('cA', { t: 'start', opts: {} });
    room.onMessage('cA', { t: 'action', action: { type: 'take', colors: ['red', 'blue', 'black'] } });
    room.onMessage('cA', { t: 'action', action: { type: 'endTurn' } });
    assert.ok(room.stepAI());
    assert.strictEqual(room.G.turn, 0, '仍然推进到真人回合');
    assertConserved(room.G);
  }
});

function playOut(room, humanConns, guardMax) {
  let guard = 0;
  while (room.G.phase === 'play' && guard++ < (guardMax || 3000)) {
    if (room.aiPending()) { room.stepAI(); continue; }
    const seat = room.G.turn;
    const cid = humanConns[seat];
    const plan = AI.chooseTurn(E.clone(room.G), { difficulty: 'easy' });
    room.onMessage(cid, { t: 'action', action: plan.action || { type: 'pass' } });
    const p = room.G.players[seat];
    let d = 0;
    while (E.needsDiscard(room.G, p) && d++ < 20) {
      room.onMessage(cid, { t: 'action', action: { type: 'discard', color: E.ALL_TOKENS.find(c => p.tokens[c] > 0) } });
    }
    room.onMessage(cid, { t: 'action', action: { type: 'endTurn' } });
    assertConserved(room.G);
  }
  return guard;
}

test('完整对局：1 真人 + 1 电脑（2 人），打到结束且全程守恒', () => {
  const { room, last } = makeRoom();
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cA', { t: 'addAI', level: 'normal' });
  room.onMessage('cA', { t: 'start', opts: {} });
  const plies = playOut(room, { 0: 'cA' });
  assert.strictEqual(room.G.phase, 'gameover', '对局应在 ' + plies + ' 步内结束');
  assert.ok(last('cA', 'over'), '真人收到结束广播');
});

test('完整对局：1 真人 + 3 电脑（4 人，Megas），打乱座位后开局，打到结束', () => {
  const { room, last } = makeRoom();
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cA', { t: 'addAI', level: 'easy' });
  room.onMessage('cA', { t: 'addAI', level: 'normal' });
  room.onMessage('cA', { t: 'addAI', level: 'hard' });
  room.onMessage('cA', { t: 'shuffle' });
  room.onMessage('cA', { t: 'start', opts: { megas: true } });
  const humanSeat = seatOfToken(room, 'tA');
  const plies = playOut(room, { [humanSeat]: 'cA' });
  assert.strictEqual(room.G.phase, 'gameover', '对局应在 ' + plies + ' 步内结束');
  assert.ok(last('cA', 'over'));
});

test('再来一局：电脑座位与难度保留，随机次数清零', () => {
  const { room, last } = makeRoom();
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cA', { t: 'addAI', level: 'hard' });
  room.onMessage('cA', { t: 'shuffle' });
  room.onMessage('cA', { t: 'start', opts: {} });
  room.G.phase = 'gameover'; room.G.winner = 0;
  room.onMessage('cA', { t: 'rematch' });
  const r = last('cA', 'roster');
  assert.strictEqual(r.players.filter(p => p.ai === 'hard').length, 1, '电脑与难度保留');
  assert.strictEqual(room.shuffleCount, 0, '回到大厅后随机次数重新计');
  room.onMessage('cA', { t: 'shuffle' });
  assert.strictEqual(last('cA', 'shuffled').count, 1);
});

test('持久化：快照往返保留电脑座位、难度、房主与随机次数；电脑座位不会被 token 重绑', () => {
  const { room } = makeRoom();
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cB', { t: 'join', token: 'tB' });
  room.onMessage('cA', { t: 'addAI', level: 'easy' });
  let tries = 0;
  while (seatOfToken(room, 'tA') === 0 && tries++ < 200) room.onMessage('cA', { t: 'shuffle' });
  const snap = JSON.parse(JSON.stringify(room.snapshot()));
  const inbox = {};
  const r2 = new Room({ cardDB: DB, ai: AI, send: (c, m) => { (inbox[c] = inbox[c] || []).push(m); } });
  r2.restore(snap);
  assert.strictEqual(r2.seats.filter(s => s.ai === 'easy').length, 1);
  assert.strictEqual(r2.shuffleCount, room.shuffleCount);
  assert.strictEqual(r2.rebind('w1', 'tA'), seatOfToken(room, 'tA'), '休眠唤醒后按 token 重绑到正确座位');
  assert.ok(r2._isHost('w1'), '唤醒后房主身份不丢');
  const aiSeat = r2.seats.findIndex(s => s.ai);
  assert.strictEqual(r2.seats[aiSeat].token, null, '电脑座位没有 token');
  assert.strictEqual(r2.rebind('w2', null), -1, '空 token 不会绑到电脑座位');
});

function humanTurn(room, cid) {
  const p = room.G.players[room.G.turn];
  const plan = AI.chooseTurn(E.clone(room.G), { difficulty: 'easy' });
  room.onMessage(cid, { t: 'action', action: plan.action || { type: 'pass' } });
  let d = 0;
  while (E.needsDiscard(room.G, p) && d++ < 20) {
    room.onMessage(cid, { t: 'action', action: { type: 'discard', color: E.ALL_TOKENS.find(c => p.tokens[c] > 0) } });
  }
  room.onMessage(cid, { t: 'action', action: { type: 'endTurn' } });
}

test('stepAI(attempt)：同一电脑回合重试时思考开销严格递减（高手：4 视图 → 1 视图 → 不搜索），且每次都能走完', () => {
  const calls = [];
  const spy = { chooseTurn(s, o) { calls.push(o); return AI.chooseTurn(s, o); } };
  const { room } = makeRoom({ ai: spy });
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cA', { t: 'addAI', level: 'hard' });
  room.onMessage('cA', { t: 'start', opts: {} });
  const expected = { 0: [{ difficulty: 'hard' }], 1: [{ difficulty: 'hard', beliefs: 1 }], 2: [], 3: [], 9: [] };
  for (const attempt of [0, 1, 2, 3, 9]) {
    humanTurn(room, 'cA');
    assert.ok(room.aiPending(), '轮到电脑');
    calls.length = 0;
    assert.ok(room.stepAI(attempt));
    assert.strictEqual(room.G.turn, 0, 'attempt ' + attempt + '：电脑回合仍然走完');
    assert.deepStrictEqual(calls, expected[attempt], 'attempt ' + attempt + ' 的思考参数');
    assertConserved(room.G);
  }
});

test('stepAI：新手/普通本来就是单视图，第一次重试就直接不搜索；AI 永远在副本上思考', () => {
  for (const lv of ['easy', 'normal']) {
    const calls = [], states = [];
    const spy = { beliefState: AI.beliefState, chooseTurn(s, o) { calls.push(o); states.push(s); return AI.chooseTurn(s, o); } };
    const { room } = makeRoom({ ai: spy });
    room.onMessage('cA', { t: 'join', token: 'tA' });
    room.onMessage('cA', { t: 'addAI', level: lv });
    room.onMessage('cA', { t: 'start', opts: {} });
    humanTurn(room, 'cA');
    room.stepAI(0);
    assert.deepStrictEqual(calls, [{ difficulty: lv }], lv + '：首次按原难度');
    assert.ok(states[0] !== room.G, lv + '：AI 拿到的是副本，不是权威状态');
    humanTurn(room, 'cA');
    calls.length = 0;
    assert.ok(room.stepAI(1));
    assert.deepStrictEqual(calls, [], lv + '：第一次重试就不再搜索（再搜一次也不会更省）');
    assert.strictEqual(room.G.turn, 0, lv + '：仍然走完');
  }
});

test('PokéMart 电脑对局：AI 的查找缓存（_byName）不会写进权威状态、广播或快照', () => {
  let states = 0;
  for (let g = 0; g < 3; g++) {
    const { room, inbox } = makeRoom();
    room.onMessage('cA', { t: 'join', token: 'tA' });
    for (const lv of ['easy', 'normal', 'hard']) room.onMessage('cA', { t: 'addAI', level: lv });
    room.onMessage('cA', { t: 'start', opts: { pokemart: true } });
    let guard = 0;
    while (room.G.phase === 'play' && guard++ < 1500) {
      if (room.aiPending()) room.stepAI(0); else humanTurn(room, 'cA');
      assert.ok(!('_byName' in room.G), '权威状态上出现了 _byName（第 ' + guard + ' 步）');
    }
    for (const m of inbox.cA || []) if (m.t === 'state') { states++; assert.ok(!('_byName' in m.state), '广播的状态里带了 _byName'); }
    assert.ok(JSON.stringify(room.snapshot()).indexOf('_byName') < 0, '快照里带了 _byName');
  }
  assert.ok(states > 100, '确实检查了足够多的广播');
  // 旧版本写下的「脏」快照恢复后也会被清掉
  const dirty = new Room({ cardDB: DB, pokemartDB: PM, send: () => { } });
  const { room: src } = makeRoom();
  src.onMessage('cA', { t: 'join', token: 'tA' });
  src.onMessage('cA', { t: 'addAI' });
  src.onMessage('cA', { t: 'start', opts: { pokemart: true } });
  const snap = src.snapshot();
  snap.g._byName = { 'x': { id: 'x' } };
  dirty.restore(JSON.parse(JSON.stringify(snap)));
  assert.ok(!('_byName' in dirty.G), '恢复时丢弃旧快照里的 _byName');
});

test('removeAI / aiLevel 带上看到的电脑名字：在新名单到达前连点（座位号已过期）时拒绝，而不是误伤另一个电脑', () => {
  const { room, last } = makeRoom();
  room.onMessage('cA', { t: 'join', token: 'tA' });
  for (const lv of ['easy', 'normal', 'normal']) room.onMessage('cA', { t: 'addAI', level: lv });
  // 同一份旧名单 [房主, 电脑1, 电脑2, 电脑3] 上连点：先删电脑1，再对（旧的）2 号位电脑2 改难度 / 删除
  room.onMessage('cA', { t: 'removeAI', seat: 1, name: '电脑1' });
  room.onMessage('cA', { t: 'aiLevel', seat: 2, level: 'hard', name: '电脑2' });
  assert.ok(/座位已变化/.test(last('cA', 'reject').reason), '改难度被拒绝');
  room.onMessage('cA', { t: 'removeAI', seat: 2, name: '电脑2' });
  assert.ok(/座位已变化/.test(last('cA', 'reject').reason), '删除被拒绝');
  assert.deepStrictEqual(room.seats.slice(1).map(s => s.name + ':' + s.ai), ['电脑2:normal', '电脑3:normal'], '电脑3 没被误改、误删');
  room.onMessage('cA', { t: 'aiLevel', seat: 1, level: 'hard', name: '电脑2' });
  assert.strictEqual(room.seats[1].ai, 'hard', '按最新名单操作照常生效');
  room.onMessage('cA', { t: 'removeAI', seat: 2 });
  assert.strictEqual(room.seats.length, 2, '不带名字（旧客户端）仍按座位号处理');
});

test('roster 携带随机次数：刷新或晚到的人也能看到房主重随过几次', () => {
  const { room, last } = makeRoom();
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cA', { t: 'addAI' });
  for (let i = 0; i < 3; i++) room.onMessage('cA', { t: 'shuffle' });
  room.onMessage('cL', { t: 'join', token: 'tL' });
  assert.strictEqual(last('cL', 'roster').shuffleCount, 3);
});

test('恢复快照时房主以 hostToken 为准（旧规则「第一个真人座位」会认错人）', () => {
  const r = new Room({ cardDB: DB, send: () => { } });
  r.restore({ seq: 5, started: false, turnStartedAt: 0, g: null, shuffleCount: 2, hostToken: 'tA',
    seats: [{ token: 'tB', name: 'B' }, { token: 'tA', name: 'A' }, { token: null, name: '电脑1', ai: 'easy' }] });
  assert.strictEqual(r.rebind('w1', 'tA'), 1);
  assert.strictEqual(r.rebind('w2', 'tB'), 0);
  assert.ok(r._isHost('w1'), '坐 2 号位的 tA 仍是房主');
  assert.ok(!r._isHost('w2'), '坐 1 号位的 tB 不会被当成房主');
  assert.strictEqual(r._hostSeat(), 1);
});

test('代打计划：用 discard/evolve 冒充主行动不会让回合卡住（旧漏洞：回合不结束、每次白扣挂机者一个球）', () => {
  for (const fake of [{ type: 'discard', color: 'red' }, { type: 'endTurn' }]) {
    const { room } = makeRoom();
    room.onMessage('cA', { t: 'join', token: 'tA' });
    room.onMessage('cB', { t: 'join', token: 'tB' });
    room.onMessage('cA', { t: 'start', opts: {} });
    room.onMessage('cA', { t: 'action', action: { type: 'take', colors: ['red', 'blue', 'black'] } });
    room.onMessage('cA', { t: 'action', action: { type: 'endTurn' } });
    room.onMessage('cB', { t: 'action', action: { type: 'take', colors: ['red', 'blue', 'black'] } });
    room.onMessage('cB', { t: 'action', action: { type: 'endTurn' } });
    assert.strictEqual(room.G.turn, 0);
    room.now = room.turnStartedAt + 180000;              // A 挂机超时
    room.onMessage('cB', { t: 'takeover', plan: { action: fake } });
    assert.strictEqual(room.G.turn, 1, fake.type + '：回合照常交给下一位');
    assertConserved(room.G);
  }
});

test('humansConnected：电脑不算；真人全部断线时为 false（DO 据此暂停电脑回合），重连后恢复', () => {
  const { room } = makeRoom();
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cA', { t: 'addAI' });
  room.onMessage('cA', { t: 'start', opts: {} });
  assert.strictEqual(room.humansConnected(), true);
  room.leave('cA');
  assert.strictEqual(room.humansConnected(), false, '只剩电脑 → 暂停');
  room.onMessage('cA2', { t: 'join', token: 'tA' });
  assert.strictEqual(room.humansConnected(), true);
});

// ---------------------------------------------------------------- 主动离开（{t:'leave'}）
// 回归：以前点「离开房间」只是闷头断开 socket，服务器把它当意外掉线 —— 座位保留
// token 等「重连」，其他人眼中永远躺着一个「已断线」的幽灵占座，还会随快照活到
// DO 下一次唤醒。主动离开必须真正放出座位。
test('主动离开（大厅）：座位真正让出，名单里不再有幽灵；后面的人前移并收到新 welcome', () => {
  const { room, last, clear } = makeRoom();
  room.onMessage('cA', { t: 'join', name: '小明', token: 'tA' });   // seat 0 房主
  room.onMessage('cB', { t: 'join', name: '阿强', token: 'tB' });   // seat 1
  room.onMessage('cC', { t: 'join', name: '小刚', token: 'tC' });   // seat 2
  clear();
  room.onMessage('cB', { t: 'leave' });
  assert.strictEqual(room.seats.length, 2, '座位被让出，而不是留着 token 等「重连」');
  assert.strictEqual(room.seats.map(s => s.token).join(','), 'tA,tC');
  assert.strictEqual(room.conns.cB, undefined, '离开者的连接已摘除');
  assert.strictEqual(last('cC', 'welcome').seat, 1, '后面的人前移，座位号变了必须重新告知');
  assert.strictEqual(room.conns.cC, 1);
  const r = last('cA', 'roster');
  assert.strictEqual(r.players.length, 2, '其他人看到的名单里没有他了');
  assert.ok(/阿强 离开了房间/.test(last('cA', 'notice').msg), '全房间收到离开提示');
  // 离开者再进来（即使还揣着旧 token）也是全新玩家，不会悄悄坐回原座
  room.onMessage('cB2', { t: 'join', name: '阿强', token: 'tB' });
  assert.strictEqual(room.seats.length, 3);
  assert.strictEqual(room.seats[2].token, 'tB', '旧 token 认不到旧座位 → 拿了新座位');
});

test('主动离开（大厅）：房主离开 → 移交房主并告知（否则剩下的人谁也开不了局）', () => {
  const { room, last, clear } = makeRoom();
  room.onMessage('cA', { t: 'join', name: '小明', token: 'tA' });
  room.onMessage('cB', { t: 'join', name: '阿强', token: 'tB' });
  clear();
  room.onMessage('cA', { t: 'leave' });
  assert.strictEqual(room.hostToken, 'tB', '房主移交给留下的真人');
  const w = last('cB', 'welcome');
  assert.ok(w && w.host === true, '新房主必须收到 host=true（客户端据此显示开始/加电脑控件）');
  assert.ok(/阿强 成为新房主/.test(last('cB', 'notice').msg));
  assert.strictEqual(last('cB', 'roster').hostSeat, seatOfToken(room, 'tB'));
  room.onMessage('cB', { t: 'addAI' });                      // 新房主能加电脑（房主权限生效）
  room.onMessage('cB', { t: 'start', opts: {} });            // 2 座（B + 电脑）才允许开局
  assert.ok(room.started, '新房主可以开局');
});

test('主动离开（大厅）：房主与座位号都没变的人不需要额外 welcome，但新房主仍会被告知', () => {
  const { room, all, clear } = makeRoom();
  room.onMessage('cA', { t: 'join', name: '小明', token: 'tA' });   // seat 0 房主
  room.onMessage('cB', { t: 'join', name: '阿强', token: 'tB' });   // seat 1
  room.onMessage('cC', { t: 'join', name: '小刚', token: 'tC' });   // seat 2
  clear();
  room.onMessage('cC', { t: 'leave' });                             // 末位离开：A/B 座位号都不变
  assert.strictEqual(all('cA', 'welcome').length, 0, '座位号没变不应重发 welcome');
  assert.strictEqual(all('cB', 'welcome').length, 0, '座位号没变不应重发 welcome');
  // 换成房主末位离开：B（seat 1 → 0）收到重排 welcome；新房主若是座位号没变的人也要被单独告知
  room.onMessage('cA', { t: 'leave' });
  assert.ok(all('cB', 'welcome').some(m => m.host === true), '成为新房主的人收到了 host=true');
  assert.strictEqual(room.hostToken, 'tB');
});

test('主动离开（对局结束）：结算界面点「离开房间」也放座；重开后大厅干净、可补电脑再开', () => {
  const { room, last, clear } = makeRoom();
  room.onMessage('cA', { t: 'join', name: '小明', token: 'tA' });
  room.onMessage('cB', { t: 'join', name: '阿强', token: 'tB' });
  room.onMessage('cA', { t: 'start', opts: {} });
  room.G.phase = 'gameover'; room.G.winner = 0;
  clear();
  room.onMessage('cB', { t: 'leave' });
  assert.strictEqual(room.seats.length, 1, '结算时离开同样让出座位');
  room.onMessage('cA', { t: 'rematch' });
  assert.strictEqual(last('cA', 'roster').players.length, 1, '回到大厅：名单里没有幽灵座位');
  room.onMessage('cA', { t: 'addAI' });
  room.onMessage('cA', { t: 'start', opts: {} });
  assert.strictEqual(room.G.numPlayers, 2, '补一个电脑即可重开，人数没有被幽灵虚占');
});

test('对局进行中主动离开：不能删座位（引擎按座位记账），退化为断线等待代打', () => {
  const { room, last, clear } = makeRoom();
  room.now = 0;
  room.onMessage('cA', { t: 'join', name: '小明', token: 'tA' });
  room.onMessage('cB', { t: 'join', name: '阿强', token: 'tB' });
  room.onMessage('cA', { t: 'start', opts: {} });
  clear();
  room.onMessage('cA', { t: 'leave' });                    // A 在对局中点离开
  assert.strictEqual(room.seats.length, 2, '座位保留：筹码/卡牌按座位记账，抽不得');
  assert.strictEqual(room.seats[0].connected, false, '标记为断线');
  assert.strictEqual(room.seats[0].token, 'tA', 'token 保留：刷新还能认回');
  assert.strictEqual(last('cB', 'roster').players.length, 2);
  // 对局不卡死：超时后其他人可以代打
  room.now = 200000;
  room.onMessage('cB', { t: 'takeover', plan: { action: { type: 'take', colors: ['red', 'blue', 'black'] } } });
  assert.strictEqual(room.G.turn, 1, '代打推进了离开者的回合');
});

test('观战者主动离开：只清连接，不影响任何座位', () => {
  const { room } = makeRoom();
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cB', { t: 'join', token: 'tB' });
  room.onMessage('cA', { t: 'start', opts: {} });
  room.onMessage('cS', { t: 'join', token: 'tS' });        // 开局后加入 = 观战
  room.onMessage('cS', { t: 'leave' });
  assert.strictEqual(room.seats.length, 2);
  assert.strictEqual(room.conns.cS, undefined);
  assert.strictEqual(room.seats.every(s => s.connected), true);
});

test('只能退出自己的座位：被顶掉的旧连接发 leave 不会动新连接的座位', () => {
  const { room } = makeRoom();
  room.join('old', 'A', 'a'); room.join('b', 'B', 'b');
  room.join('new', 'A', 'a');                               // new 顶掉 old
  room.onMessage('old', { t: 'leave' });                    // old 已不是任何座位的主人
  assert.strictEqual(room.seats.length, 2);
  assert.strictEqual(room.seats[0].connId, 'new');
  assert.strictEqual(room.seats[0].connected, true);
});

test('主动离开后会话不留痕：快照往返不复活幽灵座位，房主移交也持久', () => {
  const { room } = makeRoom();
  room.onMessage('cA', { t: 'join', name: '小明', token: 'tA' });
  room.onMessage('cB', { t: 'join', name: '阿强', token: 'tB' });
  room.onMessage('cA', { t: 'leave' });                     // 房主走
  const snap = JSON.parse(JSON.stringify(room.snapshot()));
  const inbox = {};
  const r2 = new Room({ cardDB: DB, send: (c, m) => { (inbox[c] = inbox[c] || []).push(m); } });
  r2.restore(snap);
  assert.strictEqual(r2.seats.length, 1, 'DO 唤醒后离开者的座位没有回来');
  assert.strictEqual(r2.hostToken, 'tB', '房主移交被落盘（否则房间永远开不了局）');
  r2.onMessage('w1', { t: 'join', name: '阿强', token: 'tB' });
  assert.strictEqual(inbox.w1.filter(m => m.t === 'welcome').pop().host, true, '唤醒后重新加入的房主仍被认出');
});

// ---------------------------------------------------------------- 房主移出玩家（{t:'kick'}）
test('房主移出玩家（大厅）：座位放出，被移出者收到 kicked 并与座位解绑，其余人看到提示与位移', () => {
  const { room, last, clear } = makeRoom();
  room.onMessage('cA', { t: 'join', name: '小明', token: 'tA' });   // 房主
  room.onMessage('cB', { t: 'join', name: '阿强', token: 'tB' });
  room.onMessage('cC', { t: 'join', name: '小刚', token: 'tC' });
  clear();
  room.onMessage('cA', { t: 'kick', seat: 1, name: '阿强' });
  assert.strictEqual(room.seats.length, 2, '座位被放出');
  assert.deepStrictEqual(room.seats.map(s => s.token), ['tA', 'tC']);
  assert.strictEqual(last('cB', 'kicked').msg, '你已被房主移出房间');
  assert.strictEqual(room.conns.cB, undefined, '被移出者的连接已与座位解绑（不再是广播对象）');
  assert.strictEqual(last('cC', 'welcome').seat, 1, '后面的人前移并被重新告知座位号');
  assert.strictEqual(last('cA', 'roster').players.length, 2);
  assert.ok(/阿强 已被房主移出房间/.test(last('cA', 'notice').msg), '全房间收到提示');
  // 被移出者拿旧 token 再进来：全新玩家，不会认回旧座位（移出不是封禁，但也不留幽灵）
  room.onMessage('cB2', { t: 'join', name: '阿强', token: 'tB' });
  assert.strictEqual(room.seats.length, 3);
  assert.strictEqual(room.seats[2].token, 'tB');
  assert.strictEqual(room.hostToken, 'tA', '移出别人不影响房主身份');
});

test('移出玩家：仅房主；不能移出自己；电脑座位要走 removeAI', () => {
  const { room, last, clear } = makeRoom();
  room.onMessage('cA', { t: 'join', name: '小明', token: 'tA' });
  room.onMessage('cB', { t: 'join', name: '阿强', token: 'tB' });
  room.onMessage('cA', { t: 'addAI' });
  clear();
  room.onMessage('cB', { t: 'kick', seat: 2, name: '电脑1' });
  assert.ok(/只有房主/.test(last('cB', 'reject').reason), '非房主不能移出');
  room.onMessage('cA', { t: 'kick', seat: 0, name: '小明' });
  assert.ok(/不能移出自己/.test(last('cA', 'reject').reason));
  room.onMessage('cA', { t: 'kick', seat: 2, name: '电脑1' });
  assert.ok(/不是真人/.test(last('cA', 'reject').reason), '电脑座位请用移除电脑');
  assert.strictEqual(room.seats.length, 3, '谁都没被移出');
});

test('移出玩家：过期的座位/名字组合被拒绝（防连点误伤挪进该座位的人）', () => {
  const { room, last } = makeRoom();
  room.onMessage('cA', { t: 'join', name: '小明', token: 'tA' });
  room.onMessage('cB', { t: 'join', name: '阿强', token: 'tB' });
  room.onMessage('cC', { t: 'join', name: '小刚', token: 'tC' });
  room.onMessage('cA', { t: 'kick', seat: 1, name: '阿强' });   // 阿强被移出 → 小刚前移到 1 号位
  room.onMessage('cA', { t: 'kick', seat: 1, name: '阿强' });   // 房主界面还没刷新就连点
  assert.ok(/座位已变化/.test(last('cA', 'reject').reason), '按旧名单连点应被拒绝');
  assert.strictEqual(room.seats.length, 2, '坐在 1 号位的小刚没有被误伤');
  assert.strictEqual(room.seats[1].token, 'tC');
  room.onMessage('cA', { t: 'kick', seat: 1, name: '小刚' });   // 按最新名单操作照常生效
  assert.strictEqual(room.seats.length, 1);
});

test('移出玩家：对局进行中拒绝（不能删座位）；对局结束后可用（重开前清人）', () => {
  const { room, last, clear } = makeRoom();
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cB', { t: 'join', token: 'tB' });
  room.onMessage('cA', { t: 'start', opts: {} });
  clear();
  room.onMessage('cA', { t: 'kick', seat: 1 });
  assert.ok(/对局进行中/.test(last('cA', 'reject').reason));
  assert.strictEqual(room.seats.length, 2);
  room.G.phase = 'gameover'; room.G.winner = 0;
  room.onMessage('cA', { t: 'kick', seat: 1 });
  assert.strictEqual(room.seats.length, 1, '对局结束后可以移出');
  assert.ok(last('cB', 'kicked'), '被移出者收到 kicked 通知');
  room.onMessage('cA', { t: 'rematch' });
  assert.strictEqual(last('cA', 'roster').players.length, 1, '重开的大厅没有幽灵座位');
});

test('移出断线中的玩家：座位照常放出（不卡房间），只是收不到 kicked 通知', () => {
  const { room, last } = makeRoom();
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cB', { t: 'join', name: '阿强', token: 'tB' });
  room.leave('cB');                                          // 断线：座位保留等重连
  assert.strictEqual(room.seats.length, 2);
  room.onMessage('cA', { t: 'kick', seat: 1, name: '阿强' });
  assert.strictEqual(room.seats.length, 1, '断线玩家的座位也能放出');
  assert.strictEqual(room.hostToken, 'tA');
  assert.strictEqual(last('cB', 'kicked'), undefined, '断线中收不到通知（重连后是新玩家）');
});

test('移出玩家会落盘：快照往返不复活座位', () => {
  const { room } = makeRoom();
  room.onMessage('cA', { t: 'join', token: 'tA' });
  room.onMessage('cB', { t: 'join', token: 'tB' });
  room.onMessage('cA', { t: 'kick', seat: 1 });
  const snap = JSON.parse(JSON.stringify(room.snapshot()));
  const r2 = new Room({ cardDB: DB, send: () => { } });
  r2.restore(snap);
  assert.strictEqual(r2.seats.length, 1, 'DO 唤醒后被移出者的座位没有回来');
  assert.strictEqual(r2.hostToken, 'tA');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
