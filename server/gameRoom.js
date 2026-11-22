/**
 * 游戏房间:把连接、世界、主循环、持久化串起来。
 *
 * 时序(严格按方案):
 *   20 tick/s 权威模拟  → setInterval(50ms)
 *   10Hz 下行广播       → 每 2 个 tick 一次
 *   3s 心跳             → 独立定时器
 */
import crypto from 'node:crypto';
import { ANTI_CHEAT, GAME, PHYSICS, RULES, TIMING } from './config.js';
import { createLogger, logCheat } from './logger.js';
import { CLIENT_MESSAGE, SERVER_MESSAGE, parseClientMessage } from './protocol.js';
import {
  checkActionRate,
  checkInputRate,
  recordStrike,
  startCooldown,
  validateGemPickup,
  validateMovement,
  validatePetHatch,
  validatePetSteal,
} from './antiCheat.js';
import { World, createPlayerState } from './world.js';

const log = createLogger('room');

/** 每个连接在服务端的会话对象。 */
class Session {
  constructor({ ws, uid, displayName, jti, auditId }) {
    this.ws = ws;
    this.uid = uid;
    this.displayName = displayName;
    this.jti = jti;
    this.auditId = auditId;
    this.player = null;
    this.alive = true;
    this.lastPongAt = Date.now();
    this.lastSnapshotAt = 0;
  }

  send(type, payload) {
    if (this.ws.readyState !== this.ws.OPEN) return false;
    const packet = JSON.stringify({ type, ...payload });
    // 背压保护:发送缓冲积压过多说明客户端卡住了,丢弃这一帧
    if (this.ws.bufferedAmount > 512 * 1024) return false;
    this.ws.send(packet);
    return true;
  }

  close(code, reason) {
    this.alive = false;
    try {
      this.ws.close(code, reason);
    } catch {
      /* 已关闭 */
    }
  }
}

export class GameRoom {
  /**
   * @param {object} deps
   * @param {import('./store.js').PgStore} deps.store
   * @param {(session: Session) => void} [deps.onSessionClosed]
   */
  constructor({ store }) {
    this.store = store;
    this.world = new World();
    /** @type {Map<import('ws').WebSocket, Session>} */
    this.sessions = new Map();
    /** @type {Map<string, Session>} uid -> session(单端登录) */
    this.byUid = new Map();

    this.tickTimer = null;
    this.heartbeatTimer = null;
    this.flushTimer = null;
    this.tickCount = 0;
    this.lastTickAt = 0;
    this.running = false;
    /** 待广播的名单变更 */
    this.rosterDirty = true;
  }

  /* ------------------------------------------------------------------ *
   * 生命周期
   * ------------------------------------------------------------------ */
  start() {
    if (this.running) return;
    this.running = true;
    this.lastTickAt = Date.now();

    this.tickTimer = setInterval(() => this.tick(), TIMING.tickMs);
    this.heartbeatTimer = setInterval(() => this.heartbeat(), TIMING.heartbeatIntervalMs);
    // 宝石等库存攒批落库,5 秒一次,避免每次拾取都写 PG
    this.flushTimer = setInterval(() => {
      this.store.flushInventory().catch((err) => {
        log.warn('flushInventory 失败', { message: err.message });
      });
    }, 5000);

    this.tickTimer.unref?.();
    this.heartbeatTimer.unref?.();
    log.info('主循环已启动', {
      tickRate: TIMING.tickRate,
      broadcastRate: TIMING.broadcastRate,
    });
  }

  async stop() {
    this.running = false;
    clearInterval(this.tickTimer);
    clearInterval(this.heartbeatTimer);
    clearInterval(this.flushTimer);
    for (const session of [...this.sessions.values()]) {
      session.close(1001, 'server_shutdown');
    }
    await this.store.flushInventory();
  }

