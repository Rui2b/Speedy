/**
 * 房间管理。
 *
 * 每个房间有独立的世界、玩家集合与排行榜。玩家默认进公共 lobby。
 *
 * 为什么需要房间:多个独立世界能同时承载更多人,排行榜也不会互相污染。
 * 单个房间内仍然是"一个权威世界",安全模型完全不变。
 */
import { ROOMS } from './gameConfig.js';
import { World } from './world.js';

/** 生成一个可读的房间 id,冲突则追加重试。 */
function generateRoomId(existing) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const n = Math.floor(Math.random() * 900) + 100;
    const id = `room-${n}`;
    if (!existing.has(id)) return id;
  }
  return `room-${Date.now().toString(36)}`;
}

export class Room {
  /**
   * @param {string} id
   * @param {object} deps
   * @param {import('./store.js').PgStore} deps.store
   * @param {Array<object>} deps.stages 关卡运行时数据
   */
  constructor(id, { store, stages }) {
    this.id = id;
    this.store = store;
    this.stages = stages;
    this.world = new World();
    /** @type {Map<string, object>} uid -> session */
    this.sessions = new Map();
    this.createdAt = Date.now();
    this.lastActiveAt = Date.now();
    this.rosterDirty = true;
    /** 本房间的排行榜缓存 */
    this.leaderboard = [];
    this.leaderboardAt = 0;
  }

  get playerCount() {
    return this.sessions.size;
  }

  get isFull() {
    return this.sessions.size >= ROOMS.maxPlayersPerRoom;
  }

  /** 房间是否长时间没人,可以回收。 */
  isEmptyAndIdle(now) {
    return this.sessions.size === 0 && now - this.lastActiveAt > ROOMS.emptyRoomTtlMs;
  }

  touch(now) {
    this.lastActiveAt = now;
  }

  /**
   * 按重量级排序当前房间的玩家。
   * 排序键:转生次数 → 累计速度 → 通关数。
   */
  buildLeaderboard() {
    const rows = [];
    for (const session of this.sessions.values()) {
      const p = session.player;
      if (!p) continue;
      rows.push({
        uid: p.uid,
        displayName: p.displayName,
        rebirth: p.rebirth,
        speed: Math.round(p.speed * 10) / 10,
        speedTotal: Math.round(p.speedTotal * 10) / 10,
        cleared: p.clearedStages.size,
      });
    }
    rows.sort(
      (a, b) =>
        b.rebirth - a.rebirth || b.speedTotal - a.speedTotal || b.cleared - a.cleared,
    );
    this.leaderboard = rows;
    this.leaderboardAt = Date.now();
    return rows;
  }
}

export class RoomManager {
  /**
   * @param {object} deps
   * @param {import('./store.js').PgStore} deps.store
   * @param {Array<object>} deps.stages
   */
  constructor({ store, stages }) {
    this.store = store;
    this.stages = stages;
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
    this.ensureDefaultRoom();
  }

  ensureDefaultRoom() {
    if (this.rooms.has(ROOMS.defaultId)) return this.rooms.get(ROOMS.defaultId);
    return this.createRoom(ROOMS.defaultId);
  }

  createRoom(id) {
    const room = new Room(id, { store: this.store, stages: this.stages });
    this.rooms.set(id, room);
    return room;
  }

  getRoom(id) {
    return this.rooms.get(id) ?? null;
  }

  /**
   * 获取或按需创建房间。
   * @returns {{room: Room|null, reason?: string}}
   */
  joinRoom(id) {
    const requested = typeof id === 'string' ? id.trim().toLowerCase() : '';
    if (requested && !ROOMS.idPattern.test(requested)) {
      return { room: null, reason: 'invalid_room_id' };
    }

    const targetId = requested || ROOMS.defaultId;

    const existing = this.rooms.get(targetId);
    if (existing) {
      if (existing.isFull) return { room: null, reason: 'room_full' };
      return { room: existing };
    }

    // 新建房间前先检查上限
    if (this.rooms.size >= ROOMS.maxRooms) {
      this.reclaimIdle();
      if (this.rooms.size >= ROOMS.maxRooms) {
        return { room: null, reason: 'server_full' };
      }
    }

    return { room: this.createRoom(targetId) };
  }

  /** 往房间里加一个会话。 */
  addSession(roomId, session) {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    room.sessions.set(session.uid, session);
    room.touch(Date.now());
    room.rosterDirty = true;
    return true;
  }

  /** 从房间移除会话,返回它原来所在的房间。 */
  removeSession(roomId, uid) {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    const session = room.sessions.get(uid) ?? null;
    room.sessions.delete(uid);
    room.touch(Date.now());
    room.rosterDirty = true;
    return session;
  }

  /** 回收长期空房间(公共 lobby 永不回收)。 */
  reclaimIdle(now = Date.now()) {
    const removed = [];
    for (const [id, room] of this.rooms) {
      if (id === ROOMS.defaultId) continue;
      if (room.isEmptyAndIdle(now)) {
        this.rooms.delete(id);
        removed.push(id);
      }
    }
    return removed;
  }

  /** 房间列表,给客户端的房间选择器用。 */
  listRooms() {
    return [...this.rooms.values()].map((room) => ({
      id: room.id,
      players: room.playerCount,
      capacity: ROOMS.maxPlayersPerRoom,
    }));
  }

  /** 全局在线人数。 */
  get onlineCount() {
    let total = 0;
    for (const room of this.rooms.values()) total += room.playerCount;
    return total;
  }
}

export { generateRoomId };
