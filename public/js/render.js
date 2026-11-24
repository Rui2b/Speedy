/**
 * Three.js 场景与渲染。
 *
 * 客户端只做:渲染、插值平滑、本地预测收敛。
 * 不做物理、不做资源判定。
 */
import * as THREE from '/vendor/three/three.module.js';
import { DEFAULT_SKIN, MAP, PALETTE, SIZES, SKINS } from './assets.js';
import { CharacterInstance, loadCharacter } from './character.js';
import {
  INTERPOLATION_DELAY_MS,
  SnapshotBuffer,
  convergeFactor,
  lerp,
  lerpAngle,
} from './interpolation.js';

export class GameView {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      // Chromebook 集显上 MSAA 很贵;靠像素比控制清晰度就够了
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.setClearColor(PALETTE.sky, 1);

    this.scene = new THREE.Scene();
    // 明亮的卡通场地不需要雾:有雾会把整块地压成灰绿一片
    this.scene.background = new THREE.Color(PALETTE.sky);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 260);
    this.camera.position.set(0, MAP.camera.height, MAP.camera.distance);
    this.camera.lookAt(0, 0, 0);

    /** @type {Map<string, object>} uid -> { group, buffer, facing, skinId } */
    this.otherPlayers = new Map();
    /** @type {Map<string, THREE.Object3D>} gemId -> group */
    this.gemMeshes = new Map();
    /** @type {Map<string, object>} petId -> { group, target, hatchProgress } */
    this.petMeshes = new Map();
    /** @type {Map<string, {displayName:string, skinId:string}>} */
    this.roster = new Map();

    this.selfUid = null;
    this.selfGroup = null;
    /** 本地玩家当前皮肤,拖尾颜色跟着走 */
    this.currentSkinId = DEFAULT_SKIN;
    /** 拖尾开关(默认开) */
    this.trailEnabled = true;
    /** 当前所在关卡;null 表示在 lobby,关卡几何不显示 */
    this.inStage = null;
    this.predicted = new THREE.Vector3(0, 0, 0);
    this.authoritative = new THREE.Vector3(0, 0, 0);
    this.authoritativeVel = new THREE.Vector3(0, 0, 0);
    this.facing = 0;

    /** 登录页:慢速环绕,不跟随玩家 */
    this.attractMode = true;
    this.attractAngle = Math.PI * 0.25;

    this.clock = new THREE.Clock();
    this.running = false;
    this.frameHandle = null;

    this.gemsGroup = new THREE.Group();
    this.petsGroup = new THREE.Group();
    this.playersGroup = new THREE.Group();
    this.scene.add(this.gemsGroup, this.petsGroup, this.playersGroup);

    /**
     * 跑步机踏板。
     * @type {Map<string, {group: THREE.Group, pads: THREE.Mesh[], machine: object}>}
     */
    this.treadmillMeshes = new Map();
    this.treadmillGroup = new THREE.Group();
    /** treadmillId -> 到期时间戳,只用于踏板高亮 */
    this.treadmillActiveUntil = {};
    /** 服务器下发的跑步机几何,用于本地预测的踏板支撑 */
    this.treadmillMachines = null;
    this.scene.add(this.treadmillGroup);

    this.buildEnvironment();
    this.buildDecor();
    // 先只建一个空壳:真实皮肤要等 welcome 才知道,
    // 在这里按默认值加载会白下一份模型
    this.selfGroup = null;

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    // 首次绘制时 canvas 还没有布局尺寸,等布局完成后再量一次
    this.resize();
    requestAnimationFrame(() => this.resize());
    if (typeof ResizeObserver !== 'undefined') {
      this._observer = new ResizeObserver(() => this.resize());
      this._observer.observe(canvas);
    }
  }

  /* ------------------------------------------------------------------ *
   * 环境
   * ------------------------------------------------------------------ */
  buildEnvironment() {
    const hemi = new THREE.HemisphereLight(0xffffff, 0x9fc8bb, MAP.ambientIntensity);
    this.scene.add(hemi);

    // 主光偏上偏前,让踏板的高差看得出来
    const key = new THREE.DirectionalLight(0xfff6e2, MAP.directionalIntensity);
    key.position.set(-18, 30, 14);
    this.scene.add(key);

    // 冷色补光,给右侧一点层次
    const rim = new THREE.DirectionalLight(0xbfe0ff, 0.55);
    rim.position.set(22, 14, -20);
    this.scene.add(rim);

    // 场地外圈底板
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(MAP.worldRadius + 6, 72),
      new THREE.MeshStandardMaterial({
        color: PALETTE.ground,
        roughness: 0.95,
        metalness: 0,
      }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    this.scene.add(ground);
    this.lobbyGround = ground;

    this.buildTileFloor();
    this.buildZoneMarkings();
  }

  /**
   * 方格按键式地板。
   *
   * 用一整片 InstancedMesh 铺出来,几百块砖只有一次 draw call,
   * Chromebook 上也扛得住。离场地中心越远颜色越淡,形成柔和边界。
   */
  buildTileFloor() {
    const radius = MAP.worldRadius;
    const size = MAP.tileSize;
    const half = Math.ceil(radius / size);

    /** @type {Array<{x:number,z:number,odd:boolean}>} */
    const cells = [];
    for (let ix = -half; ix <= half; ix += 1) {
      for (let iz = -half; iz <= half; iz += 1) {
        const cx = (ix + 0.5) * size;
        const cz = (iz + 0.5) * size;
        // 只保留圆心在场地内的砖
        if (Math.hypot(cx, cz) > radius) continue;
        cells.push({ x: cx, z: cz, odd: (ix + iz) % 2 === 0 });
      }
    }

    // 先在底下铺一层亮色整板,砖缝就会透出这层浅色
    const seam = new THREE.Mesh(
      new THREE.CircleGeometry(radius, 72),
      new THREE.MeshStandardMaterial({ color: PALETTE.tileSeam, roughness: 0.95 }),
    );
    seam.rotation.x = -Math.PI / 2;
    seam.position.y = 0.015;
    this.scene.add(seam);

    const geometry = new THREE.BoxGeometry(size * 0.92, 0.1, size * 0.92);
    const material = new THREE.MeshStandardMaterial({
      roughness: 0.95,
      metalness: 0.02,
    });

    const mesh = new THREE.InstancedMesh(geometry, material, cells.length);
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);

    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    const baseA = new THREE.Color(PALETTE.tileA);
    const baseB = new THREE.Color(PALETTE.tileB);

    cells.forEach((cell, index) => {
      dummy.position.set(cell.x, 0.02, cell.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);

      // 内圈是"跑动涨 speed"的区域,用暖色标出来,和外圈冷色方格拉开
      const dist = Math.hypot(cell.x, cell.z);
      if (dist <= MAP.laneSpacing * 2.1) {
        color.setHex(PALETTE.walkZone).offsetHSL(0, 0, cell.odd ? 0.02 : -0.02);
      } else {
        color.copy(cell.odd ? baseA : baseB);
      }
      mesh.setColorAt(index, color);
    });

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

    this.tileFloor = mesh;
    this.scene.add(mesh);
  }

  /**
   * 区域标记:跑动区的外圈、以及三个关卡入口的色块。
   * 全部是贴地的薄片,不参与碰撞。
   */
  buildZoneMarkings() {
    const markings = new THREE.Group();

    // 跑动区外圈:一圈醒目的虚线,告诉玩家"里面踩上去就涨速度"
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(
        MAP.laneSpacing * 2.1 - 0.22,
        MAP.laneSpacing * 2.1,
        96,
      ),
      new THREE.MeshBasicMaterial({
        color: PALETTE.walkAccent,
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.1;
    markings.add(ring);

    // 外缘护栏轮廓:一圈细环,给场地一个收口
    const boundary = new THREE.Mesh(
      new THREE.RingGeometry(MAP.worldRadius - 0.35, MAP.worldRadius - 0.1, 96),
      new THREE.MeshBasicMaterial({
        color: PALETTE.groundEdge,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    boundary.rotation.x = -Math.PI / 2;
    boundary.position.y = 0.09;
    markings.add(boundary);

    this.lobbyMarkings = markings;
    this.scene.add(markings);
  }

  /** 关卡入口的地面色块。拿到关卡配置后调用。 */
  buildStageEntrances(stages) {
    if (this.entranceGroup) {
      this.entranceGroup.removeFromParent();
      this.entranceGroup.traverse((obj) => {
        obj.geometry?.dispose?.();
        obj.material?.dispose?.();
      });
    }
    this.entranceGroup = new THREE.Group();

    // 入口放在场地边缘、玩家出生点(原点附近)看得见的一侧,
    // 不要放在相机正前方,否则会糊在镜头上。
    const count = Math.min(3, (stages ?? []).length);
    const spacing = 13;
    const z = MAP.worldRadius - 12;

    for (let i = 0; i < count; i += 1) {
      const stage = stages[i];
      const x = (i - (count - 1) / 2) * spacing;

      const pad = new THREE.Mesh(
        new THREE.BoxGeometry(10, 0.18, 10),
        new THREE.MeshStandardMaterial({
          color: PALETTE.stageEntry,
          roughness: 0.75,
          metalness: 0.05,
          emissive: PALETTE.stageEntry,
          emissiveIntensity: 0.1,
        }),
      );
      pad.position.set(x, 0.11, z);
      this.entranceGroup.add(pad);

      // 入口中央的箭头,指向场地中心,体积收小避免挡视线
      const arrow = new THREE.Mesh(
        new THREE.ConeGeometry(0.9, 1.6, 4),
        new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }),
      );
      arrow.rotation.x = -Math.PI / 2;
      arrow.position.set(x, 0.45, z - 3.4);
      this.entranceGroup.add(arrow);

      if (stage) pad.userData.stageId = stage.id;
    }

    this.scene.add(this.entranceGroup);
  }

  /**
   * 大厅装饰:看台长椅 + 路灯 + 场地边线柱。
   *
   * 全部是 Box/Cylinder 基础几何体,十几个 draw call 以内。
   * 目标是消除空旷感,但每件东西都说得清是什么。
   */
  buildDecor() {
    const group = new THREE.Group();
    const r = MAP.worldRadius - 4;

    // 场边长椅:一圈矮凳,像学校操场边的看台
    const benchSeatGeo = new THREE.BoxGeometry(6.4, 0.4, 1.6);
    const benchLegGeo = new THREE.BoxGeometry(0.44, 0.8, 1.4);
    const seatMat = new THREE.MeshStandardMaterial({ color: 0xd9a86a, roughness: 0.85 });
    const legMat = new THREE.MeshStandardMaterial({ color: 0x9a7b52, roughness: 0.9 });

    for (let i = 0; i < 6; i += 1) {
      const angle = (i / 6) * Math.PI * 2 + Math.PI / 12;
      const bench = new THREE.Group();
      const seat = new THREE.Mesh(benchSeatGeo, seatMat);
      seat.position.y = 1.0;
      bench.add(seat);
      for (const side of [-1, 1]) {
        const leg = new THREE.Mesh(benchLegGeo, legMat);
        leg.position.set(side * 2.3, 0.4, 0);
        bench.add(leg);
      }
      bench.position.set(Math.cos(angle) * r, 0, Math.sin(angle) * r);
      // 长椅朝向场地中心
      bench.rotation.y = -angle + Math.PI / 2;
      group.add(bench);
    }

    // 路灯:灯柱 + 灯头,均匀立在外圈
    const poleGeo = new THREE.CylinderGeometry(0.18, 0.26, 9, 6);
    const lampGeo = new THREE.SphereGeometry(0.7, 12, 10);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x8d9aa0, roughness: 0.6, metalness: 0.3 });
    const lampMat = new THREE.MeshStandardMaterial({
      color: 0xfff3c4,
      emissive: 0xffe9a8,
      emissiveIntensity: 0.6,
      roughness: 0.5,
    });

    for (let i = 0; i < 8; i += 1) {
      const angle = (i / 8) * Math.PI * 2;
      const px = Math.cos(angle) * (r + 4);
      const pz = Math.sin(angle) * (r + 4);

      const pole = new THREE.Mesh(poleGeo, poleMat);
      pole.position.set(px, 4.5, pz);
      group.add(pole);

      const lamp = new THREE.Mesh(lampGeo, lampMat);
      lamp.position.set(px, 9.2, pz);
      group.add(lamp);
    }

    // 场地边线柱:短的白柱,把跑动区边界点出来
    const markerGeo = new THREE.CylinderGeometry(0.28, 0.34, 1.8, 8);
    const markerMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.75 });
    for (let i = 0; i < 12; i += 1) {
      const angle = (i / 12) * Math.PI * 2;
      const marker = new THREE.Mesh(markerGeo, markerMat);
      const mr = MAP.laneSpacing * 2.1 + 1.1;
      marker.position.set(Math.cos(angle) * mr, 0.9, Math.sin(angle) * mr);
      group.add(marker);
    }

    this.decorGroup = group;
    this.scene.add(group);
  }

  /* ------------------------------------------------------------------ *
   * 模型工厂(换美术资源改这里)
   * ------------------------------------------------------------------ */
  /**
   * 造一个玩家。
   *
   * 模型是异步加载的(GLB),所以先放一个占位体保证立刻可见,
   * 加载完成后原地替换。返回的 group 始终是同一个对象,
   * 外部写入的位置/朝向不会因为替换而丢失。
   *
   * @param {{skinId?: string, isSelf?: boolean}} options
   */
  createPlayerMesh({ skinId, isSelf }) {
    const skin = SKINS[skinId] ?? SKINS[DEFAULT_SKIN];
    const group = new THREE.Group();
    group.userData.skinId = skinId;

    // 脚下的圈:标出自己/别人,和角色模型无关,始终存在
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(SIZES.ringInner, SIZES.ringOuter, 40),
      new THREE.MeshBasicMaterial({
        color: isSelf ? PALETTE.selfRing : PALETTE.otherRing,
        transparent: true,
        opacity: isSelf ? 0.9 : 0.45,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.04;
    group.add(ring);

    // 占位体:模型到之前先把人显示出来(胶囊,但只在加载的一瞬间)
    const placeholder = new THREE.Mesh(
      new THREE.CapsuleGeometry(SIZES.playerBody.x / 2, SIZES.playerBody.y, 6, 12),
      new THREE.MeshStandardMaterial({ color: skin.body, roughness: 0.72 }),
    );
    placeholder.position.y = SIZES.playerBody.y / 2 + 0.42;
    group.add(placeholder);
    group.userData.placeholder = placeholder;

    this.attachCharacter(group, skinId ?? DEFAULT_SKIN);
    return group;
  }

  /**
   * 异步加载并挂上真实角色模型。
   * 用 generation 计数丢弃过期请求:快速连点换皮肤时,晚到的旧模型不能覆盖新的。
   *
   * @param {THREE.Group} group
   * @param {string} skinId
   */
  attachCharacter(group, skinId) {
    group.userData.skinRequest = (group.userData.skinRequest ?? 0) + 1;
    const request = group.userData.skinRequest;

    loadCharacter(skinId)
      .then((proto) => {
        // 期间换过皮肤或对象已被移除,这次结果作废
        if (group.userData.skinRequest !== request) return;
        if (!group.parent && group !== this.selfGroup) return;

        const previous = group.userData.character;
        const character = new CharacterInstance(proto);
        group.add(character.group);
        group.userData.character = character;

        // 真实模型就位后去掉占位胶囊
        const placeholder = group.userData.placeholder;
        if (placeholder) {
          placeholder.removeFromParent();
          placeholder.geometry.dispose();
          placeholder.material.dispose();
          group.userData.placeholder = null;
        }

        if (previous) previous.dispose();
      })
      .catch((err) => {
        // 加载失败就保留占位体,至少玩家还看得见自己
        console.warn('[character] load failed', skinId, err?.message ?? err);
      });
  }

  /** 每帧推进所有角色的动画。 */
  updateCharacters(dt) {
    if (this.selfGroup?.userData.character) {
      const c = this.selfGroup.userData.character;
      const v = this.predictor?.vel;
      const speed = v ? Math.hypot(v.x, v.z) : 0;
      const onGround = this.predictor?.onGround ?? true;
      c.update(speed, onGround, dt);
    }
    for (const entry of this.otherPlayers.values()) {
      const c = entry.group?.userData.character;
      if (!c) continue;
      const speed = entry.lastSpeed ?? 0;
      c.update(speed, true, dt);
    }
  }

  createGemMesh() {
    const group = new THREE.Group();
    const gem = new THREE.Mesh(
      new THREE.OctahedronGeometry(SIZES.gem, 0),
      new THREE.MeshStandardMaterial({
        color: PALETTE.gem,
        emissive: PALETTE.gemGlow,
        // 宝石是暖色小物件,不是光源;场上最亮的表面留给玩家自己
        emissiveIntensity: 0.22,
        roughness: 0.35,
        metalness: 0.15,
        flatShading: true,
      }),
    );
    gem.position.y = SIZES.gem + 0.32;
    group.add(gem);

    const halo = new THREE.Mesh(
      new THREE.CircleGeometry(SIZES.gem * 1.5, 24),
      new THREE.MeshBasicMaterial({
        color: PALETTE.gemGlow,
        transparent: true,
        opacity: 0.07,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = 0.05;
    group.add(halo);

    group.userData.spin = gem;
    return group;
  }

  createPetMesh() {
    const group = new THREE.Group();

    // 蛋:椭球做底,顶部一个小尖角
    const body = new THREE.Mesh(
      new THREE.SphereGeometry(SIZES.pet / 2, 20, 16),
      new THREE.MeshStandardMaterial({
        color: PALETTE.egg,
        roughness: 0.55,
        metalness: 0.04,
      }),
    );
    body.scale.set(1, 1.25, 1);
    body.position.y = SIZES.pet / 2 + 0.24;
    group.add(body);

    const shell = new THREE.Mesh(
      new THREE.SphereGeometry(SIZES.pet / 2.1, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.42),
      new THREE.MeshStandardMaterial({ color: PALETTE.eggShell, roughness: 0.6 }),
    );
    shell.scale.set(1, 1.25, 1);
    shell.position.y = body.position.y;
    group.add(shell);

    const halo = new THREE.Mesh(
      new THREE.CircleGeometry(SIZES.pet * 1.3, 24),
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0.12,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = 0.05;
    group.add(halo);

    group.userData.body = body;
    group.userData.shell = shell;
    group.userData.halo = halo;
    return group;
  }

  /* ------------------------------------------------------------------ *
   * 状态接入
   * ------------------------------------------------------------------ */
  setSelf(uid) {
    this.selfUid = uid;
  }

  applyWelcome(msg) {
    this.setSelf(msg.uid);
    this.attractMode = false;
    this.selfGroup = this.rebuildSelfGroup(msg.skinId);
    this.selfGroup.visible = true;

    const pos = msg.self?.pos ?? { x: 0, y: 0, z: 0 };
    this.authoritative.set(pos.x, pos.y, pos.z);
    this.predicted.copy(this.authoritative);
    this.authoritativeVel.set(0, 0, 0);

    if (Array.isArray(msg.roster)) {
      this.roster.clear();
      for (const entry of msg.roster) {
        this.roster.set(entry.uid, { displayName: entry.displayName, skinId: entry.skinId });
      }
    }

    // 跑步机是场景实体,拿到配置就一次性造出来
    if (Array.isArray(msg.config?.treadmills)) {
      this.buildTreadmills(msg.config.treadmills);
    }

    // 关卡入口色块
    if (Array.isArray(msg.stages)) {
      this.buildStageEntrances(msg.stages);
    }

    this.lastSnapshotTick = msg.tick ?? 0;
  }

  rebuildSelfGroup(skinId) {
    const old = this.selfGroup;
    const fresh = this.createPlayerMesh({ skinId, isSelf: true });
    if (old) old.removeFromParent();
    fresh.position.copy(this.predicted);
    this.scene.add(fresh);
    this.currentSkinId = skinId;
    return fresh;
  }

  /**
   * 换皮肤。
   *
   * 只改本地模型和拖尾颜色。皮肤本身通过已有的 player_input 上报,
   * 服务端会校验并在 roster 里广播,所以别人也能看到新颜色。
   */
  setSkin(skinId) {
    if (!SKINS[skinId] || skinId === this.currentSkinId) return false;
    this.selfGroup = this.rebuildSelfGroup(skinId);
    this.selfGroup.visible = true;
    this.setTrailColor(skinId);
    return true;
  }

  applySnapshot(msg) {
    const now = performance.now();
    this.lastSnapshotTick = msg.tick;

    const seen = new Set();
    for (const p of msg.players ?? []) {
      seen.add(p.uid);
      let entry = this.otherPlayers.get(p.uid);
      if (!entry) {
        const rosterInfo = this.roster.get(p.uid);
        const group = this.createPlayerMesh({
          skinId: p.skinId ?? rosterInfo?.skinId ?? DEFAULT_SKIN,
          isSelf: false,
        });
        this.playersGroup.add(group);
        entry = {
          group,
          buffer: new SnapshotBuffer(),
          facing: 0,
          skinId: p.skinId,
        };
        this.otherPlayers.set(p.uid, entry);
      } else if (p.skinId && p.skinId !== entry.skinId) {
        entry.group.removeFromParent();
        const group = this.createPlayerMesh({ skinId: p.skinId, isSelf: false });
        group.position.copy(entry.group.position);
        this.playersGroup.add(group);
        entry.group = group;
        entry.skinId = p.skinId;
      }
      entry.buffer.push({ at: now, pos: p.pos, speed: p.speed ?? 0 });
      entry.lastSpeed = p.speed ?? 0;
    }
    for (const [uid, entry] of this.otherPlayers) {
      if (!seen.has(uid)) {
        entry.group.removeFromParent();
        this.otherPlayers.delete(uid);
      }
    }

    const seenGems = new Set();
    for (const g of msg.gems ?? []) {
      seenGems.add(g.gemId);
      let mesh = this.gemMeshes.get(g.gemId);
      if (!mesh) {
        mesh = this.createGemMesh();
        mesh.position.set(g.pos.x, 0, g.pos.z);
        this.gemsGroup.add(mesh);
        this.gemMeshes.set(g.gemId, mesh);
      }
      mesh.userData.target = { x: g.pos.x, z: g.pos.z };
    }
    for (const [id, mesh] of this.gemMeshes) {
      if (!seenGems.has(id)) {
        mesh.removeFromParent();
        mesh.traverse((obj) => {
          obj.geometry?.dispose?.();
          obj.material?.dispose?.();
        });
        this.gemMeshes.delete(id);
      }
    }

    // 宠物位置只在同步帧下发(每 N tick),其他帧没有这个字段。
    // 这里必须区分"这帧没带宠物"和"这帧没有宠物":当成空数组会把宠物全删掉,
    // 下一帧再建回来,画面就是一直闪。
    if (Array.isArray(msg.pets)) {
      const seenPets = new Set();
      for (const p of msg.pets) {
        seenPets.add(p.petId);
        let entry = this.petMeshes.get(p.petId);
        if (!entry) {
          const group = this.createPetMesh();
          group.position.set(p.pos.x, 0, p.pos.z);
          this.petsGroup.add(group);
          entry = { group, target: { x: p.pos.x, z: p.pos.z }, hatchProgress: 0 };
          this.petMeshes.set(p.petId, entry);
        }
        entry.target = { x: p.pos.x, z: p.pos.z };
        entry.hatchProgress = p.hatchProgress ?? 0;
        this.updatePetAppearance(entry, p.ownerUid === this.selfUid, Boolean(p.ownerUid));
      }
      for (const [id, entry] of this.petMeshes) {
        if (!seenPets.has(id)) {
          entry.group.removeFromParent();
          this.petMeshes.delete(id);
        }
      }
    }
  }

  updatePetAppearance(entry, isMine, isOwned) {
    const body = entry.group.userData.body;
    const halo = entry.group.userData.halo;
    if (!body) return;
    const hatched = entry.hatchProgress >= 100;
    let color = PALETTE.pet;
    if (isMine) color = hatched ? PALETTE.petHatched : PALETTE.petOwned;
    else if (isOwned) color = PALETTE.petOwned;
    body.material.color.setHex(color);
    halo.material.color.setHex(color);
    halo.material.opacity = isMine ? 0.24 : 0.12;
  }

  applySelfState(msg) {
    this.authoritative.set(msg.pos.x, msg.pos.y, msg.pos.z);
    this.authoritativeVel.set(msg.vel.x, msg.vel.y, msg.vel.z);
  }

  /* ------------------------------------------------------------------ *
   * 每帧
   * ------------------------------------------------------------------ */
  start() {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    const loop = () => {
      if (!this.running) return;
      this.frameHandle = requestAnimationFrame(loop);
      this.frame();
    };
    this.frameHandle = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.frameHandle);
  }

  frame() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    const renderTime = performance.now() - INTERPOLATION_DELAY_MS;

    this.updateSelf(dt);
    this.updateOthers(renderTime);
    this.updateCharacters(dt);
    this.updateGems(dt);
    this.updatePets(dt);
    this.updateTrails(dt);
    this.updateBlinkers(dt);
    this.updateTreadmills(this.treadmillActiveUntil);
    if (this.attractMode) this.updateAttractCamera(dt);
    else this.updateCamera(dt);

    this.renderer.render(this.scene, this.camera);
  }

  /**
   * 渲染开销快照,只用于排查性能问题。
   * 取自 WebGLRenderer.info,不额外渲染。
   */
  perfSnapshot() {
    const info = this.renderer.info;
    return {
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs?.length ?? 0,
    };
  }

  /**
   * 本地玩家使用 predict 模块产出的位置。
   * 位置与朝向都由 LocalPredictor 决定(它只用服务器下发的常量),
   * 这里只把结果搬到网格上。
   */
  updateSelf(dt) {
    if (!this.selfGroup) return;

    if (this.predictor) {
      this.selfGroup.position.set(
        this.predictor.pos.x,
        this.predictor.pos.y,
        this.predictor.pos.z,
      );
      const vx = this.predictor.vel.x;
      const vz = this.predictor.vel.z;
      if (Math.hypot(vx, vz) > 0.25) {
        this.facing = lerpAngle(this.facing, Math.atan2(vx, vz), convergeFactor(16, dt));
      }
    } else {
      this.selfGroup.position.set(this.predicted.x, this.predicted.y, this.predicted.z);
    }
    this.selfGroup.rotation.y = this.facing;

    this.pushTrail(this.selfGroup.position, this.facing);
  }

  /**
   * 本地预测。
   *
   * 现在由 predictor.js 里的 LocalPredictor 负责,它使用服务器下发的物理常量,
   * 与服务端积分公式完全一致。这个方法只是每帧驱动它。
   */
  predictMotion(dt, input) {
    if (!this.predictor) return;
    // jump 由输入层在网络层发出后清除,这里直接用当前采样
    // 跑步机踏板在 lobby 里是实体,预测也要踩在上面,否则会和服务端打架
    this.predictor.step(dt, input, true, this.supportHeightAt(this.predictor.pos));
  }

  /**
   * lobby 里脚下有没有踏板。
   *
   * 服务端 world.js 的 treadmillSupportHeight 是同一套规则:
   * 水平在 AABB 内、且脚底不低于顶面一个容差,就算站在踏板上。
   * @returns {number|null} 顶面高度;不在踏板上返回 null
   */
  supportHeightAt(point) {
    const machines = this.treadmillMachines;
    if (!machines) return null;
    for (const machine of machines) {
      if (point.x < machine.min.x || point.x > machine.max.x) continue;
      if (point.z < machine.min.z || point.z > machine.max.z) continue;
      if (point.y >= machine.max.y - 0.6) return machine.max.y;
    }
    return null;
  }

  /** 每帧把本地预测位置同步到相机/网格用的旧字段(供相机跟随)。 */
  syncPredictedFromPredictor() {
    if (!this.predictor) return;
    this.predicted.set(
      this.predictor.pos.x,
      this.predictor.pos.y,
      this.predictor.pos.z,
    );
  }

  /* ------------------------------------------------------------------ *
   * 关卡几何与拖尾
   * ------------------------------------------------------------------ */

  /**
   * 用服务器下发的关卡几何搭出可视模型。
   * 这里只负责画:平台、检查点、goal、消失平台。
   * 是否站得住、是否通关,全部由服务器判定。
   */
  buildStages(stages) {
    this.stages = stages;
    if (this.stageGroup) {
      this.stageGroup.removeFromParent();
      this.stageGroup.traverse((obj) => {
        obj.geometry?.dispose?.();
        obj.material?.dispose?.();
      });
    }

    this.stageGroup = new THREE.Group();
    /** blinker id -> { mesh, periodMs, enabledMs, phaseMs } */
    this.blinkerMeshes = new Map();
    /** stage id -> goal mesh */
    this.goalMeshes = new Map();

    for (const stage of stages) {
      for (const solid of stage.solids) {
        // 起点平台用暖色区分,和中间的跳跃平台分开
        const isStart = String(solid.id).includes('start');
        this.stageGroup.add(
          this.makeBoxMesh(solid.box, isStart ? PALETTE.treadmill[0].pad : PALETTE.platformSolid),
        );
      }

      for (const blinker of stage.blinkers) {
        const mesh = this.makeBoxMesh(blinker.box, PALETTE.platformBlink);
        this.stageGroup.add(mesh);
        this.blinkerMeshes.set(blinker.id, { mesh, ...blinker });
      }

      for (const cp of stage.checkpoints) {
        const flag = new THREE.Mesh(
          new THREE.CylinderGeometry(0.06, 0.06, 1.1, 8),
          new THREE.MeshBasicMaterial({ color: PALETTE.checkpoint }),
        );
        flag.position.set(cp.pos.x, cp.pos.y + 0.55, cp.pos.z);
        this.stageGroup.add(flag);
      }

      // goal 用半透明发光体,一眼可辨
      const goal = new THREE.Mesh(
        new THREE.BoxGeometry(
          stage.goal.max.x - stage.goal.min.x,
          stage.goal.max.y - stage.goal.min.y,
          stage.goal.max.z - stage.goal.min.z,
        ),
        new THREE.MeshBasicMaterial({
          color: PALETTE.goal,
          transparent: true,
          opacity: 0.18,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      goal.position.set(
        (stage.goal.min.x + stage.goal.max.x) / 2,
        (stage.goal.min.y + stage.goal.max.y) / 2,
        (stage.goal.min.z + stage.goal.max.z) / 2,
      );
      this.stageGroup.add(goal);
      this.goalMeshes.set(stage.id, goal);
    }

    // 关卡平台在 z≈-120 之外,和 lobby 是两块独立空间。
    // 不进关卡就不要显示,否则从 lobby 抬头能看到一串悬空的板子。
    this.stageGroup.visible = this.inStage !== null && this.inStage !== undefined;

    // 关卡里加一层地面色带,避免玩家悬在纯色天空里不知道掉到哪
    const stageFloor = new THREE.Mesh(
      new THREE.PlaneGeometry(90, 90),
      new THREE.MeshStandardMaterial({ color: PALETTE.walkZone, roughness: 1 }),
    );
    stageFloor.rotation.x = -Math.PI / 2;
    stageFloor.position.y = -14;
    this.stageGroup.add(stageFloor);

    this.scene.add(this.stageGroup);
  }

  /**
   * 进入 / 离开关卡时切换关卡几何的可见性。
   * 只影响渲染:玩家能不能进关卡完全由服务端判定。
   */
  setInStage(stageId) {
    this.inStage = stageId ?? null;
    if (this.stageGroup) this.stageGroup.visible = this.inStage !== null;

    // lobby 的地板/装饰在关卡里要收起:两块空间不重叠,
    // 同时画着会让画面出现"远处有另一片场地"的错位感。
    const inLobby = this.inStage === null;
    if (this.tileFloor) this.tileFloor.visible = inLobby;
    if (this.lobbyGround) this.lobbyGround.visible = inLobby;
    if (this.lobbyMarkings) this.lobbyMarkings.visible = inLobby;
    if (this.treadmillGroup) this.treadmillGroup.visible = inLobby;
    if (this.decorGroup) this.decorGroup.visible = inLobby;
    if (this.entranceGroup) this.entranceGroup.visible = inLobby;
  }

  /** 由 AABB 生成一个盒子网格。 */
  makeBoxMesh(box, color) {
    const sx = box.max.x - box.min.x;
    const sy = box.max.y - box.min.y;
    const sz = box.max.z - box.min.z;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(sx, sy, sz),
      new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.05 }),
    );
    mesh.position.set(
      (box.min.x + box.max.x) / 2,
      (box.min.y + box.max.y) / 2,
      (box.min.z + box.max.z) / 2,
    );
    return mesh;
  }

  /* ------------------------------------------------------------------ *
   * 跑步机
   * ------------------------------------------------------------------ */
  /**
   * 造一排跑步机。
   *
   * 服务器已经决定了"站上去有没有加成",这里只负责让玩家一眼看出
   * 这是一块可以踩的加速踏板:底板 + 一排亮色踏板 + 侧边扶手。
   * 全部用基础几何体,Chromebook 上也稳。
   *
   * @param {Array<object>} machines 服务器下发的 { id, name, min, max, bonus, gemPrice }
   */
  buildTreadmills(machines) {
    for (const entry of this.treadmillMeshes.values()) {
      entry.group.removeFromParent();
      entry.group.traverse((obj) => {
        obj.geometry?.dispose?.();
        obj.material?.dispose?.();
      });
    }
    this.treadmillMeshes.clear();
    this.treadmillGroup.clear();

    if (!Array.isArray(machines)) return;

    this.treadmillMachines = machines;

    for (const machine of machines) {
      const width = machine.max.x - machine.min.x;
      const depth = machine.max.z - machine.min.z;
      const group = new THREE.Group();
      group.position.set(
        (machine.min.x + machine.max.x) / 2,
        0,
        (machine.min.z + machine.max.z) / 2,
      );

      // 三档各自一套颜色,不看左侧文字也能分辨
      const tier = treadmillTier(machine.id);
      const look = PALETTE.treadmill[tier];

      // 底板:顶面正好是服务器判定的踏板高度,玩家会站在这个面上
      const padTop = machine.max.y;
      const base = new THREE.Mesh(
        new THREE.BoxGeometry(width, padTop, depth),
        new THREE.MeshStandardMaterial({
          color: look.base,
          roughness: 0.9,
          metalness: 0.08,
        }),
      );
      base.position.y = padTop / 2;
      group.add(base);

      // 造型差异:高档次多一层台面,肩高和颜色一起变化
      if (tier > 0) {
        const crown = new THREE.Mesh(
          new THREE.BoxGeometry(width * 0.86, 0.12 * tier, depth * 0.86),
          new THREE.MeshStandardMaterial({
            color: look.pad,
            roughness: 0.6,
            metalness: 0.12,
          }),
        );
        crown.position.y = padTop + 0.06 * tier;
        group.add(crown);
      }

      // 踏板:沿 z 方向一排,颜色与普通地面完全不同
      const padCount = 7;
      const padDepth = (depth - 0.5) / padCount;
      const pads = [];
      for (let i = 0; i < padCount; i += 1) {
        const pad = new THREE.Mesh(
          new THREE.BoxGeometry(width - 0.5, 0.06, padDepth * 0.82),
          new THREE.MeshStandardMaterial({
            color: look.pad,
            roughness: 0.55,
            metalness: 0.15,
            emissive: look.pad,
            emissiveIntensity: 0.12,
          }),
        );
        pad.position.set(0, padTop + 0.03, -depth / 2 + 0.25 + padDepth * (i + 0.5));
        // 动画相位错开,看起来像传送带在动
        pad.userData.phase = (i / padCount) * Math.PI * 2;
        pads.push(pad);
        group.add(pad);
      }

      // 两侧扶手,把这块区域框出来
      for (const side of [-1, 1]) {
        const rail = new THREE.Mesh(
          new THREE.BoxGeometry(0.12, 0.42, depth),
          new THREE.MeshStandardMaterial({
            color: look.rail,
            roughness: 0.5,
            metalness: 0.35,
          }),
        );
        rail.position.set((side * (width - 0.12)) / 2, padTop + 0.21, 0);
        group.add(rail);
      }

      this.treadmillGroup.add(group);
      this.treadmillMeshes.set(machine.id, { group, pads, machine, look });
    }
  }

  /**
   * 踏板循环动画 + 已购买的踏板高亮。
   *
   * 只改 emissiveIntensity 和很小的缩放,不做任何布局属性动画。
   * @param {Record<string, number>} activeUntil treadmillId -> 到期时间戳
   */
  updateTreadmills(activeUntil = {}, now = performance.now()) {
    if (this.treadmillMeshes.size === 0) return;

    const t = now * 0.001;
    for (const [id, entry] of this.treadmillMeshes) {
      const until = activeUntil[id] ?? 0;
      const active = until > Date.now();
      const look = entry.look;

      for (const pad of entry.pads) {
        const wave = 0.5 + 0.5 * Math.sin(t * 2.6 + pad.userData.phase);
        pad.material.emissive.setHex(active ? look.padActive : look.pad);
        pad.material.emissiveIntensity = active ? 0.35 + wave * 0.45 : 0.08 + wave * 0.12;
        const scale = active ? 1 + wave * 0.012 : 1;
        pad.scale.set(scale, 1, scale);
      }
    }
  }

  /** 消失平台按服务器给的周期显隐。客户端只做视觉,不参与判定。 */
  updateBlinkers() {
    if (!this.blinkerMeshes) return;
    const now = performance.now();
    for (const entry of this.blinkerMeshes.values()) {
      const period = Math.max(1, entry.periodMs);
      const enabled = Math.max(0, Math.min(period, entry.enabledMs));
      const phase = ((now + (entry.phaseMs ?? 0)) % period + period) % period;
      const on = phase < enabled;
      entry.mesh.visible = on;
      entry.mesh.material.opacity = on ? 1 : 0.12;
      entry.mesh.material.transparent = !on;
    }
  }

  /** 给本地玩家创建拖尾。颜色跟着皮肤走。 */
  ensureTrail(skinId = this.currentSkinId) {
    if (this.trail) return;
    const count = 24;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    const skin = SKINS[skinId] ?? SKINS[DEFAULT_SKIN];
    const mat = new THREE.PointsMaterial({
      color: skin.trail ?? PALETTE.trail,
      size: 0.26,
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this.trail = new THREE.Points(geo, mat);
    this.trail.frustumCulled = false;
    this.trail.visible = this.trailEnabled !== false;
    this.trailHistory = [];
    this.scene.add(this.trail);
  }

  /** 切换皮肤时把拖尾颜色一起换掉,不用重建整个几何。 */
  setTrailColor(skinId) {
    if (!this.trail) return;
    const skin = SKINS[skinId] ?? SKINS[DEFAULT_SKIN];
    this.trail.material.color.setHex(skin.trail ?? PALETTE.trail);
  }

  /** 拖尾开关:纯视觉,关掉就隐藏,不重建几何。 */
  setTrailVisible(on) {
    this.trailEnabled = Boolean(on);
    if (this.trail) this.trail.visible = this.trailEnabled;
  }

  /** 记录一个拖尾点(只在真的移动时)。 */
  pushTrail(position, facing) {
    if (!this.trail) return;
    const last = this.trailHistory[this.trailHistory.length - 1];
    const minStep = 0.35;
    if (last && Math.hypot(position.x - last.x, position.z - last.z) < minStep) return;

    this.trailHistory.push({ x: position.x, y: position.y + 0.45, z: position.z });
    if (this.trailHistory.length > 24) this.trailHistory.shift();
  }

  updateTrails() {
    if (!this.trail) return;
    const positions = this.trail.geometry.attributes.position;
    const arr = positions.array;
    for (let i = 0; i < 24; i += 1) {
      const point = this.trailHistory[i];
      arr[i * 3] = point ? point.x : 0;
      arr[i * 3 + 1] = point ? point.y : -999; // 没历史就藏到地下
      arr[i * 3 + 2] = point ? point.z : 0;
    }
    positions.needsUpdate = true;
  }

  updateOthers(renderTime) {
    for (const entry of this.otherPlayers.values()) {
      const bracket = entry.buffer.bracket(renderTime);
      if (!bracket) continue;
      const { a, b, t } = bracket;
      const nx = lerp(a.pos.x, b.pos.x, t);
      const ny = lerp(a.pos.y, b.pos.y, t);
      const nz = lerp(a.pos.z, b.pos.z, t);

      const group = entry.group;
      const dx = nx - group.position.x;
      const dz = nz - group.position.z;
      group.position.set(nx, ny, nz);
      if (Math.hypot(dx, dz) > 0.02) {
        entry.facing = lerpAngle(entry.facing, Math.atan2(dx, dz), 0.28);
      }
      group.rotation.y = entry.facing;
    }
  }

  updateGems(dt) {
    const t = performance.now() / 1000;
    for (const mesh of this.gemMeshes.values()) {
      const target = mesh.userData.target;
      if (target) {
        const k = convergeFactor(10, dt);
        mesh.position.x += (target.x - mesh.position.x) * k;
        mesh.position.z += (target.z - mesh.position.z) * k;
      }
      const spin = mesh.userData.spin;
      if (spin) {
        spin.rotation.y += dt * 1.5;
        spin.position.y = SIZES.gem + 0.32 + Math.sin(t * 2 + mesh.position.x) * 0.1;
      }
    }
  }

  updatePets(dt) {
    const t = performance.now() / 1000;
    for (const entry of this.petMeshes.values()) {
      const k = convergeFactor(8, dt);
      entry.group.position.x += (entry.target.x - entry.group.position.x) * k;
      entry.group.position.z += (entry.target.z - entry.group.position.z) * k;
      const body = entry.group.userData.body;
      if (body) body.position.y = SIZES.pet / 2 + 0.26 + Math.sin(t * 3 + entry.target.x) * 0.05;
    }
  }

  /** 登录面板打开时的慢速环绕。 */
  updateAttractCamera(dt) {
    this.attractAngle += dt * MAP.attract.speed;
    const r = MAP.attract.radius;
    const targetX = Math.sin(this.attractAngle) * r;
    const targetZ = Math.cos(this.attractAngle) * r;
    const k = convergeFactor(1.6, dt);
    this.camera.position.x += (targetX - this.camera.position.x) * k;
    this.camera.position.z += (targetZ - this.camera.position.z) * k;
    this.camera.position.y += (MAP.attract.height - this.camera.position.y) * k;
    const focus = MAP.attract.focus;
    this.camera.lookAt(focus.x, focus.y, focus.z);
  }

  updateCamera(dt) {
    const cam = MAP.camera;
    const focusX = this.predicted.x;
    const focusZ = this.predicted.z;
    const desiredX = focusX;
    const desiredZ = focusZ + cam.distance;
    const k = convergeFactor(cam.lerpRate, dt);
    this.camera.position.x += (desiredX - this.camera.position.x) * k;
    this.camera.position.z += (desiredZ - this.camera.position.z) * k;
    this.camera.position.y += (cam.height - this.camera.position.y) * k;
    this.camera.lookAt(focusX, 1.1, focusZ - cam.lookAhead);
  }

  resize() {
    const parent = this.canvas.parentElement ?? document.body;
    const width = Math.max(1, parent.clientWidth || window.innerWidth);
    const height = Math.max(1, parent.clientHeight || window.innerHeight);
    // 尺寸没变就不要反复 setSize,否则每帧都会重建绘制缓冲
    const current = this.renderer.getSize(new THREE.Vector2());
    if (current.x === width && current.y === height && this.camera.aspect === width / height) {
      return;
    }
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this.stop();
    window.removeEventListener('resize', this._onResize);
    this._observer?.disconnect();
    this.renderer.dispose();
  }

  /** 退出登录:清掉本地玩家模型与拖尾,回到登录前的环绕视角。 */
  logoutReset() {
    this.attractMode = true;
    this.predictor = null;
    if (this.selfGroup) this.selfGroup.visible = false;
    for (const entry of this.otherPlayers.values()) entry.group.removeFromParent();
    this.otherPlayers.clear();
    for (const mesh of this.gemMeshes.values()) mesh.removeFromParent();
    this.gemMeshes.clear();
    for (const entry of this.petMeshes.values()) entry.group.removeFromParent();
    this.petMeshes.clear();
    if (this.trail) {
      this.trail.removeFromParent();
      this.trail.geometry.dispose();
      this.trail.material.dispose();
      this.trail = null;
      this.trailHistory = [];
    }
  }
}

/**
 * 从跑步机 id 推断档位(0/1/2),用来挑颜色和造型。
 * id 形如 treadmill-1 / treadmill-2 / treadmill-3。
 */
function treadmillTier(id) {
  const match = /(\d+)$/.exec(String(id ?? ''));
  const n = match ? Number(match[1]) : 1;
  return Math.max(0, Math.min(2, n - 1));
}