  /* ------------------------------------------------------------------ *
   * 连接接入
   * ------------------------------------------------------------------ */
  /**
   * @param {import('ws').WebSocket} ws
   * @param {object} identity  { uid, displayName, skinId, jti, auditId }
   */
  async attach(ws, identity) {
    if (this.world.onlineCount >= GAME.maxOnline) {
      ws.send(JSON.stringify({ type: SERVER_MESSAGE.ERROR, code: 'server_full' }));
      ws.close(1013, 'server_full');
      return null;
    }

    // 单端登录:同一 uid 的新连接踢掉旧连接
    const existing = this.byUid.get(identity.uid);
    if (existing) {
      existing.close(4001, 'replaced_by_new_session');
      this.sessions.delete(existing.ws);
      this.world.removePlayer(existing.uid);
    }

    const session = new Session({
      ws,
      uid: identity.uid,
      displayName: identity.displayName,
      jti: identity.jti,
      auditId: identity.auditId,
    });

    let profile;
    try {
      profile = await this.store.loadProfile(identity.uid);
    } catch (err) {
      log.error('加载存档失败', { uid: identity.uid, message: err.message });
      ws.close(1011, 'profile_load_failed');
      return null;
    }

    const player = createPlayerState({
      uid: identity.uid,
      displayName: identity.displayName,
      skinId: identity.skinId,
      gems: profile.inventory.gems,
    });
    this.world.attachPersistedPets(player, profile.pets);
    this.world.addPlayer(player);
    session.player = player;

    this.sessions.set(ws, session);
    this.byUid.set(identity.uid, session);
    this.rosterDirty = true;

    session.send(SERVER_MESSAGE.WELCOME, {
      uid: player.uid,
      displayName: player.displayName,
      skinId: player.skinId,
      self: this.buildSelfState(player),
      config: {
        tickRate: TIMING.tickRate,
        broadcastRate: TIMING.broadcastRate,
        maxSpeed: PHYSICS.maxSpeed,
        worldRadius: GAME.worldRadius,
        rules: {
          gemPickupRadius: RULES.gemPickupRadius,
          petStealRadius: RULES.petStealRadius,
          petHatchRadius: RULES.petHatchRadius,
          petStealCooldownMs: RULES.petStealCooldownMs,
          petHatchCooldownMs: RULES.petHatchCooldownMs,
          gemRespawnMs: RULES.gemRespawnMs,
        },
      },
      roster: this.world.buildRoster(),
      tick: this.world.tick,
    });

    log.info('玩家上线', {
      uid: identity.uid,
      name: player.displayName,
      online: this.world.onlineCount,
    });
    return session;
  }

  /**
   * 处理一条上行消息。
   */
  handleMessage(session, raw) {
    const parsed = parseClientMessage(raw);
    if (parsed.error) {
      // 协议级错误不记作弊日志(可能是老版本客户端),只做节流记录
      session.send(SERVER_MESSAGE.ERROR, { code: parsed.error });
      return 0;
    }

    const now = Date.now();

    switch (parsed.type) {
      case CLIENT_MESSAGE.PING:
        // 必须回显客户端的时间戳,否则客户端算出来的是时钟偏差而不是 RTT
        session.send(SERVER_MESSAGE.PONG, { t: parsed.payload.t });
        return 0;
      case CLIENT_MESSAGE.PONG:
        session.lastPongAt = now;
        return 0;
      case CLIENT_MESSAGE.INPUT:
        this.handleInput(session, parsed.payload, now);
        return 0;
      case CLIENT_MESSAGE.PICK_GEM:
      case CLIENT_MESSAGE.STEAL_PET:
      case CLIENT_MESSAGE.HATCH_PET:
        this.handleAction(session, parsed.type, parsed.payload, now).catch((err) => {
          log.error('操作处理异常', { uid: session.uid, message: err.message });
          session.send(SERVER_MESSAGE.ACTION_RESULT, {
            action: parsed.type,
            ok: false,
            reason: 'server_error',
          });
        });
        return 1;
      default:
        return 0;
    }
  }

