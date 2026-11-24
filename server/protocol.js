/**
 * 协议层:上行包的解析与严格校验。
 *
 * 安全原则:任何字段类型不对、范围越界、字段缺失,都直接丢弃整包并返回错误,
 * 绝不把未经校验的数据塞进模拟循环。
 */
import { TIMING, VALID_SKINS } from './config.js';

export const CLIENT_MESSAGE = {
  INPUT: 'player_input',
  PICK_GEM: 'try_pick_gem',
  STEAL_PET: 'try_steal_pet',
  HATCH_PET: 'try_hatch_pet',
  /** 捡起地上的野生蛋(奖励产出的宠物来源) */
  CLAIM_PET: 'try_claim_pet',
  /** 转生 */
  REBIRTH: 'request_rebirth',
  /** 用宝石买跑步机时长 */
  BUY_TREADMILL: 'buy_treadmill',
  /** 进入 / 退出关卡 */
  ENTER_STAGE: 'enter_stage',
  EXIT_STAGE: 'exit_stage',
  /** 切换房间 */
  JOIN_ROOM: 'join_room',
  /** 删除自己创建的房间 */
  DELETE_ROOM: 'delete_room',
  /** 请求排行榜 / 房间列表 */
  REQUEST_LEADERBOARD: 'request_leaderboard',
  REQUEST_ROOMS: 'request_rooms',
  PONG: 'pong',
  HELLO: 'hello',
  PING: 'ping',
};

export const SERVER_MESSAGE = {
  WELCOME: 'welcome',
  SNAPSHOT: 'world_snapshot',
  SELF: 'self_state',
  ACTION_RESULT: 'action_result',
  PONG: 'pong',
  PING: 'ping',
  ERROR: 'error',
  INVENTORY: 'inventory',
  /** speed / rebirth / 倍率 / 跑步机时段 */
  PROGRESS: 'progress',
  /** 排行榜快照 */
  LEADERBOARD: 'leaderboard',
  /** 房间列表 */
  ROOMS: 'rooms',
  /** 房间被删除,房内玩家被送回公共大厅 */
  ROOM_CLOSED: 'room_closed',
  /** 关卡几何与当前进度 */
  STAGE: 'stage_state',
  KICK: 'kick',
};

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isSafeId(value, maxLength = 64) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

/**
 * 解析并校验一个上行包。
 * @param {string|Buffer} raw
 * @returns {{type: string, payload: object} | {error: string}}
 */
export function parseClientMessage(raw) {
  if (raw.length > TIMING.maxPayloadBytes) {
    return { error: 'payload_too_large' };
  }

  let data;
  try {
    data = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
  } catch {
    return { error: 'invalid_json' };
  }

  if (!isPlainObject(data)) return { error: 'not_object' };
  const type = data.type;
  if (typeof type !== 'string') return { error: 'missing_type' };

  switch (type) {
    case CLIENT_MESSAGE.INPUT:
      return parseInput(data);
    case CLIENT_MESSAGE.PICK_GEM:
      return parseGemAction(data);
    case CLIENT_MESSAGE.STEAL_PET:
    case CLIENT_MESSAGE.HATCH_PET:
    case CLIENT_MESSAGE.CLAIM_PET:
      return parsePetAction(data, type);
    case CLIENT_MESSAGE.REBIRTH:
    case CLIENT_MESSAGE.REQUEST_LEADERBOARD:
    case CLIENT_MESSAGE.REQUEST_ROOMS:
      return { type, payload: {} };
    case CLIENT_MESSAGE.BUY_TREADMILL:
      return parseTreadmill(data);
    case CLIENT_MESSAGE.ENTER_STAGE:
      return parseEnterStage(data);
    case CLIENT_MESSAGE.EXIT_STAGE:
      return { type, payload: {} };
    case CLIENT_MESSAGE.JOIN_ROOM:
      return parseJoinRoom(data);
    case CLIENT_MESSAGE.DELETE_ROOM:
      return parseDeleteRoom(data);
    case CLIENT_MESSAGE.PONG:
    case CLIENT_MESSAGE.PING:
    case CLIENT_MESSAGE.HELLO:
      return { type, payload: { t: isFiniteNumber(data.t) ? data.t : 0 } };
    default:
      return { error: 'unknown_type' };
  }
}

