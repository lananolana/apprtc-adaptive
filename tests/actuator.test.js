// tests/actuator.test.js — модульные тесты Actuator с двусторонней
// кооперативной адаптацией. Mock'аем RTCPeerConnection — нам нужны
// только sender'ы с getParameters/setParameters и MediaStreamTrack
// с минимальной реализацией.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Actuator } from '../client/adaptive/actuator.js';
import { LADDER, AUDIO_ONLY_LEVEL } from '../client/adaptive/policy.js';

function makeMockPc() {
  // Состояние, которое мы можем читать в тестах.
  const trackState = { enabled: true };
  const params = { encodings: [{}], degradationPreference: 'balanced' };
  const sender = {
    track: {
      kind: 'video',
      get enabled() { return trackState.enabled; },
      set enabled(v) { trackState.enabled = v; },
      getSettings: () => ({ height: 720, width: 1280 }),
    },
    getParameters: () => JSON.parse(JSON.stringify(params)),
    setParameters: async (p) => Object.assign(params, p),
    _params: params,
    _trackState: trackState,
  };
  return {
    getSenders: () => [sender],
    _sender: sender,
  };
}

describe('Actuator (двусторонняя кооперативная адаптация)', () => {
  test('начальные уровни: оба на верхней ступени', () => {
    const pc = makeMockPc();
    const a = new Actuator(pc);
    assert.equal(a.localLevel, LADDER.length - 1);
    assert.equal(a.remoteLevel, LADDER.length - 1);
    assert.equal(a.effectiveLevel(), LADDER.length - 1);
  });

  test('local downgrade применяется к sender', async () => {
    const pc = makeMockPc();
    const a = new Actuator(pc);
    await a.apply({ action: 'downgrade', targetLevel: 3 });
    assert.equal(a.localLevel, 3);
    assert.equal(a.effectiveLevel(), 3);
    // setParameters был вызван с maxBitrate ступени 3
    assert.equal(pc._sender._params.encodings[0].maxBitrate, LADDER[3].maxBitrateKbps * 1000);
  });

  test('setRemoteLevel ограничивает исходящий уровень', async () => {
    const pc = makeMockPc();
    const a = new Actuator(pc);
    // местная политика хочет верхнюю ступень
    assert.equal(a.localLevel, LADDER.length - 1);
    // собеседник сообщил, что у него тяжёлая сеть — макс. уровень 2
    await a.setRemoteLevel(2);
    assert.equal(a.effectiveLevel(), 2);
    // applied к sender
    assert.equal(pc._sender._params.encodings[0].maxBitrate, LADDER[2].maxBitrateKbps * 1000);
  });

  test('MIN: если оба упали, берётся меньший уровень', async () => {
    const pc = makeMockPc();
    const a = new Actuator(pc);
    await a.apply({ action: 'downgrade', targetLevel: 3 });
    await a.setRemoteLevel(1);
    assert.equal(a.effectiveLevel(), 1); // MIN(3, 1) = 1
  });

  test('MIN: local восстанавливается, но remote всё ещё держит низкий — выходим только до remote', async () => {
    const pc = makeMockPc();
    const a = new Actuator(pc);
    await a.setRemoteLevel(1);
    await a.apply({ action: 'upgrade', targetLevel: 5 });
    assert.equal(a.effectiveLevel(), 1); // remote ограничивает
  });

  test('remote audio-only заставляет нас тоже отключить видео', async () => {
    const pc = makeMockPc();
    const a = new Actuator(pc);
    // местная политика не паникует
    assert.equal(a.localLevel, LADDER.length - 1);
    assert.equal(pc._sender._trackState.enabled, true);
    // но собеседник сообщил audio-only
    await a.setRemoteLevel(AUDIO_ONLY_LEVEL);
    assert.equal(a.effectiveLevel(), AUDIO_ONLY_LEVEL);
    // наше видео отключено
    assert.equal(pc._sender._trackState.enabled, false);
  });

  test('выход из audio-only: при remote=0 видеотрек включается обратно', async () => {
    const pc = makeMockPc();
    const a = new Actuator(pc);
    await a.setRemoteLevel(AUDIO_ONLY_LEVEL);
    assert.equal(pc._sender._trackState.enabled, false);
    // remote сообщил, что готов принимать снова (на нижней ступени)
    await a.setRemoteLevel(0);
    assert.equal(pc._sender._trackState.enabled, true);
  });

  test('local audio-only — track отключается', async () => {
    const pc = makeMockPc();
    const a = new Actuator(pc);
    await a.apply({ action: 'audioOnly', targetLevel: AUDIO_ONLY_LEVEL });
    assert.equal(a.localLevel, AUDIO_ONLY_LEVEL);
    assert.equal(pc._sender._trackState.enabled, false);
  });

  test('local restoreVideo — выходим из audio-only', async () => {
    const pc = makeMockPc();
    const a = new Actuator(pc);
    await a.apply({ action: 'audioOnly', targetLevel: AUDIO_ONLY_LEVEL });
    assert.equal(pc._sender._trackState.enabled, false);
    await a.apply({ action: 'restoreVideo', targetLevel: 0 });
    assert.equal(a.localLevel, 0);
    assert.equal(pc._sender._trackState.enabled, true);
  });

  test('setRemoteLevel игнорирует невалидные значения', async () => {
    const pc = makeMockPc();
    const a = new Actuator(pc);
    await a.setRemoteLevel('not-a-number');
    assert.equal(a.remoteLevel, LADDER.length - 1); // не изменился
    await a.setRemoteLevel(999); // вне ladder
    assert.equal(a.remoteLevel, LADDER.length - 1);
    await a.setRemoteLevel(-99);
    assert.equal(a.remoteLevel, LADDER.length - 1);
  });

  test('degradationPreference устанавливается в maintain-framerate', async () => {
    const pc = makeMockPc();
    const a = new Actuator(pc);
    await a.apply({ action: 'downgrade', targetLevel: 3 });
    assert.equal(pc._sender._params.degradationPreference, 'maintain-framerate');
  });

  test('повторное применение того же эффективного уровня — no-op', async () => {
    const pc = makeMockPc();
    const a = new Actuator(pc);
    let setParamsCalls = 0;
    const originalSet = pc._sender.setParameters;
    pc._sender.setParameters = async (p) => { setParamsCalls++; return originalSet(p); };
    await a.apply({ action: 'downgrade', targetLevel: 3 });
    const callsAfterFirst = setParamsCalls;
    await a.setRemoteLevel(5); // localLevel=3 уже ниже, MIN=3, ничего не меняется
    assert.equal(setParamsCalls, callsAfterFirst);
  });
});
