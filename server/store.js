/**
 * PostgreSQL persistence.
 *
 * Called only on connect, disconnect, gem pickup and pet changes. Never per
 * tick. To keep write volume down, gem pickups accumulate as dirty counters
 * and land in batches (see flushInventory), so several pickups by one player
 * become a single UPDATE.
 */
import pg from 'pg';
import { DB, AUTH, RULES, isProduction } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('store');
const { Pool } = pg;

/** Fallback used when DATABASE_URL is missing, so the client can be worked on alone. */
class NullStore {
  constructor() {
    this.enabled = false;
  }
  async init() {
    log.warn('DATABASE_URL is not set, running without persistence (memory only)');
  }
  async createUser() {
    throw new Error('database_unavailable');
  }
  async authenticate() {
    throw new Error('database_unavailable');
  }
  async loadProfile() {
    return { inventory: { gems: 0 }, pets: [] };
  }
  async recordLogin() {}
  async recordDisconnect() {}
  async flushInventory() {}
  async stealPet() {
    return false;
  }
  async hatchPet() {
    return false;
  }
  async upsertOwnedPet() {
    return null;
  }
  async close() {}
}

export class PgStore {
  constructor(connectionString) {
    this.enabled = true;
    this.pool = new Pool({
      connectionString,
      max: DB.poolMax,
      connectionTimeoutMillis: DB.connectionTimeoutMs,
      idleTimeoutMillis: DB.idleTimeoutMs,
      application_name: 'speedy-game',
    });
    this.pool.on('error', (err) => {
      log.error('idle connection failed', { message: err.message });
    });
    /** uid -> pending increment, { gems: number } */
    this.dirtyInventory = new Map();
  }

  async init() {
    await this.pool.query('SELECT 1');
    log.info('connected to PostgreSQL');
    if (DB.autoMigrate) {
      const { readFile } = await import('node:fs/promises');
      const { fileURLToPath } = await import('node:url');
      const path = await import('node:path');
      const here = path.dirname(fileURLToPath(import.meta.url));
      const sql = await readFile(path.join(here, '..', 'db', 'init.sql'), 'utf8');
      await this.pool.query(sql);
      log.info('schema ready');
    }
  }

  /* ----------------------------- Accounts ------------------------------ */

