/**
 * 游戏界面:速度 HUD、侧边面板(房间/跑步机/关卡/转生)、排行榜、背包、房间选择。
 *
 * 纯 DOM,和渲染循环解耦。所有数值都来自服务器下发,这里只负责显示与发请求。
 */

/**
 * 游戏界面:HUD 数值、侧边功能栏、抽屉(宠物/皮肤/奖励/房间)、排行榜。
 *
 * 纯 DOM,和渲染循环解耦。所有数值都来自服务器下发,这里只负责显示与发请求。
 */
import { SKINS, SKIN_ORDER } from './assets.js';

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
   * @param {(roomId: string) => void} handlers.onDeleteRoom
   * @param {(skinId: string, label: string) => void} handlers.onPickSkin
   * @param {(on: boolean) => void} handlers.onTrailToggle
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
      treadmillPrompt: document.getElementById('treadmill-prompt'),
      treadmillPromptTitle: document.getElementById('treadmill-prompt-title'),
      treadmillPromptBody: document.getElementById('treadmill-prompt-body'),
      treadmillPromptBuy: document.getElementById('treadmill-prompt-buy'),
      stageList: document.getElementById('stage-list'),
      btnExitStage: document.getElementById('btn-exit-stage'),
      btnRoom: document.getElementById('btn-room'),

      // 排行榜
      leaderboard: document.getElementById('leaderboard'),
      leaderboardRows: document.getElementById('leaderboard-rows'),

      // 侧边功能栏
      railLeft: document.getElementById('rail-left'),
      railRight: document.getElementById('rail-right'),
      railRebirth: document.getElementById('rail-rebirth'),
      railRebirthBadge: document.getElementById('rail-rebirth-badge'),
      railPets: document.getElementById('rail-pets'),
      railPetsBadge: document.getElementById('rail-pets-badge'),
      railSkins: document.getElementById('rail-skins'),
      railRewards: document.getElementById('rail-rewards'),
      railTrails: document.getElementById('rail-trails'),
      railTrailsState: document.getElementById('rail-trails-state'),

      // 抽屉
      skinPanel: document.getElementById('skin-panel'),
      skinList: document.getElementById('skin-list'),
      rewardsPanel: document.getElementById('rewards-panel'),
      rewardsProgress: document.getElementById('rewards-progress'),
      bagPanel: document.getElementById('bag-panel'),
      bagList: document.getElementById('bag-list'),

      // 房间
      roomPanel: document.getElementById('room-panel'),
      roomList: document.getElementById('room-list'),
      roomInput: document.getElementById('room-input'),
      btnRoomJoin: document.getElementById('btn-room-join'),

      // 转生进度条
      rebirthMeter: document.getElementById('rebirth-meter'),
      rebirthFill: document.getElementById('rebirth-meter-fill'),
      rebirthSub: document.getElementById('rebirth-sub'),
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
    /** 一次购买的有效时长,由 welcome.config 下发 */
    this.sessionMs = 10 * 60 * 1000;
    this.lastTreadmillSignature = '';
    /** 当前皮肤,由欢迎消息与选择面板共同维护 */
    this.currentSkinId = '';
    /** 拖尾开关(纯客户端视觉) */
    this.trailOn = true;

    this.wireEvents();
  }

  wireEvents() {
    this.el.railRebirth.addEventListener('click', () => this.handlers.onRebirth());
    this.el.btnExitStage.addEventListener('click', () => this.handlers.onExitStage());
    this.el.btnRoom.addEventListener('click', () => this.toggleDrawer('room-panel'));
    this.el.btnRoomJoin.addEventListener('click', () => this.joinTypedRoom());
    this.el.roomInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.joinTypedRoom();
      }
    });

    this.el.railPets.addEventListener('click', () => this.toggleDrawer('bag-panel'));
    this.el.railSkins.addEventListener('click', () => this.toggleDrawer('skin-panel'));
    this.el.railRewards.addEventListener('click', () => this.toggleDrawer('rewards-panel'));
    this.el.railTrails.addEventListener('click', () => this.toggleTrail());

    // 抽屉右上角的关闭按钮统一走 data-close
    for (const btn of document.querySelectorAll('[data-close]')) {
      btn.addEventListener('click', () => this.closeDrawers());
    }

    // 点空白处收起抽屉(但不要挡住 canvas 的移动操作:只认点击背景)
    document.addEventListener('pointerdown', (event) => {
      if (event.target.closest('.drawer, .rail-btn, #btn-room')) return;
      this.closeDrawers();
    });
  }

  /**
   * 打开/关闭一个抽屉。同一时间只留一个,避免互相盖住。
   * @param {string} id
   */
  toggleDrawer(id) {
    const target = document.getElementById(id);
    if (!target) return;
    const willOpen = target.hidden;

    this.closeDrawers();
    if (!willOpen) return;

    target.hidden = false;
    if (id === 'bag-panel') this.renderBag();
    if (id === 'skin-panel') this.renderSkins();
    if (id === 'rewards-panel') this.renderRewards();
    if (id === 'room-panel') {
      this.renderRooms();
      this.el.roomInput.focus();
    }
  }

  closeDrawers() {
    for (const id of ['bag-panel', 'skin-panel', 'rewards-panel', 'room-panel']) {
      const panel = document.getElementById(id);
      if (panel) panel.hidden = true;
    }
  }

  /** 拖尾开关:纯客户端视觉,不需要服务端参与。 */
  toggleTrail() {
    this.trailOn = !this.trailOn;
    this.el.railTrailsState.textContent = this.trailOn ? 'On' : 'Off';
    this.el.railTrails.classList.toggle('is-ready', this.trailOn);
    this.handlers.onTrailToggle?.(this.trailOn);
  }

  /** 从 welcome 里初始化静态配置。 */
  applyWelcome(msg) {
    this.selfUid = msg.uid;
    this.currentRoom = msg.roomId ?? '';
    this.stages = msg.stages ?? [];
    this.treadmills = msg.config?.treadmills ?? [];
    this.currentSkinId = msg.skinId ?? this.currentSkinId;
    if (Number.isFinite(msg.config?.treadmillSessionMs)) {
      this.sessionMs = msg.config.treadmillSessionMs;
    }
    this.el.currentRoom.textContent = this.currentRoom;
    this.renderTreadmills();
    this.renderStages();
  }

  /** 被房主删房后,服务端把我们送回 lobby。 */
  applyRoomClosed(msg) {
    this.setCurrentRoom(msg.movedTo ?? 'lobby-1');
    if (!this.el.roomPanel.hidden) this.renderRooms();
  }

  show() {
    this.el.sidePanel.hidden = false;
    this.el.leaderboard.hidden = false;
    this.el.railLeft.hidden = false;
    this.el.railRight.hidden = false;
  }

  /** 退出登录时收起所有面板。 */
  hide() {
    this.el.sidePanel.hidden = true;
    this.el.leaderboard.hidden = true;
    this.el.railLeft.hidden = true;
    this.el.railRight.hidden = true;
    this.closeDrawers();
    this.el.leaderboardRows.replaceChildren();
    this.el.bagList.replaceChildren();
    this.el.roomList.replaceChildren();
    this.el.stageList.replaceChildren();
    this.el.treadmillList.replaceChildren();
    this.hideTreadmillPrompt();
    this.lastTreadmillSignature = '';
    this.progress = null;
    this.pets = [];
    this.lastSpeed = 0;
  }

  /**
   * 抽屉:打开/关闭一个抽屉。同一时间只留一个,避免互相盖住。
   * (实现见上方 toggleDrawer)
   */

  /* ------------------------------------------------------------------ *
   * 皮肤
   * ------------------------------------------------------------------ */
  renderSkins() {
    if (!this.el.skinList) return;
    this.el.skinList.replaceChildren();

    for (const id of SKIN_ORDER) {
      const skin = SKINS[id];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `skin-btn${id === this.currentSkinId ? ' is-active' : ''}`;
      btn.title = skin.label;

      const swatch = document.createElement('span');
      swatch.className = 'skin-swatch';
      swatch.style.background = `linear-gradient(135deg, #${skin.body.toString(16).padStart(6, '0')}, #${skin.accent.toString(16).padStart(6, '0')})`;

      const name = document.createElement('span');
      name.className = 'skin-name';
      name.textContent = skin.label;

      btn.append(swatch, name);
      btn.addEventListener('click', () => this.handlers.onPickSkin?.(id, skin.label));
      this.el.skinList.appendChild(btn);
    }
  }

  applySkin(skinId) {
    this.currentSkinId = skinId;
    if (!this.el.skinPanel.hidden) this.renderSkins();
  }

  /** 奖励说明里的数字跟着服务端下发的配置走,避免写死。 */
  renderRewards() {
    if (!this.el.rewardsPanel) return;
    const cleared = this.progress?.clearedStages?.length ?? 0;
    if (this.el.rewardsProgress) {
      this.el.rewardsProgress.textContent =
        cleared === 0 ? 'No stages cleared yet' : `Cleared ${cleared} of ${this.stages.length} stages`;
    }
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

    // 转生进度条:到门槛就可以点,不足时显示还差多少
    const min = progress.rebirthMinSpeed ?? 100;
    const canRebirth = progress.speed >= min;
    const ratio = Math.max(0, Math.min(1, progress.speed / Math.max(1, min)));
    if (this.el.rebirthFill) {
      this.el.rebirthFill.style.width = `${(ratio * 100).toFixed(1)}%`;
    }
    if (this.el.rebirthMeter) {
      this.el.rebirthMeter.classList.toggle('is-ready', canRebirth);
    }
    if (this.el.rebirthSub) {
      this.el.rebirthSub.textContent = canRebirth
        ? `Ready. Resets speed, multiplier becomes \u00d7${formatMultiplier(progress.multiplier * 1.5)}`
        : `${formatSpeed(progress.speed)} of ${min} speed (${Math.ceil(min - progress.speed)} to go)`;
    }

    // 侧边栏的转生按钮跟着可用状态走
    if (this.el.railRebirth) {
      this.el.railRebirth.disabled = !canRebirth;
      this.el.railRebirth.classList.toggle('is-ready', canRebirth);
      // 淡淡的"可以转生了"提示点,不闪烁
      this.el.railRebirthBadge.hidden = !canRebirth;
      if (canRebirth) this.el.railRebirthBadge.textContent = 'Ready';
    }

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

  /**
   * 奖励浮层:首次通关时在宝石计数旁浮出 "+N"。
   * 只做视觉反馈,数值本身以服务端下发为准。
   */
  floatReward(amount, detail = '') {
    const host = this.el.gems?.parentElement ?? this.el.gems;
    if (!host) return;

    const node = document.createElement('span');
    node.className = 'reward-float';
    node.innerHTML = `<strong>+${amount}</strong>${detail ? `<em>${detail}</em>` : ''}`;
    host.appendChild(node);

    requestAnimationFrame(() => node.classList.add('is-in'));
    setTimeout(() => {
      node.classList.add('is-out');
      setTimeout(() => node.remove(), 400);
    }, 1600);
  }

  /* ------------------------------------------------------------------ *
   * 跑步机
   * ------------------------------------------------------------------ */
  /**
   * 站在跑步机上时的提示。
   *
   * 服务端权威:没买时长的玩家可以站上去,但拿不到加成。
   * 这里只做提示,不参与任何判定。
   */
  applyTreadmillAt(context) {
    const signature = context ? `${context.id}:${context.active}` : '';
    if (signature === this.lastTreadmillSignature) return;
    this.lastTreadmillSignature = signature;

    if (!context) {
      this.hideTreadmillPrompt();
      return;
    }
    if (context.active) {
      this.showTreadmillPrompt(
        `${context.name} active`,
        `${formatRemaining(Math.max(0, context.untilMs - Date.now()))} of ${context.bonus}\u00d7 speed left`,
        null,
      );
      return;
    }
    this.showTreadmillPrompt(
      `${context.name} is locked`,
      `Spend ${context.gemPrice} gems for ${formatMinutes(this.sessionMs)} of ${context.bonus}\u00d7 speed. Standing here does nothing until you buy it.`,
      { label: `Buy ${context.gemPrice} gems`, onClick: () => this.handlers.onBuyTreadmill(context.id) },
    );
  }

  showTreadmillPrompt(title, body, action) {
    if (!this.el.treadmillPrompt) return;
    this.el.treadmillPrompt.hidden = false;
    this.el.treadmillPromptTitle.textContent = title;
    this.el.treadmillPromptBody.textContent = body;

    const btn = this.el.treadmillPromptBuy;
    if (!action) {
      btn.hidden = true;
      return;
    }
    btn.hidden = false;
    btn.textContent = action.label;
    btn.onclick = action.onClick;
  }

  hideTreadmillPrompt() {
    if (this.el.treadmillPrompt) this.el.treadmillPrompt.hidden = true;
  }

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
      btn.textContent = isActive ? `+${formatMinutes(this.sessionMs)}` : 'Buy';
      btn.title = `Costs ${machine.gemPrice} gems for ${formatMinutes(this.sessionMs)}`;
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
    if (this.el.railPetsBadge) {
      this.el.railPetsBadge.textContent = String(this.pets.length);
      this.el.railPetsBadge.hidden = this.pets.length === 0;
    }
    if (!this.el.bagPanel.hidden) this.renderBag();
  }

  /** 旧接口保留:内部转发到统一的抽屉逻辑 */
  toggleBag(force) {
    if (force === false) this.el.bagPanel.hidden = true;
    else this.toggleDrawer('bag-panel');
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
    this.renderRooms();
    // 如果当前房间被删了(房主删房),服务端会推 room_closed,
    // 但房间列表也可能先到,这里兜底同步一次。
    if (this.currentRoom && !this.rooms.some((r) => r.id === this.currentRoom)) {
      // 列表里已经没有自己所在的房间,等 room_closed 处理
    }
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

      const owner = document.createElement('span');
      owner.className = 'room-row-owner';
      owner.textContent = room.isPublic ? 'public' : room.creator || '—';

      const count = document.createElement('span');
      count.className = 'room-row-count';
      count.textContent = `${room.players}/${room.capacity}`;

      row.append(name, owner, count);

      // 只有自己创建、非公共、非当前房间才显示删除按钮。
      // 这只是 UI 拦截,真正的权限校验在服务端。
      const canDelete =
        !room.isPublic &&
        room.createdByUid &&
        room.createdByUid === this.selfUid &&
        room.id !== this.currentRoom;

      if (canDelete) {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'room-del';
        del.textContent = 'Delete';
        del.addEventListener('click', (event) => {
          event.stopPropagation();
          this.confirm(
            'Delete this room?',
            `Room "${room.id}" will close and everyone inside will be sent to the public lobby.`,
            () => this.handlers.onDeleteRoom(room.id),
          );
        });
        row.appendChild(del);
      }

      row.addEventListener('click', () => {
        this.handlers.onJoinRoom(room.id);
        this.toggleRoomPanel(false);
      });
      this.el.roomList.appendChild(row);
    }

    if (this.rooms.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'panel-value';
      empty.textContent = 'No rooms';
      this.el.roomList.appendChild(empty);
    }
  }

  /* ------------------------------------------------------------------ *
   * 通用确认弹窗
   * ------------------------------------------------------------------ */

  /**
   * @param {string} title
   * @param {string} body
   * @param {() => void} onConfirm
   */
  confirm(title, body, onConfirm) {
    const backdrop = document.getElementById('confirm-modal');
    const titleEl = document.getElementById('confirm-title');
    const bodyEl = document.getElementById('confirm-body');
    const okBtn = document.getElementById('confirm-ok');
    const cancelBtn = document.getElementById('confirm-cancel');

    titleEl.textContent = title;
    bodyEl.textContent = body;
    backdrop.hidden = false;
    okBtn.focus();

    const cleanup = () => {
      backdrop.hidden = true;
      okBtn.removeEventListener('click', handleOk);
      cancelBtn.removeEventListener('click', handleCancel);
      backdrop.removeEventListener('click', handleBackdrop);
      document.removeEventListener('keydown', handleKey);
    };
    const handleOk = () => {
      cleanup();
      onConfirm();
    };
    const handleCancel = () => cleanup();
    const handleBackdrop = (event) => {
      if (event.target === backdrop) cleanup();
    };
    const handleKey = (event) => {
      if (event.key === 'Escape') cleanup();
    };

    okBtn.addEventListener('click', handleOk);
    cancelBtn.addEventListener('click', handleCancel);
    backdrop.addEventListener('click', handleBackdrop);
    document.addEventListener('keydown', handleKey);
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

/** 时长文案:整分钟就写 "10 minutes",否则保留一位小数 */
function formatMinutes(ms) {
  const minutes = ms / 60000;
  if (Number.isInteger(minutes)) return `${minutes} minutes`;
  return `${minutes.toFixed(1)} minutes`;
}
