/**
 * 客户端主流程:登录 → 连接 → 渲染循环。
 *
 * 页面加载后不刷新;每个会话只开一条 WebSocket,断线内部重连。
 * 渲染循环在登录面板背后也一直跑着,所以还没登录就能看到场地。
 */

import { GameView } from './render.js';
import { Hud } from './hud.js';
import { InputController } from './input.js';
import { NetClient } from './net.js';
import { ACTION_KEYS, findNearestGem, findNearestPet } from './targeting.js';
import { TurnstileGate } from './turnstile.js';
import { LocalPredictor } from './predictor.js';
import { GameUi } from './gameUi.js';
import { DEFAULT_SKIN, SKIN_ORDER } from './assets.js';

const el = {
  canvas: document.getElementById('scene'),
  overlay: document.getElementById('overlay'),
  form: document.getElementById('auth-form'),
  username: document.getElementById('username'),
  password: document.getElementById('password'),
  error: document.getElementById('auth-error'),
  btnLogin: document.getElementById('btn-login'),
  btnRegister: document.getElementById('btn-register'),
  loading: document.getElementById('loading'),
  loadingText: document.getElementById('loading-text'),
  turnstileSlot: document.getElementById('turnstile-slot'),
  turnstileWidget: document.getElementById('turnstile-widget'),
  turnstileNote: document.getElementById('turnstile-note'),
  btnLogout: document.getElementById('btn-logout'),
  hudUser: document.getElementById('hud-user'),
};

const state = {
  /** 短期 WS 票据,只放内存,不落 localStorage(避免 XSS 偷取) */
  wsToken: null,
  uid: null,
  userName: '',
  gems: 0,
  pets: [],
  /** gemId -> {x,z} */
  gemsById: new Map(),
  /** petId -> {ownerUid, pos} */
  petsById: new Map(),
  roster: new Map(),
  online: 0,
  lastSelfPos: { x: 0, y: 0, z: 0 },
  starting: false,
};

const hud = new Hud();
const view = new GameView(el.canvas);
const input = new InputController();

/** 本地预测器,收到 welcome 后用服务器下发的物理常量初始化 */
let predictor = null;

const gameUi = new GameUi({
  onBuyTreadmill: (id) => net.send({ type: 'buy_treadmill', treadmillId: id }),
  onEnterStage: (stage) => net.send({ type: 'enter_stage', stage }),
  onExitStage: () => net.send({ type: 'exit_stage' }),
  onRebirth: () => net.send({ type: 'request_rebirth' }),
  onJoinRoom: (roomId) => net.send({ type: 'join_room', roomId }),
  onDeleteRoom: (roomId) => net.send({ type: 'delete_room', roomId }),
  onPickSkin: (skinId, label) => pickSkin(skinId, label),
  onTrailToggle: (on) => setTrailEnabled(on),
});

const gate = new TurnstileGate({
  slot: el.turnstileSlot,
  container: el.turnstileWidget,
  note: el.turnstileNote,
  onError: (message) => {
    authError(message);
    // 挑战失败时,挂起的那次提交也要收尾,不能让用户一直等
    clearPendingAuth();
    setBusy(false);
  },
  // token 一到,如果用户已经点过按钮,立刻继续提交
  onReady: () => resumePendingAuth(),
});

const net = new NetClient({
  onMessage: handleServerMessage,
  onStateChange: handleConnectionState,
  getToken: () => state.wsToken,
  onJumpSent: () => input.consumeJump(),
});

/** 验证兜底定时器句柄 */
let pendingAuthTimer = null;

/* ------------------------------------------------------------------------- *
 * 启动
 * ------------------------------------------------------------------------- */
boot();