  async createUser({ username, passwordHash, displayName }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO users (username, username_lower, password_hash, display_name)
         VALUES ($1, $2, $3, $4)
         RETURNING uid, username, display_name, equipped_skin, created_at`,
        [username, username.toLowerCase(), passwordHash, displayName],
      );
      const user = rows[0];
      await client.query(
        `INSERT INTO player_inventory (uid) VALUES ($1)
         ON CONFLICT (uid) DO NOTHING`,
        [user.uid],
      );
      await client.query('COMMIT');
      return user;
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505' || err.code === '23514') {
        const conflict = new Error('username_taken');
        conflict.code = err.code;
        throw conflict;
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /** Returns the raw row including password_hash; the caller verifies the password. */
  async findUserByUsername(username) {
    const { rows } = await this.pool.query(
      `SELECT uid, username, password_hash, display_name, equipped_skin
         FROM users WHERE username_lower = $1`,
      [username.toLowerCase()],
    );
    return rows[0] ?? null;
  }

  async findUserById(uid) {
    const { rows } = await this.pool.query(
      `SELECT uid, username, display_name, equipped_skin FROM users WHERE uid = $1`,
      [uid],
    );
    return rows[0] ?? null;
  }

  async recordLogin(uid) {
    await this.pool.query(
      'UPDATE users SET last_login_at = now(), last_seen_at = now() WHERE uid = $1',
      [uid],
    );
  }

  async recordDisconnect(uid) {
    await this.pool.query('UPDATE users SET last_seen_at = now() WHERE uid = $1', [uid]);
  }

  /* ----------------------------- Save data ----------------------------- */

  async loadProfile(uid) {
    const [inv, pets] = await Promise.all([
      this.pool.query(
        'SELECT gems, gems_earned, pets_stolen, pets_lost, pets_hatched FROM player_inventory WHERE uid = $1',
        [uid],
      ),
      this.pool.query(
        `SELECT pet_id, species, rarity, hatch_progress, is_hatched
           FROM pets WHERE owner_uid = $1 ORDER BY created_at`,
        [uid],
      ),
    ]);
    return {
      inventory: inv.rows[0] ?? { gems: 0, gems_earned: 0, pets_stolen: 0, pets_lost: 0, pets_hatched: 0 },
      pets: pets.rows.map((row) => ({
        petId: row.pet_id,
        species: row.species,
        rarity: row.rarity,
        hatchProgress: row.hatch_progress,
        isHatched: row.is_hatched,
      })),
    };
  }

  /** Flush accumulated gem increments. index.js calls this every 5 seconds. */
  markGemPickup(uid, amount) {
    const cur = this.dirtyInventory.get(uid) ?? 0;
    this.dirtyInventory.set(uid, cur + amount);
  }

  async flushInventory() {
    if (this.dirtyInventory.size === 0) return;
    const entries = [...this.dirtyInventory.entries()];
    this.dirtyInventory.clear();

    const uids = entries.map(([uid]) => uid);
    const amounts = entries.map(([, amount]) => amount);

    try {
      await this.pool.query(
        `UPDATE player_inventory AS inv
            SET gems = inv.gems + data.amount,
                gems_earned = inv.gems_earned + GREATEST(data.amount, 0),
                updated_at = now()
           FROM UNNEST($1::uuid[], $2::int[]) AS data(uid, amount)
          WHERE inv.uid = data.uid`,
        [uids, amounts],
      );
    } catch (err) {
      // On failure put the increments back so the next cycle retries them
      for (const [uid, amount] of entries) {
        const cur = this.dirtyInventory.get(uid) ?? 0;
        this.dirtyInventory.set(uid, cur + amount);
      }
      log.error('batch inventory write failed', { message: err.message });
    }
  }

  /* ------------------------------- Pets -------------------------------- */

  /** Insert a pet owned by a player (hatched, or granted at spawn). */
  async upsertOwnedPet({ petId, ownerUid, species, rarity, hatchProgress, isHatched }) {
    const { rows } = await this.pool.query(
      `INSERT INTO pets (pet_id, owner_uid, species, rarity, hatch_progress, is_hatched, created_at)
       VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, now())
       ON CONFLICT (pet_id) DO UPDATE
         SET owner_uid = EXCLUDED.owner_uid,
             hatch_progress = EXCLUDED.hatch_progress,
             is_hatched = EXCLUDED.is_hatched
       RETURNING pet_id`,
      [petId ?? null, ownerUid, species, rarity, hatchProgress, isHatched],
    );
    return rows[0].pet_id;
  }

  /**
   * Transfer pet ownership.
   * @returns {Promise<boolean>} true when the transfer landed; a mismatched
   *   current owner fails
   */
  async transferPet({ petId, fromUid, toUid }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rowCount } = await client.query(
        `UPDATE pets
            SET owner_uid = $3,
                stolen_count = stolen_count + 1,
                last_stolen_at = now()
          WHERE pet_id = $1 AND owner_uid = $2`,
        [petId, fromUid, toUid],
      );
      if (rowCount === 0) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query(
        `UPDATE player_inventory SET pets_stolen = pets_stolen + 1, updated_at = now() WHERE uid = $1`,
        [toUid],
      );
      await client.query(
        `UPDATE player_inventory SET pets_lost = pets_lost + 1, updated_at = now() WHERE uid = $1`,
        [fromUid],
      );
      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      log.error('pet transfer failed', { message: err.message });
      return false;
    } finally {
      client.release();
    }
  }

  async updateHatchProgress(petId, ownerUid, progress, isHatched) {
    await this.pool.query(
      `UPDATE pets SET hatch_progress = $3, is_hatched = $4
        WHERE pet_id = $1 AND owner_uid = $2`,
      [petId, ownerUid, Math.min(100, Math.max(0, progress)), isHatched],
    );
    if (isHatched) {
      await this.pool.query(
        `UPDATE player_inventory SET pets_hatched = pets_hatched + 1, updated_at = now() WHERE uid = $1`,
        [ownerUid],
      );
    }
  }

  async startSessionAudit(uid, jti) {
    const { rows } = await this.pool.query(
      'INSERT INTO session_audit (uid, jti) VALUES ($1, $2) RETURNING id',
      [uid, jti],
    );
    return rows[0].id;
  }

  async endSessionAudit(id, reason) {
    await this.pool.query(
      'UPDATE session_audit SET disconnected_at = now(), disconnect_reason = $2 WHERE id = $1',
      [id, reason],
    );
  }

  async close() {
    await this.flushInventory();
    await this.pool.end();
  }
}

let singleton = null;

export function getStore() {
  if (singleton) return singleton;

  if (!DB.url) {
    if (isProduction) {
      throw new Error('DATABASE_URL is required in production');
    }
    singleton = new NullStore();
    return singleton;
  }

  if (!AUTH.secret) {
    throw new Error('SESSION_SECRET is required');
  }

  singleton = new PgStore(DB.url);
  return singleton;
}

/** Test only: drop the singleton. */
export function resetStoreForTests() {
  singleton = null;
}
