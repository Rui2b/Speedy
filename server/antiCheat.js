/**
 * 服务器权威校验 & 防作弊。
 *
 *   1. 移动校验(位移阈值 + 持续漂移)
 *   2. 资源操作校验(距离 / 冷却 / 归属)
 *   3. Session Token 校验(在 auth.js,这里只做绑定检查)
 *   4. 单连接限流(每秒输入包 / 操作包上限)
 *   5. 作弊日志
 */
import { ANTI_CHEAT, PHYSICS, RULES, TIMING } from './config.js';
import { logCheat } from './logger.js';
import { planarDistance } from './world.js';

/**
 * 固定窗口限流器。每 1 秒重置一次,超额直接拒绝。
 * 使用 Date.now() 的秒级窗口而不是滑动窗口,实现简单且足够。
 */
export function createRateLimiter() {
  return {
    windowStart: Date.now(),
    inputCount: 0,
    actionCount: 0,
  };
}

function rollWindow(rate) {
  const now = Date.now();
  if (now - rate.windowStart >= 1000) {
    rate.windowStart = now;
    rate.inputCount = 0;
    rate.actionCount = 0;
  }
}

/**
 * 检查输入包频率。
 * @returns {{allowed: boolean, reason?: string}}
 */
export function checkInputRate(rate) {
  rollWindow(rate);
  rate.inputCount += 1;
  if (rate.inputCount > ANTI_CHEAT.maxInputPacketsPerSec) {
    return { allowed: false, reason: 'input_rate' };
  }
  return { allowed: true };
}

export function checkActionRate(rate) {
  rollWindow(rate);
  rate.actionCount += 1;
  if (rate.actionCount > ANTI_CHEAT.maxActionPacketsPerSec) {
    return { allowed: false, reason: 'action_rate' };
  }
  return { allowed: true };
}

/** 网络抖动/丢包容差(米),避免正常玩家被误判。 */
const PREVIEW_SLACK_METERS = 0.6;
/** 瞬移需要连续多少次才计一次作弊(单帧巧合不算)。 */
const DISPLACEMENT_STRIKE_AFTER = 2;
/** 漂移需要连续多少次(约 0.6 秒)才计一次作弊,容忍网络抖动。 */
const DRIFT_STRIKE_AFTER = 12;

/**
 * 移动校验。
 *
 * @param {object} player 服务器权威玩家状态
 * @param {object|null} preview 客户端上报的预览坐标
 * @param {number} now 当前时间戳(ms)
 * @returns {{ok: boolean, reason?: string, details?: object}}
 *
 * 判定分两层,两层都需要"连续多次命中"才算作弊,避免网络抖动误杀:
 *
 *   A. 瞬移检测(方案要求的"单次 tick 位移超过理论最大移动阈值"):
 *      相邻两个上报包之间,客户端自称的位置跨度不能超过
 *      maxSpeed × 实际间隔 × 容差 + 抖动容差。
 *   B. 漂移检测:客户端预览坐标与服务器权威坐标长期偏离超过 maxDrift。
 *
 * 无论哪种情况,服务器坐标都不会被改写(服务器从不信任客户端坐标),
 * 所以方案要求的"回滚到服务器权威坐标"天然成立;客户端会在下发的
 * self_state 里收到权威坐标并自行收敛。
 */
export function validateMovement(player, preview, now) {
  if (!preview) return { ok: true };

  const result = checkDisplacement(player, preview, now);
  if (!result.ok) return result;

  return checkDrift(player, preview);
}

function checkDisplacement(player, preview, now) {
  if (!player.lastPreview) {
    player.lastPreview = preview;
    player.lastPreviewAt = now;
    return { ok: true };
  }

  const elapsedMs = Math.max(1, now - player.lastPreviewAt);
  const travelled = planarDistance(preview, player.lastPreview);
  const maxTravel =
    PHYSICS.maxSpeed * (elapsedMs / 1000) * ANTI_CHEAT.displacementTolerance + PREVIEW_SLACK_METERS;

  if (travelled > maxTravel) {
    player.lastPreview = preview;
    player.lastPreviewAt = now;
    player.displacementStreak = (player.displacementStreak ?? 0) + 1;
    if (player.displacementStreak >= DISPLACEMENT_STRIKE_AFTER) {
      player.displacementStreak = 0;
      return {
        ok: false,
        reason: 'displacement',
        details: {
          travelled: round(travelled),
          maxTravel: round(maxTravel),
          elapsedMs,
          serverPos: roundVec(player.pos),
          clientPos: roundVec(preview),
        },
      };
    }
    return { ok: true };
  }

  player.displacementStreak = 0;
  player.lastPreview = preview;
  player.lastPreviewAt = now;
  return { ok: true };
}