async function boot() {
  // 从第一帧开始,场地就在登录面板背后跟着跑。
  view.start();

  setLoading(true, 'Restoring your session');
  try {
    const res = await fetch('/api/session', { credentials: 'same-origin' });
    if (res.ok) {
      const data = await res.json();
      state.uid = data.uid;
      await obtainWsTicket();
      if (state.wsToken) {
        startGame(data);
        return;
      }
    }
  } catch {
    /* 网络异常时退回登录 */
  }
  setLoading(false);
  await gate.init();
  showLogin();
}

/* ------------------------------------------------------------------------- *
 * 登录 / 注册
 * ------------------------------------------------------------------------- */
function showLogin() {
  el.overlay.hidden = false;
  el.loading.hidden = true;
  el.error.hidden = true;
  el.error.textContent = '';

  // 退出登录后 Turnstile 的 token 已经用过,必须重新拿一个新的挑战
  if (gate.enabled) {
    gate.reset(true);
  }
  clearPendingAuth();
  setBusy(false);

  el.username.focus();
}

function authError(message) {
  el.error.textContent = message;
  el.error.hidden = false;
}

const ERROR_TEXT = {
  invalid_username: 'Use 3 to 20 letters, digits or underscores',
  invalid_password: 'Password needs at least 6 characters',
  invalid_credentials: 'That username and password do not match',
  username_taken: 'That username is already taken',
  payload_too_large: 'That request was too large',
  invalid_json: 'The request could not be read',
  server_error: 'The server could not handle that. Try again',
  network: 'Cannot reach the server',
  captcha_failed: 'Complete the verification below, then try again',
  direct_origin_forbidden: 'This server must be reached through its public address',
};

