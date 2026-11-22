/**
 * Network layer: one long lived WebSocket.
 *
 *   - A single connection per page load. Reconnects reuse the same client
 *     instead of reloading the page.
 *   - Inputs leave at 20Hz, dropping to 5Hz while the tab is hidden.
 *   - Heartbeat in both directions.
 *   - Automatic reconnect, at most 5 attempts, one second apart.
 */

export const TICK = {
  activeHz: 20,
  backgroundHz: 5,
  heartbeatMs: 3000,
  maxReconnectAttempts: 5,
  reconnectDelayMs: 1000,
};

const INPUT_INTERVAL_ACTIVE = 1000 / TICK.activeHz;
const INPUT_INTERVAL_BACKGROUND = 1000 / TICK.backgroundHz;

export class NetClient {
  /**
   * @param {object} options
   * @param {(msg: object) => void} options.onMessage
   * @param {(state: string, info?: object) => void} options.onStateChange
   * @param {() => string|null} options.getToken session token for the URL
   * @param {() => void} [options.onJumpSent] fires once a jump has been sent
   */
  constructor({ onMessage, onStateChange, getToken, onJumpSent }) {
    this.onMessage = onMessage;
    this.onStateChange = onStateChange;
    this.getToken = getToken;
    this.onJumpSent = onJumpSent;

    this.ws = null;
    this.state = 'idle'; // idle | connecting | open | reconnecting | closed
    this.seq = 0;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.inputTimer = null;
    this.heartbeatTimer = null;
    this.lastPongAt = 0;
    this.rttMs = null;
    this.closedByUser = false;

    /** Current input, updated by the input layer */
    this.input = { moveX: 0, moveZ: 0, jump: false };
    /** Last authoritative position, sent back only for comparison */
    this.previewPos = { x: 0, y: 0, z: 0 };
    this.skinId = 'classic';

    this.backgroundMode = false;
    this._boundVisibility = () => this.handleVisibility();
    document.addEventListener('visibilitychange', this._boundVisibility);
  }

  /* ------------------------------------------------------------------ *
   * Connection
   * ------------------------------------------------------------------ */
  connect() {
    if (this.state === 'open' || this.state === 'connecting') return;
    this.closedByUser = false;
    this.openSocket();
  }

