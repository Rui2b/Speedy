/**
 * 端到端自测脚本(不依赖浏览器)。
 *
 * 覆盖:
 *   1. 注册 / 登录 / 会话 / WS 票据
 *   2. WebSocket 握手鉴权(无 token、伪造 token 必须被拒)
 *   3. welcome 包结构
 *   4. 输入上报 → self_state 权威坐标变化
 *   5. 超频发包触发限流与作弊日志
 *   6. 瞬移作弊检测
 *   7. 宝石拾取(远距离必须失败)
 *
 * 用法: node test/e2e.mjs [baseUrl]
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { WebSocket } from 'ws';

const BASE = process.argv[2] || 'http://127.0.0.1:8080';
const WS_BASE = BASE.replace(/^http/, 'ws');

const results = [];
function record(name, ok, info) {
  results.push({ name, ok, info });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${info ? ` - ${info}` : ''}`);
}

async function api(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json, cookies: res.headers.getSetCookie?.() ?? [] };
}

/**
 * 注册 / 登录请求体。
 *
 * Turnstile 的 token 只能由真实浏览器产生,所以自动化测试用 Cloudflare 官方的
 * "始终通过"测试 secret。服务端只要配置了这个测试 secret,任意字符串都能通过。
 * 生产环境用的是真 key,伪造的 token 会被拒。
 *
 * 若服务端未启用 Turnstile(本地没配 key),则返回 503,脚本也能识别。
 */
const TEST_TURNSTILE_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

function authBody(fields) {
  return JSON.stringify({ ...fields, turnstileToken: TEST_TURNSTILE_TOKEN });
}

/** 极简 cookie jar,只需要 speedy_session */
function cookieFrom(headers) {
  for (const item of headers || []) {
    const [pair] = item.split(';');
    if (pair.startsWith('speedy_session=')) return pair;
  }
  return null;
}

class Client {
  constructor(ws, name) {
    this.ws = ws;
    this.name = name;
    this.messages = [];
    this.waiters = [];
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      // 优先交给等待者;没人认领才进缓冲区,避免同一条消息被重复消费
      const idx = this.waiters.findIndex((w) => w.predicate(msg));
      if (idx !== -1) {
        const waiter = this.waiters.splice(idx, 1)[0];
        waiter.resolve(msg);
        return;
      }
      this.messages.push(msg);
    });
  }

  static connect(url, name) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const client = new Client(ws, name);
      ws.once('open', () => resolve(client));
      ws.once('error', reject);
    });
  }

  waitFor(predicate, timeoutMs = 4000) {
    const existingIndex = this.messages.findIndex(predicate);
    if (existingIndex !== -1) {
      const [existing] = this.messages.splice(existingIndex, 1);
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const wrapped = (msg) => {
        clearTimeout(timer);
        resolve(msg);
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== wrapped);
        reject(new Error(`timeout waiting for a message in ${this.name}`));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve: wrapped });
    });
  }

  waitClose(timeoutMs = 4000) {
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve({ code: 0 });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('close timeout')), timeoutMs);
      this.ws.once('close', (code) => {
        clearTimeout(timer);
        resolve({ code });
      });
    });
  }

  send(payload) {
    this.ws.send(JSON.stringify(payload));
  }

  close() {
    try {
      this.ws.close(1000, 'test_done');
    } catch {
      /* ignore */
    }
  }
}

function seqStart() {
  return Math.floor(Math.random() * 1000);
}

