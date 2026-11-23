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

/** 房间被删除时通知房内玩家的消息类型 */
const SERVER_EVENT_ROOM_CLOSED = 'room_closed';

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
   * @param {string} [deps.createdByUid] 创建者 uid;公共大厅为 null
   */
  constructor(id, { store, stages, createdByUid = null }) {
    this.id = id;
    this.store = store;
    this.stages = stages;
    this.world = new World();
    /** @type {Map<string, object>} uid -> session */
    this.sessions = new Map();
    this.createdAt = Date.now();
    this.lastActiveAt = Date.now();
    /** 创建者 uid。公共大厅永久存在,两者都是 null */
    this.createdByUid = createdByUid;
    this.createdByName = '';
    /** 公共大厅不可删除 */
    this.isPublic = id === ROOMS.defaultId;
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
    return this.createRoom(ROOMS.defaultId, null);
  }

  /**
   * 创建房间。
   * @param {string} id
   * @param {object|null} creator 创建者 session;null 表示系统创建的公共大厅
   */
  createRoom(id, creator = null) {
    const room = new Room(id, {
      store: this.store,
      stages: this.stages,
      createdByUid: creator?.uid ?? null,
    });
    if (creator) room.createdByName = creator.player?.displayName ?? creator.displayName ?? '';
    this.rooms.set(id, room);
    return room;
  }

  /**
   * 删除房间。只有创建者能删,公共大厅永远不能删,
   * 且不能删自己当前所在的房间。
   *
   * @param {string} roomId
   * @param {object} session 发起删除的会话
   * @returns {{ok: true, movedTo: string} | {ok: false, reason: string}}
   */
  deleteRoom(roomId, session) {
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, reason: 'room_not_found' };

    // 公共大厅永久存在
    if (room.isPublic) return { ok: false, reason: 'cannot_delete_public' };

    // 只有创建者能删
    if (room.createdByUid !== session.uid) return { ok: false, reason: 'not_owner' };

    // 不能删自己正在里面的房间
    if (session.roomId === roomId) return { ok: false, reason: 'cannot_delete_current' };

    // 把房间里其他所有人送回公共大厅
    const lobby = this.ensureDefaultRoom();
    for (const other of [...room.sessions.values()]) {
      room.sessions.delete(other.uid);
      other.roomId = lobby.id;
      lobby.sessions.set(other.uid, other);
      if (other.player) {
        room.world.removePlayer(other.uid);
        lobby.world.addPlayer(other.player);
        lobby.world.exitStage(other.player, Date.now());
      }
      other.send(SERVER_EVENT_ROOM_CLOSED, {
        roomId,
        movedTo: lobby.id,
        reason: 'room_deleted',
      });
      lobby.rosterDirty = true;
    }

    this.rooms.delete(roomId);
    return { ok: true, movedTo: lobby.id };
  }

  getRoom(id) {
    return this.rooms.get(id) ?? null;
  }

  /**
   * 获取或按需创建房间。
   * @param {string} id
   * @param {object|null} [creator] 首次创建该房间的会话
   * @returns {{room: Room|null, reason?: string, created?: boolean}}
   */
  joinRoom(id, creator = null) {
    const requested = typeof id === 'string' ? id.trim().toLowerCase() : '';
    if (requested && !ROOMS.idPattern.test(requested)) {
      return { room: null, reason: 'invalid_room_id' };
    }

    const targetId = requested || ROOMS.defaultId;

    const existing = this.rooms.get(targetId);
    if (existing) {
      if (existing.isFull) return { room: null, reason: 'room_full' };
      return { room: existing, created: false };
    }

    // 新建房间前先检查上限
    if (this.rooms.size >= ROOMS.maxRooms) {
      this.reclaimIdle();
      if (this.rooms.size >= ROOMS.maxRooms) {
        return { room: null, reason: 'server_full' };
      }
    }

    // 房间不存在则创建,并记录创建者
    return { room: this.createRoom(targetId, creator), created: true };
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
      creator: room.createdByName || (room.isPublic ? '' : 'Unknown'),
      createdByUid: room.createdByUid,
      isPublic: room.isPublic,
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
