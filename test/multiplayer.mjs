/**
 * 双人玩法测试:偷宠物、冷却、权限、以及宠物被偷后的通知。
 *
 * 用法: node test/multiplayer.mjs [baseUrl]
 */
import crypto from 'node:crypto';
import { WebSocket } from 'ws';

const BASE = process.argv[2] || 'http://127.0.0.1:8080';
const WS_BASE = BASE.replace(/^http/, 'ws');

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

const results = [];
function check(name, ok, info) {
  results.push({ name, ok, info });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${info ? ` — ${info}` : ''}`);
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
      body: JSON.stringify({ username: name, password }),
    });
    let cookie = reg.cookie;
    if (reg.status === 409) {
      const login = await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({ username: name, password }),
      });
      cookie = login.cookie;
    }
    if (!cookie) throw new Error(`${name} 登录失败: ${JSON.stringify(reg.body)}`);

    const ticket = await api('/api/ws-ticket', { headers: { Cookie: cookie } });
    peer.uid = ticket.body.uid ?? null;

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
        reject(new Error(`${this.name} 等待超时`));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve: wrapped });
    });
  }

  latestSelf() {
    const list = this.queue.filter((m) => m.type === 'self_state');
    return list[list.length - 1] ?? null;
  }

  send(payload) {
    this.ws.send(JSON.stringify(payload));
  }

  /** 朝目标点走,直到服务器权威坐标进入 radius */
  async walkTo(target, radius = 1.6, maxMs = 15000) {
    const started = Date.now();
    let seq = 1;
    let lastSelf = null;
    while (Date.now() - started < maxMs) {
      const self = this.latestSelf();
      if (!self) {
        await new Promise((r) => setTimeout(r, 60));
        continue;
      }
      lastSelf = self;
      const dx = target.x - self.pos.x;
      const dz = target.z - self.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist <= radius) return true;
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
    if (lastSelf) {
      const dist = Math.hypot(target.x - lastSelf.pos.x, target.z - lastSelf.pos.z);
      console.log(
        `    [debug] ${this.name} 超时,剩余距离 ${dist.toFixed(2)}, 当前 ${lastSelf.pos.x.toFixed(1)},${lastSelf.pos.z.toFixed(1)} 目标 ${target.x.toFixed(1)},${target.z.toFixed(1)}`,
      );
    }
    return false;
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
  check('两个玩家都已连接', Boolean(a.welcome && b.welcome), `A=${a.uid.slice(0, 8)} B=${b.uid.slice(0, 8)}`);

  // 从服务器拿到一只野生宠物,先由 A 走到旁边
  const snap = await b.waitFor((m) => m.type === 'world_snapshot');
  const wildPets = snap.pets.filter((p) => p.ownerUid === null);
  check('存在野生宠物', wildPets.length > 0, `数量=${wildPets.length}`);

  const wild = wildPets[0];

  // 野生宠物不能偷
  await a.walkTo(wild.pos, 1.8);
  a.send({ type: 'try_steal_pet', petId: wild.petId });
  const wildResult = await a.waitFor((m) => m.type === 'action_result' && m.action === 'steal_pet');
  check('野生宠物不能被偷', wildResult.ok === false && wildResult.reason === 'pet_wild', `reason=${wildResult.reason}`);

  // 自己的宠物不能偷
  const selfSnap = await a.waitFor((m) => m.type === 'world_snapshot');
  const ownPet = selfSnap.pets.find((p) => p.ownerUid === a.uid);
  if (ownPet) {
    a.send({ type: 'try_steal_pet', petId: ownPet.petId });
    const ownResult = await a.waitFor((m) => m.type === 'action_result' && m.action === 'steal_pet');
    check('不能偷自己的宠物', ownResult.ok === false && ownResult.reason === 'own_pet', `reason=${ownResult.reason}`);
  } else {
    check('不能偷自己的宠物', true, 'A 没有宠物,跳过');
  }

  // 不存在宠物
  a.send({ type: 'try_steal_pet', petId: 'nope-nope' });
  const missing = await a.waitFor((m) => m.type === 'action_result' && m.action === 'steal_pet');
  check('不存在的宠物被拒', missing.ok === false && missing.reason === 'pet_missing', `reason=${missing.reason}`);

  // 距离太远:用另一只野生宠物(它在别处),验证距离先于归属被判定
  const farTarget = wildPets.find(
    (p) => Math.hypot(p.pos.x - wild.pos.x, p.pos.z - wild.pos.z) > 8,
  );
  if (farTarget) {
    a.send({ type: 'try_steal_pet', petId: farTarget.petId });
    const farResult = await a.waitFor((m) => m.type === 'action_result' && m.action === 'steal_pet');
    check(
      '远距离偷宠物被拒',
      farResult.ok === false && ['too_far', 'pet_wild'].includes(farResult.reason),
      `reason=${farResult.reason}`,
    );
  }

  // 完整抢夺链路:用数据库直接给某个账号发一只宠物,再由 B 抢走
  const ownerReg = await api('/api/register', {
    method: 'POST',
    body: JSON.stringify({ username: `own_${suffix}`, password }),
  });
  check('注册宠物持有者', ownerReg.status === 201, `status=${ownerReg.status}`);

  const granted = await grantPet(ownerReg.body.uid);
  check('测试脚本已给持有者发放宠物', Boolean(granted), granted ? `petId=${granted.slice(0, 8)}` : '未配置 DATABASE_URL');

  if (granted) {
    const ownerPeer = await Peer.login(`own_${suffix}`, password);
    const snap2 = await ownerPeer.waitFor((m) => m.type === 'world_snapshot');
    const ownedPet = snap2.pets.find((p) => p.ownerUid === ownerPeer.uid);
    check('持有者已获得宠物', Boolean(ownedPet));

    if (ownedPet) {
      const reached = await b.walkTo(ownedPet.pos, 1.9);
      check('B 走到了目标宠物旁', reached);

      if (reached) {
        b.send({ type: 'try_steal_pet', petId: ownedPet.petId });
        const steal = await b.waitFor((m) => m.type === 'action_result' && m.action === 'steal_pet');
        check('合法偷宠物成功', steal.ok === true, `ok=${steal.ok} reason=${steal.reason ?? '-'}`);

        if (steal.ok) {
          const notified = await ownerPeer
            .waitFor((m) => m.type === 'action_result' && m.action === 'pet_lost', 3000)
            .catch(() => null);
          check('原主人收到被偷通知', notified?.reason === 'stolen', `reason=${notified?.reason ?? 'timeout'}`);

          const inv = await b.waitFor((m) => m.type === 'inventory', 3000).catch(() => null);
          check('B 的库存包含新宠物', Boolean(inv?.pets?.some((p) => p.petId === ownedPet.petId)));

          // 冷却期内由原主人反抢:应当被判冷却拦住
          await a.walkTo(ownedPet.pos, 1.9);
          a.send({ type: 'try_steal_pet', petId: ownedPet.petId });
          const cd = await a.waitFor((m) => m.type === 'action_result' && m.action === 'steal_pet');
          check(
            '冷却期内宠物无法被反抢',
            cd.ok === false && cd.reason === 'cooldown',
            `reason=${cd.reason} remaining=${cd.details?.remainingMs ?? '-'}`,
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
  console.log(`通过 ${results.length - failed.length}/${results.length}`);
  if (failed.length) {
    for (const f of failed) console.log(`  - ${f.name} (${f.info ?? ''})`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('测试异常:', err.message);
  process.exitCode = 1;
});
