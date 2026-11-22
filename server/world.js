/**
 * 世界状态与权威物理模拟。
 *
 * - 在线玩家位置/速度只放在内存 Map,绝不每 tick 写数据库。
 * - 客户端只上报输入,位置由这里算。
 * - 广播降频到 10Hz,由 tick 计数控制。
 */
import crypto from 'node:crypto';
import {
  GAME,
  PHYSICS,
  TIMING,
  GEM_SPAWN_POINTS,
  PET_SPAWN_POINTS,
  RULES,
  VALID_SKINS,
} from './config.js';

function randomInDisc(radius) {
  const angle = Math.random() * Math.PI * 2;
  const dist = Math.sqrt(Math.random()) * radius;
  return { x: Math.cos(angle) * dist, z: Math.sin(angle) * dist };
}

/** 复用的空输入常量,避免每 tick 分配对象 */
const IDLE_INPUT = Object.freeze({ moveX: 0, moveZ: 0, jump: false });

export function clampToWorld(x, z) {
  const radius = Math.hypot(x, z);
  if (radius <= GAME.worldRadius) return { x, z };
  const scale = GAME.worldRadius / radius;
  return { x: x * scale, z: z * scale };
}

export function normalizeSkin(skinId) {
  return VALID_SKINS.includes(skinId) ? skinId : VALID_SKINS[0];
}

/** 创建一个玩家运行时状态。位置由服务器分配,不信任客户端。 */
export function createPlayerState({ uid, displayName, skinId, gems }) {
  const spawn = randomInDisc(GAME.spawnRadius);
  return {
    uid,
    displayName: displayName || uid.slice(0, 8),
    skinId: normalizeSkin(skinId),
    pos: { x: spawn.x, y: PHYSICS.groundY, z: spawn.z },
    vel: { x: 0, y: 0, z: 0 },
    onGround: true,
    /** 最近一次输入,缺包时用于外推 */
    lastInput: { moveX: 0, moveZ: 0, jump: false },
    /** 最近一次收到输入包的时间戳,用于判定输入是否已过期 */
    lastInputAt: 0,
    /** 最近一次收到的 seq,用于丢弃乱序/重复包 */
    lastSeq: -1,
    /** 服务器一共接受了多少个输入包 */
    ackedInputs: 0,
    /** 持有宝石总数(权威值) */
    gems: Number.isFinite(gems) ? gems : 0,
    /** 已拥有的宠物 id 集合 */
    petIds: new Set(),
    /** petId -> 下次可操作时间戳 */
    petCooldowns: new Map(),
    /** 累计作弊计次 */
    strikes: 0,
    /** 上一次客户端预览坐标与时间,用于瞬移检测 */
    lastPreview: null,
    lastPreviewAt: 0,
    displacementStreak: 0,
    driftStreak: 0,
    /** 限流窗口 */
    rate: { windowStart: 0, inputCount: 0, actionCount: 0 },
  };
}

/**
 * 单个玩家的权威积分。dt 单位为秒。
 * 水平方向:输入决定目标速度,加速度逼近,摩擦衰减。
 * 垂直方向:跳跃冲量 + 重力,落地钳制在地面。
 */
