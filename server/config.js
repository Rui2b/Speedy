/**
 * Central configuration.
 *
 * Every magic number lives here so map layout, speed and pet rules can be
 * tuned without touching the simulation. Environment variables win, then the
 * defaults below.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '..');

/** Minimal .env parser, no extra dependency. Existing env vars win. */
function loadDotEnv() {
  const envPath = path.join(ROOT_DIR, '.env');
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();

function num(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

/* ------------------------------------------------------------------------- *
 * Network
 * ------------------------------------------------------------------------- */
export const NETWORK = {
  host: process.env.HOST || '127.0.0.1',
  port: num('PORT', 8080),
  wsPath: '/ws',
};

/* ------------------------------------------------------------------------- *
 * Timing: client reports at 20Hz, the server simulates 20 ticks/s and
 * broadcasts at 10Hz.
 * ------------------------------------------------------------------------- */
export const TIMING = {
  tickRate: num('TICK_RATE', 20),
  broadcastRate: num('BROADCAST_RATE', 10),
  /** Heartbeat interval. Both directions ping so NAT never drops an idle link. */
  heartbeatIntervalMs: 3000,
  /** No upstream packet for this long means the connection is probably dead. */
  heartbeatTimeoutMs: 10000,
  /**
   * Input expiry. After this long without a new input packet the server treats
   * the player as pressing nothing. Must stay above the 200ms background
   * reporting interval, or keys look released every time a tab is hidden.
   */
  inputStaleMs: num('INPUT_STALE_MS', 450),
  /** Maximum packet size in bytes, so one client cannot exhaust memory. */
  maxPayloadBytes: 4096,
};
TIMING.tickMs = 1000 / TIMING.tickRate;
TIMING.broadcastEveryNTicks = Math.max(1, Math.round(TIMING.tickRate / TIMING.broadcastRate));
TIMING.broadcastMs = 1000 / TIMING.broadcastRate;

/* ------------------------------------------------------------------------- *
 * Player physics (server authoritative)
 * ------------------------------------------------------------------------- */
export const PHYSICS = {
  maxSpeed: num('PLAYER_MAX_SPEED', 6),          // units/s
  acceleration: num('PLAYER_ACCELERATION', 12),  // units/s^2
  friction: num('PLAYER_FRICTION', 0.9),         // damping per tick with no input
  jumpImpulse: num('PLAYER_JUMP_IMPULSE', 7.5),  // units/s
  gravity: num('PLAYER_GRAVITY', 22),            // units/s^2
  groundY: 0,
  /** Horizontal control multiplier while airborne */
  airControl: 0.35,
};

/* ------------------------------------------------------------------------- *
 * Game rules
 * ------------------------------------------------------------------------- */
export const RULES = {
  gemPickupRadius: 2.2,
  petStealRadius: 2.5,
  petHatchRadius: 2.5,
  petStealCooldownMs: 12_000,   // per pet
  petHatchCooldownMs: 20_000,   // per pet
  /** Progress added by one successful hatch action */
  hatchProgressPerAction: 25,
  /** Time before a collected gem respawns */
  gemRespawnMs: 8_000,
};

export const GAME = {
  maxOnline: num('MAX_ONLINE', 30),
  maxGems: 24,
  maxPets: 8,
  /** Walkable radius of the round field, in metres */
  worldRadius: 40,
  spawnRadius: 26,
};

/* ------------------------------------------------------------------------- *
 * Anti-cheat
 * ------------------------------------------------------------------------- */
export const ANTI_CHEAT = {
  /** Allowed displacement per tick = maxSpeed * dt * this factor */
  displacementTolerance: num('CHEAT_DISPLACEMENT_TOLERANCE', 1.45),
  /** Maximum drift between the reported position and the authoritative one */
  maxDrift: num('CHEAT_MAX_DRIFT', 3.5),
  /** Strikes before the connection is dropped. 0 only logs. */
  strikesBeforeKick: num('CHEAT_STRIKES_BEFORE_KICK', 8),
  maxInputPacketsPerSec: num('MAX_INPUT_PACKETS_PER_SEC', 22),
  maxActionPacketsPerSec: num('MAX_ACTION_PACKETS_PER_SEC', 10),
};

/* ------------------------------------------------------------------------- *
 * Database and sessions
 * ------------------------------------------------------------------------- */
export const DB = {
  url: process.env.DATABASE_URL || '',
  poolMax: num('PG_POOL_MAX', 8),
  autoMigrate: bool('DB_AUTO_MIGRATE', true),
  connectionTimeoutMs: 8000,
  idleTimeoutMs: 30_000,
};

export const AUTH = {
  secret: process.env.SESSION_SECRET || '',
  sessionTtlMs: num('SESSION_TTL_HOURS', 12) * 60 * 60 * 1000,
  /** scrypt parameters */
  scryptN: 16384,
  scryptR: 8,
  scryptP: 1,
  keyLen: 64,
  saltBytes: 16,
  usernameMinLength: 3,
  usernameMaxLength: 20,
  passwordMinLength: 6,
  passwordMaxLength: 128,
};

export const LOG = {
  level: process.env.LOG_LEVEL || 'info',
  cheatLogFile: path.resolve(ROOT_DIR, process.env.CHEAT_LOG_FILE || 'logs/cheat.log'),
};

/* ------------------------------------------------------------------------- *
 * Spawn points. Server side only; the client cannot influence these.
 * Edit this list to change the map layout.
 * ------------------------------------------------------------------------- */
export const GEM_SPAWN_POINTS = [
  { x: 14, z: 0 }, { x: 9.9, z: 9.9 }, { x: 0, z: 14 }, { x: -9.9, z: 9.9 },
  { x: -14, z: 0 }, { x: -9.9, z: -9.9 }, { x: 0, z: -14 }, { x: 9.9, z: -9.9 },
  { x: 26, z: 0 }, { x: 18.4, z: 18.4 }, { x: 0, z: 26 }, { x: -18.4, z: 18.4 },
  { x: -26, z: 0 }, { x: -18.4, z: -18.4 }, { x: 0, z: -26 }, { x: 18.4, z: -18.4 },
  { x: 6, z: 2 }, { x: -6, z: -2 }, { x: 2, z: -6 }, { x: -2, z: 6 },
  { x: 33, z: 8 }, { x: -33, z: -8 }, { x: 8, z: 33 }, { x: -8, z: -33 },
];

export const PET_SPAWN_POINTS = [
  { x: 20, z: 20 }, { x: -20, z: 20 }, { x: -20, z: -20 }, { x: 20, z: -20 },
  { x: 0, z: 32 }, { x: 32, z: 0 }, { x: 0, z: -32 }, { x: -32, z: 0 },
];

export const VALID_SKINS = ['classic', 'sprout', 'ember', 'frost', 'bolt', 'shadow'];

export const isProduction = process.env.NODE_ENV === 'production';
