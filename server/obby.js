/**
 * Obby 闯关判定。
 *
 * 全部服务端权威:
 *   - 平台碰撞支撑(玩家能不能站住)
 *   - 掉落死亡 → 回最近检查点
 *   - 到达 goal → 标记通关
 *   - 消失平台的启停
 *
 * 客户端只负责把平台和检查点画出来,不参与任何判定。
 */
import { OBBY } from './gameConfig.js';
import {
  blinkerEnabled,
  offsetAabb,
  offsetPoint,
  pointInAabb,
  supportHeightUnder,
} from './geometry.js';

/**
 * 把某一关的配置预处理成世界坐标。
 * 服务端启动时算一次,避免每 tick 反复偏移。
 */
export function buildStageRuntime() {
  return OBBY.list.map((stage) => {
    const origin = stage.origin;
    const solid = stage.platforms.map((p) => ({
      id: p.id,
      kind: p.kind ?? 'solid',
      box: offsetAabb(p, origin),
    }));
    const blinkers = stage.blinkers.map((b) => ({
      id: b.id,
      box: offsetAabb(b, origin),
      periodMs: b.periodMs,
      enabledMs: b.enabledMs,
      phaseMs: b.phaseMs ?? 0,
    }));
    const checkpoints = stage.checkpoints.map((c) => offsetPoint(c, origin));
    return {
      id: stage.id,
      name: stage.name,
      origin,
      minSpeed: stage.minSpeed,
      deathY: stage.deathY,
      solid,
      blinkers,
      checkpoints,
      goal: offsetAabb(stage.goal, origin),
    };
  });
}

/** 按 id 取一关。 */
export function findStage(runtime, stageId) {
  return runtime.find((s) => s.id === stageId) ?? null;
}

/**
 * 当前时刻某关所有"有效平台"(静态 + 正在启用的消失平台)。
 * 消失平台关掉时不再提供支撑,玩家会掉下去。
 */
export function activePlatforms(stage, nowMs) {
  const out = stage.solid.map((p) => p.box);
  for (const b of stage.blinkers) {
    if (blinkerEnabled(b, nowMs)) out.push(b.box);
  }
  return out;
}

/**
 * 计算玩家应该站的高度。
 *
 * @returns {number|null} 支撑面顶面高度,没有支撑返回 null
 */
export function groundHeightAt(stage, point, nowMs) {
  return supportHeightUnder(point, activePlatforms(stage, nowMs));
}

/** 玩家是否掉出关卡。 */
export function isFallen(stage, point) {
  return point.y < stage.deathY;
}

/** 玩家是否踩到通关区域。 */
export function reachedGoal(stage, point) {
  return pointInAabb(point, stage.goal);
}

/**
 * 找距离玩家最近的检查点。
 * 用于掉落后复活:回到"已经路过"的那个,而不是从头开始。
 */
export function nearestCheckpoint(stage, point) {
  let best = null;
  let bestDist = Infinity;
  for (const cp of stage.checkpoints) {
    const d = Math.hypot(cp.x - point.x, cp.y - point.y, cp.z - point.z);
    if (d < bestDist) {
      bestDist = d;
      best = cp;
    }
  }
  return best;
}

/**
 * 玩家是否已经走到某个检查点(用于更新复活点)。
 * 用水平距离判定,避免跳跃中擦过时错过。
 */
export function touchedCheckpoint(stage, point, radius = 1.8) {
  for (const cp of stage.checkpoints) {
    if (Math.hypot(cp.x - point.x, cp.z - point.z) <= radius) return cp;
  }
  return null;
}

/**
 * 关卡是否允许进入。
 * @returns {{ok: true} | {ok: false, reason: string, need?: number}}
 */
export function canEnterStage(stage, player) {
  if (player.speed < stage.minSpeed) {
    return {
      ok: false,
      reason: 'below_min_speed',
      need: Math.ceil(stage.minSpeed - player.speed),
    };
  }
  return { ok: true };
}

/** 关卡进入点:出生平台上方一点,避免一进去就卡在平台里。 */
export function stageEntryPoint(stage) {
  const first = stage.checkpoints[0];
  return first
    ? { x: first.x, y: first.y + 0.6, z: first.z }
    : { x: stage.origin.x, y: stage.origin.y + 1, z: stage.origin.z };
}

/**
 * 下发给客户端的关卡几何(只含渲染需要的字段)。
 * 不发任何判定参数,避免客户端自己算出"我过关了"。
 */
export function serializeStage(stage) {
  return {
    id: stage.id,
    name: stage.name,
    minSpeed: stage.minSpeed,
    solids: stage.solid.map((p) => ({ id: p.id, box: p.box })),
    blinkers: stage.blinkers.map((b) => ({
      id: b.id,
      box: b.box,
      periodMs: b.periodMs,
      enabledMs: b.enabledMs,
      phaseMs: b.phaseMs,
    })),
    checkpoints: stage.checkpoints.map((cp, i) => ({ index: i, pos: cp })),
    goal: stage.goal,
  };
}