async function main() {
  const suffix = crypto.randomBytes(4).toString('hex');
  const userA = `t_a_${suffix}`;
  const userB = `t_b_${suffix}`;
  const password = 'TestPass123';

  /* ---------------------------- 1. 账号 ---------------------------- */
  const regA = await api('/api/register', {
    method: 'POST',
    body: authBody({ username: userA, password }),
  });
  record('register user A', regA.status === 201 && regA.body.ok === true, `status=${regA.status}`);

  const dup = await api('/api/register', {
    method: 'POST',
    body: authBody({ username: userA, password }),
  });
  record('duplicate username refused', dup.status === 409 && dup.body.error === 'username_taken', `status=${dup.status}`);

  const badName = await api('/api/register', {
    method: 'POST',
    body: authBody({ username: 'a', password }),
  });
  record('short username refused', badName.status === 400, `status=${badName.status}`);

  const badPass = await api('/api/login', {
    method: 'POST',
    body: authBody({ username: userA, password: 'wrongpass' }),
  });
  record('wrong password refused', badPass.status === 401, `status=${badPass.status}`);

  const regB = await api('/api/register', {
    method: 'POST',
    body: authBody({ username: userB, password }),
  });
  const cookieB = cookieFrom(regB.cookies);
  record('register user B', regB.status === 201 && Boolean(cookieB), `status=${regB.status}`);

  const cookieA = cookieFrom(regA.cookies);
  record('sign in sets an HttpOnly cookie', /HttpOnly/i.test(regA.cookies.join(';')) && Boolean(cookieA));

  const sessionA = await api('/api/session', { headers: { Cookie: cookieA } });
  record('session validates', sessionA.status === 200 && sessionA.body.ok === true);

  const noSession = await api('/api/session');
  record('session without a cookie fails', noSession.status === 401);

  const ticketA = await api('/api/ws-ticket', { headers: { Cookie: cookieA } });
  const tokenA = ticketA.body?.token;
  record('WebSocket ticket issued', ticketA.status === 200 && typeof tokenA === 'string' && tokenA.includes('.'));

  const ticketB = await api('/api/ws-ticket', { headers: { Cookie: cookieB } });
  const tokenB = ticketB.body?.token;

  /* ------------------------ 2. WS 握手鉴权 ------------------------- */
  let rejectedCode = null;
  await new Promise((resolve) => {
    const bad = new WebSocket(`${WS_BASE}/ws?token=${encodeURIComponent('forged.token')}`);
    bad.on('close', (code) => {
      rejectedCode = code;
      resolve();
    });
    bad.on('error', () => {});
    setTimeout(resolve, 3000);
  });
  record('forged token is refused', rejectedCode === 4001, `code=${rejectedCode}`);

  let noTokenCode = null;
  await new Promise((resolve) => {
    const bad = new WebSocket(`${WS_BASE}/ws`);
    bad.on('close', (code) => {
      noTokenCode = code;
      resolve();
    });
    bad.on('error', () => {});
    setTimeout(resolve, 3000);
  });
  record('missing token is refused', noTokenCode === 4001, `code=${noTokenCode}`);

  /* --------------------------- 3. 进游戏 --------------------------- */
  const clientA = await Client.connect(`${WS_BASE}/ws?token=${encodeURIComponent(tokenA)}`, 'A');
  const clientB = await Client.connect(`${WS_BASE}/ws?token=${encodeURIComponent(tokenB)}`, 'B');

  // 握手要读库;本地通过 SSH 隧道连远程库时每次往返约 200ms,所以要给足时间
  const welcomeA = await clientA.waitFor((m) => m.type === 'welcome', 20000);
  record('welcome carries the self state', Boolean(welcomeA.self?.pos) && typeof welcomeA.uid === 'string');
  record('welcome carries server config', welcomeA.config?.tickRate === 20 && welcomeA.config?.broadcastRate === 10);

  const welcomeB = await clientB.waitFor((m) => m.type === 'welcome', 20000);

  /* ------------------------ 4. 输入 → 权威位移 --------------------- */
  let seq = seqStart();
  const startPos = { ...welcomeA.self.pos };

  const moveStart = Date.now();
  const moveTimer = setInterval(() => {
    seq += 1;
    clientA.send({
      type: 'player_input',
      seq,
      input: { moveX: 1, moveZ: 0, jump: false },
      clientPreviewPos: { x: startPos.x, y: 0, z: startPos.z },
      skinId: welcomeA.skinId,
    });
  }, 50);

  await new Promise((r) => setTimeout(r, 1200));
  clearInterval(moveTimer);
  const moved = Date.now() - moveStart;

  const selfStates = clientA.messages.filter((m) => m.type === 'self_state');
  const lastSelf = selfStates[selfStates.length - 1];
  const distance = lastSelf ? Math.hypot(lastSelf.pos.x - startPos.x, lastSelf.pos.z - startPos.z) : 0;

  record('input moves the authoritative position', distance > 1.5, `moved ${distance.toFixed(2)} in ${moved}ms`);
  record(
    'movement stays under the speed limit',
    distance <= 6.0 * (moved / 1000) + 1.0,
    `moved ${distance.toFixed(2)}, limit ${(6 * (moved / 1000)).toFixed(2)}`,
  );

  // 等一条真正包含 A 的快照。B 缓冲区里最早那条可能是 A 还没进场时发的,
  // 所以只能按内容匹配才能稳定断言
  const snapshot = await clientB.waitFor(
    (m) => m.type === 'world_snapshot' && (m.players ?? []).some((p) => p.uid === welcomeA.uid),
    5000,
  );
  record('B receives world_snapshot containing A', true);
  // P2 起宝石只来自首通奖励,地图上不再有可拾取的宝石
  record('snapshot carries no ground gems', Array.isArray(snapshot.gems) && snapshot.gems.length === 0);
  // 宠物位置按更低频率下发,所以要等到一条带 pets 的快照
  const petSnapshot = await clientB.waitFor(
    (m) => m.type === 'world_snapshot' && Array.isArray(m.pets),
    5000,
  );
  record('snapshot carries pets', Array.isArray(petSnapshot.pets));

  const snapshotB2 = await clientB.waitFor((m) => m.type === 'world_snapshot', 3000);
  record('snapshot excludes the receiver', !snapshotB2.players.some((p) => p.uid === welcomeB.uid));

  /* ------------------------ 5. 宝石只来自首通奖励 ------------------- */
  // P2 起地图上不再生成可拾取的宝石:任何拾取请求都必须被拒绝
  const gems = snapshot.gems;
  record('map has no pickable gems', Array.isArray(gems) && gems.length === 0, `count=${gems?.length}`);

  clientA.send({ type: 'try_pick_gem', gemId: 'does-not-exist' });
  const invalidGem = await clientA.waitFor((m) => m.type === 'action_result' && m.action === 'pick_gem', 3000);
  record(
    'unknown gem is refused',
    invalidGem.ok === false && invalidGem.reason === 'gems_are_rewards_only',
    `reason=${invalidGem.reason}`,
  );

  /* ------------------------ 6. 协议字段校验 ----------------------- */
  clientA.send({
    type: 'player_input',
    seq: 1,
    input: { moveX: 5, moveZ: 0, jump: false },
    clientPreviewPos: { x: 0, y: 0, z: 0 },
  });
  const outOfRange = await clientA.waitFor((m) => m.type === 'error', 3000);
  record('out-of-range input is refused', outOfRange.code === 'input_out_of_range', `code=${outOfRange.code}`);

  clientA.send({ type: 'player_input', seq: 2, input: { moveX: 0, moveZ: 0 } });
  const badJump = await clientA.waitFor((m) => m.type === 'error', 3000);
  record('missing jump field is refused', badJump.code === 'bad_input_jump', `code=${badJump.code}`);

  /* ------------------------ 7. 瞬移作弊检测 ----------------------- */
  clientA.send({
    type: 'player_input',
    seq: 100000,
    input: { moveX: 1, moveZ: 1, jump: false },
    clientPreviewPos: { x: 500, y: 0, z: 500 },
    skinId: 'classic',
  });
  await new Promise((r) => setTimeout(r, 400));

  const afterCheat = clientA.messages.filter((m) => m.type === 'self_state').pop();
  const cheatDistance = afterCheat ? Math.hypot(afterCheat.pos.x, afterCheat.pos.z) : Infinity;
  record(
    'teleport is ignored by the server',
    cheatDistance < 45,
    `server position is ${cheatDistance.toFixed(2)} from origin`,
  );

  /* ------------------------ 8. 超频限流 --------------------------- */
  const rateSeq = 200000;
  for (let i = 0; i < 40; i += 1) {
    clientA.send({
      type: 'player_input',
      seq: rateSeq + i,
      input: { moveX: 0, moveZ: 0, jump: false },
      clientPreviewPos: afterCheat?.pos ?? { x: 0, y: 0, z: 0 },
    });
  }

  const closed = await clientA.waitClose(4000).catch(() => ({ code: -1 }));
  record('flooding inputs closes the connection', closed.code === 4002 || closed.code === 4003, `code=${closed.code}`);

  /* --------------------------- 收尾 ------------------------------ */
  clientB.close();

  const health = await api('/api/health');
  record('health check responds', health.status === 200 && health.body.ok === true, `online=${health.body.online}`);

  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log(`${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    console.log('失败项:');
    for (const item of failed) console.log(`  - ${item.name} (${item.info ?? ''})`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('测试异常:', err);
  process.exitCode = 1;
});
