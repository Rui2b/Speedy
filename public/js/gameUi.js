/**
 * 游戏界面:速度 HUD、侧边面板(房间/跑步机/关卡/转生)、排行榜、背包、房间选择。
 *
 * 纯 DOM,和渲染循环解耦。所有数值都来自服务器下发,这里只负责显示与发请求。
 */

const RARITY_LABEL = {
  common: 'Common',
  rare: 'Rare',
  epic: 'Epic',
  legendary: 'Legendary',
};

export class GameUi {
  /**
   * @param {object} handlers
   * @param {(treadmillId: string) => void} handlers.onBuyTreadmill
   * @param {(stage: number) => void} handlers.onEnterStage
   * @param {() => void} handlers.onExitStage
   * @param {() => void} handlers.onRebirth
   * @param {(roomId: string) => void} handlers.onJoinRoom
   */
  constructor(handlers) {
    this.handlers = handlers;
    this.el = {
      // 顶部
      speed: document.getElementById('hud-speed'),
      mult: document.getElementById('hud-mult'),
      gems: document.getElementById('hud-gems'),
      rebirth: document.getElementById('hud-rebirth'),
      online: document.getElementById('hud-online'),
      speedWrap: document.querySelector('.scoreboard-speed'),

      // 侧边
      sidePanel: document.getElementById('side-panel'),
      currentRoom: document.getElementById('current-room'),
      treadmillList: document.getElementById('treadmill-list'),
      stageList: document.getElementById('stage-list'),
      btnExitStage: document.getElementById('btn-exit-stage'),
      btnRebirth: document.getElementById('btn-rebirth'),
      rebirthSub: document.getElementById('rebirth-sub'),

      // 排行榜
      leaderboard: document.getElementById('leaderboard'),
      leaderboardRows: document.getElementById('leaderboard-rows'),

      // 背包
      bagBtn: document.getElementById('btn-bag'),
      bagCount: document.getElementById('bag-count'),
      bagPanel: document.getElementById('bag-panel'),
      bagList: document.getElementById('bag-list'),
      btnBagClose: document.getElementById('btn-bag-close'),

      // 房间
      btnRoom: document.getElementById('btn-room'),
      roomPanel: document.getElementById('room-panel'),
      roomList: document.getElementById('room-list'),
      roomInput: document.getElementById('room-input'),
      btnRoomJoin: document.getElementById('btn-room-join'),
      btnRoomClose: document.getElementById('btn-room-close'),
    };

    /** 缓存的服务器状态 */
    this.progress = null;
    this.treadmills = [];
    this.stages = [];
    this.currentRoom = '';
    this.rooms = [];
    this.selfUid = '';
    this.lastSpeed = 0;
    this.gainTimer = null;

    this.wireEvents();
  }

