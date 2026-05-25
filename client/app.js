// app.js — главный модуль клиента.
//
// Архитектура построена по образцу AppRTC PeerConnectionClient
// (см. client/baseline/peerconnectionclient.original.js):
//   - один RTCPeerConnection на звонок;
//   - signaling-сообщения уезжают наружу через handler, доставка ICE через
//     onicecandidate / addIceCandidate;
//   - адаптивный слой (collector → aggregator → policy → actuator) подключается
//     поверх стандартного API и не вмешивается в congestion control браузера.
//
// Поверх адаптивного слоя добавлены наблюдатели UX:
//   - FreezeDetector — выявляет «зависание» удалённого видеопотока;
//   - RecoveryManager — автоматический ICE restart при разрыве/застревании;
//   - Toast/overlays — пользовательская обратная связь.

import { startMetricsCollector } from '/adaptive/collector.js';
import { Aggregator }            from '/adaptive/aggregator.js';
import { AdaptationPolicy }      from '/adaptive/policy.js';
import { Actuator }              from '/adaptive/actuator.js';
import { renderMetrics }         from '/adaptive/dashboard.js';
import { Recorder }              from '/adaptive/recorder.js';
import { FreezeDetector }        from '/adaptive/freeze-detector.js';
import { RecoveryManager }       from '/adaptive/recovery.js';
import { showToast }             from '/adaptive/toast.js';
import {
  setAudioOnly, setFrozen, setRecovering, setPeerLeft, resetOverlays, updateQualityBadge,
} from '/adaptive/overlays.js';

// --- параметры -------------------------------------------------------------
const RTC_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};
const MEDIA_CONSTRAINTS = {
  audio: true,
  video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
};

// --- DOM ----------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const localVideo  = $('localVideo');
const remoteVideo = $('remoteVideo');
const roomInput   = $('roomInput');
const joinBtn     = $('joinBtn');
const copyBtn     = $('copyLinkBtn');
const hangupBtn   = $('hangupBtn');
const statusText  = $('statusText');
const modeLabel   = $('modeLabel');

// --- состояние ---------------------------------------------------------------
let ws = null;
let pc = null;
let localStream = null;
let roomId = null;
let role = null;          // 'caller' | 'callee'
let mode = 'baseline';    // 'baseline' | 'adaptive'

let collectorHandle = null;
let aggregator = null;
let policy = null;
let actuator = null;
const recorder = new Recorder();

let freezeDetector = null;
let recoveryManager = null;

// последнее принятое решение политики — для бейджа и оверлеев
let lastDecisionAction = null;
let audioOnlyActive = false;
let recoveryActive = false;
let peerLeftActive = false;
let lastPeerCount = 0;

// --- утилиты -----------------------------------------------------------------
function setStatus(text) { statusText.textContent = text; }
function log(...args) { console.log('[app]', ...args); }

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

function randomRoomId() {
  return Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6);
}

function prefillRoomFromUrl() {
  const u = new URL(location.href);
  const r = u.searchParams.get('room');
  if (r) roomInput.value = r;
}

// --- сигналинг ---------------------------------------------------------------
function connectSignaling() {
  ws = new WebSocket(wsUrl());
  ws.addEventListener('open',    () => log('signaling open'));
  ws.addEventListener('close',   () => log('signaling close'));
  ws.addEventListener('error',   (e) => log('signaling error', e));
  ws.addEventListener('message', onSignalingMessage);
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', (e) => reject(e), { once: true });
  });
}

function sendSignal(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ ...payload, roomId }));
}

