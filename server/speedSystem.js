/**
 * Speed 成长、转生与跑步机。
 *
 * 全部在服务端算。客户端只收到数值用于展示,任何上传的 speed 都被忽略。
 */
import { PHYSICS } from './config.js';
import { SPEED, TREADMILL } from './gameConfig.js';

/** 玩家当前速度向量长度。 */
export function speedMagnitude(player) {
  return Math.hypot(player.vel.x, player.vel.y, player.vel.z);
}

/** 玩家是否处于"正在移动"状态。 */
export function isMoving(player) {
  return speedMagnitude(player) > SPEED.movingThreshold;
}

/**
 * 找玩家当前站的跑步机。
 *
 * 只按水平位置 + 高度容差判定:必须真的站在跑步机上,站在旁边蹭不到加成。
 * 时段过期的跑步机不算。
 */
export function treadmillUnder(player, nowMs) {
  const feet = player.pos;
  for (const machine of TREADMILL.list) {
    if (feet.x < machine.min.x || feet.x > machine.max.x) continue;
    if (feet.z < machine.min.z || feet.z > machine.max.z) continue;

    // 必须贴在跑步机表面高度附近
    if (Math.abs(feet.y - machine.max.y) > TREADMILL.heightTolerance) continue;

    const until = player.treadmillUntil?.get(machine.id) ?? 0;
    if (nowMs >= until) continue;

    return machine;
  }
  return null;
}

/**
 * 每个 tick 给玩家结算 speed 增长。
 *
 * @param {object} player 服务端权威玩家状态
 * @param {number} nowMs
 * @returns {number} 本 tick 实际增加的 speed
 */
export function gainSpeed(player, nowMs) {
  if (!isMoving(player)) return 0;

  let gain = SPEED.baseGainPerTick * player.multiplier;

  const machine = treadmillUnder(player, nowMs);
  if (machine) gain *= machine.bonus;

  player.speed += gain;
  player.speedTotal += gain;
  return gain;
}

/**
 * 校验并执行转生。
 *
 * @returns {{ok: true, rebirth: number, multiplier: number} | {ok: false, reason: string, remaining?: number}}
 */
export function tryRebirth(player) {
  if (player.speed < SPEED.rebirthMinSpeed) {
    return {
      ok: false,
      reason: 'below_min_speed',
      remaining: Math.ceil(SPEED.rebirthMinSpeed - player.speed),
    };
  }

  player.rebirth += 1;
  player.multiplier *= SPEED.rebirthMultiplierGain;
  player.speed = 0;

  // 回到 lobby 出生点,并清空关卡位置
  player.pos.x = SPEED.rebirthSpawn.x;
  player.pos.y = SPEED.rebirthSpawn.y;
  player.pos.z = SPEED.rebirthSpawn.z;
  player.vel.x = 0;
  player.vel.y = 0;
  player.vel.z = 0;
  player.onGround = true;

  return { ok: true, rebirth: player.rebirth, multiplier: player.multiplier };
}

/**
 * 购买跑步机时段。宝石不足则拒绝。
 *
 * @returns {{ok: true, treadmillId: string, untilMs: number, gems: number} | {ok: false, reason: string, need?: number}}
 */
export function tryBuyTreadmill(player, treadmillId, nowMs) {
  const machine = TREADMILL.list.find((m) => m.id === treadmillId);
  if (!machine) return { ok: false, reason: 'unknown_treadmill' };

  if (player.gems < machine.gemPrice) {
    return { ok: false, reason: 'not_enough_gems', need: machine.gemPrice };
  }

  player.gems -= machine.gemPrice;

  // 已有时段则续期,不覆盖
  const current = player.treadmillUntil.get(machine.id) ?? 0;
  const base = Math.max(current, nowMs);
  const until = base + TREADMILL.sessionMs;
  player.treadmillUntil.set(machine.id, until);

  return { ok: true, treadmillId: machine.id, untilMs: until, gems: player.gems };
}

/** 玩家当前有效的跑步机时段,用于下发 HUD。 */
export function treadmillState(player, nowMs) {
  const out = {};
  for (const machine of TREADMILL.list) {
    const until = player.treadmillUntil?.get(machine.id) ?? 0;
    out[machine.id] = until > nowMs ? until : 0;
  }
  return out;
}

/** 重力/地面常量,给需要判断离地的模块复用。 */
export const GROUND_Y = PHYSICS.groundY;
