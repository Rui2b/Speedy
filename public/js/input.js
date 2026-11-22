/**
 * Input capture: WASD plus Space.
 *
 * This only turns key state into moveX / moveZ / jump. Where the player
 * actually ends up is decided by the server; nothing here simulates physics.
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
      // Stop the page from scrolling
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
   * Input snapshot for this frame.
   *
   * The camera looks down from +Z, so "forward on screen" is -Z.
   * W maps to moveZ = -1, matching the server's integration direction.
   *
   * jump is a pending flag, cleared by the network layer once a packet is
   * actually sent. Clearing it here would swallow the jump, because frames
   * run at 60fps and inputs only leave at 20Hz.
   */
  sample() {
    const forward =
      (this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : 0) -
      (this.keys.has('KeyS') || this.keys.has('ArrowDown') ? 1 : 0);
    const strafe =
      (this.keys.has('KeyD') || this.keys.has('ArrowRight') ? 1 : 0) -
      (this.keys.has('KeyA') || this.keys.has('ArrowLeft') ? 1 : 0);

    return { moveX: strafe, moveZ: -forward, jump: this.jumpPending };
  }

  /** Called by the network layer once the jump has been sent. */
  consumeJump() {
    this.jumpPending = false;
  }
}

function isMoveKey(code) {
  return (
    code === 'KeyW' ||
    code === 'KeyA' ||
    code === 'KeyS' ||
    code === 'KeyD' ||
    code === 'ArrowUp' ||
    code === 'ArrowDown' ||
    code === 'ArrowLeft' ||
    code === 'ArrowRight'
  );
}
