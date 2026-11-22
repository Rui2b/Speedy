/**
 * 日志工具。
 * - 普通日志:统一前缀,便于 systemd/journalctl 检索。
 * - 作弊日志:单独落到文件,一行一条 JSON,方便后续脚本统计。
 */
import fs from 'node:fs';
import path from 'node:path';
import { LOG } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[LOG.level] ?? LEVELS.info;

let cheatStream = null;

function ensureCheatStream() {
  if (cheatStream) return cheatStream;
  fs.mkdirSync(path.dirname(LOG.cheatLogFile), { recursive: true });
  cheatStream = fs.createWriteStream(LOG.cheatLogFile, { flags: 'a' });
  cheatStream.on('error', (err) => {
    // 作弊日志写失败不能影响主流程
    console.error(`[warn] cheat log stream error: ${err.message}`);
  });
  return cheatStream;
}

function stamp() {
  return new Date().toISOString();
}

function emit(level, scope, message, extra) {
  if (LEVELS[level] < threshold) return;
  const suffix = extra === undefined ? '' : ` ${safeJson(extra)}`;
  const line = `${stamp()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${suffix}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function createLogger(scope) {
  return {
    debug: (msg, extra) => emit('debug', scope, msg, extra),
    info: (msg, extra) => emit('info', scope, msg, extra),
    warn: (msg, extra) => emit('warn', scope, msg, extra),
    error: (msg, extra) => emit('error', scope, msg, extra),
  };
}

/**
 * 记录一条作弊/异常事件。uid/sessionId 只记录脱敏后的短标识。
 * @param {object} event
 * @param {string} event.reason 事件类型,例如 'input_rate' / 'displacement' / 'invalid_action'
 */
export function logCheat(event) {
  const record = { ts: stamp(), ...event };
  const line = safeJson(record);
  const level = event.severity === 'high' ? 'warn' : 'info';
  emit(level, 'anti-cheat', event.reason, {
    uid: event.uid,
    ...(event.details ? { details: event.details } : {}),
  });
  try {
    ensureCheatStream().write(`${line}\n`);
  } catch {
    /* 忽略磁盘异常 */
  }
}

export function closeLogger() {
  if (cheatStream) {
    cheatStream.end();
    cheatStream = null;
  }
}
