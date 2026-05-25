// freeze-detector.js — детектор подвисания удалённого видео.
//
// Опирается на монотонно растущий счётчик inboundVideoFramesReceived.
// Если значение не растёт в течение thresholdMs, считаем видео «зафризившимся».
// Состояние выходит в callback (onFreezeChange) только при смене (true ↔ false).

export class FreezeDetector {
  /**
   * @param {{ thresholdMs?: number, onFreezeChange?: (frozen: boolean) => void }} [opts]
   */
  constructor(opts = {}) {
    this.thresholdMs = opts.thresholdMs ?? 3000;
    this.onFreezeChange = opts.onFreezeChange || (() => {});
    this.lastFrames = null;
    this.lastGrowAt = performance.now();
    this.frozen = false;
  }

  reset() {
    this.lastFrames = null;
    this.lastGrowAt = performance.now();
    this._setFrozen(false);
  }

  observe(stats) {
    const f = stats?.inboundVideoFramesReceived;
    if (f == null) return;
    const now = performance.now();
    if (this.lastFrames == null) {
      this.lastFrames = f;
      this.lastGrowAt = now;
      return;
    }
    if (f > this.lastFrames) {
      this.lastFrames = f;
      this.lastGrowAt = now;
      this._setFrozen(false);
      return;
    }
    if (now - this.lastGrowAt > this.thresholdMs) {
      this._setFrozen(true);
    }
  }

  _setFrozen(v) {
    if (this.frozen === v) return;
    this.frozen = v;
    this.onFreezeChange(v);
  }
}
