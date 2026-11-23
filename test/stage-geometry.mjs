/**
 * 关卡几何可达性校验。
 *
 * 起因:Stage 2/3 原本的台阶间隔远超跳跃能力,玩家永远通不了关,
 * 但服务端不会报错 —— 只有真人踩上去掉下来才知道。
 * 这里用真实的积分物理跑一个贪心机器人,把"通不了"变成构建期错误。
 *
 * 用法: node test/stage-geometry.mjs
 */
import { PHYSICS } from '../server/config.js';
import { buildStageRuntime, groundHeightAt, isFallen, reachedGoal } from '../server/obby.js';
import { integratePlayer } from '../server/world.js';

const DT = 1 / 20;
/** 关卡里脚下没有平台时的支撑面,必须是"永远掉下去" */
const NO_GROUND = -Infinity;
const MAX_TICKS = 4000;

const results = [];
function check(name, ok, info) {
  results.push({ name, ok, info });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${info ? ` - ${info}` : ''}`);
}

const apex = (PHYSICS.jumpImpulse ** 2) / (2 * PHYSICS.gravity);
const apexTime = PHYSICS.jumpImpulse / PHYSICS.gravity;
const airTime = (2 * PHYSICS.jumpImpulse) / PHYSICS.gravity;
console.log(`    跳跃最高 ${apex.toFixed(2)} 单位,用时 ${apexTime.toFixed(2)}s,滞空 ${airTime.toFixed(2)}s`);

function center(box) {
  return {
    x: (box.min.x + box.max.x) / 2,
    y: box.max.y,
    z: (box.min.z + box.max.z) / 2,
  };
}

/** 几何可达性用:把所有消失平台都当常亮,只验证"距离本身"是否过得去。 */
function allPlatforms(stage) {
  return [...stage.solid.map((p) => p.box), ...stage.blinkers.map((b) => b.box)];
}

/**
 * 贪心机器人:走到当前平台边缘再跳,落到下一块平台的中间。
 * 它不需要很聪明,只需要证明"存在一条能走通的路"。
 */
function runStage(stage, boxes) {
  const start = stage.solid[0].box;
  const spawn = { x: 0, y: start.max.y, z: start.max.z - 1 };
  const p = { pos: { ...spawn }, vel: { x: 0, y: 0, z: 0 }, onGround: true };

  let falls = 0;
  let stuck = 0;
  let lastZ = p.pos.z;

  for (let i = 0; i < MAX_TICKS; i += 1) {
    const now = i * DT * 1000;

    if (isFallen(stage, p.pos)) {
      falls += 1;
      if (falls > 30) return { ok: false, reason: `掉了 ${falls} 次`, pos: p.pos };
      p.pos = { ...spawn };
      p.vel = { x: 0, y: 0, z: 0 };
      p.onGround = true;
      continue;
    }

    if (reachedGoal(stage, p.pos)) return { ok: true, ticks: i, falls };

    // 卡住检测:连续 3 秒没有推进就算失败
    if (Math.abs(p.pos.z - lastZ) < 0.2) stuck += 1;
    else stuck = 0;
    lastZ = p.pos.z;
    if (stuck > 60) return { ok: false, reason: '卡住了', pos: p.pos };

    const candidates = boxes
      .filter((box) => (box.min.z + box.max.z) / 2 < p.pos.z - 0.4)
      .sort((a, b) => (b.min.z + b.max.z) / 2 - (a.min.z + a.max.z) / 2);

    const goalBox = stage.goal;
    const aim = candidates[0]
      ? center(candidates[0])
      : { x: 0, y: goalBox.max.y, z: (goalBox.min.z + goalBox.max.z) / 2 };

    const dx = aim.x - p.pos.x;
    const dz = aim.z - p.pos.z;
    const moveX = Math.abs(dx) < 0.2 ? 0 : Math.sign(dx);
    // 快到位就松手,否则冲过头掉下去 —— 真人也是这么操作的
    const moveZ = Math.abs(dz) < 0.6 ? 0 : Math.sign(dz);

    // 站着的平台:走到边缘再起跳
    const standing = boxes.find(
      (box) =>
        p.pos.x >= box.min.x &&
        p.pos.x <= box.max.x &&
        p.pos.z >= box.min.z &&
        p.pos.z <= box.max.z &&
        Math.abs(p.pos.y - box.max.y) < 0.15,
    );
    const edgeGap = standing ? p.pos.z - standing.min.z : 0;
    const jump = p.onGround && standing !== undefined && edgeGap <= 0.45 && dz < 0;

    const ground = groundHeightAt(stage, p.pos, now, boxes);
    integratePlayer(p, { moveX, moveZ, jump }, DT, ground ?? NO_GROUND, null);
  }

  return { ok: false, reason: `超过 ${MAX_TICKS} tick`, pos: p.pos };
}

const stages = buildStageRuntime();
for (const stage of stages) {
  const r = runStage(stage, allPlatforms(stage));
  check(
    `Stage ${stage.id} 距离上可以走到 goal`,
    r.ok,
    r.ok
      ? `${r.ticks} tick,掉了 ${r.falls} 次`
      : `${r.reason},停在 z=${r.pos.z.toFixed(1)} y=${r.pos.y.toFixed(1)}`,
  );
}

// 落差约束:相邻两层高度差不能超过跳跃最高点
for (const stage of stages) {
  const tops = [...new Set(allPlatforms(stage).map((b) => b.max.y))].sort((a, b) => a - b);
  let maxRise = 0;
  for (let i = 1; i < tops.length; i += 1) maxRise = Math.max(maxRise, tops[i] - tops[i - 1]);
  check(
    `Stage ${stage.id} 单层上升不超过跳跃高度`,
    maxRise <= apex + 0.05,
    `最大上升 ${maxRise.toFixed(2)} / 上限 ${apex.toFixed(2)}`,
  );
}

// 水平间隙:相邻两层之间的水平空隙要小于跳跃能覆盖的距离
for (const stage of stages) {
  const boxes = [...allPlatforms(stage), stage.goal].sort((a, b) => b.max.z - a.max.z);
  let worst = 0;
  let worstPair = '';
  for (let i = 1; i < boxes.length; i += 1) {
    const gap = boxes[i - 1].min.z - boxes[i].max.z;
    if (gap > worst) {
      worst = gap;
      worstPair = `z ${boxes[i - 1].max.z.toFixed(1)} → ${boxes[i].min.z.toFixed(1)}`;
    }
  }
  const maxGap = PHYSICS.maxSpeed * airTime;
  check(
    `Stage ${stage.id} 平台水平间隙在跳跃范围内`,
    worst <= maxGap,
    `最大间隙 ${worst.toFixed(2)} / 上限 ${maxGap.toFixed(2)} (${worstPair})`,
  );
}

// 消失平台的窗口要够长:走过去至少要 0.4s,否则等于必死
for (const stage of stages) {
  for (const b of stage.blinkers) {
    check(
      `Stage ${stage.id} ${b.id} 开启时长足够落脚`,
      b.enabledMs >= 500,
      `enabledMs=${b.enabledMs}`,
    );
  }
}

const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  for (const f of failed) console.log(`  - ${f.name} (${f.info ?? ''})`);
  process.exitCode = 1;
}
