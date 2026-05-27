// recovery.js — RecoveryManager: автоматическое восстановление WebRTC-соединения
// через механизм ICE restart при разрывах или «зависании» канала.
//
// Триггеры для запуска восстановления:
//   1. pc.iceConnectionState === 'failed' — немедленно.
//   2. pc.iceConnectionState === 'disconnected' длится > disconnectTimeoutMs.
//   3. pc.connectionState === 'connected', но inboundVideoBytesReceived
//      не растёт > stuckTimeoutMs (явное «зависание» при формально активной
//      связи).
//
// Сам ICE restart инициирует только caller — он формирует новый offer с
// флагом iceRestart: true. Callee, если детектирует разрыв, отправляет
// caller через сигналинг сообщение { type: 'restart-request' }.
//
// Все side-effects (отправка SDP/сообщений, обновление UI) делаются через
// callbacks, переданные в конструктор, — этим RecoveryManager остаётся
// тестируемым и не привязан к DOM.

export class RecoveryManager {
  /**
   * @param {RTCPeerConnection} pc
   * @param {object} callbacks
   * @param {() => string} callbacks.getRole           — 'caller' | 'callee'
   * @param {() => Promise<void>} callbacks.sendRestartOffer    — caller-only
   * @param {() => void} callbacks.sendRestartRequest           — callee-only
   * @param {(reason: string, attempt: number) => void} callbacks.onRecoveryStart
   * @param {() => void} callbacks.onRecoverySuccess
   * @param {() => void} callbacks.onRecoveryFail
   * @param {object} [opts]
   */
  constructor(pc, callbacks, opts = {}) {
    this.pc = pc;
    this.cb = callbacks;
    this.disconnectTimeoutMs = opts.disconnectTimeoutMs ?? 3000;
    this.stuckTimeoutMs      = opts.stuckTimeoutMs      ?? 8000;
    this.attemptTimeoutMs    = opts.attemptTimeoutMs    ?? 10000;
    this.minAttemptIntervalMs = opts.minAttemptIntervalMs ?? 2000;
    this.maxAttempts = opts.maxAttempts ?? 3;

    this.attempts = 0;
    this.recovering = false;
    this.disconnectedSince = null;
    this.lastBytesReceived = 0;
    this.lastBytesGrowAt = performance.now();
    // -Infinity означает «попыток ещё не было». Это эквивалентно тому,
    // что minAttemptIntervalMs давно прошёл, и первое срабатывание не
    // подавляется проверкой интервала (актуально для тестов и для
    // короткоживущих сессий, в которых разрыв случается рано).
    this.lastAttemptAt = -Infinity;
    this.giveUp = false;
  }

  reset() {
    this.attempts = 0;
    this.recovering = false;
    this.disconnectedSince = null;
    this.lastBytesReceived = 0;
    this.lastBytesGrowAt = performance.now();
    this.lastAttemptAt = -Infinity;
    this.giveUp = false;
  }

  observe(stats) {
    if (!this.pc || this.recovering || this.giveUp) return;

    const now = performance.now();
    const bytes = stats?.inboundVideoBytesReceived ?? 0;
    if (bytes > this.lastBytesReceived) {
      this.lastBytesReceived = bytes;
      this.lastBytesGrowAt = now;
    }

    const ice = this.pc.iceConnectionState;
    const conn = this.pc.connectionState;

    // Если связь стабильна — обнуляем счётчик попыток. Иначе после первой
    // удачи (ICE сам восстановился) мы бы накопили attempts и при следующей
    // проблеме могли уйти в giveUp слишком рано.
    const isHealthy = (ice === 'connected' || ice === 'completed') && conn === 'connected';
    if (isHealthy && this.attempts > 0) {
      this.attempts = 0;
    }

    // failed → немедленно
    if (ice === 'failed') {
      this._trigger('iceConnectionState=failed');
      return;
    }

    // disconnected → ждём подтверждения через timeout
    if (ice === 'disconnected') {
      if (this.disconnectedSince == null) this.disconnectedSince = now;
      if (now - this.disconnectedSince > this.disconnectTimeoutMs) {
        this._trigger(`disconnected for ${this.disconnectTimeoutMs} ms`);
        return;
      }
    } else {
      this.disconnectedSince = null;
    }

    // stuck connection: connected, но видео не растёт
    if (conn === 'connected'
        && this.lastBytesReceived > 0
        && now - this.lastBytesGrowAt > this.stuckTimeoutMs) {
      this._trigger(`no inbound video for ${this.stuckTimeoutMs} ms`);
    }
  }

  /**
   * Вызывается app.js когда состояние снова стабильное —
   * сбрасываем счётчик попыток.
   */
  markStable() {
    if (this.recovering) {
      this.recovering = false;
      this.attempts = 0;
      // giveUp сбрасываем, чтобы при следующей проблеме можно было снова
      // запустить серию попыток (иначе после однократного провала
      // RecoveryManager отключился бы навсегда для текущей сессии).
      this.giveUp = false;
      this.lastBytesGrowAt = performance.now();
      this.cb.onRecoverySuccess?.();
    }
  }

  async _trigger(reason) {
    const now = performance.now();
    if (now - this.lastAttemptAt < this.minAttemptIntervalMs) return;
    if (this.attempts >= this.maxAttempts) {
      this.giveUp = true;
      this.cb.onRecoveryFail?.();
      return;
    }
    this.recovering = true;
    this.attempts++;
    this.lastAttemptAt = now;
    this.cb.onRecoveryStart?.(reason, this.attempts);

    try {
      const role = this.cb.getRole?.() || 'caller';
      if (role === 'caller') {
        await this.cb.sendRestartOffer?.();
      } else {
        this.cb.sendRestartRequest?.();
      }
    } catch (e) {
      console.warn('[recovery] trigger failed', e);
    }

    // через attemptTimeoutMs проверим, восстановилось ли
    setTimeout(() => {
      if (!this.recovering) return;
      const okIce  = this.pc.iceConnectionState === 'connected'
                  || this.pc.iceConnectionState === 'completed';
      const okConn = this.pc.connectionState === 'connected';
      if (okIce && okConn) {
        this.markStable();
      } else {
        this.recovering = false;
        // observe() в следующем тике сам решит — пробовать снова или сдаться
      }
    }, this.attemptTimeoutMs);
  }
}
