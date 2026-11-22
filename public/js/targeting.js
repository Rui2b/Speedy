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
 * 自己的宠物优先(用于孵化),其次是别人的(用于偷)。
 * @returns {string|null} petId
 */
export function findNearestPet(pets, pos, maxDistance, selfUid) {
  let bestOwnId = null;
  let bestOwnDist = Infinity;
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
    } else if (pet.ownerUid && dist < bestOtherDist) {
      bestOtherDist = dist;
      bestOtherId = petId;
    }
  }

  return bestOwnId ?? bestOtherId;
}
