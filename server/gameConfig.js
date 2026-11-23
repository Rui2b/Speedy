/* ------------------------------------------------------------------------- *
 * Speed 成长、跑步机、Obby 关卡与宠物规则。
 *
 * 全部是服务端权威配置:客户端只会收到渲染需要的形状与位置,
 * 判定(是否在区域内、是否通过、是否死亡)只在服务端跑。
 *
 * 改关卡 / 跑步机 / 成长速度,只改这个文件。
 */
import { num } from './config.js';

/* ------------------------------------------------------------------------- *
 * Speed 成长
 * ------------------------------------------------------------------------- */
export const SPEED = {
  /** 每 tick 的基础速度增量。20 tick/s,所以静止之外每秒约 0.4。 */
  baseGainPerTick: num('SPEED_BASE_GAIN_PER_TICK', 0.02),
  /**
   * "正在移动"的判定阈值(单位/秒)。
   * 权威速度向量长度超过它才算在跑,避免站着也涨 speed。
   */
  movingThreshold: 0.35,
  /** 转生需要的 speed 门槛 */
  rebirthMinSpeed: num('REBIRTH_MIN_SPEED', 100),
  /** 每次转生后倍率乘数 */
  rebirthMultiplierGain: num('REBIRTH_MULTIPLIER_GAIN', 1.5),
  /** 转生后回到 lobby 的出生点 */
  rebirthSpawn: { x: 0, y: 0, z: 0 },
};

/* ------------------------------------------------------------------------- *
 * 跑步机
 *
 * 玩家权威坐标落在 AABB 内、且当前购买时段未过期时,
 * speed 增量再乘以 bonus。
 *
 * 用宝石购买时段:花 gemPrice 颗宝石换 sessionMs 毫秒。
 * 越贵倍率越高。
 * ------------------------------------------------------------------------- */
export const TREADMILL = {
  /** 一次购买的有效时长,默认 10 分钟 */
  sessionMs: num('TREADMILL_SESSION_MINUTES', 10) * 60 * 1000,
  /** 站立判定的高度容差:玩家脚底必须贴在踏板顶面附近 */
  heightTolerance: 0.45,
  /** 踏板高度。玩家会真的站到这块板上,所以它同时是 lobby 的支撑面。 */
  padHeight: 0.3,
  list: [
    {
      id: 'treadmill-1',
      name: 'Treadmill I',
      min: { x: -4.4, y: 0, z: -1.8 },
      max: { x: -1.6, y: 0.3, z: 1.8 },
      gemPrice: num('TREADMILL_1_PRICE', 5),
      bonus: num('TREADMILL_1_BONUS', 2),
    },
    {
      id: 'treadmill-2',
      name: 'Treadmill II',
      min: { x: 1.6, y: 0, z: -1.8 },
      max: { x: 4.4, y: 0.3, z: 1.8 },
      gemPrice: num('TREADMILL_2_PRICE', 15),
      bonus: num('TREADMILL_2_BONUS', 3.5),
    },
    {
      id: 'treadmill-3',
      name: 'Treadmill III',
      min: { x: 7.5, y: 0, z: -1.8 },
      max: { x: 10.3, y: 0.3, z: 1.8 },
      gemPrice: num('TREADMILL_3_PRICE', 40),
      bonus: num('TREADMILL_3_BONUS', 6),
    },
  ],
};

/* ------------------------------------------------------------------------- *
 * Obby 关卡
 *
 * 1 个 World × 3 个 Stage。
 * Lobby 与关卡是分开的空间:进入关卡靠传送,而不是走过去。
 *
 * 每个 stage:
 *   origin       关卡局部坐标原点在世界中的位置(整关整体平移到这里)
 *   spawnY       进入本关的落点高度
 *   minSpeed     进入本关需要的最低 speed,不够则服务端拒绝传送
 *   deathY       低于这个高度判定掉落,传送回最近 checkpoint
 *   platforms    静态平台 AABB(y 是平台顶面)
 *   blinkers     消失平台:enabledMs / disabledMs 交替
 *   checkpoints  到达即更新重生点
 *   goal         通关触发区域
 *   quizGate     预留字段:你的网站已有答题系统,这里不用,留空即可
 *
 * 跳跃可达性(PLAYER_JUMP_IMPULSE 7.5 / PLAYER_GRAVITY 22):
 *   最高点 1.28 单位、用时 0.34s,最高水平速度 6 单位/s。
 *   因此「上升 ≤ 0.7、水平间隙 ≤ 2.0」一定过得去,平坦间隙上限约 4.0。
 *   任何平台之间的距离超过这个范围,玩家就永远过不去;
 *   改关卡几何时必须按这条约束检查。
 * ------------------------------------------------------------------------- */
