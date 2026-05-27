// tests/freeze-detector.test.js — модульные тесты FreezeDetector.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { FreezeDetector } from '../client/adaptive/freeze-detector.js';

let fakeNow = 0;
const realPerformance = globalThis.performance;
function setupClock() {
  fakeNow = 0;
  globalThis.performance = { now: () => fakeNow };
}
function tickMs(ms) { fakeNow += ms; }
function restoreClock() { globalThis.performance = realPerformance; }

describe('FreezeDetector', () => {
  beforeEach(setupClock);
  afterEach(restoreClock);

  test('начальное состояние — не зафризился, callback не дёргается', () => {
    let calls = 0;
    const d = new FreezeDetector({ onFreezeChange: () => calls++ });
    assert.equal(d.frozen, false);
    assert.equal(calls, 0);
  });

  test('счётчик растёт — не считаем замиранием', () => {
    let calls = 0;
    const d = new FreezeDetector({ thresholdMs: 3000, onFreezeChange: () => calls++ });
    d.observe({ inboundVideoFramesReceived: 100 });
    tickMs(1000);
    d.observe({ inboundVideoFramesReceived: 130 });
    tickMs(1000);
    d.observe({ inboundVideoFramesReceived: 160 });
    assert.equal(d.frozen, false);
    assert.equal(calls, 0);
  });

  test('счётчик не растёт дольше threshold → frozen=true, callback вызвался', () => {
    let lastValue = null;
    const d = new FreezeDetector({ thresholdMs: 3000, onFreezeChange: v => lastValue = v });
    d.observe({ inboundVideoFramesReceived: 100 });
    tickMs(5000);
    d.observe({ inboundVideoFramesReceived: 100 });
    assert.equal(d.frozen, true);
    assert.equal(lastValue, true);
  });

  test('callback срабатывает ОДИН РАЗ при смене состояния, не на каждом сэмпле', () => {
    let calls = [];
    const d = new FreezeDetector({ thresholdMs: 2000, onFreezeChange: v => calls.push(v) });
    d.observe({ inboundVideoFramesReceived: 100 });
    tickMs(3000);
    d.observe({ inboundVideoFramesReceived: 100 });
    tickMs(1000);
    d.observe({ inboundVideoFramesReceived: 100 });
    tickMs(1000);
    d.observe({ inboundVideoFramesReceived: 100 });
    // три вызова observe в состоянии «зафризился», но callback должен сработать один раз
    assert.deepEqual(calls, [true]);
  });

  test('выход из freeze: callback с false когда счётчик опять начинает расти', () => {
    let calls = [];
    const d = new FreezeDetector({ thresholdMs: 2000, onFreezeChange: v => calls.push(v) });
    d.observe({ inboundVideoFramesReceived: 100 });
    tickMs(3000);
    d.observe({ inboundVideoFramesReceived: 100 }); // frozen=true
    tickMs(1000);
    d.observe({ inboundVideoFramesReceived: 130 }); // снова растёт → frozen=false
    assert.deepEqual(calls, [true, false]);
    assert.equal(d.frozen, false);
  });

  test('null-сэмплы игнорируются (нет данных = нет вердикта)', () => {
    let calls = 0;
    const d = new FreezeDetector({ thresholdMs: 2000, onFreezeChange: () => calls++ });
    d.observe({ inboundVideoFramesReceived: null });
    tickMs(5000);
    d.observe({ inboundVideoFramesReceived: null });
    assert.equal(calls, 0);
    assert.equal(d.frozen, false);
  });

  test('reset() сбрасывает состояние', () => {
    const d = new FreezeDetector({ thresholdMs: 1000 });
    d.observe({ inboundVideoFramesReceived: 50 });
    tickMs(2000);
    d.observe({ inboundVideoFramesReceived: 50 });
    assert.equal(d.frozen, true);
    d.reset();
    assert.equal(d.frozen, false);
    assert.equal(d.lastFrames, null);
  });
});
