// tests/recovery.test.js — модульные тесты RecoveryManager.
// Подменяем performance.now() и setTimeout для контроля времени.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { RecoveryManager } from '../client/adaptive/recovery.js';

let fakeNow = 0;
const realPerformance = globalThis.performance;
function setupClock() {
  fakeNow = 0;
  globalThis.performance = { now: () => fakeNow };
}
function tickMs(ms) { fakeNow += ms; }
function restoreClock() { globalThis.performance = realPerformance; }

function makePc(initial = {}) {
  return {
    iceConnectionState: 'connected',
    connectionState: 'connected',
    ...initial,
  };
}

function makeCallbacks() {
  const calls = { start: [], success: 0, fail: 0, restartOffer: 0, restartRequest: 0 };
  return {
    calls,
    cb: {
      getRole: () => 'caller',
      sendRestartOffer: async () => { calls.restartOffer++; },
      sendRestartRequest: () => { calls.restartRequest++; },
      onRecoveryStart: (reason, attempt) => calls.start.push({ reason, attempt }),
      onRecoverySuccess: () => calls.success++,
      onRecoveryFail: () => calls.fail++,
    },
  };
}

describe('RecoveryManager', () => {
  beforeEach(setupClock);
  afterEach(restoreClock);

  test('healthy состояние — observe() ничего не делает', () => {
    const pc = makePc();
    const { cb, calls } = makeCallbacks();
    const rm = new RecoveryManager(pc, cb);
    rm.observe({ inboundVideoBytesReceived: 1000 });
    tickMs(1000);
    rm.observe({ inboundVideoBytesReceived: 2000 });
    assert.equal(calls.restartOffer, 0);
    assert.equal(calls.start.length, 0);
  });

  test('iceConnectionState=failed → немедленный триггер', () => {
    const pc = makePc({ iceConnectionState: 'failed' });
    const { cb, calls } = makeCallbacks();
    const rm = new RecoveryManager(pc, cb);
    rm.observe({});
    // дать промисам разрешиться
    return new Promise(resolve => setImmediate(() => {
      assert.equal(calls.restartOffer, 1);
      assert.equal(calls.start.length, 1);
      assert.equal(calls.start[0].attempt, 1);
      resolve();
    }));
  });

  test('iceConnectionState=disconnected — триггер только после disconnectTimeoutMs', () => {
    const pc = makePc({ iceConnectionState: 'disconnected' });
    const { cb, calls } = makeCallbacks();
    const rm = new RecoveryManager(pc, cb, { disconnectTimeoutMs: 3000 });

    rm.observe({});
    assert.equal(calls.restartOffer, 0); // только что вошли в disconnected
    tickMs(2000);
    rm.observe({});
    assert.equal(calls.restartOffer, 0); // меньше 3 секунд
    tickMs(2000);
    rm.observe({});

    return new Promise(resolve => setImmediate(() => {
      assert.equal(calls.restartOffer, 1);
      resolve();
    }));
  });

  test('callee при disconnected отправляет restart-request, не offer', () => {
    const pc = makePc({ iceConnectionState: 'failed' });
    const { cb, calls } = makeCallbacks();
    cb.getRole = () => 'callee';
    const rm = new RecoveryManager(pc, cb);
    rm.observe({});

    return new Promise(resolve => setImmediate(() => {
      assert.equal(calls.restartOffer, 0);
      assert.equal(calls.restartRequest, 1);
      resolve();
    }));
  });

  test('после maxAttempts срабатывает onRecoveryFail и giveUp=true', () => {
    const pc = makePc({ iceConnectionState: 'failed' });
    const { cb, calls } = makeCallbacks();
    const rm = new RecoveryManager(pc, cb, { maxAttempts: 2, minAttemptIntervalMs: 100 });

    return new Promise(resolve => {
      rm.observe({}); // attempt 1
      setImmediate(() => {
        tickMs(200);
        rm.recovering = false; // эмулируем что попытка завершилась без успеха
        rm.observe({}); // attempt 2
        setImmediate(() => {
          tickMs(200);
          rm.recovering = false;
          rm.observe({}); // attempts >= maxAttempts → fail
          setImmediate(() => {
            assert.equal(calls.fail, 1);
            assert.equal(rm.giveUp, true);
            resolve();
          });
        });
      });
    });
  });

  test('markStable сбрасывает giveUp — после успеха можно снова пробовать', () => {
    const pc = makePc();
    const { cb } = makeCallbacks();
    const rm = new RecoveryManager(pc, cb);
    rm.giveUp = true;
    rm.recovering = true;
    rm.attempts = 3;
    rm.markStable();
    assert.equal(rm.giveUp, false);
    assert.equal(rm.attempts, 0);
    assert.equal(rm.recovering, false);
  });

  test('observe сбрасывает счётчик попыток при healthy state', () => {
    const pc = makePc({ iceConnectionState: 'connected', connectionState: 'connected' });
    const { cb } = makeCallbacks();
    const rm = new RecoveryManager(pc, cb);
    rm.attempts = 2;
    rm.observe({ inboundVideoBytesReceived: 100 });
    assert.equal(rm.attempts, 0);
  });

  test('enabled:false — observe() не триггерит ICE restart даже на failed', () => {
    const pc = makePc({ iceConnectionState: 'failed' });
    const { cb, calls } = makeCallbacks();
    const rm = new RecoveryManager(pc, cb, { enabled: false });
    rm.observe({});
    return new Promise(resolve => setImmediate(() => {
      assert.equal(calls.restartOffer, 0,
        'в baseline (enabled:false) ICE restart не должен запускаться');
      assert.equal(calls.start.length, 0);
      resolve();
    }));
  });

  test('setEnabled(false) во время disconnected — сбрасывает накопленное состояние', () => {
    const pc = makePc({ iceConnectionState: 'disconnected' });
    const { cb, calls } = makeCallbacks();
    const rm = new RecoveryManager(pc, cb, { disconnectTimeoutMs: 3000 });
    rm.observe({});
    assert.notEqual(rm.disconnectedSince, null);
    rm.setEnabled(false);
    // даже если время пройдёт — триггера не будет
    tickMs(10000);
    rm.observe({});
    return new Promise(resolve => setImmediate(() => {
      assert.equal(calls.restartOffer, 0);
      // и состояние сброшено — disconnectedSince обнулён
      assert.equal(rm.disconnectedSince, null);
      resolve();
    }));
  });

  test('setEnabled(true) обратно — recovery снова работает', () => {
    const pc = makePc({ iceConnectionState: 'failed' });
    const { cb, calls } = makeCallbacks();
    const rm = new RecoveryManager(pc, cb, { enabled: false });
    rm.observe({});
    rm.setEnabled(true);
    rm.observe({});
    return new Promise(resolve => setImmediate(() => {
      assert.equal(calls.restartOffer, 1);
      resolve();
    }));
  });

  test('stuck connection: bytesReceived не растёт > stuckTimeoutMs → триггер', () => {
    const pc = makePc({ iceConnectionState: 'connected', connectionState: 'connected' });
    const { cb, calls } = makeCallbacks();
    const rm = new RecoveryManager(pc, cb, { stuckTimeoutMs: 5000 });

    rm.observe({ inboundVideoBytesReceived: 1000 });
    tickMs(3000);
    rm.observe({ inboundVideoBytesReceived: 1000 }); // не растёт, но < 5s
    assert.equal(calls.restartOffer, 0);
    tickMs(3000);
    rm.observe({ inboundVideoBytesReceived: 1000 }); // 6 секунд без роста

    return new Promise(resolve => setImmediate(() => {
      assert.equal(calls.restartOffer, 1);
      resolve();
    }));
  });
});
