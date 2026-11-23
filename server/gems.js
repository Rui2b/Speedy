/**
 * 宝石经济。
 *
 * 宝石只能通过三种方式获得,全部由服务端发放:
 *   1. 关卡首次通关
 *   2. 每累计 N 个新关卡触发一次里程碑
 *   3. 新账号一次性启动宝石
 *
 * 地面拾取、跑步机、转生、挂机都不产出宝石。
 * 曲线用对数,前期收益明显、后期收敛。
 */
import { GEMS } from './gameConfig.js';

/**
 * 某一关的首通奖励。
 * @param {number} stage 关卡编号(从 1 开始)
 * @returns {number} 宝石数量
 */
export function stageReward(stage) {
  const raw = Math.floor(GEMS.baseReward * Math.log(Math.max(1, stage) + 1));
  return Math.max(1, Math.min(GEMS.maxPerStage, raw));
}

/**
 * 某个里程碑分组的奖励。
 * @param {number} groupIndex 从 1 开始,表示第几个"10 关"
 */
export function milestoneReward(groupIndex) {
  const raw = Math.floor(GEMS.milestoneBase * Math.log(Math.max(1, groupIndex) + 1));
  return Math.max(1, Math.min(GEMS.maxPerMilestone, raw));
}

/**
 * 根据"已通关关卡数"算出应触发哪些里程碑分组。
 *
 * @param {number} clearedCount 累计已通关的不同关卡数(含本次)
 * @returns {number[]} 本次应该发放奖励的 group_index 列表
 *
 * 例:milestoneEvery = 10,clearedCount = 20 → [1, 2]
 * 已经领过的分组由调用方用数据库记录过滤。
 */
export function milestoneGroupsFor(clearedCount) {
  const groups = [];
  const maxGroup = Math.floor(clearedCount / Math.max(1, GEMS.milestoneEvery));
  for (let i = 1; i <= maxGroup; i += 1) groups.push(i);
  return groups;
}

/**
 * 计算一次通关的完整宝石收益。
 *
 * @param {object} params
 * @param {number} params.stage 关卡编号
 * @param {boolean} params.firstTime 是否首次通关
 * @param {number} params.clearedCountAfter 本次通关后的累计通关数
 * @param {number[]} params.alreadyClaimedGroups 已经领过的里程碑分组
 * @returns {{ stageGems: number, milestoneGems: number, newGroups: number[], total: number }}
 */
export function computeClearReward({
  stage,
  firstTime,
  clearedCountAfter,
  alreadyClaimedGroups = [],
}) {
  const stageGems = firstTime ? stageReward(stage) : 0;

  let milestoneGems = 0;
  const newGroups = [];

  if (firstTime) {
    const claimed = new Set(alreadyClaimedGroups);
    for (const group of milestoneGroupsFor(clearedCountAfter)) {
      if (claimed.has(group)) continue;
      newGroups.push(group);
      milestoneGems += milestoneReward(group);
    }
  }

  return {
    stageGems,
    milestoneGems,
    newGroups,
    total: stageGems + milestoneGems,
  };
}
