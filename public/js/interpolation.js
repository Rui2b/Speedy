/**
 * 位置插值与本地预测平滑。
 *
 * 服务器只发 10Hz 快照,直接渲染会卡顿。这里做两件事:
 *   1. 对远端玩家做"快照缓冲 + 线性插值",渲染时间轴永远落后服务器约 130ms,
 *      因此总有前后两帧可以做插值。
 *   2. 对本地玩家做"预测 + 收敛":移动手感即时,但每帧向服务器权威坐标收敛,
 *      收敛速率足够快时作弊客户端也无法真正跑偏。
 */

/** 渲染延迟:故意落后服务器,给插值留缓冲。 */
export const INTERPOLATION_DELAY_MS = 130;

export class SnapshotBuffer {
  constructor(maxSamples = 12) {
    this.samples = [];
    this.maxSamples = maxSamples;
  }

  push(sample) {
    this.samples.push(sample);
    if (this.samples.length > this.maxSamples) this.samples.shift();
  }

  clear() {
    this.samples.length = 0;
  }

  get latest() {
    return this.samples[this.samples.length - 1] ?? null;
  }

  /**
   * 取渲染时间点对应的一对样本(前/后)。
   * @param {number} renderTime 渲染时间(用 performance.now() 的同一时基)
   */
  bracket(renderTime) {
    const samples = this.samples;
    if (samples.length === 0) return null;
    if (samples.length === 1) return { a: samples[0], b: samples[0], t: 0 };

    // 样本按时间升序;找到第一个 >= renderTime 的
    let lo = 0;
    let hi = samples.length - 1;
    if (renderTime <= samples[0].at) return { a: samples[0], b: samples[0], t: 0 };
    if (renderTime >= samples[hi].at) {
      const a = samples[hi - 1];
      const b = samples[hi];
      return { a, b, t: 1 };
    }

    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (samples[mid].at <= renderTime) lo = mid;
      else hi = mid;
    }

    const a = samples[lo];
    const b = samples[hi];
    const span = b.at - a.at;
    const t = span > 0 ? (renderTime - a.at) / span : 0;
    return { a, b, t: Math.max(0, Math.min(1, t)) };
  }
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** 角度插值:走最短路径,避免转身时绕远 */
export function lerpAngle(a, b, t) {
  let diff = b - a;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

/**
 * 指数收敛系数。
 * 每帧向目标靠近的比例,与帧率无关:rate 越大跟得越紧。
 */
export function convergeFactor(ratePerSecond, dtSeconds) {
  return 1 - Math.exp(-ratePerSecond * dtSeconds);
}
