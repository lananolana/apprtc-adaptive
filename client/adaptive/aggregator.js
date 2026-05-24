// aggregator.js — экспоненциальное сглаживание + производные показатели.
//
// Сырые сэмплы из RTCPeerConnection.getStats() шумят и часто содержат
// «нулевые» окна. Аггрегатор сглаживает значения EMA и считает производные:
// процент потерь за окно, агрегатное состояние «качество хуже / лучше».
// Параметры сглаживания — см. отчёт о практике, §2.3.

const EMA_ALPHA = 0.3; // вес текущего сэмпла

function ema(prev, curr, alpha = EMA_ALPHA) {
  if (curr == null) return prev;
  if (prev == null || Number.isNaN(prev)) return curr;
  return alpha * curr + (1 - alpha) * prev;
}

export class Aggregator {
  constructor() {
    this.state = {
      rttMs: null, jitterMs: null, lossPct: null,
      videoKbps: null, audioKbps: null,
      fps: null, frameWidth: null, frameHeight: null,
      framesDropped: 0,
      qoeScore: null,
    };
    this.lastLost = null;
    this.lastRecv = null;
  }

  update(raw) {
    const s = this.state;
    s.rttMs    = ema(s.rttMs,    raw.rttMs);
    s.jitterMs = ema(s.jitterMs, raw.jitterMs);

    // мгновенный loss% за окно
    let lossPct = null;
    if (raw.packetsLost != null && raw.packetsReceived != null) {
      if (this.lastLost != null && this.lastRecv != null) {
        const dLost = Math.max(0, raw.packetsLost - this.lastLost);
        const dRecv = Math.max(0, raw.packetsReceived - this.lastRecv);
        const total = dLost + dRecv;
        if (total > 0) lossPct = (dLost / total) * 100;
      }
      this.lastLost = raw.packetsLost;
      this.lastRecv = raw.packetsReceived;
    }
    s.lossPct = ema(s.lossPct, lossPct);

    s.videoKbps = ema(s.videoKbps, raw.videoBitsPerSec != null ? raw.videoBitsPerSec / 1000 : null);
    s.audioKbps = ema(s.audioKbps, raw.audioBitsPerSec != null ? raw.audioBitsPerSec / 1000 : null);
    s.fps         = ema(s.fps, raw.fps);
    s.frameWidth  = raw.frameWidth  ?? s.frameWidth;
    s.frameHeight = raw.frameHeight ?? s.frameHeight;
    if (raw.framesDropped != null && raw.framesDropped > s.framesDropped) {
      s.framesDropped = raw.framesDropped;
    }
    s.qoeScore = this.qoe();
    return { ...s };
  }

  // Простая 4-уровневая интегральная оценка из отчёта о практике (§2.3):
  // 4 = excellent, 3 = good, 2 = fair, 1 = poor.
  qoe() {
    const { rttMs, jitterMs, lossPct, fps } = this.state;
    if (rttMs == null && jitterMs == null && lossPct == null && fps == null) return null;
    let score = 4;
    if ((rttMs ?? 0) > 150)  score = Math.min(score, 3);
    if ((rttMs ?? 0) > 300)  score = Math.min(score, 2);
    if ((rttMs ?? 0) > 500)  score = Math.min(score, 1);
    if ((jitterMs ?? 0) > 30)  score = Math.min(score, 3);
    if ((jitterMs ?? 0) > 60)  score = Math.min(score, 2);
    if ((lossPct ?? 0) > 1)    score = Math.min(score, 3);
    if ((lossPct ?? 0) > 3)    score = Math.min(score, 2);
    if ((lossPct ?? 0) > 7)    score = Math.min(score, 1);
    if (fps != null && fps < 15) score = Math.min(score, 2);
    if (fps != null && fps < 8)  score = Math.min(score, 1);
    return score;
  }
}
