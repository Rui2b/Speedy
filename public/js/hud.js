/**
 * HUD:宝石数、在线人数、延迟、宠物进度、提示与连接状态。
 * 纯 DOM 操作,和渲染循环解耦。
 */
export class Hud {
  constructor() {
    this.el = {
      hud: document.getElementById('hud'),
      gems: document.getElementById('hud-gems'),
      online: document.getElementById('hud-online'),
      ping: document.getElementById('hud-ping'),
      fps: document.getElementById('hud-fps'),
      pets: document.getElementById('hud-pets'),
      toast: document.getElementById('toast'),
      banner: document.getElementById('conn-banner'),
      hints: document.getElementById('controls-hint'),
    };
    this.toastTimer = null;
    this.lastPetsKey = '';
  }

  showGameUi() {
    for (const key of ['hud', 'hints']) {
      if (this.el[key]) this.el[key].hidden = false;
    }
  }

  hideGameUi() {
    for (const key of ['hud', 'hints']) {
      if (this.el[key]) this.el[key].hidden = true;
    }
  }

  setGems(value) {
    if (this.el.gems) this.el.gems.textContent = String(value);
  }

  setOnline(value) {
    if (this.el.online) this.el.online.textContent = String(value);
  }

  setPing(ms) {
    if (!this.el.ping) return;
    if (ms === null || !Number.isFinite(ms)) {
      this.el.ping.textContent = '--';
      return;
    }
    this.el.ping.textContent = String(Math.round(ms));
  }

  setFps(fps) {
    if (!this.el.fps) return;
    this.el.fps.textContent = String(Math.round(fps));
  }

  /** 渲染宠物列表,只在内容变化时重建 DOM。 */
  setPets(pets, cooldowns = new Map()) {
    if (!this.el.pets) return;
    const list = Array.isArray(pets) ? pets : [];
    const key = list.map((p) => `${p.petId}:${p.hatchProgress}:${p.isHatched}`).join('|');
    if (key === this.lastPetsKey) {
      this.updateCooldownBadges(cooldowns);
      return;
    }
    this.lastPetsKey = key;

    this.el.pets.replaceChildren();
    for (const pet of list) {
      const chip = document.createElement('div');
      chip.className = `pet-chip${pet.isHatched ? ' hatched' : ''}`;
      chip.dataset.petId = pet.petId;

      const dot = document.createElement('span');
      dot.className = 'pet-dot';
      const label = document.createElement('span');
      label.textContent = pet.isHatched ? '已孵化' : '孵化中';
      const progress = document.createElement('span');
      progress.className = 'pet-progress';
      progress.textContent = `${Math.round(pet.hatchProgress)}%`;

      chip.append(dot, label, progress);
      this.el.pets.appendChild(chip);
    }
    this.updateCooldownBadges(cooldowns);
  }

  updateCooldownBadges(cooldowns) {
    if (!this.el.pets) return;
    const now = Date.now();
    for (const chip of this.el.pets.children) {
      const petId = chip.dataset.petId;
      const until = cooldowns.get(petId) ?? 0;
      const remaining = Math.max(0, until - now);
      chip.style.opacity = remaining > 0 ? '0.55' : '1';
      const progress = chip.querySelector('.pet-progress');
      if (!progress) continue;
      const base = progress.dataset.base ?? progress.textContent.replace(/ \(\d+s\)$/, '');
      progress.dataset.base = base;
      progress.textContent = remaining > 0 ? `${base} (${Math.ceil(remaining / 1000)}s)` : base;
    }
  }

  toast(message, kind = '') {
    if (!this.el.toast) return;
    this.el.toast.textContent = message;
    this.el.toast.className = `toast show${kind ? ` ${kind}` : ''}`;
    this.el.toast.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.el.toast.classList.remove('show');
      this.toastTimer = setTimeout(() => {
        this.el.toast.hidden = true;
      }, 240);
    }, 1600);
  }

  setConnectionBanner(text) {
    if (!this.el.banner) return;
    if (!text) {
      this.el.banner.hidden = true;
      this.el.banner.textContent = '';
      return;
    }
    this.el.banner.textContent = text;
    this.el.banner.hidden = false;
  }
}
