/**
 * Three.js 场景与渲染。
 *
 * 客户端只做:渲染、插值平滑、本地预测收敛。
 * 不做物理、不做资源判定。
 */
import * as THREE from '/vendor/three/three.module.js';
import { DEFAULT_SKIN, MAP, PALETTE, SIZES, SKINS } from './assets.js';
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
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(PALETTE.sky, 1);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(PALETTE.fog, 46, 96);

    this.camera = new THREE.PerspectiveCamera(52, 1, 0.1, 240);
    this.camera.position.set(0, MAP.camera.height, MAP.camera.distance);
    this.camera.lookAt(0, 0, 0);

    /** @type {Map<string, object>} uid -> { group, buffer, target, ... } */
    this.otherPlayers = new Map();
    /** @type {Map<string, THREE.Object3D>} gemId -> mesh */
    this.gemMeshes = new Map();
    /** @type {Map<string, object>} petId -> { group, target, ... } */
    this.petMeshes = new Map();
    /** @type {Map<string, {displayName:string, skinId:string}>} */
    this.roster = new Map();

    this.selfUid = null;
    this.selfGroup = null;
    this.selfRing = null;
    /** 本地预测位置(立即响应输入) */
    this.predicted = new THREE.Vector3(0, 0, 0);
    /** 服务器权威位置 */
    this.authoritative = new THREE.Vector3(0, 0, 0);
    /** 服务器下发的速度,用于本地预测 */
    this.authoritativeVel = new THREE.Vector3(0, 0, 0);
    this.facing = 0;

    this.clock = new THREE.Clock();
    this.running = false;
    this.frameHandle = null;

    this.gemsGroup = new THREE.Group();
    this.petsGroup = new THREE.Group();
    this.playersGroup = new THREE.Group();
    this.scene.add(this.gemsGroup, this.petsGroup, this.playersGroup);

    this.buildEnvironment();
    this.selfGroup = this.createPlayerMesh({ skinId: DEFAULT_SKIN, isSelf: true });
    this.selfGroup.visible = false;
    this.scene.add(this.selfGroup);

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.resize();
  }

  /* ------------------------------------------------------------------ *
   * 环境
   * ------------------------------------------------------------------ */
  buildEnvironment() {
    const hemi = new THREE.HemisphereLight(0xbcd7ff, 0x0a1220, MAP.ambientIntensity);
    this.scene.add(hemi);

    const dir = new THREE.DirectionalLight(0xffffff, MAP.directionalIntensity);
    dir.position.set(18, 30, 14);
    this.scene.add(dir);

    const groundGeo = new THREE.CircleGeometry(MAP.worldRadius, 72);
    const groundMat = new THREE.MeshStandardMaterial({
      color: PALETTE.ground,
      roughness: 0.95,
      metalness: 0.05,
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = false;
    this.scene.add(ground);

    const grid = new THREE.GridHelper(
      MAP.worldRadius * 2,
      MAP.gridDivisions,
      PALETTE.grid,
      PALETTE.grid,
    );
    grid.material.opacity = 0.22;
    grid.material.transparent = true;
    grid.position.y = 0.02;
    this.scene.add(grid);

    // 场地边界:一圈低矮环,提示可行走范围
    const ringGeo = new THREE.RingGeometry(MAP.worldRadius - MAP.wallThickness, MAP.worldRadius, 96);
    const ringMat = new THREE.MeshBasicMaterial({
      color: PALETTE.groundEdge,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.9,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    this.scene.add(ring);

    const starGeo = new THREE.BufferGeometry();
    const starCount = 220;
    const positions = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i += 1) {
      const radius = 60 + Math.random() * 60;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI * 0.42;
      positions[i * 3] = Math.cos(theta) * Math.cos(phi) * radius;
      positions[i * 3 + 1] = 10 + Math.sin(phi) * radius * 0.72;
      positions[i * 3 + 2] = Math.sin(theta) * Math.cos(phi) * radius;
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const stars = new THREE.Points(
      starGeo,
      new THREE.PointsMaterial({ color: 0xa9c4ea, size: 0.6, sizeAttenuation: true, transparent: true, opacity: 0.7 }),
    );
    this.scene.add(stars);
    this.stars = stars;
  }

  /* ------------------------------------------------------------------ *
   * 模型工厂(皮肤/贴图替换入口)
   * ------------------------------------------------------------------ */
  createPlayerMesh({ skinId, isSelf }) {
    const skin = SKINS[skinId] ?? SKINS[DEFAULT_SKIN];
    const group = new THREE.Group();

    const bodyMat = new THREE.MeshStandardMaterial({
      color: skin.body,
      roughness: 0.6,
      metalness: 0.1,
      map: skin.map ?? null,
    });
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(SIZES.playerBody.x / 2, SIZES.playerBody.y, 6, 14),
      bodyMat,
    );
    body.position.y = SIZES.playerBody.y / 2 + 0.42;
    group.add(body);

    const head = new THREE.Mesh(
      new THREE.SphereGeometry(SIZES.playerHead / 2, 18, 14),
      new THREE.MeshStandardMaterial({ color: skin.accent, roughness: 0.5 }),
    );
    head.position.y = body.position.y + SIZES.playerBody.y / 2 + SIZES.playerHead * 0.42;
    group.add(head);

    // 朝向指示:一个小鼻尖,方便看出面朝方向
    const nose = new THREE.Mesh(
      new THREE.ConeGeometry(SIZES.playerHead * 0.22, SIZES.playerHead * 0.4, 10),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 }),
    );
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, head.position.y, SIZES.playerHead * 0.5);
    group.add(nose);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(SIZES.ringInner, SIZES.ringOuter, 32),
      new THREE.MeshBasicMaterial({
        color: isSelf ? PALETTE.selfRing : PALETTE.otherRing,
        transparent: true,
        opacity: isSelf ? 0.85 : 0.5,
        side: THREE.DoubleSide,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.04;
    group.add(ring);

    group.userData.ring = ring;
    group.userData.skinId = skinId;
    return group;
  }

  createGemMesh() {
    const geo = new THREE.OctahedronGeometry(SIZES.gem, 0);
    const mat = new THREE.MeshStandardMaterial({
      color: PALETTE.gem,
      emissive: PALETTE.gemGlow,
      emissiveIntensity: 1.15,
      roughness: 0.15,
      metalness: 0.5,
      flatShading: true,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = SIZES.gem + 0.35;
    const group = new THREE.Group();
    group.add(mesh);

    // 地面光斑,提示位置
    const halo = new THREE.Mesh(
      new THREE.CircleGeometry(SIZES.gem * 1.5, 20),
      new THREE.MeshBasicMaterial({
        color: PALETTE.gemGlow,
        transparent: true,
        opacity: 0.2,
        side: THREE.DoubleSide,
      }),
    );
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = 0.05;
    group.add(halo);

    group.userData.spin = mesh;
    return group;
  }

  createPetMesh() {
    const group = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.SphereGeometry(SIZES.pet / 2, 18, 14),
      new THREE.MeshStandardMaterial({
        color: PALETTE.pet,
        emissive: PALETTE.pet,
        emissiveIntensity: 0.28,
        roughness: 0.45,
      }),
    );
    body.position.y = SIZES.pet / 2 + 0.28;
    group.add(body);

    const eyeGeo = new THREE.SphereGeometry(SIZES.pet * 0.09, 8, 8);
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0x0b1120 });
    for (const sign of [-1, 1]) {
      const eye = new THREE.Mesh(eyeGeo, eyeMat);
      eye.position.set(sign * SIZES.pet * 0.16, body.position.y + SIZES.pet * 0.12, SIZES.pet * 0.42);
      group.add(eye);
    }

    const halo = new THREE.Mesh(
      new THREE.CircleGeometry(SIZES.pet * 1.4, 20),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.16, side: THREE.DoubleSide }),
    );
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = 0.05;
    group.add(halo);

    group.userData.body = body;
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
    this.lastSnapshotTick = msg.tick ?? 0;
  }

  rebuildSelfGroup(skinId) {
    const old = this.selfGroup;
    const fresh = this.createPlayerMesh({ skinId, isSelf: true });
    if (old) {
      old.removeFromParent();
    }
    fresh.position.copy(this.predicted);
    this.scene.add(fresh);
    return fresh;
  }

  /** 服务器上行下发快照 → 更新插值缓冲 */
  applySnapshot(msg) {
    const now = performance.now();
    this.lastSnapshotTick = msg.tick;

    // 远端玩家
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
          lastPos: new THREE.Vector3(p.pos.x, p.pos.y, p.pos.z),
          facing: 0,
          skinId: p.skinId,
        };
        this.otherPlayers.set(p.uid, entry);
      } else if (p.skinId && p.skinId !== entry.skinId) {
        // 皮肤变化:重建模型
        entry.group.removeFromParent();
        const group = this.createPlayerMesh({ skinId: p.skinId, isSelf: false });
        group.position.copy(entry.group.position);
        this.playersGroup.add(group);
        entry.group = group;
        entry.skinId = p.skinId;
      }
      entry.buffer.push({ at: now, pos: p.pos, speed: p.speed ?? 0 });
    }
    for (const [uid, entry] of this.otherPlayers) {
      if (!seen.has(uid)) {
        entry.group.removeFromParent();
        this.otherPlayers.delete(uid);
      }
    }

    // 宝石
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

    // 宠物
    const seenPets = new Set();
    for (const p of msg.pets ?? []) {
      seenPets.add(p.petId);
      let entry = this.petMeshes.get(p.petId);
      if (!entry) {
        const group = this.createPetMesh();
        group.position.set(p.pos.x, 0, p.pos.z);
        this.petsGroup.add(group);
        entry = { group, target: { x: p.pos.x, z: p.pos.z }, hatchProgress: 0, owned: false };
        this.petMeshes.set(p.petId, entry);
      }
      entry.target = { x: p.pos.x, z: p.pos.z };
      entry.hatchProgress = p.hatchProgress ?? 0;
      entry.owned = Boolean(p.ownerUid);
      this.updatePetAppearance(entry, p.ownerUid === this.selfUid);
    }
    for (const [id, entry] of this.petMeshes) {
      if (!seenPets.has(id)) {
        entry.group.removeFromParent();
        this.petMeshes.delete(id);
      }
    }
  }

  updatePetAppearance(entry, isMine) {
    const body = entry.group.userData.body;
    const halo = entry.group.userData.halo;
    if (!body) return;
    const hatched = entry.hatchProgress >= 100;
    const color = isMine ? (hatched ? PALETTE.petHatched : 0x60a5fa) : PALETTE.pet;
    body.material.color.setHex(color);
    body.material.emissive.setHex(color);
    halo.material.color.setHex(color);
    halo.material.opacity = isMine ? 0.3 : 0.16;
  }

  /** 自己的权威状态 → 纠正预测 */
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
    this.updateGems(dt);
    this.updatePets(dt);
    this.updateCamera(dt);

    this.renderer.render(this.scene, this.camera);
  }

  updateSelf(dt) {
    if (!this.selfGroup) return;
    // 预测:本地立即响应当前输入(仅视觉),再向服务器权威坐标收敛
    const factor = convergeFactor(14, dt);
    this.predicted.lerp(this.authoritative, factor);

    this.selfGroup.position.set(this.predicted.x, this.predicted.y, this.predicted.z);

    const vx = this.authoritativeVel.x;
    const vz = this.authoritativeVel.z;
    if (Math.hypot(vx, vz) > 0.25) {
      const target = Math.atan2(vx, vz);
      this.facing = lerpAngle(this.facing, target, convergeFactor(12, dt));
    }
    this.selfGroup.rotation.y = this.facing;

    // 轻微起伏,让站着的角色不显得僵死
    const bob = Math.sin(performance.now() / 260) * 0.02;
    this.selfGroup.position.y += bob;
  }

  /** 本地预测:网络层每帧调用,把输入转成即时视觉位移(不含碰撞) */
  predictMotion(dt, input) {
    if (!this.selfGroup) return;
    const speed = MAP.predictedSpeed ?? 6;
    const len = Math.hypot(input.moveX, input.moveZ);
    if (len < 0.01) return;
    const nx = input.moveX / Math.max(1, len);
    const nz = input.moveZ / Math.max(1, len);
    this.predicted.x += nx * speed * dt;
    this.predicted.z += nz * speed * dt;
    // 本地预测不能跑出世界
    const dist = Math.hypot(this.predicted.x, this.predicted.z);
    if (dist > MAP.worldRadius) {
      const scale = MAP.worldRadius / dist;
      this.predicted.x *= scale;
      this.predicted.z *= scale;
    }
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
        const target = Math.atan2(dx, dz);
        entry.facing = lerpAngle(entry.facing, target, 0.28);
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
        spin.rotation.y += dt * 1.7;
        spin.position.y = SIZES.gem + 0.35 + Math.sin(t * 2 + mesh.position.x) * 0.11;
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
      if (body) body.position.y = SIZES.pet / 2 + 0.28 + Math.sin(t * 3 + entry.target.x) * 0.06;
    }
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
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this.stop();
    window.removeEventListener('resize', this._onResize);
    this.renderer.dispose();
  }
}
