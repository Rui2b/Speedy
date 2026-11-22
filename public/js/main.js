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
  invalid_username: 'Use 3 to 20 letters, digits or underscores',
  invalid_password: 'Password needs at least 6 characters',
  invalid_credentials: 'That username and password do not match',
  username_taken: 'That username is already taken',
  payload_too_large: 'That request was too large',
  invalid_json: 'The request could not be read',
  server_error: 'The server could not handle that. Try again',
  network: 'Cannot reach the server',
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
      authError(ERROR_TEXT[data.error] ?? 'Sign in failed');
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
      for (const entry of msg.roster ?? []) state.roster.set(entry.uid, entry);
      view.applyWelcome(msg);
      hud.setGems(state.gems);
      hud.setPets(state.pets);
      setLoading(false);
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
      hud.setPets(state.pets);
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
};

function handleActionResult(msg) {
  const table = ACTION_TEXT[msg.action];
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
        hud.toast('The server closed the connection. Sign in again', 'bad');
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