/**
 * 跑步机购买请求。
 * 只接受 treadmillId —— 价格、倍率、时长全部由服务器配置决定,
 * 客户端即使传了价格也会被忽略。
 */
function parseTreadmill(data) {
  if (!isSafeId(data.treadmillId, 32)) return { error: 'bad_treadmill_id' };
  return { type: CLIENT_MESSAGE.BUY_TREADMILL, payload: { treadmillId: data.treadmillId } };
}

/** 进入关卡。stage 必须是整数;服务端还会再校验 speed 门槛与存在性。 */
function parseEnterStage(data) {
  const stage = data.stage;
  if (!Number.isInteger(stage) || stage < 0 || stage > 999) {
    return { error: 'bad_stage' };
  }
  return { type: CLIENT_MESSAGE.ENTER_STAGE, payload: { stage } };
}

/** 切换房间。空字符串表示回默认房间。 */
function parseJoinRoom(data) {
  const roomId = data.roomId === undefined || data.roomId === null ? '' : data.roomId;
  if (typeof roomId !== 'string' || roomId.length > 24) {
    return { error: 'bad_room_id' };
  }
  return { type: CLIENT_MESSAGE.JOIN_ROOM, payload: { roomId: roomId.trim().toLowerCase() } };
}

/** 删除房间。权限(创建者、非公共、非当前房间)由服务端再次校验。 */
function parseDeleteRoom(data) {
  if (!isSafeId(data.roomId, 24)) return { error: 'bad_room_id' };
  return {
    type: CLIENT_MESSAGE.DELETE_ROOM,
    payload: { roomId: String(data.roomId).trim().toLowerCase() },
  };
}

/**
 * player_input 包。
 *
 * 严格按方案:只接受 moveX / moveZ / jump,以及仅用于对比校验的 clientPreviewPos。
 *
 * 关键:绝不读取 gems / petId / speedBonus 等字段——即使客户端发了也忽略,
 * 服务器所有数值都由自己的模拟产生。
 */
function parseInput(data) {
  const { seq, input, clientPreviewPos, skinId } = data;

  if (!Number.isInteger(seq) || seq < 0 || seq > Number.MAX_SAFE_INTEGER) {
    return { error: 'bad_seq' };
  }

  if (!isPlainObject(input)) return { error: 'bad_input' };
  const { moveX, moveZ, jump } = input;
  if (!isFiniteNumber(moveX) || !isFiniteNumber(moveZ)) return { error: 'bad_input_axis' };
  if (moveX < -1 || moveX > 1 || moveZ < -1 || moveZ > 1) return { error: 'input_out_of_range' };
  if (typeof jump !== 'boolean') return { error: 'bad_input_jump' };

  let preview = null;
  if (clientPreviewPos !== undefined && clientPreviewPos !== null) {
    if (!isPlainObject(clientPreviewPos)) return { error: 'bad_preview' };
    const { x, y, z } = clientPreviewPos;
    if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(z)) {
      return { error: 'bad_preview' };
    }
    // 拒绝明显离谱的坐标,避免用于日志污染的巨值
    if (Math.abs(x) > 1e4 || Math.abs(y) > 1e4 || Math.abs(z) > 1e4) {
      return { error: 'bad_preview' };
    }
    preview = { x, y, z };
  }

  let skin = null;
  if (skinId !== undefined && skinId !== null) {
    if (typeof skinId !== 'string' || !VALID_SKINS.includes(skinId)) {
      return { error: 'bad_skin' };
    }
    skin = skinId;
  }

  return {
    type: CLIENT_MESSAGE.INPUT,
    payload: { seq, input: { moveX, moveZ, jump }, clientPreviewPos: preview, skinId: skin },
  };
}

function parseGemAction(data) {
  if (!isSafeId(data.gemId)) return { error: 'bad_gem_id' };
  return {
    type: CLIENT_MESSAGE.PICK_GEM,
    payload: { gemId: data.gemId, clientPos: parseClientPos(data.clientPos) },
  };
}

function parsePetAction(data, type) {
  if (!isSafeId(data.petId)) return { error: 'bad_pet_id' };
  return {
    type,
    payload: { petId: data.petId, clientPos: parseClientPos(data.clientPos) },
  };
}

function parseClientPos(value) {
  if (!isPlainObject(value)) return null;
  const { x, z } = value;
  if (!isFiniteNumber(x) || !isFiniteNumber(z)) return null;
  return { x, z };
}
