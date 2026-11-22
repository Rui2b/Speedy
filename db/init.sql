-- ---------------------------------------------------------------------------
-- Speedy 持久化存档表结构
--
-- 设计原则(严格按方案):
--   只存"存档"数据:账号、皮肤、宝石总数、宠物、孵化进度。
--   在线位置/速度/临时状态一律放服务器内存,绝不入库。
--
-- 幂等:全部使用 IF NOT EXISTS,可重复执行。
-- ---------------------------------------------------------------------------

-- --- 用户账号 -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    uid              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username         VARCHAR(20) NOT NULL,
    -- 用户名唯一,不区分大小写
    username_lower   VARCHAR(20) NOT NULL UNIQUE,
    password_hash    TEXT NOT NULL,
    display_name     VARCHAR(24) NOT NULL,
    equipped_skin    VARCHAR(24) NOT NULL DEFAULT 'classic',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at    TIMESTAMPTZ,
    last_seen_at     TIMESTAMPTZ,
    CONSTRAINT users_username_len CHECK (char_length(username) BETWEEN 3 AND 20)
);

-- --- 玩家资源(一行一玩家,与 users 一对一)-------------------------------
CREATE TABLE IF NOT EXISTS player_inventory (
    uid              UUID PRIMARY KEY REFERENCES users(uid) ON DELETE CASCADE,
    gems             INTEGER NOT NULL DEFAULT 0 CHECK (gems >= 0),
    gems_earned      BIGINT  NOT NULL DEFAULT 0 CHECK (gems_earned >= 0),
    pets_stolen      INTEGER NOT NULL DEFAULT 0 CHECK (pets_stolen >= 0),
    pets_lost        INTEGER NOT NULL DEFAULT 0 CHECK (pets_lost >= 0),
    pets_hatched     INTEGER NOT NULL DEFAULT 0 CHECK (pets_hatched >= 0),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --- 宠物 -----------------------------------------------------------------
-- owner_uid 为 NULL 表示野生宠物。
-- hatch_progress 持久化,玩家下线后不丢孵化进度。
CREATE TABLE IF NOT EXISTS pets (
    pet_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_uid        UUID REFERENCES users(uid) ON DELETE SET NULL,
    species          VARCHAR(24) NOT NULL DEFAULT 'blob',
    rarity           VARCHAR(16) NOT NULL DEFAULT 'common',
    hatch_progress   SMALLINT NOT NULL DEFAULT 0 CHECK (hatch_progress BETWEEN 0 AND 100),
    is_hatched       BOOLEAN NOT NULL DEFAULT false,
    stolen_count     INTEGER NOT NULL DEFAULT 0 CHECK (stolen_count >= 0),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- 抢夺后原主人失去所有权的保护期
    last_stolen_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS pets_owner_idx ON pets(owner_uid) WHERE owner_uid IS NOT NULL;

-- --- 会话审计(可选,几行/分钟,不涉及 tick 写入)------------------------
-- 用于排查 token 复用与多端踢线,单次登录/下线写一行。
CREATE TABLE IF NOT EXISTS session_audit (
    id               BIGSERIAL PRIMARY KEY,
    uid              UUID NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
    jti              VARCHAR(64) NOT NULL,
    connected_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    disconnected_at  TIMESTAMPTZ,
    disconnect_reason TEXT
);

CREATE INDEX IF NOT EXISTS session_audit_uid_idx ON session_audit(uid, connected_at DESC);
