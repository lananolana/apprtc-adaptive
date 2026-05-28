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
  // index 0 — наихудший допустимый видеорежим.
  // maxBitrateKbps — верхняя граница; фактический битрейт выбирает GCC.
  // Эмпирически на тестах с NLC-профилем «3G» GCC выжимал ~1.2 Мбит/с
  // при 480p — поэтому ограничения средних ступеней были подняты с 900
  // и 1500 до 1400 и 2000 соответственно, чтобы политика не мешала GCC
  // там, где он способен сам.
  { name: '180p@10',  width: 320,  height: 180,  fps: 10, maxBitrateKbps:  150 },
  { name: '240p@15',  width: 426,  height: 240,  fps: 15, maxBitrateKbps:  300 },
  { name: '360p@20',  width: 640,  height: 360,  fps: 20, maxBitrateKbps:  600 },
  { name: '480p@24',  width: 854,  height: 480,  fps: 24, maxBitrateKbps: 1400 },
  { name: '540p@30',  width: 960,  height: 540,  fps: 30, maxBitrateKbps: 2000 },
  { name: '720p@30',  width: 1280, height: 720,  fps: 30, maxBitrateKbps: 2500 },
];

export const AUDIO_ONLY_LEVEL = -1;

const DEFAULTS = {
  // Асимметричные выдержки: после любого переключения ступени контроллер
  // ждёт downgradeCooldownMs до следующего понижения и upgradeCooldownMs
  // до следующего повышения. Несимметричность мотивирована поведением
  // встроенного механизма GCC: при ухудшении полосы он реагирует
  // постепенно (что согласуется с консервативным понижением у нас), при
  // улучшении — быстрее (значит и повышение ступени у нас тоже должно
  // быть оперативным).
  downgradeCooldownMs: 5000,
  upgradeCooldownMs:   1500,
  hysteresisN:   3,
  rttBadMs:      400,
  rttGoodMs:     150,
  // Порог loss для понижения ступени. Версия v3: 7 % — компромисс между
  // v1 (5 %, слишком чувствительно — давала ложные срабатывания)
  // и v2 (10 %, слишком терпимо — в lossy политика вообще молчала, и
  // adaptive проигрывал baseline по стабильности битрейта). При 7 %
  // включается умеренное понижение, которое снижает CV исходящего
  // битрейта без потери fps.
  lossBadPct:    7,
  lossGoodPct:   1,
  // Условие audio-only. Версия v3: AND-логика. Один высокий RTT — не повод
  // отключать видео: edge-сеть (GPRS, rtt 400-1300 мс) при умеренных
  // потерях прекрасно несёт видеопоток на 240p@15. Audio-only остаётся
  // как «крайний» сценарий, когда плохо ОДНОВРЕМЕННО и по RTT, и по loss.
  // Порог RTT поднят 800 → 2000, потому что граница «edge нормально / edge
  // аварийно» по нашим прогонам лежит около 2 с.
  audioOnlyRttMs:    2000,
  audioOnlyLossPct:  15,
  extremeStreakN:    3,
};

export class AdaptationPolicy {
  constructor({ enabled = false, params = {} } = {}) {
    this.enabled = enabled;
    this.p = { ...DEFAULTS, ...params };
    this.level = LADDER.length - 1; // стартуем с верхней ступени
    // -Infinity означает «переключений ещё не было», что эквивалентно
    // «cooldown давно прошёл». Это важно для корректной работы политики
    // в первые секунды сессии: с 0 могла бы возникнуть ситуация, когда
    // performance.now() < downgradeCooldownMs и первое срабатывание
    // ошибочно откладывается.
    this.lastSwitchAt = -Infinity;
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
    const sinceLastSwitch = now - this.lastSwitchAt;
    const downgradeAllowed = sinceLastSwitch > this.p.downgradeCooldownMs;
    const upgradeAllowed   = sinceLastSwitch > this.p.upgradeCooldownMs;

    const rtt  = stats.rttMs    ?? 0;
    const loss = stats.lossPct  ?? 0;

    // Экстремальная деградация: требуется ≥ extremeStreakN подряд сэмплов,
    // удовлетворяющих условию. Это защищает от ложного срабатывания на
    // переходных всплесках потерь, типичных при резком сужении полосы
    // пропускания (например, в первые секунды после активации эмулятора
    // сети). В v3 — AND-логика: одного только высокого RTT или одного
    // только высокого loss недостаточно; должны совпасть оба, иначе мы
    // ошибочно уходим в audio-only на медленных, но устойчивых каналах
    // (edge-сеть GPRS — типичный случай высокого RTT при разумном loss).
    const extreme = rtt > this.p.audioOnlyRttMs && loss > this.p.audioOnlyLossPct;
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

    // Понижение ступени — только при выдержке downgradeCooldownMs.
    if (this.badStreak >= this.p.hysteresisN && downgradeAllowed) {
      if (this.level === AUDIO_ONLY_LEVEL) return null; // уже на дне
      if (this.level > 0) {
        this.level--;
        this.lastSwitchAt = now;
        this.badStreak = 0;
        return { action: 'downgrade', targetLevel: this.level, reason: `bad streak: rtt=${rtt|0} loss=${loss.toFixed(1)}` };
      }
    }
    // Повышение ступени и возврат из audio-only — при более короткой
    // выдержке upgradeCooldownMs.
    if (this.goodStreak >= this.p.hysteresisN && upgradeAllowed) {
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
