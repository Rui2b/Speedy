/**
 * 宠物系统:稀有度、蛋、孵化计时、跟随位置。
 *
 * 服务端负责:
 *   - 生成蛋时按权重抽稀有度,决定孵化时长
 *   - 每 tick 推进孵化进度
 *   - 计算宠物跟随主人的权威位置(客户端只做平滑)
 *
 * 偷窃的距离 / 冷却 / 归属校验仍在 antiCheat.js,这里只补充"跟随"与"孵化"。
 */
import { PETS } from './gameConfig.js';

/** 按权重抽一个稀有度。 */
export function rollRarity(random = Math.random) {
  const total = PETS.rarityWeights.reduce((sum, r) => sum + r.weight, 0);
  let pick = random() * total;
  for (const entry of PETS.rarityWeights) {
    pick -= entry.weight;
    if (pick <= 0) return entry;
  }
  return PETS.rarityWeights[0];
}

/** 该稀有度对应的孵化总时长(毫秒)。 */
export function hatchDurationMs(rarity) {
  const entry = PETS.rarityWeights.find((r) => r.rarity === rarity);
  return entry?.hatchMs ?? PETS.rarityWeights[0].hatchMs;
}

/**
 * 创建一颗新蛋。
 * @param {string} id
 * @param {{x:number,z:number}} spawn
 */
export function createEgg(id, spawn, species = 'blob') {
  const roll = rollRarity();
  return {
    petId: id,
    ownerUid: null,
    species,
    rarity: roll.rarity,
    isEgg: true,
    isHatched: false,
    hatchProgress: 0,
    hatchStartedAt: null,
    hatchDurationMs: roll.hatchMs,
    pos: { x: spawn.x, y: 0, z: spawn.z },
    stealCooldownUntil: 0,
    lastStolenAt: 0,
  };
}

/**
 * 推进一颗蛋的孵化进度。
 *
 * 未开始计时的蛋(hatchStartedAt 为 null)不涨进度;开始后按真实时间推进,
 * 这样即使服务器重启,进度也不会因为 tick 精度而漂移。
 *
 * @returns {boolean} 本次是否刚刚孵化完成
 */
export function tickHatch(pet, nowMs) {
  if (!pet.isEgg || pet.isHatched || !pet.hatchStartedAt) return false;

  const elapsed = nowMs - pet.hatchStartedAt;
  const duration = pet.hatchDurationMs || hatchDurationMs(pet.rarity);
  const progress = Math.max(0, Math.min(1, elapsed / duration));
  pet.hatchProgress = Math.round(progress * 100);

  if (progress >= 1) {
    pet.isEgg = false;
    pet.isHatched = true;
    pet.hatchProgress = 100;
    return true;
  }
  return false;
}

/** 开始孵化计时(玩家第一次孵化操作时调用)。 */
export function startHatch(pet, nowMs) {
  if (!pet.isEgg || pet.hatchStartedAt) return false;
  pet.hatchStartedAt = nowMs;
  return true;
}

/**
 * 已孵化宠物跟着主人的权威位置。
 *
 * 没有寻路,只是把宠物放在主人身后固定距离处;服务端算完再下发,
 * 客户端只负责平滑,不自己决定宠物在哪。
 */
export function updateFollow(pet, owner, nowMs) {
  if (!pet.isHatched || !owner) return;

  const angle = owner.facing ?? Math.atan2(owner.vel.x, owner.vel.z);
  const bx = owner.pos.x - Math.sin(angle) * PETS.followDistance;
  const bz = owner.pos.z - Math.cos(angle) * PETS.followDistance;

  // 简单避让:宠物不能被推到世界外
  const dist = Math.hypot(bx, bz);
  const limit = 200;
  const scale = dist > limit ? limit / dist : 1;

  pet.pos.x = bx * scale;
  pet.pos.z = bz * scale;
  pet.pos.y = owner.pos.y + PETS.followHeight;
  pet.lastUpdated = nowMs;
}

/** 下发给客户端的宠物数据(含蛋与孵化进度)。 */
export function serializePet(pet) {
  return {
    petId: pet.petId,
    ownerUid: pet.ownerUid,
    species: pet.species,
    rarity: pet.rarity,
    isEgg: pet.isEgg,
    isHatched: pet.isHatched,
    hatchProgress: pet.hatchProgress,
    pos: { x: round3(pet.pos.x), y: round3(pet.pos.y), z: round3(pet.pos.z) },
  };
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}
