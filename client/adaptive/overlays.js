// overlays.js — управление видео-оверлеями (audio-only / freeze / recovery).
//
// Оверлеи накладываются на удалённое видео-окно и показывают пользователю,
// что происходит с соединением. Приоритет: recovery > freeze > audio-only.

const $ = (id) => document.getElementById(id);

const state = {
  audioOnly: false,
  frozen: false,
  recovering: false,
  peerLeft: false,
  recoveryReason: '',
  attempt: 0,
};

function render() {
  const audioOnly = $('overlayAudioOnly');
  const frozen = $('overlayFrozen');
  const recovery = $('overlayRecovery');
  const peerLeft = $('overlayPeerLeft');
  if (!audioOnly || !frozen || !recovery || !peerLeft) return;

  // audio-only лежит на ЛОКАЛЬНОМ видео и описывает наше исходящее.
  // Независим от состояния входящего потока — может сосуществовать
  // одновременно с freeze/recovery на удалённом окне.
  show(audioOnly, state.audioOnly);

  // На удалённом окне: peerLeft > recovery > frozen.
  if (state.peerLeft) {
    show(peerLeft, true); show(recovery, false); show(frozen, false);
    return;
  }
  if (state.recovering) {
    show(peerLeft, false); show(recovery, true); show(frozen, false);
    const att = $('overlayRecoveryAttempt');
    if (att) att.textContent = state.attempt > 0
      ? `Попытка ${state.attempt} из 3`
      : 'Подождите несколько секунд.';
    return;
  }
  if (state.frozen) {
    show(peerLeft, false); show(recovery, false); show(frozen, true);
    return;
  }
  show(peerLeft, false); show(recovery, false); show(frozen, false);
}

function show(el, visible) {
  if (!el) return;
  el.classList.toggle('overlay-visible', !!visible);
}

export function setAudioOnly(v) { state.audioOnly = !!v; render(); }
export function setFrozen(v)    { state.frozen    = !!v; render(); }
export function setRecovering(v, attempt = 0, reason = '') {
  state.recovering = !!v;
  state.attempt = attempt;
  state.recoveryReason = reason;
  render();
}
export function setPeerLeft(v) { state.peerLeft = !!v; render(); }
export function resetOverlays() {
  state.audioOnly = false;
  state.frozen = false;
  state.recovering = false;
  state.peerLeft = false;
  state.attempt = 0;
  state.recoveryReason = '';
  render();
}

/**
 * Бейдж качества соединения в шапке.
 * @param {object} ctx
 * @param {number|null} ctx.qoeScore   1..4
 * @param {boolean} [ctx.audioOnly]
 * @param {boolean} [ctx.recovering]
 */
export function updateQualityBadge(ctx) {
  const el = $('qualityBadge');
  if (!el) return;
  if (ctx.peerLeft) {
    el.textContent = '⛌ Собеседник вышел';
    el.dataset.level = 'idle';
    return;
  }
  if (ctx.recovering) {
    el.textContent = '⟳ Восстановление связи';
    el.dataset.level = 'recovering';
    return;
  }
  if (ctx.audioOnly) {
    el.textContent = '♪ Видео выкл.';
    el.dataset.level = 'audio';
    return;
  }
  const q = ctx.qoeScore;
  if (q == null) {
    el.textContent = 'Нет данных';
    el.dataset.level = 'idle';
    return;
  }
  const map = {
    4: { text: '● Отличное соединение', level: '4' },
    3: { text: '● Хорошее соединение',  level: '3' },
    2: { text: '● Среднее соединение',  level: '2' },
    1: { text: '● Плохое соединение',   level: '1' },
  };
  const v = map[q] || map[1];
  el.textContent = v.text;
  el.dataset.level = v.level;
}
