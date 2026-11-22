/**
 * 端到端自测脚本(本地跑,不依赖浏览器)。
 *
 * 覆盖:
 *   1. 注册 / 登录 / 会话 / WS 票据
 *   2. WebSocket 握手鉴权(无 token 必须被拒)
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
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${name}${info ? ` — ${info}` : ''}`);
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

/** 极简 cookie jar,只需要 speedy_session */
function cookieFrom(headers) {
  const list = headers || [];
  for (const item of list) {
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
      ws.once('close', (code) => {
        if (!client.closedResolve) return;
        client.closedResolve({ code });
      });
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
        reject(new Error(`timeout waiting for message in ${this.name}`));
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
    body: JSON.stringify({ username: userA, password }),
  });
  record('注册用户 A', regA.status === 201 && regA.body.ok === true, `status=${regA.status}`);

  const dup = await api('/api/register', {
    method: 'POST',
    body: JSON.stringify({ username: userA, password }),
  });
  record('重复用户名被拒', dup.status === 409 && dup.body.error === 'username_taken', `status=${dup.status}`);

  const badName = await api('/api/register', {
    method: 'POST',
    body: JSON.stringify({ username: 'a', password }),
  });
  record('用户名过短被拒', badName.status === 400, `status=${badName.status}`);

  const badPass = await api('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username: userA, password: 'wrongpass' }),
  });
  record('错误密码被拒', badPass.status === 401, `status=${badPass.status}`);

  const regB = await api('/api/register', {
    method: 'POST',
    body: JSON.stringify({ username: userB, password }),
  });
  const cookieB = cookieFrom(regB.cookies);
  record('注册用户 B', regB.status === 201 && Boolean(cookieB), `status=${regB.status}`);

  const cookieA = cookieFrom(regA.cookies);
  record('登录下发 HttpOnly cookie', /HttpOnly/i.test(regA.cookies.join(';')) && Boolean(cookieA));

  const sessionA = await api('/api/session', { headers: { Cookie: cookieA } });
  record('会话校验通过', sessionA.status === 200 && sessionA.body.ok === true);

  const noSession = await api('/api/session');
  record('无 cookie 会话失败', noSession.status === 401);

  const ticketA = await api('/api/ws-ticket', { headers: { Cookie: cookieA } });
  const tokenA = ticketA.body?.token;
  record('获取 WS 票据', ticketA.status === 200 && typeof tokenA === 'string' && tokenA.includes('.'));

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
  record('伪造 token 被断开', rejectedCode === 4001, `code=${rejectedCode}`);

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
  record('无 token 被断开', noTokenCode === 4001, `code=${noTokenCode}`);

  /* --------------------------- 3. 进游戏 --------------------------- */
  const clientA = await Client.connect(`${WS_BASE}/ws?token=${encodeURIComponent(tokenA)}`, 'A');
  const clientB = await Client.connect(`${WS_BASE}/ws?token=${encodeURIComponent(tokenB)}`, 'B');

  const welcomeA = await clientA.waitFor((m) => m.type === 'welcome');
  record('welcome 包含自身状态', Boolean(welcomeA.self?.pos) && typeof welcomeA.uid === 'string');
  record('welcome 下发服务器配置', welcomeA.config?.tickRate === 20 && welcomeA.config?.broadcastRate === 10);

  const welcomeB = await clientB.waitFor((m) => m.type === 'welcome');

  /* ------------------------ 4. 输入 → 权威位移 --------------------- */
  let seq = seqStart();
  const startPos = { ...welcomeA.self.pos };

  // 持续向右移动 1.2 秒(24 包 @ 20Hz)
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

  record(
    '输入驱动服务器权威位移',
    distance > 1.5,
    `位移=${distance.toFixed(2)} 用时=${moved}ms`,
  );
  record(
    '位移不超过最大速度上限',
    distance <= 6.0 * (moved / 1000) + 1.0,
    `位移=${distance.toFixed(2)} 理论上限=${(6 * (moved / 1000)).toFixed(2)}`,
  );

  const snapshot = await clientB.waitFor((m) => m.type === 'world_snapshot', 3000);
  record(
    'B 收到 world_snapshot 且包含 A',
    Array.isArray(snapshot.players) && snapshot.players.some((p) => p.uid === welcomeA.uid),
  );
  record('快照包含宝石列表', Array.isArray(snapshot.gems) && snapshot.gems.length > 0);
  record('快照包含宠物列表', Array.isArray(snapshot.pets));

  const snapshotB2 = await clientB.waitFor((m) => m.type === 'world_snapshot', 3000);
  const selfInB = snapshotB2.players.some((p) => p.uid === welcomeB.uid);
  record('快照不包含接收者自己', !selfInB);

  /* ------------------------ 5. 宝石拾取校验 ----------------------- */
  const gems = snapshot.gems;
  const farGem = gems.find((g) => {
    const d = Math.hypot(g.pos.x - lastSelf.pos.x, g.pos.z - lastSelf.pos.z);
    return d > 5;
  });
  if (farGem) {
    clientA.send({ type: 'try_pick_gem', gemId: farGem.gemId });
    const res = await clientA.waitFor(
      (m) => m.type === 'action_result' && m.action === 'pick_gem',
      3000,
    );
    record('远距离拾取被拒绝', res.ok === false && res.reason === 'too_far', `reason=${res.reason}`);
  } else {
    record('远距离拾取被拒绝', false, '找不到足够远的宝石');
  }

  const invalidGem = await (async () => {
    clientA.send({ type: 'try_pick_gem', gemId: 'does-not-exist' });
    return clientA.waitFor((m) => m.type === 'action_result' && m.action === 'pick_gem', 3000);
  })();
  record(
    '不存在的宝石被拒绝',
    invalidGem.ok === false && invalidGem.reason === 'gem_unavailable',
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
  record('越界输入被拒', outOfRange.code === 'input_out_of_range', `code=${outOfRange.code}`);

  clientA.send({ type: 'player_input', seq: 2, input: { moveX: 0, moveZ: 0 } });
  const badJump = await clientA.waitFor((m) => m.type === 'error', 3000);
  record('缺少 jump 字段被拒', badJump.code === 'bad_input_jump', `code=${badJump.code}`);

  /* ------------------------ 7. 瞬移作弊检测 ----------------------- */
  const cheatSeq = 100000;
  clientA.send({
    type: 'player_input',
    seq: cheatSeq,
    input: { moveX: 1, moveZ: 1, jump: false },
    clientPreviewPos: { x: 500, y: 0, z: 500 },
    skinId: 'classic',
  });
  await new Promise((r) => setTimeout(r, 400));

  // 服务器不应采信 500,500
  const afterCheat = clientA.messages.filter((m) => m.type === 'self_state').pop();
  const cheatDistance = afterCheat ? Math.hypot(afterCheat.pos.x, afterCheat.pos.z) : Infinity;
  record(
    '瞬移坐标被服务器忽略',
    cheatDistance < 45,
    `服务器坐标距离原点=${cheatDistance.toFixed(2)}`,
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
  record('超频发包被断开', closed.code === 4002 || closed.code === 4003, `code=${closed.code}`);

  /* --------------------------- 收尾 ------------------------------ */
  clientB.close();

  const health = await api('/api/health');
  record('健康检查正常', health.status === 200 && health.body.ok === true, `online=${health.body.online}`);

  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log(`通过 ${results.length - failed.length}/${results.length}`);
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