  /* ------------------------------------------------------------------ *
   * 输入
   * ------------------------------------------------------------------ */
  handleInput(session, payload, now) {
    const player = session.player;
    if (!player) return;

    const rate = checkInputRate(player.rate);
    if (!rate.allowed) {
      if (recordStrike(player, {
        reason: 'input_rate',
        details: { perSecond: player.rate.inputCount, limit: ANTI_CHEAT.maxInputPacketsPerSec },
      })) {
        session.close(4002, 'input_rate_exceeded');
      }
      return;
    }

    // 丢弃重复 / 乱序 / 迟到的包
    if (payload.seq <= player.lastSeq) {
      return;
    }
    player.lastSeq = payload.seq;
    player.ackedInputs += 1;

    const movement = validateMovement(player, payload.clientPreviewPos, now);
    if (!movement.ok) {
      if (recordStrike(player, { reason: movement.reason, details: movement.details })) {
        session.close(4003, 'movement_violation');
        return;
      }
    }

    player.lastInput = payload.input;
    player.lastInputAt = now;

    if (payload.skinId && payload.skinId !== player.skinId) {
      // 皮肤只允许从白名单里选,协议层已校验
      player.skinId = payload.skinId;
      this.rosterDirty = true;
    }

    // 输入包不立即回包,坐标统一由 10Hz 的 self 状态下发,省带宽
  }

  /* ------------------------------------------------------------------ *
   * 资源操作
   * ------------------------------------------------------------------ */
  async handleAction(session, type, payload, now) {
    const player = session.player;
    if (!player) return;

    const rate = checkActionRate(player.rate);
    if (!rate.allowed) {
      if (recordStrike(player, {
        reason: 'action_rate',
        details: { perSecond: player.rate.actionCount, limit: ANTI_CHEAT.maxActionPacketsPerSec },
      })) {
        session.close(4004, 'action_rate_exceeded');
      }
      return;
    }

    switch (type) {
      case CLIENT_MESSAGE.PICK_GEM:
        return this.doPickGem(session, player, payload, now);
      case CLIENT_MESSAGE.STEAL_PET:
        return this.doStealPet(session, player, payload, now);
      case CLIENT_MESSAGE.HATCH_PET:
        return this.doHatchPet(session, player, payload, now);
      default:
        return undefined;
    }
  }

  doPickGem(session, player, payload, now) {
    const gem = this.world.gems.get(payload.gemId);
    const check = validateGemPickup(player, gem);
    if (!check.ok) {
      logCheat({
        reason: 'invalid_action',
        action: 'pick_gem',
        uid: player.uid,
        details: { result: check.reason, ...(check.details ?? {}), gemId: payload.gemId },
      });
      session.send(SERVER_MESSAGE.ACTION_RESULT, {
        action: 'pick_gem',
        ok: false,
        reason: check.reason,
      });
      return;
    }

    // 服务器权威:先标记为已拾取,再发奖励
    gem.active = false;
    gem.respawnAt = now + RULES.gemRespawnMs;
    player.gems += 1;
    this.store.markGemPickup(player.uid, 1);

    session.send(SERVER_MESSAGE.ACTION_RESULT, {
      action: 'pick_gem',
      ok: true,
      gemId: gem.gemId,
      gained: 1,
    });
    session.send(SERVER_MESSAGE.INVENTORY, {
      gems: player.gems,
      pets: this.buildPetList(player),
    });
    return;
  }

