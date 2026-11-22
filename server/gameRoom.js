/**
 * 房间:把连接、世界、主循环、持久化串起来。
 *
 *   20 tick/s 权威模拟
 *   10Hz 下行广播(每个房间独立)
 *   3s 心跳
 *
 * 相比上一版新增:
 *   - 多房间(RoomManager),玩家默认进公共 lobby
 *   - speed 成长、转生、跑步机
 *   - Obby 关卡进出与通关
 *   - 排行榜 10 秒推送
 *   - 宠物孵化计时与跟随
 */
import { ANTI_CHEAT, GAME, PHYSICS, RULES, TIMING } from './config.js';
import { LEADERBOARD, OBBY, PETS, ROOMS, SPEED as SPEED_CFG, TREADMILL } from './gameConfig.js';
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
import { buildStageRuntime, canEnterStage, serializeStage } from './obby.js';
import { startHatch } from './pets.js';
import { RoomManager } from './rooms.js';
import { tryBuyTreadmill, tryRebirth, treadmillState } from './speedSystem.js';
import { createPlayerState } from './world.js';

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
    /** 所在房间 id */
    this.roomId = null;
    this.alive = true;
    this.lastPongAt = Date.now();
  }

  send(type, payload) {
    if (this.ws.readyState !== this.ws.OPEN) return false;
    const packet = JSON.stringify({ type, ...payload });
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
   */
  constructor({ store }) {
    this.store = store;

    /** 关卡运行时几何(世界坐标),启动时算一次 */
    this.stages = buildStageRuntime();

    /** 房间管理 */
    this.rooms = new RoomManager({ store, stages: this.stages });

    /** @type {Map<import('ws').WebSocket, Session>} */
    this.sessions = new Map();
    /** @type {Map<string, Session>} uid -> session(单端登录) */
    this.byUid = new Map();

    this.tickTimer = null;
    this.heartbeatTimer = null;
    this.flushTimer = null;
    this.cleanupTimer = null;
    this.tickCount = 0;
    this.lastTickAt = 0;
    this.running = false;
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

    // 库存与速度攒批落库:5 秒一次,避免每 tick 写库
    this.flushTimer = setInterval(() => {
      this.store.flushInventory().catch((err) => {
        log.warn('flushInventory 失败', { message: err.message });
      });
      this.flushSpeeds().catch((err) => {
        log.warn('flushSpeeds 失败', { message: err.message });
      });
    }, 5000);

    this.cleanupTimer = setInterval(() => {
      const removed = this.rooms.reclaimIdle();
      if (removed.length > 0) log.info('回收空房间', { rooms: removed });
    }, 60_000);

    this.tickTimer.unref?.();
    this.heartbeatTimer.unref?.();
    this.flushTimer.unref?.();
    this.cleanupTimer.unref?.();

    log.info('主循环已启动', {
      tickRate: TIMING.tickRate,
      broadcastRate: TIMING.broadcastRate,
      rooms: this.rooms.rooms.size,
    });
  }

  async stop() {
    this.running = false;
    clearInterval(this.tickTimer);
    clearInterval(this.heartbeatTimer);
    clearInterval(this.flushTimer);
    clearInterval(this.cleanupTimer);

    // 关闭前把每个玩家的进度写回去
    for (const session of [...this.sessions.values()]) {
      await this.persistPlayer(session).catch(() => {});
      session.close(1001, 'server_shutdown');
    }
    await this.store.flushInventory();
  }

  /** 批量写回在线玩家的 speed,降低崩溃丢失。 */
  async flushSpeeds() {
    if (typeof this.store.saveSpeeds !== 'function') return;
    const entries = [];
    for (const session of this.sessions.values()) {
      const p = session.player;
      if (!p) continue;
      entries.push({ uid: p.uid, speed: p.speed, speedTotal: p.speedTotal });
    }
    if (entries.length > 0) await this.store.saveSpeeds(entries);
  }

  /** 写回单个玩家的完整进度。 */
  async persistPlayer(session) {
    const p = session.player;
    if (!p || typeof this.store.saveProgress !== 'function') return;
    await this.store.saveProgress(p.uid, {
      speed: p.speed,
      speedTotal: p.speedTotal,
      rebirth: p.rebirth,
      multiplier: p.multiplier,
      location: p.location,
      checkpoint: p.checkpoint,
    });
  }

  /* ------------------------------------------------------------------ *
   * 连接接入
   * ------------------------------------------------------------------ */
  /**
   * @param {import('ws').WebSocket} ws
   * @param {object} identity { uid, displayName, skinId, jti, auditId }
   * @param {string} [roomId] 期望进入的房间
   */
  async attach(ws, identity, roomId = '') {
    if (this.byUid.size >= GAME.maxOnline) {
      ws.send(JSON.stringify({ type: SERVER_MESSAGE.ERROR, code: 'server_full' }));
      ws.close(1013, 'server_full');
      return null;
    }

    // 单端登录:同一 uid 的新连接踢掉旧连接
    const existing = this.byUid.get(identity.uid);
    if (existing) {
      existing.close(4001, 'replaced_by_new_session');
      this.detach(existing, 'replaced_by_new_session');
    }

    const joined = this.rooms.joinRoom(roomId);
    if (!joined.room) {
      ws.send(
        JSON.stringify({ type: SERVER_MESSAGE.ERROR, code: joined.reason ?? 'room_unavailable' }),
      );
      ws.close(1013, joined.reason ?? 'room_unavailable');
      return null;
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
      save: profile.save,
    });

    joined.room.world.attachPersistedPets(player, profile.pets);
    joined.room.world.addPlayer(player);
    session.player = player;
    session.roomId = joined.room.id;

    this.sessions.set(ws, session);
    this.byUid.set(identity.uid, session);
    this.rooms.addSession(joined.room.id, session);

    session.send(SERVER_MESSAGE.WELCOME, {
      uid: player.uid,
      displayName: player.displayName,
      skinId: player.skinId,
      roomId: joined.room.id,
      self: this.buildSelfState(player),
      /**
       * 客户端本地预测所需的全部物理常量。
       * 全部来自服务端同一份 config.js,客户端不另写一套,
       * 保证本地预测与权威模拟的参数完全一致。
       */
      physics: {
        maxSpeed: PHYSICS.maxSpeed,
        acceleration: PHYSICS.acceleration,
        friction: PHYSICS.friction,
        jumpImpulse: PHYSICS.jumpImpulse,
        gravity: PHYSICS.gravity,
        airControl: PHYSICS.airControl,
        tickRate: TIMING.tickRate,
        inputStaleMs: TIMING.inputStaleMs,
      },
      config: {
        tickRate: TIMING.tickRate,
        broadcastRate: TIMING.broadcastRate,
        worldRadius: GAME.worldRadius,
        rules: {
          gemPickupRadius: RULES.gemPickupRadius,
          petStealRadius: RULES.petStealRadius,
          petHatchRadius: RULES.petHatchRadius,
          petStealCooldownMs: RULES.petStealCooldownMs,
          petHatchCooldownMs: RULES.petHatchCooldownMs,
          gemRespawnMs: RULES.gemRespawnMs,
        },
        treadmills: TREADMILL.list.map((m) => ({
          id: m.id,
          name: m.name,
          min: m.min,
          max: m.max,
          gemPrice: m.gemPrice,
          bonus: m.bonus,
        })),
        treadmillSessionMs: TREADMILL.sessionMs,
        rebirthMinSpeed: SPEED_CFG.rebirthMinSpeed,
        petSyncEveryNTicks: PETS.syncEveryNTicks,
      },
      stages: this.stages.map(serializeStage),
      progress: this.buildProgress(player),
      roster: joined.room.world.buildRoster(),
      rooms: this.rooms.listRooms(),
      tick: joined.room.world.tick,
    });

    log.info('玩家上线', {
      uid: identity.uid,
      name: player.displayName,
      room: joined.room.id,
      online: this.rooms.onlineCount,
    });
    return session;
  }

  /* ------------------------------------------------------------------ *
   * 上行消息
   * ------------------------------------------------------------------ */
  handleMessage(session, raw) {
    const parsed = parseClientMessage(raw);
    if (parsed.error) {
      session.send(SERVER_MESSAGE.ERROR, { code: parsed.error });
      return 0;
    }

    const now = Date.now();

    switch (parsed.type) {
      case CLIENT_MESSAGE.PING:
        session.send(SERVER_MESSAGE.PONG, { t: parsed.payload.t });
        return 0;
      case CLIENT_MESSAGE.PONG:
        session.lastPongAt = now;
        return 0;
      case CLIENT_MESSAGE.INPUT:
        this.handleInput(session, parsed.payload, now);
        return 0;
      case CLIENT_MESSAGE.REBIRTH:
        this.doRebirth(session);
        return 0;
      case CLIENT_MESSAGE.BUY_TREADMILL:
        this.doBuyTreadmill(session, parsed.payload, now);
        return 0;
      case CLIENT_MESSAGE.ENTER_STAGE:
        this.doEnterStage(session, parsed.payload, now);
        return 0;
      case CLIENT_MESSAGE.EXIT_STAGE:
        this.doExitStage(session, now);
        return 0;
      case CLIENT_MESSAGE.JOIN_ROOM:
        this.doJoinRoom(session, parsed.payload, now).catch((err) => {
          log.error('切换房间失败', { uid: session.uid, message: err.message });
        });
        return 1;
      case CLIENT_MESSAGE.REQUEST_LEADERBOARD:
        this.sendLeaderboard(session);
        return 0;
      case CLIENT_MESSAGE.REQUEST_ROOMS:
        session.send(SERVER_MESSAGE.ROOMS, { rooms: this.rooms.listRooms() });
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

  /** 当前会话所在房间。 */
  roomOf(session) {
    return this.rooms.getRoom(session.roomId);
  }

  /* ------------------------------------------------------------------ *
   * 输入
   * ------------------------------------------------------------------ */
  handleInput(session, payload, now) {
    const player = session.player;
    if (!player) return;

    const rate = checkInputRate(player.rate);
    if (!rate.allowed) {
      if (
        recordStrike(player, {
          reason: 'input_rate',
          details: { perSecond: player.rate.inputCount, limit: ANTI_CHEAT.maxInputPacketsPerSec },
        })
      ) {
        session.close(4002, 'input_rate_exceeded');
      }
      return;
    }

    // 丢弃重复 / 乱序 / 迟到的包
    if (payload.seq <= player.lastSeq) return;
    player.lastSeq = payload.seq;
    player.ackedInputs += 1;

    const movement = validateMovement(player, payload.clientPreviewPos, now);
    if (!movement.ok && recordStrike(player, { reason: movement.reason, details: movement.details })) {
      session.close(4003, 'movement_violation');
      return;
    }

    player.lastInput = payload.input;
    player.lastInputAt = now;

    if (payload.skinId && payload.skinId !== player.skinId) {
      player.skinId = payload.skinId;
      const room = this.roomOf(session);
      if (room) room.rosterDirty = true;
    }
  }

  /* ------------------------------------------------------------------ *
   * Speed / 转生 / 跑步机
   * ------------------------------------------------------------------ */
  doRebirth(session) {
    const player = session.player;
    if (!player) return;

    const result = tryRebirth(player);
    if (!result.ok) {
      session.send(SERVER_MESSAGE.ACTION_RESULT, {
        action: 'rebirth',
        ok: false,
        reason: result.reason,
        remaining: result.remaining,
      });
      return;
    }

    // 转生是低频事件,立刻落库
    this.persistPlayer(session).catch((err) =>
      log.warn('转生落库失败', { uid: player.uid, message: err.message }),
    );

    session.send(SERVER_MESSAGE.ACTION_RESULT, {
      action: 'rebirth',
      ok: true,
      rebirth: result.rebirth,
      multiplier: result.multiplier,
    });
    session.send(SERVER_MESSAGE.PROGRESS, this.buildProgress(player));
    session.send(SERVER_MESSAGE.STAGE, { stageId: null });
    log.info('玩家转生', { uid: player.uid, rebirth: player.rebirth });
  }

  doBuyTreadmill(session, payload, now) {
    const player = session.player;
    if (!player) return;

    const result = tryBuyTreadmill(player, payload.treadmillId, now);
    if (!result.ok) {
      session.send(SERVER_MESSAGE.ACTION_RESULT, {
        action: 'buy_treadmill',
        ok: false,
        reason: result.reason,
        need: result.need,
      });
      return;
    }

    session.send(SERVER_MESSAGE.ACTION_RESULT, {
      action: 'buy_treadmill',
      ok: true,
      treadmillId: result.treadmillId,
      untilMs: result.untilMs,
      gems: result.gems,
    });
    session.send(SERVER_MESSAGE.INVENTORY, { gems: player.gems, pets: this.buildPetList(player) });
    session.send(SERVER_MESSAGE.PROGRESS, this.buildProgress(player));
  }

  /* ------------------------------------------------------------------ *
   * 关卡
   * ------------------------------------------------------------------ */
  doEnterStage(session, payload, now) {
    const player = session.player;
    const room = this.roomOf(session);
    if (!player || !room) return;

    const stage = this.stages.find((s) => s.id === payload.stage);
    if (!stage) {
      session.send(SERVER_MESSAGE.ACTION_RESULT, {
        action: 'enter_stage',
        ok: false,
        reason: 'unknown_stage',
      });
      return;
    }

    // 必须按顺序解锁:前一关未通关不能进下一关
    if (stage.id > 1 && !player.clearedStages.has(stage.id - 1)) {
      session.send(SERVER_MESSAGE.ACTION_RESULT, {
        action: 'enter_stage',
        ok: false,
        reason: 'previous_stage_locked',
      });
      return;
    }

    const check = canEnterStage(stage, player);
    if (!check.ok) {
      session.send(SERVER_MESSAGE.ACTION_RESULT, {
        action: 'enter_stage',
        ok: false,
        reason: check.reason,
        need: check.need,
      });
      return;
    }

    room.world.enterStage(player, stage, now);
    session.send(SERVER_MESSAGE.ACTION_RESULT, { action: 'enter_stage', ok: true, stage: stage.id });
    session.send(SERVER_MESSAGE.STAGE, {
      stageId: stage.id,
      enteredAt: now,
      checkpoint: player.checkpoint,
    });
    session.send(SERVER_MESSAGE.SELF, this.buildSelfPayload(player, room));
  }

  doExitStage(session, now) {
    const player = session.player;
    const room = this.roomOf(session);
    if (!player || !room) return;
    room.world.exitStage(player, now);
    session.send(SERVER_MESSAGE.ACTION_RESULT, { action: 'exit_stage', ok: true });
    session.send(SERVER_MESSAGE.STAGE, { stageId: null });
    session.send(SERVER_MESSAGE.SELF, this.buildSelfPayload(player, room));
  }

  /* ------------------------------------------------------------------ *
   * 房间切换
   * ------------------------------------------------------------------ */
  async doJoinRoom(session, payload, now) {
    const player = session.player;
    if (!player) return;

    const targetId = payload.roomId || ROOMS.defaultId;
    const current = this.roomOf(session);
    if (current && current.id === targetId) {
      session.send(SERVER_MESSAGE.ACTION_RESULT, { action: 'join_room', ok: true, roomId: current.id });
      return;
    }

    const joined = this.rooms.joinRoom(targetId);
    if (!joined.room) {
      session.send(SERVER_MESSAGE.ACTION_RESULT, {
        action: 'join_room',
        ok: false,
        reason: joined.reason,
      });
      return;
    }

    if (current) {
      current.world.removePlayer(player.uid);
      current.sessions.delete(session.uid);
      current.rosterDirty = true;
      current.touch(now);
    }

    joined.room.world.addPlayer(player);
    this.rooms.addSession(joined.room.id, session);
    session.roomId = joined.room.id;

    // 换房间后回 lobby 出生点,避免落进别的房间的关卡
    joined.room.world.exitStage(player, now);

    session.send(SERVER_MESSAGE.ACTION_RESULT, { action: 'join_room', ok: true, roomId: joined.room.id });
    session.send(SERVER_MESSAGE.PROGRESS, this.buildProgress(player));
    session.send(SERVER_MESSAGE.ROOMS, { rooms: this.rooms.listRooms() });
    session.send(SERVER_MESSAGE.STAGE, { stageId: null });
    session.send(SERVER_MESSAGE.SELF, this.buildSelfPayload(player, joined.room));

    log.info('玩家切换房间', { uid: player.uid, room: joined.room.id });
  }

  /* ------------------------------------------------------------------ *
   * 资源操作(宝石 / 宠物)
   * ------------------------------------------------------------------ */
  async handleAction(session, type, payload, now) {
    const player = session.player;
    if (!player) return;

    const rate = checkActionRate(player.rate);
    if (!rate.allowed) {
      if (
        recordStrike(player, {
          reason: 'action_rate',
          details: { perSecond: player.rate.actionCount, limit: ANTI_CHEAT.maxActionPacketsPerSec },
        })
      ) {
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
    const room = this.roomOf(session);
    if (!room) return;

    const gem = room.world.gems.get(payload.gemId);
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
    session.send(SERVER_MESSAGE.INVENTORY, { gems: player.gems, pets: this.buildPetList(player) });
  }

  async doStealPet(session, player, payload, now) {
    const room = this.roomOf(session);
    if (!room) return;

    const pet = room.world.pets.get(payload.petId);
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

    const ownerSession = room.sessions.get(pet.ownerUid);
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

    previousOwner.petIds.delete(pet.petId);
    player.petIds.add(pet.petId);
    pet.ownerUid = player.uid;
    pet.stealCooldownUntil = now + RULES.petStealCooldownMs;
    pet.lastStolenAt = now;
    startCooldown(player, pet.petId, RULES.petStealCooldownMs, now);

    session.send(SERVER_MESSAGE.ACTION_RESULT, { action: 'steal_pet', ok: true, petId: pet.petId });
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
    const room = this.roomOf(session);
    if (!room) return;

    const pet = room.world.pets.get(payload.petId);
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

    // 第一次孵化:开始计时。之后由 tick 推进,玩家不用反复按。
    const startedNow = startHatch(pet, now);
    if (!startedNow && pet.hatchStartedAt) {
      session.send(SERVER_MESSAGE.ACTION_RESULT, {
        action: 'hatch_pet',
        ok: true,
        petId: pet.petId,
        hatchProgress: pet.hatchProgress,
        alreadyStarted: true,
      });
      session.send(SERVER_MESSAGE.INVENTORY, {
        gems: player.gems,
        pets: this.buildPetList(player),
      });
      return;
    }

    startCooldown(player, `hatch:${pet.petId}`, RULES.petHatchCooldownMs, now);

    try {
      await this.store.markHatchStarted(pet.petId, player.uid, now);
    } catch (err) {
      log.warn('写入孵化开始时间失败', { petId: pet.petId, message: err.message });
    }

    session.send(SERVER_MESSAGE.ACTION_RESULT, {
      action: 'hatch_pet',
      ok: true,
      petId: pet.petId,
      hatchProgress: pet.hatchProgress,
      isHatched: pet.isHatched,
      started: true,
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
    const dt = Math.min(dtMs, TIMING.tickMs * 4) / 1000;

    this.tickCount += 1;

    for (const room of this.rooms.rooms.values()) {
      if (room.playerCount === 0) continue;

      room.world.step(dt, now, this.stages, (event) => this.onStageCleared(room, event));
      this.broadcastRoom(room, now);

      // 排行榜每 10 秒推一次
      if (this.tickCount % LEADERBOARD.broadcastEveryNTicks === 0) {
        this.pushLeaderboard(room);
      }
    }
  }

  /** 通关回调:落库并通知客户端。 */
  onStageCleared(room, { player, stage, elapsedMs }) {
    this.store
      .completeStage(player.uid, OBBY.worldId, stage.id, elapsedMs)
      .then((firstTime) => {
        const session = room.sessions.get(player.uid);
        if (!session) return;
        session.send(SERVER_MESSAGE.ACTION_RESULT, {
          action: 'stage_clear',
          ok: true,
          stage: stage.id,
          firstTime: Boolean(firstTime),
          elapsedMs: Math.round(elapsedMs),
        });
        session.send(SERVER_MESSAGE.PROGRESS, this.buildProgress(player));
      })
      .catch((err) => log.warn('通关落库失败', { uid: player.uid, message: err.message }));
  }

  broadcastRoom(room, now) {
    if (room.sessions.size === 0) return;

    const roster = room.rosterDirty ? room.world.buildRoster() : null;
    const syncPets = room.world.tick % PETS.syncEveryNTicks === 0;

    for (const session of room.sessions.values()) {
      const player = session.player;
      if (!player) continue;

      const snapshot = room.world.buildSnapshot(player.uid);

      session.send(SERVER_MESSAGE.SNAPSHOT, {
        tick: room.world.tick,
        players: snapshot.players,
        gems: snapshot.gems,
        // 宠物位置单独按更低频率发,这里只在同步帧带全量
        pets: syncPets ? snapshot.pets : undefined,
      });

      session.send(SERVER_MESSAGE.SELF, this.buildSelfPayload(player, room, roster));
      session.send(SERVER_MESSAGE.PROGRESS, this.buildProgress(player));
    }
    room.rosterDirty = false;
    room.touch(now);
  }

  sendLeaderboard(session) {
    const room = this.roomOf(session);
    if (!room) return;
    session.send(SERVER_MESSAGE.LEADERBOARD, {
      roomId: room.id,
      rows: room.buildLeaderboard().slice(0, LEADERBOARD.topN),
    });
  }

  pushLeaderboard(room) {
    const rows = room.buildLeaderboard().slice(0, LEADERBOARD.topN);
    for (const session of room.sessions.values()) {
      session.send(SERVER_MESSAGE.LEADERBOARD, { roomId: room.id, rows });
    }
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

    const room = this.roomOf(session);
    if (room) {
      room.world.removePlayer(session.uid);
      room.sessions.delete(session.uid);
      room.rosterDirty = true;
      room.touch(Date.now());
    }

    // 下线是最重要的落库时机:进度 + 库存 + 最后在线
    this.persistPlayer(session).catch((err) =>
      log.warn('下线落库失败', { uid: session.uid, message: err.message }),
    );
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

    log.info('玩家下线', {
      uid: session.uid,
      room: session.roomId,
      reason,
      online: this.rooms.onlineCount,
    });
  }

  /* ------------------------------------------------------------------ *
   * 下行辅助
   * ------------------------------------------------------------------ */
  buildSelfState(player) {
    return {
      pos: { x: round3(player.pos.x), y: round3(player.pos.y), z: round3(player.pos.z) },
      skinId: player.skinId,
      gems: player.gems,
      pets: this.buildPetList(player),
      speed: player.speed,
      rebirth: player.rebirth,
      multiplier: player.multiplier,
      location: player.location,
    };
  }

  buildSelfPayload(player, room, roster = null) {
    const payload = {
      tick: room.world.tick,
      pos: { x: round3(player.pos.x), y: round3(player.pos.y), z: round3(player.pos.z) },
      vel: { x: round3(player.vel.x), y: round3(player.vel.y), z: round3(player.vel.z) },
      seq: player.lastSeq,
      acked: player.ackedInputs,
      onGround: player.onGround,
      skinId: player.skinId,
      gems: player.gems,
      speed: round3(player.speed),
      rebirth: player.rebirth,
      multiplier: player.multiplier,
      location: player.location,
      online: room.playerCount,
      rosterDirty: roster !== null,
    };
    if (roster) payload.roster = roster;
    return payload;
  }

  buildProgress(player) {
    return {
      speed: round3(player.speed),
      speedTotal: round3(player.speedTotal),
      rebirth: player.rebirth,
      multiplier: player.multiplier,
      gems: player.gems,
      location: player.location,
      clearedStages: [...player.clearedStages],
      treadmills: treadmillState(player, Date.now()),
      rebirthMinSpeed: SPEED_CFG.rebirthMinSpeed,
    };
  }

  buildPetList(player) {
    const room = this.roomOf({ roomId: this.roomIdOf(player.uid) });
    const list = [];
    for (const petId of player.petIds) {
      const pet = room ? room.world.pets.get(petId) : this.findPetAnywhere(petId);
      if (!pet) continue;
      list.push({
        petId: pet.petId,
        species: pet.species,
        rarity: pet.rarity,
        hatchProgress: pet.hatchProgress,
        isHatched: pet.isHatched,
        isEgg: pet.isEgg,
      });
    }
    return list;
  }

  /** 按 uid 反查所在房间 id(宠物列表需要)。 */
  roomIdOf(uid) {
    const session = this.byUid.get(uid);
    return session?.roomId ?? null;
  }

  findPetAnywhere(petId) {
    for (const room of this.rooms.rooms.values()) {
      const pet = room.world.pets.get(petId);
      if (pet) return pet;
    }
    return null;
  }
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

export { Session };
