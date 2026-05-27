// tests/aggregator.test.js — модульные тесты для Aggregator.
// Aggregator не зависит от времени, DOM и WebRTC, поэтому тестируется
// в чистом виде без mocking.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Aggregator } from '../client/adaptive/aggregator.js';

describe('Aggregator', () => {
  test('возвращает null-значения на первом сэмпле без данных', () => {
    const a = new Aggregator();
    const s = a.update({ rttMs: null, jitterMs: null, packetsLost: null, packetsReceived: null });
    assert.equal(s.rttMs, null);
    assert.equal(s.jitterMs, null);
    assert.equal(s.lossPct, null);
  });

  test('EMA-сглаживание RTT: первый сэмпл = значение, второй — смешан с α=0.3', () => {
    const a = new Aggregator();
    a.update({ rttMs: 100 });
    const s = a.update({ rttMs: 200 });
    // EMA: 0.3 * 200 + 0.7 * 100 = 60 + 70 = 130
    assert.equal(s.rttMs, 130);
  });

  test('lossPct рассчитывается как отношение приращений за окно', () => {
    const a = new Aggregator();
    // первый сэмпл — нет истории, lossPct остаётся null
    a.update({ packetsLost: 0, packetsReceived: 100 });
    // во втором: 5 потерь и 95 успешных пакетов за окно → 5/(5+95) = 5%
    const s = a.update({ packetsLost: 5, packetsReceived: 195 });
    assert.equal(s.lossPct, 5);
  });

  test('lossPct устойчив к отрицательным приращениям (счётчик сбросился)', () => {
    const a = new Aggregator();
    a.update({ packetsLost: 100, packetsReceived: 1000 });
    // сброс счётчика (например, после reconnect): новые значения меньше
    const s = a.update({ packetsLost: 0, packetsReceived: 0 });
    // приращения отрицательные → Math.max(0, ...) → 0 → total=0 → lossPct остаётся null/прежним
    // в нашей реализации lossPct получает null в этом сэмпле, EMA остаётся прежним
    assert.notEqual(s.lossPct, NaN);
  });

  test('qoeScore = 4 при идеальных условиях', () => {
    const a = new Aggregator();
    const s = a.update({ rttMs: 30, jitterMs: 2, packetsLost: 0, packetsReceived: 100, fps: 30 });
    a.update({ rttMs: 30, jitterMs: 2, packetsLost: 0, packetsReceived: 200, fps: 30 });
    const s2 = a.update({ rttMs: 30, jitterMs: 2, packetsLost: 0, packetsReceived: 300, fps: 30 });
    assert.equal(s2.qoeScore, 4);
  });

  test('qoeScore = 3 при RTT 200мс (диапазон 150-300)', () => {
    const a = new Aggregator();
    // несколько сэмплов чтобы EMA устаканилось
    for (let i = 0; i < 5; i++) {
      a.update({ rttMs: 200, jitterMs: 5, packetsLost: 0, packetsReceived: 100 * (i+1), fps: 30 });
    }
    const s = a.update({ rttMs: 200, jitterMs: 5, packetsLost: 0, packetsReceived: 600, fps: 30 });
    assert.equal(s.qoeScore, 3);
  });

  test('qoeScore = 1 при экстремальной деградации', () => {
    const a = new Aggregator();
    for (let i = 0; i < 5; i++) {
      a.update({ rttMs: 600, jitterMs: 100, packetsLost: 10 * (i+1), packetsReceived: 100 * (i+1), fps: 5 });
    }
    const s = a.update({ rttMs: 600, jitterMs: 100, packetsLost: 70, packetsReceived: 600, fps: 5 });
    assert.equal(s.qoeScore, 1);
  });

  test('FPS снижает QoE до 2 при значениях ниже 15', () => {
    const a = new Aggregator();
    for (let i = 0; i < 3; i++) a.update({ rttMs: 30, jitterMs: 2, fps: 10 });
    const s = a.update({ rttMs: 30, jitterMs: 2, fps: 10 });
    assert.equal(s.qoeScore, 2);
  });

  test('inbound-метрики прокидываются без сглаживания', () => {
    const a = new Aggregator();
    a.update({ inboundVideoFramesReceived: 100, inboundVideoBytesReceived: 5000 });
    const s = a.update({ inboundVideoFramesReceived: 130, inboundVideoBytesReceived: 6500 });
    assert.equal(s.inboundVideoFramesReceived, 130);
    assert.equal(s.inboundVideoBytesReceived, 6500);
  });
});
