/**
 * 真实通关测试:走完 Stage 1 拿到首通宝石,再重复通关确认不再发。
 *
 * 需要 DATABASE_URL(用于核对服务端真值)。
 *
 * 用法: DATABASE_URL=... node test/stage-clear.mjs [baseUrl]
 */
import crypto from 'node:crypto';
import pg from 'pg';
import { WebSocket } from 'ws';
import { buildStageRuntime, groundHeightAt, isFallen, reachedGoal } from '../server/obby.js';

const BASE = process.argv[2] || 'http://127.0.0.1:8080';
const WS_BASE = BASE.replace(/^http/, 'ws');
const TEST_TURNSTILE_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
const DB_URL = process.env.DATABASE_URL;

/** 服务端真实关卡几何,测试用它算"该在哪起跳" */
const STAGES = buildStageRuntime();

const results = [];
function check(name, ok, info) {
  results.push({ name, ok, info });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${info ? ` - ${info}` : ''}`);
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
  const cookie = raw.map((c) => c.split(';')[0]).find((c) => c.startsWith('speedy_session=')) ?? null;
  return { status: res.status, body, cookie };
}

async function dbGems(uid) {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  try {
    const { rows } = await client.query('SELECT gems FROM player_inventory WHERE uid = $1', [uid]);
    return rows[0]?.gems ?? 0;
  } finally {
    await client.end();
  }
}

class Peer {
  constructor(name) {
    this.name = name;
    this.queue = [];
    this.waiters = [];
  }

  static async login(name, password) {
    const peer = new Peer(name);
    const reg = await api('/api/register', {
      method: 'POST',
      body: JSON.stringify({ username: name, password, turnstileToken: TEST_TURNSTILE_TOKEN }),
    });
    let cookie = reg.cookie;
    if (reg.status === 409) {
      const login = await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({ username: name, password, turnstileToken: TEST_TURNSTILE_TOKEN }),
      });
      cookie = login.cookie;
    }
    if (!cookie) throw new Error('登录失败');

    const ticket = await api('/api/ws-ticket', { headers: { Cookie: cookie } });
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${WS_BASE}/ws?token=${encodeURIComponent(ticket.body.token)}`);
      peer.ws = ws;
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
          return;
        }
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
    return peer;
  }

  waitFor(predicate, timeoutMs = 15000) {
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

  latest() {
    const list = this.queue.filter((m) => m.type === 'self_state');
    return list[list.length - 1] ?? null;
  }

  send(payload) {
    this.ws.send(JSON.stringify(payload));
  }

  /**
   * 用真实的关卡几何 + 服务端权威位置来通关。
   * 60ms 一包,低于服务端 22 包/秒的上限。
   */
  async runStage(stageId, maxMs = 40000) {
    const stage = STAGES.find((s) => s.id === stageId);
    const boxes = [...stage.solid.map((p) => p.box), ...stage.blinkers.map((b) => b.box)];
    const started = Date.now();
    let seq = Date.now();
    let stuck = 0;
    let lastZ = Infinity;
    let falls = 0;
    let lastY = Infinity;
    let inStage = false;

    while (Date.now() - started < maxMs) {
      const self = this.latest();
      if (!self) {
        await new Promise((r) => setTimeout(r, 60));
        continue;
      }

      // 刚进关时队列里还有 lobby 的旧包,给一点时间让它换过来
      if (self.location?.world !== 'obby' || self.location?.stage !== stageId) {
        if (!inStage && Date.now() - started > 5000) {
          return { ok: false, reason: '没有进入关卡', pos: self.pos };
        }
        await new Promise((r) => setTimeout(r, 60));
        continue;
      }
      inStage = true;

      // 掉落后服务端已经把玩家送回检查点,这里只统计
      if (self.pos.y < lastY - 1) falls += 1;
      lastY = self.pos.y;

      if (reachedGoal(stage, self.pos)) return { ok: true, falls };

      const candidates = boxes
        .filter((box) => (box.min.z + box.max.z) / 2 < self.pos.z - 0.4)
        .sort((a, b) => (b.min.z + b.max.z) / 2 - (a.min.z + a.max.z) / 2);

      const aim = candidates[0]
        ? {
            x: (candidates[0].min.x + candidates[0].max.x) / 2,
            y: candidates[0].max.y,
            z: (candidates[0].min.z + candidates[0].max.z) / 2,
          }
        : {
            x: 0,
            y: stage.goal.max.y,
            z: (stage.goal.min.z + stage.goal.max.z) / 2,
          };

      const dx = aim.x - self.pos.x;
      const dz = aim.z - self.pos.z;

      const standing = boxes.find(
        (box) =>
          self.pos.x >= box.min.x &&
          self.pos.x <= box.max.x &&
          self.pos.z >= box.min.z &&
          self.pos.z <= box.max.z &&
          Math.abs(self.pos.y - box.max.y) < 0.2,
      );
      const edgeGap = standing ? self.pos.z - standing.min.z : 0;
      const jump = self.onGround === true && standing !== undefined && edgeGap <= 0.45 && dz < 0;

      if (Math.abs(self.pos.z - lastZ) < 0.1) stuck += 1;
      else stuck = 0;
      lastZ = self.pos.z;
      if (stuck > 120) return { ok: false, reason: '卡住了', pos: self.pos };

      this.send({
        type: 'player_input',
        seq: seq++,
        input: {
          moveX: Math.abs(dx) < 0.2 ? 0 : Math.sign(dx),
          moveZ: Math.abs(dz) < 0.6 ? 0 : Math.sign(dz),
          jump,
        },
        clientPreviewPos: { ...self.pos },
      });
      await new Promise((r) => setTimeout(r, 60));
    }

    return { ok: false, reason: '超时', pos: this.latest()?.pos };
  }

  close() {
    try {
      this.ws.close(1000, 'done');
    } catch {
      /* ignore */
    }
  }
}