export function integratePlayer(player, input, dt) {
  const { maxSpeed, acceleration, friction, jumpImpulse, gravity, groundY, airControl } = PHYSICS;

  // 输入归一化:防止斜向移动速度更快(正方形输入 → 圆形)
  let ix = Number(input.moveX);
  let iz = Number(input.moveZ);
  if (!Number.isFinite(ix)) ix = 0;
  if (!Number.isFinite(iz)) iz = 0;
  ix = Math.max(-1, Math.min(1, ix));
  iz = Math.max(-1, Math.min(1, iz));
  const inputMagnitude = Math.hypot(ix, iz);
  if (inputMagnitude > 1) {
    ix /= inputMagnitude;
    iz /= inputMagnitude;
  }

  const control = player.onGround ? 1 : airControl;

  if (inputMagnitude > 0.01) {
    const targetVx = ix * maxSpeed;
    const targetVz = iz * maxSpeed;
    player.vel.x = approach(player.vel.x, targetVx, acceleration * control * dt);
    player.vel.z = approach(player.vel.z, targetVz, acceleration * control * dt);
  } else if (player.onGround) {
    // 无输入:按摩擦衰减(以 tick 为基准做幂运算,保证不同 dt 下表现一致)
    const decay = Math.pow(friction, dt * TIMING.tickRate);
    player.vel.x *= decay;
    player.vel.z *= decay;
    if (Math.abs(player.vel.x) < 0.05) player.vel.x = 0;
    if (Math.abs(player.vel.z) < 0.05) player.vel.z = 0;
  }

  // 硬性限速,防止浮点累积越界
  const speed = Math.hypot(player.vel.x, player.vel.z);
  if (speed > maxSpeed) {
    player.vel.x = (player.vel.x / speed) * maxSpeed;
    player.vel.z = (player.vel.z / speed) * maxSpeed;
  }

  // 垂直运动
  if (input.jump === true && player.onGround) {
    player.vel.y = jumpImpulse;
    player.onGround = false;
  }
  player.vel.y -= gravity * dt;

  player.pos.x += player.vel.x * dt;
  player.pos.y += player.vel.y * dt;
  player.pos.z += player.vel.z * dt;

  if (player.pos.y <= groundY) {
    player.pos.y = groundY;
    player.vel.y = 0;
    player.onGround = true;
  }

  const clamped = clampToWorld(player.pos.x, player.pos.z);
  player.pos.x = clamped.x;
  player.pos.z = clamped.z;
}

function approach(current, target, maxDelta) {
  const diff = target - current;
  if (Math.abs(diff) <= maxDelta) return target;
  return current + Math.sign(diff) * maxDelta;
}

/** 本 tick 允许的最大位移距离(米),用于防作弊阈值。 */
export function maxDisplacementPerTick(dt) {
  const horizontal = PHYSICS.maxSpeed * dt;
  const vertical = PHYSICS.jumpImpulse * dt;
  return Math.hypot(horizontal, vertical);
}

