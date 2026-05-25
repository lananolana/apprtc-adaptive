// overlays.js — управление видео-оверлеями (audio-only / freeze / recovery).
//
// Оверлеи накладываются на удалённое видео-окно и показывают пользователю,
// что происходит с соединением. Приоритет: recovery > freeze > audio-only.

const $ = (id) => document.getElementById(id);

const state = {
  audioOnly: false,
  frozen: false,
  recovering: false,
  recoveryReason: '',
  attempt: 0,
};

function render() {
  const audioOnly = $('overlayAudioOnly');
  const frozen = $('overlayFrozen');
  const recovery = $('overlayRecovery');
  if (!audioOnly || !frozen || !recovery) return;

  // priority order
  if (state.recovering) {
    show(recovery, true);
    show(frozen, false);
    show(audioOnly, false);
    const att = $('overlayRecoveryAttempt');
    if (att) att.textContent = state.attempt > 0 ? `Попытка ${state.attempt}` : '';
    return;
  }
  if (state.frozen) {
    show(recovery, false);
    show(frozen, true);
    show(audioOnly, false);
    return;
  }
  if (state.audioOnly) {
    show(recovery, false);
    show(frozen, false);
    show(audioOnly, true);
    return;
  }
  show(recovery, false);
  show(frozen, false);
  show(audioOnly, false);
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
export function resetOverlays() {
  state.audioOnly = false;
  state.frozen = false;
  state.recovering = false;
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
  if (ctx.recovering) {
    el.textContent = '⟳ Восстановление…';
    el.dataset.level = 'recovering';
    return;
  }
  if (ctx.audioOnly) {
    el.textContent = '♪ Только аудио';
    el.dataset.level = 'audio';
    return;
  }
  const q = ctx.qoeScore;
  if (q == null) {
    el.textContent = '— Нет данных';
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
