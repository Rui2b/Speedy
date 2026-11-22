/**
 * Cloudflare Turnstile 前端封装。
 *
 * 流程:
 *   1. 从 /api/config 取 site key(全部来自环境变量,不写死在前端)
 *   2. 用官方脚本的 explicit 模式挂载 widget
 *   3. 拿到 token 后放进注册 / 登录请求体
 *
 * token 是一次性的,服务端校验过就作废,所以每次提交后要 reset。
 * 另外 token 最长 5 分钟有效,widget 自己会处理过期回调。
 */

const SCRIPT_LOAD_TIMEOUT_MS = 12000;

/** 等待官方脚本就绪。脚本用 async defer 加载,可能比主流程慢。 */
function waitForTurnstileApi(timeoutMs = SCRIPT_LOAD_TIMEOUT_MS) {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (window.turnstile) {
        clearInterval(timer);
        resolve(window.turnstile);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('turnstile_script_timeout'));
      }
    }, 100);
  });
}

export class TurnstileGate {
  /**
   * @param {object} options
   * @param {HTMLElement} options.slot 外层容器(用于显示/隐藏)
   * @param {HTMLElement} options.container widget 挂载点
   * @param {HTMLElement} options.note 出错提示
   * @param {(message: string) => void} options.onError
   */
  constructor({ slot, container, note, onError }) {
    this.slot = slot;
    this.container = container;
    this.note = note;
    this.onError = onError;

    /** null 表示还没解析出来;false 表示服务端未启用 */
    this.enabled = null;
    this.siteKey = null;
    this.widgetId = null;
    this.token = null;
    /** 每次 reset 递增,用来丢弃上一轮的回调 */
    this.generation = 0;
  }

  /**
   * 读取服务端配置并挂载 widget。
   * @returns {Promise<boolean>} 是否启用
   */
  async init() {
    let config;
    try {
      const res = await fetch('/api/config', { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`config_${res.status}`);
      config = await res.json();
    } catch {
      this.fail('Could not load the verification settings.');
      this.enabled = false;
      return false;
    }

    const t = config?.turnstile;
    if (!t?.enabled || !t.siteKey) {
      // 服务端明确表示未启用(本地开发)。不显示 widget,也不用带 token。
      this.enabled = false;
      return false;
    }

    this.enabled = true;
    this.siteKey = t.siteKey;
    this.slot.hidden = false;

    try {
      const api = await waitForTurnstileApi();
      const generation = this.generation;
      this.widgetId = api.render(this.container, {
        sitekey: this.siteKey,
        theme: 'dark',
        size: 'flexible',
        callback: (token) => {
          if (generation !== this.generation) return;
          this.token = token;
        },
        'error-callback': () => {
          if (generation !== this.generation) return;
          this.token = null;
          this.onError?.('Verification failed. Try again.');
        },
        'expired-callback': () => {
          if (generation !== this.generation) return;
          this.token = null;
        },
      });
      return true;
    } catch {
      this.fail('Verification is unavailable. Reload the page, or check your connection.');
      return false;
    }
  }

  fail(message) {
    this.note.textContent = message;
    this.note.hidden = false;
    this.onError?.(message);
  }

  /**
   * 取当前 token。没有 token 时返回 null —— 调用方应当中止提交。
   * 服务端未启用 Turnstile 时返回空字符串,表示"无需校验"。
   */
  takeToken() {
    if (this.enabled === false) return '';
    return this.token ?? null;
  }

  /**
   * 提交结束后必须重置:Turnstile 的 token 一次性有效。
   *
   * reset(true) 用于校验失败后强制拿一个新挑战。单纯 reset 只是清空 token 并
   * 让 widget 重新挑战,回调仍然有效;但一旦失败过,旧的 token 已经作废,
   * 必须用新的 generation 重建 widget,否则回调会被丢弃、永远拿不到 token。
   */
  reset(force = false) {
    this.token = null;
    if (!this.enabled || this.widgetId === null) return;
    try {
      if (force) {
        this.remount();
      } else {
        window.turnstile?.reset(this.widgetId);
      }
    } catch {
      /* widget 可能已被移除 */
    }
  }

  /** 拆掉旧的 widget 再挂一个新的,拿到全新的挑战与回调。 */
  remount() {
    const api = window.turnstile;
    if (!api) return;

    this.generation += 1;
    const generation = this.generation;

    try {
      if (this.widgetId !== null) api.remove(this.widgetId);
    } catch {
      /* 已移除 */
    }
    this.widgetId = null;
    // 有些版本的 remove() 不会清空容器,保险起见自己清一遍
    this.container.replaceChildren();

    this.widgetId = api.render(this.container, {
      sitekey: this.siteKey,
      theme: 'dark',
      size: 'flexible',
      callback: (token) => {
        if (generation !== this.generation) return;
        this.token = token;
      },
      'error-callback': () => {
        if (generation !== this.generation) return;
        this.token = null;
        this.onError?.('Verification failed. Try again.');
      },
      'expired-callback': () => {
        if (generation !== this.generation) return;
        this.token = null;
      },
    });
  }
}