async function onSignalingMessage(ev) {
  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }
  log('signal in:', msg.type, msg);

  switch (msg.type) {
    case 'joined':
      role = msg.role;
      setStatus(`Вошёл в комнату ${msg.roomId} как ${role}. ${msg.count === 1 ? 'Ожидание второго участника…' : ''}`);
      break;
    case 'peers':
      handlePeersCount(msg.count);
      break;
    case 'offer':
      await handleOffer(msg.sdp);
      break;
    case 'answer':
      if (pc) await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      break;
    case 'candidate':
      if (pc && msg.candidate) {
        try { await pc.addIceCandidate(msg.candidate); }
        catch (e) { console.warn('addIceCandidate failed', e); }
      }
      break;
    case 'restart-request':
      // Callee сообщает, что у него проблемы со связью; caller инициирует ICE restart.
      if (role === 'caller') {
        log('received restart-request from peer, initiating ICE restart');
        await sendRestartOffer();
      }
      break;
    case 'bye':
      hangup(false);
      break;
    case 'full':
      setStatus(`Комната ${msg.roomId} уже занята двумя участниками.`);
      break;
    case 'error':
      setStatus(`Ошибка сигналинга: ${msg.reason}`);
      break;
  }
}

// --- WebRTC ------------------------------------------------------------------
async function ensureLocalStream() {
  if (localStream) return localStream;
  localStream = await navigator.mediaDevices.getUserMedia(MEDIA_CONSTRAINTS);
  localVideo.srcObject = localStream;
  return localStream;
}

function createPeerConnection() {
  pc = new RTCPeerConnection(RTC_CONFIG);

  pc.addEventListener('icecandidate', (ev) => {
    if (ev.candidate) sendSignal({ type: 'candidate', candidate: ev.candidate });
  });
  pc.addEventListener('track', (ev) => {
    log('remote track', ev.track.kind);
    if (ev.streams && ev.streams[0]) remoteVideo.srcObject = ev.streams[0];
  });
  pc.addEventListener('iceconnectionstatechange', () => {
    log('iceConnectionState =', pc.iceConnectionState);
  });
  pc.addEventListener('connectionstatechange', () => {
    log('connectionState =', pc.connectionState);
    if (pc.connectionState === 'connected') {
      setStatus('Соединение установлено.');
      startTelemetry();
    } else if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
      stopTelemetry();
    }
  });

  for (const track of localStream.getTracks()) {
    pc.addTrack(track, localStream);
  }
}

async function createOffer() {
  createPeerConnection();
  const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
  await pc.setLocalDescription(offer);
  sendSignal({ type: 'offer', sdp: pc.localDescription });
  setStatus('Offer отправлен, ожидание answer…');
}

async function handleOffer(sdp) {
  if (!pc) createPeerConnection();
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  sendSignal({ type: 'answer', sdp: pc.localDescription });
  setStatus('Answer отправлен.');
}

/**
 * Реакция на изменение количества участников в комнате.
 * 0 — мы только что вошли, ничего не делаем (текущий клиент видит peers
 *     только после своего же join — там min count = 1).
 * 1 — мы остались одни. Если до этого было 2, значит собеседник вышел —
 *     переходим в терминальное состояние "peer left" и гасим попытки
 *     восстановления (восстанавливать некого).
 * 2 — двое в комнате. Если до этого было 1 и мы caller — инициируем offer
 *     (как при первом установлении или если пир вернулся после выхода).
 */
async function handlePeersCount(count) {
  const prev = lastPeerCount;
  lastPeerCount = count;

  if (count === 2 && prev <= 1) {
    // собеседник пришёл (или вернулся) — гасим peer-left, готовим звонок
    if (peerLeftActive) {
      peerLeftActive = false;
      setPeerLeft(false);
      showToast('Собеседник вернулся', { type: 'success', duration: 3000 });
    }
    if (role === 'caller') await createOffer();
    return;
  }

  if (count === 1 && prev === 2) {
    // собеседник вышел
    peerLeftActive = true;
    setPeerLeft(true);
    // гасим оверлеи и наблюдателей, чтобы не маячило «восстанавливаем»
    setFrozen(false);
    setRecovering(false);
    recoveryActive = false;
    audioOnlyActive = false;
    setAudioOnly(false);
    // очищаем удалённое видео, чтобы не висел последний кадр под оверлеем
    try { remoteVideo.srcObject = null; } catch {}
    updateQualityBadge({ qoeScore: null, peerLeft: true });
    showToast('Собеседник вышел из звонка', { type: 'info', duration: 5000 });
    setStatus('Собеседник вышел. Можно подождать или завершить сессию.');
  }
}

