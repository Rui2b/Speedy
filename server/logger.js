/**
 * Logging.
 * - Operational logs share one prefix so systemd and journalctl stay searchable.
 * - Anti-cheat events go to their own file, one JSON object per line, so a
 *   script can aggregate them later.
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
    // A failed cheat-log write must never break the game loop
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
 * Record one anti-cheat event. Only short identifiers are stored.
 * @param {object} event
 * @param {string} event.reason one of 'input_rate', 'displacement', 'invalid_action'
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
    /* ignore disk errors */
  }
}

export function closeLogger() {
  if (cheatStream) {
    cheatStream.end();
    cheatStream = null;
  }
}
