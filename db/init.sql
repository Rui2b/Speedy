-- ---------------------------------------------------------------------------
-- Speedy persistence schema
--
-- Save data only: accounts, skins, gem totals, pets and hatch progress.
-- Live positions, velocities and temporary state stay in server memory and are
-- never written here.
--
-- Idempotent: every statement uses IF NOT EXISTS, so it is safe to re-run.
-- ---------------------------------------------------------------------------

-- --- Accounts -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    uid              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username         VARCHAR(20) NOT NULL,
    -- Case-insensitive uniqueness
    username_lower   VARCHAR(20) NOT NULL UNIQUE,
    password_hash    TEXT NOT NULL,
    display_name     VARCHAR(24) NOT NULL,
    equipped_skin    VARCHAR(24) NOT NULL DEFAULT 'classic',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at    TIMESTAMPTZ,
    last_seen_at     TIMESTAMPTZ,
    CONSTRAINT users_username_len CHECK (char_length(username) BETWEEN 3 AND 20)
);

-- --- Player resources (one row per player) --------------------------------
CREATE TABLE IF NOT EXISTS player_inventory (
    uid              UUID PRIMARY KEY REFERENCES users(uid) ON DELETE CASCADE,
    gems             INTEGER NOT NULL DEFAULT 0 CHECK (gems >= 0),
    gems_earned      BIGINT  NOT NULL DEFAULT 0 CHECK (gems_earned >= 0),
    pets_stolen      INTEGER NOT NULL DEFAULT 0 CHECK (pets_stolen >= 0),
    pets_lost        INTEGER NOT NULL DEFAULT 0 CHECK (pets_lost >= 0),
    pets_hatched     INTEGER NOT NULL DEFAULT 0 CHECK (pets_hatched >= 0),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --- Pets -----------------------------------------------------------------
-- A NULL owner_uid means the pet is wild.
-- hatch_progress is persisted so progress survives a disconnect.
CREATE TABLE IF NOT EXISTS pets (
    pet_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_uid        UUID REFERENCES users(uid) ON DELETE SET NULL,
    species          VARCHAR(24) NOT NULL DEFAULT 'blob',
    rarity           VARCHAR(16) NOT NULL DEFAULT 'common',
    hatch_progress   SMALLINT NOT NULL DEFAULT 0 CHECK (hatch_progress BETWEEN 0 AND 100),
    is_hatched       BOOLEAN NOT NULL DEFAULT false,
    stolen_count     INTEGER NOT NULL DEFAULT 0 CHECK (stolen_count >= 0),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Protection window after a steal
    last_stolen_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS pets_owner_idx ON pets(owner_uid) WHERE owner_uid IS NOT NULL;

-- --- Session audit (optional) ---------------------------------------------
-- A few rows per minute at most. Written on connect and disconnect only, so it
-- never touches the tick loop. Useful for spotting token reuse and double login.
CREATE TABLE IF NOT EXISTS session_audit (
    id               BIGSERIAL PRIMARY KEY,
    uid              UUID NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
    jti              VARCHAR(64) NOT NULL,
    connected_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    disconnected_at  TIMESTAMPTZ,
    disconnect_reason TEXT
);

CREATE INDEX IF NOT EXISTS session_audit_uid_idx ON session_audit(uid, connected_at DESC);
