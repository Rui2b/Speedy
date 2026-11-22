/**
 * PostgreSQL 存档层。
 *
 * 只在上线/下线/拾取宝石/宠物变更时调用,绝不每 tick 写入。
 * 为了降低写入频率,宝石拾取采用"脏标记 + 定时批量落库"的方式
 * (见 flushInventory),同一个玩家多次拾取只产生一次 UPDATE。
 */
import pg from 'pg';
import { DB, AUTH, RULES, isProduction } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('store');
const { Pool } = pg;

/** 未配置 DATABASE_URL 时使用的空实现,方便本地纯前端调试。 */
class NullStore {
  constructor() {
    this.enabled = false;
  }
  async init() {
    log.warn('未配置 DATABASE_URL,存档功能关闭(仅内存模式)');
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
      log.error('空闲连接异常', { message: err.message });
    });
    /** uid -> 待落库的增量,{ gems: number } */
    this.dirtyInventory = new Map();
  }

  async init() {
    await this.pool.query('SELECT 1');
    log.info('PostgreSQL 连接成功');
    if (DB.autoMigrate) {
      const { readFile } = await import('node:fs/promises');
      const { fileURLToPath } = await import('node:url');
      const path = await import('node:path');
      const here = path.dirname(fileURLToPath(import.meta.url));
      const sql = await readFile(path.join(here, '..', 'db', 'init.sql'), 'utf8');
      await this.pool.query(sql);
      log.info('存档表结构已就绪');
    }
  }

  /* ----------------------------- 账号 ---------------------------------- */

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

  /** 返回包含 password_hash 的原始行,由调用方校验密码。 */
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

  /* ----------------------------- 存档 ---------------------------------- */

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

  /** 把内存中累积的宝石增量攒批写入。index.js 每 5 秒调用一次。 */
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
      // 落库失败时把增量放回去,下个周期重试,避免丢数据
      for (const [uid, amount] of entries) {
        const cur = this.dirtyInventory.get(uid) ?? 0;
        this.dirtyInventory.set(uid, cur + amount);
      }
      log.error('批量写入库存失败', { message: err.message });
    }
  }

  /* ----------------------------- 宠物 ---------------------------------- */

  /** 新建一只归属某玩家的宠物(孵化完成或初始赠送)。 */
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
   * 转移宠物所有权。
   * @returns {Promise<boolean>} 是否真的转移成功(原主人不匹配则失败)
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
      log.error('转移宠物失败', { message: err.message });
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
      throw new Error('生产模式必须配置 DATABASE_URL');
    }
    singleton = new NullStore();
    return singleton;
  }

  if (!AUTH.secret) {
    throw new Error('必须配置 SESSION_SECRET');
  }

  singleton = new PgStore(DB.url);
  return singleton;
}

/** 仅供测试使用:重置单例。 */
export function resetStoreForTests() {
  singleton = null;
}
