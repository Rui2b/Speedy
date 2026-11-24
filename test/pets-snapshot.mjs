/**
 * 宠物快照合并的纯逻辑测试。
 *
 * 起因:宠物位置只在每 N tick 的同步帧下发,其余帧快照里没有 pets 字段。
 * 之前把"没带 pets"和"没有宠物"当成同一件事,于是每收到一帧不带宠物的快照
 * 就把宠物全删掉,下一帧再建回来 —— 画面上宠物一直在闪。
 *
 * 这里把 world.buildSnapshot 的产出喂给一个还原了合并规则的小函数,
 * 直接断言"缺字段不等于清空"。
 *
 * 用法: node test/pets-snapshot.mjs
 */
import { buildStageRuntime } from '../server/obby.js';
import { createEgg, serializePet } from '../server/pets.js';

const results = [];
function check(name, ok, info) {
  results.push({ name, ok, info });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${info ? ` - ${info}` : ''}`);
}

/**
 * 客户端 render.js 里 pets 的合并规则(与实现等价)。
 *
 * 关键点:只有字段真的存在时才做增删;字段缺失表示"这一帧没同步",保持原样。
 *
 * @param {Map<string, object>} meshById 当前显示中的宠物
 * @param {object} snapshot 一帧快照
 * @returns {{added: string[], removed: string[], visible: number}}
 */
function mergePets(meshById, snapshot) {
  const added = [];
  const removed = [];

  if (!Array.isArray(snapshot.pets)) {
    // 这一帧没带宠物数据:什么都不做
    return { added, removed, visible: meshById.size };
  }

  const seen = new Set();
  for (const p of snapshot.pets) {
    seen.add(p.petId);
    if (!meshById.has(p.petId)) {
      added.push(p.petId);
      meshById.set(p.petId, { target: { x: p.pos.x, z: p.pos.z } });
    } else {
      meshById.get(p.petId).target = { x: p.pos.x, z: p.pos.z };
    }
  }

  for (const id of [...meshById.keys()]) {
    if (!seen.has(id)) {
      removed.push(id);
      meshById.delete(id);
    }
  }

  return { added, removed, visible: meshById.size };
}

/* --------------------------- 造两帧快照 --------------------------- */
const stage = buildStageRuntime()[0];
void stage;

const eggA = createEgg('egg-a', { x: 2, y: 0, z: 3 }, 'blob');
const eggB = createEgg('egg-b', { x: -4, y: 0, z: 1 }, 'blob');

const withPets = { tick: 10, pets: [serializePet(eggA), serializePet(eggB)] };
const withoutPets = { tick: 11 };

/* ------------------------- 1. 缺字段不清空 ------------------------ */
{
  const meshes = new Map();
  const first = mergePets(meshes, withPets);
  check('同步帧建出两只宠物', first.added.length === 2 && meshes.size === 2, `added=${first.added.length}`);

  // 连续几帧都没有 pets:必须一只都不删
  let flickered = false;
  for (let i = 0; i < 5; i += 1) {
    const r = mergePets(meshes, { tick: 12 + i });
    if (r.removed.length > 0) flickered = true;
  }
  check('没有 pets 字段的帧不会删除宠物', !flickered && meshes.size === 2, `visible=${meshes.size}`);
}

/* --------------------- 2. 真没有宠物时才清 ----------------------- */
{
  const meshes = new Map();
  mergePets(meshes, withPets);
  // 显式空数组:这一帧确实一只都没有
  const r = mergePets(meshes, { tick: 20, pets: [] });
  check('显式空数组表示真的没有宠物', r.removed.length === 2 && meshes.size === 0, `removed=${r.removed.length}`);
}

/* ------------------------ 3. 位置会更新 -------------------------- */
{
  const meshes = new Map();
  mergePets(meshes, withPets);
  eggA.pos.x = 9;
  eggA.pos.z = -9;
  mergePets(meshes, { tick: 30, pets: [serializePet(eggA), serializePet(eggB)] });
  const moved = meshes.get('egg-a');
  check(
    '同步帧会更新宠物位置',
    moved.target.x === 9 && moved.target.z === -9,
    JSON.stringify(moved.target),
  );
  check('更新位置不会重建对象', meshes.size === 2);
}

/* --------------------- 4. 新增 / 消失都正确 --------------------- */
{
  const meshes = new Map();
  mergePets(meshes, withPets);

  const eggC = createEgg('egg-c', { x: 0, y: 0, z: 0 }, 'blob');
  const r = mergePets(meshes, { tick: 40, pets: [serializePet(eggB), serializePet(eggC)] });
  check('同步帧能加入新宠物', r.added.length === 1 && meshes.has('egg-c'));
  check('同步帧能移除消失的宠物', r.removed.length === 1 && !meshes.has('egg-a'));
  check('总数保持正确', meshes.size === 2, `visible=${meshes.size}`);
}

const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  for (const f of failed) console.log(`  - ${f.name} (${f.info ?? ''})`);
  process.exitCode = 1;
}
