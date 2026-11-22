/**
 * 新功能测试:Speed 成长、转生、跑步机、Obby 关卡、房间、排行榜。
 *
 * 用法: node test/progression.mjs [baseUrl]
 */
import crypto from 'node:crypto';
import { WebSocket } from 'ws';

const BASE = process.argv[2] || 'http://127.0.0.1:8080';
const WS_BASE = BASE.replace(/^http/, 'ws');

const TEST_TURNSTILE_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

const results = [];
function check(name, ok, info) {
  results.push({ name, ok, info });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${info ? ` - ${info}` : ''}`);
}

function authBody(fields) {
  return JSON.stringify({ ...fields, turnstileToken: TEST_TURNSTILE_TOKEN });
}

async function api(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  const raw = res.headers.getSetCookie?.() ?? [];
  const cookie =
    raw.map((c) => c.split(';')[0]).find((c) => c.startsWith('speedy_session=')) ?? null;
  return { status: res.status, body, cookie };
}

class Peer {
  constructor(name) {
    this.name = name;
    this.queue = [];
    this.waiters = [];
    this.progress = null;
  }

  static async login(name, password, roomId = '') {
    const peer = new Peer(name);
    const reg = await api('/api/register', {
      method: 'POST',
      body: authBody({ username: name, password }),
    });
    let cookie = reg.cookie;
    if (reg.status === 409) {
      const login = await api('/api/login', {
        method: 'POST',
        body: authBody({ username: name, password }),
      });
      cookie = login.cookie;
    }
    if (!cookie) throw new Error(`${name} 登录失败: ${JSON.stringify(reg.body)}`);

    const ticket = await api('/api/ws-ticket', { headers: { Cookie: cookie } });
    const suffix = roomId ? `&room=${encodeURIComponent(roomId)}` : '';

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(
        `${WS_BASE}/ws?token=${encodeURIComponent(ticket.body.token)}${suffix}`,
      );
      peer.ws = ws;
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
          return;
        }
        if (msg.type === 'progress') peer.progress = msg;
        const idx = peer.waiters.findIndex((w) => w.predicate(msg));
        if (idx !== -1) {
          const [w] = peer.waiters.splice(idx, 1);
          w.resolve(msg);
          return;
        }
        peer.queue.push(msg);
      });
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    peer.welcome = await peer.waitFor((m) => m.type === 'welcome');
    peer.uid = peer.welcome.uid;
    peer.roomId = peer.welcome.roomId;
    return peer;
  }

  waitFor(predicate, timeoutMs = 6000) {
    const idx = this.queue.findIndex(predicate);
    if (idx !== -1) {
      const [msg] = this.queue.splice(idx, 1);
      return Promise.resolve(msg);
    }
    return new Promise((resolve, reject) => {
      const wrapped = (msg) => {
        clearTimeout(timer);
        resolve(msg);
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== wrapped);
        reject(new Error(`${this.name} 等待超时`));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve: wrapped });
    });
  }

  latestSelf() {
    const list = this.queue.filter((m) => m.type === 'self_state');
    return list[list.length - 1] ?? null;
  }

  /** 丢弃已排队的指定类型消息,避免读到过期的旧包。 */
  drainType(type) {
    this.queue = this.queue.filter((m) => m.type !== type);
  }

  send(payload) {
    this.ws.send(JSON.stringify(payload));
  }

  /** 持续输入一段时间,保持"正在移动"。 */
  async move(durationMs, input = { moveX: 1, moveZ: 0, jump: false }) {
    const started = Date.now();
    let seq = Date.now();
    while (Date.now() - started < durationMs) {
      const self = this.latestSelf();
      this.send({
        type: 'player_input',
        seq: seq++,
        input,
        clientPreviewPos: self ? { ...self.pos } : { x: 0, y: 0, z: 0 },
      });
      // 60ms ≈ 16.7 包/秒,低于服务端 22 包/秒的上限
      await new Promise((r) => setTimeout(r, 60));
    }
  }

  /** 朝目标点走;返回是否到达。 */
  async walkTo(target, radius = 1.5, maxMs = 20000) {
    const started = Date.now();
    let seq = Date.now();
    let arrived = false;
    while (Date.now() - started < maxMs) {
      const self = this.latestSelf();
      if (!self) {
        await new Promise((r) => setTimeout(r, 60));
        continue;
      }
      const dx = target.x - self.pos.x;
      const dy = (target.y ?? self.pos.y) - self.pos.y;
      const dz = target.z - self.pos.z;
      if (Math.hypot(dx, dz) <= radius) {
        arrived = true;
        break;
      }
      this.send({
        type: 'player_input',
        seq: seq++,
        input: {
          moveX: Math.abs(dx) < 0.3 ? 0 : Math.sign(dx),
          moveZ: Math.abs(dz) < 0.3 ? 0 : Math.sign(dz),
          jump: dy > 1.0,
        },
        clientPreviewPos: { ...self.pos },
      });
      await new Promise((r) => setTimeout(r, 60));
    }
    // 停下
    for (let i = 0; i < 6; i += 1) {
      const self = this.latestSelf();
      this.send({
        type: 'player_input',
        seq: seq++,
        input: { moveX: 0, moveZ: 0, jump: false },
        clientPreviewPos: self ? { ...self.pos } : { x: 0, y: 0, z: 0 },
      });
      await new Promise((r) => setTimeout(r, 60));
    }
    return arrived;
  }

  close() {
    try {
      this.ws.close(1000, 'done');
    } catch {
      /* ignore */
    }
  }
}

/**
 * 等到角色的权威速度真正归零。
 *
 * 停止输入后仍有惯性滑行,这段时间 speed 会继续增长,属于正确行为。
 * 必须持续上报"无输入",否则服务器会用最后一次移动输入继续外推。
 *
 * 判定依据取自最新到达的 self_state:每次都重新消费一条 tick 更新的包。
 */
async function waitUntilStopped(peer, timeoutMs = 9000) {
  const started = Date.now();
  let lastTick = peer.latestSelf()?.tick ?? -1;
  let last = peer.latestSelf();
  let seq = Date.now();
  while (Date.now() - started < timeoutMs) {
    peer.send({
      type: 'player_input',
      seq: seq++,
      input: { moveX: 0, moveZ: 0, jump: false },
      clientPreviewPos: last ? { ...last.pos } : { x: 0, y: 0, z: 0 },
    });
    try {
      const fresh = await peer.waitFor(
        (m) => m.type === 'self_state' && m.tick > lastTick,
        400,
      );
      lastTick = fresh.tick;
      last = fresh;
      const speed = Math.hypot(fresh.vel?.x ?? 0, fresh.vel?.y ?? 0, fresh.vel?.z ?? 0);
      if (speed < 0.01) return true;
    } catch {
      /* 这一轮没等到新包,继续 */
    }
  }
  return false;
}

async function main() {  const suffix = crypto.randomBytes(3).toString('hex');
  const password = 'TestPass123';

  const a = await Peer.login(`p_a_${suffix}`, password);
  check('welcome 下发房间 id', typeof a.roomId === 'string' && a.roomId.length > 0, a.roomId);

  // --- 1. 客户端预测常量同源 ---
  const physics = a.welcome.physics;
  check(
    'welcome 下发完整物理常量',
    physics &&
      typeof physics.maxSpeed === 'number' &&
      typeof physics.acceleration === 'number' &&
      typeof physics.gravity === 'number' &&
      typeof physics.tickRate === 'number',
    JSON.stringify({ maxSpeed: physics?.maxSpeed, gravity: physics?.gravity }),
  );

  // --- 2. Speed 随移动增长 ---
  const speedBefore = a.welcome.self.speed ?? 0;
  await a.move(1500);
  const afterMove = await a.waitFor((m) => m.type === 'progress', 3000);
  check(
    '移动时 speed 增长',
    afterMove.speed > speedBefore,
    `${speedBefore.toFixed(2)} -> ${afterMove.speed.toFixed(2)}`,
  );

  // --- 3. 静止不涨 ---
  // 惯性滑行期间速度不为零,speed 继续增长是正确的。
  // 所以要等速度真正归零(期间持续上报无输入),再看 speed 是否稳定。
  const stopped = await waitUntilStopped(a, 9000);
  check('角色能完全停下', stopped);

  const idleStartProgress = await (async () => {
    a.drainType('progress');
    await new Promise((r) => setTimeout(r, 200));
    a.drainType('progress');
    return a.waitFor((m) => m.type === 'progress', 4000);
  })();
  const idleStart = idleStartProgress.speed;
  await new Promise((r) => setTimeout(r, 1500));
  a.drainType('progress');
  const idleProgress = await a.waitFor((m) => m.type === 'progress', 4000);
  check(
    '静止时 speed 不增长',
    Math.abs(idleProgress.speed - idleStart) < 0.02,
    `${idleStart.toFixed(3)} -> ${idleProgress.speed.toFixed(3)}`,
  );

  // --- 4. 转生门槛校验 ---
  a.send({ type: 'request_rebirth' });
  const rebirthFail = await a.waitFor(
    (m) => m.type === 'action_result' && m.action === 'rebirth',
    3000,
  );
  check(
    'speed 不足时转生被拒',
    rebirthFail.ok === false && rebirthFail.reason === 'below_min_speed',
    `reason=${rebirthFail.reason} remaining=${rebirthFail.remaining}`,
  );

  // --- 5. 跑步机:宝石不足 ---
  a.send({ type: 'buy_treadmill', treadmillId: 'treadmill-1' });
  const buyFail = await a.waitFor(
    (m) => m.type === 'action_result' && m.action === 'buy_treadmill',
    3000,
  );
  check(
    '宝石不足时买跑步机被拒',
    buyFail.ok === false && buyFail.reason === 'not_enough_gems',
    `reason=${buyFail.reason} need=${buyFail.need}`,
  );

  // --- 6. 非法跑步机 id ---
  a.send({ type: 'buy_treadmill', treadmillId: 'no-such-thing' });
  const buyBad = await a.waitFor(
    (m) => m.type === 'action_result' && m.action === 'buy_treadmill',
    3000,
  );
  check('未知跑步机被拒', buyBad.ok === false, `reason=${buyBad.reason}`);

  // --- 7. 关卡:speed 门槛 ---
  a.send({ type: 'enter_stage', stage: 2 });
  const stage2 = await a.waitFor(
    (m) => m.type === 'action_result' && m.action === 'enter_stage',
    3000,
  );
  check(
    '未通关前一关时无法进入 stage 2',
    stage2.ok === false && ['previous_stage_locked', 'below_min_speed'].includes(stage2.reason),
    `reason=${stage2.reason}`,
  );

  // --- 8. 进入 stage 1 ---
  a.send({ type: 'enter_stage', stage: 1 });
  const enter1 = await a.waitFor(
    (m) => m.type === 'action_result' && m.action === 'enter_stage',
    3000,
  );
  check('可以进入 stage 1', enter1.ok === true, `stage=${enter1.stage}`);

  const stageState = await a.waitFor((m) => m.type === 'stage_state', 3000);
  check('进入关卡后下发关卡状态', stageState.stageId === 1, `stageId=${stageState.stageId}`);

  // 位置应该被传送到关卡原点附近
  await new Promise((r) => setTimeout(r, 300));
  const inStage = a.latestSelf();
  check(
    '进入关卡后位置被传送到关卡',
    inStage && Math.abs(inStage.pos.z) > 50,
    `z=${inStage?.pos.z}`,
  );

  // --- 9. 掉落检测:往侧面跑出平台 ---
  const yBefore = inStage.pos.y;
  await a.move(1200, { moveX: 1, moveZ: 0, jump: false });
  await new Promise((r) => setTimeout(r, 1500));
  const afterFall = a.latestSelf();
  check(
    '掉落后高度回升(回到检查点)',
    afterFall && afterFall.pos.y >= -10,
    `y=${afterFall?.pos.y?.toFixed(2)} (前 ${yBefore?.toFixed(2)})`,
  );

  // --- 10. 退出关卡 ---
  a.send({ type: 'exit_stage' });
  const exit = await a.waitFor(
    (m) => m.type === 'action_result' && m.action === 'exit_stage',
    3000,
  );
  check('可以退出关卡', exit.ok === true);

  const backLobby = await a.waitFor((m) => m.type === 'self_state' && Math.abs(m.pos.z) < 60, 3000);
  check('退出后回到 lobby', Math.abs(backLobby.pos.z) < 60, `z=${backLobby.pos.z}`);

  // --- 11. 房间:列表与切换 ---
  a.send({ type: 'request_rooms' });
  const rooms = await a.waitFor((m) => m.type === 'rooms', 3000);
  check('可以获取房间列表', Array.isArray(rooms.rooms) && rooms.rooms.length > 0, `${rooms.rooms.length} 个`);

  const targetRoom = `test-${suffix}`;
  a.send({ type: 'join_room', roomId: targetRoom });
  const joinRes = await a.waitFor(
    (m) => m.type === 'action_result' && m.action === 'join_room',
    4000,
  );
  check('可以切换房间', joinRes.ok === true && joinRes.roomId === targetRoom, `room=${joinRes.roomId}`);

  // --- 12. 非法房间名 ---
  // 服务端在协议层接受任何短字符串,真正的 id 合法性由房间管理器判定,
  // 所以拒绝是 action_result(reason=invalid_room_id),不是 error 包。
  a.send({ type: 'join_room', roomId: 'BAD ROOM!!' });
  const badRoom = await a.waitFor(
    (m) =>
      (m.type === 'action_result' && m.action === 'join_room' && m.ok === false) ||
      m.type === 'error',
    3000,
  );
  const badRoomReason = badRoom.reason ?? badRoom.code;
  check(
    '非法房间 id 被拒',
    ['invalid_room_id', 'bad_room_id'].includes(badRoomReason),
    `reason=${badRoomReason}`,
  );

  // --- 13. 排行榜 ---
  a.send({ type: 'request_leaderboard' });
  const board = await a.waitFor((m) => m.type === 'leaderboard', 4000);
  check(
    '可以获取排行榜',
    Array.isArray(board.rows) && board.rows.some((r) => r.uid === a.uid),
    `${board.rows.length} 行,room=${board.roomId}`,
  );
  const meRow = board.rows.find((r) => r.uid === a.uid);
  check(
    '排行榜包含 rebirth 与 speed',
    meRow && typeof meRow.rebirth === 'number' && typeof meRow.speed === 'number',
    JSON.stringify(meRow),
  );

  // --- 14. 客户端上传 speed 无效 ---
  const speedBeforeForge = a.progress?.speed ?? 0;
  a.send({
    type: 'player_input',
    seq: Date.now(),
    input: { moveX: 0, moveZ: 0, jump: false },
    clientPreviewPos: { x: 0, y: 0, z: 0 },
    speed: 999999,
    multiplier: 999,
    gems: 99999,
  });
  await new Promise((r) => setTimeout(r, 500));
  const afterForge = a.progress?.speed ?? 0;
  check(
    '客户端上传 speed/multiplier 被忽略',
    Math.abs(afterForge - speedBeforeForge) < 5,
    `${speedBeforeForge.toFixed(2)} -> ${afterForge.toFixed(2)}`,
  );

  // --- 15. 断线重连恢复进度 ---
  const speedSnapshot = a.progress?.speed ?? 0;
  const rebirthSnapshot = a.progress?.rebirth ?? 0;
  a.close();
  await new Promise((r) => setTimeout(r, 800));

  const a2 = await Peer.login(`p_a_${suffix}`, password);
  const restored = a2.welcome.progress ?? a2.welcome.self;
  check(
    '重连后 speed 从存档恢复',
    Math.abs((restored.speed ?? 0) - speedSnapshot) < 1.5,
    `存档 ${restored.speed?.toFixed(2)} vs 下线前 ${speedSnapshot.toFixed(2)}`,
  );
  check(
    '重连后 rebirth 从存档恢复',
    (restored.rebirth ?? 0) === rebirthSnapshot,
    `${restored.rebirth}`,
  );

  a2.close();

  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log(`${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    for (const f of failed) console.log(`  - ${f.name} (${f.info ?? ''})`);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error('测试异常:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    // 兜底:任何用例卡住都不要让进程挂着
    setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
  });
