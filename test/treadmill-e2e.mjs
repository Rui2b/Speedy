/**
 * P3 跑步机端到端:真的走到踏板上,验证权限与倍率。
 *
 * 单测(test/treadmill.mjs)覆盖纯逻辑,这里覆盖"真人从出生点走过去"这条路径:
 *   1. 站上去但没买 → 服务端下发 active=false,只有基础增速
 *   2. 买了 → active=true,增速比正好等于配置倍率
 *
 * 用法: node test/treadmill-e2e.mjs [baseUrl]
 */
import { WebSocket } from 'ws';
import { TREADMILL } from '../server/gameConfig.js';

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
  const cookie = raw.map((c) => c.split(';')[0]).find((c) => c.startsWith('speedy_session=')) ?? null;
  return { status: res.status, body, cookie };
}

const machine = TREADMILL.list[0];
const padX = (machine.min.x + machine.max.x) / 2;
const padZ = (machine.min.z + machine.max.z) / 2;

async function main() {
  const name = `tm_${Math.random().toString(16).slice(2, 8)}`;
  const reg = await api('/api/register', {
    method: 'POST',
    body: JSON.stringify({ username: name, password: 'TestPass123', turnstileToken: TEST_TURNSTILE_TOKEN }),
  });
  if (!reg.cookie) throw new Error(`注册失败: ${reg.status} ${JSON.stringify(reg.body)}`);

  const ticket = await api('/api/ws-ticket', { headers: { Cookie: reg.cookie } });
  const ws = new WebSocket(`${WS_BASE}/ws?token=${encodeURIComponent(ticket.body.token)}`);

  let self = null;
  let progress = null;
  const actions = [];
  /** 每次 progress 都记一条,用来精确统计"在踏板上"的时间 */
  const samples = [];

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
      return;
    }
    if (msg.type === 'self_state') self = msg;
    if (msg.type === 'progress') {
      progress = msg;
      samples.push({
        t: Date.now(),
        speed: msg.speed,
        onPad: msg.treadmillAt?.id === machine.id,
        active: msg.treadmillAt?.active === true,
      });
    }
    if (msg.type === 'action_result') actions.push(msg);
  });

  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  await new Promise((r) => setTimeout(r, 3200));

  let seq = 1;
  const send = (moveX, moveZ) =>
    ws.send(
      JSON.stringify({
        type: 'player_input',
        seq: seq++,
        input: { moveX, moveZ, jump: false },
        clientPreviewPos: { ...(self?.pos ?? { x: 0, y: 0, z: 0 }) },
      }),
    );

  /**
   * 单轴导航。距离远全速、近一点半速、很近了松手靠摩擦停下。
   * 直接斜着开会冲过头,所以一次只走一个轴。
   */
  const axis = async (key, target, iterations = 300) => {
    for (let i = 0; i < iterations; i += 1) {
      const p = self?.pos;
      if (!p) {
        await new Promise((r) => setTimeout(r, 55));
        continue;
      }
      const d = target - p[key];
      if (Math.abs(d) < 0.25) break;
      const magnitude = Math.abs(d) > 3 ? 1 : Math.abs(d) > 1.2 ? 0.4 : 0;
      const v = Math.sign(d) * magnitude;
      if (key === 'x') send(v, 0);
      else send(0, v);
      await new Promise((r) => setTimeout(r, 55));
    }
    for (let i = 0; i < 20; i += 1) {
      send(0, 0);
      await new Promise((r) => setTimeout(r, 55));
    }
  };

  /** 小幅左右摆动:保持"在移动"以便吃到增速,又不会漂出踏板 */
  const measure = async (ms = 1600) => {
    samples.length = 0;
    const started = Date.now();
    let dir = 1;
    while (Date.now() - started < ms) {
      send(dir * 0.12, 0);
      await new Promise((r) => setTimeout(r, 200));
      dir = -dir;
    }
    for (let i = 0; i < 10; i += 1) {
      send(0, 0);
      await new Promise((r) => setTimeout(r, 55));
    }
    await new Promise((r) => setTimeout(r, 300));

    // 只统计采样两端都在踏板上的区间,避免把漂出去的时间算进倍率
    let onPadGain = 0;
    let onPadMs = 0;
    let totalGain = 0;
    let totalMs = 0;
    for (let i = 1; i < samples.length; i += 1) {
      const a = samples[i - 1];
      const b = samples[i];
      const dt = b.t - a.t;
      const ds = b.speed - a.speed;
      totalMs += dt;
      totalGain += ds;
      if (a.active && b.active) {
        onPadMs += dt;
        onPadGain += ds;
      }
    }
    return {
      onPadGain,
      onPadMs,
      totalGain,
      totalMs,
      onPadRate: onPadMs > 0 ? onPadGain / (onPadMs / 1000) : 0,
      totalRate: totalMs > 0 ? totalGain / (totalMs / 1000) : 0,
    };
  };

  // --- 走到踏板上 ---
  await axis('z', padZ);
  await axis('x', padX);

  check('站到踏板上被服务端识别', progress?.treadmillAt?.id === machine.id, JSON.stringify(progress?.treadmillAt));
  check('未购买时 active=false', progress?.treadmillAt?.active === false);
  check(
    '玩家真的踩在踏板顶面',
    Math.abs((self?.pos?.y ?? 0) - machine.max.y) < 0.05,
    `y=${self?.pos?.y} top=${machine.max.y}`,
  );

  // --- 没买:只有基础增速 ---
  const beforeBuy = await measure();
  check(
    '未购买时没有倍率',
    beforeBuy.onPadRate <= beforeBuy.totalRate * 1.05 + 1e-6,
    `onPad=${beforeBuy.onPadRate.toFixed(3)}/s total=${beforeBuy.totalRate.toFixed(3)}/s`,
  );

  // --- 购买 ---
  ws.send(JSON.stringify({ type: 'buy_treadmill', treadmillId: machine.id }));
  await new Promise((r) => setTimeout(r, 1500));
  const buy = actions.find((a) => a.action === 'buy_treadmill');
  check('购买成功', buy?.ok === true, JSON.stringify(buy));
  check('购买后 active=true', progress?.treadmillAt?.active === true);
  check('扣掉正确的宝石', progress?.gems === 15 - machine.gemPrice, `gems=${progress?.gems}`);

  // 购买后可能已经漂到边上,重新对齐一次
  await axis('z', padZ);
  await axis('x', padX);

  // --- 买了:增速比等于配置倍率 ---
  const afterBuy = await measure();
  const beforeRate = beforeBuy.onPadMs > 0 ? beforeBuy.onPadRate : beforeBuy.totalRate;
  const ratio = beforeRate > 0 ? afterBuy.onPadRate / beforeRate : 0;
  check(
    `倍率为配置的 ${machine.bonus}×`,
    Math.abs(ratio - machine.bonus) < 0.4,
    `实测 ${ratio.toFixed(2)}× (基础 ${beforeRate.toFixed(3)}/s → ${afterBuy.onPadRate.toFixed(3)}/s)`,
  );

  ws.close();

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
