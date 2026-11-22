/**
 * Three.js scene and rendering.
 *
 * The client only renders, interpolates and converges to the authoritative
 * position. It never simulates physics or decides who owns a gem.
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
    this.scene.fog = new THREE.Fog(PALETTE.fog, 52, 108);

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
    this.predicted = new THREE.Vector3(0, 0, 0);
    this.authoritative = new THREE.Vector3(0, 0, 0);
    this.authoritativeVel = new THREE.Vector3(0, 0, 0);
    this.facing = 0;

    /** Sign-in screen: slow orbit instead of following the player. */
    this.attractMode = true;
    this.attractAngle = Math.PI * 0.25;

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
    // The canvas has no layout size yet on first paint; measure after it does.
    this.resize();
    requestAnimationFrame(() => this.resize());
    if (typeof ResizeObserver !== 'undefined') {
      this._observer = new ResizeObserver(() => this.resize());
      this._observer.observe(canvas);
    }
  }

  /* ------------------------------------------------------------------ *
   * Environment
   * ------------------------------------------------------------------ */
  buildEnvironment() {
    const hemi = new THREE.HemisphereLight(0x9fb2c9, 0x120f0c, MAP.ambientIntensity);
    this.scene.add(hemi);

    // Low dusk key light from one side, like a floodlight
    const key = new THREE.DirectionalLight(0xffe6bd, MAP.directionalIntensity);
    key.position.set(-26, 22, 18);
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(0x6f8bb0, 0.5);
    rim.position.set(24, 10, -22);
    this.scene.add(rim);

    // Infill surface
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(MAP.worldRadius + 4, 96),
      new THREE.MeshStandardMaterial({
        color: PALETTE.ground,
        roughness: 0.98,
        metalness: 0,
      }),
    );
    ground.rotation.x = -Math.PI / 2;
    this.scene.add(ground);

    // The track itself: a slightly warmer ring of worn surfacing between the
    // inner infield and the outer boundary.
    const trackInner = MAP.laneSpacing;
    const trackOuter = MAP.worldRadius - 0.6;
    const track = new THREE.Mesh(
      new THREE.RingGeometry(trackInner, trackOuter, 128),
      new THREE.MeshStandardMaterial({
        color: PALETTE.track,
        roughness: 0.95,
        metalness: 0.02,
      }),
    );
    track.rotation.x = -Math.PI / 2;
    track.position.y = 0.006;
    this.scene.add(track);

    // Lane lines: concentric rings, one in lane paint marks the inner lane
    const laneGroup = new THREE.Group();
    for (let i = 1; i <= MAP.laneCount; i += 1) {
      const radius = i * MAP.laneSpacing;
      if (radius > MAP.worldRadius) break;
      const isAccent = i === 2;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(radius - MAP.laneWidth / 2, radius + MAP.laneWidth / 2, 128),
        new THREE.MeshBasicMaterial({
          color: isAccent ? PALETTE.laneAccent : PALETTE.lane,
          // Quiet enough to stay behind the gems and players
          transparent: true,
          opacity: isAccent ? 0.24 : 0.8,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.012 + i * 0.0006;
      laneGroup.add(ring);
    }

    // Start line: a short dash across the lanes, like a stagger mark
    for (let i = 1; i < MAP.laneCount; i += 1) {
      const r = (i + 0.5) * MAP.laneSpacing;
      if (r > MAP.worldRadius) break;
      const dash = new THREE.Mesh(
        new THREE.PlaneGeometry(0.34, MAP.laneSpacing * 0.72),
        new THREE.MeshBasicMaterial({
          color: PALETTE.chalk,
          transparent: true,
          opacity: 0.55,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      dash.rotation.x = -Math.PI / 2;
      dash.position.set(r, 0.016, 0);
      laneGroup.add(dash);
    }

    // Chalk boundary at the outer edge
    const boundary = new THREE.Mesh(
      new THREE.RingGeometry(MAP.worldRadius - 0.42, MAP.worldRadius - 0.12, 128),
      new THREE.MeshBasicMaterial({
        color: PALETTE.chalk,
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    boundary.rotation.x = -Math.PI / 2;
    boundary.position.y = 0.03;
    laneGroup.add(boundary);

    this.scene.add(laneGroup);

    // Radial tick marks, like lane dividers near the outer edge
    const ticks = new THREE.Group();
    for (let i = 0; i < 32; i += 1) {
      const angle = (i / 32) * Math.PI * 2;
      const tick = new THREE.Mesh(
        new THREE.PlaneGeometry(0.1, 2.2),
        new THREE.MeshBasicMaterial({
          color: PALETTE.chalk,
          transparent: true,
          opacity: 0.3,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      tick.rotation.x = -Math.PI / 2;
      tick.rotation.z = -angle;
      const r = MAP.worldRadius - 2.2;
      tick.position.set(Math.cos(angle) * r, 0.014, Math.sin(angle) * r);
      ticks.add(tick);
    }
    this.scene.add(ticks);

    // Distant floodlights: warm pools of light at the field edge, no fixtures in
    // frame. They light the outer lane without adding clutter.
    for (let i = 0; i < 4; i += 1) {
      const angle = Math.PI / 4 + (i * Math.PI) / 2;
      const px = Math.cos(angle) * (MAP.worldRadius + 5);
      const pz = Math.sin(angle) * (MAP.worldRadius + 5);
      const glow = new THREE.PointLight(0xffd39b, 12, 26, 2);
      glow.position.set(px, 4.5, pz);
      this.scene.add(glow);
    }
  }

  /* ------------------------------------------------------------------ *
   * Mesh factories (the place to swap art)
   * ------------------------------------------------------------------ */
  createPlayerMesh({ skinId, isSelf }) {
    const skin = SKINS[skinId] ?? SKINS[DEFAULT_SKIN];
    const group = new THREE.Group();

    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(SIZES.playerBody.x / 2, SIZES.playerBody.y, 6, 16),
      new THREE.MeshStandardMaterial({
        color: skin.body,
        roughness: 0.72,
        metalness: 0.04,
        map: skin.map ?? null,
      }),
    );
    body.position.y = SIZES.playerBody.y / 2 + 0.42;
    group.add(body);

    const head = new THREE.Mesh(
      new THREE.SphereGeometry(SIZES.playerHead / 2, 20, 16),
      new THREE.MeshStandardMaterial({ color: skin.accent, roughness: 0.6 }),
    );
    head.position.y = body.position.y + SIZES.playerBody.y / 2 + SIZES.playerHead * 0.42;
    group.add(head);

    // A small marker so the facing direction reads at a glance
    const nose = new THREE.Mesh(
      new THREE.ConeGeometry(SIZES.playerHead * 0.2, SIZES.playerHead * 0.36, 12),
      new THREE.MeshStandardMaterial({ color: 0xf6f1e6, roughness: 0.5 }),
    );
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, head.position.y, SIZES.playerHead * 0.5);
    group.add(nose);

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

    group.userData.skinId = skinId;
    return group;
  }

  createGemMesh() {
    const group = new THREE.Group();
    const gem = new THREE.Mesh(
      new THREE.OctahedronGeometry(SIZES.gem, 0),
      new THREE.MeshStandardMaterial({
        color: PALETTE.gem,
        emissive: PALETTE.gemGlow,
        // Gems read as small warm objects, not light sources. The player keeps
        // the brightest surface in the scene.
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
    const body = new THREE.Mesh(
      new THREE.SphereGeometry(SIZES.pet / 2, 20, 16),
      new THREE.MeshStandardMaterial({
        color: PALETTE.pet,
        roughness: 0.68,
        metalness: 0.02,
      }),
    );
    body.position.y = SIZES.pet / 2 + 0.26;
    group.add(body);

    const eyeGeo = new THREE.SphereGeometry(SIZES.pet * 0.075, 8, 8);
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0x17140f });
    for (const sign of [-1, 1]) {
      const eye = new THREE.Mesh(eyeGeo, eyeMat);
      eye.position.set(
        sign * SIZES.pet * 0.15,
        body.position.y + SIZES.pet * 0.1,
        SIZES.pet * 0.43,
      );
      group.add(eye);
    }

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
    group.userData.halo = halo;
    return group;
  }

  /* ------------------------------------------------------------------ *
   * State intake
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
    this.lastSnapshotTick = msg.tick ?? 0;
  }

  rebuildSelfGroup(skinId) {
    const old = this.selfGroup;
    const fresh = this.createPlayerMesh({ skinId, isSelf: true });
    if (old) old.removeFromParent();
    fresh.position.copy(this.predicted);
    this.scene.add(fresh);
    return fresh;
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

    const seenPets = new Set();
    for (const p of msg.pets ?? []) {
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
   * Frame
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
    if (this.attractMode) this.updateAttractCamera(dt);
    else this.updateCamera(dt);

    this.renderer.render(this.scene, this.camera);
  }

  updateSelf(dt) {
    if (!this.selfGroup) return;
    this.predicted.lerp(this.authoritative, convergeFactor(14, dt));
    this.selfGroup.position.set(this.predicted.x, this.predicted.y, this.predicted.z);

    const vx = this.authoritativeVel.x;
    const vz = this.authoritativeVel.z;
    if (Math.hypot(vx, vz) > 0.25) {
      this.facing = lerpAngle(this.facing, Math.atan2(vx, vz), convergeFactor(12, dt));
    }
    this.selfGroup.rotation.y = this.facing;
  }

  /** Local prediction: instant visual response, corrected by the server. */
  predictMotion(dt, input) {
    if (!this.selfGroup) return;
    const speed = MAP.predictedSpeed;
    const len = Math.hypot(input.moveX, input.moveZ);
    if (len < 0.01) return;
    const nx = input.moveX / Math.max(1, len);
    const nz = input.moveZ / Math.max(1, len);
    this.predicted.x += nx * speed * dt;
    this.predicted.z += nz * speed * dt;
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

  /** Slow orbit while the sign-in panel is open. */
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
}
