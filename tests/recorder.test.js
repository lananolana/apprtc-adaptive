// tests/recorder.test.js — модульные тесты Recorder (только бизнес-логика
// сериализации CSV; DOM-зависимый download() здесь не тестируется).

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Recorder } from '../client/adaptive/recorder.js';

let fakeNow = 0;
const realPerformance = globalThis.performance;
function setupClock() {
  fakeNow = 0;
  globalThis.performance = { now: () => fakeNow };
}
function tickMs(ms) { fakeNow += ms; }
function restoreClock() { globalThis.performance = realPerformance; }

describe('Recorder', () => {
  beforeEach(setupClock);
  afterEach(restoreClock);

  test('isActive() = false до старта', () => {
    const r = new Recorder();
    assert.equal(r.isActive(), false);
  });

  test('start() переводит в активное состояние', () => {
    const r = new Recorder();
    r.start();
    assert.equal(r.isActive(), true);
  });

  test('record() добавляет строку с относительным ts_ms', () => {
    const r = new Recorder();
    r.start();
    tickMs(1234);
    r.record({ rttMs: 50, fps: 30, qoeScore: 4 }, 'baseline');
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].ts_ms, 1234);
    assert.equal(r.rows[0].rttMs, 50);
    assert.equal(r.rows[0].mode, 'baseline');
  });

  test('mark() ставит event в следующем сэмпле', () => {
    const r = new Recorder();
    r.start();
    r.mark('profile=3g');
    tickMs(100);
    r.record({ rttMs: 10 }, 'baseline');
    assert.equal(r.rows[0].event, 'profile=3g');
    // следующая запись — event пустой (мгновенный flag)
    tickMs(100);
    r.record({ rttMs: 10 }, 'baseline');
    assert.equal(r.rows[1].event, '');
  });

  test('noteDecision() сохраняется в adaptAction/adaptLevel', () => {
    const r = new Recorder();
    r.start();
    r.noteDecision({ action: 'downgrade', targetLevel: 4 });
    tickMs(100);
    r.record({}, 'adaptive');
    assert.equal(r.rows[0].adaptAction, 'downgrade');
    assert.equal(r.rows[0].adaptLevel, 4);
  });

  test('toCsv() формирует валидный CSV с правильным заголовком', () => {
    const r = new Recorder();
    r.start();
    tickMs(100);
    r.record({ rttMs: 50, fps: 30 }, 'baseline');
    const csv = r.toCsv();
    const lines = csv.trim().split('\n');
    const header = lines[0];
    assert.ok(header.startsWith('ts_ms,mode,event'));
    assert.ok(header.includes('inboundVideoFramesReceived'));
    assert.equal(lines.length, 2); // заголовок + 1 строка
  });

  test('CSV экранирует значения с запятыми', () => {
    const r = new Recorder();
    r.start();
    r.mark('hello, world'); // запятая в event
    tickMs(100);
    r.record({}, 'baseline');
    const csv = r.toCsv();
    // ожидаем экранирование двойными кавычками
    assert.ok(csv.includes('"hello, world"'));
  });

  test('stop() переводит в неактивное состояние и возвращает CSV', () => {
    const r = new Recorder();
    r.start();
    tickMs(100);
    r.record({}, 'baseline');
    const csv = r.stop();
    assert.ok(csv && csv.includes('ts_ms'));
    assert.equal(r.isActive(), false);
  });

  test('record() в неактивном состоянии — no-op', () => {
    const r = new Recorder();
    r.record({ rttMs: 50 }, 'baseline');
    assert.equal(r.rows.length, 0);
  });

  test('inbound метрики попадают в CSV', () => {
    const r = new Recorder();
    r.start();
    tickMs(100);
    r.record({ inboundVideoFramesReceived: 1500, inboundVideoBytesReceived: 50000 }, 'baseline');
    const csv = r.toCsv();
    // в строке должны быть значения 1500 и 50000
    assert.ok(csv.includes('1500'));
    assert.ok(csv.includes('50000'));
  });
});
