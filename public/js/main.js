/**
 * 客户端主流程:登录 → 连接 → 渲染循环。
 *
 * 严格按方案:页面加载后不刷新;连接只建立一次(断线内部重连)。
 */

import { GameView } from './render.js';
import { Hud } from './hud.js';
import { InputController } from './input.js';
import { NetClient } from './net.js';
import { ACTION_KEYS, findNearestGem, findNearestPet } from './targeting.js';

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
};

const state = {
  /** 短期 WS 票据,只放内存,不落 localStorage(避免 XSS 偷取) */
  wsToken: null,
  uid: null,
  gems: 0,
  pets: [],
  petCooldowns: new Map(),
  /** gemId -> {x,z} */
  gemsById: new Map(),
  /** petId -> {ownerUid, pos} */
  petsById: new Map(),
  roster: new Map(),
  online: 0,
  rtt: null,
  lastSelfPos: { x: 0, y: 0, z: 0 },
  starting: false,
};

const hud = new Hud();
const view = new GameView(el.canvas);
const input = new InputController();

const net = new NetClient({
  onMessage: handleServerMessage,
  onStateChange: handleConnectionState,
  getToken: () => state.wsToken,
  onJumpSent: () => input.consumeJump(),
});

/* ------------------------------------------------------------------------- *
 * 启动
 * ------------------------------------------------------------------------- */
boot();

async function boot() {
  // 复用 HttpOnly cookie 里的会话:能恢复就直接进游戏,不用重新输密码
  setLoading(true, '正在恢复会话…');
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
  showLogin();
}

/* ------------------------------------------------------------------------- *
 * 登录 / 注册
 * ------------------------------------------------------------------------- */
function showLogin() {
  el.overlay.hidden = false;
  el.loading.hidden = true;
  el.username.focus();
}

function authError(message) {
  el.error.textContent = message;
  el.error.hidden = false;
}