  wireEvents() {
    this.el.btnRebirth.addEventListener('click', () => this.handlers.onRebirth());
    this.el.btnExitStage.addEventListener('click', () => this.handlers.onExitStage());
    this.el.btnRoom.addEventListener('click', () => this.toggleRoomPanel());
    this.el.btnRoomClose.addEventListener('click', () => this.toggleRoomPanel(false));
    this.el.btnRoomJoin.addEventListener('click', () => this.joinTypedRoom());
    this.el.roomInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.joinTypedRoom();
      }
    });
    this.el.bagBtn.addEventListener('click', () => this.toggleBag());
    this.el.btnBagClose.addEventListener('click', () => this.toggleBag(false));
  }

  /** 从 welcome 里初始化静态配置。 */
  applyWelcome(msg) {
    this.selfUid = msg.uid;
    this.currentRoom = msg.roomId ?? '';
    this.stages = msg.stages ?? [];
    this.treadmills = msg.config?.treadmills ?? [];
    this.el.currentRoom.textContent = this.currentRoom;
    this.renderTreadmills();
    this.renderStages();
  }

  show() {
    this.el.sidePanel.hidden = false;
    this.el.leaderboard.hidden = false;
    this.el.bagBtn.hidden = false;
  }

  /* ------------------------------------------------------------------ *
   * 顶部数值
   * ------------------------------------------------------------------ */
  applyProgress(progress) {
    this.progress = progress;

    const speedText = formatSpeed(progress.speed);
    if (progress.speed > this.lastSpeed + 1e-6) {
      this.flashGain();
    }
    this.lastSpeed = progress.speed;
    this.el.speed.textContent = speedText;

    this.el.mult.textContent = `\u00d7${formatMultiplier(progress.multiplier)}`;
    this.el.gems.textContent = String(progress.gems ?? 0);
    this.el.rebirth.textContent = String(progress.rebirth ?? 0);

    // 转生按钮:不足门槛时禁用并显示还差多少
    const min = progress.rebirthMinSpeed ?? 100;
    const canRebirth = progress.speed >= min;
    this.el.btnRebirth.disabled = !canRebirth;
    this.el.rebirthSub.textContent = canRebirth
      ? `Reset speed, multiplier \u00d7${formatMultiplier(progress.multiplier * 1.5)}`
      : `Needs ${min} speed (${Math.ceil(min - progress.speed)} to go)`;

    // 跑步机倒计时
    this.renderTreadmills();

    // 关卡解锁状态
    this.renderStages();
  }

  flashGain() {
    if (!this.el.speed) return;
    this.el.speed.classList.add('is-gaining');
    clearTimeout(this.gainTimer);
    this.gainTimer = setTimeout(() => {
      this.el.speed.classList.remove('is-gaining');
    }, 400);
  }

  setOnline(count) {
    this.el.online.textContent = String(count);
  }

  /* ------------------------------------------------------------------ *
   * 跑步机
   * ------------------------------------------------------------------ */
  renderTreadmills() {
    if (!this.el.treadmillList || this.treadmills.length === 0) return;

    const active = this.progress?.treadmills ?? {};
    const now = Date.now();

    this.el.treadmillList.replaceChildren();

    for (const machine of this.treadmills) {
      const until = active[machine.id] ?? 0;
      const remaining = Math.max(0, until - now);
      const isActive = remaining > 0;

      const row = document.createElement('div');
      row.className = `treadmill${isActive ? ' is-active' : ''}`;

      const name = document.createElement('span');
      name.className = 'treadmill-name';
      name.textContent = machine.name;

      const meta = document.createElement('span');
      meta.className = 'treadmill-meta';
      meta.textContent = isActive ? formatRemaining(remaining) : `${machine.bonus}\u00d7 \u00b7 ${machine.gemPrice} gems`;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mini-btn';
      btn.textContent = isActive ? '+10m' : 'Buy';
      btn.title = `Costs ${machine.gemPrice} gems for 10 minutes`;
      btn.addEventListener('click', () => this.handlers.onBuyTreadmill(machine.id));

      row.append(name, meta, btn);
      this.el.treadmillList.appendChild(row);
    }
  }

  /* ------------------------------------------------------------------ *
   * 关卡
   * ------------------------------------------------------------------ */
  renderStages() {
    if (!this.el.stageList) return;

    const cleared = new Set(this.progress?.clearedStages ?? []);
    const inStage = this.progress?.location?.world === 'obby' ? this.progress.location.stage : null;
    const minSpeed = this.progress?.rebirthMinSpeed ?? 0;

    this.el.stageList.replaceChildren();

    for (const stage of this.stages) {
      const isCleared = cleared.has(stage.id);
      const prevCleared = stage.id === 1 || cleared.has(stage.id - 1);
      const speedOk = (this.progress?.speed ?? 0) >= stage.minSpeed;

      const row = document.createElement('div');
      row.className = `stage${isCleared ? ' is-cleared' : ''}`;

      const idx = document.createElement('span');
      idx.className = 'stage-index';
      idx.textContent = String(stage.id);

      const name = document.createElement('span');
      name.className = 'stage-name';
      name.textContent = stage.name.replace(/^Stage \d+ \u00b7 /, '');
      name.title = stage.name;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'stage-btn';

      const isCurrent = inStage === stage.id;
      btn.textContent = isCurrent ? 'Inside' : isCleared ? 'Replay' : 'Enter';
      btn.disabled = isCurrent || !prevCleared || !speedOk;
      btn.title = !prevCleared
        ? 'Clear the previous stage first'
        : !speedOk
          ? `Needs ${stage.minSpeed} speed`
          : '';
      btn.addEventListener('click', () => this.handlers.onEnterStage(stage.id));

      row.append(idx, name, btn);
      this.el.stageList.appendChild(row);
    }

    this.el.btnExitStage.hidden = inStage === null;
  }

  /* ------------------------------------------------------------------ *
   * 排行榜
   * ------------------------------------------------------------------ */
  applyLeaderboard(msg) {
    if (!this.el.leaderboardRows) return;
    const rows = Array.isArray(msg.rows) ? msg.rows : [];

    this.el.leaderboardRows.replaceChildren();

    if (rows.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'leaderboard-row';
      empty.textContent = 'No players yet';
      this.el.leaderboardRows.appendChild(empty);
      return;
    }

    rows.forEach((row, index) => {
      const li = document.createElement('li');
      li.className = `leaderboard-row${row.uid === this.selfUid ? ' is-me' : ''}`;

      const rank = document.createElement('span');
      rank.className = 'lb-rank';
      rank.textContent = String(index + 1);

      const name = document.createElement('span');
      name.className = 'lb-name';
      name.textContent = row.displayName;

      const score = document.createElement('span');
      score.className = 'lb-score';
      // 排行榜按转生优先,所以显示 "✕倍率 · speed"
      score.textContent = `${row.rebirth}\u2605 ${formatSpeed(row.speed)}`;

      li.append(rank, name, score);
      this.el.leaderboardRows.appendChild(li);
    });
  }

  /* ------------------------------------------------------------------ *
   * 背包
   * ------------------------------------------------------------------ */
  applyPets(pets) {
    this.pets = Array.isArray(pets) ? pets : [];
    this.el.bagCount.textContent = String(this.pets.length);
    if (!this.el.bagPanel.hidden) this.renderBag();
  }

  toggleBag(force) {
    const show = force === undefined ? this.el.bagPanel.hidden : force;
    this.el.bagPanel.hidden = !show;
    if (show) this.renderBag();
  }

  renderBag() {
    const list = this.pets ?? [];
    this.el.bagList.replaceChildren();

    if (list.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'bag-state';
      empty.textContent = 'No pets yet. Find an egg on the field.';
      this.el.bagList.appendChild(empty);
      return;
    }

    for (const pet of list) {
      const row = document.createElement('div');
      row.className = 'bag-row';

      const swatch = document.createElement('span');
      swatch.className = `bag-swatch rarity-${pet.rarity ?? 'common'}`;

      const name = document.createElement('span');
      name.className = 'bag-name';
      name.textContent = `${RARITY_LABEL[pet.rarity] ?? 'Common'} ${pet.isEgg ? 'egg' : 'pet'}`;

      const state = document.createElement('span');
      state.className = 'bag-state';
      if (pet.isHatched) state.textContent = 'Hatched';
      else if (pet.hatchProgress > 0) state.textContent = `${Math.round(pet.hatchProgress)}%`;
      else state.textContent = 'Ready';

      row.append(swatch, name, state);
      this.el.bagList.appendChild(row);
    }
  }

  /* ------------------------------------------------------------------ *
   * 房间
   * ------------------------------------------------------------------ */
  applyRooms(rooms) {
    this.rooms = Array.isArray(rooms) ? rooms : [];
    if (!this.el.roomPanel.hidden) this.renderRooms();
  }

  toggleRoomPanel(force) {
    const show = force === undefined ? this.el.roomPanel.hidden : force;
    this.el.roomPanel.hidden = !show;
    if (show) {
      this.renderRooms();
      this.el.roomInput.focus();
    }
  }

  renderRooms() {
    this.el.roomList.replaceChildren();

    for (const room of this.rooms) {
      const row = document.createElement('div');
      row.className = `room-row${room.id === this.currentRoom ? ' is-current' : ''}`;

      const name = document.createElement('span');
      name.className = 'room-row-name';
      name.textContent = room.id;

      const count = document.createElement('span');
      count.className = 'room-row-count';
      count.textContent = `${room.players}/${room.capacity}`;

      row.append(name, count);
      row.addEventListener('click', () => {
        this.handlers.onJoinRoom(room.id);
        this.toggleRoomPanel(false);
      });
      this.el.roomList.appendChild(row);
    }
  }

  joinTypedRoom() {
    const value = this.el.roomInput.value.trim().toLowerCase();
    if (!/^[a-z0-9-]{1,24}$/.test(value)) {
      this.el.roomInput.focus();
      return;
    }
    this.handlers.onJoinRoom(value);
    this.el.roomInput.value = '';
    this.toggleRoomPanel(false);
  }

  setCurrentRoom(roomId) {
    this.currentRoom = roomId;
    this.el.currentRoom.textContent = roomId;
  }
}

function formatSpeed(value) {
  const n = Number(value) || 0;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  if (n >= 100) return n.toFixed(0);
  return n.toFixed(1);
}

function formatMultiplier(value) {
  const n = Number(value) || 1;
  return n >= 10 ? n.toFixed(0) : n.toFixed(1).replace(/\.0$/, '');
}

function formatRemaining(ms) {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
