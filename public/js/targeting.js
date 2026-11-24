/**
 * 目标选择:客户端只做"视觉层面"的最近目标筛选,
 * 真正的距离、冷却、归属校验全部在服务器。
 *
 * 这里直接返回 id 字符串,方便直接丢给网络层。
 */

export const ACTION_KEYS = {
  pick: 'KeyE',
  hatch: 'KeyF',
};

function planarDist(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * @param {Map<string, {x:number,z:number}>} gems
 * @returns {string|null} gemId
 */
export function findNearestGem(gems, pos, maxDistance) {
  let bestId = null;
  let bestDist = Infinity;
  for (const [gemId, gemPos] of gems) {
    const dist = planarDist(pos, gemPos);
    if (dist <= maxDistance && dist < bestDist) {
      bestDist = dist;
      bestId = gemId;
    }
  }
  return bestId;
}

/**
 * 找最近可交互的宠物。
 *
 * 三种都算:自己的(孵化)、别人的(偷)、野生的(捡起来养)。
 * 优先级:自己的 → 野生 → 别人的,这样站在一堆宠物中间时
 * 按 E 的行为是可预期的。
 *
 * @returns {string|null} petId
 */
export function findNearestPet(pets, pos, maxDistance, selfUid) {
  let bestOwnId = null;
  let bestOwnDist = Infinity;
  let bestWildId = null;
  let bestWildDist = Infinity;
  let bestOtherId = null;
  let bestOtherDist = Infinity;

  for (const [petId, pet] of pets) {
    const dist = planarDist(pos, pet.pos);
    if (dist > maxDistance) continue;

    if (pet.ownerUid === selfUid) {
      if (dist < bestOwnDist) {
        bestOwnDist = dist;
        bestOwnId = petId;
      }
    } else if (pet.ownerUid === null || pet.ownerUid === undefined) {
      if (dist < bestWildDist) {
        bestWildDist = dist;
        bestWildId = petId;
      }
    } else if (dist < bestOtherDist) {
      bestOtherDist = dist;
      bestOtherId = petId;
    }
  }

  return bestOwnId ?? bestWildId ?? bestOtherId;
}

/**
 * 只找野生蛋。
 * 野生蛋是"奖励产出"的主要入口,按 E 时应该能直接捡起来。
 */
export function findNearestWildPet(pets, pos, maxDistance) {
  let bestId = null;
  let bestDist = Infinity;
  for (const [petId, pet] of pets) {
    if (pet.ownerUid !== null && pet.ownerUid !== undefined) continue;
    const dist = planarDist(pos, pet.pos);
    if (dist <= maxDistance && dist < bestDist) {
      bestDist = dist;
      bestId = petId;
    }
  }
  return bestId;
}
