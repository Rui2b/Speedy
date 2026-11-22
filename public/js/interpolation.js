/**
 * Position interpolation and local prediction smoothing.
 *
 * The server sends snapshots at 10Hz, which stutters if rendered directly.
 * Two things happen here:
 *   1. Remote players get a snapshot buffer plus linear interpolation. The
 *      render timeline trails the server by about 130ms, so there is always a
 *      pair of samples to interpolate between.
 *   2. The local player predicts immediately for responsive controls and
 *      converges to the authoritative position every frame. Converging fast
 *      enough means a cheating client still cannot drift.
 */

/** Deliberate render lag, giving the buffer room to interpolate. */
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
   * The pair of samples surrounding a render time.
   * @param {number} renderTime same time base as performance.now()
   */
  bracket(renderTime) {
    const samples = this.samples;
    if (samples.length === 0) return null;
    if (samples.length === 1) return { a: samples[0], b: samples[0], t: 0 };

    const hi0 = samples.length - 1;
    if (renderTime <= samples[0].at) return { a: samples[0], b: samples[0], t: 0 };
    if (renderTime >= samples[hi0].at) {
      return { a: samples[hi0 - 1], b: samples[hi0], t: 1 };
    }

    let lo = 0;
    let hi = hi0;
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

/** Shortest-path angle interpolation, so turns never take the long way. */
export function lerpAngle(a, b, t) {
  let diff = b - a;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

/**
 * Exponential convergence factor, independent of frame rate.
 * Higher rates track the target more tightly.
 */
export function convergeFactor(ratePerSecond, dtSeconds) {
  return 1 - Math.exp(-ratePerSecond * dtSeconds);
}
