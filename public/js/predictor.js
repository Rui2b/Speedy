/**
 * 客户端本地预测物理。
 *
 * 与服务端 world.js 的 computeHorizontalStep / integratePlayer 使用同一套公式,
 * 常量全部来自服务器 welcome 下发的 physics 字段,客户端不另写一份。
 *
 * 重要:本地预测只用于画面。
 * 任何游戏判定(拾取、偷宠物、通关)仍然发给服务器,由服务器裁决。
 *
 * 偏差处理(按需求):
 *   - 平时用 lerp 把本地位置向权威位置收敛,收敛时长固定 100ms
 *   - 偏差超过 MAX_ALLOWED_DRIFT 时不收敛,直接对齐(作弊/丢包保护)
 */

/** 收敛时长:100ms 内走完当前偏差 */
export const CONVERGE_MS = 100;

/** 偏差阈值:超过就立刻对齐 */
export const MAX_ALLOWED_DRIFT = 1.8;

/**
 * 与服务端 computeHorizontalStep 完全对应的水平速度推进。
 *
 * @param {{x:number,y:number,z:number}} vel 当前速度
 * @param {{moveX:number,moveZ:number}} input
 * @param {number} dt 秒
 * @param {boolean} onGround
 * @param {object} phys 服务器下发的物理常量
 * @returns {{vx:number, vz:number}}
 */
export function stepHorizontal(vel, input, dt, onGround, phys) {
  const approach = (current, target, maxDelta) => {
    const diff = target - current;
    if (Math.abs(diff) <= maxDelta) return target;
    return current + Math.sign(diff) * maxDelta;
  };

  let ix = Number(input.moveX) || 0;
  let iz = Number(input.moveZ) || 0;
  ix = Math.max(-1, Math.min(1, ix));
  iz = Math.max(-1, Math.min(1, iz));
  const magnitude = Math.hypot(ix, iz);
  if (magnitude > 1) {
    ix /= magnitude;
    iz /= magnitude;
  }

  let vx = vel.x;
  let vz = vel.z;
  const control = onGround ? 1 : phys.airControl;

  if (magnitude > 0.01) {
    vx = approach(vx, ix * phys.maxSpeed, phys.acceleration * control * dt);
    vz = approach(vz, iz * phys.maxSpeed, phys.acceleration * control * dt);
  } else if (onGround) {
    // 与服务端一致:每 tick 的摩擦系数,按 tick 数做幂运算
    const decay = Math.pow(phys.friction, dt * phys.tickRate);
    vx *= decay;
    vz *= decay;
    if (Math.abs(vx) < 0.05) vx = 0;
    if (Math.abs(vz) < 0.05) vz = 0;
  }

  const speed = Math.hypot(vx, vz);
  if (speed > phys.maxSpeed) {
    vx = (vx / speed) * phys.maxSpeed;
    vz = (vz / speed) * phys.maxSpeed;
  }

  return { vx, vz };
}

/**
 * 本地预测模拟器。
 *
 * 维护一份"本地认为的位置与速度",每帧按输入推进。
 * 收到权威位置时调用 reconcile() 收敛。
 */
export class LocalPredictor {
  /**
   * @param {object} physics 服务端下发的 physics 常量
   */
  constructor(physics) {
    this.phys = physics;
    this.pos = { x: 0, y: 0, z: 0 };
    this.vel = { x: 0, y: 0, z: 0 };
    this.onGround = true;
    /** 待收敛的目标位置(权威位置) */
    this.target = null;
    /** 是否处于强制对齐状态(偏差过大) */
    this.snapped = false;
    /** 最近一次对齐时间,用于诊断 */
    this.lastSnapAt = 0;
  }

  /** 收到服务器权威状态时调用。 */
  reconcile(authoritativePos, authoritativeVel, onGround) {
    this.target = {
      x: authoritativePos.x,
      y: authoritativePos.y,
      z: authoritativePos.z,
    };
    // 速度直接以服务器为准,因为速度是加速度来源,不能在客户端累积偏差
    if (authoritativeVel) {
      this.vel.x = authoritativeVel.x;
      this.vel.z = authoritativeVel.z;
      this.vel.y = authoritativeVel.y;
    }
    this.onGround = Boolean(onGround);

    const drift = flatDistance(this.pos, this.target);
    if (drift > MAX_ALLOWED_DRIFT) {
      // 偏差过大:直接对齐,不做平滑
      this.pos.x = this.target.x;
      this.pos.y = this.target.y;
      this.pos.z = this.target.z;
      this.target = null;
      this.snapped = true;
      this.lastSnapAt = performance.now();
    } else {
      this.snapped = false;
    }
  }

  /**
   * 每帧推进。
   * @param {number} dt 秒
   * @param {{moveX:number,moveZ:number,jump:boolean}} input
   * @param {boolean} hasInput 是否收到过输入(没收到就不要自己乱动)
   * @param {number|null} [supportY] 脚下支撑面高度(跑步机踏板);null 用默认地面
   */
  step(dt, input, hasInput = true, supportY = null) {
    if (hasInput) {
      const next = stepHorizontal(this.vel, input, dt, this.onGround, this.phys);
      this.vel.x = next.vx;
      this.vel.z = next.vz;

      // 垂直:与服务端一致
      if (input.jump === true && this.onGround) {
        this.vel.y = this.phys.jumpImpulse;
        this.onGround = false;
      }
      if (!this.onGround) this.vel.y -= this.phys.gravity * dt;

      this.pos.x += this.vel.x * dt;
      this.pos.z += this.vel.z * dt;
      this.pos.y += this.vel.y * dt;

      const floor = supportY === null ? this.phys.groundY ?? 0 : supportY;
      if (this.pos.y <= floor && this.vel.y <= 0) {
        this.pos.y = floor;
        this.vel.y = 0;
        this.onGround = true;
      }
    }

    // 向权威位置收敛
    if (this.target) {
      const k = Math.min(1, (dt * 1000) / CONVERGE_MS);
      this.pos.x += (this.target.x - this.pos.x) * k;
      this.pos.y += (this.target.y - this.pos.y) * k;
      this.pos.z += (this.target.z - this.pos.z) * k;
    }
  }

  /** 硬对齐(切换关卡、复活时用)。 */
  snapTo(pos) {
    this.pos.x = pos.x;
    this.pos.y = pos.y;
    this.pos.z = pos.z;
    this.vel.x = 0;
    this.vel.y = 0;
    this.vel.z = 0;
    this.target = null;
  }
}

function flatDistance(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}
