/**
 * 配置中心。
 * 所有魔法数字集中在这里,方便后续调整地图、速度、宠物规则。
 * 优先读取环境变量,其次使用下面的默认值。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '..');

/** 极简 .env 解析,避免引入额外依赖。已存在的环境变量优先。 */
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
 * 网络
 * ------------------------------------------------------------------------- */
export const NETWORK = {
  host: process.env.HOST || '127.0.0.1',
  port: num('PORT', 8080),
  wsPath: '/ws',
};

/* ------------------------------------------------------------------------- *
 * 时序:客户端 20Hz 上传 / 服务器 20 tick 模拟 / 10Hz 下行广播
 * ------------------------------------------------------------------------- */
export const TIMING = {
  tickRate: num('TICK_RATE', 20),
  broadcastRate: num('BROADCAST_RATE', 10),
  /** 心跳间隔,双向 ping/pong,防止 OCI NAT 掐断空闲连接 */
  heartbeatIntervalMs: 3000,
  /** 超过这么久没收到任何上行包视为连接可能已死 */
  heartbeatTimeoutMs: 10000,
  /**
   * 输入过期时间:超过这么久没收到新的输入包,服务器按"无输入"处理。
   * 必须大于后台标签页的 5Hz 上报间隔(200ms),否则会误判为松开按键。
   */
  inputStaleMs: num('INPUT_STALE_MS', 450),
  /** 单包最大字节数,防内存炸 */
  maxPayloadBytes: 4096,
};
TIMING.tickMs = 1000 / TIMING.tickRate;
TIMING.broadcastEveryNTicks = Math.max(1, Math.round(TIMING.tickRate / TIMING.broadcastRate));
TIMING.broadcastMs = 1000 / TIMING.broadcastRate;

/* ------------------------------------------------------------------------- *
 * 玩家物理(服务器权威)
 * ------------------------------------------------------------------------- */
export const PHYSICS = {
  maxSpeed: num('PLAYER_MAX_SPEED', 6),          // units/s
  acceleration: num('PLAYER_ACCELERATION', 12),  // units/s^2
  friction: num('PLAYER_FRICTION', 0.9),         // 每 tick 的无输入阻尼系数
  jumpImpulse: num('PLAYER_JUMP_IMPULSE', 7.5),  // units/s
  gravity: num('PLAYER_GRAVITY', 22),            // units/s^2
  groundY: 0,
  /** 空中时的水平操控衰减 */
  airControl: 0.35,
};

/* ------------------------------------------------------------------------- *
 * 玩法规则
 * ------------------------------------------------------------------------- */
export const RULES = {
  gemPickupRadius: 2.2,
  petStealRadius: 2.5,
  petHatchRadius: 2.5,
  petStealCooldownMs: 12_000,   // per pet
  petHatchCooldownMs: 20_000,   // per pet
  /** 每次成功孵化动作增加的进度 */
  hatchProgressPerAction: 25,
  /** 宝石被拾取后重新刷新的时间 */
  gemRespawnMs: 8_000,
};

export const GAME = {
  maxOnline: num('MAX_ONLINE', 30),
  maxGems: 24,
  maxPets: 8,
  /** 地图可行走半径(圆形场地),防止玩家跑出世界 */
  worldRadius: 40,
  spawnRadius: 26,
};

/* ------------------------------------------------------------------------- *
 * 防作弊
 * ------------------------------------------------------------------------- */
export const ANTI_CHEAT = {
  /** 单 tick 允许位移 = maxSpeed * dt * 该倍数 */
  displacementTolerance: num('CHEAT_DISPLACEMENT_TOLERANCE', 1.45),
  /** 客户端预览坐标与权威坐标允许的最大偏差 */
  maxDrift: num('CHEAT_MAX_DRIFT', 3.5),
  /** 触发多少次异常后断开连接,0 表示只记日志 */
  strikesBeforeKick: num('CHEAT_STRIKES_BEFORE_KICK', 8),
  maxInputPacketsPerSec: num('MAX_INPUT_PACKETS_PER_SEC', 22),
  maxActionPacketsPerSec: num('MAX_ACTION_PACKETS_PER_SEC', 10),
};

/* ------------------------------------------------------------------------- *
 * 数据库与会话
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
  /** scrypt 参数 */
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
 * 地图刷新点(服务端配置,前端不可控)
 * 修改这里即可改地图布局。
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
