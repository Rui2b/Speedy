/**
 * 美术资源与地图配置(与逻辑分离)。
 *
 * 世界是一块明亮的数字踏板场地:柔和的浅色底、方格踏板地板,
 * 用颜色区分「跑动区 / 跑步机底座 / 关卡入口」。
 *
 * 所有颜色都在这里,3D 场景与 UI 共用同一套色板,避免两处各写一份。
 * 想换皮肤 / 地图配色,只改这个文件。
 */

/**
 * 皮肤定义:主体色 + 描边色 + 拖尾色。
 * 每个皮肤给一个明显不同的色相,方便在场上快速分辨谁是谁。
 *
 * 必须与 server/config.js 的 VALID_SKINS 保持一致:
 * 皮肤是随 player_input 上报的,服务端会校验,多出来的会被拒绝。
 */
export const SKINS = {
  classic: { body: 0xf3e7d3, accent: 0xf2a541, trail: 0xffc266, label: 'Classic' },
  sprout: { body: 0xa8dfa0, accent: 0x4f9e59, trail: 0x8ee38a, label: 'Sprout' },
  ember: { body: 0xffb09a, accent: 0xe35f3d, trail: 0xff8f6b, label: 'Ember' },
  frost: { body: 0xa9d7f5, accent: 0x3d84c6, trail: 0x8fd0ff, label: 'Frost' },
  bolt: { body: 0xffe58a, accent: 0xd9a300, trail: 0xffde5c, label: 'Bolt' },
  shadow: { body: 0xb3adc9, accent: 0x6b5f8c, trail: 0xa79bd6, label: 'Shadow' },
};

export const DEFAULT_SKIN = 'classic';

/** 皮肤顺序,用于选择面板 */
export const SKIN_ORDER = Object.keys(SKINS);

/** 场景配色:明亮卡通 + 区域色块。 */
export const PALETTE = {
  sky: 0xa8dcf5,
  fog: 0xc9e9f7,
  /** 场地外的浅色底 */
  ground: 0xe8f1ec,
  /** 方格踏板:两色交替,读起来像按键地板 */
  tileA: 0xeefaf6,
  tileB: 0xd2ece2,
  /** 方格之间的缝:比砖亮,像打光后的接缝 */
  tileSeam: 0xf7fdfb,
  /** 跑动区:玩家靠跑动涨 speed 的整片区域,明显更暖更亮 */
  walkZone: 0xfff0cf,
  /** 跑动区里更亮的一圈,提示"这里踩上去就有速度" */
  walkAccent: 0x3fc7a8,
  /** 外缘 */
  groundEdge: 0xbcd9d0,
  lane: 0xf7fbf9,
  laneAccent: 0x4fb9a1,
  chalk: 0xffffff,
  gem: 0xfff0b8,
  gemGlow: 0xf5b942,
  pet: 0xf6c8c2,
  petOwned: 0xf7cf9a,
  petHatched: 0x93dda0,
  selfRing: 0xf2a541,
  otherRing: 0x9bb3ab,
  /** Obby 平台:明亮,和地面区分 */
  platformSolid: 0x8ecae6,
  platformBlink: 0xf2a541,
  checkpoint: 0x5ecf89,
  goal: 0xffc94d,
  /** 玩家拖尾 */
  trail: 0xffc266,
  /** 蛋 */
  egg: 0xfff3d6,
  eggShell: 0xf5b942,
  /**
   * 跑步机:三档各自一个主色,不看文字也能分辨档位。
   * 底板深一档、踏板亮一档,一眼能看出"这块可以踩"。
   */
  treadmill: [
    { base: 0xd9cbb5, pad: 0xf2a541, padActive: 0xffd166, rail: 0xb99a72 },
    { base: 0xc9d4dd, pad: 0x4fa3d9, padActive: 0x86d0ff, rail: 0x85a3bd },
    { base: 0xd8c9e8, pad: 0xa06fd6, padActive: 0xd2a6ff, rail: 0xa98cc8 },
  ],
  /** 关卡入口平台的颜色 */
  stageEntry: 0xa98ce8,
  /** 装饰方块 */
  decor: [0xffd166, 0x8ecae6, 0x9fe6b8, 0xffb4a2],
};

/** 地图参数。改这里就能改场地大小与密度。 */
export const MAP = {
  /** 场地半径(米),必须与服务器 GAME.worldRadius 保持一致 */
  worldRadius: 40,
  /** 画多少条车道 */
  laneCount: 6,
  /** 车道线宽度(米) */
  laneWidth: 0.16,
  /** 车道中心线间距(米) */
  laneSpacing: 5.4,
  /** 方格踏板的边长(米)。越小越密,开销越高 */
  tileSize: 3.2,
  ambientIntensity: 1.3,
  directionalIntensity: 1.15,
  /** 本地预测速度(仅视觉,真实速度由服务器决定) */
  predictedSpeed: 6,
  camera: {
    distance: 13,
    height: 9.4,
    lookAhead: 2.4,
    lerpRate: 9,
  },
  /** 登录面板背后的慢速环绕参数 */
  attract: {
    radius: 30,
    height: 15,
    speed: 0.028,
    /** 视线略微越过中心,让车道横扫画面 */
    focus: { x: 0, y: 0.6, z: -6 },
  },
};

/** 模型尺寸(单位 = 米) */
export const SIZES = {
  playerBody: { x: 0.85, y: 1.15, z: 0.85 },
  playerHead: 0.52,
  gem: 0.42,
  pet: 0.62,
  ringInner: 0.78,
  ringOuter: 0.92,
};

/** 音效留白:后续可替换成真实音频文件。 */
export const SOUNDS = {
  pickup: null,
  steal: null,
  hatch: null,
};
