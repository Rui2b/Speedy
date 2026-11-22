/**
 * HUD:宝石数、在线人数、延迟、帧率、已拥有的宠物。
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
      controls: document.getElementById('controls-hint'),
    };
    this.toastTimer = null;
    this.hideTimer = null;
    this.lastPetsKey = '';
  }

  showGameUi() {
    this.el.hud.hidden = false;
    this.el.controls.hidden = false;
  }

  hideGameUi() {
    this.el.hud.hidden = true;
    this.el.controls.hidden = true;
    this.el.pets.hidden = true;
  }

  setGems(value) {
    this.el.gems.textContent = String(value);
  }

  setOnline(value) {
    this.el.online.textContent = String(value);
  }

  setPing(ms) {
    if (ms === null || !Number.isFinite(ms)) {
      this.el.ping.textContent = '\u2014';
      return;
    }
    this.el.ping.textContent = String(Math.round(ms));
  }

  setFps(fps) {
    this.el.fps.textContent = String(Math.round(fps));
  }

  /** 只在内容变化时重建宠物列表 DOM。 */
  setPets(pets) {
    const list = Array.isArray(pets) ? pets : [];
    const key = list.map((p) => `${p.petId}:${p.hatchProgress}:${p.isHatched}`).join('|');
    if (key === this.lastPetsKey) return;
    this.lastPetsKey = key;

    this.el.pets.replaceChildren();
    this.el.pets.hidden = list.length === 0;

    for (const pet of list) {
      const row = document.createElement('div');
      row.className = `pet-row${pet.isHatched ? ' is-hatched' : ''}`;
      row.dataset.petId = pet.petId;

      const dot = document.createElement('span');
      dot.className = 'pet-dot';

      const label = document.createElement('span');
      label.textContent = pet.isHatched ? 'Hatched' : 'Hatching';

      const track = document.createElement('span');
      track.className = 'pet-track';
      const fill = document.createElement('span');
      fill.className = 'pet-fill';
      const pct = Math.max(0, Math.min(100, Math.round(pet.hatchProgress)));
      fill.style.width = `${pct}%`;
      track.appendChild(fill);

      const value = document.createElement('span');
      value.className = 'pet-progress';
      value.textContent = `${pct}%`;

      row.append(dot, label, track, value);
      this.el.pets.appendChild(row);
    }
  }

  toast(message, kind = '') {
    clearTimeout(this.toastTimer);
    clearTimeout(this.hideTimer);

    const el = this.el.toast;
    el.textContent = message;
    el.className = `toast is-visible${kind ? ` is-${kind}` : ''}`;
    el.hidden = false;

    this.toastTimer = setTimeout(() => {
      el.classList.remove('is-visible');
      this.hideTimer = setTimeout(() => {
        el.hidden = true;
      }, 180);
    }, 1800);
  }

  setConnectionBanner(text) {
    const el = this.el.banner;
    if (!text) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    el.textContent = text;
    el.hidden = false;
  }
}
