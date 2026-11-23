/**
 * P3 跑步机:权限、倍率、时长。
 *
 * 覆盖三件容易出错的事:
 *   1. 站在踏板上但没买 → 拿不到倍率(服务端权威,不是客户端说了算)
 *   2. 买了 → 立刻生效,倍率与配置一致
 *   3. 时长耗尽 → 倍率立刻消失
 *
 * 用法: DATABASE_URL=... node test/treadmill.mjs
 */
import { SPEED, TREADMILL } from '../server/gameConfig.js';
import {
  gainSpeed,
  treadmillContext,
  treadmillStandingOn,
  treadmillUnder,
  tryBuyTreadmill,
  treadmillState,
} from '../server/speedSystem.js';
import { PHYSICS } from '../server/config.js';

const results = [];
function check(name, ok, info) {
  results.push({ name, ok, info });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${info ? ` - ${info}` : ''}`);
}

const machine = TREADMILL.list[0];
const now = Date.now();

/** 造一个正站在踏板上的玩家 */
function playerOnPad(extra = {}) {
  return {
    pos: {
      x: (machine.min.x + machine.max.x) / 2,
      y: machine.max.y,
      z: (machine.min.z + machine.max.z) / 2,
    },
    vel: { x: PHYSICS.maxSpeed, y: 0, z: 0 },
    speed: 0,
    speedTotal: 0,
    multiplier: 1,
    gems: 100,
    treadmillUntil: new Map(),
    ...extra,
  };
}

/* ---------------------------- 1. 站位判定 ---------------------------- */
{
  const on = playerOnPad();
  check('站在踏板上能被识别', treadmillStandingOn(on)?.id === machine.id);

  const off = playerOnPad();
  off.pos.x = machine.max.x + 3;
  check('站在旁边不算', treadmillStandingOn(off) === null);

  // 站在踏板上方悬空(跳跃中)不该算
  const above = playerOnPad();
  above.pos.y = machine.max.y + 2.5;
  check('离地太高不算', treadmillStandingOn(above) === null);

  // 脚底明显低于踏板(掉到踏板内部/下方)不该算
  const sunk = playerOnPad();
  sunk.pos.y = machine.max.y - 1.5;
  check('掉到踏板下方不算', treadmillStandingOn(sunk) === null);
}

/* ------------------------ 2. 没买就没有倍率 ------------------------- */
{
  const p = playerOnPad();
  check('未购买时 treadmillUnder 为 null', treadmillUnder(p, now) === null);

  const base = gainSpeed(p, now);
  const expected = SPEED.baseGainPerTick * p.multiplier;
  check(
    '未购买时只吃基础增速',
    Math.abs(base - expected) < 1e-9,
    `${base.toFixed(4)} == ${expected.toFixed(4)}`,
  );

  const ctx = treadmillContext(p, now);
  check(
    '未购买时下发的是"可购买"提示',
    ctx?.id === machine.id && ctx.active === false && ctx.gemPrice === machine.gemPrice,
    `active=${ctx?.active}`,
  );
}

/* ----------------------- 3. 买了立刻有倍率 ------------------------- */
{
  const p = playerOnPad();
  const buy = tryBuyTreadmill(p, machine.id, now);
  check('购买成功', buy.ok === true, buy.ok ? '' : buy.reason);
  check('购买扣掉正确的宝石', p.gems === 100 - machine.gemPrice, `gems=${p.gems}`);
  check(
    '购买时长等于配置',
    buy.untilMs === now + TREADMILL.sessionMs,
    `${buy.untilMs - now}ms`,
  );

  check('购买后 treadmillUnder 命中', treadmillUnder(p, now)?.id === machine.id);

  const boosted = gainSpeed(p, now);
  const base = SPEED.baseGainPerTick * p.multiplier;
  check(
    `倍率等于配置的 ${machine.bonus}×`,
    Math.abs(boosted - base * machine.bonus) < 1e-9,
    `${boosted.toFixed(4)} == ${(base * machine.bonus).toFixed(4)}`,
  );

  const ctx = treadmillContext(p, now);
  check('已购买时下发 active=true', ctx?.active === true && ctx.untilMs > now);

  // 续期是叠加,不是覆盖
  const buy2 = tryBuyTreadmill(p, machine.id, now);
  check(
    '再次购买是续期而不是重置',
    buy2.ok && buy2.untilMs === now + TREADMILL.sessionMs * 2,
    `${buy2.untilMs - now}ms`,
  );
}

/* --------------------- 4. 时长耗尽立刻失效 ------------------------ */
{
  const p = playerOnPad();
  tryBuyTreadmill(p, machine.id, now);

  const expired = now + TREADMILL.sessionMs + 1;
  check('到期后 treadmillUnder 为 null', treadmillUnder(p, expired) === null);

  const gain = gainSpeed(p, expired);
  const base = SPEED.baseGainPerTick * p.multiplier;
  check(
    '到期后回到基础增速',
    Math.abs(gain - base) < 1e-9,
    `${gain.toFixed(4)} == ${base.toFixed(4)}`,
  );

  check('到期后 HUD 时长归零', treadmillState(p, expired)[machine.id] === 0);
}

/* ------------------------ 5. 三台机器互不干扰 ---------------------- */
{
  const p = playerOnPad();
  const [first, second] = TREADMILL.list;
  tryBuyTreadmill(p, first.id, now);

  const state = treadmillState(p, now);
  check(
    '只买了第一台,另外两台是 0',
    state[first.id] > now && state[second.id] === 0,
    JSON.stringify(state),
  );

  // 走到第二台上:没买就没有倍率
  p.pos.x = (second.min.x + second.max.x) / 2;
  p.pos.z = (second.min.z + second.max.z) / 2;
  check('换到没买的机器后没有倍率', treadmillUnder(p, now) === null);
}

/* -------------------------- 6. 宝石不足 --------------------------- */
{
  const p = playerOnPad({ gems: 0 });
  const worst = TREADMILL.list[TREADMILL.list.length - 1];
  const buy = tryBuyTreadmill(p, worst.id, now);
  check(
    '宝石不足时购买被拒',
    buy.ok === false && buy.reason === 'not_enough_gems',
    `reason=${buy.reason} need=${buy.need}`,
  );
  check('被拒时不扣宝石', p.gems === 0);

  const unknown = tryBuyTreadmill(p, 'no-such-treadmill', now);
  check('未知机器被拒', unknown.ok === false && unknown.reason === 'unknown_treadmill');
}

const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  for (const f of failed) console.log(`  - ${f.name} (${f.info ?? ''})`);
  process.exitCode = 1;
}