  async doStealPet(session, player, payload, now) {
    const pet = this.world.pets.get(payload.petId);
    const check = validatePetSteal(player, pet, now);
    if (!check.ok) {
      logCheat({
        reason: 'invalid_action',
        action: 'steal_pet',
        uid: player.uid,
        details: { result: check.reason, ...(check.details ?? {}), petId: payload.petId },
      });
      session.send(SERVER_MESSAGE.ACTION_RESULT, {
        action: 'steal_pet',
        ok: false,
        reason: check.reason,
      });
      return;
    }

    // 目标主人必须在线,否则世界状态和存档会不一致
    const ownerSession = this.byUid.get(pet.ownerUid);
    if (!ownerSession || !ownerSession.player) {
      session.send(SERVER_MESSAGE.ACTION_RESULT, {
        action: 'steal_pet',
        ok: false,
        reason: 'owner_offline',
      });
      return;
    }

    const previousOwner = ownerSession.player;
    const transferred = await this.store.transferPet({
      petId: pet.petId,
      fromUid: previousOwner.uid,
      toUid: player.uid,
    });
    if (!transferred) {
      session.send(SERVER_MESSAGE.ACTION_RESULT, {
        action: 'steal_pet',
        ok: false,
        reason: 'transfer_failed',
      });
      return;
    }

    // 内存状态同步
    previousOwner.petIds.delete(pet.petId);
    player.petIds.add(pet.petId);
    pet.ownerUid = player.uid;
    pet.stealCooldownUntil = now + RULES.petStealCooldownMs;
    pet.lastStolenAt = now;
    startCooldown(player, pet.petId, RULES.petStealCooldownMs, now);

    session.send(SERVER_MESSAGE.ACTION_RESULT, {
      action: 'steal_pet',
      ok: true,
      petId: pet.petId,
    });
    session.send(SERVER_MESSAGE.INVENTORY, { gems: player.gems, pets: this.buildPetList(player) });

    if (ownerSession !== session) {
      ownerSession.send(SERVER_MESSAGE.ACTION_RESULT, {
        action: 'pet_lost',
        ok: false,
        reason: 'stolen',
        petId: pet.petId,
        byUid: player.uid,
      });
      ownerSession.send(SERVER_MESSAGE.INVENTORY, {
        gems: previousOwner.gems,
        pets: this.buildPetList(previousOwner),
      });
    }
    log.info('宠物被偷', { from: previousOwner.uid, to: player.uid, petId: pet.petId });
  }

  async doHatchPet(session, player, payload, now) {
    const pet = this.world.pets.get(payload.petId);
    const check = validatePetHatch(player, pet, now);
    if (!check.ok) {
      logCheat({
        reason: 'invalid_action',
        action: 'hatch_pet',
        uid: player.uid,
        details: { result: check.reason, ...(check.details ?? {}), petId: payload.petId },
      });
      session.send(SERVER_MESSAGE.ACTION_RESULT, {
        action: 'hatch_pet',
        ok: false,
        reason: check.reason,
      });
      return;
    }

    pet.hatchProgress = Math.min(100, pet.hatchProgress + RULES.hatchProgressPerAction);
    const isHatched = pet.hatchProgress >= 100;
    if (isHatched) pet.isHatched = true;
    startCooldown(player, `hatch:${pet.petId}`, RULES.petHatchCooldownMs, now);

    try {
      await this.store.updateHatchProgress(pet.petId, player.uid, pet.hatchProgress, isHatched);
    } catch (err) {
      log.warn('写入孵化进度失败', { petId: pet.petId, message: err.message });
    }

    session.send(SERVER_MESSAGE.ACTION_RESULT, {
      action: 'hatch_pet',
      ok: true,
      petId: pet.petId,
      hatchProgress: pet.hatchProgress,
      isHatched,
    });
    session.send(SERVER_MESSAGE.INVENTORY, { gems: player.gems, pets: this.buildPetList(player) });
  }

