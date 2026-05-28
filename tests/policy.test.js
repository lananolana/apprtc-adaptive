// tests/policy.test.js — модульные тесты для AdaptationPolicy.
// Policy зависит от performance.now() — подменяем глобальный счётчик
// для контроля времени в тестах.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AdaptationPolicy, LADDER, AUDIO_ONLY_LEVEL } from '../client/adaptive/policy.js';

// --- управляемый таймер -------------------------------------------------
let fakeNow = 0;
const realPerformance = globalThis.performance;
function setupClock() {
  fakeNow = 0;
  globalThis.performance = { now: () => fakeNow };
}
function tickMs(ms) { fakeNow += ms; }
function restoreClock() { globalThis.performance = realPerformance; }

// --- хелперы -----------------------------------------------------------
const GOOD  = { rttMs: 30,  lossPct: 0 };
const BAD   = { rttMs: 500, lossPct: 8 };
// v3: audio-only требует одновременно высокий RTT (>2000) И высокий loss (>15).
// EXTREME удовлетворяет обоим, чтобы дойти до audio-only ветки.
const EXTREME = { rttMs: 2500, lossPct: 50 };
// «высокий RTT, но умеренные потери» — типичный edge-канал; audio-only
// сработать не должен.
const EDGE_LIKE = { rttMs: 2500, lossPct: 5 };
// «высокие потери, но низкий RTT» — переходный спайк; audio-only тоже нет.
const LOSS_SPIKE = { rttMs: 100, lossPct: 50 };