const ERROR_TEXT = {
  invalid_username: '用户名需为 3-20 位字母、数字或下划线',
  invalid_password: '密码至少 6 位',
  invalid_credentials: '用户名或密码不正确',
  username_taken: '这个用户名已被占用',
  payload_too_large: '请求内容过大',
  invalid_json: '请求格式错误',
  server_error: '服务器开小差了,请稍后再试',
  network: '无法连接服务器',
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

  setBusy(true, mode);
  try {
    const res = await fetch(`/api/${mode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      authError(ERROR_TEXT[data.error] ?? '登录失败');
      return;
    }

    state.uid = data.uid;
    await obtainWsTicket();
    if (!state.wsToken) {
      authError('无法获取连接凭证,请重试');
      return;
    }
    startGame({ uid: data.uid, displayName: data.displayName });
  } catch {
    authError(ERROR_TEXT.network);
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
  if (busy) {
    el.btnLogin.textContent = mode === 'login' ? '登录中…' : '进入游戏';
    el.btnRegister.textContent = mode === 'register' ? '注册中…' : '注册新账号';
  } else {
    el.btnLogin.textContent = '进入游戏';
    el.btnRegister.textContent = '注册新账号';
  }
}

el.form.addEventListener('submit', (event) => {
  event.preventDefault();
  submitAuth('login');
});

el.btnRegister.addEventListener('click', () => submitAuth('register'));

/* ------------------------------------------------------------------------- *
 * 进入游戏
 * ------------------------------------------------------------------------- */
function startGame(profile) {
  if (state.starting) return;
  state.starting = true;

  el.overlay.hidden = true;
  setLoading(true, '正在连接服务器…');

  hud.showGameUi();
  input.setEnabled(true);
  view.start();

  net.connect();
  el.username.blur();
  el.password.blur();
  // 防止 Chromebook 上软键盘弹出
  document.activeElement?.blur?.();

  window.addEventListener('keydown', handleActionKey);
  window.addEventListener('beforeunload', () => net.disconnect());
}

function setLoading(show, text) {
  el.loading.hidden = !show;
  if (text) el.loadingText.textContent = text;
}

/* ------------------------------------------------------------------------- *
 * 服务器消息
 * ------------------------------------------------------------------------- */
function handleServerMessage(msg) {
  switch (msg.type) {
    case 'welcome':
      state.uid = msg.uid;
      state.gems = msg.self?.gems ?? 0;
      state.pets = msg.self?.pets ?? [];
      state.lastSelfPos = msg.self?.pos ?? { x: 0, y: 0, z: 0 };
      state.roster.clear();
      for (const entry of msg.roster ?? []) {
        state.roster.set(entry.uid, entry);
      }
      view.applyWelcome(msg);
      hud.setGems(state.gems);
      hud.setPets(state.pets, state.petCooldowns);
      setLoading(false);
      hud.toast('已进入游戏', 'good');
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
      net.setPreviewPosition(msg.pos);
      hud.setGems(state.gems);
      hud.setOnline(state.online);
      break;

    case 'inventory':
      state.gems = msg.gems ?? state.gems;
      state.pets = msg.pets ?? state.pets;
      hud.setGems(state.gems);
      hud.setPets(state.pets, state.petCooldowns);
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
    state.petsById.set(pet.petId, { ownerUid: pet.ownerUid, pos: pet.pos, hatchProgress: pet.hatchProgress });
  }
  state.online = (msg.players?.length ?? 0) + 1;
  hud.setOnline(state.online);
}

const ACTION_TEXT = {
  pick_gem: { ok: '💎 +1', fail: { too_far: '离宝石太远了', gem_unavailable: '宝石已被拿走' } },
  steal_pet: {
    ok: '🐾 偷到宠物了!',
    fail: {
      too_far: '离宠物太远了',
      own_pet: '这是你自己的宠物',
      pet_wild: '野生宠物不能偷',
      cooldown: '还在冷却中',
      owner_offline: '主人不在线',
      pet_missing: '宠物不存在了',
      transfer_failed: '转移失败,请重试',
    },
  },
  hatch_pet: {
    ok: '🥚 孵化进度 +1',
    fail: {
      too_far: '离宠物太远了',
      not_owner: '这不是你的宠物',
      already_hatched: '已经孵化完成',
      cooldown: '还在冷却中',
      pet_missing: '宠物不存在了',
    },
  },
  pet_lost: { ok: '', fail: { stolen: '⚠️ 你的宠物被偷走了!' } },
};

function handleActionResult(msg) {
  const table = ACTION_TEXT[msg.action];
  if (msg.ok) {
    if (table?.ok) hud.toast(table.ok, 'good');
    if (msg.action === 'steal_pet' && msg.petId) {
      state.petCooldowns.set(msg.petId, Date.now() + 12_000);
    }
    if (msg.action === 'hatch_pet' && msg.petId) {
      state.petCooldowns.set(`hatch:${msg.petId}`, Date.now() + 20_000);
    }
    return;
  }

  const reason = msg.reason;
  if (reason === 'cooldown' && msg.action !== 'pick_gem') {
    hud.toast('冷却中,稍等一下', 'bad');
    return;
  }
  const text = table?.fail?.[reason];
  if (text) hud.toast(text, 'bad');
}

function errorText(code) {
  const map = {
    unauthorized: '登录已过期,请重新登录',
    server_full: '服务器已满,请稍后再试',
    input_rate_exceeded: '操作过快',
    payload_too_large: '数据异常',
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
      hud.setConnectionBanner(`连接中断,正在重连 (${info?.attempt ?? 1}/${info?.max ?? 5})…`);
      break;
    case 'closed':
      hud.setConnectionBanner('');
      if (info?.reason === 'reconnect_exhausted') {
        hud.toast('连接已断开,请刷新页面', 'bad');
        input.setEnabled(false);
      } else if (String(info?.reason ?? '').startsWith('server_')) {
        hud.toast('服务器拒绝了连接,请重新登录', 'bad');
        input.setEnabled(false);
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
    if (!pet || pet.ownerUid === null) hud.toast('野生宠物不能偷', 'bad');
    else if (pet.ownerUid === state.uid) hud.toast('这是你自己的宠物,按 F 孵化', 'bad');
    else net.tryStealPet(petId);
    return;
  }

  hud.toast('附近没有可拾取的东西', '');
}

function doHatch() {
  const pos = state.lastSelfPos;
  const petId = findNearestPet(state.petsById, pos, 3.2, state.uid);
  if (!petId) {
    hud.toast('附近没有你的宠物', '');
    return;
  }
  const pet = state.petsById.get(petId);
  if (!pet || pet.ownerUid !== state.uid) {
    hud.toast('这不是你的宠物', 'bad');
    return;
  }
  net.tryHatchPet(petId);
}

/* ------------------------------------------------------------------------- *
 * 调试钩子(只读快照,便于自动化测试与排查)
 * ------------------------------------------------------------------------- */
if (typeof window !== 'undefined') {
  window.__speedy = {
    get state() {
      return {
        uid: state.uid,
        gems: state.gems,
        online: state.online,
        rtt: state.rtt,
        pos: { ...state.lastSelfPos },
        net: net.state,
        pets: state.pets.map((p) => ({ petId: p.petId, hatchProgress: p.hatchProgress })),
        gemsById: [...state.gemsById.entries()],
        petsById: [...state.petsById.entries()],
      };
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
    view.predictMotion(dt, snapshot);
    hud.setPing(net.rttMs);
  }

  // 帧率统计 + 冷却倒计时刷新
  FRAME.fpsAccum += dt;
  FRAME.fpsFrames += 1;
  if (FRAME.fpsAccum >= 0.5) {
    hud.setFps(FRAME.fpsFrames / FRAME.fpsAccum);
    FRAME.fpsAccum = 0;
    FRAME.fpsFrames = 0;
    hud.updateCooldownBadges(state.petCooldowns);
  }

  requestAnimationFrame(clientLoop);
}
requestAnimationFrame(clientLoop);