/** Перепогон ICE: caller формирует новый offer с iceRestart: true. */
async function sendRestartOffer() {
  if (!pc) return;
  const offer = await pc.createOffer({ iceRestart: true });
  await pc.setLocalDescription(offer);
  sendSignal({ type: 'offer', sdp: pc.localDescription });
  log('restart offer sent');
}

function hangup(notifyRemote) {
  if (notifyRemote) sendSignal({ type: 'bye' });
  stopTelemetry();
  if (pc) { try { pc.close(); } catch {} pc = null; }
  if (ws) { try { ws.close(); } catch {} ws = null; }
  remoteVideo.srcObject = null;
  lastPeerCount = 0;
  resetOverlays();
  updateQualityBadge({ qoeScore: null });
  setStatus('Сессия завершена.');
  joinBtn.disabled = false;
  copyBtn.disabled = true;
  hangupBtn.disabled = true;
}

// --- адаптивный слой + UX наблюдатели ---------------------------------------
function startTelemetry() {
  if (collectorHandle) return;
  aggregator = new Aggregator();
  policy = new AdaptationPolicy({ enabled: mode === 'adaptive' });
  actuator = new Actuator(pc);

  // Детектор фриза удалённого видео
  freezeDetector = new FreezeDetector({
    thresholdMs: 3000,
    onFreezeChange: (frozen) => {
      // не показываем фриз ни поверх audio-only, ни если собеседник вышел
      if (audioOnlyActive || peerLeftActive) return;
      setFrozen(frozen);
      if (frozen) {
        showToast('Видеосигнал прерывается', { type: 'warn' });
      } else {
        showToast('Изображение вернулось', { type: 'success', duration: 2500 });
      }
    },
  });

  // Менеджер восстановления соединения через ICE restart
  recoveryManager = new RecoveryManager(pc, {
    getRole: () => role,
    sendRestartOffer,
    sendRestartRequest: () => sendSignal({ type: 'restart-request' }),
    onRecoveryStart: (reason, attempt) => {
      // если собеседник вышел — восстанавливать некого, не дёргаемся
      if (peerLeftActive) return;
      recoveryActive = true;
      setRecovering(true, attempt, reason);
      showToast(`Соединение восстанавливается. Попытка ${attempt} из 3`, {
        type: 'warn', duration: 6000,
      });
      log('recovery start:', reason, 'attempt', attempt);
    },
    onRecoverySuccess: () => {
      recoveryActive = false;
      setRecovering(false);
      showToast('Связь восстановлена', { type: 'success' });
      log('recovery success');
    },
    onRecoveryFail: () => {
      recoveryActive = false;
      setRecovering(false);
      if (!peerLeftActive) {
        showToast('Связь не восстановилась. Завершите сессию и подключитесь заново.', {
          type: 'error', duration: 8000,
        });
      }
      log('recovery fail');
    },
  });

  collectorHandle = startMetricsCollector(pc, (rawStats) => {
    const smoothed = aggregator.update(rawStats);
    const decision = policy.evaluate(smoothed);
    if (decision) {
      actuator.apply(decision);
      recorder.noteDecision(decision);
      handlePolicyDecision(decision);
    }
    renderMetrics(smoothed, { mode, decision });
    recorder.record(smoothed, mode);

    // UX-наблюдатели поверх адаптивного слоя.
    // Если собеседник вышел — наблюдатели не нужны.
    if (!peerLeftActive) {
      freezeDetector?.observe(smoothed);
      recoveryManager?.observe(smoothed);
    }

    updateQualityBadge({
      qoeScore: smoothed.qoeScore,
      audioOnly: audioOnlyActive,
      recovering: recoveryActive,
      peerLeft: peerLeftActive,
    });
  }, { intervalMs: 1000 });
}