export const OBBY = {
  worldId: 'speed-escape',
  /** 进入关卡时额外的落点偏移,避免和别的玩家重叠 */
  entrySpread: 1.2,
  list: [
    {
      id: 1,
      name: 'Stage 1 · Warm Up',
      origin: { x: 0, y: 0, z: -120 },
      minSpeed: 0,
      deathY: -12,
      platforms: [
        { id: 's1-start', min: { x: -4, y: 0, z: -6 }, max: { x: 4, y: 0.5, z: 2 }, kind: 'solid' },
        { id: 's1-jump1', min: { x: -3, y: 0.5, z: -11 }, max: { x: 3, y: 1.1, z: -8 }, kind: 'solid' },
        { id: 's1-jump2', min: { x: -3, y: 1.1, z: -16 }, max: { x: 3, y: 1.7, z: -13 }, kind: 'solid' },
        { id: 's1-goal', min: { x: -3, y: 1.7, z: -22 }, max: { x: 3, y: 2.3, z: -18 }, kind: 'solid' },
      ],
      blinkers: [],
      checkpoints: [
        { x: 0, y: 0.5, z: -2 },
        { x: 0, y: 1.7, z: -14.5 },
      ],
      goal: { min: { x: -3, y: 1.7, z: -22 }, max: { x: 3, y: 4.5, z: -18 } },
    },
    {
      id: 2,
      name: 'Stage 2 · Timing',
      origin: { x: 0, y: 0, z: -180 },
      minSpeed: 20,
      deathY: -12,
      platforms: [
        { id: 's2-start', min: { x: -4, y: 0, z: -6 }, max: { x: 4, y: 0.5, z: 2 }, kind: 'solid' },
        { id: 's2-mid', min: { x: -3, y: 0.6, z: -14 }, max: { x: 3, y: 1.2, z: -11 }, kind: 'solid' },
        { id: 's2-goal', min: { x: -3, y: 1.8, z: -23 }, max: { x: 3, y: 2.4, z: -20 }, kind: 'solid' },
      ],
      blinkers: [
        // 两块交替出现的平台,是同一段路的左右两条线
        {
          id: 's2-blink-a',
          min: { x: -2.4, y: 0.1, z: -9 },
          max: { x: -0.4, y: 0.7, z: -7.5 },
          periodMs: 3200,
          enabledMs: 1600,
          phaseMs: 0,
        },
        {
          id: 's2-blink-b',
          min: { x: 0.4, y: 0.1, z: -9 },
          max: { x: 2.4, y: 0.7, z: -7.5 },
          periodMs: 3200,
          enabledMs: 1600,
          phaseMs: 1600,
        },
        {
          id: 's2-blink-c',
          min: { x: -2, y: 1.2, z: -18 },
          max: { x: 2, y: 1.8, z: -16 },
          periodMs: 3200,
          enabledMs: 1600,
          phaseMs: 800,
        },
      ],
      checkpoints: [
        { x: 0, y: 0.5, z: -2 },
        { x: 0, y: 1.2, z: -12.5 },
      ],
      goal: { min: { x: -3, y: 1.8, z: -23 }, max: { x: 3, y: 4.6, z: -20 } },
    },
    {
      id: 3,
      name: 'Stage 3 · Blink',
      origin: { x: 0, y: 0, z: -240 },
      minSpeed: 60,
      deathY: -12,
      platforms: [
        { id: 's3-start', min: { x: -4, y: 0, z: -6 }, max: { x: 4, y: 0.5, z: 2 }, kind: 'solid' },
        { id: 's3-mid', min: { x: -3, y: 1.2, z: -21 }, max: { x: 3, y: 1.8, z: -17 }, kind: 'solid' },
        { id: 's3-goal', min: { x: -3, y: 2.0, z: -27 }, max: { x: 3, y: 2.6, z: -24 }, kind: 'solid' },
      ],
      blinkers: [
        {
          id: 's3-blink-a',
          min: { x: -3, y: 0, z: -10.5 },
          max: { x: 3, y: 0.5, z: -7.5 },
          periodMs: 2400,
          enabledMs: 1000,
          phaseMs: 0,
        },
        {
          id: 's3-blink-b',
          min: { x: -3, y: 0.6, z: -14.5 },
          max: { x: 3, y: 1.1, z: -11.5 },
          periodMs: 2400,
          enabledMs: 1000,
          phaseMs: 800,
        },
        {
          id: 's3-blink-c',
          min: { x: -3, y: 1.2, z: -17.5 },
          max: { x: 3, y: 1.7, z: -15.5 },
          periodMs: 2400,
          enabledMs: 1000,
          phaseMs: 1600,
        },
      ],
      checkpoints: [
        { x: 0, y: 0.5, z: -2 },
        { x: 0, y: 1.8, z: -19 },
      ],
      goal: { min: { x: -3, y: 2.0, z: -27 }, max: { x: 3, y: 4.8, z: -24 } },
    },
  ],
};