describe('AdaptationPolicy', () => {
  beforeEach(setupClock);
  afterEach(restoreClock);

  test('disabled политика всегда возвращает null', () => {
    const p = new AdaptationPolicy({ enabled: false });
    assert.equal(p.evaluate(BAD), null);
    assert.equal(p.evaluate(EXTREME), null);
  });

  test('enabled политика на старте на верхней ступени, decision=null при стабильно хороших условиях', () => {
    const p = new AdaptationPolicy({ enabled: true });
    for (let i = 0; i < 10; i++) {
      tickMs(1000);
      assert.equal(p.evaluate(GOOD), null);
    }
    assert.equal(p.level, LADDER.length - 1);
  });

  test('downgrade срабатывает после hysteresisN плохих сэмплов', () => {
    const p = new AdaptationPolicy({ enabled: true });
    // первый и второй — копят badStreak, ещё нет решения
    tickMs(1000);
    assert.equal(p.evaluate(BAD), null);
    tickMs(1000);
    assert.equal(p.evaluate(BAD), null);
    // третий — должен дать downgrade
    tickMs(1000);
    const d = p.evaluate(BAD);
    assert.equal(d.action, 'downgrade');
    assert.equal(d.targetLevel, LADDER.length - 2);
  });

  test('повторное понижение требует выдержки downgradeCooldownMs от прошлого переключения', () => {
    const p = new AdaptationPolicy({ enabled: true });
    // первое понижение на t=3000
    for (let i = 0; i < 3; i++) { tickMs(1000); p.evaluate(BAD); }
    const levelAfterFirst = p.level;
    assert.ok(levelAfterFirst < LADDER.length - 1, 'первый downgrade должен был произойти');

    // сразу после downgrade при 3 плохих подряд cooldown ещё блокирует.
    // badStreak уже подсчитан (3 плохих после сброса).
    tickMs(1000); p.evaluate(BAD); // badStreak=1, sinceLastSwitch=1000
    tickMs(1000); p.evaluate(BAD); // badStreak=2
    tickMs(1000);                  // fakeNow=6000, sinceLastSwitch=3000 (<5000)
    let d = p.evaluate(BAD);       // badStreak=3, но downgradeAllowed=false
    assert.equal(d, null, 'до истечения downgradeCooldownMs новый downgrade не сработает');
    assert.equal(p.level, levelAfterFirst, 'уровень не меняется');

    // дожидаемся остатка cooldown. На текущий момент fakeNow=6000, lastSwitchAt=3000.
    // Чтобы sinceLastSwitch > 5000, нужно tickMs(2001+).
    tickMs(2500); // fakeNow=8500, sinceLastSwitch=5500 > 5000 ✓
    // badStreak уже накоплен (>=3 от предыдущего шага), downgradeAllowed теперь true
    d = p.evaluate(BAD);
    assert.equal(d?.action, 'downgrade');
    assert.equal(p.level, levelAfterFirst - 1);
  });

  test('upgrade срабатывает с более короткой выдержкой (asymmetric cooldown)', () => {
    const p = new AdaptationPolicy({ enabled: true });
    // понижаем
    for (let i = 0; i < 3; i++) { tickMs(1000); p.evaluate(BAD); }
    const levelAfterDowngrade = p.level;
    // теперь 3 хороших сэмпла + 1500мс выдержки (upgradeCooldownMs)
    tickMs(800); p.evaluate(GOOD);  // badStreak сбрасывается, goodStreak=1
    tickMs(800); p.evaluate(GOOD);  // goodStreak=2; 1600мс с момента понижения
    tickMs(800);
    const d = p.evaluate(GOOD);    // goodStreak=3, прошло 2400мс — больше upgradeCooldown=1500мс
    assert.equal(d.action, 'upgrade');
    assert.equal(d.targetLevel, levelAfterDowngrade + 1);
  });

  test('audioOnly срабатывает после extremeStreakN подряд сэмплов', () => {
    const p = new AdaptationPolicy({ enabled: true });
    // extremeStreakN=4 в v4 — три первых ещё не дают audio-only
    for (let i = 0; i < 3; i++) {
      tickMs(1000);
      const d = p.evaluate(EXTREME);
      assert.notEqual(d?.action, 'audioOnly',
        `на ${i+1}-м сэмпле audio-only не должен срабатывать (нужно 4 подряд)`);
    }
    // 4-й — audio-only
    tickMs(1000);
    const d = p.evaluate(EXTREME);
    assert.equal(d?.action, 'audioOnly');
    assert.equal(p.level, AUDIO_ONLY_LEVEL);
  });

  test('audioOnly НЕ срабатывает на одиночном transient spike', () => {
    const p = new AdaptationPolicy({ enabled: true });
    tickMs(1000); p.evaluate(EXTREME);  // extremeStreak=1
    tickMs(1000); p.evaluate(GOOD);     // reset → extremeStreak=0
    tickMs(1000); p.evaluate(EXTREME);  // extremeStreak=1 снова
    // ни одного audio-only не сработало
    assert.notEqual(p.level, AUDIO_ONLY_LEVEL);
  });

  test('restoreVideo возвращает из audio-only на нижнюю ступень', () => {
    const p = new AdaptationPolicy({ enabled: true });
    // переходим в audio-only (extremeStreakN=4 в v4)
    for (let i = 0; i < 4; i++) { tickMs(1000); p.evaluate(EXTREME); }
    assert.equal(p.level, AUDIO_ONLY_LEVEL);
    // 3 хороших сэмпла + upgrade cooldown 1500мс
    tickMs(800); p.evaluate(GOOD);
    tickMs(800); p.evaluate(GOOD);
    tickMs(800);
    const d = p.evaluate(GOOD);
    assert.equal(d.action, 'restoreVideo');
    assert.equal(p.level, 0); // нижняя ступень
  });

  test('lossBadPct=7 (v3): 3% потерь не вызывает downgrade', () => {
    const p = new AdaptationPolicy({ enabled: true });
    const THREE_PERCENT = { rttMs: 100, lossPct: 3 };
    for (let i = 0; i < 5; i++) {
      tickMs(1000);
      const d = p.evaluate(THREE_PERCENT);
      assert.equal(d, null);
    }
    assert.equal(p.level, LADDER.length - 1);
  });

  test('lossBadPct=7 (v3): 10% потерь вызывает downgrade', () => {
    const p = new AdaptationPolicy({ enabled: true });
    const TEN_PERCENT = { rttMs: 100, lossPct: 10 };
    let switched = false;
    for (let i = 0; i < 10; i++) {
      tickMs(1000);
      const d = p.evaluate(TEN_PERCENT);
      if (d?.action === 'downgrade') switched = true;
    }
    assert.equal(switched, true);
  });

  test('AND-логика audio-only (v3): высокий RTT при умеренных потерях не вызывает audio-only', () => {
    const p = new AdaptationPolicy({ enabled: true });
    // эмулируем edge-канал: rtt=2500, loss=5 — НЕ должно вырубать видео
    for (let i = 0; i < 10; i++) {
      tickMs(1000);
      const d = p.evaluate(EDGE_LIKE);
      assert.notEqual(d?.action, 'audioOnly',
        'edge-канал с высоким RTT, но низким loss не должен попадать в audio-only');
    }
    assert.notEqual(p.level, AUDIO_ONLY_LEVEL);
  });

  test('AND-логика audio-only (v3): высокий loss при низком RTT не вызывает audio-only', () => {
    const p = new AdaptationPolicy({ enabled: true });
    // эмулируем lossy-канал: rtt=100, loss=50 — НЕ должно вырубать видео,
    // но должно идти агрессивное понижение через обычный downgrade
    for (let i = 0; i < 10; i++) {
      tickMs(1000);
      const d = p.evaluate(LOSS_SPIKE);
      assert.notEqual(d?.action, 'audioOnly',
        'loss-only пиков недостаточно для audio-only без высокого RTT');
    }
    assert.notEqual(p.level, AUDIO_ONLY_LEVEL);
  });

  test('setEnabled(false) сбрасывает streak-счётчики', () => {
    const p = new AdaptationPolicy({ enabled: true });
    tickMs(1000); p.evaluate(BAD);
    tickMs(1000); p.evaluate(BAD);
    assert.equal(p.badStreak, 2);
    p.setEnabled(false);
    assert.equal(p.badStreak, 0);
  });

  test('политика не идёт ниже нижней ступени', () => {
    const p = new AdaptationPolicy({ enabled: true });
    // загнать на нижнюю
    while (p.level > 0) {
      tickMs(6000); // пропускаем cooldown
      for (let i = 0; i < 3; i++) { tickMs(1000); p.evaluate(BAD); }
    }
    assert.equal(p.level, 0);
    // ещё плохие сэмплы не должны выходить за пределы (но extreme переведут в audio-only)
    for (let i = 0; i < 5; i++) { tickMs(1000); p.evaluate(BAD); }
    assert.equal(p.level, 0); // на дне ladder
  });
});
