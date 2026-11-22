/**
 * 美术资源与地图配置(与逻辑分离)。
 *
 * 世界是一圈黄昏的学校跑道:深色沥青、同心车道漆、粉笔标记。
 * 这里定义的颜色就是 3D 场地用的颜色,所以界面本身保持中性,
 * 让场地去承载色彩。
 *
 * 想换皮肤贴图 / 地图模型 / 配色,只改这个文件。
 */

/** 皮肤定义:主体色 + 描边色(贴图留空则使用纯色)。 */
export const SKINS = {
  classic: { body: 0xd9d3c6, accent: 0xe5a84b, map: null },
  sprout: { body: 0xb9c9a4, accent: 0x8fae74, map: null },
  ember: { body: 0xd99a7a, accent: 0xb4573a, map: null },
  frost: { body: 0xb6c6d4, accent: 0x7e9bb5, map: null },
  bolt: { body: 0xded3a9, accent: 0xc0a341, map: null },
  shadow: { body: 0x8b8681, accent: 0x514c47, map: null },
};

export const DEFAULT_SKIN = 'classic';

/** 场景配色:暖墨色系 + 琥珀跑道漆。 */
export const PALETTE = {
  sky: 0x14120f,
  fog: 0x14120f,
  ground: 0x24211d,
  /** 内场与外缘之间磨旧的跑道铺装 */
  track: 0x312c26,
  groundEdge: 0x2a2724,
  lane: 0x6f6659,
  laneAccent: 0xe5a84b,
  chalk: 0x8c8172,
  gem: 0xe8d2a4,
  gemGlow: 0xc9973f,
  pet: 0xd8b0a8,
  petOwned: 0xe0bb8a,
  petHatched: 0x9fd3a5,
  selfRing: 0xe5a84b,
  otherRing: 0x7d766c,
  /** Obby 平台 */
  platformSolid: 0x3a352f,
  platformBlink: 0x8a6a3a,
  checkpoint: 0x7fb886,
  goal: 0xe5a84b,
  /** 玩家拖尾 */
  trail: 0xe5a84b,
  /** 蛋 */
  egg: 0xe8d2a4,
  eggShell: 0xc9973f,
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
  ambientIntensity: 1.05,
  directionalIntensity: 1.5,
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