  openSocket() {
    const token = this.getToken();
    if (!token) {
      this.setState('closed', { reason: 'no_token' });
      return;
    }

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // The token travels as a query parameter so the connection works through
    // the Cloudflare Worker proxy without relying on cookies.
    const url = `${proto}//${location.host}/ws?token=${encodeURIComponent(token)}`;

    this.setState(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');

    let ws;
    try {
      ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect('construct_failed');
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.reconnectAttempts = 0;
      this.lastPongAt = Date.now();
      this.setState('open');
      this.startInputLoop();
      this.startHeartbeat();
    });

    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === 'ping') {
        this.send({ type: 'pong', t: msg.t });
        return;
      }
      if (msg.type === 'pong') {
        this.lastPongAt = Date.now();
        // t is our own timestamp echoed back, so the difference is real RTT
        if (typeof msg.t === 'number' && msg.t > 0 && msg.t <= Date.now()) {
          this.rttMs = Math.max(0, Date.now() - msg.t);
        }
        return;
      }
      this.onMessage(msg);
    });

    ws.addEventListener('close', (event) => {
      this.stopInputLoop();
      this.stopHeartbeat();
      this.ws = null;
      if (this.closedByUser) {
        this.setState('closed', { reason: 'user' });
        return;
      }
      // 4000 to 4999 are deliberate server decisions. Do not retry those.
      if (event.code >= 4000 && event.code < 5000) {
        this.setState('closed', { reason: `server_${event.code}` });
        return;
      }
      this.scheduleReconnect(`close_${event.code}`);
    });

    ws.addEventListener('error', () => {
      // The close event follows, so nothing to do here
    });
  }

  scheduleReconnect(reason) {
    if (this.closedByUser) return;
    if (this.reconnectAttempts >= TICK.maxReconnectAttempts) {
      this.setState('closed', { reason: 'reconnect_exhausted', detail: reason });
      return;
    }
    this.reconnectAttempts += 1;
    this.setState('reconnecting', {
      attempt: this.reconnectAttempts,
      max: TICK.maxReconnectAttempts,
      reason,
    });
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.openSocket(), TICK.reconnectDelayMs);
  }

  disconnect() {
    this.closedByUser = true;
    clearTimeout(this.reconnectTimer);
    this.stopInputLoop();
    this.stopHeartbeat();
    if (this.ws) {
      try {
        this.ws.close(1000, 'client_leave');
      } catch {
        /* already closing */
      }
      this.ws = null;
    }
    this.setState('closed', { reason: 'user' });
  }

  setState(state, info) {
    this.state = state;
    this.onStateChange?.(state, info);
  }

  /* ------------------------------------------------------------------ *
   * Input reporting
   * ------------------------------------------------------------------ */
  setInput(partial) {
    Object.assign(this.input, partial);
  }

  /** Written back by the renderer; only used for the comparison field. */
  setPreviewPosition(pos) {
    this.previewPos.x = pos.x;
    this.previewPos.y = pos.y;
    this.previewPos.z = pos.z;
  }

  startInputLoop() {
    this.stopInputLoop();
    const interval = this.backgroundMode ? INPUT_INTERVAL_BACKGROUND : INPUT_INTERVAL_ACTIVE;
    this.inputTimer = setInterval(() => this.sendInput(), interval);
  }

  stopInputLoop() {
    clearInterval(this.inputTimer);
    this.inputTimer = null;
  }

  handleVisibility() {
    const hidden = document.visibilityState === 'hidden';
    if (hidden === this.backgroundMode) return;
    this.backgroundMode = hidden;
    if (this.state === 'open') {
      // Hidden tab reports at 5Hz, visible again at 20Hz. Connection stays up.
      this.startInputLoop();
    }
  }

  sendInput() {
    if (this.state !== 'open') return;
    this.seq += 1;
    const hadJump = this.input.jump === true;
    this.send({
      type: 'player_input',
      seq: this.seq,
      input: {
        moveX: round4(this.input.moveX),
        moveZ: round4(this.input.moveZ),
        jump: hadJump,
      },
      // Compared against the authoritative position, never trusted
      clientPreviewPos: {
        x: round4(this.previewPos.x),
        y: round4(this.previewPos.y),
        z: round4(this.previewPos.z),
      },
      skinId: this.skinId,
    });
    // A jump is a one shot: clear it after sending so holding Space does not
    // produce a second jump, and clear it only once it really went out.
    if (hadJump) {
      this.input.jump = false;
      this.onJumpSent?.();
    }
  }

  /* ------------------------------------------------------------------ *
   * Heartbeat
   * ------------------------------------------------------------------ */
  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.state !== 'open') return;
      // The server drops a connection after 10s of silence; 3s is plenty
      this.send({ type: 'ping', t: Date.now() });
    }, TICK.heartbeatMs);
  }

  stopHeartbeat() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  /* ------------------------------------------------------------------ *
   * Sending
   * ------------------------------------------------------------------ */
  send(payload) {
    if (this.state !== 'open' || !this.ws) return false;
    if (this.ws.readyState !== WebSocket.OPEN) return false;
    if (this.ws.bufferedAmount > 256 * 1024) return false;
    try {
      this.ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  /** Action requests, fired by events rather than every frame. */
  tryPickGem(gemId) {
    return this.send({ type: 'try_pick_gem', gemId });
  }

  tryStealPet(petId) {
    return this.send({ type: 'try_steal_pet', petId });
  }

  tryHatchPet(petId) {
    return this.send({ type: 'try_hatch_pet', petId });
  }

  dispose() {
    document.removeEventListener('visibilitychange', this._boundVisibility);
    this.disconnect();
  }
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}
