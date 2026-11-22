/**
 * The room: connections, world, main loop and persistence wired together.
 *
 *   authoritative simulation at 20 ticks/s
 *   downlink broadcast at 10Hz, every second tick
 *   heartbeat every 3s on its own timer
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

/** One server side session per connection. */
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
    // Backpressure: a large send buffer means a stuck client, so drop this frame
    if (this.ws.bufferedAmount > 512 * 1024) return false;
    this.ws.send(packet);
    return true;
  }

  close(code, reason) {
    this.alive = false;
    try {
      this.ws.close(code, reason);
    } catch {
      /* already closed */
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
    /** @type {Map<string, Session>} uid -> session, one live session per account */
    this.byUid = new Map();

    this.tickTimer = null;
    this.heartbeatTimer = null;
    this.flushTimer = null;
    this.tickCount = 0;
    this.lastTickAt = 0;
    this.running = false;
    /** Roster changed and needs one broadcast */
    this.rosterDirty = true;
  }

  /* ------------------------------------------------------------------ *
   * Lifecycle
   * ------------------------------------------------------------------ */
  start() {
    if (this.running) return;
    this.running = true;
    this.lastTickAt = Date.now();

    this.tickTimer = setInterval(() => this.tick(), TIMING.tickMs);
    this.heartbeatTimer = setInterval(() => this.heartbeat(), TIMING.heartbeatIntervalMs);
    // Flush inventory counters every 5s instead of writing on every pickup
    this.flushTimer = setInterval(() => {
      this.store.flushInventory().catch((err) => {
        log.warn('flushInventory failed', { message: err.message });
      });
    }, 5000);

    this.tickTimer.unref?.();
    this.heartbeatTimer.unref?.();
    log.info('main loop started', {
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
   * Attaching a connection
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

    // Single session per account: a new connection evicts the old one
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
      log.error('could not load profile', { uid: identity.uid, message: err.message });
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

    log.info('player joined', {
      uid: identity.uid,
      name: player.displayName,
      online: this.world.onlineCount,
    });
    return session;
  }

  /**
   * Handle one upstream message.
   */
  handleMessage(session, raw) {
    const parsed = parseClientMessage(raw);
    if (parsed.error) {
      // Protocol errors are not cheat events; they may be an old client
      session.send(SERVER_MESSAGE.ERROR, { code: parsed.error });
      return 0;
    }

    const now = Date.now();

    switch (parsed.type) {
      case CLIENT_MESSAGE.PING:
        // Echo the client timestamp, or the client measures clock skew instead of RTT
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
          log.error('action failed', { uid: session.uid, message: err.message });
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
   * Input
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

    // Drop duplicate, out-of-order and late packets
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
      // Skins come from a whitelist, already checked in the protocol layer
      player.skinId = payload.skinId;
      this.rosterDirty = true;
    }

    // No immediate reply; positions ride the 10Hz self state to save bandwidth
  }

  /* ------------------------------------------------------------------ *
   * Resource actions
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

    // Authoritative order: mark collected first, then grant the reward
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

    // The current owner must be online, or world state and save would diverge
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

    // Keep memory state in sync
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
    log.info('pet stolen', { from: previousOwner.uid, to: player.uid, petId: pet.petId });
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
      log.warn('could not persist hatch progress', { petId: pet.petId, message: err.message });
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
   * Main loop
   * ------------------------------------------------------------------ */
  tick() {
    const now = Date.now();
    const dtMs = now - this.lastTickAt;
    this.lastTickAt = now;
    // Clamp dt so a GC pause or a suspended host cannot integrate several seconds at once
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

      // Authoritative self state: corrects local prediction and feeds the HUD
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
        log.info('heartbeat timeout, closing', { uid: session.uid });
        session.close(4000, 'heartbeat_timeout');
        this.detach(session, 'heartbeat_timeout');
        continue;
      }
      session.send(SERVER_MESSAGE.PING, { t: now });
    }
  }

  /* ------------------------------------------------------------------ *
   * Detach
   * ------------------------------------------------------------------ */
  detach(session, reason = 'closed') {
    if (!this.sessions.has(session.ws)) return;
    this.sessions.delete(session.ws);
    if (this.byUid.get(session.uid) === session) this.byUid.delete(session.uid);
    this.world.removePlayer(session.uid);
    this.rosterDirty = true;

    // Write on disconnect only: inventory plus last seen time
    this.store.markGemPickup(session.uid, 0);
    this.store
      .flushInventory()
      .catch((err) => log.warn('could not flush on disconnect', { uid: session.uid, message: err.message }));
    this.store
      .recordDisconnect(session.uid)
      .catch((err) => log.warn('could not record disconnect', { uid: session.uid, message: err.message }));
    if (session.auditId) {
      this.store
        .endSessionAudit(session.auditId, reason)
        .catch((err) => log.warn('could not write session audit', { message: err.message }));
    }

    log.info('player left', { uid: session.uid, reason, online: this.world.onlineCount });

    // Broadcast right away so the others see the player disappear
    this.broadcast(Date.now());
  }

  /* ------------------------------------------------------------------ *
   * Snapshot helpers
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