async function main() {
  if (!DB_URL) {
    console.log('需要 DATABASE_URL 才能核对服务端真值');
    process.exitCode = 1;
    return;
  }

  const suffix = crypto.randomBytes(3).toString('hex');
  const password = 'TestPass123';
  const a = await Peer.login(`c_a_${suffix}`, password);

  const gemsStart = await dbGems(a.uid);
  check('初始宝石为 15', gemsStart === 15, `gems=${gemsStart}`);

  // 进入 Stage 1,用真实的关卡几何一路走到 goal
  a.send({ type: 'enter_stage', stage: 1 });
  const enter = await a.waitFor((m) => m.type === 'action_result' && m.action === 'enter_stage', 8000);
  check('进入 Stage 1', enter.ok === true, `ok=${enter.ok}`);

  const run = await a.runStage(1);
  check('走完 Stage 1 的所有平台', run.ok, run.ok ? `掉了 ${run.falls} 次` : `${run.reason} @ ${JSON.stringify(run.pos)}`);

  // 等通关回调
  const clear = run.ok
    ? await a
        .waitFor((m) => m.type === 'action_result' && m.action === 'stage_clear', 12000)
        .catch(() => null)
    : null;

  check('收到通关结果', Boolean(clear), clear ? `stage=${clear.stage}` : 'timeout');

  if (clear) {
    check('首通标记为 true', clear.firstTime === true);
    check(
      '首通发放宝石',
      clear.totalGems > 0 && clear.stageGems > 0,
      `stageGems=${clear.stageGems} milestone=${clear.milestoneGems} total=${clear.totalGems}`,
    );

    const gemsAfter = await dbGems(a.uid);
    check(
      '宝石已落库',
      gemsAfter === gemsStart + clear.totalGems,
      `${gemsStart} + ${clear.totalGems} = ${gemsAfter}`,
    );

    // --- 重复通关:不再发宝石 ---
    a.send({ type: 'exit_stage' });
    await a.waitFor((m) => m.type === 'action_result' && m.action === 'exit_stage', 5000);
    a.send({ type: 'enter_stage', stage: 1 });
    await a.waitFor((m) => m.type === 'action_result' && m.action === 'enter_stage', 8000);

    const run2 = await a.runStage(1);
    check('重复通关也能走到 goal', run2.ok, run2.ok ? `掉了 ${run2.falls} 次` : `${run2.reason}`);

    const clear2 = await a
      .waitFor((m) => m.type === 'action_result' && m.action === 'stage_clear', 12000)
      .catch(() => null);

    if (clear2) {
      check('重复通关仍返回结果', true);
      check('重复通关 firstTime=false', clear2.firstTime === false);
      check(
        '重复通关不再发宝石',
        clear2.totalGems === 0,
        `total=${clear2.totalGems}`,
      );
      const gemsFinal = await dbGems(a.uid);
      check(
        '重复通关后宝石不变',
        gemsFinal === gemsAfter,
        `${gemsAfter} -> ${gemsFinal}`,
      );
    } else {
      check('重复通关仍返回结果', false, 'timeout');
    }
  }

  a.close();

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
    console.error('测试异常:', err.message);
    process.exitCode = 1;
  })
  .finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 300).unref());
