/**
 * World state and authoritative physics.
 *
 * - Live positions and velocities only exist in memory maps. Nothing is
 *   written per tick.
 * - The client reports inputs; positions are computed here.
 * - Snapshots go out at 10Hz, driven by the tick counter.
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

/** Shared idle input, so the tick loop allocates nothing */
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

/** Build a runtime player state. The spawn is server chosen, never client supplied. */
export function createPlayerState({ uid, displayName, skinId, gems }) {
  const spawn = randomInDisc(GAME.spawnRadius);
  return {
    uid,
    displayName: displayName || uid.slice(0, 8),
    skinId: normalizeSkin(skinId),
    pos: { x: spawn.x, y: PHYSICS.groundY, z: spawn.z },
    vel: { x: 0, y: 0, z: 0 },
    onGround: true,
    /** Most recent input, extrapolated when a packet is missing */
    lastInput: { moveX: 0, moveZ: 0, jump: false },
    /** Timestamp of the last input packet, used to expire stale input */
    lastInputAt: 0,
    /** Last accepted seq, so out-of-order and duplicate packets are dropped */
    lastSeq: -1,
    /** Total input packets accepted */
    ackedInputs: 0,
    /** Gem count (authoritative) */
    gems: Number.isFinite(gems) ? gems : 0,
    /** Pet ids owned by this player */
    petIds: new Set(),
    /** petId -> next allowed action timestamp */
    petCooldowns: new Map(),
    /** Accumulated anti-cheat strikes */
    strikes: 0,
    /** Previous reported position and time, used for teleport detection */
    lastPreview: null,
    lastPreviewAt: 0,
    displacementStreak: 0,
    driftStreak: 0,
    /** Rate limit window */
    rate: { windowStart: 0, inputCount: 0, actionCount: 0 },
  };
}

/**
 * Authoritative integration for one player. dt is in seconds.
 * Horizontally the input sets a target velocity, acceleration approaches it
 * and friction damps it. Vertically a jump impulse plus gravity applies, and
 * landing is clamped to the ground plane.
 */
export function integratePlayer(player, input, dt) {
  const { maxSpeed, acceleration, friction, jumpImpulse, gravity, groundY, airControl } = PHYSICS;

  // Normalize input so diagonal movement is not faster (square to circle)
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
    // No input: damp by friction, raised to a tick-based power so any dt behaves the same
    const decay = Math.pow(friction, dt * TIMING.tickRate);
    player.vel.x *= decay;
    player.vel.z *= decay;
    if (Math.abs(player.vel.x) < 0.05) player.vel.x = 0;
    if (Math.abs(player.vel.z) < 0.05) player.vel.z = 0;
  }

  // Hard speed clamp, so float drift cannot exceed the limit
  const speed = Math.hypot(player.vel.x, player.vel.z);
  if (speed > maxSpeed) {
    player.vel.x = (player.vel.x / speed) * maxSpeed;
    player.vel.z = (player.vel.z / speed) * maxSpeed;
  }

  // Vertical motion
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

/** Maximum allowed displacement for one tick, used as the anti-cheat threshold. */
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
 * The world, in memory
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
        /** Steal cooldown: a freshly stolen pet is protected for a while */
        stealCooldownUntil: 0,
        /** When this pet was last stolen, for validation and display */
        lastStolenAt: 0,
      };
      this.pets.set(pet.petId, pet);
    }
  }

  /** Attach a player's persisted pets to the world on connect. */
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

  /** Advance one tick. */
  step(dt, now) {
    this.tick += 1;

    for (const player of this.players.values()) {
      // Expired input: a client that stops reporting must not keep sliding
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

  /** Build a downlink snapshot. The receiver is left out of the player list. */
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

  /** Roster, sent only when someone joins or leaves rather than every frame. */
  buildRoster() {
    const roster = [];
    for (const player of this.players.values()) {
      roster.push({ uid: player.uid, displayName: player.displayName, skinId: player.skinId });
    }
    return roster;
  }

  /** Nearest collectable gem within a radius. */
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