export function planarDistance(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export function round3(value) {
  return Math.round(value * 1000) / 1000;
}

export function round3Vec(v) {
  return { x: round3(v.x), y: round3(v.y), z: round3(v.z) };
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

/* ------------------------------------------------------------------------- *
 * 世界(内存)
 * ------------------------------------------------------------------------- */
export class World {
  constructor() {
    /** @type {Map<string, object>} uid -> player */
    this.players = new Map();
    /** @type {Map<string, object>} gemId -> gem */
    this.gems = new Map();
    /** @type {Map<string, object>} petId -> pet */
    this.pets = new Map();
    this.tick = 0;
    this.spawnGems();
    this.spawnPets();
  }

  spawnGems() {
    const points = shuffle([...GEM_SPAWN_POINTS]).slice(0, GAME.maxGems);
    for (const point of points) {
      const gem = {
        gemId: crypto.randomUUID(),
        pos: { x: point.x, y: 0, z: point.z },
        respawnAt: 0,
        active: true,
      };
      this.gems.set(gem.gemId, gem);
    }
  }

  spawnPets() {
    const points = shuffle([...PET_SPAWN_POINTS]).slice(0, GAME.maxPets);
    for (const point of points) {
      const pet = {
        petId: crypto.randomUUID(),
        ownerUid: null,
        pos: { x: point.x, y: 0, z: point.z },
        hatchProgress: 0,
        isHatched: false,
        species: 'blob',
        rarity: 'common',
        /** 抢夺冷却时间戳:被偷后进入保护期,期间任何人不能再次抢夺 */
        stealCooldownUntil: 0,
        /** 该宠物上次被偷的时间戳,用于校验与展示 */
        lastStolenAt: 0,
      };
      this.pets.set(pet.petId, pet);
    }
  }

  /** 把玩家已持久化的宠物挂进世界(上线时调用)。 */
  attachPersistedPets(player, pets) {
    for (const record of pets) {
      let pet = this.pets.get(record.petId);
      if (!pet) {
        const spawn = randomInDisc(GAME.spawnRadius);
        pet = {
          petId: record.petId,
          ownerUid: player.uid,
          pos: { x: spawn.x, y: 0, z: spawn.z },
          hatchProgress: record.hatchProgress ?? 0,
          isHatched: Boolean(record.isHatched),
          species: record.species ?? 'blob',
          rarity: record.rarity ?? 'common',
          stealCooldownUntil: 0,
          lastStolenAt: 0,
        };
        this.pets.set(pet.petId, pet);
      } else {
        pet.ownerUid = player.uid;
        pet.hatchProgress = record.hatchProgress ?? pet.hatchProgress;
        pet.isHatched = Boolean(record.isHatched);
        pet.species = record.species ?? pet.species;
        pet.rarity = record.rarity ?? pet.rarity;
      }
      player.petIds.add(pet.petId);
    }
  }

  addPlayer(player) {
    this.players.set(player.uid, player);
  }

  removePlayer(uid) {
    const player = this.players.get(uid);
    if (!player) return null;
    this.players.delete(uid);
    return player;
  }

  getPlayer(uid) {
    return this.players.get(uid) ?? null;
  }

  /** 推进一个 tick。 */
  step(dt, now) {
    this.tick += 1;

    for (const player of this.players.values()) {
      // 输入过期:客户端停发或掉线时不能让角色一直往前跑
      const stale = now - player.lastInputAt > TIMING.inputStaleMs;
      const input = stale ? IDLE_INPUT : player.lastInput;
      integratePlayer(player, input, dt);
    }

    for (const gem of this.gems.values()) {
      if (!gem.active && gem.respawnAt > 0 && now >= gem.respawnAt) {
        gem.active = true;
        gem.respawnAt = 0;
      }
    }
  }

  /** 生成下行快照。players 中排除接收者自己(方案要求只发给其他玩家)。 */
  buildSnapshot(excludeUid) {
    const players = [];
    for (const player of this.players.values()) {
      if (player.uid === excludeUid) continue;
      players.push({
        uid: player.uid,
        pos: round3Vec(player.pos),
        skinId: player.skinId,
        speed: round3(Math.hypot(player.vel.x, player.vel.z)),
      });
    }

    const gems = [];
    for (const gem of this.gems.values()) {
      if (!gem.active) continue;
      gems.push({ gemId: gem.gemId, pos: round3Vec(gem.pos) });
    }

    const pets = [];
    for (const pet of this.pets.values()) {
      pets.push({
        petId: pet.petId,
        ownerUid: pet.ownerUid,
        pos: round3Vec(pet.pos),
        hatchProgress: Math.round(pet.hatchProgress),
      });
    }

    return { players, gems, pets };
  }

  /** 玩家名单(仅加入/离开时广播,避免每帧刷名字)。 */
  buildRoster() {
    const roster = [];
    for (const player of this.players.values()) {
      roster.push({ uid: player.uid, displayName: player.displayName, skinId: player.skinId });
    }
    return roster;
  }

  /** 找到距离某点最近的、在半径内且可拾取的宝石。 */
  findGemNear(pos, radius) {
    let best = null;
    let bestDist = Infinity;
    for (const gem of this.gems.values()) {
      if (!gem.active) continue;
      const dist = planarDistance(pos, gem.pos);
      if (dist <= radius && dist < bestDist) {
        bestDist = dist;
        best = gem;
      }
    }
    return best;
  }

  findPetNear(petId, pos, radius) {
    const pet = this.pets.get(petId);
    if (!pet) return null;
    if (planarDistance(pos, pet.pos) > radius) return null;
    return pet;
  }

  get onlineCount() {
    return this.players.size;
  }
}

export { RULES, VALID_SKINS };
