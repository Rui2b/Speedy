/**
 * 协议层:上行包的解析与严格校验。
 *
 * 安全原则:任何字段类型不对、范围越界、字段缺失,都直接丢弃整包并返回 null,
 * 绝不把未经校验的数据塞进模拟循环。
 */
import { TIMING, VALID_SKINS } from './config.js';

export const CLIENT_MESSAGE = {
  INPUT: 'player_input',
  PICK_GEM: 'try_pick_gem',
  STEAL_PET: 'try_steal_pet',
  HATCH_PET: 'try_hatch_pet',
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
      return parsePetAction(data, type);
    case CLIENT_MESSAGE.PONG:
    case CLIENT_MESSAGE.PING:
    case CLIENT_MESSAGE.HELLO:
      return { type, payload: { t: isFiniteNumber(data.t) ? data.t : 0 } };
    default:
      return { error: 'unknown_type' };
  }
}

/**
 * player_input 包。
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
