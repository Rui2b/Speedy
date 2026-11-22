/**
 * 美术资源与地图配置(与逻辑分离)。
 *
 * 想换皮肤贴图 / 地图模型 / 配色,只改这个文件,不用碰渲染与联网代码。
 */

/** 皮肤定义:颜色 + 贴图(贴图留空则使用纯色)。 */
export const SKINS = {
  classic: { body: 0x4ade80, accent: 0x22c55e, map: null },
  sprout: { body: 0x86efac, accent: 0x16a34a, map: null },
  ember: { body: 0xf97316, accent: 0xdc2626, map: null },
  frost: { body: 0x7dd3fc, accent: 0x0284c7, map: null },
  bolt: { body: 0xfde047, accent: 0xca8a04, map: null },
  shadow: { body: 0x6b7280, accent: 0x374151, map: null },
};

export const DEFAULT_SKIN = 'classic';

/** 场景配色,便于整体调性调整。 */
export const PALETTE = {
  sky: 0x0b1120,
  fog: 0x0b1120,
  ground: 0x16233a,
  groundEdge: 0x24344f,
  grid: 0x2b3f5c,
  gem: 0x38bdf8,
  gemGlow: 0x0ea5e9,
  pet: 0xf472b6,
  petHatched: 0x4ade80,
  selfRing: 0x4ade80,
  otherRing: 0x64748b,
};

/** 地图参数。改这里就能改场地大小与密度。 */
export const MAP = {
  size: 96,
  gridDivisions: 48,
  /** 场地围墙高度与厚度 */
  wallHeight: 3.2,
  wallThickness: 0.9,
  /** 世界半径,必须与服务器 GAME.worldRadius 保持一致 */
  worldRadius: 40,
  /** 环境光/主光 */
  ambientIntensity: 0.85,
  directionalIntensity: 1.15,
  /** 本地预测速度(仅视觉,真实速度由服务器决定) */
  predictedSpeed: 6,
  camera: {
    distance: 13,
    height: 9.4,
    lookAhead: 2.4,
    lerpRate: 9,
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
