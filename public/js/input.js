/**
 * 输入采集:WASD + 空格。
 *
 * 只负责把按键状态翻译成 moveX/moveZ/jump。
 * 具体"玩家跑到哪"由服务器决定,这里绝不计算物理。
 */
export class InputController {
  constructor() {
    this.keys = new Set();
    this.jumpPending = false;
    this.enabled = false;

    this._onKeyDown = (event) => this.handleKeyDown(event);
    this._onKeyUp = (event) => this.handleKeyUp(event);
    this._onBlur = () => this.reset();

    window.addEventListener('keydown', this._onKeyDown, { passive: false });
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled) this.reset();
  }

  handleKeyDown(event) {
    if (!this.enabled) return;
    const code = event.code;

    if (code === 'Space') {
      // 阻止页面滚动
      event.preventDefault();
      if (!event.repeat) this.jumpPending = true;
      return;
    }
    if (isMoveKey(code)) {
      event.preventDefault();
      this.keys.add(code);
    }
  }

  handleKeyUp(event) {
    if (isMoveKey(event.code)) this.keys.delete(event.code);
  }

  reset() {
    this.keys.clear();
    this.jumpPending = false;
  }

  /**
   * 返回本帧的输入快照。
   * 世界坐标约定:相机在 +Z 方向俯视,所以"屏幕前方"= -Z。
   * W 键 → moveZ = -1,与服务器积分方向一致。
   *
   * 注意:jump 是"待发送"标记,由网络层在真正发包后清除。
   * 这里不能清,否则 60fps 的采样会把一次跳跃在两次发包之间吞掉。
   */
  sample() {
    const forward = (this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : 0)
      - (this.keys.has('KeyS') || this.keys.has('ArrowDown') ? 1 : 0);
    const strafe = (this.keys.has('KeyD') || this.keys.has('ArrowRight') ? 1 : 0)
      - (this.keys.has('KeyA') || this.keys.has('ArrowLeft') ? 1 : 0);

    return { moveX: strafe, moveZ: -forward, jump: this.jumpPending };
  }

  /** 网络层确认跳跃已发出后调用 */
  consumeJump() {
    this.jumpPending = false;
  }
}

function isMoveKey(code) {
  return (
    code === 'KeyW' || code === 'KeyA' || code === 'KeyS' || code === 'KeyD' ||
    code === 'ArrowUp' || code === 'ArrowDown' || code === 'ArrowLeft' || code === 'ArrowRight'
  );
}
