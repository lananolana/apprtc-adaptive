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
// На этом этапе (День 1) реализован baseline-путь: P2P-звонок между двумя
// вкладками через локальный WebSocket-сигналинг. Adaptive-логика подключена
// как заглушки и будет наполняться в Дни 2–3.

import { startMetricsCollector } from '/adaptive/collector.js';
import { Aggregator }            from '/adaptive/aggregator.js';
import { AdaptationPolicy }      from '/adaptive/policy.js';
import { Actuator }              from '/adaptive/actuator.js';
import { renderMetrics }         from '/adaptive/dashboard.js';

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
      if (msg.count === 2 && role === 'caller') {
        await createOffer();
      }
      break;
    case 'offer':
      await handleOffer(msg.sdp);
      break;
    case 'answer':
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      break;
    case 'candidate':
      if (pc && msg.candidate) {
        try { await pc.addIceCandidate(msg.candidate); }
        catch (e) { console.warn('addIceCandidate failed', e); }
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

function hangup(notifyRemote) {
  if (notifyRemote) sendSignal({ type: 'bye' });
  stopTelemetry();
  if (pc) { try { pc.close(); } catch {} pc = null; }
  if (ws) { try { ws.close(); } catch {} ws = null; }
  remoteVideo.srcObject = null;
  setStatus('Сессия завершена.');
  joinBtn.disabled = false;
  copyBtn.disabled = true;
  hangupBtn.disabled = true;
}

// --- адаптивный слой (заглушки) ---------------------------------------------
function startTelemetry() {
  if (collectorHandle) return;
  aggregator = new Aggregator();
  policy = new AdaptationPolicy({ enabled: mode === 'adaptive' });
  actuator = new Actuator(pc);

  collectorHandle = startMetricsCollector(pc, (rawStats) => {
    const smoothed = aggregator.update(rawStats);
    const decision = policy.evaluate(smoothed);
    if (decision) actuator.apply(decision);
    renderMetrics(smoothed, { mode, decision });
  }, { intervalMs: 1000 });
}

function stopTelemetry() {
  if (collectorHandle) { collectorHandle.stop(); collectorHandle = null; }
  aggregator = null; policy = null; actuator = null;
}

function setMode(newMode) {
  mode = newMode;
  modeLabel.textContent = newMode;
  if (policy) policy.setEnabled(newMode === 'adaptive');
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

log('app ready. signaling endpoint =', wsUrl());
