/**
 * Server side validation and anti-cheat.
 *
 *   1. Movement checks: per-packet displacement and sustained drift
 *   2. Resource action checks: distance, cooldown, ownership
 *   3. Session tokens (issued in auth.js; only binding is checked here)
 *   4. Per-connection rate limits on input and action packets
 *   5. Anti-cheat log
 */
import { ANTI_CHEAT, PHYSICS, RULES, TIMING } from './config.js';
import { logCheat } from './logger.js';
import { planarDistance } from './world.js';

/**
 * Fixed window rate limiter, reset once per second. Over the limit is a flat
 * refusal. A one second window keyed off Date.now() is simple and enough here.
 */
export function createRateLimiter() {
  return {
    windowStart: Date.now(),
    inputCount: 0,
    actionCount: 0,
  };
}

function rollWindow(rate) {
  const now = Date.now();
  if (now - rate.windowStart >= 1000) {
    rate.windowStart = now;
    rate.inputCount = 0;
    rate.actionCount = 0;
  }
}

/**
 * Check the input packet rate.
 * @returns {{allowed: boolean, reason?: string}}
 */
export function checkInputRate(rate) {
  rollWindow(rate);
  rate.inputCount += 1;
  if (rate.inputCount > ANTI_CHEAT.maxInputPacketsPerSec) {
    return { allowed: false, reason: 'input_rate' };
  }
  return { allowed: true };
}

export function checkActionRate(rate) {
  rollWindow(rate);
  rate.actionCount += 1;
  if (rate.actionCount > ANTI_CHEAT.maxActionPacketsPerSec) {
    return { allowed: false, reason: 'action_rate' };
  }
  return { allowed: true };
}

/** Jitter and packet loss allowance in metres, so honest players are not flagged. */
const PREVIEW_SLACK_METERS = 0.6;
/** Consecutive hits needed before a teleport counts as one strike. */
const DISPLACEMENT_STRIKE_AFTER = 2;
/** Consecutive hits needed before drift counts as one strike, about 0.6s. */
const DRIFT_STRIKE_AFTER = 12;

/**
 * Movement validation.
 *
 * @param {object} player server authoritative player state
 * @param {object|null} preview position reported by the client
 * @param {number} now current timestamp in ms
 * @returns {{ok: boolean, reason?: string, details?: object}}
 *
 * Two layers, both requiring repeated hits before a strike, so network jitter
 * does not punish honest players:
 *
 *   A. Teleport check. Between two consecutive packets the client's claimed
 *      position may not move further than
 *      maxSpeed * elapsed * tolerance + jitter allowance.
 *   B. Drift check. The reported position may not stay further than maxDrift
 *      from the authoritative one.
 *
 * Either way the server position is never overwritten. The client never gets
 * to move itself, so the rollback to the authoritative position is automatic:
 * self_state carries the true position and the client converges to it.
 */
export function validateMovement(player, preview, now) {
  if (!preview) return { ok: true };

  const result = checkDisplacement(player, preview, now);
  if (!result.ok) return result;

  return checkDrift(player, preview);
}

function checkDisplacement(player, preview, now) {
  if (!player.lastPreview) {
    player.lastPreview = preview;
    player.lastPreviewAt = now;
    return { ok: true };
  }

  const elapsedMs = Math.max(1, now - player.lastPreviewAt);
  const travelled = planarDistance(preview, player.lastPreview);
  const maxTravel =
    PHYSICS.maxSpeed * (elapsedMs / 1000) * ANTI_CHEAT.displacementTolerance + PREVIEW_SLACK_METERS;

  if (travelled > maxTravel) {
    player.lastPreview = preview;
    player.lastPreviewAt = now;
    player.displacementStreak = (player.displacementStreak ?? 0) + 1;
    if (player.displacementStreak >= DISPLACEMENT_STRIKE_AFTER) {
      player.displacementStreak = 0;
      return {
        ok: false,
        reason: 'displacement',
        details: {
          travelled: round(travelled),
          maxTravel: round(maxTravel),
          elapsedMs,
          serverPos: roundVec(player.pos),
          clientPos: roundVec(preview),
        },
      };
    }
    return { ok: true };
  }

  player.displacementStreak = 0;
  player.lastPreview = preview;
  player.lastPreviewAt = now;
  return { ok: true };
}

