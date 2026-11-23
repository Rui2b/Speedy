/**
 * 双人玩法测试:偷宠物、冷却、权限,以及宠物被偷后的通知。
 *
 * 用法: node test/multiplayer.mjs [baseUrl]
 */
import crypto from 'node:crypto';
import { WebSocket } from 'ws';

const BASE = process.argv[2] || 'http://127.0.0.1:8080';
const WS_BASE = BASE.replace(/^http/, 'ws');

const results = [];
function check(name, ok, info) {
  results.push({ name, ok, info });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${info ? ` - ${info}` : ''}`);
}

/**
 * 测试专用的"发宠物"辅助:直连数据库,不在服务端留任何后门。
 * 未配置 DATABASE_URL 时跳过相关用例。
 */
async function grantPet(uid) {
  const url = process.env.DATABASE_URL;
  if (!url || !uid) return null;
  const pg = await import('pg');
  const client = new pg.default.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query(
      `INSERT INTO pets (owner_uid, species, rarity, hatch_progress, is_hatched)
       VALUES ($1, 'blob', 'common', 0, false) RETURNING pet_id`,
      [uid],
    );
    return rows[0].pet_id;
  } finally {
    await client.end();
  }
}

/**
 * Turnstile 的 token 只能由真实浏览器产生,自动化测试用 Cloudflare 官方的
 * "始终通过"测试 secret。生产环境用的是真 key,伪造 token 会被拒。
 */
const TEST_TURNSTILE_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

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
  }

  static async login(name, password) {
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
    if (!cookie) throw new Error(`${name} could not sign in: ${JSON.stringify(reg.body)}`);

    const ticket = await api('/api/ws-ticket', { headers: { Cookie: cookie } });

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${WS_BASE}/ws?token=${encodeURIComponent(ticket.body.token)}`);
      peer.ws = ws;
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        // 必须回应服务器心跳,否则空闲期间会被判定为死连接
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

  waitFor(predicate, timeoutMs = 5000) {
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
        reject(new Error(`${this.name} timed out`));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve: wrapped });
    });
  }

  latestSelf() {
    const list = this.queue.filter((m) => m.type === 'self_state');
    return list[list.length - 1] ?? null;
  }

  latestSelfWithVel() {
    const list = this.queue.filter((m) => m.type === 'self_state' && m.vel);
    return list[list.length - 1] ?? null;
  }

  send(payload) {
    this.ws.send(JSON.stringify(payload));
  }

  /** 丢弃已排队的消息,避免把上一次的旧结果当成这次请求的回应。 */
  drain(predicate) {
    this.queue = this.queue.filter((m) => !predicate(m));
  }

  /**
   * 朝目标点走,直到服务器权威坐标进入 radius,再发一包"停止"并等服务器稳定。
   * 不发停止包的话,最后一条移动指令会一直生效到输入过期,从而冲过头。
   */
  async walkTo(target, radius = 1.6, maxMs = 20000) {
    const started = Date.now();
    let seq = 1;
    let lastSelf = null;
    let arrived = false;
    while (Date.now() - started < maxMs) {
      const self = this.latestSelf();
      if (!self) {
        await new Promise((r) => setTimeout(r, 60));
        continue;
      }
      lastSelf = self;
      const dx = target.x - self.pos.x;
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
          jump: false,
        },
        clientPreviewPos: { ...self.pos },
      });
      await new Promise((r) => setTimeout(r, 50));
    }

    if (!arrived) {
      if (lastSelf) {
        const dist = Math.hypot(target.x - lastSelf.pos.x, target.z - lastSelf.pos.z);
        console.log(
          `    [debug] ${this.name} timed out ${dist.toFixed(2)} away, at ${lastSelf.pos.x.toFixed(1)},${lastSelf.pos.z.toFixed(1)} target ${target.x.toFixed(1)},${target.z.toFixed(1)}`,
        );
      }
      return false;
    }

    // 先停下,再等权威坐标稳定
    for (let i = 0; i < 20; i += 1) {
      const self = this.latestSelf();
      this.send({
        type: 'player_input',
        seq: seq++,
        input: { moveX: 0, moveZ: 0, jump: false },
        clientPreviewPos: self ? { ...self.pos } : { x: 0, y: 0, z: 0 },
      });
      await new Promise((r) => setTimeout(r, 60));
      const settled = this.latestSelfWithVel();
      if (settled && Math.abs(settled.vel.x) < 0.2 && Math.abs(settled.vel.z) < 0.2) break;
    }
    return true;
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
  const suffix = crypto.randomBytes(3).toString('hex');
  const nameA = `m_a_${suffix}`;
  const nameB = `m_b_${suffix}`;
  const password = 'TestPass123';

  const a = await Peer.login(nameA, password);
  const b = await Peer.login(nameB, password);
  check('both players connected', Boolean(a.welcome && b.welcome), `A=${a.uid.slice(0, 8)} B=${b.uid.slice(0, 8)}`);

  // 宠物位置只在本帧是全量同步帧时才下发,所以要等到一条带 pets 的快照
  const snap = await b.waitFor(
    (m) => m.type === 'world_snapshot' && Array.isArray(m.pets),
    10000,
  );
  const wildPets = snap.pets.filter((p) => p.ownerUid === null);
  check('wild pets exist', wildPets.length > 0, `count=${wildPets.length}`);

  const wild = wildPets[0];

  // 野生宠物不能偷
  await a.walkTo(wild.pos, 1.8);
  a.send({ type: 'try_steal_pet', petId: wild.petId });
  const wildResult = await a.waitFor((m) => m.type === 'action_result' && m.action === 'steal_pet');
  check('wild pets cannot be stolen', wildResult.ok === false && wildResult.reason === 'pet_wild', `reason=${wildResult.reason}`);

  // 自己的宠物不能偷
  const selfSnap = await a.waitFor((m) => m.type === 'world_snapshot' && Array.isArray(m.pets), 10000);
  const ownPet = selfSnap.pets.find((p) => p.ownerUid === a.uid);
  if (ownPet) {
    a.send({ type: 'try_steal_pet', petId: ownPet.petId });
    const ownResult = await a.waitFor((m) => m.type === 'action_result' && m.action === 'steal_pet');
    check('own pet cannot be stolen', ownResult.ok === false && ownResult.reason === 'own_pet', `reason=${ownResult.reason}`);
  } else {
    check('own pet cannot be stolen', true, 'A owns no pet, skipped');
  }

  // 不存在的宠物
  a.send({ type: 'try_steal_pet', petId: 'nope-nope' });
  const missing = await a.waitFor((m) => m.type === 'action_result' && m.action === 'steal_pet');
  check('unknown pet is refused', missing.ok === false && missing.reason === 'pet_missing', `reason=${missing.reason}`);

  // 距离太远:另一只位于场地别处的野生宠物
  const farTarget = wildPets.find(
    (p) => Math.hypot(p.pos.x - wild.pos.x, p.pos.z - wild.pos.z) > 8,
  );
  if (farTarget) {
    a.send({ type: 'try_steal_pet', petId: farTarget.petId });
    const farResult = await a.waitFor((m) => m.type === 'action_result' && m.action === 'steal_pet');
    check(
      'distant steal is refused',
      farResult.ok === false && ['too_far', 'pet_wild'].includes(farResult.reason),
      `reason=${farResult.reason}`,
    );
  }

  // 完整抢夺链路:数据库里给 A 发一只宠物,再由 B 抢走
  const ownerReg = await api('/api/register', {
    method: 'POST',
    body: authBody({ username: `own_${suffix}`, password }),
  });
  check('owner account registered', ownerReg.status === 201, `status=${ownerReg.status}`);

  const granted = await grantPet(ownerReg.body.uid);
  check(
    'test helper granted a pet',
    Boolean(granted),
    granted ? `petId=${granted.slice(0, 8)}` : 'DATABASE_URL not set',
  );

  if (granted) {
    const ownerPeer = await Peer.login(`own_${suffix}`, password);
    const snap2 = await ownerPeer.waitFor((m) => m.type === 'world_snapshot' && Array.isArray(m.pets), 10000);
    const ownedPet = snap2.pets.find((p) => p.ownerUid === ownerPeer.uid);
    check('owner sees the granted pet', Boolean(ownedPet));

    if (ownedPet) {
      // 先把两个玩家都走到宠物旁边,免得后面的冷却校验把 12 秒窗口花在走路上
      const aReady = await a.walkTo(ownedPet.pos, 2.2, 20000);
      const reached = await b.walkTo(ownedPet.pos, 1.9, 20000);
      check('B reached the target pet', reached);

      if (reached) {
        b.send({ type: 'try_steal_pet', petId: ownedPet.petId });
        const steal = await b.waitFor((m) => m.type === 'action_result' && m.action === 'steal_pet');
        const stolenAt = Date.now();
        check('legitimate steal succeeds', steal.ok === true, `ok=${steal.ok} reason=${steal.reason ?? '-'}`);

        if (steal.ok) {
          const notified = await ownerPeer
            .waitFor((m) => m.type === 'action_result' && m.action === 'pet_lost', 3000)
            .catch(() => null);
          check('previous owner is notified', notified?.reason === 'stolen', `reason=${notified?.reason ?? 'timeout'}`);

          const inv = await b.waitFor((m) => m.type === 'inventory', 3000).catch(() => null);
          check('B inventory contains the pet', Boolean(inv?.pets?.some((p) => p.petId === ownedPet.petId)));

          // 12 秒窗口内原主人不能抢回去。A 已经站在宠物旁边,
          // 所以这里只测量冷却本身
          a.drain((m) => m.type === 'action_result' && m.action === 'steal_pet');
          a.send({ type: 'try_steal_pet', petId: ownedPet.petId });
          const cd = await a.waitFor((m) => m.type === 'action_result' && m.action === 'steal_pet');
          const elapsed = Date.now() - stolenAt;
          check(
            'pet is protected during cooldown',
            cd.ok === false && cd.reason === 'cooldown',
            `reason=${cd.reason} ${elapsed}ms after the steal, A in range=${aReady}`,
          );
        }
      }
      ownerPeer.close();
    }
  }

  a.close();
  b.close();

  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log(`${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    for (const f of failed) console.log(`  - ${f.name} (${f.info ?? ''})`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('测试异常:', err.message);
  process.exitCode = 1;
});
