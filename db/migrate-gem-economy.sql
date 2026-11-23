-- ---------------------------------------------------------------------------
-- 迭代 3:宝石经济
--
-- 宝石不再从地面拾取,改为通关奖励:
--   1. 每关首次通关发一次,用 first_gems_rewarded 标记
--   2. 每累计 10 个新关卡发一次里程碑奖励,用 milestone_rewarded 记录已领分组
--   3. 新账号注册发一次性启动宝石
--
-- 增量扩展,不删旧字段。幂等。
-- ---------------------------------------------------------------------------

-- --- 每关进度:补首通奖励标记 ----------------------------------------------
ALTER TABLE player_progress ADD COLUMN IF NOT EXISTS first_gems_rewarded BOOLEAN NOT NULL DEFAULT false;
-- 该关实际发放的宝石数量,便于审计
ALTER TABLE player_progress ADD COLUMN IF NOT EXISTS gems_rewarded INTEGER NOT NULL DEFAULT 0;

-- --- 里程碑:记录哪些"每 10 关"分组已经领过 --------------------------------
-- group_index = floor(新通关总数 / 10),从 1 开始
CREATE TABLE IF NOT EXISTS player_milestones (
    uid           UUID NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
    group_index   INTEGER NOT NULL CHECK (group_index > 0),
    gems_rewarded INTEGER NOT NULL DEFAULT 0,
    claimed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (uid, group_index)
);

-- --- users:记录启动宝石是否已发 --------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS starter_gems_granted BOOLEAN NOT NULL DEFAULT false;

-- 老账号一律视为已发放,避免升级后集体补发 15 颗
UPDATE users SET starter_gems_granted = true WHERE starter_gems_granted = false;

-- --- 清理:地面宝石已移除,把历史上"地面拾取"的记录留着不动(只是不再增长)---
-- 不删除任何已有数据。
