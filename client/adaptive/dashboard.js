// dashboard.js — отрисовка live-метрик и состояния адаптации.

const $ = (id) => document.getElementById(id);

function fmt(v, digits = 0) {
  if (v == null || Number.isNaN(v)) return '—';
  return digits ? v.toFixed(digits) : Math.round(v).toString();
}

function qoeLabel(score) {
  if (score == null) return '—';
  return ({ 4: 'отлично', 3: 'хорошо', 2: 'удовл.', 1: 'плохо' })[score] + ` (${score}/4)`;
}

let lastAction = '—';

export function renderMetrics(stats, ctx) {
  $('m-ice').textContent     = ctx?.iceState ?? '—';
  $('m-pc').textContent      = ctx?.pcState  ?? '—';
  $('m-rtt').textContent     = fmt(stats.rttMs, 0);
  $('m-jitter').textContent  = fmt(stats.jitterMs, 1);
  $('m-loss').textContent    = stats.lossPct != null ? fmt(stats.lossPct, 2) : '—';
  $('m-vbr').textContent     = fmt(stats.videoKbps, 0);
  $('m-abr').textContent     = fmt(stats.audioKbps, 0);
  $('m-fps').textContent     = fmt(stats.fps, 0);
  $('m-res').textContent     = (stats.frameWidth && stats.frameHeight)
    ? `${stats.frameWidth}×${stats.frameHeight}` : '—';
  $('m-drops').textContent   = fmt(stats.framesDropped, 0);
  $('m-qoe').textContent     = qoeLabel(stats.qoeScore);

  if (ctx?.decision) lastAction = `${ctx.decision.action} → ${ctx.decision.targetLevel} (${ctx.decision.reason})`;
  $('m-adapt').textContent   = ctx?.mode === 'adaptive' ? lastAction : 'выключено (baseline)';
}