/* ------------------------------------------------------------------------- *
 * 宠物
 * ------------------------------------------------------------------------- */
export const PETS = {
  /** 稀有度权重,用于生成新蛋 */
  rarityWeights: [
    { rarity: 'common', weight: 60, hatchMs: 3 * 60 * 1000 },
    { rarity: 'rare', weight: 25, hatchMs: 8 * 60 * 1000 },
    { rarity: 'epic', weight: 12, hatchMs: 20 * 60 * 1000 },
    { rarity: 'legendary', weight: 3, hatchMs: 45 * 60 * 1000 },
  ],
  /** 宠物跟随主人的距离 */
  followDistance: 2.1,
  /** 跟着走时的高度 */
  followHeight: 0.35,
  /** 服务器下发宠物权威位置的频率(每 N 个 tick) */
  syncEveryNTicks: 5,
  /** 在 lobby 里刷多少个野生蛋 */
  wildEggCount: 8,
};

/* ------------------------------------------------------------------------- *
 * 宝石经济
 *
 * 宝石只有三个来源,全部服务端发放:
 *   1. 每关首次通关(重复通关不再给)
 *   2. 每累计 N 个新关卡发一次里程碑
 *   3. 新账号一次性启动宝石
 *
 * 曲线用对数,前期涨得快、后期收敛,不会出现天文数字。
 * 跑步机、speed、转生、挂机都不产出宝石。
 * ------------------------------------------------------------------------- */
export const GEMS = {
  /** 单关首通奖励 = floor(baseReward * ln(stage + 1)) */
  baseReward: num('GEMS_BASE_REWARD', 3),
  /** 单关奖励上限,防后期爆炸 */
  maxPerStage: num('GEMS_MAX_PER_STAGE', 16),
  /** 里程碑:每累计这么多个新关卡触发一次 */
  milestoneEvery: num('GEMS_MILESTONE_EVERY', 10),
  /** 里程碑奖励 = floor(milestoneBase * ln(group + 1)) */
  milestoneBase: num('GEMS_MILESTONE_BASE', 12),
  /** 里程碑上限 */
  maxPerMilestone: num('GEMS_MAX_PER_MILESTONE', 40),
  /** 新账号启动宝石(只发一次) */
  starterGems: num('GEMS_STARTER', 15),
};

/* ------------------------------------------------------------------------- *
 * 房间
 * ------------------------------------------------------------------------- */
export const ROOMS = {
  /** 公共 lobby 的房间 id,所有人默认进这里 */
  defaultId: 'lobby-1',
  /** 单房间人数上限 */
  maxPlayersPerRoom: num('ROOM_MAX_PLAYERS', 20),
  /** 房间总数上限,防止内存被撑爆 */
  maxRooms: num('ROOM_MAX_ROOMS', 12),
  /** 空房间多久后回收 */
  emptyRoomTtlMs: 5 * 60 * 1000,
  /** 房间 id 允许的字符 */
  idPattern: /^[a-z0-9-]{1,24}$/,
};

/* ------------------------------------------------------------------------- *
 * 排行榜
 * ------------------------------------------------------------------------- */
export const LEADERBOARD = {
  /** 下发频率 */
  broadcastEveryNTicks: 200, // 20 tick/s → 10 秒
  /** 榜单长度 */
  topN: 10,
};
