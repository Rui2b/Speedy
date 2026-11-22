/**
 * 网络层:WebSocket 长连接。
 *
 * 严格按方案:
 *   - 页面生命周期内只建立一次连接(重连复用同一个实例,不刷新页面)
 *   - 20Hz 上报输入(切标签页降到 5Hz)
 *   - 双向心跳
 *   - 断线自动重连,最多 5 次,间隔 1s
 */

/** 上报频率配置 */
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
   * @param {() => string|null} options.getToken 取 session token(用于 URL 参数)
   * @param {() => void} [options.onJumpSent] 跳跃指令真正发出后回调,用于清掉待发送标记
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

    /** 当前输入状态,由输入层更新 */
    this.input = { moveX: 0, moveZ: 0, jump: false };
    /** 服务器最近一次下发的权威坐标,用于"仅对比校验"上报 */
    this.previewPos = { x: 0, y: 0, z: 0 };
    this.skinId = 'classic';

    this.backgroundMode = false;
    this._boundVisibility = () => this.handleVisibility();
    document.addEventListener('visibilitychange', this._boundVisibility);
  }

  /* ------------------------------------------------------------------ *
   * 连接
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
    // token 走 query 参数:可以穿过 Cloudflare Worker 代理,无需依赖 cookie
    const url = `${proto}//${location.host}/ws?token=${encodeURIComponent(token)}`;

    this.setState(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');

    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
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
        if (typeof msg.t === 'number') {
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
      // 4001/4002/4003/4004 是服务端主动判定:不允许重连
      if (event.code >= 4000 && event.code < 5000) {
        this.setState('closed', { reason: `server_${event.code}` });
        return;
      }
      this.scheduleReconnect(`close_${event.code}`);
    });

    ws.addEventListener('error', () => {
      // close 事件会跟着触发,这里不重复处理
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
        /* 忽略 */
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
   * 输入上报
   * ------------------------------------------------------------------ */
  setInput(partial) {
    Object.assign(this.input, partial);
  }

  /** 由渲染层把服务器权威坐标写回来,仅用于下一次上报的对比字段 */
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
      // 切标签页:上报频率降级到 5Hz;切回来恢复 20Hz。连接不断开。
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
      // 仅用于服务器对比校验;服务器从不采信这个坐标
      clientPreviewPos: {
        x: round4(this.previewPos.x),
        y: round4(this.previewPos.y),
        z: round4(this.previewPos.z),
      },
      skinId: this.skinId,
    });
    // jump 是"一次性"动作:发出后清除,避免持续按住造成连跳;
    // 但只在真的发出后才清,防止 60fps 采样把跳跃吞掉
    if (hadJump) {
      this.input.jump = false;
      this.onJumpSent?.();
    }
  }

  /* ------------------------------------------------------------------ *
   * 心跳
   * ------------------------------------------------------------------ */
  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.state !== 'open') return;
      // 服务器 10 秒收不到 pong 会断开;这里 3 秒发一次 ping 足够
      this.send({ type: 'ping', t: Date.now() });
    }, TICK.heartbeatMs);
  }

  stopHeartbeat() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  /* ------------------------------------------------------------------ *
   * 发送
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

  /** 操作请求(事件触发,不每帧) */
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