function checkDrift(player, preview) {
  const drift = planarDistance(preview, player.pos);
  if (drift > ANTI_CHEAT.maxDrift) {
    player.driftStreak = (player.driftStreak ?? 0) + 1;
    if (player.driftStreak >= DRIFT_STRIKE_AFTER) {
      player.driftStreak = 0;
      return {
        ok: false,
        reason: 'sustained_drift',
        details: {
          drift: round(drift),
          maxDrift: ANTI_CHEAT.maxDrift,
          serverPos: roundVec(player.pos),
          clientPos: roundVec(preview),
        },
      };
    }
    return { ok: true };
  }

  player.driftStreak = 0;
  return { ok: true };
}

/**
 * 累计一次可疑行为,返回是否应当断开连接。
 */
export function recordStrike(player, event) {
  player.strikes += 1;
  logCheat({
    reason: event.reason,
    severity: player.strikes >= ANTI_CHEAT.strikesBeforeKick ? 'high' : 'normal',
    uid: player.uid,
    strikes: player.strikes,
    details: event.details,
  });
  if (ANTI_CHEAT.strikesBeforeKick > 0 && player.strikes >= ANTI_CHEAT.strikesBeforeKick) {
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------------- *
 * 资源操作校验
 * ------------------------------------------------------------------------- */

/**
 * 校验一次宝石拾取。
 * 服务器自己没有"拾取请求历史",所以这里只校验距离 + 宝石是否仍然有效。
 * 宝石是否已被别人拿走由 World 的 active 标记保证。
 */
export function validateGemPickup(player, gem) {
  if (!gem || !gem.active) {
    return { ok: false, reason: 'gem_unavailable' };
  }
  const dist = planarDistance(player.pos, gem.pos);
  if (dist > RULES.gemPickupRadius) {
    return { ok: false, reason: 'too_far', details: { dist: round(dist), limit: RULES.gemPickupRadius } };
  }
  return { ok: true };
}

/**
 * 校验一次偷宠物。
 *
 * 按此顺序判定,便于客户端给出准确提示:
 *   - 宠物必须存在
 *   - 玩家必须在 stealRadius 内
 *   - 不能偷自己的
 *   - 宠物必须有主人(野生宠物不能"偷")
 *   - 该宠物本身必须已过抢夺冷却
 *
 * 冷却按"每只宠物"计,而不是按玩家:被偷的宠物在冷却内无法再被倒手,
 * 新主人也有真正的保护期。
 */
export function validatePetSteal(player, pet, now) {
  if (!pet) return { ok: false, reason: 'pet_missing' };

  const dist = planarDistance(player.pos, pet.pos);
  if (dist > RULES.petStealRadius) {
    return { ok: false, reason: 'too_far', details: { dist: round(dist), limit: RULES.petStealRadius } };
  }

  if (pet.ownerUid === player.uid) return { ok: false, reason: 'own_pet' };
  if (!pet.ownerUid) return { ok: false, reason: 'pet_wild' };

  const nextAllowed = pet.stealCooldownUntil ?? 0;
  if (now < nextAllowed) {
    return {
      ok: false,
      reason: 'cooldown',
      details: { remainingMs: Math.round(nextAllowed - now) },
    };
  }

  return { ok: true };
}

/**
 * 校验一次孵化。
 * 规则:必须是自己的宠物、在范围内、已过冷却、未完成孵化。
 */
export function validatePetHatch(player, pet, now) {
  if (!pet) return { ok: false, reason: 'pet_missing' };
  if (pet.ownerUid !== player.uid) return { ok: false, reason: 'not_owner' };
  if (pet.isHatched) return { ok: false, reason: 'already_hatched' };

  const dist = planarDistance(player.pos, pet.pos);
  if (dist > RULES.petHatchRadius) {
    return { ok: false, reason: 'too_far', details: { dist: round(dist), limit: RULES.petHatchRadius } };
  }

  const key = `hatch:${pet.petId}`;
  const nextAllowed = player.petCooldowns.get(key) ?? 0;
  if (now < nextAllowed) {
    return {
      ok: false,
      reason: 'cooldown',
      details: { remainingMs: Math.round(nextAllowed - now) },
    };
  }
  return { ok: true };
}

export function startCooldown(player, key, durationMs, now) {
  player.petCooldowns.set(key, now + durationMs);
}

/* ------------------------------------------------------------------------- *
 * 杂项
 * ------------------------------------------------------------------------- */
function round(value) {
  return Math.round(value * 100) / 100;
}

function roundVec(v) {
  return { x: round(v.x), y: round(v.y), z: round(v.z) };
}

/** 理论速度上限 */
export function theoreticalMaxSpeed() {
  return PHYSICS.maxSpeed * (TIMING.tickMs / 1000);
}