function handlePolicyDecision(decision) {
  lastDecisionAction = decision.action;
  switch (decision.action) {
    case 'audioOnly':
      audioOnlyActive = true;
      setAudioOnly(true);
      // freeze-оверлей не нужен, когда видео осознанно выключено
      setFrozen(false);
      showToast('Видео отключилось из-за слабой сети', {
        type: 'warn', duration: 6000,
      });
      break;
    case 'restoreVideo':
      audioOnlyActive = false;
      setAudioOnly(false);
      showToast('Видео восстановилось', { type: 'success' });
      break;
    case 'downgrade':
      // приглушённое сообщение — не спамим тостами по каждой ступени
      log('quality downgraded to level', decision.targetLevel);
      break;
    case 'upgrade':
      log('quality upgraded to level', decision.targetLevel);
      break;
  }
}

function stopTelemetry() {
  if (collectorHandle) { collectorHandle.stop(); collectorHandle = null; }
  aggregator = null; policy = null; actuator = null;
  freezeDetector = null;
  recoveryManager = null;
  audioOnlyActive = false;
  recoveryActive = false;
  peerLeftActive = false;
  resetOverlays();
}

function setMode(newMode) {
  mode = newMode;
  modeLabel.textContent = newMode;
  if (policy) policy.setEnabled(newMode === 'adaptive');
  if (recorder.isActive()) recorder.mark(`mode=${newMode}`);
  // В baseline-режиме политика отключена → переход в audio-only не происходит,
  // нужно сбросить связанные UX-состояния.
  if (newMode === 'baseline') {
    audioOnlyActive = false;
    setAudioOnly(false);
  }
  showToast(`Режим: ${newMode}`, { type: 'info', duration: 2000 });
}

// --- запись эксперимента ----------------------------------------------------
function onRecordToggle() {
  const btn = $('recordBtn');
  const profileInput = $('profileInput');
  if (!recorder.isActive()) {
    recorder.start();
    recorder.mark(`profile=${(profileInput?.value || 'unset').trim()}|mode=${mode}`);
    btn.textContent = '⏺ Стоп и скачать';
    btn.classList.add('recording');
    setStatus('Идёт запись телеметрии.');
  } else {
    const profile = (profileInput?.value || 'unset').trim();
    const filename = `run-${profile}-${mode}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.csv`;
    recorder.download(filename);
    recorder.stop();
    btn.textContent = '● Старт записи';
    btn.classList.remove('recording');
    setStatus(`Запись сохранена: ${filename}`);
  }
}

function onMarkProfile() {
  const profileInput = $('profileInput');
  const label = (profileInput?.value || '').trim();
  if (label && recorder.isActive()) {
    recorder.mark(`profile=${label}`);
    setStatus(`Профиль отмечен: ${label}`);
  }
}

// --- UI handlers -------------------------------------------------------------
async function onJoinClick() {
  try {
    await ensureLocalStream();
  } catch (e) {
    setStatus(`Не удалось получить камеру/микрофон: ${e.message}`);
    return;
  }
  roomId = (roomInput.value || '').trim() || randomRoomId();
  roomInput.value = roomId;
  history.replaceState(null, '', `?room=${encodeURIComponent(roomId)}`);

  try { await connectSignaling(); }
  catch (e) { setStatus('Не удалось подключиться к сигналингу.'); return; }

  sendSignal({ type: 'join' });
  joinBtn.disabled = true;
  copyBtn.disabled = false;
  hangupBtn.disabled = false;
}

function onCopyLink() {
  const url = `${location.origin}${location.pathname}?room=${encodeURIComponent(roomId)}`;
  navigator.clipboard.writeText(url).then(() => setStatus(`Ссылка скопирована: ${url}`));
}

function onModeChange(ev) { setMode(ev.target.value); }

// --- init --------------------------------------------------------------------
prefillRoomFromUrl();
joinBtn.addEventListener('click', onJoinClick);
copyBtn.addEventListener('click', onCopyLink);
hangupBtn.addEventListener('click', () => hangup(true));
for (const r of document.querySelectorAll('input[name="mode"]')) {
  r.addEventListener('change', onModeChange);
}
const recordBtn = document.getElementById('recordBtn');
if (recordBtn) recordBtn.addEventListener('click', onRecordToggle);
const markBtn = document.getElementById('markBtn');
if (markBtn) markBtn.addEventListener('click', onMarkProfile);

updateQualityBadge({ qoeScore: null });
log('app ready. signaling endpoint =', wsUrl());