function checkDrift(player, preview) {
  const drift = planarDistance(preview, player.pos);
  if (drift > ANTI_CHEAT.maxDrift) {
    player.driftStreak = (player.driftStreak ?? 0) + 1;
    if (player.driftStreak >= DRIFT_STRIKE_AFTER) {
      player.driftStreak = 0;
      return {
        ok: false,
        reason: 'sustained_drift',
        details: {
          drift: round(drift),
          maxDrift: ANTI_CHEAT.maxDrift,
          serverPos: roundVec(player.pos),
          clientPos: roundVec(preview),
        },
      };
    }
    return { ok: true };
  }

  player.driftStreak = 0;
  return { ok: true };
}

/**
 * Record one suspicious event and report whether the connection should close.
 */
export function recordStrike(player, event) {
  player.strikes += 1;
  logCheat({
    reason: event.reason,
    severity: player.strikes >= ANTI_CHEAT.strikesBeforeKick ? 'high' : 'normal',
    uid: player.uid,
    strikes: player.strikes,
    details: event.details,
  });
  if (ANTI_CHEAT.strikesBeforeKick > 0 && player.strikes >= ANTI_CHEAT.strikesBeforeKick) {
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------------- *
 * Resource action validation
 * ------------------------------------------------------------------------- */

/**
 * Validate a gem pickup.
 *
 * There is no per-player pickup history on the server, so this checks distance
 * and whether the gem is still active. World's active flag already guarantees
 * a gem cannot be claimed twice.
 */
export function validateGemPickup(player, gem) {
  if (!gem || !gem.active) {
    return { ok: false, reason: 'gem_unavailable' };
  }
  const dist = planarDistance(player.pos, gem.pos);
  if (dist > RULES.gemPickupRadius) {
    return { ok: false, reason: 'too_far', details: { dist: round(dist), limit: RULES.gemPickupRadius } };
  }
  return { ok: true };
}

/**
 * Validate a pet steal.
 *
 * Checked in this order, so the client can show an accurate reason:
 *   - the pet exists
 *   - the player is inside the steal radius
 *   - the pet is not already theirs
 *   - the pet has an owner (wild pets cannot be stolen)
 *   - the pet itself has passed its steal cooldown
 *
 * The cooldown is per pet, not per player, so a freshly stolen pet cannot be
 * flipped again immediately and its new owner gets a real protection window.
 */
export function validatePetSteal(player, pet, now) {
  if (!pet) return { ok: false, reason: 'pet_missing' };

  const dist = planarDistance(player.pos, pet.pos);
  if (dist > RULES.petStealRadius) {
    return { ok: false, reason: 'too_far', details: { dist: round(dist), limit: RULES.petStealRadius } };
  }

  if (pet.ownerUid === player.uid) return { ok: false, reason: 'own_pet' };
  if (!pet.ownerUid) return { ok: false, reason: 'pet_wild' };

  const nextAllowed = pet.stealCooldownUntil ?? 0;
  if (now < nextAllowed) {
    return {
      ok: false,
      reason: 'cooldown',
      details: { remainingMs: Math.round(nextAllowed - now) },
    };
  }

  return { ok: true };
}

/**
 * Validate a hatch action.
 * The pet must be yours, in range, off cooldown and not yet hatched.
 */
export function validatePetHatch(player, pet, now) {
  if (!pet) return { ok: false, reason: 'pet_missing' };
  if (pet.ownerUid !== player.uid) return { ok: false, reason: 'not_owner' };
  if (pet.isHatched) return { ok: false, reason: 'already_hatched' };

  const dist = planarDistance(player.pos, pet.pos);
  if (dist > RULES.petHatchRadius) {
    return { ok: false, reason: 'too_far', details: { dist: round(dist), limit: RULES.petHatchRadius } };
  }

  const key = `hatch:${pet.petId}`;
  const nextAllowed = player.petCooldowns.get(key) ?? 0;
  if (now < nextAllowed) {
    return {
      ok: false,
      reason: 'cooldown',
      details: { remainingMs: Math.round(nextAllowed - now) },
    };
  }
  return { ok: true };
}

export function startCooldown(player, key, durationMs, now) {
  player.petCooldowns.set(key, now + durationMs);
}

/* ------------------------------------------------------------------------- *
 * Helpers
 * ------------------------------------------------------------------------- */
function round(value) {
  return Math.round(value * 100) / 100;
}

function roundVec(v) {
  return { x: round(v.x), y: round(v.y), z: round(v.z) };
}

/** Theoretical speed limit */
export function theoreticalMaxSpeed() {
  return PHYSICS.maxSpeed * (TIMING.tickMs / 1000);
}
