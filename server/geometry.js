/**
 * 纯几何工具。没有副作用,便于单独测试。
 *
 * AABB 一律用 { min: {x,y,z}, max: {x,y,z} } 表示。
 */

/** 点是否在 AABB 内(含边界)。 */
export function pointInAabb(point, box) {
  return (
    point.x >= box.min.x &&
    point.x <= box.max.x &&
    point.y >= box.min.y &&
    point.y <= box.max.y &&
    point.z >= box.min.z &&
    point.z <= box.max.z
  );
}

/** 只比较水平方向(x/z),用于地面区域判定。 */
export function pointInAabb2D(point, box) {
  return (
    point.x >= box.min.x &&
    point.x <= box.max.x && point.z >= box.min.z && point.z <= box.max.z
  );
}

/**
 * 把 AABB 从局部坐标平移到世界坐标。
 * 关卡配置用局部坐标书写,进世界时整体偏移,便于调整关卡位置。
 */
export function offsetAabb(box, origin) {
  return {
    min: { x: box.min.x + origin.x, y: box.min.y + origin.y, z: box.min.z + origin.z },
    max: { x: box.max.x + origin.x, y: box.max.y + origin.y, z: box.max.z + origin.z },
  };
}

export function offsetPoint(point, origin) {
  return { x: point.x + origin.x, y: point.y + origin.y, z: point.z + origin.z };
}

/** 两个 AABB 是否相交。 */
export function aabbIntersects(a, b) {
  return !(
    a.max.x < b.min.x ||
    a.min.x > b.max.x ||
    a.max.y < b.min.y ||
    a.min.y > b.max.y ||
    a.max.z < b.min.z ||
    a.min.z > b.max.z
  );
}

/** AABB 中心点。 */
export function aabbCenter(box) {
  return {
    x: (box.min.x + box.max.x) / 2,
    y: (box.min.y + box.max.y) / 2,
    z: (box.min.z + box.max.z) / 2,
  };
}

/** AABB 尺寸。 */
export function aabbSize(box) {
  return {
    x: box.max.x - box.min.x,
    y: box.max.y - box.min.y,
    z: box.max.z - box.min.z,
  };
}

/**
 * 找玩家脚下最高的支撑面高度。
 *
 * 玩家位置用脚底坐标(与现有物理一致:pos.y 是脚底)。
 * 只有当水平方向在平台内、且脚底不高于平台顶面一个容差时才算站上去,
 * 避免从下方穿到平台上面。
 */
export function supportHeightUnder(point, boxes, stepUp = 0.6) {
  let best = null;
  for (const box of boxes) {
    if (!pointInAabb2D(point, box)) continue;
    const top = box.max.y;
    if (point.y >= top - stepUp && (best === null || top > best)) best = top;
  }
  return best;
}

/**
 * 消失平台在某一时刻是否启用。
 * periodMs 一个完整周期,前 enabledMs 启用。
 */
export function blinkerEnabled(blinker, nowMs) {
  const period = Math.max(1, blinker.periodMs);
  const enabled = Math.max(0, Math.min(period, blinker.enabledMs));
  const phase = ((nowMs + (blinker.phaseMs ?? 0)) % period + period) % period;
  return phase < enabled;
}
