/**
 * 角色模型加载与动画。
 *
 * 用的是 CC0 公共领域的方块角色包(见 public/vendor/models/LICENSE/)。
 * 八个角色共用一个 22 骨骼的骨架和十段动画,所以换皮肤只需要换一个文件。
 *
 * 关键约束:GLB 只加载一次,换角色时克隆已缓存的原型。
 * 每个玩家一份 SkeletonUtils.clone,否则所有人会共用一个骨架、动作同步。
 */
import * as THREE from '/vendor/three/three.module.js';
import { GLTFLoader } from '/vendor/three/GLTFLoader.js';
import { clone as cloneSkeleton } from '/vendor/three/SkeletonUtils.js';

/**
 * 皮肤 id → 模型文件。
 *
 * 服务端白名单只有 6 个皮肤(classic/sprout/ember/frost/bolt/shadow),
 * 8 个模型里挑 6 个,性格和名字对得上即可。
 */
export const SKIN_MODELS = {
  classic: 'blocky_01_hero',
  sprout: 'blocky_19_princess',
  ember: 'blocky_03_knight',
  frost: 'blocky_05_wizard',
  bolt: 'blocky_06_pirate',
  shadow: 'blocky_09_zombie',
};

/** 模型目录 */
const MODEL_DIR = '/vendor/models';
/** 模型原始高度未知,统一缩放到这个玩家身高 */
const TARGET_HEIGHT = 2.3;

const loader = new GLTFLoader();
/** @type {Map<string, Promise<object>>} */
const cache = new Map();

/**
 * 加载一个角色原型(带缓存)。
 *
 * @param {string} skinId
 * @returns {Promise<{scene: THREE.Group, animations: THREE.AnimationClip[], height: number}>}
 */
export function loadCharacter(skinId) {
  const file = SKIN_MODELS[skinId] ?? SKIN_MODELS.classic;
  if (cache.has(file)) return cache.get(file);

  const task = new Promise((resolve, reject) => {
    loader.load(
      `${MODEL_DIR}/${file}.glb`,
      (gltf) => {
        const box = new THREE.Box3().setFromObject(gltf.scene);
        const size = new THREE.Vector3();
        box.getSize(size);
        resolve({
          scene: gltf.scene,
          animations: gltf.animations ?? [],
          height: size.y || 1,
          footOffset: box.min.y,
        });
      },
      undefined,
      (err) => reject(err),
    );
  });

  cache.set(file, task);
  return task;
}

/**
 * 一个玩家的角色实例。
 *
 * 负责:骨架克隆、动画状态机(idle / walk / run / jump / fall)、朝向。
 * 位置与朝向由外部每帧写入 group,这里只管播放哪段动作。
 */
export class CharacterInstance {
  /**
   * @param {{scene: THREE.Group, animations: THREE.AnimationClip[], height: number, footOffset: number}} proto
   */
  constructor(proto) {
    this.group = new THREE.Group();

    const model = cloneSkeleton(proto.scene);
    // 统一身高,并把脚底对齐到 y=0
    const scale = TARGET_HEIGHT / (proto.height || 1);
    model.scale.setScalar(scale);
    model.position.y = -proto.footOffset * scale;

    this.group.add(model);
    this.model = model;

    this.mixer = new THREE.AnimationMixer(model);
    /** @type {Map<string, THREE.AnimationAction>} */
    this.actions = new Map();
    for (const clip of proto.animations) {
      this.actions.set(clip.name, this.mixer.clipAction(clip));
    }

    this.current = null;
    this.play('idle');
  }

  /**
   * 播放一段动画。同名重复调用不会重启动画。
   * @param {string} name
   * @param {number} [fadeMs]
   */
  play(name, fadeMs = 160) {
    const next = this.actions.get(name);
    if (!next || this.current === name) return;

    const prev = this.actions.get(this.current);
    next.reset();
    next.setLoop(THREE.LoopRepeat, Infinity);
    next.enabled = true;
    next.setEffectiveWeight(1);
    next.play();

    if (prev && prev !== next) next.crossFadeFrom(prev, fadeMs / 1000, false);
    this.current = name;
  }

  /**
   * 根据运动状态挑一段动画。
   *
   * @param {number} speed 水平速度
   * @param {boolean} onGround
   * @param {number} dt 秒
   */
  update(speed, onGround, dt) {
    if (!onGround) {
      // 上升 / 下落分开,落地前一帧看起来更自然
      this.play(speed > 0.5 ? 'jump' : 'fall');
    } else if (speed > 4) {
      this.play('run');
    } else if (speed > 0.35) {
      this.play('walk');
    } else {
      this.play('idle');
    }
    this.mixer.update(dt);
  }

  dispose() {
    this.mixer.stopAllAction();
    this.group.removeFromParent();
    this.group.traverse((obj) => {
      if (obj.isMesh) {
        obj.geometry?.dispose?.();
        obj.material?.dispose?.();
      }
    });
  }
}
