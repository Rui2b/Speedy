-- ---------------------------------------------------------------------------
-- Speedy 迭代:Speed 成长、Rebirth、Obby 进度
--
-- 只做增量扩展,不删除任何旧字段、不改已有列的类型。
-- 幂等:每一句都可以重复执行。
-- ---------------------------------------------------------------------------

-- --- 1. users:速度成长与转生 ----------------------------------------------
-- speed          当前累计速度(转生后清零)
-- speed_total    历史累计速度(永不重置,用于排行榜与统计)
-- rebirth        转生次数
-- multiplier     速度获取倍率,转生时按 rebirth 倍率累乘
-- current_world / current_stage   当前所在关卡(用于断线重连恢复)
-- current_checkpoint              最近检查点 { x, y, z, world, stage }
ALTER TABLE users ADD COLUMN IF NOT EXISTS speed              DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS speed_total        DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS rebirth            INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS multiplier         NUMERIC(12, 4) NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS current_world      VARCHAR(32) NOT NULL DEFAULT 'lobby';
ALTER TABLE users ADD COLUMN IF NOT EXISTS current_stage      SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS current_checkpoint JSONB;

-- 约束用 DO 块加,方便重复执行
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_speed_nonneg') THEN
        ALTER TABLE users ADD CONSTRAINT users_speed_nonneg CHECK (speed >= 0);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_rebirth_nonneg') THEN
        ALTER TABLE users ADD CONSTRAINT users_rebirth_nonneg CHECK (rebirth >= 0);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_multiplier_pos') THEN
        ALTER TABLE users ADD CONSTRAINT users_multiplier_pos CHECK (multiplier > 0);
    END IF;
END
$$;

-- --- 2. player_progress:每个 World / Stage 的通关状态 ----------------------
-- 一行 = 一个玩家在一个 stage 上的进度。
-- is_completed 一旦为 true 就不再回退(奖杯不会丢)。
-- best_time_ms 为通关耗时,仅用于展示,不做判定。
CREATE TABLE IF NOT EXISTS player_progress (
    uid            UUID NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
    world          VARCHAR(32) NOT NULL,
    stage          SMALLINT NOT NULL CHECK (stage >= 0),
    is_completed   BOOLEAN NOT NULL DEFAULT false,
    best_time_ms   INTEGER,
    completed_at   TIMESTAMPTZ,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (uid, world, stage)
);

CREATE INDEX IF NOT EXISTS player_progress_completed_idx
    ON player_progress (uid, world, is_completed);

-- --- 3. pets:稀有度、蛋状态、跟随 -------------------------------------------
-- 现有 pets 表已经有 pet_rarity 语义的 rarity 列和 hatch_progress,
-- 这里补上"是不是蛋"和"已经孵化的时间",不改动旧列。
ALTER TABLE pets ADD COLUMN IF NOT EXISTS is_egg         BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE pets ADD COLUMN IF NOT EXISTS hatched_at     TIMESTAMPTZ;
ALTER TABLE pets ADD COLUMN IF NOT EXISTS hatch_started_at TIMESTAMPTZ;

DO $$
BEGIN
    -- 旧数据的 rarity 取值可能不在新枚举里,统一收敛到 'common'
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pets_rarity_check') THEN
        ALTER TABLE pets ADD CONSTRAINT pets_rarity_check
            CHECK (rarity IN ('common', 'rare', 'epic', 'legendary'));
    END IF;
END
$$;

-- 老数据兼容:已有 hatch_progress 的宠物,按进度回填 is_egg / hatched_at
UPDATE pets
   SET is_egg = false,
       hatched_at = COALESCE(hatched_at, now())
 WHERE is_hatched = true
   AND is_egg = true;

-- --- 4. 会话审计:补上 room 字段,便于排查 -----------------------------------
ALTER TABLE session_audit ADD COLUMN IF NOT EXISTS room VARCHAR(32);
