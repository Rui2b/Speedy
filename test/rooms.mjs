/**
 * P1 房间系统测试:创建者记录、删除权限、公共大厅保护、房内玩家被移出。
 *
 * 用法: node test/rooms.mjs [baseUrl]
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

  static async login(name, password, roomId = '') {
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
    if (!cookie) throw new Error(`${name} 登录失败`);

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

  send(payload) {
    this.ws.send(JSON.stringify(payload));
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
  const password = 'TestPass123';
  const roomId = `room-${suffix}`;

  // A 创建房间
  const a = await Peer.login(`r_a_${suffix}`, password, roomId);
  check('A 进入了自建房间', a.roomId === roomId, `room=${a.roomId}`);

  let roomsMsg = await (async () => {
    a.send({ type: 'request_rooms' });
    return a.waitFor((m) => m.type === 'rooms', 4000);
  })();
  let row = roomsMsg.rooms.find((r) => r.id === roomId);
  check('房间列表带创建者', Boolean(row?.creator), `creator=${row?.creator}`);
  check('房间记录创建者 uid', row?.createdByUid === a.uid);
  check('公共大厅标记为 public', roomsMsg.rooms.some((r) => r.isPublic === true));

  // B 加入同一房间
  const b = await Peer.login(`r_b_${suffix}`, password, roomId);
  check('B 加入了同一房间', b.roomId === roomId, `room=${b.roomId}`);

  // B 尝试删除 → 拒绝
  b.send({ type: 'delete_room', roomId });
  const notOwner = await b.waitFor(
    (m) => m.type === 'action_result' && m.action === 'delete_room',
    4000,
  );
  check(
    '非创建者不能删除房间',
    notOwner.ok === false && notOwner.reason === 'not_owner',
    `reason=${notOwner.reason}`,
  );

  // A 删除自己当前所在的房间 → 拒绝
  a.send({ type: 'delete_room', roomId });
  const current = await a.waitFor(
    (m) => m.type === 'action_result' && m.action === 'delete_room',
    4000,
  );
  check(
    '不能删除自己正在里面的房间',
    current.ok === false && current.reason === 'cannot_delete_current',
    `reason=${current.reason}`,
  );

  // 尝试删除公共大厅 → 拒绝
  a.send({ type: 'delete_room', roomId: 'lobby-1' });
  const publicDel = await a.waitFor(
    (m) => m.type === 'action_result' && m.action === 'delete_room',
    4000,
  );
  check(
    '公共大厅不能删除',
    publicDel.ok === false && publicDel.reason === 'cannot_delete_public',
    `reason=${publicDel.reason}`,
  );

  // A 先回 lobby,再删房间
  a.send({ type: 'join_room', roomId: 'lobby-1' });
  await a.waitFor((m) => m.type === 'action_result' && m.action === 'join_room', 5000);

  a.send({ type: 'delete_room', roomId });
  const deleted = await a.waitFor(
    (m) => m.type === 'action_result' && m.action === 'delete_room',
    5000,
  );
  check('创建者可以删除房间', deleted.ok === true, `movedTo=${deleted.movedTo}`);

  // B 应当收到 room_closed 并被送回 lobby
  const closed = await b.waitFor((m) => m.type === 'room_closed', 5000).catch(() => null);
  check(
    '房内玩家收到房间关闭通知',
    closed?.roomId === roomId && closed?.movedTo === 'lobby-1',
    `room=${closed?.roomId} movedTo=${closed?.movedTo}`,
  );

  // 房间确实没了。删除后服务端已经广播过一次新列表,
  // 所以这里要丢掉旧的 rooms 包,再主动请求一次。
  a.queue = a.queue.filter((m) => m.type !== 'rooms');
  a.send({ type: 'request_rooms' });
  const after = await a.waitFor((m) => m.type === 'rooms', 4000);
  check(
    '房间已从列表移除',
    !after.rooms.some((r) => r.id === roomId),
    `rooms=${after.rooms.map((r) => r.id).join(',')}`,
  );

  // 不存在的房间
  a.send({ type: 'delete_room', roomId: 'nope-nope' });
  const missing = await a.waitFor(
    (m) => m.type === 'action_result' && m.action === 'delete_room',
    4000,
  );
  check(
    '删除不存在的房间被拒',
    missing.ok === false && missing.reason === 'room_not_found',
    `reason=${missing.reason}`,
  );

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

main()
  .catch((err) => {
    console.error('测试异常:', err.message);
    process.exitCode = 1;
  })
  .finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 300).unref());