  /* ------------------------------------------------------------------ *
   * 主循环
   * ------------------------------------------------------------------ */
  tick() {
    const now = Date.now();
    const dtMs = now - this.lastTickAt;
    this.lastTickAt = now;
    // dt 钳制:GC 停顿或系统挂起时不要一次积分几秒,避免穿墙
    const dt = Math.min(dtMs, TIMING.tickMs * 4) / 1000;

    this.world.step(dt, now);
    this.tickCount += 1;

    if (this.rosterDirty || this.tickCount % TIMING.broadcastEveryNTicks === 0) {
      this.broadcast(now);
    }
  }

  broadcast(now) {
    if (this.sessions.size === 0) {
      this.rosterDirty = false;
      return;
    }

    const roster = this.world.buildRoster();

    for (const session of this.sessions.values()) {
      const player = session.player;
      if (!player) continue;

      const snapshot = this.world.buildSnapshot(player.uid);
      session.send(SERVER_MESSAGE.SNAPSHOT, {
        tick: this.world.tick,
        players: snapshot.players,
        gems: snapshot.gems,
        pets: snapshot.pets,
      });

      // 自己的权威状态:客户端据此纠正本地预测,也用于 HUD
      session.send(SERVER_MESSAGE.SELF, {
        tick: this.world.tick,
        pos: { x: round3(player.pos.x), y: round3(player.pos.y), z: round3(player.pos.z) },
        vel: { x: round3(player.vel.x), y: round3(player.vel.y), z: round3(player.vel.z) },
        seq: player.lastSeq,
        acked: player.ackedInputs,
        onGround: player.onGround,
        skinId: player.skinId,
        gems: player.gems,
        rosterDirty: this.rosterDirty,
        roster: this.rosterDirty ? roster : undefined,
        online: this.world.onlineCount,
      });
    }
    this.rosterDirty = false;
  }

  heartbeat() {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (now - session.lastPongAt > TIMING.heartbeatTimeoutMs) {
        log.info('心跳超时,断开连接', { uid: session.uid });
        session.close(4000, 'heartbeat_timeout');
        this.detach(session, 'heartbeat_timeout');
        continue;
      }
      session.send(SERVER_MESSAGE.PING, { t: now });
    }
  }

  /* ------------------------------------------------------------------ *
   * 断开
   * ------------------------------------------------------------------ */
  detach(session, reason = 'closed') {
    if (!this.sessions.has(session.ws)) return;
    this.sessions.delete(session.ws);
    if (this.byUid.get(session.uid) === session) this.byUid.delete(session.uid);
    this.world.removePlayer(session.uid);
    this.rosterDirty = true;

    // 下线时才写库(库存 + 最后在线时间)
    this.store.markGemPickup(session.uid, 0);
    this.store
      .flushInventory()
      .catch((err) => log.warn('下线落库失败', { uid: session.uid, message: err.message }));
    this.store
      .recordDisconnect(session.uid)
      .catch((err) => log.warn('记录下线失败', { uid: session.uid, message: err.message }));
    if (session.auditId) {
      this.store
        .endSessionAudit(session.auditId, reason)
        .catch((err) => log.warn('会话审计写入失败', { message: err.message }));
    }

    log.info('玩家下线', { uid: session.uid, reason, online: this.world.onlineCount });

    // 立即广播一次,让其他人看到该玩家消失
    this.broadcast(Date.now());
  }

  /* ------------------------------------------------------------------ *
   * 快照辅助
   * ------------------------------------------------------------------ */
  buildSelfState(player) {
    return {
      pos: { x: round3(player.pos.x), y: round3(player.pos.y), z: round3(player.pos.z) },
      skinId: player.skinId,
      gems: player.gems,
      pets: this.buildPetList(player),
    };
  }

  buildPetList(player) {
    const list = [];
    for (const petId of player.petIds) {
      const pet = this.world.pets.get(petId);
      if (!pet) continue;
      list.push({
        petId: pet.petId,
        species: pet.species,
        rarity: pet.rarity,
        hatchProgress: Math.round(pet.hatchProgress),
        isHatched: pet.isHatched,
      });
    }
    return list;
  }
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

export { Session };
