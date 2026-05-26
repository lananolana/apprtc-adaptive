// policy.js — политика адаптации качества.
//
// На входе — сглаженная телеметрия от Aggregator, на выходе — Decision:
//   { action: 'downgrade' | 'upgrade' | 'audioOnly' | 'restoreVideo' | 'noop',
//     targetLevel: number (0..N-1),  // индекс в ступенчатой шкале качества
//     reason: string }
//
// Используется ступенчатая шкала качества (ladder) и гистерезис: переключение
// возможно не чаще, чем раз в cooldownMs, и только если зона уверенно
// «плохая» / «хорошая» подряд hysteresisN сэмплов. Это снимает осцилляцию.

export const LADDER = [
  // index 0 — наихудший допустимый видеорежим
  { name: '180p@10',  width: 320,  height: 180,  fps: 10, maxBitrateKbps:  150 },
  { name: '240p@15',  width: 426,  height: 240,  fps: 15, maxBitrateKbps:  250 },
  { name: '360p@20',  width: 640,  height: 360,  fps: 20, maxBitrateKbps:  500 },
  { name: '480p@24',  width: 854,  height: 480,  fps: 24, maxBitrateKbps:  900 },
  { name: '540p@30',  width: 960,  height: 540,  fps: 30, maxBitrateKbps: 1500 },
  { name: '720p@30',  width: 1280, height: 720,  fps: 30, maxBitrateKbps: 2500 },
];

export const AUDIO_ONLY_LEVEL = -1;

const DEFAULTS = {
  cooldownMs:    5000,
  hysteresisN:   3,
  rttBadMs:      400,
  rttGoodMs:     150,
  lossBadPct:    5,
  lossGoodPct:   1,
  // Условие audio-only: либо RTT > порог, либо относительные потери > порог.
  // Требуется ≥ extremeStreakN подряд таких сэмплов, чтобы не реагировать
  // на переходные всплески потерь при резком сужении полосы пропускания.
  audioOnlyRttMs:    800,
  audioOnlyLossPct:  30,
  extremeStreakN:    3,
};

export class AdaptationPolicy {
  constructor({ enabled = false, params = {} } = {}) {
    this.enabled = enabled;
    this.p = { ...DEFAULTS, ...params };
    this.level = LADDER.length - 1; // стартуем с верхней ступени
    this.lastSwitchAt = 0;
    this.badStreak = 0;
    this.goodStreak = 0;
    this.extremeStreak = 0;
  }

  setEnabled(v) {
    this.enabled = !!v;
    if (!v) {
      this.badStreak = 0;
      this.goodStreak = 0;
      this.extremeStreak = 0;
    }
  }

  evaluate(stats) {
    if (!this.enabled) return null;
    const now = performance.now();
    const cooldownOk = now - this.lastSwitchAt > this.p.cooldownMs;

    const rtt  = stats.rttMs    ?? 0;
    const loss = stats.lossPct  ?? 0;

    // Экстремальная деградация: требуется ≥ extremeStreakN подряд сэмплов,
    // удовлетворяющих условию. Это защищает от ложного срабатывания на
    // переходных всплесках потерь, типичных при резком сужении полосы
    // пропускания (например, в первые секунды после активации эмулятора
    // сети).
    const extreme = rtt > this.p.audioOnlyRttMs || loss > this.p.audioOnlyLossPct;
    if (extreme) this.extremeStreak++;
    else this.extremeStreak = 0;

    if (this.extremeStreak >= this.p.extremeStreakN && this.level !== AUDIO_ONLY_LEVEL) {
      this.level = AUDIO_ONLY_LEVEL;
      this.lastSwitchAt = now;
      this.badStreak = 0;
      this.goodStreak = 0;
      this.extremeStreak = 0;
      return {
        action: 'audioOnly',
        targetLevel: AUDIO_ONLY_LEVEL,
        reason: `extreme x${this.p.extremeStreakN}: rtt=${rtt|0} loss=${loss.toFixed(1)}`,
      };
    }

    const bad  = rtt > this.p.rttBadMs  || loss > this.p.lossBadPct;
    const good = rtt < this.p.rttGoodMs && loss < this.p.lossGoodPct;

    if (bad)  { this.badStreak++;  this.goodStreak = 0; }
    else if (good) { this.goodStreak++; this.badStreak = 0; }
    else { this.badStreak = 0; this.goodStreak = 0; }

    if (!cooldownOk) return null;

    if (this.badStreak >= this.p.hysteresisN) {
      if (this.level === AUDIO_ONLY_LEVEL) return null; // уже на дне
      if (this.level > 0) {
        this.level--;
        this.lastSwitchAt = now;
        this.badStreak = 0;
        return { action: 'downgrade', targetLevel: this.level, reason: `bad streak: rtt=${rtt|0} loss=${loss.toFixed(1)}` };
      }
    }
    if (this.goodStreak >= this.p.hysteresisN) {
      if (this.level === AUDIO_ONLY_LEVEL) {
        this.level = 0;
        this.lastSwitchAt = now;
        this.goodStreak = 0;
        return { action: 'restoreVideo', targetLevel: 0, reason: 'recovered from audio-only' };
      }
      if (this.level < LADDER.length - 1) {
        this.level++;
        this.lastSwitchAt = now;
        this.goodStreak = 0;
        return { action: 'upgrade', targetLevel: this.level, reason: `good streak: rtt=${rtt|0} loss=${loss.toFixed(1)}` };
      }
    }
    return null;
  }
}
