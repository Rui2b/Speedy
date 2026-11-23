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
import { createEgg, hatchDurationMs, tickHatch, updateFollow, startHatch } from './pets.js';
import { gainSpeed } from './speedSystem.js';
import { SPEED, TREADMILL } from './gameConfig.js';
import {
  activePlatforms,
  groundHeightAt,
  isFallen,
  nearestCheckpoint,
  reachedGoal,
  stageEntryPoint,
  touchedCheckpoint,
} from './obby.js';

/** 复用 rebirth 出生点常量,避免两处写死不同坐标 */
const SPEED_REBIRTH_SPAWN = SPEED.rebirthSpawn;

function randomInDisc(radius) {
  const angle = Math.random() * Math.PI * 2;
  const dist = Math.sqrt(Math.random()) * radius;
  return { x: Math.cos(angle) * dist, z: Math.sin(angle) * dist };
}

/** 复用的空输入常量,避免每 tick 分配对象 */
const IDLE_INPUT = Object.freeze({ moveX: 0, moveZ: 0, jump: false });

/**
 * 关卡里脚下没有平台时的"支撑面"。
 * 用一个永远低于死亡线的值,让玩家继续下落到 isFallen 触发复活;
 * 如果回退到 lobby 的 groundY,关卡会出现一块看不见的地面,掉落判定永远不生效。
 */
const NO_GROUND = -Infinity;

/**
 * lobby 里跑步机踏板是实体:玩家会真的站在踏板上,而不是踩在地面里。
 * 返回踏板顶面高度,不在踏板上就返回 null(用默认地面)。
 *
 * @param {{x:number,y:number,z:number}} point 玩家脚底坐标
 * @returns {number|null}
 */
