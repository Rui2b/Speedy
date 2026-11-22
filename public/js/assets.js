/**
 * Art assets and map configuration, kept apart from logic.
 *
 * The world is a school running track at dusk: dark asphalt, concentric lane
 * paint, chalk marks. Colours here are the ones the 3D field uses, so the
 * interface chrome can stay neutral and let the field carry the colour.
 *
 * To reskin, change values in this file only.
 */

/** Skins: body colour plus a trim colour. Add a texture map when you have one. */
export const SKINS = {
  classic: { body: 0xd9d3c6, accent: 0xe5a84b, map: null },
  sprout: { body: 0xb9c9a4, accent: 0x8fae74, map: null },
  ember: { body: 0xd99a7a, accent: 0xb4573a, map: null },
  frost: { body: 0xb6c6d4, accent: 0x7e9bb5, map: null },
  bolt: { body: 0xded3a9, accent: 0xc0a341, map: null },
  shadow: { body: 0x8b8681, accent: 0x514c47, map: null },
};

export const DEFAULT_SKIN = 'classic';

/** Scene colours. Warm ink ramp, amber lane paint. */
export const PALETTE = {
  sky: 0x14120f,
  fog: 0x14120f,
  ground: 0x24211d,
  /** Worn track surfacing between the infield and the boundary */
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
};

/** Map parameters. Change these to change the field. */
export const MAP = {
  /** Track radius in metres. Must match GAME.worldRadius on the server. */
  worldRadius: 40,
  /** How many painted lanes to draw */
  laneCount: 6,
  /** Lane line thickness in metres */
  laneWidth: 0.16,
  /** Spacing between lane centre lines in metres */
  laneSpacing: 5.4,
  ambientIntensity: 1.05,
  directionalIntensity: 1.5,
  /** Local prediction speed (visual only; the server owns the real speed) */
  predictedSpeed: 6,
  camera: {
    distance: 13,
    height: 9.4,
    lookAhead: 2.4,
    lerpRate: 9,
  },
  /** Slow orbit used behind the sign-in panel */
  attract: {
    radius: 30,
    height: 15,
    speed: 0.028,
    /** Look slightly past the centre so the lanes sweep across the frame */
    focus: { x: 0, y: 0.6, z: -6 },
  },
};

/** Model sizes in metres. */
export const SIZES = {
  playerBody: { x: 0.85, y: 1.15, z: 0.85 },
  playerHead: 0.52,
  gem: 0.42,
  pet: 0.62,
  ringInner: 0.78,
  ringOuter: 0.92,
};

/** Audio slots. Replace with real files when you have them. */
export const SOUNDS = {
  pickup: null,
  steal: null,
  hatch: null,
};
