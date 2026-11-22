/**
 * Target picking. The client only filters for the nearest thing on screen;
 * distance, cooldown and ownership are all checked on the server.
 *
 * Each helper returns an id string ready to hand to the network layer.
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
 * Your own pets take priority (for hatching), then other players' pets
 * (for stealing).
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