function treadmillSupportHeight(point) {
  for (const machine of TREADMILL.list) {
    if (point.x < machine.min.x || point.x > machine.max.x) continue;
    if (point.z < machine.min.z || point.z > machine.max.z) continue;
    if (point.y >= machine.max.y - 0.6) return machine.max.y;
  }
  return null;
}

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
export function createPlayerState({ uid, displayName, skinId, gems, save }) {
  const spawn = randomInDisc(GAME.spawnRadius);
  const restored = save ?? {};
  return {
    uid,
    displayName: displayName || uid.slice(0, 8),
    skinId: normalizeSkin(skinId),
    pos: { x: spawn.x, y: PHYSICS.groundY, z: spawn.z },
    vel: { x: 0, y: 0, z: 0 },
    onGround: true,

    /* --- Speed 成长(全部服务端计算)--------------------------------- */
    /** 当前累计速度,转生后清零 */
    speed: Number.isFinite(restored.speed) ? restored.speed : 0,
    /** 历史累计速度,永不重置 */
    speedTotal: Number.isFinite(restored.speedTotal) ? restored.speedTotal : 0,
    /** 转生次数 */
    rebirth: Number.isFinite(restored.rebirth) ? restored.rebirth : 0,
    /** speed 获取倍率 */
    multiplier: Number.isFinite(restored.multiplier) && restored.multiplier > 0 ? restored.multiplier : 1,
    /** treadmillId -> 有效期截止时间戳 */
    treadmillUntil: new Map(),
    /** 已通关的 stage id 集合 */
    clearedStages: new Set(restored.clearedStages ?? []),
    /** 本轮进入关卡后是否已经触发过通关,防止一次踩 goal 反复回调 */
    clearedThisRun: false,
    /** 当前所在:lobby 或某关 */
    location: restored.location ?? { world: 'lobby', stage: 0 },
    /** 最近检查点(掉落后复活用) */
    checkpoint: restored.checkpoint ?? null,

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
 * 垂直方向:跳跃冲量 + 重力。
 *
 * `groundHeight` 是玩家脚下当前的支撑面高度(Obby 平台顶面),传 null 表示
 * 用默认地面。Lobby 没有平台,传 null 即可。客户端预测用同一套函数,保证手感一致。
 * 关卡里脚下没有平台时应传 NO_GROUND,让玩家真的往下掉。
 *
 * @param {object} player
 * @param {object} input
 * @param {number} dt
 * @param {number|null} [groundHeight]
 * @param {number|null} [worldRadius] 圆形边界半径;传 null 不裁剪
 */
export function integratePlayer(player, input, dt, groundHeight = null, worldRadius = null) {
  const baseGround = groundHeight === null ? PHYSICS.groundY : groundHeight;

  player.prevPos = player.prevPos ?? { x: player.pos.x, y: player.pos.y, z: player.pos.z };

  /* --- 水平 --- */
  const accel = computeHorizontalStep(player, input, dt);
  player.vel.x = accel.vx;
  player.vel.z = accel.vz;

  /* --- 垂直 --- */
  let grounded = player.onGround;
  if (input.jump === true && grounded) {
    player.vel.y = PHYSICS.jumpImpulse;
    grounded = false;
  }
  if (!grounded) player.vel.y -= PHYSICS.gravity * dt;

  player.pos.x += player.vel.x * dt;
  player.pos.z += player.vel.z * dt;
  player.pos.y += player.vel.y * dt;

  // 落地:支撑面可能是平台,也可能是 lobby 地面
  const support = groundHeight === null ? baseGround : groundHeight;
  if (player.pos.y <= support && player.vel.y <= 0) {
    player.pos.y = support;
    player.vel.y = 0;
    player.onGround = true;
  } else {
    player.onGround = false;
  }

  // 圆形边界只对 lobby 生效;关卡是直线延伸的,不裁剪
  if (worldRadius !== null) {
    const clamped = clampToRadius(player.pos.x, player.pos.z, worldRadius);
    player.pos.x = clamped.x;
    player.pos.z = clamped.z;
  }
}

/**
 * 纯函数:根据当前速度和输入算出下一帧水平速度。
 * 抽出来是为了让客户端预测和服务端积分用同一段逻辑(同源参数的唯一实现)。
 */
export function computeHorizontalStep(player, input, dt) {
  const { maxSpeed, acceleration, friction, airControl } = PHYSICS;

  let ix = Number(input.moveX);
  let iz = Number(input.moveZ);
  if (!Number.isFinite(ix)) ix = 0;
  if (!Number.isFinite(iz)) iz = 0;
  ix = Math.max(-1, Math.min(1, ix));
  iz = Math.max(-1, Math.min(1, iz));
  const magnitude = Math.hypot(ix, iz);
  if (magnitude > 1) {
    ix /= magnitude;
    iz /= magnitude;
  }

  let vx = player.vel.x;
  let vz = player.vel.z;
  const control = player.onGround ? 1 : airControl;

  if (magnitude > 0.01) {
    vx = approach(vx, ix * maxSpeed, acceleration * control * dt);
    vz = approach(vz, iz * maxSpeed, acceleration * control * dt);
  } else if (player.onGround) {
    const decay = Math.pow(friction, dt * TIMING.tickRate);
    vx *= decay;
    vz *= decay;
    if (Math.abs(vx) < 0.05) vx = 0;
    if (Math.abs(vz) < 0.05) vz = 0;
  }

  const speed = Math.hypot(vx, vz);
  if (speed > maxSpeed) {
    vx = (vx / speed) * maxSpeed;
    vz = (vz / speed) * maxSpeed;
  }

  return { vx, vz };
}

function clampToRadius(x, z, radius) {
  const dist = Math.hypot(x, z);
  if (dist <= radius) return { x, z };
  const scale = radius / dist;
  return { x: x * scale, z: z * scale };
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
    /**
     * 地面宝石已移除(宝石改为通关奖励)。
     * 保留这个空 Map 是为了让旧代码路径不至于崩,新代码不应再往里写。
     * @type {Map<string, object>}
     */
    this.gems = new Map();
    /** @type {Map<string, object>} petId -> pet */
    this.pets = new Map();
    this.tick = 0;
    this.spawnPets();
  }

  /**
   * 地面宝石生成已废弃。
   * 宝石现在只由 gems.js 在通关时发放。
   */
  spawnGems() {
    // 故意留空:不再在地图刷宝石
  }

  spawnPets() {
    const points = shuffle([...PET_SPAWN_POINTS]).slice(0, GAME.maxPets);
    for (const point of points) {
      // 野生宠物做成"蛋",由玩家捡起后孵化
      const pet = createEgg(crypto.randomUUID(), point);
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
          species: record.species ?? 'blob',
          rarity: record.rarity ?? 'common',
          isEgg: record.isEgg ?? !record.isHatched,
          isHatched: Boolean(record.isHatched),
          hatchProgress: record.hatchProgress ?? 0,
          hatchStartedAt: record.hatchStartedAt ?? null,
          hatchDurationMs: hatchDurationMs(record.rarity ?? 'common'),
          pos: { x: spawn.x, y: 0, z: spawn.z },
          stealCooldownUntil: 0,
          lastStolenAt: 0,
          lastUpdated: 0,
        };
        this.pets.set(pet.petId, pet);
      } else {
        pet.ownerUid = player.uid;
        pet.species = record.species ?? pet.species;
        pet.rarity = record.rarity ?? pet.rarity;
        pet.isEgg = record.isEgg ?? pet.isEgg;
        pet.isHatched = Boolean(record.isHatched);
        pet.hatchProgress = record.hatchProgress ?? pet.hatchProgress;
        pet.hatchStartedAt = record.hatchStartedAt ?? pet.hatchStartedAt;
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

  /** 取玩家当前所在的关卡运行时数据;在 lobby 返回 null。 */
  stageFor(player, stages) {
    if (player.location?.world !== 'obby') return null;
    return stages.find((s) => s.id === player.location.stage) ?? null;
  }

  /**
   * 关卡内每 tick 的判定:掉落复活、检查点更新、通关。
   * 任何判定都在服务端,客户端只收到结果。
   */
  checkStageProgress(player, stage, now, onStageClear) {
    // 1. 到达检查点 → 更新复活点
    const cp = touchedCheckpoint(stage, player.pos);
    if (cp) player.checkpoint = cp;

    // 2. 掉落 → 回最近检查点
    if (isFallen(stage, player.pos)) {
      const respawn =
        player.checkpoint ?? nearestCheckpoint(stage, player.pos) ?? stageEntryPoint(stage);
      player.pos.x = respawn.x;
      player.pos.y = respawn.y + 0.4;
      player.pos.z = respawn.z;
      player.vel.x = 0;
      player.vel.y = 0;
      player.vel.z = 0;
      player.onGround = false;
      player.justRespawned = true;
      player.fellCount = (player.fellCount ?? 0) + 1;
      return;
    }

    // 3. 踩到 goal → 通关
    // 每次进入关卡只触发一次;重复通关也要触发,客户端才能提示
    // "本关已通关,不再获得宝石奖励"。宝石是否发放由数据库的 first_gems_rewarded 决定。
    if (reachedGoal(stage, player.pos) && !player.clearedThisRun) {
      player.clearedThisRun = true;
      player.clearedStages.add(stage.id);
      player.stageEnteredAt = null;
      const elapsed = player.stageStartedAt ? now - player.stageStartedAt : 0;
      player.stageStartedAt = null;
      onStageClear?.({ player, stage, elapsedMs: elapsed });
    }
  }

  /** 让玩家进入某个关卡。 */
  enterStage(player, stage, now) {
    const entry = stageEntryPoint(stage);
    player.location = { world: 'obby', stage: stage.id };
    player.pos.x = entry.x;
    player.pos.y = entry.y;
    player.pos.z = entry.z;
    player.vel.x = 0;
    player.vel.y = 0;
    player.vel.z = 0;
    player.onGround = false;
    player.checkpoint = stage.checkpoints[0] ?? null;
    player.stageStartedAt = now;
    player.clearedThisRun = false;
  }

  /** 把玩家送回 lobby。 */
  exitStage(player, now) {
    const spawn = SPEED_REBIRTH_SPAWN;
    player.location = { world: 'lobby', stage: 0 };
    player.pos.x = spawn.x;
    player.pos.y = spawn.y;
    player.pos.z = spawn.z;
    player.vel.x = 0;
    player.vel.y = 0;
    player.vel.z = 0;
    player.onGround = true;
    player.checkpoint = null;
    player.stageStartedAt = null;
    player.lastLobbyAt = now;
  }

  /**
   * 推进一个 tick。
   *
   * @param {number} dt 秒
   * @param {number} now 时间戳
   * @param {Array<object>} stages buildStageRuntime() 产出的关卡运行时数据
   * @param {(event: object) => void} [onStageClear] 通关回调
   */
  step(dt, now, stages = [], onStageClear = null) {
    this.tick += 1;

    for (const player of this.players.values()) {
      // 输入过期:客户端停发或掉线时不能让角色一直往前跑
      const stale = now - player.lastInputAt > TIMING.inputStaleMs;
      const input = stale ? IDLE_INPUT : player.lastInput;

      const stage = this.stageFor(player, stages);

      // 关卡判定要在积分前做:上一帧可能已经把玩家推到死亡高度以下
      if (stage) {
        this.checkStageProgress(player, stage, now, onStageClear);
        // 掉落复活后位置被重置,本 tick 不再积分,避免又把玩家推下去
        if (player.justRespawned) {
          player.justRespawned = false;
          gainSpeed(player, now);
          continue;
        }
      }

      const groundHeight = stage
        ? (groundHeightAt(stage, player.pos, now) ?? NO_GROUND)
        : treadmillSupportHeight(player.pos);

      integratePlayer(
        player,
        input,
        dt,
        groundHeight,
        stage ? null : GAME.worldRadius,
      );

      // 积分后再判一次:这一帧可能刚踩进 goal
      if (stage) {
        this.checkStageProgress(player, stage, now, onStageClear);
      }

      // Speed 成长(服务端权威)
      gainSpeed(player, now);

      // 朝向:给宠物跟随用
      if (Math.hypot(player.vel.x, player.vel.z) > 0.1) {
        player.facing = Math.atan2(player.vel.x, player.vel.z);
      }
    }

    // 宠物:孵化计时 + 跟随主人
    for (const pet of this.pets.values()) {
      if (pet.isEgg) {
        if (pet.hatchStartedAt) tickHatch(pet, now);
      } else if (pet.ownerUid) {
        const owner = this.players.get(pet.ownerUid);
        if (owner) updateFollow(pet, owner, now);
      }
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