async function submitAuth(mode) {
  const username = el.username.value.trim();
  const password = el.password.value;

  el.error.hidden = true;

  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
    authError(ERROR_TEXT.invalid_username);
    return;
  }
  if (password.length < 6) {
    authError(ERROR_TEXT.invalid_password);
    return;
  }

  // 必须先拿到 Turnstile token 才能提交;服务端未启用时 takeToken() 返回空串
  const turnstileToken = gate.takeToken();
  if (turnstileToken === null) {
    // 挑战还在进行:记下这次提交意图,拿到 token 后自动继续
    submitWhenVerified(mode);
    return;
  }

  setBusy(true, mode);
  try {
    const res = await fetch(`/api/${mode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ username, password, turnstileToken }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      authError(ERROR_TEXT[data.error] ?? 'Sign in failed');
      // token 已被消费或校验失败,换一个新的
      gate.reset(true);
      return;
    }

    state.uid = data.uid;
    await obtainWsTicket();
    if (!state.wsToken) {
      authError('Could not get a connection ticket. Try again');
      return;
    }
    startGame({ uid: data.uid, displayName: data.displayName });
  } catch {
    authError(ERROR_TEXT.network);
    gate.reset();
  } finally {
    setBusy(false, mode);
  }
}

/** 从服务端取一个短期 WS 票据,cookie 是唯一凭据。 */
async function obtainWsTicket() {
  try {
    const res = await fetch('/api/ws-ticket', { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = await res.json();
    if (typeof data.token === 'string' && data.token.length > 0) {
      state.wsToken = data.token;
    }
  } catch {
    /* 失败时退化为 cookie 握手 */
  }
}

function setBusy(busy, mode) {
  el.btnLogin.disabled = busy;
  el.btnRegister.disabled = busy;
  el.btnLogin.textContent = busy && mode === 'login' ? 'Signing in' : 'Sign in';
  el.btnRegister.textContent = busy && mode === 'register' ? 'Creating account' : 'Create account';
}

/**
 * 提交前的验证等待。
 *
 * 早期做法是"没 token 就把按钮禁用",但一旦挑战被拦截或超时,
 * 用户面对的就是一个永远点不动的按钮,比报错还难受。
 *
 * 现在改成:点了就记下意图,提示正在验证,token 一到立刻自动提交。
 */

/** 等 token 到手后要自动执行的那次提交 */
let pendingAuth = null;

function submitWhenVerified(mode) {
  pendingAuth = mode;
  setBusy(true, mode);
  authError('Finishing the browser check. This takes a moment');

  clearTimeout(pendingAuthTimer);
  pendingAuthTimer = setTimeout(() => {
    if (!pendingAuth) return;
    pendingAuth = null;
    setBusy(false);
    authError('The browser check did not finish. Reload the page and try again');
  }, 30000);
}

function clearPendingAuth() {
  pendingAuth = null;
  clearTimeout(pendingAuthTimer);
}

/** Turnstile 拿到 token 时调用:如果有挂起的提交,立刻继续 */
function resumePendingAuth() {
  if (!pendingAuth) return;
  const mode = pendingAuth;
  clearPendingAuth();
  el.error.hidden = true;
  setBusy(false);
  submitAuth(mode);
}

el.form.addEventListener('submit', (event) => {
  event.preventDefault();
  submitAuth('login');
});

el.btnRegister.addEventListener('click', () => submitAuth('register'));

/* ------------------------------------------------------------------------- *
 * 进入游戏
 * ------------------------------------------------------------------------- */
function startGame() {
  if (state.starting) return;
  state.starting = true;

  el.overlay.hidden = true;
  setLoading(true, 'Connecting to the server');

  hud.showGameUi();
  gameUi.show();
  input.setEnabled(true);

  net.connect();

  // 防止 Chromebook 上弹出软键盘
  document.activeElement?.blur?.();

  window.addEventListener('keydown', handleActionKey);
  window.addEventListener('beforeunload', () => net.disconnect());
}

function setLoading(show, text) {
  el.loading.hidden = !show;
  if (text) el.loadingText.textContent = text;
}

/* ------------------------------------------------------------------------- *
 * 退出登录 / 会话失效
 * ------------------------------------------------------------------------- */

/**
 * 退出登录。
 *
 * 顺序很重要:先主动关掉 WebSocket,再清 cookie,最后回到登录页。
 * 如果先清 cookie,断线重连会拿不到票据而反复报错。
 */
async function doLogout(reason) {
  if (state.loggingOut) return;
  state.loggingOut = true;

  try {
    net.disconnect();
  } catch {
    /* 已经断开 */
  }

  // 清掉服务端 cookie,清掉内存里的票据
  try {
    await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
  } catch {
    /* 网络异常也要能退出 */
  }
  state.wsToken = null;
  state.uid = null;
  state.userName = '';
  state.starting = false;

  // 清 UI 状态
  input.setEnabled(false);
  hud.hideGameUi();
  gameUi.hide();
  view.logoutReset?.();

  state.loggingOut = false;

  showLogin();

  // 提示要放在 showLogin 之后,否则会被它清掉
  if (reason === 'expired') {
    authError('Your session expired. Sign in again.');
  } else if (reason === 'kicked') {
    authError('This account signed in somewhere else. You are signed out.');
  }
}

/**
 * 服务端明确拒绝会话时调用:断开并引导重新登录。
 * 只在真的需要时弹,避免网络抖动把人踢出去。
 */
function handleSessionLost(reason) {
  if (state.loggingOut) return;
  hud.setConnectionBanner('');
  doLogout(reason);
}

el.btnLogout?.addEventListener('click', () => {
  // 退出是破坏性操作,先确认
  if (window.confirm('Log out and return to the sign in screen?')) {
    doLogout();
  }
});

/* ------------------------------------------------------------------------- *
 * 服务器消息
 * ------------------------------------------------------------------------- */
function handleServerMessage(msg) {
  switch (msg.type) {
    case 'welcome': {
      state.uid = msg.uid;
      state.userName = msg.displayName ?? msg.uid;
      state.gems = msg.self?.gems ?? 0;
      state.pets = msg.self?.pets ?? [];
      state.lastSelfPos = msg.self?.pos ?? { x: 0, y: 0, z: 0 };
      state.roster.clear();
      for (const entry of msg.roster ?? []) state.roster.set(entry.uid, entry);

      // 右上角显示当前账号
      if (el.hudUser) el.hudUser.textContent = state.userName;

      // 用服务器下发的物理常量建本地预测器,保证两边参数同源
      if (msg.physics) {
        predictor = new LocalPredictor(msg.physics);
        predictor.snapTo(state.lastSelfPos);
        view.predictor = predictor;

        // 服务器存档里还是默认皮肤时,给这个账号挑一个稳定的区分色,
        // 让场上的颜色天然错开。已有皮肤的账号保持原样。
        const serverSkin = msg.skinId ?? DEFAULT_SKIN;
        const skin = serverSkin === DEFAULT_SKIN ? pickStarterSkin(msg.uid) : serverSkin;
        state.skinId = skin;
        net.skinId = skin;
        view.currentSkinId = skin;
        view.ensureTrail(skin);
      }

      view.applyWelcome(msg);
      if (Array.isArray(msg.stages)) view.buildStages(msg.stages);

      gameUi.applyWelcome(msg);
      if (msg.progress) gameUi.applyProgress(msg.progress);
      if (Array.isArray(msg.rooms)) gameUi.applyRooms(msg.rooms);

      hud.setGems(state.gems);
      hud.setPets(state.pets);
      setLoading(false);
      break;
    }

    case 'progress':
      state.progress = msg;
      state.speed = msg.speed;
      gameUi.applyProgress(msg);
      hud.setOnline(state.online);
      // 踏板高亮跟着"我买了哪台"走,同时驱动站上去未购买时的提示
      view.treadmillActiveUntil = msg.treadmills ?? {};
      gameUi.applyTreadmillAt(msg.treadmillAt ?? null);
      break;

    case 'leaderboard':
      gameUi.applyLeaderboard(msg);
      break;

    case 'rooms':
      gameUi.applyRooms(msg.rooms);
      break;

    case 'room_closed':
      // 房主删除了房间,我们在里面的所有人都被送回公共大厅
      gameUi.applyRoomClosed(msg);
      hud.toast('The room was closed. You are back in the lobby.', '');
      if (predictor && state.lastSelfPos) predictor.snapTo(state.lastSelfPos);
      state.pendingRoomRefresh = true;
      net.send({ type: 'request_rooms' });
      break;

    case 'stage_state':
      // 进入/退出关卡:本地预测器要立刻对齐,否则会看到一段滑行
      if (msg.stageId === null) {
        state.inStage = null;
      } else {
        state.inStage = msg.stageId;
      }
      // 关卡几何只在该玩家进入关卡时显示,避免从 lobby 看到悬空的平台
      view.setInStage(state.inStage);
      break;

    case 'world_snapshot':
      applySnapshot(msg);
      break;

    case 'self_state':
      state.lastSelfPos = msg.pos;
      state.gems = msg.gems ?? state.gems;
      state.online = msg.online ?? state.online;
      if (msg.roster && msg.rosterDirty) {
        state.roster.clear();
        for (const entry of msg.roster) state.roster.set(entry.uid, entry);
      }
      view.applySelfState(msg);
      // 权威位置交给预测器收敛:常态 100ms lerp,偏差超阈值直接对齐
      if (predictor) predictor.reconcile(msg.pos, msg.vel, msg.onGround);
      net.setPreviewPosition(msg.pos);
      hud.setGems(state.gems);
      hud.setOnline(state.online);
      break;

    case 'inventory':
      state.gems = msg.gems ?? state.gems;
      state.pets = msg.pets ?? state.pets;
      hud.setGems(state.gems);
      hud.setPets(state.pets);
      gameUi.applyPets(state.pets);
      break;

    case 'action_result':
      handleActionResult(msg);
      break;

    case 'error':
      if (msg.code) hud.toast(errorText(msg.code), 'bad');
      break;

    default:
      break;
  }
}

function applySnapshot(msg) {
  view.applySnapshot(msg);

  state.gemsById.clear();
  for (const gem of msg.gems ?? []) state.gemsById.set(gem.gemId, gem.pos);

  state.petsById.clear();
  for (const pet of msg.pets ?? []) {
    state.petsById.set(pet.petId, {
      ownerUid: pet.ownerUid,
      pos: pet.pos,
      hatchProgress: pet.hatchProgress,
    });
  }
  state.online = (msg.players?.length ?? 0) + 1;
  hud.setOnline(state.online);
}

const ACTION_TEXT = {
  pick_gem: { ok: '+1 gem', fail: { too_far: 'Too far from that gem', gem_unavailable: 'That gem is gone' } },
  steal_pet: {
    ok: 'Pet stolen',
    fail: {
      too_far: 'Too far from that pet',
      own_pet: 'That pet is already yours',
      pet_wild: 'Wild pets cannot be stolen',
      cooldown: 'That pet is still protected',
      owner_offline: 'The owner is offline',
      pet_missing: 'That pet is gone',
      transfer_failed: 'Could not transfer that pet. Try again',
    },
  },
  hatch_pet: {
    ok: 'Hatch progress added',
    fail: {
      too_far: 'Too far from that pet',
      not_owner: 'That pet is not yours',
      already_hatched: 'That pet is already hatched',
      cooldown: 'Hatching is still on cooldown',
      pet_missing: 'That pet is gone',
    },
  },
  pet_lost: { ok: '', fail: { stolen: 'Your pet was stolen' } },
  rebirth: {
    ok: 'Rebirth complete',
    fail: { below_min_speed: 'Not enough speed yet' },
  },
  buy_treadmill: {
    ok: 'Treadmill unlocked for 10 minutes',
    fail: {
      not_enough_gems: 'Not enough gems',
      unknown_treadmill: 'That treadmill does not exist',
    },
  },
  enter_stage: {
    ok: '',
    fail: {
      unknown_stage: 'That stage does not exist',
      previous_stage_locked: 'Clear the previous stage first',
      below_min_speed: 'Not enough speed to enter',
    },
  },
  exit_stage: { ok: '', fail: {} },
  join_room: {
    ok: '',
    fail: {
      room_full: 'That room is full',
      invalid_room_id: 'Room names use lowercase letters, digits and dashes',
      server_full: 'No room slots left',
    },
  },
  delete_room: {
    ok: 'Room deleted',
    fail: {
      room_not_found: 'That room no longer exists',
      cannot_delete_public: 'The public lobby cannot be deleted',
      not_owner: 'Only the room creator can delete it',
      cannot_delete_current: 'Leave the room before deleting it',
    },
  },
  stage_clear: { ok: '', fail: {} },
};

/**
 * 通关结算。
 *
 * 宝石只来自首通奖励(P2):
 *   - 首次通关:阶段奖励 + 可能的里程碑奖励
 *   - 重复通关:不再发宝石,但仍可继续攒 speed
 */
function handleStageClear(msg) {
  if (!msg.firstTime) {
    hud.toast('Stage cleared again. No more gems from this stage, but speed still counts.', 'info');
    return;
  }

  const parts = [`${msg.stageGems} stage`];
  if (msg.milestoneGems > 0) parts.push(`${msg.milestoneGems} milestone`);

  hud.toast(`First clear. +${msg.totalGems} gems (${parts.join(' + ')})`, 'good');

  if (msg.totalGems > 0) {
    // 浮字只负责显示:总数进大字,拆解进小字
    gameUi.floatReward(msg.totalGems, parts.join(' + '));
  }

  for (const group of msg.newMilestones ?? []) {
    hud.toast(`Milestone ${group}: every 10 new stages reached`, 'good');
  }

  if (typeof msg.elapsedMs === 'number' && msg.elapsedMs > 0) {
    hud.toast(`Clear time ${(msg.elapsedMs / 1000).toFixed(2)}s`, 'info');
  }
}

function handleActionResult(msg) {
  const table = ACTION_TEXT[msg.action];

  if (msg.action === 'stage_clear') {
    handleStageClear(msg);
    return;
  }
  if (msg.action === 'join_room' && msg.ok) {
    gameUi.setCurrentRoom(msg.roomId);
    hud.toast(`Joined ${msg.roomId}`, 'good');
    // 换房间后本地预测器必须立刻对齐
    if (predictor && state.lastSelfPos) predictor.snapTo(state.lastSelfPos);
    return;
  }

  if (msg.ok) {
    if (table?.ok) hud.toast(table.ok, 'good');
    return;
  }

  const reason = msg.reason;
  if (reason === 'cooldown' && msg.action !== 'pick_gem') {
    hud.toast('Still on cooldown', 'bad');
    return;
  }
  const text = table?.fail?.[reason];
  if (text) hud.toast(text, 'bad');
}

function errorText(code) {
  const map = {
    unauthorized: 'Your session expired. Sign in again',
    server_full: 'The server is full. Try again shortly',
    input_rate_exceeded: 'Too many inputs',
    payload_too_large: 'Malformed data',
  };
  return map[code] ?? String(code);
}

/* ------------------------------------------------------------------------- *
 * 连接状态
 * ------------------------------------------------------------------------- */
function handleConnectionState(nextState, info) {
  switch (nextState) {
    case 'connecting':
      hud.setConnectionBanner('');
      break;
    case 'open':
      hud.setConnectionBanner('');
      setLoading(false);
      break;
    case 'reconnecting':
      hud.setConnectionBanner(
        `Reconnecting (${info?.attempt ?? 1} of ${info?.max ?? 5})`,
      );
      break;
    case 'closed':
      hud.setConnectionBanner('');
      if (info?.reason === 'reconnect_exhausted') {
        hud.toast('Connection lost. Reload the page', 'bad');
        input.setEnabled(false);
      } else if (String(info?.reason ?? '').startsWith('server_')) {
        // 4001 = token 失效或被顶号,4003/4004 = 被判定异常
        // 这些都不该重连,直接引导回登录页
        const code = String(info.reason).replace('server_', '');
        if (code === '4001') handleSessionLost('expired');
        else handleSessionLost('kicked');
      }
      break;
    default:
      break;
  }
}

/* ------------------------------------------------------------------------- *
 * 操作按键
 * ------------------------------------------------------------------------- */
function handleActionKey(event) {
  if (!input.enabled) return;
  if (event.code === ACTION_KEYS.pick) {
    event.preventDefault();
    doPickOrSteal();
  } else if (event.code === ACTION_KEYS.hatch) {
    event.preventDefault();
    doHatch();
  } else if (event.code === 'KeyR') {
    // 转生由服务器校验门槛,这里直接发请求
    event.preventDefault();
    net.send({ type: 'request_rebirth' });
  } else if (event.code === 'KeyB') {
    event.preventDefault();
    gameUi.toggleBag();
  }
}

function doPickOrSteal() {
  const pos = state.lastSelfPos;

  const gemId = findNearestGem(state.gemsById, pos, 3.2);
  if (gemId) {
    net.tryPickGem(gemId);
    return;
  }

  const petId = findNearestPet(state.petsById, pos, 3.2, state.uid);
  if (petId) {
    const pet = state.petsById.get(petId);
    if (!pet || pet.ownerUid === null) hud.toast('Wild pets cannot be stolen', 'bad');
    else if (pet.ownerUid === state.uid) hud.toast('That is your pet. Press F to hatch', 'bad');
    else net.tryStealPet(petId);
    return;
  }

  hud.toast('Nothing to collect nearby', '');
}

function doHatch() {
  const pos = state.lastSelfPos;
  const petId = findNearestPet(state.petsById, pos, 3.2, state.uid);
  if (!petId) {
    hud.toast('No pet of yours nearby', '');
    return;
  }
  const pet = state.petsById.get(petId);
  if (!pet || pet.ownerUid !== state.uid) {
    hud.toast('That pet is not yours', 'bad');
    return;
  }
  net.tryHatchPet(petId);
}

/* ------------------------------------------------------------------------- *
 * 皮肤与拖尾(纯客户端,皮肤借用已有的 player_input 字段上报)
 * ------------------------------------------------------------------------- */

/**
 * 换皮肤。
 *
 * 服务端本来就接受 player_input 里的 skinId(有白名单校验),
 * 所以这里不改协议:本地先换外观,下一包输入就把新皮肤带上去。
 */
function pickSkin(skinId, label) {
  if (!view.setSkin(skinId)) return;
  net.skinId = skinId;
  state.skinId = skinId;
  gameUi.applySkin(skinId);
  gameUi.closeDrawers();
  hud.toast(`Skin: ${label}`, 'good');
}

/**
 * 新玩家的初始配色。
 *
 * 只在本地挑一个和别人不一样的,让场上颜色天然错开;
 * 真正的皮肤仍然由服务端保存与广播。
 */
function pickStarterSkin(uid) {
  if (!uid) return DEFAULT_SKIN;
  let hash = 0;
  for (let i = 0; i < uid.length; i += 1) hash = (hash * 31 + uid.charCodeAt(i)) >>> 0;
  return SKIN_ORDER[hash % SKIN_ORDER.length];
}

/** 拖尾开关:只影响本地渲染,不向服务端发任何东西。 */
function setTrailEnabled(on) {
  view.setTrailVisible?.(on);
}

/* ------------------------------------------------------------------------- *
 * 只读调试钩子(便于自动化测试与排查)
 * ------------------------------------------------------------------------- */
if (typeof window !== 'undefined') {
  window.__speedy = {
    get state() {
      return {
        uid: state.uid,
        gems: state.gems,
        online: state.online,
        pos: { ...state.lastSelfPos },
        skinId: state.skinId,
        net: net.state,
        pets: state.pets.map((p) => ({ petId: p.petId, hatchProgress: p.hatchProgress })),
        gemsById: [...state.gemsById.entries()],
        petsById: [...state.petsById.entries()],
      };
    },
    /** 渲染开销,排查掉帧时用 */
    get perf() {
      return view.perfSnapshot?.() ?? null;
    },
    /**
     * 触发一次奖励浮字,仅用于自动化验证视觉反馈。
     * 真实数值仍由服务端 stage_clear 消息驱动,这里不改变任何状态。
     */
    previewReward(amount = 2, detail = 'first clear') {
      gameUi.floatReward(String(amount), detail);
    },
  };
}

/* ------------------------------------------------------------------------- *
 * 主循环桥接:输入 → 网络 + 本地预测
 * ------------------------------------------------------------------------- */
const FRAME = { last: performance.now(), fpsAccum: 0, fpsFrames: 0 };

function clientLoop() {
  const now = performance.now();
  const dt = Math.min((now - FRAME.last) / 1000, 0.1);
  FRAME.last = now;

  if (net.state === 'open') {
    const snapshot = input.sample();
    net.setInput(snapshot);
    // 本地预测:只影响画面,判定仍在服务器
    view.predictMotion(dt, snapshot);
    view.syncPredictedFromPredictor();
    hud.setPing(net.rttMs);
  }

  // 帧率统计
  FRAME.fpsAccum += dt;
  FRAME.fpsFrames += 1;
  if (FRAME.fpsAccum >= 0.5) {
    hud.setFps(FRAME.fpsFrames / FRAME.fpsAccum);
    FRAME.fpsAccum = 0;
    FRAME.fpsFrames = 0;
  }

  requestAnimationFrame(clientLoop);
}
requestAnimationFrame(clientLoop);
